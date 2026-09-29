import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import { createAcpAdapter, NotImplementedError } from "./acp/index.ts";
import { type Agent, echoAgent } from "./agent.ts";
import { confinedPath, resolveMadcHome } from "./home.ts";
import {
  acquireThreadLock,
  holdsThreadLock,
  isPidAlive,
  LOCK_TOKEN_PATTERN,
  LockPathNotAFileError,
  openNoFollow,
  readLock,
  reclaimIfUnchanged,
  releaseThreadLock,
  threadLockPath,
} from "./lock.ts";
import { handleTerminationSignal } from "./main.ts";
import { ErrorCode, providerRefusalError, RpcError } from "./protocol/errors.ts";
import { ID_PATTERN, isValidId, newId } from "./protocol/ids.ts";
import { CLIENT_REQUEST_METHODS, ITEM_KINDS, type Item } from "./protocol/types.ts";
import { encodeMessage, parseLine } from "./protocol/wire.ts";
import { EngineConnection } from "./server.ts";
import { makeHome } from "./testing/harness.ts";

test("§4.1 error-code constants match the pin table exactly", () => {
  assert.deepEqual(
    { ...ErrorCode },
    {
      ParseError: -32700,
      InvalidRequest: -32600,
      MethodNotFound: -32601,
      InvalidParams: -32602,
      InternalError: -32603,
      NotInitialized: -32000,
      AlreadyInitialized: -32001,
      ThreadNotFound: -32002,
      TurnNotFound: -32003,
      TurnAlreadyActive: -32004,
      SeatNotFound: -32005,
      SeatInvalid: -32006,
      ProviderDenied: -32007,
      ProviderUnavailable: -32008,
      SessionWriteFailed: -32009,
    },
  );
  assert.ok(Object.isFrozen(ErrorCode));
});

test("§5 six item kinds; M1 pin §3 complete request list (M0 six + §3.5 seat/list and auth presence)", () => {
  assert.deepEqual(
    [...ITEM_KINDS],
    ["userMessage", "agentMessage", "toolCall", "toolResult", "error", "servedModel"],
  );
  // M1-A2 (protocol pin §3/§3.5) added the two presence methods; M1-A7 adds `seat/list`. The M0
  // methods are unchanged, and there is still no `auth/set` over JSONL (P4).
  assert.deepEqual(
    [...CLIENT_REQUEST_METHODS],
    [
      "initialize",
      "thread/start",
      "thread/resume",
      "thread/list",
      "turn/start",
      "turn/interrupt",
      "seat/list",
      "auth/status",
      "auth/remove",
    ],
  );
});

test("registry refusal mapping: unwired → -32008, every other reason → -32007", () => {
  const unwired = providerRefusalError({
    providerId: "ollama-cloud",
    reason: "unwired",
    status: "allowed-direct",
  });
  assert.equal(unwired.code, ErrorCode.ProviderUnavailable);
  assert.deepEqual(unwired.data, { providerId: "ollama-cloud", reason: "unwired" });

  for (const reason of ["forbidden", "interactive-only-headless", "connect-mismatch"]) {
    const e = providerRefusalError({ providerId: "p", reason, status: "forbidden" });
    assert.equal(e.code, ErrorCode.ProviderDenied, reason);
    assert.deepEqual(e.data, { providerId: "p", status: "forbidden", reason });
  }
  const unknown = providerRefusalError({
    providerId: "zz",
    reason: "unknown-provider",
    status: "x",
  });
  assert.equal(unknown.code, -32007);
  assert.deepEqual(unknown.data, { providerId: "zz", status: null, reason: "unknown-provider" });
});

test("id grammar (honesty: rejects traversal / separators / dots / whitespace / length)", () => {
  assert.equal(ID_PATTERN.source, "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$");
  for (const ok of ["a", "thr_01", "madc-default", "A".repeat(128), "0-_"]) {
    assert.equal(isValidId(ok), true, ok);
  }
  for (const bad of [
    "",
    "../x",
    "..",
    ".",
    "a/b",
    "a\\b",
    "a.b",
    "_a",
    "-a",
    " a",
    "a b",
    "a\n",
    "a\u0000",
    "a".repeat(129),
    5,
    null,
  ]) {
    assert.equal(isValidId(bad), false, JSON.stringify(bad));
  }
  for (const prefix of ["thr", "turn", "item"] as const) {
    const id = newId(prefix);
    assert.ok(id.startsWith(`${prefix}_`));
    assert.equal(isValidId(id), true);
  }
});

