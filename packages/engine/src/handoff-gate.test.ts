/**
 * M2-A1: the first writer of a §2 event — M2 evidence schema v2 pin §10 acceptance at the ENGINE
 * level, through the real `EngineConnection`: item 1 (two-way link verifies; editing any of the
 * three link lines is FAIL `handoff-mismatch` from the other file), item 2 (one-way is refused
 * on turn/start and thread/resume, nothing appended, doctor WARNs `handoff-incomplete`), item 4
 * (worktree HEAD at open and close, subdirectory, non-git cwd, linked worktree), item 6 (the seat
 * gate, retargeted in M2-A3 to `PIN-madc-M2-seat-handoff-allowlist.md`: only a v2 seat with
 * `handoffs.enabled: true` and a non-empty allowlist relaxes it) and D-M2-A0-5 (`session.close`
 * on every clean shutdown); plus Copilot 4160774858 on #46 (an unreadable source is
 * `handoff-unverifiable` and the target may not serve; a readable source serves).
 *
 * Network-free: the echo agent, in-process engines, real temporary git repositories (fixture
 * `git` children run with the runner's `GIT_*` stripped, M1-A9) and fixture chains written by the
 * engine's own writer. No worktree is created by ENGINE code: the one linked worktree below is a
 * test fixture made with `git worktree add` in a temp dir, so item 4's rule can be checked.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import { type Agent, echoAgent } from "./agent.ts";
import { checkHandoffTarget, inspectSessionV2, type SessionFinding } from "./handoff.ts";
import { inspectMadcHome } from "./inspect.ts";
import { MADC_DEFAULT_SEAT } from "./seat.ts";
import { HEPHAESTUS_SEAT } from "./seats/roster.ts";
import type { EngineOptions } from "./server.ts";
import { EngineConnection } from "./server.ts";
import {
  GENESIS_HASH,
  type SessionEvent,
  type SessionOpenPayload,
  sessionEventHash,
  unguardedSessionWriterForTests,
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
const BACKING = "kimi-code";
const OPEN: SessionOpenPayload = {
  cwd: null,
  backing: BACKING,
  providerId: BACKING,
  pinnedModel: "m",
  worktree: null,
  handoff: null,
};

/** In-process engine on `home` (the session-integrity harness, plus `worktreeDeps` and the logs). */
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
  return { input, received, logs, done, waitFor, request, init, close };
}
type Engine = ReturnType<typeof inProcess>;

function expectEvidenceInvalid(m: Wire, threadId: string, reason: string): { issues: string[] } {
  const err = m.error as { code: number; data: Record<string, unknown> } | undefined;
  assert.ok(err, `expected an error, got ${JSON.stringify(m)}`);
  assert.equal(err.code, -32010, JSON.stringify(m));
  assert.deepEqual(Object.keys(err.data).sort(), [
    "issues",
    "reason",
    "threadId",
    "turnId",
    "type",
  ]);
  assert.equal(err.data.threadId, threadId);
  assert.equal(err.data.turnId, null);
  assert.equal(err.data.type, "session.open");
  assert.equal(err.data.reason, reason);
  return { issues: err.data.issues as string[] };
}

async function serve(e: Engine, threadId: string, input = "hi"): Promise<void> {
  const ts = await e.request("turn/start", { threadId, input: text(input) });
  assert.ok(ts.result, `turn/start: ${JSON.stringify(ts.error)}`);
  const turnId = (ts.result as { turn: { id: string } }).turn.id;
  const turnOf = (m: Wire) => m.params?.turn as { id: string; status: string } | undefined;
  const done = await e.waitFor((m) => m.method === "turn/completed" && turnOf(m)?.id === turnId);
  assert.equal(turnOf(done)?.status, "completed");
}

/**
 * §2.1 order, written by the engine's own writer: source `thr_src` (seat daedalus) writes
 * `handoff.out` (H); target `thr_tgt` (seat hephaestus) opens citing it (G); the source then
 * writes `handoff.link` (G), or `handoff.aborted`, or nothing.
 */
