# madc M3 build plan — Desktop v1 on the same engine

*2026-11-23 · Venue: `MADVenturesLLC/MADC` only · Status: **accepted for M3-A0** (Founder, 2026-11-23: `"Yes, start M3-A0"`). Each act still needs its own Founder merge at an exact head SHA.*

*Base: `main` @ `39148d0` (M2-A9 merge commit, PR #69). Roadmap: [`ROADMAP-madc-post-M0.md`](ROADMAP-madc-post-M0.md) (§0 M3 row, §1 M3, §6 D-R6).*

## 0. Bet in one sentence

Build a **second window** onto the same local `@madc/engine` over a local socket transport: dark glass, big type, keyboard-first, showing seats side by side, live handoffs, the Founder Decision Inbox, and session search, where no widget turns green unless a verifier checked a hash, SHA, or served-model receipt behind it.

## 1. Non-goals (hard boundaries)

- Not an IDE or code editor (no file tree, no LSP, no terminal emulator).
- No agent loop, tools, or credentials inside the desktop shell; all agent/session/registry authority stays in `@madc/engine`.
- No "decorative green" or unverified status badges (every green indicator binds to a verified `hash`, `sha`, or `servedModel` receipt).
- No M4 scope (no `memory.write` store, no per-seat MCP server manager, no ACP server).
- No M5 scope (no npm publish, no code-signing/notarization pipeline).

## 2. Proposed Acts (M3-A0 through M3-A8, 9 acts)

| Act | Deliverable | Scope summary |
| --- | --- | --- |
| **M3-A0** | Protocol & local-socket transport pin | Additive protocol pin (`PIN-madc-M3-desktop-protocol.md`) for Unix domain socket / local IPC JSONL transport, `room/inspect` & `session/search` read methods, and real-time event subscription (`thread/turn/item/decision/handoff` deltas). |
| **M3-A1** | Engine local-socket listener & `session/search` | Implement the local socket server (`$MADC_HOME/engine.sock`, `0600` owner-only) beside stdio, `room/inspect`, and read-only `session/search` across verified chains (no payload secret leaks). |
| **M3-A2** | Desktop shell scaffold (`packages/desktop`) | Scaffold `packages/desktop` in the chosen stack (`D-R6`: Tauri v2 recommended), connect over `engine.sock` via `@madc/engine/client`-equivalent typed IPC, and verify cold-start + keyboard focus bar. |
| **M3-A3** | Visual system & evidence-bound primitives | Dark-glass design tokens, typography, keyboard command palette, and evidence-bound status pills (only green when backed by verified `hash`, `sha`, or `servedModel`). |
| **M3-A4** | Multi-seat side-by-side workspace | Live side-by-side seat panes, model/lane/worktree receipts (`servedModel`, `worktree.topLevel` + `head`), and interactive turn start / interrupt from the desktop window. |
| **M3-A5** | Live handoff chain view | Visual two-way handoff graph (`handoff.out` -> `session.open` -> `handoff.link`), brief-served state, and click-to-inspect cross-thread hash links. |
| **M3-A6** | Founder Decision Inbox view | Live inbox bound to `decision/list`, showing `question`, `recommendedDefault`, and clickable `evidenceRefs`, plus keyboard-driven `decision/resolve` confirmation flow. |
| **M3-A7** | Session search & replay inspector | Full-text search over verified session chains (`session/search`) and read-only turn-by-turn replay with hash-chain verification indicator. |
| **M3-A8** | M3 conformance, `docs/runbook/M3.md`, freeze | Mock-only desktop + socket integration suite in CI (Node 22.19 + Bun + desktop build check), operator runbook, and M3 exit gate. |

## 3. `FOUNDER_DECISION_REQUIRED` (before M3-A0 / M3-A2 start)

| # | Decision | Recommended default | Why it matters |
| --- | --- | --- | --- |
| **D-M3-1** | Accept this M3 build plan as commissionable? | **Draft** until Founder accepts explicitly. | Same governance rule as M1/M2. |
| **D-R6** | Desktop stack choice: **Tauri v2** (Rust shell + TypeScript/HTML webview) vs **GPUI** (pure Rust, pre-1.0) vs **Electron**? | **Tauri v2 (TypeScript UI + thin Rust shell)** | Reuses `@madc/core` / protocol types cleanly, avoids GPUI pre-1.0 churn (`ROADMAP` §1), and keeps bundle footprint small compared to Electron. |
| **D-M3-2** | Local socket transport: Unix domain socket (`$MADC_HOME/engine.sock`, `0600`) vs loopback TCP (`127.0.0.1` + bearer token)? | **Unix domain socket (`0600`) on POSIX** (named pipe on Windows). | OS file permissions (`0600` under `0700` `$MADC_HOME`) give same-user isolation with zero port-collision or token-in-URL surface. |
| **D-M3-3** | Can M3-A0 (pin) and M3-A1 (engine local socket + `session/search`) start immediately after `D-M3-1` even if `D-R6` is still being finalized? | **Yes** — socket transport is stack-independent. | Unblocks engine work immediately while desktop UI stack is confirmed. |
