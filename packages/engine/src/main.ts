import type { Writable } from "node:stream";
import {
  ALIBABA_CODING_PLAN_BASE_URL,
  ALIBABA_CODING_PLAN_PROVIDER_ID,
  type CredentialCheck,
  checkAlibabaCredential,
  checkMinimaxCredential,
  createAlibabaCodingPlanPort,
  createClaudeCodePort,
  createCodexCodePort,
  createDeepseekPort,
  createGeminiPort,
  createKimiCodePort,
  createMinimaxTokenPlanPort,
  createMistralPort,
  createOllamaCloudPort,
  createXaiPort,
  DEEPSEEK_PROVIDER_ID,
  GEMINI_PROVIDER_ID,
  honestUserAgent,
  KIMI_API_KEY_ENV,
  KIMI_CODE_PROVIDER_ID,
  type KimiCredential,
  MINIMAX_TOKEN_PLAN_PROVIDER_ID,
  MISTRAL_PROVIDER_ID,
  OLLAMA_CLOUD_PROVIDER_ID,
  readKimiCredential,
  resolveAlibabaCodingPlanPinnedModel,
  resolveDeepseekPinnedModel,
  resolveGeminiPinnedModel,
  resolveMinimaxPinnedModel,
  resolveMistralPinnedModel,
  resolveOllamaPinnedModel,
  resolveXaiPinnedModel,
  XAI_PROVIDER_ID,
} from "@madc/adapters";
import type { Agent } from "./agent.ts";
import { createCredentialStore } from "./credentials/store.ts";
import { resolveMadcHome } from "./home.ts";
import { loadRepoPolicy, type RepoPolicy } from "./policy/store.ts";
import type { PresenceTerminal } from "./presence/terminal.ts";
import { createProviderAgent } from "./provider-agent.ts";
import { ENGINE_VERSION, EngineConnection } from "./server.ts";

/** Builds the turn agent once `MADC_HOME` is known. May resolve async (keychain probe, M1-A2). */
export type AgentFactory = (env: {
  readonly home: string;
  /** M1-A4: the loaded `$MADC_HOME/policy.json`; the agent gates repo-denied FALLBACK candidates. */
  readonly repoPolicy: RepoPolicy;
}) => Agent | Promise<Agent>;

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

