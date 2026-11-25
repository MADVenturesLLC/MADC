import { bindDesktopShell, invokeTauri } from "./shell.js";

bindDesktopShell(document, (cmd, args) => invokeTauri(cmd, args, window));
