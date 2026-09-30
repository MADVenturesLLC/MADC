/**
 * @madc/adapters — provider seam + backings: the generic direct-key port (Act M1-A3) with the
 * Kimi Code lane over pinned pi-ai (Act M0-A3), the Ollama Cloud lane (Act M1-A3) and the M1-A4
 * direct-key batch — Mistral, DeepSeek, Gemini (auth key) and the xAI API — plus the unmodified
 * Claude Code vendor binary (Act M0-A5) and the unmodified Codex vendor binary via
 * `codex app-server` (Act M0-A6), plus the M1-A5 interactive-only plans — MiniMax Token Plan and the
 * Alibaba Cloud Coding Plan — whose credential-class rules live here and whose presence gate lives in
 * the engine. Only this package imports `@earendil-works/pi-ai` (exact pin
 * 0.87.1, plan §6) — the pi-ai importers are `kimi-code.ts`, `direct/generic.ts` and the lane
 * modules under `providers/` (M1-A3 generalizes the M0 "only kimi-code.ts" rule to the
 * direct-key lane modules; M1-A4 adds four more).
 */
export {
  CLAUDE_BINARY_NAME,
  CLAUDE_CODE_PROVIDER_ID,
  type ClaudeCodePortOptions,
  type ClaudePinnedModelResolution,
  type ClaudeSpawn,
  createClaudeCodePort,
  findClaudeBinary,
  resolveClaudePinnedModel,
} from "./claude-code.ts";
export {
  CODEX_BINARY_NAME,
  CODEX_PROVIDER_ID,
  type CodexPinnedModelResolution,
  type CodexPortOptions,
  type CodexSpawn,
  createCodexCodePort,
  findCodexBinary,
  resolveCodexPinnedModel,
} from "./codex.ts";
export {
  type CredentialCheck,
  createDirectKeyPort,
  type DirectKeyPortConfig,
  type DirectWireApi,
  leadingHttpStatus,
  type PinnedModelResolution,
  providerErrorStatus,
  QUOTA_OR_UNREACHABLE_STATUSES,
} from "./direct/generic.ts";
export {
  resolveStaticPinnedModel,
  type StaticCatalogLane,
} from "./direct/pinned-model.ts";
export {
  createKimiCodePort,
  honestUserAgent,
  KIMI_API_KEY_ENV,
  KIMI_CODE_PROVIDER_ID,
  KIMI_DEFAULT_PINNED_MODEL,
  KIMI_PI_PROVIDER,
  type KimiCodePortOptions,
  type KimiCredential,
  kimiCatalogModelIds,
  PI_AI_VERSION,
  readKimiCredential,
  resolveKimiPinnedModel,
} from "./kimi-code.ts";
export {
  ProviderCallError,
  type ProviderMessage,
  type ProviderPort,
  type ProviderTurnRequest,
  type ProviderTurnResult,
} from "./provider-port.ts";
export {
  ALIBABA_CODING_PLAN_API_KEY_ENV,
  ALIBABA_CODING_PLAN_BASE_URL,
  ALIBABA_CODING_PLAN_PI_PROVIDER,
  ALIBABA_CODING_PLAN_PROVIDER_ID,
  ALIBABA_CODING_PLAN_WIRE_API,
  ALIBABA_PAYG_PROVIDER_ID,
  ALIBABA_PLAN_KEY_PREFIX,
  type AlibabaClass,
  type AlibabaCodingPlanPortOptions,
  alibabaEndpointClass,
  alibabaKeyClass,
  checkAlibabaCredential,
  createAlibabaCodingPlanPort,
  resolveAlibabaCodingPlanPinnedModel,
} from "./providers/alibaba-coding.ts";
export {
  buildDeepseekProvider,
  createDeepseekPort,
  DEEPSEEK_API_KEY_ENV,
  DEEPSEEK_BASE_URL,
  DEEPSEEK_PI_PROVIDER,
  DEEPSEEK_PROVIDER_ID,
  DEEPSEEK_WIRE_API,
  type DeepseekPortOptions,
  deepseekCatalogModelIds,
  resolveDeepseekPinnedModel,
} from "./providers/deepseek.ts";
export {
  buildGeminiProvider,
  createGeminiPort,
  GEMINI_API_KEY_ENV,
  GEMINI_BASE_URL,
  GEMINI_PI_PROVIDER,
  GEMINI_PROVIDER_ID,
  GEMINI_STANDARD_KEY_PREFIX,
  GEMINI_STANDARD_KEY_WARNING,
  GEMINI_WIRE_API,
  type GeminiPortOptions,
  geminiCatalogModelIds,
  looksLikeStandardGeminiKey,
  resolveGeminiPinnedModel,
} from "./providers/gemini.ts";
export {
  checkMinimaxCredential,
  createMinimaxTokenPlanPort,
  MINIMAX_BASE_URL,
  MINIMAX_PAYG_PROVIDER_ID,
  MINIMAX_PI_PROVIDER,
  MINIMAX_PLAN_KEY_PREFIX,
  MINIMAX_TOKEN_PLAN_API_KEY_ENV,
  MINIMAX_TOKEN_PLAN_PROVIDER_ID,
  MINIMAX_WIRE_API,
  type MinimaxTokenPlanPortOptions,
  minimaxCatalogModelIds,
  resolveMinimaxPinnedModel,
} from "./providers/minimax.ts";
export {
  buildMistralProvider,
  createMistralPort,
  MISTRAL_API_KEY_ENV,
  MISTRAL_BASE_URL,
  MISTRAL_PI_PROVIDER,
  MISTRAL_PROVIDER_ID,
  MISTRAL_WIRE_API,
  type MistralPortOptions,
  mistralCatalogModelIds,
  resolveMistralPinnedModel,
} from "./providers/mistral.ts";
export {
  createOllamaCloudPort,
  type ListedOllamaModel,
  listOllamaCloudModels,
  OLLAMA_API_KEY_ENV,
  OLLAMA_CLOUD_BASE_URL,
  OLLAMA_CLOUD_PROVIDER_ID,
  OLLAMA_PI_PROVIDER,
  OLLAMA_TAGS_PATH,
  type OllamaCloudPortOptions,
  type OllamaListOptions,
  resolveOllamaPinnedModel,
} from "./providers/ollama-cloud.ts";
export {
  buildXaiProvider,
  createXaiPort,
  resolveXaiPinnedModel,
  stockXaiProviderHasOAuth,
  XAI_API_KEY_ENV,
  XAI_BASE_URL,
  XAI_PI_PROVIDER,
  XAI_PROVIDER_ID,
  XAI_WIRE_API,
  type XaiPortOptions,
  xaiCatalogModelIds,
} from "./providers/xai.ts";
