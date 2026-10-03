/**
 * M2-A2: `thread/handoff`, the M2 evidence pin §2.1 order performed in-process
 * (`docs/plan/PIN-madc-M2-handoff-procedure.md`). Each test below is named for the commission's
 * acceptance row it carries, and kills the mutation recorded in the PR body:
 *
 * - success: the source has `handoff.out` then `handoff.link`; the target's seq 0 cites H; the
 *   link cites G; doctor reports no handoff finding; the target lock is not held on return; no
 *   turn ran inside the method;
 * - refusals before any append (bad or gated seat, empty brief, ids, the source lock): size,
 *   sha256 and the writer's next seq unchanged;
 * - the target open fails after `handoff.out`: `handoff.aborted`, no link, and the orphaned
 *   target is refused `-32010 handoff-one-way`;
 * - redaction: a secret-shaped brief is `[REDACTED]` on disk and both chains still verify.
 *
 * Network-free: in-process engines with a spy around the echo agent, real temporary git
 * repositories for the worktree identity (fixture `git` children with the runner's `GIT_*`
 * stripped, M1-A9). No engine code creates a worktree; no fixture here does either.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import { type Agent, echoAgent } from "./agent.ts";
import { checkHandoffTarget, inspectSessionV2, type SessionFinding } from "./handoff.ts";
import { ID_PATTERN } from "./protocol/ids.ts";
import { MADC_DEFAULT_SEAT } from "./seat.ts";
import { EngineConnection, type EngineOptions } from "./server.ts";
import {
  REDACTED,
  type SessionEvent,
  setSessionCloseForTests,
  verifySessionFile,
} from "./session-store.ts";
import { fixtureGitEnv } from "./testing/git-env.ts";
import { makeHome, seatFileBody, writeSeatFile } from "./testing/harness.ts";

type Wire = Record<string, unknown> & { params?: Record<string, unknown> };
type Line = SessionEvent & { payload: Record<string, unknown> };

const text = (t: string) => [{ type: "text", text: t }];
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const sessionPath = (home: string, id: string) => join(home, "sessions", `${id}.jsonl`);
const lockPath = (home: string, id: string) => join(home, "sessions", `${id}.lock`);
const readLines = (path: string): Line[] =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as Line);
const types = (path: string) => readLines(path).map((l) => l.type);
const sessionFiles = (home: string) =>
  readdirSync(join(home, "sessions"))
    .filter((n) => n.endsWith(".jsonl"))
    .sort();
const snapshot = (path: string) => ({ size: statSync(path).size, sha: sha256(path) });

/** The echo agent, counting every preflight and run: a turn inside `thread/handoff` shows here. */
function spyAgent(): { agent: Agent; calls: { preflight: number; run: number } } {
  const calls = { preflight: 0, run: 0 };
  const agent: Agent = {
    name: "spy-echo",
    preflight() {
      calls.preflight++;
    },
    run(ctx, sink) {
      calls.run++;
      return echoAgent.run(ctx, sink);
    },
  };
  return { agent, calls };
}

