/**
 * M3-A2 desktop scaffold tests:
 * - Typed IPC client over `@madc/engine/client` types (no auto-retry/respawn)
 * - Amendment 1 §6 exit code classification & §2a lock-owner manual recovery guidance
 * - Base pin §4 evidence-bound UI rule (never `verified` without verified receipt)
 * - Keyboard focus bar navigation (`Tab`, `Shift+Tab`, arrows, `Home`, `End`)
 * - Import-rule honesty guard (`PLAN-madc-M0-build-plan.md:105`, `ROADMAP-madc-post-M0.md:140`)
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION } from "@madc/engine/client";
import {
  classifyServeExit,
  createFocusBarState,
  type DesktopConnectionInfo,
  DesktopEngineClient,
  type DesktopIpcTransport,
  evidenceTone,
  focusBarSelect,
  isVerifiedReceipt,
  parseLockOwnerGuidance,
  type RoomUpdatedEvent,
  stepFocusBar,
} from "./index.ts";

test("M3-A2 §4 evidence-bound UI rule: never returns verified without a verified hash, sha, or servedModel", () => {
  const validHash = "a".repeat(64);
  const validSha = "b".repeat(40);

  assert.equal(isVerifiedReceipt(null), false);
  assert.equal(isVerifiedReceipt(undefined), false);
  assert.equal(isVerifiedReceipt({ kind: "hash", hash: validHash, verified: false }), false);
  assert.equal(isVerifiedReceipt({ kind: "hash", hash: "short", verified: true }), false);
  assert.equal(isVerifiedReceipt({ kind: "sha", sha: "not-a-sha", verified: true }), false);
  assert.equal(
    isVerifiedReceipt({ kind: "servedModel", servedModel: "   ", verified: true }),
    false,
  );

  assert.equal(isVerifiedReceipt({ kind: "hash", hash: validHash, verified: true }), true);
  assert.equal(isVerifiedReceipt({ kind: "sha", sha: validSha, verified: true }), true);
  assert.equal(
    isVerifiedReceipt({ kind: "servedModel", servedModel: "kimi-for-coding", verified: true }),
    true,
  );

  // Even when caller asks for "ok", unverified/missing receipt renders "neutral", never "verified".
  assert.equal(evidenceTone(null, "ok"), "neutral");
  assert.equal(evidenceTone({ kind: "hash", hash: validHash, verified: false }, "ok"), "neutral");
  assert.equal(evidenceTone({ kind: "hash", hash: validHash, verified: true }, "ok"), "verified");
  assert.equal(evidenceTone({ kind: "hash", hash: validHash, verified: true }, "warn"), "warn");
  assert.equal(evidenceTone({ kind: "hash", hash: validHash, verified: true }, "fail"), "fail");
});

test("M3-A2 keyboard focus bar: cycles cleanly across shell landmarks", () => {
  let state = createFocusBarState();
  assert.equal(state.activeId, "connection");

  state = stepFocusBar(state, "Tab");
  assert.equal(state.activeId, "room");
  state = stepFocusBar(state, "ArrowRight");
  assert.equal(state.activeId, "decisions");
  state = stepFocusBar(state, "End");
  assert.equal(state.activeId, "search");
  state = stepFocusBar(state, "Tab");
  assert.equal(state.activeId, "connection", "wraps forward");
  state = stepFocusBar(state, "Shift+Tab");
  assert.equal(state.activeId, "search", "wraps backward");
  state = stepFocusBar(state, "ArrowLeft");
  assert.equal(state.activeId, "decisions");
  state = stepFocusBar(state, "Home");
  assert.equal(state.activeId, "connection");
  state = focusBarSelect(state, "room");
  assert.equal(state.activeId, "room");
});

test("M3-A2 amendment 1 §6 exit code classification and §2a manual lock guidance", () => {
  assert.deepEqual(classifyServeExit({ code: 0 }), { kind: "clean", code: 0 });
  assert.deepEqual(classifyServeExit({ code: 130 }), { kind: "clean", code: 130 });
  assert.deepEqual(classifyServeExit({ code: 143 }), { kind: "clean", code: 143 });
  assert.deepEqual(classifyServeExit({ code: 2 }), { kind: "usage-or-home", code: 2 });
  assert.deepEqual(classifyServeExit({ code: 20 }), { kind: "owned", code: 20 });
  assert.deepEqual(classifyServeExit({ code: 21 }), { kind: "unsafe-path", code: 21 });
  assert.deepEqual(classifyServeExit({ code: 22 }), { kind: "listen-error", code: 22 });
  assert.deepEqual(classifyServeExit({ code: 23 }), { kind: "shutdown-deadline", code: 23 });
  assert.deepEqual(classifyServeExit({ code: 24 }), {
    kind: "internal-fault",
    code: 24,
    rawCode: 24,
  });
  // Unlisted runtime codes (e.g. 1 without launcher kill on Windows, or 13) -> 24.
  assert.deepEqual(classifyServeExit({ code: 1 }), {
    kind: "internal-fault",
    code: 24,
    rawCode: 1,
  });
  assert.deepEqual(classifyServeExit({ code: 13 }), {
    kind: "internal-fault",
    code: 24,
    rawCode: 13,
  });
  // Signal termination -> stopped (not 24).
  assert.deepEqual(classifyServeExit({ code: null, signal: "SIGKILL" }), {
    kind: "stopped",
    code: null,
    signal: "SIGKILL",
  });
  // Windows launcher-initiated TerminateProcess(handle, 1) -> stopped (not 24).
  assert.deepEqual(classifyServeExit({ code: 1, launcherKilled: true, platform: "win32" }), {
    kind: "stopped",
    code: 1,
    signal: null,
  });

  // §2a lock holder manual guidance parsing.
  const guidance = parseLockOwnerGuidance(
    "[madc-engine] boot\nmadc-engine serve: home owned by pid 4242: /Users/test/.madc/engine.lock\n",
    "darwin",
  );
  assert.ok(guidance !== null);
  assert.equal(guidance.pid, 4242);
  assert.equal(guidance.lockPath, "/Users/test/.madc/engine.lock");
  assert.match(guidance.manualFix, /ps -p 4242 -o command=/);
  assert.match(guidance.manualFix, /manually remove \/Users\/test\/\.madc\/engine\.lock/);

  const winGuidance = parseLockOwnerGuidance(
    "madc-engine serve: home owned by pid 99: C:\\Users\\test\\.madc\\engine.lock\n",
    "win32",
  );
  assert.ok(winGuidance !== null);
  assert.match(winGuidance.manualFix, /Task Manager for PID 99/);
  assert.equal(parseLockOwnerGuidance("madc-engine serve: symlink: /tmp/engine.sock\n"), null);
});

test("M3-A2 DesktopEngineClient: connects with protocol check, dispatches typed IPC, forwards room/updated, never auto-retries", async () => {
  let connectCalls = 0;
  const listeners: Array<(e: RoomUpdatedEvent) => void> = [];
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];

  const transport: DesktopIpcTransport = {
    async connect(): Promise<DesktopConnectionInfo> {
      connectCalls += 1;
      return {
        socketPath: "/tmp/test/engine.sock",
        reusedExisting: false,
        protocolVersion: PROTOCOL_VERSION,
        serverName: "madc-engine",
        serverVersion: "0.0.0",
        coldStartMs: 42,
      };
    },
    async request<TResult>(method: string, params: Record<string, unknown>): Promise<TResult> {
      calls.push({ method, params });
      if (method === "room/inspect") {
        return { room: { counts: { threads: 0, openDecisions: 0 } } } as unknown as TResult;
      }
      if (method === "session/search") {
        return { matches: [] } as unknown as TResult;
      }
      if (method === "session/read") {
        return { threadId: "thr_1", events: [], chainOk: true } as unknown as TResult;
      }
      throw new Error(`unexpected method ${method}`);
    },
    async disconnect(): Promise<void> {},
    onRoomUpdated(fn) {
      listeners.push(fn);
      return () => {};
    },
  };

  const client = new DesktopEngineClient(transport);
  const info = await client.connect();
  assert.equal(info.protocolVersion, "madc-m1/1");
  assert.equal(connectCalls, 1);

  const received: RoomUpdatedEvent[] = [];
  client.onRoomUpdated((ev) => received.push(ev));
  for (const fn of listeners) fn({ reason: "thread", threadId: "thr_1" });
  assert.deepEqual(received, [{ reason: "thread", threadId: "thr_1" }]);

  await client.roomInspect();
  await client.sessionSearch({ query: "needle", limit: 10 });
  await client.sessionRead({ threadId: "thr_1" });
  assert.deepEqual(
    calls.map((c) => c.method),
    ["room/inspect", "session/search", "session/read"],
  );
  await client.disconnect();
  assert.equal(client.connection, null);

  // Protocol mismatch fails closed without retrying.
  let badConnectCalls = 0;
  const badClient = new DesktopEngineClient({
    ...transport,
    async connect() {
      badConnectCalls += 1;
      return { ...(await transport.connect()), protocolVersion: "madc-m0/1" };
    },
  });
  await assert.rejects(() => badClient.connect(), /protocol version mismatch/);
  assert.equal(badConnectCalls, 1, "no automatic retry on failure");
});

test("M3-A2 import-rule honesty guard: packages/desktop/src imports only @madc/core, @madc/engine/client, or relative files", () => {
  const desktopSrc = fileURLToPath(new URL("./", import.meta.url));
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|js|mjs|cjs)$/.test(name)) files.push(p);
    }
  };
  walk(desktopSrc);
  assert.ok(files.length >= 4);

  const allowedTestNodeBuiltins = new Set([
    "node:assert/strict",
    "node:fs",
    "node:path",
    "node:test",
    "node:url",
  ]);
  const violations: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const isTest = file.endsWith(".test.ts");
    for (const m of text.matchAll(
      /\b(import|export)\s+(type\s+)?[^'"]*?from\s+["']([^"']+)["']/g,
    )) {
      const typeOnly = m[2] !== undefined;
      const spec = m[3] ?? "";
      const ok =
        (isTest && allowedTestNodeBuiltins.has(spec)) ||
        (spec.startsWith(".") && !spec.includes("engine") && !spec.includes("adapters")) ||
        spec === "@madc/core" ||
        spec === "@madc/engine/client" ||
        (typeOnly && spec === "@madc/engine");
      if (!ok) violations.push(`${relative(desktopSrc, file)}: ${m[0]}`);
    }
  }
  assert.deepEqual(violations, []);
});