function writePair(
  home: string,
  terminal: "link" | "none" | "aborted",
): { out: SessionEvent; G: string } {
  mkdirSync(join(home, "sessions"), { recursive: true, mode: 0o700 });
  const src = unguardedSessionWriterForTests.create(
    sessionPath(home, "thr_src"),
    "thr_src",
    "daedalus",
    OPEN,
    () => [],
    1000,
    home,
  );
  src.append("turn.start", { turnId: "turn_1", inputText: "plan" }, 1001);
  src.append("turn.end", { turnId: "turn_1", status: "completed", error: null }, 1002);
  const out = src.append(
    "handoff.out",
    { handoffId: "ho_1", turnId: "turn_1", targetSeatId: "hephaestus", brief: "Implement §2.1." },
    1003,
  );
  const tgt = unguardedSessionWriterForTests.create(
    sessionPath(home, "thr_tgt"),
    "thr_tgt",
    "hephaestus",
    {
      ...OPEN,
      handoff: {
        sourceThreadId: "thr_src",
        sourceSeatId: "daedalus",
        handoffId: "ho_1",
        sourceSeq: out.seq,
        sourceHash: out.hash,
      },
    },
    () => [],
    1004,
    home,
  );
  const G = tgt.genesisHash as string;
  if (terminal === "link") {
    src.append(
      "handoff.link",
      {
        handoffId: "ho_1",
        targetThreadId: "thr_tgt",
        targetSeatId: "hephaestus",
        targetGenesisHash: G,
      },
      1005,
    );
  } else if (terminal === "aborted") {
    src.append(
      "handoff.aborted",
      { handoffId: "ho_1", reason: "target-genesis-unavailable", error: null },
      1005,
    );
  }
  return { out, G };
}

/** Rewrite line `seq`'s payload and recompute that file's hashes from there on (a tampering that keeps the file self-consistent). */
function rewriteLine(
  path: string,
  seq: number,
  mutate: (p: Record<string, unknown>) => void,
): void {
  const lines = readLines(path);
  let prev = seq === 0 ? GENESIS_HASH : (lines[seq - 1] as Line).hash;
  for (let i = seq; i < lines.length; i++) {
    const line = lines[i] as Line;
    if (i === seq) mutate(line.payload);
    const { v, ts, type, threadId, seatId, payload } = line;
    const hash = sessionEventHash(prev, {
      v,
      seq: i,
      ts,
      type,
      threadId,
      seatId,
      payload,
    } as never);
    lines[i] = { v, seq: i, ts, type, threadId, seatId, prevHash: prev, hash, payload } as Line;
    prev = hash;
  }
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  const v = verifySessionFile(path);
  assert.equal(v.ok, true, "the rewritten file still verifies on its own");
}

const codes = (findings: readonly SessionFinding[]) =>
  findings.filter((f) => f.code.startsWith("handoff")).map((f) => `${f.level} ${f.code}`);
function findingsOf(home: string, threadId: string): SessionFinding[] {
  const v = verifySessionFile(sessionPath(home, threadId), threadId, {}, home);
  assert.ok(v.ok, `${threadId} verifies`);
  return v.ok ? inspectSessionV2(home, v.events) : [];
}

// ------------------------------------------------------------------ item 1

test("M2 §10.1 two-way link verifies: doctor reports no handoff finding on either file; the target serves; editing any one link line (hashes recomputed) is FAIL handoff-mismatch from the other file and -32010 for the target", async () => {
  const { home, cleanup } = makeHome();
  try {
    writePair(home, "link");
    assert.deepEqual(codes(findingsOf(home, "thr_src")), []);
    assert.deepEqual(codes(findingsOf(home, "thr_tgt")), []);
    const e = inProcess(home);
    await e.init();
    assert.ok((await e.request("thread/resume", { threadId: "thr_tgt" })).result);
    await serve(e, "thr_tgt");
    assert.deepEqual(types(sessionPath(home, "thr_tgt")).slice(1, 3), ["turn.start", "item"]);
    await e.close();
    assert.equal(types(sessionPath(home, "thr_tgt")).at(-1), "session.close");
  } finally {
    cleanup();
  }
  // The three link lines, each edited in a fresh pair.
  const edits: Array<[string, () => void, string]> = [];
  for (const which of ["handoff.out", "target session.open", "handoff.link"] as const) {
    const { home, cleanup } = makeHome();
    try {
      writePair(home, "link");
      if (which === "handoff.out") {
        rewriteLine(sessionPath(home, "thr_src"), 3, (p) => {
          p.brief = "Implement §2.2 instead.";
        });
      } else if (which === "target session.open") {
        rewriteLine(sessionPath(home, "thr_tgt"), 0, (p) => {
          p.cwd = "/elsewhere";
        });
      } else {
        rewriteLine(sessionPath(home, "thr_src"), 4, (p) => {
          p.targetGenesisHash = "f".repeat(64);
        });
      }
      assert.deepEqual(
        codes(findingsOf(home, "thr_src")),
        ["fail handoff-mismatch"],
        `${which}: from the source`,
      );
      assert.deepEqual(
        codes(findingsOf(home, "thr_tgt")),
        ["fail handoff-mismatch"],
        `${which}: from the target`,
      );
      const target = sessionPath(home, "thr_tgt");
      const before = sha256(target);
      const e = inProcess(home);
      await e.init();
      expectEvidenceInvalid(
        await e.request("thread/resume", { threadId: "thr_tgt" }),
        "thr_tgt",
        "handoff-one-way",
      );
      assert.equal(sha256(target), before, `${which}: nothing appended to the target`);
      assert.equal(
        existsSync(lockPath(home, "thr_tgt")),
        false,
        `${which}: the probe lock is released`,
      );
      await e.close();
      edits.push([which, () => {}, "checked"]);
    } finally {
      cleanup();
    }
  }
  assert.equal(edits.length, 3);
});

