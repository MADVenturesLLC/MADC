/**
 * M3-A1 (`docs/plan/PIN-madc-M3-desktop-protocol.md` §1): local-socket JSONL transport
 * (`$MADC_HOME/engine.sock` on POSIX, `0600` owner-only; named pipe on Windows).
 */
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, realpathSync, type Stats, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { enforcePrivateDir } from "./home.ts";
import { EngineConnection, type EngineOptions, type RoomUpdateReason } from "./server.ts";

/**
 * Per-socket flush grace at shutdown (amendment 1 §3 step 3): after `end()`, a client socket is
 * destroyed on `finish` or after this long, whichever comes first (the stdio engine's 2 s flush
 * bound, `main.ts:301`).
 */
export const SOCKET_CLOSE_GRACE_MS = 2000;

/** How long the stale-socket probe `connect()` may take before startup refuses (pin §1). */
export const SOCKET_PROBE_TIMEOUT_MS = 1000;

/**
 * Longest socket path, in bytes, that fits `sockaddr_un.sun_path` with its terminating NUL: 108
 * bytes on Linux, 104 on macOS, the BSDs and other POSIX (amendment 1 §4 "Listen", rev 6: a byte
 * length of 104 / 108 or more is refused). Checked before `listen()` because runtimes disagree: on
 * this box Node 22.19.0 binds a 108-byte path (which a Python client cannot reach) and a truncated
 * name for a longer one, Bun 1.3.11 and 1.4.2 fail the bind, and Bun 1.4.4 listens (Argus probe).
 */
export const SOCKET_PATH_MAX_BYTES = process.platform === "linux" ? 107 : 103;

/**
 * Test seams for the socket transport. Production never passes them: the defaults are the real
 * `chmodSync`, `createConnection`, {@link SOCKET_PROBE_TIMEOUT_MS}, `unlinkSync`, `process.getuid`
 * and {@link SOCKET_CLOSE_GRACE_MS}.
 */
export type SocketServerDeps = {
  readonly chmod?: (path: string, mode: number) => void;
  readonly connect?: (path: string) => Socket;
  readonly probeTimeoutMs?: number;
  readonly unlink?: (path: string) => void;
  readonly getuid?: () => number;
  readonly closeGraceMs?: number;
};

export type SocketServerOptions = Omit<EngineOptions, "input" | "output"> & {
  readonly socketDeps?: SocketServerDeps;
};

export type SocketServerHandle = {
  readonly socketPath: string;
  close(): Promise<void>;
};

/**
 * Why `startSocketServer` refused to start. Every refusal leaves whatever was at the socket path
 * untouched, except `chmod-failed`, which removes only the socket this call itself bound.
 *
 * - `symlink`: the path is a symlink (pin §1: never followed, never unlinked).
 * - `not-socket`: the path is a regular file, directory or other non-socket; never unlinked.
 * - `live`: a probe `connect()` was answered by a listener.
 * - `probe-timeout`: the probe neither connected nor failed within the timeout.
 * - `probe-failed`: the probe failed with an error that does not prove the socket stale.
 * - `replaced`: the path changed between the check and the unlink (another engine raced us).
 * - `stat-failed`: the path could not be `lstat`ed for a reason other than "absent", or a socket
 *   judged stale could not be unlinked for a reason other than "absent" (it is left in place).
 * - `listen-failed`: binding the socket failed (for example `EADDRINUSE` after a race), or the
 *   socket path is longer than {@link SOCKET_PATH_MAX_BYTES} (checked before `listen()`).
 * - `chmod-failed`: the bound socket could not be made `0600`, or is not owned by this process's
 *   uid (fail closed: nothing is served).
 */
export type SocketStartRefusal =
  | "symlink"
  | "not-socket"
  | "live"
  | "probe-timeout"
  | "probe-failed"
  | "replaced"
  | "stat-failed"
  | "listen-failed"
  | "chmod-failed";

export class SocketStartError extends Error {
  readonly kind: SocketStartRefusal;
  readonly socketPath: string;
  /**
   * The errno behind the refusal (`EADDRINUSE`, `EACCES`, …) when there is one: set for
   * `listen-failed`, `probe-failed` and `stat-failed` (Argus #73 P4), so a caller can map
   * `listen-failed` + `EADDRINUSE` (amendment 1 §6: exit 20) without parsing the message.
   */
  readonly code: string | undefined;
  constructor(kind: SocketStartRefusal, socketPath: string, detail: string, code?: string) {
    super(`engine socket ${kind}: ${detail} (${socketPath})`);
    this.name = "SocketStartError";
    this.kind = kind;
    this.socketPath = socketPath;
    this.code = code;
  }
}