test("wire: parseLine classifies; encodeMessage omits jsonrpc and is one line", () => {
  assert.equal(parseLine("   "), null);
  const bad = parseLine("{");
  assert.equal(bad?.kind, "invalid");
  assert.equal(bad?.kind === "invalid" && bad.error.code, -32700);
  assert.deepEqual(parseLine('{"id":1,"method":"m","params":{"a":1}}'), {
    kind: "request",
    id: 1,
    method: "m",
    params: { a: 1 },
  });
  assert.deepEqual(parseLine('{"jsonrpc":"2.0","method":"initialized","params":{}}'), {
    kind: "notification",
    method: "initialized",
    params: {},
  });
  const nullId = parseLine('{"id":null,"method":"m"}');
  assert.equal(nullId?.kind === "invalid" && nullId.error.code, -32600);
  const line = encodeMessage({ id: 1, result: { text: "a\nb" } });
  assert.equal(line.endsWith("\n"), true);
  assert.equal(line.slice(0, -1).includes("\n"), false);
  assert.equal(line.includes("jsonrpc"), false);
});

test("MADC_HOME: optional override, must be absolute; default ~/.madc", () => {
  assert.equal(resolveMadcHome({ MADC_HOME: "/abs/madc" }), "/abs/madc");
  assert.throws(() => resolveMadcHome({ MADC_HOME: "relative/dir" }), /absolute/);
  assert.ok(resolveMadcHome({}).endsWith(".madc"));
});

test("confinedPath: id checked BEFORE any path join/mkdir (honesty guard)", () => {
  const { home, cleanup } = makeHome();
  try {
    assert.throws(
      () => confinedPath(home, "sessions", "../x", ".lock"),
      (e: unknown) => e instanceof RpcError && e.code === ErrorCode.InvalidParams,
    );
    assert.equal(existsSync(home), false, "rejected before touching the filesystem");
    const p = confinedPath(home, "sessions", "thr_ok", ".lock");
    assert.ok(p.endsWith(join("sessions", "thr_ok.lock")));
  } finally {
    cleanup();
  }
});

const isInternal = (e: unknown) => e instanceof RpcError && e.code === ErrorCode.InternalError;

test("confinedPath: symlinked subdir escaping MADC_HOME is rejected", () => {
  const { home, cleanup } = makeHome();
  try {
    mkdirSync(home, { recursive: true });
    const outside = join(home, "..", "outside");
    mkdirSync(outside);
    try {
      symlinkSync(outside, join(home, "sessions"), "dir");
    } catch {
      return; // symlinks unavailable (e.g. unprivileged Windows) — nothing to assert
    }
    chmodSync(outside, 0o755);
    assert.throws(() => confinedPath(home, "sessions", "thr_ok", ".lock"), isInternal);
    if (process.platform !== "win32") {
      // Honesty: a rejected path never gets permissions changed outside MADC_HOME.
      assert.equal(statSync(outside).mode & 0o777, 0o755);
    }
  } finally {
    cleanup();
  }
});

test("confinedPath: symlinked component rejected BEFORE any mkdir (dangling / inside targets)", () => {
  const { home, cleanup } = makeHome();
  try {
    mkdirSync(home, { recursive: true });
    const missingOutside = join(home, "..", "not-yet");
    try {
      symlinkSync(missingOutside, join(home, "sessions"), "dir");
    } catch {
      return; // symlinks unavailable — nothing to assert
    }
    assert.throws(() => confinedPath(home, "sessions", "thr_ok", ".lock"), isInternal);
    assert.equal(existsSync(missingOutside), false, "nothing created outside MADC_HOME");

    // Even a symlink that points back inside MADC_HOME is refused: components must be real dirs.
    unlinkSync(join(home, "sessions"));
    mkdirSync(join(home, "real"));
    symlinkSync(join(home, "real"), join(home, "sessions"), "dir");
    assert.throws(() => confinedPath(home, "sessions", "thr_ok", ".lock"), isInternal);
    assert.deepEqual(readdirSync(join(home, "real")), []);
  } finally {
    cleanup();
  }
});

