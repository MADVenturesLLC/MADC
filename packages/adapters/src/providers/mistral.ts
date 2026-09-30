/**
 * Mistral Pro backing (M1-A4; roadmap §3 row 3 — `allowed-direct`, terms VERIFIED 2026-09-24).
 *
 * Registry-driven lane CONFIG over the pinned pi-ai built-in `mistral` provider: the
 * `mistral-conversations` wire against `https://api.mistral.ai` with a Bearer API key. All the
 * streaming, failure and quota-signal mechanics are the shared generic port (`direct/generic.ts`) —
 * this module holds only what is Mistral-specific (plan §7 M1-A4: "Registry-driven config over
 * pi-ai built-ins").
 *
 * Model truth is the pinned pi-ai catalog, labelled by version in every refusal message. There is
 * no hard-coded model list here (plan A3 forbidden list): `pinnedModel` membership is checked
 * against the catalog the pinned pi-ai actually ships.
 *
 * Headless policy, terms freshness and lane status live in the REGISTRY and are enforced by the
 * engine's `assertAllowed` preflight — this adapter never decides policy.
 */
import { createModels } from "@earendil-works/pi-ai";
import { mistralProvider } from "@earendil-works/pi-ai/providers/mistral";
import { createDirectKeyPort, type PinnedModelResolution } from "../direct/generic.ts";
import { resolveStaticPinnedModel } from "../direct/pinned-model.ts";
import type { ProviderPort } from "../provider-port.ts";

/** Registry provider id (== seat `preferredBacking`). */
export const MISTRAL_PROVIDER_ID = "mistral-pro";
/** pi-ai provider id — differs from the registry id on purpose (seat pin §3). */
export const MISTRAL_PI_PROVIDER = "mistral";
export const MISTRAL_WIRE_API = "mistral-conversations" as const;
/** The pinned catalog endpoint. Production never overrides it; tests do, through the port seam. */
export const MISTRAL_BASE_URL = "https://api.mistral.ai";
/** Derived env name for the A2 credential store (`credentialEnvVar("mistral-pro")`). */
export const MISTRAL_API_KEY_ENV = "MADC_API_KEY_MISTRAL_PRO";

const catalog = createModels();
catalog.setProvider(mistralProvider());

function inCatalog(modelId: string): boolean {
  return catalog.getModel(MISTRAL_PI_PROVIDER, modelId)?.api === MISTRAL_WIRE_API;
}

/** Model ids the pinned pi-ai catalog lists under `mistral` on this lane's wire api. */
export function mistralCatalogModelIds(): string[] {
  return catalog.getModels(MISTRAL_PI_PROVIDER).map((model) => model.id);
}

/** `pinnedModel` must be `mistral/<id>` with `<id>` in the pinned catalog; else refused. */
export function resolveMistralPinnedModel(pinnedModel: string): PinnedModelResolution {
  return resolveStaticPinnedModel(pinnedModel, {
    providerId: MISTRAL_PROVIDER_ID,
    piProvider: MISTRAL_PI_PROVIDER,
    inCatalog,
  });
}

/** The pinned pi-ai built-in provider, unchanged (M1-A4 uses built-ins, not `createProvider`). */
export function buildMistralProvider() {
  return mistralProvider();
}

export type MistralPortOptions = {
  readonly apiKey: string;
  /** Test seam: override the catalog base URL. Production never sets it. */
  readonly baseUrl?: string;
  /** Test seam: in-process fake transport. Production uses `globalThis.fetch`. */
  readonly fetch?: typeof globalThis.fetch;
};

export function createMistralPort(options: MistralPortOptions): ProviderPort {
  return createDirectKeyPort({
    providerId: MISTRAL_PROVIDER_ID,
    piProvider: MISTRAL_PI_PROVIDER,
    api: MISTRAL_WIRE_API,
    apiKey: options.apiKey,
    buildProvider: () => mistralProvider(),
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
}
