import { bindDesktopShell, invokeTauri } from "./shell.js";

const controller = bindDesktopShell(document, (cmd, args) => invokeTauri(cmd, args, window));

document.addEventListener("keydown", (ev) => {
  controller.handleKeydown(ev);
});
