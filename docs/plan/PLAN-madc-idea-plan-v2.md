# Your Own Agent Platform: Idea Plan

*Prometheus · Sep 24, 2026 · Status: v2, corrected by Surface Architect, Sep 24 2026. Idea plan, not a build plan. Daedalus writes the build plan only after Mike says so after the Console MVP call.*

## 1. The idea in one sentence

You own one engine that runs on your machine. It seats your named agents, and each agent can be backed by any of your ten subscriptions: either your own agent loop calling a model directly, or a vendor's agent (Claude Code or Codex) that your platform drives. A CLI and a desktop app are two windows onto that same engine, and every session leaves a record you can replay.

## 2. How your ideas fit together

| What you've said you want | Where it goes in the plan |
|---|---|
| "My own Claude Code / Oh My Pi / Hermes" | **The engine** (the agent loop, tools, sessions, providers) and **the CLI**, which is its first window |
| "My own Claude Desktop / Codex app" | **The desktop app**, a second window onto the same engine |
| "Like Ghostex": running Claude Code, Codex and others side by side | Not a separate product. Your platform needs **agent adapters** to use your Claude and Codex subscriptions legally, and once it has them, running outside agents side by side comes for free. |
| "All my subscriptions on day one" | **The provider registry**: ten providers as config entries with explicit status (allowed-direct, allowed-via-vendor-agent, interactive-only, or forbidden). Day one **wires three**; the other seven stay config after M0. |
| Your roster (Prometheus, Daedalus, Hephaestus…) | **The differentiator / the wedge**: named seats as first-class objects, handoffs between them, and replayable records |
| Build Room, MadBridge | **Outside this product.** Each can plug in later (see section 8), and neither owns it. If the engine ever runs inside Build Room, it runs as a worker under the Gateway. |

The biggest simplification is that your Cipher brief treats the "harness" (layer A) and the "Ghostex-style workspace" (layer B) as two products. They're one product. The agent adapters you need for your subscriptions are the same thing as the workspace's ability to run outside agents.

## 3. The problem

- Every agent you use today belongs to someone else. Claude Code only runs Claude. Codex only runs OpenAI. Each has its own sessions, memory and settings, and none of them knows about your roster.
- You pay for about ten AI subscriptions, and no single tool can use all of them. Each has different rules about which tools may use it.
- Your way of working, with named agents in fixed roles handing work to each other, exists only as a convention across separate chats. No tool treats it as a real feature.

## 4. Who feels it

You first. Later, possibly MAD builders, and eventually other people who pay for several AI plans and run more than one agent. The design target is one person, you, using it daily. It is not a team product in v1.

## 5. Non-goals (v1)

- Not Build Room. It isn't a control plane, and it doesn't change Build Room's frozen contracts.
- Not MadBridge. It doesn't replace MadBridge's policy or attestation role.
- Not an IDE or code editor. It works alongside your editor.
- Not a clone. It takes mechanisms from Claude Code, Codex, omp, Hermes and Ghostex, and it doesn't copy their code or UI. Forking OpenCode or Hermes is rejected.
- No mobile app and no multi-user teams in v1.
- No model training and no hosted cloud service. It's local-first.
- It never uses an access path a provider's terms forbid. See the forbidden-paths list in section 6.3.

## 6. The mechanism

### 6.1 The engine is a local server
One program runs in the background on your machine and holds the agent loop, tools, sessions, memory and providers. The CLI and the desktop app contain no agent logic. They connect over one protocol. This is how the products you admire work: Codex's app server behind its CLI, IDE and desktop app, `opencode serve`, Hermes' single core, and omp's "same engine, four wrappers."

**Named protocol.** The engine's native client protocol is modeled on the Codex app server's thread/turn/item message shapes. ACP (Agent Client Protocol) is an adapter layer for editors, not the native core. This changes ADR-07 in the planning record (which currently frames RPC as ACP v1).

**Runtime.** A clean TypeScript core that runs on Bun and on Node 22.19+, with a dual-target test matrix. omp-compatible model-list and session-import seams, with no omp code vendored (ADR-01 hybrid). Binary name: `madc` (npm and crates.io reservation pending Founder go-ahead).

