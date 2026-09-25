# PIN: M0 seat file format + session JSONL

*Surface Architect · 2026-09-24 · Venue: `MADVenturesLLC/MADC` · Status: **build pin** for Hephaestus Act M0-A4 (read by A2/A3). Docs only.*

*Amended by `PIN-madc-M0-amendment-2-session-integrity.md` (2026-09-25): session integrity, additive.*

**Authority:**

- `docs/plan/PLAN-madc-M0-build-plan.md` §9 — Founder-accepted; on `main` via PR #2, merge commit `9c71afd5c99d44443eecce2a0b4678e90dea6cb0`.
- Founder rulings (2026-09-24, plan §14): **D2** direct-key = Kimi Code · **D3** stdio JSON-RPC · **D4** built-in seat `madc-default` (role "general builder") · **D5** JSONL hash-chain, no SQLite in M0.
- `packages/registry` on `main` (`c07b43a6d6e6e91f3b47caba35c78beb45633c29`): provider ids used below are copied from `PROVIDER_CATALOG`.
- Protocol pin: `docs/plan/PIN-madc-M0-protocol-messages.md` (Item types, error codes).

**Steal:** MadBridge-style append-only hash chain (mechanism only). **Do not** depend on `madventures-tui` or copy Codex/omp session files.

---

## 1. On-disk root

| Path | Role |
| --- | --- |
| `$MADC_HOME/` | **M0 home** — seats, sessions, memory. Default `$HOME/.madc` (`%USERPROFILE%\.madc` on Windows). |
| `$MADC_HOME/seats/<id>.json` | Named seat definition |
| `$MADC_HOME/sessions/<threadId>.jsonl` | One append-only session file per thread |
| `$MADC_HOME/memory/<seatId>.md` | Optional standing memory notes (append-only text) |

**Surface decisions:**

| Topic | Decision |
| --- | --- |
| `MADC_HOME` | **Optional override.** Unset → `$HOME/.madc`. If set, must be an absolute path; engine and `madc doctor` both honor it. Document in the M0 runbook. |
| Why home-dir, not repo `.madc/` | Seats and receipts belong to the operator machine, not a worktree; one place for doctor regardless of `cwd`. Thread `cwd` is still recorded. Repo-local seat overlay is post-M0. |
| Seed | **Engine auto-seeds `madc-default` on first start if `seats/madc-default.json` is missing** (creates `seats/`, `sessions/`, `memory/`). Never overwrites an existing file. `madc doctor --init` calls the **same writer function** — one source of seed content. |
| Permissions | Dirs `0700`, files `0600` on POSIX (best effort on Windows). |
| Path confinement | `seatId` / `threadId` must match the protocol id grammar (`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`, protocol pin §1) before any path join; else `-32602`. Every resolved path (seat, session, lock, memory) must stay under the real path of `$MADC_HOME`; else reject (`-32006` for seat/memory paths). |

---

## 2. Seat file schema

File: `$MADC_HOME/seats/<id>.json` · UTF-8 JSON, camelCase keys, no comments.

```ts
/** Exactly the three registry entries with wired: true in PROVIDER_CATALOG (packages/registry/src/catalog.ts). */
type SeatBacking = "kimi-code" | "claude-code" | "codex";

type SeatToolsPolicy = {
  /** Deny wins. Empty = no extra denies beyond engine defaults. */
  deny: string[];          // tool name patterns, e.g. "bash", "write:*"
  /** Allow/ask lists deferred; M0: unknown = ask in interactive, deny in headless. */
  allow?: string[];
};

type SeatHandoffsStub = {
  enabled: false;          // M0: type presence only
  targets: string[];       // always [] in M0
};

type SeatMemory =
  | { mode: "file"; path: string }  // required; relative, normalized, under "memory/", ends ".md"; no "..", no absolute
  | { mode: "in-session" };         // no path key allowed

type Seat = {
  id: string;              // == filename stem
  version: 1;              // schema version
  role: string;
  standingInstructions: string;
  pinnedModel: string;     // "<pi-ai provider>/<model id>" for kimi-code; vendor model name for claude-code/codex
  preferredBacking: SeatBacking; // == registry providerId passed to assertAllowed
  memory: SeatMemory;
  tools: SeatToolsPolicy;
  policy: { headlessOk: boolean };
  handoffs: SeatHandoffsStub;
};
```

**Backing → registry mapping** (values from `packages/registry` on `main`):