// ------------------------------------------------------------------ item 2

test("M2 §10.2 one-way is refused: no handoff.link → -32010 handoff-one-way on thread/resume and on turn/start, nothing appended, doctor WARNs handoff-incomplete; the same with handoff.aborted", async () => {
  // (a) no terminal record at all.
  {
    const { home, cleanup } = makeHome();
    try {
      writePair(home, "none");
      assert.deepEqual(codes(findingsOf(home, "thr_src")), ["warn handoff-incomplete"]);
      assert.deepEqual(codes(findingsOf(home, "thr_tgt")), ["warn handoff-incomplete"]);
      const target = sessionPath(home, "thr_tgt");
      const before = { size: statSync(target).size, sha: sha256(target) };
      const e = inProcess(home);
      await e.init();
      const r = expectEvidenceInvalid(
        await e.request("thread/resume", { threadId: "thr_tgt" }),
        "thr_tgt",
        "handoff-one-way",
      );
      assert.match(r.issues.join(" "), /no handoff\.link or handoff\.aborted/);
      assert.deepEqual({ size: statSync(target).size, sha: sha256(target) }, before);
      assert.equal(existsSync(lockPath(home, "thr_tgt")), false, "lock released after the refusal");
      // The source is not a target: it serves as today.
      assert.ok((await e.request("thread/resume", { threadId: "thr_src" })).result);
      await serve(e, "thr_src", "carry on");
      await e.close();
      // I8 (Argus): "newest" is decided by mtime; the target is set a minute older explicitly, so
      // the assertion below never depends on two writes landing in different clock ticks.
      const older = new Date(Date.now() - 60_000);
      utimesSync(sessionPath(home, "thr_tgt"), older, older);
      // doctor's home report carries the finding for the newest session.
      const report = inspectMadcHome(home);
      assert.equal(report.lastSession?.threadId, "thr_src");
      assert.deepEqual(codes(report.lastSession?.findings ?? []), ["warn handoff-incomplete"]);
    } finally {
      cleanup();
    }
  }
  // (b) turn/start: the link was valid at resume; the source loses its handoff.link before the
  // first turn (its chain stays valid: the link was the last line) → turn/start refuses.
  {
    const { home, cleanup } = makeHome();
    try {
      writePair(home, "link");
      const e = inProcess(home);
      await e.init();
      assert.ok((await e.request("thread/resume", { threadId: "thr_tgt" })).result);
      const src = sessionPath(home, "thr_src");
      const kept = readLines(src).slice(0, -1);
      writeFileSync(src, `${kept.map((l) => JSON.stringify(l)).join("\n")}\n`);
      assert.equal(verifySessionFile(src, "thr_src").ok, true);
      const target = sessionPath(home, "thr_tgt");
      const before = sha256(target);
      expectEvidenceInvalid(
        await e.request("turn/start", { threadId: "thr_tgt", input: text("go") }),
        "thr_tgt",
        "handoff-one-way",
      );
      assert.equal(sha256(target), before, "no turn.start, no repo.decision: nothing appended");
      assert.ok(!e.received.some((m) => m.method === "turn/started"));
      // Every thread/resume re-checks, warm ones included.
      expectEvidenceInvalid(
        await e.request("thread/resume", { threadId: "thr_tgt" }),
        "thr_tgt",
        "handoff-one-way",
      );
      assert.equal(sha256(target), before);
      // Nothing to close for a thread that never served, but the engine still shuts down cleanly
      // and writes the target's session.close under its still-held lock.
      await e.close();
      assert.equal(types(target).at(-1), "session.close");
    } finally {
      cleanup();
    }
  }
  // (c) handoff.aborted: the attempt is closed (source OK), the target is orphaned.
  {
    const { home, cleanup } = makeHome();
    try {
      writePair(home, "aborted");
      assert.deepEqual(
        codes(findingsOf(home, "thr_src")),
        [],
        "a recorded failure is OK from the source",
      );
      assert.deepEqual(codes(findingsOf(home, "thr_tgt")), ["warn handoff-incomplete"]);
      const target = sessionPath(home, "thr_tgt");
      const before = sha256(target);
      const e = inProcess(home);
      await e.init();
      const r = expectEvidenceInvalid(
        await e.request("thread/resume", { threadId: "thr_tgt" }),
        "thr_tgt",
        "handoff-one-way",
      );
      assert.match(r.issues.join(" "), /handoff\.aborted \(target-genesis-unavailable\)/);
      assert.equal(sha256(target), before);
      await e.close();
    } finally {
      cleanup();
    }
  }
});

