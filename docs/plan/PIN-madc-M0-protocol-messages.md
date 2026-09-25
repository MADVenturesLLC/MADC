# PIN: M0 native protocol messages (thread / turn / item)

*Surface Architect · 2026-09-24 · Venue: `MADVenturesLLC/MADC` · Status: **build pin** — gates Hephaestus Act M0-A2. Docs only.*

*Amendment 1 (2026-09-24): lock token, fixes A2 Copilot W1 (PR #7), Founder-authorized.*

**Authority:**

- `docs/plan/PLAN-madc-M0-build-plan.md` — Founder-accepted; on `main` via PR #2, merge commit `9c71afd5c99d44443eecce2a0b4678e90dea6cb0`.
- Founder rulings (2026-09-24, plan §14): **D2** direct-key = Kimi Code · **D3** transport = stdio JSON-RPC · **D4** built-in seat = `madc-default` · **D5** session store = JSONL hash-chain.
- ADR-0002 (ACCEPTED): Codex app-server thread/turn/item is native; ACP is adapter only.
- `packages/registry` on `main` (`c07b43a6d6e6e91f3b47caba35c78beb45633c29`): provider ids, `ProviderStatus`, `DenyReason`, `RegistryDeniedError`.

**Steal:** Codex app-server vocabulary + stdio JSON-RPC lifecycle. **Do not** copy Codex crates, schemas, or UI.

---

## 1. Wire

| Rule | M0 pin |
| --- | --- |
| Transport | **stdio only** (D3) — newline-delimited JSON (JSONL). One message per line on stdin/stdout. |
| Framing | JSON-RPC 2.0 *shape*: request `{ id, method, params? }`, response `{ id, result }` or `{ id, error }`, notification `{ method, params }` (no `id`). |
| `jsonrpc` field | **Omitted** by the engine (Codex app-server convention). Parsers on both sides must accept messages with or without `"jsonrpc":"2.0"`. |
| Encoding | UTF-8. No binary frames. stderr is logs only — never protocol. |
| IDs | Request `id`: number or string. Domain ids (`threadId`, `turnId`, `itemId`) and `seatId`: opaque strings matching `^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$` (no `.`, `/`, `\`, whitespace, or control chars; `thr_…`, `turn_…`, `item_…` recommended). Any other value → `-32602` **before** it is joined into a path. |

Engine process owns the protocol host. CLI is a client only (no loop/tools/adapters in `packages/cli`; plan §6 import rules).

---

## 2. Process ownership

| Actor | Owns |
| --- | --- |
| **Engine** (`packages/engine`) | Protocol host; thread store; turn execution; item stream; seat resolution; registry check (`assertAllowed`); session append. |
| **CLI** (`packages/cli`) | Spawns engine with `stdio: ["pipe","pipe","inherit"]`, speaks protocol, renders UI / one-shot JSON, exits. |
| **Who starts engine** | M0: **CLI spawns child** for interactive or one-shot. No daemon, no WS listener, no Unix-socket control plane. |

Connection lifecycle:

1. Client opens stdio → sends `initialize` → server replies → client sends `initialized`.
2. Any request before `initialize` → `-32000 NotInitialized`.
3. Second `initialize` on same stream → `-32001 AlreadyInitialized`.
4. Client drives `thread/*` then `turn/*`; reads notifications until `turn/completed`.
5. EOF on stdin / process exit ends the connection; an in-flight turn ends `interrupted`.

---

## 3. Methods (complete M0 list)

### 3.1 Handshake

| Method | Kind | Params | Result / notes |
| --- | --- | --- | --- |
| `initialize` | request | `{ clientInfo: { name, title?, version } }` | `{ serverInfo: { name: "madc-engine", version }, protocolVersion: "madc-m0/1" }` |
| `initialized` | notification | `{}` | Client → server; no response |

### 3.2 Threads

| Method | Kind | Params | Result |
| --- | --- | --- | --- |
| `thread/start` | request | `{ seatId?: string, cwd?: string }` | `{ thread: Thread }` |
| `thread/resume` | request | `{ threadId: string }` | `{ thread: Thread }` |
| `thread/list` | request | `{ limit?: number, cursor?: string }` | `{ data: ThreadSummary[], nextCursor: string \| null }` |
| `thread/started` | notification | `{ thread: Thread }` | After start / resume load |

`seatId` defaults to `madc-default` (D4) when omitted.

### 3.3 Turns

| Method | Kind | Params | Result |
| --- | --- | --- | --- |
| `turn/start` | request | `{ threadId, input: UserInput[] }` | `{ turn: Turn }` (status `inProgress`, items `[]`) |
| `turn/interrupt` | request | `{ threadId, turnId }` | `{}` — turn ends `interrupted`; no-op `{}` if the turn already finished |
| `turn/started` | notification | `{ turn: Turn }` | |
| `turn/completed` | notification | `{ turn: Turn }` | Final status + items snapshot |

`UserInput` M0: `{ type: "text", text: string }` only.
**One active turn per thread in M0:** `turn/start` while a turn is `inProgress` on that thread → `-32004 TurnAlreadyActive`.
**Cross-process ownership:** each CLI run spawns its own engine, so the rule is enforced on disk. `thread/start` / `thread/resume` take an exclusive lock `sessions/<threadId>.lock` (create-exclusive) held until the connection ends. Lock body is exactly `{ pid, startedAt, token }`. `token` is 32 lowercase hex chars (128 random bits, e.g. `crypto.randomBytes(16).toString("hex")`), valid iff it matches `^[0-9a-f]{32}$`, generated fresh on every acquisition and never reused. The holder keeps its token in memory. Lock held by a live process → `-32004` with `activeTurnId: null` and `lockHolderPid`. Only the lock holder appends to `sessions/<threadId>.jsonl`. Ownership checks compare `token`; pid + startedAt + inode alone are not unique (Amendment 1):

- **(a) Release** unlinks the lock only if the on-disk body's `token` equals the holder's in-memory token. Otherwise it leaves the file alone.
- **(b) Reclaim** (lock pid dead): rename the lock aside to a unique name (e.g. `sessions/<threadId>.lock.reclaim-<reclaimer token>`), re-read the renamed body, and delete it only if it still matches the observed dead holder's `pid` + `startedAt` + `token` (for a (c) body, the same missing or invalid `token` value). On mismatch, restore it (link or rename back to `sessions/<threadId>.lock`) and treat the thread as locked (`-32004`).
- **(c) Legacy / corrupt body** (`token` missing or not matching `^[0-9a-f]{32}$`): reclaimable via (b) only if its pid is dead. With a live pid the thread is locked (`-32004`).
- **(d) Errors unchanged:** `-32004 TurnAlreadyActive` still returns `lockHolderPid` (§4.1). `token` is never sent on the wire, never logged (stderr included), and never written to session JSONL.

### 3.4 Items (notifications only)

| Method | Kind | Params |
| --- | --- | --- |
| `item/started` | notification | `{ threadId, turnId, item: Item }` |
| `item/completed` | notification | `{ threadId, turnId, item: Item }` |
| `item/agentMessage/delta` | notification | `{ threadId, turnId, itemId, delta: string }` |

`item/completed` is authoritative. Deltas are optional TUI convenience.

---

## 4. Errors

Response error shape: `{ id, error: { code: number, message: string, data?: object } }`. `id` is `null` only when the request id could not be read (`-32700`, `-32600`). `message` is human-readable and not a contract; `code` and `data` are. `data` never carries secrets, env, or stack traces.

### 4.1 Error-code table

| Code | Name | When | `data` |
| --- | --- | --- | --- |
| -32700 | ParseError | Line is not valid JSON. | omitted |
| -32600 | InvalidRequest | Valid JSON but not a request/notification shape (missing `method`, bad `id` type). | omitted |
| -32601 | MethodNotFound | `method` not in §3 (includes all out-of-M0 Codex methods). | `{ method: string }` |
| -32602 | InvalidParams | Params fail schema (missing `threadId`, empty `input`, non-text `UserInput`, …). | `{ issues: string[] }` |
| -32603 | InternalError | Unexpected engine fault not covered below. | omitted |
| -32000 | NotInitialized | Any request before `initialize` completes. | `{ method: string }` |
| -32001 | AlreadyInitialized | Second `initialize` on the same connection. | omitted |
| -32002 | ThreadNotFound | `thread/resume`, `turn/start`, `turn/interrupt` with unknown `threadId`. | `{ threadId: string }` |
| -32003 | TurnNotFound | `turn/interrupt` with a `turnId` not in that thread. | `{ threadId: string, turnId: string }` |
| -32004 | TurnAlreadyActive | `turn/start` while the thread has an `inProgress` turn (one active turn per thread in M0), or `thread/start` / `thread/resume` / `turn/start` on a thread locked by another engine process (§3.3). | `{ threadId: string, activeTurnId: string \| null, lockHolderPid?: number }` |
| -32005 | SeatNotFound | `thread/start.seatId` has no `seats/<id>.json` (`madc-default` is auto-seeded, so this is non-default ids). | `{ seatId: string, path: string }` |
| -32006 | SeatInvalid | Seat file unreadable, not JSON, or fails seat schema (see seat pin §2). | `{ seatId: string, path: string, issues: string[] }` |
| -32007 | ProviderDenied | `assertAllowed` throws `RegistryDeniedError` with reason `unknown-provider` \| `forbidden` \| `interactive-only-headless` \| `connect-mismatch`. | `{ providerId: string, status: ProviderStatus \| null, reason: DenyReason }` (`status` null for `unknown-provider`) |
| -32008 | ProviderUnavailable | Provider allowed by policy but cannot run: registry `wired: false` (reason `unwired`), vendor binary missing (`claude`, `codex`), or no key configured. | `{ providerId: string, reason: "unwired" \| "binary-missing" \| "no-credentials" }` |
| -32009 | SessionWriteFailed | Append to `sessions/<threadId>.jsonl` fails (I/O, permission, disk). | `{ threadId: string, path: string, seq: number }` |

`ProviderStatus` and `DenyReason` are the exported types from `@madc/registry` (`packages/registry/src/types.ts`).

### 4.2 Where errors surface

| Situation | Surface |
| --- | --- |
| Request can be rejected before work starts | Response `error` with code above. Provider / seat checks run in `turn/start` (and `thread/start` for seat load) **before** any model or vendor call. |
| Failure after `turn/start` already returned | Turn ends `failed`; `turn/completed.turn.error = { code, message, data? }` using the same table, plus an `error` item. Example: session append fails mid-turn → `-32009`; vendor child exits → `-32008` with `reason: "binary-missing"` or `-32603`. |
| Recoverable mid-turn problem (tool error, retry) | `error` item only; turn may still complete. |

---

## 5. Type shapes

```ts
/** Wire camelCase everywhere. */

type ThreadStatus = "idle" | "active" | "closed";

type Thread = {
  id: string;
  seatId: string;          // "madc-default" by default
  cwd: string | null;
  createdAt: number;       // unix ms
  updatedAt: number;
  status: ThreadStatus;
  preview: string;         // first user text or ""
};

type ThreadSummary = Pick<Thread, "id" | "seatId" | "createdAt" | "updatedAt" | "preview" | "status">;

type TurnStatus = "inProgress" | "completed" | "interrupted" | "failed";

type RpcErrorBody = { code: number; message: string; data?: Record<string, unknown> }; // §4.1

type Turn = {
  id: string;
  threadId: string;
  status: TurnStatus;
  items: Item[];           // authoritative on turn/completed
  error: RpcErrorBody | null; // set iff status === "failed"
  startedAt: number;
  completedAt: number | null;
};

type ItemKind =
  | "userMessage"
  | "agentMessage"
  | "toolCall"
  | "toolResult"
  | "error"
  | "servedModel";

type ItemBase = {
  id: string;
  kind: ItemKind;
  status: "inProgress" | "completed" | "failed";
};

type UserMessageItem = ItemBase & {
  kind: "userMessage";
  content: Array<{ type: "text"; text: string }>;
};

type AgentMessageItem = ItemBase & {
  kind: "agentMessage";
  text: string;            // full text at completed; may grow via deltas
};

type ToolCallItem = ItemBase & {
  kind: "toolCall";
  name: string;
  arguments: unknown;      // JSON-serializable
};

type ToolResultItem = ItemBase & {
  kind: "toolResult";
  callId: string;          // matches toolCall.id
  name: string;
  output: string;
  isError: boolean;
};

type ErrorItem = ItemBase & {
  kind: "error";
  message: string;
  code?: number;           // §4.1 when applicable
};

/** MAD receipt — not a Codex field. One per model invocation in the turn. */
type ServedModelItem = ItemBase & {
  kind: "servedModel";
  requestedModel: string;  // seat pinnedModel, e.g. "kimi-coding/kimi-for-coding"
  servedModel: string;     // pi-ai responseModel ?? requested model id; vendor equivalent for adapters
  backing: "kimi-code" | "claude-code" | "codex"; // seat preferredBacking
  providerId: string;      // registry id passed to assertAllowed (== backing in M0)
};

type Item =
  | UserMessageItem
  | AgentMessageItem
  | ToolCallItem
  | ToolResultItem
  | ErrorItem
  | ServedModelItem;
```

**Item lifecycle:** `item/started` (`inProgress`) → optional deltas → `item/completed`.
**Turn order (happy path):** `userMessage` → zero or more (`toolCall` / `toolResult`) → `agentMessage` → `servedModel` → `turn/completed`.
The same `servedModel` receipt is also written to session JSONL (seat pin §4, dual write).

---

## 6. Not in M0

- WebSocket / HTTP / Unix-socket listeners (`--listen` family).
- Rest of the Codex method surface (fork, archive, delete, goal, skills, apps, auth RPC, `fs/*`, approvals as server-requests, review, compact, steer, inject_items, …) → `-32601`.
- ACP editor integration beyond a **stub** module (types + `NotImplemented`).
- Multiple concurrent turns per thread; multi-subscriber fan-out; daemon; remote attach.
- Image / multimodal input; `reasoning` / `fileChange` / `commandExecution` item kinds (map vendor events into `toolCall` / `toolResult` / `agentMessage` or drop until M1).
- Codex experimental capability gates.

---

## 7. Compatibility

| Layer | Rule |
| --- | --- |
| **MAD native names** | Codex vocabulary: `thread`, `turn`, `item`; method paths `thread/start`, `turn/start`, `item/started`, … |
| **Not a Codex fork** | MAD owns the shapes above. `seatId`, `servedModel` item, `protocolVersion: "madc-m0/1"`, and codes `-32000..-32009` are MAD-defined. |
| **Codex as backing** | Act M0-A6 maps Codex app-server ↔ MAD native (identity where shapes match) inside `packages/adapters`. |
| **ACP** | Adapter only, later. Native path never speaks ACP. |

---

## 8. Acceptance — Hephaestus **A2**

A2 is done when all pass on **Node 22.19 and Bun**:

1. Engine starts as a child process; `initialize` / `initialized` handshake completes.
2. Round-trip test (no live providers): `thread/start` → `turn/start` (text) → fake/echo agent emits `item/started` + `item/completed` for `userMessage` and `agentMessage` → `turn/completed` with status `completed`.
3. `turn/interrupt` yields `turn/completed` with status `interrupted`.
4. Error tests: request before `initialize` → `-32000`; unknown method → `-32601`; unknown `threadId` → `-32002`; second `turn/start` on an active thread → `-32004`; `thread/resume` from a second engine while the first holds the lock → `-32004`; `threadId: "../x"` → `-32602`; malformed line → `-32700`.
5. Types for `Thread`, `Turn`, `Item` (six kinds in §5) and the §4.1 code constants live in `packages/engine` (or `packages/core`); CLI imports **types / client SDK only**.
6. ACP module exports stub + `NotImplemented`; no editor wiring.
7. No WS/HTTP server code paths in M0 packages.
8. A2 PR description references this pin; deviations need a Founder note.
9. Lock-token tests (Amendment 1, A2 W1 follow-up): a same-pid, same-`startedAt` re-acquisition with a different `token` — the stale holder's release does not delete the new lock, and a reclaim does not delete a lock whose `token` changed; the `token` never appears in any protocol response, log / stderr line, or session JSONL.

Codes `-32005..-32009` are defined here so A3/A4/A5/A6 share one table; their tests land in those acts.

*End of protocol pin.*
