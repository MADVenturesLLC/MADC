/**
 * Shared wire validators for the one-shot and the Witness app (DESIGN-SPEC §5.10 E-d: the app
 * applies erratum §3b's checks unchanged to its own connection). Moved verbatim from
 * `oneshot.ts` so both entry paths classify engine messages with the same code; `oneshot.ts`
 * re-exports `classifyMessage` for its existing importers.
 */
import {
  EngineRpcError,
  ITEM_KINDS,
  type Item,
  type ItemStatus,
  listCatalog,
  type Thread,
  type Turn,
  type WireMessage,
} from "@madc/engine/client";

/**
 * Erratum §3e E11: in human mode, engine-supplied text written to stdout or stderr has every C0
 * control character except TAB and LF, plus DEL and the C1 range, replaced with U+FFFD (no ANSI
 * injection from a model). `--json` carries text verbatim.
 */
export { stripControls } from "./sanitize.ts";

/**
 * Runtime shape check of one wire item (Copilot r4108764755): the fields the CLI reads must have
 * their pinned types, so nothing malformed reaches the renderers.
 */
const ITEM_STATUSES: readonly ItemStatus[] = ["inProgress", "completed", "failed"];

/** Protocol pin §1 "IDs": domain ids are opaque strings of this grammar before any path join. */
const DOMAIN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const isDomainId = (v: unknown): v is string => typeof v === "string" && DOMAIN_ID.test(v);

/**
 * Erratum §3b N6 (D-188), widened by M1-A3 per seat pin S1 / protocol pin §5 P2: a servedModel
 * `backing` is any WIRED registry id (M0's closed three-literal list grew `ollama-cloud` when its
 * adapter landed; A4+ lanes join by registry flip, not by CLI edit). The catalog is frozen data,
 * so this set is computed once. Shared with the Witness app via this module.
 */
const SERVED_MODEL_BACKINGS: ReadonlySet<string> = new Set(
  listCatalog()
    .filter((entry) => entry.wired)
    .map((entry) => entry.id),
);

export function isItemShape(i: unknown): i is Item {
  if (i === null || typeof i !== "object") return false;
  const r = i as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.kind !== "string" || typeof r.status !== "string") {
    return false;
  }
  // Item.id is a domain id (protocol pin §1 "IDs"): `../x` and friends are protocol violations.
  if (!isDomainId(r.id)) return false;
  // Copilot r4109396318: `kind` and `status` must be members of the pinned unions.
  if (!(ITEM_KINDS as readonly string[]).includes(r.kind)) return false;
  if (!(ITEM_STATUSES as readonly string[]).includes(r.status)) return false;
  // Per-kind fields (PR #35 round 7, Copilot r4136804197): every field the renderers read must
  // have its pinned type, so a malformed toolCall/toolResult/error/userMessage is classified as
  // a protocol violation by the wait matchers — never pushed into a turn record where the
  // renderers call e.g. `output.split` on a non-string.
  if (r.kind === "agentMessage") return typeof r.text === "string";
  if (r.kind === "userMessage") {
    return (
      Array.isArray(r.content) &&
      r.content.every(
        (c) =>
          c !== null &&
          typeof c === "object" &&
          (c as Record<string, unknown>).type === "text" &&
          typeof (c as Record<string, unknown>).text === "string",
      )
    );
  }
  if (r.kind === "toolCall") {
    return typeof r.name === "string" && r.arguments !== undefined;
  }
  if (r.kind === "toolResult") {
    return (
      typeof r.callId === "string" &&
      typeof r.name === "string" &&
      typeof r.output === "string" &&
      typeof r.isError === "boolean"
    );
  }
  if (r.kind === "error") {
    return typeof r.message === "string" && (r.code === undefined || Number.isInteger(r.code));
  }
  if (r.kind === "servedModel") {
    return (
      typeof r.requestedModel === "string" &&
      typeof r.servedModel === "string" &&
      typeof r.backing === "string" &&
      SERVED_MODEL_BACKINGS.has(r.backing) &&
      typeof r.providerId === "string"
    );
  }
  return false;
}

export function isErrorBody(e: unknown): boolean {
  if (e === null || typeof e !== "object") return false;
  const r = e as Record<string, unknown>;
  return Number.isInteger(r.code) && typeof r.message === "string";
}

/** Minimal runtime shape check of a `Turn` from the wire (fields the CLI reads). */
export function isTurnShape(t: unknown): t is Turn {
  if (t === null || typeof t !== "object") return false;
  const r = t as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.threadId === "string" &&
    typeof r.status === "string" &&
    Array.isArray(r.items) &&
    r.items.every(isItemShape) &&
    typeof r.startedAt === "number" &&
    (r.completedAt === null || typeof r.completedAt === "number") &&
    // Copilot r4108941737: `error` is required, and is null or an RPC error body.
    Object.hasOwn(r, "error") &&
    (r.error === null || isErrorBody(r.error)) &&
    // Protocol type: `error` is set iff the status is `failed` (Copilot r4109224803), so a
    // `completed` turn carrying an error can never map to exit 0. Status strings stay verbatim.
    (r.status === "failed") === (r.error !== null)
  );
}

