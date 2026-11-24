/**
 * M3-A1 (`docs/plan/PIN-madc-M3-desktop-protocol.md` §1): local-socket JSONL transport
 * (`$MADC_HOME/engine.sock` on POSIX, `0600` owner-only; named pipe on Windows).
 */
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { enforcePrivateDir } from "./home.ts";
import { EngineConnection, type EngineOptions, type RoomUpdateReason } from "./server.ts";

export type SocketServerOptions = Omit<EngineOptions, "input" | "output">;

export type SocketServerHandle = {
  readonly socketPath: string;
  close(): Promise<void>;
};

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

function probeSocketAlive(sockPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const client = createConnection(sockPath);
    client.once("connect", () => {
      client.destroy();
      resolve(true);
    });
    client.once("error", () => {
      client.destroy();
      resolve(false);
    });
  });
}

/**
 * Start the local-socket JSONL server for `home`. Refuses symlinks and live listeners; unlinks
 * stale sockets only when a probe `connect()` fails (`ECONNREFUSED`).
 */
export async function startSocketServer(opts: SocketServerOptions): Promise<SocketServerHandle> {
  mkdirSync(opts.home, { recursive: true, mode: 0o700 });
  enforcePrivateDir(opts.home);
  const socketPath = engineSocketPath(opts.home);

  if (process.platform !== "win32") {
    let exists = false;
    let isSym = false;
    try {
      const st = lstatSync(socketPath);
      exists = true;
      isSym = st.isSymbolicLink();
    } catch {
      exists = false;
    }
    if (isSym) {
      throw new Error(`refusing symlink at socket path: ${socketPath}`);
    }
    if (exists) {
      const alive = await probeSocketAlive(socketPath);
      if (alive) {
        throw new Error(`socket already in use by a live engine: ${socketPath}`);
      }
      unlinkSync(socketPath);
    }
  }

  const conns = new Set<EngineConnection>();
  const broadcast = (event: { readonly reason: RoomUpdateReason; readonly threadId: string }) => {
    for (const c of conns) {
      c.notifyRoomUpdated(event.reason, event.threadId);
    }
  };

  const server: Server = createServer((socket: Socket) => {
    const conn = new EngineConnection({
      ...opts,
      input: socket,
      output: socket,
      onRoomUpdated: broadcast,
    });
    conns.add(conn);
    void conn.run().finally(() => {
      conns.delete(conn);
      conn.releaseLocks();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      if (process.platform !== "win32") {
        try {
          chmodSync(socketPath, 0o600);
        } catch {
          // Best effort if socket vanished during shutdown.
        }
      }
      resolve();
    });
  });

  return {
    socketPath,
    async close(): Promise<void> {
      for (const c of conns) c.shutdown();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      if (process.platform !== "win32") {
        try {
          const st = lstatSync(socketPath);
          if (!st.isSymbolicLink()) unlinkSync(socketPath);
        } catch {
          // Already removed.
        }
      }
    },
  };
}
