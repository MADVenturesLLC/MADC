/**
 * M1-A4 L1 mock conformance, one set per provider: **chat, stream, one tool round-trip, and a
 * served-model receipt** (plan §7 M1-A4 acceptance; L1 is defined in the M0 sizing note as "chat,
 * streaming, one tool round-trip, JSON output"). Network-free: every lane talks to an in-process
 * fake on a `.invalid` host, and every credential is a synthetic sentinel.
 *
 * WHY THIS FILE IMPORTS pi-ai (a documented narrowing of the M1-A3 convention)
 *
 * Plan §5 carries M0 §6's import rule as a PACKAGE rule: "`adapters` is the only importer of
 * `@earendil-works/pi-ai`". The `PI_AI_IMPORTERS` allowlist in `packages/engine/src/provider.test.ts`
 * additionally kept *fakes and tests* out, which was enforceable while every lane's L1 surface was
 * the MAD `ProviderPort`. M1-A4's acceptance adds a tool round-trip, and M1 commissions no
 * direct-lane tool loop: `ProviderPort` is text-only and `turn/start` accepts no tool definitions.
 * The Founder ruled (2026-09-30) that the round-trip is proved against the LANE'S OWN pi-ai
 * configuration — its built-in provider, wire api, endpoint and key auth — rather than by widening
 * that shared seam. Driving pi-ai's catalog is therefore unavoidable here, so this ONE test file is
 * allowlisted. It stays inside `packages/adapters`, so the plan's rule still holds.
 *
 * HONESTY NOTE the receipts depend on (verified against pi-ai 0.87.1, `dist/api/*.js`): only
 * `openai-completions` and `anthropic-messages` ever assign `responseModel`. So DeepSeek is the only
 * A4 lane that can surface a vendor-reported identity; Mistral, Gemini and xAI cannot, even though
 * their real responses carry a model field. These tests assert that truth rather than a nicer one:
 * on those three lanes `servedModel` is the requested id and `vendorReported` is absent, which the
 * engine turns into `vendorReported: false` (protocol pin §5 honesty rule).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  createModels,
  Type,
} from "@earendil-works/pi-ai";
import {
  buildDeepseekProvider,
  buildGeminiProvider,
  buildMistralProvider,
  buildXaiProvider,
  createDeepseekPort,
  createGeminiPort,
  createMistralPort,
  createXaiPort,
  DEEPSEEK_PI_PROVIDER,
  DEEPSEEK_PROVIDER_ID,
  deepseekCatalogModelIds,
  GEMINI_PI_PROVIDER,
  GEMINI_PROVIDER_ID,
  geminiCatalogModelIds,
  MISTRAL_PI_PROVIDER,
  MISTRAL_PROVIDER_ID,
  mistralCatalogModelIds,
  providerErrorStatus,
  XAI_PI_PROVIDER,
  XAI_PROVIDER_ID,
  xaiCatalogModelIds,
} from "../index.ts";
import { ProviderCallError, type ProviderPort, type ProviderTurnResult } from "../provider-port.ts";
import {
  createFakeDeepSeekTransport,
  createFakeGeminiTransport,
  createFakeMistralTransport,
  createFakeXaiTransport,
  fakeXaiToolCallId,
} from "../testing/index.ts";

/** Synthetic. No real credential is ever used, and CI never reaches the network. */
const KEY = "test-sentinel-key-a4-conformance";
const TOOL_NAME = "get_weather";
const TOOL_CALL_ARGS = { city: "Miami" } as const;

/** One declared tool, built with pi-ai's re-exported TypeBox so no new dependency is added. */
const WEATHER_TOOL = {
  name: TOOL_NAME,
  description: "Look up the current weather for a city.",
  parameters: Type.Object({ city: Type.String() }),
};

type RecordedRequest = {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
};