test("confinedPath tightens pre-existing MADC_HOME / subdir to 0700 (POSIX)", () => {
  if (process.platform === "win32") return; // POSIX mode bits only
  const { home, cleanup } = makeHome();
  try {
    mkdirSync(join(home, "sessions"), { recursive: true });
    chmodSync(home, 0o755);
    chmodSync(join(home, "sessions"), 0o777);
    confinedPath(home, "sessions", "thr_p", ".lock");
    assert.equal(statSync(home).mode & 0o777, 0o700);
    assert.equal(statSync(join(home, "sessions")).mode & 0o777, 0o700);
  } finally {
    cleanup();
  }
});

/** A pid that is certainly dead: spawn a child and wait for it to exit. */
async function deadPid(): Promise<number> {
  const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = dead.pid ?? 0;
  await new Promise((r) => dead.once("exit", r));
  assert.equal(isPidAlive(pid), false);
  return pid;
}

function liveHolder() {
  return spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
}

const TOKEN_A = "a".repeat(32);
const TOKEN_B = "b".repeat(32);

test("lock: body is exactly {pid,startedAt,token}; token 32 hex, fresh per acquisition", () => {
  const { home, cleanup } = makeHome();
  try {
    const tokens = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const res = acquireThreadLock(home, "thr_tok");
      assert.equal(res.ok, true);
      if (!res.ok) return;
      const body = JSON.parse(readFileSync(res.path, "utf8"));
      assert.deepEqual(Object.keys(body).sort(), ["pid", "startedAt", "token"]);
      assert.equal(body.pid, process.pid);
      assert.equal(typeof body.startedAt, "number");
      assert.match(body.token, LOCK_TOKEN_PATTERN);
      assert.equal(body.token, res.handle.token);
      tokens.add(body.token);
      assert.equal(releaseThreadLock(res.handle), true);
    }
    assert.equal(tokens.size, 3, "never reused");
    assert.equal(LOCK_TOKEN_PATTERN.source, "^[0-9a-f]{32}$");
  } finally {
    cleanup();
  }
});

test("lock: live foreign holder refused with its pid; release only with our token", async () => {
  const { home, cleanup } = makeHome();
  const holder = liveHolder();
  try {
    const holderPid = holder.pid ?? 0;
    const mine = acquireThreadLock(home, "thr_a", holderPid);
    assert.equal(mine.ok, true);
    if (!mine.ok) return;
    const other = acquireThreadLock(home, "thr_a");
    assert.deepEqual(other, { ok: false, path: mine.path, holderPid });
    assert.equal(holdsThreadLock(mine.handle), true);
    // Same pid + startedAt, wrong token → not ours: nothing removed.
    assert.equal(releaseThreadLock({ ...mine.handle, token: TOKEN_A }), false);
    assert.equal(holdsThreadLock(mine.handle), true);
    assert.equal(releaseThreadLock(mine.handle), true);
    assert.equal(readLock(mine.path).state, "missing");
  } finally {
    holder.kill();
    cleanup();
  }
});

test("§8.9 same pid + same startedAt, different token: stale release keeps the new lock", () => {
  const { home, cleanup } = makeHome();
  try {
    const first = acquireThreadLock(home, "thr_c");
    assert.equal(first.ok, true);
    if (!first.ok) return;
    // Our lock is replaced by a re-acquisition with the SAME pid and SAME startedAt (same ms) and
    // a different token. The freed inode is typically reused, so only the token tells them apart.
    const replacement = { pid: process.pid, startedAt: first.handle.startedAt, token: TOKEN_B };
    unlinkSync(first.path);
    writeFileSync(first.path, JSON.stringify(replacement));
    assert.equal(holdsThreadLock(first.handle), false);
    assert.equal(releaseThreadLock(first.handle), false, "stale handle must not release");
    assert.deepEqual(JSON.parse(readFileSync(first.path, "utf8")), replacement);
    // Nor can it be stolen: a live pid (even our own) under another token is locked (-32004).
    const again = acquireThreadLock(home, "thr_c");
    assert.deepEqual(again, { ok: false, path: first.path, holderPid: process.pid });
    assert.deepEqual(JSON.parse(readFileSync(first.path, "utf8")), replacement);
    assert.deepEqual(readdirSync(join(home, "sessions")), ["thr_c.lock"], "no stray files");
  } finally {
    cleanup();
  }
});

