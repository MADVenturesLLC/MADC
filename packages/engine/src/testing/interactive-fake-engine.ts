/**
 * Test fixture (M1-A5): the production provider agent with the two interactive-only plan lanes —
 * MiniMax Token Plan and the Alibaba Coding Plan — against in-process fake transports, and the REAL
 * system terminal for the presence check (no terminal is injected). Tests spawn it detached
 * (`setsid`) to prove a client's `mode: "interactive"` claim is refused when the engine itself has
 * no controlling terminal. Network-free: `.invalid` hosts, synthetic keys only.
 *
 * - `MADC_API_KEY_MINIMAX_TOKEN_PLAN` / `MADC_API_KEY_ALIBABA_CODING_PLAN`: lane credentials, run
 *   through the same credential-class checks as production (harness env is hermetic).
 * - `MADC_TEST_WIRE_LOG`: one JSON line per provider request, for either lane — its absence after a
 *   refused turn proves no network call was attempted.
 */
import { appendFileSync } from "node:fs";
import {
  ALIBABA_CODING_PLAN_PROVIDER_ID,
  checkAlibabaCredential,
  checkMinimaxCredential,
  createAlibabaCodingPlanPort,
  createMinimaxTokenPlanPort,
  MINIMAX_TOKEN_PLAN_PROVIDER_ID,
  resolveAlibabaCodingPlanPinnedModel,
  resolveMinimaxPinnedModel,
} from "@madc/adapters";
import { createFakeDeepSeekTransport, createFakeKimiTransport } from "@madc/adapters/testing";
import { startStdioEngine } from "../main.ts";
import { createProviderAgent } from "../provider-agent.ts";
import { applyRegistryTestClock } from "./registry-test-clock.ts";

applyRegistryTestClock();

export const FAKE_MINIMAX_BASE_URL = "https://minimax-fake.invalid/anthropic";
export const FAKE_ALIBABA_BASE_URL = "https://alibaba-fake.invalid/v1";

const wireLog = process.env.MADC_TEST_WIRE_LOG;

/** Every request either fake receives is logged before it is answered. */
function logged(fetchImpl: typeof globalThis.fetch): typeof globalThis.fetch {
  return async (input, init) => {
    if (wireLog !== undefined) {
      appendFileSync(wireLog, `${JSON.stringify({ url: String(input) })}\n`);
    }
    return fetchImpl(input, init);
  };
}

// The Anthropic Messages fake serves MiniMax (same wire); the OpenAI chat fake serves Alibaba.
const minimaxFetch = logged(createFakeKimiTransport().fetch);
const alibabaFetch = logged(createFakeDeepSeekTransport().fetch);

function key(name: string, check: (apiKey: string) => { ok: boolean }): string | null {
  const value = (process.env[name] ?? "").trim();
  return value !== "" && check(value).ok ? value : null;
}

await startStdioEngine(
  createProviderAgent({
    directLanes: [
      {
        providerId: MINIMAX_TOKEN_PLAN_PROVIDER_ID,
        credential: key("MADC_API_KEY_MINIMAX_TOKEN_PLAN", (apiKey) =>
          checkMinimaxCredential(MINIMAX_TOKEN_PLAN_PROVIDER_ID, apiKey),
        ),
        createPort: (apiKey) =>
          createMinimaxTokenPlanPort({
            apiKey,
            baseUrl: FAKE_MINIMAX_BASE_URL,
            fetch: minimaxFetch,
          }),
        resolvePinnedModel: resolveMinimaxPinnedModel,
      },
      {
        providerId: ALIBABA_CODING_PLAN_PROVIDER_ID,
        credential: key("MADC_API_KEY_ALIBABA_CODING_PLAN", (apiKey) =>
          checkAlibabaCredential(ALIBABA_CODING_PLAN_PROVIDER_ID, apiKey, FAKE_ALIBABA_BASE_URL),
        ),
        createPort: (apiKey) =>
          createAlibabaCodingPlanPort({
            apiKey,
            baseUrl: FAKE_ALIBABA_BASE_URL,
            fetch: alibabaFetch,
          }),
        resolvePinnedModel: resolveAlibabaCodingPlanPinnedModel,
      },
    ],
    log: (line) => process.stderr.write(`[madc-engine] ${line}\n`),
  }),
);
