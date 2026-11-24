/**
 * M3-A1 (`docs/plan/PIN-madc-M3-desktop-protocol.md`): local-socket JSONL transport
 * (`$MADC_HOME/engine.sock`), `room/inspect`, `session/search`, `session/read`, and `room/updated`.
 *
 * Every wait is bounded (`withTimeout` / `waitFor`), so a missing response or notification fails the
 * test instead of hanging it.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createConnection, createServer, type Server, Socket } from "node:net";
import { dirname, join } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { PassThrough, type Writable } from "node:stream";
import { afterEach, test } from "node:test";
import { type Agent, echoAgent } from "./agent.ts";
import type { RoomReport } from "./inspect.ts";
import type { PresenceTerminal } from "./presence/terminal.ts";
import type { SessionReadResult, SessionSearchResult } from "./search.ts";
import { EngineConnection } from "./server.ts";
import { unguardedSessionWriterForTests } from "./session-store.ts";
import {
  enginePipeName,
  engineSocketPath,
  SOCKET_PATH_MAX_BYTES,
  type SocketServerHandle,
  type SocketServerOptions,
  SocketStartError,
  type SocketStartRefusal,
  startSocketServer,
} from "./socket.ts";
import { makeHome, writeSeatFile } from "./testing/harness.ts";

const POSIX = process.platform !== "win32";

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out after ${ms}ms waiting for ${what}`)),
      ms,
    );
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Poll `cond` every 5 ms; reject after `ms`. */
function waitFor(cond: () => boolean, ms: number, what: string): Promise<void> {
  return withTimeout(
    new Promise<void>((resolve) => {
      const tick = (): void => {
        if (cond()) resolve();
        else setTimeout(tick, 5);
      };
      tick();
    }),
    ms,
    what,
  );
}

class RpcFailure extends Error {
  readonly code: number | undefined;
  readonly rpcMessage: string | undefined;
  readonly data: unknown;
  /** The whole response line as it came off the socket (for "never echoed" checks). */
  readonly raw: string;
  constructor(code: number | undefined, message: string | undefined, data: unknown, raw: string) {
    super(`RPC ${code}: ${message}`);
    this.code = code;
    this.rpcMessage = message;
    this.data = data;
    this.raw = raw;
  }
}

/** `assert.rejects` matcher for an exact JSON-RPC error code. */
function rpcCode(code: number): (err: unknown) => boolean {
  return (err) => {
    assert.ok(err instanceof RpcFailure, `expected an RPC error, got ${String(err)}`);
    assert.equal(err.code, code, err.message);
    return true;
  };
}

/** `assert.rejects` matcher for a `SocketStartError` of one kind. */
function refusal(kind: SocketStartRefusal): (err: unknown) => boolean {
  return (err) => {
    assert.ok(err instanceof SocketStartError, `expected SocketStartError, got ${String(err)}`);
    assert.equal(err.kind, kind, err.message);
    return true;
  };
}

type RoomUpdate = { reason: string; threadId: string };

class SocketRpcClient {
  readonly socket: Socket;
  readonly #rl: Interface;
  #nextId = 1;
  readonly #pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  readonly notifications: Array<{ method: string; params: unknown }> = [];

  constructor(socket: Socket) {
    this.socket = socket;
    this.#rl = createInterface({ input: socket, crlfDelay: Number.POSITIVE_INFINITY });
    this.#rl.on("line", (line) => {
      if (!line.trim()) return;
      const msg = JSON.parse(line) as Record<string, unknown>;
      if (typeof msg.id === "number") {
        const p = this.#pending.get(msg.id);
        if (!p) return;
        this.#pending.delete(msg.id);
        if (msg.error !== undefined) {
          const err = msg.error as { code?: number; message?: string; data?: unknown };
          p.reject(new RpcFailure(err.code, err.message, err.data, line));
        } else {
          p.resolve(msg.result);
        }
      } else if (typeof msg.method === "string") {
        this.notifications.push({ method: msg.method, params: msg.params });
      }
    });
  }

  get roomUpdates(): RoomUpdate[] {
    return this.notifications
      .filter((n) => n.method === "room/updated")
      .map((n) => n.params as RoomUpdate);
  }

  has(method: string, pred: (params: unknown) => boolean = () => true): boolean {
    return this.notifications.some((n) => n.method === method && pred(n.params));
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.#nextId++;
    const p = new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.socket.write(`${JSON.stringify({ id, method, params })}\n`);
    });
    return withTimeout(p, 3000, `RPC response for ${method}`);
  }

  init(name: string, capabilities?: unknown): Promise<unknown> {
    return this.request("initialize", {
      clientInfo: { name, version: "0" },
      ...(capabilities === undefined ? {} : { capabilities }),
    });
  }

  async close(): Promise<void> {
    this.#rl.close();
    if (this.socket.destroyed) return;
    await withTimeout(
      new Promise<void>((resolve) => {
        this.socket.once("close", () => resolve());
        this.socket.end();
        this.socket.destroy();
      }),
      1500,
      "client socket close",
    );
  }
}

const activeServers: SocketServerHandle[] = [];
const activeClients: SocketRpcClient[] = [];
const activeCleanups: Array<() => void> = [];

afterEach(async () => {
  while (activeClients.length > 0) {
    const c = activeClients.pop();
    if (c) await c.close().catch(() => {});
  }
  while (activeServers.length > 0) {
    const s = activeServers.pop();
    if (s) await withTimeout(s.close(), 2000, "afterEach server.close").catch(() => {});
  }
  while (activeCleanups.length > 0) {
    const fn = activeCleanups.pop();
    if (fn) fn();
  }
});

async function connect(sockPath: string): Promise<SocketRpcClient> {
  const socket = createConnection(sockPath);
  await withTimeout(
    new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    }),
    2000,
    `socket connect (${sockPath})`,
  );
  const client = new SocketRpcClient(socket);
  activeClients.push(client);
  return client;
}

function freshHome(): string {
  const { home, cleanup } = makeHome();
  activeCleanups.push(cleanup);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return home;
}

function writeSeat(home: string, id: string): void {
  writeSeatFile(home, {
    id,
    version: 2,
    displayName: id,
    role: "builder",
    standingInstructions: "test",
    pinnedModel: "kimi-coding/kimi-for-coding",
    preferredBacking: "kimi-code",
    fallbacks: [],
    memory: { mode: "in-session" },
    tools: { deny: [] },
    policy: { headlessOk: true },
    handoffs: { enabled: true, targets: [id] },
  });
}

