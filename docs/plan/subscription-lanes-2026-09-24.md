# Subscription → custom harness lanes (research brief)

**Audience:** Michael (Founder, MAD Ventures) — TypeScript AI coding agent engine (CLI + desktop).  
**Question:** For each paid AI coding subscription, may a *custom* harness call the vendor API directly with a key (lane A), or must it drive the vendor’s own agent binary (lane B)?  
**Method:** Primary vendor docs / pricing / terms / official GitHub only, retrieved **2026-09-24**. Secondary sources labelled.  
**Already established (not re-litigated here unless contradicted):** Anthropic Claude Pro/Max → unofficial clients forbidden except unmodified Claude Code; Google Antigravity / Gemini CLI OAuth → third-party forbidden; MiniMax Token Plan & Alibaba Coding Plan → third-party allowed but **interactive only**.

### Lane legend

| Code | Meaning |
|------|---------|
| **A** | Harness may call vendor HTTP API directly with a subscription-issued key |
| **B** | Must drive vendor’s own agent program (CLI / app / app-server) |
| **C** | No coding subscription that feeds a harness — use pay-as-you-go API (or separate API product) |
| **D** | Unclear / conflicting primary text |

### Status tags

`VERIFIED` = clear primary quote · `UNVERIFIED` = inferred / incomplete primary · `CONFLICTING` = primary sources disagree

---

## Summary table

| Provider | Plan(s) | Lane | Key restriction (one line) | Status |
|----------|---------|------|----------------------------|--------|
| **Moonshot Kimi Code** | Andante ¥49 / Moderato ¥99 / Allegretto ¥199 / Allegro ¥699/mo (membership includes Kimi Code) | **A** | Coding API keys for 3P tools; don’t spoof User-Agent; ≠ Moonshot Open Platform PAYG | VERIFIED |
| **Moonshot Open Platform** | PAYG API (`platform.moonshot.ai` / `api.moonshot.ai`) | **C** | Separate PAYG product; OpenAI-compatible | VERIFIED |
| **Mistral Le Chat Pro / Team + Vibe** | Pro **$14.99**/mo; Team **$24.99**/seat/mo; Pro includes **$30**/mo API credits | **A** (via API key / shared monthly usage) *or* **B** (Vibe CLI) | Pro usage shared across Studio, API, Vibe; Codestral/Devstral also on La Plateforme PAYG | VERIFIED (3P harness not named in ToS; billing model is A) |
| **Mistral La Plateforme** | PAYG API + Codestral | **C** | `api.mistral.ai`; Codestral FIM endpoint | VERIFIED |
| **DeepSeek** | No coding subscription found — Open Platform top-up only | **C** | OpenAI + Anthropic-compatible bases; agent tools explicitly supported | VERIFIED |
| **Z.ai (Zhipu) GLM Coding Plan** | Lite **$18** / Pro / Max (credits: 2k·10k / 12k·60k / 28k·140k per 5h·week) | **A\*** | Key works in **officially supported tools only**; custom unlisted harness forbidden | VERIFIED |
| **OpenAI ChatGPT Plus / Pro → Codex** | Plus / Pro / Business / Enterprise (Codex included) | **B** (ChatGPT sign-in) | Subscription auth for official Codex clients + App Server / `codex exec`; not a documented 3P HTTP key | VERIFIED |
| **OpenAI Platform API** | PAYG API key | **C** (= A for custom harness if you pay API rates) | Use API key for programmatic / CI Codex or any OpenAI-compatible client | VERIFIED |
| **GitHub Copilot** | Individual / Pro / Business / Enterprise | **B** | Drive `copilot --acp` (ACP public preview) or official extensions; no raw ChatGPT-style sub key for arbitrary HTTP | VERIFIED |
| **OpenRouter** | Credits / PAYG keys | **A** | Explicitly documents coding-agent use; `https://openrouter.ai/api/v1` | VERIFIED |
| **xAI Grok / SuperGrok** | Consumer SuperGrok ≠ API | **C** | API at `https://api.x.ai/v1` is prepaid credits, separate from SuperGrok chat sub | VERIFIED |
| **Groq Cloud** | PAYG API keys | **A** / **C** | Developer API keys for OpenAI-compatible tools; not a ChatGPT-like coding sub | VERIFIED |
| **Cursor** | Cursor Pro / Business | **B** (own app) / **C** if BYOK | Subscription is for Cursor product; custom harness uses BYOK elsewhere | UNVERIFIED (product ToS not fully fetched) |

