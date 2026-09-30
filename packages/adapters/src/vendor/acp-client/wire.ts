/**
 * ACP wire subset (Act M1-A6): the pure half of the generic Agent Client Protocol client — message
 * shapes and the mappers from ACP to MAD. No I/O here; `client.ts` owns the child process.
 *
 * Source: Agent Client Protocol schema v1 (`protocolVersion: 1`), github.com/agentclientprotocol/
 * agent-client-protocol `schema/v1/schema.json` as read on 2026-09-30. Only what a text-only MAD
 * turn needs is modelled; everything else a vendor agent sends is ignored or, for agent→client
 * requests, refused (`-32601`). ACP is adapter-internal: the MAD native protocol never speaks it
 * (ADR-0002, protocol pin §7).
 */
import type { ProviderToolEvent } from "../../provider-port.ts";

/** The only ACP major version this client speaks. */
export const ACP_PROTOCOL_VERSION = 1;

/** ACP `auth_required` (schema v1 `ErrorCode`): the agent needs `authenticate` first. */
export const ACP_AUTH_REQUIRED = -32000;

/** JSON-RPC "method not found": the answer to every agent→client request MAD does not serve. */
export const JSONRPC_METHOD_NOT_FOUND = -32601;

/**
 * What MAD tells the agent it can do for it: nothing. No file-system or terminal methods are
 * served (MAD has no approval surface and never lends its filesystem to a vendor agent in M1), so
 * a conforming agent never calls them; one that does gets `-32601`.
 */
export const ACP_CLIENT_CAPABILITIES = Object.freeze({
  fs: Object.freeze({ readTextFile: false, writeTextFile: false }),
  terminal: false,
});

/** An agent-advertised auth method (`InitializeResponse.authMethods[]`). */
export type AcpAuthMethod = { readonly id: string };

/** The method a spec picks for `authenticate`, plus the optional `_meta` the vendor documents. */
export type AcpAuthChoice = {
  readonly methodId: string;
  readonly meta?: Readonly<Record<string, unknown>>;
};

/** ACP v1 `StopReason`. */
export type AcpStopReason =
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "cancelled";

/**
 * Stop reasons that end the vendor turn normally (the agent answered, possibly truncated or with
 * a refusal): the MAD turn completes with whatever text arrived. `cancelled` is only a success
 * signal for an interrupt MAD itself requested, and any other value fails the turn.
 */
export const ACP_ANSWERED_STOP_REASONS: ReadonlySet<string> = new Set([
  "end_turn",
  "max_tokens",
  "max_turn_requests",
  "refusal",
]);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** `InitializeResponse.authMethods`, keeping only well-formed entries (ids are opaque strings). */
export function authMethodsOf(initResult: unknown): readonly AcpAuthMethod[] {
  if (!isRecord(initResult) || !Array.isArray(initResult.authMethods)) return [];
  const methods: AcpAuthMethod[] = [];
  for (const method of initResult.authMethods) {
    const id = isRecord(method) ? nonEmptyString(method.id) : null;
    if (id !== null) methods.push({ id });
  }
  return methods;
}

/**
 * The model identity an agent REPORTED, or null. Two explicit report shapes are read, nothing is
 * inferred (protocol pin §5 P2: `vendorReported` is true only when the agent reports a model):
 *
 * - ACP v1: a `configOptions[]` entry with `category: "model"` and `type: "select"` — its
 *   `currentValue` is the session's model (`NewSessionResponse.configOptions`, and every
 *   `config_option_update` notification).
 * - The pre-`configOptions` unstable ACP `SessionModelState`: `models.currentModelId` on the
 *   `session/new` result, which agents built against that draft still send.
 *
 * `value` is a `session/new` result or a `config_option_update` update object.
 */
export function reportedModelOf(value: unknown): string | null {
  if (!isRecord(value)) return null;
  if (Array.isArray(value.configOptions)) {
    for (const option of value.configOptions) {
      if (!isRecord(option) || option.category !== "model" || option.type !== "select") continue;
      const current = nonEmptyString(option.currentValue);
      if (current !== null) return current;
    }
  }
  if (isRecord(value.models)) {
    const current = nonEmptyString(value.models.currentModelId);
    if (current !== null) return current;
  }
  return null;
}

/**
 * MAD's answer to `session/request_permission` (M1 approval posture). MAD has no approval surface
 * in M1 — approvals as server requests are not in the native protocol (protocol pin §6) and the
 * seat's `tools.allow` list is deferred (seat pin §2: "unknown = ask in interactive, deny in
 * headless", and MAD cannot ask) — so every request is REFUSED: the agent's `reject_once` option
 * when it offers one (a one-off refusal that persists nothing in the vendor's own settings), else
 * the `cancelled` outcome. After MAD sent `session/cancel` the answer is always `cancelled`, as ACP
 * requires. An allow option is never selected.
 */
export function permissionOutcome(
  params: unknown,
  cancelling: boolean,
): { readonly outcome: "selected"; readonly optionId: string } | { readonly outcome: "cancelled" } {
  if (!cancelling && isRecord(params) && Array.isArray(params.options)) {
    for (const option of params.options) {
      if (!isRecord(option) || option.kind !== "reject_once") continue;
      const optionId = nonEmptyString(option.optionId);
      if (optionId !== null) return { outcome: "selected", optionId };
    }
  }
  return { outcome: "cancelled" };
}