async function start(
  home: string,
  extra: Partial<SocketServerOptions> = {},
): Promise<SocketServerHandle> {
  const server = await withTimeout(
    startSocketServer({ home, agent: echoAgent, log: () => {}, ...extra }),
    3000,
    "startSocketServer",
  );
  activeServers.push(server);
  return server;
}

/**
 * Leave a real stale socket at `sockPath`: a child process (this same runtime) binds it and is
 * SIGKILLed, so nothing unlinks the file and nothing listens on it.
 */
async function makeStaleSocket(sockPath: string): Promise<void> {
  const script =
    'const sockPath = process.env.MADC_TEST_SOCK; require("node:net").createServer().listen(sockPath, () => process.stdout.write("ready\\n"));';
  const child = spawn(process.execPath, ["-e", script], {
    env: { ...process.env, MADC_TEST_SOCK: sockPath },
    stdio: ["ignore", "pipe", "inherit"],
  });
  try {
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        child.stdout.once("data", () => resolve());
        child.once("error", reject);
        child.once("exit", (code) => reject(new Error(`stale-socket child exited ${code}`)));
      }),
      5000,
      "stale-socket child listen",
    );
  } finally {
    const exited = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once("exit", () => resolve());
    });
    child.kill("SIGKILL");
    await withTimeout(exited, 5000, "stale-socket child exit");
  }
  assert.ok(lstatSync(sockPath).isSocket(), "a stale socket file is left at the path");
}

/** A bare in-process Unix-socket listener at `sockPath` (impostors and runtime probes). */
async function listenOn(sockPath: string): Promise<Server> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(sockPath, () => resolve()));
  return server;
}

/** `assert.rejects` matcher for a `SocketStartError` of one kind carrying exactly errno `code`. */
function refusalWithCode(
  kind: SocketStartRefusal,
  code: string | undefined,
): (err: unknown) => boolean {
  return (err) => {
    refusal(kind)(err);
    assert.equal((err as SocketStartError).code, code, (err as Error).message);
    return true;
  };
}

/**
 * Child-process subscriber that stops reading (so the engine's writes to it pile up), asks for
 * `requests` large `session/read` answers, prints `ready`, resumes reading on `go` from stdin, and
 * prints one JSON summary when the engine ends the connection. A separate process, because an
 * in-process client paused and resumed after the peer ends gets 0 bytes on Bun 1.3.11
 * (amendment 1 §3 step 3 test note).
 */
const SLOW_SUBSCRIBER = `
const net = require("node:net");
const sock = net.createConnection(process.env.MADC_TEST_SOCK);
const requests = Number(process.env.MADC_TEST_REQUESTS);
let buf = "";
let bytes = 0;
let responses = 0;
const updates = [];
sock.setEncoding("utf8");
sock.on("connect", () => {
  sock.write(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "slow", version: "0" }, capabilities: { subscribeRoom: true } } }) + "\\n");
});
function onLine(msg) {
  if (msg.id === 1) {
    for (let i = 0; i < requests; i++) {
      sock.write(JSON.stringify({ id: 10 + i, method: "session/read", params: { threadId: "thr_big" } }) + "\\n");
    }
    sock.pause();
    setTimeout(() => process.stdout.write("ready\\n"), 600);
  } else if (typeof msg.id === "number" && msg.result !== undefined) {
    responses++;
  } else if (msg.method === "room/updated") {
    updates.push(msg.params);
  }
}
sock.on("data", (chunk) => {
  bytes += Buffer.byteLength(chunk);
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line.trim()) onLine(JSON.parse(line));
  }
});
process.stdin.on("data", () => sock.resume());
let printed = false;
const report = () => {
  if (printed) return;
  printed = true;
  process.stdout.write(JSON.stringify({ bytes, responses, updates }) + "\\n");
  process.exit(0);
};
sock.on("end", report);
sock.on("close", report);
sock.on("error", report);
`;

/** A fake `connect` for the probe: a socket that emits one error with `code`, or never settles. */
function fakeConnect(code: string | null): (path: string) => Socket {
  return () => {
    const s = new Socket();
    if (code !== null) {
      setImmediate(() =>
        s.emit("error", Object.assign(new Error(`fake ${code}`), { code }) as Error),
      );
    }
    return s;
  };
}

const confirmingTerminal: PresenceTerminal = {
  probe: () => ({ device: "16/18", session: null }),
  confirm: async () => true,
};

// ------------------------------------------------------------------ transport

test("M3-A1 socket: binds a 0600 socket at $MADC_HOME/engine.sock and a second engine is refused (live)", async () => {
  const home = freshHome();
  const server = await start(home);
  assert.equal(server.socketPath, engineSocketPath(home));
  if (POSIX) {
    assert.equal(server.socketPath, join(home, "engine.sock"));
    assert.equal(statSync(server.socketPath).mode & 0o777, 0o600);
    assert.ok(lstatSync(server.socketPath).isSocket());
  }
  await assert.rejects(() => start(home), refusal("live"));
  // The refused second start left the live listener alone.
  const c = await connect(server.socketPath);
  await c.init("after-refusal");
});

test("M3-A1 socket: close() with idle and half-open clients finishes promptly and unlinks the socket (6e20176 regression)", async () => {
  const home = freshHome();
  const server = await start(home);
  const c = await connect(server.socketPath);
  await c.init("idle");
  // A client that keeps its side open after the server ends (allowHalfOpen) and never writes:
  // without destroying live sockets, server.close() waits for it forever.
  const halfOpen = createConnection({ path: server.socketPath, allowHalfOpen: true });
  await withTimeout(
    new Promise<void>((resolve, reject) => {
      halfOpen.once("connect", () => resolve());
      halfOpen.once("error", reject);
    }),
    2000,
    "half-open client connect",
  );
  halfOpen.on("error", () => {});
  activeCleanups.push(() => halfOpen.destroy());
  // The server has accepted it (and created its connection) before close() runs.
  await new Promise((r) => setTimeout(r, 50));
  const clientClosed = new Promise<void>((resolve) => c.socket.once("close", () => resolve()));
  await withTimeout(server.close(), 1000, "server.close with idle and half-open clients");
  await withTimeout(clientClosed, 1000, "client sees the server close");
  if (POSIX) assert.equal(existsSync(server.socketPath), false, "close() unlinks the socket");
});

