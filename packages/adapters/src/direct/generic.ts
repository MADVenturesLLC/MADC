/**
 * Generic direct-key ProviderPort (M1-A3, plan §7): the M0 Kimi port generalized and driven by
 * registry data. One implementation streams every `connect: "direct"` lane; per-lane differences
 * (pi-ai provider, wire api, model-catalog truth, honest-UA requirement, quota mapping) are
 * config, not forks. Kimi Code (anthropic-messages) and Ollama Cloud (openai-completions) are the
 * M1-A3 lanes; A4/A5 add Mistral, DeepSeek, Gemini and xAI through the same seam.
 *
 * Honesty rules (inherited from the M0 Kimi port):
 * - the key is passed explicitly per request; pi-ai's ambient credential lookup is never relied
 *   on (`env: {}` on every stream call) and error messages never carry upstream text or the key;
 * - a User-Agent override happens only where the lane requires the honest madc UA (registry
 *   `clientIdentity: "honest-ua-required"`); no vendor client is ever impersonated;
 * - HTTP 429/502 become the recorded `quota-or-unreachable` signal (protocol pin P5) that the
 *   engine's fallback logic consumes; every other non-2xx stays an ordinary failure.
 */
import {
  type Api,
  type AssistantMessage,
  createModels,
  type Model,
  type Provider,
} from "@earendil-works/pi-ai";
import {
  ProviderCallError,
  type ProviderPort,
  type ProviderTurnRequest,
  type ProviderTurnResult,
} from "../provider-port.ts";

/** Wire apis a direct-key lane can speak through pi-ai (registry `wire` field drives the choice). */
export type DirectWireApi = "anthropic-messages" | "openai-completions";

/** HTTP statuses mapped to the recorded `quota-or-unreachable` signal (plan M1-A3, pin P5). */
export const QUOTA_OR_UNREACHABLE_STATUSES: readonly number[] = Object.freeze([429, 502]);

export type PinnedModelResolution =
  | { readonly ok: true; readonly modelId: string }
  | { readonly ok: false; readonly issue: string };

export type DirectKeyPortConfig = {
  /** Registry provider id (== seat backing); used in error messages and receipts. */
  readonly providerId: string;
  /** pi-ai provider id — may differ from the registry id on purpose (seat pin §3). */
  readonly piProvider: string;
  readonly api: DirectWireApi;
  /** The credential this port streams with (resolved engine-side; never logged). */
  readonly apiKey: string;
  /** Static catalog registration (kimi: the pinned pi-ai provider). */
  readonly buildProvider: () => Provider<Api>;
  /**
   * Dynamic catalog refresh (ollama: the live `/api/tags` list). Called when a requested model is
   * not in the current catalog; the returned provider REPLACES the registered one. A hard-coded
   * model list is never the truth (plan A3 forbidden list).
   */
  readonly refreshProvider?: () => Promise<Provider<Api>>;
  /** Honest madc UA (registry `clientIdentity: "honest-ua-required"`); omit for pi-ai default. */
  readonly userAgent?: string;
  /** Test seam: override the catalog base URL. Production never sets it. */
  readonly baseUrl?: string;
  /** Test seam: in-process fake transport. Production uses `globalThis.fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  /** Defaults to QUOTA_OR_UNREACHABLE_STATUSES. */
  readonly quotaStatuses?: readonly number[];
};

/**
 * pi-ai's `errorMessage` is `"<status> <upstream body>"` for HTTP errors. Only the leading status
 * code is kept; the upstream body (which may echo request content) is discarded.
 */
export function leadingHttpStatus(errorMessage: string | undefined): number | null {
  const match = /^([1-5]\d\d)\b/.exec(errorMessage ?? "");
  return match?.[1] === undefined ? null : Number(match[1]);
}

