/**
 * M3-A2 shipped desktop UI module (`packages/desktop/ui/shell.js`).
 *
 * Single source of truth loaded by `ui/index.html` (via `ui/app.js`) and re-exported / tested
 * directly by `@madc/desktop`:
 * - Minimal, neutral keyboard focus bar controller (`PLAN-madc-M3-build-plan.md` §2 row M3-A2)
 * - Evidence-bound UI tone rule (`PIN-madc-M3-desktop-protocol.md` §4): derives verified status
 *   strictly from engine-returned receipt fields (`chainOk` + 64-hex `hash`, 40-hex `sha`, or
 *   `vendorReported` + non-empty `servedModel`), never a caller-supplied boolean.
 * - Tauri IPC shell binder (manual connect only, zero automatic retry).
 */

const SHA256_HEX = /^[0-9a-f]{64}$/;
const GIT_SHA_HEX = /^[0-9a-f]{40}$/;

export const DEFAULT_FOCUS_BAR_ITEMS = Object.freeze([
  Object.freeze({ id: "connection", label: "Engine" }),
  Object.freeze({ id: "room", label: "Room" }),
  Object.freeze({ id: "decisions", label: "Decisions" }),
  Object.freeze({ id: "search", label: "Search" }),
]);

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

export async function invokeTauri(cmd, args, globalObj = globalThis) {
  const internals = globalObj?.__TAURI_INTERNALS__;
  if (!internals || typeof internals.invoke !== "function") {
    throw new Error("Tauri IPC bridge unavailable outside desktop shell");
  }
  return internals.invoke(cmd, args || {});
}

/**
 * Wire the M3-A2 landmark toolbar and manual connect button in `ui/index.html`.
 */
export function bindDesktopShell(doc, invokeFn = invokeTauri) {
  const bar = doc.getElementById("focus-bar");
  const buttons = Array.from(bar.querySelectorAll("button[data-focus-id]"));
  const items = buttons.map((btn) => ({
    id: btn.getAttribute("data-focus-id"),
    label: btn.textContent ?? "",
  }));
  let focusState = createFocusBarState(items, 0);

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

  const statusEl = doc.getElementById("connection-status");
  const outputEl = doc.getElementById("output");
  const connectBtn = doc.getElementById("connect-btn");

  const connectHandler = async () => {
    statusEl.className = `status-${evidenceTone(null, "neutral")}`;
    statusEl.textContent = "Connecting over engine.sock…";
    try {
      const info = await invokeFn("connect_engine");
      const room = await invokeFn("rpc_request", { method: "room/inspect", params: {} });
      // M3 pin §4: no verified hash/sha/servedModel receipt yet -> tone stays neutral (no green).
      const tone = evidenceTone(null, "ok");
      statusEl.className = `status-${tone}`;
      statusEl.textContent = `Connected (${info.protocolVersion}, ${info.coldStartMs}ms) — ${tone}`;
      outputEl.textContent = JSON.stringify({ connection: info, room }, null, 2);
    } catch (err) {
      statusEl.className = `status-${evidenceTone(null, "fail")}`;
      statusEl.textContent = "Engine connection failed (no automatic retry)";
      outputEl.textContent = String(err);
    }
  };

  connectBtn.addEventListener("click", connectHandler);

  return {
    getFocusState: () => focusState,
    connect: connectHandler,
  };
}
