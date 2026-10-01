/**
 * Alibaba Cloud Coding Plan backing (M1-A5; roadmap §3 row 9 — `interactive-only`, VERIFIED).
 *
 * The OpenAI-compatible Coding Plan endpoint `https://coding-intl.dashscope.aliyuncs.com/v1` with a
 * Bearer `sk-sp-` plan key. Both facts were confirmed on the lane's `termsUrl` page on 2026-09-30
 * ("Last Updated: Sep 28, 2026") as a build-time wiring check. That is not a terms re-verification:
 * the registry `verifiedAt` stays the roadmap §3 date (Copilot r4145107357).
 *
 * **Why this is a `createProvider` config, not a pi-ai built-in.** Roadmap §3 row 9 planned the lane
 * as "pi-ai `qwen-token-plan*` catalog, endpoint match to confirm at build time". The match fails:
 * every pinned pi-ai 0.87.1 `qwen-token-plan*` provider targets the Token Plan host
 * (`token-plan.<region>.maas.aliyuncs.com`), a different product with its own terms, and pi-ai has
 * no Coding Plan endpoint at all. Pointing this registry id at the Token Plan would make every
 * receipt name a lane that did not serve the turn, so the lane speaks the pinned
 * `openai-completions` wire directly at the Coding Plan endpoint, like Ollama Cloud (M1-A3).
 *
 * **Model truth.** No pinned catalog lists this endpoint and no model-list endpoint is documented
 * for it, so there is no list to check against: `pinnedModel` is shape-checked only, the id is sent
 * as-is, and the vendor's reply is the only truth (an unknown id fails the call; it is never
 * remapped). The record carries honest zeros for pricing and context ("unknown"), exactly like
 * Ollama Cloud's; pi-ai reads `maxTokens` only for reasoning budgets, which MADC never requests.
 * Its `compat` pins the two request-shape flags pi-ai's own pinned Alibaba catalog uses
 * (`supportsStore: false`, `supportsDeveloperRole: false`), so no `store` field or developer role
 * is sent to DashScope.
 *
 * **Credential class (Founder ruling 12).** Model Studio keys are prefixed by class (planning record
 * QW-09..14: `sk-` / `sk-ws` pay-as-you-go, `sk-sp-` Token/Coding Plan) and endpoints are split by
 * class too, so both are checked: an `sk-` key on the plan endpoint and an `sk-sp-` key on a
 * pay-as-you-go endpoint are refused, and so is a plan lane pointed at a pay-as-you-go host (or the
 * reverse). `alibaba-model-studio-payg` stays `wired: false` until a PAYG terms source is cited
 * (M1 plan §7 M1-A1), and its region/workspace endpoint is not pinned anywhere, so this act ships
 * its credential rule only and no PAYG port.
 *
 * **This module decides no policy.** Interactive-only serving is the engine's presence check.
 */
import { createProvider, envApiKeyAuth, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import {
  type CredentialCheck,
  createDirectKeyPort,
  type PinnedModelResolution,
} from "../direct/generic.ts";
import { ProviderCallError, type ProviderPort } from "../provider-port.ts";

/** Registry provider id of the interactive-only plan (== seat `preferredBacking`). */
export const ALIBABA_CODING_PLAN_PROVIDER_ID = "alibaba-coding-plan";
/** Registry provider id of the pay-as-you-go lane (unwired in this build; credential rule only). */
export const ALIBABA_PAYG_PROVIDER_ID = "alibaba-model-studio-payg";
/** pi-ai provider id of the custom provider == the registry id (no legacy split to honor). */
export const ALIBABA_CODING_PLAN_PI_PROVIDER = "alibaba-coding-plan";
export const ALIBABA_CODING_PLAN_WIRE_API = "openai-completions" as const;
/** International Coding Plan endpoint (termsUrl page, confirmed 2026-09-30 as a wiring check). */
export const ALIBABA_CODING_PLAN_BASE_URL = "https://coding-intl.dashscope.aliyuncs.com/v1";
/** Coding Plan key prefix (termsUrl page; planning record QW-09..14 / QW-53..60). */
export const ALIBABA_PLAN_KEY_PREFIX = "sk-sp-";
/** Derived env name for the A2 credential store (`credentialEnvVar("alibaba-coding-plan")`). */
export const ALIBABA_CODING_PLAN_API_KEY_ENV = "MADC_API_KEY_ALIBABA_CODING_PLAN";

/** Billing class of an Alibaba Model Studio key or endpoint (ruling 12). */
export type AlibabaClass = "plan" | "payg";

/** `sk-sp-` → plan; any other `sk-` (`sk-`, `sk-ws…`) → pay-as-you-go; anything else → unknown. */
export function alibabaKeyClass(apiKey: string): AlibabaClass | null {
  if (apiKey.startsWith(ALIBABA_PLAN_KEY_PREFIX)) return "plan";
  if (apiKey.startsWith("sk-")) return "payg";
  return null;
}

/**
 * The billing class of a Model Studio endpoint, by host (planning record QW-01..08, QW-53..60):
 * Coding Plan (`coding[-intl].dashscope…`) and Token Plan (`token-plan.<region>.maas…`) hosts are
 * plan endpoints; the DashScope API hosts and workspace `…maas…` hosts are pay-as-you-go. `null` for
 * any host that is not one of these (for example a test transport on a `.invalid` host).
 */
export function alibabaEndpointClass(url: string): AlibabaClass | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (/^coding(?:-intl)?\.dashscope\.aliyuncs\.com$/.test(host)) return "plan";
  if (/^dashscope(?:-intl|-us)?\.aliyuncs\.com$/.test(host)) return "payg";
  if (host.endsWith(".maas.aliyuncs.com")) {
    return host.startsWith("token-plan.") ? "plan" : "payg";
  }
  return null;
}