function failure(
  config: DirectKeyPortConfig,
  signal: AbortSignal,
  status: number | null,
  aborted = false,
): ProviderCallError {
  if (aborted || signal.aborted) {
    return new ProviderCallError("aborted", status, `${config.providerId} request aborted`);
  }
  const suffix = status !== null && (status < 200 || status >= 300) ? ` (HTTP ${status})` : "";
  const quota =
    status !== null && (config.quotaStatuses ?? QUOTA_OR_UNREACHABLE_STATUSES).includes(status);
  return new ProviderCallError(
    "failed",
    status,
    `${config.providerId} request failed${suffix}`,
    quota ? "quota-or-unreachable" : undefined,
  );
}

export function createDirectKeyPort(config: DirectKeyPortConfig): ProviderPort {
  const catalog = createModels();
  catalog.setProvider(config.buildProvider());
  let refreshInFlight: Promise<void> | null = null;

  const resolveModel = (modelId: string): Model<DirectWireApi> | undefined => {
    const model = catalog.getModel(config.piProvider, modelId);
    return model !== undefined && model.api === config.api
      ? (model as Model<DirectWireApi>)
      : undefined;
  };

  /** One dynamic refresh at a time; failures propagate to the caller (mapped to ProviderCallError). */
  const refresh = (): Promise<void> => {
    const refreshProvider = config.refreshProvider;
    if (refreshProvider === undefined) return Promise.resolve();
    refreshInFlight ??= refreshProvider()
      .then((provider) => {
        catalog.setProvider(provider);
      })
      .finally(() => {
        refreshInFlight = null;
      });
    return refreshInFlight;
  };

  return Object.freeze({
    providerId: config.providerId,
    async streamTurn(request: ProviderTurnRequest): Promise<ProviderTurnResult> {
      let model = resolveModel(request.modelId);
      if (model === undefined) {
        try {
          await refresh();
        } catch (err) {
          if (err instanceof ProviderCallError) throw err;
          throw new ProviderCallError(
            "failed",
            null,
            `${config.providerId} model catalog refresh failed`,
          );
        }
        model = resolveModel(request.modelId);
        if (model === undefined) {
          throw new ProviderCallError(
            "failed",
            null,
            `Unknown ${config.piProvider} model "${request.modelId}"`,
          );
        }
      }
      const target = config.baseUrl === undefined ? model : { ...model, baseUrl: config.baseUrl };
      let status: number | null = null;
      const timestamp = Date.now();
      const stream = catalog.stream(
        target,
        {
          ...(request.systemPrompt === undefined ? {} : { systemPrompt: request.systemPrompt }),
          messages: request.messages.map((m) => ({ role: "user", content: m.text, timestamp })),
        },
        {
          apiKey: config.apiKey,
          ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
          // Provider-scoped env: keeps pi-ai from consulting ambient process env for this request.
          env: {},
          signal: request.signal,
          ...(config.userAgent === undefined
            ? {}
            : { headers: { "User-Agent": config.userAgent } }),
          onResponse: (response) => {
            status = response.status;
          },
        },
      );

      let final: AssistantMessage | undefined;
      try {
        for await (const event of stream) {
          if (event.type === "text_delta") request.onTextDelta(event.delta);
        }
        final = await stream.result();
      } catch {
        // Never surface the underlying error text: it can carry upstream bodies.
        throw failure(config, request.signal, status);
      }
      if (final.stopReason === "error" || final.stopReason === "aborted") {
        throw failure(
          config,
          request.signal,
          status ?? leadingHttpStatus(final.errorMessage),
          final.stopReason === "aborted",
        );
      }
      const text = final.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
      const servedModel = final.responseModel ?? model.id;
      // OpenAI-compat lanes: pi-ai fills responseModel from the first chunk's `model` — the vendor
      // reported an identity even when it equals the requested id. Anthropic lanes omit the key so
      // the M0 three-key result shape is untouched (the engine derives vendorReported there).
      const vendorReported =
        config.api === "openai-completions" && final.responseModel !== undefined
          ? { vendorReported: true as const }
          : {};
      return {
        text,
        requestedModelId: model.id,
        servedModel,
        ...vendorReported,
      };
    },
  });
}
