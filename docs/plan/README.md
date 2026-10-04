# Plan documents

Planning documents behind madc. Edit rule, keyed to each file's status line:

- **Accepted or frozen** (Founder-accepted plans, build pins that gated a merged act, ADRs): never
  edited, except for one added `Amended by <file>` pointer line per amendment (not per file),
  directly under the status line.
- **Draft** (status says draft, proposed or not yet accepted): may be edited in place by a
  Founder-merged PR that says so in its body.
- **Amendments are new files** that name the base file. Verbatim research copies are never edited.
  Amendment 1's in-place edit of the protocol pin (PR #8) predates this rule and stands.

| File | Status in this repo |
| --- | --- |
| `PLAN-madc-idea-plan-v2.md` | Present (v2, corrected by Surface Architect, 2026-09-24) |
| `PLAN-MAD-AGENT-planning-record.md` | Present (plan-mode record plus Appendix R, a DRAFT Founder ruling) |
| `pi-check-2026-09-24.md` | Present (one-day technical check of `@earendil-works/pi-ai` and `pi-agent-core` 0.87.1) |
| `subscription-lanes-2026-09-24.md` | Present (per-subscription lanes A–D with primary-source quotes, retrieved 2026-09-24) |
| `PLAN-madc-M0-build-plan.md` | Present (Daedalus M0 commissionable build plan, 2026-09-24 — merged, PR #2, merge commit `9c71afd`) |
| `PIN-madc-M0-protocol-messages.md` | Present (Surface build pin, 2026-09-24: M0 stdio JSONL methods, Thread/Turn/Item, error codes; gates Act M0-A2; **superseded for M1 work** by `PIN-madc-M1-protocol-messages.md`, 2026-09-27 — the M0 pin stays frozen and is not edited) |
| `PIN-madc-M0-seat-format.md` | Present (Surface build pin, 2026-09-24: `madc-default` seat file, session JSONL hash chain; Act M0-A4; **superseded for M1 work** by `PIN-madc-M1-seat-format.md`, 2026-09-27 — the M0 pin stays frozen and is not edited) |
| `PIN-madc-M0-amendment-2-session-integrity.md` | Present (Surface M0 Amendment 2, 2026-09-25: single-writer append checks, fsync, torn-tail detection; additive) |
| `PIN-madc-M0-amendment-3.md` | Present (Surface M0 Amendment 3, 2026-09-25, additive; binding from Founder merge, status on the file's own status line: rollback durability and broken-writer recovery, crash-residue classification, writer guard (Founder decision on #17 note 6), seed `created:false` proof, `sessions/` 0300 unsupported) |
| `PIN-madc-M0-cli.md` | Present (Surface build pin, 2026-09-25: `madc doctor` + headless one-shot; gates Act M0-A7) |
| `PIN-madc-M0-cli-erratum-1.md` | Present (Surface erratum to the CLI pin, 2026-09-25: `locks` row start-time rule and orphan-name redaction, pointer placement, interpretations D-160..D-164 and D-168..D-174 for Founder confirmation; rev. 2026-09-26 adds §3a–§3f: one-shot close exit, engine-message/shape checks, turn idle deadline `MADC_TURN_IDLE_MS`, exit precedence, A7 failure-inventory pins and triage, engine-client fix under Founder allowance A1, F-78 carried by Founder decision) |
| `PIN-madc-M0-cli-erratum-1-E17a.md` | Present (Surface clarification E17a to CLI erratum 1 §3e E17, 2026-09-26, additive: `rejected` only for a well-formed `turn/start` error reply, N2/N4 replies stay pending; tests (6)-(10)) |
| `ROADMAP-madc-post-M0.md` | Present (Daedalus post-M0 roadmap M1–M5, 2026-09-24: order, 11-row subscription lane table re-verified 2026-09-24, innovation per milestone — proposed, not a build authorization; Founder rulings D-R1–D-R6 recorded 2026-09-25) |
| `PLAN-madc-M1-build-plan.md` | Present (Daedalus M1 commissionable build plan, 2026-09-24: every lane lit + named roster; acts M1-A0..A9; proposed pin amendments — draft until Founder accept; Founder rulings D-M1-1–D-M1-11 and the engine-owned repo-identity rule recorded 2026-09-25) |
| `PIN-madc-M1-protocol-messages.md` | Present (Surface build pin, 2026-09-27, M1-A0: `protocolVersion` `madc-m1/1`, widened `servedModel` receipt (`lane`, `mode`, `fallbackFrom`, `vendorReported`), `turn/start` mode claim + engine-side presence, `seat/list` / `provider/list` / `auth/*` (no `auth/set` over JSONL), new `-32007` / `-32008` reasons; supersedes `PIN-madc-M0-protocol-messages.md` for M1 work; carries M0 Amendment 1 forward unchanged; gates Hephaestus acts M1-A1+) |
| `PIN-madc-M1-seat-format.md` | Present (Surface build pin, 2026-09-27, M1-A0: seat schema v2 (`displayName`, `fallbacks`, same-lane rule), five-seat roster seeding, `policy.json` repo allowlists with engine-owned repo identity, JSONL payload additions (`mode`/`presence`, `fallback.rejected`, `repo.decision`), new-provider redaction; supersedes `PIN-madc-M0-seat-format.md` for M1 work; carries M0 Amendment 1 forward unchanged) |
| `sources/DESIGN-SPEC-witness-rev6.2.md` | Present (verbatim research copy of the supplied Iris design source "Witness with a per-turn chain rail", rev 6.2, SHA-256 `9b575b87…462fd`; the source self-describes as a proposal, **not a pin** — preserved, never edited) |
| `PIN-madc-M0-witness-rev6.2-amendment.md` | Present (**proposed, pending review** — builder-drafted 2026-09-28 from the preserved rev 6.2 source and the architect continuation plan; §12 reconciliation P-1…P-19 / E-a…E-e / PL-1…PL-4 / L-1–L-2 provenance, clause-to-code-to-test matrix, and the W-1/W-2/W-3 + audit fixes of the continuation act; not accepted, not merged, no approvals backfilled) |
| `PIN-madc-M2-evidence-schema-v2.md` | Present (**proposed, not a build authorization until the Founder merges it** — builder-drafted 2026-10-01 under the Founder's M2-A0 commission, base `c4f97fc`: schema v2 chain events on the unchanged `v: 1` envelope — two-way hash-linked handoffs (`handoff.out` / `handoff.link` / `handoff.aborted` + `session.open.handoff`), worktree identity (`HEAD`) at open and close, `founderDecision` with one recommended default and evidence refs, `EvidenceRef`, reserved M4 `memory.write` / `tool.call` receipts, proposed `-32010 EvidenceInvalid`, D-M2-A0-1…6 ruled by the Founder on 2026-10-01 as the recommended defaults (rev. 2026-10-01, same-PR correction); additive to the M1 session chain, no code, `handoffs.enabled` stays `false`; Argus reviews) |
| `PIN-madc-M2-handoff-procedure.md` | Present (**proposed until the Founder merges it**, builder-drafted 2026-10-03 under the Founder's M2-A2 commission, base `ce10ca0`: authorizes one request, `thread/handoff` `{ threadId, targetSeatId, brief, turnId }` → `{ handoffId, targetThreadId, targetGenesisHash }`, performing the evidence pin §2.1 order in-process: refusals before any append, `handoff.out` (H), the target `session.open` citing H through the `thread/start` session-open path, G read back, `handoff.link` (G), or `handoff.aborted` when the target open or read-back fails; no turn on the target, no worktree created, `handoffs.enabled` stays `false`, `handoffs.targets` not consulted, `protocolVersion` unchanged, no CLI subcommand; the evidence pin stays frozen; Argus reviews) |

The plan cites these files at `/workspace/briefs/...`; in this repo the path is `docs/plan/`.

## Related policy

| File | Status in this repo |
| --- | --- |
| [`../policy/CODE-ADVISORIES.md`](../policy/CODE-ADVISORIES.md) | Present (Copilot DoD; code scanning if enabled; Dependabot out of scope until enabled) |
