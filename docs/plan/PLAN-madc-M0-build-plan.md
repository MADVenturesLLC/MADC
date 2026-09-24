# madc M0 build plan

*Daedalus · 2026-09-24 · Venue: `MADVenturesLLC/MADC` only · Status: commissionable build plan for Hephaestus — **not** a merge authorization*

## 0. Bet in one sentence

Ship a **vertical M0 slice** of madc: a local engine speaking a minimal Codex-shaped **thread / turn / item** protocol, a thin `madc` CLI with no agent logic, a rules-aware provider registry that can say no, three live backings (one direct-key + Claude Code seat + Codex seat), and ≥1 named seat that writes a hash-chained session record — all on the Node 22.19 + Bun matrix, with a short in-repo runbook.

## 1. Authority and Founder rulings (bind the builder)

After PR #1 merge (`63472f736bb6` on `main` via merge commit `84874b2a870e`), authority on this venue is:

| Path | Role |
| --- | --- |
| `docs/plan/PLAN-madc-idea-plan-v2.md` | Product idea + M0 day-one wiring |
| `docs/plan/PLAN-MAD-AGENT-planning-record.md` | Research ledgers + Appendix R |
| `docs/plan/pi-check-2026-09-24.md` | Foundation evidence (`pi-ai` hybrid) |
| `docs/plan/subscription-lanes-2026-09-24.md` | Lane A/B/C + forbidden paths |
| `docs/adr/ADR-0001-foundation.md` | Hybrid: pin `@earendil-works/pi-ai` behind MAD interfaces |
| `docs/adr/ADR-0002-native-protocol.md` | Native = Codex thread/turn/item; ACP = adapter only |
| `docs/adr/ADR-0003-provider-registry.md` | Rules-aware registry; router never takes forbidden path |

**Founder rulings that supersede scaffold README “PROPOSED” language for this commission:**

1. Build gate **OPEN** for madc (prior FounderOS/Console-first hold lifted for madc).
2. ADR-0001 **ACCEPTED** — hybrid TS MAD core on Bun + Node 22.19+; pin `@earendil-works/pi-ai` behind MAD interfaces; no omp vendored; omp-compatible seams only.
3. ADR-0002 **ACCEPTED** — Codex app-server thread/turn/item is native; ACP is adapter only.
4. ADR-0003 **ACCEPTED** — rules-aware provider registry; router never takes a forbidden path.
5. Named seats first-class (role, pinned model, memory, tools/policy, typed handoffs, hash-chained served-model record).
6. Windows: CLI-first `madc`; desktop later; not an IDE.
7. Venue **only** `MADVenturesLLC/MADC`. No edits to founder-os-build-room, madventures-tui, FounderOS, or other repos.
8. Innovation bar: steal mechanisms; no clones; no vendored forks of OpenCode / Hermes / omp.
9. Merges Founder-only; name exact head SHA for any merge request.
10. npm `0.0.0` name-reserve for `madc` is **PARKED** — no npm tokens, no publish.

**Docs hygiene for Hephaestus (small, first commit OK):** bump ADR-0001..0003 status lines from “PROPOSED — pending Founder ruling” to **ACCEPTED** (cite this plan + Founder commission date 2026-09-24). Do not rewrite ADR bodies beyond status + a one-line “Accepted by Founder” note. Update README gate/ADR table to match. Do not invent new ADRs in M0.

## 2. M0 success criteria (must all pass)

Copied from Founder commission; this plan’s exit gate:

| ID | Criterion |
| --- | --- |
| **A** | Local engine (server) with minimal native Codex-shaped protocol (thread / turn / item). |
| **B** | Thin `madc` CLI: at least `madc doctor` + interactive chat **or** headless one-shot; **no** agent logic in CLI. |
| **C** | Provider registry with real enforcement; wire **exactly three**: (1) one direct-key provider — **Kimi Code** (justified below); (2) Claude Code seat via **unmodified** vendor agent adapter; (3) Codex seat via Codex app-server. Other seven subscriptions = registry stubs (including forbidden entries from subscription-lanes). |
| **D** | ≥1 named seat E2E with session record written. |
| **E** | Keep Node 22.19 + Bun matrix green; tests for registry forbid/allow + M0 happy path. |
| **F** | Short M0 runbook in-repo (`docs/runbook/M0.md` or `docs/plan/RUNBOOK-madc-M0.md`). |

