# ADR-0003: Rules-aware provider registry

- **Status:** PROPOSED — pending Founder ruling
- **Date:** 2026-09-24
- **Sources:** [PLAN-madc-idea-plan-v2.md](../plan/PLAN-madc-idea-plan-v2.md) §6.2, §6.3, §9;
  [planning record](../plan/PLAN-MAD-AGENT-planning-record.md) Appendix R (amendment 13);
  [subscription-lanes-2026-09-24.md](../plan/subscription-lanes-2026-09-24.md)

## Context

The Founder pays for about ten AI subscriptions, and each has different rules
about which tools may use it. Using one the wrong way risks account
suspension.

## Decision (proposed)

Each subscription is a config entry, not code, and the registry can say no.
Each entry records (plan §6.3):

- an explicit **status**: `allowed-direct`, `allowed-via-vendor-agent`,
  `interactive-only` or `forbidden`, with the source quote;
- how it connects: a direct call, or driving a vendor agent;
- which formats it speaks: OpenAI-compatible, Anthropic-compatible or native;
- whether it is interactive only, or allowed in scripts and headless runs;
- the honest client identity it must send;
- quota and rate-limit signals, so the router can fall back instead of failing.

The router enforces these rules itself. A headless job never touches an
interactive-only plan, and Claude subscription traffic only ever goes through
real Claude Code.

**Forbidden paths** (plan §6.3):

- Z.ai GLM Coding Plan in a private harness.
- Antigravity / Gemini sign-in in third-party tools (use a Gemini API key).
- Claude subscription outside real Claude Code.
- ChatGPT tokens replayed in a custom client.

**Day one wires three** (M0): one direct-key provider (Ollama Cloud or Kimi
Code), the Claude Code seat and the Codex seat. The other seven stay as config.

## Consequences

- Terms change every few months; someone re-checks them monthly (plan §10, risk 4).
- Adding a subscription is a config change, not a code change.
- Time-sensitive facts to re-verify before writing (plan §10, risk 8): the Qwen
  DashScope-domain cutoff on 2026-09-30, Gemini's standard-key rejection, and
  the Z.ai GLM-5.3-Flash promo ending 2026-10-07.
