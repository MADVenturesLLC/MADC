/**
 * Ollama Cloud backing (M1-A3 — the first new live lane, D-M1-2). Direct cloud inference over the
 * OpenAI-compatible endpoint `https://ollama.com/v1` with a Bearer API key
 * (docs.ollama.com/api/authentication.md; roadmap §3 row 1). Not a pi-ai built-in: the provider is
 * built with pi-ai `createProvider` (plan §7 M1-A3, pi-check §1 "OpenAI-compat custom provider").
 *
 * Model truth: the live `GET https://ollama.com/api/tags` list, labelled `listed` — NOT
 * "entitled" (planning record OLL-27/28) and never a hard-coded model list (plan A3 forbidden).
 * The catalog starts empty; the port refreshes it from `/api/tags` when a requested model is not
 * (yet) known. `/api/tags` publishes no pricing or context metadata, so those Model fields carry
 * honest zeros ("unknown"); receipts never use them, and pi-ai consults `maxTokens` only for
 * reasoning-effort budgets, which MADC never requests.
 *
 * Headless policy lives in the registry (`headless: "denied"`, D-M1-3) and is enforced by the
 * engine's `assertAllowed` preflight — this adapter never decides policy.
 */
import { createProvider, envApiKeyAuth, type Model, type Provider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import {
  createDirectKeyPort,
  type PinnedModelResolution,
  QUOTA_OR_UNREACHABLE_STATUSES,
} from "../direct/generic.ts";
import { ProviderCallError, type ProviderPort } from "../provider-port.ts";

/** Registry provider id == pi-ai provider id for this lane (no legacy split to honor). */
export const OLLAMA_CLOUD_PROVIDER_ID = "ollama-cloud";
export const OLLAMA_PI_PROVIDER = "ollama-cloud";
export const OLLAMA_CLOUD_BASE_URL = "https://ollama.com/v1";
/** The picker endpoint on the API origin (NOT under /v1). */
export const OLLAMA_TAGS_PATH = "/api/tags";
/** Derived env name for the A2 credential store (`credentialEnvVar("ollama-cloud")`). */
export const OLLAMA_API_KEY_ENV = "MADC_API_KEY_OLLAMA_CLOUD";

/**
 * One model from `GET /api/tags`. `source: "listed"` is the honest truth label: the provider
 * lists the model; that is NOT the same as this credential being entitled to it (OLL-27/28).
 */
export type ListedOllamaModel = { readonly id: string; readonly source: "listed" };

export type OllamaListOptions = {
  /** Sent as `Authorization: Bearer` when present (cloud endpoints require the key). */
  readonly apiKey?: string;
  readonly baseUrl?: string;
  /** Test seam; defaults to `/api/tags` on the base URL's origin. */
  readonly tagsUrl?: string;
  /** Test seam: in-process fake transport. Production uses `globalThis.fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
};

/** Fetch the live model list. Throws ProviderCallError (429/502 → quota-or-unreachable). */
export async function listOllamaCloudModels(
  options: OllamaListOptions = {},
): Promise<readonly ListedOllamaModel[]> {
  const baseUrl = options.baseUrl ?? OLLAMA_CLOUD_BASE_URL;
  const tagsUrl = options.tagsUrl ?? new URL(OLLAMA_TAGS_PATH, baseUrl).toString();
  const runFetch = options.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await runFetch(tagsUrl, {
      headers: options.apiKey === undefined ? {} : { Authorization: `Bearer ${options.apiKey}` },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch {
    throw new ProviderCallError("failed", null, "ollama-cloud model list request failed");
  }
  if (!response.ok) {
    const quota = QUOTA_OR_UNREACHABLE_STATUSES.includes(response.status);
    throw new ProviderCallError(
      "failed",
      response.status,
      `ollama-cloud model list request failed (HTTP ${response.status})`,
      quota ? "quota-or-unreachable" : undefined,
    );
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new ProviderCallError("failed", null, "ollama-cloud model list was not valid JSON");
  }
  const models = (parsed as { models?: unknown } | null)?.models;
  if (!Array.isArray(models)) {
    throw new ProviderCallError("failed", null, "ollama-cloud model list was malformed");
  }
  const listed: ListedOllamaModel[] = [];
  for (const entry of models) {
    const name = (entry as { name?: unknown } | null)?.name;
    if (typeof name === "string" && name !== "") listed.push({ id: name, source: "listed" });
  }
  return listed;
}

/**
 * `pinnedModel` must be `ollama-cloud/<model id>`. Membership is NOT checked here: the live
 * `/api/tags` list is the only model truth (checked by the port at call time), and preflight stays
 * side-effect free. A hard-coded membership list would violate the plan A3 forbidden list.
 */
export function resolveOllamaPinnedModel(pinnedModel: string): PinnedModelResolution {
  const slash = pinnedModel.indexOf("/");
  if (slash <= 0 || slash === pinnedModel.length - 1) {
    return { ok: false, issue: `pinnedModel must be "${OLLAMA_PI_PROVIDER}/<model id>"` };
  }
  const provider = pinnedModel.slice(0, slash);
  if (provider !== OLLAMA_PI_PROVIDER) {
    return {
      ok: false,
      issue: `pinnedModel provider "${provider}" does not match backing ${OLLAMA_CLOUD_PROVIDER_ID} (pi-ai provider "${OLLAMA_PI_PROVIDER}")`,
    };
  }
  return { ok: true, modelId: pinnedModel.slice(slash + 1) };
}

function listedModel(id: string, baseUrl: string): Model<"openai-completions"> {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: OLLAMA_PI_PROVIDER,
    baseUrl,
    reasoning: false,
    input: ["text"],
    // /api/tags publishes no pricing or context numbers; zeros mean "unknown" (see module docs).
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 0,
    maxTokens: 0,
  };
}

function ollamaCloudProvider(
  baseUrl: string,
  models: readonly Model<"openai-completions">[],
): Provider<"openai-completions"> {
  return createProvider({
    id: OLLAMA_PI_PROVIDER,
    name: "Ollama Cloud",
    baseUrl,
    auth: { apiKey: envApiKeyAuth("Ollama Cloud API key", [OLLAMA_API_KEY_ENV]) },
    models,
    api: openAICompletionsApi(),
  });
}

export type OllamaCloudPortOptions = {
  readonly apiKey: string;
  /** Test seam: override the OpenAI-compat base URL. Production never sets it. */
  readonly baseUrl?: string;
  /** Test seam: override the `/api/tags` URL. Production derives it from the base URL origin. */
  readonly tagsUrl?: string;
  /** Test seam: in-process fake transport. Production uses `globalThis.fetch`. */
  readonly fetch?: typeof globalThis.fetch;
};

export function createOllamaCloudPort(options: OllamaCloudPortOptions): ProviderPort {
  const baseUrl = options.baseUrl ?? OLLAMA_CLOUD_BASE_URL;
  return createDirectKeyPort({
    providerId: OLLAMA_CLOUD_PROVIDER_ID,
    piProvider: OLLAMA_PI_PROVIDER,
    api: "openai-completions",
    apiKey: options.apiKey,
    // The static catalog is EMPTY on purpose: availability truth is the live list, fetched by
    // refreshProvider the first time a model is requested (and re-fetched on an unknown model).
    buildProvider: () => ollamaCloudProvider(baseUrl, []),
    refreshProvider: async () => {
      const listed = await listOllamaCloudModels({
        apiKey: options.apiKey,
        baseUrl,
        ...(options.tagsUrl === undefined ? {} : { tagsUrl: options.tagsUrl }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      });
      return ollamaCloudProvider(
        baseUrl,
        listed.map((model) => listedModel(model.id, baseUrl)),
      );
    },
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
}