/** Protocol pin §5 ThreadStatus. */
const THREAD_STATUSES: readonly string[] = ["idle", "active", "closed"];

/**
 * Full `Thread` shape check (erratum §3b N5/N7, protocol pin §5): every field the pin lists, with
 * `seatId` equal to the seat the CLI asked for.
 */
export function isThreadShape(t: unknown, seatId: string): t is Thread {
  if (t === null || typeof t !== "object") return false;
  const r = t as Record<string, unknown>;
  return (
    isDomainId(r.id) &&
    isDomainId(r.seatId) &&
    r.seatId === seatId &&
    (typeof r.cwd === "string" || r.cwd === null) &&
    typeof r.createdAt === "number" &&
    typeof r.updatedAt === "number" &&
    typeof r.status === "string" &&
    THREAD_STATUSES.includes(r.status) &&
    typeof r.preview === "string"
  );
}

/**
 * Erratum §3b "well-formed message": every object in `client.messages` is a notification, a
 * response, or malformed (N2–N4). The `jsonrpc` field is neither required nor checked.
 * Accepts `unknown` and never throws (Copilot PR #23): a non-object JSON value classifies as the
 * N4-style malformed case. (The client already routes non-object lines to `protocolViolations`
 * instead of `messages`; this is belt-and-braces.)
 */
export type MessageClass =
  | { readonly kind: "ok" }
  | { readonly kind: "n2" } // both an id and a method
  | { readonly kind: "n3" } // neither a method nor an id
  | { readonly kind: "n4"; readonly malformedError: boolean }; // any other malformed object

export function classifyMessage(m: unknown): MessageClass {
  if (m === null || typeof m !== "object" || Array.isArray(m)) {
    return { kind: "n4", malformedError: false };
  }
  const w = m as WireMessage;
  const hasId = Object.hasOwn(w, "id");
  const hasMethod = Object.hasOwn(w, "method");
  if (hasId && hasMethod) return { kind: "n2" };
  if (!hasId && !hasMethod) return { kind: "n3" };
  if (hasMethod) {
    // A notification: `method` must be a string (there is no own id key here).
    return typeof w.method === "string" ? { kind: "ok" } : { kind: "n4", malformedError: false };
  }
  // A response: own id that is a number or a string, or null together with `error`; exactly one
  // of own `result` and own `error`; an error is an integer code plus a string message.
  if (typeof w.id !== "number" && typeof w.id !== "string" && w.id !== null) {
    return { kind: "n4", malformedError: false };
  }
  const hasResult = Object.hasOwn(w, "result");
  const hasError = Object.hasOwn(w, "error");
  if (hasResult === hasError) return { kind: "n4", malformedError: false };
  if (w.id === null && !hasError) return { kind: "n4", malformedError: false };
  if (hasError && !isErrorBody(w.error)) return { kind: "n4", malformedError: true };
  return { kind: "ok" };
}

export function violationMessage(c: Exclude<MessageClass, { kind: "ok" }>): string {
  switch (c.kind) {
    case "n2":
      return "protocol violation: engine message with both id and method";
    case "n3":
      return "protocol violation: engine message with neither method nor id";
    case "n4":
      return c.malformedError
        ? "protocol violation: malformed error response"
        : "protocol violation: malformed engine message";
  }
}

export { isDomainId };

/**
 * thread/start failure classification (DESIGN-SPEC §5.11 table + §7 seat rows), shared by
 * tier W, Level A and inline:
 * - RPC -32005/-32006/-32602 (seat)            → exit 2 (usage)
 * - RPC -32009                                 → exit 5 (session)
 * - any other RPC code, protocol errors, engine exit, malformed responses and every other
 *   non-RPC failure                            → exit 3 (engine)
 * The label is the receipt/pre-thread class word ("usage" | "session" | "engine").
 */
export function classifyThreadStartFailure(err: unknown): {
  readonly exit: number;
  readonly label: "usage" | "session" | "engine";
  readonly code: number | null;
} {
  if (err instanceof EngineRpcError) {
    if (err.code === -32005 || err.code === -32006 || err.code === -32602) {
      return { exit: 2, label: "usage", code: err.code };
    }
    if (err.code === -32009) return { exit: 5, label: "session", code: err.code };
    return { exit: 3, label: "engine", code: err.code };
  }
  return { exit: 3, label: "engine", code: null };
}
