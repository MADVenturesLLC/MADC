# PIN (proposed): M3 desktop protocol, amendment 2: the M3-A4 desktop method allowlist, the engine-event forwarding path, connection epochs for events, fail-closed rules, and the bounded exit path

*Surface Architect · 2026-11-27 · Venue: `MADVenturesLLC/MADC` · Status: **proposed until the Founder merges this PR**. Per `docs/plan/README.md:3-11` this file is a draft while proposed; once the Founder merges it, it is frozen and changes only by `Amended by` pointer lines and new files. Additive amendment to `PIN-madc-M3-desktop-protocol.md` (§2, §3) and to `PIN-madc-M3-desktop-protocol-amendment-1.md` (§3(a), §5), and the desktop-protocol half of M3-A4 (`PLAN-madc-M3-build-plan.md:27`). `protocolVersion` stays `madc-m1/1`. **No engine method, param, result shape or error code is added or removed; no engine file changes** (the engine already implements everything used here). Docs only. Companion design pin: `PIN-madc-M3-A4-multi-seat-workspace.md` ("A4 pin"); verbatim Iris spec: `sources/DESIGN-SPEC-m3-a4-equal-columns.md` ("A4 spec"). Founder rulings FDR-1..FDR-8 (Mike, 2026-11-27 9:26 PM ET, "Accept all eight recommended defaults", relayed by MADC Architect; Clio D-708..D-715, needs-confirmation) are applied below and are tabled in §14.*

