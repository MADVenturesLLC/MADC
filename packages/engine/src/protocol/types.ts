/**
 * MAD native protocol types — docs/plan/PIN-madc-M1-protocol-messages.md §3 and §5 (supersedes the
 * frozen M0 pin for M1 work). Wire is camelCase everywhere. The engine omits `jsonrpc` on output;
 * parsers accept it either way.
 */

/** P1: the M1-only methods of §3.5 exist only under `madc-m1/1`; all M0 methods and codes are unchanged. */
export const PROTOCOL_VERSION = "madc-m1/1" as const;
export const SERVER_NAME = "madc-engine" as const;
/** D4: built-in seat used when `thread/start.seatId` is omitted. */
export const DEFAULT_SEAT_ID = "madc-default" as const;

export type RequestId = number | string;

// ---------------------------------------------------------------------------
// §5 shapes
// ---------------------------------------------------------------------------

export type ThreadStatus = "idle" | "active" | "closed";

export type Thread = {
  id: string;
  seatId: string;
  cwd: string | null;
  createdAt: number;
  updatedAt: number;
  status: ThreadStatus;
  preview: string;
};

export type ThreadSummary = Pick<
  Thread,
  "id" | "seatId" | "createdAt" | "updatedAt" | "preview" | "status"
>;

export type TurnStatus = "inProgress" | "completed" | "interrupted" | "failed";

export type RpcErrorBody = { code: number; message: string; data?: Record<string, unknown> };

export type Turn = {
  id: string;
  threadId: string;
  status: TurnStatus;
  items: Item[];
  /** Set iff status === "failed". */
  error: RpcErrorBody | null;
  startedAt: number;
  completedAt: number | null;
};

export type ItemKind =
  | "userMessage"
  | "agentMessage"
  | "toolCall"
  | "toolResult"
  | "error"
  | "servedModel";

export const ITEM_KINDS: readonly ItemKind[] = Object.freeze([
  "userMessage",
  "agentMessage",
  "toolCall",
  "toolResult",
  "error",
  "servedModel",
]);

export type ItemStatus = "inProgress" | "completed" | "failed";

export type ItemBase = {
  id: string;
  kind: ItemKind;
  status: ItemStatus;
};

export type TextContent = { type: "text"; text: string };

export type UserMessageItem = ItemBase & {
  kind: "userMessage";
  content: TextContent[];
};

export type AgentMessageItem = ItemBase & {
  kind: "agentMessage";
  text: string;
};

export type ToolCallItem = ItemBase & {
  kind: "toolCall";
  name: string;
  arguments: unknown;
};

export type ToolResultItem = ItemBase & {
  kind: "toolResult";
  callId: string;
  name: string;
  output: string;
  isError: boolean;
};

export type ErrorItem = ItemBase & {
  kind: "error";
  message: string;
  code?: number;
};

export type ServedModelBacking = "kimi-code" | "claude-code" | "codex";

/** MAD receipt — not a Codex field. One per model invocation in the turn. */
export type ServedModelItem = ItemBase & {
  kind: "servedModel";
  requestedModel: string;
  servedModel: string;
  backing: ServedModelBacking;
  providerId: string;
};

export type Item =
  | UserMessageItem
  | AgentMessageItem
  | ToolCallItem
  | ToolResultItem
  | ErrorItem
  | ServedModelItem;

// ---------------------------------------------------------------------------
// §3 methods
// ---------------------------------------------------------------------------

/** M0 UserInput: text only. */
export type UserInput = TextContent;

export type ClientInfo = { name: string; title?: string; version: string };

export type InitializeParams = { clientInfo: ClientInfo };
export type InitializeResult = {
  serverInfo: { name: typeof SERVER_NAME; version: string };
  protocolVersion: typeof PROTOCOL_VERSION;
};

export type ThreadStartParams = { seatId?: string; cwd?: string };
export type ThreadStartResult = { thread: Thread };

export type ThreadResumeParams = { threadId: string };
export type ThreadResumeResult = { thread: Thread };