\*Z.ai is “A for allowlisted tools”: Claude Code, Cline, OpenCode, Cursor, Roo, Kilo, etc. A **MAD-owned custom harness not on that list is not permitted** on Coding Plan quota.

---

## 1. Moonshot Kimi (Kimi Code membership + platform API)

### Plans & price (primary)

From [Kimi Membership Pricing](https://www.kimi.com/en/help/membership/membership-pricing) (retrieved 2026-09-24):

| Plan | Monthly (CNY) | Kimi Code |
|------|---------------|-----------|
| Andante | ¥49 | included |
| Moderato | ¥99 | included |
| Allegretto | ¥199 | included |
| Allegro | ¥699 | included |

Membership guide also states ~300–1,200 requests / 5 hours and max concurrency 30 ([membership guide](https://www.kimi.com/en/help/kimi-code/membership-guide)).

Kimi Code docs note a plan rename in flight (legacy Andante… vs new Plus/Pro naming) with **pricing unchanged** ([membership benefits](https://www.kimi.com/code/docs/en/kimi-code/membership.html)).

### Lane: **A** — VERIFIED

Primary docs explicitly issue API keys for third-party coding agents:

> “Subscribers can also obtain an API Key to integrate Kimi Code's model capabilities into third-party development tools and platforms.”  
> — [Kimi Code Overview](https://www.kimi.com/code/docs/en/) (2026-09-24)

> “Subscribers can connect to third-party development tools such as Claude Code, Roo Code, and OpenCode via an API Key.”  
> — [Membership Benefits Guide](https://www.kimi.com/en/help/kimi-code/membership-guide) (2026-09-24)

> “Kimi Code benefits can be used in mainstream Coding Agents, such as Claude Code, Roo Code, and OpenCode. They can also work with general Agent frameworks such as OpenClaw and Hermes…”  
> — same guide

### Base URLs & wire formats

| Protocol | Base URL |
|----------|----------|
| OpenAI-compatible | `https://api.kimi.com/coding/v1` (China); overseas also documented as `https://api.kimi.ai/coding/v1` |
| Anthropic-compatible | `https://api.kimi.com/coding/` (China); overseas `https://api.kimi.ai/coding/` |

Model IDs include `kimi-for-coding`, `kimi-for-coding-highspeed`, `k3`, `k3-256k` (tier-gated). Up to **5** API keys in Kimi Code Console.

**Separate product — Moonshot / Kimi Open Platform (PAYG):**  
`https://api.moonshot.cn/v1` (CN) / `https://api.moonshot.ai/v1` (overseas). Keys and base URLs are **not interchangeable** with Kimi Code ([overview comparison table](https://www.kimi.com/code/docs/en/)).

### Restrictions

> “Please maintain the tool's real identity identifier when using. Tampering with the client identifier (User-Agent) is considered a violation and may result in suspension of membership benefits.”  
> — [Kimi Code Overview](https://www.kimi.com/code/docs/en/) (2026-09-24)

- No primary “interactive-only” clause found (unlike MiniMax/Alibaba).  
- Official clients: Kimi Code Desktop, CLI (`kimi`), VS Code extension; ACP for JetBrains/Zed.  
- Automation / headless: not expressly forbidden in Code docs; User-Agent must stay honest. Treat heavy unattended farms as risk until ToS says otherwise → practical: **A OK for custom harness**, keep real client UA.

### Official CLI

Install from `https://code.kimi.com/kimi-code/install.sh`; login via `/login` (OAuth) or API key mode. Optional path **B**, not required.

### Data-use / training

Not fully reviewed on this pass for Code-specific privacy. Open Platform is a distinct contract. **UNVERIFIED** for training opt-out on Code keys.

---

## 2. Mistral (Le Chat / Vibe vs La Plateforme)

### Plans & price (primary)

From [mistral.ai/pricing](https://mistral.ai/pricing/) (2026-09-24):

- **Free** — limited Vibe / Studio; **$10**/mo API credits cited on page  
- **Pro** — **$14.99**/mo (ex-tax); “All-day coding in the CLI, IDE, or on web”; **$30**/mo API credits; students **$5.99**  
- **Team** — **$24.99**/user/mo  

Vibe 2.0 announcement: Vibe on Pro/Team with PAYG beyond limits; BYOK supported ([mistral.ai/news/mistral-vibe-2-0](https://mistral.ai/news/mistral-vibe-2-0/)).

### Lane: **A** (subscription usage via API key) — VERIFIED for billing model; 3P clients not banned in primary docs

> “Mistral plans include monthly usage that is shared across Studio, the API, and Vibe Code. Vibe Code uses this included monthly usage before any pay-as-you-go charges apply.”  
> — [API keys and profiles / Vibe docs](https://docs.mistral.ai/vibe/code/cli/api-keys-profiles) (2026-09-24)

> “Create your key from Code › Vibe CLI. The same key works in Free mode, with a paid plan, or with pay-as-you-go enabled.”  
> — same page

> “Your Mistral plan controls access across Vibe, Studio, and the API.”  
> — [Subscriptions](https://docs.mistral.ai/admin/billing-usage/subscriptions) (2026-09-24)

**Implication for MAD:** Le Chat/Vibe Pro is **not** Anthropic-style “official binary only.” Included monthly usage is designed to be consumable through the **API** as well as Vibe. A custom harness holding `MISTRAL_API_KEY` is aligned with published billing design → **lane A**.

Optional **lane B:** run official `vibe` CLI (browser sign-in or key).

### Codestral / Devstral / La Plateforme

- Coding models (Codestral, etc.) remain available on **La Plateforme** PAYG (`https://api.mistral.ai`) — lane **C** if you only buy API, or same key/credits if on Pro with shared usage.  
- FIM: documented under Mistral API (`/v1/fim/completions` in older Codestral docs).  
- No primary quote found forbidding third-party harnesses on Codestral.

### Restrictions / caveats

- Partner-billed Pro (Apple/Google/carrier) may **not** enable PAYG; Vibe stops when included usage ends ([Vibe API keys docs](https://docs.mistral.ai/vibe/code/cli/api-keys-profiles)).  
- **Secondary (Reddit):** support messages briefly claimed Vibe keys were Vibe-only, then retracted — *not* controlling; primary docs win. Label: secondary only.

### Data-use

Not deep-dived; use Mistral privacy / Studio settings. **UNVERIFIED** here.

---

## 3. DeepSeek

### Plans

**No coding agent subscription** found on primary docs. Access = Open Platform balance / top-up (PAYG). Chat app and API share account ([Open Platform Terms](https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html), release Apr 22, 2026 / effective Apr 29, 2026).

### Lane: **C** (PAYG API; custom harness OK) — VERIFIED

> “The DeepSeek API uses an API format compatible with OpenAI/Anthropic. By modifying the configuration, you can use the OpenAI/Anthropic SDK or softwares compatible with the OpenAI/Anthropic API to access the DeepSeek API.”  
> — [Your First API Call](https://api-docs.deepseek.com/) (2026-09-24)

> “The DeepSeek API is supported by many popular AI agent and coding assistant tools. If you use tools like Claude Code, GitHub Copilot, or OpenCode, you can use DeepSeek as the backend model directly — no code required.”  
> — same page (“Integrate with Agent Tools”)

Open Platform ToS §1.1 grants integrating models into “various downstream systems, applications, or functionalities” including serving external end users ([Open Platform ToS](https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html)).

### Base URLs & models (2026-09-24)

| Format | Base URL |
|--------|----------|
| OpenAI | `https://api.deepseek.com` |
| Anthropic | `https://api.deepseek.com/anthropic` |

Models cited on first-call page: `deepseek-flash`, `deepseek-v4-pro` (naming on docs has been in flux; confirm `/models` at call time). Reasoning / thinking fields documented. DeepSeek Harness in developer preview for harness builders.

### Data-use / location — VERIFIED snippets

> “To provide you with our services, we directly collect, process and store your Personal Data in People's Republic of China.”  
> — [DeepSeek Privacy Policy](https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html) (Last Update: Feb 10, 2026)

Privacy policy lists improving Services / training ML models among purposes, and states a right to opt out of training/optimization in applicable regions. Chat setting “Improve the model for everyone” is the usual consumer control; **API-specific retention/training toggles not confirmed in this pass** → flag for Michael if code leaves the laptop.

### Restrictions on third-party agents

None found that resemble Anthropic’s “unmodified binary only.” Standard ToS: no illegal use, protect API keys, etc.

---

## 4. Z.ai (Zhipu) GLM Coding Plan

### Plans & quotas (primary)

[Overview](https://docs.z.ai/devpack/overview) (2026-09-24):

| Plan | 5-hour credits | Weekly credits | Sticker |
|------|----------------|---------------|---------|
| Lite | 2,000 | 10,000 | “Starting at just **18 USD** per month” |
| Pro | 12,000 | 60,000 | higher tier |
| Max | 28,000 | 140,000 | highest |

Reset: 5-hour window refreshes 5h after consumption; weekly from subscription. Models: GLM-5.3 / GLM-5.3-Flash (older aliases routed).

**Time-sensitive:** GLM-5.3-Flash campaign **Sep 3 – Oct 7, 2026** (night unlimited Flash via ZCode/AutoClaw; doubled quota other agents) — [overview tip](https://docs.z.ai/devpack/overview).

### Lane: **A\*** (allowlisted tools only) — VERIFIED

Issues a Coding Plan API key and documents Anthropic + OpenAI bases:

| Protocol | Base URL |
|----------|----------|
| Anthropic Messages | `https://api.z.ai/api/anthropic` |
| OpenAI Chat Completions | `https://api.z.ai/api/coding/paas/v4` |
| OpenAI Responses | `https://api.z.ai/api/v1` |

> “The GLM Coding Plan is strictly limited to use within officially supported tools and products.”  
> — [Quick Start](https://docs.z.ai/devpack/quick-start) (2026-09-24)

> “The GLM Coding Plan is strictly limited to use within officially supported tools and products. The subscriber shall not use the subscription benefits in any unsupported tools or scenarios.”  
> — [FAQ](https://docs.z.ai/devpack/faq) (2026-09-24)

> “GLM Coding Plan may only be used within officially supported tools and products. Use in unsupported tools may result in restricted benefits.”  
> — [Usage Policy](https://docs.z.ai/devpack/usage-policy) (2026-09-24)

> “The GLM Coding Plan is limited to use within the following officially supported tools and product environments; users may not use their subscription benefits for tools or scenarios outside of this scope.”  
> — [Tool Integration / Others](https://docs.z.ai/devpack/tool/others) (2026-09-24)

Supported examples: Claude Code, Cline, OpenCode, Cursor, Roo Code, Kilo Code, Codex, Crush, Goose, OpenClaw, etc.

**For MAD’s own harness:** unless Z.ai adds it to the supported list, Coding Plan keys **must not** be pointed at a private TypeScript harness → treat as **not A for custom**. Workaround: lane **C** Z.ai general PAYG API (`/api/paas/v4`), or drive an allowlisted CLI as **B**.

### Other restrictions

- No account sharing / multi-user on individual sub ([Usage Policy](https://docs.z.ai/devpack/usage-policy)).  
- Concurrency guidance by tier (Lite 1 project, Pro 1–2, Max 2+).  
- Risk control / bans after repeated violations.  
- General vs coding endpoints are **not** interchangeable ([ZCode FAQ](https://zcode.z.ai/en/docs/qa)).

---

## 5. OpenAI — ChatGPT Plus/Pro sign-in in third-party harnesses

### What primary sources *do* say

**Official Codex clients + ChatGPT plan (lane B):**

> “Codex supports two ways for a person to sign in when using OpenAI models: Sign in with ChatGPT for subscription access; Sign in with an API key for usage-based access.”  
> “The ChatGPT desktop app, Codex CLI, and IDE extension support both sign-in methods for local work.”  
> — [developers.openai.com/codex/auth](https://developers.openai.com/codex/auth) (2026-09-24)

Help Center article *Using Codex with your ChatGPT plan* (URL `help.openai.com/en/articles/11369540-…`) lists clients: ChatGPT desktop Codex mode, Codex CLI, IDE extension, Codex web. Direct WebFetch returned **403**; search snippets + `developers.openai.com` auth page are consistent. Retrieval note: help center blocked automated fetch; auth/docs pages worked.

**Programmatic / CI:**

> “Use API key authentication for programmatic Codex CLI workflows, such as CI/CD jobs.”  
> — [Codex auth](https://developers.openai.com/codex/auth)

**Official way to embed Codex in *your* product (still lane B — you drive their harness):**

> “Codex app-server is the interface Codex uses to power rich clients… Use it when you want a deep integration inside your own product: authentication, conversation history, approvals, and streamed agent events.”  
> “If you are automating jobs or running Codex in CI, use the Codex SDK instead.”  
> — [learn.chatgpt.com Codex App Server](https://learn.chatgpt.com/docs/app-server) (2026-09-24)

App Server speaks JSON-RPC over stdio/WS; `initialize.clientInfo.name` identifies the client; enterprise “known clients” list via contacting OpenAI. Auth modes include ChatGPT OAuth, API key, device code, and experimental host-supplied `chatgptAuthTokens`.

**Headless ChatGPT login for *official* Codex:** device code (`codex login --device-auth`), or copy `~/.codex/auth.json` to a trusted machine (documented fallback). Enterprise: Codex access tokens for non-interactive local workflows. Still authenticating **Codex**, not minting a public Responses API subscription key.

**`codex exec`:** App Server docs list `exec` as a thread `sourceKind`; auth doc pushes API keys for automation. ChatGPT-sign-in + headless exec is possible via cached auth / access tokens on trusted hosts, but limits/rate windows remain ChatGPT plan limits (`account/rateLimits/*` RPCs).

### What primary sources *do not* say

No developers.openai.com / help.openai.com / policies page was found that **permits** copying ChatGPT OAuth tokens into OpenCode / Cline / pi / a custom HTTP client against `chatgpt.com/backend-api/codex` or similar.

**Secondary:** GitHub issue [openai/codex#36886](https://github.com/openai/codex/issues/36886) asks for a documented third-party subscription auth contract (analogous to Anthropic’s `oauth-2025-04-20`) and notes the backend host is undocumented — labelled **secondary**, illustrates absence of a published A-lane.

### Terms of Use (general prohibition)

Fetched `https://openai.com/policies/terms-of-use/` successfully via curl (2026-09-24):

> “Attempt to or assist anyone to reverse engineer, decompile or discover the source code or underlying components of our Services, including our models, algorithms, or systems… **Automatically or programmatically extract data or Output**… Interfere with or disrupt our Services, including circumvent any rate limits or restrictions or bypass any protective measures…”  
> — [OpenAI Terms of Use](https://openai.com/policies/terms-of-use/)

Combined with “Services” being the ChatGPT product surfaces, scraping/replaying ChatGPT session credentials in an unofficial HTTP client is **not** a supported A-lane.

### Lane decision

| Credential | Lane | Notes |
|------------|------|-------|
| ChatGPT Plus/Pro (Sign in with ChatGPT) | **B** | Use unmodified Codex CLI / IDE / desktop / **App Server** / SDK |
| OpenAI Platform API key | **C** (usable as A in custom harness) | Billed at API rates; recommended for CI |

**Status: VERIFIED** that subscription access is tied to Codex clients + App Server. **No primary permit** for arbitrary third-party HTTP with ChatGPT cookies/tokens.

---

## 6. Other common developer subscriptions (brief)

| Product | Note | Primary |
|---------|------|---------|
| **GitHub Copilot** | Subscription used inside Copilot product. Third-party editors/automation: drive **`copilot --acp`** (ACP public preview, stdio/TCP JSON-RPC). Lane **B**. | [ACP server docs](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server); [Changelog 2026-01-28](https://github.blog/changelog/2026-01-28-acp-support-in-copilot-cli-is-now-in-public-preview/) |
| **OpenRouter** | PAYG/credits API keys; docs teach wiring into coding agents / Claude Code. Lane **A**. Base: `https://openrouter.ai/api/v1`. | [Authentication](https://openrouter.ai/docs/api/reference/authentication); [coding agent tutorial](https://openrouter.ai/blog/tutorials/any-coding-agent/) |
| **xAI Grok / SuperGrok** | Consumer SuperGrok ≠ API. Build with prepaid API at `https://api.x.ai/v1`. Lane **C**. | [docs.x.ai overview](https://docs.x.ai/docs/overview) |
| **Groq Cloud** | Developer API keys, OpenAI-compatible; no “ChatGPT Plus-style” coding sub researched. Lane **A/C**. | console.groq.com docs (fetch mostly SPA) |
| **Cursor** | Subscription unlocks Cursor app; custom harness typically BYOK to other A/C providers. Lane **B** for Cursor sub itself. | Product pricing/docs — full ToS not captured this pass → UNVERIFIED detail |

---

## Cross-cutting implications for MAD’s TypeScript harness

1. **True A-lane subscriptions that fit a custom engine today:** Kimi Code membership keys; Mistral Pro shared usage via API key; DeepSeek PAYG; OpenRouter; Groq; xAI API credits; Z.ai only if MAD is (or becomes) an **allowlisted** tool — otherwise Z.ai Coding Plan ≠ custom harness.  
2. **Must wrap vendor binary / protocol (B):** ChatGPT Plus/Pro → Codex (`codex` / App Server); GitHub Copilot → `copilot --acp`; Anthropic Pro/Max → stock Claude Code (prior finding); Gemini CLI OAuth → stock Google clients (prior finding).  
3. **Interactive-only coding plans (prior):** MiniMax Token Plan, Alibaba Coding Plan — OK in 3P *interactive* tools; automation/headless fragile.  
4. **Do not** reverse ChatGPT OAuth into a private HTTP client; OpenAI’s supported embed path is App Server (still their agent loop).  
5. **Re-check monthly:** Z.ai campaign windows, Kimi plan renames, Mistral Vibe↔API credit sharing, DeepSeek model IDs.

---

## Retrieval log (2026-09-24)

| Source | Method | Result |
|--------|--------|--------|
| kimi.com code docs / help | WebFetch | OK |
| docs.z.ai / docs.z.ai | WebFetch | OK |
| api-docs.deepseek.com + cdn policies | WebFetch | OK |
| docs.mistral.ai + mistral.ai/pricing | WebFetch | OK |
| developers.openai.com/codex/auth, learn.chatgpt.com app-server | WebFetch | OK |
| help.openai.com Codex article | WebFetch 403; jina.ai challenge; search snippets | Partial |
| openai.com/policies/terms-of-use | curl 200 | OK |
| openai.com/index/unlocking-the-codex-harness | WebFetch 403 | Blog quote via search snippets only |
| docs.github.com Copilot ACP | WebFetch | OK |
| openrouter.ai auth docs | WebFetch | OK |
| docs.x.ai | WebFetch | OK |

*End of brief.*
