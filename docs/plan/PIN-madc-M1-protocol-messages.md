# PIN: M1 native protocol messages (thread / turn / item)

*Surface Architect · 2026-09-27 · Venue: `MADVenturesLLC/MADC` · Status: **build pin** — gates Hephaestus Acts M1-A1 … M1-A9. Docs only.*

*Amended by [`PIN-madc-M1-amendment-1-subscription-surface.md`](PIN-madc-M1-amendment-1-subscription-surface.md) (Founder ruling 2026-09-30: unnamed-model receipts and `-32008` reason `model-default-undocumented`; `protocolVersion` stays `madc-m1/1`).*

*Supersedes `docs/plan/PIN-madc-M0-protocol-messages.md` **for M1 work**. The M0 pin stays frozen and is not edited (M1-A0; Founder, 2026-09-25). M0 Amendments 2 and 3 are separate frozen files, unedited and not superseded here; they remain binding as written, and their references to M0-pin sections read against the matching sections of this pin.*

*Carried forward unchanged: **M0 Amendment 1** (merged PR #8). The frozen M0 pin's record line: `*Amendment 1 (2026-09-24): lock token, fixes A2 Copilot W1 (PR #7), Founder-authorized.*` Its normative text stands in §3.3 ("Cross-process ownership") and §8 (item 9).*

**Authority:**

- `docs/plan/PLAN-madc-M1-build-plan.md` — Founder-accepted 2026-09-27 (D-M1-1); §9 P1–P6 is this pin's source text. Founder rulings D-M1-1 … D-M1-11 (§12).
- `docs/plan/PIN-madc-M0-protocol-messages.md` — frozen base text, including Amendment 1 (PR #8, `main` @ `2e26b4d`). Superseded by this pin for M1 work only.
- `docs/plan/PIN-madc-M0-amendment-2-session-integrity.md`, `docs/plan/PIN-madc-M0-amendment-3.md` — frozen; session-integrity requirements (single writer, durability, torn-tail classification, rollback durability, poisoned writer, writer guard, seed proof, `sessions/` permissions) continue to bind.
- Founder rulings recorded in the M1 plan §6 and §12: **D-M1-3** Ollama headless denied until permission is recorded · **D-M1-7** same-lane fallback rule · engine-owned repo identity (Copilot [r4101049517](https://github.com/MADVenturesLLC/MADC/pull/9#discussion_r4101049517), seat pin §5).
- ADR-0002 (ACCEPTED): Codex app-server thread/turn/item is native; ACP is adapter only.
- `packages/registry` on `main`: provider ids, `ProviderStatus`, `DenyReason`, `RegistryDeniedError`. Registry **v2** (catalog, `credentialClass`, `verifiedAt`, new `DenyReason` values) lands in act **M1-A1**; this pin's references to v2 concepts bind from that act.

**Steal:** Codex app-server vocabulary + stdio JSON-RPC lifecycle. **Do not** copy Codex crates, schemas, or UI.

---

## 1. Wire

| Rule | M1 pin |
| --- | --- |
| Transport | **stdio only** (M0 D3) — newline-delimited JSON (JSONL). One message per line on stdin/stdout. |
| Framing | JSON-RPC 2.0 *shape*: request `{ id, method, params? }`, response `{ id, result }` or `{ id, error }`, notification `{ method, params }` (no `id`). |
| `jsonrpc` field | **Omitted** by the engine (Codex app-server convention). Parsers on both sides must accept messages with or without `"jsonrpc":"2.0"`. |
| Encoding | UTF-8. No binary frames. stderr is logs only — never protocol. |
| IDs | Request `id`: number or string. Domain ids (`threadId`, `turnId`, `itemId`) and `seatId`: opaque strings matching `^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$` (no `.`, `/`, `\`, whitespace, or control chars; `thr_…`, `turn_…`, `item_…` recommended). Any other value → `-32602` **before** it is joined into a path. |

Engine process owns the protocol host. CLI is a client only (no loop/tools/adapters in `packages/cli`; M0 plan §6 import rules, carried by M1 plan §5).

---

## 2. Process ownership

| Actor | Owns |
| --- | --- |
| **Engine** (`packages/engine`) | Protocol host; thread store; turn execution; item stream; seat resolution; registry check (`assertAllowed`); repo identity resolution (seat pin §5); presence check (§3.3); credential store (keychain); session append. |
| **CLI** (`packages/cli`) | Spawns engine with `stdio: ["pipe","pipe","inherit"]`, speaks protocol, renders UI / one-shot JSON, exits. Claims the turn `mode` from its own TTY facts (§3.3). |
| **Who starts engine** | M1: **CLI spawns child** for interactive or one-shot. No daemon, no WS listener, no Unix-socket control plane (§6). |
| **`madc-engine auth-set <provider>`** | One-shot subcommand, a **separate process, not a JSONL session** (P4, M1-A2). It reads the secret from its own no-echo TTY prompt, writes it straight to the OS keychain, and exits. No secret ever crosses the protocol stream or its error path. |

Connection lifecycle:

1. Client opens stdio → sends `initialize` → server replies → client sends `initialized`.
2. Any request before `initialize` → `-32000 NotInitialized`.
3. Second `initialize` on same stream → `-32001 AlreadyInitialized`.
4. Client drives `thread/*` then `turn/*`; reads notifications until `turn/completed`.
5. EOF on stdin / process exit ends the connection; an in-flight turn ends `interrupted`.

---

## 3. Methods (complete M1 list)

### 3.1 Handshake

| Method | Kind | Params | Result / notes |
| --- | --- | --- | --- |
| `initialize` | request | `{ clientInfo: { name, title?, version } }` | `{ serverInfo: { name: "madc-engine", version }, protocolVersion: "madc-m1/1" }` |
| `initialized` | notification | `{}` | Client → server; no response |

**P1:** `protocolVersion` is `"madc-m1/1"`. All M0 methods and codes are unchanged under it. The M1-only methods of §3.5 exist only under `"madc-m1/1"`; clients must not assume new methods on `"madc-m0/1"`.

### 3.2 Threads

| Method | Kind | Params | Result |
| --- | --- | --- | --- |
| `thread/start` | request | `{ seatId?: string, cwd?: string }` | `{ thread: Thread }` |
| `thread/resume` | request | `{ threadId: string }` | `{ thread: Thread }` |
| `thread/list` | request | `{ limit?: number, cursor?: string }` | `{ data: ThreadSummary[], nextCursor: string \| null }` |
| `thread/started` | notification | `{ thread: Thread }` | After start / resume load |

`seatId` defaults to `madc-default` (M0 D4) when omitted.

### 3.3 Turns

| Method | Kind | Params | Result |
| --- | --- | --- | --- |
| `turn/start` | request | `{ threadId, input: UserInput[], mode?: "interactive" \| "headless" }` | `{ turn: Turn }` (status `inProgress`, items `[]`) |
| `turn/interrupt` | request | `{ threadId, turnId }` | `{}` — turn ends `interrupted`; no-op `{}` if the turn already finished |
| `turn/started` | notification | `{ turn: Turn }` | |
| `turn/completed` | notification | `{ turn: Turn }` | Final status + items snapshot |

`UserInput` M1: `{ type: "text", text: string }` only.

**P3 — mode claim:** `mode` is optional. If absent, the engine uses `headless` (**fail-closed**). The claim is advisory: a client's `mode: "interactive"` claim is necessary but never sufficient for an `interactive-only` lane. Interactive-only lanes also need the **engine-side presence check** (M1-A5): the engine itself opens the controlling terminal (`/dev/tty`) on every interactive-only turn and requires a human keypress confirmation there on the first such turn in a session; a lost or changed terminal voids the confirmation. The check result is recorded as `presence: "verified" | "absent"` in the session JSONL `turn.start` payload (seat pin §4). No controlling terminal or no confirmation means the turn is refused with `-32007` reason `interactive-only-headless` **before any network call**.

**One active turn per thread in M1:** `turn/start` while a turn is `inProgress` on that thread → `-32004 TurnAlreadyActive`.

The following block is **M0 Amendment 1, carried forward unchanged** (PR #8):

> **Cross-process ownership:** each CLI run spawns its own engine, so the rule is enforced on disk. `thread/start` / `thread/resume` take an exclusive lock `sessions/<threadId>.lock` (create-exclusive) held until the connection ends. Lock body is exactly `{ pid, startedAt, token }`. `token` is 32 lowercase hex chars (128 random bits, e.g. `crypto.randomBytes(16).toString("hex")`), valid iff it matches `^[0-9a-f]{32}$`, generated fresh on every acquisition and never reused. The holder keeps its token in memory. Lock held by a live process → `-32004` with `activeTurnId: null` and `lockHolderPid`. Only the lock holder appends to `sessions/<threadId>.jsonl`. Ownership checks compare `token`; pid + startedAt + inode alone are not unique (Amendment 1):
>
> - **(a) Release** unlinks the lock only if the on-disk body's `token` equals the holder's in-memory token. Otherwise it leaves the file alone. The check and the unlink must act on the same file: read the body through an open fd, and immediately before unlinking confirm the path still names that fd's file (`lstat` vs `fstat` dev + inode; the open fd pins the inode, so it cannot be reused). POSIX has no compare-and-unlink; the remaining window is closed by (b), which never reclaims a lock whose pid is live.
> - **(b) Reclaim** (lock pid dead): rename the lock aside to a unique name (e.g. `sessions/<threadId>.lock.reclaim-<reclaimer token>`), re-read the renamed body, and delete it only if it still matches the observed dead holder's `pid` + `startedAt` + `token` (for a (c) body, the same missing or invalid `token` value). On mismatch, restore it (link or rename back to `sessions/<threadId>.lock`) and treat the thread as locked (`-32004`).
> - **(c) Legacy / corrupt body** (`token` missing or not matching `^[0-9a-f]{32}$`): reclaimable via (b) only if its pid is dead. With a live pid the thread is locked (`-32004`).
> - **(d) Errors unchanged:** `-32004 TurnAlreadyActive` still returns `lockHolderPid` (§4.1). `token` is never sent on the wire, never logged (stderr included), and never written to session JSONL.

*Note (not part of Amendment 1): M0 Amendment 2 §6 corrects the last sentence of (a) — the guarantee holds only inside Amendment 2 §1's operating envelope (one PID namespace, one host, one kernel boot), and the three-engine reclaim race residual is documented in Amendment 2 §6. Amendments 2 and 3 remain binding as written.*

### 3.4 Items (notifications only)

| Method | Kind | Params |
| --- | --- | --- |
| `item/started` | notification | `{ threadId, turnId, item: Item }` |
| `item/completed` | notification | `{ threadId, turnId, item: Item }` |
| `item/agentMessage/delta` | notification | `{ threadId, turnId, itemId, delta: string }` |

`item/completed` is authoritative. Deltas are optional TUI convenience.

### 3.5 M1 additions (P4)

| Method | Kind | Params | Result |
| --- | --- | --- | --- |
| `seat/list` | request | `{}` | `{ data: SeatSummary[] }` |
| `provider/list` | request | `{}` | `{ data: ProviderSummary[] }` |
| `auth/remove` | request | `{ providerId: string }` | `{}` — removes the stored credential through the engine's keychain store |
| `auth/status` | request | `{ providerId: string }` | `{ providerId: string, present: boolean }` — presence only, **never** a value |

- `ProviderSummary` fields: `id`, `status`, `wired`, `verifiedAt`, `stale`, and `credentialsPresent` (direct-key lanes) or `binaryPresent` (vendor-agent lanes). Presence booleans only — **never values** (type shapes in §5).
- `SeatSummary` carries no secrets. Its exact projection of the seat schema (seat pin §2) is locked by act **M1-A7** against that schema; this pin fixes the method, the `{ data: SeatSummary[] }` envelope and the no-secrets rule.
- **No `auth/set` over JSONL:** secrets are set only by the one-shot `madc-engine auth-set` subcommand (§2), so no secret ever crosses the protocol stream or its `-32700` parse-error path. No JSONL method accepts a secret value (schema test, M1-A2).

---

## 4. Errors

Response error shape: `{ id, error: { code: number, message: string, data?: object } }`. `id` is `null` only when the request id could not be read (`-32700`, `-32600`). `message` is human-readable and not a contract; `code` and `data` are. `data` never carries secrets, env, or stack traces.

### 4.1 Error-code table

| Code | Name | When | `data` |
| --- | --- | --- | --- |
| -32700 | ParseError | Line is not valid JSON. | omitted |
| -32600 | InvalidRequest | Valid JSON but not a request/notification shape (missing `method`, bad `id` type). | omitted |
| -32601 | MethodNotFound | `method` not in §3 (includes all out-of-M1 Codex methods). | `{ method: string }` |
| -32602 | InvalidParams | Params fail schema (missing `threadId`, empty `input`, non-text `UserInput`, …). | `{ issues: string[] }` |
| -32603 | InternalError | Unexpected engine fault not covered below. | omitted |
| -32000 | NotInitialized | Any request before `initialize` completes. | `{ method: string }` |
| -32001 | AlreadyInitialized | Second `initialize` on the same connection. | omitted |
| -32002 | ThreadNotFound | `thread/resume`, `turn/start`, `turn/interrupt` with unknown `threadId`. | `{ threadId: string }` |
| -32003 | TurnNotFound | `turn/interrupt` with a `turnId` not in that thread. | `{ threadId: string, turnId: string }` |
| -32004 | TurnAlreadyActive | `turn/start` while the thread has an `inProgress` turn (one active turn per thread in M1), or `thread/start` / `thread/resume` / `turn/start` on a thread locked by another engine process (§3.3). | `{ threadId: string, activeTurnId: string \| null, lockHolderPid?: number }` |
| -32005 | SeatNotFound | `thread/start.seatId` has no `seats/<id>.json` (the five roster seats are auto-seeded, seat pin §3, so this is ids outside the seeded set). | `{ seatId: string, path: string }` |
| -32006 | SeatInvalid | Seat file unreadable, not JSON, or fails seat schema (see seat pin §2). | `{ seatId: string, path: string, issues: string[] }` |
| -32007 | ProviderDenied | `assertAllowed` throws `RegistryDeniedError` with reason `unknown-provider` \| `forbidden` \| `interactive-only-headless` \| `connect-mismatch` \| `repo-not-allowed` \| `repo-identity-ambiguous` \| `terms-stale` \| `headless-not-permitted`. | `{ providerId: string, status: ProviderStatus \| null, reason: DenyReason }` (`status` null for `unknown-provider`) |
| -32008 | ProviderUnavailable | Provider allowed by policy but cannot run: registry `wired: false` (reason `unwired`), vendor binary missing (`claude`, `codex`, `grok`), no key configured, or a 429/502-style signal from the lane (reason `quota-or-unreachable`). | `{ providerId: string, reason: "unwired" \| "binary-missing" \| "no-credentials" \| "quota-or-unreachable" }` |
| -32009 | SessionWriteFailed | Append to `sessions/<threadId>.jsonl` fails (I/O, permission, disk). | `{ threadId: string, path: string, seq: number }` |

**P5:** `-32007 ProviderDenied` `reason` gains `repo-not-allowed`, `repo-identity-ambiguous`, `terms-stale` and `headless-not-permitted` (registry v2 `DenyReason`, M1-A1). `-32008 ProviderUnavailable` `reason` gains `quota-or-unreachable` (from 429/502-style signals, M1-A3).

**P6:** M1 still has no WS/HTTP listener. The desktop transport is an M3 amendment; any method outside §3 gets `-32601`.

`ProviderStatus` and `DenyReason` are the exported types from `@madc/registry` (`packages/registry/src/types.ts`; v2 from M1-A1).

### 4.2 Where errors surface

| Situation | Surface |
| --- | --- |
| Request can be rejected before work starts | Response `error` with code above. Provider / seat / presence / repo-policy checks run in `turn/start` (and `thread/start` for seat load) **before** any model or vendor call. |
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

/** MAD receipt — not a Codex field. One per model invocation in the turn. (P2) */
type ServedModelItem = ItemBase & {
  kind: "servedModel";
  requestedModel: string;  // seat pinnedModel, e.g. "kimi-coding/kimi-for-coding"
  servedModel: string;     // pi-ai responseModel ?? requested model id; vendor equivalent for adapters
  backing: string;         // seat preferredBacking: a registry id with wired: true (M0 was the 3-literal union)
  providerId: string;      // registry id passed to assertAllowed for this invocation
  lane: ProviderStatus;    // registry status of the serving lane
  mode: "interactive" | "headless"; // the turn's mode (§3.3)
  fallbackFrom: string | null;      // previous backing id when this receipt follows a fallback hop; null on the primary
  vendorReported: boolean;          // true only if the vendor/agent reported a model identity; else false
};

type Item =
  | UserMessageItem
  | AgentMessageItem
  | ToolCallItem
  | ToolResultItem
  | ErrorItem
  | ServedModelItem;

/** §3.5 shapes (P4). */
type ProviderSummary = {
  id: string;                    // registry id
  status: ProviderStatus;        // registry v2 (M1-A1)
  wired: boolean;
  verifiedAt: string;            // ISO date of the terms verification
  stale: boolean;                // verifiedAt older than the registry freshness window (30 days, M1-A1)
  credentialsPresent?: boolean;  // direct-key lanes; presence only, never a value
  binaryPresent?: boolean;       // vendor-agent lanes
};

type SeatSummary = { id: string } & Record<string, unknown>; // projection of the seat schema locked by M1-A7; never carries secrets
```

**Honesty rule for `servedModel` (P2, plan §2 F):** `servedModel` uses the vendor-reported identity when one exists (pi-ai `responseModel`, or a vendor agent's report); `vendorReported` is `true` only in that case. Otherwise the receipt records the requested model with `vendorReported: false`. `fallbackFrom` marks every hop honestly; it is never cleared to make a fallback look like the primary.

**`ThreadStatus "closed"` remains reserved in M1** (M0 Amendment 2 §7): M1 engines never produce it; clients print any status string verbatim and do not branch on `closed`. Its semantics stay deferred — the M1 plan §9 does not commission them (§6).

**Item lifecycle:** `item/started` (`inProgress`) → optional deltas → `item/completed`.
**Turn order (happy path):** `userMessage` → zero or more (`toolCall` / `toolResult`) → `agentMessage` → `servedModel` → `turn/completed`.
The same `servedModel` receipt is also written to session JSONL (seat pin §4, dual write).

---

## 6. Not in M1

- WebSocket / HTTP / Unix-socket listeners (`--listen` family). M1 has no such listener (P6); the desktop transport is an M3 amendment.
- Rest of the Codex method surface (fork, archive, delete, goal, skills, apps, `fs/*`, approvals as server-requests, review, compact, steer, inject_items, …) → `-32601`.
- **Any method that carries a secret value.** There is no `auth/set` over JSONL; secrets are set only by the `madc-engine auth-set` subcommand (§2, P4).
- ACP **server** / editor integration (M4). The M1 ACP **client** adapter for vendor agents (M1-A6) is adapter-internal and adds no protocol methods.
- Multiple concurrent turns per thread; multi-subscriber fan-out; daemon; remote attach. Multi-seat handoffs (M2; `handoffs.enabled` stays `false`, seat pin §2).
- Image / multimodal input; `reasoning` / `fileChange` / `commandExecution` item kinds (map vendor events into `toolCall` / `toolResult` / `agentMessage` or drop).
- Codex experimental capability gates.
- **Deferred beyond M1 scope** (named by M0 Amendment 2 §7 for M1-A0 consideration; the Founder-ruled M1 plan §9 does not commission them, so they remain unpinned): namespace-proof lock liveness (lease/heartbeat, lock body v2); torn-tail repair (fail-closed stands); `ThreadStatus "closed"` semantics (reserved, §5); a size bound on session verification reads.

---

## 7. Compatibility

| Layer | Rule |
| --- | --- |
| **MAD native names** | Codex vocabulary: `thread`, `turn`, `item`; method paths `thread/start`, `turn/start`, `item/started`, … |
| **Not a Codex fork** | MAD owns the shapes above. `seatId`, `servedModel` item, `protocolVersion: "madc-m1/1"`, and codes `-32000..-32009` are MAD-defined. |
| **Protocol version** | `"madc-m1/1"` (P1). All M0 methods and codes behave unchanged under it. The §3.5 methods exist only under `"madc-m1/1"`; clients must not assume new methods on `"madc-m0/1"`. |
| **Codex as backing** | The Codex vendor adapter maps Codex app-server ↔ MAD native (identity where shapes match) inside `packages/adapters`. |
| **ACP** | Adapter only (M1-A6 client side). The native path never speaks ACP. |

---

## 8. Acceptance — Hephaestus **M1 acts**

This pin gates acts **M1-A1 … M1-A9** (M1 plan §7). Each act PR references this pin and cites its merged SHA (M1-A0 acceptance); the per-act acceptance bullets live in the plan §7 and bind as written there. Pin-level invariants:

1. `initialize` returns `protocolVersion: "madc-m1/1"`; every M0 method, code and behavior from the M0 pin §8 acceptance (items 1–9) still passes unchanged where the surface is unchanged.
2. `turn/start` without `mode` is treated as `headless` (fail-closed); an interactive claim without the engine-side presence check never unlocks an `interactive-only` lane (`-32007`, `interactive-only-headless`, before any network call).
3. `seat/list`, `provider/list`, `auth/remove`, `auth/status` round-trip per §3.5; `provider/list` and `auth/status` carry presence only, never values; a schema test proves no JSONL method accepts a secret value (M1-A2).
4. Every model or vendor invocation writes a `servedModel` receipt (protocol item + JSONL event, seat pin §4) carrying `lane`, `mode`, `fallbackFrom`, `vendorReported` honestly (plan §2 F).
5. The §4.1 reason lists match registry v2 exactly (M1-A1): `-32007` includes `repo-not-allowed`, `repo-identity-ambiguous`, `terms-stale`, `headless-not-permitted`; `-32008` includes `quota-or-unreachable`.
6. Deviations from this pin need a Founder note in the act PR.

**Amendment 1, carried forward unchanged (M0 pin §8 item 9):**

> 9. Lock-token tests (Amendment 1, A2 W1 follow-up): a same-pid, same-`startedAt` re-acquisition with a different `token` — the stale holder's release does not delete the new lock, and a reclaim does not delete a lock whose `token` changed; the `token` never appears in any protocol response, log / stderr line, or session JSONL.

Codes `-32005..-32009` are shared by every act; their tests land in the acts named by the plan §7.

*End of M1 protocol pin.*