test("M3-A1 socket: a real stale socket (bound by a killed process) is recovered on start", {
  skip: !POSIX,
}, async () => {
  const home = freshHome();
  const sockPath = engineSocketPath(home);
  await makeStaleSocket(sockPath);
  const server = await start(home);
  const c = await connect(server.socketPath);
  const init = (await c.init("after-stale")) as { protocolVersion: string };
  assert.equal(typeof init.protocolVersion, "string");
  assert.equal(statSync(sockPath).mode & 0o777, 0o600);
});

test("M3-A1 socket: probe ENOENT on a path that is still the same socket is stale (Bun 1.3.11 errno), on every runtime", {
  skip: !POSIX,
}, async () => {
  const home = freshHome();
  const sockPath = engineSocketPath(home);
  await makeStaleSocket(sockPath);
  const server = await start(home, { socketDeps: { connect: fakeConnect("ENOENT") } });
  const c = await connect(server.socketPath);
  await c.init("after-enoent");
});

test("M3-A1 socket: non-socket files at engine.sock are refused, never unlinked", {
  skip: !POSIX,
}, async () => {
  // Regular file.
  const fileHome = freshHome();
  const filePath = engineSocketPath(fileHome);
  writeFileSync(filePath, "not a socket", { mode: 0o600 });
  await assert.rejects(() => start(fileHome), refusal("not-socket"));
  assert.equal(readFileSync(filePath, "utf8"), "not a socket", "the regular file is untouched");

  // Directory (previously a raw EISDIR from unlinkSync).
  const dirHome = freshHome();
  const dirPath = engineSocketPath(dirHome);
  mkdirSync(dirPath, { mode: 0o700 });
  writeFileSync(join(dirPath, "keep"), "x");
  await assert.rejects(
    () => start(dirHome),
    (err: unknown) => {
      refusal("not-socket")(err);
      assert.match((err as Error).message, /directory/);
      return true;
    },
  );
  assert.ok(statSync(dirPath).isDirectory(), "the directory is untouched");
  assert.ok(existsSync(join(dirPath, "keep")));

  // Symlink (dangling), never followed or removed.
  const symHome = freshHome();
  const symPath = engineSocketPath(symHome);
  symlinkSync("/tmp/nonexistent-sock-target", symPath);
  await assert.rejects(() => start(symHome), refusal("symlink"));
  assert.equal(readlinkSync(symPath), "/tmp/nonexistent-sock-target", "the symlink is untouched");
});

test("M3-A1 socket: a stale-looking socket is unlinked only on ECONNREFUSED / ENOENT; timeout, other errors and a swap refuse", {
  skip: !POSIX,
}, async () => {
  const home = freshHome();
  const sockPath = engineSocketPath(home);
  await makeStaleSocket(sockPath);
  const before = lstatSync(sockPath).ino;

  // The probe never settles: bounded by the timeout, and the socket is left in place.
  const t0 = Date.now();
  await assert.rejects(
    () => start(home, { socketDeps: { connect: fakeConnect(null), probeTimeoutMs: 50 } }),
    refusal("probe-timeout"),
  );
  assert.ok(Date.now() - t0 < 2000, "the probe timeout bounds startup");
  assert.equal(lstatSync(sockPath).ino, before, "timeout: not unlinked");

  // An error that does not prove the socket stale; its errno is on the refusal (Argus P4).
  await assert.rejects(
    () => start(home, { socketDeps: { connect: fakeConnect("EACCES") } }),
    refusalWithCode("probe-failed", "EACCES"),
  );
  assert.equal(lstatSync(sockPath).ino, before, "EACCES: not unlinked");

  // The path is swapped for a regular file during the probe: refused, the new file is untouched.
  await assert.rejects(
    () =>
      start(home, {
        socketDeps: {
          connect: (p) => {
            unlinkSync(p);
            writeFileSync(p, "swapped in", { mode: 0o600 });
            return fakeConnect("ECONNREFUSED")(p);
          },
        },
      }),
    refusal("replaced"),
  );
  assert.equal(readFileSync(sockPath, "utf8"), "swapped in");
});

test("M3-A1 socket: a non-stale probe error refuses even when the path vanished during the probe (amendment 1 §4 step 4)", {
  skip: !POSIX,
}, async () => {
  const home = freshHome();
  const sockPath = engineSocketPath(home);
  await makeStaleSocket(sockPath);
  await assert.rejects(
    () =>
      start(home, {
        socketDeps: {
          connect: (p) => {
            unlinkSync(p); // gone before the re-lstat
            return fakeConnect("EACCES")(p);
          },
        },
      }),
    refusal("probe-failed"),
  );
  assert.equal(existsSync(sockPath), false, "nothing was bound after the refusal");
});

test("M3-A1 socket: a stale socket whose unlink fails (not ENOENT) refuses and stays put; ENOENT proceeds", {
  skip: !POSIX,
}, async () => {
  const home = freshHome();
  const sockPath = engineSocketPath(home);
  await makeStaleSocket(sockPath);
  const before = lstatSync(sockPath).ino;
  await assert.rejects(
    () =>
      start(home, {
        socketDeps: {
          unlink: () => {
            throw Object.assign(new Error("EACCES: unlink refused"), { code: "EACCES" });
          },
        },
      }),
    (err: unknown) => {
      refusalWithCode("stat-failed", "EACCES")(err);
      assert.match((err as Error).message, /unlink failed \(EACCES\)/);
      return true;
    },
  );
  assert.equal(lstatSync(sockPath).ino, before, "the stale socket is left in place");

  // Someone else removed it between the re-lstat and our unlink: free to bind.
  const server = await start(home, {
    socketDeps: {
      unlink: (p) => {
        unlinkSync(p);
        throw Object.assign(new Error("ENOENT: already gone"), { code: "ENOENT" });
      },
    },
  });
  const c = await connect(server.socketPath);
  await c.init("after-unlink-enoent");
});

