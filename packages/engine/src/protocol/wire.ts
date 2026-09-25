import { invalidRequest, parseError, type RpcError } from "./errors.ts";
import type { OutgoingMessage, RequestId } from "./types.ts";

/** One classified stdin line (protocol pin §1). */
export type Incoming =
  | { kind: "request"; id: RequestId; method: string; params: unknown }
  | { kind: "notification"; method: string; params: unknown }
  | { kind: "invalid"; id: RequestId | null; error: RpcError };

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRequestId(value: unknown): value is RequestId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

/**
 * Parse one newline-delimited JSON message. Returns `null` for blank lines.
 * Accepts messages with or without `"jsonrpc":"2.0"`; any other `jsonrpc` value is invalid.
 */
export function parseLine(line: string): Incoming | null {
  if (line.trim() === "") return null;

  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { kind: "invalid", id: null, error: parseError() };
  }

  if (!isPlainObject(raw)) {
    return { kind: "invalid", id: null, error: invalidRequest("Message must be a JSON object") };
  }

  const hasId = Object.hasOwn(raw, "id");
  const id = hasId && isRequestId(raw.id) ? raw.id : null;

  if (hasId && id === null) {
    return { kind: "invalid", id: null, error: invalidRequest("id must be a number or string") };
  }
  if (raw.jsonrpc !== undefined && raw.jsonrpc !== "2.0") {
    return { kind: "invalid", id, error: invalidRequest('jsonrpc, when present, must be "2.0"') };
  }
  if (typeof raw.method !== "string" || raw.method === "") {
    return { kind: "invalid", id, error: invalidRequest("method must be a non-empty string") };
  }

  if (id !== null) {
    return { kind: "request", id, method: raw.method, params: raw.params };
  }
  return { kind: "notification", method: raw.method, params: raw.params };
}

/** Serialize one outgoing message as a single JSONL line. The engine never emits `jsonrpc`. */
export function encodeMessage(message: OutgoingMessage): string {
  return `${JSON.stringify(message)}\n`;
}
