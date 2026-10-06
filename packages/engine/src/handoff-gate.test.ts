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
 *
 * M2-A4 (`docs/plan/PIN-madc-M2-brief-delivery.md`, the commission's Part D rows): a handoff
 * target's first `turn/start` serves the source's brief once under the recorded `briefServed`
 * marker. Those tests drive the production provider agent on fake model ports, so every model call
 * and every `servedModel` receipt they check is the engine's own, and no paid call is made.
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
import { type ProviderPort, resolveKimiPinnedModel } from "@madc/adapters";
import { type Agent, echoAgent } from "./agent.ts";
import { checkHandoffTarget, inspectSessionV2, type SessionFinding } from "./handoff.ts";
import { inspectMadcHome } from "./inspect.ts";
import { ErrorCode, RpcError } from "./protocol/errors.ts";
import { createProviderAgent } from "./provider-agent.ts";
import { MADC_DEFAULT_SEAT } from "./seat.ts";
import { DAEDALUS_SEAT, HEPHAESTUS_SEAT } from "./seats/roster.ts";
import type { EngineOptions } from "./server.ts";
import { EngineConnection } from "./server.ts";
import {
  GENESIS_HASH,
  REDACTED,
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

// ------------------------------------------------- M2-A4: the target serves the brief

/** The brief `writePair` hands over (fixture text). */
const PAIR_BRIEF = "Implement §2.1.";
/** The brief the engine-driven room tests hand over (fixture text). */
const ROOM_BRIEF = "Write the runbook section on brief delivery; cite the pin by hash.";
const occurrences = (hay: string, needle: string) => hay.split(needle).length - 1;
const snapshotOf = (path: string) => ({ size: statSync(path).size, sha: sha256(path) });
const turnStarts = (path: string) => readLines(path).filter((l) => l.type === "turn.start");
/** Each `userMessage` item of a file, as its text parts. */
const userTexts = (path: string): string[][] =>
  readLines(path)
    .filter((l) => l.type === "item" && (l.payload.item as { kind: string }).kind === "userMessage")
    .map((l) =>
      (l.payload.item as { content: Array<{ text: string }> }).content.map((c) => c.text),
    );
const briefFindings = (findings: readonly SessionFinding[]) =>
  findings.filter((f) => f.code === "brief-unserved");

/** The echo agent, recording each turn's served input; `refuseNext.on` refuses one preflight. */
function recordingEcho(): { agent: Agent; inputs: string[][]; refuseNext: { on: boolean } } {
  const inputs: string[][] = [];
  const refuseNext = { on: false };
  const agent: Agent = {
    name: "recording-echo",
    preflight() {
      if (!refuseNext.on) return;
      refuseNext.on = false;
      throw new RpcError(ErrorCode.ProviderUnavailable, "Provider unavailable", {
        providerId: "codex",
        reason: "binary-missing",
      });
    },
    run(ctx, sink) {
      inputs.push(ctx.input.map((part) => part.text));
      return echoAgent.run(ctx, sink);
    },
  };
  return { agent, inputs, refuseNext };
}

type ModelCall = { readonly providerId: string; readonly text: string };

/** A fake model port: records the user message it is sent and answers "ok". */
function fakePort(providerId: string, calls: ModelCall[]): ProviderPort {
  return {
    providerId,
    async streamTurn(request) {
      calls.push({ providerId, text: request.messages.map((m) => m.text).join("\n") });
      request.onTextDelta("ok");
      return { text: "ok", requestedModelId: request.modelId, servedModel: request.modelId };
    },
  };
}

/**
 * The production provider agent on fake ports: `daedalus` serves on `claude-code`
 * (allowed-via-vendor-agent) and `prometheus` on `kimi-code` (allowed-direct), so a receipt that
 * named the other seat's lane would show.
 */
function roomAgent(calls: ModelCall[]): Agent {
  return createProviderAgent({
    directLanes: [
      {
        providerId: "kimi-code",
        credential: "fake-kimi-credential",
        createPort: () => fakePort("kimi-code", calls),
        resolvePinnedModel: resolveKimiPinnedModel,
      },
    ],
    createClaudePort: () => fakePort("claude-code", calls),
    detectClaudeBinary: () => "/fake/bin/claude",
  });
}

/** `daedalus` may hand off to `prometheus`; written before the engine seeds the roster. */
function allowPrometheus(home: string): void {
  writeSeatFile(home, {
    ...seatFileBody(DAEDALUS_SEAT),
    handoffs: { enabled: true, targets: ["prometheus"] },
  });
}

/** A `daedalus` source serves one turn, then hands `brief` to a new `prometheus` target. */
async function handOff(
  e: Engine,
  brief = ROOM_BRIEF,
): Promise<{ src: string; tgt: string; handoffId: string }> {
  const started = await e.request("thread/start", { seatId: "daedalus" });
  assert.ok(started.result, JSON.stringify(started.error));
  const src = (started.result as { thread: { id: string } }).thread.id;
  await serve(e, src, "plan the room");
  const r = await e.request("thread/handoff", {
    threadId: src,
    targetSeatId: "prometheus",
    brief,
    turnId: null,
  });
  const result = r.result as { handoffId: string; targetThreadId: string } | undefined;
  assert.ok(result, `thread/handoff: ${JSON.stringify(r.error)}`);
  return { src, tgt: result.targetThreadId, handoffId: result.handoffId };
}

test("M2-A4 D1/D2/D3/D6: a target's first turn/start serves the brief once, read from the source's handoff.out under the recorded briefServed marker; no later turn carries it, a restarted engine included; its servedModel receipt names its own seat and lane; the source file is byte-identical across the target's turns", async () => {
  const { home, cleanup } = makeHome();
  try {
    allowPrometheus(home);
    const calls: ModelCall[] = [];
    const e = inProcess(home, roomAgent(calls));
    await e.init();
    const { src, tgt, handoffId } = await handOff(e);
    const source = sessionPath(home, src);
    const target = sessionPath(home, tgt);
    assert.deepEqual(types(target), ["session.open"], "thread/handoff started no turn");
    const before = snapshotOf(source);
    assert.ok((await e.request("thread/resume", { threadId: tgt })).result);
    await serve(e, tgt, "first");
    await serve(e, tgt, "second");
    // D6: size and SHA-256 of the source, unchanged by the target's turns.
    assert.deepEqual(snapshotOf(source), before);

    // D1 / D2: what the target's model was sent — the brief first and exactly once, then never.
    const sent = calls.filter((c) => c.providerId === "kimi-code").map((c) => c.text);
    assert.deepEqual(sent, [`${ROOM_BRIEF}\nfirst`, "second"]);
    assert.equal(occurrences(sent[0] ?? "", ROOM_BRIEF), 1);

    // The marker on the first turn.start cites the source's handoff.out by seq and hash (H).
    const link = (readLines(target)[0] as Line).payload.handoff as {
      handoffId: string;
      sourceSeq: number;
      sourceHash: string;
    };
    assert.equal(link.handoffId, handoffId);
    const out = readLines(source)[link.sourceSeq] as Line;
    assert.equal(out.type, "handoff.out");
    assert.equal(out.hash, link.sourceHash);
    assert.equal(out.payload.brief, ROOM_BRIEF);
    const starts = turnStarts(target);
    assert.deepEqual(starts[0]?.payload.briefServed, {
      handoffId,
      sourceSeq: link.sourceSeq,
      sourceHash: link.sourceHash,
    });
    assert.equal(starts[0]?.payload.inputText, "first", "inputText stays what the caller sent");
    assert.equal(Object.hasOwn(starts[1]?.payload ?? {}, "briefServed"), false);
    assert.deepEqual(userTexts(target), [[ROOM_BRIEF, "first"], ["second"]]);
    assert.equal(occurrences(readFileSync(target, "utf8"), ROOM_BRIEF), 1, "one copy, on disk");

    // D3: each receipt names the seat (envelope) and lane that served it.
    const receipts = (path: string) =>
      readLines(path)
        .filter((l) => l.type === "servedModel")
        .map((l) => ({
          seatId: l.seatId,
          backing: l.payload.backing,
          providerId: l.payload.providerId,
          lane: l.payload.lane,
        }));
    const own = {
      seatId: "prometheus",
      backing: "kimi-code",
      providerId: "kimi-code",
      lane: "allowed-direct",
    };
    assert.deepEqual(receipts(target), [own, own]);
    assert.deepEqual(receipts(source), [
      {
        seatId: "daedalus",
        backing: "claude-code",
        providerId: "claude-code",
        lane: "allowed-via-vendor-agent",
      },
    ]);
    assert.deepEqual(
      e.received.filter((m) => m.error !== undefined),
      [],
    );
    await e.close();

    // D2 across a restart: a new engine resumes the target from disk and never re-delivers.
    const closed = snapshotOf(source); // the first engine's shutdown closed the source
    const calls2: ModelCall[] = [];
    const e2 = inProcess(home, roomAgent(calls2));
    await e2.init();
    assert.ok((await e2.request("thread/resume", { threadId: tgt })).result);
    await serve(e2, tgt, "third");
    await e2.close();
    assert.deepEqual(
      calls2.map((c) => c.text),
      ["third"],
    );
    assert.equal(turnStarts(target).length, 3);
    assert.equal(Object.hasOwn(turnStarts(target)[2]?.payload ?? {}, "briefServed"), false);
    assert.deepEqual(snapshotOf(source), closed);
    // D10: no finding, log line or error of either engine carries the brief.
    const texts = [
      ...[...findingsOf(home, src), ...findingsOf(home, tgt)].map((f) => f.detail),
      ...e.logs,
      ...e2.logs,
      ...[...e.received, ...e2.received]
        .filter((m) => m.error !== undefined)
        .map((m) => JSON.stringify(m)),
    ];
    assert.ok(!texts.some((t) => t.includes(ROOM_BRIEF)));
  } finally {
    cleanup();
  }
});

test("M2-A4 D4: a turn started by the source after the handoff does not deliver the brief — its model call, turn.start and userMessage carry none — while the target's first turn does", async () => {
  const { home, cleanup } = makeHome();
  try {
    allowPrometheus(home);
    const calls: ModelCall[] = [];
    const e = inProcess(home, roomAgent(calls));
    await e.init();
    const { src, tgt } = await handOff(e);
    await serve(e, src, "carry on");
    assert.ok((await e.request("thread/resume", { threadId: tgt })).result);
    await serve(e, tgt, "first");
    await e.close();
    const sentBy = (providerId: string) =>
      calls.filter((c) => c.providerId === providerId).map((c) => c.text);
    assert.deepEqual(sentBy("claude-code"), ["plan the room", "carry on"]);
    assert.deepEqual(sentBy("kimi-code"), [`${ROOM_BRIEF}\nfirst`]);
    const source = sessionPath(home, src);
    assert.deepEqual(userTexts(source), [["plan the room"], ["carry on"]]);
    assert.ok(turnStarts(source).every((l) => !Object.hasOwn(l.payload, "briefServed")));
    assert.notEqual(turnStarts(sessionPath(home, tgt))[0]?.payload.briefServed, undefined);
  } finally {
    cleanup();
  }
});

test("M2-A4 D5: delivering twice is refused -32010 field-invalid, nothing appended and the writer usable — a second briefServed after the target's first turn.start; so are a marker on a thread that is not a target, one that differs from the link and malformed ones", async () => {
  const { home, cleanup } = makeHome();
  try {
    allowPrometheus(home);
    const e = inProcess(home, roomAgent([]));
    await e.init();
    const one = await handOff(e);
    const two = await handOff(e, "A second brief, for the refusal cases.");
    assert.ok((await e.request("thread/resume", { threadId: one.tgt })).result);
    await serve(e, one.tgt, "first");
    await e.close();
    const markerOf = (id: string) => {
      const h = (readLines(sessionPath(home, id))[0] as Line).payload.handoff as Record<
        string,
        unknown
      >;
      return { handoffId: h.handoffId, sourceSeq: h.sourceSeq, sourceHash: h.sourceHash };
    };
    const writerFor = (id: string, seatId: string) => {
      const path = sessionPath(home, id);
      const v = verifySessionFile(path, id, {}, home);
      assert.ok(v.ok, id);
      return unguardedSessionWriterForTests.resume(
        path,
        id,
        seatId,
        v.nextSeq,
        v.lastHash,
        () => [],
        home,
      );
    };
    const start = (turnId: string, briefServed: unknown) =>
      ({ turnId, inputText: "again", mode: "headless", presence: "absent", briefServed }) as never;
    const refused = (
      id: string,
      seatId: string,
      briefServed: unknown,
      reason: string,
      issue: string,
    ) => {
      const path = sessionPath(home, id);
      const w = writerFor(id, seatId);
      const before = { ...snapshotOf(path), next: w.nextSeq };
      assert.throws(
        () => w.append("turn.start", start("turn_twice", briefServed)),
        (err: unknown) => {
          assert.ok(err instanceof RpcError, String(err));
          assert.equal(err.code, -32010);
          assert.equal(err.data?.type, "turn.start");
          assert.equal(err.data?.reason, reason, issue);
          assert.deepEqual(err.data?.issues, [issue]);
          return true;
        },
      );
      assert.deepEqual(
        { ...snapshotOf(path), next: w.nextSeq },
        before,
        `${issue}: nothing appended`,
      );
      assert.equal(w.broken, false, issue);
      return w;
    };
    const twice = "briefServed stands after an earlier turn.start (the brief is served once)";
    // D5: the target served its brief on its first turn.start; a second delivery is refused.
    const w1 = refused(one.tgt, "prometheus", markerOf(one.tgt), "field-invalid", twice);
    w1.append("turn.start", {
      turnId: "turn_plain",
      inputText: "plain",
      mode: "headless",
      presence: "absent",
    });
    refused(
      one.src,
      "daedalus",
      markerOf(one.tgt),
      "field-invalid",
      "briefServed stands in a file whose session.open has no handoff link",
    );
    // The second target is unserved: another link's marker and malformed markers are refused.
    refused(
      two.tgt,
      "prometheus",
      markerOf(one.tgt),
      "field-invalid",
      "briefServed differs from session.open.handoff",
    );
    refused(
      two.tgt,
      "prometheus",
      { ...markerOf(two.tgt), sourceHash: "f" },
      "field-invalid",
      "briefServed.sourceHash must be 64 lowercase hex",
    );
    const { sourceHash: _dropped, ...noHash } = markerOf(two.tgt);
    refused(two.tgt, "prometheus", noHash, "field-missing", "briefServed.sourceHash is required");
    refused(
      two.tgt,
      "prometheus",
      { ...markerOf(two.tgt), extra: "x" },
      "field-invalid",
      "briefServed has a key outside handoffId, sourceSeq and sourceHash",
    );
    refused(two.tgt, "prometheus", null, "field-invalid", "briefServed must be an object");
    // Positive control: the second target's own marker is accepted once, then refused.
    writerFor(two.tgt, "prometheus").append("turn.start", start("turn_first", markerOf(two.tgt)));
    refused(two.tgt, "prometheus", markerOf(two.tgt), "field-invalid", twice);
    for (const id of [one.tgt, one.src, two.tgt]) {
      assert.equal(verifySessionFile(sessionPath(home, id), id, {}, home).ok, true, id);
    }
  } finally {
    cleanup();
  }
});

test("M2-A4 D7/D10: a target whose link does not verify at its next turn/start refuses -32010 handoff-one-way before serving — nothing appended, the agent not run, no brief text in the refusal or the log; the brief is read on the read that re-checks the link, so a gate result cached by an earlier refused turn/start never serves a source changed since", async () => {
  // (a) The link breaks after the target loaded; restored, the same target serves its brief.
  for (const breakage of ["no handoff.link", "source deleted"] as const) {
    const { home, cleanup } = makeHome();
    try {
      const { out } = writePair(home, "link");
      const rec = recordingEcho();
      const e = inProcess(home, rec.agent);
      await e.init();
      assert.ok((await e.request("thread/resume", { threadId: "thr_tgt" })).result);
      const src = sessionPath(home, "thr_src");
      const saved = readFileSync(src);
      if (breakage === "no handoff.link") {
        const kept = readLines(src).slice(0, -1);
        writeFileSync(src, `${kept.map((l) => JSON.stringify(l)).join("\n")}\n`);
      } else {
        unlinkSync(src);
      }
      const target = sessionPath(home, "thr_tgt");
      const before = snapshotOf(target);
      const m = await e.request("turn/start", { threadId: "thr_tgt", input: text("go") });
      expectEvidenceInvalid(m, "thr_tgt", "handoff-one-way");
      assert.ok(!JSON.stringify(m).includes(PAIR_BRIEF), `${breakage}: no brief in the refusal`);
      assert.deepEqual(snapshotOf(target), before, `${breakage}: nothing appended`);
      assert.deepEqual(rec.inputs, [], `${breakage}: the agent never ran`);
      assert.ok(!e.received.some((x) => x.method === "turn/started"));
      writeFileSync(src, saved);
      await serve(e, "thr_tgt", "go");
      assert.deepEqual(rec.inputs, [[PAIR_BRIEF, "go"]], `${breakage}: served once restored`);
      assert.deepEqual(turnStarts(target)[0]?.payload.briefServed, {
        handoffId: "ho_1",
        sourceSeq: out.seq,
        sourceHash: out.hash,
      });
      assert.ok(!e.logs.some((l) => l.includes(PAIR_BRIEF)), `${breakage}: no brief in the log`);
      await e.close();
    } finally {
      cleanup();
    }
  }
  // (b) The gate passes and is cached by a turn/start that preflight then refuses; the source's
  // handoff.out is rewritten (its file stays self-consistent); the next turn/start refuses.
  const { home, cleanup } = makeHome();
  try {
    writePair(home, "link");
    const rec = recordingEcho();
    const e = inProcess(home, rec.agent);
    await e.init();
    assert.ok((await e.request("thread/resume", { threadId: "thr_tgt" })).result);
    const target = sessionPath(home, "thr_tgt");
    const before = snapshotOf(target);
    rec.refuseNext.on = true;
    const first = await e.request("turn/start", { threadId: "thr_tgt", input: text("go") });
    assert.equal((first.error as { code: number } | undefined)?.code, -32008, "preflight refused");
    const TAMPERED = "Implement §2.2 instead.";
    rewriteLine(sessionPath(home, "thr_src"), 3, (p) => {
      p.brief = TAMPERED;
    });
    const m = await e.request("turn/start", { threadId: "thr_tgt", input: text("go") });
    const r = expectEvidenceInvalid(m, "thr_tgt", "handoff-one-way");
    assert.match(r.issues.join(" "), /hash differs from the recorded sourceHash/);
    for (const brief of [PAIR_BRIEF, TAMPERED]) {
      assert.ok(!JSON.stringify(m).includes(brief), "no brief in the refusal");
      assert.ok(!e.logs.some((l) => l.includes(brief)), "no brief in the log");
    }
    assert.deepEqual(snapshotOf(target), before, "nothing appended");
    assert.deepEqual(rec.inputs, [], "the agent never ran");
    await e.close();
  } finally {
    cleanup();
  }
});

test("M2-A4 D8/D10: inspectSessionV2 and doctor report an unserved target as WARN brief-unserved — ids and seqs, never the brief — until its first turn serves it; thread/list carries no served state; a target whose first turn.start has no marker is reported and never served late; an orphaned target is not reported", async () => {
  // (a) Unserved, then served.
  {
    const { home, cleanup } = makeHome();
    try {
      writePair(home, "link");
      const unserved = briefFindings(findingsOf(home, "thr_tgt"));
      assert.deepEqual(unserved, [
        {
          level: "warn",
          code: "brief-unserved",
          detail:
            "handoff ho_1 (source thr_src seq 3): no turn.start yet; this target's next turn/start serves it",
        },
      ]);
      assert.deepEqual(briefFindings(findingsOf(home, "thr_src")), [], "a source is no target");
      // doctor's home report, with the target as the newest session.
      const older = new Date(Date.now() - 60_000);
      utimesSync(sessionPath(home, "thr_src"), older, older);
      const report = inspectMadcHome(home);
      assert.equal(report.lastSession?.threadId, "thr_tgt");
      assert.deepEqual(
        briefFindings(report.lastSession?.findings ?? []).map((f) => `${f.level} ${f.code}`),
        ["warn brief-unserved"],
      );
      // thread/list: the six summary keys and nothing about handoffs or serving.
      const rec = recordingEcho();
      const e = inProcess(home, rec.agent);
      await e.init();
      const rowsOf = async (engine: Engine) =>
        (
          (await engine.request("thread/list", {})).result as {
            data: Array<Record<string, unknown>>;
          }
        ).data;
      const rows = await rowsOf(e);
      for (const row of rows) {
        assert.deepEqual(Object.keys(row).sort(), [
          "createdAt",
          "id",
          "preview",
          "seatId",
          "status",
          "updatedAt",
        ]);
      }
      assert.equal(rows.find((row) => row.id === "thr_tgt")?.preview, "");
      assert.ok(!JSON.stringify(rows).includes(PAIR_BRIEF));
      assert.ok((await e.request("thread/resume", { threadId: "thr_tgt" })).result);
      await serve(e, "thr_tgt", "go");
      assert.deepEqual(rec.inputs, [[PAIR_BRIEF, "go"]]);
      assert.deepEqual(briefFindings(findingsOf(home, "thr_tgt")), [], "served: no WARN");
      // `preview` is the first user text the turn served, live and rebuilt alike (pin §4).
      const live = (await rowsOf(e)).find((row) => row.id === "thr_tgt");
      await e.close();
      const e2 = inProcess(home);
      await e2.init();
      const cold = (await rowsOf(e2)).find((row) => row.id === "thr_tgt");
      await e2.close();
      assert.equal(live?.preview, PAIR_BRIEF);
      assert.equal(cold?.preview, live?.preview);
      const details = [...findingsOf(home, "thr_src"), ...findingsOf(home, "thr_tgt"), ...unserved];
      assert.ok(details.every((f) => !f.detail.includes(PAIR_BRIEF)));
    } finally {
      cleanup();
    }
  }
  // (b) A target whose first turn.start was written without a marker (an engine before M2-A4).
  {
    const { home, cleanup } = makeHome();
    try {
      writePair(home, "link");
      const target = sessionPath(home, "thr_tgt");
      const v = verifySessionFile(target, "thr_tgt", {}, home);
      assert.ok(v.ok);
      const w = unguardedSessionWriterForTests.resume(
        target,
        "thr_tgt",
        "hephaestus",
        v.nextSeq,
        v.lastHash,
        () => [],
        home,
      );
      w.append("turn.start", { turnId: "turn_early", inputText: "earlier" }, 1006);
      w.append("turn.end", { turnId: "turn_early", status: "completed", error: null }, 1007);
      assert.deepEqual(
        briefFindings(findingsOf(home, "thr_tgt")).map((f) => f.detail),
        [
          "handoff ho_1 (source thr_src seq 3): the first turn.start (seq 1) carries no briefServed; the brief was never served",
        ],
      );
      const rec = recordingEcho();
      const e = inProcess(home, rec.agent);
      await e.init();
      assert.ok((await e.request("thread/resume", { threadId: "thr_tgt" })).result);
      await serve(e, "thr_tgt", "go");
      await e.close();
      assert.deepEqual(rec.inputs, [["go"]], "its first turn has passed: never served late");
      assert.ok(turnStarts(target).every((l) => !Object.hasOwn(l.payload, "briefServed")));
    } finally {
      cleanup();
    }
  }
  // (c) An orphaned target already has its handoff finding and can never serve.
  {
    const { home, cleanup } = makeHome();
    try {
      writePair(home, "aborted");
      assert.deepEqual(briefFindings(findingsOf(home, "thr_tgt")), []);
      assert.deepEqual(codes(findingsOf(home, "thr_tgt")), ["warn handoff-incomplete"]);
    } finally {
      cleanup();
    }
  }
});

test("M2-A4 pin §3 read side: a briefServed marker that differs from the link, stands on a later turn.start or stands in a thread that is not a target is doctor FAIL integrity (no brief text); the chain verifier tolerates the additive field, and the engine never re-delivers on such a file", async () => {
  const integrity = (home: string, id: string) =>
    findingsOf(home, id)
      .filter((f) => f.code === "integrity")
      .map((f) => f.detail);
  const servedPair = async (home: string) => {
    writePair(home, "link");
    const e = inProcess(home);
    await e.init();
    assert.ok((await e.request("thread/resume", { threadId: "thr_tgt" })).result);
    await serve(e, "thr_tgt", "go");
    await serve(e, "thr_tgt", "again");
    await e.close();
    return sessionPath(home, "thr_tgt");
  };
  // (a) The marker differs from the link.
  {
    const { home, cleanup } = makeHome();
    try {
      const target = await servedPair(home);
      assert.deepEqual(integrity(home, "thr_tgt"), []);
      const seq = (turnStarts(target)[0] as Line).seq;
      rewriteLine(target, seq, (p) => {
        (p.briefServed as Record<string, unknown>).sourceHash = "f".repeat(64);
      });
      assert.deepEqual(integrity(home, "thr_tgt"), [
        `line ${seq + 1}: briefServed differs from session.open.handoff`,
      ]);
      const rec = recordingEcho();
      const e = inProcess(home, rec.agent);
      await e.init();
      assert.ok((await e.request("thread/resume", { threadId: "thr_tgt" })).result);
      await serve(e, "thr_tgt", "third");
      await e.close();
      assert.deepEqual(rec.inputs, [["third"]], "never re-delivered");
    } finally {
      cleanup();
    }
  }
  // (b) The marker moved from the first turn.start to the second.
  {
    const { home, cleanup } = makeHome();
    try {
      const target = await servedPair(home);
      const [first, second] = turnStarts(target) as [Line, Line];
      const marker = first.payload.briefServed;
      rewriteLine(target, first.seq, (p) => {
        p.briefServed = undefined;
      });
      rewriteLine(target, second.seq, (p) => {
        p.briefServed = marker;
      });
      assert.deepEqual(integrity(home, "thr_tgt"), [
        `line ${second.seq + 1}: briefServed stands after an earlier turn.start (the brief is served once)`,
      ]);
      assert.deepEqual(
        briefFindings(findingsOf(home, "thr_tgt")).map((f) => f.code),
        ["brief-unserved"],
      );
    } finally {
      cleanup();
    }
  }
  // (c) A marker in a thread that is not a target.
  {
    const { home, cleanup } = makeHome();
    try {
      writePair(home, "link");
      rewriteLine(sessionPath(home, "thr_src"), 1, (p) => {
        p.briefServed = { handoffId: "ho_1", sourceSeq: 3, sourceHash: "a".repeat(64) };
      });
      assert.deepEqual(integrity(home, "thr_src"), [
        "line 2: briefServed stands in a file whose session.open has no handoff link",
      ]);
    } finally {
      cleanup();
    }
  }
});

test("M2-A4 B1: the brief served is the source's handoff.out as written — redacted on disk — never the caller's thread/handoff value or a copy cached by the engine that took the handoff", async () => {
  const { home, cleanup } = makeHome();
  try {
    const KEY = `sk-${"A1b2C3d4".repeat(4)}`;
    allowPrometheus(home);
    const calls: ModelCall[] = [];
    const e = inProcess(home, roomAgent(calls));
    await e.init();
    const { tgt } = await handOff(e, `Retire the old key ${KEY} before release.`);
    assert.ok((await e.request("thread/resume", { threadId: tgt })).result);
    await serve(e, tgt, "first");
    await e.close();
    assert.deepEqual(
      calls.filter((c) => c.providerId === "kimi-code").map((c) => c.text),
      [`Retire the old key ${REDACTED} before release.\nfirst`],
    );
    assert.ok(!JSON.stringify(e.received).includes(KEY), "the wire never carries the key");
    assert.ok(!readFileSync(sessionPath(home, tgt), "utf8").includes(KEY));
  } finally {
    cleanup();
  }
});
