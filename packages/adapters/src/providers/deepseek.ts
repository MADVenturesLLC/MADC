/**
 * DeepSeek backing (M1-A4; roadmap §3 row 4 — `allowed-direct`, PAYG terms VERIFIED 2026-09-24).
 *
 * Registry-driven lane CONFIG over the pinned pi-ai built-in `deepseek` provider: the
 * `openai-completions` wire against `https://api.deepseek.com/chat/completions` with a Bearer API
 * key. Note the endpoint is at the API ROOT, not under `/v1`.
 *
 * **WIRED BUT GATED (Founder ruling D-M1-8).** Wiring this adapter does NOT open the lane.
 * `deepseek-payg` is a repo-gated provider (M1 seat pin §5): the engine resolves the thread's
 * repository identity itself and denies every repo that is not on the `$MADC_HOME/policy.json`
 * allowlist with `-32007 repo-not-allowed`. A clean install ships an EMPTY allowlist, so every
 * repository is denied and nothing is ever sent to DeepSeek until the Founder names a repo. The
 * gate lives in `packages/engine/src/policy/` — never here: this adapter decides no policy.
 */
import { createModels } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { createDirectKeyPort, type PinnedModelResolution } from "../direct/generic.ts";
import { resolveStaticPinnedModel } from "../direct/pinned-model.ts";
import type { ProviderPort } from "../provider-port.ts";

/** Registry provider id (== seat `preferredBacking`). */
export const DEEPSEEK_PROVIDER_ID = "deepseek-payg";
/** pi-ai provider id — differs from the registry id on purpose (seat pin §3). */
export const DEEPSEEK_PI_PROVIDER = "deepseek";
export const DEEPSEEK_WIRE_API = "openai-completions" as const;
/** The pinned catalog endpoint. Production never overrides it; tests do, through the port seam. */
export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
/** Derived env name for the A2 credential store (`credentialEnvVar("deepseek-payg")`). */
export const DEEPSEEK_API_KEY_ENV = "MADC_API_KEY_DEEPSEEK_PAYG";

const catalog = createModels();
catalog.setProvider(deepseekProvider());

function inCatalog(modelId: string): boolean {
  return catalog.getModel(DEEPSEEK_PI_PROVIDER, modelId)?.api === DEEPSEEK_WIRE_API;
}

/** Model ids the pinned pi-ai catalog lists under `deepseek` on this lane's wire api. */
export function deepseekCatalogModelIds(): string[] {
  return catalog.getModels(DEEPSEEK_PI_PROVIDER).map((model) => model.id);
}

/** `pinnedModel` must be `deepseek/<id>` with `<id>` in the pinned catalog; else refused. */
export function resolveDeepseekPinnedModel(pinnedModel: string): PinnedModelResolution {
  return resolveStaticPinnedModel(pinnedModel, {
    providerId: DEEPSEEK_PROVIDER_ID,
    piProvider: DEEPSEEK_PI_PROVIDER,
    inCatalog,
  });
}

/** The pinned pi-ai built-in provider, unchanged (M1-A4 uses built-ins, not `createProvider`). */
export function buildDeepseekProvider() {
  return deepseekProvider();
}

export type DeepseekPortOptions = {
  readonly apiKey: string;
  /** Test seam: override the catalog base URL. Production never sets it. */
  readonly baseUrl?: string;
  /** Test seam: in-process fake transport. Production uses `globalThis.fetch`. */
  readonly fetch?: typeof globalThis.fetch;
};

export function createDeepseekPort(options: DeepseekPortOptions): ProviderPort {
  return createDirectKeyPort({
    providerId: DEEPSEEK_PROVIDER_ID,
    piProvider: DEEPSEEK_PI_PROVIDER,
    api: DEEPSEEK_WIRE_API,
    apiKey: options.apiKey,
    buildProvider: () => deepseekProvider(),
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
}