test("Copilot 4160774858 (#46): an unreadable source is handoff-unverifiable — the target may not serve (-32010), doctor WARNs; a source whose target is unreadable serves and doctor WARNs", async () => {
  const { home, cleanup } = makeHome();
  try {
    writePair(home, "link");
    // Target side: source deleted.
    unlinkSync(sessionPath(home, "thr_src"));
    const check = checkHandoffTarget(home, {
      threadId: "thr_tgt",
      seatId: "hephaestus",
      genesisHash: (readLines(sessionPath(home, "thr_tgt"))[0] as Line).hash,
      link: (readLines(sessionPath(home, "thr_tgt"))[0] as Line).payload.handoff as never,
    });
    assert.equal(check.ok, false);
    assert.equal(check.ok ? "" : check.kind, "unverifiable");
    assert.deepEqual(codes(findingsOf(home, "thr_tgt")), ["warn handoff-unverifiable"]);
    const target = sessionPath(home, "thr_tgt");
    const before = sha256(target);
    const e = inProcess(home);
    await e.init();
    const r = expectEvidenceInvalid(
      await e.request("thread/resume", { threadId: "thr_tgt" }),
      "thr_tgt",
      "handoff-one-way",
    );
    assert.match(r.issues.join(" "), /unverifiable/);
    assert.equal(sha256(target), before);
    await e.close();
  } finally {
    cleanup();
  }
  const { home: home2, cleanup: cleanup2 } = makeHome();
  try {
    writePair(home2, "link");
    // Source side: target deleted → the source serves as today; doctor WARNs.
    unlinkSync(sessionPath(home2, "thr_tgt"));
    assert.deepEqual(codes(findingsOf(home2, "thr_src")), ["warn handoff-unverifiable"]);
    const e = inProcess(home2);
    await e.init();
    assert.ok((await e.request("thread/resume", { threadId: "thr_src" })).result);
    await serve(e, "thr_src", "still here");
    await e.close();
    assert.equal(types(sessionPath(home2, "thr_src")).at(-1), "session.close");
  } finally {
    cleanup2();
  }
});

// ------------------------------------------------------------------ item 4

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
const commit = (dir: string, msg: string): string => {
  git(dir, ["-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", msg]);
  return git(dir, ["rev-parse", "HEAD"]);
};

