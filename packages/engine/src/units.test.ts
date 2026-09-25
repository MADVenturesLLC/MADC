import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createAcpAdapter, NotImplementedError } from "./acp/index.ts";
import { confinedPath, resolveMadcHome } from "./home.ts";
import { acquireThreadLock, isPidAlive, readLock, releaseThreadLock } from "./lock.ts";
import { ErrorCode, providerRefusalError, RpcError } from "./protocol/errors.ts";
import { ID_PATTERN, isValidId, newId } from "./protocol/ids.ts";
import { CLIENT_REQUEST_METHODS, ITEM_KINDS } from "./protocol/types.ts";
import { encodeMessage, parseLine } from "./protocol/wire.ts";
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
    assert.throws(
      () => confinedPath(home, "sessions", "thr_ok", ".lock"),
      (e: unknown) => e instanceof RpcError && e.code === ErrorCode.InternalError,
    );
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
    assert.equal(body.pid, holderPid);
    assert.equal(typeof body.startedAt, "number");

    const other = acquireThreadLock(home, "thr_a");
    assert.deepEqual(other, { ok: false, path: mine.path, holderPid });

    releaseThreadLock(mine.path); // not ours (process.pid) → must not remove
    assert.equal(readLock(mine.path).state, "held");
    releaseThreadLock(mine.path, holderPid);
    assert.equal(readLock(mine.path).state, "missing");
  } finally {
    holder.kill();
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
    releaseThreadLock(path);

    writeFileSync(path, "not json");
    assert.equal(acquireThreadLock(home, "thr_b").ok, true);
    releaseThreadLock(path);
    assert.equal(existsSync(path), false);
  } finally {
    cleanup();
  }
});

test("§8.6 ACP module is a stub that throws NotImplemented", () => {
  assert.throws(
    () => createAcpAdapter(),
    (e: unknown) => e instanceof NotImplementedError && /not implemented/.test(e.message),
  );
});