test("M3-A1 socket: a socket path over the sun_path limit is refused before anything is bound (listen-failed)", {
  skip: !POSIX,
}, async () => {
  // sun_path is 108 bytes on Linux and 104 on macOS/BSD, one of them the terminating NUL.
  assert.equal(SOCKET_PATH_MAX_BYTES, process.platform === "linux" ? 107 : 103);
  /** A home whose engine.sock path is exactly `bytes` long. */
  const homeWithSocketPathOf = (bytes: number): string => {
    const base = freshHome();
    const pad = bytes - Buffer.byteLength(join(base, "x", "engine.sock")) + 1;
    assert.ok(pad > 0 && pad < 200, `padding ${pad}`);
    const home = join(base, "h".repeat(pad));
    mkdirSync(home, { mode: 0o700 });
    assert.equal(Buffer.byteLength(engineSocketPath(home)), bytes);
    return home;
  };
  for (const over of [SOCKET_PATH_MAX_BYTES + 1, SOCKET_PATH_MAX_BYTES + 12]) {
    const home = homeWithSocketPathOf(over);
    await assert.rejects(
      () => start(home),
      (err: unknown) => {
        refusalWithCode("listen-failed", undefined)(err);
        assert.match(
          (err as Error).message,
          new RegExp(`socket path too long \\(${over} bytes, limit ${SOCKET_PATH_MAX_BYTES}\\)`),
        );
        return true;
      },
    );
    assert.deepEqual(
      readdirSync(home).filter((f) => f.startsWith("engine")),
      [],
      "no socket (or truncated socket name) was bound",
    );
  }
  // Exactly at the limit still binds and serves.
  const server = await start(homeWithSocketPathOf(SOCKET_PATH_MAX_BYTES));
  const c = await connect(server.socketPath);
  await c.init("at-limit");
});

test("M3-A1 socket: a bound socket not owned by this process's uid fails closed (amendment 1 §4 step 5)", {
  skip: !POSIX,
}, async () => {
  const home = freshHome();
  const sockPath = engineSocketPath(home);
  const uid = process.getuid?.() ?? 0;
  await assert.rejects(
    () => start(home, { socketDeps: { getuid: () => uid + 1 } }),
    (err: unknown) => {
      refusal("chmod-failed")(err);
      assert.match((err as Error).message, new RegExp(`owner uid is ${uid}, not ${uid + 1}`));
      return true;
    },
  );
  assert.equal(existsSync(sockPath), false, "the bound socket is removed");
  // The real uid passes.
  const server = await start(home);
  assert.equal(lstatSync(server.socketPath).uid, uid);
});

test("M3-A1 socket: the Windows pipe name hashes the home's real path (amendment 1 §4 Windows)", () => {
  const home = freshHome();
  const alias = join(dirname(home), "alias");
  symlinkSync(home, alias);
  const real = enginePipeName(home);
  assert.match(real, /^\\\\\.\\pipe\\madc-[0-9a-f]{16}$/);
  assert.equal(enginePipeName(alias), real, "two spellings of one home name one pipe");
  const rawAliasHash = createHash("sha256").update(alias).digest("hex").slice(0, 16);
  assert.notEqual(enginePipeName(alias), `\\\\.\\pipe\\madc-${rawAliasHash}`);
  // An absent home has no listener: the name cannot be computed (ENOENT), never guessed.
  assert.throws(
    () => enginePipeName(join(dirname(home), "absent")),
    (err: unknown) => (err as { code?: string }).code === "ENOENT",
  );
});

test("M3-A1 socket: a failed chmod 0600 fails closed (listener closed, socket removed)", {
  skip: !POSIX,
}, async () => {
  for (const chmod of [
    () => {
      throw Object.assign(new Error("EPERM: chmod refused"), { code: "EPERM" });
    },
    // "Succeeds" but leaves the wrong mode (a no-op is no longer enough: the socket is born 0600
    // under umask 0o177): the post-chmod mode check still refuses.
    (path: string) => chmodSync(path, 0o644),
  ]) {
    const home = freshHome();
    const sockPath = engineSocketPath(home);
    await assert.rejects(() => start(home, { socketDeps: { chmod } }), refusal("chmod-failed"));
    assert.equal(existsSync(sockPath), false, "the bound socket is removed");
    await assert.rejects(
      () => connect(sockPath),
      (err: unknown) => (err as { code?: string }).code !== undefined,
    );
    // Nothing was left listening: a normal start now succeeds.
    await start(home);
  }
});

test("M3-A1 socket: close() flushes a slow subscriber's MiB-scale backlog, ending with the thread-close room/updated (amendment 1 §3 step 3)", {
  skip: !POSIX,
  timeout: 30000,
}, async () => {
  const home = freshHome();
  writeSeat(home, "seat-a");
  const dir = join(home, "sessions");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const big = unguardedSessionWriterForTests.create(
    join(dir, "thr_big.jsonl"),
    "thr_big",
    "seat-a",
    { cwd: null, backing: "kimi-code", providerId: "kimi-code", pinnedModel: "m" },
    () => [],
  );
  big.append("turn.start", { turnId: "turn_1", inputText: "start" });
  for (let i = 0; i < 4; i++) {
    big.append("item", {
      turnId: "turn_1",
      item: {
        id: `item_${i}`,
        kind: "agentMessage",
        status: "completed",
        text: "x".repeat(256 * 1024),
      },
    });
  }
  const server = await start(home);
  // The driver connects first, so its shutdown (thread close) is broadcast while the slow
  // subscriber is still open.
  const driver = await connect(server.socketPath);
  await driver.init("driver");
  const s = (await driver.request("thread/start", { seatId: "seat-a" })) as {
    thread: { id: string };
  };
  const requests = 6;
  const child = spawn(process.execPath, ["-e", SLOW_SUBSCRIBER], {
    env: {
      ...process.env,
      MADC_TEST_SOCK: server.socketPath,
      MADC_TEST_REQUESTS: String(requests),
    },
    stdio: ["pipe", "pipe", "inherit"],
  });
  let out = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    out += chunk;
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  try {
    await waitFor(() => out.includes("ready\n"), 10000, "slow subscriber ready");
    const closing = server.close();
    child.stdin.write("go\n");
    await withTimeout(closing, 10000, "close() with a slow subscriber");
    await withTimeout(exited, 10000, "slow subscriber exit");
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  const summary = JSON.parse(
    out
      .split("\n")
      .filter((l) => l.startsWith("{"))
      .at(-1) ?? "{}",
  ) as {
    bytes: number;
    responses: number;
    updates: RoomUpdate[];
  };
  assert.equal(summary.responses, requests, "every queued session/read answer arrived");
  assert.ok(summary.bytes > 4 * 1024 * 1024, `MiB-scale backlog (${summary.bytes} bytes)`);
  assert.deepEqual(summary.updates.at(-1), { reason: "thread", threadId: s.thread.id });
});

test("M3-A1 socket: close() with a subscriber that never reads still finishes, bounded by the per-socket grace", {
  skip: !POSIX,
  timeout: 30000,
}, async () => {
  const home = freshHome();
  writeSeat(home, "seat-a");
  const dir = join(home, "sessions");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const big = unguardedSessionWriterForTests.create(
    join(dir, "thr_big.jsonl"),
    "thr_big",
    "seat-a",
    { cwd: null, backing: "kimi-code", providerId: "kimi-code", pinnedModel: "m" },
    () => [],
  );
  big.append("turn.start", { turnId: "turn_1", inputText: "start" });
  for (let i = 0; i < 4; i++) {
    big.append("item", {
      turnId: "turn_1",
      item: {
        id: `item_${i}`,
        kind: "agentMessage",
        status: "completed",
        text: "x".repeat(256 * 1024),
      },
    });
  }
  const graceMs = 200;
  const server = await start(home, { socketDeps: { closeGraceMs: graceMs } });
  const child = spawn(process.execPath, ["-e", SLOW_SUBSCRIBER], {
    env: { ...process.env, MADC_TEST_SOCK: server.socketPath, MADC_TEST_REQUESTS: "6" },
    stdio: ["pipe", "pipe", "inherit"],
  });
  let out = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    out += chunk;
  });
  try {
    await waitFor(() => out.includes("ready\n"), 10000, "never-reading subscriber ready");
    // No "go": the subscriber never reads its MiB-scale backlog, so `finish` never fires.
    const t0 = Date.now();
    await withTimeout(server.close(), 5000, "close() with a never-reading subscriber");
    const took = Date.now() - t0;
    assert.ok(took >= graceMs - 20, `close() waited out the grace (${took} ms)`);
    assert.ok(took < graceMs + 2000, `close() bounded by the grace (${took} ms)`);
  } finally {
    child.kill("SIGKILL");
  }
});

