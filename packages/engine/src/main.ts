import type { Writable } from "node:stream";
import {
  createClaudeCodePort,
  createCodexCodePort,
  createKimiCodePort,
  honestUserAgent,
  KIMI_API_KEY_ENV,
  KIMI_CODE_PROVIDER_ID,
  type KimiCredential,
  readKimiCredential,
} from "@madc/adapters";
import type { Agent } from "./agent.ts";
import { createCredentialStore } from "./credentials/store.ts";
import { resolveMadcHome } from "./home.ts";
import { createProviderAgent } from "./provider-agent.ts";
import { ENGINE_VERSION, EngineConnection } from "./server.ts";

/** Builds the turn agent once `MADC_HOME` is known. May resolve async (keychain probe, M1-A2). */
export type AgentFactory = (env: { readonly home: string }) => Agent | Promise<Agent>;

const log = (line: string) => process.stderr.write(`[madc-engine] ${line}\n`);

/**
 * Map a store-resolved secret to a `KimiCredential`, preserving the adapter's own validation
 * (trim + Claude OAuth-token refusal): the value is passed through `readKimiCredential` as if it
 * had been read from the environment.
 */
function kimiCredentialFromStore(secret: string | null): KimiCredential {
  if (secret === null) return { ok: false, reason: "missing" };
  return readKimiCredential({ [KIMI_API_KEY_ENV]: secret });
}

/**
 * Production agent: the thread's seat file (seeded `madc-default` by default) on Kimi Code (plan
 * D2), the unmodified Claude Code binary (A5), or the unmodified Codex binary via `codex
 * app-server` (A6) per the seat's `preferredBacking`. The Kimi API key is resolved once from the
 * engine-owned credential store (M1-A2): the OS keychain, or — only under the
 * `MADC_DEV_ENV_KEYS=1` development exception (D-M1-5) — the `KIMI_API_KEY` environment variable.
 * Without one, kimi turns answer -32008 `no-credentials`; the resolved key is registered with the
 * session redactor by exact value (the redactor learns every stored key, seat pin §4.2).
 * claude-code / codex read no MAD credential — the detected vendor binary (PATH lookup at
 * preflight; -32008 `binary-missing` when absent) inherits the environment and finds its own
 * auth. No base-URL or transport override exists here: production only talks to the pinned
 * catalog endpoint, and only spawns the detected vendor binary.
 */
export const defaultAgentFactory: AgentFactory = async () => {
  const credentials = createCredentialStore({ env: process.env });
  const secret = await credentials.get(KIMI_CODE_PROVIDER_ID);
  return createProviderAgent({
    credential: kimiCredentialFromStore(secret),
    createPort: (apiKey) =>
      createKimiCodePort({ apiKey, userAgent: honestUserAgent(ENGINE_VERSION) }),
    createClaudePort: (binaryPath) => createClaudeCodePort({ binaryPath }),
    createCodexPort: (binaryPath) =>
      createCodexCodePort({ binaryPath, clientVersion: ENGINE_VERSION }),
    log,
  });
};

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
    agent: typeof agent === "function" ? await agent({ home }) : agent,
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
