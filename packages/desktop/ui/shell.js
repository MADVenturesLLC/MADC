/**
 * M3-A3 shipped desktop UI module (`packages/desktop/ui/shell.js`).
 *
 * Single source of truth loaded by `ui/index.html` (via `ui/app.js`) and re-exported / tested
 * directly by `@madc/desktop`:
 * - Keyboard focus bar controller (`PLAN-madc-M3-build-plan.md` §2 row M3-A2)
 * - Evidence-bound UI tone rule (`PIN-madc-M3-desktop-protocol.md` §4): derives verified status
 *   strictly from engine-returned receipt fields (`chainOk` + 64-hex `hash`, 40-hex `sha`, or
 *   `vendorReported` + non-empty `servedModel`), never a caller-supplied boolean.
 * - Precision Instrument Glass primitives, Room table, Receipts well, command palette, and
 *   single-flight Tauri IPC shell binder (`PIN-madc-M3-design-precision-instrument-glass.md`).
 */

const SHA256_HEX = /^[0-9a-f]{64}$/;
const GIT_SHA_HEX = /^[0-9a-f]{40}$/;
const LOCK_OWNER_LINE = /^madc-engine serve: home owned by pid (\d+): (.+)$/;
const CONNECT_EXIT_20_PREFIX = "madc-engine serve exited 20 (";
const CONNECT_EXIT_RE =
  /^madc-engine serve exited before initialize \(code=(None|Some\((-?\d+)\)), signal=(None|Some\((\d+)\)), class=/;
const CONNECT_TIMEOUT_RE =
  /^madc-engine serve did not complete initialize within (\d+) ms \(exit code=(None|Some\((-?\d+)\)), signal=(None|Some\((\d+)\))\)/;
const WINDOWS_UNVERIFIED_MSG = "Windows named-pipe desktop transport is unverified in M3-A2";
const RPC_ALLOWLIST_PREFIX = "RPC method not allowed by M3-A2 desktop shell: ";
const RPC_NOT_CONNECTED_MSG = "not connected to @madc/engine";
const RPC_ENGINE_ERROR_PREFIX = "engine RPC error: ";

export const EXPECTED_PROTOCOL_VERSION = "madc-m1/1";

export const DEFAULT_FOCUS_BAR_ITEMS = Object.freeze([
  Object.freeze({ id: "connection", label: "Engine" }),
  Object.freeze({ id: "room", label: "Room" }),
  Object.freeze({ id: "decisions", label: "Decisions" }),
  Object.freeze({ id: "search", label: "Search" }),
]);

export const PALETTE_COMMANDS = Object.freeze([
  Object.freeze({
    id: "cmd-connect",
    group: "Engine",
    name: "Connect to @madc/engine",
    defaultMeta: "manual · no retry",
    keyHint: null,
  }),
  Object.freeze({
    id: "cmd-inspect-room",
    group: "Engine",
    name: "Inspect room",
    defaultMeta: "room/inspect",
    keyHint: null,
  }),
  Object.freeze({
    id: "cmd-disconnect",
    group: "Engine",
    name: "Disconnect",
    defaultMeta: null,
    keyHint: null,
  }),
  Object.freeze({
    id: "cmd-focus-engine",
    group: "Focus",
    name: "Focus Engine",
    defaultMeta: null,
    keyHint: "Home",
  }),
  Object.freeze({
    id: "cmd-focus-room",
    group: "Focus",
    name: "Focus Room",
    defaultMeta: null,
    keyHint: null,
  }),
  Object.freeze({
    id: "cmd-focus-decisions",
    group: "Focus",
    name: "Focus Decisions",
    defaultMeta: null,
    keyHint: null,
  }),
  Object.freeze({
    id: "cmd-focus-search",
    group: "Focus",
    name: "Focus Search",
    defaultMeta: null,
    keyHint: "End",
  }),
  Object.freeze({
    id: "cmd-copy-chain-head",
    group: "Evidence",
    name: "Copy chain head",
    defaultMeta: null,
    keyHint: null,
  }),
  Object.freeze({
    id: "cmd-copy-served-model",
    group: "Evidence",
    name: "Copy served model",
    defaultMeta: null,
    keyHint: null,
  }),
]);

const PILL_GLYPHS = Object.freeze({
  verified: "✓",
  neutral: "○",
  warn: "▲",
  fail: "✗",
});

const ALLOWED_PILL_LABELS = Object.freeze({
  verified: new Set(["VERIFIED"]),
  neutral: new Set(["NO RECEIPT", "IDLE", "CONNECTING", "CONNECTED", "DISCONNECTED"]),
  warn: new Set(["UNVERIFIED", "STOPPED"]),
  fail: new Set(["FAILED"]),
});

export function createFocusBarState(items = DEFAULT_FOCUS_BAR_ITEMS, initialIndex = 0) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("focus bar requires at least one item");
  }
  const bounded = ((initialIndex % items.length) + items.length) % items.length;
  const active = items[bounded];
  if (active === undefined) {
    throw new Error("focus bar index out of range");
  }
  return { items, activeIndex: bounded, activeId: active.id };
}

export function stepFocusBar(state, key) {
  const len = state.items.length;
  let nextIndex = state.activeIndex;
  switch (key) {
    case "Tab":
    case "ArrowRight":
      nextIndex = (state.activeIndex + 1) % len;
      break;
    case "Shift+Tab":
    case "ArrowLeft":
      nextIndex = (state.activeIndex - 1 + len) % len;
      break;
    case "Home":
      nextIndex = 0;
      break;
    case "End":
      nextIndex = len - 1;
      break;
    default:
      return state;
  }
  const active = state.items[nextIndex];
  if (active === undefined) return state;
  return { ...state, activeIndex: nextIndex, activeId: active.id };
}

export function focusBarSelect(state, id) {
  const idx = state.items.findIndex((item) => item.id === id);
  if (idx === -1) return state;
  return { ...state, activeIndex: idx, activeId: id };
}

/**
 * Determine whether an engine-returned receipt earns the `verified` (green-eligible) state per
 * M3 pin §4. Fails closed on missing/malformed fields and never accepts a caller boolean.
 */
export function isVerifiedReceipt(receipt) {
  if (receipt === null || receipt === undefined || typeof receipt !== "object") return false;
  switch (receipt.kind) {
    case "hash":
      return (
        receipt.chainOk === true &&
        typeof receipt.hash === "string" &&
        SHA256_HEX.test(receipt.hash)
      );
    case "sha":
      return typeof receipt.sha === "string" && GIT_SHA_HEX.test(receipt.sha);
    case "servedModel":
      return (
        receipt.vendorReported === true &&
        typeof receipt.servedModel === "string" &&
        receipt.servedModel.trim().length > 0
      );
    default:
      return false;
  }
}

