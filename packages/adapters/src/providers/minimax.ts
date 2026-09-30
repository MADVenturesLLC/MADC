/**
 * MiniMax Token Plan backing (M1-A5; roadmap §3 row 8 — `interactive-only`, "0.5 act (pi-ai
 * built-in `minimax`)").
 *
 * Registry-driven lane CONFIG over the pinned pi-ai built-in `minimax` provider: the
 * `anthropic-messages` wire against `https://api.minimax.io/anthropic` (the path MiniMax documents
 * as the recommended default, planning record MM-01..06) with the plan's Subscription Key.
 *
 * **This module decides no policy.** Interactive-only serving (the engine presence check on the
 * controlling terminal) and the per-repo allowlist (ruling 13 / D-M1-9, seat pin §5 — MiniMax may
 * use inputs to improve its services, MM-45) live in the engine. This module owns only what is
 * MiniMax-specific about the credential and the wire.
 *
 * **Credential class (Founder ruling 12: plan keys interactive, pay-as-you-go headless, never
 * mixed).** Token Plan and pay-as-you-go share the same base URL (MM-32..39), so the endpoint cannot
 * tell the two apart; the key shape can. MiniMax's page says the Subscription Key "is not
 * interchangeable with pay-as-you-go API Keys" (roadmap §3 row 8) and the planning record gives its
 * prefix as `sk-cp-` (MM-32..39, verified 2026-09-24; the intro and FAQ pages read on 2026-09-30
 * no longer print the prefix). So:
 * - `minimax-token-plan` accepts only an `sk-cp-` key;
 * - `minimax-payg` refuses an `sk-cp-` key (a plan key must never serve headless work).
 * Both refusals are fail-closed and never echo the value. A key containing `sk-ant-oat` is refused on
 * either id: pi-ai's anthropic-messages wire would send Claude Code identity headers for it
 * (`api/anthropic-messages.js` `isOAuthToken`), the same refusal the Kimi lane makes.
 *
 * Only `minimax-token-plan` gets a port: `minimax-payg` stays `wired: false` in the registry until a
 * PAYG terms source is cited (M1 plan §7 M1-A1), so this act ships its credential rule only.
 */
import { createModels } from "@earendil-works/pi-ai";
import { minimaxProvider } from "@earendil-works/pi-ai/providers/minimax";
import {
  type CredentialCheck,
  createDirectKeyPort,
  type PinnedModelResolution,
} from "../direct/generic.ts";
import { resolveStaticPinnedModel } from "../direct/pinned-model.ts";
import { ProviderCallError, type ProviderPort } from "../provider-port.ts";

/** Registry provider id of the interactive-only plan (== seat `preferredBacking`). */
export const MINIMAX_TOKEN_PLAN_PROVIDER_ID = "minimax-token-plan";
/** Registry provider id of the pay-as-you-go lane (unwired in this build; credential rule only). */
export const MINIMAX_PAYG_PROVIDER_ID = "minimax-payg";
/** pi-ai provider id — differs from the registry ids on purpose (seat pin §3). */
export const MINIMAX_PI_PROVIDER = "minimax";
export const MINIMAX_WIRE_API = "anthropic-messages" as const;
/** The pinned catalog endpoint. Production never overrides it; tests do, through the port seam. */
export const MINIMAX_BASE_URL = "https://api.minimax.io/anthropic";
/** Token Plan Subscription Key prefix (planning record MM-32..39). */
export const MINIMAX_PLAN_KEY_PREFIX = "sk-cp-";
/** Derived env name for the A2 credential store (`credentialEnvVar("minimax-token-plan")`). */
export const MINIMAX_TOKEN_PLAN_API_KEY_ENV = "MADC_API_KEY_MINIMAX_TOKEN_PLAN";

/**
 * The credential-class rule for either MiniMax registry id. The `issue` names the id and the rule,
 * never the value, so it is safe for stderr.
 */
export function checkMinimaxCredential(providerId: string, apiKey: string): CredentialCheck {
  if (apiKey.includes("sk-ant-oat")) {
    return {
      ok: false,
      issue: `${providerId}: refused credential shape (a Claude OAuth token would make pi-ai send Claude Code identity headers)`,
    };
  }
  const planShaped = apiKey.startsWith(MINIMAX_PLAN_KEY_PREFIX);
  if (providerId === MINIMAX_TOKEN_PLAN_PROVIDER_ID) {
    return planShaped
      ? { ok: true }
      : {
          ok: false,
          issue: `${providerId}: credential is not a Token Plan Subscription Key (${MINIMAX_PLAN_KEY_PREFIX}…); a pay-as-you-go key never serves the plan lane`,
        };
  }
  if (providerId === MINIMAX_PAYG_PROVIDER_ID) {
    return planShaped
      ? {
          ok: false,
          issue: `${providerId}: credential is a Token Plan Subscription Key (${MINIMAX_PLAN_KEY_PREFIX}…); a plan key never serves the pay-as-you-go lane`,
        }
      : { ok: true };
  }
  return { ok: false, issue: `${providerId}: not a MiniMax registry id` };
}

const catalog = createModels();
catalog.setProvider(minimaxProvider());

function inCatalog(modelId: string): boolean {
  return catalog.getModel(MINIMAX_PI_PROVIDER, modelId)?.api === MINIMAX_WIRE_API;
}

/** Model ids the pinned pi-ai catalog lists under `minimax` on this lane's wire api. */
export function minimaxCatalogModelIds(): string[] {
  return catalog.getModels(MINIMAX_PI_PROVIDER).map((model) => model.id);
}

/** `pinnedModel` must be `minimax/<id>` with `<id>` in the pinned catalog; else refused. */
export function resolveMinimaxPinnedModel(pinnedModel: string): PinnedModelResolution {
  return resolveStaticPinnedModel(pinnedModel, {
    providerId: MINIMAX_TOKEN_PLAN_PROVIDER_ID,
    piProvider: MINIMAX_PI_PROVIDER,
    inCatalog,
  });
}

export type MinimaxTokenPlanPortOptions = {
  readonly apiKey: string;
  /** Test seam: override the catalog base URL. Production never sets it. */
  readonly baseUrl?: string;
  /** Test seam: in-process fake transport. Production uses `globalThis.fetch`. */
  readonly fetch?: typeof globalThis.fetch;
};

/** The Token Plan port. Refuses a credential of the wrong class before any request exists. */
export function createMinimaxTokenPlanPort(options: MinimaxTokenPlanPortOptions): ProviderPort {
  const check = checkMinimaxCredential(MINIMAX_TOKEN_PLAN_PROVIDER_ID, options.apiKey);
  if (!check.ok) throw new ProviderCallError("failed", null, check.issue);
  return createDirectKeyPort({
    providerId: MINIMAX_TOKEN_PLAN_PROVIDER_ID,
    piProvider: MINIMAX_PI_PROVIDER,
    api: MINIMAX_WIRE_API,
    apiKey: options.apiKey,
    buildProvider: () => minimaxProvider(),
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
}
