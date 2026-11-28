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
const RPC_PARAMS_PREFIX = "RPC params refused by desktop shell for ";
const RPC_NOT_CONNECTED_MSG = "not connected to @madc/engine";
const RPC_SHUTTING_DOWN_MSG = "desktop shutting down";
const RPC_ENGINE_ERROR_PREFIX = "engine RPC error: ";
const UTF8_ENCODER = new TextEncoder();

export const EXPECTED_PROTOCOL_VERSION = "madc-m1/1";

export const FORWARDED_ENGINE_EVENTS = Object.freeze(
  new Set([
    "room/updated",
    "thread/started",
    "turn/started",
    "turn/completed",
    "item/completed",
    "madc/events-dropped",
  ]),
);

const TERMINAL_CLOSED_REASONS = new Set([
  "eof",
  "read-error",
  "invalid-frame",
  "oversize-frame",
  "overflow",
  "disconnect",
  "exit",
]);

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
  Object.freeze({
    id: "cmd-copy-head-open",
    group: "Evidence",
    name: "Copy head@open",
    defaultMeta: null,
    keyHint: null,
  }),
  Object.freeze({
    id: "cmd-view-panes",
    group: "Panes",
    name: "Show Panes view",
    defaultMeta: null,
    keyHint: null,
  }),
  Object.freeze({
    id: "cmd-view-table",
    group: "Panes",
    name: "Show Table view",
    defaultMeta: null,
    keyHint: null,
  }),
  Object.freeze({
    id: "cmd-pane-focus-1",
    group: "Panes",
    name: "Focus pane 1",
    defaultMeta: null,
    keyHint: "Ctrl 1",
  }),
  Object.freeze({
    id: "cmd-pane-focus-2",
    group: "Panes",
    name: "Focus pane 2",
    defaultMeta: null,
    keyHint: "Ctrl 2",
  }),
  Object.freeze({
    id: "cmd-pane-focus-3",
    group: "Panes",
    name: "Focus pane 3",
    defaultMeta: null,
    keyHint: "Ctrl 3",
  }),
  Object.freeze({
    id: "cmd-pane-focus-4",
    group: "Panes",
    name: "Focus pane 4",
    defaultMeta: null,
    keyHint: "Ctrl 4",
  }),
  Object.freeze({
    id: "cmd-pane-hide",
    group: "Panes",
    name: "Hide pane",
    defaultMeta: null,
    keyHint: null,
  }),
  Object.freeze({
    id: "cmd-pane-dismiss",
    group: "Panes",
    name: "Dismiss pane",
    defaultMeta: null,
    keyHint: null,
  }),
  Object.freeze({
    id: "cmd-turn-start",
    group: "Turn",
    name: "Start turn",
    defaultMeta: null,
    keyHint: "Ctrl Enter",
  }),
]);

const PILL_GLYPHS = Object.freeze({
  verified: "✓",
  neutral: "○",
  warn: "▲",
  fail: "✗",
});

export const ALLOWED_PILL_LABELS = Object.freeze({
  verified: new Set(["VERIFIED"]),
  neutral: new Set([
    "NO RECEIPT",
    "IDLE",
    "CONNECTING",
    "CONNECTED",
    "DISCONNECTED",
    "RUNNING",
    "COMPLETED",
  ]),
  warn: new Set(["UNVERIFIED", "STOPPED"]),
  fail: new Set(["FAILED", "INTERRUPTED"]),
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

  if (message.startsWith(RPC_PARAMS_PREFIX)) {
    return { kind: "params", message };
  }

  if (message === RPC_SHUTTING_DOWN_MSG) {
    return { kind: "shutting-down", message };
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

/**
 * Pure event-acceptance gate per amendment 2 §4.2.
 * `madc/transport-closed` is NEVER decided here (always handled by `acceptTerminal`).
 */
export function acceptEngineEvent(state, ev) {
  if (ev === null || typeof ev !== "object" || Array.isArray(ev)) {
    return { outcome: "drop", streamGap: false, nextSeq: state?.lastAcceptedSeq ?? null };
  }
  const boundEpoch = state?.boundEpoch ?? null;
  const epochOk =
    typeof ev.epoch === "number" &&
    Number.isInteger(ev.epoch) &&
    boundEpoch !== null &&
    ev.epoch === boundEpoch;

  if (!epochOk || ev.method === "madc/transport-closed") {
    return { outcome: "drop", streamGap: false, nextSeq: state?.lastAcceptedSeq ?? null };
  }

  const seq = ev.seq;
  const seqOk = typeof seq === "number" && Number.isInteger(seq) && seq >= 1;
  const lastSeq = state?.lastAcceptedSeq ?? null;
  const connectedOk = state?.connectionState === "CONNECTED" && !state?.disconnectPending;
  const methodOk = typeof ev.method === "string" && FORWARDED_ENGINE_EVENTS.has(ev.method);

  if (seqOk && lastSeq !== null && seq <= lastSeq) {
    return { outcome: "drop", streamGap: true, nextSeq: lastSeq };
  }

  if (!connectedOk || !methodOk || !seqOk) {
    return { outcome: "drop", streamGap: false, nextSeq: lastSeq };
  }

  const gap = (lastSeq !== null && seq > lastSeq + 1) || ev.method === "madc/events-dropped";
  return { outcome: "accept", streamGap: gap, nextSeq: seq };
}

/**
 * Pure terminal-event state machine per amendment 2 §4.3.
 */
export function acceptTerminal(state, ev) {
  const evEpoch = ev?.epoch;
  if (typeof evEpoch !== "number" || !Number.isInteger(evEpoch) || evEpoch < 1) {
    return {
      action: "ignore",
      nextState: state,
      settleQuit: false,
      markEnded: false,
      nextConnectionState: state.connectionState,
      startDisconnect: false,
    };
  }
  const rawReason = ev?.params?.reason ?? ev?.reason;
  const reason =
    typeof rawReason === "string" && TERMINAL_CLOSED_REASONS.has(rawReason)
      ? rawReason
      : "read-error";

  // Rule 1: At most once per epoch.
  if (evEpoch <= (state.terminalHandled ?? 0)) {
    return {
      action: "ignore",
      nextState: state,
      settleQuit: false,
      markEnded: false,
      nextConnectionState: state.connectionState,
      startDisconnect: false,
    };
  }

  // Rule 2: CONNECTING handoff — latch highest non-stale terminal without binding early.
  if (state.connectionState === "CONNECTING") {
    if (state.boundEpoch === null || evEpoch >= state.boundEpoch) {
      const existing = state.pendingTerminal ?? null;
      const pendingTerminal =
        existing !== null && existing.epoch > evEpoch ? existing : { epoch: evEpoch, reason };
      return {
        action: "pending-connecting",
        nextState: { ...state, pendingTerminal },
        settleQuit: false,
        markEnded: false,
        nextConnectionState: "CONNECTING",
        startDisconnect: false,
      };
    }
    return {
      action: "ignore",
      nextState: state,
      settleQuit: false,
      markEnded: false,
      nextConnectionState: state.connectionState,
      startDisconnect: false,
    };
  }

  // Rule 3: ev.epoch === boundEpoch and reason === "exit" -> exit path (no FAILED, no disconnect).
  if (state.boundEpoch !== null && evEpoch === state.boundEpoch && reason === "exit") {
    return {
      action: "exit",
      nextState: { ...state, terminalHandled: evEpoch },
      settleQuit: true,
      markEnded: true,
      nextConnectionState: state.connectionState,
      startDisconnect: false,
    };
  }

  // Rule 4: CONNECTED, ev.epoch === boundEpoch, disconnectPending === null -> FAILED + single disconnect_engine.
  if (
    state.connectionState === "CONNECTED" &&
    state.boundEpoch !== null &&
    evEpoch === state.boundEpoch &&
    !state.disconnectPending
  ) {
    return {
      action: "fail",
      nextState: { ...state, connectionState: "FAILED", terminalHandled: evEpoch },
      settleQuit: true,
      markEnded: true,
      nextConnectionState: "FAILED",
      startDisconnect: true,
    };
  }

  // Rule 5: CONNECTED, ev.epoch === boundEpoch, disconnectPending !== null -> user disconnect in flight.
  if (
    state.connectionState === "CONNECTED" &&
    state.boundEpoch !== null &&
    evEpoch === state.boundEpoch &&
    state.disconnectPending
  ) {
    return {
      action: "disconnecting",
      nextState: { ...state, terminalHandled: evEpoch },
      settleQuit: true,
      markEnded: true,
      nextConnectionState: state.connectionState,
      startDisconnect: false,
    };
  }

  // Rule 6: DISCONNECTED / FAILED after boundEpoch, or older epoch.
  if (state.boundEpoch !== null && evEpoch === state.boundEpoch) {
    return {
      action: "mark-handled",
      nextState: { ...state, terminalHandled: evEpoch },
      settleQuit: true,
      markEnded: false,
      nextConnectionState: state.connectionState,
      startDisconnect: false,
    };
  }

  return {
    action: "ignore",
    nextState: state,
    settleQuit: false,
    markEnded: false,
    nextConnectionState: state.connectionState,
    startDisconnect: false,
  };
}

/**
 * Pure connect resolution helper for `acceptTerminal` Rule 2 (`Ok(N)`).
 */
export function resolveConnectTerminal(state, resolvedEpoch) {
  const term = state?.pendingTerminal ?? null;
  if (typeof resolvedEpoch === "number" && term !== null && term.epoch === resolvedEpoch) {
    const isExit = term.reason === "exit";
    return {
      matched: true,
      reason: term.reason,
      nextState: {
        ...state,
        boundEpoch: resolvedEpoch,
        terminalHandled: resolvedEpoch,
        pendingTerminal: null,
        connectionState: isExit ? state.connectionState : "FAILED",
      },
      markEnded: true,
      settleQuit: true,
      startDisconnect: !isExit,
    };
  }
  return {
    matched: false,
    reason: null,
    nextState: {
      ...state,
      boundEpoch: typeof resolvedEpoch === "number" ? resolvedEpoch : (state.boundEpoch ?? null),
      pendingTerminal: null,
      connectionState: "CONNECTED",
    },
    markEnded: false,
    settleQuit: false,
    startDisconnect: false,
  };
}

/**
 * Pure quit-request decision rule per amendment 2 §6.1 L12.
 */
export function acceptQuitRequest(state, payload) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { action: "ignore", nextRecord: state?.quitRecord ?? null };
  }
  const { epoch, requestId } = payload;
  if (
    typeof epoch !== "number" ||
    !Number.isInteger(epoch) ||
    typeof requestId !== "number" ||
    !Number.isInteger(requestId) ||
    requestId < 1
  ) {
    return { action: "ignore", nextRecord: state?.quitRecord ?? null };
  }
  if (
    state?.boundEpoch === null ||
    state?.boundEpoch === undefined ||
    epoch !== state.boundEpoch ||
    state?.connectionState !== "CONNECTED"
  ) {
    return { action: "ignore", nextRecord: state?.quitRecord ?? null };
  }

  const rec = state?.quitRecord ?? null;
  if (rec === null || requestId > rec.requestId) {
    return {
      action: "candidate-open",
      nextRecord: { requestId, status: "candidate" },
    };
  }
  if (rec.status === "shown" && requestId === rec.requestId) {
    return { action: "refocus", nextRecord: rec };
  }
  return { action: "ignore", nextRecord: rec };
}

/**
 * Pure local POSIX cwd validator per addendum §6A.5 (no trim, UTF-8 byte cap 4096).
 */
export function cwdCheck(text) {
  const raw = String(text ?? "");
  if (raw === "") {
    return { ok: true, reason: "optional · Enter starts without a cwd (worktree —)" };
  }
  if (raw.includes("\u0000")) {
    return { ok: false, reason: "contains a NUL character" };
  }
  if (UTF8_ENCODER.encode(raw).length > 4096) {
    return { ok: false, reason: "longer than 4096 bytes" };
  }
  if (raw.startsWith("~")) {
    return { ok: false, reason: "~ is not expanded · type the full path" };
  }
  if (!raw.startsWith("/")) {
    return { ok: false, reason: "not absolute · must start with /" };
  }
  return { ok: true, reason: "syntax ok · engine not asked · Enter starts" };
}

/**
 * Pure cwd field status mapper per addendum §6A.4.
 * Returns ONLY { neutral, fail } and NEVER { verified, warn }.
 */
export function cwdFieldState(text, phase, refuseInfo = null) {
  if (phase === "started") {
    return { word: "STARTED", glyph: "○", tone: "neutral", reason: null };
  }
  if (phase === "starting") {
    return {
      word: "STARTING",
      glyph: "○",
      tone: "neutral",
      reason: "field locked until thread/start returns",
    };
  }
  if (phase === "refused") {
    return {
      word: "REFUSED",
      glyph: "✗",
      tone: "fail",
      reason: refuseInfo?.message ? String(refuseInfo.message) : "thread/start refused",
    };
  }
  const raw = String(text ?? "");
  if (raw === "") {
    return {
      word: "NO CWD",
      glyph: "○",
      tone: "neutral",
      reason: "optional · Enter starts without a cwd (worktree —)",
    };
  }
  const check = cwdCheck(raw);
  if (!check.ok) {
    return {
      word: "REJECTED",
      glyph: "✗",
      tone: "fail",
      reason: `${check.reason} · nothing sent`,
    };
  }
  return {
    word: "UNCHECKED",
    glyph: "○",
    tone: "neutral",
    reason: check.reason,
  };
}

export function paneColumns(width) {
  return Number(width) >= 1440 ? 4 : 2;
}

export function isWidePaneWidth(paneWidth) {
  return Number(paneWidth) >= 520;
}

/**
 * Turn-state pills NEVER carry a receipt and NEVER turn green (A4 pin §4.1, spec §6.1).
 */
export function turnPillForPane(pane) {
  switch (pane?.state) {
    case "running":
    case "interrupt-pending":
      return { tone: evidenceTone(null, "neutral"), label: "RUNNING" };
    case "completed":
      return { tone: evidenceTone(null, "neutral"), label: "COMPLETED" };
    case "interrupted":
      return { tone: evidenceTone(null, "fail"), label: "INTERRUPTED" };
    case "failed":
      return { tone: evidenceTone(null, "fail"), label: "FAILED" };
    case "history":
      return { tone: evidenceTone(null, "neutral"), label: "DISCONNECTED" };
    default:
      return { tone: evidenceTone(null, "neutral"), label: "IDLE" };
  }
}

function methodErrorDataChips(err) {
  const chips = [{ key: "code", value: String(err.code) }];
  if (err.data && typeof err.data === "object" && !Array.isArray(err.data)) {
    for (const [k, v] of Object.entries(err.data)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) {
        chips.push({ key: k, value: v.map((item) => sanitizeEngineText(item)).join("; ") });
      } else if (typeof v === "object" && v !== null) {
        chips.push({ key: k, value: sanitizeEngineText(JSON.stringify(v)) });
      } else {
        chips.push({ key: k, value: sanitizeEngineText(String(v)) });
      }
    }
  }
  return chips;
}

