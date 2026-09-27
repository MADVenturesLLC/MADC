/**
 * M0 Amendment 3 (docs/plan/PIN-madc-M0-amendment-3.md) acceptance:
 * item 1 rollback durability and broken-writer recovery (1a, 1a-w, 1b rows a/b/c/a-f/p-r, 1b-p,
 * 1e, 1b-t), item 2 crash-residue classification (2a, 2b), item 3 writer guard Option A
 * (3a–3d), item 4 seed `created:false` proof (4a–4f), item 5 `sessions/` permissions (5a).
 * Network-free: in-process engines and direct writer use only.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  ftruncateSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { type Agent, echoAgent } from "./agent.ts";
import { RpcError } from "./protocol/errors.ts";
import type { Turn } from "./protocol/types.ts";
import { MADC_DEFAULT_SEAT } from "./seat.ts";
import { seedDefaultSeat, serializeSeat, setSeedHooksForTests } from "./seat-store.ts";
import { EngineConnection } from "./server.ts";
import {
  GENESIS_HASH,
  SessionWriter,
  setSessionCloseForTests,
  setSessionFsyncForTests,
  setSessionTruncateForTests,
  setSessionWriteForTests,
  unguardedSessionWriterForTests,
  verifySessionFile,
  verifySessionText,
} from "./session-store.ts";
import { makeHome } from "./testing/harness.ts";

const POSIX = process.platform !== "win32";
const SEED_PROBE = fileURLToPath(new URL("./testing/seed-probe.ts", import.meta.url));

type Wire = Record<string, unknown> & { params?: Record<string, unknown> };

function inProcess(home: string, agent: Agent = echoAgent) {
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
    log: (m) => logs.push(m),
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
  const init = () => request("initialize", { clientInfo: { name: "t", version: "0" } });
  const close = async () => {
    input.end();
    await done;
  };
  return { input, received, done, waitFor, request, init, close, logs };
}

/** Agent whose agentMessage completes (the turn's next append) only when `open()` is called. */
function gatedAgent(): { agent: Agent; open: () => void } {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const agent: Agent = {
    name: "gated",
    async run(_ctx, sink) {
      const id = sink.newItemId();
      sink.startItem({ id, kind: "agentMessage", status: "inProgress", text: "" });
      await gate;
      sink.completeItem({ id, kind: "agentMessage", status: "completed", text: "gated" });
    },
  };
  return { agent, open: () => release() };
}

const text = (t: string) => [{ type: "text", text: t }];
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const sessionPath = (home: string, id: string) => join(home, "sessions", `${id}.jsonl`);
const lockPath = (home: string, id: string) => join(home, "sessions", `${id}.lock`);

function completedTurn(m: Wire): Turn {
  return (m.params as { turn: Turn }).turn;
}

/** Wait for the turn/completed of THIS turn (earlier completions stay in the log). */
function waitTurnCompleted(e: ReturnType<typeof inProcess>, turnId: string): Promise<Turn> {
  return e
    .waitFor(
      (m) => m.method === "turn/completed" && (m.params as { turn: Turn }).turn.id === turnId,
    )
    .then(completedTurn);
}

/** The turn id of a successful turn/start response. */
function startedTurnId(m: Wire): string {
  return (m.result as { turn: Turn }).turn.id;
}

const agentMessageStarted = (m: Wire): boolean =>
  m.method === "item/started" &&
  (m.params?.item as { kind?: string } | undefined)?.kind === "agentMessage";

async function startThread(e: ReturnType<typeof inProcess>): Promise<string> {
  await e.init();
  const start = await e.request("thread/start", {});
  return (start.result as { thread: { id: string } }).thread.id;
}

const SAMPLE_OPEN = {
  cwd: null,
  backing: "kimi-code",
  providerId: "kimi-code",
  pinnedModel: "m",
} as const;

/** Hash of the last line of a session file (the chain head). */
function readLastHash(path: string): string {
  const last = readFileSync(path, "utf8").trimEnd().split("\n").at(-1) ?? "{}";
  return (JSON.parse(last) as { hash: string }).hash;
}

