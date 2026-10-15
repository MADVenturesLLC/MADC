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
  type Message,
  type Model,
  type Provider,
  type Tool,
  type ToolCall,
  Type,
} from "@earendil-works/pi-ai";
import {
  ProviderCallError,
  type ProviderDecisionRaiseInput,
  type ProviderPort,
  type ProviderTurnRequest,
  type ProviderTurnResult,
} from "../provider-port.ts";

/**
 * M2-A6 (F2): single bounded model-callable tool exposed on direct lanes through pi-ai's native
 * `Context.tools` contract. The engine owns `threadId` and `turnId`; the model supplies only the
 * typed `founderDecision` fields (`question`, `recommendedDefault`, `evidenceRefs`, and optional
 * `decisionId`). Never exposes `decision/resolve`.
 */
export const FOUNDER_DECISION_RAISE_TOOL_NAME = "founder_decision_raise";

/** Maximum native decision-tool round-trips permitted within a single provider turn. */
export const MAX_DECISION_TOOL_ROUNDS = 4;

const EVIDENCE_REF_SCHEMA = Type.Object({
  kind: Type.String({
    description: 'Evidence reference kind ("session", "servedModel", or "git").',
  }),
  path: Type.Optional(
    Type.String({ description: "Relative session path (sessions/<threadId>.jsonl)." }),
  ),
  seq: Type.Optional(Type.Integer({ minimum: 0, description: "Target event sequence number." })),
  hash: Type.Optional(Type.String({ description: "64-hex SHA-256 event hash." })),
  sha: Type.Optional(Type.String({ description: "40-hex git commit SHA." })),
  remote: Type.Optional(
    Type.Union([Type.String(), Type.Null()], {
      description: "Git remote name or null for local-only commit.",
    }),
  ),
});

export const FOUNDER_DECISION_RAISE_TOOL: Tool = Object.freeze({
  name: FOUNDER_DECISION_RAISE_TOOL_NAME,
  description:
    "Raise a typed Founder decision on the active thread and turn. Requires non-empty question, recommendedDefault, and verified evidenceRefs.",
  parameters: Type.Object({
    question: Type.String({
      description: "The decision question requiring Founder resolution.",
    }),
    recommendedDefault: Type.String({
      description: "The recommended default resolution if accepted as-is.",
    }),
    evidenceRefs: Type.Array(EVIDENCE_REF_SCHEMA, {
      minItems: 1,
      description: "Non-empty list of verified evidence references backing the decision.",
    }),
    decisionId: Type.Optional(
      Type.String({
        description: "Optional explicit decision id matching ^dec_[A-Za-z0-9_-]{1,64}$.",
      }),
    ),
  }),
});

const DIRECT_LANE_TOOLS: readonly Tool[] = Object.freeze([FOUNDER_DECISION_RAISE_TOOL]);

function executeDecisionToolCall(
  call: ToolCall,
  request: ProviderTurnRequest,
): { readonly text: string; readonly isError: boolean } {
  if (call.name !== FOUNDER_DECISION_RAISE_TOOL_NAME) {
    return {
      text: JSON.stringify({
        ok: false,
        error: {
          code: -32601,
          message: "Unsupported tool: only founder_decision_raise is permitted",
        },
      }),
      isError: true,
    };
  }
  if (request.raiseDecision === undefined) {
    return {
      text: JSON.stringify({
        ok: false,
        error: {
          code: -32010,
          message: "Evidence invalid: founder_decision_raise requires an active engine turn",
        },
      }),
      isError: true,
    };
  }
  const rawArgs = call.arguments;
  const input =
    typeof rawArgs === "object" && rawArgs !== null && !Array.isArray(rawArgs)
      ? (Object.fromEntries(Object.entries(rawArgs)) as unknown as ProviderDecisionRaiseInput)
      : (rawArgs as unknown as ProviderDecisionRaiseInput);
  const outcome = request.raiseDecision(input);
  return {
    text: JSON.stringify(outcome),
    isError: !outcome.ok,
  };
}

/**
 * Wire apis a direct-key lane can speak through pi-ai (registry `wire` field drives the choice).
 * M1-A3: `anthropic-messages` (kimi) and `openai-completions` (ollama). M1-A4 adds the three wire
 * styles its four built-in lanes use: `mistral-conversations` (mistral), `google-generative-ai`
 * (google) and `openai-responses` (xai); deepseek reuses `openai-completions`.
 */
export type DirectWireApi =
  | "anthropic-messages"
  | "openai-completions"
  | "mistral-conversations"
  | "google-generative-ai"
  | "openai-responses";

/** HTTP statuses mapped to the recorded `quota-or-unreachable` signal (plan M1-A3, pin P5). */
export const QUOTA_OR_UNREACHABLE_STATUSES: readonly number[] = Object.freeze([429, 502]);

export type PinnedModelResolution =
  | { readonly ok: true; readonly modelId: string }
  | { readonly ok: false; readonly issue: string };

