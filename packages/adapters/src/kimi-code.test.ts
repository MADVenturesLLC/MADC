/**
 * Kimi Code adapter tests. Network-free: every request goes to the in-process fake transport and a
 * `.invalid` base URL; keys are dummy sentinels.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  createKimiCodePort,
  honestUserAgent,
  KIMI_API_KEY_ENV,
  KIMI_DEFAULT_PINNED_MODEL,
  kimiCatalogModelIds,
  PI_AI_VERSION,
  ProviderCallError,
  type ProviderTurnRequest,
  readKimiCredential,
  resolveKimiPinnedModel,
} from "./index.ts";
import { createFakeKimiTransport, type FakeKimiReply } from "./testing/index.ts";

const KEY = "test-sentinel-key-9f3c";
const BASE_URL = "https://kimi-fake.invalid/coding";

function turnRequest(overrides: Partial<ProviderTurnRequest> = {}): ProviderTurnRequest {
  return {
    modelId: "kimi-for-coding",
    systemPrompt: "system prompt",
    messages: [{ role: "user", text: "hello" }],
    signal: new AbortController().signal,
    onTextDelta: () => undefined,
    ...overrides,
  };
}

function portWith(reply?: FakeKimiReply) {
  const transport = createFakeKimiTransport(reply);
  const port = createKimiCodePort({
    apiKey: KEY,
    userAgent: honestUserAgent("0.0.0"),
    baseUrl: BASE_URL,
    fetch: transport.fetch,
  });
  return { transport, port };
}

test("pi-ai is pinned exactly at PI_AI_VERSION (plan §6)", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    dependencies: Record<string, string>;
  };
  assert.equal(pkg.dependencies["@earendil-works/pi-ai"], PI_AI_VERSION);
  assert.equal(PI_AI_VERSION, "0.87.1");
  const installed = JSON.parse(
    readFileSync(
      new URL("../../../node_modules/@earendil-works/pi-ai/package.json", import.meta.url),
      "utf8",
    ),
  ) as { version: string };
  assert.equal(installed.version, PI_AI_VERSION);
});

test("madc-default pinnedModel is locked against the pinned pi-ai catalog (seat pin §3)", () => {
  assert.equal(KIMI_DEFAULT_PINNED_MODEL, "kimi-coding/kimi-for-coding");
  assert.deepEqual(resolveKimiPinnedModel(KIMI_DEFAULT_PINNED_MODEL), {
    ok: true,
    modelId: "kimi-for-coding",
  });
  assert.ok(kimiCatalogModelIds().includes("kimi-for-coding"));
});

test("honesty: pinnedModel mismatch is refused, never remapped", () => {
  for (const bad of [
    "anthropic/claude-sonnet-4-5",
    "kimi-code/kimi-for-coding",
    "kimi-coding/not-a-model",
    "kimi-for-coding",
    "kimi-coding/",
    "/kimi-for-coding",
  ]) {
    const result = resolveKimiPinnedModel(bad);
    assert.equal(result.ok, false, bad);
  }
});

test("credentials: missing / blank / Claude OAuth token shapes are refused", () => {
  assert.deepEqual(readKimiCredential({}), { ok: false, reason: "missing" });
  assert.deepEqual(readKimiCredential({ [KIMI_API_KEY_ENV]: "   " }), {
    ok: false,
    reason: "missing",
  });
  assert.deepEqual(readKimiCredential({ [KIMI_API_KEY_ENV]: "sk-ant-oat01-abc" }), {
    ok: false,
    reason: "oauth-token-refused",
  });
  assert.deepEqual(readKimiCredential({ [KIMI_API_KEY_ENV]: ` ${KEY} ` }), {
    ok: true,
    apiKey: KEY,
  });
});

test("honesty: the port refuses OAuth-shaped keys and non-madc User-Agents", () => {
  assert.throws(
    () => createKimiCodePort({ apiKey: "sk-ant-oat01-x", userAgent: honestUserAgent("0.0.0") }),
    ProviderCallError,
  );
  assert.throws(
    () => createKimiCodePort({ apiKey: KEY, userAgent: "claude-cli/2.0.0 (external, cli)" }),
    ProviderCallError,
  );
});

test("streams text deltas and reports the served model (responseModel)", async () => {
  const { transport, port } = portWith({
    type: "stream",
    chunks: ["Hel", "lo", " world"],
    model: "kimi-for-coding-2026-09",
  });
  const deltas: string[] = [];
  const result = await port.streamTurn(turnRequest({ onTextDelta: (d) => deltas.push(d) }));
  assert.deepEqual(deltas, ["Hel", "lo", " world"]);
  assert.deepEqual(result, {
    text: "Hello world",
    requestedModelId: "kimi-for-coding",
    servedModel: "kimi-for-coding-2026-09",
  });
  assert.equal(transport.requests.length, 1);
  const body = JSON.parse(transport.requests[0]?.body ?? "{}") as { model: string };
  assert.equal(body.model, "kimi-for-coding");
});

test("served model falls back to the requested model id when upstream reports the same id", async () => {
  const { port } = portWith({ type: "stream", chunks: ["ok"], model: "kimi-for-coding" });
  const result = await port.streamTurn(turnRequest());
  assert.equal(result.servedModel, "kimi-for-coding");
});

test("honesty: request carries an honest madc User-Agent and no vendor-CLI identity", async () => {
  const { transport, port } = portWith();
  await port.streamTurn(turnRequest());
  const request = transport.requests[0];
  assert.ok(request !== undefined);
  assert.ok(request.url.startsWith(`${BASE_URL}/`), request.url);
  const ua = request.headers["user-agent"] ?? "";
  assert.match(ua, /^madc\/0\.0\.0 \(pi-ai\/0\.87\.1; /);
  assert.doesNotMatch(ua, /claude|anthropic|kimi-cli|pi \(/i);
  assert.equal(request.headers["x-app"], undefined);
  assert.equal(request.headers.authorization, undefined);
  assert.doesNotMatch(request.headers["anthropic-beta"] ?? "", /claude-code|oauth/);
});

test("honesty: key travels only in x-api-key, and the ambient env key is never used", async () => {
  const previous = process.env[KIMI_API_KEY_ENV];
  process.env[KIMI_API_KEY_ENV] = "ambient-sentinel-should-not-be-used";
  try {
    const { transport, port } = portWith();
    await port.streamTurn(turnRequest());
    const request = transport.requests[0];
    assert.ok(request !== undefined);
    assert.equal(request.headers["x-api-key"], KEY);
    const elsewhere = JSON.stringify({
      ...request,
      headers: { ...request.headers, "x-api-key": "" },
    });
    assert.ok(!elsewhere.includes(KEY), "key leaked outside x-api-key");
    assert.ok(!JSON.stringify(request).includes("ambient-sentinel"), "ambient key was used");
  } finally {
    if (previous === undefined) delete process.env[KIMI_API_KEY_ENV];
    else process.env[KIMI_API_KEY_ENV] = previous;
  }
});

test("honesty: upstream error bodies (even echoing the key) never reach the error message", async () => {
  const { port } = portWith({
    type: "status",
    status: 401,
    body: JSON.stringify({ type: "error", error: { type: "authentication_error", message: KEY } }),
  });
  const err = await port.streamTurn(turnRequest()).then(
    () => assert.fail("expected failure"),
    (e: unknown) => e,
  );
  assert.ok(err instanceof ProviderCallError);
  assert.equal(err.kind, "failed");
  assert.equal(err.status, 401);
  assert.equal(err.message, "kimi-code request failed (HTTP 401)");
  assert.ok(!JSON.stringify({ ...err, message: err.message }).includes(KEY));
});

test("abort mid-stream ends the call as aborted", async () => {
  const { port } = portWith({ type: "hang", model: "kimi-for-coding" });
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
