/**
 * M2-A1 follow-up (Hephaestus; Argus follow-up list `followup-pr47-ce10ca0`, §(a) items a.1–a.13):
 * one behavior test per fix, each named with the Argus finding id, and one test per mutant that
 * survived the full suite at `ce10ca0` (P25). Every test here was shown to FAIL with its named
 * mutant applied (`M2A1-FU-mutations.txt`).
 *
 * Network-free and in-process: the echo agent, fake `git` runners through the engine's own seams
 * (`worktreeDeps`, `InspectSessionDeps.runGit`), and session files written by the engine's writer
 * or hashed with the seat pin §4.3 formula.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs, {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import { type Agent, echoAgent } from "./agent.ts";
import { checkHandoffTarget, inspectSessionV2, type SessionFinding } from "./handoff.ts";
import { defaultGitRunner, type GitRunner } from "./policy/identity.ts";
import { ErrorCode, EVIDENCE_REFUSALS, RpcError } from "./protocol/errors.ts";
import { CLOSE_REREAD_BUDGET_MS, EngineConnection, type EngineOptions } from "./server.ts";
import {
  GENESIS_HASH,
  rebuildSession,
  SessionChainIndex,
  type SessionEvent,
  type SessionOpenPayload,
  SessionWriter,
  sessionEventHash,
  setSessionResumeReadForTests,
  unguardedSessionWriterForTests,
  verifySessionFile,
  verifySessionText,
} from "./session-store.ts";
import { checkV2Payload, type WorktreeIdentity } from "./session-v2.ts";
import { makeHome } from "./testing/harness.ts";
import { rereadWorktreeIdentity, resolveWorktreeIdentity } from "./worktree.ts";

type Wire = Record<string, unknown> & { params?: Record<string, unknown> };
type Line = SessionEvent & { payload: Record<string, unknown> };

const HEX64 = "a".repeat(64);
const SHA_C = "c".repeat(40);
const BACKING = "kimi-code";
const V1_OPEN: SessionOpenPayload = {
  cwd: null,
  backing: BACKING,
  providerId: BACKING,
  pinnedModel: "m",
};
const V2_OPEN: SessionOpenPayload = { ...V1_OPEN, worktree: null, handoff: null };
const REPO_WT: WorktreeIdentity = { topLevel: "/repo", remote: null, head: SHA_C };
const GHP = `ghp_${"A1b2C3d4E5".repeat(4)}`; // a token shape that is also a valid id
const SECRET = "sk-FUPROBEsecret0123456789"; // a configured secret that is also a valid id

const text = (t: string) => [{ type: "text", text: t }];
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const sessionPath = (home: string, id: string) => join(home, "sessions", `${id}.jsonl`);
const readLines = (path: string): Line[] =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as Line);
const types = (path: string) => readLines(path).map((l) => l.type);
const lockFiles = (home: string) =>
  existsSync(join(home, "sessions"))
    ? readdirSync(join(home, "sessions")).filter((n) => n.endsWith(".lock"))
    : [];
const brief = (findings: readonly SessionFinding[]) => findings.map((f) => `${f.level} ${f.code}`);
/** Synchronous sleep (a hung `git` blocks the event loop exactly like `spawnSync` does). */
const sleepSync = (ms: number) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
};

type Snapshot = { size: number; sha: string };
const snapshot = (path: string): Snapshot => ({ size: statSync(path).size, sha: sha256(path) });

type Fixture = { dir: string; path: string; writer: SessionWriter; cleanup: () => void };
function fixture(
  threadId = "thr_src",
  seatId = "madc-default",
  open: SessionOpenPayload = V2_OPEN,
  secrets: () => readonly string[] = () => [],
): Fixture {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "madc-m2a1fu-"));
  mkdirSync(join(dir, "sessions"), { mode: 0o700 });
  const path = join(dir, "sessions", `${threadId}.jsonl`);
  const writer = unguardedSessionWriterForTests.create(path, threadId, seatId, open, secrets);
  return { dir, path, writer, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

type AnyWriter = { append(type: string, payload: unknown): SessionEvent; nextSeq: number };
const raw = (writer: SessionWriter): AnyWriter => writer as unknown as AnyWriter;

/** The pinned -32010 refusal: data shape, nothing appended, nextSeq unchanged, writer usable. */
function expectRefusal(
  f: Fixture,
  type: string,
  payload: unknown,
  reason: string,
  turnId: string | null = null,
): { issues: string[]; data: Record<string, unknown> } {
  const before = snapshot(f.path);
  const seq = f.writer.nextSeq;
  let data: Record<string, unknown> | undefined;
  assert.throws(
    () => raw(f.writer).append(type, payload),
    (err: unknown) => {
      assert.ok(err instanceof RpcError, `${type}: an RpcError, got ${String(err)}`);
      assert.equal(err.code, ErrorCode.EvidenceInvalid, `${type}: code -32010`);
      data = err.data;
      return true;
    },
  );
  assert.ok(data);
  assert.deepEqual(Object.keys(data).sort(), ["issues", "reason", "threadId", "turnId", "type"]);
  assert.equal(data.threadId, f.writer.threadId);
  assert.equal(data.turnId, turnId);
  assert.equal(data.type, type);
  assert.equal(data.reason, reason, `${type}: reason (${JSON.stringify(data.issues)})`);
  assert.ok(EVIDENCE_REFUSALS.includes(data.reason as never));
  assert.deepEqual(snapshot(f.path), before, `${type}: nothing appended (size + sha256)`);
  assert.equal(f.writer.nextSeq, seq, `${type}: nextSeq unchanged`);
  assert.equal(f.writer.broken, false, `${type}: writer not broken`);
  return { issues: data.issues as string[], data };
}

/** Lines hashed with the engine's formula (ts = 1000 + seq, so a prefix always hashes the same). */
function rawEvents(
  lines: ReadonlyArray<{ type: string; payload: Record<string, unknown> }>,
  threadId = "thr_raw",
  seatId = "madc-default",
): Line[] {
  let prev = GENESIS_HASH;
  return lines.map(({ type, payload }, seq) => {
    const body = { v: 1 as const, seq, ts: 1000 + seq, type, threadId, seatId, payload };
    const hash = sessionEventHash(prev, body as never);
    const line = { ...body, prevHash: prev, hash } as unknown as Line;
    prev = hash;
    return line;
  });
}
const rawText = (events: readonly Line[]) =>
  events
    .map((e) => {
      const { v, seq, ts, type, threadId, seatId, prevHash, hash, payload } = e;
      return `${JSON.stringify({ v, seq, ts, type, threadId, seatId, prevHash, hash, payload })}\n`;
    })
    .join("");
function writeRaw(home: string, threadId: string, events: readonly Line[]): string {
  mkdirSync(join(home, "sessions"), { recursive: true, mode: 0o700 });
  const path = sessionPath(home, threadId);
  writeFileSync(path, rawText(events), { mode: 0o600 });
  return path;
}

/** Rewrite line `seq`'s payload and recompute the file's hashes from there on (self-consistent tamper). */
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
  assert.equal(verifySessionFile(path).ok, true, "the rewritten file still verifies on its own");
}

/**
 * §2.1 order with the engine's own writer: source `thr_src` (seat daedalus) writes `handoff.out`
 * to `outTargetSeat`; target `thr_tgt` (seat hephaestus) opens citing it, naming `sourceSeatId`;
 * the source then writes `handoff.link` (or nothing).
 */