async function drain(stream: AssistantMessageEventStream): Promise<AssistantMessage> {
  for await (const _event of stream) {
    // The port consumes deltas through callbacks; here only the final message is needed.
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
  assert.equal(call.type, "toolCall");
  return call as unknown as { id: string; name: string; arguments: unknown };
}

/** What every lane must send: its own endpoint, its own auth header, the sentinel key, the prompt. */
function assertRequestShape(
  request: RecordedRequest | undefined,
  expected: { url: string; authHeader: string; authValue: string; prompt: string },
): void {
  assert.ok(request, "the lane must have made exactly one request");
  assert.equal(request.method, "POST");
  assert.equal(request.url, expected.url);
  assert.equal(request.headers[expected.authHeader], expected.authValue);
  // The credential reaches the wire as the sentinel and nothing else; a real key is never involved.
  assert.ok(request.body.includes(expected.prompt), "the request body carries the user text");
}

async function streamViaPort(
  port: ProviderPort,
  modelId: string,
  prompt: string,
): Promise<{ result: ProviderTurnResult; deltas: string[] }> {
  const deltas: string[] = [];
  const result = await port.streamTurn({
    modelId,
    messages: [{ role: "user", text: prompt }],
    signal: new AbortController().signal,
    onTextDelta: (delta) => deltas.push(delta),
  });
  return { result, deltas };
}

// ========================================================================= Mistral

const MISTRAL_MODEL = "mistral-small-latest";
const MISTRAL_BASE = "https://mistral-fake.invalid";
const MISTRAL_URL = `${MISTRAL_BASE}/v1/chat/completions`;

test("A4 L1 Mistral: chat + stream + served-model receipt", async () => {
  assert.ok(
    mistralCatalogModelIds().includes(MISTRAL_MODEL),
    "fixture model must be in the catalog",
  );
  const fake = createFakeMistralTransport({
    reply: { type: "stream", chunks: ["Hello", " from", " Mistral"], model: MISTRAL_MODEL },
  });
  const port = createMistralPort({ apiKey: KEY, baseUrl: MISTRAL_BASE, fetch: fake.fetch });
  const { result, deltas } = await streamViaPort(port, MISTRAL_MODEL, "hello mistral");

  assert.deepEqual(deltas, ["Hello", " from", " Mistral"], "deltas arrive in wire order");
  assert.equal(result.text, "Hello from Mistral");
  assert.equal(result.requestedModelId, MISTRAL_MODEL);
  // pi-ai's mistral-conversations adapter never assigns responseModel, so the receipt records the
  // requested id and claims NO vendor-reported identity (protocol pin §5 honesty rule).
  assert.equal(result.servedModel, MISTRAL_MODEL);
  assert.equal("vendorReported" in result, false, "no vendor identity was reported");
  assertRequestShape(fake.requests[0], {
    url: MISTRAL_URL,
    authHeader: "authorization",
    authValue: `Bearer ${KEY}`,
    prompt: "hello mistral",
  });
  assert.ok(fake.requests[0]?.body.includes(`"model":"${MISTRAL_MODEL}"`));
});

test("A4 L1 Mistral: one tool round-trip on the lane's own pi-ai configuration", async () => {
  const callId = "call0001"; // Mistral normalizes tool-call ids to 9 alphanumerics
  const fake = createFakeMistralTransport({
    replies: [
      {
        type: "tool-call",
        id: callId,
        name: TOOL_NAME,
        args: TOOL_CALL_ARGS,
        model: MISTRAL_MODEL,
      },
      { type: "stream", chunks: ["28C and sunny"], model: MISTRAL_MODEL },
    ],
  });
  const catalog = createModels();
  catalog.setProvider(buildMistralProvider());
  const model = catalog.getModel(MISTRAL_PI_PROVIDER, MISTRAL_MODEL);
  assert.ok(model, "the lane's catalog must list the model");
  const target = { ...model, baseUrl: MISTRAL_BASE };
  const timestamp = Date.now();

  // Leg 1: declare the tool, receive the call.
  const first = await drain(
    catalog.stream(
      target,
      {
        messages: [{ role: "user", content: "weather in Miami?", timestamp }],
        tools: [WEATHER_TOOL],
      },
      { apiKey: KEY, fetch: fake.fetch, env: {}, signal: new AbortController().signal },
    ),
  );
  const call = toolCallOf(first);
  assert.equal(call.name, TOOL_NAME);
  assert.deepEqual(call.arguments, TOOL_CALL_ARGS);
  assert.equal(call.id, callId);
  assert.equal(first.stopReason, "toolUse");
  // The tool declaration really went on the wire — this is what makes it a round-trip, not a stub.
  assert.ok(fake.requests[0]?.body.includes(TOOL_NAME), "the request declared the tool");

  // Leg 2: return the tool result, receive the final answer.
  const second = await drain(
    catalog.stream(
      target,
      {
        messages: [
          { role: "user", content: "weather in Miami?", timestamp },
          first,
          {
            role: "toolResult",
            toolCallId: call.id,
            toolName: TOOL_NAME,
            content: [{ type: "text", text: "28C and sunny" }],
            isError: false,
            timestamp,
          },
        ],
        tools: [WEATHER_TOOL],
      },
      { apiKey: KEY, fetch: fake.fetch, env: {}, signal: new AbortController().signal },
    ),
  );
  assert.equal(textOf(second), "28C and sunny");
  assert.equal(fake.requests.length, 2, "exactly two requests: the call and the result");
  const replay = fake.requests[1]?.body ?? "";
  assert.ok(replay.includes("28C and sunny"), "the second request carried the tool result");
  assert.ok(replay.includes(callId), "the second request referenced the tool-call id");
});

test("A4 L1 Mistral: 429 and 502 map to the recorded quota signal; abort is an abort", async () => {
  for (const status of [429, 502]) {
    const fake = createFakeMistralTransport({
      reply: { type: "status", status, body: JSON.stringify({ message: "nope" }) },
    });
    const port = createMistralPort({ apiKey: KEY, baseUrl: MISTRAL_BASE, fetch: fake.fetch });
    const err = await port
      .streamTurn({
        modelId: MISTRAL_MODEL,
        messages: [{ role: "user", text: "x" }],
        signal: new AbortController().signal,
        onTextDelta: () => {},
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    assert.ok(err instanceof ProviderCallError, `${status} must raise ProviderCallError`);
    assert.equal(err.status, status);
    assert.equal(err.reason, "quota-or-unreachable", `${status} is the recorded quota signal`);
    assert.equal(err.message.includes("nope"), false, "upstream body text is never surfaced");
  }
  // A 401 is an ordinary failure, not a quota signal.
  const unauthorized = createFakeMistralTransport({
    reply: { type: "status", status: 401, body: "{}" },
  });
  const port = createMistralPort({ apiKey: KEY, baseUrl: MISTRAL_BASE, fetch: unauthorized.fetch });
  const err = await port
    .streamTurn({
      modelId: MISTRAL_MODEL,
      messages: [{ role: "user", text: "x" }],
      signal: new AbortController().signal,
      onTextDelta: () => {},
    })
    .then(
      () => null,
      (e: unknown) => e,
    );
  assert.ok(err instanceof ProviderCallError);
  assert.equal(err.status, 401);
  assert.equal(err.reason, undefined);

  // Abort mid-stream.
  const hang = createFakeMistralTransport({ reply: { type: "hang", model: MISTRAL_MODEL } });
  const hangPort = createMistralPort({ apiKey: KEY, baseUrl: MISTRAL_BASE, fetch: hang.fetch });
  const controller = new AbortController();
  const aborted = hangPort
    .streamTurn({
      modelId: MISTRAL_MODEL,
      messages: [{ role: "user", text: "x" }],
      signal: controller.signal,
      onTextDelta: () => controller.abort(),
    })
    .then(
      () => null,
      (e: unknown) => e,
    );
  const abortErr = await aborted;
  assert.ok(abortErr instanceof ProviderCallError);
  assert.equal(abortErr.kind, "aborted");
});

// ========================================================================= DeepSeek

const DEEPSEEK_MODEL = "deepseek-flash";
const DEEPSEEK_SERVED = "deepseek-flash-0408";
const DEEPSEEK_BASE = "https://deepseek-fake.invalid";
const DEEPSEEK_URL = `${DEEPSEEK_BASE}/chat/completions`;

test("A4 L1 DeepSeek: chat + stream + a VENDOR-REPORTED served-model receipt", async () => {
  assert.ok(deepseekCatalogModelIds().includes(DEEPSEEK_MODEL));
  // openai-completions sets responseModel only when the frame's model DIFFERS from the request, so
  // the fixture reports a distinct identity — the case that makes `vendorReported: true` honest.
  const fake = createFakeDeepSeekTransport({
    reply: { type: "stream", chunks: ["Hello", " from", " DeepSeek"], model: DEEPSEEK_SERVED },
  });
  const port = createDeepseekPort({ apiKey: KEY, baseUrl: DEEPSEEK_BASE, fetch: fake.fetch });
  const { result, deltas } = await streamViaPort(port, DEEPSEEK_MODEL, "hello deepseek");

  assert.deepEqual(deltas, ["Hello", " from", " DeepSeek"]);
  assert.equal(result.text, "Hello from DeepSeek");
  assert.equal(result.requestedModelId, DEEPSEEK_MODEL);
  assert.equal(result.servedModel, DEEPSEEK_SERVED, "the vendor-reported identity wins");
  assert.equal(result.vendorReported, true);
  assertRequestShape(fake.requests[0], {
    url: DEEPSEEK_URL,
    authHeader: "authorization",
    authValue: `Bearer ${KEY}`,
    prompt: "hello deepseek",
  });
});

test("A4 L1 DeepSeek: a frame that only echoes the request claims no vendor identity", async () => {
  const fake = createFakeDeepSeekTransport({
    reply: { type: "stream", chunks: ["ok"], model: DEEPSEEK_MODEL },
  });
  const port = createDeepseekPort({ apiKey: KEY, baseUrl: DEEPSEEK_BASE, fetch: fake.fetch });
  const { result } = await streamViaPort(port, DEEPSEEK_MODEL, "x");
  assert.equal(result.servedModel, DEEPSEEK_MODEL);
  assert.equal("vendorReported" in result, false, "an echoed id is not a vendor-reported identity");

  const silent = createFakeDeepSeekTransport({
    reply: { type: "stream-no-model", chunks: ["ok"] },
  });
  const silentPort = createDeepseekPort({
    apiKey: KEY,
    baseUrl: DEEPSEEK_BASE,
    fetch: silent.fetch,
  });
  const { result: noModel } = await streamViaPort(silentPort, DEEPSEEK_MODEL, "x");
  assert.equal(noModel.servedModel, DEEPSEEK_MODEL, "the receipt falls back to the requested id");
  assert.equal("vendorReported" in noModel, false);
});

test("A4 L1 DeepSeek: one tool round-trip on the lane's own pi-ai configuration", async () => {
  const callId = "ds_call_1";
  const fake = createFakeDeepSeekTransport({
    replies: [
      {
        type: "tool-call",
        id: callId,
        name: TOOL_NAME,
        args: TOOL_CALL_ARGS,
        model: DEEPSEEK_MODEL,
      },
      { type: "stream", chunks: ["28C and sunny"], model: DEEPSEEK_MODEL },
    ],
  });
  const catalog = createModels();
  catalog.setProvider(buildDeepseekProvider());
  const model = catalog.getModel(DEEPSEEK_PI_PROVIDER, DEEPSEEK_MODEL);
  assert.ok(model);
  const target = { ...model, baseUrl: DEEPSEEK_BASE };
  const timestamp = Date.now();

  const first = await drain(
    catalog.stream(
      target,
      {
        messages: [{ role: "user", content: "weather in Miami?", timestamp }],
        tools: [WEATHER_TOOL],
      },
      { apiKey: KEY, fetch: fake.fetch, env: {}, signal: new AbortController().signal },
    ),
  );
  const call = toolCallOf(first);
  assert.equal(call.name, TOOL_NAME);
  assert.deepEqual(call.arguments, TOOL_CALL_ARGS);
  assert.equal(call.id, callId);

  const second = await drain(
    catalog.stream(
      target,
      {
        messages: [
          { role: "user", content: "weather in Miami?", timestamp },
          first,
          {
            role: "toolResult",
            toolCallId: call.id,
            toolName: TOOL_NAME,
            content: [{ type: "text", text: "28C and sunny" }],
            isError: false,
            timestamp,
          },
        ],
        tools: [WEATHER_TOOL],
      },
      { apiKey: KEY, fetch: fake.fetch, env: {}, signal: new AbortController().signal },
    ),
  );
  assert.equal(textOf(second), "28C and sunny");
  assert.equal(fake.requests.length, 2);
  assert.ok((fake.requests[1]?.body ?? "").includes("28C and sunny"));
});

test("A4 L1 DeepSeek: 429 maps to the recorded quota signal", async () => {
  const fake = createFakeDeepSeekTransport({
    reply: { type: "status", status: 429, body: JSON.stringify({ error: "rate limited" }) },
  });
  const port = createDeepseekPort({ apiKey: KEY, baseUrl: DEEPSEEK_BASE, fetch: fake.fetch });
  const err = await port
    .streamTurn({
      modelId: DEEPSEEK_MODEL,
      messages: [{ role: "user", text: "x" }],
      signal: new AbortController().signal,
      onTextDelta: () => {},
    })
    .then(
      () => null,
      (e: unknown) => e,
    );
  assert.ok(err instanceof ProviderCallError);
  assert.equal(err.status, 429);
  assert.equal(err.reason, "quota-or-unreachable");
  assert.equal(err.message.includes("rate limited"), false);
});

// =========================================================================== Gemini

const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_BASE = "https://gemini-fake.invalid/v1beta";
const GEMINI_URL = `${GEMINI_BASE}/models/${GEMINI_MODEL}:streamGenerateContent?alt=sse`;

test("A4 L1 Gemini: chat + stream + served-model receipt, over x-goog-api-key", async () => {
  assert.ok(geminiCatalogModelIds().includes(GEMINI_MODEL));
  const fake = createFakeGeminiTransport({
    reply: { type: "stream", chunks: ["Hello", " from", " Gemini"], model: GEMINI_MODEL },
  });
  // pi-ai's google adapter REFUSES a custom fetch, so the fake patches globalThis.fetch instead and
  // the port is built with no `fetch` option at all.
  fake.install();
  try {
    const port = createGeminiPort({ apiKey: KEY, baseUrl: GEMINI_BASE });
    const { result, deltas } = await streamViaPort(port, GEMINI_MODEL, "hello gemini");

    assert.deepEqual(deltas, ["Hello", " from", " Gemini"]);
    assert.equal(result.text, "Hello from Gemini");
    assert.equal(result.requestedModelId, GEMINI_MODEL);
    // google-generative-ai never assigns responseModel: the receipt records the requested id and
    // claims no vendor identity, even though the frames carried a modelVersion.
    assert.equal(result.servedModel, GEMINI_MODEL);
    assert.equal("vendorReported" in result, false);
    assertRequestShape(fake.requests[0], {
      url: GEMINI_URL,
      // Auth is the x-goog-api-key header, NOT a Bearer token.
      authHeader: "x-goog-api-key",
      authValue: KEY,
      prompt: "hello gemini",
    });
    assert.equal(
      fake.requests[0]?.headers.authorization,
      undefined,
      "no Bearer header on this lane",
    );
  } finally {
    fake.restore();
  }
});

test("A4 L1 Gemini: one tool round-trip on the lane's own pi-ai configuration", async () => {
  const callId = "gemini_call_1";
  const fake = createFakeGeminiTransport({
    replies: [
      { type: "tool-call", id: callId, name: TOOL_NAME, args: TOOL_CALL_ARGS, model: GEMINI_MODEL },
      { type: "stream", chunks: ["28C and sunny"], model: GEMINI_MODEL },
    ],
  });
  fake.install();
  try {
    const catalog = createModels();
    catalog.setProvider(buildGeminiProvider());
    const model = catalog.getModel(GEMINI_PI_PROVIDER, GEMINI_MODEL);
    assert.ok(model);
    const target = { ...model, baseUrl: GEMINI_BASE };
    const timestamp = Date.now();
    const options = { apiKey: KEY, env: {}, signal: new AbortController().signal };

    const first = await drain(
      catalog.stream(
        target,
        {
          messages: [{ role: "user", content: "weather in Miami?", timestamp }],
          tools: [WEATHER_TOOL],
        },
        options,
      ),
    );
    const call = toolCallOf(first);
    assert.equal(call.name, TOOL_NAME);
    assert.deepEqual(call.arguments, TOOL_CALL_ARGS);
    assert.equal(call.id, callId);
    assert.ok(
      (fake.requests[0]?.body ?? "").includes(TOOL_NAME),
      "the request declared the tool as a functionDeclaration",
    );

    const second = await drain(
      catalog.stream(
        target,
        {
          messages: [
            { role: "user", content: "weather in Miami?", timestamp },
            first,
            {
              role: "toolResult",
              toolCallId: call.id,
              toolName: TOOL_NAME,
              content: [{ type: "text", text: "28C and sunny" }],
              isError: false,
              timestamp,
            },
          ],
          tools: [WEATHER_TOOL],
        },
        { ...options, signal: new AbortController().signal },
      ),
    );
    assert.equal(textOf(second), "28C and sunny");
    assert.equal(fake.requests.length, 2);
    assert.ok((fake.requests[1]?.body ?? "").includes("28C and sunny"));
  } finally {
    fake.restore();
  }
});

test("A4 L1 Gemini: a 429 is a provider failure, but pi-ai 0.87.1 reports NO status on this wire", async () => {
  // PINNED LIMITATION, asserted rather than hidden. On the `google-generative-ai` wire pi-ai's
  // `formatProviderError` returns the `@google/genai` error message unchanged (it decides the
  // message already carries the body), and `onResponse` is not called on the error path. So the
  // HTTP status is unrecoverable from pi-ai's public surface here, and a 429 on the Gemini lane
  // yields an ordinary failure with `status: null` — NOT the recorded `quota-or-unreachable`
  // signal that the Mistral, DeepSeek and xAI lanes do produce. The fallback walk therefore will
  // not treat a Gemini quota error as quota. Guessing the status out of an upstream JSON body was
  // rejected: the port's contract is that it never parses or propagates upstream text.
  const fake = createFakeGeminiTransport({
    reply: { type: "status", status: 429, body: '{"error":{"code":429,"message":"quota"}}' },
  });
  fake.install();
  try {
    const port = createGeminiPort({ apiKey: KEY, baseUrl: GEMINI_BASE });
    const err = await port
      .streamTurn({
        modelId: GEMINI_MODEL,
        messages: [{ role: "user", text: "x" }],
        signal: new AbortController().signal,
        onTextDelta: () => {},
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    assert.ok(err instanceof ProviderCallError, "a 429 must still fail the call");
    assert.equal(err.kind, "failed");
    assert.equal(err.status, null, "no HTTP status is recoverable on this wire in pi-ai 0.87.1");
    assert.equal(
      err.reason,
      undefined,
      "so no quota signal is recorded — this is the limitation, not a pass",
    );
    assert.equal(err.message.includes("quota"), false, "upstream body text is never surfaced");
  } finally {
    fake.restore();
  }
});

test("A4 L1: providerErrorStatus reads every shape pi-ai 0.87.1 emits", () => {
  // The extractor that makes the xAI lane's quota signal work, pinned against the exact strings the
  // pinned pi-ai produces (verified by probe, quoted in generic.ts).
  assert.equal(providerErrorStatus('502 {"error":"bad gateway"}'), 502, "no-prefix shape");
  assert.equal(
    providerErrorStatus('xai API error (502): 502 "bad gateway"'),
    502,
    "prefixed shape",
  );
  assert.equal(providerErrorStatus("Mistral API error (429): {}"), 429, "prefixed shape");
  assert.equal(providerErrorStatus("401 unauthorized"), 401);
  // No status anywhere → null, never a guess.
  assert.equal(providerErrorStatus('{"error":{"code":429,"message":"quota"}}'), null);
  assert.equal(providerErrorStatus("Custom fetch is not supported"), null);
  assert.equal(providerErrorStatus(undefined), null);
  assert.equal(providerErrorStatus(""), null);
  // A status-like number that is not an HTTP status is not treated as one.
  assert.equal(providerErrorStatus("(9999) nope"), null);
  assert.equal(providerErrorStatus("(099) nope"), null);
});

// ============================================================================== xAI

const XAI_MODEL = "grok-4.7";
const XAI_BASE = "https://xai-fake.invalid/v1";
const XAI_URL = `${XAI_BASE}/responses`;
const XAI_CALL_ID = "xai_call_1";
const XAI_ITEM_ID = "fc_item_1";

test("A4 L1 xAI: chat + stream + served-model receipt, with the API key only", async () => {
  assert.ok(xaiCatalogModelIds().includes(XAI_MODEL));
  const fake = createFakeXaiTransport({
    reply: { type: "stream", chunks: ["Hello", " from", " Grok"], model: XAI_MODEL },
  });
  const port = createXaiPort({ apiKey: KEY, baseUrl: XAI_BASE, fetch: fake.fetch });
  const { result, deltas } = await streamViaPort(port, XAI_MODEL, "hello grok");

  assert.deepEqual(deltas, ["Hello", " from", " Grok"]);
  assert.equal(result.text, "Hello from Grok");
  assert.equal(result.requestedModelId, XAI_MODEL);
  // openai-responses never assigns responseModel, so `stream` and `stream-no-model` are
  // indistinguishable to pi-ai on this lane and the receipt claims no vendor identity.
  assert.equal(result.servedModel, XAI_MODEL);
  assert.equal("vendorReported" in result, false);
  assertRequestShape(fake.requests[0], {
    url: XAI_URL,
    authHeader: "authorization",
    authValue: `Bearer ${KEY}`,
    prompt: "hello grok",
  });
  // The Responses wire shape, not chat-completions.
  assert.ok((fake.requests[0]?.body ?? "").includes('"input":['));
});

test("A4 L1 xAI: one tool round-trip on the lane's own pi-ai configuration", async () => {
  const fake = createFakeXaiTransport({
    replies: [
      {
        type: "tool-call",
        callId: XAI_CALL_ID,
        itemId: XAI_ITEM_ID,
        name: TOOL_NAME,
        args: TOOL_CALL_ARGS,
        model: XAI_MODEL,
      },
      { type: "stream", chunks: ["28C and sunny"], model: XAI_MODEL },
    ],
  });
  const catalog = createModels();
  catalog.setProvider(buildXaiProvider());
  const model = catalog.getModel(XAI_PI_PROVIDER, XAI_MODEL);
  assert.ok(model);
  const target = { ...model, baseUrl: XAI_BASE };
  const timestamp = Date.now();

  const first = await drain(
    catalog.stream(
      target,
      {
        messages: [{ role: "user", content: "weather in Miami?", timestamp }],
        tools: [WEATHER_TOOL],
      },
      { apiKey: KEY, fetch: fake.fetch, env: {}, signal: new AbortController().signal },
    ),
  );
  const call = toolCallOf(first);
  assert.equal(call.name, TOOL_NAME);
  assert.deepEqual(call.arguments, TOOL_CALL_ARGS);
  // pi-ai's Responses parser surfaces a COMPOSITE id, not the bare call_id.
  assert.equal(call.id, fakeXaiToolCallId(XAI_CALL_ID, XAI_ITEM_ID));

  const second = await drain(
    catalog.stream(
      target,
      {
        messages: [
          { role: "user", content: "weather in Miami?", timestamp },
          first,
          {
            role: "toolResult",
            toolCallId: call.id,
            toolName: TOOL_NAME,
            content: [{ type: "text", text: "28C and sunny" }],
            isError: false,
            timestamp,
          },
        ],
        tools: [WEATHER_TOOL],
      },
      { apiKey: KEY, fetch: fake.fetch, env: {}, signal: new AbortController().signal },
    ),
  );
  assert.equal(textOf(second), "28C and sunny");
  assert.equal(fake.requests.length, 2);
  const replay = fake.requests[1]?.body ?? "";
  assert.ok(replay.includes("28C and sunny"), "the second request carried the tool result");
  assert.ok(replay.includes(XAI_CALL_ID), "the second request referenced the original call_id");
});

test("A4 L1 xAI: 502 maps to the recorded quota signal; abort is an abort", async () => {
  const fake = createFakeXaiTransport({
    reply: { type: "status", status: 502, body: '{"error":"bad gateway"}' },
  });
  const port = createXaiPort({ apiKey: KEY, baseUrl: XAI_BASE, fetch: fake.fetch });
  const err = await port
    .streamTurn({
      modelId: XAI_MODEL,
      messages: [{ role: "user", text: "x" }],
      signal: new AbortController().signal,
      onTextDelta: () => {},
    })
    .then(
      () => null,
      (e: unknown) => e,
    );
  assert.ok(err instanceof ProviderCallError);
  assert.equal(err.status, 502);
  assert.equal(err.reason, "quota-or-unreachable");

  const hang = createFakeXaiTransport({ reply: { type: "hang", model: XAI_MODEL } });
  const hangPort = createXaiPort({ apiKey: KEY, baseUrl: XAI_BASE, fetch: hang.fetch });
  const controller = new AbortController();
  const abortErr = await hangPort
    .streamTurn({
      modelId: XAI_MODEL,
      messages: [{ role: "user", text: "x" }],
      signal: controller.signal,
      onTextDelta: () => controller.abort(),
    })
    .then(
      () => null,
      (e: unknown) => e,
    );
  assert.ok(abortErr instanceof ProviderCallError);
  assert.equal(abortErr.kind, "aborted");
});

// ------------------------------------------------------------------ cross-lane guards

test("A4 L1: an unknown model id is refused without any request reaching the wire", async () => {
  const cases: Array<[ProviderPort, () => RecordedRequest[] | undefined]> = [];
  const mistral = createFakeMistralTransport();
  cases.push([
    createMistralPort({ apiKey: KEY, baseUrl: MISTRAL_BASE, fetch: mistral.fetch }),
    () => mistral.requests,
  ]);
  const deepseek = createFakeDeepSeekTransport();
  cases.push([
    createDeepseekPort({ apiKey: KEY, baseUrl: DEEPSEEK_BASE, fetch: deepseek.fetch }),
    () => deepseek.requests,
  ]);
  const xai = createFakeXaiTransport();
  cases.push([
    createXaiPort({ apiKey: KEY, baseUrl: XAI_BASE, fetch: xai.fetch }),
    () => xai.requests,
  ]);

  for (const [port, requests] of cases) {
    const err = await port
      .streamTurn({
        modelId: "no-such-model-a4",
        messages: [{ role: "user", text: "x" }],
        signal: new AbortController().signal,
        onTextDelta: () => {},
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    assert.ok(err instanceof ProviderCallError, `${port.providerId} must refuse an unknown model`);
    assert.match(err.message, /Unknown .* model "no-such-model-a4"/);
    assert.deepEqual(requests(), [], `${port.providerId} must not call the wire`);
  }
});

test("A4 L1: every lane reports its REGISTRY id, not the pi-ai provider id", async () => {
  const gemini = createFakeGeminiTransport();
  gemini.install();
  try {
    const ports: Array<[ProviderPort, string]> = [
      [createMistralPort({ apiKey: KEY }), MISTRAL_PROVIDER_ID],
      [createDeepseekPort({ apiKey: KEY }), DEEPSEEK_PROVIDER_ID],
      [createGeminiPort({ apiKey: KEY }), GEMINI_PROVIDER_ID],
      [createXaiPort({ apiKey: KEY }), XAI_PROVIDER_ID],
    ];
    for (const [port, id] of ports) assert.equal(port.providerId, id);
    // And the registry id is never the pi-ai id on any of the four (seat pin §3).
    assert.notEqual(MISTRAL_PROVIDER_ID, MISTRAL_PI_PROVIDER);
    assert.notEqual(DEEPSEEK_PROVIDER_ID, DEEPSEEK_PI_PROVIDER);
    assert.notEqual(GEMINI_PROVIDER_ID, GEMINI_PI_PROVIDER);
    assert.notEqual(XAI_PROVIDER_ID, XAI_PI_PROVIDER);
  } finally {
    gemini.restore();
  }
});
