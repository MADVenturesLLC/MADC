/**
 * xAI (Grok) backing (M1-A4; roadmap §3 row 11 — lane (a) "xAI API key: `allowed-direct`", terms
 * VERIFIED 2026-09-24).
 *
 * Registry-driven lane CONFIG over the pinned pi-ai `xai` model catalog: the `openai-responses`
 * wire against `https://api.x.ai/v1/responses` with a Bearer API key.
 *
 * **API KEY ONLY — pi-ai's xAI OAuth is NOT enabled.** `xaiProvider()` ships
 * `auth: { apiKey, oauth }`, where `oauth` is a `lazyOAuth` for "Sign in with SuperGrok or X
 * Premium" (pi-ai `providers/xai.js`). Roadmap §3 row 11 classifies that consumer sign-in as
 * `forbidden` — registry id `xai-consumer-signin`, AUP "bypassing our systems or protective
 * measures" — so this lane REBUILDS the provider with `createProvider` and `auth: { apiKey }` only.
 * That is a structural guarantee, not a behavioural one: there is no OAuth descriptor in the built
 * provider for pi-ai to fall back to, whatever the ambient environment holds. The single difference
 * from `xaiProvider()` is the removed `oauth` key; id, name, baseUrl, model catalog and api are the
 * pinned pi-ai values. A test asserts `auth.oauth` is absent.
 *
 * The credential is the M1-A2 keychain value for registry id `xai-api`. The port passes it
 * explicitly per request with `env: {}`, so pi-ai's ambient `XAI_API_KEY` lookup is never relied on.
 */
import { createModels, createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import { XAI_MODELS } from "@earendil-works/pi-ai/providers/xai.models";
import { createDirectKeyPort, type PinnedModelResolution } from "../direct/generic.ts";
import { resolveStaticPinnedModel } from "../direct/pinned-model.ts";
import type { ProviderPort } from "../provider-port.ts";

/** Registry provider id (== seat `preferredBacking`). */
export const XAI_PROVIDER_ID = "xai-api";
/** pi-ai provider id — differs from the registry id on purpose (seat pin §3). */
export const XAI_PI_PROVIDER = "xai";
export const XAI_WIRE_API = "openai-responses" as const;
/** The pinned catalog endpoint. Production never overrides it; tests do, through the port seam. */
export const XAI_BASE_URL = "https://api.x.ai/v1";
/** Derived env name for the A2 credential store (`credentialEnvVar("xai-api")`). */
export const XAI_API_KEY_ENV = "MADC_API_KEY_XAI_API";

/**
 * The pinned pi-ai `xai` provider WITHOUT its consumer OAuth descriptor (see module docs).
 * `envApiKeyAuth` keeps pi-ai's own label and env name; it is inert for madc because the generic
 * port always passes the key explicitly and `env: {}`.
 */
export function buildXaiProvider() {
  return createProvider({
    id: XAI_PI_PROVIDER,
    name: "xAI",
    baseUrl: XAI_BASE_URL,
    auth: { apiKey: envApiKeyAuth("xAI API key", ["XAI_API_KEY"]) },
    models: Object.values(XAI_MODELS),
    api: openAIResponsesApi(),
  });
}

const catalog = createModels();
catalog.setProvider(buildXaiProvider());

/**
 * True while the STOCK pi-ai `xaiProvider()` still ships an OAuth descriptor — i.e. while the strip
 * in `buildXaiProvider` is still load-bearing. Exported so the no-OAuth test can prove it is not
 * passing vacuously (a future pi-ai that drops xAI OAuth would make the assertion trivially true);
 * production never branches on it. It lives here rather than in the test because plan §6 allows only
 * the lane modules to import pi-ai — fakes and tests never do.
 */
export function stockXaiProviderHasOAuth(): boolean {
  return "oauth" in xaiProvider().auth;
}

function inCatalog(modelId: string): boolean {
  return catalog.getModel(XAI_PI_PROVIDER, modelId)?.api === XAI_WIRE_API;
}

/** Model ids the pinned pi-ai catalog lists under `xai` on this lane's wire api. */
export function xaiCatalogModelIds(): string[] {
  return catalog.getModels(XAI_PI_PROVIDER).map((model) => model.id);
}

/** `pinnedModel` must be `xai/<id>` with `<id>` in the pinned catalog; else refused. */
export function resolveXaiPinnedModel(pinnedModel: string): PinnedModelResolution {
  return resolveStaticPinnedModel(pinnedModel, {
    providerId: XAI_PROVIDER_ID,
    piProvider: XAI_PI_PROVIDER,
    inCatalog,
  });
}

export type XaiPortOptions = {
  readonly apiKey: string;
  /** Test seam: override the catalog base URL. Production never sets it. */
  readonly baseUrl?: string;
  /** Test seam: in-process fake transport. Production uses `globalThis.fetch`. */
  readonly fetch?: typeof globalThis.fetch;
};

export function createXaiPort(options: XaiPortOptions): ProviderPort {
  return createDirectKeyPort({
    providerId: XAI_PROVIDER_ID,
    piProvider: XAI_PI_PROVIDER,
    api: XAI_WIRE_API,
    apiKey: options.apiKey,
    buildProvider: () => buildXaiProvider(),
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
}