/**
 * A lane's credential-class verdict (M1-A5, Founder ruling 12). `issue` names the lane and the rule
 * and NEVER the credential value, so it is safe for stderr.
 */
export type CredentialCheck =
  | { readonly ok: true }
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
  /**
   * M1-A5: the model record for a lane that has NEITHER a pinned pi-ai catalog NOR a listing
   * endpoint (the Alibaba Coding Plan). The requested id is passed through as-is and the vendor's
   * reply is the only model truth; the record carries no invented metadata. Consulted only when
   * the static catalog does not list the id; a lane never sets both this and `refreshProvider`.
   */
  readonly unlistedModel?: (modelId: string) => Model<DirectWireApi>;
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

/**
 * The HTTP status pi-ai 0.87.1 reports for a failed provider call, across every wire a direct-key
 * lane can speak. Its `utils/error-body.js` `formatProviderError` emits one of:
 *
 * - `"<status>: <body>"` — no prefix; caught by {@link leadingHttpStatus} (M1-A3's lanes).
 * - `"<prefix> (<status>): <body>"` — with a prefix, e.g. `"xai API error (502): 502 \"…\""`. The
 *   status is NOT leading here, so M1-A3's extractor alone would lose it and a 429/502 on the xAI
 *   lane would never map to the recorded `quota-or-unreachable` signal (protocol pin §5 P5).
 * - the upstream message unchanged, when pi-ai decides the message already carries the body — in
 *   which case NO status is recoverable. Verified on the `google-generative-ai` wire, where the
 *   `@google/genai` error message is the raw error body: a 429 there yields `null`. That is a
 *   limitation of the pinned pi-ai, not of this port, and it is asserted as such in the Gemini
 *   conformance test rather than papered over by guessing a status out of an upstream body.
 *
 * Only the status is kept; the body (which may echo request content) is never propagated.
 */
export function providerErrorStatus(errorMessage: string | undefined): number | null {
  const leading = leadingHttpStatus(errorMessage);
  if (leading !== null) return leading;
  const prefixed = /\(([1-5]\d\d)\)/.exec(errorMessage ?? "");
  return prefixed?.[1] === undefined ? null : Number(prefixed[1]);
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
    if (model !== undefined && model.api === config.api) return model as Model<DirectWireApi>;
    const unlisted = config.unlistedModel?.(modelId);
    return unlisted !== undefined && unlisted.api === config.api ? unlisted : undefined;
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
      const timestamp = Date.now();
      const conversationMessages: Message[] = request.messages.map((m) => ({
        role: "user" as const,
        content: m.text,
        timestamp,
      }));

      let accumulatedText = "";
      let final: AssistantMessage | undefined;
      let toolRounds = 0;

      while (true) {
        let status: number | null = null;
        const stream = catalog.stream(
          target,
          {
            ...(request.systemPrompt === undefined ? {} : { systemPrompt: request.systemPrompt }),
            messages: conversationMessages,
            tools: [...DIRECT_LANE_TOOLS],
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
            status ?? providerErrorStatus(final.errorMessage),
            final.stopReason === "aborted",
          );
        }

        accumulatedText += final.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("");

        const toolCalls = final.content.filter(
          (part): part is ToolCall => part.type === "toolCall",
        );
        if (toolCalls.length === 0) {
          break;
        }
        if (toolRounds >= MAX_DECISION_TOOL_ROUNDS) {
          throw failure(config, request.signal, null);
        }
        toolRounds += 1;
        conversationMessages.push(final);
        const resultTimestamp = Date.now();
        for (const call of toolCalls) {
          const outcome = executeDecisionToolCall(call, request);
          conversationMessages.push({
            role: "toolResult",
            toolCallId: call.id,
            toolName: call.name,
            content: [{ type: "text", text: outcome.text }],
            isError: outcome.isError,
            timestamp: resultTimestamp,
          });
        }
      }

      const servedModel = final.responseModel ?? model.id;
      // OpenAI-compat lanes: pi-ai fills responseModel from the first chunk's `model` — the vendor
      // reported an identity even when it equals the requested id. Anthropic lanes omit the key so
      // the M0 three-key result shape is untouched (the engine derives vendorReported there).
      //
      // M1-A4 note (verified against pi-ai 0.87.1, so no test asserts what the wire cannot
      // deliver): in the whole pinned package only `api/openai-completions.js` and
      // `api/anthropic-messages.js` ever assign `responseModel`. So of the four A4 lanes only
      // DeepSeek (openai-completions) can surface a vendor-reported identity; `mistral-
      // conversations`, `google-generative-ai` and `openai-responses` leave it undefined even
      // though their real responses do carry a model field. Those three receipts therefore record
      // the requested model with `vendorReported: false`, which is what protocol pin §5's honesty
      // rule requires — the condition below is already correct for all four and needs no widening.
      const vendorReported =
        config.api === "openai-completions" && final.responseModel !== undefined
          ? { vendorReported: true as const }
          : {};
      return {
        text: accumulatedText,
        requestedModelId: model.id,
        servedModel,
        ...vendorReported,
      };
    },
  });
}