/** A short valid chain (session.open, one completed turn) written by the writer. */
function writeSampleSession(dir: string, threadId = "thr_sample"): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${threadId}.jsonl`);
  const w = unguardedSessionWriterForTests.create(
    path,
    threadId,
    "madc-default",
    SAMPLE_OPEN,
    () => [],
  );
  w.append("turn.start", { turnId: "turn_1", inputText: "hi" });
  w.append("turn.end", { turnId: "turn_1", status: "completed", error: null });
  return path;
}

// ------------------------------------------------------------------ item 1 (1a, 1a-w)

test("A3 1a: a failed batch fsync truncates to the pre-batch offset, fsyncs the truncate, and answers -32009", () => {
  const { home, cleanup } = makeHome();
  const ops: string[] = [];
  let failNext = false;
  setSessionFsyncForTests({
    file: () => {
      ops.push("fsync");
      if (failNext) {
        failNext = false;
        throw new Error("EIO (injected)");
      }
    },
  });
  try {
    const path = writeSampleSession(join(home, "sessions"));
    const before = readFileSync(path);
    const w = unguardedSessionWriterForTests.resume(
      path,
      "thr_sample",
      "madc-default",
      3,
      readLastHash(path),
      () => [],
    );
    failNext = true;
    const fsyncsBefore = ops.length;
    assert.throws(
      () => w.append("turn.start", { turnId: "turn_2", inputText: "b" }),
      (err: RpcError) => err.code === -32009 && (err.data as { seq: number }).seq === 3,
    );
    assert.equal(
      ops.length - fsyncsBefore,
      2,
      "two fsyncs for the failed batch: its own and the rollback's",
    );
    assert.deepEqual(readFileSync(path), before, "file bytes equal the pre-batch bytes");
    assert.equal(w.broken, true);
    assert.equal(w.poisoned, false, "rollback reached disk: broken, not poisoned");
  } finally {
    setSessionFsyncForTests(null);
    cleanup();
  }
});

test("A3 1a-w: a partial write (ENOSPC mid-batch) truncates to the pre-batch offset, then fsyncs, -32009", () => {
  const { home, cleanup } = makeHome();
  const ops: string[] = [];
  const fsyncs: number[] = [];
  const truncates: number[] = [];
  try {
    const path = writeSampleSession(join(home, "sessions"));
    const before = readFileSync(path);
    const w = unguardedSessionWriterForTests.resume(
      path,
      "thr_sample",
      "madc-default",
      3,
      readLastHash(path),
      () => [],
    );
    // Armed only now: the write seam writes the batch's first line, then throws ENOSPC.
    setSessionWriteForTests((fd, buf, off, len) => {
      const firstLine = buf.indexOf("\n", off) + 1;
      if (ops.includes("write:partial")) {
        ops.push("write:ENOSPC");
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      }
      ops.push("write:partial");
      return writeSync(fd, buf, off, Math.min(len, firstLine - off));
    });
    setSessionFsyncForTests({
      file: (fd) => {
        ops.push("fsync");
        fsyncs.push(fd);
      },
    });
    setSessionTruncateForTests((fd, size) => {
      ops.push(`truncate:${size}`);
      truncates.push(size);
      ftruncateSync(fd, size);
    });
    assert.throws(
      () =>
        w.appendAll([
          { type: "turn.start", payload: { turnId: "turn_2", inputText: "a" } },
          {
            type: "item",
            payload: {
              turnId: "turn_2",
              item: { id: "item_1", kind: "agentMessage", status: "completed", text: "x" },
            },
          },
          { type: "turn.end", payload: { turnId: "turn_2", status: "completed", error: null } },
        ]),
      (err: RpcError) => err.code === -32009 && (err.data as { seq: number }).seq === 3,
    );
    assert.deepEqual(truncates, [before.length], "one truncate, to the pre-batch offset");
    assert.deepEqual(
      ops.slice(ops.indexOf("write:ENOSPC") + 1),
      [`truncate:${before.length}`, "fsync"],
      "the fsync runs after the truncate",
    );
    assert.equal(
      fsyncs.length,
      1,
      "only the rollback fsync ran (the batch fsync was never reached)",
    );
    assert.deepEqual(readFileSync(path), before, "no partial line left behind");
    assert.equal(w.broken, true);
    assert.equal(w.poisoned, false);
  } finally {
    setSessionWriteForTests(null);
    setSessionFsyncForTests(null);
    setSessionTruncateForTests(null);
    cleanup();
  }
});

// ------------------------------------------------------------------ item 1 rule 6 (1b)

test("A3 1b (a): rollback durable → turn/start -32009 writes nothing; thread/resume reloads under the held lock; the next turn appends and verifies", async () => {
  const { home, cleanup } = makeHome();
  let failNext = false;
  setSessionFsyncForTests({
    file: () => {
      if (failNext) {
        failNext = false;
        throw new Error("EIO (injected)");
      }
    },
  });
  const e = inProcess(home);
  try {
    const t = await startThread(e);
    const first = await e.request("turn/start", { threadId: t, input: text("first") });
    await waitTurnCompleted(e, startedTurnId(first));
    const path = sessionPath(home, t);
    const before = sha256(path);
    failNext = true;
    const refused = await e.request("turn/start", { threadId: t, input: text("second") });
    assert.equal((refused.error as { code: number }).code, -32009);
    assert.equal(sha256(path), before, "the refused batch never reappears");
    assert.equal(e.logs.filter((l) => l.includes("rollback failed")).length, 0, "not poisoned");
    // Row (a): thread/resume clears the broken writer by reloading from disk, lock kept.
    const resumed = await e.request("thread/resume", { threadId: t });
    assert.ok(resumed.result, JSON.stringify(resumed.error));
    const ok = await e.request("turn/start", { threadId: t, input: text("third") });
    assert.ok(ok.result, JSON.stringify(ok.error));
    assert.equal((await waitTurnCompleted(e, startedTurnId(ok))).status, "completed");
    assert.equal(verifySessionFile(path, t).ok, true, "chain verifies after the reload");
  } finally {
    setSessionFsyncForTests(null);
    await e.close();
    cleanup();
  }
});

test("A3 1b (b): rollback failed → poisoned for the process life; every later answer is -32009 with the C2 entry; nothing writes", async () => {
  const { home, cleanup } = makeHome();
  const e = inProcess(home);
  try {
    const t = await startThread(e);
    const path = sessionPath(home, t);
    await e.request("turn/start", { threadId: t, input: text("first") });
    await e.waitFor((m) => m.method === "turn/completed");
    // The refused batch's fsync AND the rollback fsync both fail.
    setSessionFsyncForTests({
      file: () => {
        throw new Error("EIO (injected)");
      },
    });
    const verified = verifySessionFile(path, t);
    assert.ok(verified.ok);
    if (!verified.ok) return;
    const firstRefusedSeq = verified.nextSeq;
    const sizeBefore = statSync(path).size;
    const shaBefore = sha256(path);
    const expectRefusal = (m: Wire) => {
      const err = m.error as { code: number; data: { path: string; seq: number } };
      assert.equal(err.code, -32009, JSON.stringify(m));
      assert.equal(err.data.seq, firstRefusedSeq, "C2 entry: first seq of the refused batch");
      // C2 carries the engine's confined (realpath) path, not the lexical mkdtemp path (F1).
      assert.equal(err.data.path, realpathSync(path), "C2 entry: the session file");
    };
    expectRefusal(await e.request("turn/start", { threadId: t, input: text("second") }));
    setSessionFsyncForTests(null); // no more injected failures; the poisoned answer needs no I/O
    expectRefusal(await e.request("turn/start", { threadId: t, input: text("third") }));
    expectRefusal(await e.request("thread/resume", { threadId: t }));
    assert.equal(statSync(path).size, sizeBefore, "size unchanged");
    assert.equal(sha256(path), shaBefore, "sha256 unchanged");
    assert.equal(
      e.logs.filter((l) =>
        l.includes(`session ${t}: rollback failed; refused seq ${firstRefusedSeq}..`),
      ).length,
      1,
      "rule 3 stderr line exactly once",
    );
    // The lock is stolen (a foreign engine resumes) and released: still poisoned, never re-taken.
    unlinkSync(lockPath(home, t));
    const b = inProcess(home);
    await b.init();
    assert.ok((await b.request("thread/resume", { threadId: t })).result);
    await b.close();
    expectRefusal(await e.request("thread/resume", { threadId: t }));
    expectRefusal(await e.request("turn/start", { threadId: t, input: text("fourth") }));
    assert.equal(existsSync(lockPath(home, t)), false, "the poisoned engine never re-takes");
    assert.equal(sha256(path), shaBefore, "still nothing written");
    // A new engine process resumes and appends, and the chain verifies (the truncate reached disk).
    const c = inProcess(home);
    await c.init();
    assert.ok((await c.request("thread/resume", { threadId: t })).result);
    const ok = await c.request("turn/start", { threadId: t, input: text("from c") });
    assert.ok(ok.result, JSON.stringify(ok.error));
    assert.equal(
      completedTurn(await c.waitFor((m) => m.method === "turn/completed")).status,
      "completed",
    );
    assert.equal(verifySessionFile(path, t).ok, true, "chain verifies on the new engine");
    await c.close();
  } finally {
    setSessionFsyncForTests(null);
    await e.close();
    cleanup();
  }
});

test("A3 1b (c): lock stolen mid-turn → the turn fails -32009 (writer broken); after the foreign release, turn/start re-takes, reloads and appends", async () => {
  const { home, cleanup } = makeHome();
  const g = gatedAgent();
  const a = inProcess(home, g.agent);
  try {
    const t = await startThread(a);
    const first = await a.request("turn/start", { threadId: t, input: text("from a") });
    const firstTurnId = startedTurnId(first);
    await a.waitFor(agentMessageStarted);
    // A foreign holder steals the lock while A's turn is active.
    unlinkSync(lockPath(home, t));
    const b = inProcess(home);
    await b.init();
    assert.ok((await b.request("thread/resume", { threadId: t })).result);
    await b.request("turn/start", { threadId: t, input: text("from b") });
    assert.equal(
      completedTurn(await b.waitFor((m) => m.method === "turn/completed")).status,
      "completed",
    );
    const path = sessionPath(home, t);
    const afterB = sha256(path);
    // A's next append fails the §2 ownership check: the turn ends failed -32009 (writer broken).
    g.open();
    const done = await waitTurnCompleted(a, firstTurnId);
    assert.equal(done.status, "failed");
    assert.equal(done.error?.code, -32009);
    assert.equal(sha256(path), afterB, "A wrote nothing after losing the lock");
    // The foreign holder releases; A's next turn/start re-takes, reloads and appends (PROBE-D).
    await b.close();
    const ok = await a.request("turn/start", { threadId: t, input: text("a again") });
    assert.ok(ok.result, JSON.stringify(ok.error));
    assert.equal((await waitTurnCompleted(a, startedTurnId(ok))).status, "completed");
    assert.equal(verifySessionFile(path, t).ok, true, "chain verifies after the re-take");
  } finally {
    await a.close();
    cleanup();
  }
});

test("A3 1b (a-f): a row (a) break then a mid-file corruption → thread/resume -32603, lock released, record dropped (-32002), file untouched", async () => {
  const { home, cleanup } = makeHome();
  let failNext = false;
  setSessionFsyncForTests({
    file: () => {
      if (failNext) {
        failNext = false;
        throw new Error("EIO (injected)");
      }
    },
  });
  const e = inProcess(home);
  try {
    const t = await startThread(e);
    await e.request("turn/start", { threadId: t, input: text("hello") });
    await e.waitFor((m) => m.method === "turn/completed");
    const path = sessionPath(home, t);
    failNext = true;
    const refused = await e.request("turn/start", { threadId: t, input: text("again") });
    assert.equal((refused.error as { code: number }).code, -32009);
    setSessionFsyncForTests(null);
    // Corrupt a mid-file line; the reload's verification then fails.
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace('"inputText":"hello"', '"inputText":"HELLO"'),
    );
    const before = sha256(path);
    const r = await e.request("thread/resume", { threadId: t });
    assert.equal((r.error as { code: number }).code, -32603);
    assert.equal(existsSync(lockPath(home, t)), false, "the held lock was released");
    const ts = await e.request("turn/start", { threadId: t, input: text("again") });
    assert.equal((ts.error as { code: number }).code, -32002, "the record was dropped");
    const cold = await e.request("thread/resume", { threadId: t });
    assert.equal((cold.error as { code: number }).code, -32603, "the cold path fails the same");
    assert.equal(sha256(path), before, "file's sha256 unchanged");
  } finally {
    setSessionFsyncForTests(null);
    await e.close();
    cleanup();
  }
});

test("A3 1b (p-r): poisoned inside a reload → -32009 with the close batch's first seq, lock kept until exit, record gone", async () => {
  const { home, cleanup } = makeHome();
  const e = inProcess(home);
  try {
    mkdirSync(join(home, "sessions"), { recursive: true });
    seedDefaultSeat(home);
    const path = sessionPath(home, "thr_pr");
    const w = unguardedSessionWriterForTests.create(
      path,
      "thr_pr",
      "madc-default",
      SAMPLE_OPEN,
      () => [],
    );
    w.append("turn.start", { turnId: "turn_a", inputText: "dangling" });
    const verified = verifySessionFile(path, "thr_pr");
    assert.ok(verified.ok);
    if (!verified.ok) return;
    const closeFirstSeq = verified.nextSeq; // the close batch's first seq (last seq + 1)
    const sizeBefore = statSync(path).size;
    const shaBefore = sha256(path);
    // The close batch's fsync AND the rollback fsync both fail.
    setSessionFsyncForTests({
      file: () => {
        throw new Error("EIO (injected)");
      },
    });
    await e.init();
    const expectRefusal = (m: Wire) => {
      const err = m.error as { code: number; data: { path: string; seq: number } };
      assert.equal(err.code, -32009, JSON.stringify(m));
      assert.equal(err.data.seq, closeFirstSeq, "the close batch's first seq");
      // C2 carries the engine's confined (realpath) path, not the lexical mkdtemp path (F1).
      assert.equal(err.data.path, realpathSync(path), "the session file");
    };
    const r = await e.request("thread/resume", { threadId: "thr_pr" });
    expectRefusal(r);
    assert.equal(
      e.logs.filter((l) =>
        l.includes(`session thr_pr: rollback failed; refused seq ${closeFirstSeq}..`),
      ).length,
      1,
      "rule 3 stderr line exactly once",
    );
    const lp = lockPath(home, "thr_pr");
    assert.equal(existsSync(lp), true, "the reload's lock is kept, not released");
    const lockBytes = readFileSync(lp, "utf8");
    assert.equal((JSON.parse(lockBytes) as { pid: number }).pid, process.pid, "this engine's pid");
    const second = await e.request("thread/resume", { threadId: "thr_pr" });
    expectRefusal(second);
    assert.equal(readFileSync(lp, "utf8"), lockBytes, "the lock file is untouched");
    const ts = await e.request("turn/start", { threadId: "thr_pr", input: text("x") });
    assert.equal(
      (ts.error as { code: number }).code,
      -32002,
      "no record: -32002 before the poisoned check",
    );
    assert.equal(statSync(path).size, sizeBefore, "session size unchanged");
    assert.equal(sha256(path), shaBefore, "session sha256 unchanged");
    setSessionFsyncForTests(null);
    await e.close();
    assert.equal(existsSync(lp), false, "the kept lock is released when the engine exits");
  } finally {
    setSessionFsyncForTests(null);
    await e.close();
    cleanup();
  }
});

test("A3 1b-p: preflight still refuses before any append, on an ordinary turn/start and after a re-take", async () => {
  const { home, cleanup } = makeHome();
  let preflights = 0;
  const agent: Agent = {
    name: "refusing",
    preflight() {
      preflights++;
      throw new RpcError(-32008, "no-credentials (test)");
    },
    async run() {},
  };
  const e = inProcess(home, agent);
  try {
    const t = await startThread(e);
    const path = sessionPath(home, t);
    const before = sha256(path);
    const refused = await e.request("turn/start", { threadId: t, input: text("x") });
    assert.equal((refused.error as { code: number }).code, -32008, "the preflight error answers");
    assert.equal(sha256(path), before, "nothing appended");
    assert.equal(preflights, 1, "preflight ran exactly once");
    // Steal and release the lock; the next turn/start re-takes and reloads, then preflight
    // refuses again — against the reloaded record — still appending nothing.
    unlinkSync(lockPath(home, t));
    const b = inProcess(home);
    await b.init();
    assert.ok((await b.request("thread/resume", { threadId: t })).result);
    await b.close();
    const refused2 = await e.request("turn/start", { threadId: t, input: text("y") });
    assert.equal((refused2.error as { code: number }).code, -32008);
    assert.equal(preflights, 2, "preflight ran again, once, after the re-take");
    assert.equal(sha256(path), before, "still nothing appended");
    const lock = readFileSync(lockPath(home, t), "utf8");
    assert.equal(
      (JSON.parse(lock) as { pid: number }).pid,
      process.pid,
      "the re-taken lock stays held by this process after the refusal",
    );
  } finally {
    await e.close();
    cleanup();
  }
});

test("A3 1e: a close that fails after a durable batch is logged once and changes nothing: the append succeeds, the writer is not broken", async () => {
  const { home, cleanup } = makeHome();
  let failNext = false;
  setSessionCloseForTests((fd) => {
    if (failNext) {
      failNext = false;
      throw Object.assign(new Error("EIO on close (injected)"), { code: "EIO" });
    }
    closeSync(fd);
  });
  const e = inProcess(home);
  try {
    const t = await startThread(e);
    const path = sessionPath(home, t);
    failNext = true;
    const ok = await e.request("turn/start", { threadId: t, input: text("close me") });
    assert.ok(ok.result, `the request succeeds: ${JSON.stringify(ok.error)}`);
    assert.equal(
      (await waitTurnCompleted(e, startedTurnId(ok))).status,
      "completed",
      "the turn completes: the durable batch counted",
    );
    assert.equal(
      e.logs.filter((l) => l.includes(`session ${t}: close failed after a durable append (EIO)`))
        .length,
      1,
      "rule 4 stderr line exactly once",
    );
    const again = await e.request("turn/start", { threadId: t, input: text("and again") });
    assert.ok(again.result, JSON.stringify(again.error));
    assert.equal(
      (await waitTurnCompleted(e, startedTurnId(again))).status,
      "completed",
      "the writer is not broken: the next turn appends",
    );
    assert.equal(verifySessionFile(path, t).ok, true, "chain verifies");
  } finally {
    setSessionCloseForTests(null);
    await e.close();
    cleanup();
  }
});

test("A3 1b-t: residual R-1 is real — a failed rollback truncate leaves the refused lines on disk, and a new engine resumes past them", async () => {
  const { home, cleanup } = makeHome();
  const e = inProcess(home);
  try {
    mkdirSync(join(home, "sessions"), { recursive: true });
    seedDefaultSeat(home);
    const path = sessionPath(home, "thr_rt");
    const w = unguardedSessionWriterForTests.create(
      path,
      "thr_rt",
      "madc-default",
      SAMPLE_OPEN,
      () => [],
    );
    w.append("turn.start", { turnId: "turn_a", inputText: "dangling a" });
    w.append("turn.start", { turnId: "turn_b", inputText: "dangling b" });
    const verified = verifySessionFile(path, "thr_rt");
    assert.ok(verified.ok);
    if (!verified.ok) return;
    const closeFirstSeq = verified.nextSeq; // 3: the two-event close batch is seqs 3..4
    // The close batch's fsync fails AND the rollback truncate fails: the refused lines persist.
    setSessionFsyncForTests({
      file: () => {
        throw new Error("EIO (injected)");
      },
    });
    setSessionTruncateForTests(() => {
      throw new Error("EIO on truncate (injected)");
    });
    await e.init();
    const r = await e.request("thread/resume", { threadId: "thr_rt" });
    assert.equal((r.error as { code: number }).code, -32009);
    assert.equal(
      e.logs.filter((l) =>
        l.includes(
          `session thr_rt: rollback failed; refused seq ${closeFirstSeq}..${closeFirstSeq + 1}`,
        ),
      ).length,
      1,
      "the engine is poisoned and logs the refused seq range",
    );
    setSessionFsyncForTests(null);
    setSessionTruncateForTests(null);
    await e.close(); // releases the kept lock at shutdown
    // Residual R-1: a new engine process resumes with nextSeq PAST the refused lines — they
    // verify (complete, newline-terminated, correctly chained), so they count as history.
    const after = verifySessionFile(path, "thr_rt");
    assert.ok(after.ok, "the persisted refused lines verify");
    if (!after.ok) return;
    assert.equal(after.nextSeq, closeFirstSeq + 2, "nextSeq is past the refused lines");
    const c = inProcess(home);
    await c.init();
    const resumed = await c.request("thread/resume", { threadId: "thr_rt" });
    assert.ok(resumed.result, JSON.stringify(resumed.error));
    await c.close();
  } finally {
    setSessionFsyncForTests(null);
    setSessionTruncateForTests(null);
    await e.close();
    cleanup();
  }
});

// ------------------------------------------------------------------ item 2 (2a, 2b)

test("A3 2a: every crash-residue shape classifies as torn-tail; thread/resume stays -32603; the file's sha256 is unchanged", async () => {
  const { home, cleanup } = makeHome();
  const e = inProcess(home);
  try {
    await e.init();
    const path = writeSampleSession(join(home, "sessions"), "thr_torn");
    const good = readFileSync(path, "utf8");
    const cases: Array<[string, string]> = [
      ["0-byte file", ""],
      ["valid lines + NULs (no newline)", `${good}${"\0".repeat(3)}`],
      ["valid lines + NULs + newline", `${good}${"\0".repeat(3)}\n`],
      ["valid lines + whitespace-only tail", `${good} \t \n`],
      ["valid lines + several NUL-only lines", `${good}\0\n\0\n\0\n`],
      ["valid lines + one trailing blank line", `${good}\n`],
      ["a file that is only NULs", "\0\0\0\0\0"],
    ];
    for (const [name, content] of cases) {
      const r = verifySessionText(content, "thr_torn");
      assert.equal(r.ok, false, name);
      if (r.ok) continue;
      assert.equal(r.kind, "torn-tail", `${name}: ${r.reason}`);
      writeFileSync(path, content);
      const f = verifySessionFile(path, "thr_torn", {}, home);
      assert.equal(f.ok ? null : f.kind, "torn-tail", `${name} (file)`);
      const before = sha256(path);
      const res = await e.request("thread/resume", { threadId: "thr_torn" });
      assert.equal((res.error as { code: number }).code, -32603, `${name}: fail closed`);
      assert.equal(sha256(path), before, `${name}: file never modified`);
      assert.equal(
        existsSync(lockPath(home, "thr_torn")),
        false,
        `${name}: the failed reload released the lock`,
      );
    }
    assert.equal(verifySessionText(good, "thr_torn").ok, true, "the untouched original verifies");
  } finally {
    await e.close();
    cleanup();
  }
});

test("A3 2b: tampering shapes stay integrity (mid-file edit, garbage line, wrong hash, NUL line + valid line, NUL run + non-NUL fragment)", () => {
  const { home, cleanup } = makeHome();
  try {
    const path = writeSampleSession(join(home, "sessions"), "thr_torn");
    const good = readFileSync(path, "utf8");
    const lines = good.trimEnd().split("\n");
    const lastLine = lines.at(-1) ?? "";
    const wrongHash = lastLine.replace(/"hash":"[0-9a-f]/, (m) =>
      m.endsWith("0") ? `${m.slice(0, -1)}1` : `${m.slice(0, -1)}0`,
    );
    const cases: Array<[string, string]> = [
      ["mid-file edit", good.replace('"inputText":"hi"', '"inputText":"HI"')],
      ["complete non-JSON line at the end", `${good}garbage\n`],
      [
        "complete well-formed line, wrong hash",
        `${[...lines.slice(0, -1), wrongHash].join("\n")}\n`,
      ],
      ["NUL-only line followed by a valid-looking complete line", `${good}\0\0\0\n${lastLine}\n`],
      ["NUL run + newline-terminated non-NUL fragment", `${good}\0\0\0{"v":1,"se\n`],
    ];
    for (const [name, content] of cases) {
      const r = verifySessionText(content, "thr_torn");
      assert.equal(r.ok, false, name);
      if (r.ok) continue;
      assert.equal(r.kind, "integrity", `${name}: ${r.reason}`);
    }
    assert.equal(verifySessionText(good, "thr_torn").ok, true, "the untouched original verifies");
  } finally {
    cleanup();
  }
});