/**
 * Map an engine-returned receipt and explicit status hint to an evidence-bound UI tone.
 * Even when `hint === "ok"`, `verified` is returned ONLY when `isVerifiedReceipt(receipt)` is true.
 */
export function evidenceTone(receipt, hint = "neutral") {
  if (hint === "fail") return "fail";
  if (hint === "warn") return "warn";
  if (isVerifiedReceipt(receipt)) return "verified";
  return "neutral";
}

/**
 * Replace C0 control bytes (except TAB/LF), DEL, and C1 control bytes with U+FFFD per spec §4.2.
 */
export function sanitizeEngineText(value) {
  const str = String(value ?? "");
  let out = "";
  for (let i = 0; i < str.length; i += 1) {
    const code = str.charCodeAt(i);
    if (
      (code >= 0x00 && code <= 0x08) ||
      code === 0x0b ||
      code === 0x0c ||
      (code >= 0x0e && code <= 0x1f) ||
      (code >= 0x7f && code <= 0x9f)
    ) {
      out += "\uFFFD";
    } else {
      out += str[i];
    }
  }
  return out;
}

/**
 * Plain-JS port of `classifyServeExit` from `src/ipc.ts` (pin §6.2, D3, D5).
 */
export function serveExitFromCode(code, signal = null) {
  const normalizedSignal = signal ?? null;
  if (code === null && normalizedSignal !== null) {
    return { kind: "stopped", code: null, signal: normalizedSignal };
  }
  switch (code) {
    case 0:
    case 130:
    case 143:
      return { kind: "clean", code };
    case 2:
      return { kind: "usage-or-home", code: 2 };
    case 20:
      return { kind: "owned", code: 20 };
    case 21:
      return { kind: "unsafe-path", code: 21 };
    case 22:
      return { kind: "listen-error", code: 22 };
    case 23:
      return { kind: "shutdown-deadline", code: 23 };
    case 24:
      return { kind: "internal-fault", code: 24, rawCode: 24 };
    default:
      return { kind: "internal-fault", code: 24, rawCode: code };
  }
}

/**
 * Plain-JS port of `parseLockOwnerGuidance` from `src/ipc.ts` (pin §6.2, D5).
 */
export function lockOwnerGuidanceFromStderr(stderrText, platform = "darwin") {
  const lines = String(stderrText ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line === undefined) continue;
    const match = LOCK_OWNER_LINE.exec(line);
    if (match === null) continue;
    const pid = Number(match[1]);
    const lockPath = match[2] ?? "";
    if (!Number.isInteger(pid) || pid <= 0 || lockPath.length === 0) continue;
    const checkCmd =
      platform === "win32"
        ? `Check Task Manager for PID ${pid}`
        : `Run \`ps -p ${pid} -o command=\` to confirm no \`madc-engine serve\` process with PID ${pid} is running`;
    return {
      pid,
      lockPath,
      manualFix: `(i) ${checkCmd}; (ii) if none is running, manually remove ${lockPath}.`,
    };
  }
  return null;
}

/**
 * Classify a `connect_engine` rejection string per pin §6.2 (grammars G1–G6).
 */
export function classifyConnectError(errOrMessage, platform = "darwin") {
  const raw =
    typeof errOrMessage === "string" ? errOrMessage : String(errOrMessage?.message ?? errOrMessage);
  const splitIdx = raw.indexOf("\nstderr:\n");
  const head = splitIdx === -1 ? raw : raw.slice(0, splitIdx);
  const stderr = splitIdx === -1 ? "" : raw.slice(splitIdx + "\nstderr:\n".length);

  if (head.startsWith(CONNECT_EXIT_20_PREFIX)) {
    return {
      phase: "serve-exit",
      exit: serveExitFromCode(20, null),
      guidance: lockOwnerGuidanceFromStderr(stderr, platform),
      raw,
    };
  }

  const exitMatch = CONNECT_EXIT_RE.exec(head);
  if (exitMatch !== null) {
    const code = exitMatch[2] !== undefined ? Number(exitMatch[2]) : null;
    const signal = exitMatch[4] !== undefined ? String(Number(exitMatch[4])) : null;
    return {
      phase: "serve-exit",
      exit: serveExitFromCode(code, signal),
      guidance: null,
      raw,
    };
  }

  const timeoutMatch = CONNECT_TIMEOUT_RE.exec(head);
  if (timeoutMatch !== null) {
    return {
      phase: "start-timeout",
      startWindowMs: Number(timeoutMatch[1]),
      raw,
    };
  }

  if (head === WINDOWS_UNVERIFIED_MSG) {
    return { phase: "unverified-transport", raw };
  }

  return { phase: "other", raw };
}

/**
 * Classify an `rpc_request` rejection string per pin §6.4 (R1–R4).
 */
export function classifyRpcError(errOrMessage) {
  const message =
    typeof errOrMessage === "string" ? errOrMessage : String(errOrMessage?.message ?? errOrMessage);

  if (message.startsWith(RPC_ALLOWLIST_PREFIX)) {
    return { kind: "allowlist", message };
  }

  if (message === RPC_NOT_CONNECTED_MSG) {
    return { kind: "not-connected", message };
  }

  if (message.startsWith(RPC_ENGINE_ERROR_PREFIX)) {
    const rest = message.slice(RPC_ENGINE_ERROR_PREFIX.length);
    try {
      const parsed = JSON.parse(rest);
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        typeof parsed.code === "number" &&
        typeof parsed.message === "string"
      ) {
        return {
          kind: "rpc",
          code: parsed.code,
          rpcMessage: parsed.message,
          data: parsed.data,
          message,
        };
      }
    } catch {
      // Fall through to R4 transport error per pin §6.4.
    }
  }

  return { kind: "transport", message };
}

function validatePillInput(tone, label) {
  const allowed = ALLOWED_PILL_LABELS[tone];
  if (!allowed?.has(label)) {
    throw new Error(`invalid pill label "${label}" for tone "${tone}"`);
  }
}

