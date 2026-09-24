# ADR-0002: Native protocol — Codex app-server thread/turn/item, ACP as an adapter

- **Status:** PROPOSED — pending Founder ruling
- **Date:** 2026-09-24
- **Sources:** [PLAN-madc-idea-plan-v2.md](../plan/PLAN-madc-idea-plan-v2.md) §6.1;
  [planning record](../plan/PLAN-MAD-AGENT-planning-record.md) Appendix R (amendment 11)
- **Amends:** planning-record ADR-07 (was ACP v1 + `mad/*`)

## Context

The engine runs as a local server. The CLI and the desktop app contain no
agent logic and connect over one protocol (plan §6.1). Codex's app server,
`opencode serve`, Hermes' single core and omp's "same engine, four wrappers"
all follow this shape.

## Decision (proposed)

- The engine's native client protocol is modeled on the Codex app server's
  **thread / turn / item** message shapes.
- **ACP (Agent Client Protocol)** is an adapter layer for editors, not the
  native core.

## Consequences

- One internal model. ACP is a translation layer, not a second code path.
- ADR-07 in the planning record changes from "ACP v1 + `mad/*`" to this.