// ------------------------------------------------------------------ item 3 (3a-3d)

test("A3 3a (PROBE-G, kills 17-E): a resumed writer that lost its lock answers -32009 on the next append and writes nothing", () => {
  const { home, cleanup } = makeHome();
  try {
    const path = writeSampleSession(join(home, "sessions"));
    let held = true;
    const w = SessionWriter.resume(
      path,
      "thr_sample",
      "madc-default",
      3,
      readLastHash(path),
      () => [],
      undefined,
      undefined,
      { holdsLock: () => held, expectedSize: statSync(path).size },
    );
    held = false; // the lock is lost, with no foreign append yet
    const before = readFileSync(path);
    assert.throws(
      () => w.append("turn.start", { turnId: "turn_2", inputText: "x" }),
      (err: RpcError) => err.code === -32009 && (err.data as { seq: number }).seq === 3,
    );
    assert.deepEqual(readFileSync(path), before, "nothing written");
    assert.equal(w.broken, true);
  } finally {
    cleanup();
  }
});

test("A3 3b (kills 17-D): an external append between verification and resume fails the resumed writer's first append with -32009, nothing written", () => {
  const { home, cleanup } = makeHome();
  try {
    const path = writeSampleSession(join(home, "sessions"));
    const verified = verifySessionFile(path, "thr_sample", {}, home);
    assert.ok(verified.ok);
    if (!verified.ok) return;
    if (verified.size === undefined) throw new Error("verifier reports the byte size");
    writeFileSync(path, `${readFileSync(path, "utf8")}{"external":true}\n`); // the seam append
    const before = readFileSync(path);
    const w = SessionWriter.resume(
      path,
      "thr_sample",
      "madc-default",
      verified.nextSeq,
      verified.lastHash,
      () => [],
      home,
      verified.file,
      { holdsLock: () => true, expectedSize: verified.size as number },
    );
    assert.throws(
      () => w.append("turn.start", { turnId: "turn_2", inputText: "x" }),
      (err: RpcError) => err.code === -32009 && (err.data as { seq: number }).seq === 3,
    );
    assert.deepEqual(readFileSync(path), before, "nothing written");
  } finally {
    cleanup();
  }
});

