import type { Writable } from "node:stream";
import { createKimiCodePort, honestUserAgent, readKimiCredential } from "@madc/adapters";
import type { Agent } from "./agent.ts";
import { resolveMadcHome } from "./home.ts";
import { createProviderAgent } from "./provider-agent.ts";
import { MADC_DEFAULT_SEAT } from "./seat.ts";
import { ENGINE_VERSION, EngineConnection } from "./server.ts";

/** Builds the turn agent once `MADC_HOME` is known. */
export type AgentFactory = (env: { readonly home: string }) => Agent;

const log = (line: string) => process.stderr.write(`[madc-engine] ${line}\n`);

/**
 * Production agent: built-in `madc-default` seat on Kimi Code (plan D2). The API key is read once
 * from the local environment (`KIMI_API_KEY`); without one, `turn/start` answers -32008
 * `no-credentials`. No base-URL or transport override exists here: production only talks to the
 * pinned catalog endpoint.
 */
export const defaultAgentFactory: AgentFactory = ({ home }) =>
  createProviderAgent({
    home,
    seat: MADC_DEFAULT_SEAT,
    credential: readKimiCredential(process.env),
    createPort: (apiKey) =>
      createKimiCodePort({ apiKey, userAgent: honestUserAgent(ENGINE_VERSION) }),
    log,
  });

/**
 * Engine process entry: protocol on stdin/stdout (JSONL), logs on stderr only.
 * `agent` defaults to the live Kimi Code agent; tests pass fixture agents.
 */
export async function startStdioEngine(
  agent: Agent | AgentFactory = defaultAgentFactory,
): Promise<void> {
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
    agent: typeof agent === "function" ? agent({ home }) : agent,
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
