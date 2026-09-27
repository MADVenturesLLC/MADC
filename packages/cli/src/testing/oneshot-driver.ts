/**
 * Test driver: calls `runOneShot` in-process (erratum §3c rule 8: the `turnIdleMs` and
 * `responseTimeoutMs` test hooks are reached this way, never via env or flags) and then exits, so
 * a turn wait that never sees `turn/completed` cannot hang the test runner on the client
 * waitFor's backstop timer. Knobs (env): MADC_TEST_TURN_IDLE_MS (default 600000),
 * MADC_TEST_RESPONSE_TIMEOUT_MS, MADC_TEST_JSON=1, MADC_TEST_STDOUT_TTY=1, MADC_TEST_PROMPT.
 */
import { runOneShot } from "../oneshot.ts";

/** Positive-integer ms from a test env knob; anything else is a harness error, never NaN. */
function readMsKnob(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `oneshot-driver: ${name} must be a positive integer (got ${JSON.stringify(raw)})`,
    );
  }
  return value;
}

const turnIdleMs = readMsKnob("MADC_TEST_TURN_IDLE_MS", 600_000);
const responseTimeoutMs =
  process.env.MADC_TEST_RESPONSE_TIMEOUT_MS === undefined
    ? undefined
    : readMsKnob("MADC_TEST_RESPONSE_TIMEOUT_MS", 0);
const code = await runOneShot(
  {
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    env: {},
    stdoutIsTTY: process.env.MADC_TEST_STDOUT_TTY === "1",
    stderrIsTTY: false,
    cwd: process.cwd(),
    ...(process.env.MADC_TEST_ENGINE_ENTRY !== undefined
      ? { engineEntry: process.env.MADC_TEST_ENGINE_ENTRY }
      : {}),
  },
  {
    prompt: process.env.MADC_TEST_PROMPT ?? "hi",
    seatId: undefined,
    json: process.env.MADC_TEST_JSON === "1",
    home: process.env.MADC_HOME ?? "",
    turnIdleMs,
    ...(responseTimeoutMs !== undefined ? { responseTimeoutMs } : {}),
  },
);
process.exit(code);
