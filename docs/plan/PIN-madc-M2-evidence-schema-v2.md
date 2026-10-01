# PIN (proposed): M2 evidence schema v2 — session chain events for the room

*Hephaestus (builder-drafted under the Founder's M2-A0 commission) · 2026-10-01 · Venue: `MADVenturesLLC/MADC` · Status: **proposed, not a build authorization until the Founder merges it.** Docs only. Additive to the M1 session chain.*

*Base: `main` @ `c4f97fc668c4b55d701b0be4875aa0c4180cdd15` (the M1 I1–I3 squash, PR #45); its parent is M1-A9 `148a2793620d045e2a0470b8f6add630af26cbc8` (PR #44). Every file and line cited below was read at that commit. This pin was not written by Surface Architect and claims none of Surface's authority; it is a builder's proposal for Argus review and the Founder's merge. Nothing in it is implemented: no code in `packages/` writes, reads, links or refuses any event named here, and this act adds none.*

**What this pin does.** It names the session chain events the room (M2) and the memory and tools milestone (M4) need, with their fields, their hash inputs and the refusal that applies when a required field is missing. The desktop (M3) can then bind to one schema once (roadmap §2, reason 2), and the M2 build plan can commission acts against pinned shapes instead of inventing them act by act.

**What it does not do.** It changes no envelope field, no hash formula, no protocol method, no seat field and no existing event. It does not enable handoffs: `handoffs.enabled` stays `false`, and a seat file with `enabled: true` still fails `-32006`, as the M1 seat pin §2 says and `packages/engine/src/seat.ts:254` enforces. It creates no worktree, no inbox, no memory store and no MCP client. §6 lists the non-goals.

**Authority:**

- `docs/plan/ROADMAP-madc-post-M0.md` (blob `71dfb31a`): §2 "M2 freezes schema v2, then M3 binds to it once" and "M2 defines memory-write and tool-call receipt events in schema v2"; §4 M2 rows — handoffs "hash-linked in both directions: the source chain records the target thread's genesis hash, and the target's `session.open` records the source handoff hash", "the worktree HEAD SHA is written into the chain at open and close", and the Founder decision inbox: "Seats may only escalate a typed `founderDecision` that carries a recommended default and evidence refs"; §4 M3 row (the `evidenceRef` forms: session path + seq + hash, git SHA, servedModel receipt); §4 M4 row ("Each memory write is a chain event that records which seat, turn and served model wrote it"); §6 rulings **D-R2** (M2 before M3), **D-R3** (Z.ai stays forbidden), **D-R6** (desktop stack: Surface recommends during M2, the Founder rules before M3 — not this act).
- `docs/plan/PIN-madc-M1-seat-format.md` (blob `3fe232ef`): §4.1 envelope, §4.2 event table and redaction, §4.3 hash chain, §2 seat schema (`handoffs.enabled: false` → `-32006`), §5 repo identity, §9 "Not in M1". **Frozen** (it gated merged acts; README edit rule). This pin adds to its §4.2 table **by reference** and edits nothing.
- `docs/plan/PIN-madc-M1-protocol-messages.md` (blob `4f3d4812`): §1 id grammar, §4.1 error table (codes end at `-32009`), §4.2 where errors surface, §5 `Item` and `ServedModelItem` shapes. Frozen; not edited.
- `docs/plan/PIN-madc-M0-amendment-2-session-integrity.md` and `PIN-madc-M0-amendment-3.md`: single writer, ownership and position re-check, fsync, rollback, poisoned writer, torn-tail classification. Frozen; they bind every append named here unchanged.
- `docs/plan/PLAN-madc-M1-build-plan.md` §3 (M1 non-goals: "Multi-seat handoffs, parallel seats, decision inbox (M2). `handoffs.enabled` stays `false`") and §12.
- `AGENTS.md`: Founder ruling **D-FS-1** (2026-09-30) — no GLM or Z.ai adapter; `zai-glm-coding-plan` stays forbidden.
- Code at the base, cited for what it already does (this pin changes none of it): `packages/engine/src/session-store.ts` (blob `5a4de53a`) — `SESSION_EVENT_TYPES` (`:121`), the `v: 1` envelope type (`:132`), `sortedKeyJson` (`:156`), `sessionEventHash` (`:170`), `ENVELOPE_KEYS` (`:826`), `verifySessionText` (`:853`) which fails `v !== 1` (`:890`) and whose comment reads "Unknown event types are tolerated (later milestones add events additively, envelope v:1)" (`:893`), `checkPayload` ("Extra fields are allowed", `:982`), and `rebuildSession` (`:1128`), which checks payload shape for the known types only and ignores unknown types and extra payload fields (`:1136-1141`). `packages/engine/src/seat.ts` (blob `71491ca3`) `:254-256` ("handoffs.enabled must be false in M0", "handoffs.targets must be [] in M0"). `packages/engine/src/protocol/errors.ts` (blob `5438185a`): `ErrorCode` ends at `SessionWriteFailed: -32009`.

**Steal:** two append-only logs that pin each other's entries by hash (the inclusion idea behind Certificate Transparency, roadmap §4 M3 row; MadBridge's chained ledger, idea plan §8). **Do not** copy Codex, Claude Code or Grok Build session formats, and do not depend on `madventures-tui`.

---

## 0. Vocabulary

| Term | Meaning in this pin |
| --- | --- |
| **Schema v1** | The M1 seat pin §4 event vocabulary (`session.open`, `turn.start`, `item`, `servedModel`, `fallback.rejected`, `repo.decision`, `turn.end`, `session.close`) on the `v: 1` envelope. |
| **Schema v2** | v1 **plus** the events and fields in §2–§4 of this pin, on the **same** `v: 1` envelope. "v2" names the vocabulary, not the envelope (D-M2-A0-6). |
| **v1 engine** | The engine at the base. It verifies a v2 file's chain and ignores what it does not know (§1 rule 3). It writes nothing from this pin. |
| **v2 engine** | An engine built by a later, Founder-commissioned M2 act that writes and enforces §2–§3 and refuses §4. None exists today. |
| **Reserved** | A name defined here that no engine writes until the M4 pin lifts the reservation (§4). |
| **Refusal** | The engine appends nothing and the operation fails closed with the code pinned in §5. |
| **Source / target** | The thread that hands work off, and the new thread that receives it (§2.1). |

---

## 1. Ground rules

1. **Envelope unchanged.** Every line keeps exactly the nine envelope keys `v`, `seq`, `ts`, `type`, `threadId`, `seatId`, `prevHash`, `hash`, `payload` (`ENVELOPE_KEYS`), with `v: 1`. Every new fact in this pin lives inside `payload`, so it is redacted and hashed exactly like every M1 payload. No new envelope key: a line with a tenth key fails verification today ("envelope keys differ") and must keep failing.
2. **Hash inputs unchanged.** `hash = sha256_hex(prevHash + "\n" + sortedKeyJson({ v, seq, ts, type, threadId, seatId, payload }))` (seat pin §4.3; `sessionEventHash`). Sorted-key JSON makes field order irrelevant, so each event's hash inputs below are stated as "its envelope plus the payload fields listed". A cross-chain link (§2.1) is a hash **value** carried inside a payload; it is therefore covered by the carrying line's own hash.
3. **Additive, both ways.** A v1 engine verifies a v2 file: its verifier tolerates unknown `type` values, and `rebuildSession` ignores unknown types and extra payload fields, so `thread/list`, `thread/resume` and doctor's chain check keep working on v2 files. A v2 engine verifies v1 files unchanged. Nothing ever rewrites a line (seat pin §4; Amendments 2 and 3).
4. **Redaction before hashing** (seat pin §4.2) applies to every string in every new payload: `question`, `recommendedDefault`, `brief`, paths and ids included. A redacted field still satisfies its type rule (it is a non-empty string), so redaction never turns a valid event into an invalid one.
5. **Validity is checked before the append.** Each event has required fields with pinned types (§2–§4). A v2 engine validates the payload **before** redaction and hashing. On failure: nothing is written; the writer is **not** broken (the file, its offset and the chain are untouched, because no bytes were attempted, so Amendment 2 §2/§4 and Amendment 3 §1 do not engage); the operation that needed the event fails closed with the refusal pinned for that event (§5). Reading a hash-valid line whose v2 payload is malformed is an **integrity** failure (`-32603` on resume, skipped by list, doctor FAIL), the same treatment `checkPayload` gives a malformed v1 payload today.
6. **Required means present.** "Missing" means the key is absent or `undefined`. Where a field admits `null`, `null` is a value and is written explicitly. A key present with the wrong type is "invalid". Both refuse.
7. **No new writer.** Only the thread-lock holder appends (protocol pin §3.3). Every append here is an ordinary batch under Amendment 2 §2 (ownership and position re-check) and §4 (fsync) and Amendment 3 §1 (rollback). A failed append is `-32009` exactly as today.
8. **Seat gate unchanged.** `handoffs.enabled` must be `false` and `handoffs.targets` must be `[]` (seat pin §2; `seat.ts:254-256`), else `-32006`. The seat-file change that lets a seat name handoff targets is **not** in this pin; it belongs to a later M2 act with its own new seat pin file. Until a v2 engine exists, the gate is what keeps a one-way link from ever being written (§2.1).
9. **Ids.** Every new id field (`handoffId`, `decisionId`, `callId`, thread and seat ids inside payloads) obeys the protocol pin §1 grammar `^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`. A hash field is exactly 64 lowercase hex characters. A git SHA field is exactly 40 lowercase hex characters.

---

## 2. Room events (M2)

### 2.1 Handoff — hash-linked in both directions

A handoff moves work from a **source** thread (seat A) to a **new target** thread (seat B). The roles are the only asymmetry: any seat may be a source or a target, a target may hand off again, and a hand-back from B to A is another handoff with the roles swapped. Nothing in the shapes depends on direction; "both directions" is the pair of hash links, one in each file.

**Why the source writes two lines.** The source must record the target's genesis hash, and the target's genesis must record the source's handoff hash. One pair of lines cannot do both: the target's genesis hash depends on the source hash it cites, so the cited source line has to exist first, and the source line that cites the target genesis has to come after it. The source therefore writes `handoff.out` (which the target cites), the target's `session.open` is written (citing it), and the source then writes `handoff.link` (citing the target genesis). If the target never opens, the source closes the attempt with `handoff.aborted` (D-M2-A0-3).

**Order (normative):**

1. The source appends `handoff.out` at seq `s`. Its line hash is **H**.
2. The target thread opens. Its `session.open` (seq 0) carries `payload.handoff = { sourceThreadId, sourceSeatId, handoffId, sourceSeq: s, sourceHash: H }`. Its line hash is the target's **genesis hash G**.
3. The source appends `handoff.link` carrying `targetGenesisHash: G`.
4. Only now may the target serve a turn.

If step 2 fails (the target `thread/start` returns an error, or its genesis hash cannot be read back), the source appends `handoff.aborted` instead of step 3, and step 4 never happens. Which engine process opens the target, and how the source learns G, are the M2 build plan's to decide; this pin fixes only the lines, their order and their links. The source lock holder writes steps 1 and 3; the target's lock holder writes step 2.

**Shapes:**

```ts
/** Source chain, step 1. */
type HandoffOutPayload = {
  handoffId: string;        // id grammar; unique within the source file (duplicate → doctor FAIL `duplicate-id`)
  turnId: string | null;    // the source turn that raised the handoff; null when the operator raised it between turns
  targetSeatId: string;     // id grammar; the seat the target thread opens under
  brief: string;            // the work handed over, verbatim; non-empty after trim; it becomes the target's first user input
};

/** Target chain, step 2: an ADDITIVE field on `session.open` (seat pin §4.2). */
type SessionOpenHandoffLink = {
  sourceThreadId: string;   // id grammar; the source file's threadId
  sourceSeatId: string;     // id grammar; equals the source file's envelope seatId
  handoffId: string;        // equals HandoffOutPayload.handoffId
  sourceSeq: number;        // non-negative integer; seq of the source `handoff.out` line
  sourceHash: string;       // that line's `hash` (H), 64 lowercase hex
};
// session.open.payload gains:   handoff: SessionOpenHandoffLink | null
//   null  = this thread is not a handoff target. A v1 line has no `handoff` key; absent reads as null.

/** Source chain, step 3. */
type HandoffLinkPayload = {
  handoffId: string;        // equals the `handoff.out` handoffId
  targetThreadId: string;   // id grammar; the target file's threadId
  targetSeatId: string;     // equals HandoffOutPayload.targetSeatId and the target file's envelope seatId
  targetGenesisHash: string; // the target file's seq-0 `hash` (G), 64 lowercase hex
};

/** Source chain, written instead of `handoff.link` when step 2 did not complete. */
type HandoffAbortedPayload = {
  handoffId: string;
  reason: "target-open-failed" | "target-genesis-unavailable" | "interrupted";
  error: { code: number; message: string } | null;  // the target thread/start error when there was one
};
```

Whether `targetSeatId` must appear in the source seat's `handoffs.targets` is the later seat pin's rule (rule 1.8); this pin requires the shape only.

**Hash inputs.** Each line: its envelope plus its whole payload (rule 1.2). So **H** covers `handoffId`, `turnId`, `targetSeatId` and `brief`, under the source envelope (`threadId` = source thread, `seatId` = source seat). **G** covers the target's whole `session.open` payload — `cwd`, `backing`, `providerId`, `pinnedModel`, `worktree` (§2.2) and `handoff` with `sourceHash = H` — under the target envelope, with `prevHash` = the 64-zero genesis value. The `handoff.link` hash covers **G** under the source envelope. Each file therefore pins a line of the other by hash: a rewrite of either file, even one that recomputes its own chain, is visible from the other.

**A one-way link is not a handoff (normative).** A handoff **exists** only when all three hold:

- **(a)** the source file has `handoff.out` at seq `s` with hash H;
- **(b)** the target file's seq-0 `session.open.payload.handoff` equals `{ sourceThreadId: <source threadId>, sourceSeatId: <source envelope seatId>, handoffId, sourceSeq: s, sourceHash: H }`, and the target file's envelope `seatId` equals that `handoff.out`'s `targetSeatId`;
- **(c)** the source file has a later `handoff.link` with the same `handoffId`, `targetThreadId` = the target file's threadId, `targetSeatId` = the target envelope seatId, and `targetGenesisHash` = the target's seq-0 hash.

Anything less is not a handoff:

| State | Meaning | v2 engine | Doctor (v2) |
| --- | --- | --- | --- |
| (a) only, no `handoff.link` or `handoff.aborted` after it | in progress, or a crash between steps 1 and 3 | a target that exists **cannot serve a turn**: `turn/start` → `-32010` `handoff-one-way` | WARN `handoff-incomplete` |
| (a) + `handoff.aborted` | attempt closed | a target that was created is orphaned and cannot serve a turn (same refusal) | OK (a recorded failure) |
| (b) whose cited source line does not exist, is not a `handoff.out`, or has another hash | tampering, or a source file replaced | the target cannot serve a turn (`-32010` `handoff-one-way`) | FAIL `handoff-mismatch` |
| (c) whose `targetGenesisHash` differs from the target's seq-0 hash, or whose seat or thread ids disagree with (b) | tampering | the target cannot serve a turn | FAIL `handoff-mismatch` |
| (b) and (c) agree but the other file cannot be read (deleted, torn tail, another `MADC_HOME`) | unverifiable, not invalid | the readable side serves as today; the link is **never reported as verified** | WARN `handoff-unverifiable` |

A v2 engine checks (b) and (c) against the source file before the first `turn/start` on a target thread and on every `thread/resume` of it. A v1 engine does neither (rule 1.3). That is why rule 1.8 keeps the seat gate closed until a v2 engine exists.

**Refusals (missing or invalid field):**

| Line | Missing or invalid | Refusal (§5) | Effect |
| --- | --- | --- | --- |
| `handoff.out` | `handoffId`, `turnId` (key), `targetSeatId` or `brief` missing; `brief` empty after trim; an id outside the grammar | `-32010` `field-missing` / `field-invalid` | nothing appended; the handoff does not start. Mid-turn this is an `error` item and the turn continues (protocol pin §4.2, row 3) |
| target `session.open.handoff` | present and non-null with any of the five sub-fields missing or mistyped (`sourceHash` not 64 lowercase hex, `sourceSeq` not a non-negative integer) | `-32010` `field-missing` / `field-invalid` on the target `thread/start` | no target file is created; the source then appends `handoff.aborted` with `target-open-failed` |
| `handoff.link` | `targetGenesisHash` unavailable or not 64 lowercase hex; `targetThreadId` or `targetSeatId` missing | the engine appends `handoff.aborted` with `target-genesis-unavailable` instead; a partial `handoff.link` is never written | a target that was created is orphaned (cannot serve a turn) |
| `handoff.aborted` | `handoffId` or `error` key missing; `reason` missing or outside the enum | `-32010` `field-missing` / `field-invalid` (an engine fault) | nothing appended; one stderr line `session <threadId>: handoff.aborted refused (<issue>)`; the attempt stays `handoff-incomplete` in doctor |

### 2.2 Worktree identity — HEAD at open and at close

Additive fields on `session.open` and `session.close`:

```ts
type WorktreeIdentity = {
  topLevel: string;         // absolute realpath of the git top-level that contains the thread's cwd (seat pin §5 identity rules)
  remote: string | null;    // normalized `origin` remote (seat pin §5), or null when there is no origin or its endpoints disagree
  head: string | null;      // `HEAD` resolved at that top-level: 40 lowercase hex; null only for an unborn branch (no commit yet)
};
// session.open.payload gains:   worktree: WorktreeIdentity | null   // null when cwd is null or not inside a git work tree
// session.close.payload gains:  worktree: WorktreeIdentity | null   // HEAD re-read at close at the RECORDED topLevel; null when it can no longer be read
```

**Rules.**

- **Engine-owned, never caller-supplied.** The engine resolves `topLevel` from `cwd` the way it resolves repo identity today (seat pin §5: realpath of the git top-level, symlinks resolved; a linked worktree resolves to its own top-level, not the main checkout's). `cwd` itself stays recorded as it is today (the caller's string). `remote` follows the seat pin §5 normalization and agreement rules; disagreement or absence records `null`, never a guess.
- **At open.** A v2 engine always writes the `worktree` key on `session.open` (an object or `null`). `head` is the commit `HEAD` resolves to at that moment.
- **At close.** A v2 engine writes `session.close` on every clean shutdown of a thread (M1 made it optional; D-M2-A0-5), with `worktree.head` re-read at the **recorded** `topLevel`, not at the current `cwd`, and `topLevel` equal to the open's. If the recorded top-level can no longer be read, `worktree` is `null` at close and doctor WARNs `worktree-head-unreadable`. A missing `session.close` means the thread is open or ended uncleanly; it is never invalid.
- **No worktree is created.** No act under this pin creates a worktree. Recording identity is the whole scope; a thread that runs in a worktree the operator made is recorded like any other. Parallel seats and engine-made worktrees are the M2 build plan's (§6).
- **Between open and close** HEAD may move (the seat commits). Per-turn HEAD is not recorded by this pin; a seat cites its commits as `git` evidence refs (§3). The M2 build plan may add a per-turn record as a new event; this pin does not.
- **Hash inputs.** Part of the `session.open` and `session.close` payloads, so covered by the genesis hash G (a handoff target's genesis binds the worktree it started in) and by the close line's hash.

**Refusals (missing or invalid field):**

| Line | Missing or invalid | Refusal (§5) | Effect |
| --- | --- | --- | --- |
| `session.open.worktree` | key missing (a v2 engine always writes it); an object missing `topLevel`, `remote` or `head`; `topLevel` not an absolute path; `head` neither null nor 40 lowercase hex | `-32010` `field-missing` / `field-invalid` at `thread/start` | no file is created |
| `session.close.worktree` | the same shape faults; or `topLevel` differs from the open's | no `session.close` is appended; one stderr line `session <threadId>: close record refused (<issue>)` | the chain stays valid; doctor shows the thread as not cleanly closed |

**Verifier rule (v2).** On `session.open`, the keys `handoff` and `worktree` are **both present or both absent** (a v1 line has neither; a v2 line has both). One without the other is an integrity failure, the way a partial `mode` / `presence` set is on `turn.start` today.

### 2.3 `founderDecision`

```ts
type FounderDecisionPayload = {
  decisionId: string;          // id grammar; unique within the file (duplicate → doctor FAIL `duplicate-id`)
  turnId: string;              // the turn that raised it
  question: string;            // non-empty after trim
  recommendedDefault: string;  // exactly one; non-empty after trim
  evidenceRefs: EvidenceRef[]; // at least one; each valid under §3
};
```

**Rules.**

- The event records the **escalation**, never the answer. Where the Founder reads and rules (the inbox) is a non-goal of this act (§6); the ruling record is left to the M2 build plan and is **not** this event.
- **One recommended default**, by type: `recommendedDefault` is a single string. A list of alternatives is not a field; an empty string is invalid.
- **Evidence or nothing.** `evidenceRefs` has at least one entry, each well-formed (§3). A decision with no evidence ref is invalid and is never written.
- **Seats do not get a free-text escalation.** No other event type, item kind or method carries a question to the Founder. An `agentMessage` that asks a question is text, not a decision; the engine never derives a `founderDecision` from text. The typed mechanism by which a seat raises one (a typed tool or method) is the M2 build plan's to commission; whatever it is, it is refused when a typed field is missing, and there is no fallback to "just ask".
- **Hash inputs.** Envelope plus the whole payload, so the cited `hash` values inside `evidenceRefs` are bound by the decision line.

**Refusals (missing or invalid field):**

| Missing or invalid | Refusal (§5) | Effect |
| --- | --- | --- |
| `evidenceRefs` missing or `[]` | `-32010` `evidence-ref-missing` | nothing appended; an `error` item with code `-32010` in the turn; the turn continues; the seat may retry with evidence |
| an entry malformed under §3 | `-32010` `evidence-ref-invalid` | same |
| a same-file `session` / `servedModel` ref whose `seq` is not below the current `nextSeq`, whose `hash` differs from that line's, or whose line type is wrong (D-M2-A0-4) | `-32010` `evidence-ref-invalid` | same |
| `decisionId`, `turnId`, `question` or `recommendedDefault` missing, mistyped, or empty after trim | `-32010` `field-missing` / `field-invalid` | same |

---

## 3. `EvidenceRef`

The one reference type every evidence-bearing field uses (roadmap §4 M3 row: "session path + seq + hash, or git SHA, or servedModel receipt").

```ts
type EvidenceRef =
  | { kind: "session";     path: string; seq: number; hash: string }   // any chained line
  | { kind: "servedModel"; path: string; seq: number; hash: string }   // a chained line whose type is `servedModel`
  | { kind: "git";         sha: string;  remote: string | null };      // a commit or object
```

**Well-formed (checked at write time):**

- `path` is `sessions/<threadId>.jsonl`, relative to `$MADC_HOME`, with `<threadId>` in the id grammar; nothing else (no absolute path, no `..`, no other directory, no other extension). It names a file, never a lock or reclaim artefact.
- `seq` is a non-negative integer; `hash` is 64 lowercase hex.
- `sha` is 40 lowercase hex (SHA-1 object names). SHA-256 repositories are out of scope until an act brings them in. `remote` is a normalized remote (seat pin §5) or `null`.
- No other `kind`. A plain URL, a file path outside `sessions/`, or free text is not evidence.

**Resolved (checked by a verifier, and at write time for same-file refs under D-M2-A0-4):**

- A `session` ref resolves when the named file verifies and its line at `seq` has that `hash`. A `servedModel` ref additionally requires that line's `type` to be `servedModel`.
- A `git` ref resolves when the object exists in the thread's recorded `topLevel` (§2.2) or, if `remote` is given, in a checkout of that remote the verifier can read.
- A ref that cannot be resolved is reported **unresolved**, never silently accepted. Doctor WARNs `evidence-ref-unresolved`; a ref whose line exists but whose hash differs is FAIL `evidence-ref-mismatch`. The M3 rule follows from this: "the renderer refuses a success state without a verified ref" (roadmap §4 M3).

Which engine resolves what at write time is D-M2-A0-4. The shape check is never optional.

---

## 4. Reserved for M4 — defined here, not stored

Roadmap §2: "Persistent memory is not a prerequisite for the desktop, as long as M2 defines memory-write and tool-call receipt events in schema v2. M3 can then show them, and M4 fills them with a real store." The two names below are **reserved**: their shapes are fixed now; **no engine writes them** before the M4 pin lifts the reservation. There is no memory store and no MCP in M2 (§6). A v2 engine asked to append either refuses with `-32010` `reserved` and writes nothing. A v2 verifier validates their shape when it meets one in a file, so a malformed reserved line is an integrity failure (D-M2-A0-2).

### 4.1 `memory.write` — a memory-write receipt (seat, turn, served model)

```ts
type MemoryWritePayload = {
  turnId: string;             // the turn in which the write happened
  path: string;               // the seat's memory file, relative, under `memory/`, ending `.md` (seat pin §2 SeatMemory `file` rules)
  op: "append";               // memory files are append-only text (seat pin §1)
  bytes: number;              // bytes appended; a positive integer
  contentSha256: string;      // sha256 of exactly those bytes, 64 lowercase hex
  requestedModel: string;     // the served-model identity of the invocation that issued the write,
  servedModel: string;        //   copied as the M1 receipt would record it (protocol pin §5):
  providerId: string;         //   requested, served, registry id, lane and whether the vendor reported it
  lane: ProviderStatus;
  vendorReported: boolean;
};
```

- **Seat** is the envelope `seatId`: a seat writes only its own memory, so the writer is always the thread's seat. A `path` outside the seat's own confined memory path is invalid.
- **Turn** is `turnId`. **Served model** is inline, as known when the write is issued, because the `servedModel` chain line for that invocation may not exist yet when the write happens. The M4 pin may add a back-reference to that receipt; it may not remove the inline fields.
- **No receipt, no write** is the M4 rule this shape exists to serve; its ordering and failure semantics (receipt before bytes, or bytes before receipt) are the M4 pin's to fix, not this pin's.
- **Hash inputs.** Envelope plus the whole payload.
- **Refusal when a field is missing (M4):** `-32010` `field-missing` / `field-invalid`; the memory write itself must not happen without a valid receipt. Until M4: `-32010` `reserved`, always.

### 4.2 `tool.call` — a tool-call receipt

```ts
type ToolCallReceiptPayload = {
  turnId: string;
  callId: string;                               // equals the `toolCall` item id
  name: string;                                 // tool name as called
  server: string | null;                        // MCP server id (M4); null for an engine-native tool. Always null until M4.
  call: { seq: number; hash: string };          // same-file ref to the `item` line that holds the `toolCall`
  result: { seq: number; hash: string } | null; // same-file ref to the `item` line that holds the `toolResult`; null when the call was denied before it ran
  decision: "allowed" | "denied";               // the seat tools policy outcome (deny wins, seat pin §2)
  reason: string | null;                        // the matching deny pattern when denied; null when allowed
};
```

- The receipt is the compact audit record; the `toolCall` and `toolResult` items (protocol pin §5) stay the full record, written as `item` lines as today. The receipt points at them by `seq` + `hash`, so it is itself an `EvidenceRef`-shaped pair of same-file links.
- **Hash inputs.** Envelope plus the whole payload; the two same-file refs bind the item lines.
- **Refusal when a field is missing (M4):** `-32010` `field-missing` / `field-invalid`; `call` must resolve in the same file (D-M2-A0-4). Until M4: `-32010` `reserved`, always.

---

## 5. The refusal: `-32010 EvidenceInvalid` (proposed)

The M1 protocol pin §4.1 table ends at `-32009`. This pin proposes one code for every schema-v2 refusal, so an operator, a seat and doctor can tell "the record was invalid" from an I/O failure (`-32009`), from bad request params (`-32602`) and from an unexpected engine fault (`-32603`). It is **not** in `ErrorCode` at the base, no M1 pin is edited to add it, and it binds only when the Founder merges this pin (or rules otherwise, D-M2-A0-1). The M2 protocol pin, when written, carries it into the error table.

| Code | Name | When | `data` |
| --- | --- | --- | --- |
| -32010 | EvidenceInvalid | A schema-v2 line would be written with a required field missing or invalid; a `founderDecision` has no evidence ref or a malformed or mismatched one; a handoff target is asked to serve a turn while its link is one-way; a reserved (M4) type is requested. **Nothing is appended.** | `{ threadId: string, turnId: string \| null, type: string, reason: EvidenceRefusal, issues: string[] }` |

```ts
type EvidenceRefusal =
  | "field-missing"          // a required key is absent
  | "field-invalid"          // a key is present with the wrong type, an empty string, a bad id, or a bad hex length
  | "evidence-ref-missing"   // `evidenceRefs` absent or empty
  | "evidence-ref-invalid"   // an entry fails §3 well-formedness, or a same-file ref does not resolve
  | "handoff-one-way"        // §2.1 (b) or (c) does not hold for a target thread asked to serve a turn
  | "reserved";              // §4: a `memory.write` or `tool.call` append requested before the M4 pin
```

`issues` are human-readable strings (not a contract, like every `message`); `code`, `reason` and the other `data` keys are the contract. `data` never carries secrets, env, the `brief` or the `question` text (protocol pin §4).

**Where it surfaces** (protocol pin §4.2, unchanged rows):

| Situation | Surface |
| --- | --- |
| `thread/start` of a handoff target with a malformed `handoff` or `worktree` record | response `error` `-32010`; no file created |
| `turn/start` or `thread/resume` on a target whose link is one-way | response `error` `-32010` `handoff-one-way`; nothing appended |
| a seat raises a `founderDecision` or a `handoff.out` mid-turn with a missing field | `error` item with `code: -32010`; the turn **continues** (recoverable); nothing appended |
| the engine itself would write a malformed `handoff.aborted` or `session.close` | nothing appended; one stderr line; no protocol error (the operation that needed the line has already answered) |

---

## 6. Non-goals of this act (M2-A0)

Stated so no reader mistakes a defined shape for a built thing:

- **Parallel seats.** One active turn per thread, one thread per seat run, exactly as M1. No scheduler, no concurrency rule.
- **Git worktrees.** None created, none managed. §2.2 records identity only.
- **An inbox.** No delivery of `founderDecision` to the Founder, no ruling record, no `madc decisions` command, no notification.
- **A desktop.** No window, no widget, no transport (protocol pin §6: no WS/HTTP listener; the desktop transport is an M3 amendment).
- **The GPUI-vs-Tauri choice.** D-R6 stands: Surface Architect recommends during M2 and the Founder rules before M3-A0. This pin makes no recommendation.
- **A Claude rate cap.** The roadmap §3 flag ("M2 parallel seats on Claude Code should be rate-capped per seat") is a build concern for the act that introduces parallel seats. Nothing here caps anything.
- **npm publish.** No publish, no version bump, no scope change.
- **Any change to Z.ai.** `zai-glm-coding-plan` stays `forbidden` (D-R3; D-FS-1). No adapter, no catalog change, no `zai-payg` id in this act.
- Also not here: any code; any new protocol method; any change to `handoffs.enabled` or `handoffs.targets`; any seat schema change; any envelope change; a memory store; MCP; the ACP server; signatures or custody on the chain; a SQLite store; torn-tail repair; `ThreadStatus "closed"` semantics (still reserved, protocol pin §5).

---

## 7. Doctor (v2) — what a verifier reports for this schema

A summary for the M2 act that extends doctor's `session` row and for M3's binding. FAIL means the chain or a link is wrong; WARN means a fact could not be established.

| Finding | Level | Where |
| --- | --- | --- |
| `handoff-mismatch` | FAIL | §2.1 (b) or (c) names a line that exists with a different hash, type, seat or thread |
| `evidence-ref-mismatch` | FAIL | a cited `hash` differs from the line at that `seq` |
| `duplicate-id` | FAIL | two `handoff.out` with one `handoffId`, or two `founderDecision` with one `decisionId`, in one file |
| malformed v2 payload, or `handoff`/`worktree` present without the other on `session.open` | FAIL (integrity) | rule 1.5, §2.2 verifier rule |
| `handoff-incomplete` | WARN | `handoff.out` with no later `handoff.link` or `handoff.aborted` |
| `handoff-unverifiable` | WARN | the other file of a link cannot be read |
| `evidence-ref-unresolved` | WARN | a well-formed ref whose file or object the verifier cannot read |
| `worktree-head-unreadable` | WARN | `session.close.worktree` is null after a non-null open |
| not cleanly closed | WARN | no `session.close` on a thread the lock says is not live |

Nothing in this table edits, repairs or deletes a file (Amendment 2 §5; Amendment 3 §2).

---

## 8. Sample lines (hashes truncated, illustrative only)

Source thread `thr_a` (seat `daedalus`) hands off to a new target `thr_b` (seat `hephaestus`). Lines from two files, in the §2.1 order.

```json
{"v":1,"seq":7,"ts":1759300000000,"type":"handoff.out","threadId":"thr_a","seatId":"daedalus","prevHash":"5e6f…","hash":"H111…","payload":{"handoffId":"ho_01","turnId":"turn_03","targetSeatId":"hephaestus","brief":"Implement §2.1 of the pin; tests first."}}
{"v":1,"seq":0,"ts":1759300001000,"type":"session.open","threadId":"thr_b","seatId":"hephaestus","prevHash":"0000000000000000000000000000000000000000000000000000000000000000","hash":"G222…","payload":{"cwd":"/Users/mike/proj","backing":"codex","providerId":"codex","pinnedModel":"<the seat's pinnedModel>","worktree":{"topLevel":"/Users/mike/proj","remote":"github.com/MADVenturesLLC/MADC","head":"c4f97fc668c4b55d701b0be4875aa0c4180cdd15"},"handoff":{"sourceThreadId":"thr_a","sourceSeatId":"daedalus","handoffId":"ho_01","sourceSeq":7,"sourceHash":"H111…"}}}
{"v":1,"seq":8,"ts":1759300001200,"type":"handoff.link","threadId":"thr_a","seatId":"daedalus","prevHash":"H111…","hash":"7a7b…","payload":{"handoffId":"ho_01","targetThreadId":"thr_b","targetSeatId":"hephaestus","targetGenesisHash":"G222…"}}
```

A `founderDecision` raised later in `thr_b`, citing its own served-model receipt and a commit:

```json
{"v":1,"seq":14,"ts":1759300400000,"type":"founderDecision","threadId":"thr_b","seatId":"hephaestus","prevHash":"9c9d…","hash":"e0e1…","payload":{"decisionId":"dec_01","turnId":"turn_02","question":"Keep -32010 as the schema-v2 refusal code, or reuse -32603?","recommendedDefault":"Keep -32010: an operator must be able to tell an invalid record from an engine fault.","evidenceRefs":[{"kind":"servedModel","path":"sessions/thr_b.jsonl","seq":11,"hash":"3b3c…"},{"kind":"git","sha":"c4f97fc668c4b55d701b0be4875aa0c4180cdd15","remote":"github.com/MADVenturesLLC/MADC"}]}}
```

Placeholders in angle brackets stand for values the engine fills; no model string is pinned by this sample (`AGENTS.md`, ruling of 2026-09-30).

---

## 9. FOUNDER_DECISION_REQUIRED

Each row has one recommended default. None blocks Argus review. Rulings are recorded in this file by a Founder-merged PR that says so (README draft edit rule).

| # | Decision | Recommended default | What it blocks |
| --- | --- | --- | --- |
| D-M2-A0-1 | The schema-v2 refusal code: a new `-32010 EvidenceInvalid` (§5), or reuse of `-32603` / `-32602`? | **New `-32010`.** An invalid record must be distinguishable from an engine fault and from bad params; the reasons in §5 give doctor and M3 one enum to bind. | The M2 protocol pin's error table |
| D-M2-A0-2 | Reserved M4 names (`memory.write`, `tool.call`) met in a file today: validate their shape (integrity failure if malformed), or tolerate as unknown? | **Validate.** Nothing legitimate writes them yet, so a shape fault is a fault. | The v2 verifier |
| D-M2-A0-3 | Record a failed target open as `handoff.aborted`, or leave the `handoff.out` dangling? | **Record it.** A dangling `handoff.out` is indistinguishable from a crash; a recorded abort is evidence. | §2.1 |
| D-M2-A0-4 | Resolve same-file `session` / `servedModel` evidence refs at write time (the writer holds the verified file), with cross-file and `git` refs left to the verifier? | **Yes, same-file at write time.** It is cheap and it stops a seat citing a hash that is not in its own file. | §2.3, §3, §4.2 |
| D-M2-A0-5 | A v2 engine writes `session.close` on every clean shutdown (M1: optional), so the close-time HEAD is recorded? | **Yes.** Without it, "HEAD at close" is never recorded. | §2.2 |
| D-M2-A0-6 | Envelope stays `v: 1` with v2 as an additive vocabulary (the base's verifier comment), or bump to `v: 2` so v1 engines fail closed on v2 files? | **Stay `v: 1`.** The base already tolerates unknown types for exactly this reason; a bump breaks "additive" and buys nothing a v1 engine could enforce anyway. | §1 |

---

## 10. Acceptance — for the M2 acts that implement this pin (not for M2-A0)

M2-A0 adds no tests (its deliverable is this file). The act that first writes a §2 event must land these, with mutations that the tests kill:

1. **Two-way link verifies.** A source and a target fixture satisfy §2.1 (a)–(c); doctor reports no handoff finding. Editing any one of the three link lines (`handoff.out`, the target `session.open`, `handoff.link`), even with that file's later hashes recomputed, is FAIL `handoff-mismatch` from the other file.
2. **One-way is refused.** A target whose source has no `handoff.link` gets `-32010` `handoff-one-way` on `turn/start` and `thread/resume`; nothing is appended (size and sha256 unchanged); doctor WARNs `handoff-incomplete`. The same with a `handoff.aborted` present.
3. **Evidence or nothing.** A `founderDecision` with `evidenceRefs: []`, with a malformed ref, and with a same-file ref whose hash is wrong each gets `-32010` with the pinned reason; nothing is appended; the turn continues and a later valid decision appends. Mutation: accept an empty list.
4. **Worktree HEAD.** A fixture repo's `session.open.worktree.head` equals its `HEAD` object name at open; after a commit, `session.close.worktree.head` equals the new one; `cwd` in a subdirectory still records the top-level; a non-git `cwd` records `null`; a linked worktree records its own top-level.
5. **Additive both ways.** A v1 fixture file verifies and rebuilds unchanged under the v2 engine. A v2 fixture file passes the base's `verifySessionText` and `rebuildSession` (this holds at the base today and must keep holding: unknown types tolerated, extra `session.open` fields ignored).
6. **Seat gate unchanged.** A seat file with `handoffs.enabled: true`, or `targets` non-empty, still fails `-32006` — at the base and after every M2 act until a new seat pin file says otherwise.
7. **Redaction.** A `brief`, `question` or `recommendedDefault` containing an injected key shape (seat pin §4.2 patterns) is `[REDACTED]` on disk and the chain still verifies.
8. **Reserved stays reserved.** The writer refuses `memory.write` and `tool.call` with `-32010` `reserved`; a guard test fails if either name enters the writable set before the M4 pin.
9. **Nothing written on refusal.** For every refusal in §2–§4: file size, sha256 and the writer's `nextSeq` are unchanged, and the writer is not broken (the next valid append succeeds).

---

## 11. Sources read for this pin

All at `main` @ `c4f97fc668c4b55d701b0be4875aa0c4180cdd15`: `docs/plan/README.md`, `ROADMAP-madc-post-M0.md` (§2, §4, §5, §6), `PLAN-madc-M1-build-plan.md` (§2, §3, §11, §12), `PIN-madc-M1-seat-format.md` (whole), `PIN-madc-M1-protocol-messages.md` (whole), `PIN-madc-M0-amendment-2-session-integrity.md` (whole), `PIN-madc-M0-amendment-3.md` (§1–§2), `PIN-madc-M0-witness-rev6.2-amendment.md` (header, for the proposed-status form), `docs/runbook/M1.md`, `AGENTS.md`; `packages/engine/src/session-store.ts`, `seat.ts` (`:240-262`), `protocol/errors.ts`, `policy/identity.ts`, `policy/store.ts` (exports only). PR #44 and PR #30 bodies on GitHub, for the act-PR form. No live web source was needed; none was fetched. No model, vendor or paid call was made.

*End of proposed M2 evidence schema v2 pin.*
