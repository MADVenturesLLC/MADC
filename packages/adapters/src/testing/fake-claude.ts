/**
 * Test-only fixture child standing in for the `claude` binary (Act M0-A5). Spawned as a real
 * process via `createFakeClaudeSpawn` (same runtime as the test runner), it parses the exact CLI
 * shape the adapter uses (`-p <prompt> --output-format json --model <m> [--append-system-prompt
 * <s>]`) and answers per `MADC_TEST_CLAUDE_MODE`:
 *
 * - unset / `ok`       — one JSON result on stdout (echoes prompt + model), exit 0
 * - `no-model`         — same but without `modelUsage` (servedModel falls back to the requested id)
 * - `nonzero`          — hostile text on stderr, exit 1
 * - `malformed`        — non-JSON stdout, exit 0
 * - `error-result`     — `{ is_error: true, … }` on stdout, exit 0
 * - `hang`             — writes nothing, runs until killed (abort tests)
 * - `vanish`           — exits 127 immediately (spawn- raced binary-missing is covered by a stub
 *                        spawn that emits `error`; this mode covers the close-without-result path)
 *
 * Records its argv (prompt, model, system prompt) to `MADC_TEST_CLAUDE_ARGV_LOG` (one JSON line)
 * when set, so tests can assert exactly what the adapter would have passed to the vendor binary.
 */
import { appendFileSync } from "node:fs";

function argValue(args: readonly string[], flag: string): string | null {
  const at = args.indexOf(flag);
  return at >= 0 && at + 1 < args.length ? (args[at + 1] ?? null) : null;
}

const args = process.argv.slice(2);
const prompt = argValue(args, "-p") ?? "";
const model = argValue(args, "--model") ?? "";
const systemPrompt = argValue(args, "--append-system-prompt");

const argvLog = process.env.MADC_TEST_CLAUDE_ARGV_LOG;
if (argvLog !== undefined) {
  appendFileSync(argvLog, `${JSON.stringify({ prompt, model, systemPrompt })}\n`);
}

const mode = process.env.MADC_TEST_CLAUDE_MODE ?? "ok";

function result(overrides: Record<string, unknown> = {}): void {
  process.stdout.write(
    `${JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: `fake claude answer to: ${prompt}`,
      modelUsage: { [model]: { inputTokens: 11, outputTokens: 7 } },
      ...overrides,
    })}\n`,
  );
}

switch (mode) {
  case "ok":
    result();
    break;
  case "no-model":
    result({ modelUsage: {} });
    break;
  case "nonzero":
    process.stderr.write("fake claude: exploded with account details that must never surface\n");
    process.exit(1);
    break;
  case "malformed":
    process.stdout.write("this is not json\n");
    break;
  case "error-result":
    result({ is_error: true, subtype: "error_during_execution", result: "" });
    break;
  case "hang":
    setInterval(() => undefined, 60_000);
    break;
  case "vanish":
    process.exit(127);
    break;
  default:
    process.stderr.write(`fake claude: unknown MADC_TEST_CLAUDE_MODE "${mode}"\n`);
    process.exit(2);
}
