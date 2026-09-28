/**
 * Signal driver (tests only): runs a real WitnessApp turn, then delivers the named signal the
 * way production `main.ts` wires it, so a child-process test can observe the pinned exit
 * behaviour — SIGHUP re-raise (the OS reports the signal), SIGINT/SIGTERM exit codes and the
 * §5.12 receipt + §5.13 line on the real stderr.
 *
 * Env:
 * - MADC_TEST_SIGNAL (sighup | sigint | sigterm), MADC_HOME, MADC_TEST_ENGINE_ENTRY.
 * - MADC_TEST_VERIFY_HOLD_MS: when > 0, the FINAL verify (the quit path's R-g, not the per-turn
 *   R-a) is held open this long and a `[final-verify-start]` marker is written to stderr first,
 *   so a test can land a SECOND signal inside the §5.8.1 O-2 window deterministically.
 */

import type { WitnessApp } from "../app/app.ts";
import { runWitnessApp } from "../app/launch.ts";
import { ProcessTty } from "../app/tty.ts";
import {
  runVerifyBounded,
  VERIFY_DEADLINE_MS,
  type VerifyOutcome,
  type VerifyRequest,
} from "../app/verify.ts";
import { parseTurnIdleMs } from "../main.ts";

const signal = process.env.MADC_TEST_SIGNAL ?? "sigint";
const home = process.env.MADC_HOME ?? "";
const engineEntry = process.env.MADC_TEST_ENGINE_ENTRY;
const holdMs = Number(process.env.MADC_TEST_VERIFY_HOLD_MS ?? "0");
// The driver simulates a CAPABLE terminal (§3.4): TERM set (colour) and a UTF-8 locale,
// unless the harness explicitly set TERM (e.g. dumb) to exercise the degraded paths.
const simEnv: NodeJS.ProcessEnv = { ...process.env };
// MADC_TEST_TERM pins the simulated terminal explicitly (e.g. "dumb" for the Level-A-with-
// zero-SGR path). Otherwise the harness shell's TERM=dumb would degrade every run; the
// driver's tier-W assertions assume a capable terminal, so dumb/undefined defaults to colour.
if (simEnv.MADC_TEST_TERM !== undefined) {
  simEnv.TERM = simEnv.MADC_TEST_TERM;
} else if (simEnv.TERM === undefined || simEnv.TERM === "dumb") {
  simEnv.TERM = "xterm-256color";
}
if (simEnv.LANG === undefined && simEnv.LC_ALL === undefined && simEnv.LC_CTYPE === undefined) {
  simEnv.LANG = "en_US.UTF-8";
}
const io = {
  stdout: process.stdout,
  stderr: process.stderr,
  stdin: process.stdin,
  env: simEnv,
  stdoutIsTTY: true,
  stderrIsTTY: true,
  stdinIsTTY: true,
  columns:
    process.env.MADC_TEST_COLUMNS === undefined ? 110 : Number(process.env.MADC_TEST_COLUMNS),
  rows: process.env.MADC_TEST_ROWS === undefined ? 32 : Number(process.env.MADC_TEST_ROWS),
  cwd: process.cwd(),
  ...(engineEntry !== undefined ? { engineEntry } : {}),
};

const tty = new ProcessTty(
  process.stdin as NodeJS.ReadStream,
  process.stdout as NodeJS.WriteStream,
  {
    columns:
      process.env.MADC_TEST_COLUMNS === undefined ? 110 : Number(process.env.MADC_TEST_COLUMNS),
    rows: process.env.MADC_TEST_ROWS === undefined ? 32 : Number(process.env.MADC_TEST_ROWS),
  },
);

let app: WitnessApp | null = null;
const onSigint = (): void => app?.onSigint();
const onSigterm = (): void => app?.onSigterm();
const onSighup = (): void => app?.onSighup();
process.on("SIGINT", onSigint);
process.on("SIGTERM", onSigterm);
process.on("SIGHUP", onSighup);

/** With the hold knob: call #2 is the quit path's final verify (call #1 was the per-turn R-a). */
let verifyCalls = 0;
const wrappedVerify =
  holdMs > 0
    ? async (req: VerifyRequest): Promise<VerifyOutcome> => {
        verifyCalls++;
        if (verifyCalls === 2) {
          process.stderr.write("[final-verify-start]\n");
          await new Promise((resolve) => setTimeout(resolve, holdMs));
        }
        return runVerifyBounded({ ...req, deadlineMs: VERIFY_DEADLINE_MS });
      }
    : undefined;

const exitPromise = runWitnessApp({
  io,
  home,
  turnIdleMs: (parseTurnIdleMs(process.env) as { ok: true; ms: number }).ms,
  firstPrompt: "hi",
  tty,
  onApp: (a) => {
    app = a;
  },
  onSighup: () => {
    // O-4, exactly as main.ts wires it: remove the listener, then re-raise.
    process.removeListener("SIGHUP", onSighup);
    process.kill(process.pid, "SIGHUP");
  },
  onFinalVerifySignal: (sig) => {
    if (sig === "SIGINT") process.removeListener("SIGINT", onSigint);
    if (sig === "SIGTERM") process.removeListener("SIGTERM", onSigterm);
    if (sig === "SIGHUP") process.removeListener("SIGHUP", onSighup);
    process.kill(process.pid, sig);
  },
  ...(wrappedVerify !== undefined ? { verify: wrappedVerify } : {}),
});

// Deliver the signal once the first turn has been sent and verified on disk.
const t0 = Date.now();
const poll = setInterval(() => {
  const done = app !== null && app.turns.length === 1 && app.turns[0]?.verify != null;
  if (done) {
    clearInterval(poll);
    const sig = signal === "sighup" ? "SIGHUP" : signal === "sigterm" ? "SIGTERM" : "SIGINT";
    // Small settle tick so the verify's worker is fully wound down before the signal.
    setTimeout(() => process.kill(process.pid, sig), 50).unref?.();
  }
  if (Date.now() - t0 > 30_000) {
    clearInterval(poll);
    process.exit(9); // harness failure: the turn never completed
  }
}, 25);
poll.unref?.();

const code = await exitPromise;
process.exit(code);