/**
 * Canonical local socket / pipe path for `$MADC_HOME` (`PIN-madc-M3-desktop-protocol.md` §1).
 */
export function engineSocketPath(home: string): string {
  if (process.platform === "win32") return enginePipeName(home);
  return join(home, "engine.sock");
}

/**
 * Windows pipe name for `$MADC_HOME` (amendment 1 §4 "Windows"): the hash of the home's **real
 * path** (`fs.realpathSync.native`), so two spellings of one home name one pipe. The home must
 * exist: an absent home throws `ENOENT`, which means no listener (amendment 1 §2: the launcher then
 * spawns `serve`, which creates the home). `realpath` is a test seam; production passes nothing.
 */
export function enginePipeName(
  home: string,
  realpath: (path: string) => string = realpathSync.native,
): string {
  const hash = createHash("sha256").update(realpath(home)).digest("hex").slice(0, 16);
  return `\\\\.\\pipe\\madc-${hash}`;
}

function errCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (err) {
    if (errCode(err) === "ENOENT") return null;
    throw err;
  }
}

/**
 * `end()` then `destroy()` on `finish` or after `graceMs`, whichever first; resolves once the
 * socket is closed. Never `destroy()` straight after `end()`: that discards unflushed writes.
 */
function endThenDestroy(sock: Socket, graceMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    if (sock.destroyed) {
      resolve();
      return;
    }
    const timer = setTimeout(() => sock.destroy(), graceMs);
    const done = (): void => {
      clearTimeout(timer);
      if (!sock.destroyed) sock.destroy();
      resolve();
    };
    sock.once("close", done);
    sock.once("finish", done);
    sock.once("error", done);
    // Already ended and flushed (the connection's own run() ended it): nothing left to flush.
    if (sock.writableFinished) done();
    else sock.end();
  });
}

function describe(st: Stats): string {
  if (st.isDirectory()) return "a directory";
  if (st.isFile()) return "a regular file";
  if (st.isFIFO()) return "a FIFO";
  if (st.isCharacterDevice() || st.isBlockDevice()) return "a device";
  return "not a socket";
}

type ProbeOutcome =
  | { readonly kind: "live" }
  | { readonly kind: "error"; readonly code: string | undefined }
  | { readonly kind: "timeout" };

/** One bounded `connect()` against `sockPath`. Always settles; the probe socket is destroyed. */
function probeSocket(
  sockPath: string,
  connect: (path: string) => Socket,
  timeoutMs: number,
): Promise<ProbeOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    let client: Socket | null = null;
    const finish = (outcome: ProbeOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client?.destroy();
      resolve(outcome);
    };
    const timer = setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
    try {
      client = connect(sockPath);
    } catch (err) {
      finish({ kind: "error", code: errCode(err) });
      return;
    }
    client.once("connect", () => finish({ kind: "live" }));
    client.once("error", (err) => finish({ kind: "error", code: errCode(err) }));
  });
}

/**
 * Pin §1 stale-socket rule. Returns once the path is free to bind (absent, or a proven-stale socket
 * that this call unlinked); throws {@link SocketStartError} otherwise, leaving the path untouched.
 *
 * Only a real socket is ever probed or unlinked. It is stale only when the probe `connect()` fails
 * with `ECONNREFUSED`, or with `ENOENT` while the same socket (same dev + inode) is still at the
 * path: Bun 1.3.11 reports a listener-less socket as `ENOENT` where Node 22 and Bun 1.4.x report
 * `ECONNREFUSED`. Every other outcome refuses. The dev + inode are re-checked just before the
 * unlink, so a socket another engine bound in the meantime is never removed.
 *
 * Known gap (Argus #73 P5, `logs/pr73-5ea/argus-dbl.mjs`): on Bun 1.3.11 (CI) a second `listen()`
 * on a path where a live engine is listening **succeeds and replaces that socket** (new inode)
 * instead of failing `EADDRINUSE` as Node 22 and Bun 1.4.x do. So under Bun 1.3.11 a listener
 * that binds between this probe and our `listen()` is hijacked, not refused, and amendment 1 §6's
 * `EADDRINUSE` → 20 cannot occur. Only `engine.lock` (amendment 1 §2a, not built in this act)
 * closes that race for `serve` against `serve`.
 */