test("M3-A1 socket: listen runs under umask 0o177 and the previous umask is restored, on success and on a listen failure", {
  skip: !POSIX,
}, async () => {
  const previous = process.umask(0o022);
  try {
    const home = freshHome();
    let modeAtBind = -1;
    await start(home, {
      socketDeps: {
        chmod: (path, mode) => {
          modeAtBind = lstatSync(path).mode & 0o777;
          chmodSync(path, mode);
        },
      },
    });
    assert.equal(modeAtBind.toString(8), "600", "the socket was born 0600, before any chmod");
    assert.equal(process.umask(), 0o022, "umask restored after the bind");

    // A listen that fails (a directory appears at the path after the stale unlink): EADDRINUSE on
    // every runtime, with the errno on the refusal (Argus P4), and the umask restored.
    const failHome = freshHome();
    const sockPath = engineSocketPath(failHome);
    await makeStaleSocket(sockPath);
    await assert.rejects(
      () =>
        start(failHome, {
          socketDeps: {
            unlink: (p) => {
              unlinkSync(p);
              mkdirSync(p, { mode: 0o700 });
            },
          },
        }),
      refusalWithCode("listen-failed", "EADDRINUSE"),
    );
    assert.equal(process.umask(), 0o022, "umask restored after a failed listen");
  } finally {
    process.umask(previous);
  }
});

test("M3-A1 socket: close() and the fail-closed path unlink only the socket this engine bound (dev + ino)", {
  skip: !POSIX,
}, async () => {
  // Does this runtime's own server.close() unlink the path (Node 22, Bun 1.4.x) or not (Bun
  // 1.3.11)? Where it does, an impostor at the path is removed by the runtime, not by us.
  const probeHome = freshHome();
  const probePath = join(probeHome, "probe.sock");
  const probe = await listenOn(probePath);
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const runtimeUnlinks = !existsSync(probePath);

  /** Replace whatever is at `p` with a different socket (bound by a live in-process server). */
  const plantImpostor = async (p: string): Promise<Server> => {
    unlinkSync(p);
    return listenOn(p);
  };

  // close(): the socket at the path is no longer ours.
  const home = freshHome();
  const server = await start(home);
  const impostor = await plantImpostor(server.socketPath);
  const ino = lstatSync(server.socketPath).ino;
  await server.close();
  if (!runtimeUnlinks) {
    assert.equal(lstatSync(server.socketPath).ino, ino, "close(): the impostor is left in place");
  }
  await new Promise<void>((resolve) => impostor.close(() => resolve()));

  // Fail-closed: inside chmod, another socket is renamed over ours, so the check refuses
  // ("replaced") and the fail-closed unlink must leave the other socket alone.
  const fcHome = freshHome();
  const fcPath = engineSocketPath(fcHome);
  const otherPath = join(fcHome, "other.sock");
  const other = await listenOn(otherPath);
  const otherIno = lstatSync(otherPath).ino;
  await assert.rejects(
    () => start(fcHome, { socketDeps: { chmod: (path) => renameSync(otherPath, path) } }),
    (err: unknown) => {
      refusal("chmod-failed")(err);
      assert.match((err as Error).message, /replaced before the mode check/);
      return true;
    },
  );
  if (!runtimeUnlinks) {
    assert.equal(lstatSync(fcPath).ino, otherIno, "fail-closed: the other socket is left in place");
  }
  await new Promise<void>((resolve) => other.close(() => resolve()));
});

// ------------------------------------------------------------- initialize

test("M3-A1 initialize: capabilities must be an object and subscribeRoom a boolean (-32602)", async () => {
  const home = freshHome();
  const server = await start(home);
  const c = await connect(server.socketPath);
  await assert.rejects(() => c.init("bad", "yes"), rpcCode(-32602));
  await assert.rejects(() => c.init("bad", { subscribeRoom: "yes" }), rpcCode(-32602));
  await assert.rejects(() => c.init("bad", [true]), rpcCode(-32602));
  await c.init("good", { subscribeRoom: false });
});

// --------------------------------------------------------------- room/updated