test("A3 3c: create / resume without the guards fail at the type level (tsc) and at run time", () => {
  const { home, cleanup } = makeHome();
  try {
    const path = join(home, "sessions", "thr_guard.jsonl");
    mkdirSync(join(home, "sessions"), { recursive: true });
    assert.throws(() => {
      // @ts-expect-error Amendment 3 item 3: `guards` is a required parameter
      SessionWriter.create(path, "thr_guard", "madc-default", SAMPLE_OPEN, () => [], 1000, home);
    }, TypeError);
    assert.throws(() => {
      SessionWriter.create(path, "thr_guard", "madc-default", SAMPLE_OPEN, () => [], 1000, home, {
        // @ts-expect-error Amendment 3 item 3: holdsLock must be a function
        holdsLock: undefined,
      });
    }, TypeError);
    assert.throws(() => {
      // @ts-expect-error Amendment 3 item 3: `guards` is a required parameter
      SessionWriter.resume(path, "thr_guard", "madc-default", 1, GENESIS_HASH, () => [], home);
    }, TypeError);
    assert.throws(() => {
      SessionWriter.resume(
        path,
        "thr_guard",
        "madc-default",
        1,
        GENESIS_HASH,
        () => [],
        home,
        undefined,
        // @ts-expect-error Amendment 3 item 3: resume requires the verified expectedSize
        { holdsLock: () => true },
      );
    }, TypeError);
    assert.equal(existsSync(path), false, "no file created by the refused calls");
  } finally {
    cleanup();
  }
});