/** A generic direct lane's credential: the trimmed store value, or null when absent/blank. */
function directCredential(secret: string | null): string | null {
  const trimmed = secret?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

/**
 * M1-A5 (Founder ruling 12: plan keys and pay-as-you-go keys never mixed): a lane's credential only
 * if it is of the lane's own class. A mismatch leaves the lane without a usable credential, so its
 * turns answer -32008 `no-credentials` at preflight, before any request; stderr names the rule and
 * never the value. The keychain already stores one credential per registry id, so a key stored
 * under one id is never read through another — this catches a key of the wrong class stored under
 * the right id.
 */
function classCheckedCredential(
  secret: string | null,
  check: (apiKey: string) => CredentialCheck,
): string | null {
  const apiKey = directCredential(secret);
  if (apiKey === null) return null;
  const verdict = check(apiKey);
  if (verdict.ok) return apiKey;
  log(`${verdict.issue}; the lane has no usable credential`);
  return null;
}

/**
 * Production agent: the thread's seat file (seeded `madc-default` by default) on a registry-driven
 * direct lane — Kimi Code (plan D2), Ollama Cloud (M1-A3, D-M1-2; headless denied by D-M1-3), or
 * the M1-A4 batch Mistral / DeepSeek / Gemini / xAI — or the unmodified Claude Code binary (A5) /
 * Codex binary via `codex app-server` (A6) per the seat's `preferredBacking`. Direct-lane API keys
 * are resolved once from the engine-owned credential store (M1-A2): the OS keychain, or — only under
 * the `MADC_DEV_ENV_KEYS=1` development exception (D-M1-5) — the lane's environment variable.
 * Without one, that lane's turns answer -32008 `no-credentials`; every resolved key is registered
 * with the session redactor by exact value (the redactor learns every stored key, seat pin §4.2).
 * claude-code / codex read no MAD credential — the detected vendor binary (PATH lookup at
 * preflight; -32008 `binary-missing` when absent) inherits the environment and finds its own auth.
 * No base-URL or transport override exists here: production only talks to the pinned catalog
 * endpoint of each lane and only spawns the detected vendor binary.
 *
 * `deepseek-payg` being wired does NOT open it: the lane is repo-gated and `repoPolicy` denies
 * every repository that `$MADC_HOME/policy.json` does not list (D-M1-8). `gemini-api-key` accepts
 * auth keys only, so a standard-shaped credential is warned about on stderr — the warning never
 * carries the value. The M1-A5 plans (`minimax-token-plan`, `alibaba-coding-plan`) take only a key
 * of their own plan class, and serve only presence-verified interactive turns.
 */
export const defaultAgentFactory: AgentFactory = async ({ repoPolicy }) => {
  const credentials = createCredentialStore({ env: process.env });
  const [
    kimiSecret,
    ollamaSecret,
    mistralSecret,
    deepseekSecret,
    geminiSecret,
    xaiSecret,
    minimaxPlanSecret,
    alibabaPlanSecret,
  ] = await Promise.all([
    credentials.get(KIMI_CODE_PROVIDER_ID),
    credentials.get(OLLAMA_CLOUD_PROVIDER_ID),
    credentials.get(MISTRAL_PROVIDER_ID),
    credentials.get(DEEPSEEK_PROVIDER_ID),
    credentials.get(GEMINI_PROVIDER_ID),
    credentials.get(XAI_PROVIDER_ID),
    credentials.get(MINIMAX_TOKEN_PLAN_PROVIDER_ID),
    credentials.get(ALIBABA_CODING_PLAN_PROVIDER_ID),
  ]);
  return createProviderAgent({
    credential: kimiCredentialFromStore(kimiSecret),
    createPort: (apiKey) =>
      createKimiCodePort({ apiKey, userAgent: honestUserAgent(ENGINE_VERSION) }),
    directLanes: [
      {
        providerId: OLLAMA_CLOUD_PROVIDER_ID,
        credential: directCredential(ollamaSecret),
        createPort: (apiKey) => createOllamaCloudPort({ apiKey }),
        resolvePinnedModel: resolveOllamaPinnedModel,
      },
      {
        providerId: MISTRAL_PROVIDER_ID,
        credential: directCredential(mistralSecret),
        createPort: (apiKey) => createMistralPort({ apiKey }),
        resolvePinnedModel: resolveMistralPinnedModel,
      },
      {
        providerId: DEEPSEEK_PROVIDER_ID,
        credential: directCredential(deepseekSecret),
        createPort: (apiKey) => createDeepseekPort({ apiKey }),
        resolvePinnedModel: resolveDeepseekPinnedModel,
      },
      {
        providerId: GEMINI_PROVIDER_ID,
        credential: directCredential(geminiSecret),
        // Auth keys only: a standard-shaped key is a likely failure from September 2026, so say so
        // on stderr at lane construction (the value itself is never passed to `warn`).
        createPort: (apiKey) => createGeminiPort({ apiKey, warn: log }),
        resolvePinnedModel: resolveGeminiPinnedModel,
      },
      {
        providerId: XAI_PROVIDER_ID,
        credential: directCredential(xaiSecret),
        createPort: (apiKey) => createXaiPort({ apiKey }),
        resolvePinnedModel: resolveXaiPinnedModel,
      },
      // M1-A5 interactive-only plans. Wired does not mean open: the engine serves them only on a
      // turn whose presence it verified on its own controlling terminal, and MiniMax is repo-gated
      // with an empty allowlist on a clean install (ruling 13, D-M1-9).
      {
        providerId: MINIMAX_TOKEN_PLAN_PROVIDER_ID,
        credential: classCheckedCredential(minimaxPlanSecret, (apiKey) =>
          checkMinimaxCredential(MINIMAX_TOKEN_PLAN_PROVIDER_ID, apiKey),
        ),
        createPort: (apiKey) => createMinimaxTokenPlanPort({ apiKey }),
        resolvePinnedModel: resolveMinimaxPinnedModel,
      },
      {
        providerId: ALIBABA_CODING_PLAN_PROVIDER_ID,
        credential: classCheckedCredential(alibabaPlanSecret, (apiKey) =>
          checkAlibabaCredential(
            ALIBABA_CODING_PLAN_PROVIDER_ID,
            apiKey,
            ALIBABA_CODING_PLAN_BASE_URL,
          ),
        ),
        createPort: (apiKey) => createAlibabaCodingPlanPort({ apiKey }),
        resolvePinnedModel: resolveAlibabaCodingPlanPinnedModel,
      },
    ],
    createClaudePort: (binaryPath) => createClaudeCodePort({ binaryPath }),
    createCodexPort: (binaryPath) =>
      createCodexCodePort({ binaryPath, clientVersion: ENGINE_VERSION }),
    log,
    repoPolicy,
  });
};

export type StdioEngineOptions = {
  /**
   * M1-A5: the controlling-terminal access for the presence check. Production passes nothing and
   * gets the real `/dev/tty`; only test fixture engines inject a fake.
   */
  readonly terminal?: PresenceTerminal;
};

/**
 * Engine process entry: protocol on stdin/stdout (JSONL), logs on stderr only.
 * `agent` defaults to the live provider agent; tests pass fixture agents.
 */
export async function startStdioEngine(
  agent: Agent | AgentFactory = defaultAgentFactory,
  options: StdioEngineOptions = {},
): Promise<void> {
  let home: string;
  try {
    home = resolveMadcHome();
  } catch (err) {
    process.stderr.write(`[madc-engine] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 2;
    return;
  }
  // M1-A4: one load of `$MADC_HOME/policy.json`, shared by the connection (which gates the seat's
  // assigned backing inside `turn/start`) and the agent (which gates fallback candidates). Loading
  // is total: an absent, unreadable or malformed file yields a deny-everywhere policy, so a broken
  // file can never widen a repo-gated lane. Every rejection is reported on stderr at start.
  const loadedPolicy = loadRepoPolicy(home);
  for (const { issue } of loadedPolicy.fileIssues) {
    log(`policy.json: ${issue}; repo-gated providers deny every repository`);
  }
  for (const entry of loadedPolicy.rejected) {
    const where = entry.index === null ? entry.providerId : `${entry.providerId}[${entry.index}]`;
    log(`policy.json: ${where} rejected (${entry.issue}); it grants nothing`);
  }
  if (loadedPolicy.permissiveMode !== null) {
    log(`policy.json: mode ${loadedPolicy.permissiveMode} is more permissive than the pinned 0600`);
  }
  const repoPolicy = loadedPolicy.policy;
  const conn = new EngineConnection({
    input: process.stdin,
    output: process.stdout,
    home,
    repoPolicy,
    agent: typeof agent === "function" ? await agent({ home, repoPolicy }) : agent,
    ...(options.terminal === undefined ? {} : { terminal: options.terminal }),
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