test("M2 §10.4 worktree HEAD: session.open records the top-level, normalized origin and HEAD at open; session.close re-reads HEAD at the RECORDED top-level; a subdirectory, a non-git cwd, an unborn branch and a linked worktree record as pinned", async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "madc-m2a1-wt-"));
  const { home, cleanup } = makeHome();
  try {
    const repo = join(root, "repo");
    initRepo(repo);
    git(repo, ["config", "--local", "remote.origin.url", "git@github.com:Owner/Repo.git"]);
    const head1 = commit(repo, "one");
    mkdirSync(join(repo, "sub", "dir"), { recursive: true });
    const unborn = join(root, "unborn");
    initRepo(unborn);
    const linked = join(root, "linked");
    git(repo, ["worktree", "add", "--quiet", linked, "-b", "wt-branch"]);
    const nonGit = join(root, "plain");
    mkdirSync(nonGit);

    // This test loads five threads and each close-time re-read is three real `git` spawns. Under a
    // loaded machine those can spend the production 300 ms shutdown budget (Argus P8), after which
    // a re-read records `worktree: null` BY DESIGN and the assertions below dereference null. The
    // test asserts the identity rules, not the machine's git latency, so it uses the seam. The
    // bounded-shutdown property itself is asserted by the a.5 P8 tests, unmodified.
    const e = inProcess(home, echoAgent, { closeRereadBudgetMs: 30_000 });
    await e.init();
    const start = async (cwd: string) => {
      const r = await e.request("thread/start", { cwd });
      assert.ok(r.result, JSON.stringify(r.error));
      return (r.result as { thread: { id: string } }).thread.id;
    };
    const tRepo = await start(repo);
    const tSub = await start(join(repo, "sub", "dir"));
    const tPlain = await start(nonGit);
    const tUnborn = await start(unborn);
    const tLinked = await start(linked);
    const openOf = (id: string) => (readLines(sessionPath(home, id))[0] as Line).payload;
    const expectedRepo = {
      topLevel: realpathSync(repo),
      remote: "github.com/Owner/Repo",
      head: head1,
    };
    assert.deepEqual(openOf(tRepo).worktree, expectedRepo);
    assert.deepEqual(openOf(tSub).worktree, expectedRepo, "a subdirectory records the top-level");
    assert.equal(
      openOf(tSub).cwd,
      join(repo, "sub", "dir"),
      "cwd itself stays the caller's string",
    );
    assert.equal(openOf(tPlain).worktree, null, "a non-git cwd records null");
    assert.deepEqual(openOf(tUnborn).worktree, {
      topLevel: realpathSync(unborn),
      remote: null,
      head: null,
    });
    assert.deepEqual(openOf(tLinked).worktree, {
      topLevel: realpathSync(linked),
      remote: "github.com/Owner/Repo",
      head: head1,
    });
    for (const id of [tRepo, tSub, tPlain, tUnborn, tLinked])
      assert.equal(openOf(id).handoff, null);
    // The seat commits; the clean shutdown re-reads HEAD at the recorded top-level.
    const head2 = commit(repo, "two");
    assert.notEqual(head2, head1);
    await e.close();
    const closeOf = (id: string) => {
      const last = readLines(sessionPath(home, id)).at(-1) as Line;
      assert.equal(last.type, "session.close", id);
      return last.payload;
    };
    assert.deepEqual(closeOf(tRepo), {
      reason: "shutdown",
      worktree: { topLevel: realpathSync(repo), remote: "github.com/Owner/Repo", head: head2 },
    });
    assert.deepEqual(closeOf(tSub).worktree, { ...expectedRepo, head: head2 });
    assert.deepEqual(closeOf(tPlain), { reason: "shutdown", worktree: null });
    assert.deepEqual(
      (closeOf(tLinked).worktree as { head: string }).head,
      head1,
      "the linked worktree's own HEAD",
    );
    for (const id of [tRepo, tSub, tPlain, tUnborn, tLinked]) {
      const v = verifySessionFile(sessionPath(home, id), id, {}, home);
      assert.equal(v.ok, true, id);
      assert.deepEqual(inspectSessionV2(home, v.ok ? v.events : []), [], id);
    }
    // The recorded top-level vanishes before close → `worktree: null` at close, doctor WARNs.
    const e2 = inProcess(home);
    await e2.init();
    const gone = join(root, "gone");
    initRepo(gone);
    commit(gone, "x");
    const tGone = await start2(e2, gone);
    rmSync(gone, { recursive: true, force: true });
    await e2.close();
    assert.deepEqual(closeOf(tGone), { reason: "shutdown", worktree: null });
    const v = verifySessionFile(sessionPath(home, tGone), tGone, {}, home);
    assert.deepEqual(
      inspectSessionV2(home, v.ok ? v.events : []).map((f) => `${f.level} ${f.code}`),
      ["warn worktree-head-unreadable"],
    );
  } finally {
    cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});
async function start2(e: Engine, cwd: string): Promise<string> {
  const r = await e.request("thread/start", { cwd });
  assert.ok(r.result, JSON.stringify(r.error));
  return (r.result as { thread: { id: string } }).thread.id;
}