test("§8.9 reclaim never deletes a lock whose token changed (same pid + startedAt)", async () => {
  const { home, cleanup } = makeHome();
  try {
    const pid = await deadPid();
    const path = threadLockPath(home, "thr_d");
    const observedBody = { pid, startedAt: 7, token: TOKEN_A };
    writeFileSync(path, JSON.stringify(observedBody));
    const observed = readLock(path);
    assert.equal(observed.state, "held");
    if (observed.state !== "held") return;

    // Between judgement and rename, the lock is re-created with the same pid + startedAt and a new
    // token (e.g. another reclaimer's retry in the same millisecond).
    const changed = { pid, startedAt: 7, token: TOKEN_B };
    writeFileSync(path, JSON.stringify(changed));
    assert.deepEqual(reclaimIfUnchanged(path, observed.fingerprint, "c".repeat(32)), {
      outcome: "restored",
      holderPid: pid,
    });
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), changed, "restored, not deleted");
    assert.deepEqual(readdirSync(join(home, "sessions")), ["thr_d.lock"], "reclaim file removed");

    // Unchanged since observed → reclaimed.
    const now = readLock(path);
    assert.ok(now.state !== "missing");
    assert.deepEqual(reclaimIfUnchanged(path, now.fingerprint), { outcome: "reclaimed" });
    assert.deepEqual(readdirSync(join(home, "sessions")), []);
  } finally {
    cleanup();
  }
});

test("lock: (c) missing/invalid token — reclaimable only when the pid is dead", async () => {
  const { home, cleanup } = makeHome();
  const holder = liveHolder();
  try {
    const path = threadLockPath(home, "thr_f");
    for (const body of [
      { pid: holder.pid, startedAt: 1 },
      { pid: holder.pid, startedAt: 1, token: "NOT-HEX" },
      { pid: holder.pid, startedAt: 1, token: "A".repeat(32) },
    ]) {
      writeFileSync(path, JSON.stringify(body));
      const state = readLock(path);
      assert.equal(state.state === "held" && state.token, null, JSON.stringify(body));
      const res = acquireThreadLock(home, "thr_f");
      assert.deepEqual(res, { ok: false, path, holderPid: holder.pid }, "live pid → locked");
      assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), body, "left untouched");
    }
    const pid = await deadPid();
    for (const body of [
      { pid, startedAt: 1 },
      { pid, startedAt: 1, token: 5 },
    ]) {
      writeFileSync(path, JSON.stringify(body));
      const res = acquireThreadLock(home, "thr_f");
      assert.equal(res.ok, true, "dead pid → reclaimed");
      if (res.ok) assert.equal(releaseThreadLock(res.handle), true);
    }
    // Unparseable body: no holder can be shown alive → reclaimed.
    writeFileSync(path, "not json");
    const res = acquireThreadLock(home, "thr_f");
    assert.equal(res.ok, true);
    if (res.ok) releaseThreadLock(res.handle);
    assert.deepEqual(readdirSync(join(home, "sessions")), [], "no stray files after reclaim");
  } finally {
    holder.kill();
    cleanup();
  }
});

test("lock: release re-checks the path names the fd it read (lstat vs fstat before unlink)", () => {
  const { home, cleanup } = makeHome();
  try {
    const mine = acquireThreadLock(home, "thr_g");
    assert.equal(mine.ok, true);
    if (!mine.ok) return;
    const original = readFileSync(mine.path, "utf8");
    // After the token check, the path is swapped for a different file (even one with identical
    // bytes). The unlink must not hit the file that was never checked.
    const released = releaseThreadLock(mine.handle, {
      beforeUnlink: () => {
        unlinkSync(mine.path);
        writeFileSync(mine.path, original);
      },
    });
    assert.equal(released, false);
    assert.equal(readFileSync(mine.path, "utf8"), original, "swapped-in file survives");
  } finally {
    cleanup();
  }
});

