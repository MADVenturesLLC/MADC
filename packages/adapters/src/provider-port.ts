/**
 * MAD provider seam. The engine talks to backings only through `ProviderPort`; nothing here imports
 * `@earendil-works/pi-ai` (only `kimi-code.ts` does — plan §6 import rules).
 */

export type ProviderMessage = { readonly role: "user"; readonly text: string };

/**
 * A vendor agent's own tool activity, reported by adapters that can see it (M1-A6: the ACP client
 * maps `tool_call` / `tool_call_update`). `callId` is adapter-scoped and stable for one call; the
 * engine turns a `call` into a `toolCall` item and the matching `result` into a `toolResult` item
 * (protocol pin §5). `arguments` is the latest JSON-serializable input the vendor reported (or
 * null), and a `result` carries it again so the engine can close the call with its final input.
 */
export type ProviderToolEvent =
  | {
      readonly kind: "call";
      readonly callId: string;
      readonly name: string;
      readonly arguments: unknown;
    }
  | {
      readonly kind: "result";
      readonly callId: string;
      readonly name: string;
      readonly arguments: unknown;
      readonly output: string;
      readonly isError: boolean;
    };

export type ProviderTurnRequest = {
  /** Bare catalog model id for the backing's pi-ai provider, e.g. `kimi-for-coding`. */
  readonly modelId: string;
  readonly systemPrompt?: string;
  readonly messages: readonly ProviderMessage[];
  readonly signal: AbortSignal;
  /** Called for every streamed assistant text chunk, in order. */
  onTextDelta(delta: string): void;
  /**
   * M1-A6: called for every vendor tool event, in order, by adapters that surface them (the ACP
   * client). Optional: direct lanes and the M0 vendor adapters never call it.
   */
  onToolEvent?(event: ProviderToolEvent): void;
};

export type ProviderTurnResult = {
  /** Full assistant text (concatenation of streamed text blocks). */
  readonly text: string;
  /** Model id the request asked for (bare catalog id). */
  readonly requestedModelId: string;
  /** Upstream-reported model (`responseModel`) when it differs, else `requestedModelId`. */
  readonly servedModel: string;
  /**
   * Set to `true` only when the adapter KNOWS the vendor reported a model identity — including
   * when it equals the requested id (OpenAI-compat lanes: pi-ai fills `responseModel` from the
   * first chunk's `model` field). Anthropic lanes omit it: pi-ai sets `responseModel` only when
   * it differs, so the engine derives vendor-reporting from `servedModel !== requestedModelId`
   * there (protocol pin §5 P2 honesty rule; M0's three-key result shape stays byte-identical).
   */
  readonly vendorReported?: boolean;
};

export type ProviderPort = {
  /** Registry provider id (== seat `preferredBacking`), e.g. `kimi-code`. */
  readonly providerId: string;
  streamTurn(request: ProviderTurnRequest): Promise<ProviderTurnResult>;
};

/** The pinned -32008 reasons an adapter can attach to a failed call (protocol pin §4.1). */
export type ProviderCallErrorReason = "binary-missing" | "quota-or-unreachable" | "no-credentials";

/**
 * A provider call that did not produce a result. `message` is written by MAD and never contains
 * upstream response text, request headers, or credentials — safe for the wire and for logs.
 */
export class ProviderCallError extends Error {
  readonly kind: "aborted" | "failed";
  /** Upstream HTTP status when one was received. */
  readonly status: number | null;
  /**
   * Pinned -32008 reason when the failure means the provider cannot run at all (A5: the vendor
   * binary vanished between preflight and spawn), or the recorded quota-or-unreachable signal
   * (M1-A3, protocol pin P5: HTTP 429/502 from a direct lane, which the fallback logic consumes),
   * or `no-credentials` when a vendor agent that owns its login reports it has none usable (M1-A6:
   * an ACP agent offering no usable auth method, or refusing `authenticate`). Absent for ordinary
   * call failures (-32603).
   */
  readonly reason?: ProviderCallErrorReason;

  constructor(
    kind: "aborted" | "failed",
    status: number | null,
    message: string,
    reason?: ProviderCallErrorReason,
  ) {
    super(message);
    this.name = "ProviderCallError";
    this.kind = kind;
    this.status = status;
    if (reason !== undefined) this.reason = reason;
  }
}
