/**
 * @madc/adapters — provider seam + backings: Kimi Code over pinned pi-ai (Act M0-A3), the
 * unmodified Claude Code vendor binary (Act M0-A5), and the unmodified Codex vendor binary via
 * `codex app-server` (Act M0-A6). Only this package imports `@earendil-works/pi-ai` (exact pin
 * 0.87.1, plan §6) — and only `kimi-code.ts` does.
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
  type PinnedModelResolution,
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
