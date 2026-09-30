/**
 * `pinnedModel` resolution for a direct-key lane whose model truth is the PINNED pi-ai built-in
 * catalog (M1-A4: mistral, deepseek, google, xai).
 *
 * One rule, stated once instead of four times — the same rule `resolveKimiPinnedModel` (M0-A3)
 * enforces for kimi: `pinnedModel` must be `<pi provider>/<model id>`, and `<model id>` must be in
 * the pinned pi-ai catalog for that provider on that wire api. Anything else (another pi-ai
 * provider, an unknown model, a bare id, an empty half) is refused and NEVER silently remapped.
 *
 * Membership is checked here because these lanes have no dynamic model list: the pinned catalog IS
 * the truth (contrast `resolveOllamaPinnedModel`, which deliberately does not check membership
 * because the live `/api/tags` list is that lane's only truth).
 *
 * Note the pi-ai provider id is not always the registry id (seat pin §3): `mistral-pro` →
 * `mistral`, `gemini-api-key` → `google`, `xai-api` → `xai`, `deepseek-payg` → `deepseek`.
 */
import { PI_AI_VERSION } from "../kimi-code.ts";
import type { PinnedModelResolution } from "./generic.ts";

export type StaticCatalogLane = {
  /** Registry provider id (== seat `preferredBacking`); named in the mismatch issue. */
  readonly providerId: string;
  /** pi-ai provider id — the required `pinnedModel` prefix. */
  readonly piProvider: string;
  /** True when the pinned pi-ai catalog lists `modelId` under `piProvider` on this lane's api. */
  readonly inCatalog: (modelId: string) => boolean;
};

export function resolveStaticPinnedModel(
  pinnedModel: string,
  lane: StaticCatalogLane,
): PinnedModelResolution {
  const slash = pinnedModel.indexOf("/");
  if (slash <= 0 || slash === pinnedModel.length - 1) {
    return { ok: false, issue: `pinnedModel must be "${lane.piProvider}/<model id>"` };
  }
  const provider = pinnedModel.slice(0, slash);
  const modelId = pinnedModel.slice(slash + 1);
  if (provider !== lane.piProvider) {
    return {
      ok: false,
      issue: `pinnedModel provider "${provider}" does not match backing ${lane.providerId} (pi-ai provider "${lane.piProvider}")`,
    };
  }
  if (!lane.inCatalog(modelId)) {
    return {
      ok: false,
      issue: `pinnedModel "${pinnedModel}" is not in the pi-ai ${PI_AI_VERSION} ${lane.piProvider} catalog`,
    };
  }
  return { ok: true, modelId };
}
