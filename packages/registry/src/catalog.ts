import type { ProviderEntry, RunMode } from "./types.ts";

/** Deep-freeze so catalog policy cannot be mutated via shared object refs. */
function deepFreeze<T extends object>(value: T): T {
  Reflect.ownKeys(value).forEach((key) => {
    const child = Reflect.get(value, key);
    if (child !== null && typeof child === "object" && !Object.isFrozen(child)) {
      deepFreeze(child as object);
    }
  });
  return Object.freeze(value);
}

/**
 * M1 provider catalog v2 — every roadmap §3 row plus the forbidden sub-paths and the M1 ids.
 * Quotes are verbatim: rows covered by docs/plan/ROADMAP-madc-post-M0.md §3 quote that table
 * (acceptance: sourceQuote equals the text quoted in roadmap §3); kept stubs quote
 * docs/plan/subscription-lanes-2026-09-24.md; the two PAYG ids quote PLAN-madc-M1-build-plan.md
 * §7 M1-A1 (PAYG terms not re-verified on 2026-09-24 → wired: false, verifiedAt: "").
 *
 * `wired: true` only where the lane is actually wired in this build: kimi-code, claude-code and
 * codex from M0, ollama-cloud from M1-A3, mistral-pro / deepseek-payg / gemini-api-key / xai-api
 * from M1-A4, and the interactive-only plans minimax-token-plan / alibaba-coding-plan from M1-A5
 * (roadmap §3 rows 8 and 9), and grok-build from M1-A6 (vendor agent via the generic ACP client). The
 * two PAYG ids stay unwired until a PAYG terms source is cited. `ollama-cloud` ships
 * headless: "denied" (D-M1-3): headless flips only with a reviewed catalog change adding
 * headlessPermission. `deepseek-payg` being wired does NOT open the lane: it is repo-gated with an
 * empty allowlist on a clean install (D-M1-8, seat pin §5), so every repo denies.
 */
