import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
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
import { echoAgent } from "./agent.ts";
import { confinedPath, resolveMadcHome } from "./home.ts";
import {
  acquireThreadLock,
  fileId,
  holdsThreadLock,
  isPidAlive,
  readLock,
  reclaimIfUnchanged,
  releaseThreadLock,
  threadLockPath,
} from "./lock.ts";
import { ErrorCode, providerRefusalError, RpcError } from "./protocol/errors.ts";
import { ID_PATTERN, isValidId, newId } from "./protocol/ids.ts";
import { CLIENT_REQUEST_METHODS, ITEM_KINDS } from "./protocol/types.ts";
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

test("§5 six item kinds; §3 complete M0 request list", () => {
  assert.deepEqual(
    [...ITEM_KINDS],
    ["userMessage", "agentMessage", "toolCall", "toolResult", "error", "servedModel"],
  );
  assert.deepEqual(
    [...CLIENT_REQUEST_METHODS],
    ["initialize", "thread/start", "thread/resume", "thread/list", "turn/start", "turn/interrupt"],
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

test("lock: create-exclusive {pid,startedAt}; live foreign holder refused; release only own", async () => {
  const { home, cleanup } = makeHome();
  // A live foreign process to act as the holder.
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
    stdio: "ignore",
  });
  try {
    const holderPid = holder.pid ?? 0;
    const mine = acquireThreadLock(home, "thr_a", holderPid);
    assert.equal(mine.ok, true);
    const body = JSON.parse(readFileSync(mine.path, "utf8"));
    assert.deepEqual(Object.keys(body).sort(), ["pid", "startedAt"], "pinned body, nothing else");
    assert.equal(body.pid, holderPid);
    assert.equal(typeof body.startedAt, "number");

    const other = acquireThreadLock(home, "thr_a");
    assert.deepEqual(other, { ok: false, path: mine.path, holderPid });

    assert.equal(mine.ok && holdsThreadLock(mine.handle), true);
    if (!mine.ok) return;
    // A handle for a different file (forged inode) is not ours → must not remove.
    assert.equal(releaseThreadLock({ ...mine.handle, ino: mine.handle.ino + 1n }), false);
    assert.equal(readLock(mine.path).state, "held");
    assert.equal(releaseThreadLock(mine.handle), true);
    assert.equal(readLock(mine.path).state, "missing");
  } finally {
    holder.kill();
    cleanup();
  }
});

test("lock: release with a token mismatch (same file, different startedAt/pid) removes nothing", () => {
  const { home, cleanup } = makeHome();
  try {
    const mine = acquireThreadLock(home, "thr_t");
    assert.equal(mine.ok, true);
    if (!mine.ok) return;
    assert.equal(
      releaseThreadLock({ ...mine.handle, startedAt: mine.handle.startedAt + 1 }),
      false,
    );
    assert.equal(releaseThreadLock({ ...mine.handle, pid: mine.handle.pid + 1 }), false);
    assert.equal(holdsThreadLock(mine.handle), true, "lock survives mismatched tokens");
    assert.equal(releaseThreadLock(mine.handle), true);
    assert.equal(readLock(mine.path).state, "missing");
  } finally {
    cleanup();
  }
});

test("lock: dead pid and corrupt body are reclaimed", async () => {
  const { home, cleanup } = makeHome();
  try {
    const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    const deadPid = dead.pid ?? 0;
    await new Promise((r) => dead.once("exit", r));
    assert.equal(isPidAlive(deadPid), false);
    assert.equal(isPidAlive(process.pid), true);

    mkdirSync(join(home, "sessions"), { recursive: true });
    const path = join(home, "sessions", "thr_b.lock");
    writeFileSync(path, JSON.stringify({ pid: deadPid, startedAt: 0 }));
    const res = acquireThreadLock(home, "thr_b");
    assert.equal(res.ok, true);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).pid, process.pid);
    if (res.ok) releaseThreadLock(res.handle);

    writeFileSync(path, "not json");
    const again = acquireThreadLock(home, "thr_b");
    assert.equal(again.ok, true);
    if (again.ok) releaseThreadLock(again.handle);
    assert.equal(existsSync(path), false);
    assert.deepEqual(readdirSync(join(home, "sessions")), [], "no stray files after reclaim");
  } finally {
    cleanup();
  }
});

test("lock: reclaim never deletes a lock that changed after it was judged dead", async () => {
  const { home, cleanup } = makeHome();
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
    stdio: "ignore",
  });
  try {
    const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    const deadPid = dead.pid ?? 0;
    await new Promise((r) => dead.once("exit", r));
    const path = threadLockPath(home, "thr_d");
    writeFileSync(path, JSON.stringify({ pid: deadPid, startedAt: 1 }));
    const seenId = fileId(path);
    const seen = readLock(path);
    assert.ok(seenId);

    // Another engine reclaims first and installs a live lock (the freed inode may be reused).
    unlinkSync(path);
    writeFileSync(path, JSON.stringify({ pid: holder.pid, startedAt: 2 }));
    assert.equal(reclaimIfUnchanged(path, seenId, seen), false);
    assert.deepEqual(readLock(path), { state: "held", info: { pid: holder.pid, startedAt: 2 } });
    assert.deepEqual(
      readdirSync(join(home, "sessions")),
      ["thr_d.lock"],
      "live lock back in place",
    );

    // Unchanged since observed → reclaimed, with no stray files left behind.
    const liveId = fileId(path);
    assert.ok(liveId);
    assert.equal(reclaimIfUnchanged(path, liveId, readLock(path)), true);
    assert.equal(readLock(path).state, "missing");
    assert.deepEqual(readdirSync(join(home, "sessions")), [], "no stray reclaim files");
  } finally {
    holder.kill();
    cleanup();
  }
});

test("lock: a stale handle never deletes a replacement lock (per-acquisition identity)", () => {
  const { home, cleanup } = makeHome();
  try {
    const first = acquireThreadLock(home, "thr_c");
    assert.equal(first.ok, true);
    if (!first.ok) return;
    // Our lock vanishes and is re-created by someone else with the same pid (the freed inode is
    // typically reused here, so identity must not rest on the inode alone).
    unlinkSync(first.path);
    writeFileSync(
      first.path,
      JSON.stringify({ pid: process.pid, startedAt: first.handle.startedAt + 1 }),
    );
    const second = acquireThreadLock(home, "thr_c"); // re-entrant adopt of the on-disk file
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(holdsThreadLock(first.handle), false);
    assert.equal(holdsThreadLock(second.handle), true);

    assert.equal(releaseThreadLock(first.handle), false); // stale → replacement stays
    assert.equal(readLock(first.path).state, "held");
    assert.equal(holdsThreadLock(second.handle), true, "replacement lock left intact");
    assert.deepEqual(
      readdirSync(join(home, "sessions")).filter((f) => f !== "thr_c.lock"),
      [],
      "no stray temp files",
    );
    releaseThreadLock(second.handle);
    assert.equal(readLock(first.path).state, "missing");
  } finally {
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

test("§8.6 ACP module is a stub that throws NotImplemented", () => {
  assert.throws(
    () => createAcpAdapter(),
    (e: unknown) => e instanceof NotImplementedError && /not implemented/.test(e.message),
  );
});
