/**
 * M3-A1 (`docs/plan/PIN-madc-M3-desktop-protocol.md`): local-socket JSONL transport
 * (`$MADC_HOME/engine.sock`), `room/inspect`, `session/search`, `session/read`, and `room/updated`.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { echoAgent } from "./agent.ts";
import type { RoomReport } from "./inspect.ts";
import type { SessionReadResult, SessionSearchResult } from "./search.ts";
import { engineSocketPath, startSocketServer } from "./socket.ts";
import { makeHome, writeSeatFile } from "./testing/harness.ts";

class SocketRpcClient {
  readonly #socket: Socket;
  #nextId = 1;
  readonly #pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  readonly #listeners: Array<(n: { method: string; params: unknown }) => void> = [];

  constructor(socket: Socket) {
    this.#socket = socket;
    createInterface({ input: socket, crlfDelay: Number.POSITIVE_INFINITY }).on("line", (line) => {
      if (!line.trim()) return;
      const msg = JSON.parse(line) as Record<string, unknown>;
      if (typeof msg.id === "number") {
        const p = this.#pending.get(msg.id);
        if (!p) return;
        this.#pending.delete(msg.id);
        if (msg.error !== undefined) {
          const err = msg.error as { code?: number; message?: string };
          p.reject(new Error(`RPC ${err.code}: ${err.message}`));
        } else {
          p.resolve(msg.result);
        }
      } else if (typeof msg.method === "string") {
        for (const l of this.#listeners) l({ method: msg.method, params: msg.params });
      }
    });
  }

  onNotification(fn: (n: { method: string; params: unknown }) => void): void {
    this.#listeners.push(fn);
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#socket.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.#socket.end(() => resolve()));
  }
}

async function connectSocketClient(sockPath: string): Promise<SocketRpcClient> {
  const socket = createConnection(sockPath);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
  });
  return new SocketRpcClient(socket);
}

test("M3-A1 socket server: binds 0600 socket, serves concurrent clients, broadcasts room/updated, and supports room/inspect, session/search, session/read", async () => {
  const { home, cleanup } = makeHome();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeSeatFile(home, {
    id: "seat-a",
    version: 2,
    displayName: "Seat A",
    role: "builder",
    standingInstructions: "test",
    pinnedModel: "kimi-coding/kimi-for-coding",
    preferredBacking: "kimi-code",
    fallbacks: [],
    memory: { mode: "in-session" },
    tools: { deny: [] },
    policy: { headlessOk: true },
    handoffs: { enabled: true, targets: ["seat-a"] },
  });

  const server = await startSocketServer({ home, agent: echoAgent, log: () => {} });
  try {
    assert.equal(server.socketPath, engineSocketPath(home));
    if (process.platform !== "win32") {
      const mode = statSync(server.socketPath).mode & 0o777;
      assert.equal(mode, 0o600);
    }

    // Symlink and live-listener refusals.
    await assert.rejects(
      () => startSocketServer({ home, agent: echoAgent, log: () => {} }),
      /already in use/,
    );

    const c1 = await connectSocketClient(server.socketPath);
    const c2 = await connectSocketClient(server.socketPath);
    const c2Updates: Array<{ reason: string; threadId: string }> = [];
    const c1Updates: Array<{ reason: string; threadId: string }> = [];
    c1.onNotification((n) => {
      if (n.method === "room/updated")
        c1Updates.push(n.params as { reason: string; threadId: string });
    });
    c2.onNotification((n) => {
      if (n.method === "room/updated")
        c2Updates.push(n.params as { reason: string; threadId: string });
    });

    try {
      await c1.request("initialize", { clientInfo: { name: "c1", version: "0" } });
      await c2.request("initialize", {
        clientInfo: { name: "c2", version: "0" },
        capabilities: { subscribeRoom: true },
      });

      const s1 = (await c1.request("thread/start", { seatId: "seat-a" })) as {
        thread: { id: string };
      };
      const thrId = s1.thread.id;

      // Turn with both searchable text and a ghp_ token (which redactor replaces with [REDACTED]).
      const t1 = (await c1.request("turn/start", {
        threadId: thrId,
        input: [{ type: "text", text: `findme_needle_alpha ghp_${"A1b2C3d4E5".repeat(4)}` }],
      })) as { turn: { id: string } };
      await new Promise((r) => setTimeout(r, 80));

      await c1.request("thread/handoff", {
        threadId: thrId,
        targetSeatId: "seat-a",
        brief: "handoff_needle_beta",
        turnId: t1.turn.id,
      });

      await c1.request("decision/raise", {
        threadId: thrId,
        turnId: t1.turn.id,
        question: "Proceed with M3?",
        recommendedDefault: "Yes",
        evidenceRefs: [
          { kind: "git", sha: "b0db17bfc94d3bd3b60af5a3f61e499c9c11a9a7", remote: null },
        ],
      });

      // Wait briefly for notifications to flush.
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(c1Updates.length, 0, "unsubscribed client receives no room/updated");
      assert.ok(c2Updates.some((u) => u.reason === "thread" && u.threadId === thrId));
      assert.ok(c2Updates.some((u) => u.reason === "handoff"));
      assert.ok(c2Updates.some((u) => u.reason === "decision" && u.threadId === thrId));

      // Write a corrupt session file to verify search skips unverified files.
      writeFileSync(join(home, "sessions", "thr_corrupt_search.jsonl"), "{bad\n", { mode: 0o600 });

      const roomRes = (await c2.request("room/inspect", {})) as { room: RoomReport };
      assert.equal(roomRes.room.counts.threads, 3);
      assert.equal(roomRes.room.counts.openDecisions, 1);

      const searchRes = (await c2.request("session/search", {
        query: "findme_needle_alpha",
      })) as SessionSearchResult;
      assert.ok(searchRes.matches.length >= 1);
      assert.equal(searchRes.matches[0]?.threadId, thrId);

      // `[REDACTED]` never matches.
      const redactedSearch = (await c2.request("session/search", {
        query: "REDACTED",
      })) as SessionSearchResult;
      assert.equal(redactedSearch.matches.length, 0);

      // Blank query refuses -32602.
      await assert.rejects(() => c2.request("session/search", { query: "   " }));

      // session/read returns verified events, refuses -32002 on missing thread.
      const readRes = (await c2.request("session/read", { threadId: thrId })) as SessionReadResult;
      assert.equal(readRes.chainOk, true);
      assert.ok(readRes.events.length >= 4);
      await assert.rejects(() => c2.request("session/read", { threadId: "thr_missing_read" }));
    } finally {
      await c1.close();
      await c2.close();
    }
  } finally {
    await server.close();
    assert.equal(existsSync(server.socketPath), false, "close unlinks socket");

    // Stale socket recovery + symlink refusal on POSIX.
    if (process.platform !== "win32") {
      const dummy = createServer();
      await new Promise<void>((r) => dummy.listen(server.socketPath, () => r()));
      await new Promise<void>((r) => dummy.close(() => r()));
      // Re-create a stale socket file via symlink check:
      const symHome = `${home}-sym`;
      mkdirSync(symHome, { recursive: true, mode: 0o700 });
      symlinkSync("/tmp/nonexistent-sock-target", engineSocketPath(symHome));
      await assert.rejects(
        () => startSocketServer({ home: symHome, agent: echoAgent, log: () => {} }),
        /symlink/,
      );
      rmSync(symHome, { recursive: true, force: true });
    }
    cleanup();
  }
});