### 6.2 Two kinds of adapters
- **Model adapters.** Your own agent loop calls a model directly. These cover Kimi, Mistral, DeepSeek, MiniMax, Qwen Cloud, Ollama Cloud, Ollama local and Gemini (through a Gemini API key). Most expose OpenAI- or Anthropic-compatible endpoints, so two generic adapters should cover most of them. Confirm this for each provider.
- **Agent adapters.** Your platform runs the vendor's own agent as a worker: it starts it, sends it tasks, streams its output and records the session. These cover Claude (stock Claude Code on your Pro/Max plan) and Codex (the Codex app server on your ChatGPT plan). Copilot would work the same way through its ACP mode if you add it.

### 6.3 A rules-aware provider registry
Each subscription is a config entry, not code. The registry can say no. Each entry records:
- an explicit **status**: `allowed-direct`, `allowed-via-vendor-agent`, `interactive-only`, or `forbidden`, with the source quote;
- how it connects: a direct call, or driving a vendor agent;
- which formats it speaks: OpenAI-compatible, Anthropic-compatible, or native;
- whether it's interactive only (MiniMax Token Plan and Alibaba Coding Plan) or allowed in scripts and headless runs;
- the honest client identity it must send (Kimi requires this);
- quota and rate-limit signals, so the router can switch to another provider instead of failing.

The router enforces these rules on its own. A headless job never touches an interactive-only plan, and Claude subscription traffic only ever goes through real Claude Code. Adding an eleventh subscription is a config change.

**Forbidden paths** (facts and citations in `/workspace/briefs/subscription-lanes-2026-09-24.md`):
- **Z.ai GLM Coding Plan in a private harness.** Quote: "The GLM Coding Plan is strictly limited to use within officially supported tools and products." GLM reaches the engine via Ollama Cloud, Alibaba Token Plan, or Z.ai pay-as-you-go API instead.
- **Antigravity / Gemini sign-in in third-party tools.** Use a Gemini API key instead.
- **Claude subscription outside real Claude Code.** Unmodified Claude Code only.
- **ChatGPT tokens replayed in a custom client.** ChatGPT Plus/Pro access stays on official Codex clients and the Codex app server.

**Day one wires three, not ten.** M0 proves the engine on real repos with:
1. one **direct-key** provider (Ollama Cloud or Kimi Code);
2. the **Claude Code** seat (agent adapter);
3. the **Codex** seat (Codex app server).

The other seven providers are registry config entries after M0, not day-one wiring.

### 6.4 Named seats (the differentiator / the wedge)
A session opens with a seat, for example "Prometheus," "Daedalus" or "Hephaestus." Seats are first-class objects. Each seat has:
- a role and standing instructions;
- a pinned model;
- its own memory;
- its own allowed tools and permissions (policy);
- typed handoffs to other seats;
- a preferred backing, such as your own loop on Kimi, or Claude Code on your Max plan, with fallbacks;
- a hash-chained record of the served model per turn.

Work can be handed from one seat to another with its context attached. Every session, whichever seat or backing ran it, is written to one record you can search, resume and replay.

### 6.5 Two windows
- **CLI.** Binary name `madc`. An interactive terminal agent, a headless one-shot mode (prompt in, JSON out, exit code), and commands for sessions, providers, seats and doctor/status. It should feel like omp.
- **Desktop app.** The same sessions and seats with a visual layer: agents running side by side, handoffs you can see, a review inbox, and session search.

## 7. Why this is innovative and not obvious