export type ThreadListParams = { limit?: number; cursor?: string };
export type ThreadListResult = { data: ThreadSummary[]; nextCursor: string | null };

export type TurnStartParams = { threadId: string; input: UserInput[] };
export type TurnStartResult = { turn: Turn };

export type TurnInterruptParams = { threadId: string; turnId: string };
export type TurnInterruptResult = Record<string, never>;

export type AuthStatusParams = { providerId: string };
/**
 * §3.5, exact pinned shape: presence only, NEVER a value (and no other field — where a credential
 * resolves from, `keychain` vs the `MADC_DEV_ENV_KEYS=1` env fallback, stays engine-internal;
 * `madc doctor` discloses the fallback from its own environment).
 */
export type AuthStatusResult = {
  providerId: string;
  present: boolean;
};

export type AuthRemoveParams = { providerId: string };
export type AuthRemoveResult = Record<string, never>;

/** Client → server requests (complete M0 list plus the M1-A2 `auth/*` presence methods). */
export type ClientRequests = {
  initialize: { params: InitializeParams; result: InitializeResult };
  "thread/start": { params: ThreadStartParams; result: ThreadStartResult };
  "thread/resume": { params: ThreadResumeParams; result: ThreadResumeResult };
  "thread/list": { params: ThreadListParams; result: ThreadListResult };
  "turn/start": { params: TurnStartParams; result: TurnStartResult };
  "turn/interrupt": { params: TurnInterruptParams; result: TurnInterruptResult };
  "auth/status": { params: AuthStatusParams; result: AuthStatusResult };
  "auth/remove": { params: AuthRemoveParams; result: AuthRemoveResult };
};

export type ClientRequestMethod = keyof ClientRequests;

/** Client → server notifications. */
export type ClientNotifications = {
  initialized: Record<string, never>;
};

export type ItemNotificationParams = { threadId: string; turnId: string; item: Item };

export type AgentMessageDeltaParams = {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
};

/** Server → client notifications. */
export type ServerNotifications = {
  "thread/started": { thread: Thread };
  "turn/started": { turn: Turn };
  "turn/completed": { turn: Turn };
  "item/started": ItemNotificationParams;
  "item/completed": ItemNotificationParams;
  "item/agentMessage/delta": AgentMessageDeltaParams;
};

export type ServerNotificationMethod = keyof ServerNotifications;

export const CLIENT_REQUEST_METHODS: readonly ClientRequestMethod[] = Object.freeze([
  "initialize",
  "thread/start",
  "thread/resume",
  "thread/list",
  "turn/start",
  "turn/interrupt",
  "auth/status",
  "auth/remove",
]);

/**
 * Declared top-level params fields per request method (M1-A2 schema test, protocol pin §3.5: "No
 * `auth/set` over JSONL … No JSONL method accepts a secret value"). Keys are exactly
 * `CLIENT_REQUEST_METHODS`; no field may carry a secret.
 */
export const CLIENT_REQUEST_PARAM_FIELDS: Readonly<Record<ClientRequestMethod, readonly string[]>> =
  Object.freeze({
    initialize: ["clientInfo"],
    "thread/start": ["seatId", "cwd"],
    "thread/resume": ["threadId"],
    "thread/list": ["limit", "cursor"],
    "turn/start": ["threadId", "input"],
    "turn/interrupt": ["threadId", "turnId"],
    "auth/status": ["providerId"],
    "auth/remove": ["providerId"],
  });

// ---------------------------------------------------------------------------
// Wire envelopes (JSON-RPC 2.0 shape; `jsonrpc` optional on input, omitted on output)
// ---------------------------------------------------------------------------

export type RequestMessage = { jsonrpc?: "2.0"; id: RequestId; method: string; params?: unknown };
export type NotificationMessage = { jsonrpc?: "2.0"; method: string; params?: unknown };
export type SuccessResponse = { id: RequestId; result: unknown };
export type ErrorResponse = { id: RequestId | null; error: RpcErrorBody };
export type ResponseMessage = SuccessResponse | ErrorResponse;
export type OutgoingMessage = ResponseMessage | { method: string; params: unknown };