| `preferredBacking` / `providerId` | Registry `status` | `connect` (Intent) | `wire` | `wired` |
| --- | --- | --- | --- | --- |
| `kimi-code` | `allowed-direct` | `direct` | `anthropic-compat` | `true` (honest UA required) |
| `claude-code` | `allowed-via-vendor-agent` | `vendor-agent` | `vendor-cli` | `true` |
| `codex` | `allowed-via-vendor-agent` | `vendor-agent` | `native` | `true` |

Engine builds `Intent = { providerId: preferredBacking, mode, connect, requireLive: true }` and calls `assertAllowed` before every model/vendor call. Denials map to protocol `-32007 ProviderDenied` / `-32008 ProviderUnavailable`.

`ollama-cloud` is in the registry as `allowed-direct`, `wired: false` — a stub, **not** a valid `preferredBacking` in M0 (seat load → `-32006 SeatInvalid`).

**Resolution:** `thread/start.seatId` → `seats/<id>.json`. Missing → `-32005 SeatNotFound`. Unparseable / schema fail (including unknown `preferredBacking`, `handoffs.enabled !== false`, `memory.mode: "file"` without a valid confined `path`, or `in-session` with a `path`) → `-32006 SeatInvalid`.

---

## 3. `madc-default`

```json
{
  "id": "madc-default",
  "version": 1,
  "role": "general builder",
  "standingInstructions": "You are madc-default, the built-in MAD seat. Prefer concrete edits and verified commands. Obey registry and tool deny rules. Record honest model identity.",
  "pinnedModel": "kimi-coding/kimi-for-coding",
  "preferredBacking": "kimi-code",
  "memory": { "mode": "file", "path": "memory/madc-default.md" },
  "tools": { "deny": [] },
  "policy": { "headlessOk": true },
  "handoffs": { "enabled": false, "targets": [] }
}
```

- `preferredBacking: "kimi-code"` — exact registry id (D2).
- `pinnedModel` — `packages/registry` carries **no model ids** (provider entries only). The value is the `@earendil-works/pi-ai` 0.87.1 catalog id: provider `kimi-coding`, model `kimi-for-coding` (catalog models under `kimi-coding` at pi-check time: `k3`, `k3-256k`, `kimi-for-coding`, `kimi-for-coding-highspeed`). **A3 locks this string** against the pinned pi-ai version; changing it needs no schema change. Registry id (`kimi-code`) and pi-ai provider id (`kimi-coding`) differ on purpose — do not conflate them.

---

## 4. Session JSONL

File: `$MADC_HOME/sessions/<threadId>.jsonl` · one JSON object per line · append-only · never rewrite prior lines.

### 4.1 Envelope

```ts
type SessionEvent = {
  v: 1;
  seq: number;             // 0-based, monotonic per file
  ts: number;              // unix ms
  type: SessionEventType;
  threadId: string;
  seatId: string;
  prevHash: string;        // 64 hex zeros for seq 0
  hash: string;            // §4.3
  payload: unknown;        // typed per `type`
};
```

### 4.2 Event types

| `type` | When | `payload` |
| --- | --- | --- |
| `session.open` | First line, on `thread/start` | `{ cwd: string \| null, backing: SeatBacking, providerId: string, pinnedModel: string }` |
| `turn.start` | `turn/start` accepted | `{ turnId: string, inputText: string }` |
| `item` | After each `item/completed` | `{ turnId: string, item: Item }` (protocol pin §5) |
| `servedModel` | After each model invocation resolves | `{ turnId: string, requestedModel: string, servedModel: string, backing: SeatBacking, providerId: string }` |
| `turn.end` | With `turn/completed` | `{ turnId: string, status: TurnStatus, error: { code: number, message: string } \| null }` |
| `session.close` | Clean shutdown (optional in M0) | `{ reason: string }` |

**Dual `servedModel` write (Surface decision):** every successful model invocation emits **both** the protocol `servedModel` item (live stream) **and** the JSONL `servedModel` event (durable receipt). The item also appears as an `item` event; the dedicated `servedModel` event is the one doctor/audit reads. `servedModel` = pi-ai `responseModel` when present, else the requested model id (pi-ai sets `responseModel` only when it differs); adapters supply the vendor-reported equivalent.

If an append fails: `thread/start` returns `-32009 SessionWriteFailed`; mid-turn the turn ends `failed` with `error.code = -32009`.

**Secrets (mandatory, every append):** payload fields are the enumerated ones above — env, headers, and credentials are never copied into a payload. Before each append, a redactor runs over every string in `payload`: (1) exact-value match of every credential the engine holds in memory (provider keys, tokens) → `"[REDACTED]"` — this guarantees configured secrets never persist; (2) pattern match for common token shapes (`sk-…`, `gh[pousr]_…`, `xox[abp]-…`, `AKIA…`, `Bearer …`, PEM private-key blocks) → `"[REDACTED]"`. Redaction runs before hashing, so the chain covers the redacted line.