*Base: `main` @ `870c1f7ec3aeca13190f306b23c5d91810675e09` (PR #80). Every `main` file cited below was read at that commit; line numbers are that commit's. `main` was re-checked at PR time and is still `870c1f7e`. This PR adds one pointer line to `PIN-madc-M3-desktop-protocol-amendment-1.md` (under line 3) and one to `PIN-madc-M3-desktop-protocol.md` (line 7), so lines below the insertion points move down; every cite here uses the `870c1f7e` numbers.*

*r2 (2026-11-27, same evening): answers Copilot's review of PR #81 (three High comments, submitted 10:53 PM ET, review `6095587740`). Dispositions in §17. No other contract in this amendment changes.*

*r3 (2026-11-27, same night): answers Copilot's second review of PR #81 (review `6095651398`, 11:02 PM ET, four High and one Medium, all on this file), and a whole-document self-review for the same classes of defect (contradictions between sections, ordering and atomicity of close, timeouts and cancellation, epoch/seq rules, shape validation, field naming). New §2.4 (one state word, exactly one terminal event, a cancellable reader) and §3.2.1 (closed shape checks); §2.2, §3.1, §3.3, §3.6, §4.1-§4.3, §5 F2/F4, §6 items 3-4, §6.1, §12 and §13 are edited to match. Dispositions in §17 (r3). The wire contract of the allowlist, `validate_rpc_params`, the exit bound and the Founder rulings does not change.*

**Authority:**

- `docs/plan/PIN-madc-M3-desktop-protocol.md` (base; §2, §3, §4), blob `2c022f33…` at the base.
- `docs/plan/PIN-madc-M3-desktop-protocol-amendment-1.md` (frozen; §3(a) line 83, §5 lines 126-133, §9 line 214, §10), blob `3047bf3f…`.
- `docs/plan/PIN-madc-M3-design-precision-instrument-glass.md` (A3 design pin; §6.1 epoch/N5, §6.4 R1-R4, §6.5, §7 out-of-scope), blob `4f5dd042…`.
- `docs/plan/PLAN-madc-M3-build-plan.md:14,27`: the shell holds no agent loop, tools or credentials; A4 deliverable text.
- Relayed Founder rulings **D-660** (fix FOUNDER-A in M3-A4) and **D-661** (FOUNDER-B), both "relayed, not posted on GitHub" (Clio ledger, `needs-confirmation`).
- Relayed Founder rulings on FDR-1..FDR-8 (2026-11-27 9:26 PM ET, D-708..D-715) and the A4 visual rulings (10:22 PM ET, D-716..D-721; C53 at 10:36 PM ET, D-722). All `needs-confirmation` in Clio's ledger: relayed by MADC Architect, not posted on GitHub. §14 lists them.
- The Founder approved this pin gate (Iris spec → Surface pin PR → Argus review → Founder merge) on 2026-11-27 7:36 PM ET (relayed by MADC Architect; Clio D-705 spec gate, D-706 this pin).

---

## 0. What this amendment changes, and what it does not

| Area | Today (`870c1f7e`) | After this amendment |
| --- | --- | --- |
| Desktop RPC allowlist | 4 methods, read-only + `initialize` (`launcher.rs:35-40`) | 8 methods (§1): adds `seat/list`, `thread/start`, `turn/start`, `turn/interrupt` |
| Reading the socket | Synchronous, request-scoped; notifications **discarded** (`launcher.rs:545-548`) | One reader thread per connection demultiplexes responses and notifications (§2) |
| Engine events in the WebView | None (no `emit`, no `listen`) | Closed set of 5 engine notifications + 2 Rust-originated events forwarded on one channel, epoch- and sequence-tagged; 2 more engine notifications read and discarded in Rust (§3) |
| Stale events | n/a | Dropped unless `epoch` is current and state is `CONNECTED`; can never flip state (§4) |
| Unknown methods/events/frames | Method: refused before write. Notification: skipped. Invalid JSON: request error | Fail closed everywhere, with named outcomes (§5) |
| Exit path | `RunEvent::Exit` blocks on the request mutex with no total bound (`main.rs:121-124`) | Total bound 9 s (**proposal**), independent of the request lock (§6) |
| `serve` stdin lifetime text | Names only EOF (amendment-1:83) | Also names an stdin error → exit 0, as built (§7; D-665) |

**Unchanged (restated so a builder cannot read them as open):** socket path, `0600`, stale-socket rule, `engine.lock`, one listener per home, launcher waits (5 s start window, 2 s/7 s kill graces), exit codes 0/2/20-24, "no automatic retry or respawn" (amendment-1:132), single-flight `connect_engine`/`disconnect_engine` (A3 §6.1), allowlist refusal **before** the connection check, `room/updated` shape and its four reasons, `ConnectionInfo` fields (one is added, §4), evidence-bound UI rule (base §4, D-626), POSIX-only (`main.rs:41-45`; D-648, D-670).

---

## 1. Desktop method allowlist (`launcher.rs` `ALLOWED_RPC_METHODS`)

### 1.1 The list (exact)

```rust
pub const ALLOWED_RPC_METHODS: &[&str] = &[
    "initialize",       // M3-A2, unchanged (a second call is refused by the engine, -32001)
    "room/inspect",     // M3-A2, unchanged, read-only
    "session/search",   // M3-A2, unchanged, read-only
    "session/read",     // M3-A2, unchanged, read-only
    "seat/list",        // M3-A4: read-only; picks a seat, shows pinnedModel / preferredBacking
    "thread/start",     // M3-A4: MUTATING (loads a thread on this connection, writes session.open)
    "turn/start",       // M3-A4: MUTATING (starts a model turn on a thread this connection loaded)
    "turn/interrupt",   // M3-A4: MUTATING (interrupts a turn this connection started)
];
```

Rules (all enforced in Rust, in `validate_rpc_method`, **before** the lock and the connection check, as `main.rs:54` and `:79` already order it):

1. Exact, case-sensitive match. No prefix, trailing-space or Unicode-normalised variants (the existing tests `"room/inspect "` and `""` stay denied, `launcher.rs:742-743`).
2. **Everything else stays denied**, including `thread/resume`, `thread/list`, `thread/handoff`, `provider/list`, `auth/status`, `auth/remove`, `auth/set`, `decision/raise`, `decision/list`, `decision/resolve`. Each needs its own act (A5 handoff view, A6 decisions) and its own pin edit. **Ruled (FDR-1, D-708):** the Founder approved `seat/list`, `thread/start`, `turn/start` and `turn/interrupt` and **deferred `thread/resume`**. **Discrepancy recorded:** the A4 spec lists `thread/resume` for the allowlist (§1 non-goals, §6.3, §8.2, §14.1). The ruling wins; `thread/resume` is **not** added, and the spec features that depend on it are deferred by A4 pin §1.3 D2.
3. **Why `thread/start` and `seat/list` are in an act whose brief names only turn start/interrupt:** the engine refuses `turn/start` with `-32002 ThreadNotFound` for any thread not loaded on the same connection (`server.ts:2171-2172`), and a thread is loaded only by `thread/start` / `thread/resume` / `thread/handoff` (`server.ts:1357-1395`; §16.4). `seat/list` supplies the seat choice (`server.ts:784-785`).
4. The refusal string is **kept byte-identical**: `RPC method not allowed by M3-A2 desktop shell: {method}`. The A3 UI classifies R1 by that literal prefix (`shell.js:23`, `:329-365`); renaming it to "M3-A4" would silently demote R1 to R4 and trigger a `disconnect_engine`. The stale "M3-A2" wording is carried as cosmetic debt.

### 1.2 Rust-side parameter validation for the new methods (defence in depth)

The engine validates params too, but the engine **ignores unknown keys on `thread/start` and `turn/start`** (amendment-1:229), and the allowlist today checks only the method name (`launcher.rs:42-48`). The desktop must not forward anything the UI is not meant to send. New in Rust: `validate_rpc_params(method, &Value)`, called right after `validate_rpc_method` and before the lock. Refusal text: `RPC params refused by desktop shell for {method}: {reason}`. **That string is a new class (R5) and is not transport loss.** Binding rules, all required:

1. `validate_rpc_params` runs after `validate_rpc_method` and **before** the lock, the connection check, and any socket write (`main.rs:54` already orders the method check first; params join that same prefix).
2. `classifyRpcError` treats R5 like R1 (defect guard: render `✗ FAILED` on the action, connection state unchanged).
3. **R5 must never call `disconnect_engine`**, in Rust or in the UI. An R5 is a client typo, not a dead socket. Calling `disconnect_engine` would stop a desktop-spawned `serve` (A3 §6.4 R4; `launcher.rs:556-560`) and interrupt every in-flight turn on that connection (`server.ts:538-541`).
4. **Required killed mutation (CI, must fail if a later edit introduces a `disconnect_engine` on the R5 path).** Two tests, both in the same suite as A3's R4 "exactly one `disconnect_engine`" check:
   - *Rust:* a connected `SocketClient` (fake peer that stays open) is issued an allowed method with §1.2-invalid params (e.g. `turn/start` with `mode: "interactive"`, or `thread/start` with a relative `cwd`). The call returns the R5 string; the peer is still connected; a subsequent valid `room/inspect` is written to the same socket and is not preceded by a stdin-EOF / `stop()` / socket close. A `grep`/`string` assertion over the R5 code path (the params-validator arm of `rpc_request_blocking` / `validate_rpc_params`) contains no `disconnect` identifier.
   - *UI:* a fake `invokeFn` rejects `rpc_request` with `RPC params refused by desktop shell for turn/start: mode must be absent or "headless"` while state is `CONNECTED` and a pane is `RUNNING`. After classification, `disconnect_engine` was invoked **zero** times, `connect_engine` zero further times, state stays `CONNECTED`, and the pane stays `RUNNING`. Flipping the test to expect one `disconnect_engine` must fail it — that is the mutation this test is designed to kill.

| Method | Params contract (closed key set; unknown key → refused, key not echoed) |
| --- | --- |
| `room/inspect` | `{}` (unchanged). |
| `session/search`, `session/read` | Unchanged (engine refuses unknown keys, amendment-1:229). Rust adds no check. |
| `seat/list` | `{}` exactly. |
| `thread/start` | Keys ⊆ `{ seatId, cwd }`. `seatId`, if present, matches `^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$` (engine `ID_PATTERN`, `protocol/ids.ts:8`). `cwd`, if present: string, 1..=4096 bytes, no NUL, **absolute** (`Path::is_absolute`). Syntactic checks only; existence is the engine's `resolveWorktreeIdentity`. **Ruled (FDR-2, D-709):** in A4, `cwd` comes from a typed absolute-path field (A4 pin §5.3); no folder-picker plugin. |
| `turn/start` | Keys ⊆ `{ threadId, input, mode }`. `threadId` matches the id grammar. `input` is an array of **exactly one** `{ "type": "text", "text": <string> }` with exactly those two keys, `text` non-empty after trim and ≤ 65 536 UTF-8 bytes (**proposal**; the engine only requires a non-empty array of text parts, `server.ts:360-380`). `mode` is **absent or `"headless"`**; `"interactive"` is refused in Rust. The desktop never claims presence: over `engine.sock` the engine has no controlling terminal (`server.ts:2332-2336`) so an `interactive` claim could never unlock a presence-gated lane, and sending it would be a false claim (§16.7). |
| `turn/interrupt` | Keys exactly `{ threadId, turnId }`, both matching the id grammar. |

### 1.3 Result handling and errors (what the UI must be able to render)

- `seat/list` → `{ data: SeatSummary[] }` (`types.ts:294-323`): render `displayName` (fallback `id`), `pinnedModel`, `preferredBacking`; an `ok:false` seat is shown as unavailable with its `code`/`issues`, never hidden.
- `thread/start` → `{ thread }` (`types.ts:171-172`). It carries **no** worktree or receipt fields (`server.ts:1357-1395`). The pane obtains `worktree.open` from its first `session/read` (the seq-0 `session.open` payload carries `worktree`, `session-store.ts:56-68`) or from the row of a user-run `Inspect room` (`inspect.ts:246-249`); the seq-0 event is durable before the response is sent. No automatic `room/inspect` is added (§3.4 item 2).
- `turn/start` → `{ turn }` with `status: "inProgress"`; the run itself is reported by events (§3). A refusal is an R3 `engine RPC error` (connection stays `CONNECTED`): `-32007` carries `data.{providerId,reason,status}` (`errors.ts:46-56`) and must be rendered verbatim in the pane. `-32004` (turn already active) and `-32002` are likewise pane-scoped.
- `turn/interrupt` → `{}`; success is **only** the `turn/completed` event with `status: "interrupted"` (`server.ts:2471`). An `{}` reply for an already-finished turn (`server.ts:2470`) must not be rendered as "interrupted".
- Request timeout and transport loss are unchanged A3 R4 (A3 §6.4): one `disconnect_engine`, no retry. **Ruled (FDR-8, D-715), consequence recorded:** with several panes the R4 cleanup stops a desktop-spawned `serve` (or drops the socket), and the engine then ends **every** pane's running turn as `interrupted` (`server.ts:538-541`). R4 stays fail-closed with no retry; per-pane transport isolation is a later act.

---

## 2. One reader thread per connection (replaces the request-scoped read loop)

### 2.1 Why this is required, not optional

The desktop already sends `capabilities.subscribeRoom: true` (`launcher.rs:438`) and nothing reads the socket between RPCs; notifications are skipped inside `request_with_deadline` (`:545-548`). The engine does not apply write backpressure to notifications (`#send` ignores `write()`'s return, `server.ts:2862-2869`), and `turn/start` produces `item/agentMessage/delta` streams to the originating connection (`server.ts:2858-2869`). Enabling `turn/start` without a continuous reader would let the engine buffer a stream the desktop never reads. **A4's `turn/start` may not ship without this section.**

### 2.2 Contract

- On successful `initialize` the launcher starts exactly one reader thread that owns the read half of the connection. It reads newline-delimited JSON frames and classifies each:
  - **Response** (has `id`, no `method`): looked up in a pending-request map keyed by the numeric id; the waiting request receives it (result or the engine error as today, `engine RPC error: {json}`, `launcher.rs:549-551`). An `id` that is not pending (late reply after a timeout) is dropped and counted, never forwarded.
  - **Notification** (has `method`, no `id`): validated against §3.2 and forwarded or dropped per §5.
  - **Anything else** (has both, neither, non-object, non-UTF-8, over the line cap): fail closed, §5 row F2.
- Writers take a short write lock per request; **the request mutex is no longer held while waiting for the reply.** Each request waits on its own channel with the same 10 s deadline (`INTERACTIVE_RPC_TIMEOUT`, `launcher.rs:31`) and the same messages (`RPC {method} timed out before write` / `timed out waiting for reply`, `socket write failed: …`, `engine socket closed before response`) so A3's `classifyRpcError` R4 strings remain valid (`shell.js:329-365`). On timeout the pending entry is removed.
- `request` ids stay sequential `u64` (`launcher.rs:496-497`), so the id is never attacker-chosen.
- Line cap: a frame over **8 MiB** (**proposal**; `room/inspect` returns every thread row) is a protocol violation (F2). Unmeasured (§12 item 3).
- **Bounded queue, no unbounded wait, EOF is a terminal state.** The reader follows the same bounded-wait pattern already pinned for the launcher and cited by A3:
  - Amendment 1 **§5** (lines 126-132): every launcher wait has a named bound (5 s start window, 2 s uninitialized SIGKILL, 7 s initialized SIGKILL) and "No automatic retry or respawn."
  - Amendment 1 **§3** Deadline (line 103) and step 3 (lines 94-95): a 5 s shutdown deadline and a per-socket 2 s grace so step 4 "cannot hang."
  - Realized in `launcher.rs` as `PROBE_TIMEOUT` / `START_WINDOW` / `UNINITIALIZED_KILL_GRACE` / `INITIALIZED_KILL_GRACE` / `STDERR_DRAIN_TIMEOUT` (`:25-29`) and `drain_stderr` (`:254-265`): if the drain thread does not observe EOF within the timeout, **detach rather than hang**. A3 §6.1 already cites `INITIALIZED_KILL_GRACE` (`launcher.rs:28`) as the disconnect bound. Amendment 2 §6 (bounded exit path) applies the same rule to `RunEvent::Exit`.
  - Applied to the reader (the lifecycle rules are §2.4; this list is the queue and the timeouts):
    - (i) **Forward queue.** The reader pushes forwardable events into one bounded FIFO; a single emitter thread drains it **in order** into Tauri `emit`. Capacity is **4096 ordinary events** (**proposal**, same cap as §3.6) **plus one reserved slot** that only `madc/transport-closed` may occupy. An ordinary enqueue is refused when the FIFO already holds 4096, or when the connection is not `Open` (§2.4). A refused ordinary enqueue never blocks the read loop; it is the `overflow` terminal case (§2.4). Frames discarded by design (§3.2) never enter the FIFO. There is **one** mechanism: the reserved slot in the same FIFO. There is no out-of-band path, so a terminal event can never overtake queued events, and `seq` order is delivery order (§3.1).
    - (ii) **EOF is a terminal state:** `read_line` returning 0 bytes ends the reader immediately. It does not wait for a drain, a grace, or a second read. What the reader does next depends on who owns the close, and that is decided by the single compare-and-swap in §2.4: if the reader still finds the connection `Open` it takes the `Open → Terminated` transition, which fails every pending request with `engine socket closed before response` and enqueues exactly one `madc/transport-closed { reason: "eof" }`; if the desktop already closed the connection it emits nothing. The reader then returns from the thread.
    - (iii) **The reader-owned socket has no read timeout, and nothing may re-arm one.** After `initialize` succeeds, Rust calls `set_read_timeout(None)` once, before the reader starts (the handshake itself keeps its bounded read; the write timeout stays). `SO_RCVTIMEO` is a property of the **socket**, shared by every `try_clone`; the writer clone, the cancel handle (§2.4) and the reader's stream are one socket. A `set_read_timeout` on **any** of those handles therefore re-arms the reader's timeout. **After the reader starts, no code path may call `set_read_timeout` on any handle.** That removes today's `launcher.rs:468` (`client.writer.set_read_timeout(Some(INTERACTIVE_RPC_TIMEOUT))`), `:470-473` (`client.reader.get_ref().set_read_timeout(Some(…))`) and the per-iteration `:526-529` from the post-initialize path. The 10 s `INTERACTIVE_RPC_TIMEOUT` (`launcher.rs:31`) applies **only** to the caller's wait on its pending-request channel and to write timeouts. An idle connection with no frames for longer than 10 s is healthy and **must not** emit `madc/transport-closed`. A real I/O error (reset, broken pipe, or any `read_line` error) is terminal (`reason: "read-error"`, same §2.4 transition). A `WouldBlock` / `TimedOut` on the reader is a pin violation: the §13 item 7b test fails if one occurs, whichever handle armed it.
    There is no unbounded `recv`/`lock`/`join` on the reader path, and no retry.
- Reader exit (EOF, read error, shutdown, or fail-closed violation) therefore always reaches a terminal state, never reconnects, respawns, or retries (amendment-1:132).

### 2.3 The existing `request_with_deadline` loop must not drop non-matching messages

Today `request_with_deadline` is the only reader, and it **drops** any frame whose `id` is not the awaited `u64` (`launcher.rs:545-548`: "Skip asynchronous notifications while waiting for our matching response id" / `continue`). That is the bug this amendment closes.

- **After `initialize` succeeds and the reader thread is running, `request` / `request_with_deadline` must not call `read_line` at all.** It writes the request and waits on the pending-request channel (§2.2). The reader is the sole owner of the read half.
- **Any remaining use of the `request_with_deadline` read loop** (the `initialize` handshake itself, which runs before the reader starts, or a transitional helper) **must hand a non-matching message to the reader's classify path, never `continue`-drop it.** "Non-matching" means any parsed frame whose `id` is not the `u64` this call is waiting for, including `room/updated`, `thread/started`, `turn/*`, `item/*`, `item/agentMessage/delta`, a late reply for another id, and a malformed frame (the last is F2). The hand-off is synchronous into the same classify function the reader uses, so a notification that arrives during `initialize` is queued (bounded) or fails closed, not discarded.
- A test with a fake peer that, while a request is in flight (and, separately, during `initialize`), sends a `room/updated` then the matching response, must assert the notification was classified/forwarded with a `seq` and was not lost. A second test in which only a notification arrives (no matching response) must time out the request without having dropped the notification.

### 2.4 Connection lifecycle: one state word, exactly one terminal event, a cancellable reader

Each `SocketClient` has one **state word** with three values, kept in one small `Mutex` (or atomic) that the reader, the emitter, `disconnect_engine`, `confirm_quit` and the exit path all use. It is held only for the compare-and-swap and the enqueue below; it is **never** held across a socket read, a socket write, a Tauri `emit`, a channel wait, or a child wait.

| State | Meaning |
| --- | --- |
| `Open` | The reader is running. Ordinary events may be enqueued. |
| `Terminated` | The **reader ended on its own** (EOF, read error, F2 violation, or overflow) and won the transition below. Exactly one `madc/transport-closed` was enqueued by that transition. The desktop has not cleaned up yet. |
| `Closed` | The **desktop** ended the connection (`disconnect_engine`, R4 cleanup, protocol-mismatch release, `confirm_quit`, or `RunEvent::Exit`). |

Transitions (each is one critical section on the state word):

1. **`Open → Terminated` (reader-initiated).** Only the reader may take it. Inside the **same** critical section the winner (a) assigns the terminal event its `epoch` and next `seq` (§3.1), (b) places it in the reserved slot (§2.2 (i)), and (c) marks the state `Terminated`. So the terminal event is enqueued **before or atomically with** the state leaving `Open`, never after. Outside the critical section the winner fails every pending request with `engine socket closed before response`, `shutdown`s the socket (the same call as step 4 (2) below, so the engine sees the connection go), and returns from the thread.
2. **`Open → Closed` (desktop-initiated).** Whoever wins this transition emits **nothing**, discards the unsent FIFO, and runs the cancellation sequence (step 4).
3. **`Terminated → Closed` (desktop cleanup after a reader-initiated end).** Idempotent and emits nothing: the UI's one `disconnect_engine` after `madc/transport-closed` (§4.3) lands here. It discards any still-unsent FIFO content, then runs the stop-`serve`/drop-socket steps of step 4. A `disconnect_engine` that finds `Closed` returns without repeating them.
4. **Cancellation sequence** (every desktop-initiated close, in this order, none of it waits on the request lock): (1) the transition above; (2) `shutdown(Shutdown::Both)` on the **cancel handle**, a `try_clone` of the stream taken at `initialize` success and held with the stdin handle and child reaper (§6 item 3); a blocked `read_line` returns EOF or an error immediately; (3) pending requests fail with `engine socket closed before response`; (4) an owned `serve` is stopped under the existing rules (stdin EOF, then the 7 s kill grace), and the socket is dropped. The `shutdown` touches **only this client's end of the connection**; it does not need the desktop to have spawned `serve`. When the desktop merely **attached to a reused listener** (`reusedExisting: true`, amendment-1:132: the desktop never owns that process), it is the only step that wakes the reader, and it is sufficient. Nothing else in the sequence blocks on the reader: the reader is **not joined** (detach-rather-than-hang, the same rule as `drain_stderr`), so the §6 9 s exit bound is unchanged. The reader wakes, finds `Closed`, emits nothing, sets a `reader_done` flag, and returns.

Consequences, stated so a builder cannot read them two ways:

- **Exactly one terminal event per epoch.** `Open` is left exactly once, by exactly one of transition 1 or 2. If the reader wins, one `madc/transport-closed` exists. If the desktop wins, none does (the desktop already knows). Two events, or none after a reader win, are impossible by construction.
- **Resolves the §4.1 gate.** Ordinary events are enqueued and emitted only while the state is `Open`. The terminal event is the single exception because its enqueue *is* the `Open → Terminated` transition; no `Closed` check can suppress it (a `Closed` state means the desktop won, so no terminal was owed).
- **Overflow** is a reader-initiated end: the reader finds the FIFO holding 4096 ordinary events, takes transition 1 with `reason: "overflow"` (the terminal event goes in the reserved slot), and ends. The event that did not fit already consumed a `seq` (§3.1), so the UI sees the gap and then the terminal event.
- **Delivery.** The emitter delivers everything enqueued before the terminal event, in order, then the terminal event, then exits. After `Closed` it delivers nothing more.
- **`connect_engine` re-check.** `connect_engine` returns `Err` instead of `ConnectionInfo` if, at return time, the state is not `Open`, so a connection that already died during or right after `initialize` is not reported as connected.

---

## 3. Engine events to the WebView

### 3.1 Channel and envelope

One Tauri event channel, **`madc:engine-event`** (Tauri event names allow `:`), carrying exactly:

```json
{ "epoch": 7, "seq": 42, "method": "turn/completed", "params": { … } }
```

- `epoch`: the connection epoch of §4 (u64, `JSON` integer).
- `seq`: **one** counter per epoch, strictly increasing, starting at 1, shared by **every** event on the channel, engine-forwarded and Rust-originated alike (`madc/events-dropped`, `madc/transport-closed`). It is assigned inside the FIFO's enqueue critical section (§2.4), to each forwarded engine frame when it passes the §3.2 filter **before** the capacity check, and to each Rust-originated event when it is enqueued. So `seq` order equals FIFO order equals delivery order, and a forwarded frame refused by a full FIFO leaves a visible gap (the terminal `overflow` event that follows carries the next `seq`). Frames discarded by design (§3.2) and dropped by F3/F4 get no `seq`; `madc/events-dropped` reports the F3/F4 count.
- `epoch` is the same value on **every** event of a connection, Rust-originated included; the UI never receives an event without both `epoch` and `seq`.
- `method` and `params`: for an engine notification, the engine's own `params`, passed through after §3.2 / §3.2.1 validation with **no** field added to or removed from them; for a Rust-originated event, exactly the `params` of §3.3 (`{ reason }` or `{ count, reason }`).

### 3.2 Closed forwarding set (anything else is dropped, §5 F3)

The A4 spec renders no streamed transcript ("Deltas (`item/agentMessage/delta`) are not rendered; this is not a transcript view", A4 spec §9; it asks for `room/updated`, `thread/started`, `turn/started`, `turn/completed` and `item/completed`, A4 spec §14.2). The forwarding set is therefore exactly those five plus the two Rust-originated events:

| `method` | Source | Shape check done in Rust before forwarding |
| --- | --- | --- |
| `room/updated` | engine (base §3) | §3.2.1 (a) |
| `thread/started` | engine | §3.2.1 (b) |
| `turn/started` | engine | §3.2.1 (c): `status` must be exactly `inProgress` |
| `turn/completed` | engine | §3.2.1 (d) |
| `item/completed` | engine | §3.2.1 (e): the closed `Item` union |
| `madc/transport-closed` | Rust-originated, §3.3 | built in Rust; `reason` from a closed set |
| `madc/events-dropped` | Rust-originated, §3.3 | built in Rust; `count` integer, `reason` from a closed set |

**Read and discarded in Rust (never forwarded, not an error, no `seq`):** `item/started` and `item/agentMessage/delta`. The reader still reads every such frame off the socket (that is the point of §2: the engine applies no write backpressure, `server.ts:2862-2869`), validates it as a frame (F2 still applies), counts it, and drops it. Because `seq` is assigned only to forwarded events, a discarded delta leaves no `seq` gap. Forwarding either one later needs a Surface amendment that also pins a WebView buffer bound.

`room/updated` is a **signal, not state**: it has no payload beyond `{reason, threadId}`, the UI never infers status from it, and its only permitted effects are in §3.4. The other forwarded engine notifications are per-connection streams delivered **only** for threads this connection loaded (`server.ts:2858-2869`); a thread loaded elsewhere has no stream on the desktop's connection.

#### 3.2.1 Shape checks (closed; a frame that fails any one is F4 `invalid-notification`, dropped and counted, never forwarded)

The check is **defence in depth** (the engine builds these shapes from `protocol/types.ts`, and the session store re-validates what it persists, `session-store.ts:1300-1360`); it exists because the UI reads these fields into the pane's receipt row. "id grammar" is `^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`. Extra keys beyond those named are **ignored, not rejected** (the UI reads only the named fields; `protocolVersion` is unchanged). A required key that is missing, or of the wrong JSON type, fails the frame.

- **(a) `room/updated`:** `params.reason ∈ {thread, turn, handoff, decision}`; `params.threadId` id grammar.
- **(b) `thread/started`:** `params.thread` object with `id` and `seatId` id grammar; `status ∈ {idle, active, closed}` (`types.ts:21`); `cwd` string or `null`; `createdAt`, `updatedAt` finite numbers; `preview` string.
- **(c) `turn/started`:** `params.turn.{id, threadId}` id grammar; **`status === "inProgress"`** (any other value fails); `error === null`; `completedAt === null`; `items` an array whose every element passes (e).
- **(d) `turn/completed`:** `params.turn.{id, threadId}` id grammar; `status ∈ {completed, interrupted, failed}`; `error` is `null` unless `status === "failed"`, in which case `{ code: integer, message: string }` (`types.ts:40`); `completedAt` a finite number; `items` an array whose every element passes (e).
- **(e) `item/completed`:** `params.threadId`, `params.turnId` id grammar, and `params.item` must be **exactly one member of the closed `Item` discriminated union** (`types.ts:145-151`). Common to all: `id` id grammar, `kind ∈ {userMessage, agentMessage, toolCall, toolResult, error, servedModel}` (`ITEM_KINDS`, `:61-68`), `status ∈ {inProgress, completed, failed}` (`:70`). An unknown `kind` fails. Then per `kind`:

| `kind` | Required fields (`types.ts`) |
| --- | --- |
| `userMessage` | `content`: array of `{ type: "text", text: string }` |
| `agentMessage` | `text`: string |
| `toolCall` | `name`: string; `arguments` present (any JSON) |
| `toolResult` | `callId`, `name`, `output`: strings; `isError`: boolean |
| `error` | `message`: string; `code`, if present, an integer |
| `servedModel` | `requestedModel`, `servedModel`, `backing`, `providerId`: non-empty strings; `lane ∈ {allowed-direct, allowed-via-vendor-agent, interactive-only, forbidden}`; `mode ∈ {interactive, headless}`; `fallbackFrom`: string or `null`; `vendorReported`: boolean (`:129-143`; the same value sets the session store enforces, `session-store.ts:1300-1306`) |

A `servedModel` item that passes (e) is still **not evidence** (§3.4 item 1; FDR-4(a)): the check only stops a malformed frame from reaching the receipt row.

Engine event types that exist but are **not** forwarded in A4: `item/started` and `item/agentMessage/delta` (discarded above). The typed set `ServerNotifications` is exactly six (`types.ts:399-407`), plus `room/updated`. A future engine notification is dropped (F3) until a pin adds it.

### 3.3 Rust-originated events

- `madc/transport-closed { reason }`, `reason ∈ { "eof", "read-error", "invalid-frame", "oversize-frame", "overflow" }`. Emitted **exactly once per epoch, and only** when the reader ends on its own, i.e. when it wins the `Open → Terminated` transition of §2.4. A desktop-initiated close (`disconnect_engine`, R4 cleanup, `confirm_quit`, `Exit`) emits nothing. Like every event on the channel it carries the connection's `epoch` and the next `seq` (§3.1), so `acceptEngineEvent` (§4.2) accepts it whenever its epoch is current, even after a visible gap. It is delivered through the reserved FIFO slot (§2.2 (i)) and **cannot be lost because the ordinary 4096 queue is full**. This **replaces A3 §6.5** ("engine dying while connected is detected only at the next user-triggered RPC", A3 pin:315-317): the UI can now say `✗ FAILED` and mark running panes `ended` without waiting for the next click. It adds no liveness polling (the reader blocks on the socket).
- `madc/events-dropped { count, reason }`, `reason ∈ { "unknown-notification", "invalid-notification" }` (queue overflow is terminal, §3.6), emitted at most once per second per reason, so a flood cannot flood the channel. The reader has no timer: it accumulates the count per reason and emits when it next processes a frame at least 1 s after that reason's last emission. It is an **ordinary** event (it takes an ordinary slot and a `seq`, and is refused by a full FIFO like any other); a pending count that cannot be flushed is simply lost with the connection, and it can never displace the terminal event.

### 3.4 What the UI does with events (contract; layout is in the A4 pin)

1. **No rendering from an unverified source of truth.** A streamed `item/completed` is *display state for the pane that started the turn*; it is not evidence. Non-receipt items are notified **before** they are persisted (`server.ts:2588-2593`), so they can vanish if the append fails (the turn then ends `failed`). Receipts and hashes come only from `session/read` and `room/inspect` (A4 pin §4).
2. **`room/updated` never triggers a request in A4.** It sets the Table-view note `room changed · Inspect room to refresh` until the next user `Inspect room` (A4 spec §9, an Iris addition the A4 pin lists as FOUNDER_DECISION_REQUIRED FDR-A4-3(f) with "accept" as the default). No automatic `room/inspect`, no timer, no loop (A3 §6.5 "no polling" holds). If the Founder declines that default, the fallback is one coalesced, single-flight `room/inspect` per burst with a dirty flag (no timers), which needs a Surface amendment.
3. **`turn/completed` for a thread with a pane on screen → exactly one `session/read` for that thread**, single-flight per thread. **Ruled (FDR-4(c), D-711):** this narrows A3 Q4/D-682's "never automatically" (A3 pin:53, 211-216) and nothing else. A turn that completes while its pane is hidden gets that same one read when the pane is next shown (A4 spec §9); it is still one read per completed turn. Never bulk, never on a timer, never on `room/updated`.
4. *(Removed: no delta buffer exists in A4, §3.2.)*
5. A `seq` gap, a repeated/decreasing `seq`, or `madc/events-dropped` marks every pane "stream gap" and still allows only the item-3 read when the relevant turn ends. A `seq` anomaly **never changes the connection state** (only `madc/transport-closed`, §4.3, may).

### 3.5 Delivery mechanism in a no-bundler WebView (Surface ruling; UNVERIFIED)

The shipped UI is plain JS with no build step; it only uses `window.__TAURI_INTERNALS__.invoke` (`shell.js:506-512`). Three candidates, in recommended order:

- **(A) `app.withGlobalTauri: true`** in `tauri.conf.json`, UI uses `window.__TAURI__.event.listen("madc:engine-event", …)`. Documented API; one config key; the CSP (`script-src 'self'`) is unchanged. Requires the A3 §9.12 `tauri.conf.json` test to allow this one key.
- **(B) `__TAURI_INTERNALS__` `plugin:event|listen` + `transformCallback`:** no config change but uses an internal shape that is version-fragile.
- **(C) A `drain_engine_events` command** (UI pulls a bounded ring buffer): no event capability and fully testable with the existing fake `invokeFn`, but it is a poll of a *local* buffer and needs a timer, which A3 §6.1 otherwise forbids; only if (A) and (B) both fail the smoke test.

Fail-closed rule: the builder proves in a real Tauri window (not the fake harness) that an event emitted from Rust reaches the chosen listener under `core:default` and the CSP, and states the result in the PR body. If neither (A) nor (B) can be shown, A4 does not claim live panes and falls back to (C) via a Surface amendment. Whether `core:default` carries `core:event:default` for window `main` is unverified (§12 item 1).

### 3.6 Volume control

No coalescing is needed in A4: the high-rate notification (`item/agentMessage/delta`) is discarded in Rust (§3.2), and the five forwarded engine notifications fire at thread/turn/item granularity. If the forward queue already holds 4096 ordinary events (**proposal**) when another forwardable event arrives, the connection ends with `madc/transport-closed { reason: "overflow" }` through the reserved slot (§2.2 (i), §2.4). The event that did not fit is not silently dropped: it consumed a `seq`, so the UI sees a gap, and the connection is ended rather than continued with a hole. The terminal event is never dropped.

---

## 4. Connection epoch for events (stale events must not flip state)

### 4.1 Rust assigns the epoch

- `static NEXT_EPOCH: AtomicU64`, process-lifetime, starting at 1, never reused or reset. Each `SocketClient` takes the next value at construction.
- **Field name (one choice, no alternatives).** `ConnectionInfo` (`launcher.rs:64-72`) already derives `Serialize, Deserialize` with `#[serde(rename_all = "camelCase")]` at struct level (`:65`), and every existing field is a snake_case Rust name emitted as camelCase (`socket_path` → `socketPath`, `cold_start_ms` → `coldStartMs`; `src/ipc.ts:54-61` mirrors them). A4 adds **one** field in the same style: Rust `pub connection_epoch: u64`, with **no per-field `#[serde(rename)]`**. The wire JSON key is therefore exactly **`connectionEpoch`** (never `connection_epoch`), and `DesktopConnectionInfo` in `src/ipc.ts` gains `readonly connectionEpoch: number`. The **event envelope** key is the different, shorter **`epoch`** (§3.1); the UI compares `ev.epoch === lastConnectionInfo.connectionEpoch`. Test: §13 item 5 serializes `ConnectionInfo` and asserts the key set.
- `connect_engine` returning a cached client (`main.rs:29-31`) returns the **same** epoch. `ipc.ts` is therefore edited in A4 (A3 left it unchanged).
- **Who may emit.** An event is emitted only by the §2.4 mechanism: ordinary events only while the client's state is `Open` and only for the process's current client (`event.epoch == current_epoch`); the single terminal event as the §2.4 exception. A desktop-initiated close moves the state to `Closed` **before** it stops `serve` (§2.4 step 4), so events queued behind a disconnect are discarded, never delivered. (r2 wording "unless the client's `closed` flag is unset" is replaced; it contradicted §2.2 (ii) for the terminal event.)

### 4.2 The UI's acceptance rule (one pure function, unit-tested)

`acceptEngineEvent(state, ev)` returns "accept" iff **all** hold: `ev.epoch === lastConnectionInfo.connectionEpoch`; `connectionState === "CONNECTED"`; `disconnectPending === null`; `ev.method` is in the §3.2 set; `ev.seq` is a positive integer greater than the last accepted `seq` for that epoch (or is the first). Otherwise the event is **dropped without rendering and without touching connection state, pane state, receipts or `#output`**. (A gap/regression additionally sets the §3.4 item 5 "stream gap" flag; it is the only side effect, and only when `epoch` matched.) **Contiguity is not required:** a `seq` greater than `last + 1` is **accepted** and sets the flag; only a repeated or lower `seq` is dropped. That is what lets a `madc/transport-closed` that follows an overflow gap (§2.4) still be accepted. `madc/transport-closed` and `madc/events-dropped` are in the §3.2 set and carry `epoch`/`seq` like any event, so this rule treats them identically. A terminal event that arrives while `disconnectPending !== null` is dropped by the rule above: the user's own Disconnect is already in flight and will reach the same `DISCONNECTED` end state.

### 4.3 Which event may change connection state

Only `madc/transport-closed` whose `epoch` equals the current epoch while `CONNECTED`: state → `✗ FAILED`, panes with an in-flight turn → `ended (connection closed)`, then **one** `disconnect_engine` under the A3 §6.1 single-flight/cleanup rule (Connect disabled until it settles, no retry, no `connect_engine`). In Rust that call lands on §2.4 transition 3 (`Terminated → Closed`): it stops an owned `serve`, drops the socket, emits nothing, and is idempotent. A `madc/transport-closed` for any other epoch is dropped (the A3 N5 rule, extended to events: A3 pin:266, `shell.js:705`, `:1030`, `:1231`).

The UI's existing binder `epoch` (`shell.js:705`) is unchanged and still guards `rpc_request` results; the Rust epoch guards **events**. They are separate counters on purpose: a request issued in epoch N may resolve after the UI has moved to N+1, and an event stamped N may arrive after `connect_engine` returned N+1.

### 4.4 Panes and epochs

A pane is bound to the `(connectionEpoch, threadId)` it was created in. After a disconnect, R4 cleanup, or reconnect, a pane from an earlier epoch is **history only** (engine interrupted its turn and closed its thread, `server.ts:532-565`); it must not accept events or send `turn/start`/`turn/interrupt`, and its Send/Interrupt controls are disabled with metadata `connection ended`. Continuing the thread would need `thread/resume` (deferred, FDR-1 / D-708).

---

## 5. Fail-closed behaviour (named outcomes; each gets a test)

| # | Input | Outcome |
| --- | --- | --- |
| F1 | `rpc_request` method not in §1.1 (including `thread/resume`, `decision/*`, `auth/*`) | Refused in Rust, before lock/connection check/write; message `RPC method not allowed by M3-A2 desktop shell: {method}`; UI renders R1 (defect guard), state unchanged |
| F1b | Allowed method, params violating §1.2 | Refused in Rust before write and before the lock; `RPC params refused by desktop shell for {method}: {reason}`; UI renders R5 (defect guard); **never** `disconnect_engine` (killed mutation, §1.2 item 4) |
| F2 | Frame that is invalid JSON, not an object, has both `id` and `method`, has neither, or exceeds the line cap | Connection treated as compromised: the reader takes `Open → Terminated` (§2.4), pending requests fail, exactly one `madc/transport-closed { reason: "invalid-frame" \| "oversize-frame" }` is enqueued, `serve`/socket handled by the A3 cleanup rule, **no retry** |
| F3 | Notification whose `method` is not in §3.2 | Dropped, never forwarded, counted; `madc/events-dropped { reason: "unknown-notification" }` (rate-limited) |
| F4 | Allowed notification whose `params` fail the §3.2.1 shape check (including an `Item` that is not a member of the closed union, a `servedModel` item missing a required field, or a `turn/started` whose `status` is not `inProgress`) | Dropped, counted; `reason: "invalid-notification"` |
| F5 | Response with an unknown/late `id` | Dropped, counted; not forwarded |
| F6 | Event with stale `epoch`, wrong state, `disconnectPending`, unknown `method`, or non-increasing `seq` (UI side, §4.2) | Dropped without rendering or state change |
| F7 | `room/updated` / stream event for a `threadId` the UI has no pane for | No request is made (§3.4 item 2: only the Table stale note is set); no pane is created from an event |
| F8 | `turn/start` params with `mode: "interactive"` | Refused in Rust (F1b); no presence claim is ever sent |
| F9 | Engine `-32007` on `turn/start` (including every presence-gated lane over the socket, §16.7) | R3: connection stays `CONNECTED`; pane shows the engine's `providerId`/`reason`/`status` verbatim; no retry, no mode escalation |
| F10 | Any `madc/*` method arriving from the **engine** | Dropped (F3): only Rust may originate `madc/*` events; a UI that receives one with an epoch it cannot match drops it (F6) |

---

## 6. Bounded exit path (folds in D-660 / D-666)

Problem: on `RunEvent::Exit` the app calls `state.0.lock()` (unbounded) and then `client.disconnect()` (≤ 7 s) (`main.rs:121-129`); amendment-1:131 bounds only the child wait. An in-flight `rpc_request` holds the same mutex for up to 10 s (`main.rs:48-62`, `launcher.rs:31`), and requests queue behind it.

Pin: **from the moment `RunEvent::Exit` is observed, the desktop has stopped its `serve` child (or dropped its socket, when it only attached to a reused listener) within `EXIT_BOUND = EXIT_LOCK_WAIT + INITIALIZED_KILL_GRACE`, with `EXIT_LOCK_WAIT = 2 s` (proposal) and `INITIALIZED_KILL_GRACE = 7 s` (amendment-1:131, `launcher.rs:28`): 9 s total**, whatever RPCs are in flight. Mechanism requirements (how, not structure):

1. Exit sets a `shutting_down` flag first; from then on `rpc_request` refuses with `desktop shutting down` and `connect_engine` refuses likewise.
2. The reader/pending state of §2 makes the request mutex a short write lock, so a blocked reply wait no longer holds it; Exit still takes the lock with a **2 s `try_lock` deadline**, never an unbounded `lock()`.
3. If the lock is not obtained, Exit still stops the child: the stdin handle (the EOF trigger, amendment-1:83), the child reaper, the §2.4 state word and the §2.4 socket cancel handle must be reachable **without** the request lock (for example held in a separate `Arc<Mutex<…>>`), and the SIGKILL fallback follows the existing 7 s rule. A poisoned lock (`main.rs:124` today silently skips on `Err`) must **not** skip the stop.
4. `disconnect_engine` (user Disconnect, protocol-mismatch release, R4 cleanup) no longer queues behind an in-flight RPC wait (it runs the §2.4 cancellation sequence: state to `Closed`, socket `shutdown`, pending requests failed with `engine socket closed before response`, then stops an owned `serve`). This **supersedes the A3 §6.1 sentence** that it "waits on the shared engine-state mutex behind any in-flight `rpc_request` (up to the 10 s RPC deadline each)" (A3 pin:263); the 7 s grace remains.
5. Consequence, stated on purpose (`server.ts:532-565`): quitting while turns run interrupts them (`interrupted`, `session.close` written, locks released within the engine's own 5 s deadline). **Ruled (FDR-5, D-712):** accepted, and it is shown in the quit flow (§6.1).

### 6.1 Close-request hook for the quit flow (answers A4 spec §14.6)

Verified at `870c1f7e`: `main.rs:109-120` builds the app with one managed state and three commands and registers **no** window-event or close-request handler; the only lifecycle hook is `RunEvent::Exit` (`main.rs:120-132`). A4 adds, in `main.rs` only:

1. A Tauri v2 window-event handler for window `main` on `WindowEvent::CloseRequested`, and a `RunEvent::ExitRequested` arm (macOS `Cmd+Q`). Rust tracks, per epoch, a **guard**: `guard = pendingStarts + |inFlightTurnIds|`, where (a) `pendingStarts` counts `turn/start` requests from the moment they are admitted under the write lock (before the write) until the reply, a refusal, an error, a timeout, or the connection leaving `Open` (§2.4); (b) when the reader dispatches a reply to a pending `turn/start` (the pending map records each request's method) whose `turn.status` is `inProgress`, it inserts `turn.id` into `inFlightTurnIds` **before** handing the reply to the waiter, so there is no instant at which both are zero; (c) a forwarded `turn/started` inserts its `turn.id` **idempotently** (the id from (b) is not counted twice), and a forwarded `turn/completed` (any status) removes it. A refused or errored `turn/start` adds nothing. The guard is **reset to empty when the state leaves `Open`** (`Terminated` or `Closed`): the engine has ended every turn of that connection (`server.ts:538-541`), so a dead connection cannot hold the quit dialog open. A `turn/completed` that never arrives (dropped by F4; or lost to overflow, which also ends the connection) leaves its id in the set: that errs toward showing the dialog, never toward quitting silently, and the user can still choose **Quit and interrupt**.

   **Why (a) and (b) are required, verified at `870c1f7e`.** `#answer` (`server.ts:737-746`) sends the JSON-RPC response first (`:738`) and only then runs `result.after?.()` (`:740`). `turn/start` returns `{ value: { turn: snapshot }, after: () => { this.#notify("turn/started", …); … } }` (`:2313-2320`; the notify is `:2316`). Copilot's cite `server.ts:738-740, 2316-2320` is therefore correct in substance (the `#answer` signature is `:737`; the after hook starts at `:2315`). A close in the response-to-`turn/started` gap would otherwise see a zero guard and skip the quit dialog even though a turn is already active on the engine.
2. Guard `0`: allow the close; the §6 bounded exit path runs as today.
3. Guard `> 0`: prevent the close/exit once and emit `madc:quit-requested { epoch }` on the §3.1 mechanism. The WebView shows the A4 spec §10 dialog. **Keep running** does nothing. **Quit and interrupt** invokes one new command, `confirm_quit`, which sets `shutting_down` and runs the §6 bounded exit path, then exits. The UI sends **zero** `turn/interrupt`; the engine records the interruptions.
4. Fail closed: if the WebView does not answer (no listener, crashed renderer) a second close request within the same epoch is **not** prevented. A forced quit, OS kill or crash shows no dialog; the engine still interrupts the turns (`server.ts:538-541`).
5. `confirm_quit` is the only new Tauri command. It takes no arguments and is not an RPC, so the §1 allowlist does not apply to it.

UNVERIFIED (§12 item 5): that Tauri 2.12.7 routes macOS `Cmd+Q` through `RunEvent::ExitRequested` with a preventable API. The builder proves both paths in a real window and states the result in the PR body.

Test: a Rust test holds a pending request (peer that never answers) and a poisoned-lock variant, triggers the exit path, and asserts the child is gone within `EXIT_BOUND` + a small tolerance (follows the existing grace tests, `launcher.rs:1346`, `:1520`).

---

## 7. `serve` stdin error (folds in D-665; D-661 stays open)

Amend amendment-1 §3(a) (line 83) to read, in substance: "**(a) EOF, or an error, on its stdin.** An stdin error is handled as EOF: it triggers the same clean shutdown and `serve` exits 0 (`SERVE_EXIT.OK`, `clean`). As built at `packages/engine/src/serve.ts:196-201` (`onStdinError` and `onStdinEnd` both call `onTrigger(SERVE_EXIT.OK, null, "clean")`) and locked by test `M3A2-C1` (`packages/engine/src/serve.test.ts:1546`)."

Status handling (the point of keeping **D-661 open**): this text is **descriptive of built behaviour**, not the Founder's confirmation. The relayed ruling FOUNDER-B (D-661) is recorded as "relayed, not posted on GitHub"; merging this amendment closes the pin-text gap D-665 and does **not** close D-661. FDR-7(a) (accepted, D-714) asks Mike to confirm D-661 (and D-660, D-654) on GitHub, for example in a PR comment or the merge note, so later pins can cite them as confirmed. Until then they stay `needs-confirmation`.

---

## 8. Supersession of A3 text (no edit to the A3 pin)

The A4 design pin lists these in its §2; this amendment states the protocol-side ones so they bind even if the design pin changes:

| A3 text | Superseded by |
| --- | --- |
| A3 §6.5 / pin:315-317 (engine death detected only at next RPC) | §3.3 `madc/transport-closed` |
| A3 §6.4 R1 "UI only ever sends `room/inspect` and `session/read`" (pin:310) | §1.1 list; R5 added (§1.2) |
| A3 §6.1 `disconnect_engine` waits behind in-flight RPCs (pin:263) | §6 item 4 |
| A3 Q4 / D-682 "never automatically" (pin:53, 211-216) | §3.4 item 3 (FDR-4(c), D-711): narrowed, not replaced |
| A3 §7 deferrals for `ALLOWED_RPC_METHODS`, `launcher.rs`/`main.rs` edits, live `room/updated`, multi-seat composer (pin:323-325) | This amendment and the A4 design pin |
| A3 §9.12 `tauri.conf.json` assertion (pin:352 area) | Allow `app.withGlobalTauri` only if §3.5 (A) is chosen |
| `src/ipc.ts` "stays unchanged" (A3 D5) | `connectionEpoch` and typed A4 methods added (§4.1) |

Not superseded: A3 §6.1 single-flight, §6.2-§6.3 `connect_engine` grammars G1-G6, §6.4 R2/R3/R4 semantics, the evidence tone invariants, the connection epoch for **requests**.

---

## 9. Carried and kept open (explicitly not decided here)

- **D-654 / D-663 / D-664 (`engine.lock` crash residue, boot-time rule).** The Founder's relayed ruling chose option (a) (treat a pre-boot holder as dead, plus a clock-skew margin) via a Surface amendment (D-663) and a follow-up act (D-664), **both before M3-A8**. Amendment-1:214 still reads "a boot-time rule is not adopted and needs a Founder ruling" and remains true text until that amendment merges. **Not bundled here (ruled FDR-7(b), D-714: the D-663 amendment stays a separate file).** The A4 builder must not implement any boot-time rule.
- **D-661** stays open (§7).
- **D-648 / D-670 / D-676:** Windows pipe ACL and transport remain unverified; A4 is POSIX-only.
- **D-688:** live WebView `@font-face` under CSP and live glass smoke remain with the `chore/desktop-webview-harness` rebase; A4 claims neither.
- Carried risks of amendment-1 §9 (lines 209-217) are unchanged.

## 10. Pointer lines this PR adds (exact; no other edit to these files)

- **`docs/plan/PIN-madc-M3-desktop-protocol-amendment-1.md`:** insert directly under the status paragraph, after a blank line, as line 5 (so amendment 1's lines from 4 on move down by two), per `README.md:5-7`:

  `*Amended by `PIN-madc-M3-desktop-protocol-amendment-2.md` (2026-11-27, Surface Architect, M3-A4): extends the desktop `ALLOWED_RPC_METHODS` to `seat/list`, `thread/start`, `turn/start`, `turn/interrupt`; adds the reader-thread and engine-event forwarding path and connection epochs for events; pins fail-closed rules and a 9 s total exit bound (D-660/D-666); records the `serve` stdin-error exit-0 text for §3(a) (D-665; D-661 stays open); supersedes §5's unbounded Exit-path wording only as stated there. D-654/D-663/D-664 untouched.*`

- **`docs/plan/PIN-madc-M3-desktop-protocol.md`:** add after line 6 (the A3 design pin pointer), as line 7:

  `*Amended by `PIN-madc-M3-desktop-protocol-amendment-2.md` (2026-11-27, Surface Architect, M3-A4): the desktop method set beyond the read-only §2 methods, the forwarding of §3 `room/updated` and the per-connection thread/turn/item streams to the WebView with epoch-tagged events and fail-closed rules, and a bounded exit path; no engine method, param, result shape or error code changes; `protocolVersion` stays `madc-m1/1`.*`

- **`docs/plan/README.md`:** add index rows for this file, the A4 design pin, and the verbatim Iris A4 spec (after row 49).
- The A3 design pin gets its pointer from the **A4 design pin**, not from this amendment (A4 pin §2.6: C53 / D-722 on the D-680 shortcut text, plus a header pointer).

## 11. Out of scope

`thread/resume` (FDR-1), `thread/list`, `thread/handoff`, `decision/*`, `provider/list`, `auth/*`; forwarding `item/started` or `item/agentMessage/delta`; any desktop presence/TTY mechanism (FDR-3, D-710); live worktree `HEAD` (the engine records only open and close identity, `server.ts:567-599`); `thread/close` (does not exist, §16.4); Windows; packaging; the D-654 boot-time rule; any engine change; M3-A5+ views.

## 12. UNVERIFIED (fail-closed rules)

1. **Tauri event delivery in a no-bundler WebView and the `core:default` event permission** (§3.5): builder smoke test in a real window; else no live-pane claim.
2. **Measured `thread/start` / `turn/start` latency** vs the 10 s deadline: builder reports observed values; the deadline stays 10 s.
3. **Frame/line cap 8 MiB, event buffer 4096, input cap 64 KiB, exit lock wait 2 s** are Surface proposals, not measurements.
4. **`room/updated` vs stream ordering across connections** is asserted only for the originating connection (`socket-search.test.ts:1130-1160`).
5. **Close/exit interception** (§6.1): `WindowEvent::CloseRequested` and `RunEvent::ExitRequested` under Tauri 2.12.7 on macOS and Linux; builder smoke test in a real window.
6. **`shutdown(Both)` wakes a reader blocked in `read_line`** on an `AF_UNIX` stream socket (§2.4 step 4) on macOS and Linux: builder test with a silent peer (§13 item 7c). If either platform does not wake it, the builder stops and files a Surface amendment; it does **not** fall back to a read timeout on its own (a timeout may only be introduced by a pin that also says a `WouldBlock`/`TimedOut` is idle, never terminal).
7. **Events that precede the UI learning the epoch.** Events emitted between `initialize` and the UI recording `connectionEpoch` (for example a `room/updated` during the handshake) reach the WebView before the UI can match their epoch and are dropped by F6. That is intended: no pane can exist yet (a pane needs `thread/start`, which needs `CONNECTED`). A `madc/transport-closed` inside that window would also be dropped; `connect_engine` narrows it by returning `Err` when the state is not `Open` at return (§2.4), and the remainder is detected at the next RPC (A3 R4), as today, with no polling added. The builder reports whether the window is observable in a real Tauri window.

## 13. CI-testable acceptance (headless; no network, no keychain, no real model)

Rust (`cargo test`): (1) `ALLOWED_RPC_METHODS` equals the §1.1 list exactly (`initialize`, `room/inspect`, `session/search`, `session/read`, `seat/list`, `thread/start`, `turn/start`, `turn/interrupt`). The denied list in `rpc_allowlist_permits_only_m3_a2_methods` (today `launcher.rs:733-747`) **drops** only `turn/start` and `thread/start` (currently `:734-735`) and **keeps, and extends to**, `thread/resume`, `thread/list`, `thread/handoff`, `decision/raise`, `decision/list`, `decision/resolve`, `auth/status`, `auth/set`, `auth/remove`, plus the existing `"room/inspect "` and `""`. (Today's array is missing `thread/list`, `decision/list`, and `auth/status`; A4 adds them.) The `main.rs` N7 test's denied example is today `turn/start` at **`main.rs:143`** (not `:148-150`, which is the `!contains("not connected")` assertion); A4 replaces that example with a still-denied method such as `thread/handoff`. (2) `validate_rpc_params` table: every §1.2 accept/refuse row, including `mode:"interactive"`, two input parts, unknown key, NUL in `cwd`, relative `cwd`. (2b) **R5 killed mutation** (§1.2 item 4): invalid params on a live client return the R5 string, do not close the socket or stop `serve`, and a follow-up valid `room/inspect` still writes; the R5 arm contains no `disconnect`. (3) A fake socket peer sends interleaved responses and notifications (and a late reply): responses reach the right request, notifications are forwarded in order with strictly increasing `seq`, the late reply is dropped. (3b) **Hand-off, not drop** (§2.3): a `room/updated` (and, separately, a `turn/started`) arriving while `request_with_deadline` is waiting, and also during `initialize`, is classified/forwarded and is not lost; the current `:545-548` `continue` path is gone. (4) F2-F5 each with a fake peer (invalid JSON, both `id` and `method`, 9 MiB line, unknown notification, bad `reason`); `item/started` and `item/agentMessage/delta` are read, counted and never emitted, and consume no `seq`. (4b) **Shape table (§3.2.1):** for each of the five forwarded engine methods, one accepted fixture and one refused fixture per row: `turn/started` with `status` `completed`/`failed`/`interrupted` is refused (only `inProgress` passes); `turn/completed` with `status: "inProgress"` is refused; `failed` without `error`, or a non-`failed` turn with an `error`, is refused; `item/completed` with an unknown `kind`, with a `servedModel` item missing each of `requestedModel`, `servedModel`, `backing`, `providerId`, `lane`, `mode`, `fallbackFrom`, `vendorReported` (one case each), with `lane: "bogus"`, or with `vendorReported: "yes"` is refused and counted as `invalid-notification`; an `Item` with extra unknown keys is accepted. **No false F4:** recorded frames of every forwarded and discarded notification kind, captured from the engine's own emissions (the `socket-search.test.ts` ordering fixtures, `:942-1160`, plus a `servedModel` turn), are all accepted. (5) Epoch: two sequential clients get different epochs; a `Closed` client emits nothing after `disconnect`. **Key name:** serializing `ConnectionInfo` yields a `connectionEpoch` key and **no** `connection_epoch` key, and the TS `DesktopConnectionInfo` type check includes `readonly connectionEpoch: number`; every event carries `epoch === connectionEpoch`. (6) Exit bound (§6); close-request with zero in-flight or running turns closes, with one running turn (a forwarded `turn/started`) emits exactly one `madc:quit-requested` and does not exit until `confirm_quit` (§6.1). (6a) **Close in the response-to-`turn/started` gap (§6.1):** a fake peer answers `turn/start` with `{ turn: { status: "inProgress", id, threadId } }` and does **not** send `turn/started`; a close request in that gap prevents the close and emits exactly one `madc:quit-requested`. (6b) A `turn/start` that has been written and not yet answered: the same (prevent close, one `madc:quit-requested`). (6c) After `turn/completed`, or after a refused/errored `turn/start`, the guard is zero and close is allowed. (6d) **No double count:** the same turn id arriving by reply (b) and then `turn/started` (c) counts once, and one `turn/completed` returns the guard to zero. (7) **Reader EOF is terminal** (§2.2): a peer close (0-byte read) yields exactly one `madc/transport-closed { reason: "eof" }`, fails pending requests with `engine socket closed before response`, and the reader thread has returned within a short bound (no hang, no second wait). A full 4096-event queue does not block the read loop (overflow behaviour as pinned). (7a) **Reserved terminal slot:** the ordinary queue is filled to 4096; the next forwardable frame (overflow), and separately an EOF while the queue is full, each still delivers exactly one `madc/transport-closed` with the matching `reason` as the **last** event delivered, with the current `epoch` and a `seq` greater than every earlier event (the overflowed frame leaves a visible `seq` gap), and the connection is no longer treated as live. A mutation that drops the terminal event when the queue is full, or that delivers it out of order, must fail this test. (7a2) **Exactly once, atomically (§2.4):** (i) EOF and overflow each yield **exactly one** `madc/transport-closed`; the state is `Terminated` at the moment it is enqueued, and a mutation that checks a `closed` flag before emitting it (the r2 contradiction) must fail; (ii) race test, repeated many times with the reader's EOF and `disconnect_engine` released together: exactly one of {one terminal event and no desktop-win} / {zero terminal events and state `Closed`} occurs, never two events, and never a terminal event enqueued after `disconnect_engine`'s transition won; (iii) after `madc/transport-closed`, the UI's one `disconnect_engine` is idempotent in Rust and emits nothing. (7a3) **Rust-originated events are accepted (§3.1, §4.2):** feed the UI's `acceptEngineEvent` the exact events a fake peer provokes (an overflow gap then `madc/transport-closed`; an F4 drop then `madc/events-dropped`): both are accepted with a current `epoch` and strictly increasing `seq`, the gap sets the stream-gap flag, and the terminal event moves `CONNECTED` → `FAILED`. (7b) **Idle reader has no read timeout:** after `initialize`, a peer that stays open and sends no frames for **more than 10 s** (e.g. 11 s) emits **zero** `madc/transport-closed` events; a subsequent valid `room/inspect` is written and answered on the same connection. Reintroducing `set_read_timeout(Some(INTERACTIVE_RPC_TIMEOUT))` on **any** handle of the socket (reader stream, writer clone, or cancel handle: they share `SO_RCVTIMEO`, §2.2 (iii)) must fail this test. (7c) **Reader cancellation, including a reused listener (§2.4):** a peer that stays open and silent; the client is attached as `reusedExisting: true` (no owned `serve`). `disconnect_engine` returns without joining; the reader's `reader_done` flag is set within 2 s (**proposal**); zero events are emitted; pending requests failed with `engine socket closed before response`. The same with an owned `serve` child, and for the `Exit` path with a held request lock. A mutation that removes the `shutdown` must fail this test (the reader stays blocked). (7d) **Quit after terminal:** after `madc/transport-closed` the §6.1 guard is empty and a close request closes without a dialog.

UI (`node --test` / `bun test`, fake `invokeFn`/listener, no DOM beyond the A3 harness): (8) `acceptEngineEvent` table (stale epoch, `DISCONNECTED`, `disconnectPending`, unknown method, `seq` regression); stale events change nothing. (9) Only a current-epoch `madc/transport-closed` moves `CONNECTED` → `FAILED` and invokes `disconnect_engine` once; no `connect_engine`/`rpc_request` follows. (10) **R5 killed mutation (UI):** `classifyRpcError` maps the R5 string to a defect guard; with a `RUNNING` pane and `CONNECTED` state, `disconnect_engine` is invoked **zero** times and the pane stays `RUNNING` (pairs with (2b)). (11) A `room/updated` (any `reason`, any count) triggers **zero** `room/inspect` and zero `session/read`, and sets the Table stale note (§3.4 item 2). (12) `turn/completed` triggers exactly one `session/read` per visible pane, none for a hidden pane until it is shown, then exactly one. (13) Quit dialog: confirming invokes `confirm_quit` once and `turn/interrupt` zero times.

Engine (`node --test`): **none required**; `socket-search.test.ts` already pins `room/updated` and `turn/*` ordering (`:942-1160`).

## 14. Founder rulings applied, and what stays open

| FDR | Ruling (Mike, 2026-11-27 9:26 PM ET, "Accept all eight recommended defaults"; relayed) | Clio id | Where applied |
| --- | --- | --- | --- |
| FDR-1 | Allow `thread/start`, `turn/start`, `turn/interrupt`, `seat/list`; defer `thread/resume` | D-708 | §1.1 (spec discrepancy recorded) |
| FDR-2 | Typed absolute `cwd` for A4 | D-709 | §1.2; A4 pin §5.3 |
| FDR-3 | Presence-gated lanes unreachable from the desktop; the pane shows the refusal | D-710 | §5 F8-F9; §16.7 |
| FDR-4 | (a) streamed `servedModel` verified only after `session/read`; (b) head labelled `head@open`; (c) one auto `session/read` per completed turn on a visible pane, narrowing D-682 | D-711 (b narrowed by D-720) | §3.4; A4 pin §4 |
| FDR-5 | Quit interrupts running turns, shown in the quit flow | D-712 | §6 item 5, §6.1 |
| FDR-6 | (a) settled by the Layout A pick (D-716); (b) Safari < 18 opaque fallback (D-699) confirmed | D-713 | A4 pin §5.2 |
| FDR-7 | (a) confirm D-660/D-661/D-654 on GitHub; (b) D-663 amendment kept separate | D-714 | §7, §9 |
| FDR-8 | R4 timeout cleanup interrupts every pane's turn; consequence recorded | D-715 | §1.3 |

All are `needs-confirmation` in Clio's ledger (relayed, not on GitHub). Merging this PR is the Founder's on-record act for the text above; it does not by itself close D-654, D-661, D-663 or D-664.

The only open FOUNDER_DECISION_REQUIRED items are design-side and are listed in A4 pin §1.1 (FDR-A4-1..FDR-A4-4). The one that touches this amendment is FDR-A4-3(f) (the Table stale note instead of an automatic `room/inspect`, §3.4 item 2).

## 15. Re-verified engine and launcher facts (line-accurate at `870c1f7e`)

MADC Architect reviewed the protocol findings and agrees with the 8-method allowlist. The cites below were re-checked against the `_src/` archive of `870c1f7e`. Where an Architect cite was one or two lines off, the **archive-accurate** span is used and the difference is noted.

**Architect-reviewed launcher / dispatch cites (corrected where needed):**

- Allowlist: `packages/desktop/src-tauri/src/launcher.rs:35-40` (agreed).
- `subscribeRoom: true` is sent on the desktop's `initialize`: `launcher.rs:434-441`, the `capabilities` key at **`:438`**. (Architect `:433-437` starts on a blank line and ends on `clientInfo`; `subscribeRoom` is `:438`.)
- Notifications skipped today: `launcher.rs:545-548` (agreed; this is the `continue` §2.3 removes).
- Engine dispatch, no `thread/close`: `packages/engine/src/server.ts:772-803` (the `switch` is `:771-806`; Architect `:772-802` ends at the `session/search` case; `session/read` is `:802-803`; no `thread/close` case exists anywhere in the switch).
- `turn/start` refuses an unloaded thread with `-32002`: `server.ts:2171-2172` (`this.#threads.get(threadId)` then `throw threadNotFound(threadId)`). (Architect `:2170-2171` is the preceding comment plus the `get`; the throw is `:2172`.)
- `#send` ignores `write()`'s return: `server.ts:2862-2869`, the write at **`:2865`** (`this.#opts.output.write(encodeMessage(message));` with no test of the return value; `#notify` at `:2858-2860` is the only caller for `turn/*` / `item/*`). (Architect `:2866-2872` starts at the `catch` and includes `#log`.)
- Shutdown interrupts every active turn, then emits `room/updated` only to other subscribers: `server.ts:532-565` (Architect `:534-565` is the body after the signature). Interrupt loop `:538-541` (`#finishTurn(..., "interrupted")`); comment and emit `:553-558` ("only OTHER subscribers (socket broadcast) receive these").
- Allowlist test to change: denied array `launcher.rs:733-747` (Architect `:733-752` includes the start of the next test at `:750`). `turn/start` and `thread/start` are `:734-735`; A4 drops those two and keeps/extends the rest per §13 item 1.
- N7 test to change: the denied method example is **`main.rs:143`** (`rpc_request_blocking(&state, "turn/start", json!({}))`). Replace with a still-denied method such as `thread/handoff`. (Architect `:148-150` is the `!denied.contains("not connected")` assertion, not the example.)

**Five evidence sets the Architect asked to re-verify (they did not verify these):**

### 15.1 `room/inspect` has no live worktree HEAD

- The row type is `RoomThreadRow.worktree = { open: WorktreeIdentity | null, close: WorktreeIdentity | null, missing: boolean }` (`packages/engine/src/inspect.ts:147-151`, assembled at `:287-291`).
- `open` is taken from the seq-0 `session.open` payload (`inspect.ts:246-249`); `close` is taken from a `session.close` payload if one exists (`:250-260`). There is no third, live field and no `git` call inside `inspectRoom`.
- `WorktreeIdentity.head` is "HEAD at that top-level, 40 lowercase hex; null only for an unborn branch" (`session-v2.ts:28-29`) — the value recorded on that event, not a live read.
- `session.close` is the only place the engine re-reads `worktree.head`, and only "at the RECORDED top-level" on a clean shutdown (`session-store.ts:138-143`; `server.ts:567-599`, `rereadWorktreeIdentity` at `:594-597`). A live thread therefore has `worktree.close === null`. The UI must label an open-row `head` as `head@open` (FDR-4(b), D-711); it is verified on a valid 40-hex SHA alone (D-720, A4 pin §4.4).

### 15.2 `room/inspect` has no `servedModel` or `lane`

- `RoomThreadRow` (`inspect.ts:136-154`) has `threadId`, `path`, `seatId`, `level`, `chain`, `handoff`, `worktree`, `openDecisions`, `findings`. It has **no** `servedModel`, `requestedModel`, `lane`, `mode`, `backing`, `vendorReported`, thread `status`, or active `turnId`.
- Those receipt fields live on `ServedModelItem` (`protocol/types.ts:129-143`) and on the `servedModel` session event (`session-store.ts:94-108`), delivered either as an `item/completed` notification (`server.ts:2572-2583`, persisted first) or inside `session/read` `events[]` (`search.ts:158-172`).

### 15.3 Which lanes are presence-gated

- The predicate is `presenceRequired(entry) === canServe(entry, "interactive") && !canServe(entry, "headless")` (`packages/engine/src/presence/policy.ts:30-33`). The module comment (`:9-14`) names the set: every `interactive-only` lane (MiniMax Token Plan, Alibaba Coding Plan) and an `allowed-direct` lane with `headless: "denied"` (`ollama-cloud`, D-M1-3).
- Catalog: `minimax-token-plan` `status: "interactive-only"` (`packages/registry/src/catalog.ts:200-201`); `alibaba-coding-plan` `status: "interactive-only"` (`:216-217`); `ollama-cloud` `status: "allowed-direct"`, `headless: "denied"` (`:79-90`). `canServe` (`catalog.ts:395-400`) returns interactive-only for `"interactive"` only, and allowed-direct headless only when `headless === "allowed"`.
- A client's `mode: "interactive"` is "necessary but never sufficient" (`presence/policy.ts:5-7`). Headless refusals are `interactive-only-headless` / `headless-not-permitted` (`packages/registry/src/assert.ts:43-60`).
- Consequence for A4: the seeded `surface-architect` seat has `preferredBacking: "ollama-cloud"` (`packages/engine/src/seats/roster.ts:87-98`) and cannot run a turn from the desktop.

### 15.4 Why socket connections fail the presence gate

- `#terminalAccess()` (`server.ts:2332-2336`) uses `opts.terminal` if provided, else `createSystemTerminal()` **only when** `opts.input === process.stdin`, else `ABSENT_TERMINAL`.
- `ABSENT_TERMINAL` (`server.ts:310-314`) is `probe: () => null`, `confirm: () => Promise.resolve(false)`.
- The socket server constructs each `EngineConnection` with `input: socket, output: socket` (`packages/engine/src/socket.ts:348-352`). `socket !== process.stdin`, and `serve` does not pass a `terminal`, so every socket connection gets `ABSENT_TERMINAL`.
- `#presencePhase` (`server.ts:2351-2357`): if presence is required and `claim !== "interactive"` → `{ kind: "absent", why: "the turn is headless" }`; if the claim is interactive, `probe()` is null → `{ kind: "absent", why: "no controlling terminal" }`. Either way `#turnStart` throws `#presenceRefusal` (`:2210`), a `-32007`. Amendment 2 §1.2 also refuses `mode: "interactive"` in Rust, so the desktop never sends the claim.

### 15.5 Per-turn notification routing (`turn/*`, `item/*`, `agentMessage/delta`)

- Typed server notifications are `thread/started`, `turn/started`, `turn/completed`, `item/started`, `item/completed`, `item/agentMessage/delta` (`protocol/types.ts:399-407`).
- They are sent only via `#notify` → `#send` on **this** connection's `output` (`server.ts:2858-2865`). `#notify` is **not** gated on `#subscribedRoom`. Emission sites: `turn/started` `:2316`, `item/started` `:2555`, `item/agentMessage/delta` `:2561-2566`, `item/completed` `:2579-2592`, `turn/completed` `:2851`.
- `room/updated` is a different path: `#emitRoomUpdated` (`:892-897`) calls `opts.onRoomUpdated` when present (the socket broadcast, `socket.ts:339-352`), else `notifyRoomUpdated`. `notifyRoomUpdated` (`:883-889`) **is** gated on `#subscribedRoom` (set only when `initialize` got `capabilities.subscribeRoom === true`, `:1348`) and broadcasts `{ reason, threadId }` with no turn/item payload.
- Therefore a thread loaded by another connection (CLI, second window) delivers its `turn/*` / `item/*` / `delta` stream only to that other connection. The desktop sees at most a `room/updated { reason: "turn", threadId }` signal, and `turn/interrupt` from the desktop fails `-32002` (`server.ts:2466-2467`, same `#threads.get` rule as `:2171-2172`).

## 16. Answers to the A4 spec's §14 open items (verified at `870c1f7e`)

1. **Allowlist (spec §14.1).** §1.1. `thread/resume` is **not** added (FDR-1, D-708); the spec's request for it is the recorded discrepancy. The A3 pin §7 bar on editing `launcher.rs` / `main.rs` (A3 pin:321-326) is lifted for M3-A4 exactly to the extent of this amendment and A4 pin §2.4.
2. **Notification forwarding (spec §14.2).** §2 and §3. Today's drop is `launcher.rs:545-548` (the comment at `:545`, the `id` test at `:546`, the `continue` at `:547`; the spec's `:545-547` and this pin's `:545-548`, which adds the closing brace, name the same code). Forwarded: exactly the five notifications the spec asks for (§3.2); `item/agentMessage/delta` and `item/started` are read and discarded.
3. **Per-turn read vs A3 Q4/D7 (spec §14.3).** §3.4 item 3: a narrow extension of A3 Q4 / D7 (D-682), ruled as FDR-4(c) (D-711). D7's "no Read command" stands (A4 spec §8.2 last bullet).
4. **Thread lock and `lockHolderPid` (spec §14.4).** (a) True: every `thread/start` takes `sessions/<threadId>.lock` for the life of the desktop's connection (`acquireThreadLock` at `server.ts:1433-1434`, a `-32004` with `lockHolderPid` if it cannot; no unload method exists, the dispatch switch `server.ts:771-806` has no `thread/close`), so the CLI is locked out of every desktop pane's thread, hidden or not. (b) In A4 the read-only state cannot be reached: it is entered only through `thread/resume` → `-32004` (`#threadResume`, `server.ts:1804`; the lock refusal `turnAlreadyActive(threadId, null, lock.holderPid)` at `:1864-1865`), and `thread/resume` is deferred. A `-32004` on `turn/start` (one active turn per thread, `server.ts:2173-2175`) is rendered as a method-error row with its `data` keys verbatim. (c) The lock file stores the holder **process** pid (`lock.ts:285-306`; `#liveLockHolder`, `server.ts:1775-1781`), so a second connection inside the same `serve` reports the `serve` process's own pid. The desktop cannot tell that case apart in A4: `ConnectionInfo` (`launcher.rs:66-73`) carries no `serve` pid. The pin states this; it matters only once `thread/resume` lands. (d) True; §5.5 of the A4 spec ("no close for a pane") follows.
5. **`seat/list` projection (spec §14.5).** The union `SeatSummary` at `protocol/types.ts:294-321` and `SeatListResult` at `:323` is confirmed for the desktop as is: `ok: true` rows render `displayName` (fallback `id`), `pinnedModel`, `preferredBacking`; `ok: false` rows render `code` and `issues` and are never hidden. The UI does **not** pre-label `policy.headlessOk: false`; it shows only the engine's refusal (spec §6.3; FDR-3).
6. **Quit hook (spec §14.6).** §6.1. Verified: `main.rs:109-120` registers no close-request handler.
7. **Desktop presence (spec §14.7).** No detach rule is needed, and the keypress prompt cannot appear in A4. Every socket connection gets `ABSENT_TERMINAL` whatever terminal `serve` inherited, because `#terminalAccess` (`server.ts:2332-2336`) opens the system terminal only when `opts.input === process.stdin`, and the socket server builds each connection with `input: socket` (`socket.ts:345-352`). The desktop also never sends `mode: "interactive"` (§1.2; refused in Rust), so `#presencePhase` returns `absent` ("the turn is headless", `server.ts:2352`) before any probe, and `#turnStart` throws the `-32007` refusal (`server.ts:2210`) before the pending-presence path (`:2212-2216`) can run. `serve`'s stdin is a pipe (`launcher.rs:601`). The builder adds no `setsid`/TTY handling.


## 17. Review dispositions (r2, r3)

### r2

Copilot review of PR #81 at head `6152bb14101a0b794ff4785697a81f43532a95d0`, submitted 2026-11-27 10:53 PM ET (`6095587740`). All three comments were High and on this file. No other review comments were open.

| # | Comment | Disposition |
| --- | --- | --- |
| C1 | [Ensure terminal events bypass a full queue](https://github.com/MADVenturesLLC/MADC/pull/81#discussion_r4725343397) (line 108): `madc/transport-closed` is itself an event on the bounded channel, so a full queue can prevent the fail-closed transition. | **Fixed.** §2.2 (i), §3.3, §3.6: the queue reserves one additional slot, usable only by `madc/transport-closed`. A full ordinary queue cannot drop the terminal event. (r3 removed the r2 "or an out-of-band path" alternative: one mechanism only, so a terminal event can never overtake queued events; see R3-1/R3-4.) Test: §13 item 7a. |
| C2 | [Prevent idle reader timeout from closing transport](https://github.com/MADVenturesLLC/MADC/pull/81#discussion_r4725343411) (line 108): the existing stream is given `INTERACTIVE_RPC_TIMEOUT` (10 s), so an idle desktop would emit `madc/transport-closed` with no traffic. | **Fixed.** §2.2 (iii): the reader-owned socket has no read timeout (today's `launcher.rs:470-473` and `:526-529` sets are removed from the reader path). The 10 s deadline stays on the caller's pending-request wait and on write timeouts only. A `WouldBlock` / `TimedOut` on the reader is a pin violation. Test: §13 item 7b (idle > 10 s emits nothing; a follow-up `room/inspect` still works). |
| C3 | [Include accepted and pending starts in close guard](https://github.com/MADVenturesLLC/MADC/pull/81#discussion_r4725343427) (line 242): the engine sends the `turn/start` response before `result.after()` emits `turn/started`, so a close in that gap would skip the quit dialog. Cite `server.ts:738-740, 2316-2320`. | **Fixed, cite verified.** The cite is correct in substance: `#answer` is `server.ts:737-746` (send at `:738`, `after()` at `:740`); the `turn/start` after hook is `:2313-2320` (`#notify("turn/started")` at `:2316`). §6.1 now counts (a) pending `turn/start` requests, (b) accepted `inProgress` results before `turn/started`, and (c) forwarded `turn/started` not yet completed. Tests: §13 items 6a (the gap), 6b (pending), 6c (count returns to zero). |

### r3

Copilot second review of PR #81 at head `0bd02e2aff4edc8cd956717b8c477aadef6c0563`, submitted 2026-11-27 11:02 PM ET (`6095651398`): four High and one Medium, all on this file. The three r2 comments were marked resolved by Copilot in that review.

| # | Comment | Disposition |
| --- | --- | --- |
| R3-1 | [Add a cancellation path to unblock the reader on disconnect](https://github.com/MADVenturesLLC/MADC/pull/81#discussion_r4725381245) (High, line 114): a reader with no read timeout is never woken by stopping `serve` or dropping the writer, least of all when the desktop attached to an already-running listener. | **Fixed.** New §2.4 step 4: every desktop-initiated close runs state → `Closed`, then `shutdown(Shutdown::Both)` on a cancel handle (a `try_clone` of the stream, held with the stdin handle and child reaper, reachable without the request lock; §6 item 3), then fails pending requests, then stops an owned `serve`. The `shutdown` is on the desktop's own end, so it is sufficient for a reused listener. The reader is detached, not joined (the §6 9 s bound is unchanged). Platform behaviour is UNVERIFIED (§12 item 6, with a no-silent-fallback rule). Tests: §13 item 7c (reused listener, owned child, `Exit` with a held lock, `shutdown`-removal mutation). |
| R3-2 | [Assign epoch and sequence to Rust-originated events](https://github.com/MADVenturesLLC/MADC/pull/81#discussion_r4725381282) (High, line 138): §3.1/§4.2 require `epoch` and increasing `seq` on every event, but `seq` was assigned only to engine frames, so the terminal event could be rejected. | **Fixed.** §3.1: **one** per-epoch counter shared by engine-forwarded and Rust-originated events, assigned inside the FIFO enqueue critical section (so `seq` order is delivery order); Rust-originated events carry `epoch` and `seq` and have exactly the `params` of §3.3. §4.2: contiguity is not required (gap accepted + flag; only repeat/lower dropped), so a terminal event after an overflow gap is accepted; `transport-closed` and `events-dropped` are in the accepted set. Tests: §13 items 7a, 7a3. |
| R3-3 | [Validate complete notification shapes before forwarding](https://github.com/MADVenturesLLC/MADC/pull/81#discussion_r4725381320) (High, line 151): `item/completed` required only `id` and `kind`, so a malformed `servedModel` item could reach the receipt row; `turn/started.status` was unchecked. | **Fixed.** New §3.2.1 validates the closed `Item` discriminated union per `kind` against `protocol/types.ts:70-151` (all `servedModel` fields, `lane` and `mode` enums, `fallbackFrom` string/null, `vendorReported` boolean; the other five kinds' required fields), `turn/started.status === "inProgress"` (with `error` and `completedAt` null), `turn/completed` status and `error` coupling, `thread/started` fields, and each `turn.items` element. Failures are F4 `invalid-notification` (§5). Extra keys are ignored, not rejected. Tests: §13 item 4b (per-field refusals and a no-false-F4 fixture sweep). |
| R3-4 | [Emit terminal events before or while marking the connection closed](https://github.com/MADVenturesLLC/MADC/pull/81#discussion_r4725381353) (High, line 196): §2.2 (ii) set `closed` then emitted; §4.1 emitted only while `closed` was unset, so the terminal event was suppressed. | **Fixed.** §2.4: a three-state word (`Open`, `Terminated`, `Closed`) and one compare-and-swap. `Open → Terminated` enqueues the single terminal event in the **same critical section** as the transition (before or atomically with, never after); `Open → Closed` is desktop-initiated and emits nothing; `Terminated → Closed` is the idempotent cleanup. Exactly one terminal event per epoch, by construction. §2.2 (ii) and §4.1 rewritten so they no longer disagree; the r2 `closed` wording is removed. Tests: §13 item 7a2 (exactly once; reader-vs-disconnect race; mutation that gates on `closed`). |
| R3-5 | [Specify the exact connection epoch JSON key](https://github.com/MADVenturesLLC/MADC/pull/81#discussion_r4725381374) (Medium, line 195): `connectionEpoch` with `serde(rename = "connection_epoch")` contradicts the struct's `rename_all = "camelCase"`. | **Fixed.** Checked the code: `ConnectionInfo` has `#[serde(rename_all = "camelCase")]` (`launcher.rs:65`) and `src/ipc.ts:54-61` mirrors camelCase. §4.1: Rust `pub connection_epoch: u64`, no per-field rename, wire key exactly **`connectionEpoch`**; the event-envelope key is the separate **`epoch`**. The A4 pin already says `connectionEpoch` (A4 pin §2.1 supersession list, amendment 2 §4.1) and needs no edit. Test: §13 item 5 (key set). |

**Self-review pass (same classes, found by reading the whole amendment).** Fixed in this revision beyond the five comments:

- **S1 (timeouts).** `SO_RCVTIMEO` is shared by every `try_clone`; the existing `launcher.rs:468` set on the *writer* would re-arm the reader's timeout. §2.2 (iii) now forbids `set_read_timeout` on any handle after the reader starts and §13 item 7b mutates every handle.
- **S2 (close guard).** The r2 guard was a sum of three terms and double-counted a turn present in both the reply and `turn/started`; it is now a set keyed by `turn.id`, reset when the connection leaves `Open` (§6.1; §13 item 6d, 7d).
- **S3 (ordering).** The r2 "or an out-of-band path" could let the terminal event overtake queued events and break `seq` order; removed (§2.2 (i)).
- **S4 (seq rule).** §3.4 item 5 and §4.2 differed on gaps versus regressions; §4.2 now states both (gap accepted + flag, repeat/lower dropped).
- **S5 (events-dropped).** The "once per second" emitter had no clock in a reader that blocks on the socket; it is now lazy on the next frame and an ordinary, refusable event (§3.3).
- **S6 (connect window).** A death during `initialize`, and events before the UI knows the epoch: `connect_engine` returns `Err` when the state is not `Open`; the residual window is recorded as UNVERIFIED (§12 item 7) rather than claimed closed.
- **S7 (idempotent cleanup).** `disconnect_engine` after `madc/transport-closed` is now explicitly a no-event, idempotent transition (§2.4 transition 3, §4.3).