test("M3-A1 room/updated: a subscriber gets every pin §3 trigger; unsubscribed and subscribeRoom:false clients get none", async () => {
  const home = freshHome();
  writeSeat(home, "seat-a");
  const ids = ["thr_src", "thr_target", "thr_taken"];
  const server = await start(home, {
    terminal: confirmingTerminal,
    newThreadId: () => ids.shift() ?? "thr_spare",
  });
  const driver = await connect(server.socketPath);
  const sub = await connect(server.socketPath);
  const off = await connect(server.socketPath);
  await driver.init("driver");
  await sub.init("sub", { subscribeRoom: true });
  await off.init("off", { subscribeRoom: false });

  // 1. A thread opens.
  const s = (await driver.request("thread/start", { seatId: "seat-a" })) as {
    thread: { id: string };
  };
  const src = s.thread.id;
  assert.equal(src, "thr_src");
  await waitFor(() => sub.roomUpdates.length === 1, 2000, "thread open update");

  // 2. A turn starts and completes.
  const t = (await driver.request("turn/start", {
    threadId: src,
    input: [{ type: "text", text: "hello" }],
  })) as { turn: { id: string } };
  await waitFor(() => driver.has("turn/completed"), 3000, "turn/completed");
  await waitFor(() => sub.roomUpdates.length === 3, 2000, "turn start + completion updates");

  // 3. A decision is raised, then resolved.
  const d = (await driver.request("decision/raise", {
    threadId: src,
    turnId: t.turn.id,
    question: "Proceed with M3?",
    recommendedDefault: "Yes",
    evidenceRefs: [{ kind: "git", sha: "b0db17bfc94d3bd3b60af5a3f61e499c9c11a9a7", remote: null }],
  })) as { decisionId: string; seq: number; hash: string };
  await waitFor(() => sub.roomUpdates.length === 4, 2000, "decision raised update");
  await driver.request("decision/resolve", {
    threadId: src,
    decisionId: d.decisionId,
    decisionSeq: d.seq,
    decisionHash: d.hash,
    outcome: "accepted-default",
  });
  await waitFor(() => sub.roomUpdates.length === 5, 2000, "decision resolved update");

  // 4. A handoff links (announced on the SOURCE thread, amendment 1 §10.2).
  const h = (await driver.request("thread/handoff", {
    threadId: src,
    targetSeatId: "seat-a",
    brief: "Take it from here.",
    turnId: t.turn.id,
  })) as { targetThreadId: string };
  assert.equal(h.targetThreadId, "thr_target");
  await waitFor(() => sub.roomUpdates.length === 6, 2000, "handoff linked update");

  // 5. A handoff aborts after handoff.out: the target id's file is in the way, so the target open
  //    fails, `handoff.aborted` is recorded and the error is answered (announced on the source).
  writeFileSync(join(home, "sessions", "thr_taken.jsonl"), "not a session\n", { mode: 0o600 });
  await assert.rejects(
    () =>
      driver.request("thread/handoff", {
        threadId: src,
        targetSeatId: "seat-a",
        brief: "Again.",
        turnId: null,
      }),
    rpcCode(-32009),
  );
  const srcLines = readFileSync(join(home, "sessions", `${src}.jsonl`), "utf8")
    .trim()
    .split("\n");
  assert.equal(JSON.parse(srcLines.at(-1) ?? "{}").type, "handoff.aborted");
  await waitFor(() => sub.roomUpdates.length === 7, 2000, "handoff aborted update");

  // A refusal before any append (unknown target seat) changes nothing and announces nothing.
  await assert.rejects(
    () =>
      driver.request("thread/handoff", {
        threadId: src,
        targetSeatId: "no-such-seat",
        brief: "x",
        turnId: null,
      }),
    rpcCode(-32005),
  );

  // 6. The thread closes when its connection goes away (shutdown writes session.close).
  await driver.close();
  await waitFor(() => sub.roomUpdates.length === 8, 2000, "thread close update");

  assert.deepEqual(sub.roomUpdates, [
    { reason: "thread", threadId: src },
    { reason: "turn", threadId: src },
    { reason: "turn", threadId: src },
    { reason: "decision", threadId: src },
    { reason: "decision", threadId: src },
    { reason: "handoff", threadId: src }, // the link: source, not "thr_target" (§10.2)
    { reason: "handoff", threadId: src }, // the abort: source
    { reason: "thread", threadId: src },
  ]);
  const closeLine = readFileSync(join(home, "sessions", `${src}.jsonl`), "utf8")
    .trim()
    .split("\n")
    .at(-1);
  assert.equal(JSON.parse(closeLine ?? "{}").type, "session.close");
  assert.deepEqual(driver.roomUpdates, [], "an unsubscribed client receives no room/updated");
  assert.deepEqual(off.roomUpdates, [], "subscribeRoom:false receives no room/updated");
});

test("M3-A1 room/updated: a turn interrupted by its client's disconnect announces its completion and the thread close", async () => {
  const home = freshHome();
  writeSeat(home, "seat-a");
  const hangAgent: Agent = {
    name: "hang",
    run: (_ctx, sink) =>
      new Promise<void>((resolve) => {
        if (sink.signal.aborted) resolve();
        else sink.signal.addEventListener("abort", () => resolve(), { once: true });
      }),
  };
  const server = await start(home, { agent: hangAgent });
  const driver = await connect(server.socketPath);
  const sub = await connect(server.socketPath);
  await driver.init("driver");
  await sub.init("sub", { subscribeRoom: true });
  const s = (await driver.request("thread/start", { seatId: "seat-a" })) as {
    thread: { id: string };
  };
  await driver.request("turn/start", {
    threadId: s.thread.id,
    input: [{ type: "text", text: "wait" }],
  });
  await waitFor(() => sub.roomUpdates.length === 2, 2000, "thread open + turn start");
  await driver.close();
  await waitFor(() => sub.roomUpdates.length === 4, 2000, "turn completion + thread close");
  assert.deepEqual(sub.roomUpdates, [
    { reason: "thread", threadId: s.thread.id },
    { reason: "turn", threadId: s.thread.id },
    { reason: "turn", threadId: s.thread.id },
    { reason: "thread", threadId: s.thread.id },
  ]);
});