test("A3 3d: no unguarded writer factory is reachable from the package entry or @madc/engine/client", async () => {
  const engineIndex = (await import("./index.ts")) as Record<string, unknown>;
  const engineClient = (await import("./sdk.ts")) as Record<string, unknown>;
  for (const [name, ns] of [
    ["index.ts", engineIndex],
    ["sdk.ts (@madc/engine/client)", engineClient],
  ] as const) {
    assert.equal(
      Object.keys(ns).some((k) => /unguard/i.test(k)),
      false,
      `${name} exposes no unguarded factory`,
    );
  }
  assert.equal(
    Object.getOwnPropertyNames(SessionWriter).some((k) => /unguard/i.test(k)),
    false,
    "no unguarded factory is a static member of SessionWriter",
  );
});

// ------------------------------------------------------------------ item 4 (4a-4f)

test("A3 4a: a pre-existing regular seat file → created:false, bytes and mtime unchanged", () => {
  const { home, cleanup } = makeHome();
  try {
    const first = seedDefaultSeat(home);
    assert.equal(first.created, true);
    const bytes = readFileSync(first.path);
    const mtime = statSync(first.path).mtimeMs;
    const second = seedDefaultSeat(home);
    assert.deepEqual(second, { path: first.path, created: false });
    assert.deepEqual(readFileSync(first.path), bytes, "never overwritten");
    assert.equal(statSync(first.path).mtimeMs, mtime, "never touched");
  } finally {
    cleanup();
  }
});

