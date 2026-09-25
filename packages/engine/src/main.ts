import type { Writable } from "node:stream";
import type { Agent } from "./agent.ts";
import { echoAgent } from "./agent.ts";
import { resolveMadcHome } from "./home.ts";
import { EngineConnection } from "./server.ts";

/**
 * Engine process entry: protocol on stdin/stdout (JSONL), logs on stderr only.
 * `agent` defaults to the fake echo agent — A2 wires no providers.
 */
export async function startStdioEngine(agent: Agent = echoAgent): Promise<void> {
  let home: string;
  try {
    home = resolveMadcHome();
  } catch (err) {
    process.stderr.write(`[madc-engine] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 2;
    return;
  }
  const conn = new EngineConnection({
    input: process.stdin,
    output: process.stdout,
    home,
    agent,
  });
  process.once("exit", () => conn.releaseLocks());
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const) {
    process.once(signal, () => handleTerminationSignal(conn, code));
  }
  await conn.run();
  // Output failure ends the connection while stdin may still be open: let the process exit.
  process.stdin.destroy();
}

export type TerminationDeps = {
  output: Writable;
  setExitCode: (code: number) => void;
  exit: () => void;
  /** Upper bound on waiting for stdout to drain before exiting anyway. */
  graceMs?: number;
};

const processDeps = (): TerminationDeps => ({
  output: process.stdout,
  setExitCode: (code) => {
    process.exitCode = code;
  },
  exit: () => process.exit(),
});

/**
 * SIGINT/SIGTERM: end in-flight turns (their `turn/completed` is queued on stdout), release locks,
 * set the exit code, and exit only once everything already written to stdout has been flushed —
 * never `process.exit(code)` straight away, which can drop the queued notifications.
 */
export function handleTerminationSignal(
  conn: { shutdown(): void },
  code: number,
  deps: TerminationDeps = processDeps(),
): void {
  deps.setExitCode(code);
  conn.shutdown();
  let exited = false;
  const exitOnce = () => {
    if (exited) return;
    exited = true;
    clearTimeout(timer);
    deps.exit();
  };
  // A stuck reader must not keep the engine alive forever.
  const timer = setTimeout(exitOnce, deps.graceMs ?? 2_000);
  try {
    // Write callbacks run in order: this one fires after every earlier write has been flushed.
    deps.output.write("", () => exitOnce());
  } catch {
    exitOnce();
  }
}
