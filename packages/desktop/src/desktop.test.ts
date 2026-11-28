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
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION } from "@madc/engine/client";
import {
  ALLOWED_PILL_LABELS,
  acceptEngineEvent,
  acceptQuitRequest,
  acceptTerminal,
  bindDesktopShell,
  classifyRpcError,
  composerTargets,
  createPaletteState,
  cwdCheck,
  cwdFieldState,
  EXPECTED_PROTOCOL_VERSION,
  FORWARDED_ENGINE_EVENTS,
  filterCommands,
  isWidePaneWidth,
  lockOwnerGuidanceFromStderr,
  PALETTE_COMMANDS,
  paneColumns,
  receiptRowsForPane,
  resolveConnectTerminal,
  type ShellDocument,
  type ShellElement,
  serveExitFromCode,
  stepPalette,
  turnPillForPane,
} from "../ui/shell.js";
import type { PillLabel } from "./evidence.ts";
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
    readonly children: FakeEl[];
    focusedCount: number;
    emit(type: string, ev?: unknown): void;
  };
  let activeEl: FakeEl | null = null;
  const makeEl = (attrsInit: Record<string, string> = {}, text = ""): FakeEl => {
    const attrs = new Map(Object.entries(attrsInit));
    const listeners = new Map<string, Array<(ev: unknown) => void>>();
    const children: FakeEl[] = [];
    const el: FakeEl = {
      attrs,
      listeners,
      children,
      className: "",
      textContent: text,
      tabIndex: 0,
      hidden: false,
      disabled: false,
      readOnly: false,
      inert: false,
      focusedCount: 0,
      setSelectionRange() {},
      setAttribute(name, value) {
        attrs.set(name, value);
      },
      getAttribute(name) {
        return attrs.get(name) ?? null;
      },
      removeAttribute(name) {
        attrs.delete(name);
      },
      hasAttribute(name) {
        return attrs.has(name);
      },
      appendChild(child) {
        children.push(child as FakeEl);
        el.textContent = children.map((c) => c.textContent ?? "").join("");
        return child;
      },
      replaceChildren(...nodes) {
        children.length = 0;
        for (const n of nodes) children.push(n as FakeEl);
        el.textContent = children.map((c) => c.textContent ?? "").join("");
      },
      focus() {
        el.focusedCount += 1;
        activeEl = el;
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
    ["main-content", makeEl()],
    ["room-counts", makeEl()],
    ["room-rows", makeEl()],
    ["receipt-rows", makeEl()],
    ["engine-pill", makeEl()],
    ["kv-socket", makeEl()],
    ["kv-protocol", makeEl()],
    ["kv-server", makeEl()],
    ["kv-cold-start", makeEl()],
    ["kv-reused", makeEl()],
    ["palette", makeEl()],
    ["palette-input", makeEl()],
    ["palette-list", makeEl()],
    ["palette-live", makeEl()],
    ["palette-keycap", makeEl()],
    ["room-stale-note", makeEl()],
    ["view-toggle", makeEl()],
    ["view-panes-btn", makeEl()],
    ["view-table-btn", makeEl()],
    ["table-view", makeEl()],
    ["col-right", makeEl()],
    ["panes-workspace", makeEl()],
    ["panes-grid", makeEl()],
    ["hidden-strip", makeEl()],
    ["composer-targets", makeEl()],
    ["composer-input", makeEl()],
    ["composer-start-btn", makeEl()],
    ["live-region", makeEl()],
    ["quit-dialog", makeEl()],
    ["quit-dialog-title", makeEl()],
    ["quit-dialog-list", makeEl()],
    ["quit-keep-btn", makeEl()],
    ["quit-confirm-btn", makeEl()],
  ]);
  const doc: ShellDocument = {
    get activeElement() {
      return activeEl;
    },
    getElementById(id) {
      const el = byId.get(id);
      if (!el) throw new Error(`missing element #${id}`);
      return el;
    },
    createElement() {
      return makeEl();
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
  assert.equal(statusEl.getAttribute("data-tone"), "neutral");
  assert.match(statusEl.textContent ?? "", /neutral/);

  // Failure path: sets fail class and never auto-retries.
  invokes.length = 0;
  shouldFail = true;
  await controller.connect();
  assert.equal(invokes.length, 1, "no automatic retry on failure");
  assert.equal(statusEl.getAttribute("data-tone"), "fail");
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
        connectionEpoch: 1,
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

// ---------------------------------------------------------------------------
// M3-A3 Precision Instrument Glass acceptance tests (pin §9 items 1–13 & N5)
// ---------------------------------------------------------------------------

type TestFakeEl = ShellElement & {
  readonly attrs: Map<string, string>;
  readonly listeners: Map<string, Array<(ev: unknown) => void>>;
  readonly children: TestFakeEl[];
  parent: TestFakeEl | null;
  focusedCount: number;
  emit(type: string, ev?: unknown): void;
};

function createShellHarness() {
  let activeEl: TestFakeEl | null = null;
  const makeEl = (attrsInit: Record<string, string> = {}, text = ""): TestFakeEl => {
    const attrs = new Map(Object.entries(attrsInit));
    const listeners = new Map<string, Array<(ev: unknown) => void>>();
    const children: TestFakeEl[] = [];
    const el: TestFakeEl = {
      attrs,
      listeners,
      children,
      parent: null,
      className: "",
      textContent: text,
      tabIndex: 0,
      hidden: false,
      disabled: false,
      readOnly: false,
      inert: false,
      focusedCount: 0,
      setSelectionRange() {},
      setAttribute(name, value) {
        attrs.set(name, value);
      },
      getAttribute(name) {
        return attrs.get(name) ?? null;
      },
      removeAttribute(name) {
        attrs.delete(name);
      },
      hasAttribute(name) {
        return attrs.has(name);
      },
      appendChild(child) {
        const c = child as TestFakeEl;
        c.parent = el;
        children.push(c);
        el.textContent = children.map((item) => item.textContent ?? "").join("");
        return child;
      },
      replaceChildren(...nodes) {
        children.length = 0;
        for (const n of nodes) {
          const c = n as TestFakeEl;
          c.parent = el;
          children.push(c);
        }
        el.textContent = children.map((item) => item.textContent ?? "").join("");
      },
      focus() {
        let cur: TestFakeEl | null = el;
        while (cur !== null) {
          if (cur.inert) return;
          cur = cur.parent;
        }
        el.focusedCount += 1;
        activeEl = el;
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
  for (const b of buttons) b.parent = bar;
  bar.querySelectorAll = () => buttons;

  const byId = new Map<string, TestFakeEl>([
    ["focus-bar", bar],
    ["connection-status", makeEl({}, "idle")],
    ["output", makeEl({}, "ready")],
    ["connect-btn", makeEl({}, "Connect")],
    ["main-content", makeEl()],
    ["room-counts", makeEl()],
    ["room-rows", makeEl()],
    ["receipt-rows", makeEl()],
    ["engine-pill", makeEl()],
    ["kv-socket", makeEl()],
    ["kv-protocol", makeEl()],
    ["kv-server", makeEl()],
    ["kv-cold-start", makeEl()],
    ["kv-reused", makeEl()],
    ["palette", makeEl()],
    ["palette-input", makeEl()],
    ["palette-list", makeEl()],
    ["palette-live", makeEl()],
    ["palette-keycap", makeEl()],
    ["room-stale-note", makeEl()],
    ["view-toggle", makeEl()],
    ["view-panes-btn", makeEl()],
    ["view-table-btn", makeEl()],
    ["table-view", makeEl()],
    ["col-right", makeEl()],
    ["panes-workspace", makeEl()],
    ["panes-grid", makeEl()],
    ["hidden-strip", makeEl()],
    ["composer-targets", makeEl()],
    ["composer-input", makeEl()],
    ["composer-start-btn", makeEl()],
    ["live-region", makeEl()],
    ["quit-dialog", makeEl()],
    ["quit-dialog-title", makeEl()],
    ["quit-dialog-list", makeEl()],
    ["quit-keep-btn", makeEl()],
    ["quit-confirm-btn", makeEl()],
  ]);

  const docListeners = new Map<string, Array<(ev: unknown) => void>>();
  const doc: ShellDocument & { emit(type: string, ev?: unknown): void } = {
    get activeElement() {
      return activeEl;
    },
    getElementById(id) {
      const el = byId.get(id);
      if (!el) throw new Error(`missing element #${id}`);
      return el;
    },
    createElement() {
      return makeEl();
    },
    addEventListener(type, listener) {
      const list = docListeners.get(type) ?? [];
      list.push(listener);
      docListeners.set(type, list);
    },
    emit(type, ev = {}) {
      for (const fn of docListeners.get(type) ?? []) fn(ev);
    },
  };

  return { doc, byId, buttons };
}

test("M3-A3 §9.1–§9.3 static CSS, tokens, zero-network, zero-HTML-sink, no decorative green, glass & forced-colors", () => {
  const uiDir = fileURLToPath(new URL("../ui/", import.meta.url));
  const css = readFileSync(join(uiDir, "styles.css"), "utf8");
  const html = readFileSync(join(uiDir, "index.html"), "utf8");
  const shellJs = readFileSync(join(uiDir, "shell.js"), "utf8");
  const appJs = readFileSync(join(uiDir, "app.js"), "utf8");

  // Forbidden files must not exist.
  assert.equal(existsSync(join(uiDir, "tokens.css")), false);
  assert.equal(existsSync(join(uiDir, "palette.js")), false);
  assert.equal(existsSync(fileURLToPath(new URL("./palette.ts", import.meta.url))), false);

  // §9.1: exact 11 color tokens + §3.2 tokens in :root.
  const rootMatch = /:root\s*\{([\s\S]*?)\n\}/.exec(css);
  assert.ok(rootMatch !== null, ":root block must exist");
  const rootBody = rootMatch[1] ?? "";
  const expectedTokens = [
    ["--madc-darker", "#0e0e14"],
    ["--madc-bg", "#1a1b26"],
    ["--madc-lighter", "#24283b"],
    ["--madc-fg", "#a9b1d6"],
    ["--madc-bright", "#c0caf5"],
    ["--madc-muted", "#565f89"],
    ["--madc-border", "#414868"],
    ["--madc-accent", "#7aa2f7"],
    ["--madc-green", "#9ece6a"],
    ["--madc-red", "#f7768e"],
    ["--madc-yellow", "#e0af68"],
    ["--madc-radius-sm", "3px"],
    ["--madc-radius-md", "4px"],
    ["--madc-radius-lg", "6px"],
    ["--madc-glass-blur", "blur(14px)"],
    ["--madc-glass-blur-strong", "blur(18px) saturate(120%)"],
  ];
  for (const [token, value] of expectedTokens) {
    assert.ok(rootBody.includes(`${token}: ${value};`), `missing ${token}: ${value}`);
  }

  // No hex literal outside :root in styles.css, or anywhere in index.html / ui/*.js.
  const cssOutsideRoot = css.replace(/:root\s*\{[\s\S]*?\n\}/, "");
  assert.doesNotMatch(cssOutsideRoot, /#[0-9a-fA-F]{3,8}\b/, "no hex outside :root");
  assert.doesNotMatch(html, /#[0-9a-fA-F]{3,8}\b/, "no hex in index.html");
  assert.doesNotMatch(shellJs, /#[0-9a-fA-F]{3,8}\b/, "no hex in shell.js");
  assert.doesNotMatch(appJs, /#[0-9a-fA-F]{3,8}\b/, "no hex in app.js");

  // Zero network URLs & zero HTML sinks.
  for (const [name, content] of [
    ["styles.css", css],
    ["index.html", html],
    ["shell.js", shellJs],
    ["app.js", appJs],
  ] as const) {
    assert.doesNotMatch(content, /https?:\/\//i, `no http(s):// in ${name}`);
  }
  assert.doesNotMatch(
    css,
    /(?:url\(\s*["']?|@import\s+["']?)\/\//i,
    "no protocol-relative CSS url",
  );
  assert.doesNotMatch(html, /(?:src|href)\s*=\s*["']\/\//i, "no protocol-relative HTML src/href");
  for (const [name, content] of [
    ["shell.js", shellJs],
    ["app.js", appJs],
  ] as const) {
    assert.doesNotMatch(
      content,
      /\b(innerHTML|outerHTML|insertAdjacentHTML|document\.write)\b/,
      `no HTML sink in ${name}`,
    );
  }

  // Vendored fonts + licenses exist and total <= 1 MB.
  const fontsDir = join(uiDir, "fonts");
  const expectedFonts = [
    "IBMPlexSans-Regular.woff2",
    "IBMPlexSans-Medium.woff2",
    "IBMPlexSans-SemiBold.woff2",
    "JetBrainsMono-Regular.woff2",
    "JetBrainsMono-Medium.woff2",
    "JetBrainsMono-SemiBold.woff2",
  ];
  let totalBytes = 0;
  for (const f of expectedFonts) {
    const p = join(fontsDir, f);
    assert.equal(existsSync(p), true, `missing font ${f}`);
    totalBytes += statSync(p).size;
    assert.ok(
      css.includes(`url("./fonts/${f}") format("woff2")`),
      `@font-face must reference ./fonts/${f}`,
    );
  }
  assert.equal(existsSync(join(fontsDir, "LICENSE-IBM-PLEX.txt")), true);
  assert.equal(existsSync(join(fontsDir, "LICENSE-JETBRAINS-MONO.txt")), true);
  assert.ok(totalBytes <= 1024 * 1024, `fonts exceed 1MB (${totalBytes})`);
  const fontFaceBlocks = Array.from(css.matchAll(/@font-face\s*\{([\s\S]*?)\}/g));
  assert.equal(fontFaceBlocks.length, 6, "expected 6 @font-face blocks");
  for (const block of fontFaceBlocks) {
    assert.match(block[1] ?? "", /font-display:\s*block;/, "every @font-face must use block");
  }

  // §9.2: No decorative green & no legacy status classes.
  assert.doesNotMatch(css, /\.(status-|tone-|green\b|ok\b|success\b)/);
  const ruleMatches = cssOutsideRoot.matchAll(/([^{}@]+)\{([^{}]+)\}/g);
  for (const m of ruleMatches) {
    const selector = (m[1] ?? "").trim();
    const body = m[2] ?? "";
    if (/#9ece6a|158\s+206\s+106|--madc-green|--madc-tone-fill-verified/.test(body)) {
      assert.ok(
        selector.includes('[data-tone="verified"]'),
        `green token used outside [data-tone="verified"]: ${selector}`,
      );
    }
    if (/backdrop-filter\s*:/.test(body)) {
      assert.equal(selector.includes(".well"), false, "well must never blur");
      assert.ok(selector.includes(".glass"), `backdrop-filter outside .glass: ${selector}`);
      // Prefixed and unprefixed travel together with one value: WebKit before Safari 18 knows
      // the property only as `-webkit-backdrop-filter`.
      const blur = (property: string): string | undefined =>
        body.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+);`))?.[1]?.trim();
      assert.equal(
        blur("-webkit-backdrop-filter"),
        blur("backdrop-filter"),
        `${selector}: backdrop-filter without its -webkit- pair`,
      );
    }
    if (/^\.pill\[data-tone=/.test(selector)) {
      for (const line of body.split(";")) {
        const prop = line.split(":")[0]?.trim();
        if (!prop) continue;
        assert.ok(
          ["color", "background", "background-color", "border-color"].includes(prop),
          `pill[data-tone] may only set colour properties, got ${prop}`,
        );
      }
    }
  }

  // §9.3: Forced-colors uses .pill .pill-glyph, never .glyph.
  assert.doesNotMatch(css, /\.glyph\b/);
  assert.match(css, /@media\s*\(forced-colors:\s*active\)[\s\S]*\.pill\s+\.pill-glyph/);

  // N1 & N3: Accessibility fallbacks cover .palette.glass and reduced-motion uses !important.
  // The no-blur fallback switches off both forms of the property.
  assert.match(
    css,
    /@media\s*\(prefers-reduced-transparency:\s*reduce\)[\s\S]*\.glass,\s*\.palette\.glass\s*\{\s*-webkit-backdrop-filter:\s*none;\s*backdrop-filter:\s*none;\s*\}/,
  );
  assert.match(
    css,
    /@supports\s+not\s*\(backdrop-filter:\s*blur\(1px\)\)\s*\{\s*\.glass,\s*\.palette\.glass\s*\{\s*background:\s*var\(--madc-lighter\);\s*\}\s*\}/,
  );
  assert.match(
    css,
    /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*transition:\s*none\s*!important;[\s\S]*animation:\s*none\s*!important;/,
  );
});

test("M3-A3 §9.4, §9.5, §9.2, §9.13 Room table initial state, on-demand session/read, and Receipts well honesty", async () => {
  const { doc, byId } = createShellHarness();
  const calls: Array<{ cmd: string; args: Record<string, unknown> | undefined }> = [];
  let sessionReadMode: "verified" | "torn" | "short-hash" | "not-found" = "verified";

  const controller = bindDesktopShell(doc, async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "connect_engine") {
      return {
        socketPath: "/tmp/madc/engine.sock",
        reusedExisting: false,
        protocolVersion: PROTOCOL_VERSION,
        serverName: "madc-engine",
        serverVersion: "0.0.0",
        coldStartMs: 18,
      };
    }
    if (cmd === "rpc_request" && args?.method === "room/inspect") {
      return {
        room: {
          home: "/tmp/madc",
          counts: { threads: 4, pass: 1, warn: 1, fail: 2, openDecisions: 0 },
          threads: [
            {
              threadId: "thr_pass",
              path: "/tmp/madc/sessions/thr_pass.jsonl",
              seatId: "kimi",
              level: "pass",
              chain: { ok: true },
              handoff: { inbound: null, outboundCount: 0, oneWay: false },
              worktree: { open: null, close: null, missing: false },
              openDecisions: [],
              findings: [],
            },
            {
              threadId: "thr_warn",
              path: "/tmp/madc/sessions/thr_warn.jsonl",
              seatId: "codex",
              level: "warn",
              chain: { ok: true },
              handoff: { inbound: null, outboundCount: 0, oneWay: false },
              worktree: { open: null, close: null, missing: false },
              openDecisions: [],
              findings: [{ level: "warn", code: "W_TEST", detail: "stale lock" }],
            },
            {
              threadId: "thr_torn",
              path: "/tmp/madc/sessions/thr_torn.jsonl",
              seatId: "claude",
              level: "fail",
              chain: { ok: false, kind: "torn-tail", line: 7, reason: "truncated line" },
              handoff: { inbound: null, outboundCount: 0, oneWay: false },
              worktree: { open: null, close: null, missing: false },
              openDecisions: [],
              findings: [],
            },
            {
              threadId: "thr_int",
              path: "/tmp/madc/sessions/thr_int.jsonl",
              seatId: "gemini",
              level: "fail",
              chain: { ok: false, kind: "integrity", line: 11, reason: "prev hash mismatch" },
              handoff: { inbound: null, outboundCount: 0, oneWay: false },
              worktree: { open: null, close: null, missing: false },
              openDecisions: [],
              findings: [],
            },
          ],
        },
      };
    }
    if (cmd === "rpc_request" && args?.method === "session/read") {
      if (sessionReadMode === "verified") {
        return {
          threadId: "thr_pass",
          chainOk: true,
          events: [{ seq: 1, hash: "a".repeat(64) }],
        };
      }
      if (sessionReadMode === "torn") {
        return { threadId: "thr_torn", chainOk: false, events: [] };
      }
      if (sessionReadMode === "short-hash") {
        return { threadId: "thr_pass", chainOk: true, events: [{ seq: 1, hash: "short" }] };
      }
      throw 'engine RPC error: {"code":-32002,"message":"ThreadNotFound"}';
    }
    throw new Error(`unexpected ${cmd}`);
  });

  // §9.13: Receipts well empty on startup, no fake rows.
  const receiptRowsEl = byId.get("receipt-rows");
  assert.equal(receiptRowsEl?.children.length, 0);
  assert.doesNotMatch(receiptRowsEl?.textContent ?? "", /servedModel|repo head|engine\.lock/);

  // Connect + room/inspect: no session/read invoked, no verified tone anywhere.
  await controller.connect();
  assert.equal(
    calls.filter((c) => c.cmd === "rpc_request" && c.args?.method === "session/read").length,
    0,
  );
  assert.equal(byId.get("connection-status")?.getAttribute("data-tone"), "neutral");
  assert.equal(
    byId.get("room-counts")?.textContent,
    "4 threads · 1 pass · 1 warn · 2 fail · 0 open decisions",
  );

  const roomRows = byId.get("room-rows")?.children ?? [];
  assert.equal(roomRows.length, 4);
  assert.equal(roomRows[0]?.getAttribute("data-tone"), "neutral");
  assert.equal(roomRows[1]?.getAttribute("data-tone"), "warn");
  assert.equal(roomRows[2]?.getAttribute("data-tone"), "fail");
  assert.match(roomRows[2]?.textContent ?? "", /torn tail/);
  assert.match(roomRows[2]?.textContent ?? "", /crash residue, not tamper/);
  assert.equal(roomRows[3]?.getAttribute("data-tone"), "fail");
  assert.match(roomRows[3]?.textContent ?? "", /prev hash mismatch/);

  // §9.5: Click thr_pass -> session/read once -> verified.
  roomRows[0]?.emit("click");
  await new Promise((r) => setTimeout(r, 0));
  const updatedRows = byId.get("room-rows")?.children ?? [];
  assert.equal(updatedRows[0]?.getAttribute("data-tone"), "verified");
  assert.equal(updatedRows[0]?.children[3]?.textContent, "1");

  // Torn tail with chainOk: false stays fail, events stays "—", adds chainOk false chip.
  sessionReadMode = "torn";
  updatedRows[2]?.emit("keydown", { key: "Enter", preventDefault() {} });
  await new Promise((r) => setTimeout(r, 0));
  const afterTorn = byId.get("room-rows")?.children ?? [];
  assert.equal(afterTorn[2]?.getAttribute("data-tone"), "fail");
  assert.equal(afterTorn[2]?.children[3]?.textContent, "—");
  assert.match(afterTorn[2]?.textContent ?? "", /chainOkfalse/);

  // Short hash -> neutral.
  sessionReadMode = "short-hash";
  await controller.selectThread("thr_pass");
  assert.equal(byId.get("room-rows")?.children[0]?.getAttribute("data-tone"), "neutral");

  // R3 -32002 -> fail, stays CONNECTED.
  sessionReadMode = "not-found";
  await controller.selectThread("thr_pass");
  assert.equal(byId.get("room-rows")?.children[0]?.getAttribute("data-tone"), "fail");
  assert.match(byId.get("room-rows")?.children[0]?.textContent ?? "", /session\/read: -32002/);
  assert.equal(controller.getConnectionState(), "CONNECTED");

  // Inspect room discards cached reads.
  await controller.inspectRoom();
  assert.equal(byId.get("room-rows")?.children[0]?.getAttribute("data-tone"), "neutral");
  assert.equal(byId.get("room-rows")?.children[0]?.children[3]?.textContent, "—");
});

test("M3-A3 §9.6–§9.7 connect_engine failure grammars G1–G6 & ipc.ts parity", async () => {
  assert.equal(EXPECTED_PROTOCOL_VERSION, PROTOCOL_VERSION);

  for (const code of [0, 1, 2, 20, 21, 22, 23, 24, 99, 130, 143, null]) {
    assert.deepEqual(serveExitFromCode(code, null), classifyServeExit({ code, signal: null }));
  }
  assert.deepEqual(serveExitFromCode(null, "9"), classifyServeExit({ code: null, signal: "9" }));

  const stderrSamples = [
    "[boot]\nmadc-engine serve: home owned by pid 4182: /h/engine.lock\n",
    "madc-engine serve: symlink: /h/engine.sock\n",
    "madc-engine serve: home owned by pid 0: /h/engine.lock\n",
    "madc-engine serve: home owned by pid 11: /a\nmadc-engine serve: home owned by pid 22: /b\n",
  ];
  for (const s of stderrSamples) {
    assert.deepEqual(lockOwnerGuidanceFromStderr(s, "darwin"), parseLockOwnerGuidance(s, "darwin"));
    assert.deepEqual(lockOwnerGuidanceFromStderr(s, "win32"), parseLockOwnerGuidance(s, "win32"));
  }

  const cases: Array<{ err: string; expectedState: string; receiptMatch?: RegExp }> = [
    {
      err: "madc-engine serve exited 20 (Owned { code: 20 }). Home lock held by PID 4182 (/h/engine.lock).\nstderr:\nmadc-engine serve: home owned by pid 4182: /h/engine.lock",
      expectedState: "FAILED",
      receiptMatch: /20 owned.*4182.*manually remove \/h\/engine\.lock/,
    },
    {
      err: "madc-engine serve exited 20 (Owned { code: 20 }).",
      expectedState: "FAILED",
      receiptMatch: /20 owned.*home owned by another process/,
    },
    {
      err: "madc-engine serve exited before initialize (code=Some(0), signal=None, class=Clean)",
      expectedState: "DISCONNECTED",
    },
    {
      err: "madc-engine serve exited before initialize (code=None, signal=Some(9), class=Stopped)",
      expectedState: "STOPPED",
      receiptMatch: /signal 9/,
    },
    {
      err: "madc-engine serve exited before initialize (code=Some(23), signal=None, class=Deadline)",
      expectedState: "FAILED",
      receiptMatch: /23 shutdown-deadline/,
    },
    {
      err: "madc-engine serve exited before initialize (code=Some(1), signal=None, class=Fault)",
      expectedState: "FAILED",
      receiptMatch: /24 internal-fault.*raw1/,
    },
    {
      err: "madc-engine serve did not complete initialize within 5000 ms (exit code=None, signal=None)",
      expectedState: "FAILED",
    },
    {
      err: "Windows named-pipe desktop transport is unverified in M3-A2",
      expectedState: "FAILED",
    },
  ];

  for (const c of cases) {
    const { doc, byId } = createShellHarness();
    let count = 0;
    const ctrl = bindDesktopShell(doc, async () => {
      count += 1;
      throw c.err;
    });
    await ctrl.connect();
    assert.equal(count, 1, "no retry");
    assert.equal(ctrl.getConnectionState(), c.expectedState);
    if (c.receiptMatch) {
      assert.match(byId.get("receipt-rows")?.textContent ?? "", c.receiptMatch);
    }
  }
});

test("M3-A3 §9.8–§9.9 & N5 single-flight connect/disconnect, R2/R4 cleanup, and stale-epoch guard", async () => {
  const { doc, byId } = createShellHarness();
  const deferred: {
    resolveConnect: ((v: unknown) => void) | null;
    resolveDisconnect: (() => void) | null;
    rejectStaleRpc: ((e: unknown) => void) | null;
  } = {
    resolveConnect: null,
    resolveDisconnect: null,
    rejectStaleRpc: null,
  };
  let connectCount = 0;
  let disconnectCount = 0;
  let rpcCount = 0;

  const ctrl = bindDesktopShell(doc, (cmd, args) => {
    if (cmd === "connect_engine") {
      connectCount += 1;
      return new Promise((r) => {
        deferred.resolveConnect = r;
      });
    }
    if (cmd === "disconnect_engine") {
      disconnectCount += 1;
      return new Promise<void>((r) => {
        deferred.resolveDisconnect = r;
      });
    }
    if (cmd === "rpc_request") {
      rpcCount += 1;
      if (args?.method === "room/inspect" && rpcCount === 1) {
        return Promise.resolve({
          room: {
            counts: { threads: 1, pass: 1, warn: 0, fail: 0, openDecisions: 0 },
            threads: [
              {
                threadId: "thr_1",
                path: "/t",
                seatId: "kimi",
                level: "pass",
                chain: { ok: true },
                handoff: { inbound: null, outboundCount: 0, oneWay: false },
                worktree: { open: null, close: null, missing: false },
                openDecisions: [],
                findings: [],
              },
            ],
          },
        });
      }
      if (args?.method === "session/read") {
        return new Promise((_, rej) => {
          deferred.rejectStaleRpc = rej;
        });
      }
      return Promise.reject("engine socket closed before response");
    }
    return Promise.reject(new Error(`unexpected ${cmd}`));
  });

  // Single-flight connect.
  const p1 = ctrl.connect();
  const p2 = ctrl.connect();
  assert.equal(connectCount, 1);
  assert.equal(byId.get("connect-btn")?.disabled, true);
  ctrl.openPalette();
  assert.equal(byId.get("palette-list")?.children[1]?.getAttribute("aria-disabled"), "true");
  ctrl.closePalette();
  deferred.resolveConnect?.({
    socketPath: "/tmp/e.sock",
    reusedExisting: false,
    protocolVersion: PROTOCOL_VERSION,
    serverName: "madc-engine",
    serverVersion: "0.0.0",
    coldStartMs: 10,
  });
  await Promise.all([p1, p2]);
  assert.equal(ctrl.getConnectionState(), "CONNECTED");

  // Start an in-flight session/read in epoch 1 (also test in-flight dedupe).
  const read1 = ctrl.selectThread("thr_1");
  const read2 = ctrl.selectThread("thr_1");
  assert.equal(rpcCount, 2, "second selectThread while pending must dedupe");

  // Trigger R4 on room/inspect -> FAILED + single disconnect_engine.
  const inspectPromise = ctrl.inspectRoom();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(ctrl.getConnectionState(), "FAILED");
  assert.equal(disconnectCount, 1);
  assert.equal(byId.get("connect-btn")?.disabled, true);

  // Second disconnect while pending issues no second call.
  const d2 = ctrl.disconnect();
  assert.equal(disconnectCount, 1);

  // N5: stale-epoch R2 rejection must NOT flip FAILED to DISCONNECTED (both while pending and after settle).
  deferred.rejectStaleRpc?.("not connected to @madc/engine");
  await Promise.all([read1, read2]);
  assert.equal(ctrl.getConnectionState(), "FAILED");

  deferred.resolveDisconnect?.();
  await Promise.all([inspectPromise, d2]);
  assert.equal(ctrl.getConnectionState(), "FAILED");
  assert.equal(byId.get("connect-btn")?.disabled, false);

  // Also test stale-epoch R2 rejection after disconnectPending has settled (only reqEpoch !== epoch guards this).
  const { doc: doc2 } = createShellHarness();
  let rejectEpoch1Read: ((e: unknown) => void) | null = null;
  let rpcCallNum = 0;
  const ctrl2 = bindDesktopShell(doc2, (cmd, args) => {
    if (cmd === "connect_engine") {
      return Promise.resolve({
        socketPath: "/tmp/e.sock",
        reusedExisting: false,
        protocolVersion: PROTOCOL_VERSION,
        serverName: "madc-engine",
        serverVersion: "0.0.0",
        coldStartMs: 10,
      });
    }
    if (cmd === "disconnect_engine") return Promise.resolve();
    if (cmd === "rpc_request") {
      rpcCallNum += 1;
      if (args?.method === "room/inspect" && rpcCallNum === 1) {
        return Promise.resolve({
          room: {
            counts: { threads: 1, pass: 1, warn: 0, fail: 0, openDecisions: 0 },
            threads: [
              {
                threadId: "thr_1",
                path: "/t",
                seatId: "kimi",
                level: "pass",
                chain: { ok: true },
                handoff: { inbound: null, outboundCount: 0, oneWay: false },
                worktree: { open: null, close: null, missing: false },
                openDecisions: [],
                findings: [],
              },
            ],
          },
        });
      }
      if (args?.method === "session/read") {
        return new Promise((_, rej) => {
          rejectEpoch1Read = rej;
        });
      }
      return Promise.reject("engine socket closed before response");
    }
    return Promise.reject(new Error(`unexpected ${cmd}`));
  });
  await ctrl2.connect();
  const staleRead = ctrl2.selectThread("thr_1");
  await ctrl2.inspectRoom(); // R4 -> FAILED, disconnect_engine settles
  assert.equal(ctrl2.getConnectionState(), "FAILED");
  (rejectEpoch1Read as ((e: unknown) => void) | null)?.("not connected to @madc/engine");
  await staleRead;
  assert.equal(ctrl2.getConnectionState(), "FAILED");
});

test("M3-A3 §9.10, §9.12 Command palette closed list, subsequence filter, keyboard nav, and tauri.conf.json (updated A4 §2.3 (1))", () => {
  assert.deepEqual(
    PALETTE_COMMANDS.map((c) => c.id),
    [
      "cmd-connect",
      "cmd-inspect-room",
      "cmd-disconnect",
      "cmd-focus-engine",
      "cmd-focus-room",
      "cmd-focus-decisions",
      "cmd-focus-search",
      "cmd-copy-chain-head",
      "cmd-copy-served-model",
      "cmd-copy-head-open",
      "cmd-view-panes",
      "cmd-view-table",
      "cmd-pane-focus-1",
      "cmd-pane-focus-2",
      "cmd-pane-focus-3",
      "cmd-pane-focus-4",
      "cmd-pane-hide",
      "cmd-pane-dismiss",
      "cmd-turn-start",
    ],
  );

  // Subsequence over command name only (group name "evidence" matches nothing).
  assert.deepEqual(
    filterCommands(PALETTE_COMMANDS, "insrm").map((m) => m.command.id),
    ["cmd-inspect-room"],
  );
  assert.equal(filterCommands(PALETTE_COMMANDS, "evidence").length, 0);

  // Step palette skips disabled rows and wraps.
  const cmds = PALETTE_COMMANDS.map((c) => ({
    ...c,
    disabled: c.id === "cmd-inspect-room" || c.id === "cmd-disconnect",
  }));
  let state = createPaletteState(cmds, "", true);
  assert.equal(state.activeId, "cmd-connect");
  state = stepPalette(state, "ArrowDown");
  assert.equal(state.activeId, "cmd-focus-engine");
  state = stepPalette(state, "End");
  assert.equal(state.activeId, "cmd-turn-start");
  state = stepPalette(state, "ArrowDown");
  assert.equal(state.activeId, "cmd-connect");
  state = stepPalette(state, "ArrowUp");
  assert.equal(state.activeId, "cmd-turn-start");

  // Toggle + Esc focus restore in harness.
  const { doc, byId } = createShellHarness();
  const connectBtn = byId.get("connect-btn");
  const ctrl = bindDesktopShell(doc, async () => ({}), { platform: "darwin" });
  connectBtn?.focus();
  ctrl.handleKeydown({ key: "k", metaKey: true, ctrlKey: false, preventDefault() {} });
  assert.equal(byId.get("palette")?.hidden, false);
  assert.equal(byId.get("main-content")?.inert, true);
  ctrl.handleKeydown({ key: "Escape", preventDefault() {} });
  assert.equal(byId.get("palette")?.hidden, true);
  assert.equal(doc.activeElement, connectBtn);

  // §9.12: tauri.conf.json window minimum.
  const confPath = fileURLToPath(new URL("../src-tauri/tauri.conf.json", import.meta.url));
  const conf = JSON.parse(readFileSync(confPath, "utf8")) as {
    app: { windows: Array<Record<string, unknown>>; security: { csp: string } };
    bundle: { active: boolean };
  };
  const win = conf.app.windows[0];
  assert.equal(win?.minWidth, 960);
  assert.equal(win?.minHeight, 640);
  assert.equal(win?.width, 1200);
  assert.equal(win?.height, 800);
  assert.equal(win?.resizable, true);
  assert.equal(conf.bundle.active, false);
  assert.equal(conf.app.security.csp, "default-src 'self'; script-src 'self'; style-src 'self'");
});

test("M3-A3 review fixes: H1 single keydown listener, M1 inert-aware focus, L3 Copy chain head honesty, and §9.10 keys", async () => {
  // H1: app.js-style single doc keydown listener toggles once and steps once.
  const { doc, byId, buttons } = createShellHarness();
  const ctrl = bindDesktopShell(doc, async () => ({}), { platform: "darwin" });
  doc.addEventListener?.("keydown", (ev) => ctrl.handleKeydown(ev));

  doc.emit("keydown", { key: "k", metaKey: true, ctrlKey: false, preventDefault() {} });
  assert.equal(byId.get("palette")?.hidden, false, "single Cmd+K must leave palette open");
  assert.equal(byId.get("palette-input")?.getAttribute("aria-activedescendant"), "cmd-connect");
  doc.emit("keydown", { key: "ArrowDown", preventDefault() {} });
  assert.equal(
    byId.get("palette-input")?.getAttribute("aria-activedescendant"),
    "cmd-focus-engine",
    "single ArrowDown must step exactly one enabled row",
  );

  // §9.10: Tab / Shift+Tab trapped while open (preventDefault + focus stays on input), Home jumps to first enabled row.
  const palInput = byId.get("palette-input");
  const focusBeforeTab = palInput?.focusedCount ?? 0;
  let tabPrevented = 0;
  doc.emit("keydown", {
    key: "Tab",
    shiftKey: false,
    preventDefault() {
      tabPrevented += 1;
    },
  });
  assert.equal(tabPrevented, 1, "Tab must call preventDefault while palette is open");
  assert.equal(palInput?.focusedCount, focusBeforeTab + 1);
  assert.equal(doc.activeElement, palInput);

  let shiftTabPrevented = 0;
  doc.emit("keydown", {
    key: "Tab",
    shiftKey: true,
    preventDefault() {
      shiftTabPrevented += 1;
    },
  });
  assert.equal(shiftTabPrevented, 1, "Shift+Tab must call preventDefault while palette is open");
  assert.equal(palInput?.focusedCount, focusBeforeTab + 2);
  assert.equal(doc.activeElement, palInput);

  doc.emit("keydown", { key: "End", preventDefault() {} });
  assert.equal(byId.get("palette-input")?.getAttribute("aria-activedescendant"), "cmd-view-panes");
  doc.emit("keydown", { key: "Home", preventDefault() {} });
  assert.equal(byId.get("palette-input")?.getAttribute("aria-activedescendant"), "cmd-connect");

  // M1 + L-M1b: All four Focus commands clear inert BEFORE focusing the target button.
  const focusCases: Array<{ cmdId: string; buttonIndex: number; label: string }> = [
    { cmdId: "cmd-focus-engine", buttonIndex: 0, label: "Focus Engine" },
    { cmdId: "cmd-focus-room", buttonIndex: 1, label: "Focus Room" },
    { cmdId: "cmd-focus-decisions", buttonIndex: 2, label: "Focus Decisions" },
    { cmdId: "cmd-focus-search", buttonIndex: 3, label: "Focus Search" },
  ];
  for (const fc of focusCases) {
    if (byId.get("palette")?.hidden) {
      doc.emit("keydown", { key: "k", metaKey: true, ctrlKey: false, preventDefault() {} });
    }
    let steps = 0;
    while (byId.get("palette-input")?.getAttribute("aria-activedescendant") !== fc.cmdId) {
      doc.emit("keydown", { key: "ArrowDown", preventDefault() {} });
      steps += 1;
      assert.ok(steps < 12, `could not reach ${fc.cmdId}`);
    }
    doc.emit("keydown", { key: "Enter", preventDefault() {} });
    assert.equal(byId.get("palette")?.hidden, true);
    assert.equal(byId.get("focus-bar")?.inert, false);
    assert.equal(doc.activeElement, buttons[fc.buttonIndex], `${fc.label} must focus button`);
  }

  // §9.10: Non-Mac Ctrl+K and empty state ("No matching command", Enter is no-op).
  const { doc: linDoc, byId: linById } = createShellHarness();
  const linCtrl = bindDesktopShell(linDoc, async () => ({}), { platform: "linux" });
  linDoc.addEventListener?.("keydown", (ev) => linCtrl.handleKeydown(ev));
  linDoc.emit("keydown", { key: "k", metaKey: false, ctrlKey: true, preventDefault() {} });
  assert.equal(linById.get("palette")?.hidden, false);
  const inputEl = linById.get("palette-input");
  if (inputEl) {
    inputEl.value = "zzzzz";
    inputEl.emit("input", { target: { value: "zzzzz" } });
  }
  assert.equal(linById.get("palette-list")?.textContent, "No matching command");
  assert.equal(linById.get("palette-live")?.textContent, "No matching command");
  linDoc.emit("keydown", { key: "Enter", preventDefault() {} });
  assert.equal(linById.get("palette")?.hidden, false, "Enter on empty state does nothing");

  // L3: warn row with chainOk: true and 64-hex hash must NOT enable Copy chain head.
  const { doc: l3Doc, byId: l3ById } = createShellHarness();
  const l3Ctrl = bindDesktopShell(
    l3Doc,
    async (cmd, args) => {
      if (cmd === "connect_engine") {
        return {
          socketPath: "/tmp/e.sock",
          reusedExisting: false,
          protocolVersion: PROTOCOL_VERSION,
          serverName: "madc-engine",
          serverVersion: "0.0.0",
          coldStartMs: 5,
        };
      }
      if (cmd === "rpc_request" && args?.method === "room/inspect") {
        return {
          room: {
            counts: { threads: 1, pass: 0, warn: 1, fail: 0, openDecisions: 0 },
            threads: [
              {
                threadId: "thr_warn",
                path: "/t",
                seatId: "kimi",
                level: "warn",
                chain: { ok: true },
                handoff: { inbound: null, outboundCount: 0, oneWay: false },
                worktree: { open: null, close: null, missing: false },
                openDecisions: [],
                findings: [{ level: "warn", code: "W_TEST", detail: "warn" }],
              },
            ],
          },
        };
      }
      if (cmd === "rpc_request" && args?.method === "session/read") {
        return {
          threadId: "thr_warn",
          chainOk: true,
          events: [{ seq: 1, hash: "b".repeat(64) }],
        };
      }
      return {};
    },
    { globalObj: { navigator: { clipboard: { writeText: async () => {} } } } },
  );
  await l3Ctrl.connect();
  await l3Ctrl.selectThread("thr_warn");
  l3Ctrl.openPalette();
  const copyRow = l3ById.get("palette-list")?.children.find((c) => c.id === "cmd-copy-chain-head");
  assert.equal(copyRow?.getAttribute("aria-disabled"), "true");
});

test("M3-A3 review fixes: §9.6 G3/G6, §9.8 protocol mismatch, §9.9 R4/disconnect reject, L2 FAILED text, N5/L4 stale room/inspect", async () => {
  // §9.6: G3 (2, 21, 22, 24, 130, 143) and G6 unclassified rejection + L2 lowercase FAILED text.
  const g3Cases: Array<{ err: string; state: string; receipt?: RegExp }> = [
    {
      err: "madc-engine serve exited before initialize (code=Some(2), signal=None, class=Usage)",
      state: "FAILED",
      receipt: /2 usage-or-home/,
    },
    {
      err: "madc-engine serve exited before initialize (code=Some(21), signal=None, class=Unsafe)",
      state: "FAILED",
      receipt: /21 unsafe-path/,
    },
    {
      err: "madc-engine serve exited before initialize (code=Some(22), signal=None, class=Listen)",
      state: "FAILED",
      receipt: /22 listen-error/,
    },
    {
      err: "madc-engine serve exited before initialize (code=Some(24), signal=None, class=Fault)",
      state: "FAILED",
      receipt: /24 internal-fault/,
    },
    {
      err: "madc-engine serve exited before initialize (code=Some(130), signal=None, class=Clean)",
      state: "DISCONNECTED",
      receipt: /serve exit130/,
    },
    {
      err: "madc-engine serve exited before initialize (code=Some(143), signal=None, class=Clean)",
      state: "DISCONNECTED",
      receipt: /serve exit143/,
    },
    { err: "failed to spawn madc-engine serve: ENOENT", state: "FAILED" },
  ];
  for (const c of g3Cases) {
    const { doc, byId } = createShellHarness();
    const ctrl = bindDesktopShell(doc, async () => {
      throw c.err;
    });
    await ctrl.connect();
    assert.equal(ctrl.getConnectionState(), c.state);
    if (c.state === "FAILED") {
      assert.equal(
        byId.get("connection-status")?.children[1]?.textContent,
        "engine connection failed (no automatic retry)",
      );
    }
    if (c.receipt) {
      assert.match(byId.get("receipt-rows")?.textContent ?? "", c.receipt);
    }
  }

  // §9.8: Protocol mismatch invokes disconnect_engine once, skips room/inspect, stays FAILED.
  const { doc: pmDoc, byId: pmById } = createShellHarness();
  const pmCalls: string[] = [];
  const pmCtrl = bindDesktopShell(pmDoc, async (cmd) => {
    pmCalls.push(cmd);
    if (cmd === "connect_engine") {
      return {
        socketPath: "/tmp/e.sock",
        reusedExisting: false,
        protocolVersion: "madc-m0/1",
        serverName: "madc-engine",
        serverVersion: "0.0.0",
        coldStartMs: 12,
      };
    }
    return undefined;
  });
  await pmCtrl.connect();
  assert.deepEqual(pmCalls, ["connect_engine", "disconnect_engine"]);
  assert.equal(pmCtrl.getConnectionState(), "FAILED");
  assert.match(
    pmById.get("receipt-rows")?.textContent ?? "",
    /expected madc-m1\/1 · got madc-m0\/1/,
  );

  // §9.9: disconnect_engine rejection ("engine state lock poisoned") + real R4 variants + N5 + L4.
  for (const r4Err of [
    "engine socket closed before response",
    "RPC room/inspect timed out waiting for reply",
    "socket read failed: broken pipe",
  ]) {
    const { doc, byId } = createShellHarness();
    const deferred: {
      resolveDisc: (() => void) | null;
      rejectDisc: ((e: unknown) => void) | null;
    } = { resolveDisc: null, rejectDisc: null };
    let discCalls = 0;
    let inspectCalls = 0;
    const rpcMethods: string[] = [];
    const ctrl = bindDesktopShell(doc, (cmd, args) => {
      if (cmd === "connect_engine") {
        return Promise.resolve({
          socketPath: "/tmp/e.sock",
          reusedExisting: false,
          protocolVersion: PROTOCOL_VERSION,
          serverName: "madc-engine",
          serverVersion: "0.0.0",
          coldStartMs: 10,
        });
      }
      if (cmd === "disconnect_engine") {
        discCalls += 1;
        return new Promise<void>((res, rej) => {
          deferred.resolveDisc = res;
          deferred.rejectDisc = rej;
        });
      }
      if (cmd === "rpc_request") {
        const method = String(args?.method ?? "");
        rpcMethods.push(method);
        if (method === "room/inspect") {
          inspectCalls += 1;
          if (inspectCalls === 1) {
            return Promise.resolve({
              room: {
                counts: { threads: 0, pass: 0, warn: 0, fail: 0, openDecisions: 0 },
                threads: [],
              },
            });
          }
          return Promise.reject(r4Err);
        }
        return Promise.resolve({ threadId: "thr_unexpected", events: [], chainOk: true });
      }
      return Promise.reject(new Error(`unexpected ${cmd}`));
    });

    // selectThread inert when IDLE (not CONNECTED).
    await ctrl.selectThread("thr_while_idle");
    assert.equal(rpcMethods.filter((m) => m === "session/read").length, 0);

    await ctrl.connect();

    // Trigger R4 -> disconnectPending is true.
    const insp = ctrl.inspectRoom();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(discCalls, 1);
    ctrl.openPalette();
    const connectRow = byId.get("palette-list")?.children.find((c) => c.id === "cmd-connect");
    const discRow = byId.get("palette-list")?.children.find((c) => c.id === "cmd-disconnect");
    assert.equal(connectRow?.getAttribute("aria-disabled"), "true");
    assert.equal(discRow?.getAttribute("aria-disabled"), "true");
    assert.match(connectRow?.textContent ?? "", /disconnecting/);
    assert.match(discRow?.textContent ?? "", /disconnecting/);
    ctrl.closePalette();

    await ctrl.selectThread("thr_inert");
    assert.equal(
      rpcMethods.filter((m) => m === "session/read").length,
      0,
      "selectThread must be inert while disconnectPending",
    );

    deferred.rejectDisc?.("engine state lock poisoned");
    await insp;
    assert.equal(ctrl.getConnectionState(), "FAILED");
    assert.equal(byId.get("output")?.textContent, "engine state lock poisoned");
    assert.equal(byId.get("connect-btn")?.disabled, false);
    assert.equal(discCalls, 1, "no retry on disconnect_engine reject");

    await ctrl.selectThread("thr_while_failed");
    assert.equal(
      rpcMethods.filter((m) => m === "session/read").length,
      0,
      "selectThread must be inert when FAILED",
    );
  }

  // N5: selectThread must ALSO be inert during user-initiated disconnect (state stays CONNECTED while disconnectPending).
  {
    const { doc } = createShellHarness();
    const deferred: { resolveDisc: (() => void) | null } = { resolveDisc: null };
    const rpcMethods: string[] = [];
    const ctrl = bindDesktopShell(doc, (cmd, args) => {
      if (cmd === "connect_engine") {
        return Promise.resolve({
          socketPath: "/tmp/e.sock",
          reusedExisting: false,
          protocolVersion: PROTOCOL_VERSION,
          serverName: "madc-engine",
          serverVersion: "0.0.0",
          coldStartMs: 10,
        });
      }
      if (cmd === "disconnect_engine") {
        return new Promise<void>((res) => {
          deferred.resolveDisc = res;
        });
      }
      if (cmd === "rpc_request") {
        const method = String(args?.method ?? "");
        rpcMethods.push(method);
        if (method === "room/inspect") {
          return Promise.resolve({
            room: {
              counts: { threads: 0, pass: 0, warn: 0, fail: 0, openDecisions: 0 },
              threads: [],
            },
          });
        }
        return Promise.resolve({ threadId: "thr_unexpected", events: [], chainOk: true });
      }
      return Promise.reject(new Error(`unexpected ${cmd}`));
    });
    await ctrl.connect();
    const userDisc = ctrl.disconnect();
    assert.equal(ctrl.getConnectionState(), "CONNECTED");
    await ctrl.selectThread("thr_during_user_disconnect");
    assert.equal(
      rpcMethods.filter((m) => m === "session/read").length,
      0,
      "selectThread must be inert while user disconnect is pending",
    );
    deferred.resolveDisc?.();
    await userDisc;
    assert.equal(ctrl.getConnectionState(), "DISCONNECTED");
  }

  // N5 + L4: earlier-epoch room/inspect R2 & R4 rejections do not clear cache or change state/disconnect.
  for (const staleErr of [
    "not connected to @madc/engine",
    "engine socket closed before response",
  ]) {
    const { doc, byId } = createShellHarness();
    const deferred: { rejectInspect: ((e: unknown) => void) | null } = { rejectInspect: null };
    let inspectNum = 0;
    let discCalls = 0;
    const ctrl = bindDesktopShell(doc, (cmd, args) => {
      if (cmd === "connect_engine") {
        return Promise.resolve({
          socketPath: "/tmp/e.sock",
          reusedExisting: false,
          protocolVersion: PROTOCOL_VERSION,
          serverName: "madc-engine",
          serverVersion: "0.0.0",
          coldStartMs: 10,
        });
      }
      if (cmd === "disconnect_engine") {
        discCalls += 1;
        return Promise.resolve();
      }
      if (cmd === "rpc_request" && args?.method === "room/inspect") {
        inspectNum += 1;
        if (inspectNum === 1) {
          return Promise.resolve({
            room: {
              counts: { threads: 1, pass: 1, warn: 0, fail: 0, openDecisions: 0 },
              threads: [
                {
                  threadId: "thr_keep",
                  path: "/t",
                  seatId: "kimi",
                  level: "pass",
                  chain: { ok: true },
                  handoff: { inbound: null, outboundCount: 0, oneWay: false },
                  worktree: { open: null, close: null, missing: false },
                  openDecisions: [],
                  findings: [],
                },
              ],
            },
          });
        }
        return new Promise((_, rej) => {
          deferred.rejectInspect = rej;
        });
      }
      if (cmd === "rpc_request" && args?.method === "session/read") {
        return Promise.resolve({
          threadId: "thr_keep",
          chainOk: true,
          events: [{ seq: 1, hash: "c".repeat(64) }],
        });
      }
      return Promise.reject(new Error(`unexpected ${cmd}`));
    });
    await ctrl.connect();
    await ctrl.selectThread("thr_keep");
    assert.equal(byId.get("room-rows")?.children[0]?.getAttribute("data-tone"), "verified");

    const staleInspect = ctrl.inspectRoom();
    await ctrl.disconnect(); // increments epoch, transitions to DISCONNECTED
    assert.equal(discCalls, 1);
    deferred.rejectInspect?.(staleErr);
    await staleInspect;
    assert.equal(ctrl.getConnectionState(), "DISCONNECTED");
    assert.equal(discCalls, 1, "stale room/inspect must not invoke disconnect_engine");
    assert.equal(
      byId.get("room-rows")?.children[0]?.getAttribute("data-tone"),
      "verified",
      "L4: stale room/inspect rejection must not wipe room well",
    );
  }
});

// ---------------------------------------------------------------------------
// Room-table track budget (spec §5.4, pin §5.2).
//
// `styles.css` is resolved arithmetically, the way a grid engine resolves the track forms
// this file uses: fixed lengths, `clamp()`, `minmax(A, B)`, `minmax(A, Bfr)` and `Nfr`. A
// page-level overflow check cannot see the bug this guards. The Room well is
// `overflow: hidden`, so at the 960px minimum the receipt track resolved to 0px and every
// evidence chip was invisible while `scrollWidth` stayed equal to `clientWidth`.
// ---------------------------------------------------------------------------

/**
 * Spec §5.4: chip values truncate to the 12-hex rule and never below it. The 12-hex `hash`
 * chip measures 144.81px, and the widest pre-read chip pair (`chain FAILED` + `line 2`)
 * 181.81px, in WebKit 27.2 and Chromium 159. 168px keeps the hash chip inside the track and
 * that pair inside the track plus the row's 16px right padding.
 */
const RECEIPT_TRACK_MIN_PX = 168;

/**
 * The folded `THREAD · SEAT` cell keeps a 96px floor below 1200px (spec r2 §6.5 (a) 3).
 */
const THREAD_TRACK_MIN_PX = 96;

type GridTrack = { base: number; limit: number; flex: number };
type CssRule = {
  selectors: string[];
  maxWidth: number | null;
  declarations: Record<string, string>;
};
type DesktopLayout = {
  viewport: number;
  /** Resolved `#main-content` column tracks, the gap between them, and the content box. */
  columns: number[];
  columnGap: number;
  mainBox: number;
  /** Resolved Room-table tracks, the gap between them, and the row's content box. */
  tracks: number[];
  trackGap: number;
  roomBox: number;
};

const FRACTION = "(\\d+(?:\\.\\d+)?)";
const sum = (values: readonly number[]): number =>
  values.reduce((total, value) => total + value, 0);

/** One `grid-template-columns` value, with `clamp()` resolved against `viewport`. */
function parseGridTracks(value: string, viewport: number): GridTrack[] {
  return value
    .trim()
    .replace(/,\s+/g, ",")
    .split(/\s+/)
    .map((token): GridTrack => {
      const clamp = token.match(
        new RegExp(`^clamp\\(${FRACTION}px,${FRACTION}vw,${FRACTION}px\\)$`),
      );
      if (clamp) {
        // `<n>vw` is n hundredths of the viewport width.
        const preferred = (Number(clamp[2]) / 100) * viewport;
        const size = Math.min(Math.max(preferred, Number(clamp[1])), Number(clamp[3]));
        return { base: size, limit: size, flex: 0 };
      }
      // `minmax(0, 1fr)`: a minimum may be a unitless zero.
      const range = token.match(new RegExp(`^minmax\\(${FRACTION}(?:px)?,${FRACTION}(px|fr)\\)$`));
      if (range) {
        const base = Number(range[1]);
        return range[3] === "fr"
          ? { base, limit: Number.POSITIVE_INFINITY, flex: Number(range[2]) }
          : { base, limit: Number(range[2]), flex: 0 };
      }
      const fixed = token.match(new RegExp(`^${FRACTION}px$`));
      if (fixed) return { base: Number(fixed[1]), limit: Number(fixed[1]), flex: 0 };
      const flex = token.match(new RegExp(`^${FRACTION}fr$`));
      if (flex) return { base: 0, limit: Number.POSITIVE_INFINITY, flex: Number(flex[1]) };
      throw new Error(`desktop.test.ts: unsupported grid track "${token}"`);
    });
}

/** Track sizes inside a `box`px content box: maximize first, then expand flexible tracks. */
function sizeGridTracks(tracks: readonly GridTrack[], box: number): number[] {
  const size = tracks.map((track) => track.base);
  for (let spare = box - sum(size); spare > 0; spare = box - sum(size)) {
    const growable = tracks.flatMap((track, index) =>
      track.flex === 0 && (size[index] ?? 0) < track.limit ? [index] : [],
    );
    if (growable.length === 0) break;
    for (const index of growable) {
      size[index] = Math.min(
        tracks[index]?.limit ?? 0,
        (size[index] ?? 0) + spare / growable.length,
      );
    }
  }
  // A flexible track that would land below its base is frozen there and the rest re-divide.
  const frozen = new Set<number>();
  for (;;) {
    const flexible = tracks.flatMap((track, index) =>
      track.flex > 0 && !frozen.has(index) ? [index] : [],
    );
    if (flexible.length === 0) break;
    // Leftover space is measured against what the other tracks already occupy.
    const used = tracks.reduce(
      (total, track, index) =>
        total + (track.flex === 0 || frozen.has(index) ? (size[index] ?? 0) : 0),
      0,
    );
    const flexSum = Math.max(1, sum(flexible.map((index) => tracks[index]?.flex ?? 0)));
    const fr = Math.max(0, box - used) / flexSum;
    const belowBase = flexible.filter((index) => {
      const track = tracks[index];
      return track !== undefined && fr * track.flex < track.base;
    });
    if (belowBase.length === 0) {
      for (const index of flexible) size[index] = fr * (tracks[index]?.flex ?? 0);
      break;
    }
    for (const index of belowBase) {
      frozen.add(index);
      size[index] = tracks[index]?.base ?? 0;
    }
  }
  return size;
}

/** Every style rule in `css`, each tagged with the `max-width` of its enclosing media block. */
function cssRules(css: string): CssRule[] {
  const rules: CssRule[] = [];
  const maxWidths: Array<number | null> = [];
  let prelude = "";
  let selectorText = "";
  let body: string | null = null;
  for (const char of css.replace(/\/\*[\s\S]*?\*\//g, "")) {
    if (char === "{") {
      selectorText = prelude.trim();
      if (selectorText === "@font-face") {
        body = "";
      } else if (selectorText.startsWith("@")) {
        const media = selectorText.match(/^@media \(max-width: (\d+)px\)$/);
        maxWidths.push(media ? Number(media[1]) : null);
      } else {
        body = "";
      }
      prelude = "";
    } else if (char === "}") {
      if (body === null) {
        maxWidths.pop();
      } else {
        const selectors = selectorText.split(",").map((selector) => selector.trim());
        if ((selectors[0] ?? "").startsWith("@") === false) {
          const declarations: Record<string, string> = {};
          for (const entry of body.split(";")) {
            const colon = entry.indexOf(":");
            if (colon !== -1) {
              declarations[entry.slice(0, colon).trim()] = entry.slice(colon + 1).trim();
            }
          }
          rules.push({ selectors, maxWidth: maxWidths.at(-1) ?? null, declarations });
        }
        body = null;
      }
      prelude = "";
    } else if (body === null) {
      prelude += char;
    } else {
      body += char;
    }
  }
  return rules;
}

/** The last rule in source order that has `selector` and declares `property` at `width`. */
function lastRule(
  rules: readonly CssRule[],
  selector: string,
  property: string,
  width: number,
): CssRule {
  let found: CssRule | undefined;
  for (const rule of rules) {
    if (
      rule.selectors.includes(selector) &&
      (rule.maxWidth === null || rule.maxWidth >= width) &&
      rule.declarations[property] !== undefined
    ) {
      found = rule;
    }
  }
  assert.ok(found !== undefined, `${selector} declares no ${property} at ${width}px`);
  return found;
}

function desktopLayoutAt(rules: readonly CssRule[], viewport: number): DesktopLayout {
  const declaration = (selector: string, property: string): string =>
    lastRule(rules, selector, property, viewport).declarations[property] ?? "";
  const length = (value: string): number => {
    const token = value.match(/^var\((--[\w-]+)\)$/);
    const resolved = token ? declaration(":root", token[1] ?? "") : value;
    assert.match(resolved, /^\d+(?:\.\d+)?px$/, `not a pixel length: ${value}`);
    return Number.parseFloat(resolved);
  };
  /** Horizontal part of a one- or two-value padding shorthand. */
  const horizontal = (value: string): number => {
    const parts = value.split(/\s+/);
    return length(parts.length === 1 ? (parts[0] ?? "") : (parts[1] ?? ""));
  };

  const mainTracks = parseGridTracks(
    declaration("#main-content", "grid-template-columns"),
    viewport,
  );
  const columnGap = length(declaration("#main-content", "gap"));
  const mainBox = viewport - 2 * horizontal(declaration("#main-content", "padding"));
  const columns = sizeGridTracks(mainTracks, mainBox - columnGap);

  const leftColumn = columns[0] ?? 0;
  const roomTracks = parseGridTracks(
    declaration(".room-thead", "grid-template-columns"),
    leftColumn,
  );
  const trackGap = length(declaration(".room-thead", "gap"));
  const wellBorder = length(declaration(".well", "border").split(/\s+/)[0] ?? "");
  const roomBox = leftColumn - 2 * wellBorder - 2 * horizontal(declaration(".room-row", "padding"));
  const tracks = sizeGridTracks(roomTracks, roomBox - trackGap * (roomTracks.length - 1));
  return { viewport, columns, columnGap, mainBox, tracks, trackGap, roomBox };
}

function describeLayout(layout: DesktopLayout): string {
  const tracks = (values: readonly number[]): string =>
    values.map((value) => value.toFixed(2)).join(" + ");
  return `${layout.viewport}px: #main-content ${tracks(layout.columns)} (gap ${layout.columnGap}) in ${layout.mainBox}px; Room ${tracks(layout.tracks)} (gap ${layout.trackGap}) in ${layout.roomBox}px`;
}

test("M3-A3 spec §5.4 / A4 §5.2 D-693 track budget: the Room receipt track never collapses from the 960px minimum up", () => {
  const css = readFileSync(fileURLToPath(new URL("../ui/styles.css", import.meta.url)), "utf8");
  const rules = cssRules(css);
  const widths = [...Array.from({ length: 441 }, (_, index) => 960 + index), 1440, 1920, 2560];
  for (const width of widths) {
    const layout = desktopLayoutAt(rules, width);
    const at = describeLayout(layout);
    assert.equal(layout.columns.length, 2, `${at}: no longer two columns`);
    const rightColumn = layout.columns[1] ?? 0;
    assert.ok(rightColumn >= 360 && rightColumn <= 440, `${at}: right column size`);
    assert.ok(
      Math.abs(sum(layout.columns) + layout.columnGap - layout.mainBox) < 0.01,
      `${at}: #main-content overflows`,
    );
    assert.ok(
      layout.tracks.every((track) => track > 0),
      `${at}: a Room track collapsed`,
    );
    assert.ok(
      Math.abs(sum(layout.tracks) + layout.trackGap * (layout.tracks.length - 1) - layout.roomBox) <
        0.01,
      `${at}: Room tracks overflow the row`,
    );
    const receipt = layout.tracks.at(-1) ?? 0;
    assert.ok(receipt >= RECEIPT_TRACK_MIN_PX, `${at}: receipt track below its floor`);
    if (width < 1200) {
      assert.ok(
        (layout.tracks[1] ?? 0) >= THREAD_TRACK_MIN_PX,
        `${at}: THREAD·SEAT track below 96px floor`,
      );
    }
    if (width >= 1200) {
      assert.deepEqual(layout.tracks.slice(0, 4), [148, 100, 108, 48], `${at}: frame columns`);
      assert.ok(receipt >= 194, `${at}: frame receipt track`);
    }
  }

  // The pinned minimum (A4 §5.2 / spec §6.5 (a) 3): 960 - 2x28 padding - 24 gap - 360 right
  // column leaves 520px; less the well border and row padding, 486px for four tracks (THREAD · SEAT folded).
  const minimum = desktopLayoutAt(rules, 960);
  const expected = [
    [520, 360],
    [140, 96, 48, 178],
  ];
  for (const [index, values] of [minimum.columns, minimum.tracks].entries()) {
    const wanted = expected[index] ?? [];
    for (const [position, value] of values.entries()) {
      assert.ok(Math.abs(value - (wanted[position] ?? 0)) < 0.01, describeLayout(minimum));
    }
  }
});

test("M3-A3 spec §5.4 / A4 §5.2 D-693 breakpoints: right column 360-440px, Room tracks folded THREAD·SEAT (960-1199px)", () => {
  const css = readFileSync(fileURLToPath(new URL("../ui/styles.css", import.meta.url)), "utf8");
  const rules = cssRules(css);
  const columnsAt = (width: number): string =>
    lastRule(rules, "#main-content", "grid-template-columns", width).declarations[
      "grid-template-columns"
    ] ?? "";
  const tracksAt = (width: number): CssRule =>
    lastRule(rules, ".room-thead", "grid-template-columns", width);

  const band = lastRule(rules, "#main-content", "grid-template-columns", 1199);
  assert.equal(band.maxWidth, 1199);
  assert.equal(columnsAt(1199), "minmax(0, 1fr) clamp(360px, 37.5vw, 440px)");
  assert.equal(columnsAt(1200), "minmax(0, 1fr) 440px");
  assert.equal(columnsAt(959), "1fr");

  const bandTracks = tracksAt(1199);
  assert.equal(bandTracks.maxWidth, 1199);
  assert.deepEqual(bandTracks.selectors, [".room-thead", ".room-row"]);
  assert.equal(
    bandTracks.declarations["grid-template-columns"],
    "140px minmax(96px, 0.62fr) 48px minmax(168px, 1.9fr)",
  );
  assert.equal(lastRule(rules, ".room-thead", "gap", 1199).declarations.gap, "var(--madc-space-2)");
  assert.equal(
    tracksAt(1200).declarations["grid-template-columns"],
    "148px 100px 108px 48px minmax(0, 1fr)",
  );

  // Empty-state row outranks .room-row rules at every width.
  const weight = (selector: string): number =>
    100 * (selector.match(/#[\w-]+/g) ?? []).length + (selector.match(/\.[\w-]+/g) ?? []).length;
  const empty = lastRule(rules, ".room-row.room-row--empty", "grid-template-columns", 960);
  assert.deepEqual(empty.declarations["grid-template-columns"], "1fr");
  for (const width of [960, 1199, 959]) {
    const rivals = rules.filter(
      (rule) =>
        rule.selectors.includes(".room-row") &&
        (rule.maxWidth === null || rule.maxWidth >= width) &&
        rule.declarations["grid-template-columns"] !== undefined,
    );
    assert.ok(rivals.length >= 2, `expected the frame and band rules at ${width}px`);
    for (const rival of rivals) {
      for (const selector of rival.selectors) {
        assert.ok(
          weight(".room-row.room-row--empty") > weight(selector),
          `${selector} at ${width}px outranks the empty-state row`,
        );
      }
    }
  }
});

// ---------------------------------------------------------------------------
// M3-A4 Slice 5: events, epochs, acceptTerminal (T-L11), quit (T-L12/b),
// R5 (10), room/updated (11), turn/completed & post-start read (12, 14, 15)
// ---------------------------------------------------------------------------

test("M3-A4 Slice 5: tauri.conf.json withGlobalTauri + ui/app.js event listener contract + ipc.ts methods", async () => {
  const confPath = fileURLToPath(new URL("../src-tauri/tauri.conf.json", import.meta.url));
  const conf = JSON.parse(readFileSync(confPath, "utf8")) as {
    app: { withGlobalTauri?: boolean; security: { csp: string } };
  };
  assert.equal(conf.app.withGlobalTauri, true);
  assert.equal(conf.app.security.csp, "default-src 'self'; script-src 'self'; style-src 'self'");

  const appJs = readFileSync(fileURLToPath(new URL("../ui/app.js", import.meta.url)), "utf8");
  assert.match(appJs, /listen\(\s*"madc:engine-event"/);
  assert.match(appJs, /listen\(\s*"madc:quit-requested"/);

  // DesktopEngineClient turnStart never adds `mode`.
  const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  const client = new DesktopEngineClient({
    async connect() {
      return {
        socketPath: "/tmp/e.sock",
        reusedExisting: false,
        protocolVersion: PROTOCOL_VERSION,
        serverName: "madc-engine",
        serverVersion: "0.0.0",
        coldStartMs: 1,
        connectionEpoch: 1,
      };
    },
    async request<T>(method: string, params: Record<string, unknown>) {
      sent.push({ method, params });
      return {} as T;
    },
    async disconnect() {},
    onRoomUpdated() {
      return () => {};
    },
  });
  await client.connect();
  await client.seatList();
  await client.threadStart({ seatId: "madc-default", cwd: "/repo" });
  await client.turnStart({ threadId: "thr_1", input: [{ type: "text", text: "hi" }] });
  await client.turnInterrupt({ threadId: "thr_1", turnId: "turn_1" });
  assert.deepEqual(
    sent.map((s) => s.method),
    ["seat/list", "thread/start", "turn/start", "turn/interrupt"],
  );
  assert.equal("mode" in (sent[2]?.params ?? {}), false);
});

test("M3-A4 Slice 5 (8): acceptEngineEvent filtering, monotonic seq, stream gap, and terminal exclusion", () => {
  assert.deepEqual(
    [...FORWARDED_ENGINE_EVENTS].sort(),
    [
      "item/completed",
      "madc/events-dropped",
      "room/updated",
      "thread/started",
      "turn/completed",
      "turn/started",
    ].sort(),
  );

  const base = {
    boundEpoch: 2,
    connectionState: "CONNECTED" as const,
    disconnectPending: false,
    lastAcceptedSeq: 3,
  };

  // Happy contiguous accept.
  assert.deepEqual(
    acceptEngineEvent(base, { epoch: 2, seq: 4, method: "room/updated", params: {} }),
    { outcome: "accept", streamGap: false, nextSeq: 4 },
  );

  // Non-contiguous higher seq is accepted AND flags streamGap.
  assert.deepEqual(
    acceptEngineEvent(base, { epoch: 2, seq: 6, method: "turn/started", params: {} }),
    { outcome: "accept", streamGap: true, nextSeq: 6 },
  );

  // madc/events-dropped accepted AND flags streamGap.
  assert.deepEqual(
    acceptEngineEvent(base, { epoch: 2, seq: 4, method: "madc/events-dropped", params: {} }),
    { outcome: "accept", streamGap: true, nextSeq: 4 },
  );

  // Stale epoch drops with NO streamGap.
  assert.deepEqual(
    acceptEngineEvent(base, { epoch: 1, seq: 99, method: "room/updated", params: {} }),
    { outcome: "drop", streamGap: false, nextSeq: 3 },
  );
  assert.deepEqual(
    acceptEngineEvent(base, { epoch: 1, seq: 1, method: "room/updated", params: {} }),
    { outcome: "drop", streamGap: false, nextSeq: 3 },
  );

  // Disconnected / disconnectPending drops.
  assert.deepEqual(
    acceptEngineEvent(
      { ...base, connectionState: "DISCONNECTED" },
      { epoch: 2, seq: 4, method: "room/updated", params: {} },
    ),
    { outcome: "drop", streamGap: false, nextSeq: 3 },
  );
  assert.deepEqual(
    acceptEngineEvent(
      { ...base, disconnectPending: true },
      { epoch: 2, seq: 4, method: "room/updated", params: {} },
    ),
    { outcome: "drop", streamGap: false, nextSeq: 3 },
  );

  // Unknown/discarded method drops.
  assert.deepEqual(
    acceptEngineEvent(base, { epoch: 2, seq: 4, method: "item/agentMessage/delta", params: {} }),
    { outcome: "drop", streamGap: false, nextSeq: 3 },
  );

  // Repeated or decreasing seq drops and sets streamGap when epoch matches.
  assert.deepEqual(
    acceptEngineEvent(base, { epoch: 2, seq: 3, method: "room/updated", params: {} }),
    { outcome: "drop", streamGap: true, nextSeq: 3 },
  );
  assert.deepEqual(
    acceptEngineEvent(base, { epoch: 2, seq: 2, method: "room/updated", params: {} }),
    { outcome: "drop", streamGap: true, nextSeq: 3 },
  );

  // madc/transport-closed is NEVER accepted by acceptEngineEvent.
  assert.deepEqual(
    acceptEngineEvent(base, {
      epoch: 2,
      seq: 4,
      method: "madc/transport-closed",
      params: { reason: "eof" },
    }),
    { outcome: "drop", streamGap: false, nextSeq: 3 },
  );
});

test("M3-A4 Slice 5 (T-L11): acceptTerminal pure table + connect handoff + desktop shutting down", async () => {
  const mkState = (
    overrides: Partial<{
      connectionState: "IDLE" | "CONNECTING" | "CONNECTED" | "DISCONNECTED" | "STOPPED" | "FAILED";
      disconnectPending: boolean;
      boundEpoch: number | null;
      terminalHandled: number;
      pendingTerminal: {
        epoch: number;
        reason:
          | "eof"
          | "read-error"
          | "invalid-frame"
          | "oversize-frame"
          | "overflow"
          | "disconnect"
          | "exit";
      } | null;
    }> = {},
  ) => ({
    connectionState: "CONNECTED" as const,
    disconnectPending: false,
    boundEpoch: 1,
    terminalHandled: 0,
    pendingTerminal: null,
    ...overrides,
  });

  // 1. CONNECTING terminal N -> Ok(N): FAILED + single disconnect_engine, never CONNECTED.
  const tConn = acceptTerminal(mkState({ connectionState: "CONNECTING", boundEpoch: null }), {
    epoch: 5,
    params: { reason: "eof" },
  });
  assert.equal(tConn.action, "pending-connecting");
  const rOk = resolveConnectTerminal(tConn.nextState, 5);
  assert.equal(rOk.matched, true);
  assert.equal(rOk.nextState.connectionState, "FAILED");
  assert.equal(rOk.startDisconnect, true);
  assert.equal(rOk.nextState.terminalHandled, 5);

  // 2. CONNECTING exit terminal N -> Ok(N): no FAILED, no disconnect_engine.
  const tExitConn = acceptTerminal(mkState({ connectionState: "CONNECTING", boundEpoch: null }), {
    epoch: 6,
    params: { reason: "exit" },
  });
  const rExitOk = resolveConnectTerminal(tExitConn.nextState, 6);
  assert.equal(rExitOk.matched, true);
  assert.equal(rExitOk.nextState.connectionState, "CONNECTING");
  assert.equal(rExitOk.startDisconnect, false);
  assert.equal(rExitOk.markEnded, true);
  assert.equal(rExitOk.settleQuit, true);

  // 3. CONNECTED non-exit terminal -> fail + single disconnect.
  const tFail = acceptTerminal(mkState({ boundEpoch: 3 }), {
    epoch: 3,
    params: { reason: "overflow" },
  });
  assert.equal(tFail.action, "fail");
  assert.equal(tFail.nextConnectionState, "FAILED");
  assert.equal(tFail.startDisconnect, true);
  assert.equal(tFail.settleQuit, true);
  assert.equal(tFail.markEnded, true);

  // 4. CONNECTED exit terminal -> exit (no FAILED, no disconnect).
  const tExit = acceptTerminal(mkState({ boundEpoch: 4 }), {
    epoch: 4,
    params: { reason: "exit" },
  });
  assert.equal(tExit.action, "exit");
  assert.equal(tExit.nextConnectionState, "CONNECTED");
  assert.equal(tExit.startDisconnect, false);
  assert.equal(tExit.settleQuit, true);
  assert.equal(tExit.markEnded, true);
  assert.equal(tExit.nextState.terminalHandled, 4);

  // 5. Duplicate or older epoch -> ignore.
  assert.equal(
    acceptTerminal(tExit.nextState, { epoch: 4, params: { reason: "eof" } }).action,
    "ignore",
  );
  assert.equal(
    acceptTerminal(tExit.nextState, { epoch: 3, params: { reason: "eof" } }).action,
    "ignore",
  );

  // 6. disconnectPending -> disconnecting (no second disconnect, no FAILED).
  const tDisc = acceptTerminal(mkState({ boundEpoch: 7, disconnectPending: true }), {
    epoch: 7,
    params: { reason: "disconnect" },
  });
  assert.equal(tDisc.action, "disconnecting");
  assert.equal(tDisc.startDisconnect, false);
  assert.equal(tDisc.nextConnectionState, "CONNECTED");

  // 7. Result arrived before terminal (already DISCONNECTED) -> Rule 6 marks handled.
  const tLate = acceptTerminal(mkState({ connectionState: "DISCONNECTED", boundEpoch: 8 }), {
    epoch: 8,
    params: { reason: "disconnect" },
  });
  assert.equal(tLate.action, "mark-handled");
  assert.equal(tLate.nextState.terminalHandled, 8);
  assert.equal(tLate.nextConnectionState, "DISCONNECTED");

  // End-to-end: rpc_request "desktop shutting down" before exit terminal -> NO FAILED, NO disconnect_engine.
  const { doc } = createShellHarness();
  let disconnectCalls = 0;
  let rejectTurnStart: ((e: unknown) => void) | null = null;
  const ctrl = bindDesktopShell(doc, (cmd, args) => {
    if (cmd === "connect_engine") {
      return Promise.resolve({
        socketPath: "/tmp/e.sock",
        reusedExisting: false,
        protocolVersion: PROTOCOL_VERSION,
        serverName: "madc-engine",
        serverVersion: "0.0.0",
        coldStartMs: 5,
        connectionEpoch: 10,
      });
    }
    if (cmd === "disconnect_engine") {
      disconnectCalls += 1;
      return Promise.resolve();
    }
    if (cmd === "rpc_request") {
      if (args?.method === "room/inspect") {
        return Promise.resolve({
          room: {
            home: "/h",
            counts: { threads: 0, pass: 0, warn: 0, fail: 0, openDecisions: 0 },
            threads: [],
          },
        });
      }
      if (args?.method === "thread/start") {
        return Promise.resolve({
          thread: {
            id: "thr_1",
            seatId: "madc-default",
            cwd: null,
            createdAt: 1,
            updatedAt: 1,
            status: "idle",
            preview: "",
          },
        });
      }
      if (args?.method === "session/read") {
        return Promise.resolve({ threadId: "thr_1", chainOk: true, events: [] });
      }
      if (args?.method === "turn/start") {
        return new Promise((_, rej) => {
          rejectTurnStart = rej;
        });
      }
    }
    return Promise.resolve({});
  });
  await ctrl.connect();
  const pane = ctrl.createDraftPane("madc-default");
  await ctrl.startThread(pane.paneId);
  const turnP = ctrl.startTurn("hello", [pane.paneId]);
  (rejectTurnStart as ((e: unknown) => void) | null)?.("desktop shutting down");
  await turnP;
  assert.equal(ctrl.getConnectionState(), "CONNECTED");
  assert.equal(disconnectCalls, 0);
  assert.equal(ctrl.getPanes()[0]?.state, "history");
  assert.equal(ctrl.getQuitState().terminalHandled, 10);
  assert.equal(ctrl.getQuitState().exitStarted, true);

  // Late exit terminal for epoch 10 after "desktop shutting down" is ignored (no error/disconnect).
  ctrl.handleEngineEvent({
    epoch: 10,
    seq: 1,
    method: "madc/transport-closed",
    params: { reason: "exit" },
  });
  assert.equal(disconnectCalls, 0);
});

test("M3-A4 Slice 5 (T-L12 / T-L12b / 13b): quit candidate, shown-ack race, stale requestIds, and confirm_quit", async () => {
  // Pure acceptQuitRequest checks.
  assert.equal(
    acceptQuitRequest(
      { boundEpoch: 1, connectionState: "IDLE", quitRecord: null },
      { epoch: 1, requestId: 1 },
    ).action,
    "ignore",
  );
  assert.equal(
    acceptQuitRequest(
      {
        boundEpoch: 2,
        connectionState: "CONNECTED",
        quitRecord: { requestId: 5, status: "shown" },
      },
      { epoch: 2, requestId: 5 },
    ).action,
    "refocus",
  );
  assert.equal(
    acceptQuitRequest(
      {
        boundEpoch: 2,
        connectionState: "CONNECTED",
        quitRecord: { requestId: 5, status: "settled" },
      },
      { epoch: 2, requestId: 5 },
    ).action,
    "ignore",
  );

  // End-to-end (T-L12b): terminal arrives while quit_dialog_shown is in flight -> late {accepted:true} opens nothing.
  const { doc } = createShellHarness();
  let resolveShown: ((v: unknown) => void) | null = null;
  const cmds: Array<{ cmd: string; args: Record<string, unknown> | undefined }> = [];
  const ctrl = bindDesktopShell(doc, (cmd, args) => {
    cmds.push({ cmd, args });
    if (cmd === "connect_engine") {
      return Promise.resolve({
        socketPath: "/tmp/e.sock",
        reusedExisting: false,
        protocolVersion: PROTOCOL_VERSION,
        serverName: "madc-engine",
        serverVersion: "0.0.0",
        coldStartMs: 5,
        connectionEpoch: 1,
      });
    }
    if (cmd === "disconnect_engine") return Promise.resolve();
    if (cmd === "quit_dialog_shown") {
      return new Promise((res) => {
        resolveShown = res;
      });
    }
    if (cmd === "ack_quit" || cmd === "confirm_quit") return Promise.resolve({ accepted: true });
    if (cmd === "rpc_request" && args?.method === "room/inspect") {
      return Promise.resolve({
        room: {
          home: "/h",
          counts: { threads: 0, pass: 0, warn: 0, fail: 0, openDecisions: 0 },
          threads: [],
        },
      });
    }
    return Promise.resolve({});
  });
  await ctrl.connect();

  // Even after a seq gap / overflow event on engine-event, quit-requested is delivered cleanly.
  ctrl.handleEngineEvent({
    epoch: 1,
    seq: 9,
    method: "madc/events-dropped",
    params: { count: 2, reason: "unknown-notification" },
  });
  assert.equal(ctrl.isStreamGap(), true);

  const q1 = ctrl.handleQuitRequested({ epoch: 1, requestId: 1 });
  assert.deepEqual(ctrl.getQuitState().quitRecord, { requestId: 1, status: "candidate" });
  assert.equal(ctrl.getQuitState().dialogOpen, false);

  // Terminal arrives before quit_dialog_shown resolves.
  ctrl.handleEngineEvent({
    epoch: 1,
    seq: 10,
    method: "madc/transport-closed",
    params: { reason: "eof" },
  });
  assert.deepEqual(ctrl.getQuitState().quitRecord, { requestId: 1, status: "settled" });
  (resolveShown as ((v: unknown) => void) | null)?.({ accepted: true });
  await q1;
  assert.equal(
    ctrl.getQuitState().dialogOpen,
    false,
    "late accepted:true must not open after terminal",
  );
  assert.deepEqual(ctrl.getQuitState().quitRecord, { requestId: 1, status: "settled" });

  // Fresh epoch 2: test Keep running + Confirm quit + stale requestIds.
  const cmds2: Array<{ cmd: string; args: Record<string, unknown> | undefined }> = [];
  const { doc: doc2 } = createShellHarness();
  const ctrl2 = bindDesktopShell(doc2, async (cmd, args) => {
    cmds2.push({ cmd, args });
    if (cmd === "connect_engine") {
      return {
        socketPath: "/tmp/e.sock",
        reusedExisting: false,
        protocolVersion: PROTOCOL_VERSION,
        serverName: "madc-engine",
        serverVersion: "0.0.0",
        coldStartMs: 5,
        connectionEpoch: 2,
      };
    }
    if (cmd === "quit_dialog_shown" || cmd === "ack_quit" || cmd === "confirm_quit") {
      return { accepted: true };
    }
    if (cmd === "rpc_request" && args?.method === "room/inspect") {
      return {
        room: {
          home: "/h",
          counts: { threads: 0, pass: 0, warn: 0, fail: 0, openDecisions: 0 },
          threads: [],
        },
      };
    }
    return {};
  });
  await ctrl2.connect();
  await ctrl2.handleQuitRequested({ epoch: 2, requestId: 10 });
  assert.equal(ctrl2.getQuitState().dialogOpen, true);

  // Keep running invokes ack_quit once, settles 10, closes dialog.
  await ctrl2.ackQuit();
  assert.equal(ctrl2.getQuitState().dialogOpen, false);
  assert.deepEqual(ctrl2.getQuitState().quitRecord, { requestId: 10, status: "settled" });
  // Delayed event for acked requestId 10 is ignored.
  await ctrl2.handleQuitRequested({ epoch: 2, requestId: 10 });
  assert.equal(ctrl2.getQuitState().dialogOpen, false);

  // Greater requestId 11 opens, confirmQuit sends confirm_quit once and zero interrupt/disconnect.
  await ctrl2.handleQuitRequested({ epoch: 2, requestId: 11 });
  assert.equal(ctrl2.getQuitState().dialogOpen, true);
  // Stale requestId 10 while 11 is shown is ignored.
  await ctrl2.handleQuitRequested({ epoch: 2, requestId: 10 });
  assert.equal(cmds2.filter((c) => c.cmd === "quit_dialog_shown").length, 2);
  await ctrl2.confirmQuit();
  assert.equal(cmds2.filter((c) => c.cmd === "confirm_quit").length, 1);
  assert.equal(cmds2.filter((c) => c.cmd === "disconnect_engine").length, 0);
  assert.equal(
    cmds2.filter((c) => c.cmd === "rpc_request" && c.args?.method === "turn/interrupt").length,
    0,
  );
});

test("M3-A4 Slice 5 (10, 11, 12, 13, 14, 15): R5 defect guard, room/updated, auto-read & coalescing", async () => {
  assert.equal(
    classifyRpcError("RPC params refused by desktop shell for turn/start: unexpected key: mode")
      .kind,
    "params",
  );
  assert.equal(classifyRpcError("desktop shutting down").kind, "shutting-down");

  const { doc } = createShellHarness();
  const rpcs: Array<{ method: string; params: Record<string, unknown> }> = [];
  let disconnects = 0;
  let resolvePostStartRead: ((v: unknown) => void) | null = null;
  let rejectSelectionRead: ((e: unknown) => void) | null = null;
  let readBehavior: "defer-post-start" | "defer-selection-fail" | "immediate" = "defer-post-start";

  const ctrl = bindDesktopShell(doc, (cmd, args) => {
    if (cmd === "connect_engine") {
      return Promise.resolve({
        socketPath: "/tmp/e.sock",
        reusedExisting: false,
        protocolVersion: PROTOCOL_VERSION,
        serverName: "madc-engine",
        serverVersion: "0.0.0",
        coldStartMs: 5,
        connectionEpoch: 1,
      });
    }
    if (cmd === "disconnect_engine") {
      disconnects += 1;
      return Promise.resolve();
    }
    if (cmd === "rpc_request") {
      const method = String(args?.method);
      const params = (args?.params ?? {}) as Record<string, unknown>;
      rpcs.push({ method, params });
      if (method === "room/inspect") {
        return Promise.resolve({
          room: {
            home: "/h",
            counts: { threads: 0, pass: 0, warn: 0, fail: 0, openDecisions: 0 },
            threads: [],
          },
        });
      }
      if (method === "thread/start") {
        if (params.seatId === "bad-seat") {
          return Promise.reject('engine RPC error: {"code":-32005,"message":"SeatNotFound"}');
        }
        return Promise.resolve({
          thread: {
            id: `thr_${params.seatId}`,
            seatId: params.seatId,
            cwd: params.cwd ?? null,
            createdAt: 1,
            updatedAt: 1,
            status: "idle",
            preview: "",
          },
        });
      }
      if (method === "session/read") {
        if (readBehavior === "defer-post-start") {
          readBehavior = "immediate";
          return new Promise((res) => {
            resolvePostStartRead = res;
          });
        }
        if (readBehavior === "defer-selection-fail") {
          readBehavior = "immediate";
          return new Promise((_, rej) => {
            rejectSelectionRead = rej;
          });
        }
        return Promise.resolve({ threadId: params.threadId, chainOk: true, events: [] });
      }
      if (method === "turn/start") {
        if (params.threadId === "thr_r5") {
          return Promise.reject("RPC params refused by desktop shell for turn/start: invalid");
        }
        return Promise.resolve({
          turn: {
            id: "turn_1",
            threadId: params.threadId,
            status: "inProgress",
            items: [],
            error: null,
            startedAt: 100,
            completedAt: null,
          },
        });
      }
    }
    return Promise.resolve({});
  });

  await ctrl.connect();

  // (11) room/updated sets table stale note and runs 0 room/inspect and 0 session/read.
  const inspectCountBefore = rpcs.filter((r) => r.method === "room/inspect").length;
  for (const [i, reason] of (["thread", "turn", "handoff", "decision"] as const).entries()) {
    ctrl.handleEngineEvent({
      epoch: 1,
      seq: i + 1,
      method: "room/updated",
      params: { reason, threadId: "thr_x" },
    });
  }
  assert.equal(ctrl.isTableStale(), true);
  assert.equal(rpcs.filter((r) => r.method === "room/inspect").length, inspectCountBefore);
  assert.equal(rpcs.filter((r) => r.method === "session/read").length, 0);
  await ctrl.inspectRoom();
  assert.equal(ctrl.isTableStale(), false);
  assert.equal(
    rpcs.filter((r) => r.method === "session/read").length,
    0,
    "(14) Inspect room triggers 0 auto reads",
  );

  // (14) Failed thread/start -> 0 session/read.
  const badPane = ctrl.createDraftPane("bad-seat");
  await ctrl.startThread(badPane.paneId);
  assert.equal(rpcs.filter((r) => r.method === "session/read").length, 0);

  // (14) Successful thread/start -> 1 post-start session/read; (15) turn/completed during flight -> 1 follow-up.
  const p1 = ctrl.createDraftPane("madc-default");
  await ctrl.startThread(p1.paneId);
  assert.equal(
    rpcs.filter((r) => r.method === "session/read" && r.params.threadId === "thr_madc-default")
      .length,
    1,
  );
  // Start turn + two turn/completed notifications while post-start read is still in flight -> coalesced to ONE follow-up.
  await ctrl.startTurn("run 1", [p1.paneId]);
  ctrl.handleEngineEvent({
    epoch: 1,
    seq: 10,
    method: "turn/completed",
    params: {
      turn: {
        id: "turn_1",
        threadId: "thr_madc-default",
        status: "completed",
        items: [],
        error: null,
        startedAt: 100,
        completedAt: 200,
      },
    },
  });
  ctrl.handleEngineEvent({
    epoch: 1,
    seq: 11,
    method: "turn/completed",
    params: {
      turn: {
        id: "turn_1",
        threadId: "thr_madc-default",
        status: "completed",
        items: [],
        error: null,
        startedAt: 100,
        completedAt: 201,
      },
    },
  });
  (resolvePostStartRead as ((v: unknown) => void) | null)?.({
    threadId: "thr_madc-default",
    chainOk: true,
    events: [],
  });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(
    rpcs.filter((r) => r.method === "session/read" && r.params.threadId === "thr_madc-default")
      .length,
    2,
    "must coalesce multiple completions during post-start flight into one follow-up",
  );

  // (12) Hidden pane: turn/completed while hidden triggers 0 reads until showPane.
  ctrl.hidePane(p1.paneId);
  await ctrl.startTurn("run 2", [p1.paneId]);
  ctrl.handleEngineEvent({
    epoch: 1,
    seq: 12,
    method: "turn/completed",
    params: {
      turn: {
        id: "turn_1",
        threadId: "thr_madc-default",
        status: "completed",
        items: [],
        error: null,
        startedAt: 100,
        completedAt: 300,
      },
    },
  });
  assert.equal(
    rpcs.filter((r) => r.method === "session/read" && r.params.threadId === "thr_madc-default")
      .length,
    2,
    "hidden pane must not auto-read while hidden",
  );
  ctrl.showPane(p1.paneId);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(
    rpcs.filter((r) => r.method === "session/read" && r.params.threadId === "thr_madc-default")
      .length,
    3,
    "showing hidden pane drains its deferred completion read once",
  );

  // (15) Selection read failure still triggers follow-up if turn/completed arrived during flight.
  readBehavior = "defer-selection-fail";
  const selP = ctrl.selectThread("thr_madc-default");
  ctrl.handleEngineEvent({
    epoch: 1,
    seq: 13,
    method: "turn/completed",
    params: {
      turn: {
        id: "turn_1",
        threadId: "thr_madc-default",
        status: "completed",
        items: [],
        error: null,
        startedAt: 100,
        completedAt: 400,
      },
    },
  });
  (rejectSelectionRead as ((e: unknown) => void) | null)?.(
    'engine RPC error: {"code":-32002,"message":"miss"}',
  );
  await selP;
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(
    rpcs.filter((r) => r.method === "session/read" && r.params.threadId === "thr_madc-default")
      .length,
    5,
    "follow-up fires once even when first read failed",
  );

  // (10) & (13): Starting-turn pane appears in getQuitTurns(), R5 defect guard does NOT call disconnect_engine.
  const p2 = ctrl.createDraftPane("r5");
  await ctrl.startThread(p2.paneId);
  await ctrl.startTurn("hi", [p1.paneId]); // p1 RUNNING
  // R5 rejection on turn/start invokes disconnect_engine 0 times, p1 stays RUNNING.
  await ctrl.startTurn("bad", [p2.paneId]);
  assert.equal(disconnects, 0);
  assert.equal(ctrl.getConnectionState(), "CONNECTED");
  assert.equal(ctrl.getPanes().find((p) => p.paneId === p1.paneId)?.state, "running");
  assert.equal(ctrl.getQuitTurns().length, 1);

  // (15) Follow-up suppressed if epoch ends mid-flight.
  readBehavior = "defer-post-start";
  const p3 = ctrl.createDraftPane("sup");
  await ctrl.startThread(p3.paneId);
  ctrl.handleEngineEvent({
    epoch: 1,
    seq: 14,
    method: "turn/completed",
    params: {
      turn: {
        id: "turn_1",
        threadId: "thr_sup",
        status: "completed",
        items: [],
        error: null,
        startedAt: 100,
        completedAt: 500,
      },
    },
  });
  await ctrl.disconnect();
  (resolvePostStartRead as ((v: unknown) => void) | null)?.({
    threadId: "thr_sup",
    chainOk: true,
    events: [],
  });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(
    rpcs.filter((r) => r.method === "session/read" && r.params.threadId === "thr_sup").length,
    1,
    "follow-up must be suppressed when epoch ends mid-flight",
  );
});

// ---------------------------------------------------------------------------
// M3-A4 Slice 6: pills, receipts, cwd (C1–C17), layout/D-693, panes/composer/palette/keys/quit
// ---------------------------------------------------------------------------

test("M3-A4 §9 items 1–7, 20–21: pill vocabulary, turn pills, servedModel, head@open, lane, topLevel", () => {
  // Items 1–4: closed vocabulary & turn pills never green.
  const vocab = {
    verified: ["VERIFIED"],
    neutral: [
      "NO RECEIPT",
      "IDLE",
      "CONNECTING",
      "CONNECTED",
      "DISCONNECTED",
      "RUNNING",
      "COMPLETED",
    ],
    warn: ["UNVERIFIED", "STOPPED"],
    fail: ["FAILED", "INTERRUPTED"],
  };
  for (const [tone, expected] of Object.entries(vocab) as Array<
    [keyof typeof ALLOWED_PILL_LABELS, PillLabel[]]
  >) {
    assert.deepEqual([...ALLOWED_PILL_LABELS[tone]].sort(), [...expected].sort());
  }
  for (const state of [
    "draft",
    "starting-thread",
    "start-failed",
    "idle",
    "starting-turn",
    "running",
    "interrupt-pending",
    "completed",
    "interrupted",
    "failed",
    "refused",
    "history",
  ] as const) {
    const tp = turnPillForPane({ state });
    assert.notEqual(tp.tone, "verified", `turn pill for ${state} must never be verified`);
  }
  assert.deepEqual(turnPillForPane({ state: "running" }), { tone: "neutral", label: "RUNNING" });
  assert.deepEqual(turnPillForPane({ state: "completed" }), {
    tone: "neutral",
    label: "COMPLETED",
  });
  assert.deepEqual(turnPillForPane({ state: "interrupted" }), {
    tone: "fail",
    label: "INTERRUPTED",
  });

  // Item 5: servedModel conditions (verified, vendorReported=false, empty, whitespace, streamed-only, failed-stream).
  const basePane = {
    paneId: "p1",
    seatId: "daedalus",
    threadId: "thr_1",
    turnId: "turn_1",
    state: "completed",
    hasReadYet: true,
  };
  // Streamed-only with vendorReported:true -> warn UNVERIFIED, never green.
  const streamedOnly = receiptRowsForPane(
    {
      ...basePane,
      streamedServedModel: {
        id: "it_1",
        kind: "servedModel",
        status: "completed",
        requestedModel: "m",
        servedModel: "claude-4",
        backing: "anthropic",
        providerId: "anthropic",
        lane: "allowed-direct",
        mode: "headless",
        fallbackFrom: null,
        vendorReported: true,
      },
    },
    null,
    null,
  );
  const smStreamRow = streamedOnly.find((r) => r.kind === "servedModel");
  assert.equal(smStreamRow?.tone, "warn");
  assert.equal(smStreamRow?.pillLabel, "UNVERIFIED");

  // Failed streamed servedModel is NOT evidence (stays NO RECEIPT).
  const noStream = receiptRowsForPane({ ...basePane, streamedServedModel: null }, null, null);
  assert.equal(noStream.find((r) => r.kind === "servedModel")?.pillLabel, "NO RECEIPT");

  // Confirmed read-back vendorReported:true non-empty -> VERIFIED.
  const readVerified = receiptRowsForPane(
    basePane,
    {
      ok: true,
      result: {
        threadId: "thr_1",
        chainOk: true,
        events: [
          {
            type: "session.open",
            payload: {
              worktree: { topLevel: "/Users/dev/repo", remote: null, head: "a".repeat(40) },
            },
          },
          {
            type: "servedModel",
            payload: {
              turnId: "turn_1",
              servedModel: "claude-4",
              vendorReported: true,
              lane: "allowed-direct",
              fallbackFrom: null,
            },
          },
        ],
      },
    },
    null,
  );
  assert.equal(readVerified.find((r) => r.kind === "servedModel")?.tone, "verified");
  assert.equal(readVerified.find((r) => r.kind === "servedModel")?.pillLabel, "VERIFIED");

  // Item 5 empty/whitespace servedModel x vendorReported {true, false} -> warn UNVERIFIED, never green or neutral.
  for (const sm of ["", "   "]) {
    for (const vr of [true, false]) {
      const rows = receiptRowsForPane(
        basePane,
        {
          ok: true,
          result: {
            threadId: "thr_1",
            chainOk: true,
            events: [
              {
                type: "servedModel",
                payload: {
                  turnId: "turn_1",
                  servedModel: sm,
                  vendorReported: vr,
                  lane: "allowed-direct",
                  fallbackFrom: null,
                },
              },
            ],
          },
        },
        null,
      );
      const smRow = rows.find((r) => r.kind === "servedModel");
      assert.equal(smRow?.tone, "warn", `empty '${sm}' vendorReported=${vr} must be warn`);
      assert.equal(smRow?.pillLabel, "UNVERIFIED");
    }
  }

  // Item 6 & 21: head@open verified with 40-hex SHA alone (even without chainOk), missing note stays verified, label literal head@open.
  const shaRows = receiptRowsForPane(
    { ...basePane, hasReadYet: true },
    { ok: true, result: { threadId: "thr_1", chainOk: false, events: [] } },
    {
      worktree: {
        open: { topLevel: "/repo", remote: null, head: "f".repeat(40) },
        close: null,
        missing: true,
      },
    },
  );
  const headRow = shaRows.find((r) => r.kind === "head@open");
  assert.equal(headRow?.label, "head@open");
  assert.equal(headRow?.tone, "verified");
  assert.equal(headRow?.note, "worktree missing on disk");

  // Item 7: lane and worktree.topLevel have no pill and contain `field · not a receipt`.
  const laneRow = readVerified.find((r) => r.kind === "lane");
  const topRow = readVerified.find((r) => r.kind === "worktree.topLevel");
  assert.equal(laneRow?.pillLabel, null);
  assert.match(laneRow?.note ?? "", /field · not a receipt/);
  assert.equal(topRow?.pillLabel, null);
  assert.match(topRow?.note ?? "", /field · not a receipt/);
});

test("M3-A4 §9 item 25 (C1–C17): cwdCheck, cwdFieldState, static CSS, and interactive cwd flow", async () => {
  // C1: cwdCheck exact table (never trims).
  assert.equal(cwdCheck("").ok, true);
  assert.equal(cwdCheck("/").ok, true);
  assert.equal(cwdCheck("/a b/").ok, true);
  assert.equal(cwdCheck("relative").ok, false);
  assert.equal(cwdCheck("./x").ok, false);
  assert.equal(cwdCheck("~/x").reason, "~ is not expanded · type the full path");
  assert.equal(cwdCheck(" /x").ok, false);
  assert.equal(cwdCheck("/a\0b").reason, "contains a NUL character");
  const p4096 = `/${"a".repeat(4095)}`;
  assert.equal(Buffer.byteLength(p4096, "utf8"), 4096);
  assert.equal(cwdCheck(p4096).ok, true);
  assert.equal(cwdCheck(`${p4096}b`).ok, false);
  // Multi-byte UTF-8 measured in bytes, not characters.
  const multi = `/${"é".repeat(2048)}`; // 1 + 4096 = 4097 bytes
  assert.equal(multi.length, 2049);
  assert.equal(cwdCheck(multi).ok, false);

  // C2: cwdFieldState returns ONLY the six words and ONLY neutral or fail (never verified or warn).
  const allowedWords = new Set([
    "NO CWD",
    "UNCHECKED",
    "REJECTED",
    "REFUSED",
    "STARTING",
    "STARTED",
  ]);
  for (const text of ["", "/repo", "bad", "~/x"]) {
    for (const phase of ["draft", "starting", "refused", "started"] as const) {
      const st = cwdFieldState(text, phase, { message: "bad" });
      assert.equal(allowedWords.has(st.word), true);
      assert.ok(st.tone === "neutral" || st.tone === "fail");
    }
  }
  assert.equal(cwdFieldState("", "started").tone, "neutral");

  // C13 & C14: static CSS checks.
  const css = readFileSync(fileURLToPath(new URL("../ui/styles.css", import.meta.url)), "utf8");
  assert.match(css, /\.cwd-val-ro[\s\S]*direction:\s*rtl;[\s\S]*text-overflow:\s*ellipsis;/);
  assert.match(css, /\.chip-v--rtl[\s\S]*direction:\s*rtl;[\s\S]*text-overflow:\s*ellipsis;/);
  const cwdRules = css.match(/\.(?:cwd|cwd-in|fst)[^{]*\{[^}]+\}/g) ?? [];
  assert.ok(cwdRules.length >= 3);
  for (const r of cwdRules) {
    assert.doesNotMatch(r, /--madc-green|--madc-yellow/);
  }

  // Interactive C3–C11, C15–C17.
  const { doc, byId } = createShellHarness();
  const rpcs: Array<{ method: string; params: Record<string, unknown> }> = [];
  let disconnects = 0;
  let resolveStart: ((v: unknown) => void) | null = null;
  let nextStartMode: "ok-worktree" | "pending" | "-32602" | "-32009" | "-32005" | "-32006" | "R5" =
    "-32602";

  const ctrl = bindDesktopShell(
    doc,
    (cmd, args) => {
      if (cmd === "connect_engine") {
        return Promise.resolve({
          socketPath: "/tmp/e.sock",
          reusedExisting: false,
          protocolVersion: PROTOCOL_VERSION,
          serverName: "madc-engine",
          serverVersion: "0.0.0",
          coldStartMs: 5,
          connectionEpoch: 1,
        });
      }
      if (cmd === "disconnect_engine") {
        disconnects += 1;
        return Promise.resolve();
      }
      if (cmd === "rpc_request") {
        const method = String(args?.method);
        const params = (args?.params ?? {}) as Record<string, unknown>;
        rpcs.push({ method, params });
        if (method === "room/inspect") {
          return Promise.resolve({
            room: {
              home: "/h",
              counts: { threads: 0, pass: 0, warn: 0, fail: 0, openDecisions: 0 },
              threads: [],
            },
          });
        }
        if (method === "seat/list") {
          return Promise.resolve({
            data: [
              {
                id: "reviewer",
                displayName: "Reviewer",
                pinnedModel: null,
                preferredBacking: null,
                ok: true,
              },
            ],
          });
        }
        if (method === "session/read") {
          return Promise.resolve({ threadId: params.threadId, chainOk: true, events: [] });
        }
        if (method === "thread/start") {
          if (nextStartMode === "pending") {
            return new Promise((res) => {
              resolveStart = res;
            });
          }
          if (nextStartMode === "-32602") {
            return Promise.reject(
              'engine RPC error: {"code":-32602,"message":"Invalid params","data":{"issues":["worktree mode requires a git repository cwd"]}}',
            );
          }
          if (nextStartMode === "-32009") {
            return Promise.reject(
              'engine RPC error: {"code":-32009,"message":"SessionWriteFailed","data":{"threadId":"thr_1","path":"/s","seq":0}}',
            );
          }
          if (nextStartMode === "-32005") {
            return Promise.reject(
              'engine RPC error: {"code":-32005,"message":"SeatNotFound","data":{"seatId":"reviewer"}}',
            );
          }
          if (nextStartMode === "-32006") {
            return Promise.reject(
              'engine RPC error: {"code":-32006,"message":"SeatInvalid","data":{"seatId":"reviewer","issues":["bad seat"]}}',
            );
          }
          if (nextStartMode === "R5") {
            return Promise.reject(
              "RPC params refused by desktop shell for thread/start: cwd must be absolute",
            );
          }
          return Promise.resolve({
            thread: {
              id: "thr_wt",
              seatId: params.seatId,
              cwd: "/madc/worktrees/thr_wt",
              createdAt: 1,
              updatedAt: 1,
              status: "idle",
              preview: "",
            },
          });
        }
      }
      return Promise.resolve({});
    },
    { platform: "darwin" },
  );

  await ctrl.connect();
  await ctrl.loadSeats();
  ctrl.openPalette();
  const palInput = byId.get("palette-input");
  assert.ok(palInput !== undefined);
  // C11: New pane on seat reviewer creates Draft pane and sends 0 RPCs.
  const reviewerNewCmd = byId
    .get("palette-list")
    ?.children.find((c) => c.id === "cmd-pane-new:reviewer");
  assert.ok(reviewerNewCmd !== undefined);
  reviewerNewCmd.emit("click");
  assert.equal(ctrl.getPanes().length, 1);
  assert.equal(rpcs.filter((r) => r.method === "thread/start").length, 0);
  assert.match(byId.get("composer-targets")?.textContent ?? "", /no thread loaded/);

  const draftId = ctrl.getPanes()[0]?.paneId ?? "";
  const findCwdInput = (node: TestFakeEl | undefined): TestFakeEl | undefined => {
    if (!node) return undefined;
    if (node.className === "cwd-in") return node;
    for (const c of node.children) {
      const hit = findCwdInput(c);
      if (hit) return hit;
    }
    return undefined;
  };
  const cwdInput = () => findCwdInput(byId.get("panes-grid")?.children[0]);

  // Test invalid cwd Enter sends 0 requests (C3).
  const inEl = cwdInput();
  assert.ok(inEl !== undefined);
  inEl.value = "relative";
  inEl.emit("input", { target: { value: "relative" } });
  inEl.emit("keydown", { key: "Enter", preventDefault() {} });
  assert.equal(rpcs.filter((r) => r.method === "thread/start").length, 0);

  // C5: Esc reverts edit and sends nothing.
  inEl.emit("keydown", { key: "Escape", preventDefault() {}, stopPropagation() {} });
  assert.equal(inEl.value, "");

  // C6: Cmd+Enter in cwd input sends neither thread/start nor turn/start.
  inEl.value = "/valid path/repo ";
  inEl.emit("input", { target: { value: "/valid path/repo " } });
  inEl.emit("keydown", { key: "Enter", metaKey: true, preventDefault() {} });
  assert.equal(rpcs.filter((r) => r.method === "thread/start").length, 0);
  assert.equal(rpcs.filter((r) => r.method === "turn/start").length, 0);

  // C9: -32602 refusal renders issues verbatim, keeps CONNECTED, keeps input editable.
  inEl.emit("keydown", { key: "Enter", preventDefault() {} });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(ctrl.getPanes()[0]?.state, "start-failed");
  assert.match(byId.get("panes-grid")?.textContent ?? "", /-32602/);
  assert.match(
    byId.get("panes-grid")?.textContent ?? "",
    /worktree mode requires a git repository cwd/,
  );
  assert.equal(disconnects, 0);

  // C10: R5 refusal renders verbatim with no chips, zero disconnect_engine.
  nextStartMode = "R5";
  await ctrl.startThread(draftId);
  assert.equal(ctrl.getPanes()[0]?.state, "start-failed");
  assert.match(byId.get("panes-grid")?.textContent ?? "", /RPC params refused/);
  assert.equal(disconnects, 0);

  // C16 & C17: -32009, -32005, -32006 keep CONNECTED and editable.
  for (const mode of ["-32009", "-32005", "-32006"] as const) {
    nextStartMode = mode;
    await ctrl.startThread(draftId);
    assert.equal(ctrl.getPanes()[0]?.state, "start-failed");
    assert.equal(ctrl.getConnectionState(), "CONNECTED");
    assert.equal(disconnects, 0);
  }

  // C4 & C7: State 5 pending locks readonly and ignores second Enter.
  nextStartMode = "pending";
  const pendingStart = ctrl.startThread(draftId);
  assert.equal(cwdInput()?.readOnly, true);
  await ctrl.startThread(draftId);
  assert.equal(rpcs.filter((r) => r.method === "thread/start").length, 6);

  // C8: Thread.cwd != typed text displays Thread.cwd in header, NEVER in topLevel chip.
  (resolveStart as ((v: unknown) => void) | null)?.({
    thread: {
      id: "thr_wt",
      seatId: "reviewer",
      cwd: "/madc/worktrees/thr_wt",
      createdAt: 1,
      updatedAt: 1,
      status: "idle",
      preview: "",
    },
  });
  await pendingStart;
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(cwdInput(), undefined, "C7: started pane has no input element");
  assert.match(byId.get("panes-grid")?.textContent ?? "", /\/madc\/worktrees\/thr_wt/);
  // Exact untrimmed cwd sent on thread/start.
  assert.equal(rpcs.find((r) => r.method === "thread/start")?.params.cwd, "/valid path/repo ");

  // C11: Dismiss removes draft pane with 0 RPCs.
  const d2 = ctrl.createDraftPane("reviewer");
  assert.equal(ctrl.getPanes().length, 2);
  assert.equal(ctrl.dismissPane(d2.paneId), true);
  assert.equal(ctrl.getPanes().length, 1);
});

test("M3-A4 §9 items 8, 13–24, 26–27: -32007 refusal, D-693 CSS, layout grid, keys, palette, quit dialog, no engine diff", async () => {
  // Item 13: paneColumns & isWidePaneWidth.
  assert.equal(paneColumns(1440), 4);
  assert.equal(paneColumns(1200), 2);
  assert.equal(paneColumns(960), 2);
  assert.equal(isWidePaneWidth(520), true);
  assert.equal(isWidePaneWidth(519), false);

  // Item 14, 18, 19: static CSS D-693 & no-decorative-green & no network.
  const css = readFileSync(fileURLToPath(new URL("../ui/styles.css", import.meta.url)), "utf8");
  assert.match(css, /\.cell-receipt\s*\{[^}]*flex-wrap:\s*wrap;/);
  assert.match(css, /\.receipt-chips\s*\{[^}]*flex-wrap:\s*wrap;/);
  assert.match(
    css,
    /@media\s*\(max-width:\s*1199px\)[\s\S]*140px minmax\(96px,\s*0\.62fr\)\s*48px\s*minmax\(168px,\s*1\.9fr\)/,
  );
  assert.match(
    css,
    /@media\s*\(max-width:\s*1199px\)[\s\S]*\.receipt-row\s*\{[^}]*grid-template-columns:\s*112px\s*minmax\(0,\s*1fr\);/,
  );
  // No rule hides `.cell-seat` or `.room-thead-seat`.
  assert.doesNotMatch(css, /\.cell-seat[^{]*\{[^}]*display:\s*none/);

  // Item 9 & 21: no thread/resume anywhere in shell UI and no cmd-pane-open-thread / Reopen pane.
  const shellJs = readFileSync(fileURLToPath(new URL("../ui/shell.js", import.meta.url)), "utf8");
  assert.doesNotMatch(shellJs, /thread\/resume|cmd-pane-open-thread|Reopen pane/);

  // Item 8, 10–11, 15–17, 20, 22–23, 26, C12: interactive checks.
  const { doc, byId } = createShellHarness();
  const rpcs: Array<{ method: string; params: Record<string, unknown> }> = [];
  const cmds: Array<{ cmd: string; args: Record<string, unknown> | undefined }> = [];
  let disconnects = 0;

  const ctrl = bindDesktopShell(
    doc,
    (cmd, args) => {
      cmds.push({ cmd, args });
      if (cmd === "connect_engine") {
        return Promise.resolve({
          socketPath: "/tmp/e.sock",
          reusedExisting: false,
          protocolVersion: PROTOCOL_VERSION,
          serverName: "madc-engine",
          serverVersion: "0.0.0",
          coldStartMs: 5,
          connectionEpoch: 1,
        });
      }
      if (cmd === "disconnect_engine") {
        disconnects += 1;
        return Promise.resolve();
      }
      if (cmd === "quit_dialog_shown" || cmd === "ack_quit" || cmd === "confirm_quit") {
        return Promise.resolve({ accepted: true });
      }
      if (cmd === "rpc_request") {
        const method = String(args?.method);
        const params = (args?.params ?? {}) as Record<string, unknown>;
        rpcs.push({ method, params });
        if (method === "room/inspect") {
          return Promise.resolve({
            room: {
              home: "/h",
              counts: { threads: 0, pass: 0, warn: 0, fail: 0, openDecisions: 0 },
              threads: [],
            },
          });
        }
        if (method === "thread/start") {
          return Promise.resolve({
            thread: {
              id: `thr_${params.seatId}`,
              seatId: params.seatId,
              cwd: null,
              createdAt: 1,
              updatedAt: 1,
              status: "idle",
              preview: "",
            },
          });
        }
        if (method === "session/read") {
          return Promise.resolve({
            threadId: params.threadId,
            chainOk: true,
            events: [
              { type: "session.open", payload: { worktree: null }, hash: "a".repeat(64) },
              {
                type: "servedModel",
                payload: {
                  turnId: "t1",
                  servedModel: "m1",
                  vendorReported: true,
                  lane: "allowed-direct",
                  fallbackFrom: null,
                },
                hash: "b".repeat(64),
              },
            ],
          });
        }
        if (method === "turn/start") {
          if (params.threadId === "thr_surface-architect") {
            return Promise.reject(
              'engine RPC error: {"code":-32007,"message":"ProviderDenied","data":{"providerId":"ollama-cloud","status":"present","reason":"headless-not-permitted"}}',
            );
          }
          return Promise.resolve({
            turn: {
              id: "t1",
              threadId: params.threadId,
              status: "inProgress",
              items: [],
              error: null,
              startedAt: 100,
              completedAt: null,
            },
          });
        }
        if (method === "turn/interrupt") return Promise.resolve({});
      }
      return Promise.resolve({});
    },
    { platform: "darwin", viewportWidth: 1440 },
  );

  await ctrl.connect();
  const pArch = ctrl.createDraftPane("surface-architect");
  await ctrl.startThread(pArch.paneId);
  const pDea = ctrl.createDraftPane("daedalus");
  await ctrl.startThread(pDea.paneId);

  // Item 8 & 23: -32007 keeps connection CONNECTED, turn pill stays IDLE, no verified badge.
  await ctrl.startTurn("test", [pArch.paneId]);
  assert.equal(ctrl.getConnectionState(), "CONNECTED");
  assert.equal(disconnects, 0);
  assert.equal(ctrl.getPanes()[0]?.state, "refused");
  assert.match(byId.get("panes-grid")?.textContent ?? "", /headless-not-permitted/);
  assert.equal(
    composerTargets(ctrl.getPanes(), new Set(), 1, ctrl.getConnectionState())[0]?.disabledReason,
    "refused -32007",
  );

  // C12 & Item 16: Cmd/Ctrl+F does nothing.
  ctrl.handleKeydown({ key: "f", metaKey: true, ctrlKey: false, preventDefault() {} });
  assert.equal(byId.get("palette")?.hidden, true);

  // Composer Cmd+Enter only fires when composer-input is focused.
  const compInput = byId.get("composer-input");
  assert.ok(compInput !== undefined);
  compInput.value = "hello world";
  ctrl.handleKeydown({ key: "Enter", metaKey: true, ctrlKey: false, preventDefault() {} });
  assert.equal(
    rpcs.filter((r) => r.method === "turn/start" && r.params.threadId === "thr_daedalus").length,
    0,
  );
  compInput.focus();
  ctrl.focusPane(pDea.paneId);
  ctrl.toggleComposerTarget(pDea.paneId);
  compInput.focus();
  ctrl.handleKeydown({ key: "Enter", metaKey: true, ctrlKey: false, preventDefault() {} });
  await new Promise((r) => setTimeout(r, 0));
  const lastTurnStart = rpcs.find(
    (r) => r.method === "turn/start" && r.params.threadId === "thr_daedalus",
  );
  assert.ok(lastTurnStart !== undefined);
  assert.equal("mode" in lastTurnStart.params, false);

  // Item 11: Interrupt sends turn/interrupt once and disables button.
  await ctrl.interruptTurn(pDea.paneId);
  assert.equal(rpcs.filter((r) => r.method === "turn/interrupt").length, 1);

  // Item 15: Quit dialog focus Keep running, Esc keeps running, Tab traps focus.
  await ctrl.handleQuitRequested({ epoch: 1, requestId: 1 });
  assert.equal(byId.get("quit-dialog")?.hidden, false);
  assert.equal(doc.activeElement, byId.get("quit-keep-btn"));
  let tabPrev = 0;
  ctrl.handleKeydown({
    key: "Tab",
    preventDefault() {
      tabPrev += 1;
    },
  });
  assert.equal(tabPrev, 1);
  assert.equal(doc.activeElement, byId.get("quit-confirm-btn"));
  ctrl.handleKeydown({ key: "Escape", preventDefault() {} });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(byId.get("quit-dialog")?.hidden, true);
  assert.equal(cmds.filter((c) => c.cmd === "ack_quit").length, 1);
  assert.equal(cmds.filter((c) => c.cmd === "confirm_quit").length, 0);

  // Item 26: Cmd+1 focuses pane 1 and switches to Panes view.
  ctrl.setViewMode("table");
  assert.equal(ctrl.getViewMode(), "table");
  ctrl.handleKeydown({ key: "1", metaKey: true, ctrlKey: false, preventDefault() {} });
  assert.equal(ctrl.getViewMode(), "panes");

  // Full turn completion removes running turn from quit list and keeps 0 decorative green.
  ctrl.handleEngineEvent({
    epoch: 1,
    seq: 1,
    method: "turn/completed",
    params: {
      turn: {
        id: "t1",
        threadId: "thr_daedalus",
        status: "interrupted",
        items: [],
        error: null,
        startedAt: 100,
        completedAt: 200,
      },
    },
  });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(ctrl.getQuitTurns().length, 0);
  assert.equal(turnPillForPane({ state: "interrupted" }).tone, "fail");
});