- Claude Code and Codex each run only themselves. OpenCode and omp run many models but only their own loop. Ghostex runs many agents but has no brain of its own. **Your platform is the only design here that does all three: many models through your own loop, vendor agents under your control, and a roster of named seats across both.**
- The rules-aware registry turns "I pay for ten plans" from a liability (breaking a vendor's terms and risking suspension) into a real feature. Nothing we looked at treats subscription terms as data the router enforces, including an explicit forbidden status.
- Named seats with handoffs and replayable records turn the way you already work into the product itself. That roster is the wedge.

What's obvious and not a moat: the agent loop, file-edit tools, and a TUI. Those are commodity. Take them or build on them, and spend your originality on 6.3 and 6.4.

## 8. Fit with your existing work

Based on the planning record's MAD assets survey and a read-only GitHub check on 2026-09-24:
- **New repo.** This doesn't belong inside `founder-os-build-room` or `madventures-tui`. Build Room and MadBridge stay outside the product.
- **Build Room.** Could later host this engine as one worker under the Gateway. It doesn't own it. A commit is not a merge; merges are Founder-only and name the exact head SHA.
- **MadBridge (`madventures-tui`).** Already runs on Bun, OpenTUI and React, and has a hash-chained SQLite ledger (`verify-ledger`). That ledger pattern supports the session-record idea in 6.4. It is **not** the main source of reusable policy packages.
- **Reusable policy packages live in Build Room's Evolve Pack** (Founder act 2026-09-13, mechanism steal not clone; lanes A–E landed). Reuse means publishing versioned packages the harness consumes, not depending on the Build Room repo across venues.
- **OpenCodex libraries.** Mike commissioned "OpenCodex to MAD Mechanism Extract Pack v0" (Act GLM-20260921-OPENCODEX-EXTRACT-V0) on 2026-09-21 on repo `founder-os-build-room`, base `d0dc2f9d1a1f147d4c9283ce03d17fff06e41a56`, branch `builder/opencodex-extract-v0`: packages `provider-tool-compat` and `route-evaluator`, optional `subagent-fallback-chain`, pure libraries only. **Read-only GitHub check (2026-09-24, cursor-github, owner MADVenturesLLC):** the base SHA resolves on `founder-os-build-room`; branch `builder/opencodex-extract-v0` was **not** present; no OpenCodex-related PR was found merged or open. Status: **UNVERIFIED / not landed on remote** (matches the planning record: extract act commissioned, builder pending, packages absent from accessible clones). Treat the assumed interfaces as the target contract; consume them later as versioned published packages.
- **FounderOS** stays the control plane for decisions. This product could eventually log decisions there.

## 9. Research evidence (from your Sep 24 subscription brief and earlier research)

- **Kimi Code:** subscribers get API keys for third-party tools, and changing the User-Agent is a violation. (kimi.com/code/docs)
- **Mistral Pro:** "Mistral plans include monthly usage that is shared across Studio, the API, and Vibe Code." (docs.mistral.ai, Vibe API keys page)
- **DeepSeek:** pay-as-you-go only. Third-party agents are explicitly supported, and data is stored in China. (api-docs.deepseek.com; DeepSeek privacy policy)
- **Codex on a ChatGPT plan:** only through official clients or the app server, which is built for "a deep integration inside your own product." (developers.openai.com/codex/auth; learn.chatgpt.com app-server docs)
- **Claude Pro/Max:** unmodified Claude Code only. (Prior finding carried in your brief / CC ledger.)
- **Gemini / Antigravity sign-in:** forbidden for third-party tools, so use a Gemini API key. (Prior finding; GM/AG ledgers.)
- **Z.ai GLM Coding Plan:** "The GLM Coding Plan is strictly limited to use within officially supported tools and products."; custom harness forbidden on Coding Plan quota. (docs.z.ai; subscription-lanes brief)
- **MiniMax and Alibaba coding / token plans:** third-party use is allowed, but interactive only. (Prior finding; MM/QW ledgers.)
- **Architecture precedent:** Codex app server (OpenAI), `opencode serve` (OpenCode, MIT), Hermes Agent single core (Nous Research, MIT), and omp's "same engine, four wrappers" (github.com/can1357/oh-my-pi, MIT).

## 10. Risks

1. **Scope.** Ten providers, two agent adapters, a CLI and a desktop app is a lot for one person. The mitigation is day-one wiring of three only (direct-key + Claude Code seat + Codex seat), keep the rest as config, and push the desktop app until after the CLI proves itself.
2. **Priority (closed).** FounderOS stays first; this build does not start until after the Console MVP call. See Decided.
3. **Fragile agent adapters.** Driving Claude Code and Codex depends on their output formats and protocols, which can change without notice. Codex's app server is an official interface, so it's the safer of the two.
4. **Terms can change.** Vendor rules shift every few months. The registry makes a change a config update, but someone has to re-check the rules monthly.
5. **Data location.** DeepSeek stores data in China. Decide which repos may go there.
6. **Secrets.** Provider keys live on one machine. They belong in the OS keychain only, never in config, prompts or logs.
7. **The "one more feature" trap.** An agent loop is easy to start and slow to make reliable (edits, context trimming, resume). Pick a foundation instead of writing everything from scratch. The one-day Pi check is done (see Decided / Open decisions); foundation is recommended hybrid, pending Founder ruling.
8. **Time-sensitive provider facts.** Re-verify before write: Qwen DashScope-domain cutoff **2026-09-30** (QW-01..08); Gemini **standard-key rejection** (GM-02 — from September 2026 the Gemini API rejects standard keys; M0 uses auth keys); Z.ai GLM-5.3-Flash promo ends **2026-10-07**.

## 11. Decided (Founder, Sep 24, 2026)

1. **Priority.** FounderOS stays first. The build starts after the Console MVP call. Only the plan correction (this file) and the one-day Pi check run now. Nothing is commissioned, built, or sent to Daedalus until Mike says so after the Console MVP call.
2. **ADR-01 omp (from planning-record ruling draft).** HYBRID: clean MAD core; omp-compatible catalog-shape and session-import seams; no omp code vendored.
3. **Antigravity / Google subscription quota.** EXCLUDED. Gemini API key (auth keys) in M0.
4. **Binary name.** `madc` (registry reservation is a separate Founder go).
5. **Roster as wedge.** Named seats with role, pinned model, memory, tools, policy, typed handoffs, and a hash-chained served-model record per turn.
6. **Pi check.** Complete (`/workspace/briefs/pi-check-2026-09-24.md`). Foundation **recommended: hybrid, pending Founder ruling** (details under Open decisions).

## 12. Open decisions for you

1. **Product display name** (CLI binary is already `madc`).
2. **Foundation:** **recommended: hybrid, pending Founder ruling.** The one-day Pi check (`/workspace/briefs/pi-check-2026-09-24.md`) tested `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core` **0.87.1** (upstream moved from `@mariozechner` to `earendil-works/pi` in May 2026; the old names are deprecated at 0.73.1). Verdicts: provider coverage **PASS**; permission gate **PARTIAL** (`beforeToolCall` deny hook exists and blocked execution in testing, but there is no sandbox); served model id **PASS** (`responseModel`); Bun + Node **PASS**, with the engine floor at **Node 22.19+**; release pace **PARTIAL** (about 23 npm publishes in 3 months, still 0.x). Recommendation: pin `pi-ai` behind MAD provider interfaces; MAD owns the loop, seats, policy, hash-chained sessions, MCP and subagents. omp's SDK is Bun-only, so it is a poor fit for the dual-runtime engine. Forking OpenCode or Hermes remains rejected.

3. **Desktop technology** (for example Tauri, Electron, or native). Surface Architect's call, with your approval.
4. **Gemini:** confirm paying for a Gemini API key / auth key (Antigravity sign-in cannot be used).
5. **DeepSeek:** which repos is it allowed to see?
6. **Day-one direct-key pick:** Ollama Cloud or Kimi Code.

## 13. Gate sequence

1. **Priority** — decided (FounderOS first; build after Console MVP call).
2. **Corrected plan** — this file.
3. **Pi check** — done (`/workspace/briefs/pi-check-2026-09-24.md`); foundation recommended hybrid, pending Founder ruling.
4. **Founder ruling** — name, foundation, roster as wedge (paste-ready ruling lives in planning-record Appendix R).
5. **Daedalus build plan** — only on Mike's word after the Console MVP call.
6. **Hephaestus build** — per phase commission. A commit is not a merge; merges are Founder-only and name the exact head SHA.

## 14. Handoff sentence for Daedalus

> "Plan a MAD-owned, local-first agent platform: one engine running as a local server with a CLI (`madc`) and a desktop app as thin clients. Native client protocol modeled on Codex app server thread/turn/item; ACP as editor adapter (amends ADR-07). Model adapters behind a rules-aware provider registry with explicit allowed-direct / allowed-via-vendor-agent / interactive-only / forbidden status per subscription; agent adapters for stock Claude Code and the Codex app server. Day one wires three: one direct-key provider (Ollama Cloud or Kimi Code), the Claude Code seat, and the Codex seat; the other seven stay config after M0. Differentiator is named seats (role, pinned model, memory, tools, policy, typed handoffs, hash-chained served-model record). Foundation recommended hybrid (pin pi-ai behind MAD interfaces; MAD owns the loop), pending Founder ruling. Do not start until Mike says so after the Console MVP call."