test("M3-A1 room/updated over stdio: only a subscribed connection receives its own updates, each turn update after its turn notification", async () => {
  const home = freshHome();
  writeSeat(home, "seat-a");
  for (const subscribe of [true, false]) {
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: Array<Record<string, unknown>> = [];
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      for (const l of chunk.split("\n")) if (l.trim()) lines.push(JSON.parse(l));
    });
    const conn = new EngineConnection({ input, output, home, agent: echoAgent, log: () => {} });
    conn.handleLine(
      JSON.stringify({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "s", version: "0" },
          capabilities: { subscribeRoom: subscribe },
        },
      }),
    );
    conn.handleLine(
      JSON.stringify({ id: 2, method: "thread/start", params: { seatId: "seat-a" } }),
    );
    const started = lines.find((m) => m.id === 2) as { result: { thread: { id: string } } };
    const threadId = started.result.thread.id;
    conn.handleLine(
      JSON.stringify({
        id: 3,
        method: "turn/start",
        params: { threadId, input: [{ type: "text", text: "hi" }] },
      }),
    );
    await waitFor(
      () => lines.some((m) => m.method === "turn/completed"),
      3000,
      `turn/completed (subscribeRoom: ${subscribe})`,
    );
    // Let anything queued after turn/completed land before reading the order.
    await new Promise((r) => setImmediate(r));
    const updates = lines.filter((m) => m.method === "room/updated");
    if (!subscribe) {
      assert.equal(updates.length, 0, "subscribeRoom:false receives nothing");
    } else {
      assert.deepEqual(
        updates.map((m) => m.params),
        [
          { reason: "thread", threadId },
          { reason: "turn", threadId },
          { reason: "turn", threadId },
        ],
      );
      // Pin §3 / Argus P2: each turn's room/updated follows its own turn notification.
      const at = (pred: (m: Record<string, unknown>) => boolean): number => lines.findIndex(pred);
      const turnStarted = at((m) => m.method === "turn/started");
      const turnCompleted = at((m) => m.method === "turn/completed");
      const turnUpdates = lines
        .map((m, i) => ({ m, i }))
        .filter(
          ({ m }) => m.method === "room/updated" && (m.params as RoomUpdate).reason === "turn",
        )
        .map(({ i }) => i);
      assert.equal(turnUpdates.length, 2);
      const [startUpdate = -1, completionUpdate = -1] = turnUpdates;
      assert.ok(turnStarted >= 0 && turnCompleted > turnStarted);
      assert.ok(turnStarted < startUpdate, "turn/started precedes the start room/updated");
      assert.ok(startUpdate < turnCompleted, "the start room/updated precedes turn/completed");
      assert.ok(
        turnCompleted < completionUpdate,
        "turn/completed precedes the completion room/updated",
      );
    }
    conn.shutdown();
  }
});

test("M3-A1 room/updated: a subscriber whose output is ending or destroyed receives none (amendment 1 §10.3)", () => {
  const home = freshHome();
  for (const state of ["open", "ending", "destroyed"] as const) {
    const writes: string[] = [];
    // A stub output: records every write attempt and reports the stream state under test.
    const output = {
      write: (chunk: string) => {
        writes.push(chunk);
        return true;
      },
      on: () => output,
      once: () => output,
      writableEnded: state === "ending",
      destroyed: state === "destroyed",
    } as unknown as Writable;
    const conn = new EngineConnection({
      input: new PassThrough(),
      output,
      home,
      agent: echoAgent,
      log: () => {},
    });
    const init = {
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "s", version: "0" }, capabilities: { subscribeRoom: true } },
    };
    // Initialize while the stub reports open, then switch it to the state under test.
    Object.assign(output, { writableEnded: false, destroyed: false });
    conn.handleLine(JSON.stringify(init));
    Object.assign(output, { writableEnded: state === "ending", destroyed: state === "destroyed" });
    writes.length = 0;
    conn.notifyRoomUpdated("thread", "thr_x");
    if (state === "open") {
      assert.equal(writes.length, 1);
      assert.deepEqual(JSON.parse(writes[0] ?? "{}"), {
        method: "room/updated",
        params: { reason: "thread", threadId: "thr_x" },
      });
    } else {
      assert.deepEqual(writes, [], `${state}: no room/updated is written`);
    }
  }
});

// ------------------------------------------------------------ read methods

const NEEDLE = "bulk_needle";

function writeFixtureSessions(home: string): void {
  const dir = join(home, "sessions");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const open = { cwd: null, backing: "kimi-code", providerId: "kimi-code", pinnedModel: "m" };
  const many = unguardedSessionWriterForTests.create(
    join(dir, "thr_many.jsonl"),
    "thr_many",
    "seat-a",
    open,
    () => [],
  );
  many.append("turn.start", { turnId: "turn_1", inputText: "start" });
  for (let i = 0; i < 230; i++) {
    many.append("item", {
      turnId: "turn_1",
      item: { id: `item_${i}`, kind: "agentMessage", status: "completed", text: `${NEEDLE} ${i}` },
    });
  }
  const other = unguardedSessionWriterForTests.create(
    join(dir, "thr_other.jsonl"),
    "thr_other",
    "seat-b",
    open,
    () => [],
  );
  other.append("turn.start", { turnId: "turn_1", inputText: `${NEEDLE} from seat b` });
  const long = `${"a".repeat(200)}\u0001\u001b[31m snippet_needle \u0007${"b".repeat(200)}`;
  other.append("item", {
    turnId: "turn_1",
    item: { id: "item_long", kind: "agentMessage", status: "completed", text: long },
  });
  other.append("item", {
    turnId: "turn_1",
    item: {
      id: "item_secret",
      kind: "agentMessage",
      status: "completed",
      text: `secret ghp_${"A1b2C3d4E5".repeat(4)} here`,
    },
  });
  writeFileSync(join(dir, "thr_corrupt.jsonl"), `{bad ${NEEDLE}\n`, { mode: 0o600 });
}

async function readClient(): Promise<SocketRpcClient> {
  const home = freshHome();
  writeFixtureSessions(home);
  const server = await start(home);
  const c = await connect(server.socketPath);
  await c.init("reader");
  return c;
}

test("M3-A1 session/search: limit defaults to 50, is capped at 200, and is honored below that", async () => {
  const c = await readClient();
  const search = async (params: Record<string, unknown>) =>
    ((await c.request("session/search", params)) as SessionSearchResult).matches;
  assert.equal((await search({ query: NEEDLE })).length, 50, "default 50");
  assert.equal((await search({ query: NEEDLE, limit: 500 })).length, 200, "capped at 200");
  assert.equal((await search({ query: NEEDLE, limit: 3 })).length, 3);
  assert.equal((await search({ query: NEEDLE, limit: 200 })).length, 200);
});

