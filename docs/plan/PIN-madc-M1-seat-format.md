# PIN: M1 seat file format + session JSONL

*Surface Architect · 2026-09-27 · Venue: `MADVenturesLLC/MADC` · Status: **build pin** — gates Hephaestus Acts M1-A1 … M1-A9 (seat schema v2 and roster seeding land in M1-A7). Docs only.*

*Supersedes `docs/plan/PIN-madc-M0-seat-format.md` **for M1 work**. The M0 pin stays frozen and is not edited (M1-A0; Founder, 2026-09-25). M0 Amendments 2 and 3 are separate frozen files, unedited and not superseded here; they remain binding as written (including the Amendment 3 §4 seed `created:false` proof contract, which amends the §1 "Seed" row below), and their references to M0-pin sections read against the matching sections of this pin.*

*Carried forward unchanged: **M0 Amendment 1** (merged PR #8). The frozen M0 pin's record line: `*Amendment 1 (2026-09-24): lock token, fixes A2 Copilot W1 (PR #7), Founder-authorized.*` Its normative home is the M1 protocol pin §3.3 and §8; it is reproduced verbatim in §6 below because the lock file lives under `$MADC_HOME/sessions/`.*

**Authority:**

- `docs/plan/PLAN-madc-M1-build-plan.md` — Founder-accepted 2026-09-27 (D-M1-1); §9 S1–S6 is this pin's source text. Seat roster (§6, accepted D-M1-4) and Founder rulings D-M1-1 … D-M1-11 (§12), including **D-M1-7** (same-lane fallback rule) and **D-M1-8 / D-M1-9** (empty repo allowlists until the Founder names repos).
- `docs/plan/PIN-madc-M0-seat-format.md` — frozen base text. Superseded by this pin for M1 work only.
- `docs/plan/PIN-madc-M0-amendment-2-session-integrity.md`, `docs/plan/PIN-madc-M0-amendment-3.md` — frozen; single-writer, durability, torn-tail, rollback-durability, poisoned-writer, writer-guard, seed-proof and `sessions/` permission requirements continue to bind.
- Protocol pin: `docs/plan/PIN-madc-M1-protocol-messages.md` (Item types, error codes, mode claim, Amendment 1).
- Engine-owned repo identity: Founder ruling 2026-09-25 (M1 plan §9 S5), fixing Copilot [r4101049517](https://github.com/MADVenturesLLC/MADC/pull/9#discussion_r4101049517).
- `packages/registry` on `main`; registry **v2** (catalog v2 with `credentialClass`, `verifiedAt`, `termsUrl`, `headless`) lands in act **M1-A1** — this pin's references to v2 fields bind from that act.

**Steal:** MadBridge-style append-only hash chain (mechanism only). **Do not** depend on `madventures-tui` or copy Codex/omp session files.

---

## 1. On-disk root

| Path | Role |
| --- | --- |
| `$MADC_HOME/` | **M1 home** — seats, sessions, memory, policy. Default `$HOME/.madc` (`%USERPROFILE%\.madc` on Windows). |
| `$MADC_HOME/seats/<id>.json` | Named seat definition |
| `$MADC_HOME/sessions/<threadId>.jsonl` | One append-only session file per thread |
| `$MADC_HOME/memory/<seatId>.md` | Optional standing memory notes (append-only text) |
| `$MADC_HOME/policy.json` | Per-repo data policy (repo allowlists), §5 (S5) |

**Surface decisions:**

| Topic | Decision |
| --- | --- |
| `MADC_HOME` | **Optional override.** Unset → `$HOME/.madc`. If set, must be an absolute path; engine and `madc doctor` both honor it. Documented in the runbook. |
| Why home-dir, not repo `.madc/` | Seats and receipts belong to the operator machine, not a worktree; one place for doctor regardless of `cwd`. Thread `cwd` is still recorded. Repo-local seat overlay is post-M1. |
| Seed | **Engine auto-seeds the five roster seats on first start** — `daedalus`, `hephaestus`, `prometheus`, `surface-architect`, `madc-default` (S3, §3) — each when its `seats/<id>.json` is missing (creates `seats/`, `sessions/`, `memory/`). **Never overwrites an existing file.** `madc doctor --init` calls the **same writer function** — one source of seed content. The seed's `created:false` proof contract is pinned by M0 Amendment 3 §4 (binding; not edited). |
| Permissions | Dirs `0700`, files `0600` on POSIX (best effort on Windows). `policy.json` follows the same confinement and permissions rules (S5). `sessions/` keeps owner read (M0 Amendment 3 §5). |
| Path confinement | `seatId` / `threadId` must match the protocol id grammar (`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`, protocol pin §1) before any path join; else `-32602`. Every resolved path (seat, session, lock, memory, policy) must stay under the real path of `$MADC_HOME`; else reject (`-32006` for seat/memory paths). |

---

## 2. Seat file schema (S1, S2)

File: `$MADC_HOME/seats/<id>.json` · UTF-8 JSON, camelCase keys, no comments.

```ts
/**
 * S1: any registry id with `wired: true` whose `connect` matches the adapter kind
 * (direct lanes for a direct backing, vendor-agent lanes for a vendor backing);
 * validated at load. A `forbidden` or unwired id fails seat load with -32006.
 * (M0 was the 3-literal union "kimi-code" | "claude-code" | "codex".)
 */
type SeatBacking = string;

type SeatToolsPolicy = {
  /** Deny wins. Empty = no extra denies beyond engine defaults. */
  deny: string[];          // tool name patterns, e.g. "bash", "write:*"
  /** Allow/ask lists deferred; M1: unknown = ask in interactive, deny in headless. */
  allow?: string[];
};

type SeatHandoffsStub = {
  enabled: false;          // M1: still disabled (multi-seat handoffs are M2)
  targets: string[];       // always [] in M1
};

type SeatMemory =
  | { mode: "file"; path: string }  // required; relative, normalized, under "memory/", ends ".md"; no "..", no absolute
  | { mode: "in-session" };         // no path key allowed

type Seat = {
  id: string;              // == filename stem
  version: 1 | 2;          // schema version; v2 adds displayName + fallbacks (S2)
  role: string;
  standingInstructions: string;
  displayName?: string;    // required at version 2 (S2)
  pinnedModel: string;     // "<pi-ai provider>/<model id>" for direct lanes; vendor model name for vendor-agent lanes
  preferredBacking: SeatBacking; // == registry providerId passed to assertAllowed
  fallbacks?: string[];    // version 2; ordered; each validated like preferredBacking (S2)
  memory: SeatMemory;
  tools: SeatToolsPolicy;
  policy: { headlessOk: boolean };
  handoffs: SeatHandoffsStub;
};
```

**S2 — version 2 and v1 migration:** seat `version: 2` adds `fallbacks: string[]` (ordered, each validated like `preferredBacking`) and `displayName: string`. **v1 files load as v2 in memory** with `fallbacks: []` and are **never rewritten**. A v2 file missing `displayName` or with an invalid `fallbacks` entry fails seat load with `-32006`.

**Backing → registry mapping (S1):** the engine resolves `preferredBacking` (and each `fallbacks` entry) against the registry v2 catalog (M1-A1). A backing is valid iff the entry exists, is `wired: true`, is not `forbidden`, and its `connect` matches the adapter kind. Engine builds `Intent = { providerId: preferredBacking, mode, connect, requireLive: true }` and calls `assertAllowed` before every model/vendor call. Denials map to protocol `-32007 ProviderDenied` / `-32008 ProviderUnavailable`. A seat's `headlessOk: true` never overrides an `interactive-only` lane or an `allowed-direct` entry with `headless: "denied"` (M1-A1, M1-A5).

**Same-lane fallback rule (normative; D-M1-7, Founder 2026-09-25; S2):** at turn time a fallback candidate is eligible only if its registry `status` **and** its `credentialClass` (billing) are equal to those of the seat's assigned backing (`preferredBacking`). A candidate that differs in either is **rejected before any call**, and the rejection is logged: a JSONL event (`fallback.rejected`, §4.2) and an `error`-style item naming the seat, the candidate, the assigned lane (status + `credentialClass`) and the candidate's lane, with reason `fallback-lane-mismatch`. The next candidate in the list is then considered; if none is eligible, the turn fails with the primary's error. A fallback is tried only if it is in the seat's list, passes `assertAllowed` for the turn's `mode`, and has credentials or a binary present. Fallbacks never move into `forbidden`, never into `interactive-only` on a turn that failed the presence check, and never into a repo-denied provider. A headless seat that wants MiniMax or Alibaba must use the PAYG id (`minimax-payg`, `alibaba-model-studio-payg`) as its backing; a PAYG id is never a fallback for a plan id. Every served hop writes a receipt with `fallbackFrom` (protocol pin §5). Seat load (M1-A7) and `madc doctor` (M1-A8) warn on any listed fallback that can never be eligible.

**Resolution:** `thread/start.seatId` → `seats/<id>.json`. Missing → `-32005 SeatNotFound`. Unparseable / schema fail (including a backing that fails S1, `handoffs.enabled !== false`, `memory.mode: "file"` without a valid confined `path`, or `in-session` with a `path`) → `-32006 SeatInvalid`.

---

## 3. Seeds (S3)

The same writer seeds **`daedalus`, `hephaestus`, `prometheus`, `surface-architect`** and **`madc-default`**, and never overwrites. Roster content follows the M1 plan §6 (Founder-accepted 2026-09-25, D-M1-4):

| Seat id | Role (summary) | `preferredBacking` | `headlessOk` | Tool policy (deny wins) | `fallbacks` (ordered) |
| --- | --- | --- | --- | --- | --- |
| `daedalus` | Architect: research-first plans, docs, D-tables. No code. | `claude-code` | `true` | deny writes outside `docs/**`; deny `git push` to `main` | `["kimi-code"]` — never eligible under the same-lane rule (§2) until the Founder changes that cell |
| `hephaestus` | Builder: acts, tests, PRs. Never merges. | `codex` | `true` | deny `git push` to `main`; deny branch-protection APIs | `["claude-code"]` |
| `prometheus` | Idea and research: sources, ledgers, verdicts. | `kimi-code` | `true` | deny writes outside `docs/**` and scratch | `["ollama-cloud"]` |
| `surface-architect` | Contracts and pins: protocol, seat format, UX system. | `ollama-cloud` | `false` (D-M1-3: Ollama headless denied until the Founder records permission) | deny writes outside `docs/plan/PIN-*` and `docs/**` | `["kimi-code"]` |
| `madc-default` | General builder (M0, unchanged) | `kimi-code` | `true` | `[]` | `[]` |

- **D-M1-4 note (Founder, 2026-09-25):** Surface Architect on Ollama Cloud serves **interactive turns only** while D-M1-3 denies headless. Any headless turn on `surface-architect` is refused (`headless-not-permitted`) until the Founder records Ollama headless permission as a reviewed catalog change (M1-A1). The registry status of `ollama-cloud` stays `allowed-direct` with `headless: "denied"`.
- **`pinnedModel` values are not pinned here.** Each is locked in act **M1-A7** against the pinned pi-ai catalog or the provider's live list at build time (M1 plan §6), the same way M0-A3 locked `kimi-coding/kimi-for-coding`. Registry id (`kimi-code`) and pi-ai provider id (`kimi-coding`) differ on purpose — do not conflate them.
- Seed files are written at `version: 2` (§2), except `madc-default`, whose M0 v1 seed below is unchanged (M1 plan §6 roster: "M0, unchanged"); it loads as v2 in memory.

`madc-default` (unchanged from the M0 pin §3):

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

---

## 4. Session JSONL (S4, S6)

File: `$MADC_HOME/sessions/<threadId>.jsonl` · one JSON object per line · append-only · never rewrite prior lines.

Single-writer, ownership re-check, durability (fsync), torn-tail, rollback-durability and broken/poisoned-writer requirements are pinned by M0 Amendments 2 and 3 and bind unchanged.

### 4.1 Envelope

```ts
type SessionEvent = {
  v: 1;                  // envelope stays v: 1 in M1 (S4: additive payloads only)
  seq: number;           // 0-based, monotonic per file
  ts: number;            // unix ms
  type: SessionEventType;
  threadId: string;
  seatId: string;
  prevHash: string;      // 64 hex zeros for seq 0
  hash: string;          // §4.3
  payload: unknown;      // typed per `type`
};
```

### 4.2 Event types

| `type` | When | `payload` |
| --- | --- | --- |
| `session.open` | First line, on `thread/start` | `{ cwd: string \| null, backing: SeatBacking, providerId: string, pinnedModel: string }` — `backing` widened per S1 (any wired registry id) |
| `turn.start` | `turn/start` accepted | `{ turnId: string, inputText: string, mode: "interactive" \| "headless", presence: "verified" \| "absent" }` (S4; `mode` per protocol pin §3.3, `presence` per the engine-side presence check) |
| `item` | After each `item/completed` | `{ turnId: string, item: Item }` (protocol pin §5) |
| `servedModel` | After each model invocation resolves | `{ turnId: string, requestedModel: string, servedModel: string, backing: SeatBacking, providerId: string, lane: ProviderStatus, mode: "interactive" \| "headless", fallbackFrom: string \| null, vendorReported: boolean }` (S4) |
| `fallback.rejected` | A fallback candidate is rejected under the same-lane rule (§2) | `{ turnId: string, candidate: string, assignedLane: { status: ProviderStatus, credentialClass: string }, candidateLane: { status: ProviderStatus, credentialClass: string }, reason: "fallback-lane-mismatch" }` — the seat is the envelope's `seatId` (S4) |
| `repo.decision` | A repo-gated provider decision is made (§5) | `{ turnId: string, providerId: string, remote: string \| null, topLevel: string \| null, decision: "allow" \| "deny", reason: string }` — records the resolved identity (normalized remote, realpath'd top-level) and the reason (S4) |
| `turn.end` | With `turn/completed` | `{ turnId: string, status: TurnStatus, error: { code: number, message: string } \| null }` |
| `session.close` | Clean shutdown (optional in M1) | `{ reason: string }` |

`fallback.rejected` and `repo.decision` are the pinned names for the two S4 addition events ("a fallback rejection event …", "a repo-policy decision …").

**Dual `servedModel` write (Surface decision, unchanged):** every successful model invocation emits **both** the protocol `servedModel` item (live stream) **and** the JSONL `servedModel` event (durable receipt). The item also appears as an `item` event; the dedicated `servedModel` event is the one doctor/audit reads. `servedModel` = pi-ai `responseModel` when present, else the requested model id (pi-ai sets `responseModel` only when it differs); adapters supply the vendor-reported equivalent, with `vendorReported` honest (protocol pin §5).

If an append fails: `thread/start` returns `-32009 SessionWriteFailed`; mid-turn the turn ends `failed` with `error.code = -32009`.

**Secrets (mandatory, every append):** payload fields are the enumerated ones above — env, headers, and credentials are never copied into a payload. Before each append, a redactor runs over every string in `payload`: (1) exact-value match of every credential the engine holds in memory (provider keys, tokens) → `"[REDACTED]"` — this guarantees configured secrets never persist; (2) pattern match for common token shapes (`sk-…`, `gh[pousr]_…`, `xox[abp]-…`, `AKIA…`, `Bearer …`, PEM private-key blocks) **plus the key shapes of every new M1 provider (S6), for example `xai-…` and `sk-sp-…`** → `"[REDACTED]"`. The redactor learns every stored key shape from the credential store (M1-A2). Redaction runs before hashing, so the chain covers the redacted line.

### 4.3 Hash chain

```
body            = { v, seq, ts, type, threadId, seatId, payload }   // envelope minus prevHash, hash
canonicalPayload = sortedKeyJson(body)
hash            = sha256_hex(prevHash + "\n" + canonicalPayload)   // UTF-8 bytes, lowercase hex
```

**`sortedKeyJson` = sorted-key JSON:** object keys sorted recursively at every depth (ascending, JS default string sort / UTF-16 code units); arrays keep their order; **no whitespace**; values serialized as `JSON.stringify` does; keys with `undefined` values omitted. Equivalent to `JSON.stringify` on a deep key-sorted copy.

- Genesis `prevHash` = 64 × `"0"`.
- Verify: recompute forward from seq 0; any mismatch or seq gap → doctor fail.
- No signatures in M1.

---

## 5. `$MADC_HOME/policy.json` — per-repo data policy (S5)

File: `$MADC_HOME/policy.json` · UTF-8 JSON · same confinement and permissions rules as §1.

```json
{
  "version": 1,
  "repoAllow": {
    "<providerId>": ["<normalized remote>", { "remote": "<normalized remote>", "path": "<absolute path>" }]
  }
}
```

- Keys are **registry ids exactly** (not pi-ai provider names).
- **Repo-gated providers** (`deepseek-payg`, the id in today's catalog, plus `minimax-token-plan` and `minimax-payg`) are denied for any repo not in their list, and a **missing or empty entry means deny everywhere** (fail-closed). A clean `{}` therefore denies all three (D-M1-8, D-M1-9: the allowlists stay empty until the Founder names repos). Providers that are not repo-gated ignore this file.
- **Repo identity is engine-owned** (Founder ruling 2026-09-25; fixes Copilot [r4101049517](https://github.com/MADVenturesLLC/MADC/pull/9#discussion_r4101049517)). The engine never matches the caller-supplied `cwd` string. For each turn on a repo-gated provider it computes the identity as **(a)** the realpath of the git top-level of `cwd` (symlinks resolved; a subdirectory resolves to its top-level; bind mounts are not collapsed by `realpath`, so a bind-mounted path counts as a distinct path) **and (b)** the normalized URL of the `origin` remote.
- **Remote normalization:** strip the scheme, credentials and userinfo; lowercase the host; convert scp-style `git@host:owner/repo`, `ssh://git@host/owner/repo` and `https://host/owner/repo` to `host/owner/repo`; strip a trailing `.git` and trailing `/`. Owner and repo keep their case.
- **Origin agreement:** every configured `origin` endpoint (each `remote.origin.url` value and each `remote.origin.pushurl` value, fetch and push alike) must normalize to the **same** remote. That single value is the identity's remote; any disagreement is ambiguous.
- **Matching:** entries are normalized the same way at load (path entries realpath'd). An entry matches only by **exact equality** of the normalized remote, and, if the entry pins a path, also exact equality of the realpath'd top-level with the realpath'd entry path. A path alone never grants: path-only entries, and entries whose remote does not normalize, are rejected at load with a doctor warning. No prefix, glob, substring or case-folded matching.
- **Deny, fail-closed, with reason `repo-identity-ambiguous`** when: `cwd` is not in a git repo; there is no `origin` remote; the `origin` fetch and push URLs (or multiple values of either) do not all normalize to the same remote; the remote is unparseable; `realpath` resolution fails; or a worktree or submodule identity cannot be resolved unambiguously. A resolved identity that is not listed denies with `repo-not-allowed`. Every decision is logged with its reason (`repo.decision`, §4.2).

---

## 6. M0 Amendment 1, carried forward unchanged

The lock file lives under `$MADC_HOME/sessions/`, so the lock-token text is reproduced here **verbatim** from the frozen M0 protocol pin (Amendment 1, PR #8). Its normative home is the M1 protocol pin (§3.3 "Cross-process ownership", §8 item 9).

> **Cross-process ownership:** each CLI run spawns its own engine, so the rule is enforced on disk. `thread/start` / `thread/resume` take an exclusive lock `sessions/<threadId>.lock` (create-exclusive) held until the connection ends. Lock body is exactly `{ pid, startedAt, token }`. `token` is 32 lowercase hex chars (128 random bits, e.g. `crypto.randomBytes(16).toString("hex")`), valid iff it matches `^[0-9a-f]{32}$`, generated fresh on every acquisition and never reused. The holder keeps its token in memory. Lock held by a live process → `-32004` with `activeTurnId: null` and `lockHolderPid`. Only the lock holder appends to `sessions/<threadId>.jsonl`. Ownership checks compare `token`; pid + startedAt + inode alone are not unique (Amendment 1):
>
> - **(a) Release** unlinks the lock only if the on-disk body's `token` equals the holder's in-memory token. Otherwise it leaves the file alone. The check and the unlink must act on the same file: read the body through an open fd, and immediately before unlinking confirm the path still names that fd's file (`lstat` vs `fstat` dev + inode; the open fd pins the inode, so it cannot be reused). POSIX has no compare-and-unlink; the remaining window is closed by (b), which never reclaims a lock whose pid is live.
> - **(b) Reclaim** (lock pid dead): rename the lock aside to a unique name (e.g. `sessions/<threadId>.lock.reclaim-<reclaimer token>`), re-read the renamed body, and delete it only if it still matches the observed dead holder's `pid` + `startedAt` + `token` (for a (c) body, the same missing or invalid `token` value). On mismatch, restore it (link or rename back to `sessions/<threadId>.lock`) and treat the thread as locked (`-32004`).
> - **(c) Legacy / corrupt body** (`token` missing or not matching `^[0-9a-f]{32}$`): reclaimable via (b) only if its pid is dead. With a live pid the thread is locked (`-32004`).
> - **(d) Errors unchanged:** `-32004 TurnAlreadyActive` still returns `lockHolderPid` (§4.1). `token` is never sent on the wire, never logged (stderr included), and never written to session JSONL.
>
> *Amendment 1 acceptance (M0 protocol pin §8), verbatim:*
>
> 9. Lock-token tests (Amendment 1, A2 W1 follow-up): a same-pid, same-`startedAt` re-acquisition with a different `token` — the stale holder's release does not delete the new lock, and a reclaim does not delete a lock whose `token` changed; the `token` never appears in any protocol response, log / stderr line, or session JSONL.

*Note (not part of Amendment 1): M0 Amendment 2 §6 corrects the last sentence of (a) — the guarantee holds only inside Amendment 2 §1's operating envelope, and the three-engine reclaim race residual is documented in Amendment 2 §6. Amendments 2 and 3 remain binding as written.*

---

## 7. Sample session (hashes truncated)

```json
{"v":1,"seq":0,"ts":1758750000000,"type":"session.open","threadId":"thr_01","seatId":"madc-default","prevHash":"0000000000000000000000000000000000000000000000000000000000000000","hash":"a1b2…","payload":{"cwd":"/Users/mike/proj","backing":"kimi-code","providerId":"kimi-code","pinnedModel":"kimi-coding/kimi-for-coding"}}
{"v":1,"seq":1,"ts":1758750001000,"type":"turn.start","threadId":"thr_01","seatId":"madc-default","prevHash":"a1b2…","hash":"c3d4…","payload":{"turnId":"turn_01","inputText":"Summarize README","mode":"headless","presence":"absent"}}
{"v":1,"seq":2,"ts":1758750001100,"type":"item","threadId":"thr_01","seatId":"madc-default","prevHash":"c3d4…","hash":"e5f6…","payload":{"turnId":"turn_01","item":{"id":"item_u1","kind":"userMessage","status":"completed","content":[{"type":"text","text":"Summarize README"}]}}}
{"v":1,"seq":3,"ts":1758750005000,"type":"item","threadId":"thr_01","seatId":"madc-default","prevHash":"e5f6…","hash":"7788…","payload":{"turnId":"turn_01","item":{"id":"item_a1","kind":"agentMessage","status":"completed","text":"README says…"}}}
{"v":1,"seq":4,"ts":1758750005100,"type":"servedModel","threadId":"thr_01","seatId":"madc-default","prevHash":"7788…","hash":"99aa…","payload":{"turnId":"turn_01","requestedModel":"kimi-coding/kimi-for-coding","servedModel":"kimi-for-coding","backing":"kimi-code","providerId":"kimi-code","lane":"allowed-direct","mode":"headless","fallbackFrom":null,"vendorReported":true}}
{"v":1,"seq":5,"ts":1758750005200,"type":"turn.end","threadId":"thr_01","seatId":"madc-default","prevHash":"99aa…","hash":"bbcc…","payload":{"turnId":"turn_01","status":"completed","error":null}}
```

---

## 8. Acceptance — Hephaestus **M1 acts**

This pin gates acts **M1-A1 … M1-A9** (M1 plan §7); the per-act acceptance bullets live there and bind as written. Pin-level invariants:

1. Fresh `$MADC_HOME`: first engine start seeds the five roster seats per §3 (M1-A7); a second start leaves every seed byte-identical; `madc doctor --init` uses the same writer. The M0 Amendment 3 §4 `created:false` proof contract still holds.
2. Seat loads and validates per §2: v1 files load as v2 in memory with `fallbacks: []` and are never rewritten; a `forbidden` or unwired backing, or a bad `fallbacks` entry, gives `-32006`.
3. Same-lane rule (§2): a fallback candidate whose registry `status` or `credentialClass` differs from the assigned backing's is rejected before any call, a `fallback.rejected` event and an `error`-style item name both lanes with reason `fallback-lane-mismatch`, and no `servedModel` receipt is written for the rejected candidate (M1-A7).
4. One E2E seat run per seeded seat (mock provider OK in CI) writes its own memory path and a session with ≥ `session.open`, `turn.start` (with `mode`, `presence`), `item` (user + agent), `servedModel` (with `lane`, `mode`, `fallbackFrom`, `vendorReported`), `turn.end`; protocol stream and JSONL receipt agree (M1-A7).
5. `policy.json` (§5): the repo-identity test matrix of M1-A4 (plan §7) passes — symlink, alias path, bind path, ssh vs https, host case, missing origin, fork owner, subdirectory, fetch/push disagreement, unparseable remote, non-git `cwd`, failed realpath, path-only entry — each denying or allowing with the pinned reason, and each decision logged (`repo.decision`).
6. Hash chain verifies with sorted-key JSON (§4.3); editing any one line fails verify.
7. Redaction: every new provider key shape (for example `xai-…`, `sk-sp-…`, generic `sk-…`) injected into tool output or agent text is absent from the session file (`[REDACTED]`), and the chain still verifies (M1-A2, S6).
8. Path tests: `seatId: "../x"` → `-32602`; seat with `memory.path: "../../etc/passwd"` → `-32006`.
9. M0 seat pin §6 acceptance items still pass where the surface is unchanged; the carried-forward Amendment 1 acceptance (§6) still passes.

## 9. Not in M1

- Multi-seat orchestration / handoffs (`handoffs.enabled` stays `false`; M2).
- Repo-local seat overlays.
- SQLite session store; the JSONL envelope stays `v: 1` (S4).
- Cloud sync, signatures/custody on the chain.
- Memory store beyond the per-seat file; MCP; ACP **server** for editors (M4).
- **Deferred beyond M1 scope** (named by M0 Amendment 2 §7 for M1-A0 consideration; the Founder-ruled M1 plan §9 does not commission them, so they remain unpinned): namespace-proof lock liveness (lock body v2); torn-tail repair (fail-closed stands; the engine never modifies, truncates, renames or deletes the file); `ThreadStatus "closed"` semantics (reserved; M1 engines never produce it; clients print any status string verbatim and do not branch on `closed`); a size bound on session verification reads.

*End of M1 seat pin.*
