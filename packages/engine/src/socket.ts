/**
 * M3-A1 (`docs/plan/PIN-madc-M3-desktop-protocol.md` §1): local-socket JSONL transport
 * (`$MADC_HOME/engine.sock` on POSIX, `0600` owner-only; named pipe on Windows).
 */
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, type Stats, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { enforcePrivateDir } from "./home.ts";
import { EngineConnection, type EngineOptions, type RoomUpdateReason } from "./server.ts";

/** How long the stale-socket probe `connect()` may take before startup refuses (pin §1). */
export const SOCKET_PROBE_TIMEOUT_MS = 1000;

/**
 * Test seams for the socket transport. Production never passes them: the defaults are the real
 * `chmodSync`, `createConnection` and {@link SOCKET_PROBE_TIMEOUT_MS}.
 */
export type SocketServerDeps = {
  readonly chmod?: (path: string, mode: number) => void;
  readonly connect?: (path: string) => Socket;
  readonly probeTimeoutMs?: number;
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
 * - `stat-failed`: the path could not be `lstat`ed for a reason other than "absent".
 * - `listen-failed`: binding the socket failed (for example `EADDRINUSE` after a race).
 * - `chmod-failed`: the bound socket could not be made `0600` (fail closed: nothing is served).
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
  constructor(kind: SocketStartRefusal, socketPath: string, detail: string) {
    super(`engine socket ${kind}: ${detail} (${socketPath})`);
    this.name = "SocketStartError";
    this.kind = kind;
    this.socketPath = socketPath;
  }
}

/**
 * Canonical local socket / pipe path for `$MADC_HOME` (`PIN-madc-M3-desktop-protocol.md` §1).
 */
export function engineSocketPath(home: string): string {
  if (process.platform === "win32") {
    const hash = createHash("sha256").update(home).digest("hex").slice(0, 16);
    return `\\\\.\\pipe\\madc-${hash}`;
  }
  return join(home, "engine.sock");
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
 */
async function clearStaleSocket(socketPath: string, deps: SocketServerDeps): Promise<void> {
  let st: Stats | null;
  try {
    st = lstatOrNull(socketPath);
  } catch (err) {
    throw new SocketStartError("stat-failed", socketPath, `lstat failed (${errCode(err) ?? err})`);
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
  let now: Stats | null;
  try {
    now = lstatOrNull(socketPath);
  } catch (err) {
    throw new SocketStartError("stat-failed", socketPath, `lstat failed (${errCode(err) ?? err})`);
  }
  if (now === null) return; // Gone already (another engine's cleanup): nothing to unlink.
  if (!now.isSocket() || now.dev !== st.dev || now.ino !== st.ino) {
    throw new SocketStartError("replaced", socketPath, "socket path changed during the probe");
  }
  if (outcome.code !== "ECONNREFUSED" && outcome.code !== "ENOENT") {
    throw new SocketStartError(
      "probe-failed",
      socketPath,
      `probe connect failed with ${outcome.code ?? "an unknown error"}; not unlinking`,
    );
  }
  try {
    unlinkSync(socketPath);
  } catch (err) {
    if (errCode(err) === "ENOENT") return;
    throw new SocketStartError("stat-failed", socketPath, `unlink failed (${errCode(err) ?? err})`);
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

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      reject(
        new SocketStartError("listen-failed", socketPath, `listen failed (${errCode(err) ?? err})`),
      );
    };
    server.once("error", onError);
    server.listen(socketPath, () => {
      server.removeListener("error", onError);
      resolve();
    });
  });

  if (process.platform !== "win32") {
    try {
      (socketDeps.chmod ?? chmodSync)(socketPath, 0o600);
      const st = lstatSync(socketPath);
      if (!st.isSocket() || (st.mode & 0o777) !== 0o600) {
        throw new Error(`mode is ${(st.mode & 0o777).toString(8)}, not 600`);
      }
    } catch (err) {
      // Fail closed: nothing is served on a socket that is not owner-only. Any connection that
      // arrived in the bind-to-chmod window is shut down and destroyed before the server closes.
      for (const c of conns) c.shutdown();
      for (const s of sockets) {
        if (!s.destroyed) s.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try {
        if (lstatSync(socketPath).isSocket()) unlinkSync(socketPath);
      } catch {
        // Already removed (Node unlinks a Unix socket on close).
      }
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
      for (const c of conns) c.shutdown();
      for (const s of sockets) {
        if (!s.destroyed) s.destroy();
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      if (process.platform !== "win32") {
        try {
          const st = lstatSync(socketPath);
          if (st.isSocket()) unlinkSync(socketPath);
        } catch {
          // Already removed.
        }
      }
    },
  };
}