## 3. Out of M0 (hard non-goals)

- Desktop app / Tauri / Electron.
- Full ten-provider live wiring (stubs only for the seven).
- Build Room, MadBridge, FounderOS control-plane changes.
- IDE / ACP polish beyond a **stub seam** (types + “not implemented” surface).
- npm publish / crates.io / binary distribution.
- Anything outside `MADVenturesLLC/MADC`.
- Vendoring or forking OpenCode, Hermes, omp, Claude Code, or Codex sources.
- Replay of ChatGPT tokens in a custom HTTP client; Claude subscription outside real Claude Code; Z.ai GLM Coding Plan in a private harness; Antigravity / Gemini sign-in in third-party tools.

## 4. Mechanism stolen + MAD evolution

| Steal from | Mechanism | MAD evolution (do not clone) |
| --- | --- | --- |
| Codex app-server | thread → turn → item lifecycle; JSON-RPC over stdio/WS; long-lived server + thin clients | MAD engine owns this shape **natively**; clients (`madc` CLI later desktop) carry zero agent logic. Do not copy Codex UI or Rust crate code. |
| omp / Pi “same engine, four wrappers” | one core, many windows | MAD engine + CLI now; desktop later. omp-compatible **catalog-shape + session-import seams** only — no omp code. |
| `@earendil-works/pi-ai` | multi-provider stream, headers, `responseModel` | Pin exact version behind MAD `ProviderPort`. MAD owns loop, seats, policy, hash-chain, MCP, subagents (MCP/subagents **stub or defer** past M0 loop minimum). |
| Ghostex-style multi-agent | side-by-side vendor agents | Agent adapters (Claude Code, Codex) as **workers** the engine drives; named seats choose backing. |
| MadBridge ledger idea | hash-chained append-only record | Session / served-model receipts as MAD-owned append-only JSONL (or SQLite) with hash chain — mechanism steal, not dependency on madventures-tui. |
| Subscription lanes brief | status as data | Registry entries with `allowed-direct` / `allowed-via-vendor-agent` / `interactive-only` / `forbidden` + source quote; router fail-closed. |

**Innovation bar for M0:** the non-commodity parts are (1) registry that can refuse, (2) named seat with hash-chained served-model record across both MAD-loop and vendor-agent backings. Commodity loop/tools get minimum viable; do not gold-plate TUI chrome.

## 5. Direct-key pick: **Kimi Code** (not Ollama Cloud)

**Recommendation: wire Kimi Code as the M0 direct-key provider.**

| Factor | Kimi Code | Ollama Cloud |
| --- | --- | --- |
| Lane | **A** VERIFIED — docs issue keys for 3P tools (subscription-lanes §1) | Hosted API with Bearer key; 3P client posture weaker / terms silent on custom clients (OLL ledger) |
| pi-ai fit | First-class `kimi-coding` catalog id; Anthropic-compatible; custom headers / honest UA proven in pi-check | Not built-in; `createProvider` OpenAI-compat custom path |
| Constraint | Must send **honest client identity** (no UA spoof) | Hosted ids from `/api/tags`; no account-scoped listing |
| Headless | No primary “interactive-only” clause found | Fine for scripts |

**Ollama Cloud** lands as a **registry stub** (`allowed-direct`, unwired) after M0, ready for M0.5/M1. Do not block M0 on Ollama Cloud auth or catalog discovery.

**Founder override:** if Founder prefers Ollama Cloud for day-one live traffic, swap Act M0-A3 target only; registry shape stays the same.

## 6. Package layout (evolve scaffold)

Current scaffold: workspace root + `packages/core` placeholder (`MADC_VERSION`).

**Target M0 packages** (all under `packages/*`, TypeScript, dual-runtime):

```
packages/
  engine/          # local server: loop, seats, sessions, protocol host
  cli/             # madc binary — thin client only
  registry/        # provider config + enforcement (pure; no I/O secrets)
  adapters/        # model + agent adapters (pi-ai pin lives here only)
  core/            # shared types, result types, version — keep thin
```

**Import rules (fail CI if violated):**

- `cli` → may import `engine` client SDK / protocol types only; **must not** import loop, tools, or adapters.
- `engine` → may import `registry`, `adapters`, `core`.
- `adapters` → only package that depends on `@earendil-works/pi-ai` (exact pin).
- `registry` → pure data + pure functions; no network; no keychain.
- No package imports omp, OpenCode, Hermes, or vendored vendor CLIs as libraries.

