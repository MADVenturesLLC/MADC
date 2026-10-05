# madc M2 build plan — the room: multi-seat work + evidence schema v2

*Daedalus · 2026-10-04 · Venue: `MADVenturesLLC/MADC` only · Status: **draft**. It is not a merge authorization, it authorizes no act, and it does not start until the Founder accepts it (D-M2-1).*

*Base: `main` @ `1580a44be4dc21776f35f9755c2520397935aaa4` (the PR #51 merge). Every file, line count and SHA-256 below was read at that commit. The pins are cited by hash, not by memory.*

Roadmap: [`ROADMAP-madc-post-M0.md`](ROADMAP-madc-post-M0.md) (M2 row; §2 order, §4 mechanism rows, §5 not-in-scope). M1 plan for form: [`PLAN-madc-M1-build-plan.md`](PLAN-madc-M1-build-plan.md).

**Where M2 already is.** Three acts are merged and are the foundation this plan builds on. The roadmap's size estimate for M2 was 10 acts; 3 have landed as A0–A2, and this plan proposes 7 more (A3–A9), which closes the estimate.

| Act | Deliverable | PR | Merge commit | Date |
| --- | --- | --- | --- | --- |
| M2-A0 | `PIN-madc-M2-evidence-schema-v2.md` — the v2 vocabulary, proposed pin | #46 | `9701c2220703df09e51d7dc9356f73c9592fb34d` | 2026-10-02 |
| M2-A1 | First writer of a §2 event: `-32010`, `session-v2.ts`, the v2 writer, worktree identity at open/close | #47 | `ce10ca010ddd72c29513a117ba872168707b9046` | 2026-10-02 |
| M2-A1 FU | Argus findings on #47 and the Copilot threads | #48 | `87ac52be8781693751faf6ea1e5eb70deff94cc7` | 2026-10-04 |
| M2-A2 | `thread/handoff` — the evidence pin §2.1 order in-process | #49 | `cbc5c644e7c58412adaa635de40c320139726835` | 2026-10-04 |

**So the room has a schema, a writer and a two-way handoff — and no room.** There is no allowlist, so no handoff may legally complete ([Certain]: `handoffs.enabled` must be `false`, `packages/engine/src/seat.ts:254-255`, enforced). No target ever serves a brief. No worktree is created by any product code — `worktree.ts` resolves identity and nothing else ([Certain]: no `worktree add` call exists under `packages/`). No inbox exists. M2's goal sentence is therefore half-built: the evidence is real, the multi-seat work is not.

## 0. Bet in one sentence

Turn the pinned v2 evidence into **a room**: seats hand work to each other through an allowlist, each runs in its own isolated worktree, and the only thing that reaches the Founder is a typed decision carrying a recommended default and evidence refs.

## 1. Authority (binds the builder)

| Path | SHA-256 at the base | Role |
| --- | --- | --- |
| `docs/plan/ROADMAP-madc-post-M0.md` | `b2f61f463454060434a6a8a308e0f6da446c2d2da76a4df979c5d3e4c61a0a19` | Milestone order; §2 freezes schema v2 before M3; §4 M2 rows; §5 not-in-scope; §6 rulings D-R1–D-R6 |
| `docs/plan/PIN-madc-M2-evidence-schema-v2.md` | `75d6eb47b3d441bed7f58d23806795fd8ee06821370e2401689e6fdad0e53ffa` | The v2 vocabulary, §2–§5, the `-32010` refusal, D-M2-A0-1…6. Frozen for M2 work |
| `docs/plan/PIN-madc-M2-handoff-procedure.md` | `607d3269186da26d3e39bf11949ae50f8b3e9345c7bf3d9b3ae9527bc0f04034` | `thread/handoff`; §6 names what it deliberately did not do |
| `docs/plan/PIN-madc-M1-seat-format.md` | `5b802ce68fa93adf80c3cdbb1f8b668ef0965a16b13253516e26c40cd35c4660` | Seat schema v2, §4 chain and redaction. Frozen |
| `docs/plan/PIN-madc-M1-protocol-messages.md` | `6c6eb179e15c9f481e1185c27565ccc5876fbe734fe982ce532673d21b75e88f` | Methods, ids, error table. Frozen |
| `docs/plan/PIN-madc-M0-amendment-2-session-integrity.md`, `PIN-madc-M0-amendment-3.md` | frozen | Single writer, ownership/position re-check, fsync, rollback, poisoned writer, torn tail |
| `docs/plan/PLAN-madc-M1-build-plan.md` | `a0187f4eae66de01e65be6146a7823995c0f043803b7128fc3bf1899a19fe292` | Form, act shape, the same-lane rule (§6), §12 ruling format |
| `AGENTS.md`, `README.md` | repo conventions | Founder rulings D-FS-1, D-436, D-454, D-466; merge and credential rules |

Standing rules carried from M1: venue only `MADVenturesLLC/MADC`; merges are Founder-only and name the exact head SHA; no npm publish in M2; no vendored forks; keys never in git, config, prompts, logs or session records; every act follows `docs/policy/CODE-ADVISORIES.md`.

**Repo state text lags the record.** `AGENTS.md` on `main` describes M1 only ([Certain] at the base, line 14: "each M1 act still needs its own Founder commission and Founder merge"); it carries **no M2 state line at all** — not A0, not A1, not A2. Open PR #52 (`e004ad4acce38583e69bae917c5407b57813d3b7`, docs, `AGENTS.md | 6 +++---`) adds those three lines and is currently red on the Node 22.19 job. A3 should not land while the repo's own front matter still says the room does not exist.

## 2. Success criteria (M2 exit gate)

| ID | Criterion |
| --- | --- |
| **A** | A handoff completes end to end: a source thread appends `handoff.out`, a target opens with `session.open.handoff` citing it, the source appends `handoff.link`, and every check is legal because the target seat's `handoffs.targets` allowlist names the source. Editing any one link line fails both files. |
| **B** | The brief moves work. The target, once linked, serves a turn whose opening context is the brief; the target's chain records the turn and the `servedModel` receipt, and the source's chain is untouched by the target's turn. |
| **C** | Two seats work at once without touching each other's files: each seated thread has its own git worktree created by the engine under a confined root, its `session.open.worktree.head` equals that worktree's HEAD, and neither thread can write the other's tree. |
| **D** | The only thing that reaches the Founder is a typed decision. A `founderDecision` with an empty `evidenceRefs`, a malformed ref or a wrong same-file hash is refused `-32010` and nothing is appended. The inbox lists every open decision across threads, and never shows one as answered without a recorded resolution. |
| **E** | Chains survive the room. A three-seat handoff chain (A→B→C, roles swapped on a hand-back) verifies; doctor reports no handoff finding on any of the three files; a killed seat leaves the other threads' chains valid and their locks released. |
| **F** | Additive both ways, unchanged. A v1 file still verifies and rebuilds under the M2 engine; the M2 seat pin's `handoffs.enabled: true` is the only seat-gate relaxation and it is allowlist-scoped; the envelope stays `v: 1` and the hash formula is unchanged (D-M2-A0-6). |
| **G** | `madc room` and `madc doctor` report the room: every thread with its handoff state, worktree state and chain integrity, and the open decisions. Doctor exits non-zero on any FAIL. No payload text (a `brief`, a `question`) appears in any report, error or `detail`. |

## 3. Non-goals (M2)

- **Merge-back.** No worktree branch is merged into anything by the engine in M2. Isolation is the deliverable; integration is a later, separately authorized concern (D-M2-6).
- **Push, PR and GitHub.** No `git push`, no GitHub API, no review rounds. Those are the roadmap's Phase 6 concerns, and this repo's own §5 forbids changes outside `MADVenturesLLC/MADC`.
- Desktop, themes, `evidenceRef` widgets and Merkle checkpoints (M3).
- Memory store, `memory.write` and `tool.call` stay **reserved**; the M4 pin lifts them and nothing here does.
- MCP, the ACP server, per-seat tool policy beyond what M1 pinned.
- Any change to the same-lane fallback rule, the registry, the presence check or the four M1 pins.
- Parallel **turns on one thread**: one writer per file, always (Amendments 2 and 3).
- Quota prediction; account rotation.

## 4. Mechanism stolen + MAD evolution

| Steal from | Mechanism | MAD evolution (no clone) |
| --- | --- | --- |
| [git worktree](https://git-scm.com/docs/git-worktree); Claude Code subagents "its own context window … independent permissions"; Grok Build subagents and worktrees (roadmap §4 M2 rows) | Parallel workers with separate checkouts | Seats are **named, persistent and cross-vendor**. The engine creates each seated thread's worktree itself, under a confined root, and records its identity and HEAD in the chain at open and close — so "which tree did this turn write" is evidence, not a claim. |
| Codex app-server lifecycle (approvals and streamed events); Claude Code hook blocking semantics (roadmap §4 M2 rows) | Approvals as typed requests | The **decision inbox**: a seat may escalate exactly one shape — a `founderDecision` with a `question`, one `recommendedDefault` and at least one `evidenceRef`. Everything else must be resolved seat to seat or denied by policy. Nothing is silently dropped and nothing is silently answered. |
| MadBridge's chained ledger; RFC 6962 inclusion (roadmap §4 M3 row) | Append-only logs that pin each other | The two-way handoff link, already pinned and implemented in A2, extended across a chain: A→B→C is three files that each pin the next, and any edit is a mismatch from the *other* file. |

## 5. Package layout and blast radius

No new packages. Import rules from M0/M1 stand (`cli` imports protocol types and the client SDK only; `adapters` is the only importer of `@earendil-works/pi-ai`; `registry` stays pure and does no I/O).

| Package | M2 changes |
| --- | --- |
| `packages/engine` | `seat.ts` / `seat-store.ts` (allowlist consulted and validated), `server.ts` (`#threadHandoff` allowlist check; the target's turn path; the decisions read), `worktree.ts` (creation, ownership, confinement, cleanup posture), a new `decisions.ts` (inbox read), `inspect.ts` / `handoff.ts` (room-level findings), `protocol/*` (new methods and any new reason, under a new pin) |
| `packages/cli` | `madc room [--json]`, `madc decisions ls [--json]`, doctor's room table. Still no agent logic, still no key printing |
| `packages/core` | Shared types only if the room view needs them |
| Docs | New dated M2 pin files (seat allowlist, protocol additions), `docs/runbook/M2.md`, README index rows |
| Tests | New files beside the existing `evidence-v2.test.ts`, `handoff-gate.test.ts`, `handoff-procedure.test.ts`, `m2a1-followup.test.ts` |

## 6. Room rules (bind every act below)

1. **One writer per file.** Only the thread-lock holder appends, as today. A handoff touches two files through two locks, never a shared one (A2 pin §2).
2. **No turn starts inside a procedure.** `thread/handoff` opens the target and links it; the target's turn is a separate request, made by its own client (D-M2-3).
3. **Nothing is written on refusal.** For every refusal in this plan, file size, SHA-256 and `nextSeq` are unchanged and the writer stays usable.
4. **The seat gate moves once, and only as far as the allowlist.** A seat that names a target must name a real, loadable seat with a legal backing. An unknown, forbidden or unloadable target refuses `-32006` before any append.
5. **Isolation is by path confinement, not by convention.** A seat worktree lives under `$MADC_HOME/worktrees/<threadId>`. A path outside it is refused, not warned about.
6. **Never remove a dirty tree, never touch `main`.** The engine never runs `git worktree remove` on a tree whose status is not clean, and never checks out or merges `main`.
7. **Reserved stays reserved.** `memory.write` and `tool.call` are refused `-32010 reserved` until the M4 pin; a guard test fails if either enters the writable set.
8. **Evidence, not narration.** Every new claim a report makes is a line the reader can verify, and every report names seqs, ids and files — never payload text.

## 7. Acts for Hephaestus (M2-A3 … M2-A9)

Each act is its own PR based on current `main`. The Founder merges by exact head SHA. **Do not merge yourself.** Every PR follows `docs/policy/CODE-ADVISORIES.md`.

### M2-A3 — The handoff allowlist (seat pin; docs + one check)

- **Scope.** The A2 pin's §6 deferred the allowlist by name. This act lands a new dated **M2 seat pin file** that permits `handoffs.enabled: true` with a non-empty `handoffs.targets` list, and makes the engine consult it: `thread/handoff` refuses `-32006` unless the target seat is named in the source seat's `targets`, loads and passes its own gate. The M2-A1/A2 gate tests are retargeted to the new pin, in this act, as their own text requires.
- **Files.** new `docs/plan/PIN-madc-M2-seat-handoff-allowlist.md`; `packages/engine/src/seat.ts`, `seat-store.ts`, `server.ts`; `packages/engine/src/handoff-gate.test.ts` and `handoff-procedure.test.ts` (retarget only); README index row.
- **Acceptance.** An allowlisted target completes the two-way link; a target absent from `targets` refuses before any append with size and SHA-256 unchanged; an unknown seat id refuses `-32005`; a seat file with `enabled: true` and `targets: []` refuses `-32006`; a v1 seat file still loads unchanged. The `handoffs.targets` mutation kills the allowlist test.
- **Forbidden.** Changing any M1 or M2 pin in place; letting a caller's `targets` value reach the engine; a wildcard, prefix or case-folded target match.
- **Size.** 1. **Confidence.** High — the gate and the tests already exist; this is a pin plus one check.

### M2-A4 — The target serves the brief

- **Scope.** A linked target's next `turn/start` opens with the brief as its first context, once: the brief is read from the source's `handoff.out` (already hash-pinned) and is never re-delivered, never duplicated into the target's payload beyond the pinned `input`. The source's chain records nothing about the target's turn. **No turn starts inside any procedure** (rule 2). A target that has not been served reports its pending handoff to `thread/list` and doctor.
- **Files.** `packages/engine/src/server.ts`, `agent.ts`, `handoff.ts`, `session-v2.ts` (read helpers only), a new protocol method or a pinned `thread/start` field decision (see D-M2-3), tests in `handoff-gate.test.ts`.
- **Acceptance.** Target serves one mock turn; the brief appears once in the target's opening context and never in a later turn; the target's `servedModel` receipt names its own seat and lane; a turn started by the source does not deliver the brief; delivering twice is refused; the source file is byte-identical after the target's turn.
- **Forbidden.** A turn started by the engine, by a lock holder, or by a procedure; re-delivering a brief after a target restart without a recorded cause.
- **Size.** 2. **Confidence.** Med — the seam is clean because A2 already extracts the session-open path, but "served once" needs a recorded marker.

### M2-A5 — Parallel seats in isolated worktrees

- **Scope.** Worktree **creation** and ownership, the thing no product code does today ([Certain]). The engine creates `$MADC_HOME/worktrees/<threadId>` from the thread's `cwd` repo on open when the seat's new `worktree` field asks for it, records the top-level, normalized remote and HEAD in `session.open.worktree` (the shape is already pinned and already written), refuses a second live thread on the same worktree path, and re-reads HEAD at close (A1 already does). Doctor reports a thread whose recorded worktree no longer exists or has moved.
- **Files.** `packages/engine/src/worktree.ts` (creation, confinement, cleanup posture), `seat.ts` (the new field), `server.ts`, `inspect.ts`, tests; a new seat-pin file for the field (D-M2-2).
- **Acceptance.** Two seats on two threads get two distinct trees off one repo; neither sees the other's files; a second thread naming an occupied tree is refused before any append; a path outside the confined root is refused; a non-git `cwd` refuses worktree mode; the repo's primary working tree is never used as a seat worktree; a dirty tree is never removed, and the refusal names it; `session.close.worktree.head` equals the post-commit HEAD.
- **Forbidden.** `git worktree remove` on a dirty tree; deleting or pruning user branches; any operation on `main`; writing anywhere outside the confined root.
- **Size.** 2. **Confidence.** Med — the identity half is done and tested; creation and ownership are new and are where the stop conditions live.

### M2-A6 — The Founder decision inbox

- **Scope.** The write side exists (M2-A1). This act lands the read and resolve side: a pinned method that lists open decisions across threads with only the pinned fields, a pinned **resolution** shape (a new append — never an edit), and `madc decisions ls [--json]`. A decision with no evidence ref is refused at write and never shown; a decision is shown as answered only when its resolution line is present and verifies.
- **Files.** `packages/engine/src/decisions.ts` (new), `inspect.ts`, `protocol/types.ts` (method + param table), `packages/cli/src/app/*` (`decisions` verb), a new M2 protocol pin file, tests.
- **Acceptance.** A decision written by seat A appears in the inbox with its question, its recommended default and its refs; a decision whose refs are empty, malformed or hash-wrong is refused `-32010` and nothing is appended; a resolution appends a new line and the inbox then shows it closed; an unresolved decision is never shown closed; no payload text appears in `--json` beyond the pinned fields; the CLI still imports no loop, tools or adapters (import-rule test).
- **Forbidden.** Editing or deleting a decision line; answering a decision by any act other than a recorded resolution; an agent resolving a decision on the Founder's behalf.
- **Size.** 2. **Confidence.** Med — shapes are pinned; the read surface and the resolution event are new pin text.

### M2-A7 — Multi-hop chains and the isolation adversarial suite

- **Scope.** The room's own adversarial proofs, in the M13/M22 spirit: a three-seat chain A→B→C including one hand-back with roles swapped; a mid-chain kill; a poisoned writer on one thread while another serves; a target whose source is truncated after the link; two seats racing for one worktree path; a decision whose source thread is deleted from under it. Each probe asserts the refusal or the finding, with the negative control that the same probe on the healthy tree passes.
- **Files.** new `packages/engine/src/room-adversarial.test.ts` (or `test/` per repo convention), `handoff.ts` / `inspect.ts` for any finding the probes require.
- **Acceptance.** Every probe fails closed with its pinned code or finding; no probe leaves a lock held, a temp tree outside the confined root, or a broken writer; each probe's mutation kills exactly one assertion and no more; the suite runs in CI on Node 22.19 and Bun.
- **Forbidden.** Widening a refusal to make a probe pass; a probe that mutates the repository rather than a disposable tree.
- **Size.** 1. **Confidence.** Med-high — the failure vocabulary already exists in `SessionFindingCode`.

### M2-A8 — `madc room` and doctor v2

- **Scope.** One room-level view: `madc room [--json]` lists every thread with its seat, handoff state, worktree state, chain integrity and open decisions; `madc doctor` gains the room table and exits non-zero on any FAIL finding. No new authority: this act reads what A3–A7 recorded.
- **Files.** `packages/cli/src/app/*`, `packages/engine/src/inspect.ts` (room aggregation), `protocol/types.ts`, tests.
- **Acceptance.** `room --json` schema test; a room with a one-way handoff, a missing worktree, a malformed v2 line and an open decision reports each as its own row with its own level; doctor exits non-zero on each FAIL and zero with warnings only; no payload text anywhere in the output; the CLI import-rule test still passes.
- **Forbidden.** Agent logic in `cli`; a green row that no verifier checked; printing any credential value.
- **Size.** 1. **Confidence.** Med-high.

### M2-A9 — Conformance, runbook, freeze (M2 exit gate)

- **Scope.** CI conformance for the room (mock only); `docs/runbook/M2.md`: how to seed a room, run two seats in parallel, read a handoff chain, answer a decision, and what the recorded residual risks are; criteria A–G checked on a clean machine; a completion report in the PR body naming each act's merged SHA. Stops for the M2 review checkpoint.
- **Files.** CI config, `docs/runbook/M2.md`, README pointers, the completion report.
- **Acceptance.** Node 22.19 + Bun CI green; a fresh `$MADC_HOME` seeds, serves a two-seat handoff and shows the room on one machine in under the runbook's stated time; no paid call in CI.
- **Forbidden.** Paid keys in CI; starting M3; any other repo's diff.
- **Size.** 1. **Confidence.** Med-high.

**Suggested order.** A3 → A4 → A5 → A6 → A7 → A8 → A9. A3 and A5 are independent and may run in parallel; A4, A6 and A8 all read what A3/A5 wrote, so they follow. A7 last before the freeze.

## 8. Risks

| Risk | Mitigation |
| --- | --- |
| Isolation is claimed but the confinement is a convention | Rule 5 and A5's acceptance: a path outside `$MADC_HOME/worktrees/<threadId>` is refused, and A7 races two seats for one path. |
| A worktree is destroyed with uncommitted work in it | Rule 6 and A5: a dirty tree is never removed; the refusal names it. |
| The allowlist becomes a soft gate | A3: consulted by the engine, not the caller; the mutation test kills the check. |
| The inbox becomes noise (the Founder's own named risk, roadmap §2) | The pinned shape admits exactly one decision form and requires a recommended default and a ref; anything else must be resolved seat to seat. If the inbox fills anyway, that is a signal about the seats, not a schema change. |
| Brief delivery leaks or duplicates text | One delivery, pinned by a recorded marker; the brief is redacted on disk like every payload; the source file is asserted byte-identical after the target's turn. |
| Worktree creation makes the engine a git client with side effects | Creation only, confined root, no remote, no push, no `main`; A7 covers the failure shapes. |
| The `handoffs.enabled` relaxation weakens a shipped guard | The relaxation is scoped to an allowlist and the M2 seat pin gates it; M2-A1/A2's gate tests are retargeted in A3 in the open, never deleted. |
| Repo state text is already false while M2 builds | PR #52 fixes `AGENTS.md`; A3 should not land before that text is true, and any act here that changes a documented state updates it in the same PR. |

## 9. Proposed amendments (pin changes this plan needs, not edited here)

Surface Architect owns the pins. In M2 the pattern that worked for A0 and A2 holds: a **builder-drafted, Founder-merged** pin file, for Argus review, under the README edit rule. Numbering continues from the M1 set.

- **P-M2-1** A new seat pin (M2-A3) permitting `handoffs.enabled: true` with a non-empty `targets` allowlist, and stating exactly what the engine checks and refuses. `handoffs.targets` is a list of seat ids, exact match, no wildcard.
- **P-M2-2** A seat-pin field for worktree isolation (M2-A5): mode and the confined root; the posture that a dirty tree is never removed.
- **P-M2-3** A protocol addition (M2-A4, M2-A6, M2-A8): the brief-delivery decision (a pinned `thread/start` field or a new method), the decisions read method and the resolution shape, and any new error reason. `protocolVersion` currently reads `madc-m1/1` because A2's commission authorized one request and nothing else ([Certain], A2 pin §2) — this pin decides whether M2 bumps it and says why.
- **P-M2-4** Whether `thread/list` and `room` may report handoff and worktree state, and in what shape.

## 10. Verify bullets (Definition of Done)

- [ ] A handoff completes only through the allowlist; a target outside it refuses before any append.
- [ ] The brief is served once, to the target, and the source file is byte-identical afterward.
- [ ] Each seated thread has its own confined, engine-created worktree; HEAD is recorded at open and close; two seats never share one.
- [ ] A dirty worktree is never removed; the refusal names it.
- [ ] A decision with no evidence ref is refused; the inbox never shows an unrecorded resolution; no payload text leaves the engine.
- [ ] A three-seat chain verifies; an edit to any link is a mismatch from the other file.
- [ ] A v1 file verifies and rebuilds under the M2 engine; the envelope stays `v: 1`; the hash formula is unchanged.
- [ ] `memory.write` and `tool.call` are still reserved and refused.
- [ ] Every refusal leaves size, SHA-256 and `nextSeq` unchanged and the writer usable.
- [ ] `madc room`, `madc decisions ls` and doctor's room table pass their schema tests; doctor exits non-zero on any FAIL.
- [ ] Node 22.19 + Bun CI green; import rules hold; M2 runbook in-repo.
- [ ] Advisories per `CODE-ADVISORIES.md` on every act PR; no npm publish; no other-repo diff; no vendored fork.

## 11. Handoff notes for Hephaestus

1. Wait for the Founder to accept this plan (D-M2-1). A3 does not start before the `AGENTS.md` M2 state text is landed (PR #52 or its successor): `main` currently carries no M2 state line at all.
2. Base every PR on current `main`. Name the exact head SHA in every merge ask. Never merge.
3. Pin before code when an act changes a pin's subject: A3, A5, A4 and A6 each land their pin text and their code together, or the pin first, as the Founder's merge settles.
4. Quote the pins by SHA-256. If a pin's text and this plan disagree, the pin governs and the report says so.
5. Report completion to the Founder with branch and SHAs. Do not message other agents unless the Founder says so.
6. Never touch vendor login stores (`~/.claude`, `~/.codex`, `~/.grok`), never run a paid call in CI, never let a secret near a JSONL session.

## 12. FOUNDER_DECISION_REQUIRED

Nothing below is ruled. Each row is a proposal with a recommended default.

| # | Decision | Recommended default | Rationale |
| --- | --- | --- | --- |
| **D-M2-1** | Accept this plan as commissionable? | Plan stays **draft** until the Founder states acceptance explicitly. | The M1 precedent (D-M1-1): "accept defaults" was correctly read as *not* acceptance. |
| **D-M2-2** | Where does the worktree-isolation field live: a new seat-pin field, or an engine-only convention with no seat file change? | **A new seat-pin field.** | A confinement rule that no seat can state is not a rule; the pin is where the confined root is defined. |
| **D-M2-3** | How does a handoff deliver work: does the target's next `turn/start` carry the brief, or does the engine start a turn on the target? | **The target's next `turn/start` carries the brief once.** No engine-started turn. | It preserves A2's own rule that no turn starts inside a procedure, and it keeps every running agent a deliberate act. |
| **D-M2-4** | Worktree lifetime: leave every tree on close, or remove a clean one? | **Leave every tree.** A removal is a separate act with its own refusal rules. | Removing is the irreversible half; leaving costs disk, and disk is cheap next to lost work. |
| **D-M2-5** | Is the decision inbox a protocol method or a CLI-only read over existing chain state? | **A protocol method**, with `madc decisions ls` as one client of it. | M3 binds to the same schema next; a CLI-only read is a second source of truth. |
| **D-M2-6** | Does M2 include merging a worktree branch back? | **No.** Out of M2; a later, separately authorized act. | Isolation is the milestone's claim; merge-back is an integration authority this plan does not need to prove the room works. |
| **D-M2-7** | `protocolVersion`: stay `madc-m1/1` with additive methods, or bump for M2? | **Decide in P-M2-3, and prefer additive** unless a method's semantics change under an existing name. | The envelope precedent (D-M2-A0-6) is the same argument: additive buys compatibility and costs nothing a version string would enforce. |
| **D-M2-8** | Commission M2-A3…A9 as stacked PRs, one act each? | **Yes**; the Founder merges each SHA. | The M1 program ran this way and each act stayed reviewable. |

*End of the draft M2 build plan.*