export const PROVIDER_CATALOG: readonly ProviderEntry[] = [
  // --- Live from M0 (wired: true) ---
  {
    id: "kimi-code",
    status: "allowed-direct",
    connect: "direct",
    wire: "anthropic-compat",
    clientIdentity: "honest-ua-required",
    wired: true,
    credentialClass: "payg",
    headless: "allowed",
    verifiedAt: "2026-09-24",
    termsUrl: "https://www.kimi.com/code/docs/en/",
    sourceQuote:
      "Subscribers can also obtain an API Key to integrate Kimi Code's model capabilities into third-party development tools and platforms.",
    sourceUrl: "docs/plan/ROADMAP-madc-post-M0.md#3-subscription-table-all-lanes",
  },
  {
    id: "claude-code",
    status: "allowed-via-vendor-agent",
    connect: "vendor-agent",
    wire: "vendor-cli",
    clientIdentity: "default",
    wired: true,
    credentialClass: "vendor-session",
    verifiedAt: "2026-09-24",
    termsUrl: "https://code.claude.com/docs/en/legal-and-compliance.md",
    sourceQuote:
      "Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription",
    sourceUrl: "docs/plan/ROADMAP-madc-post-M0.md#3-subscription-table-all-lanes",
  },
  {
    id: "codex",
    status: "allowed-via-vendor-agent",
    connect: "vendor-agent",
    wire: "native",
    clientIdentity: "default",
    wired: true,
    credentialClass: "vendor-session",
    verifiedAt: "2026-09-24",
    termsUrl: "https://learn.chatgpt.com/docs/app-server",
    sourceQuote:
      "Use it when you want a deep integration inside your own product: authentication, conversation history, approvals, and streamed agent events.",
    sourceUrl: "docs/plan/ROADMAP-madc-post-M0.md#3-subscription-table-all-lanes",
  },

  // --- M1 direct-key lanes (each flips to wired: true in the act that lands its adapter;
  // M1-A4 lands Mistral / DeepSeek / Gemini / xAI) ---
  {
    id: "ollama-cloud",
    status: "allowed-direct",
    connect: "direct",
    wire: "openai-compat",
    clientIdentity: "default",
    // Wired by M1-A3 (roadmap §3 row 1: Ollama Cloud — allowed-direct, Bearer key against
    // https://ollama.com/v1, live model list from /api/tags). Headless stays DENIED (D-M1-3):
    // the Terms bar automated access "without permission"; the flip needs a reviewed catalog
    // change carrying headlessPermission.
    wired: true,
    credentialClass: "payg",
    headless: "denied",
    verifiedAt: "2026-09-24",
    termsUrl: "https://ollama.com/terms",
    sourceQuote:
      "Direct cloud inference at `https://ollama.com/api` and `https://ollama.com/v1` requires an API key. No Ollama installation or local server is required.",
    sourceUrl: "docs/plan/ROADMAP-madc-post-M0.md#3-subscription-table-all-lanes",
  },
  {
    id: "mistral-pro",
    status: "allowed-direct",
    connect: "direct",
    wire: "openai-compat",
    clientIdentity: "default",
    // Wired by M1-A4 (roadmap §3 row 3: Mistral Pro — allowed-direct; pi-ai built-in `mistral`,
    // mistral-conversations wire against https://api.mistral.ai/v1/chat/completions, Bearer key).
    wired: true,
    credentialClass: "payg",
    headless: "allowed",
    verifiedAt: "2026-09-24",
    termsUrl: "https://docs.mistral.ai/admin/billing-usage/subscriptions",
    sourceQuote:
      "Mistral plans include monthly usage that is shared across Studio, the API, and Vibe Code.",
    sourceUrl: "docs/plan/ROADMAP-madc-post-M0.md#3-subscription-table-all-lanes",
  },
  {
    id: "deepseek-payg",
    status: "allowed-direct",
    connect: "direct",
    wire: "openai-compat",
    clientIdentity: "default",
    // Wired by M1-A4 (roadmap §3 row 4: DeepSeek PAYG — allowed-direct; pi-ai built-in `deepseek`,
    // openai-completions wire against https://api.deepseek.com/chat/completions, Bearer key).
    // WIRED BUT GATED (D-M1-8): this id is repo-gated by $MADC_HOME/policy.json (seat pin §5) and
    // a clean install ships an EMPTY allowlist, so every repo denies with -32007 repo-not-allowed.
    // Wiring the adapter does not open the lane; only the Founder naming a repo does.
    wired: true,
    credentialClass: "payg",
    headless: "allowed",
    verifiedAt: "2026-09-24",
    termsUrl: "https://api-docs.deepseek.com/",
    sourceQuote:
      "If you use tools like Claude Code, GitHub Copilot, or OpenCode, you can use DeepSeek as the backend model directly",
    sourceUrl: "docs/plan/ROADMAP-madc-post-M0.md#3-subscription-table-all-lanes",
  },
  {
    id: "gemini-api-key",
    status: "allowed-direct",
    connect: "direct",
    wire: "native",
    clientIdentity: "default",
    // Wired by M1-A4 (roadmap §3 row 5: Gemini API auth key — allowed-direct; pi-ai built-in
    // `google`, google-generative-ai wire against
    // https://generativelanguage.googleapis.com/v1beta, x-goog-api-key header). AUTH KEYS ONLY:
    // Google rejects standard keys from September 2026 (sourceQuote below), so `madc doctor` flags
    // a standard-shaped key as a likely failure. No Google OAuth of any kind — Antigravity/Gemini
    // sign-in stays `forbidden` (gemini-antigravity-signin).
    wired: true,
    credentialClass: "payg",
    headless: "allowed",
    verifiedAt: "2026-09-24",
    termsUrl: "https://ai.google.dev/gemini-api/docs/api-key",
    sourceQuote:
      "On September 2026 : the Gemini API will reject requests from standard keys . You must migrate to auth keys",
    sourceUrl: "docs/plan/ROADMAP-madc-post-M0.md#3-subscription-table-all-lanes",
  },
  {
    id: "xai-api",
    status: "allowed-direct",
    connect: "direct",
    wire: "openai-compat",
    clientIdentity: "default",
    // Wired by M1-A4 (roadmap §3 row 11: xAI API — allowed-direct; pi-ai built-in `xai`,
    // openai-responses wire against https://api.x.ai/v1/responses, Bearer key). API KEY ONLY: the
    // XAI_API_KEY-style credential comes from the M1-A2 keychain. pi-ai's own xAI OAuth
    // (SuperGrok / X Premium sign-in) is NOT enabled — the adapter strips it, and consumer sign-in
    // stays `forbidden` (xai-consumer-signin, AUP "bypassing our systems or protective measures").
    wired: true,
    credentialClass: "payg",
    headless: "allowed",
    verifiedAt: "2026-09-24",
    termsUrl: "https://docs.x.ai/build/overview.md",
    sourceQuote:
      "`grok-4.7` … is available directly on the xAI API. Drop it into your own agent loop, IDE integration, or coding tool.",
    sourceUrl: "docs/plan/ROADMAP-madc-post-M0.md#3-subscription-table-all-lanes",
  },
  {
    id: "grok-build",
    status: "allowed-via-vendor-agent",
    connect: "vendor-agent",
    wire: "vendor-cli",
    clientIdentity: "default",
    // Wired by M1-A6 (roadmap §3 row 11 (c): Grok Build — allowed-via-vendor-agent): the unmodified
    // `grok` binary spawned as `grok --no-auto-update agent --no-leader --model=<id> stdio` and
    // driven over ACP by the generic client. Grok authenticates itself (its own login, or
    // XAI_API_KEY if the Founder chooses the API-key class); madc never reads ~/.grok, never uses
    // pi-ai's xAI OAuth, and never passes --always-approve. D-R4 default: only this path and the
    // xai-api key path are wired until the Founder reads the xAI AUP compete clause.
    wired: true,
    credentialClass: "vendor-session",
    verifiedAt: "2026-09-24",
    termsUrl: "https://docs.x.ai/build/cli/headless-scripting.md",
    sourceQuote: "`grok agent stdio` … runs Grok as an ACP agent over JSON-RPC on stdin/stdout",
    sourceUrl: "docs/plan/ROADMAP-madc-post-M0.md#3-subscription-table-all-lanes",
  },

  // --- Interactive-only plans (headless always denied by status; wired by M1-A5) ---
  // Wiring does NOT relax the lane: a turn is served only when the client claims
  // `mode: "interactive"` AND the engine's own presence check on the controlling terminal passes
  // (M1 plan §7 M1-A5, protocol pin §3.3 P3). Everything else is refused before any network call.
  {
    id: "minimax-token-plan",
    status: "interactive-only",
    connect: "direct",
    // M1-A5 (roadmap §3 row 8: pi-ai built-in `minimax`): the pinned provider speaks
    // anthropic-messages against https://api.minimax.io/anthropic, so the wire is anthropic-compat.
    // Repo-gated with an empty allowlist on a clean install (ruling 13, D-M1-9, seat pin §5).
    wire: "anthropic-compat",
    clientIdentity: "default",
    wired: true,
    credentialClass: "plan-interactive",
    verifiedAt: "2026-09-24",
    termsUrl: "https://platform.minimax.io/docs/token-plan/intro",
    sourceQuote: "is not interchangeable with pay-as-you-go API Keys",
    sourceUrl: "docs/plan/ROADMAP-madc-post-M0.md#3-subscription-table-all-lanes",
  },
  {
    id: "alibaba-coding-plan",
    status: "interactive-only",
    connect: "direct",
    // M1-A5 (roadmap §3 row 9): OpenAI-compatible Coding Plan endpoint
    // https://coding-intl.dashscope.aliyuncs.com/v1. pi-ai's `qwen-token-plan*` catalog targets the
    // Token Plan host instead, so the endpoint match the roadmap asked to confirm at build time
    // failed and the lane is a `createProvider` config. The endpoint was confirmed on the termsUrl
    // page as a build-time wiring check only; `verifiedAt` stays the roadmap §3 terms date, because
    // re-verifying a lane's terms is a reviewed catalog change, not an adapter act's (Copilot
    // r4145107357).
    wire: "openai-compat",
    clientIdentity: "default",
    wired: true,
    credentialClass: "plan-interactive",
    verifiedAt: "2026-09-24",
    termsUrl: "https://www.alibabacloud.com/help/en/model-studio/coding-plan",
    sourceQuote:
      "This plan is for interactive use in programming tools such as Claude Code, Qoder, Qoder CN, and OpenClaw. Do not use the plan's API key for automated scripts, application backends, or other non-interactive scenarios.",
    sourceUrl: "docs/plan/ROADMAP-madc-post-M0.md#3-subscription-table-all-lanes",
  },

  // --- PAYG ids: allowed-direct only once a PAYG terms source is cited (M1-A1 note) ---
  {
    id: "minimax-payg",
    status: "allowed-direct",
    connect: "direct",
    wire: "openai-compat",
    clientIdentity: "default",
    wired: false,
    credentialClass: "payg",
    headless: "allowed",
    verifiedAt: "",
    termsUrl: "",
    sourceQuote: "because I did not re-verify PAYG terms on 2026-09-24",
    sourceUrl: "docs/plan/PLAN-madc-M1-build-plan.md#m1-a1--registry-v2-pure",
  },
  {
    id: "alibaba-model-studio-payg",
    status: "allowed-direct",
    connect: "direct",
    wire: "openai-compat",
    clientIdentity: "default",
    wired: false,
    credentialClass: "payg",
    headless: "allowed",
    verifiedAt: "",
    termsUrl: "",
    sourceQuote: "because I did not re-verify PAYG terms on 2026-09-24",
    sourceUrl: "docs/plan/PLAN-madc-M1-build-plan.md#m1-a1--registry-v2-pure",
  },

  // --- Kept M0 stubs (not roadmap §3 rows; quotes cite the subscription-lanes brief) ---
  {
    id: "openrouter",
    status: "allowed-direct",
    connect: "direct",
    wire: "openai-compat",
    clientIdentity: "default",
    wired: false,
    credentialClass: "payg",
    headless: "allowed",
    verifiedAt: "",
    termsUrl: "",
    sourceQuote: "PAYG/credits API keys; docs teach wiring into coding agents / Claude Code.",
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
    credentialClass: "payg",
    headless: "allowed",
    verifiedAt: "",
    termsUrl: "",
    sourceQuote: "Developer API keys for OpenAI-compatible tools; not a ChatGPT-like coding sub",
    sourceUrl:
      "docs/plan/subscription-lanes-2026-09-24.md#6-other-common-developer-subscriptions-brief",
  },
  {
    id: "github-copilot",
    status: "allowed-via-vendor-agent",
    connect: "vendor-agent",
    wire: "vendor-cli",
    clientIdentity: "default",
    wired: false,
    credentialClass: "vendor-session",
    verifiedAt: "",
    termsUrl: "",
    sourceQuote:
      "Drive `copilot --acp` (ACP public preview) or official extensions; no raw ChatGPT-style sub key for arbitrary HTTP",
    sourceUrl:
      "docs/plan/subscription-lanes-2026-09-24.md#6-other-common-developer-subscriptions-brief",
  },

  // --- Forbidden (never relax, including on staleness — D-M1-6) ---
  {
    id: "zai-glm-coding-plan",
    status: "forbidden",
    connect: "none",
    wired: false,
    verifiedAt: "2026-09-24",
    termsUrl: "https://docs.z.ai/devpack/usage-policy",
    sourceQuote:
      "The GLM Coding Plan is strictly limited to use within officially supported tools and products.",
    sourceUrl: "docs/plan/ROADMAP-madc-post-M0.md#3-subscription-table-all-lanes",
  },
  {
    id: "gemini-antigravity-signin",
    status: "forbidden",
    connect: "none",
    wired: false,
    verifiedAt: "2026-09-24",
    termsUrl: "https://antigravity.google/docs/faq",
    sourceQuote:
      "Using third party software, tools, or services to access Antigravity is a violation of our Terms of Service … If you would like to use a third party coding agent with Gemini, we recommend using a Gemini Enterprise or Google AI Studio API key.",
    sourceUrl: "docs/plan/ROADMAP-madc-post-M0.md#3-subscription-table-all-lanes",
  },
  {
    id: "chatgpt-token-replay",
    status: "forbidden",
    connect: "none",
    wired: false,
    verifiedAt: "2026-09-24",
    termsUrl: "https://learn.chatgpt.com/docs/auth",
    sourceQuote:
      "copying ChatGPT OAuth tokens into OpenCode / Cline / pi / a custom HTTP client against `chatgpt.com/backend-api/codex` or similar.",
    sourceUrl:
      "docs/plan/subscription-lanes-2026-09-24.md#5-openai--chatgpt-pluspro-sign-in-in-third-party-harnesses",
  },
  {
    id: "claude-subscription-http",
    status: "forbidden",
    connect: "none",
    wired: false,
    verifiedAt: "2026-09-24",
    termsUrl: "https://code.claude.com/docs/en/legal-and-compliance.md",
    sourceQuote:
      "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users.",
    sourceUrl: "docs/plan/ROADMAP-madc-post-M0.md#3-subscription-table-all-lanes",
  },
  {
    id: "xai-consumer-signin",
    status: "forbidden",
    connect: "none",
    wired: false,
    verifiedAt: "2026-09-24",
    termsUrl: "https://x.ai/legal/acceptable-use-policy",
    sourceQuote: 'The AUP bars "bypassing our systems or protective measures"',
    sourceUrl: "docs/plan/ROADMAP-madc-post-M0.md#3-subscription-table-all-lanes",
  },
] as const;