test("lock: a symlink at the lock path is never followed or trusted", async () => {
  const { home, cleanup } = makeHome();
  try {
    const path = threadLockPath(home, "thr_h");
    const target = join(home, "..", "target.json");
    writeFileSync(target, JSON.stringify({ pid: process.pid, startedAt: 1, token: TOKEN_A }));
    try {
      symlinkSync(target, path);
    } catch {
      return; // symlinks unavailable
    }
    assert.equal(readLock(path).state, "corrupt");
    assert.equal(
      releaseThreadLock({ path, pid: process.pid, startedAt: 1, token: TOKEN_A }),
      false,
    );
    assert.equal(holdsThreadLock({ path, pid: process.pid, startedAt: 1, token: TOKEN_A }), false);
    const res = acquireThreadLock(home, "thr_h"); // symlink reclaimed (link removed, target kept)
    assert.equal(res.ok, true);
    assert.equal(existsSync(target), true);
    if (res.ok) releaseThreadLock(res.handle);
  } finally {
    cleanup();
  }
});

test("lock: a directory or FIFO at the lock path is refused, never reclaimed or blocked on", () => {
  const { home, cleanup } = makeHome();
  try {
    const path = threadLockPath(home, "thr_i");
    mkdirSync(path);
    assert.throws(() => readLock(path), LockPathNotAFileError);
    assert.throws(() => acquireThreadLock(home, "thr_i"), LockPathNotAFileError);
    assert.equal(statSync(path).isDirectory(), true, "left in place");
    assert.deepEqual(readdirSync(join(home, "sessions")), ["thr_i.lock"], "nothing moved aside");

    if (process.platform === "win32") return;
    const fifo = threadLockPath(home, "thr_j");
    if (spawnSync("mkfifo", [fifo]).status !== 0) return; // mkfifo unavailable
    // O_NONBLOCK: opening a FIFO with no writer must not hang the engine.
    assert.throws(() => readLock(fifo), LockPathNotAFileError);
    assert.equal(
      releaseThreadLock({ path: fifo, pid: process.pid, startedAt: 1, token: TOKEN_A }),
      false,
    );
  } finally {
    cleanup();
  }
});

test("lock: without O_NOFOLLOW, a swap to a symlink between lstat and open is refused", () => {
  const { home, cleanup } = makeHome();
  try {
    const path = threadLockPath(home, "thr_n");
    const target = join(home, "..", "target-n.json");
    writeFileSync(target, JSON.stringify({ pid: process.pid, startedAt: 1, token: TOKEN_A }));
    writeFileSync(path, JSON.stringify({ pid: process.pid, startedAt: 1, token: TOKEN_B }));
    let swapped = false;
    const fd = openNoFollow(path, {
      noFollowFlag: false,
      afterLstat: () => {
        unlinkSync(path);
        try {
          symlinkSync(target, path);
          swapped = true;
        } catch {
          // symlinks unavailable
        }
      },
    });
    if (typeof fd === "number") closeSync(fd);
    if (!swapped) return;
    assert.equal(fd, "symlink", "the symlink target is never opened as the lock");
    // Untouched regular file: fallback path opens it.
    unlinkSync(path);
    writeFileSync(path, "{}");
    const ok = openNoFollow(path, { noFollowFlag: false });
    assert.equal(typeof ok, "number");
    if (typeof ok === "number") closeSync(ok);
  } finally {
    cleanup();
  }
});

test("lock: a token only counts on a well-formed {pid,startedAt,token} body", () => {
  const { home, cleanup } = makeHome();
  const holder = liveHolder();
  try {
    const path = threadLockPath(home, "thr_k");
    const handle = { path, pid: holder.pid ?? 0, startedAt: 1, token: TOKEN_A };
    for (const body of [
      { pid: holder.pid, startedAt: "1", token: TOKEN_A },
      { pid: holder.pid, startedAt: 1, token: TOKEN_A, extra: true },
      { pid: holder.pid, token: TOKEN_A },
    ]) {
      writeFileSync(path, JSON.stringify(body));
      const state = readLock(path);
      assert.equal(state.state === "held" && state.token, null, JSON.stringify(body));
      assert.equal(holdsThreadLock(handle), false, "malformed body proves no ownership");
      assert.equal(releaseThreadLock(handle), false);
      assert.deepEqual(acquireThreadLock(home, "thr_k"), {
        ok: false,
        path,
        holderPid: holder.pid,
      });
      assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), body, "left untouched");
    }
  } finally {
    holder.kill();
    cleanup();
  }
});

