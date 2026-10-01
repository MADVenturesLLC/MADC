/**
 * M1-A9 L1 mock conformance — the four wired direct-key lanes the M1-A4 file
 * (`direct-key-conformance.test.ts`) does not cover: Kimi Code, Ollama Cloud, the MiniMax Token Plan
 * and the Alibaba Cloud Coding Plan. L1 is the plan §7 M1-A4 set — **chat, stream, one tool
 * round-trip, served-model receipt** — and M1-A9 asks for it on every wired lane. Network-free:
 * every request goes to an in-process fake on a `.invalid` host, and every key is a synthetic
 * sentinel.
 *
 * Where each L1 element lives for these four lanes:
 *
 * | Lane | chat + stream + served-model receipt (port) | tool round-trip |
 * | --- | --- | --- |
 * | `kimi-code` | `../kimi-code.test.ts` | this file |
 * | `ollama-cloud` | `./ollama-cloud.test.ts` | this file |
 * | `minimax-token-plan` | `./interactive-plans.test.ts` | this file |
 * | `alibaba-coding-plan` | `./interactive-plans.test.ts` | this file |
 *
 * The engine-side receipt for every wired lane (protocol item with `lane`, `mode`, `fallbackFrom`,
 * `vendorReported`) is proved once per lane in `packages/engine/src/lane-l1.test.ts`.
 *
 * WHY THIS FILE IMPORTS pi-ai — the same documented narrowing as the M1-A4 file. `ProviderPort` is
 * text-only and M1 commissions no direct-lane tool loop, so the Founder ruled (2026-09-30, recorded
 * in `direct-key-conformance.test.ts`) that a direct lane's tool round-trip is proved against the
 * LANE'S OWN pi-ai configuration: its provider builder, wire api, endpoint shape and key auth. Each
 * lane module exports that builder (`buildKimiProvider`, `buildOllamaCloudProvider`,
 * `buildMinimaxProvider`, `buildAlibabaCodingPlanProvider` + `alibabaCodingPlanModel`) and its port
 * streams through the same function, so this test drives exactly what production streams through.
 * The file is allowlisted in `packages/engine/src/provider.test.ts` and stays inside
 * `packages/adapters`, so plan §5's package rule still holds.
 *
 * What a tool round-trip does NOT prove here: that a turn through the engine runs tools. It does
 * not — `turn/start` carries no tool definitions in M1 — and nothing below claims otherwise.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  createModels,
  type Model,
  type Provider,
  Type,
} from "@earendil-works/pi-ai";
import {
  ALIBABA_CODING_PLAN_PI_PROVIDER,
  ALIBABA_CODING_PLAN_WIRE_API,
  alibabaCodingPlanModel,
  buildAlibabaCodingPlanProvider,
  buildKimiProvider,
  buildMinimaxProvider,
  buildOllamaCloudProvider,
  honestUserAgent,
  KIMI_PI_PROVIDER,
  kimiCatalogModelIds,
  MINIMAX_PI_PROVIDER,
  MINIMAX_WIRE_API,
  minimaxCatalogModelIds,
  OLLAMA_PI_PROVIDER,
} from "../index.ts";
import {
  createFakeDeepSeekTransport,
  createFakeKimiTransport,
  createFakeOllamaTransport,
} from "../testing/index.ts";

/** Synthetic. No real credential is ever used, and CI never reaches the network. */
const KEY = "test-sentinel-key-a9-l1";
const MINIMAX_KEY = "sk-cp-synthetic-token-plan-key-a9-l1";
const ALIBABA_KEY = "sk-sp-synthetic-coding-plan-key-a9-l1";
const TOOL_NAME = "get_weather";
const TOOL_CALL_ARGS = { city: "Miami" } as const;
const TOOL_OUTPUT = "28C and sunny";

/** One declared tool, built with pi-ai's re-exported TypeBox so no new dependency is added. */
const WEATHER_TOOL = {
  name: TOOL_NAME,
  description: "Look up the current weather for a city.",
  parameters: Type.Object({ city: Type.String() }),
};

type RecordedRequest = {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
};

async function drain(stream: AssistantMessageEventStream): Promise<AssistantMessage> {
  for await (const _event of stream) {
    // Only the final message matters here; the port's delta handling is covered elsewhere.
  }
  return await stream.result();
}