export function renderPill(doc, input) {
  const { tone, label, context, small = false, role = "status" } = input;
  validatePillInput(tone, label);
  const el = doc.createElement("span");
  el.className = small ? "pill pill--sm" : "pill";
  el.setAttribute("data-tone", tone);
  el.setAttribute("role", role);
  el.setAttribute("aria-label", context ? `${tone}, ${context}` : tone);

  const glyphEl = doc.createElement("span");
  glyphEl.className = "pill-glyph";
  glyphEl.setAttribute("aria-hidden", "true");
  glyphEl.textContent = PILL_GLYPHS[tone];

  const labelEl = doc.createElement("span");
  labelEl.className = "pill-label";
  labelEl.textContent = label;

  el.appendChild(glyphEl);
  el.appendChild(labelEl);
  return el;
}

function updatePillElement(doc, el, input) {
  const { tone, label, context, small = false, role = "status" } = input;
  validatePillInput(tone, label);
  el.className = small ? "pill pill--sm" : "pill";
  el.setAttribute("data-tone", tone);
  el.setAttribute("role", role);
  el.setAttribute("aria-label", context ? `${tone}, ${context}` : tone);

  const glyphEl = doc.createElement("span");
  glyphEl.className = "pill-glyph";
  glyphEl.setAttribute("aria-hidden", "true");
  glyphEl.textContent = PILL_GLYPHS[tone];

  const labelEl = doc.createElement("span");
  labelEl.className = "pill-label";
  labelEl.textContent = label;

  el.replaceChildren(glyphEl, labelEl);
}

function renderChip(doc, key, value, title = null, mutedValue = false) {
  const chip = doc.createElement("span");
  chip.className = "chip";

  const k = doc.createElement("span");
  k.className = "chip-k";
  k.textContent = key;

  const v = doc.createElement("span");
  v.className = mutedValue ? "chip-v chip-v--muted" : "chip-v";
  v.textContent = value;
  if (title) {
    v.setAttribute("title", title);
  }

  chip.appendChild(k);
  chip.appendChild(v);
  return chip;
}

/**
 * Case-insensitive subsequence match over command name only (spec §7.2, pin §5.5).
 */
function matchSubsequence(name, query) {
  if (!query) return [];
  const lowerName = name.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const indices = [];
  let qi = 0;
  for (let i = 0; i < lowerName.length && qi < lowerQuery.length; i += 1) {
    if (lowerName[i] === lowerQuery[qi]) {
      indices.push(i);
      qi += 1;
    }
  }
  return qi === lowerQuery.length ? indices : null;
}

export function filterCommands(commands, query = "") {
  const matches = [];
  for (const cmd of commands) {
    const matchIndices = matchSubsequence(cmd.name, query);
    if (matchIndices !== null) {
      matches.push({ command: cmd, matchIndices });
    }
  }
  return matches;
}

export function createPaletteState(commands = PALETTE_COMMANDS, query = "", open = false) {
  const filtered = filterCommands(commands, query);
  const firstEnabled = filtered.find((entry) => entry.command.disabled !== true);
  return {
    open,
    query,
    commands,
    filtered,
    activeId: firstEnabled ? firstEnabled.command.id : null,
  };
}

export function stepPalette(state, key) {
  const enabled = state.filtered.filter((entry) => entry.command.disabled !== true);
  if (enabled.length === 0) {
    return state.activeId === null ? state : { ...state, activeId: null };
  }
  const currentIdx = enabled.findIndex((entry) => entry.command.id === state.activeId);
  let nextIdx;
  switch (key) {
    case "ArrowDown":
      nextIdx = currentIdx === -1 ? 0 : (currentIdx + 1) % enabled.length;
      break;
    case "ArrowUp":
      nextIdx =
        currentIdx === -1 ? enabled.length - 1 : (currentIdx - 1 + enabled.length) % enabled.length;
      break;
    case "Home":
      nextIdx = 0;
      break;
    case "End":
      nextIdx = enabled.length - 1;
      break;
    default:
      return state;
  }
  const next = enabled[nextIdx];
  return next ? { ...state, activeId: next.command.id } : state;
}

export async function invokeTauri(cmd, args, globalObj = globalThis) {
  const internals = globalObj?.__TAURI_INTERNALS__;
  if (!internals || typeof internals.invoke !== "function") {
    throw new Error("Tauri IPC bridge unavailable outside desktop shell");
  }
  return internals.invoke(cmd, args || {});
}

function formatCountsLine(counts) {
  if (!counts || typeof counts !== "object") {
    return "—";
  }
  const fmt = (val) => (typeof val === "number" ? String(val) : "—");
  return `${fmt(counts.threads)} threads · ${fmt(counts.pass)} pass · ${fmt(counts.warn)} warn · ${fmt(counts.fail)} fail · ${fmt(counts.openDecisions)} open decisions`;
}

function evaluateRoomRow(row, readEntry) {
  // §4.3 B: user-triggered session/read rejected
  if (readEntry && readEntry.ok === false) {
    return {
      tone: evidenceTone(null, "fail"),
      label: "FAILED",
      eventsText: "—",
      eventsMuted: true,
      chips: [],
      note: readEntry.note,
      hashFull: null,
    };
  }

  // §4.3 B: user-triggered session/read resolved
  if (readEntry && readEntry.ok === true) {
    const res = readEntry.result;
    if (res?.chainOk !== true) {
      const base = evaluateRoomRow(row, null);
      return {
        ...base,
        tone: evidenceTone(null, "fail"),
        label: "FAILED",
        eventsText: "—",
        eventsMuted: true,
        chips: [...base.chips, { key: "chainOk", value: "false" }],
      };
    }

    const events = Array.isArray(res.events) ? res.events : [];
    const lastEvent = events.length > 0 ? events[events.length - 1] : null;
    const tailHash = typeof lastEvent?.hash === "string" ? lastEvent.hash : null;
    const receipt = tailHash !== null ? { kind: "hash", chainOk: true, hash: tailHash } : null;
    const hint = row.level === "fail" ? "fail" : row.level === "warn" ? "warn" : "ok";
    const tone = evidenceTone(receipt, hint);

    if (tone === "verified" && tailHash !== null) {
      return {
        tone,
        label: "VERIFIED",
        eventsText: String(events.length),
        eventsMuted: false,
        chips: [
          { key: "hash", value: tailHash.slice(0, 12), title: tailHash },
          { key: "chainOk", value: "true" },
        ],
        note: null,
        hashFull: tailHash,
      };
    }

    if (tone === "warn" || tone === "fail") {
      const base = evaluateRoomRow(row, null);
      return {
        ...base,
        eventsText: String(events.length),
        eventsMuted: false,
      };
    }

    return {
      tone: "neutral",
      label: "NO RECEIPT",
      eventsText: String(events.length),
      eventsMuted: false,
      chips: [{ key: "hash", value: "—", muted: true }],
      note: null,
      hashFull: null,
    };
  }

  // §4.3 A: before any session/read
  const chain = row?.chain;
  if (chain && chain.ok === false && chain.kind === "torn-tail") {
    return {
      tone: evidenceTone(null, "fail"),
      label: "FAILED",
      eventsText: "—",
      eventsMuted: true,
      chips: [{ key: "torn tail", value: `line ${chain.line}` }],
      note: "crash residue, not tamper",
      hashFull: null,
    };
  }

  if (chain && chain.ok === false) {
    return {
      tone: evidenceTone(null, "fail"),
      label: "FAILED",
      eventsText: "—",
      eventsMuted: true,
      chips: [
        { key: "chain", value: "FAILED" },
        { key: "line", value: String(chain.line ?? "—") },
      ],
      note: sanitizeEngineText(chain.reason ?? "chain integrity failed"),
      hashFull: null,
    };
  }

  const findings = Array.isArray(row?.findings) ? row.findings : [];
  if (row?.level === "fail") {
    const f = findings.find((item) => item?.level === "fail");
    return {
      tone: evidenceTone(null, "fail"),
      label: "FAILED",
      eventsText: "—",
      eventsMuted: true,
      chips: [],
      note: f ? sanitizeEngineText(`${f.code}: ${f.detail}`) : "fail",
      hashFull: null,
    };
  }

  if (row?.level === "warn") {
    const f = findings.find((item) => item?.level === "warn");
    return {
      tone: evidenceTone(null, "warn"),
      label: "UNVERIFIED",
      eventsText: "—",
      eventsMuted: true,
      chips: [],
      note: f ? sanitizeEngineText(`${f.code}: ${f.detail}`) : "warn",
      hashFull: null,
    };
  }

  return {
    tone: evidenceTone(null, "neutral"),
    label: "NO RECEIPT",
    eventsText: "—",
    eventsMuted: true,
    chips: [{ key: "hash", value: "—", muted: true }],
    note: null,
    hashFull: null,
  };
}