test("M3-A1 session/search: wrong-typed or out-of-range params are refused -32602 (never dropped)", async () => {
  const c = await readClient();
  for (const params of [
    { query: NEEDLE, limit: "1" },
    { query: NEEDLE, limit: null },
    { query: NEEDLE, limit: 0 },
    { query: NEEDLE, limit: -1 },
    { query: NEEDLE, limit: 1.5 },
    { query: NEEDLE, seatId: 5 },
    { query: NEEDLE, seatId: null },
    { query: NEEDLE, seatId: "bad id!" },
    { query: "   " },
    { query: "" },
    { query: 5 },
    {},
  ]) {
    await assert.rejects(() => c.request("session/search", params), rpcCode(-32602));
  }
});

test("M3-A1 session/search: seatId filters, the snippet is capped and control-free, [REDACTED] and unverified chains never match", async () => {
  const c = await readClient();
  const search = async (params: Record<string, unknown>) =>
    ((await c.request("session/search", params)) as SessionSearchResult).matches;

  const seatB = await search({ query: NEEDLE, seatId: "seat-b" });
  assert.deepEqual(
    seatB.map((m) => [m.threadId, m.seatId]),
    [["thr_other", "seat-b"]],
    "seatId filter",
  );
  assert.equal((await search({ query: NEEDLE, seatId: "seat-c" })).length, 0);

  const [snip] = await search({ query: "snippet_needle" });
  assert.ok(snip !== undefined);
  assert.ok(snip.snippet.length <= 160, `snippet length ${snip.snippet.length}`);
  assert.ok(snip.snippet.includes("snippet_needle"));
  // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting control bytes are stripped
  assert.doesNotMatch(snip.snippet, /[\u0000-\u001f\u007f]/);

  assert.equal((await search({ query: "REDACTED" })).length, 0);
  assert.equal((await search({ query: "ghp_" })).length, 0);
  assert.ok(
    !(await search({ query: NEEDLE, limit: 200 })).some((m) => m.threadId === "thr_corrupt"),
  );
  assert.ok((await search({ query: "bad" })).every((m) => m.threadId !== "thr_corrupt"));
});

test("M3-A1 session/read: verified events, chainOk:false for a broken chain, -32002 / -32602", async () => {
  const c = await readClient();
  const ok = (await c.request("session/read", { threadId: "thr_other" })) as SessionReadResult;
  assert.equal(ok.chainOk, true);
  assert.equal(ok.events.length, 4);
  const bad = (await c.request("session/read", { threadId: "thr_corrupt" })) as SessionReadResult;
  assert.deepEqual(bad, { threadId: "thr_corrupt", events: [], chainOk: false });
  await assert.rejects(
    () => c.request("session/read", { threadId: "thr_missing_read" }),
    rpcCode(-32002),
  );
  await assert.rejects(() => c.request("session/read", { threadId: "bad id!" }), rpcCode(-32602));
  await assert.rejects(() => c.request("session/read", {}), rpcCode(-32602));
});

/**
 * Amendment 1 §10.7: a key outside the method's params is `-32602` with one fixed issue that
 * never echoes the key (or its value), the same way `room/inspect` refuses (base pin line 22).
 */
function unknownKeyRefusal(issue: string): (err: unknown) => boolean {
  return (err) => {
    assert.ok(err instanceof RpcFailure, `expected an RPC error, got ${String(err)}`);
    assert.equal(err.code, -32602, err.message);
    assert.equal(err.rpcMessage, "Invalid params");
    assert.deepEqual(err.data, { issues: [issue] });
    for (const marker of ["SECRET_KEY_MARKER", "SECRET_VALUE_MARKER"]) {
      assert.ok(!err.raw.includes(marker), `the refusal echoed ${marker}: ${err.raw}`);
    }
    return true;
  };
}

test("M3-A1 session/search and session/read: unknown keys are -32602 and the key is never echoed (amendment 1 §10.7)", async () => {
  const c = await readClient();
  const searchIssue = "session/search takes only query, limit and seatId";
  for (const params of [
    { query: NEEDLE, SECRET_KEY_MARKER: "SECRET_VALUE_MARKER" },
    { query: NEEDLE, limit: 3, seatId: "seat-a", SECRET_KEY_MARKER_2: 1 },
    { SECRET_KEY_MARKER: "SECRET_VALUE_MARKER" }, // refused as unknown before query is checked
    JSON.parse(`{"query":"${NEEDLE}","__proto__":{"SECRET_KEY_MARKER":"SECRET_VALUE_MARKER"}}`),
    { query: NEEDLE, threadId: "thr_other" }, // session/read's key is not session/search's
  ]) {
    await assert.rejects(() => c.request("session/search", params), unknownKeyRefusal(searchIssue));
  }
  const readIssue = "session/read takes only threadId";
  for (const params of [
    { threadId: "thr_other", SECRET_KEY_MARKER: "SECRET_VALUE_MARKER" },
    { SECRET_KEY_MARKER: "SECRET_VALUE_MARKER" },
    JSON.parse(`{"threadId":"thr_other","__proto__":{"SECRET_KEY_MARKER":1}}`),
    { threadId: "thr_other", query: NEEDLE }, // session/search's key is not session/read's
  ]) {
    await assert.rejects(() => c.request("session/read", params), unknownKeyRefusal(readIssue));
  }
  // Known keys alone still answer (the guard narrows nothing the pin allows).
  const ok = (await c.request("session/search", {
    query: NEEDLE,
    limit: 2,
    seatId: "seat-a",
  })) as SessionSearchResult;
  assert.ok(ok.matches.length > 0);
  const read = (await c.request("session/read", { threadId: "thr_other" })) as SessionReadResult;
  assert.equal(read.chainOk, true);
});

test("M3-A1 room/inspect: {} returns the room report; unknown keys are -32602", async () => {
  const c = await readClient();
  const res = (await c.request("room/inspect", {})) as { room: RoomReport };
  assert.equal(typeof res.room.counts.threads, "number");
  await assert.rejects(() => c.request("room/inspect", { x: 1 }), rpcCode(-32602));
  await assert.rejects(
    () => c.request("room/inspect", { SECRET_KEY_MARKER: "SECRET_VALUE_MARKER" }),
    unknownKeyRefusal("room/inspect takes no params"),
  );
});