function textOf(message: AssistantMessage): string {
  return message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function toolCallOf(message: AssistantMessage): { id: string; name: string; arguments: unknown } {
  const call = message.content.find((part) => part.type === "toolCall");
  assert.ok(call, `expected a toolCall content part, got ${JSON.stringify(message.content)}`);
  return call as unknown as { id: string; name: string; arguments: unknown };
}

/** The endpoint a request hit, without the query the Anthropic SDK appends (`?beta=true`). */
function endpointOf(request: RecordedRequest): string {
  const url = new URL(request.url);
  return `${url.origin}${url.pathname}`;
}

/**
 * Leg 1 declares the tool and receives the call; leg 2 returns the tool result and receives the
 * final answer — both through the lane's own provider registration, wire api and key auth.
 */
async function toolRoundTrip(lane: {
  readonly provider: Provider<Api>;
  readonly model: Model<Api>;
  readonly apiKey: string;
  readonly fetch: typeof globalThis.fetch;
  readonly requests: () => readonly RecordedRequest[];
  readonly callId: string;
  readonly headers?: Readonly<Record<string, string>>;
}): Promise<void> {
  const catalog = createModels();
  catalog.setProvider(lane.provider);
  const timestamp = Date.now();
  const options = () => ({
    apiKey: lane.apiKey,
    fetch: lane.fetch,
    // Provider-scoped env, as the port does: pi-ai never consults ambient process env here.
    env: {},
    signal: new AbortController().signal,
    ...(lane.headers === undefined ? {} : { headers: { ...lane.headers } }),
  });

  const first = await drain(
    catalog.stream(
      lane.model,
      {
        messages: [{ role: "user", content: "weather in Miami?", timestamp }],
        tools: [WEATHER_TOOL],
      },
      options(),
    ),
  );
  const call = toolCallOf(first);
  assert.equal(call.name, TOOL_NAME);
  assert.deepEqual(call.arguments, TOOL_CALL_ARGS);
  assert.equal(call.id, lane.callId);
  assert.equal(first.stopReason, "toolUse");
  // The declaration really went on the wire — this is what makes it a round-trip, not a stub.
  assert.ok(lane.requests()[0]?.body.includes(TOOL_NAME), "the request declared the tool");

  const second = await drain(
    catalog.stream(
      lane.model,
      {
        messages: [
          { role: "user", content: "weather in Miami?", timestamp },
          first,
          {
            role: "toolResult",
            toolCallId: call.id,
            toolName: TOOL_NAME,
            content: [{ type: "text", text: TOOL_OUTPUT }],
            isError: false,
            timestamp,
          },
        ],
        tools: [WEATHER_TOOL],
      },
      options(),
    ),
  );
  assert.equal(textOf(second), TOOL_OUTPUT);
  assert.equal(second.stopReason, "stop");
  assert.equal(lane.requests().length, 2, "exactly two requests: the call and the result");
  const replay = lane.requests()[1]?.body ?? "";
  assert.ok(replay.includes(TOOL_OUTPUT), "the second request carried the tool result");
  assert.ok(replay.includes(lane.callId), "the second request referenced the tool-call id");
}

// ======================================================================= Kimi Code

test("A9 L1 Kimi Code: one tool round-trip on the lane's own pi-ai configuration", async () => {
  const MODEL = "kimi-for-coding";
  const BASE = "https://kimi-fake.invalid/coding";
  const callId = "toolu_kimi_a9_1";
  assert.ok(kimiCatalogModelIds().includes(MODEL), "fixture model must be in the pinned catalog");
  const provider = buildKimiProvider();
  const listed = createModels();
  listed.setProvider(provider);
  const model = listed.getModel(KIMI_PI_PROVIDER, MODEL);
  assert.ok(model, "the lane's catalog must list the model");
  assert.equal(model.api, "anthropic-messages");

  const fake = createFakeKimiTransport({ type: "stream", chunks: [TOOL_OUTPUT], model: MODEL });
  fake.queueReply({
    type: "tool-call",
    id: callId,
    name: TOOL_NAME,
    args: TOOL_CALL_ARGS,
    model: MODEL,
  });
  // The lane's honest-UA requirement (registry `clientIdentity: "honest-ua-required"`) is part of
  // its configuration, so the round-trip sends it exactly as the port does.
  const userAgent = honestUserAgent("0.0.0");
  await toolRoundTrip({
    provider,
    model: { ...model, baseUrl: BASE },
    apiKey: KEY,
    fetch: fake.fetch,
    requests: () => fake.requests,
    callId,
    headers: { "User-Agent": userAgent },
  });
  for (const request of fake.requests) {
    assert.equal(endpointOf(request), `${BASE}/v1/messages`);
    assert.equal(request.headers["x-api-key"], KEY, "the key travels in x-api-key");
    assert.equal(request.headers.authorization, undefined, "never a Bearer / OAuth header");
    assert.equal(request.headers["user-agent"], userAgent, "the honest madc UA on every leg");
  }
});

// ===================================================================== Ollama Cloud

test("A9 L1 Ollama Cloud: one tool round-trip on the lane's own pi-ai configuration", async () => {
  const MODEL = "gpt-oss-120b";
  const BASE = "https://ollama-fake.invalid/v1";
  const callId = "call_ollama_a9_1";
  // The lane's catalog is the live /api/tags answer; here that answer is the one fixture id.
  const provider = buildOllamaCloudProvider(BASE, [MODEL]);
  const listed = createModels();
  listed.setProvider(provider);
  const model = listed.getModel(OLLAMA_PI_PROVIDER, MODEL);
  assert.ok(model, "the listed id is in the lane's catalog");
  assert.equal(model.api, "openai-completions");
  assert.equal(model.baseUrl, BASE);

  const fake = createFakeOllamaTransport({
    replies: [
      { type: "tool-call", id: callId, name: TOOL_NAME, args: TOOL_CALL_ARGS, model: MODEL },
    ],
    reply: { type: "stream", chunks: [TOOL_OUTPUT], model: MODEL },
  });
  await toolRoundTrip({
    provider,
    model,
    apiKey: KEY,
    fetch: fake.fetch,
    requests: () => fake.requests,
    callId,
  });
  for (const request of fake.requests) {
    assert.equal(request.url, `${BASE}/chat/completions`);
    assert.equal(request.headers.authorization, `Bearer ${KEY}`);
  }
});

// =============================================================== MiniMax Token Plan

test("A9 L1 MiniMax Token Plan: one tool round-trip on the lane's own pi-ai configuration", async () => {
  const MODEL = "MiniMax-M3";
  const BASE = "https://minimax-fake.invalid/anthropic";
  const callId = "toolu_minimax_a9_1";
  assert.ok(
    minimaxCatalogModelIds().includes(MODEL),
    "fixture model must be in the pinned catalog",
  );
  const provider = buildMinimaxProvider();
  const listed = createModels();
  listed.setProvider(provider);
  const model = listed.getModel(MINIMAX_PI_PROVIDER, MODEL);
  assert.ok(model, "the lane's catalog must list the model");
  assert.equal(model.api, MINIMAX_WIRE_API);

  // MiniMax speaks Anthropic Messages, so it shares the Anthropic-Messages fake with Kimi.
  const fake = createFakeKimiTransport({ type: "stream", chunks: [TOOL_OUTPUT], model: MODEL });
  fake.queueReply({
    type: "tool-call",
    id: callId,
    name: TOOL_NAME,
    args: TOOL_CALL_ARGS,
    model: MODEL,
  });
  await toolRoundTrip({
    provider,
    model: { ...model, baseUrl: BASE },
    // Plan key only: the credential-class rule (ruling 12) is the port's, proved in
    // interactive-plans.test.ts; the round-trip uses a key of the right class anyway.
    apiKey: MINIMAX_KEY,
    fetch: fake.fetch,
    requests: () => fake.requests,
    callId,
  });
  for (const request of fake.requests) {
    assert.equal(endpointOf(request), `${BASE}/v1/messages`);
    assert.equal(request.headers["x-api-key"], MINIMAX_KEY);
    assert.equal(request.headers.authorization, undefined, "never a Bearer / OAuth header");
    assert.equal(request.headers["x-app"], undefined, "no vendor client is impersonated");
  }
});

// ============================================================== Alibaba Coding Plan

test("A9 L1 Alibaba Coding Plan: one tool round-trip on the lane's own pi-ai configuration", async () => {
  const MODEL = "qwen3-coder-plus";
  const BASE = "https://alibaba-fake.invalid/v1";
  const callId = "call_alibaba_a9_1";
  // No pinned catalog lists this endpoint: the provider registers no models and the id passes
  // through as the lane's own model record (honest zeros for pricing and context).
  const provider = buildAlibabaCodingPlanProvider(BASE);
  const model = alibabaCodingPlanModel(MODEL, BASE);
  assert.equal(model.provider, ALIBABA_CODING_PLAN_PI_PROVIDER);
  assert.equal(model.api, ALIBABA_CODING_PLAN_WIRE_API);

  // The Coding Plan endpoint speaks OpenAI chat-completions; the DeepSeek fake answers that wire.
  const fake = createFakeDeepSeekTransport({
    replies: [
      { type: "tool-call", id: callId, name: TOOL_NAME, args: TOOL_CALL_ARGS, model: MODEL },
    ],
    reply: { type: "stream", chunks: [TOOL_OUTPUT], model: MODEL },
  });
  await toolRoundTrip({
    provider,
    model,
    apiKey: ALIBABA_KEY,
    fetch: fake.fetch,
    requests: () => fake.requests,
    callId,
  });
  for (const request of fake.requests) {
    assert.equal(request.url, `${BASE}/chat/completions`);
    assert.equal(request.headers.authorization, `Bearer ${ALIBABA_KEY}`);
    const body = JSON.parse(request.body) as { store?: unknown };
    assert.equal("store" in body, false, "the lane's pinned compat holds on the tool legs too");
  }
});