for (const entry of PROVIDER_CATALOG) {
  deepFreeze(entry);
}
Object.freeze(PROVIDER_CATALOG);

const BY_ID: ReadonlyMap<string, ProviderEntry> = new Map(
  PROVIDER_CATALOG.map((entry) => [entry.id, entry]),
);

export function listCatalog(): readonly ProviderEntry[] {
  return PROVIDER_CATALOG;
}

export function getById(id: string): ProviderEntry | undefined {
  return BY_ID.get(id);
}

/**
 * Mode policy per entry (M1-A1): forbidden serves nothing; interactive-only serves interactive
 * only; allowed-direct serves interactive always and headless only with `headless: "allowed"`;
 * vendor-agent lanes serve both modes. This checks mode only, not wiring or terms freshness;
 * callers must supply `now` and `requireLive` to assertAllowed to enforce both.
 */
export function canServe(entry: ProviderEntry, mode: RunMode): boolean {
  if (entry.status === "forbidden") return false;
  if (entry.status === "interactive-only") return mode === "interactive";
  if (entry.status === "allowed-direct")
    return mode === "interactive" || entry.headless === "allowed";
  return true;
}

/** Pure lane listing by mode only; entries may be unwired or stale (M1 plan §5). */
export function lanesFor(mode: RunMode): readonly ProviderEntry[] {
  return PROVIDER_CATALOG.filter((entry) => canServe(entry, mode));
}
