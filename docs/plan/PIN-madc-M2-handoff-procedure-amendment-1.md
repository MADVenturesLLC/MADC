# PIN (proposed): M2 handoff procedure, amendment 1: `handoff.out.turnId` names a `turn.start` in the source file, and step 1 row 2 never echoes a raw `turnId`

*Builder-drafted (Hephaestus) under the Founder's M2-A3 instrument, issued 2026-10-06, Stage 1 (carried M2 obligation 1) · 2026-10-06 · Venue: `MADVenturesLLC/MADC` · Status: **proposed until the Founder merges this PR**. Additive amendment to `PIN-madc-M2-handoff-procedure.md`: it changes step 1 row 2's `data` and adds step 1 row 8a, and nothing else. For Argus review.*

*Base: `main` @ `5b6ac4cdfce564c732301246f5dcb9e9c31b3b4e` (tree `f3beb3b0c861db4c4dde1b3eb129c6ed0eb1d6ea`). Every file cited below was read at that commit.*

**Provenance: the source draft is lost, and this text is new.** The M2 build plan (Carried M2 obligations §1) names a Surface draft of this file at local commit `918b5eb` (`fa430e41…`), pre-checked by Argus locally and never pushed. The M2-A3 instrument records that no local or remote branch carries it, and on 2026-10-06 it was not in this repository's object store (`git cat-file` does not resolve `918b5eb`), so its text was not available to this act. The builder wrote this file fresh from the plan's two statements quoted below. **It does not reproduce Surface's wording, and it is not the text Argus pre-checked.** The Founder is asked to confirm that the wording matches his rulings D-389 and D-399.

**The rulings, as the accepted plan records them** (`docs/plan/PLAN-madc-M2-build-plan.md` line 110, quoted verbatim; the decision ledger itself is outside this repo):

> The Founder said "turnId yes" (D-389): `handoff.out.turnId` must name a `turn.start` in the source file. Ruling A.2 (D-399) adds that step 1 row 2's refusal never echoes a raw `turnId`. The ledger still marks D-399 as awaiting the Founder's own-words confirmation.

**Authority:**