**Binary:** `madc` via `packages/cli` bin field (local `npm link` / `bun link` for runbook; **no publish**).

**Pin:** `@earendil-works/pi-ai@0.87.1` (or newer exact patch Founder/Hephaestus re-verifies against pi-check matrix). Upgrade = own PR.

## 7. Protocol sketch (native, minimal)

Align names with Codex app-server vocabulary (ADR-0002). M0 implements a **subset** sufficient for CLI chat / one-shot:

| Concept | M0 minimum |
| --- | --- |
| **Thread** | Create / resume / list (local ids); durable container for turns |
| **Turn** | Start with user input; stream items; complete / fail / abort |
| **Item** | Typed: `userMessage`, `agentMessage`, `toolCall`, `toolResult`, `error`, `servedModel` (receipt). Lifecycle: started → optional deltas → completed |
| Transport | Local JSON-RPC (stdio **or** localhost HTTP/WS — pick one in Act M0-A2; prefer **stdio JSON-RPC** for CLI simplicity, HTTP optional later) |
| ACP | Stub module exporting types + `NotImplemented` — no editor integration |

Engine process owns threads. CLI is a protocol client.

## 8. Registry model (M0)

Each subscription entry:

```ts
type ProviderStatus =
  | "allowed-direct"
  | "allowed-via-vendor-agent"
  | "interactive-only"
  | "forbidden";

type ProviderEntry = {
  id: string;
  status: ProviderStatus;
  sourceQuote: string;       // required
  sourceUrl: string;
  connect: "direct" | "vendor-agent" | "none";
  wire?: "openai-compat" | "anthropic-compat" | "native" | "vendor-cli";
  clientIdentity?: "honest-ua-required" | "default";
  wired: boolean;            // true only for the three M0 live paths
};
```

**M0 live (`wired: true`):**

1. `kimi-code` — `allowed-direct`, anthropic-compat, honest UA, MAD loop via pi-ai.
2. `claude-code` — `allowed-via-vendor-agent`, unmodified Claude Code subprocess/adapter.
3. `codex` — `allowed-via-vendor-agent`, Codex app-server.

**M0 stubs (`wired: false`, still enforced):** include at least forbidden / interactive-only from briefs, e.g.:

- `zai-glm-coding-plan` → `forbidden` (custom harness)
- `gemini-antigravity-signin` → `forbidden` (use API key path later as separate entry)
- `chatgpt-token-replay` → `forbidden`
- `claude-subscription-http` → `forbidden` (must use vendor agent)
- `minimax-token-plan` / `alibaba-coding-plan` → `interactive-only`
- `ollama-cloud`, `mistral-pro`, `deepseek-payg`, … → `allowed-direct` stubs

Router: before any call, resolve seat backing → registry.deny if forbidden / interactive-only on headless / unwired when caller demands live. **Fail closed.** Tests must prove forbid + allow.

## 9. Named seat + session record (M0 minimum)

One built-in seat is enough for E2E (e.g. `prometheus` or `madc-default`):

- `id`, `role`, `standingInstructions`
- `pinnedModel` (catalog id)
- `preferredBacking`: `kimi-code` | `claude-code` | `codex`
- `memory`: append-only notes file or in-session only (full memory store can be thin)
- `tools` / `policy`: deny-list minimum (`beforeToolCall`-style gate owned by MAD)
- `handoffs`: type stub only in M0 (no multi-seat orchestration required)
- **Session record:** append-only events with `prevHash` / `hash`; each model turn records `requestedModel` + `servedModel` (`responseModel` from pi-ai or vendor adapter equivalent)

Verify: after one interactive or one-shot turn, a record file exists and `madc`-level doctor or a test can verify the hash chain.

## 10. Phased acts for Hephaestus

Each act: own PR preferred (or stacked PRs); Founder merges by SHA. **Do not merge yourself.**

### Act M0-A0 — Docs hygiene + package skeleton

- **Blast radius:** `README.md`, `docs/adr/ADR-0001..0003` status, `packages/{engine,cli,registry,adapters}` scaffolds, workspace `package.json`.
- **Build:** ADR ACCEPTED stamps; empty packages with exports; `madc` bin stub printing version; CI still green.
- **Accept:** `npm run check` green on Node 22.19 + Bun; ADR status matches Founder rulings.
- **Forbidden:** publishing; touching other repos; implementing loop yet.