async function clearStaleSocket(socketPath: string, deps: SocketServerDeps): Promise<void> {
  let st: Stats | null;
  try {
    st = lstatOrNull(socketPath);
  } catch (err) {
    throw new SocketStartError(
      "stat-failed",
      socketPath,
      `lstat failed (${errCode(err) ?? err})`,
      errCode(err),
    );
  }
  if (st === null) return;
  if (st.isSymbolicLink()) {
    throw new SocketStartError("symlink", socketPath, "refusing symlink at socket path");
  }
  if (!st.isSocket()) {
    throw new SocketStartError(
      "not-socket",
      socketPath,
      `refusing to replace ${describe(st)} at the socket path`,
    );
  }
  const timeoutMs = deps.probeTimeoutMs ?? SOCKET_PROBE_TIMEOUT_MS;
  const outcome = await probeSocket(socketPath, deps.connect ?? createConnection, timeoutMs);
  if (outcome.kind === "live") {
    throw new SocketStartError("live", socketPath, "socket already in use by a live engine");
  }
  if (outcome.kind === "timeout") {
    throw new SocketStartError(
      "probe-timeout",
      socketPath,
      `probe connect did not settle within ${timeoutMs}ms; not unlinking`,
    );
  }
  // Amendment 1 §4 step 4: only ECONNREFUSED / ENOENT judge the socket stale; any other probe
  // error refuses, even if the path has vanished meanwhile (Argus Info: 5ea215b bound anyway).
  if (outcome.code !== "ECONNREFUSED" && outcome.code !== "ENOENT") {
    throw new SocketStartError(
      "probe-failed",
      socketPath,
      `probe connect failed with ${outcome.code ?? "an unknown error"}; not unlinking`,
      outcome.code,
    );
  }
  let now: Stats | null;
  try {
    now = lstatOrNull(socketPath);
  } catch (err) {
    throw new SocketStartError(
      "stat-failed",
      socketPath,
      `lstat failed (${errCode(err) ?? err})`,
      errCode(err),
    );
  }
  if (now === null) return; // Gone already (another engine's cleanup): nothing to unlink.
  if (!now.isSocket() || now.dev !== st.dev || now.ino !== st.ino) {
    throw new SocketStartError("replaced", socketPath, "socket path changed during the probe");
  }
  try {
    (deps.unlink ?? unlinkSync)(socketPath);
  } catch (err) {
    // Gone meanwhile: free to bind. Any other failure refuses; the stale socket stays put.
    if (errCode(err) === "ENOENT") return;
    throw new SocketStartError(
      "stat-failed",
      socketPath,
      `unlink failed (${errCode(err) ?? err})`,
      errCode(err),
    );
  }
}

/**
 * Start the local-socket JSONL server for `home`. Refuses symlinks, non-socket files and live
 * listeners; unlinks a stale socket only under the pin §1 rule (see `clearStaleSocket`). On POSIX
 * the bound socket must end up `0600`, or the listener is closed and startup refuses
 * (`chmod-failed`).
 */
