# madc M2 build plan — the room: multi-seat work + evidence schema v2

*Daedalus · 2026-10-04 · Venue: `MADVenturesLLC/MADC` only · Status: **accepted and commissionable** (Founder, 2026-10-05: "Accept the plan and the defaults"). It is not a merge authorization: each act still needs its own Founder commission and its own Founder merge at an exact head SHA.*

*Revised by Surface Architect after Argus review at `4915e5b` (2026-10-05): Argus findings H1–H3, M1–M7 and L1–L9, and the six Copilot threads on PR #53. Daedalus wrote the original draft; this revision edits the draft in place under the README edit rule and rules nothing.*

*Founder acceptance recorded 2026-10-05 (Founder): "Accept the plan and the defaults". This is the D-M2-1 acceptance itself, stated explicitly so it is not read as "accept defaults" alone. All nine D-M2 decisions are ruled as their recommended defaults (§12). D-M2-9's default is not a value: it requires the per-seat cap to be ruled before M2-A5 starts, so the cap's shape is still the Founder's to set. The plan merged as PR #53 at head `aa18875d76fda6ac9a28fbbb41ff5efd105b6b8b`, merge commit `2b44e6bb9d6ee281a4d5795f768c36806db93431`, at which point the file still read **draft**; this line is the acceptance, landed by a later docs-only PR under the README draft edit rule.*

