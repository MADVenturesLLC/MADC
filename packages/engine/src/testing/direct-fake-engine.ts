/**
 * Test fixture (M1-A3): the production provider agent with BOTH direct lanes wired — Kimi Code
 * (anthropic-messages) and Ollama Cloud (openai-completions) — against in-process fake transports.
 * Network-free: `.invalid` base URLs (RFC 6761: never resolves), synthetic keys only.
 *
 * - `MADC_TEST_KIMI_REPLY` / `MADC_TEST_KIMI_REPLIES`: JSON `FakeKimiReply` (sticky / queued).
 * - `MADC_TEST_OLLAMA_REPLY` / `MADC_TEST_OLLAMA_REPLIES`: JSON `FakeOllamaReply` (sticky /
 *   queued — a 429-then-success sequence drives the fallback tests).
 * - `MADC_TEST_OLLAMA_TAGS`: JSON string array — the fake `/api/tags` "live list".
 * - `MADC_TEST_WIRE_LOG` / `MADC_TEST_OLLAMA_WIRE_LOG`: one JSON line per provider request.
 * - `KIMI_API_KEY` / `MADC_API_KEY_OLLAMA_CLOUD`: lane credentials (harness env is hermetic).
 */
import { appendFileSync } from "node:fs";
import {
  createKimiCodePort,
  createOllamaCloudPort,
  honestUserAgent,
  readKimiCredential,
  resolveOllamaPinnedModel,
} from "@madc/adapters";
import {
  createFakeKimiTransport,
  createFakeOllamaTransport,
  type FakeKimiReply,
  type FakeOllamaReply,
} from "@madc/adapters/testing";
import type { Agent } from "../agent.ts";
import { startStdioEngine } from "../main.ts";
import { createProviderAgent } from "../provider-agent.ts";
import { ENGINE_VERSION } from "../server.ts";

export const FAKE_KIMI_BASE_URL = "https://kimi-fake.invalid/coding";
export const FAKE_OLLAMA_BASE_URL = "https://ollama-fake.invalid/v1";
export const FAKE_OLLAMA_TAGS_URL = "https://ollama-fake.invalid/api/tags";

function envJson<T>(name: string): T | undefined {
  const raw = process.env[name];
  return raw === undefined ? undefined : (JSON.parse(raw) as T);
}

/** Wrap a fake fetch so every request also lands in the wire log (headers, body). */
function recording(
  fetchImpl: typeof globalThis.fetch,
  requests: { length: number; [index: number]: unknown },
  logPath: string | undefined,
): typeof globalThis.fetch {
  return async (input, init) => {
    const seen = requests.length;
    try {
      return await fetchImpl(input, init);
    } finally {
      const request = requests[seen];
      if (logPath !== undefined && request !== undefined) {
        appendFileSync(logPath, `${JSON.stringify(request)}\n`);
      }
    }
  };
}

const kimiTransport = createFakeKimiTransport(envJson<FakeKimiReply>("MADC_TEST_KIMI_REPLY"));
for (const reply of envJson<FakeKimiReply[]>("MADC_TEST_KIMI_REPLIES") ?? []) {
  kimiTransport.queueReply(reply);
}
const kimiFetch = recording(
  kimiTransport.fetch,
  kimiTransport.requests,
  process.env.MADC_TEST_WIRE_LOG,
);

const ollamaTags = envJson<string[]>("MADC_TEST_OLLAMA_TAGS");
const ollamaReply = envJson<FakeOllamaReply>("MADC_TEST_OLLAMA_REPLY");
const ollamaReplies = envJson<FakeOllamaReply[]>("MADC_TEST_OLLAMA_REPLIES");
const ollamaTransport = createFakeOllamaTransport({
  ...(ollamaTags === undefined ? {} : { tags: ollamaTags }),
  ...(ollamaReply === undefined ? {} : { reply: ollamaReply }),
  ...(ollamaReplies === undefined ? {} : { replies: ollamaReplies }),
});
const ollamaFetch = recording(
  ollamaTransport.fetch,
  ollamaTransport.requests,
  process.env.MADC_TEST_OLLAMA_WIRE_LOG,
);

const ollamaKey = (process.env.MADC_API_KEY_OLLAMA_CLOUD ?? "").trim();

const agent: Agent = createProviderAgent({
  credential: readKimiCredential(process.env),
  createPort: (apiKey) =>
    createKimiCodePort({
      apiKey,
      userAgent: honestUserAgent(ENGINE_VERSION),
      baseUrl: FAKE_KIMI_BASE_URL,
      fetch: kimiFetch,
    }),
  directLanes: [
    {
      providerId: "ollama-cloud",
      credential: ollamaKey === "" ? null : ollamaKey,
      createPort: (apiKey) =>
        createOllamaCloudPort({
          apiKey,
          baseUrl: FAKE_OLLAMA_BASE_URL,
          tagsUrl: FAKE_OLLAMA_TAGS_URL,
          fetch: ollamaFetch,
        }),
      resolvePinnedModel: resolveOllamaPinnedModel,
    },
  ],
  log: (line) => process.stderr.write(`[madc-engine] ${line}\n`),
});

await startStdioEngine(agent);