test("server: stdout failure takes the EOF shutdown path (locks released, dispatch stops)", async () => {
  const { home, cleanup } = makeHome();
  const input = new PassThrough();
  const lines: string[] = [];
  let writes = 0;
  const output = new Writable({
    write(chunk, _enc, cb) {
      writes++;
      // initialize response + thread/start response go out; the thread/started notification fails.
      if (writes >= 3) {
        cb(new Error("EPIPE: reader went away"));
        return;
      }
      lines.push(String(chunk));
      cb();
    },
  });
  const conn = new EngineConnection({ input, output, home, agent: echoAgent, log: () => {} });
  const done = conn.run();
  try {
    input.write(
      `${JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "t", version: "0" } } })}\n`,
    );
    input.write(`${JSON.stringify({ id: 2, method: "thread/start", params: {} })}\n`);
    let timer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      done.then(() => "shutdown"),
      new Promise((r) => {
        timer = setTimeout(() => r("timeout"), 3000);
      }),
    ]);
    clearTimeout(timer);
    assert.equal(outcome, "shutdown", "run() resolves although stdin is still open");
    const started = JSON.parse(lines[1] ?? "{}");
    const threadId: string = started.result?.thread?.id;
    assert.ok(isValidId(threadId));
    assert.equal(existsSync(join(home, "sessions", `${threadId}.lock`)), false, "lock released");
    const before = writes;
    input.write(`${JSON.stringify({ id: 3, method: "thread/list", params: {} })}\n`);
    await new Promise((r) => setImmediate(r));
    assert.equal(writes, before, "no dispatch after shutdown");
  } finally {
    input.end();
    cleanup();
  }
});

type Wire = Record<string, unknown> & { params?: Record<string, unknown> };

