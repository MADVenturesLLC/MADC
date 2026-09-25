/**
 * A2 acceptance (protocol pin §8) — engine runs as a child process over stdio JSONL.
 * No live providers: the default engine uses the fake echo agent; fixtures supply hang/fail agents.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { EngineExitedError, spawnEngine } from "./client.ts";
import { ErrorCode } from "./protocol/errors.ts";
import { ID_PATTERN } from "./protocol/ids.ts";
import type { AgentMessageItem, UserMessageItem } from "./protocol/types.ts";
import {
  EXIT_ENGINE,
  expectRpcError,
  FAILING_ENGINE,
  HANG_ENGINE,
  handshake,
  makeHome,
  startEngine,
  startEngineCapturingStderr,
  withEngine,
} from "./testing/harness.ts";

// §8.1 -----------------------------------------------------------------------
test("§8.1 initialize / initialized handshake; second initialize → -32001", async () => {
  await withEngine(async (client) => {
    const result = await handshake(client);
    assert.deepEqual(result, {
      serverInfo: { name: "madc-engine", version: "0.0.0" },
      protocolVersion: "madc-m0/1",
    });
    const again = await expectRpcError(
      client.request("initialize", { clientInfo: { name: "x", version: "1" } }),
    );
    assert.equal(again.code, ErrorCode.AlreadyInitialized);
    assert.equal(again.code, -32001);
    assert.deepEqual(client.protocolViolations, []);
  });
});

test("initialize validates clientInfo → -32602", async () => {
  await withEngine(async (client) => {
    const err = await expectRpcError(client.request("initialize", {} as never));
    assert.equal(err.code, -32602);
    assert.ok(Array.isArray(err.data?.issues));
  });
});

// §8.2 -----------------------------------------------------------------------
test("§8.2 round trip: thread/start → turn/start → userMessage + agentMessage → turn/completed(completed)", async () => {
  await withEngine(async (client, home) => {
    await handshake(client);

    const { thread } = await client.request("thread/start", { cwd: "/tmp/project" });
    assert.match(thread.id, ID_PATTERN);
    assert.ok(thread.id.startsWith("thr_"));
    assert.equal(thread.seatId, "madc-default");
    assert.equal(thread.cwd, "/tmp/project");
    assert.equal(thread.status, "idle");
    assert.equal(thread.preview, "");
    const started = await client.waitForNotification("thread/started");
    assert.equal(started.thread.id, thread.id);

    // Cross-process ownership: lock file { pid, startedAt, token } held by this engine (§3.3).
    const lockPath = join(home, "sessions", `${thread.id}.lock`);
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    assert.deepEqual(Object.keys(lock).sort(), ["pid", "startedAt", "token"]);
    assert.equal(lock.pid, client.pid);
    assert.equal(typeof lock.startedAt, "number");
    assert.match(lock.token, /^[0-9a-f]{32}$/);

    const { turn } = await client.request("turn/start", {
      threadId: thread.id,
      input: [{ type: "text", text: "hello madc engine" }],
    });
    assert.equal(turn.status, "inProgress");
    assert.deepEqual(turn.items, []);
    assert.equal(turn.threadId, thread.id);
    assert.equal(turn.error, null);
    assert.equal(turn.completedAt, null);

    const done = await client.waitForNotification("turn/completed", (p) => p.turn.id === turn.id);
    assert.equal(done.turn.status, "completed");
    assert.equal(done.turn.error, null);
    assert.equal(typeof done.turn.completedAt, "number");
    assert.equal(done.turn.items.length, 2);
    const [user, agent] = done.turn.items as [UserMessageItem, AgentMessageItem];
    assert.equal(user.kind, "userMessage");
    assert.equal(user.status, "completed");
    assert.deepEqual(user.content, [{ type: "text", text: "hello madc engine" }]);
    assert.equal(agent.kind, "agentMessage");
    assert.equal(agent.status, "completed");
    assert.equal(agent.text, "hello madc engine");

    // Notification order for this turn.
    const seq = client.notifications
      .filter((n) => {
        const p = n.params as { turnId?: string; turn?: { id: string } };
        return p.turnId === turn.id || p.turn?.id === turn.id;
      })
      .map((n) => {
        const p = n.params as { item?: { kind: string } };
        return p.item === undefined ? n.method : `${n.method}:${p.item.kind}`;
      })
      .filter((m, i, arr) => !(m === "item/agentMessage/delta" && arr[i - 1] === m));
    assert.deepEqual(seq, [
      "turn/started",
      "item/started:userMessage",
      "item/completed:userMessage",
      "item/started:agentMessage",
      "item/agentMessage/delta",
      "item/completed:agentMessage",
      "turn/completed",
    ]);
    const deltas = client.notifications
      .filter((n) => n.method === "item/agentMessage/delta")
      .map((n) => (n.params as { delta: string }).delta)
      .join("");
    assert.equal(deltas, "hello madc engine");

    // thread/list reflects preview + idle status.
    const list = await client.request("thread/list", {});
    assert.equal(list.nextCursor, null);
    assert.equal(list.data.length, 1);
    assert.equal(list.data[0]?.id, thread.id);
    assert.equal(list.data[0]?.preview, "hello madc engine");
    assert.equal(list.data[0]?.status, "idle");

    // Same-engine resume returns the thread.
    const resumed = await client.request("thread/resume", { threadId: thread.id });
    assert.equal(resumed.thread.id, thread.id);

    // stdout carried protocol only, and the engine never emits `jsonrpc`.
    assert.deepEqual(client.protocolViolations, []);
    for (const m of client.messages) assert.equal(Object.hasOwn(m, "jsonrpc"), false);

    // Lock released when the connection ends.
    await client.close();
    assert.equal(existsSync(lockPath), false);
  });
});

test("parser accepts requests with jsonrpc:2.0 and without", async () => {
  await withEngine(async (client) => {
    client.sendRaw(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "s1",
        method: "initialize",
        params: { clientInfo: { name: "a", version: "1" } },
      }),
    );
    const res = await client.waitFor((m) => m.id === "s1");
    assert.equal((res.result as { protocolVersion: string }).protocolVersion, "madc-m0/1");
    assert.equal(Object.hasOwn(res, "jsonrpc"), false);
    client.sendRaw(JSON.stringify({ id: 7, method: "thread/list" }));
    const list = await client.waitFor((m) => m.id === 7);
    assert.deepEqual(list.result, { data: [], nextCursor: null });
  });
});

// §8.3 -----------------------------------------------------------------------
test("§8.3 turn/interrupt → turn/completed(interrupted); -32004 on second turn; -32003; no-op after", async () => {
  await withEngine(async (client) => {
    await handshake(client);
    const { thread } = await client.request("thread/start", {});
    const { turn } = await client.request("turn/start", {
      threadId: thread.id,
      input: [{ type: "text", text: "wait for interrupt" }],
    });
    await client.waitForNotification("item/agentMessage/delta", (p) => p.turnId === turn.id);

    // §8.4: second turn/start on an active thread (same engine) → -32004 with activeTurnId.
    const busy = await expectRpcError(
      client.request("turn/start", {
        threadId: thread.id,
        input: [{ type: "text", text: "again" }],
      }),
    );
    assert.equal(busy.code, ErrorCode.TurnAlreadyActive);
    assert.deepEqual(busy.data, { threadId: thread.id, activeTurnId: turn.id });

    // Unknown turn in that thread → -32003.
    const missing = await expectRpcError(
      client.request("turn/interrupt", { threadId: thread.id, turnId: "turn_nope" }),
    );
    assert.equal(missing.code, ErrorCode.TurnNotFound);
    assert.deepEqual(missing.data, { threadId: thread.id, turnId: "turn_nope" });

    const ack = await client.request("turn/interrupt", { threadId: thread.id, turnId: turn.id });
    assert.deepEqual(ack, {});
    const done = await client.waitForNotification("turn/completed", (p) => p.turn.id === turn.id);
    assert.equal(done.turn.status, "interrupted");
    assert.equal(done.turn.error, null);
    const agentItem = done.turn.items.find((i) => i.kind === "agentMessage") as AgentMessageItem;
    assert.equal(agentItem.status, "failed");
    assert.equal(agentItem.text, "partial");
    // Honesty: the fixture's abort listener tries to emit late events; the sink is closed first.
    const turnEvents = client.notifications.filter(
      (n) => (n.params as { turnId?: string }).turnId === turn.id,
    );
    assert.equal(JSON.stringify(client.messages).includes("late"), false, "no late emits");
    assert.equal(turnEvents.filter((n) => n.method === "item/started").length, 2);
    assert.equal(turnEvents.filter((n) => n.method === "item/completed").length, 2);

    // Already finished → {} no-op, and exactly one turn/completed was emitted.
    assert.deepEqual(
      await client.request("turn/interrupt", { threadId: thread.id, turnId: turn.id }),
      {},
    );
    assert.equal(
      client.notifications.filter(
        (n) =>
          n.method === "turn/completed" &&
          (n.params as { turn: { id: string } }).turn.id === turn.id,
      ).length,
      1,
    );

    // Thread is idle again: a new turn is accepted.
    const next = await client.request("turn/start", {
      threadId: thread.id,
      input: [{ type: "text", text: "2" }],
    });
    assert.equal(next.turn.status, "inProgress");
  }, HANG_ENGINE);
});

test("EOF on stdin ends an in-flight turn as interrupted (pin §2 step 5)", async () => {
  const { home, cleanup } = makeHome();
  const client = startEngine(home, HANG_ENGINE);
  try {
    await handshake(client);
    const { thread } = await client.request("thread/start", {});
    const { turn } = await client.request("turn/start", {
      threadId: thread.id,
      input: [{ type: "text", text: "x" }],
    });
    await client.waitForNotification("item/agentMessage/delta", (p) => p.turnId === turn.id);
    const code = await client.close();
    assert.equal(code, 0);
    const done = await client.waitForNotification(
      "turn/completed",
      (p) => p.turn.id === turn.id,
      1000,
    );
    assert.equal(done.turn.status, "interrupted");
    assert.equal(existsSync(join(home, "sessions", `${thread.id}.lock`)), false);
  } finally {
    await client.close();
    cleanup();
  }
});

test("agent failure after turn/start → turn/completed(failed) with error + error item", async () => {
  await withEngine(async (client) => {
    await handshake(client);
    const { thread } = await client.request("thread/start", {});
    const { turn } = await client.request("turn/start", {
      threadId: thread.id,
      input: [{ type: "text", text: "x" }],
    });
    const done = await client.waitForNotification("turn/completed", (p) => p.turn.id === turn.id);
    assert.equal(done.turn.status, "failed");
    assert.equal(done.turn.error?.code, -32603);
    const errItem = done.turn.items.find((i) => i.kind === "error");
    assert.ok(errItem);
    assert.equal(errItem.status, "completed");
    // Pin §5 lifecycle: item/started carries inProgress, item/completed the final snapshot.
    const isErr = (p: { item: { id: string } }) => p.item.id === errItem.id;
    const started = await client.waitForNotification("item/started", isErr);
    assert.equal(started.item.status, "inProgress");
    const completed = await client.waitForNotification("item/completed", isErr);
    assert.equal(completed.item.status, "completed");
    assert.equal(
      JSON.stringify(done).includes("fixture agent failure"),
      false,
      "no internals leak",
    );
  }, FAILING_ENGINE);
});

// §8.4 error cases -------------------------------------------------------------
test("§8.4 request before initialize → -32000 NotInitialized", async () => {
  await withEngine(async (client) => {
    const err = await expectRpcError(client.request("thread/start", {}));
    assert.equal(err.code, ErrorCode.NotInitialized);
    assert.equal(err.code, -32000);
    assert.deepEqual(err.data, { method: "thread/start" });
  });
});

test("§8.4 unknown / out-of-M0 method → -32601 MethodNotFound", async () => {
  await withEngine(async (client) => {
    await handshake(client);
    for (const method of [
      "nope/nope",
      "thread/fork",
      "thread/archive",
      "fs/readFile",
      "review/start",
    ]) {
      const err = await expectRpcError(client.request(method, {}));
      assert.equal(err.code, -32601, method);
      assert.deepEqual(err.data, { method });
    }
  });
});

test("§8.4 unknown threadId → -32002 ThreadNotFound", async () => {
  await withEngine(async (client) => {
    await handshake(client);
    const a = await expectRpcError(
      client.request("turn/start", {
        threadId: "thr_missing",
        input: [{ type: "text", text: "x" }],
      }),
    );
    assert.equal(a.code, -32002);
    assert.deepEqual(a.data, { threadId: "thr_missing" });
    const b = await expectRpcError(client.request("thread/resume", { threadId: "thr_missing" }));
    assert.equal(b.code, -32002);
    const c = await expectRpcError(
      client.request("turn/interrupt", { threadId: "thr_missing", turnId: "turn_x" }),
    );
    assert.equal(c.code, -32002);
  });
});

test("§8.4 thread/resume from a second engine while the first holds the lock → -32004 + lockHolderPid", async () => {
  const { home, cleanup } = makeHome();
  const first = startEngine(home);
  const second = startEngine(home);
  try {
    await handshake(first);
    await handshake(second);
    const { thread } = await first.request("thread/start", {});
    const lockPath = join(home, "sessions", `${thread.id}.lock`);
    assert.equal(existsSync(lockPath), true);

    const err = await expectRpcError(second.request("thread/resume", { threadId: thread.id }));
    assert.equal(err.code, ErrorCode.TurnAlreadyActive);
    assert.deepEqual(err.data, {
      threadId: thread.id,
      activeTurnId: null,
      lockHolderPid: first.pid,
    });
    // The loser did not disturb the holder's lock.
    assert.equal(JSON.parse(readFileSync(lockPath, "utf8")).pid, first.pid);

    // Holder exits → lock released → second engine is no longer blocked (A2 store is in-memory → -32002).
    await first.close();
    assert.equal(existsSync(lockPath), false);
    const after = await expectRpcError(second.request("thread/resume", { threadId: thread.id }));
    assert.equal(after.code, ErrorCode.ThreadNotFound);
    assert.equal(existsSync(lockPath), false, "probe lock released after not-found");
  } finally {
    await first.close();
    await second.close();
    cleanup();
  }
});

test("thread/resume of a thread known in-process re-verifies the on-disk lock (-32004 if lost)", async () => {
  const { home, cleanup } = makeHome();
  const engine = startEngine(home);
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
    stdio: "ignore",
  });
  try {
    await handshake(engine);
    const { thread } = await engine.request("thread/start", {});
    const ok = await engine.request("thread/resume", { threadId: thread.id });
    assert.equal(ok.thread.id, thread.id);

    // Our lock is removed out from under us and a live foreign process takes it.
    const lockPath = join(home, "sessions", `${thread.id}.lock`);
    rmSync(lockPath);
    writeFileSync(lockPath, JSON.stringify({ pid: holder.pid, startedAt: Date.now() }));

    const err = await expectRpcError(engine.request("thread/resume", { threadId: thread.id }));
    assert.equal(err.code, ErrorCode.TurnAlreadyActive);
    assert.deepEqual(err.data, {
      threadId: thread.id,
      activeTurnId: null,
      lockHolderPid: holder.pid,
    });

    // Exiting must not delete the foreign holder's lock.
    await engine.close();
    assert.equal(JSON.parse(readFileSync(lockPath, "utf8")).pid, holder.pid);
  } finally {
    holder.kill();
    await engine.close();
    cleanup();
  }
});

test("client: pending requests reject when the engine exits without responding", async () => {
  const { home, cleanup } = makeHome();
  const client = startEngine(home, EXIT_ENGINE);
  try {
    await assert.rejects(
      client.request("initialize", { clientInfo: { name: "t", version: "0" } }),
      (e: unknown) => e instanceof EngineExitedError && e.exitCode === 3,
    );
    await assert.rejects(client.request("thread/list", {}), EngineExitedError);
  } finally {
    await client.close();
    cleanup();
  }
});

test("client: a failed spawn (bad runtime) rejects pending requests instead of hanging", async () => {
  const client = (() => {
    try {
      return spawnEngine({ runtime: "/nonexistent/madc-runtime" });
    } catch {
      return null; // runtime reported the spawn failure synchronously — nothing can hang
    }
  })();
  if (client === null) return;
  try {
    await assert.rejects(
      client.request("initialize", { clientInfo: { name: "t", version: "0" } }),
      EngineExitedError,
    );
  } finally {
    await client.close();
  }
});

test("dead-pid lock is reclaimed (not reported as -32004)", async () => {
  // Obtain a pid that is certainly dead: spawn a child and wait for it to exit.
  const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const deadPid = dead.pid ?? 0;
  await new Promise((r) => dead.once("exit", r));

  await withEngine(async (client, home) => {
    await handshake(client);
    mkdirSync(join(home, "sessions"), { recursive: true });
    const lockPath = join(home, "sessions", "thr_stale.lock");
    writeFileSync(lockPath, JSON.stringify({ pid: deadPid, startedAt: 1 }));
    const err = await expectRpcError(client.request("thread/resume", { threadId: "thr_stale" }));
    assert.equal(err.code, ErrorCode.ThreadNotFound);
    assert.equal(existsSync(lockPath), false);
  });
});

test('§8.4 threadId "../x" → -32602 before any path join (honesty: no file escapes MADC_HOME)', async () => {
  await withEngine(async (client, home) => {
    await handshake(client);
    const bad = ["../x", "..", "a/b", "a\\b", ".hidden", "", " x", "x\n", "é", "a".repeat(129)];
    for (const threadId of bad) {
      for (const [method, params] of [
        ["thread/resume", { threadId }],
        ["turn/start", { threadId, input: [{ type: "text", text: "x" }] }],
        ["turn/interrupt", { threadId, turnId: "turn_x" }],
      ] as const) {
        const err = await expectRpcError(client.request(method, params as never));
        assert.equal(err.code, ErrorCode.InvalidParams, `${method} ${JSON.stringify(threadId)}`);
        assert.ok(Array.isArray(err.data?.issues));
      }
    }
    const seat = await expectRpcError(client.request("thread/start", { seatId: "../x" }));
    assert.equal(seat.code, -32602);
    // Nothing written where "../x" would have resolved.
    assert.equal(existsSync(join(home, "x.lock")), false);
    assert.equal(existsSync(join(dirname(home), "x.lock")), false);
    assert.equal(existsSync(join(home, "sessions", "..", "x.lock")), false);
  });
});

test("-32602 for malformed params (empty input, non-text input, bad limit)", async () => {
  await withEngine(async (client) => {
    await handshake(client);
    const { thread } = await client.request("thread/start", {});
    for (const input of [[], [{ type: "image", url: "x" }], [{ type: "text" }], "hi"]) {
      const err = await expectRpcError(
        client.request("turn/start", { threadId: thread.id, input } as never),
      );
      assert.equal(err.code, -32602, JSON.stringify(input));
    }
    const missing = await expectRpcError(
      client.request("turn/start", { input: [{ type: "text", text: "x" }] } as never),
    );
    assert.equal(missing.code, -32602);
    const limit = await expectRpcError(client.request("thread/list", { limit: 0 }));
    assert.equal(limit.code, -32602);
    const arr = await expectRpcError(client.request("thread/list", [] as never));
    assert.equal(arr.code, -32602);
  });
});

test("§8.4 malformed line → -32700 (id null); invalid shapes → -32600; engine keeps serving", async () => {
  await withEngine(async (client) => {
    client.sendRaw("{this is not json");
    const parse = await client.waitFor(
      (m) => (m.error as { code?: number } | undefined)?.code === -32700,
    );
    assert.equal(parse.id, null);
    assert.equal(Object.hasOwn(parse.error as object, "data"), false);

    client.sendRaw("[1,2]");
    client.sendRaw(JSON.stringify({ id: { nested: true }, method: "initialize" }));
    client.sendRaw(JSON.stringify({ id: 41 }));
    client.sendRaw(JSON.stringify({ jsonrpc: "1.0", id: 42, method: "initialize" }));
    const invalid = await Promise.all([
      client.waitFor((m) => m.id === 41),
      client.waitFor((m) => m.id === 42),
    ]);
    for (const m of invalid) assert.equal((m.error as { code: number }).code, -32600);
    await client.waitFor(
      (m) => m.id === null && (m.error as { code?: number } | undefined)?.code === -32600,
    );

    // Blank lines ignored; engine still serves.
    client.sendRaw("");
    const init = await handshake(client);
    assert.equal(init.protocolVersion, "madc-m0/1");
  });
});

test("thread/list paginates with an opaque cursor", async () => {
  await withEngine(async (client) => {
    await handshake(client);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await client.request("thread/start", {})).thread.id);
    const p1 = await client.request("thread/list", { limit: 2 });
    assert.equal(p1.data.length, 2);
    assert.ok(p1.nextCursor);
    const p2 = await client.request("thread/list", { limit: 2, cursor: p1.nextCursor });
    assert.equal(p2.data.length, 1);
    assert.equal(p2.nextCursor, null);
    assert.deepEqual(new Set([...p1.data, ...p2.data].map((t) => t.id)), new Set(ids));
    const bad = await expectRpcError(client.request("thread/list", { cursor: "thr_unknown" }));
    assert.equal(bad.code, -32602);
  });
});

/** Every regular file under `dir` (recursive). */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