test("A3 4b: a symlink, directory, FIFO, or hard-linked file at the seat path → an error, never created:false", () => {
  if (!POSIX) {
    console.log("SKIP A3 4b: symlinks and FIFOs are POSIX-only here");
    return;
  }
  const { home, cleanup } = makeHome();
  const seats = join(home, "seats");
  const path = join(seats, "madc-default.json");
  const outside = join(home, "..", "outside-seat-target");
  const reset = () => {
    rmSync(seats, { recursive: true, force: true });
    rmSync(outside, { force: true });
    mkdirSync(seats, { recursive: true, mode: 0o700 });
    writeFileSync(outside, "operator seat\n");
  };
  try {
    // A symlink at the path.
    reset();
    symlinkSync(outside, path);
    assert.throws(() => seedDefaultSeat(home), /symlink/);
    // A directory at the path.
    reset();
    mkdirSync(path);
    assert.throws(() => seedDefaultSeat(home), /not a regular file/);
    // A FIFO at the path (the proof must not hang).
    reset();
    spawnSyncChecked("mkfifo", [path]);
    assert.throws(() => seedDefaultSeat(home), /not a regular file/);
    // A regular file with a second hard link (nlink 2).
    reset();
    writeFileSync(path, serializeSeat(MADC_DEFAULT_SEAT));
    linkSync(path, join(seats, "second-name.json"));
    assert.throws(() => seedDefaultSeat(home), /nlink/);
  } finally {
    cleanup();
  }
});

