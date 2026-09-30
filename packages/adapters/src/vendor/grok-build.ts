/**
 * Grok Build backing (Act M1-A6): drives the UNMODIFIED `grok` binary as an ACP agent over stdio
 * through the generic ACP client. Registry `grok-build` (`allowed-via-vendor-agent`,
 * `vendor-session`; roadmap §3 row 11 (c)).
 *
 * Spawn (xAI docs, docs.x.ai/build/cli/headless-scripting, and `grok --help` on grok 1.0.44):
 *
 *   grok --no-auto-update agent --no-leader --model=<pinnedModel> stdio
 *
 * - `--no-auto-update`: xAI documents it for ACP in scripts and automation ("pass
 *   --no-auto-update … to skip background update checks"). It is a top-level flag: grok 1.0.44
 *   rejects it after `stdio`.
 * - `--no-leader`: an `agent` option ("Start a new agent even when config enables leader mode"), so
 *   each turn owns its own agent process and `session/cancel` + kill really end the vendor turn,
 *   whatever the operator's `[cli] use_leader` says.
 * - `--model=<id>`: an `agent` option. The `=` form binds the value even if it began with `-`, so a
 *   seat file can never smuggle a flag in; `resolveGrokPinnedModel` also rejects such names.
 * - NEVER `--always-approve` / `--yolo`: the M1 approval posture follows seat policy, and no seat
 *   field grants auto-approval (seat pin §2: allow/ask deferred). Permission requests the agent
 *   sends are refused (`acp-client/wire.ts` `permissionOutcome`).
 *
 * Auth: Grok Build authenticates itself. madc never reads `~/.grok` or any Grok credential file,
 * never reads a credential value, never uses pi-ai's xAI OAuth, and never hands Grok the M1-A2
 * `xai-api` keychain key (a different lane and billing class). The ACP `authenticate` call only
 * names one of the methods the agent itself advertises, exactly as xAI's own ACP example does:
 * `xai.api_key` when the operator chose the API-key class by exporting `XAI_API_KEY` (a PRESENCE
 * test — the value is never read), else `cached_token` (the agent's own `grok login`), with
 * `_meta: { headless: true }` so the agent never opens an interactive login from a MAD turn.
 */
import type { ProviderPort } from "../provider-port.ts";
import {
  type AcpAgentSpec,
  type AcpSpawn,
  createAcpPort,
  findAgentBinary,
} from "./acp-client/client.ts";
import type { AcpAuthChoice, AcpAuthMethod } from "./acp-client/wire.ts";

/** Registry provider id (seat `preferredBacking`). */
export const GROK_BUILD_PROVIDER_ID = "grok-build";
/** Vendor binary name looked up on PATH. */
export const GROK_BINARY_NAME = "grok";
/** The env var Grok Build reads for its API-key class; madc only tests that it is present. */
export const GROK_API_KEY_ENV = "XAI_API_KEY";
/** ACP auth method ids Grok Build advertises (xAI ACP example). */
export const GROK_AUTH_API_KEY = "xai.api_key";
export const GROK_AUTH_CACHED_TOKEN = "cached_token";

/**
 * Trailing-update window: xAI's ACP example keeps reading `session/update` chunks after the
 * `session/prompt` response until the text is stable for two 150 ms checks. MAD does the same,
 * bounded.
 */
export const GROK_TRAILING_QUIET_MS = 300;
export const GROK_TRAILING_MAX_MS = 3_000;

/** Vendor model names are passed as one argv value: letters, digits and `._:/@+-`, no leading `-`. */
const GROK_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;

export type GrokPinnedModelResolution =
  | { readonly ok: true; readonly modelId: string }
  | { readonly ok: false; readonly issue: string };

/**
 * `pinnedModel` for grok-build is the vendor model name (seat pin §2), passed as `--model=<id>`.
 * Shape only (the binary is the authority on which names it serves): non-empty, no whitespace or
 * control characters, no leading `-`.
 */
