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
  bindDesktopShell,
  createPaletteState,
  EXPECTED_PROTOCOL_VERSION,
  filterCommands,
  lockOwnerGuidanceFromStderr,
  PALETTE_COMMANDS,
  type ShellDocument,
  type ShellElement,
  serveExitFromCode,
  stepPalette,
} from "../ui/shell.js";
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
      inert: false,
      focusedCount: 0,
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
      inert: false,
      focusedCount: 0,
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

test("M3-A3 §9.10, §9.12 Command palette closed list, subsequence filter, keyboard nav, and tauri.conf.json", () => {
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
  assert.equal(state.activeId, "cmd-copy-served-model");
  state = stepPalette(state, "ArrowDown");
  assert.equal(state.activeId, "cmd-connect");
  state = stepPalette(state, "ArrowUp");
  assert.equal(state.activeId, "cmd-copy-served-model");

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

  // §9.10: Tab / Shift+Tab trapped while open, Home jumps to first enabled row.
  doc.emit("keydown", { key: "Tab", preventDefault() {} });
  assert.equal(doc.activeElement, byId.get("palette-input"));
  doc.emit("keydown", { key: "End", preventDefault() {} });
  assert.equal(
    byId.get("palette-input")?.getAttribute("aria-activedescendant"),
    "cmd-focus-search",
  );
  doc.emit("keydown", { key: "Home", preventDefault() {} });
  assert.equal(byId.get("palette-input")?.getAttribute("aria-activedescendant"), "cmd-connect");

  // M1: Focus Room clears inert BEFORE focusing Room button.
  doc.emit("keydown", { key: "ArrowDown", preventDefault() {} }); // cmd-focus-engine
  doc.emit("keydown", { key: "ArrowDown", preventDefault() {} }); // cmd-focus-room
  assert.equal(byId.get("palette-input")?.getAttribute("aria-activedescendant"), "cmd-focus-room");
  doc.emit("keydown", { key: "Enter", preventDefault() {} });
  assert.equal(byId.get("palette")?.hidden, true);
  assert.equal(byId.get("focus-bar")?.inert, false);
  assert.equal(doc.activeElement, buttons[1], "Focus Room must focus Room button");

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

  // §9.9: disconnect_engine rejection ("engine state lock poisoned") + R4 variants + N5 + L4.
  for (const r4Err of [
    "engine request failed: broken pipe",
    "engine response invalid: unexpected EOF",
    "engine request task failed: join error",
  ]) {
    const { doc, byId } = createShellHarness();
    const deferred: {
      resolveDisc: (() => void) | null;
      rejectDisc: ((e: unknown) => void) | null;
    } = { resolveDisc: null, rejectDisc: null };
    let discCalls = 0;
    let rpcCalls = 0;
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
      if (cmd === "rpc_request" && args?.method === "room/inspect") {
        rpcCalls += 1;
        if (rpcCalls === 1) {
          return Promise.resolve({
            room: {
              counts: { threads: 0, pass: 0, warn: 0, fail: 0, openDecisions: 0 },
              threads: [],
            },
          });
        }
        return Promise.reject(r4Err);
      }
      return Promise.reject(new Error(`unexpected ${cmd}`));
    });
    await ctrl.connect();

    // selectThread inert while disconnectPending is true.
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
    assert.equal(rpcCalls, 2, "selectThread must be inert while disconnectPending");

    deferred.rejectDisc?.("engine state lock poisoned");
    await insp;
    assert.equal(ctrl.getConnectionState(), "FAILED");
    assert.equal(byId.get("output")?.textContent, "engine state lock poisoned");
    assert.equal(byId.get("connect-btn")?.disabled, false);
    assert.equal(discCalls, 1, "no retry on disconnect_engine reject");
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
