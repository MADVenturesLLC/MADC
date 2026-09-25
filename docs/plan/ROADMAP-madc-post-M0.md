# madc post-M0 roadmap

*Daedalus · 2026-09-24 · Venue: `MADVenturesLLC/MADC` only · Status: **proposed roadmap**. It does not authorize a build, spend, publish, or merge.*

Base: `main` @ `6a7266a0e7ddd58ee3244a4e73070306511705b4` (after M0 plan PR #2, merge commit `9c71afd`; Surface pins PR #6; M0-A2 engine protocol PR #7). M0 acts A0–A2 are on `main`; A3–A9 are still to come. This roadmap assumes M0 A0–A9 land as planned. It builds on them and does not change them.

Sizes are **estimates in acts**. An act is one reviewable PR in the M0 sense (about one M0 act's worth of scope). Confidence is how sure I am that the size and scope hold.

---

## 0. The short version

The Founder's definition of "fully functional" has six parts. Here is the path:

| # | Milestone | One-line goal | Size (acts, est.) | Confidence |
| --- | --- | --- | --- | --- |
| **M1** | Every lane lit + named roster | Every paid subscription runs through the engine on the lane its terms allow, and four named seats run as first-class seats. | 10 (A0–A9) | Med-high |
| **M2** | The room: multi-seat work + evidence schema v2 | Seats hand work to each other, run in parallel in isolated worktrees, and surface only Founder-needed decisions, all on one frozen evidence schema. | 10 | Med |
| **M3** | Desktop v1 on the same engine | A dark-glass desktop window where every widget is bound to a verified SHA, session hash, or served model. | 9 | Med-low |
| **M4** | Memory, tools, editors | Seat memory that persists and is provable, MCP tools per seat, and an ACP server so other editors can attach. | 8 | Med |
| **M5** | Ship it | One-command install and `madc` published on npm. | 5 | Med-high |

**Recommended order:** M1 → M2 → M3 → M4 → M5, plus a tiny npm name-reserve act as soon as the Founder un-parks it (D-R5).

**Where this differs from the Founder default** (subscriptions + seats, then desktop, then multi-seat and memory): I agree on M1. I recommend **multi-seat before desktop**. Reasons are in §2.

---

## 1. Milestones

### M1 — Every lane lit + named roster

- **Goal:** Every paid subscription runs through the engine on the lane its terms allow, fail-closed, and Daedalus, Hephaestus, Prometheus and Surface Architect exist as real seats with their own model, backing, memory file, tool policy and headless flag.
- **Founder can then:** run `madc -s daedalus "…"` or `madc -s hephaestus "…"` and see the seat's own backing, model and receipt. Use Ollama Cloud, Mistral, DeepSeek, a Gemini API key, the xAI API and Kimi Code from the MAD loop. Drive Claude Code, Codex and Grok Build as vendor agents. Use the MiniMax and Alibaba plans in interactive sessions only. Run `madc providers ls` and see every lane with its terms source and the date it was last checked.
- **Depends on:** M0 A0–A9 merged (engine, protocol pin, seat pin, registry, Kimi/Claude Code/Codex adapters, CLI, runbook). Surface pin amendments (M1-A0).
- **Size:** 10 acts (est.). **Confidence:** med-high. The loop, registry and adapters exist after M0; most of M1 is config plus two new adapter shapes (generic direct-key, ACP client).
- **Top risks:** terms drift (mitigated by `verifiedAt` in the registry: stale allow entries deny until re-verified); Ollama Cloud's "automated means" clause for headless use (headless denied until the Founder records permission, D-M1-3); MiniMax interactive-only clause not re-found on today's pages (kept fail-closed); Grok Build is an early beta, so its ACP surface may move.
- **Plan:** [`PLAN-madc-M1-build-plan.md`](PLAN-madc-M1-build-plan.md).

### M2 — The room: multi-seat work + evidence schema v2

- **Goal:** Seats hand work to each other with typed, hash-linked handoffs, run in parallel in isolated git worktrees, and raise only typed Founder decisions, all written to a frozen session/evidence schema v2.
- **Founder can then:** say "Daedalus, plan it; Hephaestus, build it" once, and get back one decision inbox that holds only the calls he must make, each with a recommended default and a link into the chain. Two seats can work at once without stepping on each other's files.
- **Depends on:** M1 (roster, multiple backings).
- **Size:** 10 acts (est.). **Confidence:** med. The unknowns are cross-thread hash links and worktree lifecycle under vendor agents.
- **Top risks:** vendor agents running in parallel burn subscription limits faster (Claude's terms say Pro/Max limits "assume ordinary, individual usage"; see §3); worktree merge conflicts; getting the decision taxonomy wrong so the inbox fills with noise.

### M3 — Desktop v1 on the same engine

- **Goal:** A desktop app that is a second window onto the same engine: dark glass, big type, keyboard-first, and every widget bound to real evidence.
- **Founder can then:** see seats side by side, watch handoffs move, clear the decision inbox, and search sessions. No widget shows green unless a verifier checked a hash, SHA, or served-model receipt behind it.
- **Depends on:** M2 schema v2 frozen. Surface Architect picks the stack (GPUI vs Tauri is open; planning record Appendix R, amendment 1) and signs off on the visual system.
- **Size:** 9 acts (est.). **Confidence:** med-low, because the stack is not chosen and "instant keyboard feel" is a performance bar that has not been measured yet.
- **Top risks:** stack churn (Appendix R notes GPUI is pre-1.0); the engine currently has a stdio-only transport, so the desktop needs a local socket transport (a protocol amendment); scope creep into an IDE, which is a v1 non-goal.

### M4 — Memory, tools, editors

- **Goal:** Seat memory that persists across sessions and is provable, per-seat MCP tools, and an ACP server adapter so Zed-class editors can attach to a madc seat.
- **Founder can then:** come back a week later and find that Hephaestus remembers the repo conventions, with every memory write traceable to the turn and served model that wrote it. Add an MCP server to one seat without giving it to the others. Open Zed and talk to Daedalus through ACP.
- **Depends on:** M2 (memory and tool receipt event types are defined in schema v2). M3 not required.
- **Size:** 8 acts (est.). **Confidence:** med.
- **Top risks:** prompt injection through shared memory (Appendix R amendment 2 rejects passive shared graphs); MCP servers are third-party code (trust manifests needed); ACP spec churn.

### M5 — Ship it

- **Goal:** One-command install on the Founder's machines and the `madc` npm package published.
- **Founder can then:** install on a clean Mac with one command and run `madc doctor` green.
- **Depends on:** Founder un-parks npm (M0 plan §1 ruling 10). The name-reserve act can run any time after that (D-R5). A full release needs M1 at minimum.
- **Size:** 5 acts (est.). **Confidence:** med-high on packaging. Low on signing/notarization until the Founder picks a distribution path.
- **Top risks:** name squatting before reservation (npm `madc` returned HTTP 404, meaning free, when I checked on 2026-09-24); supply-chain posture of a published package; binary signing.

---

## 2. Recommended order and why

**Order:** M1 → M2 → M3 → M4 → M5. The npm name-reserve act runs as early as the Founder allows.

**M1 first: agree with the Founder.** Subscriptions and seats are the wedge (idea plan §6.3–6.4), and M0 leaves both one step away. Seats in M1 are already meaningfully distinct, and they do not need a new memory system to get there. The seat pin gives each seat its own `memory/<seatId>.md`, its own tool deny list, its own backing and pinned model, and its own `headlessOk`. That is enough to make Daedalus and Hephaestus behave differently on day one. Richer memory can come later without breaking seat identity.

**M2 before desktop: I argue against the default here.** Three reasons:

1. **The desktop's headline views have nothing to bind to until multi-seat exists.** The idea plan's desktop is "agents running side by side, handoffs you can see, a review inbox" (§6.5). Before M2 there is one seat per thread, no handoffs and no inbox. A desktop built first would either show one-seat chat or show placeholders. Placeholders are the "decorative green" the Founder has ruled out.
2. **Evidence-binding needs a frozen schema.** Every desktop widget must point at a session hash, SHA or served-model receipt. M2 changes the session schema: handoff events, cross-thread links, worktree SHAs, decision items. If the desktop ships first, every widget gets rebound after M2. M2 freezes schema v2, then M3 binds to it once.
3. **Multi-seat is where the product stops being "another CLI".** It is the roster-as-wedge claim (idea plan §7). Proving it in the CLI is cheaper than proving it in a GUI.

**Memory depth after desktop.** Persistent memory is not a prerequisite for the desktop, as long as M2 defines memory-write and tool-call receipt events in schema v2. M3 can then show them, and M4 fills them with a real store.

**ACP server in M4, not earlier.** Nobody needs editors attached until seats and memory are worth attaching to. The ACP *client* (driving Grok Build and other ACP agents) is different, and it lands in M1.

**What would change my mind:** if the Founder's daily pain is "I can't see what's happening" more than "I can't hand work between seats", a thin read-only desktop viewer over schema v1 could run in parallel with M2. I would keep it read-only, with no status colors.

---

## 3. Subscription table (all lanes)

**Where the list comes from.** No single doc on `main` enumerates exactly ten subscriptions. I rebuilt the ten from idea plan §6.2 (model adapters: Kimi, Mistral, DeepSeek, MiniMax, Qwen Cloud, Ollama Cloud, Gemini; agent adapters: Claude, Codex), §6.3 (forbidden paths, which add Z.ai GLM Coding Plan) and the subscription-lanes brief. "Ollama local" is in §6.2, but it is free local software, not a paid subscription, so it is not counted. GitHub Copilot, OpenRouter and Groq are registry stubs from the brief's "other" section. There is no evidence that they are Mike's paid plans, so they are not counted either. **The Founder should confirm the list (D-R1).**

**Row 11: Grok (xAI).** **Founder added this on 2026-09-24.** It is not one of the ten in the original subscription-lanes brief. The brief mentions xAI only as a one-line "other" row (lane C, "Consumer SuperGrok ≠ API"). That row is now incomplete, because xAI ships an official coding agent (Grok Build) that SuperGrok and X Premium+ subscribers sign into (details below).

**Method.** I re-fetched every source below myself on **2026-09-24 between 23:27 and 23:50 EDT** (2026-09-25 UTC), using curl and a web fetch. "VERIFIED" means I found the quoted text on the live page myself. "UNVERIFIED" means I could not confirm it today. Where a term is unconfirmed, the lane stays at its most restrictive value (fail-closed).

| # | Provider / plan | Lane (registry status) | Terms evidence (read 2026-09-24 EDT) | Wiring effort (est.) | Milestone |
| --- | --- | --- | --- | --- | --- |
| 1 | **Ollama Cloud** (paid plan) | `allowed-direct` for interactive use; headless **denied by default** until the Founder records permission (D-M1-3) | [docs.ollama.com/api/authentication.md](https://docs.ollama.com/api/authentication.md): "Direct cloud inference at `https://ollama.com/api` and `https://ollama.com/v1` requires an API key. No Ollama installation or local server is required." [docs.ollama.com/cloud.md](https://docs.ollama.com/cloud.md): "We do not use them to train models." [ollama.com/terms](https://ollama.com/terms) (Last updated: May 2026): "You may not: … Use automated means to access our services without permission". No clause on third-party clients. **VERIFIED** for interactive use with a key. Headless is denied by default, because the Terms require permission for automated access (D-M1-3). | 1 act. Not a pi-ai built-in; uses OpenAI-compat custom provider (pi-check §1). Live model list from `/api/tags`. | **M1 (first)** |
| 2 | **Kimi Code** (membership) | `allowed-direct`, honest UA required | [kimi.com/code/docs/en](https://www.kimi.com/code/docs/en/): "Subscribers can also obtain an API Key to integrate Kimi Code's model capabilities into third-party development tools and platforms." Same page: "Tampering with the client identifier (User-Agent) is considered a violation and may result in suspension of membership benefits." **VERIFIED** | Done in M0 (A3) | M0 (seat use in M1) |
| 3 | **Mistral Pro** (Le Chat / Vibe) | `allowed-direct` | [docs.mistral.ai/vibe/code/cli/api-keys-profiles](https://docs.mistral.ai/vibe/code/cli/api-keys-profiles): "Mistral plans include monthly usage that is shared across Studio, the API, and Vibe Code." [docs.mistral.ai/admin/billing-usage/subscriptions](https://docs.mistral.ai/admin/billing-usage/subscriptions): "Your Mistral plan controls access across Vibe, Studio, and the API." **VERIFIED** (the billing model is API-key shared usage; third-party harnesses are not named, and not banned). | ≤0.5 act (pi-ai built-in `mistral`) | M1 |
| 4 | **DeepSeek** (PAYG; no coding subscription found) | `allowed-direct` | [api-docs.deepseek.com](https://api-docs.deepseek.com/): "The DeepSeek API uses an API format compatible with OpenAI/Anthropic…" and "If you use tools like Claude Code, GitHub Copilot, or OpenCode, you can use DeepSeek as the backend model directly". [Privacy Policy](https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html) (Last Update: Feb 10, 2026): "we directly collect, process and store your Personal Data in People's Republic of China." **VERIFIED** | ≤0.5 act (pi-ai built-in `deepseek`) plus a per-repo data-residency gate | M1 |
| 5 | **Google** (Google AI / Antigravity subscription) → **Gemini API auth key** | Subscription sign-in: `forbidden`. Gemini API key: `allowed-direct` | [antigravity.google/docs/faq](https://antigravity.google/docs/faq): "Using third party software, tools, or services to access Antigravity is a violation of our Terms of Service … If you would like to use a third party coding agent with Gemini, we recommend using a Gemini Enterprise or Google AI Studio API key." [ai.google.dev/gemini-api/docs/api-key](https://ai.google.dev/gemini-api/docs/api-key) (page last updated 2026-09-23 UTC): "On September 2026 : the Gemini API will reject requests from standard keys . You must migrate to auth keys". **VERIFIED** | ≤0.5 act (pi-ai built-in `google`); auth key only | M1 |
| 6 | **Anthropic Claude Pro/Max** | `allowed-via-vendor-agent` (unmodified Claude Code). Subscription over custom HTTP: `forbidden` | [code.claude.com/docs/en/legal-and-compliance](https://code.claude.com/docs/en/legal-and-compliance.md): "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users." Also: "Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription". Also: "Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK." **VERIFIED** | Done in M0 (A5) | M0 (seat use in M1; parallel-use risk in M2) |
| 7 | **OpenAI ChatGPT Plus/Pro** → Codex | `allowed-via-vendor-agent` (Codex app-server). Token replay: `forbidden` | [developers.openai.com/codex/auth](https://developers.openai.com/codex/auth) (redirects to learn.chatgpt.com/docs/auth): "Codex supports two ways for a person to sign in … Sign in with ChatGPT for subscription access". [learn.chatgpt.com/docs/app-server](https://learn.chatgpt.com/docs/app-server): "Use it when you want a deep integration inside your own product: authentication, conversation history, approvals, and streamed agent events." Same page: "If you are automating jobs or running Codex in CI, use the Codex SDK instead." **VERIFIED** | Done in M0 (A6) | M0 (seat use in M1) |
| 8 | **MiniMax Token Plan** | `interactive-only` (kept fail-closed) | [platform.minimax.io/docs/token-plan/intro](https://platform.minimax.io/docs/token-plan/intro): Subscription Key "is not interchangeable with pay-as-you-go API Keys". Today's pages list integrations for Claude Code, Cursor, TRAE, Hermes Agent, OpenClaw, Pi and "Other Tools". The planning record's MM-37 quote ("designed for individual, interactive developer use") **was not found on the pages I fetched today → UNVERIFIED**. The entry stays `interactive-only` until re-confirmed. Founder ruling 13 (Appendix R): non-sensitive repos only. | 0.5 act (pi-ai built-in `minimax`), plus the shared interactive-mode gate | M1 |
| 9 | **Alibaba Cloud Coding Plan** (Qwen Cloud) | `interactive-only` | [alibabacloud.com/help/en/model-studio/coding-plan](https://www.alibabacloud.com/help/en/model-studio/coding-plan) (Last Updated: Sep 11, 2026): "This plan is for interactive use in programming tools such as Claude Code, Qoder, Qoder CN, and OpenClaw. Do not use the plan's API key for automated scripts, application backends, or other non-interactive scenarios." **VERIFIED** | 0.5 act (pi-ai `qwen-token-plan*` catalog, endpoint match to confirm at build time) | M1 |
| 10 | **Z.ai GLM Coding Plan** | `forbidden` in the MAD loop | [docs.z.ai/devpack/quick-start](https://docs.z.ai/devpack/quick-start): "The GLM Coding Plan is strictly limited to use within officially supported tools and products." [docs.z.ai/devpack/faq](https://docs.z.ai/devpack/faq): "The subscriber shall not use the subscription benefits in any unsupported tools or scenarios." [docs.z.ai/devpack/usage-policy](https://docs.z.ai/devpack/usage-policy): "Use in unsupported tools may result in restricted benefits." **VERIFIED** | 0 acts. An option to drive an allowlisted tool (for example unmodified Claude Code pointed at Z.ai) as a vendor agent is **UNVERIFIED** as permitted, so it stays off unless the Founder decides otherwise (D-R3). | Not wired (parked) |
| 11 | **Grok (xAI)**. **Founder-added 2026-09-24; not in the original brief** | (a) xAI API key: `allowed-direct`. (b) Consumer SuperGrok / X Premium+ sign-in reused by a third-party client: `forbidden` (fail-closed; terms UNVERIFIED). (c) Grok Build (official CLI): `allowed-via-vendor-agent` | (a) [docs.x.ai/build/overview](https://docs.x.ai/build/overview.md): "`grok-4.7` … is available directly on the xAI API. Drop it into your own agent loop, IDE integration, or coding tool." pi-ai 0.87.1 has a built-in `xai` provider (base `https://api.x.ai/v1`, env `XAI_API_KEY`; I inspected the published package on 2026-09-24). **VERIFIED**. (b) [x.ai/legal/terms-of-service](https://x.ai/legal/terms-of-service) (Consumer, Last Updated: September 11, 2026) and [AUP](https://x.ai/legal/acceptable-use-policy) (Effective: August 14, 2026): no clause permits third-party clients to use consumer-subscription sign-in. The AUP bars "bypassing our systems or protective measures". pi-ai also ships an xAI OAuth device-code flow whose scope includes `grok-cli:access`; **MAD must not use it**. Status: **UNVERIFIED → treated as forbidden**. (c) [x.ai/news/grok-build-cli](https://x.ai/news/grok-build-cli) (May 25, 2026): "Now in early beta for all SuperGrok and X Premium Plus subscribers — Grok Build is a new coding agent that runs right from your terminal." [docs.x.ai/build/cli/headless-scripting](https://docs.x.ai/build/cli/headless-scripting.md): "`grok agent stdio` … runs Grok as an ACP agent over JSON-RPC on stdin/stdout", and its ACP example "assumes `grok` is already authenticated locally, or `XAI_API_KEY` is set." **VERIFIED** that it exists and has ACP and headless modes. | (a) ≤0.5 act; (c) 1 act (generic ACP-client adapter, reusable for other ACP agents) | M1 |

**Terms flags the Founder should see:**

- **xAI AUP.** It bars "Using the Service or any Output to develop (or assist anyone in developing) machine learning models or any products or services that compete with SpaceXAI". madc is a personal, local-first agent platform. Whether that counts as "competing" is a legal read I cannot make. **UNVERIFIED; Founder check (D-R4).**
- **Claude parallel use.** "Ordinary, individual usage" is the stated assumption behind Pro/Max limits. M2 parallel seats on Claude Code should be rate-capped per seat.
- **Codex automation.** OpenAI points CI and automation at the Codex SDK and API keys, not the app-server. madc headless runs on a ChatGPT sign-in should prefer an API key (credential class by mode, Founder ruling 12).
- **Gemini.** Standard keys stop working in September 2026 per Google's page. Auth keys only.
- **DeepSeek.** Data is stored in the PRC. It needs a per-repo allowlist (idea plan open decision 5).

---

## 4. Innovation: mechanism stolen + MAD evolution per milestone

No clones and no CRUD-ware. Each row names the public mechanism and what MAD does that the source does not. All URLs were reachable on 2026-09-24.

| Milestone | Steal (public mechanism) | MAD evolution |
| --- | --- | --- |
| M1 | **ACP as a universal agent socket.** [Agent Client Protocol](https://agentclientprotocol.com/overview/introduction) (created by Zed; [repo](https://github.com/agentclientprotocol/agent-client-protocol)). Grok Build `grok agent stdio` ([docs](https://docs.x.ai/build/cli/headless-scripting.md)), [Copilot CLI ACP server](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server), [Zed external agents](https://zed.dev/docs/ai/external-agents). | One registry-gated **ACP client** in the engine turns every ACP-speaking vendor agent into a lane. Each one gets a registry entry, a fail-closed check before spawn, and a `servedModel` receipt. Where the agent does not report a model, the receipt records the requested model with `vendorReported: false`. It never guesses. |
| M1 | **Terms as data.** Subscription-lanes brief + ADR-0003 (MAD's own). Codex app-server's `account/rateLimits/*` shape (brief §5). | **Terms with a freshness clock.** Each registry entry carries `verifiedAt` + `termsUrl`. When an allow entry is more than 30 days old, the router **denies** it until it is re-verified or the Founder records a per-entry override, and `madc doctor` lists it. An expired `forbidden` stays forbidden (D-M1-6). |
| M1 | **Credential class by mode** (planning record ruling 12). Alibaba's `sk-sp-` vs `sk-` split. | **Engine-verified presence.** A client's `mode: "interactive"` claim is never enough on its own. For interactive-only plans the engine opens the controlling terminal itself, requires a human keypress there, and re-checks the terminal on every turn. Anything detached (cron, CI, daemons) fails closed. Plan keys and PAYG keys are separate registry ids. The chain records the claim and the check result, so an audit can show that no interactive-only plan served a turn without a terminal present. (Residual risk: a process inside the Founder's own terminal could fake the keypress.) |
| M2 | **Subagents with their own context and tools.** [Claude Code subagents](https://code.claude.com/docs/en/sub-agents): "Each subagent runs in its own context window with a custom system prompt, specific tool access, and independent permissions." Grok Build [subagents](https://docs.x.ai/build/features/subagents) and [worktrees](https://docs.x.ai/build/features/worktrees). [git worktree](https://git-scm.com/docs/git-worktree). | Seats are **not** anonymous subagents. They are named, persistent and cross-vendor (a Codex-backed seat hands to a Claude Code-backed seat). Handoffs are **hash-linked in both directions**: the source chain records the target thread's genesis hash, and the target's `session.open` records the source handoff hash. Each parallel seat gets its own worktree, and the worktree HEAD SHA is written into the chain at open and close. |
| M2 | **Approvals as server requests** (Codex app-server lifecycle: "approvals, and streamed agent events", [docs](https://learn.chatgpt.com/docs/app-server)). [Claude Code hooks](https://code.claude.com/docs/en/hooks) blocking semantics. | **Founder decision inbox.** Seats may only escalate a typed `founderDecision` that carries a recommended default and evidence refs. Everything else must be resolved seat-to-seat or denied by policy. This is the D-table convention from these plans, made executable. |
| M3 | **Append-only verifiable logs.** [Certificate Transparency, RFC 6962](https://www.rfc-editor.org/rfc/rfc6962) (Merkle tree heads and inclusion proofs). MadBridge's hash-chained ledger (idea plan §8). | **Evidence-bound widgets.** Every widget's data carries an `evidenceRef` (session path + seq + hash, or git SHA, or servedModel receipt). The renderer refuses a success state without a verified ref, so green is earned and never decorative. Periodic Merkle checkpoints over session chains let the desktop verify quickly without replaying every line. |
| M3 | **One engine, many windows.** Codex app-server powering rich clients; [`opencode serve`](https://opencode.ai/docs/server/); omp "same engine, four wrappers" ([repo](https://github.com/can1357/oh-my-pi)). | The desktop is a protocol client only, the same as the CLI (the import rule extends to it). No agent logic in the UI. |
| M4 | **Tiered agent memory.** [MemGPT paper](https://arxiv.org/abs/2310.08560); [Letta memory blocks (core memory)](https://docs.letta.com/guides/agents/memory-blocks). [Claude Code memory](https://code.claude.com/docs/en/memory) hierarchy; [AGENTS.md](https://agents.md/). | **Provable memory.** Each memory write is a chain event that records which seat, turn and served model wrote it. Seats keep private core memory. Shared knowledge lives in an evidence-tagged findings log that seats *pull* deliberately. There is no passive push, because Appendix R amendment 2 rejects passive shared graphs on prompt-injection grounds. |
| M4 | **MCP** ([spec 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25)). ACP [extensibility `_meta`](https://agentclientprotocol.com/protocol/extensibility). ACP translators [codex-acp](https://github.com/agentclientprotocol/codex-acp), [claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp). | **Per-seat MCP** with trust manifests and a registry-style status per server. The **ACP server adapter** exposes seat choice and servedModel receipts to editors through `_meta`, so a Zed session keeps MAD's evidence trail. |
| M5 | npm bin packaging (M0 `packages/cli` bin); Pi's `--ignore-scripts` supply-chain guidance (pi-check §4). | Install with `doctor` as the acceptance gate. The install is not "done" until `madc doctor` verifies registry freshness, keychain access and one mock turn's hash chain. |

---

## 5. Not in scope (whole roadmap unless noted)

- Build Room, MadBridge, FounderOS changes, or any repo other than `MADVenturesLLC/MADC`.
- Mobile apps and multi-user teams (v1 non-goals).
- An IDE or code editor. The desktop is a window onto seats, not an editor.
- Hosted cloud service; model training.
- Any access path a provider's terms forbid, including: Claude subscription outside unmodified Claude Code; ChatGPT token replay; Antigravity or Gemini sign-in in madc; Z.ai Coding Plan in the MAD loop; consumer Grok sign-in reused outside xAI's own clients; spoofed User-Agents.
- Vendoring or forking OpenCode, Hermes, omp, Claude Code, Codex or Grok Build.
- Account rotation at usage limits (planning record: Ghostex SKIP, terms risk).
- Changing branch protection or rulesets.
- Publishing to npm before the Founder un-parks it.

---

## 6. Roadmap-level Founder decisions

| # | Decision | Recommended default |
| --- | --- | --- |
| D-R1 | Confirm the ten paid subscriptions (my reconstruction in §3) plus Grok as #11. | Accept §3 as the list; the Founder corrects any row. |
| D-R2 | Order: M2 (multi-seat) before M3 (desktop)? | **Yes**, per §2. |
| D-R3 | Z.ai via an allowlisted vendor tool (for example unmodified Claude Code on Z.ai's endpoint)? | **No** until Z.ai terms clearly cover a tool driven by another program; stays `forbidden`. |
| D-R4 | xAI AUP "compete" clause: acceptable risk for a personal, local-first platform? | Founder reads the clause; until then wire only the xAI API **key** path and Grok Build as a vendor agent, both of which xAI documents for use in your own tools. |
| D-R5 | Un-park npm to reserve `madc` at `0.0.0` now (one tiny act), ahead of M5? | **Yes**. The name was free on 2026-09-24 and could be taken. |
| D-R6 | Desktop stack (GPUI vs Tauri) owner and timing. | Surface Architect recommends during M2; Founder rules before M3-A0. |

---

## 7. Sources read for this roadmap

On `main` @ `8ba4a6e` (docs unchanged at `6a7266a`, which added only `packages/engine` via PR #7): `README.md`, `docs/plan/README.md`, `PLAN-madc-M0-build-plan.md`, `PLAN-madc-idea-plan-v2.md`, `PLAN-MAD-AGENT-planning-record.md` (ledgers OLL, CC, CX, MM, QW, GM, AG; Appendix R), `subscription-lanes-2026-09-24.md`, `pi-check-2026-09-24.md`, `docs/adr/ADR-0001..0003`, `PIN-madc-M0-protocol-messages.md`, `PIN-madc-M0-seat-format.md`, `docs/policy/CODE-ADVISORIES.md`, `packages/registry/src/{catalog,types}.ts`, PR #7 (M0-A2, merged during this pass).

Live web sources: listed inline in §3 and §4, all fetched 2026-09-24 EDT.

*End of roadmap.*