function writePair(
  home: string,
  opts: { link?: boolean; outTargetSeat?: string; sourceSeatId?: string } = {},
): { out: SessionEvent; G: string } {
  mkdirSync(join(home, "sessions"), { recursive: true, mode: 0o700 });
  const src = unguardedSessionWriterForTests.create(
    sessionPath(home, "thr_src"),
    "thr_src",
    "daedalus",
    V2_OPEN,
    () => [],
    1000,
    home,
  );
  src.append("turn.start", { turnId: "turn_1", inputText: "plan" }, 1001);
  src.append("turn.end", { turnId: "turn_1", status: "completed", error: null }, 1002);
  const out = src.append(
    "handoff.out",
    {
      handoffId: "ho_1",
      turnId: "turn_1",
      targetSeatId: opts.outTargetSeat ?? "hephaestus",
      brief: "Implement §2.1.",
    },
    1003,
  );
  const tgt = unguardedSessionWriterForTests.create(
    sessionPath(home, "thr_tgt"),
    "thr_tgt",
    "hephaestus",
    {
      ...V2_OPEN,
      handoff: {
        sourceThreadId: "thr_src",
        sourceSeatId: opts.sourceSeatId ?? "daedalus",
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
  if (opts.link !== false) {
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
  }
  return { out, G };
}
const targetFacts = (home: string) => {
  const open = readLines(sessionPath(home, "thr_tgt"))[0] as Line;
  return {
    threadId: "thr_tgt",
    seatId: "hephaestus",
    genesisHash: open.hash,
    link: open.payload.handoff as never,
  };
};
function findingsOf(home: string, threadId: string, runGit?: GitRunner): SessionFinding[] {
  const v = verifySessionFile(sessionPath(home, threadId), threadId, {}, home);
  assert.ok(v.ok, `${threadId} verifies`);
  return v.ok ? inspectSessionV2(home, v.events, runGit === undefined ? {} : { runGit }) : [];
}

/** In-process engine on `home`, with `conn` exposed so `shutdown()` can be called directly. */
function inProcess(home: string, extra: Partial<EngineOptions> = {}, agent: Agent = echoAgent) {
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
    const until = Date.now() + 10_000;
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
  const startThread = async (cwd: string | null): Promise<string> => {
    const r = await request("thread/start", cwd === null ? {} : { cwd });
    assert.ok(r.result, `thread/start: ${JSON.stringify(r.error)}`);
    return (r.result as { thread: { id: string } }).thread.id;
  };
  return { conn, input, received, logs, done, waitFor, request, init, close, startThread };
}

/**
 * A fake `git` for one repository at `top` (the realpath seam is the identity). `head` answers
 * `rev-parse --verify HEAD^{commit}`; `symbolic` answers `symbolic-ref`; `showRef` answers
 * `show-ref --verify`; `config` answers the origin lookup (default: no origin).
 */
type GitPlan = {
  top?: string;
  head?: { code: number | null; stdout: string };
  symbolic?: { code: number | null; stdout: string };
  showRef?: { code: number | null; stdout: string };
  config?: { code: number | null; stdout: string };
};
function fakeGit(plan: GitPlan | (() => GitPlan)): GitRunner {
  return (args, cwd) => {
    const p = typeof plan === "function" ? plan() : plan;
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
      return { code: 0, stdout: `${p.top ?? cwd}\n` };
    }
    if (args[0] === "rev-parse" && args[1] === "--verify") return p.head ?? { code: 1, stdout: "" };
    if (args[0] === "symbolic-ref") return p.symbolic ?? { code: 0, stdout: "refs/heads/main\n" };
    if (args[0] === "show-ref") return p.showRef ?? { code: 1, stdout: "" };
    if (args[0] === "config") return p.config ?? { code: 1, stdout: "" };
    return { code: 1, stdout: "" };
  };
}
const identityPath = (p: string) => p;
const RESOLVED: GitPlan = { head: { code: 0, stdout: `${SHA_C}\n` } };

// ===================================================================== a.2 P6 (N14)

test("M2-A1 FU a.2 P6 / N14 (Copilot r4165840875): a HEAD that does not resolve reads as an unborn branch ONLY when show-ref exits 1; exit 0, a timeout (null), 128 or any other code records no worktree", () => {
  const deps = (code: number | null) => ({
    realpath: identityPath,
    runGit: fakeGit({ showRef: { code, stdout: "" } }),
  });
  const recorded: WorktreeIdentity = { topLevel: "/repo", remote: null, head: null };
  for (const code of [0, null, 128, 2]) {
    assert.equal(resolveWorktreeIdentity("/repo", deps(code)), null, `open: show-ref ${code}`);
    assert.equal(rereadWorktreeIdentity(recorded, deps(code)), null, `close: show-ref ${code}`);
  }
  assert.deepEqual(resolveWorktreeIdentity("/repo", deps(1)), recorded, "exit 1: unborn");
  assert.deepEqual(rereadWorktreeIdentity(recorded, deps(1)), recorded, "exit 1: unborn");
});

test("M2-A1 FU a.2 P6 / N14 through the engine: session.open records worktree null and session.close records worktree: null unless show-ref exits 1", async () => {
  for (const code of [0, null, 128, 1]) {
    const { home, cleanup } = makeHome();
    try {
      // Open: HEAD^{commit} fails, HEAD names refs/heads/main, show-ref answers `code`.
      let phase: "open" | "close" = "open";
      const e = inProcess(home, {
        worktreeDeps: {
          realpath: identityPath,
          runGit: fakeGit(() =>
            phase === "open"
              ? { showRef: { code, stdout: "" } }
              : { showRef: { code, stdout: "" } },
          ),
        },
      });
      await e.init();
      const id = await e.startThread("/repo");
      const open = readLines(sessionPath(home, id))[0] as Line;
      const expected = code === 1 ? { topLevel: "/repo", remote: null, head: null } : null;
      assert.deepEqual(open.payload.worktree, expected, `open, show-ref ${code}`);
      phase = "close";
      await e.close();
      const close = readLines(sessionPath(home, id)).at(-1) as Line;
      assert.equal(close.type, "session.close");
      assert.deepEqual(close.payload.worktree, expected, `close, show-ref ${code}`);
    } finally {
      cleanup();
    }
    // Close only: HEAD resolved at open, then stops resolving and show-ref answers `code`.
    const second = makeHome();
    try {
      let phase: "open" | "close" = "open";
      const e = inProcess(second.home, {
        worktreeDeps: {
          realpath: identityPath,
          runGit: fakeGit(() => (phase === "open" ? RESOLVED : { showRef: { code, stdout: "" } })),
        },
      });
      await e.init();
      const id = await e.startThread("/repo");
      assert.deepEqual(
        (readLines(sessionPath(second.home, id))[0] as Line).payload.worktree,
        REPO_WT,
      );
      phase = "close";
      await e.close();
      const close = readLines(sessionPath(second.home, id)).at(-1) as Line;
      assert.equal(close.type, "session.close");
      assert.deepEqual(
        close.payload.worktree,
        code === 1 ? { topLevel: "/repo", remote: null, head: null } : null,
        `close after a resolved open, show-ref ${code}`,
      );
    } finally {
      second.cleanup();
    }
  }
});

// ===================================================================== a.1 P25: worktree mutants

test("M2-A1 FU a.1 N13: HEAD symbolic to a ref outside refs/heads/ records no worktree (never an unborn branch)", () => {
  for (const ref of ["refs/remotes/origin/main", "refs/tags/v1", "HEAD"]) {
    const deps = {
      realpath: identityPath,
      runGit: fakeGit({
        symbolic: { code: 0, stdout: `${ref}\n` },
        showRef: { code: 1, stdout: "" },
      }),
    };
    assert.equal(resolveWorktreeIdentity("/repo", deps), null, ref);
  }
});

test("M2-A1 FU a.1 N15: a failed symbolic-ref is refused on its exit code, whatever the runner printed", () => {
  // The default runner prints nothing on failure (so N15 is equivalent for it); the GitRunner
  // seam is part of the engine options, and its contract is the exit code, not the text.
  for (const code of [1, 128, null]) {
    const deps = {
      realpath: identityPath,
      runGit: fakeGit({
        symbolic: { code, stdout: "refs/heads/main\n" },
        showRef: { code: 1, stdout: "" },
      }),
    };
    assert.equal(resolveWorktreeIdentity("/repo", deps), null, `symbolic-ref ${code}`);
  }
});

test("M2-A1 FU a.1 M55: a HEAD^{commit} answer that is not 40 lowercase hex records no worktree", () => {
  for (const out of ["not-a-sha", "C".repeat(40), "d".repeat(64), ""]) {
    const deps = {
      realpath: identityPath,
      runGit: fakeGit({ head: { code: 0, stdout: `${out}\n` } }),
    };
    assert.equal(resolveWorktreeIdentity("/repo", deps), null, JSON.stringify(out));
  }
  const ok = { realpath: identityPath, runGit: fakeGit(RESOLVED) };
  assert.deepEqual(resolveWorktreeIdentity("/repo", ok), REPO_WT);
});

test("M2-A1 FU a.1 M30: the close re-read is null when git reports another top-level at the recorded path", () => {
  const deps = { realpath: identityPath, runGit: fakeGit({ ...RESOLVED, top: "/elsewhere" }) };
  assert.equal(rereadWorktreeIdentity(REPO_WT, deps), null);
  const same = { realpath: identityPath, runGit: fakeGit(RESOLVED) };
  assert.deepEqual(rereadWorktreeIdentity(REPO_WT, same), REPO_WT);
});

// ===================================================================== a.5 P8

test("M2-A1 FU a.5 P8: one shared deadline bounds every thread's close-time git; shutdown returns within the CLI kill budget and still writes session.close (worktree: null) for every thread", async () => {
  const { home, cleanup } = makeHome();
  try {
    let closing = false;
    const timeouts: Array<number | undefined> = [];
    const HUNG_MS = 2_000; // what a hung git would cost each call without a deadline
    const runGit: GitRunner = (args, cwd, opts) => {
      if (!closing) return fakeGit(RESOLVED)(args, cwd);
      timeouts.push(opts?.timeoutMs);
      const wait = Math.min(HUNG_MS, opts?.timeoutMs ?? HUNG_MS);
      sleepSync(wait);
      return { code: null, stdout: "" }; // killed on its timeout, like spawnSync
    };
    const e = inProcess(home, { worktreeDeps: { realpath: identityPath, runGit } });
    await e.init();
    const ids = [
      await e.startThread("/repo"),
      await e.startThread("/repo"),
      await e.startThread("/repo"),
    ];
    closing = true;
    const t0 = Date.now();
    e.conn.shutdown();
    const elapsed = Date.now() - t0;
    // oneshot.ts KILL_AFTER_MS = 1000: the CLI SIGKILLs the engine 1 s after a signal or idle.
    assert.ok(elapsed < 1_000, `shutdown took ${elapsed} ms (budget ${CLOSE_REREAD_BUDGET_MS} ms)`);
    assert.ok(timeouts.length >= 1, "the first re-read ran");
    for (const t of timeouts) {
      assert.ok(
        t !== undefined && t > 0 && t <= CLOSE_REREAD_BUDGET_MS,
        `each call gets what is left (${t})`,
      );
    }
    for (const id of ids) {
      const close = readLines(sessionPath(home, id)).at(-1) as Line;
      assert.equal(close.type, "session.close", id);
      assert.equal(close.payload.worktree, null, `${id}: over budget records worktree: null`);
      assert.equal(verifySessionFile(sessionPath(home, id), id).ok, true);
    }
    assert.deepEqual(lockFiles(home), [], "every lock released");
    await e.close();
  } finally {
    cleanup();
  }
});

test("M2-A1 FU a.5 P8 (unit): rereadWorktreeIdentity under a spent deadline starts no git and records null; under a live one each call's timeout is what is left", () => {
  const calls: Array<{ args: readonly string[]; timeoutMs: number | undefined }> = [];
  const runGit: GitRunner = (args, cwd, opts) => {
    calls.push({ args, timeoutMs: opts?.timeoutMs });
    return fakeGit(RESOLVED)(args, cwd);
  };
  const deps = { realpath: identityPath, runGit };
  assert.equal(rereadWorktreeIdentity(REPO_WT, deps, { at: 1_000, now: () => 1_000 }), null);
  assert.equal(calls.length, 0, "no git started once the budget is spent");
  let clock = 0;
  const now = () => clock;
  const tick: GitRunner = (args, cwd, opts) => {
    const r = runGit(args, cwd, opts);
    clock += 10;
    return r;
  };
  assert.deepEqual(
    rereadWorktreeIdentity(REPO_WT, { realpath: identityPath, runGit: tick }, { at: 300, now }),
    REPO_WT,
  );
  assert.deepEqual(
    calls.map((c) => c.timeoutMs),
    [300, 290, 280],
    "show-toplevel, HEAD, config: each gets the remaining budget",
  );
  // A call that returns after the deadline makes the whole re-read null (never a half-read identity).
  clock = 0;
  const slow: GitRunner = (args, cwd, opts) => {
    const r = runGit(args, cwd, opts);
    clock += 200;
    return r;
  };
  assert.equal(
    rereadWorktreeIdentity(REPO_WT, { realpath: identityPath, runGit: slow }, { at: 300, now }),
    null,
  );
});

test("M2-A1 FU F7 (Argus pre-check): the shutdown deadline is monotonic — a wall-clock step back neither stretches the budget, nor does a step forward zero it", async () => {
  const realNow = Date.now;
  const run = async (stepMs: number, hang: boolean) => {
    const { home, cleanup } = makeHome();
    try {
      let closing = false;
      let stepped = false;
      const timeouts: Array<number | undefined> = [];
      const runGit: GitRunner = (args, cwd, opts) => {
        if (closing && !stepped) {
          stepped = true;
          Date.now = () => realNow() + stepMs; // the wall clock jumps mid-shutdown
        }
        if (!closing || !hang) return fakeGit(RESOLVED)(args, cwd);
        timeouts.push(opts?.timeoutMs);
        sleepSync(Math.min(2_000, opts?.timeoutMs ?? 2_000));
        return { code: null, stdout: "" };
      };
      const e = inProcess(home, { worktreeDeps: { realpath: identityPath, runGit } });
      await e.init();
      const ids = [await e.startThread("/repo"), await e.startThread("/repo")];
      closing = true;
      const t0 = performance.now();
      try {
        e.conn.shutdown();
      } finally {
        Date.now = realNow;
      }
      const elapsed = performance.now() - t0;
      const worktrees = ids.map((id) => (readLines(sessionPath(home, id)).at(-1) as Line).payload);
      await e.close();
      return { elapsed, timeouts, worktrees };
    } finally {
      Date.now = realNow;
      cleanup();
    }
  };
  // Back one hour while git hangs: every call still gets at most the 300 ms that is left.
  const back = await run(-3_600_000, true);
  assert.ok(back.elapsed < 1_000, `shutdown took ${back.elapsed} ms`);
  for (const t of back.timeouts) {
    assert.ok(t !== undefined && t <= CLOSE_REREAD_BUDGET_MS, `timeout ${t}`);
  }
  // Forward one hour with a healthy git: the budget is not spent, both closes keep their identity.
  const fwd = await run(3_600_000, false);
  assert.deepEqual(
    fwd.worktrees.map((p) => (p as { worktree: unknown }).worktree),
    [REPO_WT, REPO_WT],
  );
});

// ===================================================================== a.10 P15

// `test.skip`, not `{ skip }`: Bun 1.3.11's node:test runs a test whose options say `skip` (Argus
// pre-check of c2f6954, Q1).
const shAliasSkip = process.platform === "win32" ? "POSIX sh alias" : null;
(shAliasSkip !== null ? test.skip : test)(
  "M2-A1 FU a.5 P8 (default runner): a caller's timeoutMs caps the real git invocation below the 5 s ceiling",
  () => {
    // A git alias that execs `sleep 3` with its own stdio detached, so killing git ends the call.
    const hang = ["-c", "alias.madcfuhang=!exec sleep 3 >/dev/null 2>&1 </dev/null", "madcfuhang"];
    const t0 = Date.now();
    const r = defaultGitRunner(hang, tmpdir(), { timeoutMs: 200 });
    const took = Date.now() - t0;
    assert.equal(r.code, null, "killed at the caller's budget");
    assert.ok(took < 2000, `took ${took} ms`);
  },
);

test("M2-A1 FU a.10 P15: a close-time fault on one thread is logged and the next thread is still closed; shutdown does not throw and every lock is released", async () => {
  const { home, cleanup } = makeHome();
  try {
    let closing = false;
    const runGit: GitRunner = (args, cwd) => {
      if (closing && cwd === "/repoA") throw new Error("git runner exploded");
      return fakeGit(RESOLVED)(args, cwd);
    };
    const e = inProcess(home, { worktreeDeps: { realpath: identityPath, runGit } });
    await e.init();
    const a = await e.startThread("/repoA");
    const b = await e.startThread("/repoB");
    closing = true;
    assert.doesNotThrow(() => e.conn.shutdown());
    assert.deepEqual(lockFiles(home), [], "both locks released");
    assert.equal(types(sessionPath(home, b)).at(-1), "session.close", "the next thread is closed");
    assert.equal(types(sessionPath(home, a)).at(-1), "session.open", "the faulting thread is not");
    assert.ok(
      e.logs.some((l) => l === `session ${a}: not closed (git runner exploded)`),
      JSON.stringify(e.logs),
    );
    await e.close();
  } finally {
    cleanup();
  }
});

test("M2-A1 FU a.10 P15: releaseLocks runs in a finally — even when closing itself throws, no lock is left behind", async () => {
  const { home, cleanup } = makeHome();
  try {
    let closing = false;
    const runGit: GitRunner = (args, cwd) => {
      if (closing) throw new Error("git runner exploded");
      return fakeGit(RESOLVED)(args, cwd);
    };
    const e = inProcess(home, {
      worktreeDeps: { realpath: identityPath, runGit },
      // The stderr logger itself failing is the one fault the per-thread catch cannot absorb.
      log: (m) => {
        if (closing && m.includes("not closed")) throw new Error("stderr is gone");
      },
    });
    await e.init();
    await e.startThread("/repo");
    assert.equal(lockFiles(home).length, 1);
    closing = true;
    assert.throws(() => e.conn.shutdown(), /stderr is gone/);
    assert.deepEqual(lockFiles(home), [], "the lock is released anyway");
    e.input.end();
  } finally {
    cleanup();
  }
});

// ===================================================================== a.1 M60

test("M2-A1 FU a.1 M60: shutdown never attempts session.close on a broken writer (one stderr line, file untouched)", async () => {
  const { home, cleanup } = makeHome();
  try {
    const e = inProcess(home);
    await e.init();
    const id = await e.startThread(null);
    const path = sessionPath(home, id);
    // A foreign append moves the end offset: the next append fails -32009 and breaks the writer.
    writeFileSync(path, `${readFileSync(path, "utf8")}{"foreign":true}\n`);
    const r = await e.request("turn/start", { threadId: id, input: text("hi") });
    assert.equal((r.error as { code: number } | undefined)?.code, -32009, JSON.stringify(r));
    const before = sha256(path);
    await e.close();
    assert.equal(sha256(path), before, "nothing appended at shutdown");
    assert.ok(
      e.logs.includes(`session ${id}: not closed (writer unusable)`),
      JSON.stringify(e.logs),
    );
    assert.ok(!e.logs.some((l) => l.startsWith("session append failed (session.close)")));
  } finally {
    cleanup();
  }
});

// ===================================================================== a.3 P23

test("M2-A1 FU a.3 P23: handoff.aborted error.code Infinity, -Infinity, NaN or 1.5 refuses -32010 field-invalid with nothing written and the writer usable; every accepted payload verifies after the round trip", () => {
  const f = fixture();
  try {
    let n = 0;
    const out = () => {
      n += 1;
      const handoffId = `ho_${n}`;
      f.writer.append("handoff.out", {
        handoffId,
        turnId: null,
        targetSeatId: "hephaestus",
        brief: "b",
      });
      return handoffId;
    };
    const aborted = (handoffId: string, code: number) => ({
      handoffId,
      reason: "target-open-failed" as const,
      error: { code, message: "m" },
    });
    for (const code of [
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NaN,
      1.5,
      -0.5,
    ]) {
      const id = out();
      const r = expectRefusal(f, "handoff.aborted", aborted(id, code), "field-invalid");
      assert.deepEqual(r.issues, ["error.code must be an integer"], String(code));
      // Still usable: the same handoff closes with a valid code.
      f.writer.append("handoff.aborted", aborted(id, -32010));
    }
    // Round trip: every candidate is either refused (nothing written) or written AND verifies, and
    // what is on disk is exactly what was accepted (no Infinity → null rewrite).
    const candidates = [
      0,
      -1,
      1,
      -32010,
      -32603,
      2 ** 31 - 1,
      Number.MAX_SAFE_INTEGER,
      1e21,
      0.1,
      Number.MIN_VALUE,
      -Number.MAX_VALUE,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ];
    for (const code of candidates) {
      const id = out();
      const before = snapshot(f.path);
      try {
        const written = f.writer.append("handoff.aborted", aborted(id, code));
        const line = readLines(f.path).at(-1) as Line;
        assert.equal(line.hash, written.hash);
        assert.equal((line.payload.error as { code: unknown }).code, code, `${code} round-trips`);
        const v = verifySessionFile(f.path, "thr_src");
        assert.equal(v.ok, true, `${code}: an accepted payload verifies`);
      } catch (err) {
        assert.ok(err instanceof RpcError && err.code === ErrorCode.EvidenceInvalid, String(err));
        assert.deepEqual(snapshot(f.path), before, `${code}: a refusal writes nothing`);
        assert.equal(Number.isInteger(code), false, `${code}: only non-integers are refused`);
      }
    }
    const v = verifySessionFile(f.path, "thr_src");
    assert.equal(v.ok, true);
    assert.doesNotThrow(() => rebuildSession(v.ok ? v.events : []));
  } finally {
    f.cleanup();
  }
});

// ===================================================================== a.4 P21

test("M2-A1 FU a.4 P21 (pin §5 :298, Copilot r4165840814 / r4168209015): -32010 issues name the field, never the caller's id — not a configured secret, not a token shape, not a plain id", () => {
  const f = fixture("thr_src", "madc-default", V2_OPEN, () => [SECRET]);
  try {
    const leaks = (issues: string[], id: string) =>
      issues.some(
        (i) => i.includes(id) || i.includes(id.slice(0, 12)) || i.includes(id.slice(-12)),
      );
    for (const id of [SECRET, GHP, "hof_plain1"]) {
      for (const type of ["handoff.link", "handoff.aborted"] as const) {
        const payload =
          type === "handoff.link"
            ? {
                handoffId: id,
                targetThreadId: "thr_t",
                targetSeatId: "hephaestus",
                targetGenesisHash: HEX64,
              }
            : { handoffId: id, reason: "interrupted", error: null };
        const r = expectRefusal(f, type, payload, "field-invalid");
        assert.deepEqual(r.issues, ["handoffId has no handoff.out in this file"], `${type} ${id}`);
        assert.equal(leaks(r.issues, id), false);
        assert.equal(JSON.stringify(r.data.issues).includes(SECRET), false);
      }
    }
    // The other id echoes: a duplicate handoffId, a second terminal, a duplicate decisionId.
    f.writer.append("turn.start", { turnId: "turn_1", inputText: "x" });
    f.writer.append("handoff.out", {
      handoffId: "hof_plain1",
      turnId: null,
      targetSeatId: "hephaestus",
      brief: "b",
    });
    const dup = expectRefusal(
      f,
      "handoff.out",
      { handoffId: "hof_plain1", turnId: null, targetSeatId: "hephaestus", brief: "b" },
      "field-invalid",
    );
    assert.deepEqual(dup.issues, ["handoffId is already used in this file"]);
    f.writer.append("handoff.aborted", {
      handoffId: "hof_plain1",
      reason: "interrupted",
      error: null,
    });
    const again = expectRefusal(
      f,
      "handoff.aborted",
      { handoffId: "hof_plain1", reason: "interrupted", error: null },
      "field-invalid",
    );
    assert.deepEqual(again.issues, ["handoffId already has a terminal record (aborted)"]);
    const open = readLines(f.path)[0] as Line;
    const ref = {
      kind: "session" as const,
      path: "sessions/thr_src.jsonl",
      seq: 0,
      hash: open.hash,
    };
    const decision = {
      decisionId: "dec_plain1",
      turnId: "turn_1",
      question: "q",
      recommendedDefault: "d",
      evidenceRefs: [ref],
    };
    f.writer.append("founderDecision", decision);
    const d = expectRefusal(f, "founderDecision", decision, "field-invalid", "turn_1");
    assert.deepEqual(d.issues, ["decisionId is already used in this file"]);
    assert.equal(leaks([...dup.issues, ...again.issues, ...d.issues], "hof_plain1"), false);
    assert.equal(verifySessionFile(f.path, "thr_src").ok, true);
  } finally {
    f.cleanup();
  }
});

test("M2-A1 FU F1 (Argus pre-check, completes P21): a payload KEY that is a configured secret or a token shape is never echoed in -32010 issues — founderDecision, handoff.out, an EvidenceRef and session.open", () => {
  const leaks = (issues: readonly string[], key: string) =>
    issues.some(
      (i) =>
        i.includes(key) ||
        i.includes(key.slice(0, 8)) ||
        i.includes(key.slice(-8)) ||
        i.includes("[REDACTED]"),
    );
  const f = fixture("thr_src", "madc-default", V2_OPEN, () => [SECRET]);
  try {
    f.writer.append("turn.start", { turnId: "turn_1", inputText: "x" });
    const open = readLines(f.path)[0] as Line;
    const ref = { kind: "session", path: "sessions/thr_src.jsonl", seq: 0, hash: open.hash };
    for (const key of [SECRET, GHP]) {
      for (const value of ["plain", key]) {
        const decision = {
          decisionId: "dec_f1",
          turnId: "turn_1",
          question: "q",
          recommendedDefault: "d",
          evidenceRefs: [ref],
          [key]: value,
        };
        const d = expectRefusal(f, "founderDecision", decision, "field-invalid", "turn_1");
        assert.deepEqual(d.issues, ["redaction would rewrite structural field <extra key>"]);
        assert.equal(leaks(d.issues, key), false, `founderDecision ${key.slice(0, 4)}`);
        assert.equal(JSON.stringify(d.data).includes(key), false);
        const out = {
          handoffId: "hof_f1",
          turnId: null,
          targetSeatId: "hephaestus",
          brief: "b",
          [key]: value,
        };
        const h = expectRefusal(f, "handoff.out", out, "field-invalid");
        assert.deepEqual(h.issues, ["redaction would rewrite structural field <extra key>"]);
        assert.equal(leaks(h.issues, key), false, `handoff.out ${key.slice(0, 4)}`);
        assert.equal(JSON.stringify(h.data).includes(key), false);
      }
      // Nested: an extra key on an EvidenceRef keeps the pinned path, never the key.
      const nested = expectRefusal(
        f,
        "founderDecision",
        {
          decisionId: "dec_f1",
          turnId: "turn_1",
          question: "q",
          recommendedDefault: "d",
          evidenceRefs: [{ ...ref, [key]: "v" }],
        },
        "field-invalid",
        "turn_1",
      );
      assert.deepEqual(nested.issues, [
        "redaction would rewrite structural field evidenceRefs[0].<extra key>",
      ]);
      assert.equal(leaks(nested.issues, key), false);
    }
    // Pinned names are still named (unchanged behavior): a secret-valued handoffId.
    const named = expectRefusal(
      f,
      "handoff.out",
      { handoffId: SECRET, turnId: null, targetSeatId: "hephaestus", brief: "b" },
      "field-invalid",
    );
    assert.deepEqual(named.issues, ["redaction would rewrite structural field handoffId"]);
    assert.equal(verifySessionFile(f.path, "thr_src").ok, true);
  } finally {
    f.cleanup();
  }
  // session.open (the create-time refusal, P13's path): an extra key inside worktree.
  for (const key of [SECRET, GHP]) {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), "madc-m2a1fu-"));
    try {
      mkdirSync(join(dir, "sessions"), { mode: 0o700 });
      const path = join(dir, "sessions", "thr_f1.jsonl");
      const openPayload = {
        ...V2_OPEN,
        worktree: { ...REPO_WT, [key]: "v" },
      } as unknown as SessionOpenPayload;
      let issues: string[] = [];
      assert.throws(
        () =>
          unguardedSessionWriterForTests.create(path, "thr_f1", "madc-default", openPayload, () => [
            SECRET,
          ]),
        (err: unknown) => {
          assert.ok(err instanceof RpcError);
          assert.equal(err.code, ErrorCode.EvidenceInvalid);
          issues = (err.data as { issues: string[] }).issues;
          return true;
        },
      );
      assert.deepEqual(issues, ["redaction would rewrite structural field worktree.<extra key>"]);
      assert.equal(leaks(issues, key), false);
      assert.equal(existsSync(path), false, "no file");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("M2-A1 FU F2 (Argus pre-check): resume keeps its OWN copy of the index — a line the caller notes afterwards never resolves, and the writer's real line does", () => {
  const f = fixture();
  try {
    f.writer.append("turn.start", { turnId: "turn_1", inputText: "x" });
    const v = verifySessionFile(f.path, "thr_src");
    assert.ok(v.ok);
    if (!v.ok || v.size === undefined) return;
    const index = SessionChainIndex.fromEvents(v.events);
    const w = SessionWriter.resume(
      f.path,
      "thr_src",
      "madc-default",
      v.nextSeq,
      v.lastHash,
      () => [],
      f.dir,
      v.file,
      { holdsLock: () => true, expectedSize: v.size as number },
      undefined,
      index,
    );
    // probe-index-alias: the caller notes a forged line at the writer's next seq.
    const forged = "f".repeat(64);
    index.note({ type: "servedModel", hash: forged, payload: {} });
    assert.equal(w.lineAt(v.nextSeq), undefined, "the writer never sees the caller's note");
    const own = w.append("turn.start", { turnId: "turn_2", inputText: "y" });
    assert.deepEqual(w.lineAt(own.seq), { hash: own.hash, type: "turn.start" });
    const decision = (hash: string, decisionId: string) => ({
      decisionId,
      turnId: "turn_2",
      question: "q",
      recommendedDefault: "d",
      evidenceRefs: [
        { kind: "session" as const, path: "sessions/thr_src.jsonl", seq: own.seq, hash },
      ],
    });
    const g = { ...f, writer: w };
    const r = expectRefusal(
      g,
      "founderDecision",
      decision(forged, "dec_a"),
      "evidence-ref-invalid",
      "turn_2",
    );
    assert.equal(r.issues.length, 1);
    const ok = w.append("founderDecision", decision(own.hash, "dec_b"));
    assert.equal(ok.seq, own.seq + 1);
    const after = verifySessionFile(f.path, "thr_src");
    assert.ok(after.ok);
    const findings = inspectSessionV2(f.dir, after.ok ? after.events : []);
    assert.deepEqual(
      findings.filter((x) => x.level === "fail").map((x) => x.code),
      [],
      "doctor finds no mismatch",
    );
  } finally {
    f.cleanup();
  }
});

test("M2-A1 FU G1 (Argus pre-check, D-376): a -32010 data.turnId that is a configured secret or a token shape is null, never echoed — founderDecision (ghost turn) and handoff.out; a plain turnId is still echoed", () => {
  const leaks = (data: unknown, key: string) => {
    const json = JSON.stringify(data);
    return [key, key.slice(0, 8), key.slice(-8), key.slice(4, 12)].some((part) =>
      json.includes(part),
    );
  };
  const f = fixture("thr_src", "madc-default", V2_OPEN, () => [SECRET]);
  try {
    f.writer.append("turn.start", { turnId: "turn_1", inputText: "x" });
    const open = readLines(f.path)[0] as Line;
    const ref = { kind: "session", path: "sessions/thr_src.jsonl", seq: 0, hash: open.hash };
    for (const key of [SECRET, GHP]) {
      const decision = {
        decisionId: "dec_g1",
        turnId: key,
        question: "q",
        recommendedDefault: "d",
        evidenceRefs: [ref],
      };
      // expectRefusal asserts data.turnId === null (its default).
      const d = expectRefusal(f, "founderDecision", decision, "field-invalid");
      assert.deepEqual(d.issues, ["turnId names no turn.start in this file"], "the ghost turn");
      assert.equal(d.data.turnId, null, `founderDecision ${key.slice(0, 4)}`);
      assert.equal(leaks(d.data, key), false, `founderDecision ${key.slice(0, 4)}: data leaks`);
      const out = { handoffId: "hof_g1", turnId: key, targetSeatId: "hephaestus", brief: "b" };
      const h = expectRefusal(f, "handoff.out", out, "field-invalid");
      assert.equal(h.data.turnId, null, `handoff.out ${key.slice(0, 4)}`);
      assert.equal(leaks(h.data, key), false, `handoff.out ${key.slice(0, 4)}: data leaks`);
    }
    // A plain turnId is still echoed: a ghost turn, and a handoff.out refused for another field.
    const ghost = expectRefusal(
      f,
      "founderDecision",
      {
        decisionId: "dec_g1",
        turnId: "turn_ghost",
        question: "q",
        recommendedDefault: "d",
        evidenceRefs: [ref],
      },
      "field-invalid",
      "turn_ghost",
    );
    assert.deepEqual(ghost.issues, ["turnId names no turn.start in this file"]);
    const plain = expectRefusal(
      f,
      "handoff.out",
      { handoffId: "hof_g1", turnId: "turn_1", targetSeatId: "hephaestus", brief: 7 },
      "field-invalid",
      "turn_1",
    );
    assert.equal(plain.data.turnId, "turn_1");
    assert.equal(verifySessionFile(f.path, "thr_src").ok, true);
  } finally {
    f.cleanup();
  }
});

test("M2-A1 FU G1 fail-closed (Argus pre-check I-7): when the secrets source throws, the -32010 data.turnId is null — a secret, a token shape or a plain id — and the refusal is still -32010", () => {
  let failing = false;
  const secrets = (): readonly string[] => {
    if (failing) throw new Error("secrets source unavailable");
    return [SECRET];
  };
  const f = fixture("thr_src", "madc-default", V2_OPEN, secrets);
  try {
    f.writer.append("turn.start", { turnId: "turn_1", inputText: "x" });
    const open = readLines(f.path)[0] as Line;
    const ref = { kind: "session", path: "sessions/thr_src.jsonl", seq: 0, hash: open.hash };
    failing = true;
    for (const turnId of [SECRET, GHP, "turn_ghost"]) {
      // expectRefusal asserts code -32010, data.turnId === null (its default), nothing written.
      const d = expectRefusal(
        f,
        "founderDecision",
        {
          decisionId: "dec_g1c",
          turnId,
          question: "q",
          recommendedDefault: "d",
          evidenceRefs: [ref],
        },
        "field-invalid",
      );
      assert.deepEqual(d.issues, ["turnId names no turn.start in this file"], "the ghost turn");
      assert.equal(d.data.turnId, null, `founderDecision ${turnId.slice(0, 4)}`);
      assert.equal(JSON.stringify(d.data).includes(turnId), false);
      const h = expectRefusal(
        f,
        "handoff.out",
        { handoffId: "hof_g1c", turnId, targetSeatId: "hephaestus", brief: "" },
        "field-invalid",
      );
      assert.equal(h.data.turnId, null, `handoff.out ${turnId.slice(0, 4)}`);
      assert.equal(JSON.stringify(h.data).includes(turnId), false);
    }
    failing = false;
    assert.equal(verifySessionFile(f.path, "thr_src").ok, true);
  } finally {
    f.cleanup();
  }
});

test("M2-A1 FU G2 (Argus pre-check, D-377): the index keeps its OWN frozen session.open worktree — after resume, changing topLevel via the getter or the verified payload changes nothing: the real close is accepted, a forged one refused, the file verifies", () => {
  for (const via of ["getter", "payload"] as const) {
    const f = fixture("thr_src", "madc-default", { ...V2_OPEN, worktree: REPO_WT });
    try {
      f.writer.append("turn.start", { turnId: "turn_1", inputText: "x" });
      const v = verifySessionFile(f.path, "thr_src");
      assert.ok(v.ok);
      if (!v.ok || v.size === undefined) return;
      const index = SessionChainIndex.fromEvents(v.events);
      const w = SessionWriter.resume(
        f.path,
        "thr_src",
        "madc-default",
        v.nextSeq,
        v.lastHash,
        () => [],
        f.dir,
        v.file,
        { holdsLock: () => true, expectedSize: v.size as number },
        undefined,
        index,
      );
      const held = index.openWorktree as { topLevel: string };
      assert.equal(Object.isFrozen(held), true, "the getter hands out a frozen object");
      if (via === "getter") {
        assert.throws(() => {
          held.topLevel = "/evil/elsewhere";
        }, TypeError);
      } else {
        const first = v.events[0];
        assert.ok(first);
        const payloadWt = (first.payload as { worktree: { topLevel: string } }).worktree;
        payloadWt.topLevel = "/evil/elsewhere";
        assert.notEqual(index.openWorktree, payloadWt, "the index never holds the payload object");
      }
      assert.equal(index.openWorktree?.topLevel, "/repo", `${via}: the caller's index unchanged`);
      const g = { ...f, writer: w };
      const r = expectRefusal(
        g,
        "session.close",
        { reason: "shutdown", worktree: { ...REPO_WT, topLevel: "/evil/elsewhere" } },
        "field-invalid",
      );
      assert.deepEqual(r.issues, ["worktree.topLevel differs from the session.open worktree"]);
      const close = w.append("session.close", { reason: "shutdown", worktree: REPO_WT });
      assert.equal(close.seq, v.nextSeq, `${via}: the real close is accepted`);
      const after = verifySessionFile(f.path, "thr_src");
      assert.equal(after.ok, true, `${via}: the file verifies`);
      const findings = inspectSessionV2(f.dir, after.ok ? after.events : []);
      assert.deepEqual(
        findings.filter((x) => x.level === "fail").map((x) => x.code),
        [],
      );
    } finally {
      f.cleanup();
    }
  }
  // clone(): its own frozen copy, not the source index's object.
  const f = fixture("thr_src", "madc-default", { ...V2_OPEN, worktree: REPO_WT });
  try {
    const v = verifySessionFile(f.path, "thr_src");
    assert.ok(v.ok);
    if (!v.ok) return;
    const index = SessionChainIndex.fromEvents(v.events);
    const copy = index.clone();
    assert.notEqual(copy.openWorktree, index.openWorktree, "clone has its own object");
    assert.equal(Object.isFrozen(copy.openWorktree), true);
    assert.deepEqual(copy.openWorktree, REPO_WT);
  } finally {
    f.cleanup();
  }
});

test("M2-A1 FU K2 (Copilot r4174562359, completes P11): resume re-verifies the file it continues — an index with a forged middle line, or for a prefix, is refused (TypeError, file unchanged); a payload forged under a real hash never reaches the writer", () => {
  const f = fixture();
  try {
    f.writer.append("turn.start", { turnId: "turn_1", inputText: "x" });
    f.writer.append("item", {
      turnId: "turn_1",
      item: { id: "item_1", kind: "agentMessage", status: "completed", text: "hi" },
    });
    const v = verifySessionFile(f.path, "thr_src");
    assert.ok(v.ok);
    if (!v.ok || v.size === undefined) return;
    const resume = (index: SessionChainIndex, nextSeq = v.nextSeq, lastHash = v.lastHash) =>
      SessionWriter.resume(
        f.path,
        "thr_src",
        "madc-default",
        nextSeq,
        lastHash,
        () => [],
        f.dir,
        v.file,
        { holdsLock: () => true, expectedSize: v.size as number },
        undefined,
        index,
      );
    const before = snapshot(f.path);
    // probe-c2 (Argus PR #48 r1): real length and head, forged seq-1 hash.
    const forgedHash = "e".repeat(64);
    const forgedMiddle = SessionChainIndex.fromEvents(
      v.events.map((e) => (e.seq === 1 ? { ...e, hash: forgedHash } : e)),
    );
    assert.equal(forgedMiddle.length, v.nextSeq);
    assert.equal(forgedMiddle.lineAt(v.nextSeq - 1)?.hash, v.lastHash, "head is the real one");
    assert.throws(() => resume(forgedMiddle), TypeError, "forged middle line");
    // A forged middle line's TYPE (same hash) is refused too.
    const forgedType = SessionChainIndex.fromEvents(
      v.events.map((e) => (e.seq === 1 ? { ...e, type: "servedModel" as never } : e)),
    );
    assert.throws(() => resume(forgedType), TypeError, "forged middle type");
    // An index, nextSeq and lastHash that agree with each other but describe only a prefix.
    const prefix = v.events.slice(0, -1);
    assert.throws(
      () =>
        resume(
          SessionChainIndex.fromEvents(prefix),
          prefix.length,
          (prefix[prefix.length - 1] as Line).hash,
        ),
      TypeError,
      "an index for a prefix of the file",
    );
    // A verified size longer than the file: -32009 at resume (an append would refuse it anyway).
    assert.throws(
      () =>
        SessionWriter.resume(
          f.path,
          "thr_src",
          "madc-default",
          v.nextSeq,
          v.lastHash,
          () => [],
          f.dir,
          v.file,
          { holdsLock: () => true, expectedSize: (v.size as number) + 10 },
          undefined,
          SessionChainIndex.fromEvents(v.events),
        ),
      (err: unknown) => err instanceof RpcError && err.code === ErrorCode.SessionWriteFailed,
      "short file",
    );
    assert.deepEqual(snapshot(f.path), before, "file unchanged");
    // Right lines, forged payload under the real seq-1 hash (a ghost turn): the writer's index
    // is the file's, so the forged turn does not exist for it and the real one does.
    const forgedPayload = SessionChainIndex.fromEvents(
      v.events.map((e) =>
        e.seq === 1 ? { ...e, payload: { turnId: "turn_forged", inputText: "x" } } : e,
      ),
    );
    assert.equal(forgedPayload.hasTurn("turn_forged"), true);
    const w = resume(forgedPayload);
    const open = readLines(f.path)[0] as Line;
    const decision = (turnId: string, seq: number, hash: string, decisionId: string) => ({
      decisionId,
      turnId,
      question: "q",
      recommendedDefault: "d",
      evidenceRefs: [{ kind: "session" as const, path: "sessions/thr_src.jsonl", seq, hash }],
    });
    const g = { ...f, writer: w };
    const ghost = expectRefusal(
      g,
      "founderDecision",
      decision("turn_forged", 0, open.hash, "dec_k2a"),
      "field-invalid",
      "turn_forged",
    );
    assert.deepEqual(ghost.issues, ["turnId names no turn.start in this file"]);
    // The forged middle hash is refused at write too (this writer never saw it).
    const r = expectRefusal(
      g,
      "founderDecision",
      decision("turn_1", 1, forgedHash, "dec_k2b"),
      "evidence-ref-invalid",
      "turn_1",
    );
    assert.equal(r.issues.length, 1);
    const ok = w.append(
      "founderDecision",
      decision("turn_1", 1, (v.events[1] as Line).hash, "dec_k2c"),
    );
    assert.equal(ok.seq, v.nextSeq);
    const after = verifySessionFile(f.path, "thr_src");
    assert.ok(after.ok);
    assert.deepEqual(
      inspectSessionV2(f.dir, after.ok ? after.events : [])
        .filter((x) => x.level === "fail")
        .map((x) => x.code),
      [],
      "doctor finds no mismatch",
    );
  } finally {
    f.cleanup();
  }
});

test("M2-A1 FU L1 (Argus pre-check of 15d4d9c): resume's K2 re-read goes through one O_NOFOLLOW | O_NONBLOCK fd + fstat — a FIFO at the path (in place, or swapped in after the identity check) answers -32009 at once and is left untouched; a swap to a symlink or to another file is -32009", () => {
  const f = fixture();
  let keepFd: number | undefined;
  try {
    f.writer.append("turn.start", { turnId: "turn_1", inputText: "x" });
    const v = verifySessionFile(f.path, "thr_src");
    assert.ok(v.ok);
    if (!v.ok || v.size === undefined) return;
    // Argus pre-check of d55725d (M1): hold the original inode open for the whole test, so no later
    // copy can be given its number (the final "not the verified one" check depends on that).
    keepFd = openSync(f.path, "r");
    // No default: `undefined` must reach resume as "verifiedFile omitted".
    const resume = (file: typeof v.file) =>
      SessionWriter.resume(
        f.path,
        "thr_src",
        "madc-default",
        v.nextSeq,
        v.lastHash,
        () => [],
        f.dir,
        file,
        { holdsLock: () => true, expectedSize: v.size as number },
        undefined,
        SessionChainIndex.fromEvents(v.events),
      );
    const isWriteFailed = (err: unknown) =>
      err instanceof RpcError && err.code === ErrorCode.SessionWriteFailed;
    const before = snapshot(f.path);
    // A byte-identical copy outside MADC_HOME, and one inside it.
    const outside = join(f.dir, "..", `${f.dir.split("/").pop() ?? "x"}-outside.jsonl`);
    const twin = join(f.dir, "sessions", "twin.jsonl");
    copyFileSync(f.path, outside);
    copyFileSync(f.path, twin);
    // Replace by rename, so the new inode exists before the one it replaces is freed: the copy can
    // never get the inode it replaces. (An inode freed earlier can be reused; `keepFd` pins v.file.)
    const replaceWithTwin = () => {
      const tmp = join(f.dir, "sessions", "twin.tmp");
      copyFileSync(twin, tmp);
      renameSync(tmp, f.path);
    };
    const toSymlink = () => {
      rmSync(f.path);
      symlinkSync(outside, f.path);
    };
    try {
      for (const noFollowFlag of [true, false]) {
        const label = noFollowFlag ? "O_NOFOLLOW" : "lstat → open → fstat";
        for (const [what, swap, isSwapped, withId] of [
          [
            "a symlink to an outside copy",
            toSymlink,
            () => lstatSync(f.path).isSymbolicLink(),
            true,
          ],
          // Argus pre-check of d55725d (M2): with `verifiedFile` omitted there is no dev/inode to
          // compare, so only O_NOFOLLOW (or the fallback's lstat/fstat compare) refuses the link.
          [
            "a symlink to an outside copy, verifiedFile omitted",
            toSymlink,
            () => lstatSync(f.path).isSymbolicLink(),
            false,
          ],
          ["a byte-identical regular file (another inode)", replaceWithTwin, () => true, true],
        ] as const) {
          // A fresh regular file at the path, verified now: resume's identity check passes, and
          // the swap happens after it (before the open, or between openNoFollow's lstat and open).
          replaceWithTwin();
          const now = verifySessionFile(f.path, "thr_src");
          assert.ok(now.ok);
          const id = withId && now.ok ? now.file : undefined;
          let swapped = 0;
          const hook = () => {
            swapped++;
            swap();
          };
          setSessionResumeReadForTests(
            noFollowFlag ? { beforeOpen: hook } : { noFollowFlag, afterLstat: hook },
          );
          try {
            assert.throws(() => resume(id), isWriteFailed, `${label}: swap to ${what}`);
          } finally {
            setSessionResumeReadForTests(null);
          }
          assert.equal(swapped, 1, `${label}: the swap ran after the identity check (${what})`);
          assert.equal(isSwapped(), true, `${label}: ${what} still in place`);
        }
      }
      // With no swap, the same fresh file resumes through the fd (the read path works).
      replaceWithTwin();
      const now = verifySessionFile(f.path, "thr_src");
      assert.ok(now.ok);
      assert.throws(() => resume(v.file), isWriteFailed, "a replaced file is not the verified one");
      const w = resume(now.ok ? now.file : undefined);
      assert.equal(w.nextSeq, v.nextSeq);
      assert.deepEqual(snapshot(f.path), before, "bytes unchanged");
      // Argus pre-checks of d55725d (M4), 69f0c86 (N2) and c2f6954 (Q3): the re-read closes its fd on
      // success, on a refusal after the read (short file), on the fd's dev/inode refusal (a twin
      // swapped in after the identity check), on the not-a-regular-file refusal (a directory swapped
      // in after the identity check: it opens O_RDONLY and fstat says "not a file") and when the read
      // throws. Linux only (/proc/self/fd); the loops are synchronous, so nothing else runs in between.
      if (existsSync("/proc/self/fd")) {
        const fds = () => readdirSync("/proc/self/fd").length;
        const fdsBefore = fds();
        for (let i = 0; i < 100; i++) {
          resume(now.ok ? now.file : undefined);
          setSessionResumeReadForTests({
            beforeRead: () => {
              throw Object.assign(new Error("EIO: i/o error, read"), { code: "EIO" });
            },
          });
          try {
            assert.throws(
              () => resume(now.ok ? now.file : undefined),
              isWriteFailed,
              "read throws",
            );
          } finally {
            setSessionResumeReadForTests(null);
          }
          assert.throws(
            () =>
              SessionWriter.resume(
                f.path,
                "thr_src",
                "madc-default",
                v.nextSeq,
                v.lastHash,
                () => [],
                f.dir,
                now.ok ? now.file : undefined,
                { holdsLock: () => true, expectedSize: (v.size as number) + 10 },
                undefined,
                SessionChainIndex.fromEvents(v.events),
              ),
            isWriteFailed,
            "short file",
          );
        }
        for (let i = 0; i < 100; i++) {
          const cur = verifySessionFile(f.path, "thr_src");
          assert.ok(cur.ok);
          setSessionResumeReadForTests({ beforeOpen: replaceWithTwin });
          try {
            assert.throws(() => resume(cur.ok ? cur.file : undefined), isWriteFailed, "twin swap");
          } finally {
            setSessionResumeReadForTests(null);
          }
        }
        const cur = verifySessionFile(f.path, "thr_src");
        assert.ok(cur.ok);
        const aside = join(f.dir, "sessions", "aside.jsonl");
        for (let i = 0; i < 100; i++) {
          setSessionResumeReadForTests({
            beforeOpen: () => {
              renameSync(f.path, aside);
              mkdirSync(f.path);
            },
          });
          try {
            assert.throws(
              () => resume(cur.ok ? cur.file : undefined),
              isWriteFailed,
              "a directory swapped in",
            );
          } finally {
            setSessionResumeReadForTests(null);
            rmSync(f.path, { recursive: true, force: true });
            renameSync(aside, f.path);
          }
        }
        resume(cur.ok ? cur.file : undefined); // the same inode is back: a writer
        assert.ok(fds() - fdsBefore < 10, `fd leak: ${fdsBefore} → ${fds()} over 501 resumes`);
      }
    } finally {
      setSessionResumeReadForTests(null);
      rmSync(outside, { force: true });
      rmSync(twin, { force: true });
    }
  } finally {
    setSessionResumeReadForTests(null);
    if (keepFd !== undefined) closeSync(keepFd);
    f.cleanup();
  }
  // A FIFO at the path: a blocking read would hang the process, so each case runs in a child
  // with a timeout (as the R-FIFO append test does). POSIX only (mkfifo).
  if (process.platform === "win32") return;
  const probe = join(import.meta.dirname, "testing", "fifo-resume-probe.ts");
  const home = mkdtempSync(join(realpathSync(tmpdir()), "madc-m2a1fu-l1-"));
  try {
    // `empty`: a FIFO at the path of an empty chain reads as 0 bytes, so only fstat's regular-file
    // check stands between it and a writer.
    // `race-read` (Argus pre-check of d55725d, M3): a FIFO swapped in after the fd checks and before
    // the read. The read uses the checked fd, so the writer comes back at once (a by-path read
    // would block on the FIFO).
    for (const mode of ["nofile", "race", "race-lstat", "empty", "race-read"]) {
      const dir = join(home, mode);
      const args =
        process.versions.bun !== undefined
          ? [probe, dir, mode]
          : ["--disable-warning=ExperimentalWarning", probe, dir, mode];
      const started = Date.now();
      const res = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 10_000 });
      assert.equal(res.signal, null, `${mode}: resume blocked on a FIFO (${res.stderr})`);
      assert.equal(res.status, 0, `${mode}: probe failed (${res.stderr})`);
      assert.ok(Date.now() - started < 10_000, `${mode}: bounded`);
      assert.deepEqual(
        JSON.parse(readFileSync(join(dir, "result.json"), "utf8")),
        { code: mode === "race-read" ? null : ErrorCode.SessionWriteFailed, fifo: true },
        `${mode}: ${mode === "race-read" ? "a writer from the checked fd" : "-32009"} and the FIFO is untouched`,
      );
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("M2-A1 FU L1 errors (Argus pre-checks of d55725d, M5, and 69f0c86, N1): an error at open time (ENXIO, as open gives for a Unix socket, thrown inside openNoFollow) or at read time (an injected EIO) is -32009, never a raw error", () => {
  const f = fixture();
  try {
    f.writer.append("turn.start", { turnId: "turn_1", inputText: "x" });
    const v = verifySessionFile(f.path, "thr_src");
    assert.ok(v.ok);
    if (!v.ok || v.size === undefined) return;
    const resume = () =>
      SessionWriter.resume(
        f.path,
        "thr_src",
        "madc-default",
        v.nextSeq,
        v.lastHash,
        () => [],
        f.dir,
        undefined,
        { holdsLock: () => true, expectedSize: v.size as number },
        undefined,
        SessionChainIndex.fromEvents(v.events),
      );
    const isWriteFailed = (err: unknown) =>
      err instanceof RpcError && err.code === ErrorCode.SessionWriteFailed;
    // Open time: the fallback path's afterLstat hook runs inside openNoFollow's try, which rethrows
    // anything but ENOENT / ELOOP: the same path a real ENXIO from open takes.
    let opened = 0;
    setSessionResumeReadForTests({
      noFollowFlag: false,
      afterLstat: () => {
        opened++;
        throw Object.assign(new Error("ENXIO: no such device or address, open"), { code: "ENXIO" });
      },
    });
    try {
      assert.throws(resume, isWriteFailed, "an open-time ENXIO is -32009");
    } finally {
      setSessionResumeReadForTests(null);
    }
    assert.equal(
      opened,
      1,
      "the ENXIO was thrown inside openNoFollow (between its lstat and open)",
    );
    // Read time: an error thrown inside the re-read (as a read error, EIO, would be).
    setSessionResumeReadForTests({
      beforeRead: () => {
        throw Object.assign(new Error("EIO: i/o error, read"), { code: "EIO" });
      },
    });
    try {
      assert.throws(resume, isWriteFailed, "a read-time error is -32009");
    } finally {
      setSessionResumeReadForTests(null);
    }
    // Argus pre-check of c2f6954 (Q2): beforeRead must sit between the fd checks and the read (the M3
    // race-read case relies on it). A same-inode truncate there is seen by the read: a short file.
    const keep = readFileSync(f.path);
    setSessionResumeReadForTests({ beforeRead: () => fs.truncateSync(f.path, 0) });
    try {
      assert.throws(
        resume,
        isWriteFailed,
        "beforeRead runs before the read: a same-inode truncate there is seen (short file)",
      );
    } finally {
      setSessionResumeReadForTests(null);
      writeFileSync(f.path, keep);
    }
    resume(); // the same file, restored, no injected error: a writer
  } finally {
    setSessionResumeReadForTests(null);
    f.cleanup();
  }
});

// A real EACCES at open (mode 000). Root opens it anyway and Windows has no POSIX modes, so there
// the case is a reported skip. `test.skip`, not `{ skip }`: Bun 1.3.11's node:test runs a test
// whose options say `skip` (1.4.2 and Node skip it).
const eaccesSkip =
  process.getuid?.() === 0
    ? "runs as root (root ignores mode 000)"
    : process.platform === "win32"
      ? "no POSIX file modes"
      : null;
if (eaccesSkip !== null) console.log(`SKIP M2-A1 FU L1 errors, EACCES: ${eaccesSkip}`);
(eaccesSkip !== null ? test.skip : test)(
  "M2-A1 FU L1 errors, EACCES (Argus pre-check of 69f0c86, N1): a session file that can't be opened (mode 000) is -32009 at resume, never a raw EACCES",
  () => {
    const f = fixture();
    try {
      f.writer.append("turn.start", { turnId: "turn_1", inputText: "x" });
      const v = verifySessionFile(f.path, "thr_src");
      assert.ok(v.ok);
      if (!v.ok || v.size === undefined) return;
      const resume = () =>
        SessionWriter.resume(
          f.path,
          "thr_src",
          "madc-default",
          v.nextSeq,
          v.lastHash,
          () => [],
          f.dir,
          v.file,
          { holdsLock: () => true, expectedSize: v.size as number },
          undefined,
          SessionChainIndex.fromEvents(v.events),
        );
      chmodSync(f.path, 0o000);
      try {
        assert.throws(
          () => openSync(f.path, "r"),
          { code: "EACCES" },
          "the file really can't be opened",
        );
        assert.throws(
          resume,
          (err: unknown) => err instanceof RpcError && err.code === ErrorCode.SessionWriteFailed,
          "an open-time EACCES is -32009",
        );
      } finally {
        chmodSync(f.path, 0o600);
      }
      resume(); // readable again: a writer
    } finally {
      f.cleanup();
    }
  },
);

// ===================================================================== a.6 P11

test("M2-A1 FU a.6 P11: SessionWriter.resume refuses a missing, empty, forged or foreign index (TypeError, no writer, file unchanged); the Argus R4 / index / alias probes are refused", () => {
  const f = fixture();
  try {
    f.writer.append("turn.start", { turnId: "turn_1", inputText: "x" });
    const v = verifySessionFile(f.path, "thr_src");
    assert.ok(v.ok);
    if (!v.ok || v.size === undefined) return;
    const before = snapshot(f.path);
    const guards = { holdsLock: () => true, expectedSize: v.size as number };
    const resume = (index: unknown) =>
      SessionWriter.resume(
        f.path,
        "thr_src",
        "madc-default",
        v.nextSeq,
        v.lastHash,
        () => [],
        f.dir,
        v.file,
        guards,
        undefined,
        index as SessionChainIndex,
      );
    // R4: no index / the old default (empty) — a v2 file would look like v1 and take a keyless close.
    assert.throws(() => resume(undefined), TypeError, "no index");
    assert.throws(() => resume(new SessionChainIndex()), TypeError, "empty index");
    assert.throws(
      () => resume({ length: v.nextSeq, lineAt: () => ({ hash: v.lastHash }) }),
      TypeError,
      "not an index",
    );
    // A look-alike that delegates every member to the real index is still not one (instanceof).
    const real = SessionChainIndex.fromEvents(v.events);
    const lookAlike = {
      get length() {
        return real.length;
      },
      get openWorktree() {
        return real.openWorktree;
      },
      lineAt: (seq: number) => real.lineAt(seq),
      clone: () => real.clone(),
      note: (e: Parameters<SessionChainIndex["note"]>[0]) => real.note(e),
      handoffState: (id: string) => real.handoffState(id),
      hasDecision: (id: string) => real.hasDecision(id),
      hasTurn: (id: string) => real.hasTurn(id),
    };
    assert.throws(() => resume(lookAlike), TypeError, "a delegating look-alike");
    // probe-index: a forged index with lines the file does not have (a decision could cite seq 3).
    const forged = SessionChainIndex.fromEvents([
      ...v.events,
      { type: "servedModel", hash: "f".repeat(64), payload: {} },
      { type: "servedModel", hash: "f".repeat(64), payload: {} },
    ]);
    assert.throws(() => resume(forged), TypeError, "longer than the chain");
    // Same length, another chain (another file's events).
    const other = rawEvents([
      { type: "session.open", payload: { ...V2_OPEN } },
      { type: "turn.start", payload: { turnId: "turn_1", inputText: "x" } },
    ]);
    assert.throws(
      () => resume(SessionChainIndex.fromEvents(other)),
      TypeError,
      "foreign head hash",
    );
    assert.deepEqual(snapshot(f.path), before, "no refused resume wrote anything");
    // The real index: resume works, and the v2 close rule holds (R4's keyless close is refused).
    const w = resume(SessionChainIndex.fromEvents(v.events));
    const g = { ...f, writer: w };
    const r4 = expectRefusal(g, "session.close", { reason: "shutdown" }, "field-missing");
    assert.deepEqual(r4.issues, ["worktree is required"]);
    // probe-alias: lineAt hands out a frozen line; a mutated hash can never resolve.
    const line0 = w.lineAt(0) as { hash: string };
    assert.equal(Object.isFrozen(line0), true);
    assert.throws(() => {
      line0.hash = "e".repeat(64);
    }, TypeError);
    const fake = { kind: "session", path: "sessions/thr_src.jsonl", seq: 0, hash: "e".repeat(64) };
    expectRefusal(
      g,
      "founderDecision",
      {
        decisionId: "dec_1",
        turnId: "turn_1",
        question: "q",
        recommendedDefault: "d",
        evidenceRefs: [fake],
      },
      "evidence-ref-invalid",
      "turn_1",
    );
    w.append("session.close", { reason: "shutdown", worktree: null });
    assert.equal(
      verifySessionFile(f.path, "thr_src").ok,
      true,
      "the file the writer wrote verifies",
    );
  } finally {
    f.cleanup();
  }
});

// ===================================================================== a.7 P9

test("M2-A1 FU a.7 P9: a founderDecision whose turnId names no turn.start in the file refuses -32010 field-invalid; a started turn (earlier, or earlier in the same batch) is accepted", () => {
  const f = fixture();
  try {
    const open = readLines(f.path)[0] as Line;
    const ref = {
      kind: "session" as const,
      path: "sessions/thr_src.jsonl",
      seq: 0,
      hash: open.hash,
    };
    const decision = (turnId: string, decisionId = "dec_1") => ({
      decisionId,
      turnId,
      question: "q",
      recommendedDefault: "d",
      evidenceRefs: [ref],
    });
    const ghost = expectRefusal(
      f,
      "founderDecision",
      decision("t_ghost"),
      "field-invalid",
      "t_ghost",
    );
    assert.deepEqual(ghost.issues, ["turnId names no turn.start in this file"]);
    f.writer.append("turn.start", { turnId: "turn_1", inputText: "x" });
    expectRefusal(f, "founderDecision", decision("t_ghost"), "field-invalid", "t_ghost");
    assert.equal(f.writer.append("founderDecision", decision("turn_1")).type, "founderDecision");
    const batch = f.writer.appendAll([
      { type: "turn.start", payload: { turnId: "turn_2", inputText: "y" } },
      { type: "founderDecision", payload: decision("turn_2", "dec_2") },
    ]);
    assert.deepEqual(
      batch.map((e) => e.type),
      ["turn.start", "founderDecision"],
    );
    assert.equal(verifySessionFile(f.path, "thr_src").ok, true);
  } finally {
    f.cleanup();
  }
});

// ===================================================================== a.8 P22

test("M2-A1 FU a.8 P22 (Copilot r4168208974): doctor FAILs evidence-ref-mismatch when a reserved tool.call's call/result does not resolve to a same-file item line with that hash", () => {
  const { home, cleanup } = makeHome();
  try {
    const head = [
      { type: "session.open", payload: { ...V2_OPEN } as Record<string, unknown> },
      { type: "turn.start", payload: { turnId: "turn_1", inputText: "x" } },
      {
        type: "item",
        payload: {
          turnId: "turn_1",
          // K3 (pin §4.2): the receipt's endpoints are the toolCall / toolResult items.
          item: {
            id: "item_1",
            kind: "toolCall",
            status: "completed",
            name: "read",
            arguments: {},
          },
        },
      },
      {
        type: "item",
        payload: {
          turnId: "turn_1",
          item: {
            id: "item_2",
            kind: "toolResult",
            status: "completed",
            callId: "item_1",
            name: "read",
            output: "ok",
            isError: false,
          },
        },
      },
    ];
    const pre = rawEvents(head);
    const [open, , call, result] = pre as [Line, Line, Line, Line];
    const receipt = (c: unknown, r: unknown) => ({
      type: "tool.call",
      payload: {
        turnId: "turn_1",
        callId: "item_1",
        name: "read",
        server: null,
        call: c,
        result: r,
        decision: "allowed",
        reason: null,
      },
    });
    const cases: Array<[string, unknown, unknown, string[]]> = [
      ["resolving", { seq: 2, hash: call.hash }, { seq: 3, hash: result.hash }, []],
      ["denied before it ran (result null)", { seq: 2, hash: call.hash }, null, []],
      // The Argus r3 probe: call names no line, result names the session.open.
      [
        "probe-r3",
        { seq: 99, hash: HEX64 },
        { seq: 0, hash: open.hash },
        ["fail evidence-ref-mismatch", "fail evidence-ref-mismatch"],
      ],
      [
        "call hash differs",
        { seq: 2, hash: result.hash },
        { seq: 3, hash: result.hash },
        ["fail evidence-ref-mismatch"],
      ],
      [
        "result names a turn.start",
        { seq: 2, hash: call.hash },
        { seq: 1, hash: (pre[1] as Line).hash },
        ["fail evidence-ref-mismatch"],
      ],
    ];
    for (const [name, c, r, expected] of cases) {
      const events = rawEvents([...head, receipt(c, r)]);
      const v = verifySessionText(rawText(events));
      assert.equal(v.ok, true, `${name}: shape-valid, verifies`);
      const findings = inspectSessionV2(home, events).filter(
        (x) => x.code !== "not-cleanly-closed",
      );
      assert.deepEqual(brief(findings), expected, name);
      for (const x of findings)
        assert.match(x.detail, /^tool\.call at seq 4 (call|result): seq \d+ is not an item line/);
    }
  } finally {
    cleanup();
  }
});

test("M2-A1 FU K3 (Copilot r4174562336, pin §4.2 :264, :267-268): doctor FAILs evidence-ref-mismatch when a tool.call's call/result is a hash-valid item line that is not the receipt's toolCall / toolResult", () => {
  const { home, cleanup } = makeHome();
  try {
    const item = (id: string, body: Record<string, unknown>) => ({
      type: "item",
      payload: { turnId: "turn_1", item: { id, status: "completed", ...body } },
    });
    const head = [
      { type: "session.open", payload: { ...V2_OPEN } as Record<string, unknown> },
      { type: "turn.start", payload: { turnId: "turn_1", inputText: "x" } },
      item("item_1", { kind: "toolCall", name: "read", arguments: {} }), // seq 2
      item("item_2", {
        kind: "toolResult",
        callId: "item_1",
        name: "read",
        output: "ok",
        isError: false,
      }), // seq 3
      item("item_3", { kind: "agentMessage", text: "hi" }), // seq 4
      item("item_4", { kind: "toolCall", name: "read", arguments: {} }), // seq 5: another call
      item("item_5", {
        kind: "toolResult",
        callId: "item_4",
        name: "read",
        output: "ok",
        isError: false,
      }), // seq 6: another call's result
      item("item_6", { kind: "agentMessage", text: "hi", callId: "item_1" }), // seq 7: not a toolResult
    ];
    const pre = rawEvents(head);
    const at = (seq: number) => ({ seq, hash: (pre[seq] as Line).hash });
    const receipt = (c: unknown, r: unknown, callId = "item_1") => ({
      type: "tool.call",
      payload: {
        turnId: "turn_1",
        callId,
        name: "read",
        server: null,
        call: c,
        result: r,
        // Pin §4.2 :268: `result` is null exactly when the call was denied before it ran.
        decision: r === null ? "denied" : "allowed",
        reason: r === null ? "read:*" : null,
      },
    });
    const kindFail = (name: string, kind: string) =>
      `tool.call at seq 8 ${name}: seq \\d+ is not the ${kind} item of the receipt's callId`;
    const cases: Array<[string, Record<string, unknown>, string[]]> = [
      ["linked toolCall / toolResult", receipt(at(2), at(3)), []],
      ["denied (result null)", receipt(at(2), null), []],
      ["call is an agentMessage", receipt(at(4), at(3)), [kindFail("call", "toolCall")]],
      ["result is an agentMessage", receipt(at(2), at(4)), [kindFail("result", "toolResult")]],
      ["call is the toolResult", receipt(at(3), at(3)), [kindFail("call", "toolCall")]],
      ["result is the toolCall", receipt(at(2), at(2)), [kindFail("result", "toolResult")]],
      ["call is another call", receipt(at(5), at(3)), [kindFail("call", "toolCall")]],
      ["result is another call's", receipt(at(2), at(6)), [kindFail("result", "toolResult")]],
      // The id links but the kind is wrong (only the kind check catches these).
      [
        "call is an agentMessage whose id is the callId",
        receipt(at(4), null, "item_3"),
        [kindFail("call", "toolCall")],
      ],
      [
        "result is an agentMessage carrying the callId",
        receipt(at(2), at(7)),
        [kindFail("result", "toolResult")],
      ],
      [
        "callId names neither",
        receipt(at(2), at(3), "item_9"),
        [kindFail("call", "toolCall"), kindFail("result", "toolResult")],
      ],
    ];
    for (const [name, r, expected] of cases) {
      const events = rawEvents([...head, r as { type: string; payload: Record<string, unknown> }]);
      assert.equal(verifySessionText(rawText(events)).ok, true, `${name}: shape-valid, verifies`);
      const findings = inspectSessionV2(home, events).filter(
        (x) => x.code !== "not-cleanly-closed",
      );
      assert.deepEqual(
        brief(findings),
        expected.map(() => "fail evidence-ref-mismatch"),
        name,
      );
      findings.forEach((x, i) => {
        assert.match(x.detail, new RegExp(`^${expected[i] as string}$`), name);
        assert.equal(x.detail.includes("item_9"), false, `${name}: no caller id echoed`);
      });
    }
  } finally {
    cleanup();
  }
});

// ===================================================================== a.9 P13

test("M2-A1 FU a.9 P13 (Copilot review 5391183893): a session.open that redaction would rewrite is refused -32010 BEFORE any file is opened — no openSync, no file, no unlink", () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "madc-m2a1fu-p13-"));
  try {
    mkdirSync(join(dir, "sessions"), { mode: 0o700 });
    const tokenOpen: SessionOpenPayload = {
      ...V1_OPEN,
      cwd: `/work/${GHP}`,
      worktree: { topLevel: `/work/${GHP}`, remote: null, head: SHA_C },
      handoff: null,
    };
    const path = join(dir, "sessions", "thr_p13.jsonl");
    const refuse = () =>
      assert.throws(
        () =>
          unguardedSessionWriterForTests.create(
            path,
            "thr_p13",
            "madc-default",
            tokenOpen,
            () => [],
          ),
        (err: unknown) => {
          assert.ok(err instanceof RpcError);
          assert.equal(err.code, ErrorCode.EvidenceInvalid);
          assert.equal(err.data?.reason, "field-invalid");
          assert.deepEqual(err.data?.issues, [
            "redaction would rewrite structural field worktree.topLevel",
          ]);
          return true;
        },
      );
    let calibrated = 0;
    let onRefusal = -1;
    // Argus PR #48 r1 K1: a plain wrapper, not node:test's `mock.method` (absent in Bun 1.3.11,
    // the CI pin), so the test runs on every runtime. `syncBuiltinESMExports` makes the store's
    // named `openSync` import see it where the runtime supports that (calibration says so).
    type OpenSync = typeof fs.openSync;
    const writableFs = fs as { openSync: OpenSync };
    const realOpenSync = fs.openSync;
    let opens = 0;
    writableFs.openSync = ((...args: Parameters<OpenSync>) => {
      opens++;
      return realOpenSync(...args);
    }) as OpenSync;
    syncBuiltinESMExports();
    try {
      // Calibration: a valid create opens the file, so the spy sees the store's openSync.
      unguardedSessionWriterForTests.create(
        join(dir, "sessions", "thr_ok.jsonl"),
        "thr_ok",
        "madc-default",
        V2_OPEN,
        () => [],
      );
      calibrated = opens;
      opens = 0;
      refuse();
      onRefusal = opens;
    } finally {
      writableFs.openSync = realOpenSync;
      syncBuiltinESMExports();
    }
    // Bun (1.3.11 and 1.4.2) binds node:fs named imports at link time, so the wrapper is not
    // observed there (calibration 0) and only the behavioral checks below apply; under Node the
    // spy must see the calibration open, so the count check can never go silently dead there.
    assert.equal(fs.openSync, realOpenSync, "openSync restored");
    if (typeof process.versions.bun !== "string") assert.ok(calibrated > 0, "Node: spy calibrated");
    if (calibrated > 0) assert.equal(onRefusal, 0, "no openSync on the refusal path");
    assert.equal(existsSync(path), false, "no file");
    // Behavioral proof that nothing was opened: with no sessions/ directory an open would fail
    // -32009 (SessionWriteFailed); the refusal answers -32010 first.
    const missing = join(dir, "nosessions", "thr_p13.jsonl");
    assert.throws(
      () =>
        unguardedSessionWriterForTests.create(
          missing,
          "thr_p13",
          "madc-default",
          tokenOpen,
          () => [],
        ),
      (err: unknown) => err instanceof RpcError && err.code === ErrorCode.EvidenceInvalid,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===================================================================== a.11 P14

test("M2-A1 FU a.11 P14: on a broken writer an invalid record answers -32009 (broken), not -32010 — today's precedence, pinned", () => {
  const f = fixture();
  try {
    writeFileSync(f.path, `${readFileSync(f.path, "utf8")}{"foreign":true}\n`);
    assert.throws(
      () => f.writer.append("turn.start", { turnId: "turn_1", inputText: "x" }),
      (err: unknown) => err instanceof RpcError && err.code === ErrorCode.SessionWriteFailed,
    );
    assert.equal(f.writer.broken, true);
    const before = snapshot(f.path);
    for (const [type, payload] of [
      [
        "founderDecision",
        {
          decisionId: "d1",
          turnId: "t_ghost",
          question: "q",
          recommendedDefault: "d",
          evidenceRefs: [],
        },
      ],
      ["handoff.out", { handoffId: "bad id", targetSeatId: "x", brief: "" }],
      ["memory.write", {}],
    ] as const) {
      assert.throws(
        () => raw(f.writer).append(type, payload),
        (err: unknown) => err instanceof RpcError && err.code === ErrorCode.SessionWriteFailed,
        `${type}: -32009 before -32010`,
      );
    }
    assert.deepEqual(snapshot(f.path), before);
  } finally {
    f.cleanup();
  }
});

// ===================================================================== a.12 P12

test("M2-A1 FU a.12 P12: a same-file ref to a seq at or after its own line is FAIL evidence-ref-mismatch (the Argus probe-index file), not WARN unresolved", () => {
  const { home, cleanup } = makeHome();
  try {
    const head = [
      { type: "session.open", payload: { ...V2_OPEN } as Record<string, unknown> },
      { type: "turn.start", payload: { turnId: "turn_1", inputText: "x" } },
    ];
    const pre = rawEvents(head, "thr_i");
    const d = (seq: number, hash: string) => ({
      type: "founderDecision",
      payload: {
        decisionId: "d1",
        turnId: "turn_1",
        question: "q",
        recommendedDefault: "d",
        evidenceRefs: [{ kind: "session", path: "sessions/thr_i.jsonl", seq, hash }],
      },
    });
    for (const [seq, hash] of [
      [3, "f".repeat(64)],
      [2, "f".repeat(64)],
      [9, HEX64],
    ] as const) {
      const events = rawEvents([...head, d(seq, hash)], "thr_i");
      writeRaw(home, "thr_i", events);
      const findings = findingsOf(home, "thr_i").filter((x) => x.code.startsWith("evidence"));
      assert.deepEqual(brief(findings), ["fail evidence-ref-mismatch"], `seq ${seq}`);
      assert.match(
        findings[0]?.detail ?? "",
        new RegExp(`seq ${seq} is not below this line's seq 2`),
      );
    }
    // A backward same-file ref that resolves stays clean.
    writeRaw(home, "thr_i", rawEvents([...head, d(1, (pre[1] as Line).hash)], "thr_i"));
    assert.deepEqual(
      brief(findingsOf(home, "thr_i").filter((x) => x.code.startsWith("evidence"))),
      [],
    );
  } finally {
    cleanup();
  }
});

// ===================================================================== a.1 P25: writer mutants

test("M2-A1 FU a.1 M02: an EvidenceRef hash that is not 64 lowercase hex refuses -32010 evidence-ref-invalid at write (cross-file refs too) and fails verify on read", () => {
  const f = fixture();
  try {
    f.writer.append("turn.start", { turnId: "turn_1", inputText: "x" });
    for (const hash of ["Z".repeat(64), "A".repeat(64), "a".repeat(63), `${"a".repeat(63)}g`]) {
      const ref = { kind: "session", path: "sessions/thr_other.jsonl", seq: 0, hash };
      const r = expectRefusal(
        f,
        "founderDecision",
        {
          decisionId: "dec_1",
          turnId: "turn_1",
          question: "q",
          recommendedDefault: "d",
          evidenceRefs: [ref],
        },
        "evidence-ref-invalid",
        "turn_1",
      );
      assert.deepEqual(r.issues, ["evidenceRefs[0] hash must be 64 lowercase hex"], hash);
    }
  } finally {
    f.cleanup();
  }
  const bad = rawEvents([
    { type: "session.open", payload: { ...V2_OPEN } },
    {
      type: "founderDecision",
      payload: {
        decisionId: "dec_1",
        turnId: "turn_1",
        question: "q",
        recommendedDefault: "d",
        evidenceRefs: [
          { kind: "servedModel", path: "sessions/thr_o.jsonl", seq: 0, hash: "Z".repeat(64) },
        ],
      },
    },
  ]);
  const v = verifySessionText(rawText(bad));
  assert.equal(
    v.ok ? "" : `${v.line} ${v.kind} ${v.reason}`,
    "2 integrity malformed founderDecision payload",
  );
});

test("M2-A1 FU a.1 M19: the writer refuses a session.close whose worktree names another topLevel than the open (-32010 field-invalid)", () => {
  const f = fixture("thr_src", "madc-default", { ...V2_OPEN, worktree: REPO_WT });
  try {
    const r = expectRefusal(
      f,
      "session.close",
      { reason: "shutdown", worktree: { ...REPO_WT, topLevel: "/other" } },
      "field-invalid",
    );
    assert.deepEqual(r.issues, ["worktree.topLevel differs from the session.open worktree"]);
    f.writer.append("session.close", {
      reason: "shutdown",
      worktree: { ...REPO_WT, head: "d".repeat(40) },
    });
    assert.equal(verifySessionFile(f.path, "thr_src").ok, true);
  } finally {
    f.cleanup();
  }
});

test("M2-A1 FU a.1 M65: a founderDecision with no turnId refuses -32010 field-missing at write and fails verify on read", () => {
  const f = fixture();
  try {
    f.writer.append("turn.start", { turnId: "turn_1", inputText: "x" });
    const open = readLines(f.path)[0] as Line;
    const ref = {
      kind: "session" as const,
      path: "sessions/thr_src.jsonl",
      seq: 0,
      hash: open.hash,
    };
    const r = expectRefusal(
      f,
      "founderDecision",
      { decisionId: "dec_1", question: "q", recommendedDefault: "d", evidenceRefs: [ref] },
      "field-missing",
    );
    assert.deepEqual(r.issues, ["turnId is required"]);
  } finally {
    f.cleanup();
  }
  const bad = rawEvents([
    { type: "session.open", payload: { ...V2_OPEN } },
    {
      type: "founderDecision",
      payload: {
        decisionId: "d1",
        question: "q",
        recommendedDefault: "d",
        evidenceRefs: [{ kind: "git", sha: SHA_C, remote: null }],
      },
    },
  ]);
  const v = verifySessionText(rawText(bad));
  assert.equal(v.ok ? "" : `${v.line} ${v.reason}`, "2 malformed founderDecision payload");
});

test("M2-A1 FU a.1 N17: SessionWriter.create refuses a malformed session.open before anything is opened (-32010, not the -32009 of a failed open, and no file)", () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "madc-m2a1fu-n17-"));
  try {
    // No sessions/ directory: an open would fail -32009; validation must answer first.
    const path = join(dir, "sessions", "thr_n17.jsonl");
    for (const open of [
      { ...V2_OPEN, worktree: { topLevel: "relative/top", remote: null, head: null } },
      { ...V1_OPEN, worktree: null } as SessionOpenPayload,
    ]) {
      assert.throws(
        () =>
          unguardedSessionWriterForTests.create(path, "thr_n17", "madc-default", open, () => []),
        (err: unknown) => {
          assert.ok(err instanceof RpcError, String(err));
          assert.equal(err.code, ErrorCode.EvidenceInvalid, JSON.stringify(err.data));
          return true;
        },
      );
      assert.equal(existsSync(path), false);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M2-A1 FU a.1 M61: the memory.write shape check confines path to a seat memory file even with no envelope seat (exported checkV2Payload)", () => {
  const base = {
    turnId: "turn_1",
    op: "append",
    bytes: 1,
    contentSha256: HEX64,
    requestedModel: "m",
    servedModel: "m",
    providerId: BACKING,
    lane: "allowed-direct",
    vendorReported: true,
  };
  for (const path of [
    "memory/../secrets.md",
    "notes/x.md",
    "/memory/x.md",
    "memory/x.txt",
    "memory/.md",
  ]) {
    assert.deepEqual(
      checkV2Payload("memory.write", { ...base, path }).map((i) => i.issue),
      ["path must be a seat memory path"],
      path,
    );
  }
  assert.deepEqual(checkV2Payload("memory.write", { ...base, path: "memory/team.md" }), []);
});

// ===================================================================== a.1 P25: target check / doctor

test("M2-A1 FU a.1 M38: the target check refuses a handoff.link that names another targetThreadId (genesis hash and seat still right)", () => {
  const { home, cleanup } = makeHome();
  try {
    writePair(home);
    assert.deepEqual(checkHandoffTarget(home, targetFacts(home)), { ok: true });
    rewriteLine(sessionPath(home, "thr_src"), 4, (p) => {
      p.targetThreadId = "thr_other";
    });
    const check = checkHandoffTarget(home, targetFacts(home));
    assert.equal(check.ok, false);
    assert.equal(check.ok ? "" : check.kind, "mismatch");
    assert.deepEqual(check.ok ? [] : check.issues, [
      "source handoff.link (seq 4) names another targetThreadId",
    ]);
  } finally {
    cleanup();
  }
});

test("M2-A1 FU a.1 M35 / M44: handoff.out targetSeatId that is not the target's seat (link still names it) is refused by the target check and FAILed by doctor from the source", () => {
  const { home, cleanup } = makeHome();
  try {
    writePair(home, { outTargetSeat: "argus" });
    const check = checkHandoffTarget(home, targetFacts(home));
    assert.equal(check.ok ? "" : check.kind, "mismatch");
    assert.deepEqual(check.ok ? [] : check.issues, [
      "source line 3 targetSeatId is not this thread's seat",
    ]);
    const src = findingsOf(home, "thr_src").filter((f) => f.code.startsWith("handoff"));
    assert.deepEqual(brief(src), ["fail handoff-mismatch"]);
    assert.match(src[0]?.detail ?? "", /target seat differs from the recorded targetSeatId/);
  } finally {
    cleanup();
  }
});

test("M2-A1 FU a.1 M34: the target check refuses a link whose sourceSeatId is not the source file's seat", () => {
  const { home, cleanup } = makeHome();
  try {
    writePair(home, { sourceSeatId: "argus" });
    const check = checkHandoffTarget(home, targetFacts(home));
    assert.equal(check.ok ? "" : check.kind, "mismatch");
    assert.deepEqual(check.ok ? [] : check.issues, [
      "source seat differs from the recorded sourceSeatId",
    ]);
  } finally {
    cleanup();
  }
});

test("M2-A1 FU a.1 M36 / M41 / M42: two terminal records refuse the target; doctor FAILs a duplicate handoff.out id and a terminal record with no handoff.out", () => {
  const { home, cleanup } = makeHome();
  try {
    const srcHead = [
      { type: "session.open", payload: { ...V2_OPEN } as Record<string, unknown> },
      {
        type: "handoff.out",
        payload: { handoffId: "ho_1", turnId: null, targetSeatId: "hephaestus", brief: "b" },
      },
    ];
    const out = rawEvents(srcHead, "thr_src", "daedalus")[1] as Line;
    const tgt = rawEvents(
      [
        {
          type: "session.open",
          payload: {
            ...V2_OPEN,
            handoff: {
              sourceThreadId: "thr_src",
              sourceSeatId: "daedalus",
              handoffId: "ho_1",
              sourceSeq: 1,
              sourceHash: out.hash,
            },
          },
        },
      ],
      "thr_tgt",
      "hephaestus",
    );
    writeRaw(home, "thr_tgt", tgt);
    const link = {
      type: "handoff.link",
      payload: {
        handoffId: "ho_1",
        targetThreadId: "thr_tgt",
        targetSeatId: "hephaestus",
        targetGenesisHash: (tgt[0] as Line).hash,
      },
    };
    const abort = {
      type: "handoff.aborted",
      payload: { handoffId: "ho_1", reason: "interrupted", error: null },
    };
    writeRaw(home, "thr_src", rawEvents([...srcHead, link], "thr_src", "daedalus"));
    assert.deepEqual(checkHandoffTarget(home, targetFacts(home)), { ok: true });
    writeRaw(home, "thr_src", rawEvents([...srcHead, link, abort], "thr_src", "daedalus"));
    const check = checkHandoffTarget(home, targetFacts(home));
    assert.equal(check.ok ? "" : check.kind, "mismatch");
    assert.match(
      check.ok ? "" : check.issues.join(" "),
      /2 terminal records .*handoff-terminal-conflict/,
    );
    // M41: a second handoff.out with the same id.
    writeRaw(home, "thr_dup", rawEvents([...srcHead, srcHead[1] as never], "thr_dup", "daedalus"));
    assert.ok(brief(findingsOf(home, "thr_dup")).includes("fail duplicate-id"));
    // M42: a terminal record whose handoff.out does not exist.
    writeRaw(
      home,
      "thr_orph",
      rawEvents(
        [srcHead[0] as never, { ...link, payload: { ...link.payload, handoffId: "ho_9" } }],
        "thr_orph",
        "daedalus",
      ),
    );
    const orph = findingsOf(home, "thr_orph").filter((f) => f.code === "handoff-mismatch");
    assert.deepEqual(brief(orph), ["fail handoff-mismatch"]);
    assert.match(orph[0]?.detail ?? "", /names handoff ho_9, which has no handoff\.out/);
  } finally {
    cleanup();
  }
});

test("M2-A1 FU a.1 M31: a WARM thread/resume of a target re-checks the link (force): a source that lost its handoff.link since the last resume refuses -32010", async () => {
  const { home, cleanup } = makeHome();
  try {
    writePair(home);
    const e = inProcess(home);
    await e.init();
    assert.ok((await e.request("thread/resume", { threadId: "thr_tgt" })).result, "linked: loads");
    // A second (warm) resume passes the gate, so the record is now marked verified.
    assert.ok((await e.request("thread/resume", { threadId: "thr_tgt" })).result, "linked: warm");
    const src = sessionPath(home, "thr_src");
    const kept = readLines(src).slice(0, -1); // drop the handoff.link (the chain stays valid)
    writeFileSync(src, `${kept.map((l) => JSON.stringify(l)).join("\n")}\n`);
    const target = sessionPath(home, "thr_tgt");
    const before = sha256(target);
    const r = await e.request("thread/resume", { threadId: "thr_tgt" });
    const err = r.error as { code: number; data: { reason: string } } | undefined;
    assert.equal(err?.code, -32010, JSON.stringify(r));
    assert.equal(err?.data.reason, "handoff-one-way");
    assert.equal(sha256(target), before, "nothing appended");
    await e.close();
  } finally {
    cleanup();
  }
});

test("M2-A1 FU a.1 M46 / M59 / M47: doctor FAILs a cross-file ref whose hash differs or whose servedModel line is another type, and WARNs a git ref git cannot find", () => {
  const { home, cleanup } = makeHome();
  try {
    const a = rawEvents(
      [
        { type: "session.open", payload: { ...V2_OPEN } },
        { type: "turn.start", payload: { turnId: "turn_1", inputText: "x" } },
      ],
      "thr_a",
    );
    writeRaw(home, "thr_a", a);
    const decisionFile = (refs: unknown[]) =>
      rawEvents(
        [
          { type: "session.open", payload: { ...V2_OPEN, worktree: REPO_WT } },
          { type: "turn.start", payload: { turnId: "turn_1", inputText: "x" } },
          {
            type: "founderDecision",
            payload: {
              decisionId: "d1",
              turnId: "turn_1",
              question: "q",
              recommendedDefault: "d",
              evidenceRefs: refs,
            },
          },
        ],
        "thr_b",
      );
    const ev = (findings: SessionFinding[]) =>
      brief(findings.filter((f) => f.code.startsWith("evidence")));
    const line1 = (a[1] as Line).hash;
    const cases: Array<[string, unknown, string[]]> = [
      ["resolves", { kind: "session", path: "sessions/thr_a.jsonl", seq: 1, hash: line1 }, []],
      [
        "M46 hash differs",
        { kind: "session", path: "sessions/thr_a.jsonl", seq: 1, hash: HEX64 },
        ["fail evidence-ref-mismatch"],
      ],
      [
        "M59 not servedModel",
        { kind: "servedModel", path: "sessions/thr_a.jsonl", seq: 1, hash: line1 },
        ["fail evidence-ref-mismatch"],
      ],
    ];
    for (const [name, ref, expected] of cases) {
      writeRaw(home, "thr_b", decisionFile([ref]));
      assert.deepEqual(ev(findingsOf(home, "thr_b")), expected, name);
    }
    writeRaw(home, "thr_b", decisionFile([{ kind: "git", sha: SHA_C, remote: null }]));
    const missing: GitRunner = () => ({ code: 1, stdout: "" });
    const present: GitRunner = () => ({ code: 0, stdout: "" });
    const m47 = findingsOf(home, "thr_b", missing).filter((f) => f.code.startsWith("evidence"));
    assert.deepEqual(brief(m47), ["warn evidence-ref-unresolved"]);
    assert.match(m47[0]?.detail ?? "", new RegExp(`git ${SHA_C} not found in /repo`));
    assert.deepEqual(ev(findingsOf(home, "thr_b", present)), []);
  } finally {
    cleanup();
  }
});

test("M2-A1 FU a.1 N07: inspectSessionV2 FAILs a line whose payload is not an object (null, array, string) and never throws", () => {
  const { home, cleanup } = makeHome();
  try {
    const events = rawEvents([
      { type: "session.open", payload: { ...V2_OPEN } },
      { type: "turn.start", payload: { turnId: "turn_1", inputText: "x" } },
    ]);
    for (const payload of [null, [1], "x"]) {
      const lines = [events[0], { ...(events[1] as Line), payload }] as SessionEvent[];
      let findings: SessionFinding[] = [];
      assert.doesNotThrow(() => {
        findings = inspectSessionV2(home, lines);
      }, JSON.stringify(payload));
      assert.deepEqual(
        findings.filter((f) => f.code === "integrity"),
        [{ level: "fail", code: "integrity", detail: "line 2: payload is not an object" }],
      );
    }
  } finally {
    cleanup();
  }
});