### Act M0-A1 — Registry enforcement

- **Blast radius:** `packages/registry` + tests.
- **Build:** full M0 entry set (3 wired flags + stubs); `assertAllowed(intent)` pure API; headless vs interactive mode flag.
- **Accept:** unit tests: forbidden path throws; interactive-only blocked in headless; allowed-direct for kimi passes; Claude/Codex require vendor-agent intent.
- **Forbidden:** real network calls; keychain; wiring adapters.

### Act M0-A2 — Engine + minimal protocol

- **Blast radius:** `packages/engine`.
- **Build:** start engine; thread/turn/item types; in-memory or file-backed thread store; stream fake/echo agent for protocol tests without providers.
- **Accept:** protocol round-trip test (create thread → start turn → receive items → complete) on Node + Bun.
- **Forbidden:** desktop; ACP beyond stub; Build Room hooks.

### Act M0-A3 — Direct-key adapter (Kimi Code)

- **Blast radius:** `packages/adapters` (+ engine wiring).
- **Build:** MAD `ProviderPort` wrapping pinned `pi-ai`; Kimi Code config (base URL, honest UA, key from OS keychain or env for local only — never commit secrets); stream assistant text into items; surface `responseModel`.
- **Accept:** integration test with **mock server** (no paid calls in CI); optional manual runbook step with real key.
- **Forbidden:** spoofing User-Agent; calling forbidden providers; pinning `pi-agent-core` as hard dependency for M0 (optional later).

### Act M0-A4 — Named seat + hash-chained session record

- **Blast radius:** `packages/engine` sessions + seat config.
- **Build:** one named seat; session JSONL/SQLite with hash chain; served-model receipt per turn.
- **Accept:** E2E test: seat run writes record; chain verifies; doctor reports seat + last session.
- **Forbidden:** multi-seat orchestration; cloud sync.

### Act M0-A5 — Claude Code agent adapter

- **Blast radius:** `packages/adapters` vendor.
- **Build:** spawn **unmodified** Claude Code (detect binary); send task; stream/capture output into thread items; registry status `allowed-via-vendor-agent` only.
- **Accept:** adapter unit test with fake child process; manual runbook with real Claude Code if present; CI skips live if binary missing.
- **Forbidden:** reimplementing Claude API against Pro/Max subscription; modifying Claude Code; scraping OAuth into custom HTTP.

### Act M0-A6 — Codex seat via app-server

- **Blast radius:** `packages/adapters` vendor.
- **Build:** drive Codex **app-server** (official embed path); map thread/turn/item ↔ MAD native (identity mapping where shapes match); ChatGPT or API auth per Codex docs — never custom ChatGPT HTTP.
- **Accept:** fake/json-rpc mock for CI; manual runbook with local Codex; registry enforces vendor-agent path.
- **Forbidden:** ChatGPT token replay in custom client; forking codex-rs into the repo.

### Act M0-A7 — Thin CLI

- **Blast radius:** `packages/cli`.
- **Build:** `madc doctor` (runtimes, registry summary, seat, adapter binary presence); **either** interactive chat **or** headless one-shot (`prompt in → JSON out → exit code`) talking to engine only.
- **Accept:** doctor exits 0 on healthy scaffold; one-shot/chat completes a turn against mock or live per runbook; no agent loop code in `cli`.
- **Forbidden:** putting tools/loop in CLI; npm publish.

### Act M0-A8 — Matrix tests + M0 runbook

- **Blast radius:** CI, `docs/runbook/M0.md` (or `docs/plan/RUNBOOK-madc-M0.md`), README pointer.
- **Build:** registry forbid/allow tests + M0 happy-path test always in CI; runbook: install, doctor, kimi mock/live, Claude Code optional, Codex optional, where session files live.
- **Accept:** CI green; runbook readable in &lt;10 minutes; criterion F met.
- **Forbidden:** requiring paid keys in CI.

### Act M0-A9 — Vertical slice freeze (M0 done)

- **Blast radius:** docs completion report in PR description.
- **Build:** prove A–F on a clean machine checklist; open “M0 complete” PR or mark final stacked PR ready for Founder merge.
- **Accept:** Founder can run runbook; Hephaestus lists head SHAs for each merged act.
- **Forbidden:** starting desktop; wiring the other seven live; messaging other venues.