/**
 * The credential-class rule for either Alibaba registry id, against the endpoint it would reach.
 * The `issue` names the id and the rule, never the value, so it is safe for stderr.
 */
export function checkAlibabaCredential(
  providerId: string,
  apiKey: string,
  baseUrl: string,
): CredentialCheck {
  const lane: AlibabaClass | null =
    providerId === ALIBABA_CODING_PLAN_PROVIDER_ID
      ? "plan"
      : providerId === ALIBABA_PAYG_PROVIDER_ID
        ? "payg"
        : null;
  if (lane === null) return { ok: false, issue: `${providerId}: not an Alibaba registry id` };
  const key = alibabaKeyClass(apiKey);
  if (key !== lane) {
    const shape =
      key === "plan"
        ? `a plan key (${ALIBABA_PLAN_KEY_PREFIX}…)`
        : key === "payg"
          ? "a pay-as-you-go key (sk-…)"
          : "an unrecognized key shape";
    return {
      ok: false,
      issue: `${providerId}: credential is ${shape}; this ${lane === "plan" ? "plan" : "pay-as-you-go"} lane refuses it`,
    };
  }
  const endpoint = alibabaEndpointClass(baseUrl);
  if (endpoint !== null && endpoint !== lane) {
    return {
      ok: false,
      issue: `${providerId}: endpoint is a ${endpoint === "plan" ? "plan" : "pay-as-you-go"} host; this ${lane === "plan" ? "plan" : "pay-as-you-go"} lane refuses it`,
    };
  }
  return { ok: true };
}

/**
 * `pinnedModel` must be `alibaba-coding-plan/<model id>`. Membership is NOT checked: no pinned
 * catalog or documented list exists for this endpoint (see module docs), so the vendor decides.
 */
export function resolveAlibabaCodingPlanPinnedModel(pinnedModel: string): PinnedModelResolution {
  const slash = pinnedModel.indexOf("/");
  if (slash <= 0 || slash === pinnedModel.length - 1) {
    return {
      ok: false,
      issue: `pinnedModel must be "${ALIBABA_CODING_PLAN_PI_PROVIDER}/<model id>"`,
    };
  }
  const provider = pinnedModel.slice(0, slash);
  if (provider !== ALIBABA_CODING_PLAN_PI_PROVIDER) {
    return {
      ok: false,
      issue: `pinnedModel provider "${provider}" does not match backing ${ALIBABA_CODING_PLAN_PROVIDER_ID} (pi-ai provider "${ALIBABA_CODING_PLAN_PI_PROVIDER}")`,
    };
  }
  return { ok: true, modelId: pinnedModel.slice(slash + 1) };
}

/**
 * The pass-through model record (see module docs: zeros mean "unknown", never a claim). Exported
 * with {@link buildAlibabaCodingPlanProvider} so the M1-A9 L1 tool round-trip drives exactly what
 * the port streams through.
 */
export function alibabaCodingPlanModel(id: string, baseUrl: string): Model<"openai-completions"> {
  return {
    id,
    name: id,
    api: ALIBABA_CODING_PLAN_WIRE_API,
    provider: ALIBABA_CODING_PLAN_PI_PROVIDER,
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 0,
    maxTokens: 0,
    compat: { supportsStore: false, supportsDeveloperRole: false },
  };
}

/**
 * The lane's own pi-ai configuration: the OpenAI-compat custom provider over `baseUrl` with an
 * EMPTY static catalog — every id comes through {@link alibabaCodingPlanModel} (see module docs).
 */
export function buildAlibabaCodingPlanProvider(baseUrl: string) {
  return createProvider({
    id: ALIBABA_CODING_PLAN_PI_PROVIDER,
    name: "Alibaba Cloud Coding Plan",
    baseUrl,
    auth: {
      apiKey: envApiKeyAuth("Alibaba Coding Plan API key", [ALIBABA_CODING_PLAN_API_KEY_ENV]),
    },
    models: [],
    api: openAICompletionsApi(),
  });
}

export type AlibabaCodingPlanPortOptions = {
  readonly apiKey: string;
  /** Test seam: override the endpoint. Production never sets it; a PAYG host is still refused. */
  readonly baseUrl?: string;
  /** Test seam: in-process fake transport. Production uses `globalThis.fetch`. */
  readonly fetch?: typeof globalThis.fetch;
};

/** The Coding Plan port. Refuses a key or endpoint of the wrong class before any request exists. */
export function createAlibabaCodingPlanPort(options: AlibabaCodingPlanPortOptions): ProviderPort {
  const baseUrl = options.baseUrl ?? ALIBABA_CODING_PLAN_BASE_URL;
  const check = checkAlibabaCredential(ALIBABA_CODING_PLAN_PROVIDER_ID, options.apiKey, baseUrl);
  if (!check.ok) throw new ProviderCallError("failed", null, check.issue);
  return createDirectKeyPort({
    providerId: ALIBABA_CODING_PLAN_PROVIDER_ID,
    piProvider: ALIBABA_CODING_PLAN_PI_PROVIDER,
    api: ALIBABA_CODING_PLAN_WIRE_API,
    apiKey: options.apiKey,
    // An empty static catalog: every id comes through `unlistedModel` (see module docs).
    buildProvider: () => buildAlibabaCodingPlanProvider(baseUrl),
    unlistedModel: (modelId) => alibabaCodingPlanModel(modelId, baseUrl),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
}