test("§8.9 lock token never appears on the wire, on stderr, or in session JSONL (two engines)", async () => {
  const { home, cleanup } = makeHome();
  const a = startEngineCapturingStderr(home, FAILING_ENGINE);
  const b = startEngineCapturingStderr(home);
  try {
    await handshake(a.client);
    await handshake(b.client);
    const { thread } = await a.client.request("thread/start", {});
    const lockPath = join(home, "sessions", `${thread.id}.lock`);
    const token: string = JSON.parse(readFileSync(lockPath, "utf8")).token;
    assert.match(token, /^[0-9a-f]{32}$/);

    const { turn } = await a.client.request("turn/start", {
      threadId: thread.id,
      input: [{ type: "text", text: "x" }],
    });
    await a.client.waitForNotification("turn/completed", (p) => p.turn.id === turn.id);
    await a.client.request("thread/resume", { threadId: thread.id });
    await a.client.request("thread/list", {});
    // The other engine is refused with lockHolderPid only (§3.3 (d)).
    const refused = await expectRpcError(
      b.client.request("thread/resume", { threadId: thread.id }),
    );
    assert.deepEqual(refused.data, {
      threadId: thread.id,
      activeTurnId: null,
      lockHolderPid: a.client.pid,
    });

    // Files other than the lock itself (session JSONL included, whenever it exists) never carry it.
    for (const file of filesUnder(home).filter((f) => f !== lockPath)) {
      assert.equal(readFileSync(file, "utf8").includes(token), false, file);
    }
    const jsonl = filesUnder(home).filter((f) => f.endsWith(".jsonl"));
    for (const file of jsonl) assert.equal(readFileSync(file, "utf8").includes(token), false);

    await a.client.close();
    await b.client.close();
    const stderr = a.stderr() + b.stderr();
    assert.ok(stderr.includes("agent error"), "stderr capture is live (failing agent logged)");
    assert.equal(stderr.includes(token), false, "not on stderr");
    const wire = JSON.stringify([...a.client.messages, ...b.client.messages]);
    assert.equal(wire.includes(token), false, "not on the wire");
    assert.deepEqual([...a.client.protocolViolations, ...b.client.protocolViolations], []);
  } finally {
    await a.client.close();
    await b.client.close();
    cleanup();
  }
});

test("F1: SIGTERM mid-turn still delivers turn/completed(interrupted); exit code 143", async () => {
  if (process.platform === "win32") return; // POSIX signals only
  const { home, cleanup } = makeHome();
  const client = startEngine(home, HANG_ENGINE);
  try {
    await handshake(client);
    const { thread } = await client.request("thread/start", {});
    const { turn } = await client.request("turn/start", {
      threadId: thread.id,
      input: [{ type: "text", text: "x" }],
    });
    await client.waitForNotification("item/agentMessage/delta", (p) => p.turnId === turn.id);
    process.kill(client.pid, "SIGTERM");
    const code = await client.exited;
    assert.equal(code, 143);
    const done = await client.waitForNotification(
      "turn/completed",
      (p) => p.turn.id === turn.id,
      1000,
    );
    assert.equal(done.turn.status, "interrupted");
    assert.equal(existsSync(join(home, "sessions", `${thread.id}.lock`)), false, "lock released");
  } finally {
    await client.close();
    cleanup();
  }
});