/** Synchronous spawn that must exit 0 (fixture setup only). */
function spawnSyncChecked(cmd: string, args: string[]): void {
  const r = spawnSync(cmd, args, { stdio: "ignore" });
  if (r.error !== undefined) throw r.error;
  assert.equal(r.status, 0, `${cmd} ${args.join(" ")}`);
}

test("A3 4c (r4107279162 / D-182): an EEXIST link answer while the path is absent from the pinned seats/ → an error, never created:false", () => {
  const { home, cleanup } = makeHome();
  setSeedHooksForTests({
    link: () => {
      throw Object.assign(new Error("EEXIST: file already exists, link"), { code: "EEXIST" });
    },
  });
  try {
    const seats = join(home, "seats");
    assert.throws(() => seedDefaultSeat(home));
    assert.equal(existsSync(join(seats, "madc-default.json")), false, "no seat file appeared");
    assert.deepEqual(
      readdirSync(seats).filter((n) => n.endsWith(".tmp")),
      [],
      "the seed's own temp name is removed",
    );
  } finally {
    setSeedHooksForTests(null);
    cleanup();
  }
});

test("A3 4d (r4107279105 / D-181): a second hard link to the temp inode added before the check → an error, no seed byte in that inode, temp name removed", () => {
  if (!POSIX) {
    console.log("SKIP A3 4d: hard links are POSIX-only here");
    return;
  }
  const { home, cleanup } = makeHome();
  let evil = "";
  setSeedHooksForTests({
    afterOpen: (p) => {
      evil = `${p}.evil`;
      linkSync(p, evil); // the inode now has two names before any byte is written
    },
  });
  try {
    const seats = join(home, "seats");
    assert.throws(() => seedDefaultSeat(home), /changed while the seed was being written/);
    assert.equal(statSync(evil).size, 0, "no seed byte written into the shared inode");
    const names = readdirSync(seats);
    assert.deepEqual(
      names.filter((n) => n.endsWith(".tmp")),
      [],
      "the seed's own temp name is removed",
    );
    assert.equal(
      names.filter((n) => n.endsWith(".tmp.evil")).length,
      1,
      "the attacker's name is left alone",
    );
  } finally {
    setSeedHooksForTests(null);
    cleanup();
  }
});

test("A3 4e: two seeders race one fresh home — exactly one created:true; the seat is the default bytes with nlink 1; an engine over the result serves thread/start", async () => {
  if (!POSIX) {
    console.log("SKIP A3 4e: the race barrier uses POSIX process spawn semantics");
    return;
  }
  const { home, cleanup } = makeHome();
  const root = dirname(home);
  const barrier = join(root, "barrier");
  const results = join(root, "results");
  mkdirSync(barrier, { recursive: true });
  mkdirSync(results, { recursive: true });
  const runtimeArgs =
    process.versions.bun !== undefined ? [] : ["--disable-warning=ExperimentalWarning"];
  const spawnOne = () => {
    const child = spawn(process.execPath, [...runtimeArgs, SEED_PROBE, results, home, barrier], {
      stdio: ["ignore", "ignore", "inherit"],
    });
    return new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve(code));
    });
  };
  try {
    const runs = [spawnOne(), spawnOne()];
    // Release both once each has reached beforeLink.
    const deadline = Date.now() + 15_000;
    while (readdirSync(barrier).filter((n) => n.startsWith("ready-")).length < 2) {
      if (Date.now() > deadline) throw new Error("seed race: seeders never reached the barrier");
      await new Promise((r) => setTimeout(r, 10));
    }
    writeFileSync(join(barrier, "release"), "");
    const codes = await Promise.all(runs);
    assert.deepEqual(codes, [0, 0], "both seeders exited cleanly");
    const outcomes = readdirSync(results)
      .filter((n) => n.startsWith("result-"))
      .map((n) => JSON.parse(readFileSync(join(results, n), "utf8")) as { created?: boolean });
    assert.equal(outcomes.length, 2, "both seeders reported");
    assert.equal(
      outcomes.filter((o) => o.created === true).length,
      1,
      `exactly one created:true (${JSON.stringify(outcomes)})`,
    );
    // The loser answers created:false or an error (rule 5's benign, logged seed failure).
    const seat = join(home, "seats", "madc-default.json");
    assert.equal(readFileSync(seat, "utf8"), serializeSeat(MADC_DEFAULT_SEAT), "default bytes");
    assert.equal(statSync(seat).nlink, 1, "nlink 1");
    assert.deepEqual(readdirSync(join(home, "seats")), ["madc-default.json"], "no temp left");
    // An engine started over the result logs at most `seed failed` and serves thread/start.
    const e = inProcess(home);
    try {
      await e.init();
      const started = await e.request("thread/start", {});
      assert.ok(started.result, JSON.stringify(started.error));
      for (const line of e.logs) {
        assert.ok(line.startsWith("seed failed"), `only a seed failure may be logged: ${line}`);
      }
    } finally {
      await e.close();
    }
  } finally {
    cleanup();
  }
});

