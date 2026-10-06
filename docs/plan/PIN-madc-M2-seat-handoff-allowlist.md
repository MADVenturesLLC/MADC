# PIN (proposed): M2 seat handoff allowlist: `handoffs.enabled: true` with a non-empty `handoffs.targets`, consulted by `thread/handoff`

*Builder-drafted (Hephaestus) under the Founder's M2-A3 instrument, issued 2026-10-06, Stage 2 · 2026-10-06 · Venue: `MADVenturesLLC/MADC` · Status: **proposed until the Founder merges this PR**. It relaxes the seat gate once, only as far as the allowlist, and replaces `thread/handoff` step 1 row 9. Proposed amendment P-M2-1 of the M2 build plan. For Argus review.*

*Base: `main` @ `5b6ac4cdfce564c732301246f5dcb9e9c31b3b4e` (tree `f3beb3b0c861db4c4dde1b3eb129c6ed0eb1d6ea`), plus this act's Stage 1 commit `4de9343f05e2dc5d54817d09795a0d64fd7a4eb0` (handoff amendment 1). Every file cited below was read on that branch.*

**What this pin does.** A v2 seat file may now set `handoffs.enabled: true` with a non-empty `handoffs.targets` list of seat ids. `thread/handoff` consults the **source** seat's list: a target the list does not name is refused `-32006` before any append. A self-handoff stays allowed without a list entry (D-445).

**What it does not do.** It does not change the v1 seat schema, the evidence pin, `protocolVersion`, the seeds, `seat/list`, doctor, or A2 pin §4 step 3's target `cwd` (M2-A5 owns that amendment). It starts no turn and creates no worktree. Only the seat file supplies `targets`; no request carries it.

**Authority** (SHA-256 on this branch):

