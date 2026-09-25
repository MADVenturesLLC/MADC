/**
 * @madc/adapters — provider seam + backings (Act M0-A3: Kimi Code over pinned pi-ai).
 * Only this package imports `@earendil-works/pi-ai` (exact pin 0.87.1, plan §6).
 */
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
