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
    process.once(signal, () => {
      conn.shutdown();
      process.exit(code);
    });
  }
  await conn.run();
  // Output failure ends the connection while stdin may still be open: let the process exit.
  process.stdin.destroy();
}
