/**
 * M1-A3 Ollama Cloud adapter tests. Network-free: every request goes to the in-process fake
 * transport and `.invalid` base URLs; keys are dummy sentinels. Covers the `/api/tags` picker
 * (labelled `listed`), the OpenAI-compat stream through the generic direct port, `servedModel`
 * honesty (responseModel when present, else the requested id), and the 429/502 →
 * `quota-or-unreachable` signal mapping.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createOllamaCloudPort,
  listOllamaCloudModels,
  OLLAMA_API_KEY_ENV,
  OLLAMA_CLOUD_PROVIDER_ID,
  OLLAMA_PI_PROVIDER,
  ProviderCallError,
  type ProviderTurnRequest,
  resolveOllamaPinnedModel,
} from "../index.ts";
import { createFakeOllamaTransport, type FakeOllamaReply } from "../testing/index.ts";

const KEY = "ollama-sentinel-key-7c3d";
const BASE_URL = "https://ollama-fake.invalid/v1";
const TAGS_URL = "https://ollama-fake.invalid/api/tags";
const MODEL = "gpt-oss-120b";

function turnRequest(overrides: Partial<ProviderTurnRequest> = {}): ProviderTurnRequest {
  return {
    modelId: MODEL,
    systemPrompt: "system prompt",
    messages: [{ role: "user", text: "hello" }],
    signal: new AbortController().signal,
    onTextDelta: () => undefined,
    ...overrides,
  };
}

function portWith(
  options: { reply?: FakeOllamaReply; replies?: FakeOllamaReply[]; tags?: string[] } = {},
) {
  const transport = createFakeOllamaTransport(options);
  const port = createOllamaCloudPort({
    apiKey: KEY,
    baseUrl: BASE_URL,
    tagsUrl: TAGS_URL,
    fetch: transport.fetch,
  });
  return { transport, port };
}

// ------------------------------------------------------------------------- the model picker

test("A3 picker: /api/tags answers the live list, labelled `listed` — never `entitled`", async () => {
  const transport = createFakeOllamaTransport({ tags: [MODEL, "qwen3-coder:cloud"] });
  const listed = await listOllamaCloudModels({
    apiKey: KEY,
    baseUrl: BASE_URL,
    fetch: transport.fetch,
  });
  assert.deepEqual(listed, [
    { id: MODEL, source: "listed" },
    { id: "qwen3-coder:cloud", source: "listed" },
  ]);
  const request = transport.requests[0];
  assert.ok(request);
  assert.equal(request.method, "GET");
  assert.equal(request.url, TAGS_URL);
  assert.equal(request.headers.authorization, `Bearer ${KEY}`);
});

test("A3 picker: the tags URL derives from the base URL's origin when not overridden", async () => {
  const transport = createFakeOllamaTransport();
  await listOllamaCloudModels({ apiKey: KEY, baseUrl: BASE_URL, fetch: transport.fetch });
  assert.equal(transport.requests[0]?.url, "https://ollama-fake.invalid/api/tags");
});

test("A3 picker: 429/502 map to the quota-or-unreachable signal; other failures stay plain", async () => {
  for (const status of [429, 502]) {
    const failingFetch: typeof globalThis.fetch = async () =>
      new Response('{"error":"synthetic"}', { status });
    const err = await listOllamaCloudModels({
      apiKey: KEY,
      baseUrl: BASE_URL,
      fetch: failingFetch,
    }).then(
      () => assert.fail("expected failure"),
      (e: unknown) => e,
    );
    assert.ok(err instanceof ProviderCallError, String(status));
    assert.equal(err.status, status);
    assert.equal(err.reason, "quota-or-unreachable", String(status));
    assert.ok(!err.message.includes("synthetic"), "the upstream body never reaches the message");
  }
  const unauthorized: typeof globalThis.fetch = async () => new Response("nope", { status: 401 });
  const err = await listOllamaCloudModels({
    apiKey: KEY,
    baseUrl: BASE_URL,
    fetch: unauthorized,
  }).then(
    () => assert.fail("expected failure"),
    (e: unknown) => e,
  );
  assert.ok(err instanceof ProviderCallError);
  assert.equal(err.status, 401);
  assert.equal(err.reason, undefined);
});

test("A3 picker: a malformed list body is a plain failure, never a crash", async () => {
  const badJson: typeof globalThis.fetch = async () =>
    new Response("{ not json", { status: 200, headers: { "content-type": "application/json" } });
  await assert.rejects(
    () => listOllamaCloudModels({ apiKey: KEY, baseUrl: BASE_URL, fetch: badJson }),
    /not valid JSON/,
  );
  const noModels: typeof globalThis.fetch = async () =>
    new Response(JSON.stringify({ nope: true }), { status: 200 });
  await assert.rejects(
    () => listOllamaCloudModels({ apiKey: KEY, baseUrl: BASE_URL, fetch: noModels }),
    /malformed/,
  );
});

// ------------------------------------------------------------------------------ the port

test("A3 port: streams deltas and reports servedModel from the chunk model (vendorReported)", async () => {
  const { transport, port } = portWith({
    reply: { type: "stream", chunks: ["He", "llo", " Ollama"], model: "gpt-oss-120b-0910" },
  });
  const deltas: string[] = [];
  const result = await port.streamTurn(turnRequest({ onTextDelta: (d) => deltas.push(d) }));
  assert.deepEqual(deltas, ["He", "llo", " Ollama"]);
  assert.deepEqual(result, {
    text: "Hello Ollama",
    requestedModelId: MODEL,
    servedModel: "gpt-oss-120b-0910",
    // OpenAI-compat lanes: the chunk carried a model, so the vendor identity IS reported — even
    // when it equals the requested id (the engine cannot derive that case; the port states it).
    vendorReported: true,
  });
  // One tags fetch (the dynamic catalog) + one chat call; both Bearer-authenticated.
  assert.equal(transport.requests.length, 2);
  for (const request of transport.requests) {
    assert.equal(request.headers.authorization, `Bearer ${KEY}`);
  }
  const chat = transport.requests[1];
  assert.ok(chat?.url.endsWith("/chat/completions"), chat?.url);
  const body = JSON.parse(chat?.body ?? "{}") as { model: string };
  assert.equal(body.model, MODEL);
});

test("A3 port: when chunks carry no model, servedModel is the requested id and nothing claims vendor-reporting", async () => {
  const { port } = portWith({ reply: { type: "stream-no-model", chunks: ["ok"] } });
  const result = await port.streamTurn(turnRequest());
  assert.deepEqual(result, {
    text: "ok",
    requestedModelId: MODEL,
    servedModel: MODEL,
  });
});

test("A3 port: the model list is live truth — an unlisted model is refused, a newly listed one works", async () => {
  const { transport, port } = portWith({ tags: [MODEL] });
  const err = await port.streamTurn(turnRequest({ modelId: "not-listed-yet" })).then(
    () => assert.fail("expected refusal"),
    (e: unknown) => e,
  );
  assert.ok(err instanceof ProviderCallError);
  assert.equal(err.kind, "failed");
  assert.match(err.message, /Unknown ollama-cloud model "not-listed-yet"/);
  // The list grows upstream; the next call picks the model up without recreating the port.
  transport.setTags([MODEL, "new-arrival"]);
  const result = await port.streamTurn(
    turnRequest({ modelId: "new-arrival", onTextDelta: () => undefined }),
  );
  assert.equal(result.requestedModelId, "new-arrival");
  // Every resolution consulted the live list (initial fetch + one refresh per unknown model),
  // never a hard-coded one.
  assert.ok(
    transport.requests.filter((r) => r.url.endsWith("/api/tags")).length >= 2,
    "the catalog is refreshed from /api/tags",
  );
});

test("A3 port: 429 and 502 on the chat call become the recorded quota-or-unreachable signal", async () => {
  for (const status of [429, 502]) {
    const { port } = portWith({
      reply: { type: "status", status, body: JSON.stringify({ error: { message: "synthetic" } }) },
    });
    const err = await port.streamTurn(turnRequest()).then(
      () => assert.fail("expected failure"),
      (e: unknown) => e,
    );
    assert.ok(err instanceof ProviderCallError, String(status));
    assert.equal(err.kind, "failed", String(status));
    assert.equal(err.status, status, String(status));
    assert.equal(err.reason, "quota-or-unreachable", String(status));
    assert.equal(err.message, `ollama-cloud request failed (HTTP ${status})`);
    assert.ok(!err.message.includes("synthetic"));
  }
});

test("A3 port: an ordinary failure (401) carries no quota reason and no upstream text", async () => {
  const { port } = portWith({
    reply: { type: "status", status: 401, body: JSON.stringify({ error: { message: KEY } }) },
  });
  const err = await port.streamTurn(turnRequest()).then(
    () => assert.fail("expected failure"),
    (e: unknown) => e,
  );
  assert.ok(err instanceof ProviderCallError);
  assert.equal(err.status, 401);
  assert.equal(err.reason, undefined);
  assert.equal(err.message, "ollama-cloud request failed (HTTP 401)");
  assert.ok(!JSON.stringify({ ...err, message: err.message }).includes(KEY));
});

test("A3 port honesty: the key travels only in the Bearer header; the ambient env key is never used", async () => {
  const previous = process.env[OLLAMA_API_KEY_ENV];
  process.env[OLLAMA_API_KEY_ENV] = "ambient-ollama-sentinel-should-not-be-used";
  try {
    const { transport, port } = portWith({});
    await port.streamTurn(turnRequest());
    for (const request of transport.requests) {
      assert.equal(request.headers.authorization, `Bearer ${KEY}`);
      const elsewhere = JSON.stringify({
        ...request,
        headers: { ...request.headers, authorization: "" },
      });
      assert.ok(!elsewhere.includes(KEY), "key leaked outside the Authorization header");
      assert.ok(!JSON.stringify(request).includes("ambient-ollama-sentinel"), "ambient key used");
    }
  } finally {
    if (previous === undefined) delete process.env[OLLAMA_API_KEY_ENV];
    else process.env[OLLAMA_API_KEY_ENV] = previous;
  }
});

test("A3 port: abort mid-stream ends the call as aborted", async () => {
  const { port } = portWith({ reply: { type: "hang", model: MODEL } });
  const controller = new AbortController();
  const deltas: string[] = [];
  const pending = port.streamTurn(
    turnRequest({
      signal: controller.signal,
      onTextDelta: (d) => {
        deltas.push(d);
        controller.abort();
      },
    }),
  );
  const err = await pending.then(
    () => assert.fail("expected abort"),
    (e: unknown) => e,
  );
  assert.ok(err instanceof ProviderCallError);
  assert.equal(err.kind, "aborted");
  assert.deepEqual(deltas, ["partial"]);
});

// ------------------------------------------------------------------------ pinnedModel shape

test("A3 resolveOllamaPinnedModel: shape-only — membership belongs to the live list", () => {
  assert.deepEqual(resolveOllamaPinnedModel(`${OLLAMA_PI_PROVIDER}/${MODEL}`), {
    ok: true,
    modelId: MODEL,
  });
  assert.equal(resolveOllamaPinnedModel(MODEL).ok, false, "a bare id is refused");
  assert.equal(resolveOllamaPinnedModel("kimi-coding/kimi-for-coding").ok, false);
  assert.equal(resolveOllamaPinnedModel(`${OLLAMA_PI_PROVIDER}/`).ok, false);
  assert.equal(OLLAMA_CLOUD_PROVIDER_ID, "ollama-cloud");
});
