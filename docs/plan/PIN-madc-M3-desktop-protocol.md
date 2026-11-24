# PIN (proposed): M3 desktop protocol and local-socket transport

*Builder-drafted under M3-A0 · 2026-11-23 · Venue: `MADVenturesLLC/MADC` · Status: **proposed until the Founder merges this PR**. Amends `PIN-madc-M1-protocol-messages.md` additively; `protocolVersion` stays `madc-m1/1`.*

*Amended by `PIN-madc-M3-desktop-protocol-amendment-1.md` (2026-11-24, Argus M1 on #73): `madc-engine serve` starts the socket listener, launched only by the desktop app; lifetime (stdin EOF or signal, 5 s shutdown deadline); one listener per `$MADC_HOME`; §1 stale-socket rule narrowed (`lstat`-verified socket, 1 s probe, `ECONNREFUSED` or Bun `ENOENT`; never unlink a non-socket; `chmod 0600` failure fails closed); `serve` exit codes; supersedes lines 3 and 5's stale status, `D-M3-2` (D-620) and `D-R6` (D-633) wording; additive.*

**What this pin does.** Defines the proposed local-socket JSONL transport (`$MADC_HOME/engine.sock`, pending `D-M3-2`) alongside stdio so `packages/desktop` (stack per `D-R6`, still open) connects to the same `@madc/engine` without embedding any agent loop, tools, or credentials. Adds read-only `room/inspect`, `session/search`, `session/read`, and opt-in `room/updated` notifications.

**What it does not do.** It does not weaken single-writer locking, does not expose credentials over the socket, does not add remote/TCP access, and does not alter M0/M1/M2 methods.

---

## 1. Local Socket Transport (`$MADC_HOME/engine.sock`)

- **POSIX path:** `$MADC_HOME/engine.sock` (resolved under `0700` `$MADC_HOME`, socket mode `0600` owner-only, checked via `lstat` to refuse symlinks).
- **Windows pipe:** `\\.\pipe\madc-<sha256(MADC_HOME).slice(0,16)>`.
- **Wire framing:** Newline-delimited JSON-RPC, identical to stdio. Every socket connection must complete `initialize` before calling any other method.
- **Stale socket handling:** Before binding, if `$MADC_HOME/engine.sock` exists, the engine attempts a probe `connect()`. Only if `connect()` fails with `ECONNREFUSED` (never when a live listener answers, and never across symlinks) may it unlink the stale socket file.
- **Locking & single-writer:** Unchanged. Multiple read-only clients (or clients operating on distinct threads) may connect concurrently; only one active writer may hold a thread's `.lock` file.

## 2. Additive Methods

### `room/inspect`
- **Params:** `{}` (unknown keys rejected `-32602`).
- **Result:** `{ room: RoomReport }` — exact shape returned by `inspectRoom(home)`. Read-only; never returns payload text or credentials.

### `session/search`
- **Params:** `{ query: string, limit?: number, seatId?: string }`
  - `query` must be a non-empty, non-whitespace string (else `-32602 InvalidParams`).
  - `limit` defaults to `50`, capped at `200` (must be positive integer if present).
  - `seatId` optional filter validated against `isValidId`.
- **Behavior:** Reads `$MADC_HOME/sessions/*.jsonl`, verifies each chain with `verifySessionFile` (skipping corrupt/unverified files), and matches case-insensitively against non-redacted string payloads. `[REDACTED]` tokens are never matched or returned.
- **Result:** `{ matches: SessionSearchMatch[] }` where each match has `{ threadId, seatId, seq, hash, ts, type, snippet }` (`snippet` <= 160 chars, control bytes stripped).

### `session/read`
- **Params:** `{ threadId: string }` (`isValidId` checked, else `-32602`).
- **Result:** `{ threadId, events: SessionEvent[], chainOk: boolean }` — returns the verified events for read-only desktop replay (`-32002 ThreadNotFound` if absent).

## 3. Real-Time Notifications (`room/updated`)

- `initialize` accepts optional `capabilities.subscribeRoom?: boolean`.
- Subscribed connections receive `{ method: "room/updated", params: { reason: "thread" | "turn" | "handoff" | "decision", threadId: string } }` whenever a thread opens/closes, a turn starts/completes, a handoff links/aborts, or a decision is raised/resolved.

## 4. Evidence-Bound UI Rule (M3-A2+)

- No widget in `packages/desktop` may render a green/verified status unless backed by a verified `hash`, `sha`, or `servedModel` receipt from `@madc/engine`. Unverified or missing evidence renders neutral, `warn`, or `fail`.