export async function startSocketServer(opts: SocketServerOptions): Promise<SocketServerHandle> {
  const { socketDeps = {}, ...engineOpts } = opts;
  mkdirSync(engineOpts.home, { recursive: true, mode: 0o700 });
  enforcePrivateDir(engineOpts.home);
  const socketPath = engineSocketPath(engineOpts.home);

  if (process.platform !== "win32") {
    await clearStaleSocket(socketPath, socketDeps);
    // Amendment 1 §4 "Listen", first step (rev 6 at 8bfd86d): before `listen()`, a path whose byte
    // length leaves no room for sun_path's terminating NUL (>= 108 on Linux, >= 104 elsewhere) is
    // refused, reason `socket path too long` (§6: 22). Runtime-independent: Bun listens on such a
    // path and Node truncates or answers EINVAL (Argus `logs/amend1/longpath-boundary.log`).
    const bytes = Buffer.byteLength(socketPath, "utf8");
    if (bytes > SOCKET_PATH_MAX_BYTES) {
      throw new SocketStartError(
        "listen-failed",
        socketPath,
        `socket path too long (${bytes} bytes, limit ${SOCKET_PATH_MAX_BYTES})`,
      );
    }
  }

  const conns = new Set<EngineConnection>();
  const sockets = new Set<Socket>();
  const broadcast = (event: { readonly reason: RoomUpdateReason; readonly threadId: string }) => {
    for (const c of conns) {
      c.notifyRoomUpdated(event.reason, event.threadId);
    }
  };

  const server: Server = createServer((socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    const conn = new EngineConnection({
      ...engineOpts,
      input: socket,
      output: socket,
      onRoomUpdated: broadcast,
    });
    conns.add(conn);
    void conn.run().finally(() => {
      conns.delete(conn);
      conn.releaseLocks();
      if (!socket.destroyed) socket.end();
    });
  });

  // Amendment 1 §4 "Listen … under umask 0o177" (Argus #73 P3a): the socket never exists at a
  // wider mode than 0600. The previous umask is restored straight after the bind, in the callback
  // or the error handler, before anything else is created.
  const posix = process.platform !== "win32";
  let restoreUmask: (() => void) | null = null;
  if (posix) {
    const previous = process.umask(0o177);
    restoreUmask = () => {
      process.umask(previous);
      restoreUmask = null;
    };
  }
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      restoreUmask?.();
      reject(
        new SocketStartError(
          "listen-failed",
          socketPath,
          `listen failed (${errCode(err) ?? err})`,
          errCode(err),
        ),
      );
    };
    server.once("error", onError);
    server.listen(socketPath, () => {
      restoreUmask?.();
      server.removeListener("error", onError);
      resolve();
    });
  });

  // The identity of the socket this call bound (Argus #73 P3c, amendment 1 §3 step 5 / §8):
  // only a socket with this dev + ino is ever unlinked by the fail-closed path or by close().
  let bound: { readonly dev: number; readonly ino: number } | null = null;
  const unlinkOwnSocket = (): void => {
    if (!posix || bound === null) return;
    try {
      const now = lstatSync(socketPath);
      if (now.isSocket() && now.dev === bound.dev && now.ino === bound.ino) {
        unlinkSync(socketPath);
      }
    } catch {
      // Already removed (Node and Bun 1.4.x unlink a Unix socket path in `server.close()`).
    }
  };

  /**
   * Amendment 1 §3 steps 1-4 (Argus #73 P1): stop accepting, shut every connection down (which
   * queues its last frames, such as an interrupted `turn/completed` and the thread-close
   * `room/updated` to the other subscribers), then `end()` each client socket and `destroy()` it on
   * its `finish` or after a per-socket {@link SOCKET_CLOSE_GRACE_MS} grace, whichever comes first,
   * and only then await `server.close()`. `destroy()` straight away would discard queued writes;
   * the grace keeps the `6e20176` no-hang guarantee for clients that never read.
   */
  const closeGraceMs = socketDeps.closeGraceMs ?? SOCKET_CLOSE_GRACE_MS;
  const shutdownAll = async (): Promise<void> => {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    for (const c of conns) c.shutdown();
    await Promise.all([...sockets].map((sock) => endThenDestroy(sock, closeGraceMs)));
    await closed;
  };

  if (posix) {
    try {
      const st0 = lstatSync(socketPath);
      bound = { dev: st0.dev, ino: st0.ino };
      (socketDeps.chmod ?? chmodSync)(socketPath, 0o600);
      const st = lstatSync(socketPath);
      if (!st.isSocket() || st.dev !== bound.dev || st.ino !== bound.ino) {
        throw new Error("the bound socket was replaced before the mode check");
      }
      if ((st.mode & 0o777) !== 0o600) {
        throw new Error(`mode is ${(st.mode & 0o777).toString(8)}, not 600`);
      }
      // Amendment 1 §4 step 5 (Argus #73 P3b): the bound socket must be owned by this uid.
      const uid = (socketDeps.getuid ?? process.getuid)?.();
      if (uid === undefined || st.uid !== uid) {
        throw new Error(`owner uid is ${st.uid}, not ${uid ?? "unknown"}`);
      }
    } catch (err) {
      // Fail closed: nothing is served on a socket that is not owner-only. Any connection that
      // arrived in the bind-to-check window goes through the same shutdown as close().
      await shutdownAll();
      unlinkOwnSocket();
      throw new SocketStartError(
        "chmod-failed",
        socketPath,
        `could not make the socket 0600 (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }

  return {
    socketPath,
    async close(): Promise<void> {
      await shutdownAll();
      unlinkOwnSocket();
    },
  };
}