/** One `session/update` notification, reduced to what a MAD turn uses. */
export type AcpUpdate =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "tool"; readonly update: Readonly<Record<string, unknown>> }
  | { readonly kind: "model"; readonly modelId: string }
  | { readonly kind: "ignored" };

const IGNORED: AcpUpdate = Object.freeze({ kind: "ignored" });

/**
 * Maps one `session/update` params object for `sessionId`. Agent text chunks become deltas;
 * `tool_call` / `tool_call_update` feed the tool tracker; a `config_option_update` that reports
 * the model updates the receipt. Thoughts, plans, usage, commands, modes and every other update
 * kind are dropped (protocol pin §6: no reasoning / plan item kinds in M1). Non-text content
 * blocks are dropped (M1 turns are text only).
 */
export function parseSessionUpdate(params: unknown, sessionId: string): AcpUpdate {
  if (!isRecord(params) || params.sessionId !== sessionId || !isRecord(params.update)) {
    return IGNORED;
  }
  const update = params.update;
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const content = update.content;
      if (!isRecord(content) || content.type !== "text") return IGNORED;
      const text = nonEmptyString(content.text);
      return text === null ? IGNORED : { kind: "text", text };
    }
    case "tool_call":
    case "tool_call_update":
      return nonEmptyString(update.toolCallId) === null ? IGNORED : { kind: "tool", update };
    case "config_option_update": {
      const modelId = reportedModelOf(update);
      return modelId === null ? IGNORED : { kind: "model", modelId };
    }
    default:
      return IGNORED;
  }
}

/**
 * Text of a tool call's `content` collection (ACP `ToolCallContent[]`): text content blocks in
 * order; a diff or an embedded terminal is named, never inlined. Falls back to `rawOutput` (a
 * string verbatim, anything else as JSON) when the content carries no text.
 */
export function toolOutputText(content: unknown, rawOutput: unknown): string {
  const parts: string[] = [];
  if (Array.isArray(content)) {
    for (const entry of content) {
      if (!isRecord(entry)) continue;
      if (entry.type === "content" && isRecord(entry.content) && entry.content.type === "text") {
        const text = nonEmptyString(entry.content.text);
        if (text !== null) parts.push(text);
      } else if (entry.type === "diff") {
        const path = nonEmptyString(entry.path);
        if (path !== null) parts.push(`[diff] ${path}`);
      } else if (entry.type === "terminal") {
        const terminalId = nonEmptyString(entry.terminalId);
        if (terminalId !== null) parts.push(`[terminal] ${terminalId}`);
      }
    }
  }
  if (parts.length > 0) return parts.join("\n");
  if (typeof rawOutput === "string") return rawOutput;
  if (rawOutput === undefined || rawOutput === null) return "";
  try {
    return JSON.stringify(rawOutput) ?? "";
  } catch {
    return "";
  }
}

type TrackedCall = {
  name: string;
  arguments: unknown;
  content: unknown;
  rawOutput: unknown;
  done: boolean;
};

/**
 * Folds ACP `tool_call` / `tool_call_update` notifications into ordered MAD tool events. ACP
 * updates REPLACE the fields they carry, so the tracker keeps the latest name, input, content and
 * output per `toolCallId`. The first sight of an id emits `call`; the first terminal status
 * (`completed` / `failed`) emits `result` once (`isError` iff `failed`). A call's name is the
 * agent's `name` when it sends one, else its human `title`, else its `kind`.
 */
export function createToolTracker(emit: (event: ProviderToolEvent) => void): {
  readonly apply: (update: Readonly<Record<string, unknown>>) => void;
} {
  const calls = new Map<string, TrackedCall>();
  return Object.freeze({
    apply(update: Readonly<Record<string, unknown>>): void {
      const callId = nonEmptyString(update.toolCallId);
      if (callId === null) return;
      let call = calls.get(callId);
      const name =
        nonEmptyString(update.name) ?? nonEmptyString(update.title) ?? nonEmptyString(update.kind);
      if (call === undefined) {
        call = {
          name: name ?? "tool",
          arguments: "rawInput" in update ? (update.rawInput ?? null) : null,
          content: update.content,
          rawOutput: update.rawOutput,
          done: false,
        };
        calls.set(callId, call);
        emit({ kind: "call", callId, name: call.name, arguments: call.arguments });
      } else {
        if (call.done) return;
        if (name !== null) call.name = name;
        if ("rawInput" in update) call.arguments = update.rawInput ?? null;
        if ("content" in update) call.content = update.content;
        if ("rawOutput" in update) call.rawOutput = update.rawOutput;
      }
      if (update.status === "completed" || update.status === "failed") {
        call.done = true;
        emit({
          kind: "result",
          callId,
          name: call.name,
          arguments: call.arguments,
          output: toolOutputText(call.content, call.rawOutput),
          isError: update.status === "failed",
        });
      }
    },
  });
}