test("A3 4f: a post-link path swap inside the pinned seats/ is caught by the dev/inode comparison → an error, never created:true; the substituted file is untouched", () => {
  if (!POSIX) {
    console.log("SKIP A3 4f: rename semantics are POSIX-only here");
    return;
  }
  const { home, cleanup } = makeHome();
  const seats = join(home, "seats");
  const path = join(seats, "madc-default.json");
  const sibling = join(seats, "renamed-by-swap.json");
  setSeedHooksForTests({
    afterLink: (_tmp, p) => {
      renameSync(p, sibling); // the seed inode keeps two names (temp + sibling)
      writeFileSync(p, "substituted\n"); // a different regular file now names the path
    },
  });
  try {
    assert.throws(() => seedDefaultSeat(home), /changed while the seed was being linked/);
    assert.equal(readFileSync(path, "utf8"), "substituted\n", "the substituted file is unchanged");
    assert.deepEqual(
      readdirSync(seats).filter((n) => n.endsWith(".tmp")),
      [],
      "the seed's own temp name is removed",
    );
  } finally {
    setSeedHooksForTests(null);
    cleanup();
  }
});

test("A3 4h (F2): a seat file that vanishes between the first lstat and the opened-fd proof is an error — never 'create', never created:false", () => {
  const { home, cleanup } = makeHome();
  setSeedHooksForTests({
    afterProofOpen: (p) => {
      rmSync(p); // vanished after the existence probe, mid-proof (rule 3: an error)
    },
  });
  try {
    assert.equal(seedDefaultSeat(home).created, true, "first seed lands");
    assert.throws(() => seedDefaultSeat(home), /ENOENT|vanished/);
  } finally {
    setSeedHooksForTests(null);
    cleanup();
  }
});

test("A3 4i (F3): on a no-hard-links filesystem, an EEXIST from the in-place create stays created:false after the proof", () => {
  if (!POSIX) {
    console.log("SKIP A3 4i: hard-link semantics are POSIX-only here");
    return;
  }
  const { home, cleanup } = makeHome();
  const seats = join(home, "seats");
  const path = join(seats, "madc-default.json");
  setSeedHooksForTests({
    afterPinCheck: (step, p) => {
      // A concurrent seeder lands between the first probe's ENOENT and the fallback create.
      if (step === "link") writeFileSync(p, serializeSeat(MADC_DEFAULT_SEAT));
    },
    link: () => {
      throw Object.assign(new Error("ENOTSUP: operation not supported"), { code: "ENOTSUP" });
    },
  });
  try {
    const result = seedDefaultSeat(home);
    assert.deepEqual(
      result,
      { path, created: false },
      "the winning seeder's file is proven, not re-created",
    );
    assert.equal(readFileSync(path, "utf8"), serializeSeat(MADC_DEFAULT_SEAT), "bytes untouched");
    assert.deepEqual(
      readdirSync(seats).filter((n) => n.endsWith(".tmp")),
      [],
      "the loser's temp name is removed",
    );
  } finally {
    setSeedHooksForTests(null);
    cleanup();
  }
});

// ------------------------------------------------------------------ item 5 (5a)

test("A3 5a: sessions/ chmod 0300 → thread/start -32009 naming the mode, before any file or lock is created", async () => {
  if (!POSIX) {
    console.log("SKIP A3 5a: POSIX mode bits only (Windows is a best-effort no-op)");
    return;
  }
  const { home, cleanup } = makeHome();
  const sessions = join(home, "sessions");
  const e = inProcess(home);
  try {
    mkdirSync(sessions, { recursive: true });
    chmodSync(sessions, 0o300);
    await e.init();
    const r = await e.request("thread/start", {});
    const err = r.error as { code: number; message: string; data: { seq: number } };
    assert.equal(err.code, -32009, JSON.stringify(r));
    assert.match(
      err.message,
      /sessions\/ is not readable by its owner \(mode 0300 is unsupported in M0; use 0700\)/,
    );
    assert.equal(err.data.seq, 0);
    chmodSync(sessions, 0o700); // so the dir can be listed for the assertion
    assert.deepEqual(readdirSync(sessions), [], "sessions/ gained no file and no lock");
  } finally {
    try {
      chmodSync(sessions, 0o700);
    } catch {
      // not created
    }
    await e.close();
    cleanup();
  }
});
