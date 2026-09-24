# madc

MAD's local-first agent platform: one engine, named seats, any subscription.

> **Status:** build gate **OPEN** for madc. ADRs **0001–0003** are **ACCEPTED**.
> Scaffold / package skeleton only — no engine loop, protocol host, or adapters yet
> (those land in later M0 acts per [PLAN-madc-M0-build-plan.md](docs/plan/PLAN-madc-M0-build-plan.md)).

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
- **Day one wires three** (M0): one direct-key provider (Kimi Code, Founder D2),
  the Claude Code seat, and the Codex seat. The other seven providers
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

1. **Priority** — decided (madc build gate OPEN; Hephaestus commissioned for M0).
2. **Corrected plan** — [PLAN-madc-idea-plan-v2.md](docs/plan/PLAN-madc-idea-plan-v2.md).
3. **Pi check** — done (`docs/plan/pi-check-2026-09-24.md`); foundation hybrid.
4. **Founder ruling** — ADRs 0001–0003 **ACCEPTED**; M0 build plan on main.
5. **Daedalus build plan** — [PLAN-madc-M0-build-plan.md](docs/plan/PLAN-madc-M0-build-plan.md) on main.
6. **Hephaestus build** — Act M0-A0+ per phase commission. A commit is not a merge; merges are Founder-only and name the exact head SHA.

## Decisions

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](docs/adr/ADR-0001-foundation.md) | Foundation: hybrid, pin `@earendil-works/pi-ai` behind MAD interfaces | ACCEPTED |
| [0002](docs/adr/ADR-0002-native-protocol.md) | Native protocol: Codex app-server thread/turn/item, ACP as an adapter | ACCEPTED |
| [0003](docs/adr/ADR-0003-provider-registry.md) | Rules-aware provider registry | ACCEPTED |

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

After `npm install`, the `madc` bin (from `@madc/cli`) prints the version and exits 0.

## Rules of the road

- `main` is protected. Every change goes through a pull request with passing CI.
- Merges are Founder-only and name the exact head SHA being merged.
- Keys, `.env` files and session records never go in git (see `.gitignore`).
  Provider keys belong in the OS keychain only (plan §10, risk 6).

## License

No license. All rights reserved, MAD Ventures LLC. A license decision is pending.