/**
 * Derive the ordered §6.2/§6.4 pane receipt rows strictly from engine/read-back evidence.
 */
export function receiptRowsForPane(pane, readEntry = null, roomRow = null) {
  const rows = [];
  const isHistory = pane?.state === "history";
  const effectiveRead = isHistory ? null : readEntry;
  const effectiveRoomRow = isHistory ? null : roomRow;
  const streamed = isHistory ? null : (pane?.streamedServedModel ?? null);

  // 1. Method-error rows (turn/start, turn/interrupt, turn.end failure only; never thread/start).
  if (!isHistory && pane?.methodError) {
    const err = pane.methodError;
    const chips = methodErrorDataChips(err);
    const providerId = err.data?.providerId ? String(err.data.providerId) : "";
    const status = err.data?.status ? String(err.data.status) : "";
    const accessibleMeta = [providerId, status].filter(Boolean).join(" · ");
    rows.push({
      kind: "method-error",
      label: String(err.method),
      isField: false,
      tone: evidenceTone(null, "fail"),
      pillLabel: "FAILED",
      chips,
      note: sanitizeEngineText(err.rpcMessage ?? ""),
      title: accessibleMeta || null,
      accessibleName: accessibleMeta ? `${err.method} FAILED ${accessibleMeta}` : null,
    });
  }
  if (!isHistory && pane?.state === "failed" && pane?.turnError) {
    rows.push({
      kind: "method-error",
      label: "turn.end",
      isField: false,
      tone: evidenceTone(null, "fail"),
      pillLabel: "FAILED",
      chips: [{ key: "code", value: String(pane.turnError.code) }],
      note: sanitizeEngineText(pane.turnError.message ?? ""),
      title: null,
      accessibleName: null,
    });
  }

  // Locate seq-0 open worktree + latest turn servedModel from session/read events.
  const events =
    effectiveRead?.ok === true && Array.isArray(effectiveRead.result?.events)
      ? effectiveRead.result.events
      : [];
  const openEvent = events.find((e) => e?.type === "session.open") ?? null;
  const targetTurnId = pane?.turnId ?? pane?.completedTurnId ?? null;
  let readServed = null;
  if (targetTurnId !== null) {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const ev = events[i];
      if (ev?.type === "servedModel" && ev.payload && typeof ev.payload === "object") {
        if (ev.payload.turnId === targetTurnId) {
          readServed = ev.payload;
          break;
        }
      }
    }
  }

  // 2. servedModel row (A4 §4.3 exact condition order).
  if (effectiveRead?.ok === false) {
    rows.push({
      kind: "servedModel",
      label: "servedModel",
      isField: false,
      tone: evidenceTone(null, "fail"),
      pillLabel: "FAILED",
      chips: [{ key: "servedModel", value: "—", muted: true }],
      note: effectiveRead.note ?? "session/read failed",
    });
  } else if (effectiveRead?.ok === true) {
    const chainOk = effectiveRead.result?.chainOk === true;
    if (!chainOk) {
      rows.push({
        kind: "servedModel",
        label: "servedModel",
        isField: false,
        tone: evidenceTone(null, "fail"),
        pillLabel: "FAILED",
        chips: [{ key: "servedModel", value: "—", muted: true }],
        note: streamed ? "live value not confirmed by chain" : "chain not confirmed",
      });
    } else if (!readServed) {
      if (streamed) {
        rows.push({
          kind: "servedModel",
          label: "servedModel",
          isField: false,
          tone: evidenceTone(null, "fail"),
          pillLabel: "FAILED",
          chips: [
            { key: "servedModel", value: sanitizeEngineText(streamed.servedModel ?? "") },
            { key: "vendorReported", value: String(Boolean(streamed.vendorReported)) },
          ],
          note: "live value not confirmed by chain",
        });
      } else {
        rows.push({
          kind: "servedModel",
          label: "servedModel",
          isField: false,
          tone: evidenceTone(null, "neutral"),
          pillLabel: "NO RECEIPT",
          chips: [{ key: "servedModel", value: "—", muted: true }],
          note: null,
        });
      }
    } else {
      const sm = String(readServed.servedModel ?? "");
      const vr = readServed.vendorReported === true;
      const fb = readServed.fallbackFrom ?? null;
      const streamMismatch =
        streamed !== null &&
        (String(streamed.servedModel ?? "") !== sm || Boolean(streamed.vendorReported) !== vr);

      const chips = [
        { key: "servedModel", value: sanitizeEngineText(sm) },
        { key: "vendorReported", value: String(vr) },
      ];
      if (fb !== null && fb !== undefined) {
        chips.push({ key: "fallbackFrom", value: sanitizeEngineText(String(fb)) });
      }

      if (streamMismatch) {
        rows.push({
          kind: "servedModel",
          label: "servedModel",
          isField: false,
          tone: evidenceTone(null, "fail"),
          pillLabel: "FAILED",
          chips,
          note: "live value differs from chain",
        });
      } else if (vr && sm.trim().length > 0) {
        const tone = evidenceTone(
          { kind: "servedModel", servedModel: sm, vendorReported: true },
          "ok",
        );
        rows.push({
          kind: "servedModel",
          label: "servedModel",
          isField: false,
          tone,
          pillLabel: "VERIFIED",
          chips,
          note: null,
        });
      } else {
        const tone = evidenceTone(
          { kind: "servedModel", servedModel: sm, vendorReported: vr },
          "warn",
        );
        rows.push({
          kind: "servedModel",
          label: "servedModel",
          isField: false,
          tone,
          pillLabel: "UNVERIFIED",
          chips,
          note: sm.trim().length === 0 ? "servedModel empty" : null,
        });
      }
    }
  } else if (streamed) {
    const sm = String(streamed.servedModel ?? "");
    const vr = Boolean(streamed.vendorReported);
    rows.push({
      kind: "servedModel",
      label: "servedModel",
      isField: false,
      tone: evidenceTone(null, "warn"),
      pillLabel: "UNVERIFIED",
      chips: [
        { key: "servedModel", value: sanitizeEngineText(sm) },
        { key: "vendorReported", value: String(vr) },
      ],
      note: "streamed · confirmed by session/read after turn/completed",
    });
  } else {
    rows.push({
      kind: "servedModel",
      label: "servedModel",
      isField: false,
      tone: evidenceTone(null, "neutral"),
      pillLabel: "NO RECEIPT",
      chips: [{ key: "servedModel", value: "—", muted: true }],
      note: null,
    });
  }

  // 3. lane row (field, never toned, note `field · not a receipt`, D-719).
  const laneValue = readServed?.lane ?? streamed?.lane ?? null;
  rows.push({
    kind: "lane",
    label: "lane",
    isField: true,
    tone: "neutral",
    pillLabel: null,
    chips: [
      laneValue
        ? { key: "lane", value: sanitizeEngineText(String(laneValue)) }
        : { key: "lane", value: "—", muted: true },
    ],
    note: "field · not a receipt",
  });

  // 4 & 5. worktree.topLevel (field) and head@open (sha receipt, NO chainOk requirement, D-720).
  const worktreeOpen = openEvent?.payload?.worktree ?? effectiveRoomRow?.worktree?.open ?? null;
  const hasAnyRead =
    !isHistory &&
    (Boolean(pane?.hasReadYet) || effectiveRead?.ok === true || effectiveRoomRow !== null);
  const topLevel =
    worktreeOpen && typeof worktreeOpen.topLevel === "string" && worktreeOpen.topLevel.length > 0
      ? worktreeOpen.topLevel
      : null;

  rows.push({
    kind: "worktree.topLevel",
    label: "worktree.topLevel",
    isField: true,
    tone: "neutral",
    pillLabel: null,
    chips: [
      topLevel !== null
        ? {
            key: "topLevel",
            value: sanitizeEngineText(topLevel),
            title: sanitizeEngineText(topLevel),
            bdi: true,
          }
        : { key: "topLevel", value: "—", muted: true },
    ],
    note:
      topLevel !== null
        ? "field · not a receipt"
        : !hasAnyRead
          ? "field · not a receipt · not read yet"
          : "field · not a receipt · no git work tree recorded",
  });

  const headSha =
    worktreeOpen && typeof worktreeOpen.head === "string" && GIT_SHA_HEX.test(worktreeOpen.head)
      ? worktreeOpen.head
      : null;
  const headMissing = effectiveRoomRow?.worktree?.missing === true;
  if (headSha !== null) {
    const tone = evidenceTone({ kind: "sha", sha: headSha }, "ok");
    rows.push({
      kind: "head@open",
      label: "head@open",
      isField: false,
      tone,
      pillLabel: tone === "verified" ? "VERIFIED" : "NO RECEIPT",
      chips: [{ key: "sha", value: headSha.slice(0, 12), title: headSha }],
      note: headMissing ? "worktree missing on disk" : null,
    });
  } else {
    rows.push({
      kind: "head@open",
      label: "head@open",
      isField: false,
      tone: evidenceTone(null, "neutral"),
      pillLabel: "NO RECEIPT",
      chips: [{ key: "sha", value: "—", muted: true }],
      note: !hasAnyRead ? "not read yet" : null,
    });
  }

  // 6. hash row (reset on turn/started until turn/completed read returns).
  if (
    !isHistory &&
    pane?.hashMovedOnTurnStart &&
    (pane.state === "running" || pane.state === "interrupt-pending")
  ) {
    rows.push({
      kind: "hash",
      label: "hash",
      isField: false,
      tone: evidenceTone(null, "neutral"),
      pillLabel: "NO RECEIPT",
      chips: [
        { key: "hash", value: "—", muted: true },
        { key: "events", value: "—", muted: true },
      ],
      note: "chain head moved · read after turn/completed",
    });
  } else if (effectiveRead?.ok === false) {
    rows.push({
      kind: "hash",
      label: "hash",
      isField: false,
      tone: evidenceTone(null, "fail"),
      pillLabel: "FAILED",
      chips: [
        { key: "hash", value: "—", muted: true },
        { key: "events", value: "—", muted: true },
      ],
      note: effectiveRead.note ?? "session/read failed",
    });
  } else if (effectiveRead?.ok === true) {
    const chainOk = effectiveRead.result?.chainOk === true;
    const lastEv = events.length > 0 ? events[events.length - 1] : null;
    const tailHash = typeof lastEv?.hash === "string" ? lastEv.hash : "";
    const evCount = String(events.length);
    if (!chainOk) {
      rows.push({
        kind: "hash",
        label: "hash",
        isField: false,
        tone: evidenceTone(null, "fail"),
        pillLabel: "FAILED",
        chips: [
          { key: "chainOk", value: "false" },
          { key: "events", value: "—", muted: true },
        ],
        note: "session/read chainOk false",
      });
    } else if (SHA256_HEX.test(tailHash)) {
      const tone = evidenceTone({ kind: "hash", chainOk: true, hash: tailHash }, "ok");
      rows.push({
        kind: "hash",
        label: "hash",
        isField: false,
        tone,
        pillLabel: tone === "verified" ? "VERIFIED" : "NO RECEIPT",
        chips: [
          { key: "hash", value: tailHash.slice(0, 12), title: tailHash },
          { key: "chainOk", value: "true" },
          { key: "events", value: evCount },
        ],
        note: null,
      });
    } else {
      rows.push({
        kind: "hash",
        label: "hash",
        isField: false,
        tone: evidenceTone(null, "neutral"),
        pillLabel: "NO RECEIPT",
        chips: [
          { key: "hash", value: "—", muted: true },
          { key: "events", value: evCount },
        ],
        note: null,
      });
    }
  } else {
    rows.push({
      kind: "hash",
      label: "hash",
      isField: false,
      tone: evidenceTone(null, "neutral"),
      pillLabel: "NO RECEIPT",
      chips: [
        { key: "hash", value: "—", muted: true },
        { key: "events", value: "—", muted: true },
      ],
      note: null,
    });
  }

  return rows;
}

