/**
 * Test fixture (M1-A5): runs the REAL system terminal (`presence/terminal.ts`) in its own process so
 * tests can place it under a real pseudo-terminal (`script`) or with no controlling terminal at all
 * (a `detached` / `setsid` spawn). Not a test file itself.
 *
 *   presence-probe.ts <outFile> probe     → writes { facts }
 *   presence-probe.ts <outFile> confirm   → writes { facts, confirmed, after }
 *
 * `confirm` prompts with `PRESENCE-PROMPT> ` on the controlling terminal; the test answers by typing
 * into the pseudo-terminal, never through this process's stdin pipe.
 */
import { closeSync, openSync, writeFileSync, writeSync } from "node:fs";
import { createSystemTerminal } from "../presence/terminal.ts";

const [outFile, action] = process.argv.slice(2);
if (outFile === undefined || (action !== "probe" && action !== "confirm")) {
  process.stderr.write("usage: presence-probe.ts <outFile> probe|confirm\n");
  process.exit(2);
}

const terminal = createSystemTerminal({ pollMs: 20 });
const facts = terminal.probe();
if (action === "probe") {
  writeFileSync(outFile, JSON.stringify({ facts }));
} else {
  const confirmed = await terminal.confirm("PRESENCE-PROMPT> ", new AbortController().signal);
  const after = terminal.probe();
  writeFileSync(outFile, JSON.stringify({ facts, confirmed, after }));
}
// Completion marker, written to the controlling terminal itself (the pty `script` shows the test).
// Engine sources never write stdout (it is the protocol channel, honesty.test.ts). With no
// controlling terminal (a detached spawn) there is nobody to tell, so nothing is written.
try {
  const fd = openSync("/dev/tty", "w");
  writeSync(fd, "PRESENCE-DONE\r\n");
  closeSync(fd);
} catch {
  // no controlling terminal
}
