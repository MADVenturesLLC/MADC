/**
 * @madc/adapters — provider seam + backings: the generic direct-key port (Act M1-A3) with the
 * Kimi Code lane over pinned pi-ai (Act M0-A3) and the Ollama Cloud lane (Act M1-A3), plus the
 * unmodified Claude Code vendor binary (Act M0-A5) and the unmodified Codex vendor binary via
 * `codex app-server` (Act M0-A6). Only this package imports `@earendil-works/pi-ai` (exact pin
 * 0.87.1, plan §6) — the pi-ai importers are `kimi-code.ts`, `direct/generic.ts` and
 * `providers/ollama-cloud.ts` (M1-A3 generalizes the M0 "only kimi-code.ts" rule to the
 * direct-key lane modules).
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
  createDirectKeyPort,
  type DirectKeyPortConfig,
  type DirectWireApi,
  leadingHttpStatus,
  type PinnedModelResolution,
  QUOTA_OR_UNREACHABLE_STATUSES,
} from "./direct/generic.ts";
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