### 4.3 Hash chain

```
body            = { v, seq, ts, type, threadId, seatId, payload }   // envelope minus prevHash, hash
canonicalPayload = sortedKeyJson(body)
hash            = sha256_hex(prevHash + "\n" + canonicalPayload)   // UTF-8 bytes, lowercase hex
```

**`sortedKeyJson` = sorted-key JSON:** object keys sorted recursively at every depth (ascending, JS default string sort / UTF-16 code units); arrays keep their order; **no whitespace**; values serialized as `JSON.stringify` does; keys with `undefined` values omitted. Equivalent to `JSON.stringify` on a deep key-sorted copy.

- Genesis `prevHash` = 64 × `"0"`.
- Verify: recompute forward from seq 0; any mismatch or seq gap → doctor fail.
- No signatures in M0.

---

## 5. Sample session (hashes truncated)

```json
{"v":1,"seq":0,"ts":1758750000000,"type":"session.open","threadId":"thr_01","seatId":"madc-default","prevHash":"0000000000000000000000000000000000000000000000000000000000000000","hash":"a1b2…","payload":{"cwd":"/Users/mike/proj","backing":"kimi-code","providerId":"kimi-code","pinnedModel":"kimi-coding/kimi-for-coding"}}
{"v":1,"seq":1,"ts":1758750001000,"type":"turn.start","threadId":"thr_01","seatId":"madc-default","prevHash":"a1b2…","hash":"c3d4…","payload":{"turnId":"turn_01","inputText":"Summarize README"}}
{"v":1,"seq":2,"ts":1758750001100,"type":"item","threadId":"thr_01","seatId":"madc-default","prevHash":"c3d4…","hash":"e5f6…","payload":{"turnId":"turn_01","item":{"id":"item_u1","kind":"userMessage","status":"completed","content":[{"type":"text","text":"Summarize README"}]}}}
{"v":1,"seq":3,"ts":1758750005000,"type":"item","threadId":"thr_01","seatId":"madc-default","prevHash":"e5f6…","hash":"7788…","payload":{"turnId":"turn_01","item":{"id":"item_a1","kind":"agentMessage","status":"completed","text":"README says…"}}}
{"v":1,"seq":4,"ts":1758750005100,"type":"servedModel","threadId":"thr_01","seatId":"madc-default","prevHash":"7788…","hash":"99aa…","payload":{"turnId":"turn_01","requestedModel":"kimi-coding/kimi-for-coding","servedModel":"kimi-for-coding","backing":"kimi-code","providerId":"kimi-code"}}
{"v":1,"seq":5,"ts":1758750005200,"type":"turn.end","threadId":"thr_01","seatId":"madc-default","prevHash":"99aa…","hash":"bbcc…","payload":{"turnId":"turn_01","status":"completed","error":null}}
```

---

## 6. Acceptance — Hephaestus **A4**

1. Fresh `$MADC_HOME` (or `~/.madc`): first engine start writes `seats/madc-default.json` matching §3; a second start leaves it byte-identical; `madc doctor --init` uses the same writer.
2. Seat loads and validates per §2 (`handoffs.enabled === false`, `preferredBacking` ∈ `SeatBacking`); bad file → `-32006`.
3. One E2E seat run (mock provider OK in CI) creates `sessions/<threadId>.jsonl` with ≥ `session.open`, `turn.start`, `item` (user + agent), `servedModel`, `turn.end`.
4. Protocol stream for the same turn contains a `servedModel` item equal in `requestedModel` / `servedModel` / `backing` / `providerId` to the JSONL event.
5. Hash chain verifies with sorted-key JSON (§4.3); editing any one line fails verify.
6. Redaction test: a configured provider key and a `ghp_…`-shaped token injected into tool output and agent text are absent from the session file (replaced by `[REDACTED]`), and the chain still verifies.
7. Path tests: `seatId: "../x"` → `-32602`; seat with `memory.path: "../../etc/passwd"` → `-32006`.
8. `madc doctor` (A7) **or** an A4 helper reports seat id, last session path, chain OK.

## 7. Not in M0

- Multi-seat orchestration / handoffs (type stub only).
- Repo-local seat overlays.
- SQLite session store (D5).
- Cloud sync, signatures/custody on the chain.
- Ollama Cloud (or any `wired: false` registry entry) as a seat backing.

*End of seat pin.*
