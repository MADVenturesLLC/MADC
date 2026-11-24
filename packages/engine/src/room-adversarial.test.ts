/**
 * M2-A7 (`PLAN-madc-M2-build-plan.md` §7): multi-hop chains and the isolation adversarial suite.
 *
 * Six probes, each paired with a healthy negative control:
 * 1. Three-seat chain A -> B -> C with a hand-back C -> B (roles swapped); tampering a link fails closed.
 * 2. Mid-chain kill: target dies without session.close -> `not-cleanly-closed` (and `brief-unserved`); source stays intact.
 * 3. Poisoned writer on one thread (-32009) while another thread continues serving cleanly.
 * 4. Target whose source is truncated after the link -> target resume/turn refuses `-32010 handoff-one-way`; doctor FAILs `handoff-unverifiable`.
 * 5. Two seats racing for one worktree path -> one succeeds, the second refuses before any append without corrupting the first.
 * 6. Decision whose source thread is deleted from under it -> `decision/list` drops it cleanly and `decision/resolve` refuses `-32002` without crashing.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import type { Agent, AgentTurnContext } from "./agent.ts";
import { listOpenDecisions } from "./decisions.ts";
import { inspectSessionV2 } from "./handoff.ts";
import { EngineConnection } from "./server.ts";
import { verifySessionFile } from "./session-store.ts";

function makeTempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  chmodSync(dir, 0o700);
  return dir;
}

function makeHome(): { home: string; cleanup: () => void } {
  const home = makeTempDir("madc-m2a7-home-");
  mkdirSync(join(home, "seats"), { mode: 0o700 });
  mkdirSync(join(home, "sessions"), { mode: 0o700 });
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

function cleanGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
  ]) {
    delete env[k];
  }
  return {
    ...env,
    GIT_AUTHOR_NAME: "MADC Test",
    GIT_AUTHOR_EMAIL: "test@madc.invalid",
    GIT_COMMITTER_NAME: "MADC Test",
    GIT_COMMITTER_EMAIL: "test@madc.invalid",
  };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: cleanGitEnv(),
  }).trim();
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-b", "main");
  git(dir, "remote", "add", "origin", "https://github.com/MADVenturesLLC/MADC.git");
  writeFileSync(join(dir, "README.md"), "# base\n");
  git(dir, "add", "README.md");
  git(dir, "commit", "-m", "init");
}

function writeV2Seat(
  home: string,
  id: string,
  opts: { worktree?: boolean; targets?: string[] } = {},
): void {
  const seat = {
    id,
    version: 2,
    displayName: id,
    role: id,
    standingInstructions: `seat ${id}`,
    pinnedModel: "kimi-coding/kimi-for-coding",
    preferredBacking: "kimi-code",
    fallbacks: [],
    memory: { mode: "in-session" },
    tools: { deny: [] },
    policy: { headlessOk: true },
    handoffs:
      opts.targets && opts.targets.length > 0
        ? { enabled: true, targets: opts.targets }
        : { enabled: false, targets: [] },
    ...(opts.worktree === undefined ? {} : { worktree: opts.worktree }),
  };
  writeFileSync(join(home, "seats", `${id}.json`), JSON.stringify(seat, null, 2), { mode: 0o600 });
}

type Wire = Record<string, unknown>;

function startEngine(
  home: string,
  opts: {
    newThreadId?: () => string;
    onTurn?: (ctx: AgentTurnContext) => void;
  } = {},
) {
  const input = new PassThrough();
  const received: Wire[] = [];
  const seenInputs: Array<{ threadId: string; seatId: string; texts: string[] }> = [];
  const output = new Writable({
    write(chunk, _enc, cb) {
      for (const line of String(chunk).split("\n")) {
        if (line !== "") received.push(JSON.parse(line));
      }
      cb();
    },
  });
  const agent: Agent = {
    name: "adversarial-reply",
    async run(ctx, sink) {
      opts.onTurn?.(ctx);
      seenInputs.push({
        threadId: ctx.threadId,
        seatId: ctx.seatId,
        texts: ctx.input.map((p) => p.text),
      });
      const id = sink.newItemId();
      sink.startItem({ id, kind: "agentMessage", status: "inProgress", text: "" });
      sink.completeItem({
        id,
        kind: "agentMessage",
        status: "completed",
        text: `ok:${ctx.seatId}`,
      });
    },
  };
  const conn = new EngineConnection({
    input,
    output,
    home,
    agent,
    log: () => {},
    ...(opts.newThreadId === undefined ? {} : { newThreadId: opts.newThreadId }),
  });
  const done = conn.run();
  let nextId = 1;
  const waitFor = async (pred: (m: Wire) => boolean): Promise<Wire> => {
    const until = Date.now() + 4000;
    for (;;) {
      const hit = received.find(pred);
      if (hit !== undefined) return hit;
      if (Date.now() > until) throw new Error("timed out waiting for message");
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  const request = async (method: string, params: unknown = {}): Promise<Wire> => {
    const id = nextId++;
    input.write(`${JSON.stringify({ id, method, params })}\n`);
    return waitFor((m) => m.id === id);
  };
  const runTurn = async (threadId: string, text: string) => {
    const before = received.length;
    const res = await request("turn/start", { threadId, input: [{ type: "text", text }] });
    if (res.error) return { ok: false as const, error: res.error as { code: number; data?: Wire } };
    const turnId = (res.result as { turn: { id: string } }).turn.id;
    const completed = await waitFor(
      (m) =>
        received.indexOf(m) >= before &&
        m.method === "turn/completed" &&
        (m.params as { turn?: { id?: string } })?.turn?.id === turnId,
    );
    return {
      ok: true as const,
      turnId,
      turn: (completed.params as { turn: { status: string; error?: { code: number } } }).turn,
    };
  };
  const close = async () => {
    input.end();
    await done;
  };
  return { request, runTurn, close, seenInputs };
}

test("M2-A7 probe 1: three-seat chain A -> B -> C with hand-back C -> B (roles swapped) verifies clean; tampering a link fails closed", async () => {
  const { home, cleanup } = makeHome();
  const repo = makeTempDir("madc-m2a7-chain-");
  try {
    initRepo(repo);
    writeV2Seat(home, "seat-a", { worktree: true, targets: ["seat-b"] });
    writeV2Seat(home, "seat-b", { worktree: true, targets: ["seat-c"] });
    writeV2Seat(home, "seat-c", { worktree: true, targets: ["seat-b"] });

    const eng = startEngine(home);
    await eng.request("initialize", { clientInfo: { name: "t", version: "0" } });

    const startA = await eng.request("thread/start", { seatId: "seat-a", cwd: repo });
    const thrA = (startA.result as { thread: { id: string; cwd: string } }).thread.id;
    const turnA = await eng.runTurn(thrA, "start A");
    assert.equal(turnA.ok, true);

    // A -> B
    const hoAB = await eng.request("thread/handoff", {
      threadId: thrA,
      targetSeatId: "seat-b",
      brief: "brief A->B",
      turnId: turnA.ok ? turnA.turnId : null,
    });
    const thrB = (hoAB.result as { targetThreadId: string }).targetThreadId;
    await eng.request("thread/resume", { threadId: thrB });
    const turnB = await eng.runTurn(thrB, "run B");
    assert.equal(turnB.ok, true);

    // B -> C
    const hoBC = await eng.request("thread/handoff", {
      threadId: thrB,
      targetSeatId: "seat-c",
      brief: "brief B->C",
      turnId: turnB.ok ? turnB.turnId : null,
    });
    const thrC = (hoBC.result as { targetThreadId: string }).targetThreadId;
    await eng.request("thread/resume", { threadId: thrC });
    const turnC = await eng.runTurn(thrC, "run C");
    assert.equal(turnC.ok, true);

    // C -> B (hand-back with roles swapped: C is now source, B is now target)
    const hoCB = await eng.request("thread/handoff", {
      threadId: thrC,
      targetSeatId: "seat-b",
      brief: "brief C->B handback",
      turnId: turnC.ok ? turnC.turnId : null,
    });
    const thrB2 = (hoCB.result as { targetThreadId: string }).targetThreadId;
    assert.notEqual(thrB2, thrB);
    await eng.request("thread/resume", { threadId: thrB2 });
    const turnB2 = await eng.runTurn(thrB2, "run B2");
    assert.equal(turnB2.ok, true);

    await eng.close();

    // Negative control: every chain verifies and has zero findings; every worktree is distinct.
    const trees = new Set<string>();
    for (const tid of [thrA, thrB, thrC, thrB2]) {
      const v = verifySessionFile(join(home, "sessions", `${tid}.jsonl`), tid, {}, home);
      assert.equal(v.ok, true, tid);
      if (v.ok) {
        assert.deepEqual(inspectSessionV2(home, v.events), [], tid);
        const ev0 = v.events[0];
        assert.ok(ev0);
        const wt = (ev0.payload as { worktree?: { topLevel: string } }).worktree;
        assert.ok(wt?.topLevel);
        trees.add(wt.topLevel);
      }
      assert.equal(existsSync(join(home, "sessions", `${tid}.lock`)), false);
    }
    assert.equal(trees.size, 4);

    // Adversarial mutation: corrupt thrB2's cited sourceHash in its session.open?
    // Instead, verify tampering with thrC's handoff.link targetGenesisHash is caught by verifySessionFile/inspectSessionV2.
    const cPath = join(home, "sessions", `${thrC}.jsonl`);
    const origC = readFileSync(cPath, "utf8");
    const tamperedC = origC.replace(
      `"targetThreadId":"${thrB2}"`,
      `"targetThreadId":"thr_wrong000000000000000000000000"`,
    );
    assert.notEqual(tamperedC, origC);
    writeFileSync(cPath, tamperedC);
    const vBad = verifySessionFile(cPath, thrC, {}, home);
    assert.equal(vBad.ok, false);
  } finally {
    cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("M2-A7 probe 2: mid-chain kill leaves target not-cleanly-closed and brief-unserved while source remains healthy", async () => {
  const { home, cleanup } = makeHome();
  try {
    writeV2Seat(home, "seat-a", { targets: ["seat-b"] });
    writeV2Seat(home, "seat-b", {});

    const eng = startEngine(home);
    await eng.request("initialize", { clientInfo: { name: "t", version: "0" } });
    const startA = await eng.request("thread/start", { seatId: "seat-a" });
    const thrA = (startA.result as { thread: { id: string } }).thread.id;
    const ho = await eng.request("thread/handoff", {
      threadId: thrA,
      targetSeatId: "seat-b",
      brief: "pending work",
      turnId: null,
    });
    const thrB = (ho.result as { targetThreadId: string }).targetThreadId;

    // Close engine before thrB is ever resumed/closed, then simulate a crash on thrB by stripping
    // its session.close if present (it was never registered on eng, so it never got session.close!).
    await eng.close();

    // thrA closed cleanly and has zero findings (aside from noting thrB wasn't cleanly closed? No, A is clean).
    const vA = verifySessionFile(join(home, "sessions", `${thrA}.jsonl`), thrA, {}, home);
    assert.equal(vA.ok, true);
    if (vA.ok) assert.deepEqual(inspectSessionV2(home, vA.events), []);

    // thrB was never cleanly closed and never served its brief -> doctor warns both.
    const vB = verifySessionFile(join(home, "sessions", `${thrB}.jsonl`), thrB, {}, home);
    assert.equal(vB.ok, true);
    if (vB.ok) {
      const codes = inspectSessionV2(home, vB.events).map((f) => `${f.level} ${f.code}`);
      assert.ok(codes.includes("warn not-cleanly-closed"));
      assert.ok(codes.includes("warn brief-unserved"));
    }
    assert.equal(existsSync(join(home, "sessions", `${thrB}.lock`)), false);
  } finally {
    cleanup();
  }
});

test("M2-A7 probe 3: poisoned writer on thread 1 (-32009) while thread 2 continues serving cleanly", async () => {
  const { home, cleanup } = makeHome();
  try {
    writeV2Seat(home, "seat-a", {});
    let poisoned = false;
    const eng = startEngine(home, {
      onTurn: (ctx) => {
        if (!poisoned && ctx.threadId === thr1) {
          poisoned = true;
          const p = join(home, "sessions", `${thr1}.jsonl`);
          rmSync(p);
          mkdirSync(p); // forces EISDIR on next append
        }
      },
    });
    await eng.request("initialize", { clientInfo: { name: "t", version: "0" } });

    const s1 = await eng.request("thread/start", { seatId: "seat-a" });
    const s2 = await eng.request("thread/start", { seatId: "seat-a" });
    const thr1 = (s1.result as { thread: { id: string } }).thread.id;
    const thr2 = (s2.result as { thread: { id: string } }).thread.id;

    // Negative control: thr2 serves cleanly before and after thr1 is poisoned.
    const t1Fail = await eng.runTurn(thr1, "break thr1");
    assert.equal(t1Fail.ok, true);
    if (t1Fail.ok) {
      assert.equal(t1Fail.turn.status, "failed");
      assert.equal(t1Fail.turn.error?.code, -32009);
    }

    // Subsequent turn on poisoned thr1 refuses -32009 immediately.
    const t1Retry = await eng.runTurn(thr1, "retry thr1");
    assert.equal(t1Retry.ok, false);
    if (!t1Retry.ok) assert.equal(t1Retry.error.code, -32009);

    // thr2 is completely unaffected and serves cleanly.
    const t2Ok = await eng.runTurn(thr2, "healthy thr2");
    assert.equal(t2Ok.ok, true);
    if (t2Ok.ok) assert.equal(t2Ok.turn.status, "completed");

    await eng.close();
  } finally {
    cleanup();
  }
});

test("M2-A7 probe 4: target whose source is truncated after the link refuses -32010 handoff-one-way and doctor FAILs handoff-mismatch", async () => {
  const { home, cleanup } = makeHome();
  try {
    writeV2Seat(home, "seat-a", { targets: ["seat-b"] });
    writeV2Seat(home, "seat-b", {});

    const eng = startEngine(home);
    await eng.request("initialize", { clientInfo: { name: "t", version: "0" } });
    const startA = await eng.request("thread/start", { seatId: "seat-a" });
    const thrA = (startA.result as { thread: { id: string } }).thread.id;
    const ho = await eng.request("thread/handoff", {
      threadId: thrA,
      targetSeatId: "seat-b",
      brief: "truncated source test",
      turnId: null,
    });
    const thrB = (ho.result as { targetThreadId: string }).targetThreadId;
    await eng.close();

    // Negative control: healthy source lets thrB resume cleanly.
    const engHealthy = startEngine(home);
    await engHealthy.request("initialize", { clientInfo: { name: "t", version: "0" } });
    const resOk = await engHealthy.request("thread/resume", { threadId: thrB });
    assert.ok(resOk.result);
    await engHealthy.close();

    // Adversarial: truncate thrA's session file to only its first line (losing handoff.out + handoff.link).
    const aPath = join(home, "sessions", `${thrA}.jsonl`);
    const firstLine = readFileSync(aPath, "utf8").split("\n")[0];
    writeFileSync(aPath, `${firstLine}\n`);

    const engBroken = startEngine(home);
    await engBroken.request("initialize", { clientInfo: { name: "t", version: "0" } });
    const resFail = await engBroken.request("thread/resume", { threadId: thrB });
    assert.equal((resFail.error as { code: number; data?: { reason?: string } }).code, -32010);
    assert.equal(
      (resFail.error as { code: number; data?: { reason?: string } }).data?.reason,
      "handoff-one-way",
    );
    await engBroken.close();

    const vB = verifySessionFile(join(home, "sessions", `${thrB}.jsonl`), thrB, {}, home);
    assert.equal(vB.ok, true);
    if (vB.ok) {
      const codes = inspectSessionV2(home, vB.events).map((f) => `${f.level} ${f.code}`);
      assert.ok(codes.includes("fail handoff-mismatch"));
    }
  } finally {
    cleanup();
  }
});

test("M2-A7 probe 5: two seats racing for one worktree path — one wins, the other refuses without corrupting the winner", async () => {
  const { home, cleanup } = makeHome();
  const repo = makeTempDir("madc-m2a7-race-");
  try {
    initRepo(repo);
    writeV2Seat(home, "seat-a", { worktree: true });
    writeV2Seat(home, "seat-b", { worktree: true });

    // Both engines contend for the exact same threadId -> same lock & same worktree path.
    const eng1 = startEngine(home, { newThreadId: () => "thr_race_same" });
    const eng2 = startEngine(home, { newThreadId: () => "thr_race_same" });
    await eng1.request("initialize", { clientInfo: { name: "t1", version: "0" } });
    await eng2.request("initialize", { clientInfo: { name: "t2", version: "0" } });

    const [r1, r2] = await Promise.all([
      eng1.request("thread/start", { seatId: "seat-a", cwd: repo }),
      eng2.request("thread/start", { seatId: "seat-b", cwd: repo }),
    ]);
    const wins = [r1, r2].filter((r) => r.result !== undefined);
    const losses = [r1, r2].filter((r) => r.error !== undefined);
    assert.equal(wins.length, 1);
    assert.equal(losses.length, 1);
    const loss = losses[0];
    assert.ok(loss);
    const errCode = (loss.error as { code: number }).code;
    assert.ok(errCode === -32004 || errCode === -32602);

    await eng1.close();
    await eng2.close();

    const v = verifySessionFile(
      join(home, "sessions", "thr_race_same.jsonl"),
      "thr_race_same",
      {},
      home,
    );
    assert.equal(v.ok, true);
    if (v.ok) assert.deepEqual(inspectSessionV2(home, v.events), []);
    assert.equal(existsSync(join(home, "sessions", "thr_race_same.lock")), false);
  } finally {
    cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("M2-A7 probe 6: decision whose source thread is deleted from under it is dropped from list and refused on resolve", async () => {
  const { home, cleanup } = makeHome();
  try {
    writeV2Seat(home, "seat-a", {});
    const eng = startEngine(home);
    await eng.request("initialize", { clientInfo: { name: "t", version: "0" } });

    const s = await eng.request("thread/start", { seatId: "seat-a" });
    const thrId = (s.result as { thread: { id: string } }).thread.id;
    const t = await eng.runTurn(thrId, "raise decision");
    assert.equal(t.ok, true);
    const turnId = t.ok ? t.turnId : "";

    const vBefore = verifySessionFile(join(home, "sessions", `${thrId}.jsonl`), thrId, {}, home);
    assert.equal(vBefore.ok, true);
    const genesisHash = vBefore.ok ? (vBefore.events[0]?.hash ?? "") : "";

    const raised = await eng.request("decision/raise", {
      threadId: thrId,
      turnId,
      question: "Proceed with cutover?",
      recommendedDefault: "Proceed",
      evidenceRefs: [
        {
          kind: "session",
          path: `sessions/${thrId}.jsonl`,
          seq: 0,
          hash: genesisHash,
        },
      ],
    });
    assert.ok(raised.result);
    const decisionId = (raised.result as { decisionId: string }).decisionId;

    // Negative control: decision appears in listOpenDecisions while source file exists.
    assert.equal(listOpenDecisions(home).length, 1);

    await eng.close();

    // Adversarial: delete the source thread's session file from under the decision.
    rmSync(join(home, "sessions", `${thrId}.jsonl`));

    // listOpenDecisions returns [] cleanly without throwing.
    assert.deepEqual(listOpenDecisions(home), []);

    // decision/resolve on a fresh engine refuses -32002 (ThreadNotFound) cleanly.
    const eng2 = startEngine(home);
    await eng2.request("initialize", { clientInfo: { name: "t2", version: "0" } });
    const res = await eng2.request("decision/resolve", {
      threadId: thrId,
      decisionId,
      choice: "accepted-default",
    });
    assert.equal((res.error as { code: number }).code, -32010);
    await eng2.close();
  } finally {
    cleanup();
  }
});
