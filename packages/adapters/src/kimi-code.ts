/**
 * Kimi Code backing (plan D2): the only module in MADC that imports `@earendil-works/pi-ai`.
 *
 * Honesty rules enforced here:
 * - The request identifies itself as MADC (`User-Agent: madc/…`); pi-ai's default UA is replaced and
 *   no other client is impersonated.
 * - Only API keys are accepted. Claude subscription OAuth tokens (`sk-ant-oat…`) are refused before
 *   any request, because pi-ai would otherwise send Claude Code identity headers for them.
 * - The key is passed explicitly per request; pi-ai's ambient credential lookup is never relied on
 *   and error messages never carry upstream text or the key.
 */
import { type AssistantMessage, createModels, type Model } from "@earendil-works/pi-ai";
import { kimiCodingProvider } from "@earendil-works/pi-ai/providers/kimi-coding";
import {
  ProviderCallError,
  type ProviderPort,
  type ProviderTurnRequest,
  type ProviderTurnResult,
} from "./provider-port.ts";

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

export type PinnedModelResolution =
  | { readonly ok: true; readonly modelId: string }
  | { readonly ok: false; readonly issue: string };

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
  return Object.freeze({
    providerId: KIMI_CODE_PROVIDER_ID,
    streamTurn: (request: ProviderTurnRequest) => streamKimiTurn(options, request),
  });
}

async function streamKimiTurn(
  options: KimiCodePortOptions,
  request: ProviderTurnRequest,
): Promise<ProviderTurnResult> {
  const model = catalogModel(request.modelId);
  if (model === undefined) {
    throw new ProviderCallError("failed", null, `Unknown kimi-coding model "${request.modelId}"`);
  }
  const target = options.baseUrl === undefined ? model : { ...model, baseUrl: options.baseUrl };
  let status: number | null = null;
  const timestamp = Date.now();
  const stream = catalog.stream(
    target,
    {
      ...(request.systemPrompt === undefined ? {} : { systemPrompt: request.systemPrompt }),
      messages: request.messages.map((m) => ({ role: "user", content: m.text, timestamp })),
    },
    {
      apiKey: options.apiKey,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      // Provider-scoped env: keeps pi-ai from consulting ambient process env for this request.
      env: {},
      signal: request.signal,
      headers: { "User-Agent": options.userAgent },
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
    throw failure(request.signal, status);
  }
  if (final.stopReason === "error" || final.stopReason === "aborted") {
    throw failure(
      request.signal,
      status ?? leadingHttpStatus(final.errorMessage),
      final.stopReason === "aborted",
    );
  }
  const text = final.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
  return {
    text,
    requestedModelId: model.id,
    servedModel: final.responseModel ?? model.id,
  };
}

/**
 * pi-ai's `errorMessage` is `"<status> <upstream body>"` for HTTP errors. Only the leading status
 * code is kept; the upstream body (which may echo request content) is discarded.
 */
function leadingHttpStatus(errorMessage: string | undefined): number | null {
  const match = /^([1-5]\d\d)\b/.exec(errorMessage ?? "");
  return match?.[1] === undefined ? null : Number(match[1]);
}

function failure(signal: AbortSignal, status: number | null, aborted = false): ProviderCallError {
  if (aborted || signal.aborted) {
    return new ProviderCallError("aborted", status, "kimi-code request aborted");
  }
  const suffix = status !== null && (status < 200 || status >= 300) ? ` (HTTP ${status})` : "";
  return new ProviderCallError("failed", status, `kimi-code request failed${suffix}`);
}
