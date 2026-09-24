import type { ProviderEntry } from "./types.ts";

/**
 * M0 provider catalog — 3 live + stubs (forbidden / interactive-only / allowed-direct).
 * Quotes cite docs/plan/subscription-lanes-2026-09-24.md and PLAN-madc-M0-build-plan.md §8.
 */
export const PROVIDER_CATALOG: readonly ProviderEntry[] = [
  // --- M0 live (wired: true) ---
  {
    id: "kimi-code",
    status: "allowed-direct",
    connect: "direct",
    wire: "anthropic-compat",
    clientIdentity: "honest-ua-required",
    wired: true,
    sourceQuote:
      "Subscribers can also obtain an API Key to integrate Kimi Code's model capabilities into third-party development tools and platforms.",
    sourceUrl:
      "docs/plan/subscription-lanes-2026-09-24.md#1-moonshot-kimi-kimi-code-membership--platform-api",
  },
  {
    id: "claude-code",
    status: "allowed-via-vendor-agent",
    connect: "vendor-agent",
    wire: "vendor-cli",
    clientIdentity: "default",
    wired: true,
    sourceQuote:
      "Claude Pro/Max: unmodified Claude Code only. Claude subscription traffic only ever goes through real Claude Code.",
    sourceUrl: "docs/plan/PLAN-madc-M0-build-plan.md#8-registry-model-m0",
  },
  {
    id: "codex",
    status: "allowed-via-vendor-agent",
    connect: "vendor-agent",
    wire: "native",
    clientIdentity: "default",
    wired: true,
    sourceQuote:
      "Codex app-server is the interface Codex uses to power rich clients… Use it when you want a deep integration inside your own product.",
    sourceUrl:
      "docs/plan/subscription-lanes-2026-09-24.md#5-openai--chatgpt-pluspro-sign-in-in-third-party-harnesses",
  },

  // --- Stubs still enforced (wired: false) ---
  {
    id: "ollama-cloud",
    status: "allowed-direct",
    connect: "direct",
    wire: "openai-compat",
    clientIdentity: "default",
    wired: false,
    sourceQuote:
      "Ollama Cloud lands as a registry stub (allowed-direct, unwired) after M0, ready for M0.5/M1. Founder D2: direct-key = Kimi Code.",
    sourceUrl: "docs/plan/PLAN-madc-M0-build-plan.md#5-direct-key-pick-kimi-code-not-ollama-cloud",
  },
  {
    id: "mistral-pro",
    status: "allowed-direct",
    connect: "direct",
    wire: "openai-compat",
    clientIdentity: "default",
    wired: false,
    sourceQuote:
      "Mistral plans include monthly usage that is shared across Studio, the API, and Vibe Code.",
    sourceUrl:
      "docs/plan/subscription-lanes-2026-09-24.md#2-mistral-le-chat--vibe-vs-la-plateforme",
  },
  {
    id: "deepseek-payg",
    status: "allowed-direct",
    connect: "direct",
    wire: "openai-compat",
    clientIdentity: "default",
    wired: false,
    sourceQuote:
      "The DeepSeek API uses an API format compatible with OpenAI/Anthropic. By modifying the configuration, you can use the OpenAI/Anthropic SDK or softwares compatible with the OpenAI/Anthropic API.",
    sourceUrl: "docs/plan/subscription-lanes-2026-09-24.md#3-deepseek",
  },
  {
    id: "openrouter",
    status: "allowed-direct",
    connect: "direct",
    wire: "openai-compat",
    clientIdentity: "default",
    wired: false,
    sourceQuote:
      "OpenRouter: PAYG/credits API keys; docs teach wiring into coding agents / Claude Code. Lane A.",
    sourceUrl:
      "docs/plan/subscription-lanes-2026-09-24.md#6-other-common-developer-subscriptions-brief",
  },
  {
    id: "groq-cloud",
    status: "allowed-direct",
    connect: "direct",
    wire: "openai-compat",
    clientIdentity: "default",
    wired: false,
    sourceQuote: "Groq Cloud: Developer API keys, OpenAI-compatible; Lane A/C.",
    sourceUrl:
      "docs/plan/subscription-lanes-2026-09-24.md#6-other-common-developer-subscriptions-brief",
  },
  {
    id: "gemini-api-key",
    status: "allowed-direct",
    connect: "direct",
    wire: "native",
    clientIdentity: "default",
    wired: false,
    sourceQuote:
      "Antigravity / Google subscription quota EXCLUDED. Gemini API key (auth keys) in M0.",
    sourceUrl: "docs/plan/PLAN-madc-idea-plan-v2.md#11-decided-founder-sep-24-2026",
  },
  {
    id: "github-copilot",
    status: "allowed-via-vendor-agent",
    connect: "vendor-agent",
    wire: "vendor-cli",
    clientIdentity: "default",
    wired: false,
    sourceQuote:
      "GitHub Copilot: drive copilot --acp (ACP public preview) or official extensions; Lane B.",
    sourceUrl:
      "docs/plan/subscription-lanes-2026-09-24.md#6-other-common-developer-subscriptions-brief",
  },
  {
    id: "minimax-token-plan",
    status: "interactive-only",
    connect: "direct",
    wire: "openai-compat",
    clientIdentity: "default",
    wired: false,
    sourceQuote:
      "MiniMax Token Plan & Alibaba Coding Plan → third-party allowed but interactive only.",
    sourceUrl: "docs/plan/subscription-lanes-2026-09-24.md",
  },
  {
    id: "alibaba-coding-plan",
    status: "interactive-only",
    connect: "direct",
    wire: "openai-compat",
    clientIdentity: "default",
    wired: false,
    sourceQuote:
      "MiniMax and Alibaba coding / token plans: third-party use is allowed, but interactive only.",
    sourceUrl:
      "docs/plan/PLAN-madc-idea-plan-v2.md#9-research-evidence-from-your-sep-24-subscription-brief-and-earlier-research",
  },
  {
    id: "zai-glm-coding-plan",
    status: "forbidden",
    connect: "none",
    wired: false,
    sourceQuote:
      "The GLM Coding Plan is strictly limited to use within officially supported tools and products. The subscriber shall not use the subscription benefits in any unsupported tools or scenarios.",
    sourceUrl: "docs/plan/subscription-lanes-2026-09-24.md#4-zai-zhipu-glm-coding-plan",
  },
  {
    id: "gemini-antigravity-signin",
    status: "forbidden",
    connect: "none",
    wired: false,
    sourceQuote: "Antigravity / Gemini sign-in in third-party tools. Use a Gemini API key instead.",
    sourceUrl: "docs/plan/PLAN-madc-M0-build-plan.md#3-out-of-m0-hard-non-goals",
  },
  {
    id: "chatgpt-token-replay",
    status: "forbidden",
    connect: "none",
    wired: false,
    sourceQuote:
      "No primary permit for arbitrary third-party HTTP with ChatGPT cookies/tokens. Do not reverse ChatGPT OAuth into a private HTTP client.",
    sourceUrl:
      "docs/plan/subscription-lanes-2026-09-24.md#5-openai--chatgpt-pluspro-sign-in-in-third-party-harnesses",
  },
  {
    id: "claude-subscription-http",
    status: "forbidden",
    connect: "none",
    wired: false,
    sourceQuote: "Claude subscription outside real Claude Code. Unmodified Claude Code only.",
    sourceUrl: "docs/plan/PLAN-madc-M0-build-plan.md#3-out-of-m0-hard-non-goals",
  },
] as const;

const BY_ID: ReadonlyMap<string, ProviderEntry> = new Map(
  PROVIDER_CATALOG.map((entry) => [entry.id, entry]),
);

export function listCatalog(): readonly ProviderEntry[] {
  return PROVIDER_CATALOG;
}

export function getById(id: string): ProviderEntry | undefined {
  return BY_ID.get(id);
}