function isMacPlatform(globalObj = globalThis) {
  const nav = globalObj?.navigator;
  const plat = String(nav?.platform ?? nav?.userAgent ?? "");
  return /mac/i.test(plat);
}

/**
 * Wire the M3-A3 desktop shell, focus bar, manual connect/disconnect, Room table,
 * Receipts well, and command palette in `ui/index.html`.
 */
export function bindDesktopShell(doc, invokeFn = invokeTauri, env = {}) {
  const globalObj = env.globalObj ?? globalThis;
  const platform = env.platform ?? (isMacPlatform(globalObj) ? "darwin" : "linux");
  const isMac = platform === "darwin";

  const bar = doc.getElementById("focus-bar");
  const buttons = Array.from(bar.querySelectorAll("button[data-focus-id]"));
  const items = buttons.map((btn) => ({
    id: btn.getAttribute("data-focus-id"),
    label: btn.textContent ?? "",
  }));
  let focusState = createFocusBarState(items, 0);

  const mainEl = doc.getElementById("main-content");
  const statusEl = doc.getElementById("connection-status");
  const outputEl = doc.getElementById("output");
  const connectBtn = doc.getElementById("connect-btn");
  const roomCountsEl = doc.getElementById("room-counts");
  const roomRowsEl = doc.getElementById("room-rows");
  const receiptRowsEl = doc.getElementById("receipt-rows");
  const enginePillEl = doc.getElementById("engine-pill");
  const kvSocketEl = doc.getElementById("kv-socket");
  const kvProtocolEl = doc.getElementById("kv-protocol");
  const kvServerEl = doc.getElementById("kv-server");
  const kvColdStartEl = doc.getElementById("kv-cold-start");
  const kvReusedEl = doc.getElementById("kv-reused");
  const paletteEl = doc.getElementById("palette");
  const paletteInputEl = doc.getElementById("palette-input");
  const paletteListEl = doc.getElementById("palette-list");
  const paletteLiveEl = doc.getElementById("palette-live");
  const paletteKeycapEl = doc.getElementById("palette-keycap");

  paletteKeycapEl.textContent = isMac ? "⌘K" : "Ctrl K";

  let connectionState = "IDLE";
  let epoch = 0;
  let inspectGeneration = 0;
  let connectPending = null;
  let disconnectPending = null;
  let lastConnectionInfo = null;
  let currentRoom = null;
  let selectedThreadId = null;
  let roomInspectErrorNote = null;
  const sessionReadCache = new Map();
  const inFlightReads = new Set();
  const sessionReceipts = [];
  let paletteOpen = false;
  let paletteQuery = "";
  let paletteActiveId = null;
  let priorFocusEl = null;

  function applyFocus(nextState, moveDomFocus) {
    focusState = nextState;
    buttons.forEach((btn, i) => {
      btn.setAttribute("aria-pressed", String(i === focusState.activeIndex));
      btn.tabIndex = i === focusState.activeIndex ? 0 : -1;
    });
    if (moveDomFocus) {
      buttons[focusState.activeIndex]?.focus();
    }
  }

  bar.addEventListener("keydown", (ev) => {
    if (
      ev.key === "ArrowRight" ||
      ev.key === "ArrowLeft" ||
      ev.key === "Home" ||
      ev.key === "End"
    ) {
      ev.preventDefault();
      applyFocus(stepFocusBar(focusState, ev.key), true);
    }
  });

  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-focus-id");
      if (id) applyFocus(focusBarSelect(focusState, id), true);
    });
  });
  applyFocus(focusState, true);

  function statePresentation(state) {
    switch (state) {
      case "IDLE":
        return {
          tone: "neutral",
          label: "IDLE",
          strip: "idle · no receipt",
          context: "idle, no receipt",
        };
      case "CONNECTING":
        return {
          tone: "neutral",
          label: "CONNECTING",
          strip: "connecting over engine.sock…",
          context: "connecting",
        };
      case "CONNECTED":
        return {
          tone: "neutral",
          label: "CONNECTED",
          strip: "connected · neutral",
          context: "connected, neutral",
        };
      case "DISCONNECTED":
        return {
          tone: "neutral",
          label: "DISCONNECTED",
          strip: "disconnected",
          context: "disconnected",
        };
      case "STOPPED":
        return { tone: "warn", label: "STOPPED", strip: "stopped", context: "stopped" };
      case "FAILED":
        return {
          tone: "fail",
          label: "FAILED",
          strip: "engine connection failed (no automatic retry)",
          context: "failed",
        };
      default:
        return { tone: "neutral", label: "IDLE", strip: "idle · no receipt", context: "idle" };
    }
  }

  function renderConnectionChrome() {
    const pres = statePresentation(connectionState);
    updatePillElement(doc, enginePillEl, {
      tone: pres.tone,
      label: pres.label,
      context: pres.context,
      small: true,
      role: pres.tone === "fail" ? "alert" : "status",
    });

    statusEl.setAttribute("data-tone", pres.tone);
    const leftSpan = doc.createElement("span");
    leftSpan.className = "strip-left";
    leftSpan.textContent = `engine · ${sanitizeEngineText(lastConnectionInfo?.socketPath ?? "~/.madc/engine.sock")}`;

    const centerSpan = doc.createElement("span");
    centerSpan.className = "strip-center";
    centerSpan.textContent = pres.strip;

    const rightSpan = doc.createElement("span");
    rightSpan.className = "strip-right";
    const coldMs =
      typeof lastConnectionInfo?.coldStartMs === "number"
        ? `${lastConnectionInfo.coldStartMs} ms`
        : "—";
    rightSpan.textContent = `cold start ${coldMs} · model —`;

    statusEl.replaceChildren(leftSpan, centerSpan, rightSpan);

    kvSocketEl.textContent = sanitizeEngineText(lastConnectionInfo?.socketPath ?? "—");
    kvProtocolEl.textContent = sanitizeEngineText(lastConnectionInfo?.protocolVersion ?? "—");
    kvServerEl.textContent = lastConnectionInfo?.serverName
      ? sanitizeEngineText(
          `${lastConnectionInfo.serverName} ${lastConnectionInfo.serverVersion ?? ""}`.trim(),
        )
      : "—";
    kvColdStartEl.textContent =
      typeof lastConnectionInfo?.coldStartMs === "number"
        ? `${lastConnectionInfo.coldStartMs} ms`
        : "—";
    kvReusedEl.textContent =
      typeof lastConnectionInfo?.reusedExisting === "boolean"
        ? String(lastConnectionInfo.reusedExisting)
        : "—";

    const isConnected = connectionState === "CONNECTED";
    connectBtn.hidden = isConnected;
    connectBtn.disabled =
      connectionState === "CONNECTING" || disconnectPending !== null || isConnected;
  }

  function renderReceiptsWell() {
    const nodes = sessionReceipts.map((item) => {
      const row = doc.createElement("div");
      row.className = "receipt-row";
      row.setAttribute("data-tone", item.tone);

      const labelEl = doc.createElement("span");
      labelEl.className = "receipt-label";
      labelEl.textContent = item.label;

      const pill = renderPill(doc, {
        tone: item.tone,
        label: item.pillLabel,
        context: item.context,
        role: item.tone === "fail" ? "alert" : "status",
      });

      const chipsEl = doc.createElement("span");
      chipsEl.className = "receipt-chips";
      for (const ch of item.chips) {
        chipsEl.appendChild(renderChip(doc, ch.key, ch.value, ch.title ?? null, ch.muted ?? false));
      }

      const noteEl = doc.createElement("span");
      noteEl.className = "row-note";
      noteEl.textContent = item.note ? sanitizeEngineText(item.note) : "";
      if (item.note) {
        noteEl.setAttribute("title", sanitizeEngineText(item.note));
      }

      row.appendChild(labelEl);
      row.appendChild(pill);
      row.appendChild(chipsEl);
      row.appendChild(noteEl);
      return row;
    });
    receiptRowsEl.replaceChildren(...nodes);
  }

  function findBestChainHead() {
    const threads = Array.isArray(currentRoom?.threads) ? currentRoom.threads : [];
    const verifiedHashFor = (thr) => {
      if (!thr) return null;
      const evaluated = evaluateRoomRow(thr, sessionReadCache.get(thr.threadId) ?? null);
      return evaluated.tone === "verified" ? evaluated.hashFull : null;
    };

    if (selectedThreadId) {
      const selectedThr = threads.find((t) => t.threadId === selectedThreadId);
      const hash = verifiedHashFor(selectedThr);
      if (hash !== null) return hash;
    }

    const cachedIds = Array.from(sessionReadCache.keys()).reverse();
    for (const threadId of cachedIds) {
      const thr = threads.find((t) => t.threadId === threadId);
      const hash = verifiedHashFor(thr);
      if (hash !== null) return hash;
    }
    return null;
  }

  function renderRoomTable() {
    if (roomInspectErrorNote !== null) {
      roomCountsEl.textContent = "—";
      const errRow = doc.createElement("div");
      errRow.className = "room-row";
      errRow.setAttribute("data-tone", "fail");
      errRow.appendChild(
        renderPill(doc, {
          tone: "fail",
          label: "FAILED",
          context: roomInspectErrorNote,
          role: "alert",
        }),
      );
      const thrCell = doc.createElement("span");
      thrCell.className = "cell-thread";
      thrCell.textContent = "room/inspect";
      const seatCell = doc.createElement("span");
      seatCell.className = "cell-seat";
      seatCell.textContent = "—";
      const evCell = doc.createElement("span");
      evCell.className = "cell-events cell-events--muted";
      evCell.textContent = "—";
      const recCell = doc.createElement("span");
      recCell.className = "cell-receipt";
      const noteEl = doc.createElement("span");
      noteEl.className = "row-note";
      noteEl.textContent = sanitizeEngineText(roomInspectErrorNote);
      recCell.appendChild(noteEl);
      errRow.appendChild(thrCell);
      errRow.appendChild(seatCell);
      errRow.appendChild(evCell);
      errRow.appendChild(recCell);
      roomRowsEl.replaceChildren(errRow);
      return;
    }

    if (!currentRoom) {
      roomCountsEl.textContent = "—";
      roomRowsEl.replaceChildren();
      return;
    }

    roomCountsEl.textContent = formatCountsLine(currentRoom.counts);
    const threads = Array.isArray(currentRoom.threads) ? currentRoom.threads : [];
    if (threads.length === 0) {
      const emptyRow = doc.createElement("div");
      emptyRow.className = "room-row room-row--empty";
      emptyRow.setAttribute("data-tone", "neutral");
      emptyRow.textContent = "No threads in $MADC_HOME/sessions";
      roomRowsEl.replaceChildren(emptyRow);
      return;
    }

    const rowNodes = threads.map((row) => {
      const evaluated = evaluateRoomRow(row, sessionReadCache.get(row.threadId) ?? null);
      const rowEl = doc.createElement("div");
      rowEl.className = "room-row";
      rowEl.tabIndex = 0;
      rowEl.setAttribute("role", "option");
      rowEl.setAttribute("data-thread-id", row.threadId);
      rowEl.setAttribute("data-tone", evaluated.tone);
      rowEl.setAttribute("aria-selected", String(selectedThreadId === row.threadId));

      const pill = renderPill(doc, {
        tone: evaluated.tone,
        label: evaluated.label,
        context: `${row.threadId} ${evaluated.note ?? ""}`.trim(),
      });

      const thrCell = doc.createElement("span");
      thrCell.className = "cell-thread";
      thrCell.textContent = sanitizeEngineText(row.threadId);

      const seatCell = doc.createElement("span");
      seatCell.className = "cell-seat";
      seatCell.textContent = sanitizeEngineText(row.seatId ?? "—");

      const evCell = doc.createElement("span");
      evCell.className = evaluated.eventsMuted ? "cell-events cell-events--muted" : "cell-events";
      evCell.textContent = evaluated.eventsText;

      const recCell = doc.createElement("span");
      recCell.className = "cell-receipt";
      for (const ch of evaluated.chips) {
        recCell.appendChild(renderChip(doc, ch.key, ch.value, ch.title ?? null, ch.muted ?? false));
      }
      if (evaluated.note) {
        const noteEl = doc.createElement("span");
        noteEl.className = "row-note";
        noteEl.textContent = sanitizeEngineText(evaluated.note);
        noteEl.setAttribute("title", sanitizeEngineText(evaluated.note));
        recCell.appendChild(noteEl);
      }

      rowEl.appendChild(pill);
      rowEl.appendChild(thrCell);
      rowEl.appendChild(seatCell);
      rowEl.appendChild(evCell);
      rowEl.appendChild(recCell);

      const triggerSelect = () => {
        void selectThread(row.threadId);
      };
      rowEl.addEventListener("click", triggerSelect);
      rowEl.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault?.();
          triggerSelect();
        }
      });
      return rowEl;
    });

    roomRowsEl.replaceChildren(...rowNodes);
  }

  function startDisconnect(targetStateAfterResolve) {
    if (disconnectPending !== null) {
      return disconnectPending;
    }
    epoch += 1;

    let settle = null;
    disconnectPending = new Promise((resolve) => {
      settle = resolve;
    });
    renderConnectionChrome();
    if (paletteOpen) renderPalette();

    (async () => {
      try {
        await invokeFn("disconnect_engine");
        lastConnectionInfo = null;
        connectionState = targetStateAfterResolve;
      } catch (err) {
        connectionState = "FAILED";
        outputEl.textContent = sanitizeEngineText(err?.message ?? err);
      } finally {
        disconnectPending = null;
        renderConnectionChrome();
        if (paletteOpen) renderPalette();
        settle?.();
      }
    })();

    return disconnectPending;
  }

  async function runRoomInspect() {
    if (connectionState !== "CONNECTED" || disconnectPending !== null) return;
    const reqEpoch = epoch;
    try {
      const roomRes = await invokeFn("rpc_request", { method: "room/inspect", params: {} });
      if (reqEpoch !== epoch || disconnectPending !== null || connectionState !== "CONNECTED") {
        return;
      }
      inspectGeneration += 1;
      sessionReadCache.clear();
      inFlightReads.clear();
      roomInspectErrorNote = null;
      currentRoom = roomRes?.room ?? { counts: { threads: 0, openDecisions: 0 }, threads: [] };
      outputEl.textContent = sanitizeEngineText(
        JSON.stringify({ connection: lastConnectionInfo, room: roomRes }, null, 2),
      );
      renderRoomTable();
      if (paletteOpen) renderPalette();
    } catch (err) {
      if (reqEpoch !== epoch) {
        return;
      }
      const cls = classifyRpcError(err);
      outputEl.textContent = sanitizeEngineText(cls.message);
      inspectGeneration += 1;
      sessionReadCache.clear();
      inFlightReads.clear();

      if (cls.kind === "rpc") {
        roomInspectErrorNote = `room/inspect: ${cls.code} ${cls.rpcMessage}`;
        renderRoomTable();
        return;
      }
      if (cls.kind === "allowlist") {
        roomInspectErrorNote = cls.message;
        renderRoomTable();
        return;
      }
      if (cls.kind === "not-connected") {
        roomInspectErrorNote = cls.message;
        renderRoomTable();
        if (reqEpoch === epoch && disconnectPending === null) {
          lastConnectionInfo = null;
          connectionState = "DISCONNECTED";
          renderConnectionChrome();
        }
        return;
      }

      // R4: transport loss, timeout, or unparseable RPC error
      roomInspectErrorNote = cls.message;
      renderRoomTable();
      if (reqEpoch === epoch && disconnectPending === null) {
        connectionState = "FAILED";
        renderConnectionChrome();
        await startDisconnect("FAILED");
      }
    }
  }

  async function selectThread(threadId) {
    if (connectionState !== "CONNECTED" || disconnectPending !== null) {
      return;
    }
    selectedThreadId = threadId;
    renderRoomTable();
    if (inFlightReads.has(threadId)) {
      return;
    }

    inFlightReads.add(threadId);
    const reqEpoch = epoch;
    const reqGen = inspectGeneration;

    try {
      const res = await invokeFn("rpc_request", {
        method: "session/read",
        params: { threadId },
      });
      if (reqEpoch !== epoch || reqGen !== inspectGeneration || connectionState !== "CONNECTED") {
        return;
      }
      sessionReadCache.delete(threadId);
      sessionReadCache.set(threadId, { ok: true, result: res });
      renderRoomTable();
      if (paletteOpen) renderPalette();
    } catch (err) {
      if (reqEpoch !== epoch || reqGen !== inspectGeneration) {
        return;
      }
      const cls = classifyRpcError(err);
      outputEl.textContent = sanitizeEngineText(cls.message);
      const note = cls.kind === "rpc" ? `session/read: ${cls.code} ${cls.rpcMessage}` : cls.message;
      sessionReadCache.set(threadId, { ok: false, note });
      renderRoomTable();

      if (cls.kind === "not-connected") {
        if (disconnectPending === null) {
          lastConnectionInfo = null;
          connectionState = "DISCONNECTED";
          renderConnectionChrome();
        }
      } else if (cls.kind === "transport") {
        if (disconnectPending === null) {
          connectionState = "FAILED";
          renderConnectionChrome();
          await startDisconnect("FAILED");
        }
      }
      if (paletteOpen) renderPalette();
    } finally {
      inFlightReads.delete(threadId);
    }
  }

  function recordServeExitReceipt(classified) {
    const exit = classified.exit;
    let tone = "fail";
    let pillLabel = "FAILED";
    const chips = [];
    let note = null;

    if (exit.kind === "clean") {
      tone = "neutral";
      pillLabel = "DISCONNECTED";
      chips.push({ key: "serve exit", value: String(exit.code) });
    } else if (exit.kind === "stopped") {
      tone = "warn";
      pillLabel = "STOPPED";
      const val = exit.signal !== null ? `signal ${exit.signal}` : "1 launcher kill";
      chips.push({ key: "serve exit", value: val });
    } else if (exit.kind === "owned") {
      chips.push({ key: "serve exit", value: "20 owned" });
      if (classified.guidance) {
        chips.push({ key: "pid", value: String(classified.guidance.pid) });
        note = classified.guidance.manualFix;
      } else {
        note = "home owned by another process";
      }
    } else if (exit.kind === "internal-fault") {
      chips.push({ key: "serve exit", value: "24 internal-fault" });
      if (exit.rawCode !== 24) {
        chips.push({ key: "raw", value: String(exit.rawCode) });
      }
    } else {
      chips.push({ key: "serve exit", value: `${exit.code} ${exit.kind}` });
    }

    sessionReceipts.push({
      label: "serve exit",
      tone,
      pillLabel,
      context: chips.map((c) => `${c.key} ${c.value}`).join(" "),
      chips,
      note,
    });
    renderReceiptsWell();
  }

  const connectHandler = () => {
    if (connectPending !== null) {
      return connectPending;
    }
    if (disconnectPending !== null) {
      return disconnectPending;
    }
    connectionState = "CONNECTING";
    renderConnectionChrome();
    if (paletteOpen) renderPalette();

    connectPending = (async () => {
      try {
        const info = await invokeFn("connect_engine");
        epoch += 1;
        if (info?.protocolVersion !== EXPECTED_PROTOCOL_VERSION) {
          lastConnectionInfo = info ?? null;
          connectionState = "FAILED";
          const got = String(info?.protocolVersion ?? "unknown");
          const msg = `protocol version mismatch: expected ${EXPECTED_PROTOCOL_VERSION}, got ${got}`;
          outputEl.textContent = sanitizeEngineText(msg);
          sessionReceipts.push({
            label: "protocol",
            tone: "fail",
            pillLabel: "FAILED",
            context: msg,
            chips: [
              { key: "protocol", value: `expected ${EXPECTED_PROTOCOL_VERSION} · got ${got}` },
            ],
            note: null,
          });
          renderReceiptsWell();
          renderConnectionChrome();
          await startDisconnect("FAILED");
          return;
        }

        lastConnectionInfo = info;
        connectionState = "CONNECTED";
        renderConnectionChrome();
        await runRoomInspect();
      } catch (err) {
        const classified = classifyConnectError(err, platform);
        outputEl.textContent = sanitizeEngineText(classified.raw);
        if (classified.phase === "serve-exit") {
          if (classified.exit.kind === "clean") {
            connectionState = "DISCONNECTED";
          } else if (classified.exit.kind === "stopped") {
            connectionState = "STOPPED";
          } else {
            connectionState = "FAILED";
          }
          recordServeExitReceipt(classified);
        } else {
          connectionState = "FAILED";
        }
        renderConnectionChrome();
      } finally {
        connectPending = null;
        renderConnectionChrome();
        if (paletteOpen) renderPalette();
      }
    })();

    return connectPending;
  };

  connectBtn.addEventListener("click", () => {
    void connectHandler();
  });

  function buildPaletteCommands() {
    const canConnect =
      (connectionState === "IDLE" ||
        connectionState === "DISCONNECTED" ||
        connectionState === "STOPPED" ||
        connectionState === "FAILED") &&
      connectPending === null &&
      disconnectPending === null;
    const isConnected = connectionState === "CONNECTED" && disconnectPending === null;
    const clipboard = globalObj?.navigator?.clipboard;
    const hasClipboard = typeof clipboard?.writeText === "function";
    const chainHead = findBestChainHead();

    return PALETTE_COMMANDS.map((cmd) => {
      if (cmd.id === "cmd-connect") {
        let meta = cmd.defaultMeta;
        if (disconnectPending !== null) meta = "disconnecting";
        else if (connectionState === "CONNECTING") meta = "connecting";
        else if (connectionState === "CONNECTED") meta = "connected";
        return { ...cmd, disabled: !canConnect, meta };
      }
      if (cmd.id === "cmd-inspect-room") {
        return {
          ...cmd,
          disabled: !isConnected,
          meta: isConnected
            ? cmd.defaultMeta
            : disconnectPending !== null
              ? "disconnecting"
              : "not connected",
        };
      }
      if (cmd.id === "cmd-disconnect") {
        return {
          ...cmd,
          disabled: !isConnected,
          meta: disconnectPending !== null ? "disconnecting" : isConnected ? null : "not connected",
        };
      }
      if (cmd.id === "cmd-copy-chain-head") {
        if (!hasClipboard) {
          return { ...cmd, disabled: true, meta: "clipboard unavailable" };
        }
        return {
          ...cmd,
          disabled: chainHead === null,
          meta: chainHead !== null ? chainHead.slice(0, 12) : "no hash receipt",
        };
      }
      if (cmd.id === "cmd-copy-served-model") {
        if (!hasClipboard) {
          return { ...cmd, disabled: true, meta: "clipboard unavailable" };
        }
        return { ...cmd, disabled: true, meta: "no servedModel receipt" };
      }
      return { ...cmd, disabled: false, meta: cmd.defaultMeta };
    });
  }

  function currentPaletteState() {
    const cmds = buildPaletteCommands();
    const state = createPaletteState(cmds, paletteQuery, paletteOpen);
    if (
      paletteActiveId !== null &&
      state.filtered.some((e) => e.command.id === paletteActiveId && e.command.disabled !== true)
    ) {
      return { ...state, activeId: paletteActiveId };
    }
    return state;
  }

  function renderPalette() {
    const state = currentPaletteState();
    paletteActiveId = state.activeId;
    paletteEl.hidden = !paletteOpen;
    mainEl.inert = paletteOpen;
    bar.inert = paletteOpen;
    statusEl.inert = paletteOpen;

    if (!paletteOpen) {
      paletteInputEl.removeAttribute("aria-activedescendant");
      return;
    }

    if (state.activeId) {
      paletteInputEl.setAttribute("aria-activedescendant", state.activeId);
    } else {
      paletteInputEl.removeAttribute("aria-activedescendant");
    }

    if (state.filtered.length === 0) {
      const emptyLi = doc.createElement("div");
      emptyLi.className = "pal-empty";
      emptyLi.setAttribute("role", "presentation");
      emptyLi.textContent = "No matching command";
      paletteListEl.replaceChildren(emptyLi);
      paletteLiveEl.textContent = "No matching command";
      return;
    }

    paletteLiveEl.textContent = "";
    const listNodes = [];
    let lastGroup = null;
    for (const entry of state.filtered) {
      const { command, matchIndices } = entry;
      if (command.group !== lastGroup) {
        lastGroup = command.group;
        const grp = doc.createElement("div");
        grp.className = "pal-group";
        grp.setAttribute("role", "presentation");
        grp.id = `grp-${command.group.toLowerCase()}`;
        grp.textContent = command.group;
        listNodes.push(grp);
      }

      const row = doc.createElement("div");
      row.className = "pal-row";
      row.id = command.id;
      row.setAttribute("role", "option");
      row.setAttribute("aria-describedby", `grp-${command.group.toLowerCase()}`);
      row.setAttribute("aria-selected", String(command.id === state.activeId));
      if (command.disabled) {
        row.setAttribute("aria-disabled", "true");
      }

      const nameSpan = doc.createElement("span");
      nameSpan.className = "pal-name";
      if (matchIndices.length === 0) {
        nameSpan.textContent = command.name;
      } else {
        const matchSet = new Set(matchIndices);
        let buf = "";
        let inMatch = false;
        const flush = () => {
          if (!buf) return;
          if (inMatch) {
            const hl = doc.createElement("span");
            hl.className = "pal-match";
            hl.textContent = buf;
            nameSpan.appendChild(hl);
          } else {
            const plain = doc.createElement("span");
            plain.textContent = buf;
            nameSpan.appendChild(plain);
          }
          buf = "";
        };
        for (let i = 0; i < command.name.length; i += 1) {
          const matched = matchSet.has(i);
          if (matched !== inMatch) {
            flush();
            inMatch = matched;
          }
          buf += command.name[i];
        }
        flush();
      }

      const metaSpan = doc.createElement("span");
      metaSpan.className = "pal-meta";
      metaSpan.textContent = command.meta ?? "";

      const hintSpan = doc.createElement("span");
      hintSpan.className = "pal-hint";
      if (command.keyHint) {
        const kbd = doc.createElement("kbd");
        kbd.textContent = command.keyHint;
        hintSpan.appendChild(kbd);
      }

      row.appendChild(nameSpan);
      row.appendChild(metaSpan);
      row.appendChild(hintSpan);
      row.addEventListener("click", () => {
        if (!command.disabled) {
          paletteActiveId = command.id;
          void executePaletteCommand(command.id);
        }
      });
      listNodes.push(row);
    }

    paletteListEl.replaceChildren(...listNodes);
  }

  function openPalette() {
    if (paletteOpen) return;
    priorFocusEl = doc.activeElement ?? null;
    paletteOpen = true;
    paletteQuery = "";
    paletteActiveId = null;
    renderPalette();
    paletteInputEl.focus();
  }

  function closePalette(restoreFocus = true) {
    if (!paletteOpen) return;
    paletteOpen = false;
    renderPalette();
    if (restoreFocus && priorFocusEl && typeof priorFocusEl.focus === "function") {
      priorFocusEl.focus();
    }
    priorFocusEl = null;
  }

  async function executePaletteCommand(cmdId) {
    const state = currentPaletteState();
    const entry = state.filtered.find((e) => e.command.id === cmdId);
    if (!entry || entry.command.disabled) return;

    switch (cmdId) {
      case "cmd-connect":
        closePalette(true);
        void connectHandler();
        return;
      case "cmd-inspect-room":
        closePalette(true);
        await runRoomInspect();
        return;
      case "cmd-disconnect":
        closePalette(true);
        await startDisconnect("DISCONNECTED");
        return;
      case "cmd-focus-engine":
        closePalette(false);
        applyFocus(focusBarSelect(focusState, "connection"), true);
        return;
      case "cmd-focus-room":
        closePalette(false);
        applyFocus(focusBarSelect(focusState, "room"), true);
        return;
      case "cmd-focus-decisions":
        closePalette(false);
        applyFocus(focusBarSelect(focusState, "decisions"), true);
        return;
      case "cmd-focus-search":
        closePalette(false);
        applyFocus(focusBarSelect(focusState, "search"), true);
        return;
      case "cmd-copy-chain-head": {
        const hash = findBestChainHead();
        if (hash && typeof globalObj?.navigator?.clipboard?.writeText === "function") {
          void globalObj.navigator.clipboard.writeText(hash);
        }
        break;
      }
      case "cmd-copy-served-model":
        break;
    }
    closePalette(true);
  }

  paletteInputEl.addEventListener("input", (ev) => {
    paletteQuery = String(ev?.target?.value ?? paletteInputEl.value ?? "");
    const next = currentPaletteState();
    paletteActiveId = next.activeId;
    renderPalette();
  });

  const handleGlobalKeydown = (ev) => {
    const key = ev?.key;
    const isToggle =
      typeof key === "string" &&
      key.toLowerCase() === "k" &&
      (isMac ? Boolean(ev.metaKey && !ev.ctrlKey) : Boolean(ev.ctrlKey && !ev.metaKey));

    if (isToggle) {
      ev.preventDefault?.();
      if (paletteOpen) closePalette(true);
      else openPalette();
      return;
    }

    if (!paletteOpen) return;

    if (key === "Escape") {
      ev.preventDefault?.();
      closePalette(true);
      return;
    }

    if (key === "Tab") {
      ev.preventDefault?.();
      paletteInputEl.focus();
      return;
    }

    if (key === "ArrowDown" || key === "ArrowUp" || key === "Home" || key === "End") {
      ev.preventDefault?.();
      const stepped = stepPalette(currentPaletteState(), key);
      paletteActiveId = stepped.activeId;
      renderPalette();
      return;
    }

    if (key === "Enter") {
      ev.preventDefault?.();
      const state = currentPaletteState();
      if (state.activeId) {
        void executePaletteCommand(state.activeId);
      }
    }
  };

  renderConnectionChrome();
  renderReceiptsWell();

  return {
    getFocusState: () => focusState,
    getConnectionState: () => connectionState,
    connect: connectHandler,
    disconnect: () => startDisconnect("DISCONNECTED"),
    inspectRoom: runRoomInspect,
    selectThread,
    openPalette,
    closePalette,
    handleKeydown: handleGlobalKeydown,
  };
}
