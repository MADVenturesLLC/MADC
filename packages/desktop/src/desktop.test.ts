/**
 * M3-A2 desktop scaffold tests:
 * - Typed IPC client over `@madc/engine/client` types (no auto-retry/respawn)
 * - Amendment 1 §6 exit code classification & §2a lock-owner manual recovery guidance
 * - Base pin §4 evidence-bound UI rule (engine-returned fields only; never caller-supplied boolean)
 * - Shipped `ui/shell.js` focus bar & connect wiring (`ArrowRight`, `ArrowLeft`, `Home`, `End`,
 *   click, neutral status, zero auto-retry) + CSP/no-inline-script guard
 * - Frozen `DEFAULT_FOCUS_BAR_ITEMS` table
 * - Import-rule honesty guard (`PLAN-madc-M0-build-plan.md:105`, `ROADMAP-madc-post-M0.md:140`)
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION } from "@madc/engine/client";
import { bindDesktopShell, type ShellDocument, type ShellElement } from "../ui/shell.js";
import {
  classifyServeExit,
  createFocusBarState,
  DEFAULT_FOCUS_BAR_ITEMS,
  type DesktopConnectionInfo,
  DesktopEngineClient,
  type DesktopIpcTransport,
  type EvidenceReceipt,
  evidenceTone,
  focusBarSelect,
  isVerifiedReceipt,
  parseLockOwnerGuidance,
  type RoomUpdatedEvent,
  stepFocusBar,
} from "./index.ts";

test("M3-A2 §4 evidence-bound UI rule (M3A2-L6): derives verified only from engine-returned fields, never caller boolean", () => {
  const validHash = "a".repeat(64);
  const validSha = "b".repeat(40);

  assert.equal(isVerifiedReceipt(null), false);
  assert.equal(isVerifiedReceipt(undefined), false);
  assert.equal(isVerifiedReceipt({ kind: "hash", chainOk: false, hash: validHash }), false);
  assert.equal(isVerifiedReceipt({ kind: "hash", chainOk: true, hash: "short" }), false);
  assert.equal(isVerifiedReceipt({ kind: "sha", sha: "not-a-sha" }), false);
  assert.equal(
    isVerifiedReceipt({ kind: "servedModel", servedModel: "   ", vendorReported: true }),
    false,
  );
  assert.equal(
    isVerifiedReceipt({
      kind: "servedModel",
      servedModel: "kimi-for-coding",
      vendorReported: false,
    }),
    false,
  );
  // A caller-supplied `verified: true` flag must have zero effect when engine fields fail.
  assert.equal(
    isVerifiedReceipt({
      kind: "hash",
      chainOk: false,
      hash: validHash,
      verified: true,
    } as unknown as EvidenceReceipt),
    false,
  );
  assert.equal(
    isVerifiedReceipt({
      kind: "servedModel",
      servedModel: "kimi-for-coding",
      vendorReported: false,
      verified: true,
    } as unknown as EvidenceReceipt),
    false,
  );

  assert.equal(isVerifiedReceipt({ kind: "hash", chainOk: true, hash: validHash }), true);
  assert.equal(isVerifiedReceipt({ kind: "sha", sha: validSha }), true);
  assert.equal(
    isVerifiedReceipt({
      kind: "servedModel",
      servedModel: "kimi-for-coding",
      vendorReported: true,
    }),
    true,
  );

  // Even when caller asks for "ok", unverified/missing receipt renders "neutral", never "verified".
  assert.equal(evidenceTone(null, "ok"), "neutral");
  assert.equal(evidenceTone({ kind: "hash", chainOk: false, hash: validHash }, "ok"), "neutral");
  assert.equal(evidenceTone({ kind: "hash", chainOk: true, hash: validHash }, "ok"), "verified");
  assert.equal(evidenceTone({ kind: "hash", chainOk: true, hash: validHash }, "warn"), "warn");
  assert.equal(evidenceTone({ kind: "hash", chainOk: true, hash: validHash }, "fail"), "fail");
});

test("M3-A2 keyboard focus bar (M3A2-L4): cycles cleanly across landmarks and freezes DEFAULT_FOCUS_BAR_ITEMS", () => {
  assert.equal(Object.isFrozen(DEFAULT_FOCUS_BAR_ITEMS), true);
  assert.throws(() => {
    (DEFAULT_FOCUS_BAR_ITEMS as unknown as unknown[]).push({ id: "extra", label: "Extra" });
  }, TypeError);
  assert.equal(Object.isFrozen(DEFAULT_FOCUS_BAR_ITEMS[0]), true);
  assert.throws(() => {
    (DEFAULT_FOCUS_BAR_ITEMS[0] as unknown as Record<string, unknown>).label = "Mutated";
  }, TypeError);

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

test("M3-A2 shipped UI script (M3A2-M5) and CSP/no-inline guard (M3A2-M4)", async () => {
  const htmlPath = fileURLToPath(new URL("../ui/index.html", import.meta.url));
  const confPath = fileURLToPath(new URL("../src-tauri/tauri.conf.json", import.meta.url));
  const html = readFileSync(htmlPath, "utf8");
  const conf = JSON.parse(readFileSync(confPath, "utf8")) as {
    app: { security: { csp: string } };
  };

  // M4: no inline script/style in ui/index.html, and no 'unsafe-inline' in CSP.
  assert.doesNotMatch(html, /<style[\s>]/i, "no inline <style> in index.html");
  assert.match(html, /<link\s+rel="stylesheet"\s+href="\.\/styles\.css"\s*\/>/);
  assert.match(html, /<script\s+type="module"\s+src="\.\/app\.js"><\/script>/);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, "no inline <script> in index.html");
  assert.equal(conf.app.security.csp.includes("unsafe-inline"), false, "no unsafe-inline in CSP");

  // M5: exercise the exact shipped `bindDesktopShell` from `ui/shell.js`.
  type FakeEl = ShellElement & {
    readonly attrs: Map<string, string>;
    readonly listeners: Map<string, Array<(ev: unknown) => void>>;
    focusedCount: number;
    emit(type: string, ev?: unknown): void;
  };
  const makeEl = (attrsInit: Record<string, string> = {}, text = ""): FakeEl => {
    const attrs = new Map(Object.entries(attrsInit));
    const listeners = new Map<string, Array<(ev: unknown) => void>>();
    const el: FakeEl = {
      attrs,
      listeners,
      className: "",
      textContent: text,
      tabIndex: 0,
      focusedCount: 0,
      setAttribute(name, value) {
        attrs.set(name, value);
      },
      getAttribute(name) {
        return attrs.get(name) ?? null;
      },
      focus() {
        el.focusedCount += 1;
      },
      addEventListener(type, listener) {
        const list = listeners.get(type) ?? [];
        list.push(listener);
        listeners.set(type, list);
      },
      querySelectorAll() {
        return [];
      },
      emit(type, ev = {}) {
        for (const fn of listeners.get(type) ?? []) fn(ev);
      },
    };
    return el;
  };

  const buttons = DEFAULT_FOCUS_BAR_ITEMS.map((item) =>
    makeEl({ "data-focus-id": item.id }, item.label),
  );
  const bar = makeEl();
  bar.querySelectorAll = () => buttons;
  const statusEl = makeEl({}, "idle");
  const outputEl = makeEl({}, "ready");
  const connectBtn = makeEl({}, "Connect");

  const byId = new Map<string, ShellElement>([
    ["focus-bar", bar],
    ["connection-status", statusEl],
    ["output", outputEl],
    ["connect-btn", connectBtn],
  ]);
  const doc: ShellDocument = {
    getElementById(id) {
      const el = byId.get(id);
      if (!el) throw new Error(`missing element #${id}`);
      return el;
    },
  };

  const invokes: Array<{ cmd: string; args: Record<string, unknown> | undefined }> = [];
  let shouldFail = false;
  const controller = bindDesktopShell(doc, async (cmd, args) => {
    invokes.push({ cmd, args });
    if (shouldFail) throw new Error("connect refused");
    if (cmd === "connect_engine") {
      return { protocolVersion: PROTOCOL_VERSION, coldStartMs: 25 };
    }
    if (cmd === "rpc_request") {
      return { room: { counts: { threads: 0, openDecisions: 0 } } };
    }
    throw new Error(`unexpected cmd ${cmd}`);
  });

  // Initial state & keyboard navigation on shipped toolbar controller.
  assert.equal(controller.getFocusState().activeId, "connection");
  assert.equal(buttons[0]?.getAttribute("aria-pressed"), "true");
  assert.equal(buttons[0]?.tabIndex, 0);
  assert.equal(buttons[1]?.tabIndex, -1);

  let prevented = 0;
  const sendKey = (key: string) =>
    bar.emit("keydown", {
      key,
      preventDefault: () => {
        prevented += 1;
      },
    });
  sendKey("ArrowRight");
  assert.equal(controller.getFocusState().activeId, "room");
  assert.equal(buttons[1]?.getAttribute("aria-pressed"), "true");
  assert.equal(buttons[1]?.tabIndex, 0);
  sendKey("End");
  assert.equal(controller.getFocusState().activeId, "search");
  sendKey("ArrowRight");
  assert.equal(controller.getFocusState().activeId, "connection");
  sendKey("ArrowLeft");
  assert.equal(controller.getFocusState().activeId, "search");
  sendKey("Home");
  assert.equal(controller.getFocusState().activeId, "connection");
  assert.equal(prevented, 5);
  buttons[2]?.emit("click");
  assert.equal(controller.getFocusState().activeId, "decisions");

  // Manual connect: stays neutral (never green without verified receipt).
  await controller.connect();
  assert.deepEqual(
    invokes.map((c) => c.cmd),
    ["connect_engine", "rpc_request"],
  );
  assert.equal(statusEl.className, "status-neutral");
  assert.match(statusEl.textContent ?? "", /neutral/);

  // Failure path: sets fail class and never auto-retries.
  invokes.length = 0;
  shouldFail = true;
  await controller.connect();
  assert.equal(invokes.length, 1, "no automatic retry on failure");
  assert.equal(statusEl.className, "status-fail");
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
