import { bindDesktopShell, invokeTauri } from "./shell.js";

const controller = bindDesktopShell(document, (cmd, args) => invokeTauri(cmd, args, window));

document.addEventListener("keydown", (ev) => {
  controller.handleKeydown(ev);
});

const listen = window.__TAURI__?.event?.listen;
if (typeof listen === "function") {
  void listen("madc:engine-event", (ev) => {
    controller.handleEngineEvent(ev?.payload);
  });
  void listen("madc:quit-requested", (ev) => {
    controller.handleQuitRequested(ev?.payload);
  });
}