test("M2 §2.2 at thread/start: an engine-resolved worktree record that fails the shape refuses -32010 field-invalid with no session file and no lock left behind", async () => {
  const { home, cleanup } = makeHome();
  try {
    // The realpath seam yields a relative top-level: the record is invalid before any file exists.
    const e = inProcess(home, echoAgent, {
      worktreeDeps: {
        realpath: () => "relative/top-level",
        runGit: (args) =>
          args[0] === "rev-parse" && args[1] === "--show-toplevel"
            ? { code: 0, stdout: "/repo\n" }
            : args[0] === "rev-parse" && args[1] === "--verify"
              ? { code: 0, stdout: `${"c".repeat(40)}\n` }
              : { code: 1, stdout: "" },
      },
    });
    await e.init();
    const r = await e.request("thread/start", { cwd: "/repo" });
    const err = r.error as { code: number; data: Record<string, unknown> };
    assert.equal(err.code, -32010);
    assert.equal(err.data.reason, "field-invalid");
    assert.equal(err.data.type, "session.open");
    assert.match(String(err.data.issues), /worktree\.topLevel must be an absolute path/);
    const sessions = join(home, "sessions");
    assert.deepEqual(
      readdirSync(sessions).filter((n) => n.endsWith(".jsonl") || n.endsWith(".lock")),
      [],
      "no session file and no lock",
    );
    await e.close();
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------- D-M2-A0-5

test("M2 D-M2-A0-5: every clean shutdown writes session.close — after a served turn, after an interrupted turn, on a resumed v1 file; never when the lock was lost", async () => {
  const { home, cleanup } = makeHome();
  try {
    const e = inProcess(home);
    await e.init();
    const a = ((await e.request("thread/start", {})).result as { thread: { id: string } }).thread
      .id;
    await serve(e, a);
    // A v1 fixture (no v2 keys on its open) resumed by this engine gets a close too.
    mkdirSync(join(home, "sessions"), { recursive: true });
    const v1 = unguardedSessionWriterForTests.create(
      sessionPath(home, "thr_v1"),
      "thr_v1",
      "madc-default",
      { cwd: null, backing: BACKING, providerId: BACKING, pinnedModel: "m" },
      () => [],
      1,
      home,
    );
    v1.append("turn.start", { turnId: "turn_1", inputText: "x" });
    assert.ok((await e.request("thread/resume", { threadId: "thr_v1" })).result);
    // A thread whose lock was stolen is not closed (and the engine says so).
    const lost = ((await e.request("thread/start", {})).result as { thread: { id: string } }).thread
      .id;
    unlinkSync(lockPath(home, lost));
    const lostBefore = sha256(sessionPath(home, lost));
    await e.close();
    assert.deepEqual(types(sessionPath(home, a)).slice(-2), ["turn.end", "session.close"]);
    assert.deepEqual((readLines(sessionPath(home, a)).at(-1) as Line).payload, {
      reason: "shutdown",
      worktree: null,
    });
    assert.deepEqual(types(sessionPath(home, "thr_v1")), [
      "session.open",
      "turn.start",
      "turn.end",
      "session.close",
    ]);
    assert.equal(sha256(sessionPath(home, lost)), lostBefore, "a lost lock means no close");
    assert.ok(e.logs.some((l) => l === `session ${lost}: not closed (thread lock no longer held)`));
    for (const id of [a, "thr_v1"])
      assert.equal(verifySessionFile(sessionPath(home, id), id, {}, home).ok, true);
    // doctor: cleanly closed threads carry no `not-cleanly-closed`; a v2 thread that was never
    // closed (its lock gone) does.
    const closed = verifySessionFile(sessionPath(home, a), a, {}, home);
    assert.deepEqual(inspectSessionV2(home, closed.ok ? closed.events : []), []);
    const open = verifySessionFile(sessionPath(home, lost), lost, {}, home);
    assert.deepEqual(
      inspectSessionV2(home, open.ok ? open.events : []).map((f) => `${f.level} ${f.code}`),
      ["warn not-cleanly-closed"],
    );
  } finally {
    cleanup();
  }
  // An interrupted turn at EOF: turn.end interrupted, then session.close.
  const { home: home2, cleanup: cleanup2 } = makeHome();
  try {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slow: Agent = {
      name: "slow",
      async run(_ctx, sink) {
        const id = sink.newItemId();
        sink.startItem({ id, kind: "agentMessage", status: "inProgress", text: "" });
        await gate;
      },
    };
    const e = inProcess(home2, slow);
    await e.init();
    const t = ((await e.request("thread/start", {})).result as { thread: { id: string } }).thread
      .id;
    assert.ok((await e.request("turn/start", { threadId: t, input: text("x") })).result);
    await e.waitFor(
      (m) =>
        m.method === "item/started" &&
        (m.params?.item as { kind: string } | undefined)?.kind === "agentMessage",
    );
    await e.close();
    release();
    const lines = readLines(sessionPath(home2, t));
    assert.deepEqual(
      lines.slice(-2).map((l) => l.type),
      ["turn.end", "session.close"],
    );
    assert.equal((lines.at(-2) as Line).payload.status, "interrupted");
  } finally {
    cleanup2();
  }
});

// ------------------------------------------------------------------ item 6

test("M2 §10.6 seat gate, retargeted to the M2-A3 seat handoff allowlist pin: only a v2 seat with handoffs.enabled: true and a non-empty targets list of seat ids is relaxed; enabled: true with targets: [], a non-empty list with enabled: false, a wildcard entry and any v1 seat with handoffs on still fail thread/start with -32006", async () => {
  const { home, cleanup } = makeHome();
  try {
    const seat = (id: string, version: 1 | 2, enabled: boolean, targets: string[]) =>
      writeSeatFile(home, {
        ...seatFileBody(version === 1 ? MADC_DEFAULT_SEAT : HEPHAESTUS_SEAT),
        id,
        handoffs: { enabled, targets },
      });
    seat("ho-on", 1, true, []);
    seat("ho-targets", 1, false, ["hephaestus"]);
    seat("ho-v1-list", 1, true, ["hephaestus"]);
    seat("ho-v2-empty", 2, true, []);
    seat("ho-v2-off-list", 2, false, ["hephaestus"]);
    seat("ho-v2-wild", 2, true, ["*"]);
    seat("ho-v2-allow", 2, true, ["hephaestus"]);
    const e = inProcess(home);
    await e.init();
    for (const [seatId, issue] of [
      ["ho-on", "handoffs.enabled must be false in M0"],
      ["ho-targets", "handoffs.targets must be [] in M0"],
      ["ho-v1-list", "handoffs.enabled must be false in M0"],
      [
        "ho-v2-empty",
        "handoffs.targets must list at least one seat id when handoffs.enabled is true",
      ],
      ["ho-v2-off-list", "handoffs.targets must be [] when handoffs.enabled is false"],
      ["ho-v2-wild", "handoffs.targets[0] must match ^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$"],
    ] as const) {
      const r = await e.request("thread/start", { seatId });
      const err = r.error as { code: number; data: { issues: string[] } };
      assert.equal(err.code, -32006, seatId);
      assert.ok(err.data.issues.includes(issue), `${seatId}: ${JSON.stringify(err.data.issues)}`);
    }
    // The one relaxation: an allowlisted v2 seat now starts.
    const allowed = await e.request("thread/start", { seatId: "ho-v2-allow" });
    assert.ok(allowed.result, `ho-v2-allow: ${JSON.stringify(allowed.error)}`);
    await e.close();
  } finally {
    cleanup();
  }
});

// ------------------------------------------------ M2-A1 correction (Argus 5391475289)

test("Argus 5391475289 miss 1 (Copilot 4165236039): a target is not accepted against a source that contains a hash-valid malformed line (v2 or M0); doctor's chain row FAILs integrity for the v2 case", async () => {
  // (a) a malformed v2 line (founderDecision with evidenceRefs [null]) appended to a linked source.
  const { home, cleanup } = makeHome();
  try {
    writePair(home, "link");
    const src = sessionPath(home, "thr_src");
    const lines = readLines(src);
    const last = lines.at(-1) as Line;
    const body = {
      v: 1 as const,
      seq: last.seq + 1,
      ts: last.ts + 1,
      type: "founderDecision",
      threadId: "thr_src",
      seatId: "daedalus",
      payload: {
        decisionId: "dec_1",
        turnId: "turn_1",
        question: "q",
        recommendedDefault: "d",
        evidenceRefs: [null],
      },
    };
    const hash = sessionEventHash(last.hash, body as never);
    const { payload, ...head } = body;
    writeFileSync(
      src,
      `${readFileSync(src, "utf8")}${JSON.stringify({ ...head, prevHash: last.hash, hash, payload })}\n`,
    );
    const v = verifySessionFile(src, "thr_src", {}, home);
    assert.equal(v.ok, false, "the source does not verify any more (rule 1.5)");
    assert.equal(
      v.ok ? "" : `${v.kind} ${v.reason}`,
      "integrity malformed founderDecision payload",
    );
    const genesis = readLines(sessionPath(home, "thr_tgt"))[0] as Line;
    const check = checkHandoffTarget(home, {
      threadId: "thr_tgt",
      seatId: "hephaestus",
      genesisHash: genesis.hash,
      link: genesis.payload.handoff as never,
    });
    assert.equal(check.ok, false);
    assert.equal(check.ok ? "" : check.kind, "unverifiable");
    const target = sessionPath(home, "thr_tgt");
    const before = sha256(target);
    const e = inProcess(home);
    await e.init();
    expectEvidenceInvalid(
      await e.request("thread/resume", { threadId: "thr_tgt" }),
      "thr_tgt",
      "handoff-one-way",
    );
    assert.equal(sha256(target), before);
    await e.close();
    // doctor's read path on the SOURCE, selected by thread id — never as "the newest file": under
    // a coarse filesystem clock the two fixture writes can share an mtime, and the name tiebreak
    // then picks thr_tgt (the push CI run of 6c93967). The chain row doctor would carry for
    // thr_src is a FAIL integrity at the appended line, not a PASS with findings; nothing threw.
    const chain = verifySessionFile(sessionPath(home, "thr_src"), "thr_src", {}, home);
    assert.deepEqual(
      chain.ok
        ? { ok: true }
        : { ok: false, line: chain.line, reason: chain.reason, kind: chain.kind },
      {
        ok: false,
        line: lines.length + 1,
        reason: "malformed founderDecision payload",
        kind: "integrity",
      },
    );
  } finally {
    cleanup();
  }
  // (b) a malformed M0 line (item with an id outside the grammar): the chain verifies under the
  // M1 contract, but the gate validates the full payload shape and refuses the target.
  const { home: home2, cleanup: cleanup2 } = makeHome();
  try {
    writePair(home2, "link");
    rewriteLine(sessionPath(home2, "thr_src"), 1, (p) => {
      p.turnId = "bad id";
    });
    assert.equal(verifySessionFile(sessionPath(home2, "thr_src"), "thr_src", {}, home2).ok, true);
    const genesis = readLines(sessionPath(home2, "thr_tgt"))[0] as Line;
    const check = checkHandoffTarget(home2, {
      threadId: "thr_tgt",
      seatId: "hephaestus",
      genesisHash: genesis.hash,
      link: genesis.payload.handoff as never,
    });
    assert.equal(check.ok, false);
    assert.match(check.ok ? "" : check.issues.join(" "), /malformed turn.start payload/);
    const e = inProcess(home2);
    await e.init();
    expectEvidenceInvalid(
      await e.request("thread/resume", { threadId: "thr_tgt" }),
      "thr_tgt",
      "handoff-one-way",
    );
    await e.close();
  } finally {
    cleanup2();
  }
});

test("Argus 5391475289 miss 3 (Copilot 4165236178): head is null only for an unborn branch — a HEAD that does not resolve to a commit records no worktree at open and null at close (doctor WARNs worktree-head-unreadable)", async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "madc-m2a1-miss3-"));
  const { home, cleanup } = makeHome();
  try {
    // Real git: a detached HEAD naming an object that does not exist is not an unborn branch.
    const repo = join(root, "repo");
    initRepo(repo);
    const head1 = commit(repo, "one");
    // Same close-time reason as §10.4: several threads, three real `git` spawns per re-read, and
    // the production 300 ms shutdown budget can be spent on a loaded machine. The seam lets the
    // test assert the HEAD rules rather than the machine's git latency.
    const e = inProcess(home, echoAgent, { closeRereadBudgetMs: 30_000 });
    await e.init();
    const healthy = await start2(e, repo);
    writeFileSync(join(repo, ".git", "HEAD"), `${"0".repeat(39)}1\n`);
    const broken = await start2(e, repo);
    const openOf = (id: string) => (readLines(sessionPath(home, id))[0] as Line).payload;
    assert.deepEqual((openOf(healthy).worktree as { head: string }).head, head1);
    assert.equal(
      openOf(broken).worktree,
      null,
      "a HEAD that resolves to no commit is not an identity",
    );
    // The healthy thread closes while HEAD is broken: null at close, and doctor WARNs.
    await e.close();
    const closeOf = (id: string) => (readLines(sessionPath(home, id)).at(-1) as Line).payload;
    assert.deepEqual(closeOf(healthy), { reason: "shutdown", worktree: null });
    assert.deepEqual(closeOf(broken), { reason: "shutdown", worktree: null });
    const v = verifySessionFile(sessionPath(home, healthy), healthy, {}, home);
    assert.deepEqual(
      inspectSessionV2(home, v.ok ? v.events : []).map((f) => `${f.level} ${f.code}`),
      ["warn worktree-head-unreadable"],
    );
    // A genuine unborn branch (HEAD → a branch with no commit) still records head: null.
    const unborn = join(root, "unborn");
    initRepo(unborn);
    const orphan = join(root, "orphan");
    initRepo(orphan);
    commit(orphan, "x");
    git(orphan, ["checkout", "--quiet", "--orphan", "fresh"]);
    const e2 = inProcess(home, echoAgent, { closeRereadBudgetMs: 30_000 });
    await e2.init();
    const tUnborn = await start2(e2, unborn);
    const tOrphan = await start2(e2, orphan);
    assert.deepEqual(openOf(tUnborn).worktree, {
      topLevel: realpathSync(unborn),
      remote: null,
      head: null,
    });
    assert.deepEqual(openOf(tOrphan).worktree, {
      topLevel: realpathSync(orphan),
      remote: null,
      head: null,
    });
    await e2.close();
    for (const id of [tUnborn, tOrphan]) {
      const w = closeOf(id).worktree as { head: string | null };
      assert.equal(w.head, null, id);
      const vv = verifySessionFile(sessionPath(home, id), id, {}, home);
      assert.deepEqual(inspectSessionV2(home, vv.ok ? vv.events : []), [], id);
    }
  } finally {
    cleanup();
    rmSync(root, { recursive: true, force: true });
  }
  // The exact probe of the review: `rev-parse --verify HEAD` exits 128 while the path is inside
  // a work tree, and HEAD is not a symbolic ref. That is not unborn: no identity is recorded.
  const { home: home3, cleanup: cleanup3 } = makeHome();
  try {
    const e = inProcess(home3, echoAgent, {
      worktreeDeps: {
        realpath: (p) => p,
        runGit: (args) => {
          if (args[0] === "rev-parse" && args[1] === "--show-toplevel")
            return { code: 0, stdout: "/repo\n" };
          if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree")
            return { code: 0, stdout: "true\n" };
          if (args[0] === "rev-parse" && args[1] === "--verify") return { code: 128, stdout: "" };
          return { code: 128, stdout: "" };
        },
      },
    });
    await e.init();
    const t = await start2(e, "/repo");
    assert.equal((readLines(sessionPath(home3, t))[0] as Line).payload.worktree, null);
    await e.close();
    assert.deepEqual((readLines(sessionPath(home3, t)).at(-1) as Line).payload, {
      reason: "shutdown",
      worktree: null,
    });
  } finally {
    cleanup3();
  }
});
