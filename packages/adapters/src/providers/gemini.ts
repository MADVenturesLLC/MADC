/**
 * Gemini API backing (M1-A4; roadmap §3 row 5 — `allowed-direct`, terms VERIFIED 2026-09-24).
 *
 * Registry-driven lane CONFIG over the pinned pi-ai built-in `google` provider: the
 * `google-generative-ai` wire against `https://generativelanguage.googleapis.com/v1beta`,
 * authenticated with the `x-goog-api-key` header.
 *
 * **AUTH KEYS ONLY.** Google's pinned page (quoted verbatim in the registry `sourceQuote` for
 * `gemini-api-key`) says: "On September 2026 : the Gemini API will reject requests from standard
 * keys . You must migrate to auth keys". So a standard-shaped credential is a LIKELY FAILURE, and
 * `looksLikeStandardGeminiKey` exists so the engine and `madc doctor` can say so. It is a warning,
 * never a refusal: this module does not know what an auth key looks like (nothing in the pinned
 * sources documents its shape), so it only recognizes the standard shape and otherwise stays out of
 * the provider's way. The warning NEVER carries the credential value.
 *
 * **No Google OAuth of any kind.** `googleProvider()`'s auth is `apiKey`-only, asserted by test so a
 * future pi-ai bump cannot silently add a subscription sign-in: Antigravity / Gemini sign-in is
 * `forbidden` in the registry (`gemini-antigravity-signin`), and the port passes the key explicitly
 * with `env: {}` so pi-ai never consults ambient credentials.
 *
 * **No `fetch` test seam.** pi-ai's google adapter rejects a custom fetch outright
 * (`api/google-generative-ai.js`: "Custom fetch is not supported by the Google Generative AI
 * adapter") because it talks through the `@google/genai` SDK. Gemini conformance tests therefore
 * patch `globalThis.fetch` (see `testing/fake-gemini-transport.ts`) rather than injecting one.
 */
import { createModels } from "@earendil-works/pi-ai";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { createDirectKeyPort, type PinnedModelResolution } from "../direct/generic.ts";
import { resolveStaticPinnedModel } from "../direct/pinned-model.ts";
import type { ProviderPort } from "../provider-port.ts";

/** Registry provider id (== seat `preferredBacking`). */
export const GEMINI_PROVIDER_ID = "gemini-api-key";
/** pi-ai provider id — differs from the registry id on purpose (seat pin §3). */
export const GEMINI_PI_PROVIDER = "google";
export const GEMINI_WIRE_API = "google-generative-ai" as const;
/** The pinned catalog endpoint (includes the `/v1beta` version path). */
export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
/** Derived env name for the A2 credential store (`credentialEnvVar("gemini-api-key")`). */
export const GEMINI_API_KEY_ENV = "MADC_API_KEY_GEMINI_API_KEY";

/**
 * The standard Google API-key prefix. This is the shape Google's page says stops working in
 * September 2026; it is also the pattern the planning record's own secret grep looks for (GM-01..06,
 * "Grep for secrets patterns (`sk-`, `AIza`, …)"). Recognizing it is a heuristic WARNING only.
 */
export const GEMINI_STANDARD_KEY_PREFIX = "AIza";

/**
 * True when a credential has the STANDARD Google API-key shape, which `gemini-api-key` documents as
 * a likely failure from September 2026. Deliberately prefix-only: the auth-key shape is not
 * documented in any pinned source, so this never claims a key is valid — it only flags the shape
 * Google says it will reject. Never logs or returns the value.
 */
export function looksLikeStandardGeminiKey(apiKey: string): boolean {
  return apiKey.startsWith(GEMINI_STANDARD_KEY_PREFIX);
}

/**
 * The warning text for a standard-shaped credential. Exported so the engine's stderr line and
 * `madc doctor` report the same sentence, and so a test can pin it. Carries no credential value.
 */
export const GEMINI_STANDARD_KEY_WARNING =
  "gemini-api-key: the stored credential has a standard Google API-key shape (AIza…); Google's " +
  "pinned page says the Gemini API rejects standard keys from September 2026 and this lane accepts " +
  "auth keys only, so this call is likely to fail " +
  "(ai.google.dev/gemini-api/docs/api-key, verified 2026-09-23)";

const catalog = createModels();
catalog.setProvider(googleProvider());

function inCatalog(modelId: string): boolean {
  return catalog.getModel(GEMINI_PI_PROVIDER, modelId)?.api === GEMINI_WIRE_API;
}

/** Model ids the pinned pi-ai catalog lists under `google` on this lane's wire api. */
export function geminiCatalogModelIds(): string[] {
  return catalog.getModels(GEMINI_PI_PROVIDER).map((model) => model.id);
}

/** `pinnedModel` must be `google/<id>` with `<id>` in the pinned catalog; else refused. */
export function resolveGeminiPinnedModel(pinnedModel: string): PinnedModelResolution {
  return resolveStaticPinnedModel(pinnedModel, {
    providerId: GEMINI_PROVIDER_ID,
    piProvider: GEMINI_PI_PROVIDER,
    inCatalog,
  });
}

/** The pinned pi-ai built-in provider, unchanged (M1-A4 uses built-ins, not `createProvider`). */
export function buildGeminiProvider() {
  return googleProvider();
}

export type GeminiPortOptions = {
  readonly apiKey: string;
  /** Test seam: override the catalog base URL. Production never sets it. */
  readonly baseUrl?: string;
  /**
   * Called once at construction when the credential has a standard-key shape. Production wires it
   * to engine stderr; the value itself is never passed. Absent means "no warning surface".
   */
  readonly warn?: (line: string) => void;
};

export function createGeminiPort(options: GeminiPortOptions): ProviderPort {
  if (looksLikeStandardGeminiKey(options.apiKey)) {
    options.warn?.(GEMINI_STANDARD_KEY_WARNING);
  }
  return createDirectKeyPort({
    providerId: GEMINI_PROVIDER_ID,
    piProvider: GEMINI_PI_PROVIDER,
    api: GEMINI_WIRE_API,
    apiKey: options.apiKey,
    buildProvider: () => googleProvider(),
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    // No `fetch` seam: pi-ai's google adapter throws on a custom fetch (see module docs).
  });
}