/** In-process engine over PassThrough stdin and a collecting stdout (optionally slow). */
function inProcessEngine(home: string, agent: Agent, flushDelayMs = 0) {
  const input = new PassThrough();
  const received: Wire[] = [];
  const flushed: string[] = [];
  const output = new Writable({
    write(chunk, _enc, cb) {
      const text = String(chunk);
      const finish = () => {
        flushed.push(text);
        for (const line of text.split("\n")) if (line !== "") received.push(JSON.parse(line));
        cb();
      };
      if (flushDelayMs > 0) setTimeout(finish, flushDelayMs);
      else finish();
    },
  });
  const logs: string[] = [];
  const conn = new EngineConnection({ input, output, home, agent, log: (m) => logs.push(m) });
  const done = conn.run();
  let nextId = 1;
  const waitFor = async (pred: (m: Wire) => boolean, timeoutMs = 3000): Promise<Wire> => {
    const until = Date.now() + timeoutMs;
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
  return { conn, input, output, received, flushed, logs, done, waitFor, request };
}

test("F2: completeItem normalizes an agent-supplied status to completed", async () => {
  const { home, cleanup } = makeHome();
  const sloppy: Agent = {
    name: "sloppy",
    async run(_ctx, sink) {
      const id = sink.newItemId();
      sink.startItem({ id, kind: "agentMessage", status: "inProgress", text: "" });
      // Misbehaving on purpose: completes the item but leaves the status as inProgress.
      sink.completeItem({ id, kind: "agentMessage", status: "inProgress", text: "done" });
    },
  };
  const e = inProcessEngine(home, sloppy);
  try {
    await e.request("initialize", { clientInfo: { name: "t", version: "0" } });
    const start = await e.request("thread/start");
    const threadId = (start.result as { thread: { id: string } }).thread.id;
    await e.request("turn/start", { threadId, input: [{ type: "text", text: "x" }] });
    const done = await e.waitFor((m) => m.method === "turn/completed");
    const turn = (done.params as { turn: { status: string; items: Item[] } }).turn;
    assert.equal(turn.status, "completed");
    const agentItem = turn.items.find((i) => i.kind === "agentMessage");
    assert.equal(agentItem?.status, "completed");
    const notified = e.received.filter(
      (m) =>
        m.method === "item/completed" &&
        (m.params?.item as Item | undefined)?.kind === "agentMessage",
    );
    assert.equal(notified.length, 1);
    assert.equal((notified[0]?.params?.item as Item | undefined)?.status, "completed");
  } finally {
    e.input.end();
    await e.done;
    cleanup();
  }
});

test("F1: termination signal sets exitCode and exits only after queued turn/completed flushed", async () => {
  const { home, cleanup } = makeHome();
  const hang: Agent = {
    name: "hang",
    run(_ctx, sink) {
      const id = sink.newItemId();
      sink.startItem({ id, kind: "agentMessage", status: "inProgress", text: "" });
      return new Promise<void>((resolve) => sink.signal.addEventListener("abort", () => resolve()));
    },
  };
  // stdout acknowledges each write 20 ms late, like a slow pipe reader.
  const e = inProcessEngine(home, hang, 20);
  try {
    await e.request("initialize", { clientInfo: { name: "t", version: "0" } });
    const start = await e.request("thread/start");
    const threadId = (start.result as { thread: { id: string } }).thread.id;
    await e.request("turn/start", { threadId, input: [{ type: "text", text: "x" }] });
    await e.waitFor(
      (m) =>
        m.method === "item/started" && (m.params?.item as Item | undefined)?.kind !== "userMessage",
    );

    const events: string[] = [];
    let exitCode: number | undefined;
    const exited = new Promise<void>((resolve) => {
      handleTerminationSignal(e.conn, 143, {
        output: e.output,
        setExitCode: (c) => {
          exitCode = c;
          events.push(`exitCode=${c}`);
        },
        exit: () => {
          const flushedCompleted = e.flushed.some((t) => t.includes('"turn/completed"'));
          events.push(`exit(flushed turn/completed=${flushedCompleted})`);
          resolve();
        },
        graceMs: 5_000,
      });
    });
    await exited;
    assert.equal(exitCode, 143);
    assert.deepEqual(events, ["exitCode=143", "exit(flushed turn/completed=true)"]);
    const done = await e.waitFor((m) => m.method === "turn/completed", 0);
    assert.equal((done.params as { turn: { status: string } }).turn.status, "interrupted");
    assert.equal(existsSync(join(home, "sessions", `${threadId}.lock`)), false, "lock released");
  } finally {
    e.input.end();
    await e.done;
    cleanup();
  }
});

test("F1: a stuck stdout cannot keep the engine alive past the grace period", async () => {
  let exits = 0;
  const stuck = new Writable({ write() {} }); // never acknowledges
  await new Promise<void>((resolve) => {
    handleTerminationSignal({ shutdown() {} }, 130, {
      output: stuck,
      setExitCode: () => {},
      exit: () => {
        exits++;
        resolve();
      },
      graceMs: 30,
    });
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(exits, 1);
});

test("§8.9 token never leaves the lock file (in-process wire + logs)", async () => {
  const { home, cleanup } = makeHome();
  const failing: Agent = {
    name: "failing",
    async run() {
      throw new Error("fixture failure");
    },
  };
  const e = inProcessEngine(home, failing);
  try {
    await e.request("initialize", { clientInfo: { name: "t", version: "0" } });
    const start = await e.request("thread/start");
    const threadId = (start.result as { thread: { id: string } }).thread.id;
    const token: string = JSON.parse(
      readFileSync(join(home, "sessions", `${threadId}.lock`), "utf8"),
    ).token;
    assert.match(token, LOCK_TOKEN_PATTERN);
    await e.request("turn/start", { threadId, input: [{ type: "text", text: "x" }] });
    await e.waitFor((m) => m.method === "turn/completed");
    await e.request("thread/resume", { threadId });
    await e.request("thread/list");
    assert.ok(
      e.logs.some((l) => l.includes("fixture failure")),
      "logger is exercised",
    );
    assert.equal(JSON.stringify(e.received).includes(token), false, "not on the wire");
    assert.equal(e.logs.join("\n").includes(token), false, "not in logs");
  } finally {
    e.input.end();
    await e.done;
    cleanup();
  }
});

test("§8.6 ACP module is a stub that throws NotImplemented", () => {
  assert.throws(
    () => createAcpAdapter(),
    (e: unknown) => e instanceof NotImplementedError && /not implemented/.test(e.message),
  );
});
