import { bindDesktopShell, invokeTauri } from "./shell.js";

export function attachDesktopEvents(controller, win) {
  const listen = win?.__TAURI__?.event?.listen;
  if (typeof listen !== "function") {
    controller.reportEventBridgeFailure(
      "Tauri global event API (__TAURI__.event.listen) is unavailable; desktop events cannot be received.",
    );
    return false;
  }
  try {
    const pEngine = listen("madc:engine-event", (ev) => {
      controller.handleEngineEvent(ev?.payload);
    });
    const pQuit = listen("madc:quit-requested", (ev) => {
      controller.handleQuitRequested(ev?.payload);
    });
    Promise.resolve(pEngine).catch((err) => {
      controller.reportEventBridgeFailure(
        `Failed to listen for madc:engine-event: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    Promise.resolve(pQuit).catch((err) => {
      controller.reportEventBridgeFailure(
        `Failed to listen for madc:quit-requested: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    return true;
  } catch (err) {
    controller.reportEventBridgeFailure(
      `Failed to attach Tauri event listeners: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

export function bootDesktopApp(doc, win) {
  const controller = bindDesktopShell(doc, (cmd, args) => invokeTauri(cmd, args, win));
  doc.addEventListener("keydown", (ev) => {
    controller.handleKeydown(ev);
  });
  attachDesktopEvents(controller, win);
  return controller;
}

if (typeof document !== "undefined" && typeof window !== "undefined") {
  bootDesktopApp(document, window);
}