**Suggested build order:** A0 → A1 → A2 → A3 → A4 → A7 (doctor early) → A5 → A6 → A8 → A9. A5/A6 may proceed in parallel after A2+A1 if staffing allows; both must clear registry.

## 11. Risks (name + mitigation)

| Risk | Mitigation |
| --- | --- |
| Terms / forbidden paths | Registry fail-closed; stubs carry quotes; monthly re-check noted in runbook; never implement forbidden adapters “just to try”. |
| `pi-ai` 0.x churn | Exact pin; adapter-only import; upgrade = dedicated PR with pi-check smoke. |
| Codex app-server auth / protocol drift | Prefer official docs + mock in CI; pin Codex CLI version in runbook; isolate mapping layer. |
| Claude Code adapter fragility | Unmodified binary only; treat stdout/event stream as unstable — adapter versioned; skip CI if absent. |
| Scope creep to ten providers / desktop | Acts above; non-goals section; Founder rejects PRs that wire stubs live without new commission. |
| Secrets leak | Keychain/env only; `.gitignore` already; redaction in logs; no keys in session records. |
| Dual-runtime breaks | Keep CI Node 22.19 + Bun; avoid Bun-only APIs in engine. |

## 12. Verify bullets (Definition of Done)

- [ ] ADR-0001..0003 show **ACCEPTED** on `main` (via Founder-merged PR).
- [ ] `packages/{engine,cli,registry,adapters,core}` exist with import rules respected.
- [ ] Registry tests: forbid / interactive-only / allow paths.
- [ ] Protocol test: thread/turn/item round-trip without live vendors.
- [ ] Kimi path: mock CI + optional live runbook.
- [ ] Claude Code path: fake child + optional live.
- [ ] Codex app-server path: mock + optional live.
- [ ] Named seat writes hash-chained session with served-model field.
- [ ] `madc doctor` + chat or one-shot work as thin clients.
- [ ] `npm run check` / CI green on Node 22.19 + Bun.
- [ ] M0 runbook in-repo.
- [ ] No npm publish; no other-repo diffs; no vendored forks.

## 13. Handoff notes for Hephaestus

1. **Wait for Founder accept** of this plan (and merge of its PR) before writing engine code beyond what Founder explicitly commissions.
2. Venue: clone `MADVenturesLLC/MADC` only. Base every PR on current `main`. Name exact head SHA when asking Founder to merge.
3. Read the authority table in §1 before coding. Prefer mechanisms in §4; reject UI/code clones.
4. Start with Act **M0-A0** then **M0-A1** — registry before adapters prevents “wire first, policy later” debt.
5. Pin `@earendil-works/pi-ai` only inside `packages/adapters`. Do not take omp SDK.
6. For Claude Code / Codex: drive vendor programs; do not reimplement subscription HTTP.
7. npm: **PARKED**. No tokens, no `npm publish`.
8. Do not message Daedalus / other agents unless Founder says so; report completion to Founder with branch + SHA.
9. Cloud Agents optional; Founder has previously authorized alternate local/`gh` paths when Cloud Agents are unavailable — follow Founder’s commission letter for the build phase.

## 14. FOUNDER_DECISION_REQUIRED

| # | Decision | Default if silent |
| --- | --- | --- |
| D1 | Accept this M0 build plan as commissionable? | Plan stays draft; Hephaestus does not build. |
| D2 | Confirm direct-key = **Kimi Code** (vs Ollama Cloud)? | Kimi Code per §5. |
| D3 | Protocol transport for M0: stdio JSON-RPC vs localhost HTTP? | **stdio JSON-RPC** (Hephaestus picks in A2 if still open). |
| D4 | Built-in seat id/name for E2E? | `madc-default` with role “general builder”. |
| D5 | Session store: JSONL vs SQLite for M0? | **JSONL** hash-chain (simpler); SQLite later. |
| D6 | After accept: commission Hephaestus Act M0-A0 only, or A0–A9 as a program? | Recommend **program with stacked PRs**; Founder merges each SHA. |

## 15. Completion report (this Daedalus deliverable)

- **Deliverable:** this file `docs/plan/PLAN-madc-M0-build-plan.md` on a branch + PR (**do not merge**).
- **Not done by Daedalus:** Hephaestus build; ADR file edits on `main`; npm; other venues; agent pings.
- **Wait:** Founder accept (D1) before any Hephaestus build commission.

---

*End of M0 build plan.*
