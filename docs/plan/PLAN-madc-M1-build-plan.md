# madc M1 build plan — every lane lit + named roster

*Daedalus · 2026-09-24 · Venue: `MADVenturesLLC/MADC` only · Status: commissionable build plan for Hephaestus. It is **not** a merge authorization and it does not start until the Founder accepts it (D-M1-1) and M0 is done.*

Roadmap: [`ROADMAP-madc-post-M0.md`](ROADMAP-madc-post-M0.md) (M1 row, subscription table §3).

## 0. Bet in one sentence

Turn M0's three live backings into **every lane Mike's subscriptions allow**. That means Ollama Cloud first, then the remaining direct-key plans, interactive-only plans behind an attested mode gate, and Grok Build through one generic ACP client. It also means seating **Daedalus, Hephaestus, Prometheus and Surface Architect** as first-class seats. The registry refuses everything else, and every turn leaves a receipt that names the lane.

## 1. Authority (binds the builder)

| Path | Role |
| --- | --- |
| `docs/plan/ROADMAP-madc-post-M0.md` | Milestone order, subscription table (terms re-read 2026-09-24) |
| `docs/plan/PLAN-madc-M0-build-plan.md` | Format, import rules, M0 acts this plan builds on (merged PR #2, `9c71afd`) |
| `docs/plan/PIN-madc-M0-protocol-messages.md` | Wire, methods, error codes. M1 changes are **proposed amendments** only (§9) |
| `docs/plan/PIN-madc-M0-seat-format.md` | Seat file, `$MADC_HOME`, session JSONL hash chain. M1 changes are **proposed amendments** only (§9) |
| `docs/plan/subscription-lanes-2026-09-24.md` | Lane evidence (the roadmap §3 supersedes it where re-verified) |
| `docs/plan/pi-check-2026-09-24.md` | pi-ai provider coverage, headers, `responseModel` |
| `docs/adr/ADR-0001..0003` | Hybrid core with pinned pi-ai; Codex-shaped native protocol, ACP adapter only; rules-aware registry |
| `docs/policy/CODE-ADVISORIES.md` | Advisory DoD for every act PR |
| `PLAN-MAD-AGENT-planning-record.md` Appendix R | Founder rulings 12 (credential class by mode) and 13 (MiniMax non-sensitive repos only) |

Standing rules carried from M0: venue only `MADVenturesLLC/MADC`; merges are Founder-only and name the exact head SHA; no npm publish (still parked); no vendored forks; keys never in git, config, prompts, logs or session records.

## 2. Success criteria (M1 exit gate)

| ID | Criterion |
| --- | --- |
| **A** | Registry v2 lists every row of roadmap §3 (11 subscriptions, plus the forbidden sub-paths) with `status`, `sourceQuote`, `termsUrl`, `verifiedAt`. Unknown or unwired ids fail closed. |
| **B** | Live direct-key lanes (mock in CI, optional live in runbook): **Ollama Cloud** (first), Mistral, Gemini API auth key, xAI API, plus Kimi Code from M0. **DeepSeek is wired-but-gated:** M1 exits with DeepSeek passing mock conformance against a test allowlist, and denying every repo on a clean install (D-M1-8 default: empty allowlist). A live DeepSeek lane needs the Founder to name at least one repo. That is not an M1 exit requirement. |
| **C** | Interactive-only lanes (MiniMax Token Plan, Alibaba Coding Plan) serve **only** turns that pass the **engine-side presence check** (§7 M1-A5). A client's `mode: "interactive"` claim is necessary but never sufficient. Every other turn gets `-32007` with `interactive-only-headless` before any network call. Headless work on these vendors goes only through **separate PAYG registry ids** (`minimax-payg`, `alibaba-model-studio-payg`), never through the plan ids. |
| **D** | Vendor-agent lanes: Claude Code and Codex (M0), plus **Grok Build via a generic ACP client adapter** (`grok agent stdio`). |
| **E** | Seat roster: `daedalus`, `hephaestus`, `prometheus`, `surface-architect` (plus `madc-default`) seeded, loadable, selectable (`madc -s <id>`), each with its own backing, pinned model, memory file, tool deny list and `headlessOk`. |
| **F** | Every model or vendor invocation writes a `servedModel` receipt (protocol item + JSONL event) that names the lane, and marks `fallbackFrom` or `vendorReported: false` honestly. |
| **G** | Keys live in the OS keychain (macOS, Linux). `madc auth` stores and removes them through the engine. The redaction test covers every new provider's key shape. |
| **H** | `madc providers ls` and `madc doctor` show each lane, whether credentials or binary are present, and terms freshness (warn at more than 30 days). Node 22.19 + Bun CI green. M1 runbook in-repo. |

## 3. Non-goals (M1)

- Multi-seat handoffs, parallel seats, decision inbox (M2). `handoffs.enabled` stays `false`.
- Desktop (M3). Memory store beyond the per-seat file; MCP; ACP **server** for editors (M4).
- npm publish (parked; see roadmap D-R5).
- Z.ai GLM Coding Plan in any form (stays `forbidden`; roadmap D-R3).
- Consumer Grok / SuperGrok / X Premium+ sign-in reused by madc; Antigravity or Gemini sign-in; Claude subscription outside unmodified Claude Code; ChatGPT token replay.
- Using pi-ai's bundled third-party OAuth flows (for example its xAI device-code flow). madc uses API keys or vendor agents only.
- Windows keychain (UNVERIFIED approach; deferred, env fallback is dev-only).
- Quota prediction. M1 only reacts to 429/502-style signals and records them.

## 4. Mechanism stolen + MAD evolution

| Steal from | Mechanism | MAD evolution (no clone) |
| --- | --- | --- |
| [Agent Client Protocol](https://agentclientprotocol.com/overview/introduction); Grok Build [`grok agent stdio`](https://docs.x.ai/build/cli/headless-scripting.md); [Copilot ACP server](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server) | Vendor agents that speak ACP over stdio JSON-RPC | One **ACP client adapter** in `packages/adapters` maps `session/update` chunks to MAD items. Adding a future ACP agent is a registry entry plus a spawn spec, not new adapter code. Every spawn passes `assertAllowed` first. |
| pi-ai built-ins (`mistral`, `deepseek`, `google`, `xai`, `minimax`, `qwen-token-plan*`) + `createProvider` OpenAI-compat (pi-check §1) | Many providers behind one stream API | A **generic direct-key `ProviderPort`** driven by registry data (wire, base URL, identity header policy). Ollama Cloud uses the custom OpenAI-compat path. Model lists come live from the provider where possible (Ollama `/api/tags`), labelled `listed` or `reachable`, never hard-coded. |
| Alibaba `sk-sp-` vs `sk-` keys; planning record ruling 12 | Credential class tied to usage mode | **Engine-verified presence, not a client claim:** for interactive-only lanes the engine itself opens the controlling terminal (`/dev/tty`) and requires a human keypress confirmation there. It re-checks the terminal on **every** interactive-only turn; a lost terminal voids the confirmation. No controlling terminal or no confirmation means fail closed. Plan keys and PAYG keys are separate registry ids, so the credential class is picked by registry entry and never by a flag. |
| ADR-0003 + subscription-lanes brief | Terms as data | **Terms with a freshness clock:** `verifiedAt` + `termsUrl` per entry, and a doctor warning after 30 days. `forbidden` never relaxes on staleness. |
| MadBridge-style hash chain (seat pin §4) | Append-only receipts | Receipts now carry `lane` and `fallbackFrom`, so the chain proves which lane served each turn and that no hop crossed into a denied lane. |

## 5. Package layout and blast radius

No new packages. Import rules from M0 §6 stand (`cli` imports protocol types and client SDK only; `adapters` is the only importer of `@earendil-works/pi-ai`; `registry` stays pure).

| Package | M1 changes |
| --- | --- |
| `packages/registry` | Catalog v2 (roadmap §3 rows + forbidden sub-paths); `verifiedAt`, `termsUrl`; new `DenyReason` values `repo-not-allowed`; `credentialClass`; pure `lanesFor(mode)` helper. Still no I/O. |
| `packages/adapters` | Generic direct-key `ProviderPort` over pinned pi-ai; Ollama Cloud custom provider; ACP client adapter; Grok Build spawn spec. |
| `packages/engine` | Seat schema v2 + roster seeds; `mode` handling; per-repo data policy (`$MADC_HOME/policy.json`); ordered fallbacks; keychain-backed credential store; `seat/list`, `provider/list`, `auth/*` methods (after pin amendment). |
| `packages/cli` | `madc -s <seat>`, `madc seats ls`, `madc providers ls`, `madc auth set\|rm\|status <provider>`, TTY-based mode claim, doctor lanes report. |
| `packages/core` | Shared types only if needed for the widened `servedModel` / seat types. |
| Docs | `docs/runbook/M1.md` (or `docs/plan/RUNBOOK-madc-M1.md`), README pointer. |

## 6. Seat roster (M1 defaults; Founder can change any cell, D-M1-4)

Model ids are **not** invented here. Each `pinnedModel` is locked in M1-A7 against the pinned pi-ai catalog or the provider's live list at build time, the same way M0-A3 locked `kimi-coding/kimi-for-coding`.

| Seat id | Role (standing instructions summary) | Default backing | Why this backing | `headlessOk` | Tool policy (deny wins) | Fallbacks (ordered) |
| --- | --- | --- | --- | --- | --- | --- |
| `daedalus` | Architect: research-first plans, docs, D-tables. No code. | `claude-code` (vendor agent) | Long-form planning on the Founder's Max plan, through the only lane Anthropic allows | `true` | deny writes outside `docs/**`; deny `git push` to `main` | `kimi-code` |
| `hephaestus` | Builder: acts, tests, PRs. Never merges. | `codex` (vendor agent, app-server) | Codex sandbox and approvals; ChatGPT plan through the official embed path | `true` | deny `git push` to `main`; deny branch-protection APIs | `claude-code` |
| `prometheus` | Idea and research: sources, ledgers, verdicts. | `kimi-code` (direct) | MAD loop with honest UA; receipts from `responseModel` | `true` | deny writes outside `docs/**` and scratch | `ollama-cloud` |
| `surface-architect` | Contracts and pins: protocol, seat format, UX system. | `ollama-cloud` (direct) | First new M1 lane; exercises the generic port on real work | `true` if D-M1-3 allows Ollama headless, else `false` | deny writes outside `docs/plan/PIN-*` and `docs/**` | `kimi-code` |
| `madc-default` | General builder (M0, unchanged) | `kimi-code` | M0 pin §3 | `true` | `[]` | none |

Fallback rule: a fallback is tried only if it is in the seat's list, passes `assertAllowed` for the turn's `mode`, and has credentials or a binary present. Every hop writes a receipt with `fallbackFrom`. Fallbacks never move into `forbidden`, never into `interactive-only` on a turn that failed the presence check, and never into a repo-denied provider. A headless seat that wants MiniMax or Alibaba must list the PAYG id (`minimax-payg`, `alibaba-model-studio-payg`) explicitly.

## 7. Acts for Hephaestus (M1-A0 … M1-A9)

Each act is its own PR (stacked is fine) based on current `main`. Founder merges by exact head SHA. Every PR follows `docs/policy/CODE-ADVISORIES.md`. **Do not merge yourself.**

### M1-A0 — Pin amendments accepted (Surface Architect gate, docs only)

- **Scope:** Surface Architect turns §9 PROPOSED AMENDMENTS into **new dated pin files that supersede** the M0 pins (for example `PIN-madc-M1-protocol-messages.md`, `PIN-madc-M1-seat-format.md`). Per `docs/plan/README.md`, dated planning files stay verbatim, so the M0 pins are not edited in place. Daedalus does not edit pins.
- **Files:** new `docs/plan/PIN-madc-M1-*.md` (Surface only), `docs/plan/README.md` index rows (mark the M0 pins as superseded).
- **Acceptance:** Founder merges the pin PR. Hephaestus acts A1+ cite the merged pin SHA.
- **Forbidden:** code; changing M0 semantics that M0 tests already lock without a Founder note.

### M1-A1 — Registry v2 (pure)

- **Scope:** Catalog v2 with every roadmap §3 row and sub-path; `termsUrl`, `verifiedAt` (ISO date), `credentialClass` (`plan-interactive` | `payg` | `vendor-session`); new ids `xai-api` (`allowed-direct`), `grok-build` (`allowed-via-vendor-agent`), `xai-consumer-signin` (`forbidden`), `minimax-payg` and `alibaba-model-studio-payg` (`allowed-direct` **only once A1 cites a PAYG terms source**; until then `wired: false`, because I did not re-verify PAYG terms on 2026-09-24), keep `gemini-api-key`, `gemini-antigravity-signin`, `zai-glm-coding-plan`, etc.; `DenyReason` gains `repo-not-allowed`; pure `isStale(entry, now, days)`.
- **Files:** `packages/registry/src/{catalog,types,assert,index}.ts`, tests.
- **Acceptance:** tests: every id resolves; forbidden ids throw for both modes and both connects; `interactive-only` throws `interactive-only-headless` on headless; `xai-consumer-signin` throws `forbidden`; staleness never flips `forbidden`; catalog stays deep-frozen (M0 PR #5 test pattern); `sourceQuote` equals the text quoted in roadmap §3.
- **Forbidden:** network, keychain, file I/O in `registry`; changing a lane without a cited source.

### M1-A2 — Credential store (keychain) + `auth/*`

- **Scope:** Engine-side credential store: macOS `security` CLI and Linux `secret-tool` (libsecret) via child process, with no native npm deps. Env-var fallback only when `MADC_DEV_ENV_KEYS=1`, and doctor reports it loudly. Protocol methods `auth/remove` and `auth/status` only (status returns presence only, never values). **Setting a secret never travels over the JSONL protocol:** `madc auth set <provider>` runs a separate one-shot engine subcommand (`madc-engine auth-set <provider>`, not a JSONL session). It reads the secret from its own no-echo TTY prompt, writes it straight to the keychain, and exits. Stdin in a JSONL session stays pure protocol, so a raw secret can never hit the `-32700` parse-error path. Redactor learns every stored key.
- **Files:** `packages/engine/src/credentials/*`, protocol handlers, `packages/cli` `auth` command, tests.
- **Acceptance:** fake keychain in CI; `auth/status` payload contains no secret; no JSONL method accepts a secret value (schema test); the one-shot `auth-set` refuses to run without a TTY unless `MADC_DEV_ENV_KEYS=1`; redaction test with each new key shape (`xai-…`, `sk-sp-…`, generic `sk-…`) passes and the chain still verifies; a key passed on the CLI command line is rejected (stdin or prompt only).
- **Forbidden:** writing keys to `$MADC_HOME` files, logs, JSONL or protocol payloads; storing ChatGPT, Claude.ai or Grok consumer tokens (vendor agents own their own login).

### M1-A3 — Generic direct-key port + **Ollama Cloud** (first live lane)

- **Scope:** `ProviderPort` generalized from M0-A3's Kimi port and driven by registry data. Ollama Cloud via pi-ai `createProvider` OpenAI-compat against `https://ollama.com/v1` with Bearer key (docs.ollama.com/api/authentication.md). Model picker from `GET https://ollama.com/api/tags`, labelled `listed` (not "entitled"; planning record OLL-27/28). Map 429 and 502 to a recorded `quota-or-unreachable` signal, which the fallback logic consumes.
- **Files:** `packages/adapters/src/direct/*`, `packages/adapters/src/providers/ollama-cloud.ts`, engine wiring, tests.
- **Acceptance:** mock-server tests: stream → items → `servedModel` (uses `responseModel` when present, else requested id per seat pin §4); 429 and 502 produce an `error` item plus fallback per seat list; Kimi Code M0 tests still pass unchanged through the generic port.
- **Forbidden:** hard-coded model lists as truth; paid calls in CI; the signed-in local-proxy path as default (optional, runbook-only).

### M1-A4 — Direct-key batch: Mistral, DeepSeek, Gemini (auth key), xAI API

- **Scope:** Registry-driven config over pi-ai built-ins `mistral`, `deepseek`, `google`, `xai`. Gemini accepts **auth keys** only; doctor flags anything that looks like a standard key as a likely failure (Google's page says standard keys are rejected from September 2026). Per-repo data policy in `$MADC_HOME/policy.json`: DeepSeek denied unless the thread's repo is allowlisted (D-M1-8), giving `-32007` `repo-not-allowed`.
- **Files:** `packages/adapters/src/providers/{mistral,deepseek,gemini,xai}.ts`, `packages/engine/src/policy/*`, tests.
- **Acceptance:** one L1 conformance test per provider against a mock (chat, stream, one tool round-trip, served-model receipt); DeepSeek repo-deny test; xAI entry uses `XAI_API_KEY`-style key from keychain, never pi-ai's xAI OAuth.
- **Forbidden:** pi-ai OAuth flows; any Google OAuth; sending a repo to DeepSeek that is not on the allowlist.

### M1-A5 — Interactive-only lane: mode attestation + MiniMax + Alibaba

- **Scope:** CLI claims `mode: "interactive"` only when stdin and stdout are TTYs and no `-p`; otherwise `headless`. The engine defaults to `headless` when `mode` is absent (fail-closed). **The claim alone never unlocks an interactive-only lane, because any local program can send it.** The engine runs its own **presence check on every interactive-only turn**: it opens the controlling terminal (`/dev/tty`) itself and confirms it is still a live TTY. The first such turn in a session also requires a human keypress confirmation there (not over the protocol pipe). If the terminal is gone or has changed (different device or session id) at any later turn, the confirmation is void. That turn is refused, and the next one needs a fresh keypress on a live terminal. No controlling terminal (cron, CI, detached daemon, desktop without a verified prompt) means `-32007` `interactive-only-headless`. The per-turn check result, TTY facts and claim go into `turn.start` and receipts. Credential class by registry entry (ruling 12): plan keys (`sk-sp-`, MiniMax Subscription Key) live only under `minimax-token-plan` / `alibaba-coding-plan`; PAYG keys live only under `minimax-payg` / `alibaba-model-studio-payg`, which headless seats must list explicitly. MiniMax (both ids) gets a per-repo allowlist (ruling 13, D-M1-9). **Residual risk, stated honestly:** a program running inside the Founder's own terminal could still simulate a keypress. The check stops detached automation, not a hostile local process.
- **Files:** `packages/cli/src/mode.ts`, engine turn handling, `packages/adapters/src/providers/{minimax,alibaba-coding}.ts`, tests.
- **Acceptance:** headless turn on an interactive-only seat gives `-32007` `interactive-only-headless` **before** any network call; a client that sends `mode: "interactive"` from a process with no controlling terminal is refused (test with `setsid`/detached spawn); a session that passed the check and then loses its terminal is refused on the very next interactive-only turn (detach-after-confirm test); a plan key is never readable through a PAYG id and vice versa; interactive turn succeeds against mock; JSONL shows `mode`; a fixture with `mode` absent is treated as headless; Alibaba base URL and key-class mismatch are refused (`sk-` key on the plan endpoint or `sk-sp-` on PAYG).
- **Forbidden:** letting a seat's `headlessOk: true` override an interactive-only lane; auto-retrying a denied interactive-only call on a PAYG key without the seat's fallback list saying so.

### M1-A6 — Generic ACP client adapter + Grok Build

- **Scope:** Spawn an ACP agent over stdio (`grok agent stdio`, with `--no-auto-update` per xAI docs). Initialize, open a session, send prompt, map `session/update` agent message chunks to `agentMessage` deltas and items, and map tool events to `toolCall` / `toolResult` where present. `servedModel.vendorReported` is `true` only if the agent reports a model. Otherwise the receipt records the requested model and `vendorReported: false`. Grok Build authenticates itself (its own browser or device login, or `XAI_API_KEY` if the Founder chooses the API-key class). madc never reads Grok's credential files.
- **Files:** `packages/adapters/src/vendor/acp-client/*`, `packages/adapters/src/vendor/grok-build.ts`, tests with a fake ACP agent.
- **Acceptance:** fake ACP agent round-trip on Node and Bun; binary missing gives `-32008` `binary-missing`; interrupt maps to `turn/interrupt`; CI skips live; runbook has the optional live step.
- **Forbidden:** reading `~/.grok` credentials; using pi-ai's xAI OAuth; turning on `--always-approve` by default (approval posture follows seat policy, and default is not always-approve).

### M1-A7 — Seat roster v1

- **Scope:** Seat schema v2 (§9 amendments S1–S3): backing = any `wired: true` registry id; `fallbacks`; `displayName`. v1 files load unchanged (migrated in memory, never rewritten). Same seed writer seeds the four roster seats from §6 plus `madc-default`, and never overwrites. Lock each `pinnedModel` against the pinned catalog or live list. `seat/list` method.
- **Files:** `packages/engine/src/seats/*`, seed content, tests.
- **Acceptance:** fresh `$MADC_HOME` seeds 5 seats; second start is byte-identical; each seat runs one mock turn with its own backing and writes its own memory path; fallback test writes two receipts (primary failure + `fallbackFrom`); seat with a `forbidden` backing gives `-32006` `SeatInvalid`; path-confinement tests from the M0 seat pin still pass.
- **Forbidden:** handoffs (stay `enabled: false`); shared memory between seats.

### M1-A8 — CLI surfaces + doctor lanes report

- **Scope:** `madc -s <seat>`, `madc seats ls`, `madc providers ls [--json]`, `madc auth …`. Doctor adds a lanes table: id, status, wired, credentials/binary present, `verifiedAt`, stale warning at more than 30 days, mode it can serve.
- **Files:** `packages/cli/src/*`, `provider/list` handler in engine, tests.
- **Acceptance:** `providers ls --json` schema test; doctor exits 0 with warnings on stale terms and non-zero on a broken chain or unreadable seat; `cli` still imports no loop, tools or adapters (import-rule test).
- **Forbidden:** agent logic in `cli`; printing any credential value.

### M1-A9 — Conformance, runbook, freeze

- **Scope:** CI conformance L1 (mock) for every wired lane; `docs/runbook/M1.md`: keychain setup per OS, per-subscription live smoke (optional, Founder's keys), terms re-check table with dates, how to read receipts. Completion report in the PR body with each act's merged SHA.
- **Acceptance:** CI green on Node 22.19 + Bun; criteria A–H checked on a clean machine; runbook readable in under 15 minutes.
- **Forbidden:** paid keys in CI; starting M2 work.

**Suggested order:** A0 → A1 → A2 → A3 → A7 (roster early, on Kimi + Ollama) → A4 → A5 → A6 → A8 → A9. A4, A5 and A6 can run in parallel after A3 if staffing allows.

## 8. Risks

| Risk | Mitigation |
| --- | --- |
| Terms drift (for example MiniMax's interactive clause not re-found today; Grok Build is an early beta) | `verifiedAt` + doctor staleness; fail-closed defaults; lane changes need a cited source in the PR. |
| Ollama "automated means … without permission" read against headless | Founder rules (D-M1-3); seat `headlessOk` for `surface-architect` follows the ruling. |
| Mode claim can be spoofed by a local client | The claim is never trusted alone. The engine's own `/dev/tty` presence check plus a keypress is required for interactive-only lanes, and anything without a controlling terminal fails closed. A process inside the Founder's own terminal could still fake a keypress; that residual risk is recorded in the runbook. M3's desktop needs its own engine-owned confirmation prompt (a pin amendment) before it can use these lanes. |
| pi-ai 0.x churn across six more providers | Exact pin; generic port isolates it; upgrade is its own PR with the pi-check smoke. |
| ACP spec or Grok Build CLI changes | Adapter versioned; fake agent in CI; live step optional. |
| Keychain differences across OSes | macOS + Linux only in M1; env fallback is dev-only and loud. |
| xAI AUP "compete" clause | Founder read (roadmap D-R4); only documented xAI paths wired. |
| Parallel costs across many subscriptions | M1 is single-seat per thread; parallel use is M2 with per-seat caps. |

## 9. PROPOSED AMENDMENTS to the Surface pins (not edited here)

Surface Architect owns the pins. These are proposals for M1-A0. Numbering: P = protocol pin, S = seat pin.

**Protocol pin (`PIN-madc-M0-protocol-messages.md`):**

- **P1** `protocolVersion` → `"madc-m1/1"`. All M0 methods and codes unchanged. Clients must not assume new methods on `madc-m0/1`.
- **P2** `ServedModelItem.backing`: widen from the 3-literal union to `string`, meaning a registry id with `wired: true`. Add `lane: ProviderStatus`, `mode: "interactive" | "headless"`, `fallbackFrom: string | null`, `vendorReported: boolean`.
- **P3** `turn/start` params: optional `mode: "interactive" | "headless"`. If absent, the engine uses `headless` (fail-closed). The claim is advisory; interactive-only lanes also need the engine-side presence check (M1-A5), whose result is recorded as `presence: "verified" | "absent"`.
- **P4** New requests: `seat/list` → `{ data: SeatSummary[] }`; `provider/list` → `{ data: ProviderSummary[] }` (id, status, wired, `verifiedAt`, stale, `credentialsPresent` | `binaryPresent`; never values); `auth/remove`; `auth/status`. **No `auth/set` over JSONL:** secrets are set only by the one-shot `madc-engine auth-set` subcommand (separate process, own no-echo TTY prompt, not a JSONL session), so no secret ever crosses the protocol stream or its error path.
- **P5** `-32007 ProviderDenied` `reason` gains `repo-not-allowed`. `-32008 ProviderUnavailable` `reason` gains `quota-or-unreachable` (from 429/502-style signals).
- **P6** `-32601` list: M1 still has no WS/HTTP listener. The desktop transport is an M3 amendment.

**Seat pin (`PIN-madc-M0-seat-format.md`):**

- **S1** `SeatBacking` = any registry id with `wired: true` whose `connect` matches the adapter kind; validated at load; `forbidden` or unwired gives `-32006`.
- **S2** Seat `version: 2` adds `fallbacks: string[]` (ordered, each validated like `preferredBacking`) and `displayName: string`. v1 files load as v2 in memory with `fallbacks: []` and are never rewritten.
- **S3** Seeding: the same writer seeds `daedalus`, `hephaestus`, `prometheus`, `surface-architect` and `madc-default`, and never overwrites.
- **S4** JSONL payloads (additive; envelope stays `v: 1`): `turn.start` adds `mode` and `presence`; `servedModel` adds `lane`, `mode`, `fallbackFrom`, `vendorReported`; `session.open.backing` widened like S1.
- **S5** New file `$MADC_HOME/policy.json` (same confinement and permissions rules): `{ "version": 1, "repoAllow": { "<providerId>": ["<repo remote URL or absolute path>"] } }`. Providers listed there are denied for repos not in their list.
- **S6** Redaction list adds the key shapes of every new provider (for example `xai-…`, `sk-sp-…`).

## 10. Verify bullets (Definition of Done)

- [ ] Pin amendments merged by the Founder (M1-A0) and cited by SHA in A1+.
- [ ] Registry v2 tests: allow / forbid / interactive-only / repo-deny / stale-never-relaxes-forbidden.
- [ ] Ollama Cloud live-capable (mock in CI; optional live in runbook).
- [ ] Mistral, DeepSeek, Gemini auth key, xAI API: L1 mock conformance each.
- [ ] MiniMax and Alibaba refuse headless before any network call.
- [ ] Grok Build via ACP client: fake-agent CI plus optional live.
- [ ] Five seats seeded; each writes its own receipts; fallback receipts correct.
- [ ] Keys only in the keychain; redaction tests pass for all key shapes.
- [ ] `madc providers ls`, `madc seats ls`, doctor lanes report.
- [ ] Node 22.19 + Bun CI green; import rules hold; M1 runbook in-repo.
- [ ] Advisories per `CODE-ADVISORIES.md` on every act PR.
- [ ] No npm publish; no other-repo diffs; no vendored forks.

## 11. Handoff notes for Hephaestus

1. Wait for the Founder to accept this plan (D-M1-1) **and** for M0 A9 to be merged. Then start with M1-A1 only after Surface's A0 pin PR is merged.
2. Base every PR on current `main`. Name the exact head SHA in every merge ask. Never merge.
3. Registry before adapters again: A1 lands before any new provider wiring.
4. Quote sources verbatim from roadmap §3. If a live page no longer matches, stop and report. Do not "fix" a lane on your own.
5. Never touch vendor login stores (`~/.claude`, `~/.codex`, `~/.grok`). Vendor agents log in themselves.
6. pi-ai stays pinned inside `packages/adapters`. Do not enable pi-ai OAuth providers.
7. CI never makes paid calls. Live checks go in the runbook as optional Founder steps.
8. Report completion to the Founder with branch + SHAs. Do not message other agents unless the Founder says so.

## 12. FOUNDER_DECISION_REQUIRED

| # | Decision | Recommended default |
| --- | --- | --- |
| D-M1-1 | Accept this M1 plan as commissionable (after M0 A9)? | Plan stays draft until accepted; Hephaestus does not build. |
| D-M1-2 | Ollama Cloud as the first new live lane (M1-A3)? | **Yes**: the Founder named it first, it is already `allowed-direct`, and its key API needs no local install. |
| D-M1-3 | Ollama Cloud headless use, given the Terms line "Use automated means to access our services without permission"? | **Allow headless with the Founder's API key.** Ollama's own docs present the key-authenticated API for use "from your apps or terminal". The Founder can restrict it to interactive with one registry change. |
| D-M1-4 | Seat roster backings (§6)? | daedalus → claude-code, hephaestus → codex, prometheus → kimi-code, surface-architect → ollama-cloud. |
| D-M1-5 | Keychain-only credentials in M1 (env only with `MADC_DEV_ENV_KEYS=1`)? | **Yes.** |
| D-M1-6 | Stale-terms policy? | Warn after 30 days, still allow; `forbidden` never relaxes; the Founder can make stale allow-entries block. |
| D-M1-7 | Cross-provider fallbacks? | **On**, but only within each seat's list, never into denied lanes, every hop receipted. |
| D-M1-8 | DeepSeek repo allowlist? | **Empty** (DeepSeek denied everywhere) until the Founder names repos. |
| D-M1-9 | MiniMax repo allowlist (ruling 13: non-sensitive only)? | **Empty** until the Founder names repos. |
| D-M1-10 | Wire Grok Build (early beta) in M1? | **Yes**, vendor-agent lane, fake-agent CI, optional live. |
| D-M1-11 | Commission as a program of stacked PRs (A0–A9)? | **Yes**; the Founder merges each SHA. |

*End of M1 build plan.*