/**
 * Pure composer target mapper per spec §7.2 / pin §5.4 (exact verbatim disabled reasons).
 */
export function composerTargets(panes, selectedSet, boundEpoch, connectionState) {
  return panes.map((pane) => {
    let disabledReason = null;
    let title = null;
    if (pane.state === "draft" || pane.state === "start-failed" || pane.unloaded32002) {
      disabledReason = "no thread loaded";
    } else if (pane.state === "starting-thread") {
      disabledReason = "starting thread";
    } else if (
      connectionState !== "CONNECTED" ||
      pane.state === "history" ||
      (boundEpoch !== null && pane.boundEpoch !== boundEpoch)
    ) {
      disabledReason = "not connected";
    } else if (pane.state === "starting-turn") {
      disabledReason = "starting turn";
    } else if (pane.state === "running" || pane.state === "interrupt-pending") {
      disabledReason = "turn active";
    } else if (pane.state === "refused") {
      disabledReason = "refused -32007";
      title = pane.refused32007?.reason ?? null;
    }
    const enabled = disabledReason === null;
    return {
      paneId: pane.paneId,
      seatId: pane.seatId,
      selected: enabled && selectedSet.has(pane.paneId),
      enabled,
      disabledReason,
      title,
    };
  });
}

function validatePillInput(tone, label) {
  const allowed = ALLOWED_PILL_LABELS[tone];
  if (!allowed?.has(label)) {
    throw new Error(`invalid pill label "${label}" for tone "${tone}"`);
  }
}

export function renderPill(doc, input) {
  const { tone, label, context, ariaLabel, small = false, role = "status" } = input;
  validatePillInput(tone, label);
  const el = doc.createElement("span");
  el.className = small ? "pill pill--sm" : "pill";
  el.setAttribute("data-tone", tone);
  el.setAttribute("role", role);
  el.setAttribute("aria-label", ariaLabel ?? (context ? `${tone}, ${context}` : tone));

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
  const { tone, label, context, ariaLabel, small = false, role = "status" } = input;
  validatePillInput(tone, label);
  el.className = small ? "pill pill--sm" : "pill";
  el.setAttribute("data-tone", tone);
  el.setAttribute("role", role);
  el.setAttribute("aria-label", ariaLabel ?? (context ? `${tone}, ${context}` : tone));

  const glyphEl = doc.createElement("span");
  glyphEl.className = "pill-glyph";
  glyphEl.setAttribute("aria-hidden", "true");
  glyphEl.textContent = PILL_GLYPHS[tone];

  const labelEl = doc.createElement("span");
  labelEl.className = "pill-label";
  labelEl.textContent = label;

  el.replaceChildren(glyphEl, labelEl);
}

