# ADR-0001: Foundation — hybrid, pin `@earendil-works/pi-ai` behind MAD interfaces

- **Status:** PROPOSED — pending Founder ruling
- **Date:** 2026-09-24
- **Sources:** [PLAN-madc-idea-plan-v2.md](../plan/PLAN-madc-idea-plan-v2.md) §11.2, §12.2;
  [planning record](../plan/PLAN-MAD-AGENT-planning-record.md) Appendix R (ruling 1, amendment 10);
  `pi-check-2026-09-24.md` (not yet in this repo)
- **Relates to:** planning-record ADR-01 (omp), ruled HYBRID

## Context

An agent loop is easy to start and slow to make reliable (plan §10, risk 7), so
the plan says to pick a foundation instead of writing everything from scratch.
ADR-01 is already ruled HYBRID: a clean MAD core with omp-compatible
catalog-shape and session-import seams, and no omp code vendored.

The one-day Pi check tested `@earendil-works/pi-ai` and
`@earendil-works/pi-agent-core` 0.87.1. Its verdicts (plan §12.2):

| Check | Verdict |
| --- | --- |
| Provider coverage | PASS |
| Permission gate | PARTIAL: the `beforeToolCall` deny hook blocked execution; no sandbox |
| Served model id | PASS (`responseModel`) |
| Bun + Node | PASS; engine floor Node 22.19+ |
| Release pace | PARTIAL: about 23 npm publishes in 3 months, still 0.x |

omp's SDK is Bun-only, so it is a poor fit for a dual-runtime engine.

## Decision (proposed)

- Pin `pi-ai` to an exact version behind MAD provider interfaces. Only the
  adapter imports it.
- MAD owns the loop, seats, policy, hash-chained sessions, MCP and subagents.
- Keep the omp-compatible model-list and session-import seams from ADR-01.
- Forking OpenCode or Hermes stays rejected.

## Consequences

- A 0.x dependency with a fast release pace: each upgrade is its own PR.
- The permission gate is only PARTIAL, so sandboxing stays MAD's job.
- Replacing the provider layer later means replacing one adapter.