export function resolveGrokPinnedModel(pinnedModel: string): GrokPinnedModelResolution {
  const modelId = pinnedModel.trim();
  if (modelId === "") {
    return { ok: false, issue: "pinnedModel must be a non-empty vendor model name" };
  }
  if (!GROK_MODEL_PATTERN.test(modelId)) {
    return {
      ok: false,
      issue:
        "pinnedModel must be a grok model name: letters, digits and ._:/@+- only, not starting with -",
    };
  }
  return { ok: true, modelId };
}

/** The argv for one turn (after the binary). Never contains `--always-approve`. */
export function grokBuildArgs(modelId: string): readonly string[] {
  return ["--no-auto-update", "agent", "--no-leader", `--model=${modelId}`, "stdio"];
}

/**
 * The ACP `authenticate` choice from the methods the agent advertised. `apiKeyPresent` is the
 * presence of `XAI_API_KEY` in the environment the child inherits (never its value).
 */
export function selectGrokAuth(
  methods: readonly AcpAuthMethod[],
  apiKeyPresent: boolean,
): AcpAuthChoice | null {
  const offered = new Set(methods.map((method) => method.id));
  const methodId =
    apiKeyPresent && offered.has(GROK_AUTH_API_KEY)
      ? GROK_AUTH_API_KEY
      : offered.has(GROK_AUTH_CACHED_TOKEN)
        ? GROK_AUTH_CACHED_TOKEN
        : null;
  return methodId === null ? null : { methodId, meta: { headless: true } };
}

/** Presence of `XAI_API_KEY` as an own property of `env` — the value is never read. */
export function grokApiKeyPresent(env: object): boolean {
  return Object.hasOwn(env, GROK_API_KEY_ENV);
}

/** PATH lookup for `grok`. Never executes anything. */
export function findGrokBinary(
  env: Readonly<Record<string, string | undefined>>,
  name: string = GROK_BINARY_NAME,
): string | null {
  return findAgentBinary(env, name);
}

export type GrokBuildPortOptions = {
  /** Absolute path of the detected `grok` binary (from `findGrokBinary`). */
  readonly binaryPath: string;
  /** Test seam: spawn override. Production never sets it. */
  readonly spawn?: AcpSpawn;
  /** Version in the ACP `initialize` `clientInfo` (production: the engine version). */
  readonly clientVersion?: string;
  /**
   * Whether `XAI_API_KEY` is present in the environment the child inherits. Default: tested on
   * `process.env` at each turn (presence only). Tests inject a fixed answer.
   */
  readonly apiKeyPresent?: () => boolean;
  /** Test seam: the trailing-update window (production: the xAI-documented defaults above). */
  readonly trailingQuietMs?: number;
  readonly trailingMaxMs?: number;
};

/** The Grok Build ACP agent spec (exported for tests and doctor-style introspection). */
export function grokBuildSpec(
  options: Pick<GrokBuildPortOptions, "apiKeyPresent" | "trailingQuietMs" | "trailingMaxMs"> = {},
): AcpAgentSpec {
  const apiKeyPresent = options.apiKeyPresent ?? (() => grokApiKeyPresent(process.env));
  return Object.freeze({
    providerId: GROK_BUILD_PROVIDER_ID,
    args: grokBuildArgs,
    selectAuth: (methods: readonly AcpAuthMethod[]) => selectGrokAuth(methods, apiKeyPresent()),
    trailingQuietMs: options.trailingQuietMs ?? GROK_TRAILING_QUIET_MS,
    trailingMaxMs: options.trailingMaxMs ?? GROK_TRAILING_MAX_MS,
  });
}

export function createGrokBuildPort(options: GrokBuildPortOptions): ProviderPort {
  return createAcpPort({
    spec: grokBuildSpec(options),
    binaryPath: options.binaryPath,
    ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
    ...(options.clientVersion === undefined ? {} : { clientVersion: options.clientVersion }),
  });
}