function renderChip(doc, key, value, title = null, mutedValue = false, useBdi = false) {
  const chip = doc.createElement("span");
  chip.className = "chip";

  const k = doc.createElement("span");
  k.className = "chip-k";
  k.textContent = key;

  const v = doc.createElement("span");
  v.className = useBdi ? "chip-v chip-v--rtl" : mutedValue ? "chip-v chip-v--muted" : "chip-v";
  if (useBdi) {
    const bdi = doc.createElement("bdi");
    bdi.textContent = value;
    v.appendChild(bdi);
  } else {
    v.textContent = value;
  }
  if (title) {
    v.setAttribute("title", title);
    chip.setAttribute("aria-label", `${key} ${title}`);
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
  const optionalEl = (id) => {
    try {
      return doc.getElementById(id);
    } catch {
      return null;
    }
  };
  const roomStaleNoteEl = optionalEl("room-stale-note");
  const quitDialogEl = optionalEl("quit-dialog");
  const quitTitleEl = optionalEl("quit-dialog-title");
  const quitListEl = optionalEl("quit-dialog-list");
  const quitKeepBtnEl = optionalEl("quit-keep-btn");
  const quitConfirmBtnEl = optionalEl("quit-confirm-btn");
  const viewToggleEl = optionalEl("view-toggle");
  const viewPanesBtnEl = optionalEl("view-panes-btn");
  const viewTableBtnEl = optionalEl("view-table-btn");
  const tableViewEl = optionalEl("table-view");
  const colRightEl = optionalEl("col-right");
  const panesWorkspaceEl = optionalEl("panes-workspace");
  const panesGridEl = optionalEl("panes-grid");
  const hiddenStripEl = optionalEl("hidden-strip");
  const composerTargetsEl = optionalEl("composer-targets");
  const composerInputEl = optionalEl("composer-input");
  const composerStartBtnEl = optionalEl("composer-start-btn");
  const liveRegionEl = optionalEl("live-region");
  const cwdInputEls = new Map();
  const paneRegionEls = new Map();

  const currentViewportWidth = () =>
    typeof env.viewportWidth === "number"
      ? env.viewportWidth
      : typeof globalObj?.innerWidth === "number"
        ? globalObj.innerWidth
        : 1200;

  const announceLive = (msg) => {
    if (liveRegionEl) {
      liveRegionEl.textContent = sanitizeEngineText(msg);
    }
  };

  paletteKeycapEl.textContent = isMac ? "⌘K" : "Ctrl K";

  let connectionState = "IDLE";
  let epoch = 0;
  let inspectGeneration = 0;
  let connectPending = null;
  let disconnectPending = null;
  let lastConnectionInfo = null;
  let boundEpoch = null;
  let terminalHandled = 0;
  let pendingTerminal = null;
  let lastAcceptedSeq = null;
  let streamGap = false;
  let exitStartedSeen = false;
  let tableStale = false;
  let quitRecord = null;
  let quitDialogOpen = false;
  let quitPriorFocusEl = null;
  let seatSummaries = [];
  let seatsLoading = false;
  let nextPaneSeq = 0;
  const panes = [];
  let focusedPaneId = null;
  const selectedTargets = new Set();
  let viewMode = "table";
  let lastSentCwd = "";
  let currentRoom = null;
  let selectedThreadId = null;
  let roomInspectErrorNote = null;
  const sessionReadCache = new Map();
  const tableRefusalReceipts = [];
  const unavailableSeats = new Set();
  const inFlightReads = new Set();
  const pendingFollowUpReads = new Set();
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

  function recordTableRefusal(method, seatId, cls) {
    if (cls?.kind !== "rpc") return;
    const chips = methodErrorDataChips(cls);
    chips.push({ key: "seat", value: sanitizeEngineText(seatId) });
    tableRefusalReceipts.push({
      label: method,
      tone: evidenceTone(null, "fail"),
      pillLabel: "FAILED",
      context: `${method} code ${cls.code}`,
      chips,
      note: cls.rpcMessage ? sanitizeEngineText(cls.rpcMessage) : null,
    });
    renderReceiptsWell();
  }

  function renderReceiptsWell() {
    const allItems = [...sessionReceipts, ...tableRefusalReceipts];
    const nodes = allItems.map((item) => {
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

  function findFocusedPaneEvidence() {
    const focused = panes.find((p) => p.paneId === focusedPaneId) ?? null;
    if (!focused?.threadId) return { hash: null, servedModel: null, headOpen: null };
    const readEntry = sessionReadCache.get(focused.threadId) ?? null;
    const rows = receiptRowsForPane(focused, readEntry, null);
    let hash = null;
    let servedModel = null;
    let headOpen = null;
    for (const r of rows) {
      if (r.kind === "hash" && r.tone === "verified") {
        hash = r.chips.find((c) => c.key === "hash")?.title ?? null;
      }
      if (r.kind === "servedModel" && r.tone === "verified") {
        servedModel = r.chips.find((c) => c.key === "servedModel")?.value ?? null;
      }
      if (r.kind === "head@open" && r.tone === "verified") {
        headOpen = r.chips.find((c) => c.key === "sha")?.title ?? null;
      }
    }
    return { hash, servedModel, headOpen };
  }

  function findBestChainHead() {
    const paneEv = findFocusedPaneEvidence();
    if (paneEv.hash !== null) return paneEv.hash;

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

  function renderWorkspace() {
    const activeView = viewMode === "panes" ? "panes" : "table";
    mainEl.setAttribute("data-view", activeView);
    if (tableViewEl) tableViewEl.hidden = activeView !== "table";
    if (colRightEl) colRightEl.hidden = activeView !== "table";
    if (panesWorkspaceEl) panesWorkspaceEl.hidden = activeView !== "panes";

    if (viewPanesBtnEl && viewTableBtnEl) {
      viewPanesBtnEl.setAttribute("aria-checked", String(activeView === "panes"));
      viewPanesBtnEl.tabIndex = activeView === "panes" ? 0 : -1;
      viewTableBtnEl.setAttribute("aria-checked", String(activeView === "table"));
      viewTableBtnEl.tabIndex = activeView === "table" ? 0 : -1;
    }

    const vpWidth = currentViewportWidth();
    const maxCols = paneColumns(vpWidth);
    const visiblePanes = panes.filter((p) => p.visible);
    const hiddenPanes = panes.filter((p) => !p.visible);

    if (hiddenStripEl) {
      hiddenStripEl.hidden = activeView !== "panes" || hiddenPanes.length === 0;
      if (activeView === "panes" && hiddenPanes.length > 0) {
        if (vpWidth >= 1440) {
          const tabs = hiddenPanes.map((hp) => {
            const tab = doc.createElement("button");
            tab.className = "hidden-tab";
            tab.setAttribute("type", "button");
            const seatEl = doc.createElement("span");
            seatEl.textContent = sanitizeEngineText(hp.seatId);
            const tp = turnPillForPane(hp);
            const pill = renderPill(doc, {
              tone: tp.tone,
              label: tp.label,
              small: true,
              ariaLabel: `turn ${tp.label}`,
            });
            tab.appendChild(seatEl);
            tab.appendChild(pill);
            tab.addEventListener("click", () => {
              showPane(hp.paneId);
            });
            return tab;
          });
          hiddenStripEl.replaceChildren(...tabs);
        } else {
          const summaryBtn = doc.createElement("button");
          summaryBtn.className = "hidden-summary";
          summaryBtn.setAttribute("type", "button");
          const countEl = doc.createElement("span");
          countEl.className = "hidden-summary-count";
          countEl.textContent = `${hiddenPanes.length} hidden`;
          const namesEl = doc.createElement("span");
          namesEl.className = "hidden-summary-names";
          namesEl.textContent = hiddenPanes.map((hp) => sanitizeEngineText(hp.seatId)).join(" · ");
          summaryBtn.appendChild(countEl);
          summaryBtn.appendChild(namesEl);
          summaryBtn.addEventListener("click", () => {
            paletteQuery = "Show pane";
            openPalette();
          });
          hiddenStripEl.replaceChildren(summaryBtn);
        }
      } else {
        hiddenStripEl.replaceChildren();
      }
    }

    if (panesGridEl) {
      const colCount = Math.max(1, Math.min(maxCols, visiblePanes.length || 1));
      const paneWidth = (vpWidth - 56 - Math.max(0, colCount - 1) * 14) / colCount;
      const isWide = isWidePaneWidth(paneWidth);
      panesGridEl.setAttribute("data-cols", String(maxCols));

      const paneNodes = visiblePanes.map((pane, idx) => {
        const card = doc.createElement("section");
        card.className = "pane";
        card.tabIndex = -1;
        card.setAttribute("role", "region");
        card.setAttribute(
          "aria-label",
          `${sanitizeEngineText(pane.seatId)} pane, ${pane.threadId ?? "no thread yet"}`,
        );
        card.setAttribute("data-pane-id", pane.paneId);
        card.setAttribute("data-focused", String(focusedPaneId === pane.paneId));
        paneRegionEls.set(pane.paneId, card);

        // 1. Header
        const header = doc.createElement("div");
        header.className = "pane-header";

        const topRow = doc.createElement("div");
        topRow.className = "pane-header-top";

        const identity = doc.createElement("div");
        identity.className = "pane-identity";

        const titleRow = doc.createElement("div");
        titleRow.className = "pane-title-row";
        const posEl = doc.createElement("span");
        posEl.className = "pane-pos";
        posEl.textContent = String(idx + 1);
        const seatEl = doc.createElement("span");
        seatEl.className = "pane-seat";
        seatEl.textContent = sanitizeEngineText(pane.seatId);
        titleRow.appendChild(posEl);
        titleRow.appendChild(seatEl);

        const threadLine = doc.createElement("div");
        threadLine.className = "pane-thread-line";
        if (pane.state === "starting-thread") {
          threadLine.textContent = "thread/start · pending";
        } else if (pane.threadId) {
          threadLine.textContent = pane.turnId
            ? `${pane.threadId} · ${pane.turnId}`
            : pane.threadId;
        } else {
          threadLine.textContent = "no thread yet";
        }

        identity.appendChild(titleRow);
        identity.appendChild(threadLine);

        const tp = turnPillForPane(pane);
        const turnPill = renderPill(doc, {
          tone: tp.tone,
          label: tp.label,
          ariaLabel: `turn ${tp.label}`,
        });

        topRow.appendChild(identity);
        topRow.appendChild(turnPill);
        header.appendChild(topRow);

        // Header cwd block (§6A)
        const cwdBlock = doc.createElement("div");
        cwdBlock.className = "cwd";
        const isStartedOrHistory =
          pane.state !== "draft" &&
          pane.state !== "starting-thread" &&
          pane.state !== "start-failed";

        if (isStartedOrHistory) {
          cwdInputEls.delete(pane.paneId);
          const startedRow = doc.createElement("div");
          startedRow.className = "cwd-started";
          const keyEl = doc.createElement("span");
          keyEl.className = "cwd-key";
          keyEl.textContent = "cwd";
          const valEl = doc.createElement("span");
          const hasCwdVal = typeof pane.threadCwd === "string" && pane.threadCwd.length > 0;
          valEl.className = hasCwdVal ? "cwd-val-ro" : "cwd-val-ro cwd-val-ro--muted";
          const bdi = doc.createElement("bdi");
          bdi.textContent = hasCwdVal ? sanitizeEngineText(pane.threadCwd) : "—";
          valEl.appendChild(bdi);
          if (hasCwdVal) {
            const safeCwd = sanitizeEngineText(pane.threadCwd);
            valEl.setAttribute("title", safeCwd);
            valEl.setAttribute("aria-label", `cwd ${safeCwd}`);
          } else {
            valEl.setAttribute("aria-label", "cwd none");
          }
          const st = cwdFieldState("", "started");
          const fstEl = doc.createElement("span");
          fstEl.className = "fst";
          fstEl.setAttribute("data-tone", st.tone);
          const gEl = doc.createElement("span");
          gEl.className = "g";
          gEl.setAttribute("aria-hidden", "true");
          gEl.textContent = st.glyph;
          const wEl = doc.createElement("span");
          wEl.textContent = st.word;
          fstEl.appendChild(gEl);
          fstEl.appendChild(wEl);

          startedRow.appendChild(keyEl);
          startedRow.appendChild(valEl);
          startedRow.appendChild(fstEl);
          cwdBlock.appendChild(startedRow);

          if (pane.cwdSent !== null && pane.threadCwd !== null && pane.threadCwd !== pane.cwdSent) {
            const noteLine = doc.createElement("div");
            noteLine.className = "cwd-reason";
            noteLine.textContent = `engine path · typed ${sanitizeEngineText(pane.cwdSent)}`;
            cwdBlock.appendChild(noteLine);
          }
        } else {
          const phase =
            pane.state === "starting-thread"
              ? "starting"
              : pane.state === "start-failed"
                ? "refused"
                : "draft";
          const st = cwdFieldState(pane.cwdText, phase, pane.cwdRefusal);

          const row1 = doc.createElement("div");
          row1.className = "cwd-row";
          const labelEl = doc.createElement("label");
          labelEl.className = "cwd-key";
          const inputId = `cwd-in-${pane.paneId}`;
          const reasonId = `cwd-reason-${pane.paneId}`;
          labelEl.setAttribute("for", inputId);
          labelEl.textContent = "cwd";

          const inWrap = doc.createElement("div");
          inWrap.className = "cwd-in-wrap";
          const inputEl = doc.createElement("input");
          inputEl.id = inputId;
          inputEl.className = "cwd-in";
          inputEl.setAttribute("type", "text");
          inputEl.setAttribute("placeholder", "/absolute/path · optional");
          inputEl.setAttribute("aria-describedby", reasonId);
          if (st.tone === "fail") {
            inputEl.setAttribute("aria-invalid", "true");
            inputEl.setAttribute("data-cwd-fail", "true");
          }
          if (phase === "starting") {
            inputEl.readOnly = true;
            inputEl.setAttribute("aria-readonly", "true");
          }
          inputEl.value = pane.cwdText;
          if (pane.cwdText.length > 0) {
            inputEl.setAttribute("title", sanitizeEngineText(pane.cwdText));
          }
          cwdInputEls.set(pane.paneId, inputEl);

          const row2 = doc.createElement("div");
          row2.className = "cwd-row2";
          const fstEl = doc.createElement("span");
          fstEl.className = "fst";
          fstEl.setAttribute("data-tone", st.tone);
          const gEl = doc.createElement("span");
          gEl.className = "g";
          gEl.setAttribute("aria-hidden", "true");
          gEl.textContent = st.glyph;
          const wEl = doc.createElement("span");
          wEl.textContent = st.word;
          fstEl.appendChild(gEl);
          fstEl.appendChild(wEl);

          const startBtn = doc.createElement("button");
          startBtn.className = "btn-sm";
          startBtn.setAttribute("type", "button");
          startBtn.textContent = "START THREAD";
          startBtn.disabled =
            st.word === "REJECTED" || phase === "starting" || connectionState !== "CONNECTED";
          startBtn.addEventListener("click", () => {
            void startThread(pane.paneId);
          });

          row2.appendChild(fstEl);
          row2.appendChild(startBtn);

          const reasonEl = doc.createElement("div");
          reasonEl.id = reasonId;
          reasonEl.className = "cwd-reason";
          const effectiveReason = pane.cwdLostConnection
            ? "connection ended before thread/start returned"
            : (st.reason ?? "");
          reasonEl.textContent = sanitizeEngineText(effectiveReason);

          inputEl.addEventListener("input", (ev) => {
            const nextVal = String(ev?.target?.value ?? inputEl.value ?? "");
            setPaneCwdText(pane.paneId, nextVal);
            const nextSt = cwdFieldState(nextVal, "draft", null);
            fstEl.setAttribute("data-tone", nextSt.tone);
            gEl.textContent = nextSt.glyph;
            wEl.textContent = nextSt.word;
            reasonEl.textContent = sanitizeEngineText(nextSt.reason ?? "");
            startBtn.disabled = nextSt.word === "REJECTED" || connectionState !== "CONNECTED";
            if (nextSt.tone === "fail") {
              inputEl.setAttribute("aria-invalid", "true");
              inputEl.setAttribute("data-cwd-fail", "true");
            } else {
              inputEl.removeAttribute("aria-invalid");
              inputEl.removeAttribute("data-cwd-fail");
            }
          });

          inputEl.addEventListener("keydown", (ev) => {
            if (ev?.isComposing) return;
            const k = ev?.key;
            if (k === "Enter") {
              if (ev.metaKey || ev.ctrlKey || ev.altKey || ev.shiftKey) {
                return; // C6: Cmd/Ctrl+Enter does nothing in cwd field
              }
              ev.preventDefault?.();
              const curCheck = cwdCheck(pane.cwdText);
              if (!curCheck.ok) {
                announceLive(`${pane.seatId}: cwd REJECTED ${curCheck.reason}`);
                return;
              }
              void startThread(pane.paneId);
              return;
            }
            if (k === "Escape") {
              ev.preventDefault?.();
              ev.stopPropagation?.();
              if (pane.cwdText !== pane.cwdBaseline) {
                pane.cwdText = pane.cwdBaseline;
                pane.cwdRefusal = null;
                pane.cwdLostConnection = false;
                if (pane.state === "start-failed") pane.state = "draft";
                inputEl.value = pane.cwdText;
                const reverted = cwdFieldState(pane.cwdText, "draft", null);
                fstEl.setAttribute("data-tone", reverted.tone);
                gEl.textContent = reverted.glyph;
                wEl.textContent = reverted.word;
                reasonEl.textContent = sanitizeEngineText(reverted.reason ?? "");
                startBtn.disabled = reverted.word === "REJECTED" || connectionState !== "CONNECTED";
              } else {
                card.focus();
              }
            }
          });

          inWrap.appendChild(inputEl);
          row1.appendChild(labelEl);
          row1.appendChild(inWrap);
          cwdBlock.appendChild(row1);
          cwdBlock.appendChild(row2);
          if (pane.cwdRefusal?.kind === "rpc") {
            const chipsRow = doc.createElement("div");
            chipsRow.className = "cwd-chips";
            chipsRow.appendChild(renderChip(doc, "code", String(pane.cwdRefusal.code)));
            if (
              pane.cwdRefusal.data &&
              typeof pane.cwdRefusal.data === "object" &&
              !Array.isArray(pane.cwdRefusal.data)
            ) {
              for (const [dk, dv] of Object.entries(pane.cwdRefusal.data)) {
                if (dk === "issues" || dv === undefined || typeof dv === "object") continue;
                chipsRow.appendChild(renderChip(doc, dk, sanitizeEngineText(String(dv))));
              }
            }
            cwdBlock.appendChild(chipsRow);
            if (Array.isArray(pane.cwdRefusal.issues) && pane.cwdRefusal.issues.length > 0) {
              const ul = doc.createElement("ul");
              ul.className = "cwd-issues";
              for (const issue of pane.cwdRefusal.issues) {
                const li = doc.createElement("li");
                li.textContent = sanitizeEngineText(issue);
                ul.appendChild(li);
              }
              cwdBlock.appendChild(ul);
            }
          } else {
            cwdBlock.appendChild(reasonEl);
          }
        }
        header.appendChild(cwdBlock);
        card.appendChild(header);

        // 2. Starting banner
        if (pane.state === "starting-thread") {
          const banner = doc.createElement("div");
          banner.className = "pane-banner";
          banner.textContent =
            "Starting thread. thread/start pending. No turn can start until it returns.";
          card.appendChild(banner);
        }

        // 3. Receipts well
        const well = doc.createElement("div");
        well.className = "pane-receipts";
        if (
          pane.state === "draft" ||
          pane.state === "starting-thread" ||
          pane.state === "start-failed"
        ) {
          const noteEl = doc.createElement("div");
          noteEl.className = "pane-no-thread";
          noteEl.textContent = "No thread yet. Receipts appear after thread/start returns.";
          well.appendChild(noteEl);
        } else {
          const readEntry = pane.threadId ? (sessionReadCache.get(pane.threadId) ?? null) : null;
          const roomRow =
            pane.threadId && Array.isArray(currentRoom?.threads)
              ? (currentRoom.threads.find((t) => t.threadId === pane.threadId) ?? null)
              : null;
          const rRows = receiptRowsForPane(pane, readEntry, roomRow);
          for (const rr of rRows) {
            const rowEl = doc.createElement("div");
            rowEl.className = isWide
              ? "pane-receipt-row pane-receipt-row--wide"
              : "pane-receipt-row";
            if (rr.title) rowEl.setAttribute("title", sanitizeEngineText(rr.title));
            if (rr.accessibleName)
              rowEl.setAttribute("aria-label", sanitizeEngineText(rr.accessibleName));

            const kEl = doc.createElement("span");
            kEl.className = "pane-receipt-key";
            kEl.textContent = rr.label;
            rowEl.appendChild(kEl);

            if (rr.isField) {
              const fnEl = doc.createElement("span");
              fnEl.className = "pane-field-note";
              fnEl.textContent = rr.note ?? "field · not a receipt";
              rowEl.appendChild(fnEl);
            } else if (rr.pillLabel) {
              rowEl.appendChild(
                renderPill(doc, {
                  tone: rr.tone,
                  label: rr.pillLabel,
                  context: rr.note ?? rr.label,
                  role: rr.tone === "fail" ? "alert" : "status",
                }),
              );
            }

            const cEl = doc.createElement("span");
            cEl.className = "receipt-chips";
            for (const ch of rr.chips) {
              cEl.appendChild(
                renderChip(
                  doc,
                  ch.key,
                  ch.value,
                  ch.title ?? null,
                  ch.muted ?? false,
                  ch.bdi ?? false,
                ),
              );
            }
            if (!rr.isField && rr.note) {
              const nEl = doc.createElement("span");
              nEl.className = "row-note";
              nEl.textContent = sanitizeEngineText(rr.note);
              cEl.appendChild(nEl);
            }
            rowEl.appendChild(cEl);
            well.appendChild(rowEl);
          }
        }
        card.appendChild(well);

        // 4. Footer
        const footer = doc.createElement("div");
        footer.className = "pane-footer";
        const reasonSpan = doc.createElement("span");
        reasonSpan.className = "pane-footer-reason";
        reasonSpan.textContent = sanitizeEngineText(pane.footerReason ?? "");
        footer.appendChild(reasonSpan);

        const actionBtn = doc.createElement("button");
        actionBtn.className = "btn-sm";
        actionBtn.setAttribute("type", "button");
        if (
          pane.state === "draft" ||
          pane.state === "starting-thread" ||
          pane.state === "start-failed"
        ) {
          actionBtn.textContent = "DISMISS PANE";
          actionBtn.disabled = pane.state === "starting-thread";
          actionBtn.addEventListener("click", () => {
            dismissPane(pane.paneId);
          });
        } else {
          actionBtn.textContent = "INTERRUPT TURN";
          actionBtn.disabled =
            connectionState !== "CONNECTED" ||
            disconnectPending !== null ||
            pane.boundEpoch !== (boundEpoch ?? epoch) ||
            pane.state !== "running" ||
            pane.turnPendingInterrupt;
          actionBtn.addEventListener("click", () => {
            void interruptTurn(pane.paneId);
          });
        }
        footer.appendChild(actionBtn);
        card.appendChild(footer);
        return card;
      });

      panesGridEl.replaceChildren(...paneNodes);
    }

    if (composerTargetsEl && composerStartBtnEl) {
      const targetSpecs = composerTargets(panes, selectedTargets, boundEpoch, connectionState);
      const chipNodes = targetSpecs.map((t) => {
        const btn = doc.createElement("button");
        btn.className = "composer-target";
        btn.setAttribute("type", "button");
        btn.setAttribute("aria-pressed", String(t.selected));
        if (!t.enabled) {
          btn.setAttribute("aria-disabled", "true");
          btn.disabled = true;
        }
        if (t.title) {
          btn.setAttribute("title", sanitizeEngineText(t.title));
        }
        const gEl = doc.createElement("span");
        gEl.className = "composer-target-glyph";
        gEl.setAttribute("aria-hidden", "true");
        gEl.textContent = t.selected ? "■" : "□";
        const labelEl = doc.createElement("span");
        labelEl.textContent = t.disabledReason
          ? `${sanitizeEngineText(t.seatId)} · ${t.disabledReason}`
          : sanitizeEngineText(t.seatId);
        btn.appendChild(gEl);
        btn.appendChild(labelEl);
        btn.addEventListener("click", () => {
          toggleComposerTarget(t.paneId);
        });
        btn.addEventListener("keydown", (ev) => {
          if (ev?.key === " ") {
            ev.preventDefault?.();
            toggleComposerTarget(t.paneId);
          }
        });
        return btn;
      });
      composerTargetsEl.replaceChildren(...chipNodes);

      const selectedCount = targetSpecs.filter((t) => t.selected).length;
      const inputHasText = String(composerInputEl?.value ?? "").trim().length > 0;
      composerStartBtnEl.textContent = `START TURN · ${selectedCount} seat(s)`;
      composerStartBtnEl.disabled =
        connectionState !== "CONNECTED" ||
        disconnectPending !== null ||
        selectedCount === 0 ||
        !inputHasText;
    }
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

  function paneSnapshot(pane) {
    return {
      paneId: pane.paneId,
      seatId: pane.seatId,
      boundEpoch: pane.boundEpoch,
      state: pane.state,
      threadId: pane.threadId,
      turnId: pane.turnId,
      startedAt: pane.startedAt,
      cwdText: pane.cwdText,
      cwdBaseline: pane.cwdBaseline,
      cwdSent: pane.cwdSent,
      threadCwd: pane.threadCwd,
      visible: pane.visible,
      hasReadYet: pane.hasReadYet,
      footerReason: pane.footerReason,
    };
  }

  function closeQuitDialogUi(restoreFocus = true) {
    if (!quitDialogOpen) return;
    quitDialogOpen = false;
    if (quitDialogEl) quitDialogEl.hidden = true;
    bar.inert = false;
    mainEl.inert = false;
    statusEl.inert = false;
    if (restoreFocus && quitPriorFocusEl && typeof quitPriorFocusEl.focus === "function") {
      quitPriorFocusEl.focus();
    }
    quitPriorFocusEl = null;
  }

  function openQuitDialogUi() {
    if (!quitDialogOpen) {
      quitPriorFocusEl = doc.activeElement ?? null;
    }
    quitDialogOpen = true;
    if (quitDialogEl) quitDialogEl.hidden = false;
    const turns = getQuitTurnsInternal();
    if (quitTitleEl) {
      quitTitleEl.textContent = `Quit MADC Desktop with ${turns.length} turn(s) running?`;
    }
    if (quitConfirmBtnEl) {
      quitConfirmBtnEl.textContent = `QUIT AND INTERRUPT ${turns.length} TURN(S)`;
    }
    if (quitListEl) {
      const rows = turns.map((p) => {
        const row = doc.createElement("div");
        row.className = "quit-row";
        const seatEl = doc.createElement("span");
        seatEl.textContent = p.visible ? p.seatId : `${p.seatId} (hidden)`;
        const metaEl = doc.createElement("span");
        metaEl.textContent = `${p.threadId ?? "—"} · ${p.turnId ?? "pending"}`;
        row.appendChild(seatEl);
        row.appendChild(metaEl);
        return row;
      });
      quitListEl.replaceChildren(...rows);
    }
    bar.inert = true;
    mainEl.inert = true;
    statusEl.inert = true;
    quitKeepBtnEl?.focus?.();
  }

  function settleQuitState() {
    if (quitRecord !== null) {
      quitRecord = { requestId: quitRecord.requestId, status: "settled" };
    }
    closeQuitDialogUi(false);
  }

  function markEpochEndedOnPanes() {
    pendingFollowUpReads.clear();
    seatSummaries = [];
    unavailableSeats.clear();
    for (const pane of panes) {
      if (pane.state === "starting-thread") {
        pane.state = "draft";
        pane.cwdLostConnection = true;
        pane.footerReason = "no thread loaded";
        selectedTargets.delete(pane.paneId);
      } else if (pane.state === "draft" || pane.state === "start-failed") {
        // Holds no thread; keep draft/refused text and stay editable.
        selectedTargets.delete(pane.paneId);
      } else {
        // Started pane becomes History (spec §6.3, A4 §6.1).
        pane.state = "history";
        pane.footerReason = "connection ended · history only";
        pane.turnPendingInterrupt = false;
        pane.streamedServedModel = null;
        if (pane.threadId) {
          sessionReadCache.delete(pane.threadId);
        }
        selectedTargets.delete(pane.paneId);
      }
    }
    renderWorkspace();
  }

  function startDisconnect(targetStateAfterResolve) {
    if (disconnectPending !== null) {
      return disconnectPending;
    }
    epoch += 1;
    markEpochEndedOnPanes();
    settleQuitState();

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

  function applyTerminalResult(ev) {
    const decision = acceptTerminal(
      {
        connectionState,
        disconnectPending: disconnectPending !== null,
        boundEpoch,
        terminalHandled,
        pendingTerminal,
      },
      ev,
    );
    terminalHandled = decision.nextState.terminalHandled;
    pendingTerminal = decision.nextState.pendingTerminal;
    if (decision.action === "ignore" || decision.action === "pending-connecting") {
      return decision;
    }
    if (decision.action === "exit") {
      exitStartedSeen = true;
    }
    if (decision.settleQuit) {
      settleQuitState();
    }
    if (decision.markEnded) {
      markEpochEndedOnPanes();
    }
    if (decision.action === "fail") {
      connectionState = "FAILED";
      const reason = ev?.params?.reason ?? ev?.reason ?? "transport-closed";
      outputEl.textContent = sanitizeEngineText(`engine connection closed: ${reason}`);
      renderConnectionChrome();
      if (decision.startDisconnect) {
        void startDisconnect("FAILED");
      }
    } else if (decision.action === "exit") {
      renderConnectionChrome();
    }
    if (paletteOpen) renderPalette();
    return decision;
  }

  function applySynthesizedExitTerminal(reqEpoch) {
    exitStartedSeen = true;
    const ep = typeof reqEpoch === "number" && reqEpoch >= 1 ? reqEpoch : boundEpoch;
    if (ep !== null) {
      applyTerminalResult({
        epoch: ep,
        method: "madc/transport-closed",
        params: { reason: "exit" },
      });
    } else {
      settleQuitState();
      markEpochEndedOnPanes();
    }
  }

  async function runRoomInspect() {
    if (connectionState !== "CONNECTED" || disconnectPending !== null) return;
    const reqEpoch = epoch;
    const reqBoundEpoch = boundEpoch;
    try {
      const roomRes = await invokeFn("rpc_request", { method: "room/inspect", params: {} });
      if (reqEpoch !== epoch || disconnectPending !== null || connectionState !== "CONNECTED") {
        return;
      }
      inspectGeneration += 1;
      sessionReadCache.clear();
      inFlightReads.clear();
      tableStale = false;
      if (roomStaleNoteEl) {
        roomStaleNoteEl.hidden = true;
        roomStaleNoteEl.textContent = "";
      }
      roomInspectErrorNote = null;
      currentRoom = roomRes?.room ?? { counts: { threads: 0, openDecisions: 0 }, threads: [] };
      outputEl.textContent = sanitizeEngineText(
        JSON.stringify({ connection: lastConnectionInfo, room: roomRes }, null, 2),
      );
      renderRoomTable();
      renderWorkspace();
      if (paletteOpen) renderPalette();
    } catch (err) {
      if (reqEpoch !== epoch) {
        return;
      }
      const cls = classifyRpcError(err);
      if (cls.kind === "shutting-down") {
        applySynthesizedExitTerminal(reqBoundEpoch);
        return;
      }
      outputEl.textContent = sanitizeEngineText(cls.message);
      inspectGeneration += 1;
      sessionReadCache.clear();
      inFlightReads.clear();

      if (cls.kind === "rpc" || cls.kind === "params" || cls.kind === "allowlist") {
        roomInspectErrorNote =
          cls.kind === "rpc" ? `room/inspect: ${cls.code} ${cls.rpcMessage}` : cls.message;
        renderRoomTable();
        return;
      }
      if (cls.kind === "not-connected") {
        roomInspectErrorNote = cls.message;
        renderRoomTable();
        if (reqEpoch === epoch && disconnectPending === null) {
          lastConnectionInfo = null;
          connectionState = "DISCONNECTED";
          markEpochEndedOnPanes();
          settleQuitState();
          renderConnectionChrome();
        }
        return;
      }

      // R4: transport loss, timeout, or unparseable RPC error
      if (exitStartedSeen || (reqBoundEpoch !== null && reqBoundEpoch <= terminalHandled)) {
        return;
      }
      roomInspectErrorNote = cls.message;
      renderRoomTable();
      if (reqEpoch === epoch && disconnectPending === null) {
        connectionState = "FAILED";
        renderConnectionChrome();
        await startDisconnect("FAILED");
      }
    }
  }

  async function triggerSessionRead(threadId, trigger = "selection") {
    if (connectionState !== "CONNECTED" || disconnectPending !== null) {
      return;
    }
    if (inFlightReads.has(threadId)) {
      if (trigger === "turn-completed") {
        const pane = panes.find(
          (p) => p.threadId === threadId && p.boundEpoch === (boundEpoch ?? epoch),
        );
        if (pane) {
          if (pane.visible) {
            pendingFollowUpReads.add(threadId);
          } else {
            pane.needsTurnRead = true;
          }
        }
      }
      return;
    }

    inFlightReads.add(threadId);
    const reqEpoch = epoch;
    const reqBoundEpoch = boundEpoch;
    const reqGen = inspectGeneration;

    try {
      const res = await invokeFn("rpc_request", {
        method: "session/read",
        params: { threadId },
      });
      if (
        reqEpoch !== epoch ||
        (trigger === "selection" && reqGen !== inspectGeneration) ||
        connectionState !== "CONNECTED"
      ) {
        return;
      }
      sessionReadCache.delete(threadId);
      sessionReadCache.set(threadId, { ok: true, result: res });
      for (const pane of panes) {
        if (pane.threadId === threadId && pane.boundEpoch === (boundEpoch ?? epoch)) {
          pane.hasReadYet = true;
          pane.needsTurnRead = false;
        }
      }
      renderRoomTable();
      renderWorkspace();
      if (paletteOpen) renderPalette();
    } catch (err) {
      if (reqEpoch !== epoch || (trigger === "selection" && reqGen !== inspectGeneration)) {
        return;
      }
      const cls = classifyRpcError(err);
      if (cls.kind === "shutting-down") {
        applySynthesizedExitTerminal(reqBoundEpoch);
        return;
      }
      outputEl.textContent = sanitizeEngineText(cls.message);
      const note = cls.kind === "rpc" ? `session/read: ${cls.code} ${cls.rpcMessage}` : cls.message;
      sessionReadCache.set(threadId, { ok: false, note });
      renderRoomTable();

      if (cls.kind === "not-connected") {
        if (disconnectPending === null) {
          lastConnectionInfo = null;
          connectionState = "DISCONNECTED";
          markEpochEndedOnPanes();
          settleQuitState();
          renderConnectionChrome();
        }
      } else if (cls.kind === "transport") {
        if (
          disconnectPending === null &&
          !exitStartedSeen &&
          !(reqBoundEpoch !== null && reqBoundEpoch <= terminalHandled)
        ) {
          connectionState = "FAILED";
          renderConnectionChrome();
          await startDisconnect("FAILED");
        }
      }
      if (paletteOpen) renderPalette();
    } finally {
      inFlightReads.delete(threadId);
      if (pendingFollowUpReads.has(threadId)) {
        pendingFollowUpReads.delete(threadId);
        const epochAlive =
          reqEpoch === epoch &&
          (reqBoundEpoch === null ||
            (reqBoundEpoch === boundEpoch && terminalHandled < reqBoundEpoch)) &&
          connectionState === "CONNECTED" &&
          disconnectPending === null &&
          !exitStartedSeen;
        const paneForFollowUp = panes.find(
          (p) =>
            p.threadId === threadId &&
            p.boundEpoch === (boundEpoch ?? epoch) &&
            p.state !== "draft" &&
            p.state !== "starting-thread" &&
            p.state !== "start-failed" &&
            p.state !== "history",
        );
        if (epochAlive && paneForFollowUp) {
          if (paneForFollowUp.visible) {
            void triggerSessionRead(threadId, "turn-completed");
          } else {
            paneForFollowUp.needsTurnRead = true;
          }
        }
      }
    }
  }

  async function selectThread(threadId) {
    if (connectionState !== "CONNECTED" || disconnectPending !== null) {
      return;
    }
    selectedThreadId = threadId;
    renderRoomTable();
    await triggerSessionRead(threadId, "selection");
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
    pendingTerminal = null;
    renderConnectionChrome();
    if (paletteOpen) renderPalette();

    connectPending = (async () => {
      try {
        const info = await invokeFn("connect_engine");
        epoch += 1;
        if (info?.protocolVersion !== EXPECTED_PROTOCOL_VERSION) {
          lastConnectionInfo = info ?? null;
          if (typeof info?.connectionEpoch === "number") {
            boundEpoch = info.connectionEpoch;
          }
          pendingTerminal = null;
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

        const resolvedEpoch =
          typeof info?.connectionEpoch === "number" ? info.connectionEpoch : null;
        const handoff = resolveConnectTerminal(
          {
            connectionState,
            disconnectPending: false,
            boundEpoch,
            terminalHandled,
            pendingTerminal,
          },
          resolvedEpoch,
        );
        boundEpoch = handoff.nextState.boundEpoch;
        terminalHandled = handoff.nextState.terminalHandled;
        pendingTerminal = null;

        if (handoff.matched) {
          lastConnectionInfo = info;
          settleQuitState();
          markEpochEndedOnPanes();
          if (handoff.reason === "exit") {
            exitStartedSeen = true;
            renderConnectionChrome();
            return;
          }
          connectionState = "FAILED";
          outputEl.textContent = sanitizeEngineText(
            `engine connection closed: ${handoff.reason ?? "transport-closed"}`,
          );
          renderConnectionChrome();
          await startDisconnect("FAILED");
          return;
        }

        lastConnectionInfo = info;
        lastAcceptedSeq = null;
        streamGap = false;
        quitRecord = null;
        connectionState = "CONNECTED";
        for (const pane of panes) {
          if (
            pane.state === "draft" ||
            pane.state === "start-failed" ||
            pane.state === "starting-thread"
          ) {
            pane.boundEpoch = boundEpoch ?? epoch;
          }
        }
        renderConnectionChrome();
        await runRoomInspect();
      } catch (err) {
        pendingTerminal = null;
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
    const paneEv = findFocusedPaneEvidence();
    const activeEpoch = boundEpoch ?? epoch;
    const visiblePanes = panes.filter((p) => p.visible);
    const hiddenPanes = panes.filter((p) => !p.visible);
    const focusedPane = panes.find((p) => p.paneId === focusedPaneId) ?? null;
    const targetSpecs = composerTargets(panes, selectedTargets, boundEpoch, connectionState);
    const inputTextPresent = String(composerInputEl?.value ?? "").trim().length > 0;
    const selectedEnabledCount = targetSpecs.filter((t) => t.selected && t.enabled).length;

    const base = PALETTE_COMMANDS.map((cmd) => {
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
        return {
          ...cmd,
          disabled: paneEv.servedModel === null,
          meta: paneEv.servedModel !== null ? paneEv.servedModel : "no servedModel receipt",
        };
      }
      if (cmd.id === "cmd-copy-head-open") {
        if (!hasClipboard) {
          return { ...cmd, disabled: true, meta: "clipboard unavailable" };
        }
        return {
          ...cmd,
          disabled: paneEv.headOpen === null,
          meta: paneEv.headOpen !== null ? paneEv.headOpen.slice(0, 12) : "no head@open receipt",
        };
      }
      if (cmd.id === "cmd-view-panes") {
        return {
          ...cmd,
          disabled: viewMode === "panes",
          meta: viewMode === "panes" ? "active" : null,
        };
      }
      if (cmd.id === "cmd-view-table") {
        return {
          ...cmd,
          disabled: viewMode === "table",
          meta: viewMode === "table" ? "active" : null,
        };
      }
      if (
        cmd.id === "cmd-pane-focus-1" ||
        cmd.id === "cmd-pane-focus-2" ||
        cmd.id === "cmd-pane-focus-3" ||
        cmd.id === "cmd-pane-focus-4"
      ) {
        const slotIdx = Number(cmd.id.slice(-1)) - 1;
        const slotPane = visiblePanes[slotIdx] ?? null;
        return {
          ...cmd,
          disabled: slotPane === null,
          keyHint: `${isMac ? "⌘" : "Ctrl "}${slotIdx + 1}`,
          meta: slotPane ? sanitizeEngineText(slotPane.seatId) : "empty slot",
        };
      }
      if (cmd.id === "cmd-pane-hide") {
        const canHide = Boolean(focusedPane?.visible) && panes.length > 1;
        return {
          ...cmd,
          name: focusedPane ? `Hide pane ${sanitizeEngineText(focusedPane.seatId)}` : "Hide pane",
          disabled: !canHide,
          meta: canHide ? null : "cannot hide",
        };
      }
      if (cmd.id === "cmd-pane-dismiss") {
        const canDismiss =
          focusedPane !== null &&
          (focusedPane.state === "draft" || focusedPane.state === "start-failed");
        return {
          ...cmd,
          name: focusedPane
            ? `Dismiss pane ${sanitizeEngineText(focusedPane.seatId)}`
            : "Dismiss pane",
          disabled: !canDismiss,
          meta: canDismiss ? null : "holds thread or none",
        };
      }
      if (cmd.id === "cmd-turn-start") {
        const canStart = isConnected && inputTextPresent && selectedEnabledCount > 0;
        return {
          ...cmd,
          disabled: !canStart,
          keyHint: isMac ? "⌘↵" : "Ctrl ↵",
          meta: isConnected
            ? selectedEnabledCount > 0
              ? `${selectedEnabledCount} target(s)`
              : "no target"
            : "not connected",
        };
      }
      return { ...cmd, disabled: false, meta: cmd.defaultMeta };
    });

    const dynamic = [];
    for (const seat of seatSummaries) {
      const seatId = String(seat.id);
      const seatOk = seat.ok === true && !unavailableSeats.has(seatId);
      const enabled = isConnected && seatOk;
      dynamic.push({
        id: `cmd-pane-new:${seatId}`,
        group: "Panes",
        name: `New pane on seat ${sanitizeEngineText(seatId)}`,
        defaultMeta: null,
        keyHint: null,
        disabled: !enabled,
        meta: !isConnected
          ? "not connected"
          : seat.ok !== true
            ? `seat load failed ${seat.code ?? ""}`.trim()
            : unavailableSeats.has(seatId)
              ? "seat unavailable"
              : null,
      });
    }
    for (const hp of hiddenPanes) {
      dynamic.push({
        id: `cmd-pane-show:${hp.paneId}`,
        group: "Panes",
        name: `Show pane ${sanitizeEngineText(hp.seatId)}`,
        defaultMeta: null,
        keyHint: null,
        disabled: false,
        meta: null,
      });
    }
    for (const p of panes) {
      if (p.boundEpoch === activeEpoch && p.state === "running" && !p.turnPendingInterrupt) {
        dynamic.push({
          id: `cmd-turn-interrupt:${p.paneId}`,
          group: "Turn",
          name: `Interrupt turn on ${sanitizeEngineText(p.seatId)}`,
          defaultMeta: null,
          keyHint: null,
          disabled: !isConnected,
          meta: isConnected ? p.turnId : "not connected",
        });
      }
    }
    for (const ts of targetSpecs) {
      dynamic.push({
        id: `cmd-target-toggle:${ts.paneId}`,
        group: "Turn",
        name: `Toggle target ${sanitizeEngineText(ts.seatId)}`,
        defaultMeta: null,
        keyHint: null,
        disabled: !ts.enabled,
        meta: ts.disabledReason ?? (ts.selected ? "selected" : "unselected"),
      });
    }

    return [...base, ...dynamic];
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

  function getQuitTurnsInternal() {
    const activeEpoch = boundEpoch ?? epoch;
    return panes.filter(
      (p) =>
        p.boundEpoch === activeEpoch &&
        (p.state === "starting-turn" || p.state === "running" || p.state === "interrupt-pending"),
    );
  }

  async function loadSeats() {
    if (connectionState !== "CONNECTED" || disconnectPending !== null || seatsLoading) {
      return seatSummaries;
    }
    seatsLoading = true;
    const reqEpoch = epoch;
    const reqBoundEpoch = boundEpoch;
    try {
      const res = await invokeFn("rpc_request", { method: "seat/list", params: {} });
      if (reqEpoch !== epoch || connectionState !== "CONNECTED") return seatSummaries;
      if (Array.isArray(res?.data)) {
        seatSummaries = res.data;
        if (paletteOpen) renderPalette();
      }
      return seatSummaries;
    } catch (err) {
      if (reqEpoch !== epoch) return seatSummaries;
      const cls = classifyRpcError(err);
      if (cls.kind === "shutting-down") {
        applySynthesizedExitTerminal(reqBoundEpoch);
      } else if (
        cls.kind === "transport" &&
        disconnectPending === null &&
        !exitStartedSeen &&
        !(reqBoundEpoch !== null && reqBoundEpoch <= terminalHandled)
      ) {
        connectionState = "FAILED";
        renderConnectionChrome();
        await startDisconnect("FAILED");
      }
      return seatSummaries;
    } finally {
      seatsLoading = false;
    }
  }

  function createDraftPane(seatId) {
    nextPaneSeq += 1;
    const activeEpoch = boundEpoch ?? epoch;
    const visibleCount = panes.filter((p) => p.visible).length;
    const pane = {
      paneId: `pane_${nextPaneSeq}`,
      seatId: String(seatId),
      boundEpoch: activeEpoch,
      state: "draft",
      threadId: null,
      turnId: null,
      startedAt: null,
      cwdText: lastSentCwd,
      cwdBaseline: lastSentCwd,
      cwdSent: null,
      threadCwd: null,
      cwdRefusal: null,
      cwdLostConnection: false,
      seatUnavailable: false,
      visible: true,
      streamedServedModel: null,
      methodError: null,
      turnError: null,
      interruptError: null,
      refused32007: null,
      needsTurnRead: false,
      hasReadYet: false,
      hashMovedOnTurnStart: false,
      turnPendingInterrupt: false,
      lastCompletedTurnState: null,
      completedTurnId: null,
      footerReason: "no thread loaded",
    };
    const maxCols = paneColumns(currentViewportWidth());
    if (visibleCount >= maxCols) {
      const visiblePanes = panes.filter((p) => p.visible);
      const rightmost = visiblePanes[visiblePanes.length - 1];
      if (rightmost) rightmost.visible = false;
    }
    panes.push(pane);
    focusedPaneId = pane.paneId;
    renderWorkspace();
    return paneSnapshot(pane);
  }

  function setPaneCwdText(paneId, text) {
    const pane = panes.find((p) => p.paneId === paneId);
    if (!pane) return;
    if (pane.state !== "draft" && pane.state !== "start-failed") return;
    pane.cwdText = String(text ?? "");
    pane.cwdRefusal = null;
    pane.cwdLostConnection = false;
    if (pane.state === "start-failed") {
      pane.state = "draft";
    }
  }

  async function startThread(paneId) {
    const pane = panes.find((p) => p.paneId === paneId);
    if (!pane) return;
    if (connectionState !== "CONNECTED" || disconnectPending !== null) return;
    if (pane.state !== "draft" && pane.state !== "start-failed") return;

    const check = cwdCheck(pane.cwdText);
    if (!check.ok) {
      pane.state = "draft";
      return;
    }

    const reqEpoch = epoch;
    const reqBoundEpoch = boundEpoch;
    const exactCwd = pane.cwdText;
    const params =
      exactCwd === "" ? { seatId: pane.seatId } : { seatId: pane.seatId, cwd: exactCwd };
    if (exactCwd !== "") {
      lastSentCwd = exactCwd;
    }
    pane.cwdBaseline = exactCwd;
    pane.cwdSent = exactCwd === "" ? null : exactCwd;
    pane.cwdRefusal = null;
    pane.cwdLostConnection = false;
    pane.state = "starting-thread";
    pane.footerReason = "thread/start pending";
    renderWorkspace();

    try {
      const res = await invokeFn("rpc_request", { method: "thread/start", params });
      if (
        reqEpoch !== epoch ||
        (reqBoundEpoch !== null && reqBoundEpoch !== boundEpoch) ||
        connectionState !== "CONNECTED"
      ) {
        if (pane.state === "starting-thread") {
          pane.state = "draft";
          pane.cwdLostConnection = true;
          pane.footerReason = "no thread loaded";
        }
        renderWorkspace();
        return;
      }
      const thread = res?.thread;
      if (!thread || typeof thread.id !== "string") return;
      pane.state = "idle";
      pane.threadId = thread.id;
      pane.seatId = typeof thread.seatId === "string" ? thread.seatId : pane.seatId;
      pane.threadCwd = thread.cwd ?? null;
      pane.boundEpoch = boundEpoch ?? epoch;
      pane.hasReadYet = false;
      pane.cwdRefusal = null;
      pane.footerReason = null;
      if (focusedPaneId === pane.paneId) {
        selectedTargets.add(pane.paneId);
      }
      announceLive(`${pane.seatId}: cwd STARTED ${thread.id}`);
      renderWorkspace();
      void triggerSessionRead(thread.id, "post-start");
    } catch (err) {
      if (reqEpoch !== epoch || (reqBoundEpoch !== null && reqBoundEpoch !== boundEpoch)) {
        if (pane.state === "starting-thread") {
          pane.state = "draft";
          pane.cwdLostConnection = true;
          pane.footerReason = "no thread loaded";
        }
        renderWorkspace();
        return;
      }
      const cls = classifyRpcError(err);
      if (cls.kind === "shutting-down") {
        applySynthesizedExitTerminal(reqBoundEpoch);
        return;
      }
      outputEl.textContent = sanitizeEngineText(cls.message);
      if (cls.kind === "not-connected") {
        pane.state = "draft";
        pane.cwdLostConnection = true;
        pane.footerReason = "no thread loaded";
        if (disconnectPending === null) {
          lastConnectionInfo = null;
          connectionState = "DISCONNECTED";
          markEpochEndedOnPanes();
          settleQuitState();
          renderConnectionChrome();
        }
        renderWorkspace();
        return;
      }
      if (cls.kind === "transport") {
        pane.state = "draft";
        pane.cwdLostConnection = true;
        pane.footerReason = "no thread loaded";
        if (
          disconnectPending === null &&
          !exitStartedSeen &&
          !(reqBoundEpoch !== null && reqBoundEpoch <= terminalHandled)
        ) {
          connectionState = "FAILED";
          renderConnectionChrome();
          await startDisconnect("FAILED");
        }
        renderWorkspace();
        return;
      }
      // R5 / R1 / R3 refusal on thread/start stays in Start failed (cwd block) and never reads.
      pane.state = "start-failed";
      pane.footerReason = "no thread loaded";
      if (cls.kind === "rpc") {
        pane.cwdRefusal = {
          kind: "rpc",
          code: cls.code,
          rpcMessage: cls.rpcMessage,
          data: cls.data,
          message: cls.message,
          issues: Array.isArray(cls.data?.issues) ? cls.data.issues.map(String) : [],
        };
        if (cls.code === -32005 || cls.code === -32006) {
          pane.seatUnavailable = true;
          unavailableSeats.add(pane.seatId);
        }
        recordTableRefusal("thread/start", pane.seatId, cls);
        announceLive(`${pane.seatId}: cwd REFUSED ${cls.code} ${cls.rpcMessage}`);
      } else {
        pane.cwdRefusal = { kind: cls.kind, message: cls.message, issues: [] };
        announceLive(`${pane.seatId}: cwd REFUSED ${cls.message}`);
      }
      renderWorkspace();
    }
  }

  function isPaneStartEligible(pane) {
    if (!pane || pane.boundEpoch !== (boundEpoch ?? epoch)) return false;
    return (
      pane.state === "idle" ||
      pane.state === "completed" ||
      pane.state === "interrupted" ||
      pane.state === "failed"
    );
  }

  async function startTurn(text, targetPaneIds = null) {
    if (connectionState !== "CONNECTED" || disconnectPending !== null) return;
    const raw = String(text ?? "");
    if (raw.trim().length === 0) return;

    const chosenIds =
      targetPaneIds !== null
        ? new Set(targetPaneIds)
        : selectedTargets.size > 0
          ? selectedTargets
          : focusedPaneId
            ? new Set([focusedPaneId])
            : new Set();

    const targets = panes.filter((p) => chosenIds.has(p.paneId) && isPaneStartEligible(p));
    if (targets.length === 0) return;

    const reqEpoch = epoch;
    const reqBoundEpoch = boundEpoch;
    let allReturnedTurn = true;

    await Promise.all(
      targets.map(async (pane) => {
        if (!isPaneStartEligible(pane) || !pane.threadId) return;
        const prevTerminalState = pane.state;
        pane.state = "starting-turn";
        pane.footerReason = "starting turn";
        selectedTargets.delete(pane.paneId);
        renderWorkspace();
        try {
          const res = await invokeFn("rpc_request", {
            method: "turn/start",
            params: {
              threadId: pane.threadId,
              input: [{ type: "text", text: raw }],
            },
          });
          if (
            reqEpoch !== epoch ||
            (reqBoundEpoch !== null && reqBoundEpoch !== boundEpoch) ||
            connectionState !== "CONNECTED"
          ) {
            allReturnedTurn = false;
            return;
          }
          if (pane.methodError?.method === "turn/start") {
            pane.methodError = null;
          }
          const turn = res?.turn;
          if (turn && typeof turn.id === "string") {
            if (pane.state === "starting-turn") {
              pane.turnId = turn.id;
              pane.startedAt = typeof turn.startedAt === "number" ? turn.startedAt : Date.now();
              pane.state = "running";
              pane.turnError = null;
              pane.turnPendingInterrupt = false;
              pane.streamedServedModel = null;
              pane.hashMovedOnTurnStart = true;
              pane.footerReason = "manual · sent once";
              announceLive(`${pane.seatId}: turn RUNNING`);
            }
          } else {
            allReturnedTurn = false;
          }
        } catch (err) {
          allReturnedTurn = false;
          if (reqEpoch !== epoch || (reqBoundEpoch !== null && reqBoundEpoch !== boundEpoch)) {
            return;
          }
          const cls = classifyRpcError(err);
          if (cls.kind === "shutting-down") {
            applySynthesizedExitTerminal(reqBoundEpoch);
            return;
          }
          outputEl.textContent = sanitizeEngineText(cls.message);
          if (cls.kind === "params" || cls.kind === "allowlist") {
            pane.state = prevTerminalState;
            pane.footerReason = cls.message;
            return;
          }
          if (cls.kind === "rpc") {
            pane.methodError = {
              method: "turn/start",
              code: cls.code,
              rpcMessage: cls.rpcMessage,
              data: cls.data,
            };
            recordTableRefusal("turn/start", pane.seatId, cls);
            if (cls.code === -32007) {
              pane.state = "refused";
              const reason = String(cls.data?.reason ?? cls.rpcMessage);
              pane.refused32007 = {
                code: -32007,
                reason,
                providerId: String(cls.data?.providerId ?? ""),
                status: String(cls.data?.status ?? ""),
                data: cls.data,
              };
              pane.footerReason = "refused · no network";
              announceLive(`${pane.seatId}: turn/start refused -32007 ${reason}`);
            } else if (cls.code === -32002) {
              pane.unloaded32002 = true;
              pane.state = prevTerminalState;
              pane.footerReason = cls.rpcMessage;
            } else if (cls.code === -32004 && typeof cls.data?.activeTurnId === "string") {
              pane.state = "running";
              pane.turnId = cls.data.activeTurnId;
              pane.footerReason = cls.rpcMessage;
            } else {
              pane.state = prevTerminalState;
              pane.footerReason = cls.rpcMessage;
            }
            return;
          }
          if (cls.kind === "not-connected") {
            if (disconnectPending === null) {
              lastConnectionInfo = null;
              connectionState = "DISCONNECTED";
              markEpochEndedOnPanes();
              settleQuitState();
              renderConnectionChrome();
            }
            return;
          }
          if (
            disconnectPending === null &&
            !exitStartedSeen &&
            !(reqBoundEpoch !== null && reqBoundEpoch <= terminalHandled)
          ) {
            connectionState = "FAILED";
            renderConnectionChrome();
            await startDisconnect("FAILED");
          }
        }
      }),
    );
    if (allReturnedTurn && composerInputEl) {
      composerInputEl.value = "";
    }
    renderWorkspace();
  }

  async function interruptTurn(paneId) {
    if (connectionState !== "CONNECTED" || disconnectPending !== null) return;
    const pane = panes.find((p) => p.paneId === paneId);
    if (!pane || pane.boundEpoch !== (boundEpoch ?? epoch)) return;
    if (pane.state !== "running" || !pane.threadId || !pane.turnId || pane.turnPendingInterrupt) {
      return;
    }

    const reqEpoch = epoch;
    const reqBoundEpoch = boundEpoch;
    const targetTurnId = pane.turnId;
    pane.turnPendingInterrupt = true;
    pane.state = "interrupt-pending";
    pane.footerReason = "turn/interrupt sent";
    renderWorkspace();

    try {
      await invokeFn("rpc_request", {
        method: "turn/interrupt",
        params: { threadId: pane.threadId, turnId: targetTurnId },
      });
      if (
        reqEpoch !== epoch ||
        (reqBoundEpoch !== null && reqBoundEpoch !== boundEpoch) ||
        connectionState !== "CONNECTED"
      ) {
        return;
      }
      if (pane.methodError?.method === "turn/interrupt") {
        pane.methodError = null;
      }
      renderWorkspace();
      // Result `{}` changes nothing; state settles only on `turn/completed`.
    } catch (err) {
      if (reqEpoch !== epoch || (reqBoundEpoch !== null && reqBoundEpoch !== boundEpoch)) {
        return;
      }
      pane.turnPendingInterrupt = false;
      const cls = classifyRpcError(err);
      if (cls.kind === "shutting-down") {
        applySynthesizedExitTerminal(reqBoundEpoch);
        return;
      }
      outputEl.textContent = sanitizeEngineText(cls.message);
      if (cls.kind === "params" || cls.kind === "allowlist") {
        if (pane.state === "interrupt-pending" && pane.turnId === targetTurnId) {
          pane.state = "running";
          pane.footerReason = cls.message;
        }
        renderWorkspace();
        return;
      }
      if (cls.kind === "rpc") {
        pane.methodError = {
          method: "turn/interrupt",
          code: cls.code,
          rpcMessage: cls.rpcMessage,
          data: cls.data,
        };
        recordTableRefusal("turn/interrupt", pane.seatId, cls);
        if (pane.state === "interrupt-pending" && pane.turnId === targetTurnId) {
          pane.state = "running";
          pane.footerReason = cls.rpcMessage;
        }
        renderWorkspace();
        return;
      }
      if (cls.kind === "not-connected") {
        if (disconnectPending === null) {
          lastConnectionInfo = null;
          connectionState = "DISCONNECTED";
          markEpochEndedOnPanes();
          settleQuitState();
          renderConnectionChrome();
        }
        return;
      }
      if (
        disconnectPending === null &&
        !exitStartedSeen &&
        !(reqBoundEpoch !== null && reqBoundEpoch <= terminalHandled)
      ) {
        connectionState = "FAILED";
        renderConnectionChrome();
        await startDisconnect("FAILED");
      }
    }
  }

  function dismissPane(paneId) {
    const idx = panes.findIndex((p) => p.paneId === paneId);
    if (idx === -1) return false;
    const pane = panes[idx];
    if (pane.state !== "draft" && pane.state !== "start-failed") return false;
    panes.splice(idx, 1);
    selectedTargets.delete(paneId);
    cwdInputEls.delete(paneId);
    paneRegionEls.delete(paneId);
    if (focusedPaneId === paneId) {
      focusedPaneId = panes.find((p) => p.visible)?.paneId ?? panes[0]?.paneId ?? null;
    }
    renderWorkspace();
    return true;
  }

  function hidePane(paneId) {
    if (panes.length <= 1) return false;
    const pane = panes.find((p) => p.paneId === paneId);
    if (!pane?.visible) return false;
    pane.visible = false;
    if (focusedPaneId === paneId) {
      focusedPaneId = panes.find((p) => p.visible)?.paneId ?? null;
    }
    renderWorkspace();
    return true;
  }

  function showPane(paneId) {
    const pane = panes.find((p) => p.paneId === paneId);
    if (!pane) return false;
    if (!pane.visible) {
      const visiblePanes = panes.filter((p) => p.visible);
      const maxCols = paneColumns(currentViewportWidth());
      if (visiblePanes.length >= maxCols) {
        const rightmost = visiblePanes[visiblePanes.length - 1];
        if (rightmost) rightmost.visible = false;
      }
      pane.visible = true;
    }
    focusedPaneId = pane.paneId;
    if (
      pane.needsTurnRead &&
      pane.threadId &&
      pane.boundEpoch === (boundEpoch ?? epoch) &&
      connectionState === "CONNECTED" &&
      disconnectPending === null
    ) {
      pane.needsTurnRead = false;
      void triggerSessionRead(pane.threadId, "turn-completed");
    }
    renderWorkspace();
    return true;
  }

  function focusPane(paneId) {
    const pane = panes.find((p) => p.paneId === paneId);
    if (!pane) return false;
    if (!pane.visible) {
      showPane(paneId);
    } else {
      focusedPaneId = pane.paneId;
      renderWorkspace();
    }
    if (pane.state === "draft" || pane.state === "start-failed") {
      const inputEl = cwdInputEls.get(pane.paneId);
      inputEl?.focus?.();
    } else {
      paneRegionEls.get(pane.paneId)?.focus?.();
    }
    return true;
  }

  function toggleComposerTarget(paneId) {
    const pane = panes.find((p) => p.paneId === paneId);
    if (!pane || !isPaneStartEligible(pane) || connectionState !== "CONNECTED") {
      return false;
    }
    if (selectedTargets.has(paneId)) {
      selectedTargets.delete(paneId);
    } else {
      selectedTargets.add(paneId);
    }
    renderWorkspace();
    return true;
  }

  function handleEngineEvent(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;

    if (payload.method === "madc/transport-closed") {
      applyTerminalResult(payload);
      return;
    }

    const decision = acceptEngineEvent(
      {
        boundEpoch,
        connectionState,
        disconnectPending: disconnectPending !== null,
        lastAcceptedSeq,
      },
      payload,
    );
    if (decision.streamGap) {
      streamGap = true;
    }
    if (decision.outcome !== "accept") {
      return;
    }
    lastAcceptedSeq = decision.nextSeq;

    const method = payload.method;
    const params = payload.params;
    if (!params || typeof params !== "object") return;

    if (method === "room/updated") {
      tableStale = true;
      if (roomStaleNoteEl) {
        roomStaleNoteEl.hidden = false;
        roomStaleNoteEl.textContent = "room changed · Inspect room to refresh";
      }
      return;
    }

    if (method === "madc/events-dropped") {
      streamGap = true;
      return;
    }

    const activeEpoch = boundEpoch ?? epoch;
    if (method === "turn/started") {
      const turn = params.turn;
      if (!turn || typeof turn.threadId !== "string") return;
      for (const pane of panes) {
        if (pane.threadId === turn.threadId && pane.boundEpoch === activeEpoch) {
          pane.turnId = typeof turn.id === "string" ? turn.id : pane.turnId;
          pane.startedAt = typeof turn.startedAt === "number" ? turn.startedAt : Date.now();
          pane.state = "running";
          pane.turnError = null;
          pane.turnPendingInterrupt = false;
          pane.streamedServedModel = null;
          pane.hashMovedOnTurnStart = true;
          pane.footerReason = "manual · sent once";
          selectedTargets.delete(pane.paneId);
          announceLive(`${pane.seatId}: turn RUNNING`);
        }
      }
      renderWorkspace();
      return;
    }

    if (method === "item/completed") {
      const item = params.item;
      if (item?.kind !== "servedModel" || typeof params.threadId !== "string") return;
      if (item.status !== "completed") return;
      for (const pane of panes) {
        if (
          pane.threadId === params.threadId &&
          pane.boundEpoch === activeEpoch &&
          ((pane.turnId === null && pane.state === "starting-turn") ||
            pane.turnId === params.turnId)
        ) {
          pane.streamedServedModel = item;
        }
      }
      renderWorkspace();
      return;
    }

    if (method === "turn/completed") {
      const turn = params.turn;
      if (!turn || typeof turn.threadId !== "string" || typeof turn.id !== "string") return;
      for (const pane of panes) {
        if (pane.threadId !== turn.threadId || pane.boundEpoch !== activeEpoch) continue;
        if (pane.turnId !== null && pane.turnId !== turn.id) continue;
        pane.turnPendingInterrupt = false;
        pane.completedTurnId = turn.id;
        if (turn.status === "completed") {
          pane.state = "completed";
          pane.turnError = null;
          announceLive(`${pane.seatId}: turn COMPLETED`);
        } else if (turn.status === "interrupted") {
          pane.state = "interrupted";
          pane.turnError = null;
          pane.footerReason = "turn ended · interrupted";
          announceLive(`${pane.seatId}: turn INTERRUPTED`);
        } else if (turn.status === "failed") {
          pane.state = "failed";
          pane.turnError = turn.error ?? null;
          announceLive(`${pane.seatId}: turn FAILED`);
        } else {
          continue;
        }
        pane.lastCompletedTurnState = pane.state;
        if (pane.visible) {
          void triggerSessionRead(pane.threadId, "turn-completed");
        } else {
          pane.needsTurnRead = true;
        }
      }
      renderWorkspace();
    }
  }

  async function handleQuitRequested(payload) {
    const decision = acceptQuitRequest({ boundEpoch, connectionState, quitRecord }, payload);
    if (decision.action === "ignore") {
      return;
    }
    if (decision.action === "refocus") {
      quitKeepBtnEl?.focus?.();
      return;
    }
    const requestEpoch = payload.epoch;
    const requestId = payload.requestId;
    quitRecord = decision.nextRecord;

    let res;
    try {
      res = await invokeFn("quit_dialog_shown", { epoch: requestEpoch, requestId });
    } catch {
      res = { accepted: false };
    }

    if (
      requestEpoch !== boundEpoch ||
      connectionState !== "CONNECTED" ||
      quitRecord === null ||
      quitRecord.requestId !== requestId ||
      quitRecord.status !== "candidate"
    ) {
      return;
    }

    if (res?.accepted === true) {
      quitRecord = { requestId, status: "shown" };
      openQuitDialogUi();
      return;
    }

    quitRecord = { requestId, status: "settled" };
  }

  async function ackQuit() {
    const rec = quitRecord;
    const reqEpoch = boundEpoch;
    if (rec === null || rec.status === "settled" || reqEpoch === null) {
      closeQuitDialogUi(true);
      return { accepted: false };
    }
    const requestId = rec.requestId;
    quitRecord = { requestId, status: "settled" };
    closeQuitDialogUi(true);
    try {
      const res = await invokeFn("ack_quit", { epoch: reqEpoch, requestId });
      return { accepted: Boolean(res?.accepted) };
    } catch {
      return { accepted: false };
    }
  }

  async function confirmQuit() {
    const rec = quitRecord;
    const reqEpoch = boundEpoch;
    if (rec === null || rec.status === "settled" || reqEpoch === null) {
      closeQuitDialogUi(false);
      return { accepted: false };
    }
    const requestId = rec.requestId;
    quitRecord = { requestId, status: "settled" };
    closeQuitDialogUi(false);
    try {
      const res = await invokeFn("confirm_quit", { epoch: reqEpoch, requestId });
      return { accepted: Boolean(res?.accepted) };
    } catch {
      return { accepted: false };
    }
  }

  function openPalette() {
    if (paletteOpen) return;
    priorFocusEl = doc.activeElement ?? null;
    paletteOpen = true;
    paletteQuery = "";
    paletteActiveId = null;
    if (
      connectionState === "CONNECTED" &&
      disconnectPending === null &&
      seatSummaries.length === 0
    ) {
      void loadSeats();
    }
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
        viewMode = "table";
        renderWorkspace();
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
      case "cmd-copy-served-model": {
        const sm = findFocusedPaneEvidence().servedModel;
        if (sm && typeof globalObj?.navigator?.clipboard?.writeText === "function") {
          void globalObj.navigator.clipboard.writeText(sm);
        }
        break;
      }
      case "cmd-copy-head-open": {
        const sha = findFocusedPaneEvidence().headOpen;
        if (sha && typeof globalObj?.navigator?.clipboard?.writeText === "function") {
          void globalObj.navigator.clipboard.writeText(sha);
        }
        break;
      }
      case "cmd-view-panes":
        viewMode = "panes";
        closePalette(true);
        renderWorkspace();
        return;
      case "cmd-view-table":
        viewMode = "table";
        closePalette(true);
        renderWorkspace();
        return;
      case "cmd-pane-focus-1":
      case "cmd-pane-focus-2":
      case "cmd-pane-focus-3":
      case "cmd-pane-focus-4": {
        const slotIdx = Number(cmdId.slice(-1)) - 1;
        const visiblePanes = panes.filter((p) => p.visible);
        const slotPane = visiblePanes[slotIdx];
        closePalette(false);
        if (slotPane) {
          viewMode = "panes";
          focusPane(slotPane.paneId);
        }
        return;
      }
      case "cmd-pane-hide":
        closePalette(true);
        if (focusedPaneId) hidePane(focusedPaneId);
        return;
      case "cmd-pane-dismiss":
        closePalette(true);
        if (focusedPaneId) dismissPane(focusedPaneId);
        return;
      case "cmd-turn-start":
        closePalette(true);
        await startTurn(composerInputEl?.value ?? "");
        return;
      default:
        if (typeof cmdId === "string" && cmdId.startsWith("cmd-pane-new:")) {
          const seatId = cmdId.slice("cmd-pane-new:".length);
          closePalette(false);
          viewMode = "panes";
          const created = createDraftPane(seatId);
          const inputEl = cwdInputEls.get(created.paneId);
          inputEl?.focus?.();
          inputEl?.setSelectionRange?.(0, (inputEl.value ?? "").length);
          return;
        }
        if (typeof cmdId === "string" && cmdId.startsWith("cmd-pane-show:")) {
          const pid = cmdId.slice("cmd-pane-show:".length);
          closePalette(false);
          viewMode = "panes";
          focusPane(pid);
          return;
        }
        if (typeof cmdId === "string" && cmdId.startsWith("cmd-turn-interrupt:")) {
          const pid = cmdId.slice("cmd-turn-interrupt:".length);
          closePalette(true);
          await interruptTurn(pid);
          return;
        }
        if (typeof cmdId === "string" && cmdId.startsWith("cmd-target-toggle:")) {
          const pid = cmdId.slice("cmd-target-toggle:".length);
          toggleComposerTarget(pid);
          break;
        }
    }
    closePalette(true);
  }

  paletteInputEl.addEventListener("input", (ev) => {
    paletteQuery = String(ev?.target?.value ?? paletteInputEl.value ?? "");
    const next = currentPaletteState();
    paletteActiveId = next.activeId;
    renderPalette();
  });

  if (viewPanesBtnEl && viewTableBtnEl && viewToggleEl) {
    viewPanesBtnEl.addEventListener("click", () => {
      viewMode = "panes";
      renderWorkspace();
    });
    viewTableBtnEl.addEventListener("click", () => {
      viewMode = "table";
      renderWorkspace();
    });
    viewToggleEl.addEventListener("keydown", (ev) => {
      if (ev?.key === "ArrowLeft" || ev?.key === "ArrowRight") {
        ev.preventDefault?.();
        viewMode = viewMode === "panes" ? "table" : "panes";
        renderWorkspace();
        (viewMode === "panes" ? viewPanesBtnEl : viewTableBtnEl).focus();
      }
    });
  }

  if (composerInputEl) {
    composerInputEl.addEventListener("input", () => {
      renderWorkspace();
    });
  }

  if (composerStartBtnEl) {
    composerStartBtnEl.addEventListener("click", () => {
      void startTurn(composerInputEl?.value ?? "");
    });
  }

  if (quitKeepBtnEl) {
    quitKeepBtnEl.addEventListener("click", () => {
      void ackQuit();
    });
  }

  if (quitConfirmBtnEl) {
    quitConfirmBtnEl.addEventListener("click", () => {
      void confirmQuit();
    });
  }

  const handleGlobalKeydown = (ev) => {
    const key = ev?.key;
    const modOnly = isMac
      ? Boolean(ev?.metaKey && !ev?.ctrlKey)
      : Boolean(ev?.ctrlKey && !ev?.metaKey);

    if (quitDialogOpen) {
      if (key === "Escape") {
        ev.preventDefault?.();
        void ackQuit();
        return;
      }
      if (key === "Tab") {
        ev.preventDefault?.();
        if (doc.activeElement === quitKeepBtnEl) {
          quitConfirmBtnEl?.focus?.();
        } else {
          quitKeepBtnEl?.focus?.();
        }
        return;
      }
      if (key === "Enter") {
        ev.preventDefault?.();
        if (doc.activeElement === quitConfirmBtnEl) {
          void confirmQuit();
        } else {
          void ackQuit();
        }
      }
      return;
    }

    const isToggle = typeof key === "string" && key.toLowerCase() === "k" && modOnly;

    if (isToggle) {
      ev.preventDefault?.();
      if (paletteOpen) closePalette(true);
      else openPalette();
      return;
    }

    if (paletteOpen) {
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
      return;
    }

    // Palette & quit dialog closed: V6 keys (C53 / D-722).
    if (
      modOnly &&
      !ev?.shiftKey &&
      !ev?.altKey &&
      (key === "1" || key === "2" || key === "3" || key === "4")
    ) {
      ev.preventDefault?.();
      const slotIdx = Number(key) - 1;
      const visiblePanes = panes.filter((p) => p.visible);
      const slotPane = visiblePanes[slotIdx];
      if (slotPane) {
        viewMode = "panes";
        focusPane(slotPane.paneId);
      }
      return;
    }

    if (
      modOnly &&
      key === "Enter" &&
      composerInputEl !== null &&
      doc.activeElement === composerInputEl
    ) {
      ev.preventDefault?.();
      void startTurn(composerInputEl.value ?? "");
    }
  };

  function reportEventBridgeFailure(message) {
    const text = sanitizeEngineText(String(message ?? "Tauri event bridge unavailable"));
    sessionReceipts.splice(0, sessionReceipts.length, {
      label: "event bridge",
      tone: evidenceTone(null, "fail"),
      pillLabel: "FAILED",
      context: "Tauri global event API missing",
      chips: [{ key: "api", value: "__TAURI__.event.listen" }],
      note: text,
    });
    connectionState = "FAILED";
    outputEl.textContent = text;
    renderConnectionChrome();
    renderReceiptsWell();
    announceLive(`Engine FAILED: ${text}`);
    if (paletteOpen) renderPalette();
  }

  renderConnectionChrome();
  renderReceiptsWell();
  renderWorkspace();
  renderPalette();
  if (quitDialogEl) quitDialogEl.hidden = true;

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
    handleEngineEvent,
    handleQuitRequested,
    reportEventBridgeFailure,
    ackQuit,
    confirmQuit,
    loadSeats,
    createDraftPane,
    setPaneCwdText,
    startThread,
    startTurn,
    interruptTurn,
    dismissPane,
    hidePane,
    showPane,
    focusPane,
    toggleComposerTarget,
    setViewMode: (mode) => {
      viewMode = mode === "panes" ? "panes" : "table";
      renderWorkspace();
    },
    getViewMode: () => viewMode,
    getPanes: () => panes.map(paneSnapshot),
    getSeats: () => seatSummaries,
    getQuitState: () => ({
      quitRecord,
      dialogOpen: quitDialogOpen,
      boundEpoch,
      terminalHandled,
      exitStarted: exitStartedSeen,
    }),
    getQuitTurns: () => getQuitTurnsInternal().map(paneSnapshot),
    isTableStale: () => tableStale,
    isStreamGap: () => streamGap,
  };
}
