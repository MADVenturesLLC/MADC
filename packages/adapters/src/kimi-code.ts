/**
 * Kimi Code backing (plan D2; M0-A3). Since M1-A3 this module is the kimi LANE CONFIG over the
 * generic direct-key port (`direct/generic.ts`): the pinned pi-ai provider, the anthropic-messages
 * wire, the honest-UA requirement and the key-shape refusals are kimi-specific; the streaming,
 * failure and quota-signal mechanics are the shared generic port.
 *
 * Honesty rules enforced here:
 * - The request identifies itself as MADC (`User-Agent: madc/…`); pi-ai's default UA is replaced and
 *   no other client is impersonated.
 * - Only API keys are accepted. Claude subscription OAuth tokens (`sk-ant-oat…`) are refused before
 *   any request, because pi-ai would otherwise send Claude Code identity headers for them.
 * - The key is passed explicitly per request; pi-ai's ambient credential lookup is never relied on
 *   and error messages never carry upstream text or the key.
 */
import { createModels, type Model } from "@earendil-works/pi-ai";
import { kimiCodingProvider } from "@earendil-works/pi-ai/providers/kimi-coding";
import { createDirectKeyPort, type PinnedModelResolution } from "./direct/generic.ts";
import { ProviderCallError, type ProviderPort } from "./provider-port.ts";

export type { PinnedModelResolution };

/** Exact pinned pi-ai version (plan §6). Asserted against package.json by tests. */
export const PI_AI_VERSION = "0.87.1";
/** Registry provider id (seat `preferredBacking`). */
export const KIMI_CODE_PROVIDER_ID = "kimi-code";
/** pi-ai provider id — differs from the registry id on purpose (seat pin §3). */
export const KIMI_PI_PROVIDER = "kimi-coding";
/** Locked `madc-default` pinnedModel for pi-ai 0.87.1 (seat pin §3). */
export const KIMI_DEFAULT_PINNED_MODEL = "kimi-coding/kimi-for-coding";
/** Local-only credential source (never committed; CI never sets it). */
export const KIMI_API_KEY_ENV = "KIMI_API_KEY";

const catalog = createModels();
catalog.setProvider(kimiCodingProvider());

function catalogModel(modelId: string): Model<"anthropic-messages"> | undefined {
  const model = catalog.getModel(KIMI_PI_PROVIDER, modelId);
  return model?.api === "anthropic-messages" ? (model as Model<"anthropic-messages">) : undefined;
}

/** Model ids the pinned pi-ai catalog lists under `kimi-coding`. */
export function kimiCatalogModelIds(): string[] {
  return catalog.getModels(KIMI_PI_PROVIDER).map((model) => model.id);
}

/**
 * `pinnedModel` must be `kimi-coding/<id>` with `<id>` in the pinned catalog. Anything else (another
 * pi-ai provider, an unknown model, a bare id) is refused — never silently remapped.
 */
export function resolveKimiPinnedModel(pinnedModel: string): PinnedModelResolution {
  const slash = pinnedModel.indexOf("/");
  if (slash <= 0 || slash === pinnedModel.length - 1) {
    return { ok: false, issue: `pinnedModel must be "${KIMI_PI_PROVIDER}/<model id>"` };
  }
  const provider = pinnedModel.slice(0, slash);
  const modelId = pinnedModel.slice(slash + 1);
  if (provider !== KIMI_PI_PROVIDER) {
    return {
      ok: false,
      issue: `pinnedModel provider "${provider}" does not match backing ${KIMI_CODE_PROVIDER_ID} (pi-ai provider "${KIMI_PI_PROVIDER}")`,
    };
  }
  if (catalogModel(modelId) === undefined) {
    return {
      ok: false,
      issue: `pinnedModel "${pinnedModel}" is not in the pi-ai ${PI_AI_VERSION} ${KIMI_PI_PROVIDER} catalog`,
    };
  }
  return { ok: true, modelId };
}

export type KimiCredential =
  | { readonly ok: true; readonly apiKey: string }
  | { readonly ok: false; readonly reason: "missing" | "oauth-token-refused" };

/**
 * Claude subscription OAuth tokens: pi-ai switches to Claude Code identity headers for these.
 * Deliberately a substring match, not a prefix match: pi-ai 0.87.1 decides OAuth mode with
 * `apiKey.includes("sk-ant-oat")` (dist/api/anthropic-messages.js), so any value it would treat as
 * OAuth must be refused here too, or a key with that text anywhere would be sent with vendor identity.
 */
function isRefusedTokenShape(value: string): boolean {
  return value.includes("sk-ant-oat");
}

/** Reads the local-only Kimi Code API key. Never logs or returns anything derived from a refused value. */
export function readKimiCredential(
  env: Readonly<Record<string, string | undefined>>,
): KimiCredential {
  const raw = env[KIMI_API_KEY_ENV]?.trim() ?? "";
  if (raw === "") return { ok: false, reason: "missing" };
  if (isRefusedTokenShape(raw)) return { ok: false, reason: "oauth-token-refused" };
  return { ok: true, apiKey: raw };
}

/** Honest client identity. Never a vendor CLI string. */
export function honestUserAgent(madcVersion: string): string {
  return `madc/${madcVersion} (pi-ai/${PI_AI_VERSION}; ${process.platform} ${process.arch})`;
}

/**
 * The pinned pi-ai built-in provider, unchanged — the lane's own pi-ai configuration. The port
 * streams through it, and the M1-A9 L1 tool round-trip drives the same builder.
 */
export function buildKimiProvider() {
  return kimiCodingProvider();
}

export type KimiCodePortOptions = {
  readonly apiKey: string;
  readonly userAgent: string;
  /** Test seam (with `fetch`): override the catalog base URL. Production never sets it. */
  readonly baseUrl?: string;
  /** Test seam: in-process fake transport. Production uses `globalThis.fetch`. */
  readonly fetch?: typeof globalThis.fetch;
};

export function createKimiCodePort(options: KimiCodePortOptions): ProviderPort {
  if (isRefusedTokenShape(options.apiKey)) {
    throw new ProviderCallError("failed", null, "Refused credential shape for kimi-code");
  }
  if (!options.userAgent.startsWith("madc/")) {
    throw new ProviderCallError("failed", null, "kimi-code requires an honest madc User-Agent");
  }
  return createDirectKeyPort({
    providerId: KIMI_CODE_PROVIDER_ID,
    piProvider: KIMI_PI_PROVIDER,
    api: "anthropic-messages",
    apiKey: options.apiKey,
    buildProvider: buildKimiProvider,
    userAgent: options.userAgent,
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
}