| Path | SHA-256 | Role |
| --- | --- | --- |
| `docs/plan/PLAN-madc-M2-build-plan.md` | `42579eca40a494dfba9d7592450c72f78c31953e6ad4f0e017fad46f0601b587` | Accepted plan: §6 rule 4 (codes), §7 M2-A3, §9 P-M2-1, Carried M2 obligation 3 (D-445) |
| `docs/plan/PIN-madc-M2-handoff-procedure.md` | `8ea585084a0973ccc6b4e5243a247473c84f6faed67af1fad18caf447c39ffa7` (after amendment 1's pointer; `607d3269…` at the base) | A2 pin: §3 refusals (row 9 replaced here), §6 deferral of the allowlist (superseded here) |
| `docs/plan/PIN-madc-M2-handoff-procedure-amendment-1.md` | `72dd065eaf775980ff40916a5a3a178b608c57045c20030773650e0d4f010194` | Row 2's `data.turnId: null` (D-399) and row 8a (D-389), carried into §3 below |
| `docs/plan/PIN-madc-M2-evidence-schema-v2.md` | `75d6eb47b3d441bed7f58d23806795fd8ee06821370e2401689e6fdad0e53ffa` | Rule 1.8: the gate stays closed until "a later M2 act with its own new seat pin file"; this is that file. **Frozen; not edited** |
| `docs/plan/PIN-madc-M1-seat-format.md` | `5b802ce68fa93adf80c3cdbb1f8b668ef0965a16b13253516e26c40cd35c4660` | Seat schema v2 (S2), `SeatHandoffsStub`, resolution to `-32005` / `-32006`. **Frozen; not edited** |
| `docs/plan/PIN-madc-M1-protocol-messages.md` | `6c6eb179e15c9f481e1185c27565ccc5876fbe734fe982ce532673d21b75e88f` | §1 id grammar; §4.1 `-32005 { seatId, path }`, `-32006 { seatId, path, issues }`. **Frozen; not edited** |

---

## 1. Ground rules

1. **A new dated pin, no in-place edit.** The M1 seat pin, the evidence pin, the A2 pin and amendment 1 are not edited. Where this pin and the M1 seat pin §2 differ on `handoffs`, this pin governs M2 work, for v2 files only (§2).
2. **The seat gate moves once, and only as far as the allowlist** (plan rule 4, criterion F). Every other seat rule is unchanged.
3. **The engine consults the seat file, never the caller.** `thread/handoff` params have no `targets` field, and an extra key in params is ignored, so no caller value can widen a seat's list.
4. **Nothing is written on refusal.** Every refusal in §3 leaves the source file's size, SHA-256 and next seq unchanged, creates no session file and no lock, and leaves the writer usable.

## 2. The seat field

`handoffs` in a seat file is one of exactly two shapes:

| File | `handoffs` | Result |
| --- | --- | --- |
| v1 or v2 | `{ "enabled": false, "targets": [] }` | Loads (unchanged; every seeded seat). |
| **v2 only** | `{ "enabled": true, "targets": ["<seat id>", …] }`, one or more entries, each matching the id grammar `^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$` | Loads. The seat may hand off to exactly the listed ids. |

Anything else fails the seat schema, `-32006 SeatInvalid` at `thread/start`, `thread/resume` and `thread/handoff`'s target load, with these issues:

| File | Shape | `issues` entry |
| --- | --- | --- |
| v1 | `enabled` not `false` | `handoffs.enabled must be false in M0` (unchanged) |
| v1 | `targets` not `[]` | `handoffs.targets must be [] in M0` (unchanged) |
| v2 | `enabled: true`, `targets` missing, not a list, or `[]` | `handoffs.targets must list at least one seat id when handoffs.enabled is true` |
| v2 | `enabled: true`, an entry outside the id grammar (a wildcard such as `*`, an empty string, a non-string) | `handoffs.targets[<i>] must match ^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$` |
| v2 | `enabled: false`, `targets` not `[]` | `handoffs.targets must be [] when handoffs.enabled is false` |
| v2 | `enabled` not a boolean | `handoffs.enabled must be a boolean` |

Notes:

- **Why v2 only.** A v1 file is the closed M0 schema (M1 seat pin S2), so a v1 file loads, and refuses, exactly as before this pin, issue text included. A seat that needs an allowlist uses a v2 file, as the four roster seats already do. This is the builder's reading of "the only seat-gate relaxation" (criterion F) and is flagged for the Founder: the instrument does not name a file version.
- **Entries.** A list may name the seat's own id (it is not needed, §4), and a repeated id has no effect. A listed id need not have a seat file when the source loads; it is checked when a handoff names it (§3 row 9).
- **In memory.** The loaded seat carries `handoffs` as validated: `{ enabled: true, targets: [the list, in file order] }` for an allowlist, `{ enabled: false, targets: [] }` otherwise.
- **No seed change.** `madc-default` and the roster seeds keep `{ enabled: false, targets: [] }`, and a seed never rewrites a seat file already on disk.

## 3. `thread/handoff` step 1: the refusal order with the allowlist

Every row of the A2 pin §3 table, with amendment 1's row 2 `data` and row 8a, and **row 9 replaced in place**. Each refusal appends nothing (§1 rule 4). They run in this order:

| # | Check | Code | `data` |
| --- | --- | --- | --- |
| 1 | `params` not an object; `threadId` missing, not a string, or outside the id grammar | `-32602 InvalidParams` | `{ issues }` |
| 2 | the `handoff.out` fields: `targetSeatId`, `brief` or the `turnId` key missing → `field-missing`; a wrong type, an id outside the grammar, or `brief` empty after trim → `field-invalid` | `-32010 EvidenceInvalid` | `{ threadId, turnId: null, type: "handoff.out", reason, issues }` (amendment 1, D-399) |
| 3 | the source writer was poisoned in this process | `-32009 SessionWriteFailed` | `{ threadId, path, seq }` |
| 4 | the source is not loaded on this connection, and a live process holds its lock | `-32004 TurnAlreadyActive` | `{ threadId, activeTurnId: null, lockHolderPid }` |
| 5 | the source is not loaded on this connection, and no live process holds its lock | `-32002 ThreadNotFound` | `{ threadId }` |
| 6 | the source is loaded but this connection no longer holds its lock (refused, never re-taken) | `-32004 TurnAlreadyActive` | `{ threadId, activeTurnId: null, lockHolderPid? }` |
| 7 | the source writer is broken | `-32009 SessionWriteFailed` | `{ threadId, path, seq }` |
| 8 | the source is itself a handoff target whose own link does not verify (the M2-A1 gate) | `-32010` `handoff-one-way` | `{ threadId, turnId: null, type: "session.open", … }` |
| 8a | `turnId` is not `null` and names no `turn.start` in the source file (amendment 1, D-389) | `-32010 EvidenceInvalid` | `{ threadId, turnId: null, type: "handoff.out", reason: "field-invalid", issues }` |
| **9** | **the target seat is not allowed:** (9a) it has no seat file; (9b) its seat file does not read, parse or pass the seat schema, its own seat gate (§2) included; (9c) it is not the source's own seat, and the source seat's `handoffs` is not `enabled` with `targetSeatId` exactly equal to an entry of `targets` | (9a) `-32005 SeatNotFound`; (9b) `-32006 SeatInvalid`; (9c) `-32006 SeatInvalid` | (9a) `{ seatId, path }` and (9b) `{ seatId, path, issues }` for the target, as `thread/start`; (9c) `{ seatId: <source seat id>, path: <source seat file>, issues: ["handoffs.targets does not name targetSeatId"] }` |

Notes on the order (the A2 pin's notes, carried forward, and the new row):

- Row 1 keeps `threadId` where every method keeps it: it routes the request, and an id outside the grammar cannot name a thread for `-32010`'s `data.threadId`.
- Row 2 runs before any lock, seat or path use, so `targetSeatId` is checked against the grammar before it is joined into `seats/<id>.json`. It is the writer's own rule (`checkV2Payload("handoff.out", …)`). Its `data.turnId` is `null`: no `turnId` has been shown to name a `turn.start` yet (amendment 1).
- Rows 4 to 6 are "the caller does not hold the source thread lock". A thread this connection never loaded and nobody holds answers `-32002`, as `turn/start` does.
- Row 8 is the existing gate (`turn/start` runs the same one): an orphaned target hands nothing on.
- Row 8a reads the source's own turns, so it follows rows 3 to 8; it precedes row 9, so a refused record never loads a seat.
- **Row 9 loads the target first, then consults the list.** So an unknown id is `-32005` whether or not a list names it, and a target that fails its own schema or gate is `-32006` with the target's own `issues`, as `thread/start` reports it. Only a loadable target reaches 9c. The plan and the instrument both put an unknown id at `-32005`; loading first makes that hold for every unknown id.
- **9c is exact.** `targetSeatId` must equal a list entry character for character: no wildcard, no prefix, no case fold, no normalization. The id grammar admits no wildcard character, so `*` cannot even be listed (§2).
- **9c reads the source seat as this connection loaded it**, at `thread/start` or `thread/resume`. An edit to the source seat file applies from the thread's next load. The target's own list plays no part in receiving a handoff; it governs only the target's own handoffs.
- **9c's `data` names the source seat file**, the file that decides the refusal, and names `targetSeatId` only as a field. The caller's value is not echoed.

Steps 2 to 5 of the A2 pin are unchanged.

## 4. D-445: self-handoff

The Founder ruled, as the accepted plan records it (Carried M2 obligation 3): "allow self-handoff as shipped; Surface states it in the next handoff amendment". This pin states the allowlist consequence:

**A `thread/handoff` whose `targetSeatId` is the source's own seat stays allowed, and a seat does not need to list its own id in `handoffs.targets` for it.** This holds whether the source seat's `handoffs.enabled` is `true` or `false`. The target is still loaded (row 9a and 9b), so a source seat file that no longer loads refuses its own self-handoff.

This pin states the consequence only. The plan leaves the statement of the ruling itself to a handoff amendment; amendment 1 does not make it.

## 5. What this pin supersedes, and what it leaves

- **Supersedes:** the A2 pin's §6 deferral of the allowlist ("`handoffs.enabled` stays `false` and `handoffs.targets` stays `[]` … the allowlist is a later seat pin"), its opening "What it does not do" sentence about `targets`, and its §3 note "`handoffs.targets` of either seat is not consulted". Nothing else in that pin.
- **Satisfies:** evidence pin rule 1.8's "a later M2 act with its own new seat pin file". The evidence pin is not edited.
- **Leaves:** the M1 seat pin §2 gate, which still governs v1 files; A2 pin §4 step 3's target `cwd` (M2-A5); the seeds; `seat/list`, which still omits `handoffs`; `protocolVersion` `madc-m1/1`.
- **Known stale text outside this act's paths:** the doc comment on `SeatSummary` in `packages/engine/src/protocol/types.ts` still calls `handoffs` "always `{ enabled: false, targets: [] }`". `seat/list`'s behaviour is unchanged (it omits `handoffs`); the comment is not in the M2-A3 instrument's paths, so it is left for a later act.

## 6. Acceptance

| Instrument §7 row | Test | Evidence |
| --- | --- | --- |
| An allowlisted target completes the two-way link | `handoff-procedure.test.ts` "M2-A2 success (M2-A3: an allowlisted target; …)" | `daedalus` lists `hephaestus`; out, open, link, doctor clean |
| A target absent from `targets` refuses `-32006` before any append | "M2-A2 refusals before any append (M2-A3: the allowlist row): …" | cases "target absent …", "a prefix of an allowlisted id", "an allowlisted id is a prefix of it", "a caller's targets param never reaches the engine"; size, SHA-256, files and next seq unchanged; writer usable |
| An unknown seat id refuses `-32005` | same test, "unknown target seat" | not listed, still `-32005` (row 9a first) |
| A target that fails its schema or gate refuses `-32006` | same test, "unreadable target seat", "seat gate: …" (three cases, all listed) | the target's own `issues` |
| `enabled: true` with `targets: []` refuses `-32006` | same test (`ho-on` v1, `ho-v2-empty` v2); `handoff-gate.test.ts` "M2 §10.6 seat gate, retargeted …" | `thread/start` and handoff target load |
| A self-handoff behaves as §4 | the success test | `daedalus` (lists only `hephaestus`) and `prometheus` (handoffs disabled) each hand off to themselves |
| A v1 seat file still loads unchanged | `seat.test.ts` (unchanged), the gate test's v1 rows | v1 refusals keep their M0 issue text; `madc-default` (v1) loads across the suite |
| The `handoffs.targets` mutation kills the allowlist test | the refusals test | with `targets` not consulted, "target absent …" hands off and appends; the PR body records the run |

## 7. Sources read for this pin

On branch `hephaestus/m2-a3-handoff-allowlist` at Stage 1 (`4de9343`): `docs/plan/README.md`, `PLAN-madc-M2-build-plan.md`, `PIN-madc-M2-handoff-procedure.md`, `PIN-madc-M2-handoff-procedure-amendment-1.md`, `PIN-madc-M2-evidence-schema-v2.md` (§1, §2.1), `PIN-madc-M1-seat-format.md` (§2), `PIN-madc-M1-protocol-messages.md` (§4.1); `packages/engine/src/seat.ts`, `seat-store.ts`, `seats/roster.ts`, `server.ts` (`#threadHandoff`, seeding), `protocol/types.ts`, `protocol/ids.ts`, and the tests `seat.test.ts`, `handoff-gate.test.ts`, `handoff-procedure.test.ts`. No live web source was fetched.

*End of proposed M2 seat handoff allowlist pin.*