*Base: `main` @ `1580a44be4dc21776f35f9755c2520397935aaa4` (the PR #51 merge). Every file, line count and SHA-256 below was read at that commit. The pins are cited by hash, not by memory. Revision base: `main` @ `a4b2ab36f3d4abbd677ceeb3303f8e105b148fcd` (the PR #52 merge). PR #52 changes `AGENTS.md` lines 4, 15 and 17 only, so every hash in §1 is unchanged at `a4b2ab3`.*

Roadmap: [`ROADMAP-madc-post-M0.md`](ROADMAP-madc-post-M0.md) (M2 row; §2 order, §4 mechanism rows, §5 not-in-scope). M1 plan for form: [`PLAN-madc-M1-build-plan.md`](PLAN-madc-M1-build-plan.md).

**Where M2 already is.** Three acts are merged and are the foundation this plan builds on. The roadmap's size estimate for M2 was 10 acts. A0–A2 are 3 of them, and this plan proposes 7 more (A3–A9), so 3 + 7 = 10. The table has four rows because the M2-A1 follow-up (#48) is a fix PR for M2-A1. It is not counted as an act.

| Act | Deliverable | PR | Merge commit | Date |
| --- | --- | --- | --- | --- |
| M2-A0 | `PIN-madc-M2-evidence-schema-v2.md` — the v2 vocabulary, proposed pin | #46 | `9701c2220703df09e51d7dc9356f73c9592fb34d` | 2026-10-02 |
| M2-A1 | First writer of a §2 event: `-32010`, `session-v2.ts`, the v2 writer, worktree identity at open/close | #47 | `ce10ca010ddd72c29513a117ba872168707b9046` | 2026-10-02 |
| M2-A1 FU (not an act) | Argus findings on #47 and the Copilot threads | #48 | `87ac52be8781693751faf6ea1e5eb70deff94cc7` | 2026-10-04 |
| M2-A2 | `thread/handoff` — the evidence pin §2.1 order in-process | #49 | `cbc5c644e7c58412adaa635de40c320139726835` | 2026-10-04 |

**So the room has a schema, a writer and a two-way handoff — and no room.** There is no allowlist, so no handoff may legally complete ([Certain]: `handoffs.enabled` must be `false`, `packages/engine/src/seat.ts:254-255`, enforced). No target ever serves a brief. No product code creates a worktree. `worktree.ts` resolves identity and nothing else ([Certain]: no non-test code under `packages/` runs `git worktree add`. The one call is a test fixture in `handoff-gate.test.ts`, which A2 pin §6 allows). No inbox exists, and no seat can raise a `founderDecision` ([Certain]: only the host-side `SessionWriter` writes one; `server.ts` and `protocol/types.ts` never mention it). M2's goal sentence is therefore half-built: the evidence is real, the multi-seat work is not.

## 0. Bet in one sentence

Turn the pinned v2 evidence into **a room**: seats hand work to each other through an allowlist, each runs in its own engine-created worktree, and the only thing that reaches the Founder is a typed decision carrying a recommended default and evidence refs.

## 1. Authority (binds the builder)

| Path | SHA-256 at the base | Role |
| --- | --- | --- |
| `docs/plan/ROADMAP-madc-post-M0.md` | `b2f61f463454060434a6a8a308e0f6da446c2d2da76a4df979c5d3e4c61a0a19` | Milestone order; §1 M2 top risks; §2 freezes schema v2 before M3; §3 terms flags; §4 M2 rows; §5 not-in-scope; §6 rulings D-R1–D-R6 |
| `docs/plan/PIN-madc-M2-evidence-schema-v2.md` | `75d6eb47b3d441bed7f58d23806795fd8ee06821370e2401689e6fdad0e53ffa` | The v2 vocabulary, §2–§5, the `-32010` refusal, D-M2-A0-1…6. Frozen for M2 work |
| `docs/plan/PIN-madc-M2-handoff-procedure.md` | `607d3269186da26d3e39bf11949ae50f8b3e9345c7bf3d9b3ae9527bc0f04034` (changes when handoff amendment 1 merges; see Carried M2 obligations) | `thread/handoff`; §6 names what it deliberately did not do |
| `docs/plan/PIN-madc-M1-seat-format.md` | `5b802ce68fa93adf80c3cdbb1f8b668ef0965a16b13253516e26c40cd35c4660` | Seat schema v2, §4 chain and redaction, §5 `policy.json` repo identity. Frozen |
| `docs/plan/PIN-madc-M1-protocol-messages.md` | `6c6eb179e15c9f481e1185c27565ccc5876fbe734fe982ce532673d21b75e88f` | Methods, ids, error table. Frozen |
| `docs/plan/PIN-madc-M0-amendment-2-session-integrity.md`, `PIN-madc-M0-amendment-3.md` | frozen | Single writer, ownership/position re-check, fsync, rollback, poisoned writer, torn tail |
| `docs/plan/PLAN-madc-M1-build-plan.md` | `a0187f4eae66de01e65be6146a7823995c0f043803b7128fc3bf1899a19fe292` | Form, act shape, the same-lane rule (§6), §12 ruling format |
| `AGENTS.md`, `README.md` | repo conventions | Founder ruling D-FS-1; merge and credential rules |
| The Founder's decision ledger (kept by Clio, outside this repo) | — | The D-### rulings cited under Carried M2 obligations (D-336, D-389, D-399, D-438, D-439, D-445). These ids appear in no file on `main` |

Standing rules carried from M1: venue only `MADVenturesLLC/MADC`; merges are Founder-only and name the exact head SHA; no npm publish in M2; no vendored forks; keys never in git, config, prompts, logs or session records; every act follows `docs/policy/CODE-ADVISORIES.md`.

**Repo state text lags the record.** `AGENTS.md` on `main` describes M1 only ([Certain] at `a4b2ab3`, line 14: "each M1 act still needs its own Founder commission and Founder merge"). It carries **no M2 state line at all**: not A0, not A1, not A2. PR #52 (merged as `a4b2ab3`) changed `AGENTS.md` lines 4, 15 and 17 only and added no M2 line, and no open PR adds one. So **A3's own PR adds the M2 A0–A2 state line to `AGENTS.md`**. That follows this plan's rule that any act which changes a documented state updates it in the same PR (§8).

## 2. Success criteria (M2 exit gate)

| ID | Criterion |
| --- | --- |
| **A** | A handoff completes end to end: a source thread appends `handoff.out`, a target opens with `session.open.handoff` citing it, the source appends `handoff.link`, and every check passes because the source seat's `handoffs.targets` allowlist names the target seat. Editing any one link line fails both files. |
| **B** | The brief moves work. The target, once linked, serves a turn whose opening context is the brief; the target's chain records the turn and the `servedModel` receipt, and the source's chain is untouched by the target's turn. |
| **C** | Two seats work at once without touching each other's files, **for seats that opt into worktree mode (A5)**. Each such thread, a handed-off target included, gets its own git worktree, created by the engine under a confined root. Its `session.open.worktree.head` equals that worktree's HEAD. The engine never opens two live threads on one tree, and it starts every turn on that thread (a vendor agent's process and working directory included) inside the thread's own tree. For vendor backings this is a **cwd-placement guarantee, not a write sandbox**: the engine cannot confine a vendor agent's own file tools, and no report claims it does. Whether worktree mode stays opt-in or becomes mandatory for room seats is open decision D-M2-2. |
| **D** | The only thing that reaches the Founder is a typed decision. A seat raises one only through the typed raise mechanism (A6). A raise with a typed field missing is refused, and there is no free-text fallback. A `founderDecision` with an empty `evidenceRefs`, a malformed ref or a wrong same-file hash is refused `-32010`, and nothing is appended. The inbox lists every open decision across threads and never shows one as answered without a recorded resolution. |
| **E** | Chains survive the room. A three-seat handoff chain (A→B→C, roles swapped on a hand-back) verifies; doctor reports no handoff finding on any of the three files; a killed seat leaves the other threads' chains valid and their locks released. |
| **F** | Additive both ways, unchanged. A v1 file still verifies and rebuilds under the M2 engine; the M2 seat pin's `handoffs.enabled: true` is the only seat-gate relaxation and it is allowlist-scoped; the envelope stays `v: 1` and the hash formula is unchanged (D-M2-A0-6). |
| **G** | `madc room` and `madc doctor` report the room: every thread with its handoff state, worktree state and chain integrity, and the open decisions. Doctor exits non-zero on any FAIL. No payload text (a `brief`, a `question`, a `recommendedDefault`) appears in any finding, error or `detail`. The inbox and room views may show the pinned `founderDecision` fields of a decision (`question`, `recommendedDefault`, `evidenceRefs`, with its ids and seq) and nothing else from a payload. |

## 3. Non-goals (M2)

- **Merge-back.** No worktree branch is merged into anything by the engine in M2. Isolation is the deliverable; integration is a later, separately authorized concern (D-M2-6).
- **Push, PR and GitHub.** No `git push`, no GitHub API, no review rounds. Those are the roadmap's Phase 6 concerns, and this repo's own §5 forbids changes outside `MADVenturesLLC/MADC`.
- **A write sandbox for vendor agents.** The engine places a vendor agent's working directory; it does not confine that agent's own file tools (criterion C).
- Desktop, themes, `evidenceRef` widgets and Merkle checkpoints (M3).
- Memory store, `memory.write` and `tool.call` stay **reserved**; the M4 pin lifts them and nothing here does.
- MCP, the ACP server, per-seat tool policy beyond what M1 pinned.
- Any change to the same-lane fallback rule, the registry, the presence check or the four M1 pins.
- Parallel **turns on one thread**: one writer per file, always (Amendments 2 and 3).
- Quota prediction; account rotation. (A per-seat rate cap for parallel Claude Code seats is not a non-goal. It is open decision D-M2-9.)

## 4. Mechanism stolen + MAD evolution

| Steal from | Mechanism | MAD evolution (no clone) |
| --- | --- | --- |
| [git worktree](https://git-scm.com/docs/git-worktree); Claude Code subagents "its own context window … independent permissions"; Grok Build subagents and worktrees (roadmap §4 M2 rows) | Parallel workers with separate checkouts | Seats are **named, persistent and cross-vendor**. The engine creates each worktree-mode thread's tree itself, under a confined root, and records the tree's identity and HEAD in the chain at open and close. So "which tree was this turn started in" is evidence, not a claim. |
| Codex app-server lifecycle (approvals and streamed events); Claude Code hook blocking semantics (roadmap §4 M2 rows) | Approvals as typed requests | The **decision inbox**: a seat may escalate exactly one shape — a `founderDecision` with a `question`, one `recommendedDefault` and at least one `evidenceRef` — through one typed raise. Everything else must be resolved seat to seat or denied by policy. Nothing is silently dropped and nothing is silently answered. |
| MadBridge's chained ledger; RFC 6962 inclusion (roadmap §4 M3 row) | Append-only logs that pin each other | The two-way handoff link, already pinned and implemented in A2, extended across a chain: A→B→C is three files that each pin the next, and any edit is a mismatch from the *other* file. |

## 5. Package layout and blast radius

No new packages. Import rules from M0/M1 stand (`cli` imports protocol types and the client SDK only; `adapters` is the only importer of `@earendil-works/pi-ai`; `registry` stays pure and does no I/O).

| Package | M2 changes |
| --- | --- |
| `packages/engine` | `seat.ts` / `seat-store.ts` (allowlist consulted and validated), `server.ts` (`#threadHandoff` allowlist check; the target's turn path; the decision raise; the decisions read), `session-v2.ts` (closed `founderDecision` / `EvidenceRef` key set, D-439), `worktree.ts` (creation, ownership, confinement, cleanup posture), a new `decisions.ts` (inbox read), `inspect.ts` / `handoff.ts` (room-level findings), `protocol/*` (new methods and any new reason, under a new pin) |
| `packages/adapters` | `provider-port.ts` (a `cwd` on `ProviderTurnRequest`, which has none today), `vendor/acp-client/client.ts` (spawn cwd and `session/new { cwd }` from the request, not `process.cwd()`), `claude-code.ts` and `codex.ts` (start the vendor agent in the request's `cwd`). A5 only |
| `packages/cli` | `madc room [--json]`, `madc decisions ls [--json]`, doctor's room table. Still no agent logic, still no key printing |
| `packages/core` | Shared types only if the room view needs them |
| Docs | New dated M2 pin files (seat allowlist, worktree field, protocol additions, handoff-procedure amendment), `AGENTS.md` M2 state line (A3), `docs/runbook/M2.md`, README index rows |
| Tests | New files beside the existing `evidence-v2.test.ts`, `handoff-gate.test.ts`, `handoff-procedure.test.ts`, `m2a1-followup.test.ts` |

## 6. Room rules (bind every act below)

1. **One writer per file.** Only the thread-lock holder appends, as today. A handoff touches two files through two locks, never a shared one (A2 pin §2).
2. **No turn starts inside a procedure.** `thread/handoff` opens the target and links it; the target's turn is a separate request, made by its own client (D-M2-3).
3. **Nothing is written on refusal.** For every refusal in this plan, file size, SHA-256 and `nextSeq` are unchanged and the writer stays usable.
4. **The seat gate moves once, and only as far as the allowlist.** A seat that names a target must name a real, loadable seat with a legal backing. Before any append, an unknown target seat refuses `-32005` (`SeatNotFound`). A target that is not on the source's allowlist, fails the seat schema or its gate, or does not load refuses `-32006` (`SeatInvalid`). These are the codes A2 pin §3 row 9 uses "as `thread/start`" and `protocol/errors.ts` defines.
5. **Worktree placement is by path confinement, not by convention.** A seat worktree lives under `$MADC_HOME/worktrees/<threadId>`. The engine refuses to create, open or record a seat worktree outside that root, and it starts every turn on a worktree-mode thread in that thread's tree, including a vendor agent's process. This is a cwd-placement guarantee. It is not a sandbox over a vendor agent's own file tools.
6. **Never remove a dirty tree, never touch `main`.** The engine never runs `git worktree remove` on a tree whose status is not clean, and never checks out or merges `main`.
7. **Reserved stays reserved.** `memory.write` and `tool.call` are refused `-32010 reserved` until the M4 pin; a guard test fails if either enters the writable set.
8. **Evidence, not narration.** Every new claim a report makes is a line the reader can verify. Every report names seqs, ids and files. Findings, errors and `detail` never carry payload text. The inbox and room views show only the pinned `founderDecision` fields (criterion G).

## 7. Acts for Hephaestus (M2-A3 … M2-A9)

Each act is its own PR based on current `main`. The Founder merges by exact head SHA. **Do not merge yourself.** Every PR follows `docs/policy/CODE-ADVISORIES.md`.

### Carried M2 obligations (before and beside the acts)

The Founder has already ruled on these items, or they are in flight. They bind the acts below. Listed in order:

1. **The turnId follow-up and handoff amendment 1. Must merge before A3.** The Founder said "turnId yes" (D-389): `handoff.out.turnId` must name a `turn.start` in the source file. Ruling A.2 (D-399) adds that step 1 row 2's refusal never echoes a raw `turnId`. The ledger still marks D-399 as awaiting the Founder's own-words confirmation. Both are approved but not implemented, because #49 merged first. Two pieces carry them: Surface's `PIN-madc-M2-handoff-procedure-amendment-1.md` and Hephaestus's code follow-up. Argus pre-checks cleared both locally, and neither is on GitHub yet. A3 edits the same `server.ts` `#threadHandoff` and `handoff-procedure.test.ts`, so A3 bases on them. Amendment 1 adds an `Amended by` pointer to the handoff pin, which changes that pin's SHA-256 in §1. The local amendment draft at `918b5eb` gives `fa430e41…`. §1 updates when amendment 1 merges, and the merged file's hash is the one that binds.
2. **D-439: close the `founderDecision` / `EvidenceRef` key set on the write side.** The ruling's order: a Surface pin row first, then the builder in the next M2 act. A6 carries it (P-M2-3).
3. **D-445: self-handoff is allowed** ("allow self-handoff as shipped; Surface states it in the next handoff amendment"). A3's seat pin states the allowlist consequence: a `thread/handoff` whose `targetSeatId` is the source's own seat stays allowed, and a seat does not need to list its own id in `handoffs.targets` for it, unless the Founder says otherwise. Surface states the ruling itself in the next handoff amendment.
4. **D-336 / D-438: the M2-A1 Failure behavior note.** The Founder did not waive it: "Surface writes a short M2-A1 Failure behavior note". It is open Surface docs debt. No note text exists yet, and none is drafted here. It is listed so the M2 record does not lose it.

### M2-A3 — The handoff allowlist (seat pin; docs + one check)

- **Prerequisite.** Carried obligation 1 has merged.
- **Scope.** The A2 pin's §6 deferred the allowlist by name. This act lands a new dated **M2 seat pin file** that permits `handoffs.enabled: true` with a non-empty `handoffs.targets` list, and makes the engine consult it. `thread/handoff` refuses unless three things hold: the target seat is named in the source seat's `targets`, it loads, and it passes its own gate. Refusal codes follow rule 4. The pin states D-445's consequence (carried obligation 3). The M2-A1/A2 gate tests are retargeted to the new pin, in this act, as their own text requires. The rewritten refusal order lists every existing A2 row (A2 pin §3) with the allowlist row in its place. **The same PR adds the M2 A0–A2 state line to `AGENTS.md`** (§1, §8). This act does not change A2 pin §4 step 3's target `cwd`; A5 owns that amendment.
- **Files.** new `docs/plan/PIN-madc-M2-seat-handoff-allowlist.md`; `packages/engine/src/seat.ts`, `seat-store.ts`, `server.ts`; `packages/engine/src/handoff-gate.test.ts` and `handoff-procedure.test.ts` (retarget only); `AGENTS.md` (the M2 state line); README index row.
- **Acceptance.** An allowlisted target completes the two-way link. A target absent from `targets` refuses `-32006` before any append, with size and SHA-256 unchanged. An unknown seat id refuses `-32005`. A target that fails its schema or gate refuses `-32006`. A seat file with `enabled: true` and `targets: []` refuses `-32006`. A self-handoff behaves as the pin states for D-445. A v1 seat file still loads unchanged. The `handoffs.targets` mutation kills the allowlist test. `AGENTS.md` names M2-A0, A1 and A2 as merged.
- **Forbidden.** Changing any M1 or M2 pin in place; letting a caller's `targets` value reach the engine; a wildcard, prefix or case-folded target match.
- **Size.** 1. **Confidence.** High — the gate and the tests already exist; this is a pin plus one check.

### M2-A4 — The target serves the brief

- **Scope.** A linked target's next `turn/start` opens with the brief as its first context, once (D-M2-3's recommended default). The brief is read from the source's `handoff.out`, where it is already hash-pinned. It is never re-delivered and never duplicated into the target's payload beyond the pinned `input`. The source's chain records nothing about the target's turn. **No turn starts inside any procedure** (rule 2). Doctor reports a target that has not been served. `thread/list` reports it only if P-M2-4 is ruled to allow it.
- **Files.** `packages/engine/src/server.ts`, `agent.ts`, `handoff.ts`, `session-v2.ts` (read helpers only), the `turn/start` brief-delivery rule and its recorded served marker under P-M2-3 (or the alternative D-M2-3 names, if the Founder rules it), tests in `handoff-gate.test.ts`.
- **Acceptance.** Target serves one mock turn; the brief appears once in the target's opening context and never in a later turn; the target's `servedModel` receipt names its own seat and lane; a turn started by the source does not deliver the brief; delivering twice is refused; the source file is byte-identical after the target's turn.
- **Forbidden.** A turn started by the engine, by a lock holder, or by a procedure; re-delivering a brief after a target restart without a recorded cause.
- **Size.** 2. **Confidence.** Med — the seam is clean because A2 already extracts the session-open path, but "served once" needs a recorded marker.

### M2-A5 — Parallel seats in engine-created worktrees

- **Scope.** Worktree **creation** and ownership, which no product code does today ([Certain]).
  - When the seat's new `worktree` field asks for it (opt-in; D-M2-2), the engine creates `$MADC_HOME/worktrees/<threadId>` on open, from the repo of the thread's `cwd`.
  - It records the top-level, normalized remote and HEAD in `session.open.worktree` (the shape is already pinned and already written). It refuses a second live thread on the same worktree path, and it re-reads HEAD at close, as A1 already does.
  - Doctor reports a thread whose recorded worktree no longer exists or has moved.
- **Vendor cwd placement.** `ProviderTurnRequest` gains a `cwd`. The vendor adapters start the agent and open its session in that `cwd`: today the ACP client uses the engine's `process.cwd()` (`client.ts:148-159`), and `claude-code.ts` spawns with no `cwd` option (`claude-code.ts:140-142`). Criterion C is a cwd-placement guarantee for these backings, not a write sandbox.
- **Handoff targets.** Under the frozen A2 pin §4 step 3, a target opens with "`cwd` equal to the source's", so a handed-off target would land in the source's tree. A5 owns a **handoff-procedure amendment** (P-M2-5): a new file plus an `Amended by` pointer. It takes the next amendment number free when A5 lands. Under it, a target seat in worktree mode gets its own new worktree at step 3, from the source's repo, instead of the source's `cwd`. The base pin is not edited in place.
- **Repo-gated lanes.** A path-pinned `repoAllow` entry matches only by exact equality of the realpath'd top-level (seat pin §5). It will not match `$MADC_HOME/worktrees/<threadId>`, so as written a repo-gated lane denies `repo-not-allowed` inside a seat worktree. The A5 pin states the intended behaviour, and a test covers it. This plan does not choose that behaviour.
- **Rate cap.** Whether parallel Claude Code seats carry a per-seat rate cap is open decision D-M2-9. A5 builds none until it is ruled.
- **Files.**
  - `packages/engine/src/worktree.ts` (creation, confinement, cleanup posture), `seat.ts` (the new field), `server.ts` (including the handoff target's open), `inspect.ts`.
  - `packages/adapters/src/provider-port.ts`, `vendor/acp-client/client.ts`, `claude-code.ts`, `codex.ts` (cwd).
  - Tests.
  - A new seat-pin file for the field (P-M2-2, D-M2-2), and the new handoff-procedure amendment file plus its pointer and README row (P-M2-5).
- **Acceptance.**
  - Two worktree-mode seats on two threads get two distinct trees off one repo. Neither tree contains the other's files.
  - A handed-off target in worktree mode opens in its own new tree, not the source's.
  - Each vendor adapter receives the thread's worktree as its `cwd`. A mock adapter asserts the `cwd` it was started in and the `session/new` `cwd`.
  - A second thread naming an occupied tree is refused before any append. A path outside the confined root is refused. A non-git `cwd` refuses worktree mode. The repo's primary working tree is never used as a seat worktree.
  - A dirty tree is never removed, and the refusal names it.
  - `session.close.worktree.head` equals the post-commit HEAD.
  - The `repoAllow` behaviour inside a seat worktree matches the A5 pin.
- **Forbidden.** `git worktree remove` on a dirty tree; deleting or pruning user branches; any operation on `main`; the engine writing anywhere outside the confined root; any report claiming a vendor agent's tools are sandboxed.
- **Size.** 2. **Confidence.** Med — the identity half is done and tested; creation, ownership and the adapter cwd are new and are where the stop conditions live.

### M2-A6 — The typed decision raise and the Founder decision inbox

- **Scope.** The host-side write exists: `SessionWriter` validates and appends a `founderDecision` (M2-A1). No seat can reach it ([Certain]). This act lands three things:
  1. **The seat-facing raise** that evidence pin §2.3 leaves to this plan to commission. A typed mechanism (P-M2-3 pins whether it is a typed method or a typed tool) writes a `founderDecision` with every required field: `decisionId`, `turnId`, `question`, one `recommendedDefault`, and at least one `evidenceRef`. A raise with a typed field missing or invalid is refused `-32010`. Mid-turn, the turn continues (evidence pin §5), and nothing is appended. **There is no fallback to "just ask"**, and the engine never derives a decision from agent text.
  2. **The closed key set** on the write side for `founderDecision` and `EvidenceRef` (D-439: a Surface pin row, then this act). An extra key is refused.
  3. **The read and resolve side.** A pinned method lists open decisions across threads, showing only the pinned fields (criterion G). A pinned **resolution** shape is a new append, never an edit. `madc decisions ls [--json]` is a client of the method. A decision with no evidence ref is refused at write and never shown. A decision shows as answered only when its resolution line is present and verifies.
- **Files.** `packages/engine/src/server.ts` (the raise), `session-v2.ts` (closed key set), `decisions.ts` (new), `inspect.ts`, `protocol/types.ts` (methods + param tables), `packages/cli/src/app/*` (`decisions` verb), a new M2 protocol pin file (P-M2-3), tests.
- **Acceptance.**
  - Seat A raises a decision through the typed raise. It appears in the inbox with its question, its recommended default and its refs.
  - A raise missing any typed field is refused `-32010`, and nothing is appended. A raise whose refs are empty, malformed or hash-wrong is refused `-32010`, and nothing is appended. An extra key on the decision or on a ref is refused.
  - No code path turns an `agentMessage` into a decision.
  - A resolution appends a new line, and the inbox then shows the decision closed. An unresolved decision is never shown closed.
  - No payload text appears in `--json` beyond the pinned fields.
  - The CLI still imports no loop, tools or adapters (import-rule test).
- **Forbidden.** Editing or deleting a decision line; a free-text escalation path; answering a decision by any act other than a recorded resolution; an agent resolving a decision on the Founder's behalf.
- **Size.** 2. **Confidence.** Med — shapes are pinned; the raise, the read surface and the resolution event are new pin text.

### M2-A7 — Multi-hop chains and the isolation adversarial suite

- **Scope.** The room's own adversarial proofs:
  - a three-seat chain A→B→C, including one hand-back with roles swapped;
  - a mid-chain kill;
  - a poisoned writer on one thread while another serves;
  - a target whose source is truncated after the link;
  - two seats racing for one worktree path;
  - a decision whose source thread is deleted from under it.

  Each probe asserts the refusal or the finding. Each has a negative control: the same probe on the healthy tree passes.
- **Files.** new `packages/engine/src/room-adversarial.test.ts` (or `test/` per repo convention), `handoff.ts` / `inspect.ts` for any finding the probes require.
- **Acceptance.** Every probe fails closed with its pinned code or finding; no probe leaves a lock held, a temp tree outside the confined root, or a broken writer; each probe's mutation kills exactly one assertion and no more; the suite runs in CI on Node 22.19 and Bun.
- **Forbidden.** Widening a refusal to make a probe pass; a probe that mutates the repository rather than a disposable tree.
- **Size.** 1. **Confidence.** Med-high — the failure vocabulary already exists in `SessionFindingCode`.

### M2-A8 — `madc room` and doctor v2

- **Scope.** One room-level view: `madc room [--json]` lists every thread with its seat, handoff state, worktree state, chain integrity and open decisions; `madc doctor` gains the room table and exits non-zero on any FAIL finding. No new authority: this act reads what A3–A7 recorded.
- **Files.** `packages/cli/src/app/*`, `packages/engine/src/inspect.ts` (room aggregation), `protocol/types.ts`, tests.
- **Acceptance.** `room --json` schema test; a room with a one-way handoff, a missing worktree, a malformed v2 line and an open decision reports each as its own row with its own level; doctor exits non-zero on each FAIL and zero with warnings only; no payload text in any finding, error or `detail`, and decisions show only their pinned fields; the CLI import-rule test still passes.
- **Forbidden.** Agent logic in `cli`; a green row that no verifier checked; printing any credential value.
- **Size.** 1. **Confidence.** Med-high.

### M2-A9 — Conformance, runbook, freeze (M2 exit gate)

- **Scope.** CI conformance for the room (mock only). `docs/runbook/M2.md` covers how to seed a room, run two seats in parallel, read a handoff chain and answer a decision, and what the recorded residual risks are (among them criterion C's cwd-placement limit and, if still open, D-M2-9). Criteria A–G are checked on a clean machine. A completion report in the PR body names each act's merged SHA. The act stops for the M2 review checkpoint.
- **Files.** CI config, `docs/runbook/M2.md`, README pointers, the completion report.
- **Acceptance.** Node 22.19 + Bun CI green; a fresh `$MADC_HOME` seeds, serves a two-seat handoff and shows the room on one machine in under the runbook's stated time; no paid call in CI.
- **Forbidden.** Paid keys in CI; starting M3; any other repo's diff.
- **Size.** 1. **Confidence.** Med-high.

**Suggested order.** Carried obligation 1 lands first. Then A3 → A4 → A5 → A6 → A7 → A8 → A9.
- **A3 and A5** are independent and may run in parallel. Both touch `server.ts` around `#threadHandoff`, so whichever merges second rebases.
- **A4** follows A3: it needs a legal link to serve.
- **A6** depends only on the A1 writer and its own pin, so it may run beside A3–A5.
- **A7** probes A3–A6, so it follows them.
- **A8** reads what A3–A7 recorded, so it follows them.
- **A9** is last: the freeze.

## 8. Risks

| Risk | Mitigation |
| --- | --- |
| Isolation is claimed but the confinement is a convention | Rule 5 and A5's acceptance: a path outside `$MADC_HOME/worktrees/<threadId>` is refused, vendor adapters are started in the thread's tree, and A7 races two seats for one path. |
| Worktree placement is read as a sandbox over vendor agents | Criterion C, rule 5 and §3 say it is cwd placement only; A5 forbids any report claiming otherwise; the A9 runbook records it as a residual risk. |
| A worktree is destroyed with uncommitted work in it | Rule 6 and A5: a dirty tree is never removed; the refusal names it. |
| The allowlist becomes a soft gate | A3: consulted by the engine, not the caller; the mutation test kills the check. |
| The inbox becomes noise (a top risk Daedalus named for M2 in roadmap §1, `:48`) | The pinned shape admits exactly one decision form, raised through one typed mechanism, and requires a recommended default and a ref; anything else must be resolved seat to seat. If the inbox fills anyway, that is a signal about the seats, not a schema change. |
| Parallel Claude Code seats burn subscription limits faster (roadmap §1 M2 top risks, `:48`; §3 terms flag, `:121`: "M2 parallel seats on Claude Code should be rate-capped per seat") | Open decision D-M2-9. No act invents a cap before the Founder rules; until then the A9 runbook records it as a residual risk. |
| Brief delivery leaks or duplicates text | One delivery, pinned by a recorded marker; the brief is redacted on disk like every payload; the source file is asserted byte-identical after the target's turn. |
| Worktree creation makes the engine a git client with side effects | Creation only, confined root, no remote, no push, no `main`; A7 covers the failure shapes. |
| The `handoffs.enabled` relaxation weakens a shipped guard | The relaxation is scoped to an allowlist and the M2 seat pin gates it; M2-A1/A2's gate tests are retargeted in A3 in the open, never deleted. |
| Repo state text is already false while M2 builds | `AGENTS.md` carries no M2 line (PR #52 added none). A3's own PR adds the M2 A0–A2 state line, and any act here that changes a documented state updates it in the same PR. |

## 9. Proposed amendments (pin changes this plan needs, not edited here)

Surface Architect owns the pins. In M2 the pattern that worked for A0 and A2 holds: a **builder-drafted, Founder-merged** pin file, for Argus review, under the README edit rule. Numbering continues from the M1 set.

- **P-M2-1** A new seat pin (M2-A3) permitting `handoffs.enabled: true` with a non-empty `targets` allowlist, and stating exactly what the engine checks and refuses (rule 4 codes). `handoffs.targets` is a list of seat ids, exact match, no wildcard. It states D-445's consequence for self-handoff.
- **P-M2-2** A seat-pin field for worktree mode (M2-A5): opt-in per seat unless D-M2-2 rules otherwise; the confined root; the posture that a dirty tree is never removed; the cwd-placement statement for vendor backings; the `repoAllow` behaviour inside a seat worktree.
- **P-M2-3** A protocol addition (M2-A4, M2-A6, M2-A8):
  - The brief-delivery rule per D-M2-3. The recommended default is that the target's next `turn/start` serves the brief once, under a recorded served marker.
  - The seat-facing typed raise of a `founderDecision`: a typed method or a typed tool, which this pin picks. It is refused when a typed field is missing, with no "just ask" fallback (evidence pin §2.3).
  - The closed `founderDecision` / `EvidenceRef` key set (D-439).
  - The decisions read method, the resolution shape, and any new error reason.
  - `protocolVersion` currently reads `madc-m1/1` because A2's commission authorized one request and nothing else ([Certain], A2 pin §2). This pin decides whether M2 bumps it and says why.
- **P-M2-4** Whether `thread/list` and `room` may report handoff and worktree state, and in what shape.
- **P-M2-5** A handoff-procedure amendment (M2-A5): target worktree creation at A2 pin §4 step 3. A target seat in worktree mode opens in its own new worktree from the source's repo, not in the source's `cwd`. It is a new file plus an `Amended by` pointer on the base pin, never an in-place edit.

## 10. Verify bullets (Definition of Done)

- [ ] A handoff completes only through the allowlist; a target outside it refuses before any append.
- [ ] `AGENTS.md` carries the M2 state line (landed with A3).
- [ ] The brief is served once, to the target, and the source file is byte-identical afterward.
- [ ] Each thread whose seat opts into worktree mode has its own confined, engine-created worktree, a handed-off target included. HEAD is recorded at open and close. Two seats never share one. Vendor agents start in the thread's tree. This is cwd placement, not a sandbox.
- [ ] A dirty worktree is never removed; the refusal names it.
- [ ] A seat raises a decision only through the typed raise, and a raise with a missing field is refused. A decision with no evidence ref is refused. The inbox never shows an unrecorded resolution. No payload text appears in findings, errors or `detail`, and the inbox shows only the pinned decision fields.
- [ ] A three-seat chain verifies; an edit to any link is a mismatch from the other file.
- [ ] A v1 file verifies and rebuilds under the M2 engine; the envelope stays `v: 1`; the hash formula is unchanged.
- [ ] `memory.write` and `tool.call` are still reserved and refused.
- [ ] Every refusal leaves size, SHA-256 and `nextSeq` unchanged and the writer usable.
- [ ] `madc room`, `madc decisions ls` and doctor's room table pass their schema tests; doctor exits non-zero on any FAIL.
- [ ] Node 22.19 + Bun CI green; import rules hold; M2 runbook in-repo.
- [ ] Advisories per `CODE-ADVISORIES.md` on every act PR; no npm publish; no other-repo diff; no vendored fork.

## 11. Handoff notes for Hephaestus

1. The Founder accepted this plan (D-M2-1, 2026-10-05). A3 does not start before carried obligation 1 (the turnId follow-up and handoff amendment 1) has merged. A3's own PR adds the M2 A0–A2 state line to `AGENTS.md`. `main` carries no M2 state line, and PR #52 added none.
2. Base every PR on current `main`. Name the exact head SHA in every merge ask. Never merge.
3. Pin before code when an act changes a pin's subject. A3, A4, A5 and A6 each land their pin text with their code, or the pin first, as the Founder's merge settles.
4. Quote the pins by SHA-256. If a pin's text and this plan disagree, the pin governs and the report says so.
5. Report completion to the Founder with branch and SHAs. Do not message other agents unless the Founder says so.
6. Never touch vendor login stores (`~/.claude`, `~/.codex`, `~/.grok`), never run a paid call in CI, never let a secret near a JSONL session.

## 12. FOUNDER_DECISION_REQUIRED

Ruled by the Founder on 2026-10-05: "Accept the plan and the defaults". D-M2-1 is recorded as acceptance of this plan as commissionable, not as "accept defaults" alone. D-M2-2 to D-M2-8 are recorded as their recommended defaults. D-M2-9 is recorded as its default, which is itself a requirement to rule the cap before M2-A5 starts: that ruling is still open.

| # | Decision | Recommended default | Rationale | Founder ruling (2026-10-05) |
| --- | --- | --- | --- | --- |
| **D-M2-1** | Accept this plan as commissionable? | Plan stays **draft** until the Founder states acceptance explicitly. | The M1 precedent (D-M1-1): "accept defaults" was correctly read as *not* acceptance. | **Accepted.** "Accept the plan and the defaults" (Founder, 2026-10-05). The plan is commissionable; each act still needs its own commission and its own merge. |
| **D-M2-2** | Worktree isolation: (a) where does the field live (a new seat-pin field, or an engine-only convention with no seat file change)? (b) is worktree mode mandatory for room seats, or opt-in per seat? | **(a) A new seat-pin field. (b) Opt-in per seat**, with criterion C scoped to opted-in seats. | A confinement rule that no seat can state is not a rule; the pin is where the confined root is defined. Opt-in keeps v1 seat files and non-git `cwd` seats loading unchanged; making it mandatory would turn a non-git `cwd` into a refusal for every room seat. | **Default accepted.** |
| **D-M2-3** | How does a handoff deliver work: does the target's next `turn/start` carry the brief, or does the engine start a turn on the target? | **The target's next `turn/start` carries the brief once.** No engine-started turn. | It preserves A2's own rule that no turn starts inside a procedure, and it keeps every running agent a deliberate act. | **Default accepted.** |
| **D-M2-4** | Worktree lifetime: leave every tree on close, or remove a clean one? | **Leave every tree.** A removal is a separate act with its own refusal rules. | Removing is the irreversible half; leaving costs disk, and disk is cheap next to lost work. | **Default accepted.** |
| **D-M2-5** | Is the decision inbox a protocol method or a CLI-only read over existing chain state? | **A protocol method**, with `madc decisions ls` as one client of it. | M3 binds to the same schema next; a CLI-only read is a second source of truth. | **Default accepted.** |
| **D-M2-6** | Does M2 include merging a worktree branch back? | **No.** Out of M2; a later, separately authorized act. | Isolation is the milestone's claim; merge-back is an integration authority this plan does not need to prove the room works. | **Default accepted.** |
| **D-M2-7** | `protocolVersion`: stay `madc-m1/1` with additive methods, or bump for M2? | **Decide in P-M2-3, and prefer additive** unless a method's semantics change under an existing name. | The envelope precedent (D-M2-A0-6) is the same argument: additive buys compatibility and costs nothing a version string would enforce. | **Default accepted.** |
| **D-M2-8** | Commission M2-A3…A9 as stacked PRs, one act each? | **Yes**; the Founder merges each SHA. | The M1 program ran this way and each act stayed reviewable. | **Default accepted.** |
| **D-M2-9** | Per-seat rate cap for parallel Claude Code seats: required in M2, and if so where is it stated and enforced? | **Rule it before A5 starts.** If yes, the seat pin carries a per-seat cap field (P-M2-2) and A5 enforces it; the cap's value and unit are the Founder's to set. | The roadmap flags it (`:121`, "should be rate-capped per seat"; `:48`, parallel vendor agents "burn subscription limits faster"), but the cap's shape is product design this plan does not invent. | **Default accepted: the cap must be ruled before A5 starts.** The value and unit are still the Founder's to set. |

*End of the draft M2 build plan.*
