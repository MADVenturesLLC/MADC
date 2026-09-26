/**
 * Test driver: calls `runOneShot` in-process (erratum §3c rule 8: the `turnIdleMs` and
 * `responseTimeoutMs` test hooks are reached this way, never via env or flags) and then exits, so
 * a turn wait that never sees `turn/completed` cannot hang the test runner on the client
 * waitFor's backstop timer. Knobs (env): MADC_TEST_TURN_IDLE_MS (default 600000),
 * MADC_TEST_RESPONSE_TIMEOUT_MS, MADC_TEST_JSON=1, MADC_TEST_STDOUT_TTY=1, MADC_TEST_PROMPT.
 */
import { runOneShot } from "../oneshot.ts";

const turnIdleMs = Number(process.env.MADC_TEST_TURN_IDLE_MS ?? "600000");
const responseTimeoutMs = process.env.MADC_TEST_RESPONSE_TIMEOUT_MS;
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
    ...(responseTimeoutMs !== undefined ? { responseTimeoutMs: Number(responseTimeoutMs) } : {}),
  },
);
process.exit(code);