- `docs/plan/PIN-madc-M2-handoff-procedure.md` (M2-A2, PR #49), SHA-256 `607d3269186da26d3e39bf11949ae50f8b3e9345c7bf3d9b3ae9527bc0f04034` at the base. Amended here by a new file plus one `Amended by` pointer under its status line (README edit rule); no other line of it changes, so the pointer changes its SHA-256.
- `docs/plan/PIN-madc-M2-evidence-schema-v2.md`, SHA-256 `75d6eb47b3d441bed7f58d23806795fd8ee06821370e2401689e6fdad0e53ffa`. **Frozen; not edited.** §2.1 (`handoff.out.turnId`: "the source turn that raised the handoff; null when the operator raised it between turns"), §5 (the `-32010` `data` shape `{ threadId, turnId: string | null, type, reason, issues }`, and "`issues` … are not a contract").
- `docs/plan/PLAN-madc-M2-build-plan.md` (accepted 2026-10-05): Carried M2 obligations §1 (above), §7 M2-A3.
- The M2-A3 instrument (Founder ruling Route A): obligation 1 lands in A3's PR, ahead of the allowlist, as its own commit.

---

## 1. D-389: `handoff.out.turnId` must name a `turn.start` in the source file

A `thread/handoff` whose `turnId` is not `null` must name a `turnId` that a `turn.start` line of the **source** thread's own session file carries. Any earlier turn of that file counts (ended, interrupted, or the turn still running). A `turn.start` in any other file does not. `null` keeps its evidence pin meaning, "raised between turns", and is not checked against the file.

A `turnId` that names no such line is refused before any append, as a new step 1 row **8a**:

| # | Check | Code | `data` |
| --- | --- | --- | --- |
| 8a | `turnId` is not `null` and names no `turn.start` in the source file | `-32010 EvidenceInvalid` | `{ threadId, turnId: null, type: "handoff.out", reason: "field-invalid", issues }` |

Notes:

- **Why after row 8 and before row 9.** The check reads the source file, so it runs only once rows 3 to 7 have shown the source loaded on this connection, its lock held and its writer usable, and row 8 has shown the source can hand work on. It runs before the target seat is loaded (row 9), so a refused record never loads a seat.
- **Why "8a".** Rows 1 to 9 keep their numbers, so every citation of the A2 pin's rows (the M2 build plan, M2-A3) stays true.
- **What "in the source file" is.** The engine keeps the source's turns for the load it holds: rebuilt from the verified file at `thread/resume`, and extended only after a `turn.start` append is durable. That set is exactly the `turnId`s of the file's `turn.start` lines.
- Like every step 1 refusal: nothing is appended, the source file's size, SHA-256 and next seq are unchanged, no session file or lock is created, and the writer is not broken.

## 2. D-399: step 1 row 2's refusal never echoes a raw `turnId`

Row 2 (the `handoff.out` fields, `checkV2Payload("handoff.out", …)`) runs before any lock, seat or path use, so before the source is located. No `turnId` it sees has been shown to name a `turn.start` (§1): every `turnId` at row 2 is the caller's raw value. Row 2's refusal therefore carries:

| # | Check | Code | `data` |
| --- | --- | --- | --- |
| 2 | unchanged | `-32010 EvidenceInvalid` | `{ threadId, turnId: null, type: "handoff.out", reason, issues }` |

- `data` keeps the evidence pin §5 key set. `turnId` is present and is `null`, whatever the caller sent: well-formed, secret-shaped, or naming a real turn.
- `issues` name the field and never carry its value. That was already true of the writer's rule; it is now pinned for this row.
- Row 8a (§1) follows the same rule: its `data.turnId` is `null`.
- Refusals after row 8a are unchanged. There the `turnId` is `null` or names a `turn.start` in the source file, so it is no longer the caller's unverified value.

## 3. What this amendment does not change

The A2 pin's other rows (1, 3 to 9) and their order, §4 steps 2 to 5 (including step 3's target `cwd`, which M2-A5 owns), §5 doctor, §6 non-goals, §7 acceptance, the evidence pin, `protocolVersion`, and every other method. It does not state the D-445 self-handoff ruling; the M2-A3 seat pin states that ruling's allowlist consequence, and the plan leaves the statement of the ruling itself to a handoff amendment.

## 4. Acceptance

`packages/engine/src/handoff-procedure.test.ts`:

| Row | Test | Mutation killed |
| --- | --- | --- |
| D-389 (row 8a) | "M2 handoff amendment 1 (D-389): …": a well-formed `turnId` that no `turn.start` named, a `turn.start` of another thread, and the same before an unknown target seat are each refused `-32010 field-invalid` with nothing appended; a served `turnId` and `null` still hand off | drop the row 8a check (the test is RED against the pre-amendment engine: the handoff succeeds and appends) |
| D-399 (row 2) | "M2 handoff amendment 1 (D-399): …": a served, a secret-shaped, a plain and a malformed `turnId` are each refused at row 2 with `data.turnId: null`, and neither `data`, `issues` nor the response carries the value | echo the caller's well-formed `turnId` at row 2 (RED against the pre-amendment engine) |
| D-399 (row 2) | "M2-A2 refusals before any append: …", case "brief empty after trim": `turnId` is now `null` | the same |

## 5. Sources read for this amendment

All at `main` @ `5b6ac4cdfce564c732301246f5dcb9e9c31b3b4e`: `docs/plan/README.md`, `PLAN-madc-M2-build-plan.md`, `PIN-madc-M2-handoff-procedure.md`, `PIN-madc-M2-evidence-schema-v2.md` (§1, §2.1, §5); `packages/engine/src/server.ts` (`#threadHandoff`, `#loadColdThread`, `#beginTurn`), `session-store.ts` (`rebuildSession`, `SessionWriter`), `session-v2.ts` (`checkHandoffOut`, `turnIdOf`, `validateForWrite`), `protocol/errors.ts`, and `handoff-procedure.test.ts`. No live web source was fetched.

*End of proposed M2 handoff procedure amendment 1.*
