# madc

MAD's local-first agent platform: one engine, named seats, any subscription.

> **Status:** scaffold only. No engine code, no agent logic. The build does not
> start until the Founder says so after the Console MVP call
> ([plan §11.1](docs/plan/PLAN-madc-idea-plan-v2.md)). Every architecture
> decision below is **PROPOSED — pending Founder ruling**.

## The idea

From [the v2 idea plan, §1](docs/plan/PLAN-madc-idea-plan-v2.md):

> You own one engine that runs on your machine. It seats your named agents, and
> each agent can be backed by any of your ten subscriptions: either your own
> agent loop calling a model directly, or a vendor's agent (Claude Code or
> Codex) that your platform drives. A CLI and a desktop app are two windows onto
> that same engine, and every session leaves a record you can replay.

## v1 scope

**In v1** (plan §6, §10):

- **One engine, run as a local server.** It holds the agent loop, tools,
  sessions, memory and providers. Clients carry no agent logic.
- **The `madc` CLI**, the first window: interactive, headless one-shot
  (prompt in, JSON out, exit code), and session/provider/seat/doctor commands.
- **A rules-aware provider registry.** Each subscription is a config entry
  with an explicit status: `allowed-direct`, `allowed-via-vendor-agent`,
  `interactive-only` or `forbidden`.
- **Named seats**, the wedge: role, pinned model, memory, tools, policy, typed
  handoffs, and a hash-chained record of the served model per turn.
- **Day one wires three** (M0): one direct-key provider (Ollama Cloud or Kimi
  Code), the Claude Code seat, and the Codex seat. The other seven providers
  stay as config after M0.
- **The desktop app** is the second window, pushed until after the CLI proves
  itself (plan §10, risk 1).

**Out of v1** (plan §5, non-goals):

- Not Build Room: not a control plane, and no change to Build Room's frozen contracts.
- Not MadBridge: does not replace its policy or attestation role.
- Not an IDE or code editor.
- Not a clone: mechanisms only, no copied code or UI. Forking OpenCode or Hermes is rejected.
- No mobile app and no multi-user teams.
- No model training and no hosted cloud service.
- Never an access path a provider's terms forbid (plan §6.3).

## Gate sequence

Verbatim from [plan §13](docs/plan/PLAN-madc-idea-plan-v2.md):

1. **Priority** — decided (FounderOS first; build after Console MVP call).
2. **Corrected plan** — this file.
3. **Pi check** — done (`/workspace/briefs/pi-check-2026-09-24.md`); foundation recommended hybrid, pending Founder ruling.
4. **Founder ruling** — name, foundation, roster as wedge (paste-ready ruling lives in planning-record Appendix R).
5. **Daedalus build plan** — only on Mike's word after the Console MVP call.
6. **Hephaestus build** — per phase commission. A commit is not a merge; merges are Founder-only and name the exact head SHA.

## Decisions

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](docs/adr/ADR-0001-foundation.md) | Foundation: hybrid, pin `@earendil-works/pi-ai` behind MAD interfaces | PROPOSED — pending Founder ruling |
| [0002](docs/adr/ADR-0002-native-protocol.md) | Native protocol: Codex app-server thread/turn/item, ACP as an adapter | PROPOSED — pending Founder ruling |
| [0003](docs/adr/ADR-0003-provider-registry.md) | Rules-aware provider registry | PROPOSED — pending Founder ruling |

## Working in this repo

Requirements: Node **22.19+** and Bun **1.2+**.

```sh
npm install          # also installs the pre-push hook (core.hooksPath=.githooks)
npm run typecheck
npm run lint
npm run test:node    # node --test, native TypeScript type stripping
npm run test:bun     # bun test
npm run check        # all of the above; same as the pre-push hook
```

## Rules of the road

- `main` is protected. Every change goes through a pull request with passing CI.
- Merges are Founder-only and name the exact head SHA being merged.
- Keys, `.env` files and session records never go in git (see `.gitignore`).
  Provider keys belong in the OS keychain only (plan §10, risk 6).

## License

No license. All rights reserved, MAD Ventures LLC. A license decision is pending.