/** In-process engine on `home` (the handoff-gate harness). */
function inProcess(home: string, agent: Agent = echoAgent, extra: Partial<EngineOptions> = {}) {
  const input = new PassThrough();
  const received: Wire[] = [];
  const logs: string[] = [];
  const output = new Writable({
    write(chunk, _enc, cb) {
      for (const line of String(chunk).split("\n"))
        if (line !== "") received.push(JSON.parse(line));
      cb();
    },
  });
  const conn = new EngineConnection({
    input,
    output,
    home,
    agent,
    log: (m) => {
      logs.push(m);
    },
    ...extra,
  });
  const done = conn.run();
  let nextId = 1;
  const waitFor = async (pred: (m: Wire) => boolean): Promise<Wire> => {
    const until = Date.now() + 5000;
    for (;;) {
      const hit = received.find(pred);
      if (hit !== undefined) return hit;
      if (Date.now() > until) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  const request = async (method: string, params: unknown = {}): Promise<Wire> => {
    const id = nextId++;
    input.write(`${JSON.stringify({ id, method, params })}\n`);
    return waitFor((m) => m.id === id);
  };
  const init = async () => {
    await request("initialize", { clientInfo: { name: "t", version: "0" } });
    input.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
  };
  const close = async () => {
    input.end();
    await done;
  };
  return { received, logs, waitFor, request, init, close };
}
type Engine = ReturnType<typeof inProcess>;

function errorOf(m: Wire): { code: number; message: string; data: Record<string, unknown> } {
  const err = m.error as { code: number; message: string; data: Record<string, unknown> };
  assert.ok(err, `expected an error, got ${JSON.stringify(m)}`);
  return err;
}

function expectEvidenceInvalid(
  m: Wire,
  expected: { threadId: string; type: string; reason: string },
): { turnId: unknown; issues: string[] } {
  const err = errorOf(m);
  assert.equal(err.code, -32010, JSON.stringify(m));
  assert.deepEqual(Object.keys(err.data).sort(), [
    "issues",
    "reason",
    "threadId",
    "turnId",
    "type",
  ]);
  assert.equal(err.data.threadId, expected.threadId);
  assert.equal(err.data.type, expected.type);
  assert.equal(err.data.reason, expected.reason);
  return { turnId: err.data.turnId, issues: err.data.issues as string[] };
}

async function startThread(e: Engine, seatId: string, cwd?: string): Promise<string> {
  const r = await e.request("thread/start", cwd === undefined ? { seatId } : { seatId, cwd });
  assert.ok(r.result, `thread/start: ${JSON.stringify(r.error)}`);
  return (r.result as { thread: { id: string } }).thread.id;
}

async function serve(e: Engine, threadId: string, input = "plan the work"): Promise<string> {
  const ts = await e.request("turn/start", { threadId, input: text(input) });
  assert.ok(ts.result, `turn/start: ${JSON.stringify(ts.error)}`);
  const turnId = (ts.result as { turn: { id: string } }).turn.id;
  const turnOf = (m: Wire) => m.params?.turn as { id: string; status: string } | undefined;
  const done = await e.waitFor((m) => m.method === "turn/completed" && turnOf(m)?.id === turnId);
  assert.equal(turnOf(done)?.status, "completed");
  return turnId;
}

const handoffCodes = (findings: readonly SessionFinding[]) =>
  findings.filter((f) => f.code.startsWith("handoff")).map((f) => `${f.level} ${f.code}`);
function findingsOf(home: string, threadId: string): SessionFinding[] {
  const v = verifySessionFile(sessionPath(home, threadId), threadId, {}, home);
  assert.ok(v.ok, `${threadId} verifies`);
  return v.ok ? inspectSessionV2(home, v.events) : [];
}

/** `git init` with the target path passed explicitly (the repo-gate fixture, M1-A9). */
function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "--quiet", "--", dir], { env: fixtureGitEnv(), stdio: "ignore" });
  assert.equal(existsSync(join(dir, ".git")), true, `git init created ${dir}`);
}
function git(dir: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: dir,
    env: {
      ...fixtureGitEnv(),
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

// ------------------------------------------------------------------ success

test("M2-A2 success: the source has handoff.out then handoff.link; the target's seq 0 cites H; the link cites G; doctor reports no handoff finding; the target lock is not held on return; no turn ran inside the method", async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "madc-m2a2-ok-"));
  const { home, cleanup } = makeHome();
  try {
    const repo = join(root, "repo");
    initRepo(repo);
    git(repo, ["config", "--local", "remote.origin.url", "git@github.com:Owner/Repo.git"]);
    git(repo, ["-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "one"]);
    const head = git(repo, ["rev-parse", "HEAD"]);
    mkdirSync(join(repo, "sub"));
    const cwd = join(repo, "sub");

    const spy = spyAgent();
    const e = inProcess(home, spy.agent);
    await e.init();
    const src = await startThread(e, "daedalus", cwd);
    const turnId = await serve(e, src);
    const calls = { ...spy.calls };
    const before = e.received.length;
    const srcLinesBefore = readLines(sessionPath(home, src)).length;

    const r = await e.request("thread/handoff", {
      threadId: src,
      targetSeatId: "hephaestus",
      brief: "Implement §2.1 of the pin; tests first.",
      turnId,
    });
    // Observed at the response: the engine answers only after the method has returned.
    const result = r.result as {
      handoffId: string;
      targetThreadId: string;
      targetGenesisHash: string;
    };
    assert.ok(result, `thread/handoff: ${JSON.stringify(r.error)}`);
    const tgt = result.targetThreadId;
    assert.equal(existsSync(lockPath(home, tgt)), false, "the target lock is not held on return");
    assert.equal(existsSync(lockPath(home, src)), true, "the source lock is still held");
    assert.deepEqual(Object.keys(result).sort(), [
      "handoffId",
      "targetGenesisHash",
      "targetThreadId",
    ]);
    assert.match(result.handoffId, /^ho_[0-9a-f]{32}$/);
    assert.match(result.handoffId, ID_PATTERN);
    assert.match(tgt, ID_PATTERN);
    assert.notEqual(tgt, src);

    // Source: exactly two new lines, handoff.out (H) then handoff.link (G).
    const srcLines = readLines(sessionPath(home, src));
    assert.equal(srcLines.length, srcLinesBefore + 2);
    const out = srcLines.at(-2) as Line;
    const link = srcLines.at(-1) as Line;
    assert.equal(out.type, "handoff.out");
    assert.equal(link.type, "handoff.link", "a success return always has its handoff.link");
    assert.equal(out.seq, srcLinesBefore);
    assert.deepEqual(out.payload, {
      handoffId: result.handoffId,
      turnId,
      targetSeatId: "hephaestus",
      brief: "Implement §2.1 of the pin; tests first.",
    });
    assert.deepEqual(link.payload, {
      handoffId: result.handoffId,
      targetThreadId: tgt,
      targetSeatId: "hephaestus",
      targetGenesisHash: result.targetGenesisHash,
    });

    // Target: one line, seq 0, citing H; its hash is G; same cwd; worktree engine-resolved.
    const tgtLines = readLines(sessionPath(home, tgt));
    assert.deepEqual(
      tgtLines.map((l) => l.type),
      ["session.open"],
      "no turn on the target",
    );
    const open = tgtLines[0] as Line;
    assert.equal(open.seq, 0);
    assert.equal(open.seatId, "hephaestus");
    assert.equal(open.hash, result.targetGenesisHash);
    assert.deepEqual(open.payload.handoff, {
      sourceThreadId: src,
      sourceSeatId: "daedalus",
      handoffId: result.handoffId,
      sourceSeq: out.seq,
      sourceHash: out.hash,
    });
    assert.equal(open.payload.cwd, cwd);
    assert.deepEqual(open.payload.worktree, {
      topLevel: realpathSync(repo),
      remote: "github.com/Owner/Repo",
      head,
    });
    const srcOpen = readLines(sessionPath(home, src))[0] as Line;
    assert.deepEqual(
      open.payload.worktree,
      srcOpen.payload.worktree,
      "same work tree as the source",
    );

    // No turn was started inside the method, on either thread; the target was never announced.
    assert.deepEqual(spy.calls, calls, "no preflight and no agent run inside thread/handoff");
    const during = e.received.slice(before).filter((m) => m.method !== undefined);
    assert.deepEqual(during, [], "no notification at all: no thread/started, no turn/started");
    assert.ok(!srcLines.slice(srcLinesBefore).some((l) => l.type === "turn.start"));

    // §2.1 (a)–(c) from both files; doctor reports no handoff finding and no FAIL.
    assert.deepEqual(handoffCodes(findingsOf(home, src)), []);
    assert.deepEqual(handoffCodes(findingsOf(home, tgt)), []);
    assert.deepEqual(
      [...findingsOf(home, src), ...findingsOf(home, tgt)].filter((f) => f.level === "fail"),
      [],
    );
    assert.deepEqual(
      checkHandoffTarget(home, {
        threadId: tgt,
        seatId: "hephaestus",
        genesisHash: open.hash,
        link: open.payload.handoff as never,
      }),
      { ok: true },
    );

    // The source thread keeps serving after the handoff.
    await serve(e, src, "carry on");
    await e.close();
    assert.equal(types(sessionPath(home, src)).at(-1), "session.close");
    assert.deepEqual(types(sessionPath(home, tgt)), ["session.open"], "the target is not ours");

    // The target passes the gate in another engine (resume only: serving the brief is a later act).
    const e2 = inProcess(home);
    await e2.init();
    assert.ok((await e2.request("thread/resume", { threadId: tgt })).result);
    await e2.close();
  } finally {
    cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------- refusals

test("M2-A2 refusals before any append: a missing or invalid target seat, the seat gate, an empty brief, a bad id and a missing key leave the source's size, sha256 and next seq unchanged; nothing else is created", async () => {
  const { home, cleanup } = makeHome();
  try {
    writeSeatFile(home, { id: "broken" }, "{ not json\n");
    writeSeatFile(home, {
      ...seatFileBody(MADC_DEFAULT_SEAT),
      id: "ho-on",
      handoffs: { enabled: true, targets: [] },
    });
    writeSeatFile(home, {
      ...seatFileBody(MADC_DEFAULT_SEAT),
      id: "ho-targets",
      handoffs: { enabled: false, targets: ["hephaestus"] },
    });
    const e = inProcess(home);
    await e.init();
    const src = await startThread(e, "daedalus");
    const turnId = await serve(e, src);
    const path = sessionPath(home, src);
    const before = snapshot(path);
    const linesBefore = readLines(path).length;
    const files = sessionFiles(home);
    const BRIEF = "Do the next act (a distinctive brief that must never be echoed).";
    const ok = { threadId: src, targetSeatId: "hephaestus", brief: BRIEF, turnId };

    const cases: Array<[string, Record<string, unknown>, (m: Wire) => void]> = [
      [
        "unknown target seat",
        { ...ok, targetSeatId: "no-such-seat" },
        (m) => assert.equal(errorOf(m).code, -32005),
      ],
      [
        "unreadable target seat",
        { ...ok, targetSeatId: "broken" },
        (m) => {
          assert.equal(errorOf(m).code, -32006);
        },
      ],
      [
        "seat gate: handoffs.enabled",
        { ...ok, targetSeatId: "ho-on" },
        (m) => {
          const err = errorOf(m);
          assert.equal(err.code, -32006);
          assert.ok((err.data.issues as string[]).includes("handoffs.enabled must be false in M0"));
        },
      ],
      [
        "seat gate: handoffs.targets",
        { ...ok, targetSeatId: "ho-targets" },
        (m) => {
          const err = errorOf(m);
          assert.equal(err.code, -32006);
          assert.ok((err.data.issues as string[]).includes("handoffs.targets must be [] in M0"));
        },
      ],
      [
        "brief empty after trim",
        { ...ok, brief: " \n\t " },
        (m) => {
          const r = expectEvidenceInvalid(m, {
            threadId: src,
            type: "handoff.out",
            reason: "field-invalid",
          });
          assert.equal(r.turnId, turnId);
          assert.deepEqual(r.issues, ["brief must be a non-empty string"]);
        },
      ],
      [
        "brief missing",
        { threadId: src, targetSeatId: "hephaestus", turnId },
        (m) => {
          const r = expectEvidenceInvalid(m, {
            threadId: src,
            type: "handoff.out",
            reason: "field-missing",
          });
          assert.deepEqual(r.issues, ["brief is required"]);
        },
      ],
      [
        "targetSeatId outside the grammar",
        { ...ok, targetSeatId: "../seats/x" },
        (m) => {
          expectEvidenceInvalid(m, { threadId: src, type: "handoff.out", reason: "field-invalid" });
        },
      ],
      [
        "turnId outside the grammar",
        { ...ok, turnId: "turn 1" },
        (m) => {
          const r = expectEvidenceInvalid(m, {
            threadId: src,
            type: "handoff.out",
            reason: "field-invalid",
          });
          assert.equal(r.turnId, null);
        },
      ],
      [
        "turnId key missing",
        { threadId: src, targetSeatId: "hephaestus", brief: BRIEF },
        (m) => {
          expectEvidenceInvalid(m, { threadId: src, type: "handoff.out", reason: "field-missing" });
        },
      ],
      [
        "threadId outside the grammar",
        { ...ok, threadId: "thr/../x" },
        (m) => {
          assert.equal(errorOf(m).code, -32602);
        },
      ],
      [
        "unknown source thread",
        { ...ok, threadId: "thr_nobody" },
        (m) => {
          assert.equal(errorOf(m).code, -32002);
        },
      ],
    ];
    for (const [name, params, check] of cases) {
      const m = await e.request("thread/handoff", params);
      check(m);
      assert.ok(!JSON.stringify(m).includes(BRIEF), `${name}: the error never carries the brief`);
      assert.deepEqual(snapshot(path), before, `${name}: source size and sha256 unchanged`);
      assert.deepEqual(sessionFiles(home), files, `${name}: no session file created`);
      assert.ok(!existsSync(join(home, "sessions", "thr_nobody.lock")), `${name}: no lock taken`);
    }

    // The writer is neither advanced nor broken: the next handoff's handoff.out takes the next seq.
    const r = await e.request("thread/handoff", ok);
    assert.ok(r.result, JSON.stringify(r.error));
    const out = readLines(path).find((l) => l.type === "handoff.out") as Line;
    assert.equal(out.seq, linesBefore, "nextSeq was unchanged by every refusal");
    await e.close();
  } finally {
    cleanup();
  }
});

test("M2-A2 the caller must hold the source thread lock: another engine's thread and a lost lock are -32004 with nothing appended", async () => {
  const { home, cleanup } = makeHome();
  try {
    const a = inProcess(home);
    await a.init();
    const src = await startThread(a, "daedalus");
    const path = sessionPath(home, src);
    const params = { threadId: src, targetSeatId: "hephaestus", brief: "go", turnId: null };

    // (a) the thread is held by another engine (engine A): engine B does not hold its lock.
    const b = inProcess(home);
    await b.init();
    const before = snapshot(path);
    const viaB = errorOf(await b.request("thread/handoff", params));
    assert.equal(viaB.code, -32004);
    assert.equal(viaB.data.threadId, src);
    assert.equal(viaB.data.activeTurnId, null);
    assert.equal(viaB.data.lockHolderPid, process.pid);
    assert.deepEqual(snapshot(path), before);
    await b.close();

    // (b) engine A loaded the thread but its lock is gone: refused, never re-taken.
    unlinkSync(lockPath(home, src));
    const files = sessionFiles(home);
    const viaA = errorOf(await a.request("thread/handoff", params));
    assert.equal(viaA.code, -32004);
    assert.equal(viaA.data.activeTurnId, null);
    assert.deepEqual(snapshot(path), before, "nothing appended");
    assert.deepEqual(sessionFiles(home), files, "no target created");
    assert.equal(existsSync(lockPath(home, src)), false, "the lost lock is not re-taken");
    await a.close();
  } finally {
    cleanup();
  }
});

// ------------------------------------------------- the target open fails

test("M2-A2 the target open fails after handoff.out: handoff.aborted (target-open-failed) carries the open's error, no handoff.link, the error is answered, no target lock is left", async () => {
  const { home, cleanup } = makeHome();
  try {
    const ids = ["thr_src", "thr_taken"];
    const e = inProcess(home, echoAgent, { newThreadId: () => ids.shift() ?? "thr_spare" });
    await e.init();
    const src = await startThread(e, "daedalus");
    assert.equal(src, "thr_src");
    // The target id's session file already exists: the exclusive create refuses (-32009).
    const taken = sessionPath(home, "thr_taken");
    writeFileSync(taken, "not a session\n", { mode: 0o600 });
    const takenBefore = snapshot(taken);
    const linesBefore = readLines(sessionPath(home, src)).length;

    const m = await e.request("thread/handoff", {
      threadId: src,
      targetSeatId: "hephaestus",
      brief: "Take it from here.",
      turnId: null,
    });
    const err = errorOf(m);
    assert.equal(err.code, -32009);
    assert.equal(err.data.threadId, "thr_taken");

    const added = readLines(sessionPath(home, src)).slice(linesBefore);
    assert.deepEqual(
      added.map((l) => l.type),
      ["handoff.out", "handoff.aborted"],
      "aborted instead of link, never both",
    );
    const [out, aborted] = added as [Line, Line];
    assert.deepEqual(aborted.payload, {
      handoffId: out.payload.handoffId,
      reason: "target-open-failed",
      error: { code: -32009, message: err.message },
    });
    assert.deepEqual(snapshot(taken), takenBefore, "the file in the way is untouched");
    assert.equal(existsSync(lockPath(home, "thr_taken")), false, "the target lock was released");
    assert.deepEqual(handoffCodes(findingsOf(home, src)), [], "a recorded failure is OK");
    await e.close();
  } finally {
    cleanup();
  }
});

test("M2-A2 the target exists but its genesis cannot be read back: handoff.aborted (target-genesis-unavailable), no handoff.link, -32010; the orphaned target is refused -32010 handoff-one-way and serves no turn", async () => {
  const { home, cleanup } = makeHome();
  const ids = ["thr_src", "thr_tgt"];
  const target = sessionPath(home, "thr_tgt");
  const aside = `${target}.aside`;
  try {
    const e = inProcess(home, echoAgent, { newThreadId: () => ids.shift() ?? "thr_spare" });
    await e.init();
    const src = await startThread(e, "daedalus");
    const turnId = await serve(e, src);
    const linesBefore = readLines(sessionPath(home, src)).length;
    // Fault: once the target's session.open is durable, the file is moved aside before the
    // source reads it back (the test puts it back afterwards). Only the target's close does this.
    setSessionCloseForTests((fd) => {
      try {
        if (existsSync(target) && fstatSync(fd).ino === statSync(target).ino) {
          renameSync(target, aside);
        }
      } finally {
        closeSync(fd);
      }
    });
    let m: Wire;
    try {
      m = await e.request("thread/handoff", {
        threadId: src,
        targetSeatId: "hephaestus",
        brief: "Take it from here.",
        turnId,
      });
    } finally {
      setSessionCloseForTests(null);
    }
    const r = expectEvidenceInvalid(m, {
      threadId: src,
      type: "handoff.link",
      reason: "field-missing",
    });
    assert.equal(r.turnId, turnId);
    assert.match(r.issues.join(" "), /targetGenesisHash is unavailable/);
    assert.equal(existsSync(lockPath(home, "thr_tgt")), false, "the target lock was released");

    const added = readLines(sessionPath(home, src)).slice(linesBefore);
    assert.deepEqual(
      added.map((l) => l.type),
      ["handoff.out", "handoff.aborted"],
    );
    const [out, aborted] = added as [Line, Line];
    assert.deepEqual(aborted.payload, {
      handoffId: out.payload.handoffId,
      reason: "target-genesis-unavailable",
      error: null,
    });
    await e.close();

    // The target was created and cites H: it is orphaned.
    renameSync(aside, target);
    const open = readLines(target)[0] as Line;
    assert.deepEqual(types(target), ["session.open"]);
    assert.equal((open.payload.handoff as Record<string, unknown>).sourceHash, out.hash);
    assert.deepEqual(handoffCodes(findingsOf(home, "thr_tgt")), ["warn handoff-incomplete"]);
    assert.deepEqual(handoffCodes(findingsOf(home, src)), [], "a recorded failure is OK");

    // Serving the orphan: thread/resume is refused -32010 handoff-one-way at the gate, so the
    // target never loads and turn/start never serves it. Nothing is appended either way.
    const before = snapshot(target);
    const e2 = inProcess(home);
    await e2.init();
    const resume = expectEvidenceInvalid(
      await e2.request("thread/resume", { threadId: "thr_tgt" }),
      {
        threadId: "thr_tgt",
        type: "session.open",
        reason: "handoff-one-way",
      },
    );
    assert.match(resume.issues.join(" "), /handoff\.aborted \(target-genesis-unavailable\)/);
    const ts = await e2.request("turn/start", { threadId: "thr_tgt", input: text("go") });
    assert.ok(ts.error !== undefined && ts.result === undefined, "turn/start does not serve it");
    assert.ok(!e2.received.some((x) => x.method === "turn/started"));
    await e2.close();
    assert.deepEqual(snapshot(target), before, "nothing appended to the orphan");
    assert.equal(existsSync(lockPath(home, "thr_tgt")), false);
  } finally {
    setSessionCloseForTests(null);
    cleanup();
  }
});

// ------------------------------------------------------------- redaction

test("M2-A2 redaction: a brief containing secret shapes is [REDACTED] on disk, never on the wire, and both chains and the two-way link still verify", async () => {
  const { home, cleanup } = makeHome();
  try {
    const KEY = `sk-${"A1b2C3d4".repeat(4)}`;
    const BEARER = "Bearer abcdefghijklmnop0123";
    const e = inProcess(home);
    await e.init();
    const src = await startThread(e, "daedalus");
    const r = await e.request("thread/handoff", {
      threadId: src,
      targetSeatId: "prometheus",
      brief: `Use ${KEY} and send ${BEARER} upstream.`,
      turnId: null,
    });
    const result = r.result as { targetThreadId: string; targetGenesisHash: string };
    assert.ok(result, JSON.stringify(r.error));
    const out = readLines(sessionPath(home, src)).find((l) => l.type === "handoff.out") as Line;
    assert.equal(out.payload.brief, `Use ${REDACTED} and send ${REDACTED} upstream.`);
    assert.equal(out.payload.turnId, null, "raised between turns");
    for (const id of [src, result.targetThreadId]) {
      const raw = readFileSync(sessionPath(home, id), "utf8");
      assert.ok(!raw.includes(KEY) && !raw.includes("abcdefghijklmnop0123"), `${id}: no secret`);
      assert.equal(verifySessionFile(sessionPath(home, id), id, {}, home).ok, true, `${id}`);
    }
    assert.ok(!JSON.stringify(e.received).includes(KEY), "the wire never carries the secret");
    assert.deepEqual(handoffCodes(findingsOf(home, src)), []);
    assert.deepEqual(handoffCodes(findingsOf(home, result.targetThreadId)), []);
    await e.close();
  } finally {
    cleanup();
  }
});
