/**
 * M1-A5 lane modules — MiniMax Token Plan and the Alibaba Cloud Coding Plan — at the port level:
 * the pinned endpoint and auth each lane puts on the wire, the served-model receipt, the quota
 * signal, `pinnedModel` resolution, and the credential-class rule (Founder ruling 12: plan keys and
 * pay-as-you-go keys are never mixed). Network-free: every port talks to an in-process fake (the
 * fake intercepts `fetch`, so even the pinned production host is never contacted), and every key is
 * a synthetic sentinel. Policy (the presence check, the MiniMax repo gate) is the engine's and is
 * covered in `packages/engine/src/presence.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ALIBABA_CODING_PLAN_BASE_URL,
  ALIBABA_CODING_PLAN_PROVIDER_ID,
  ALIBABA_PAYG_PROVIDER_ID,
  alibabaEndpointClass,
  alibabaKeyClass,
  checkAlibabaCredential,
  checkMinimaxCredential,
  createAlibabaCodingPlanPort,
  createMinimaxTokenPlanPort,
  MINIMAX_BASE_URL,
  MINIMAX_PAYG_PROVIDER_ID,
  MINIMAX_TOKEN_PLAN_PROVIDER_ID,
  minimaxCatalogModelIds,
  resolveAlibabaCodingPlanPinnedModel,
  resolveMinimaxPinnedModel,
} from "../index.ts";
import { ProviderCallError, type ProviderPort, type ProviderTurnResult } from "../provider-port.ts";
import { createFakeDeepSeekTransport, createFakeKimiTransport } from "../testing/index.ts";

const MINIMAX_KEY = "sk-cp-synthetic-token-plan-key-a5-adapters";
const ALIBABA_KEY = "sk-sp-synthetic-coding-plan-key-a5-adapters";

async function stream(
  port: ProviderPort,
  modelId: string,
  systemPrompt?: string,
): Promise<{ result: ProviderTurnResult; deltas: string[] }> {
  const deltas: string[] = [];
  const result = await port.streamTurn({
    modelId,
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
    messages: [{ role: "user", text: "ping from the a5 test" }],
    signal: new AbortController().signal,
    onTextDelta: (delta) => deltas.push(delta),
  });
  return { result, deltas };
}

async function refusal(fn: () => unknown): Promise<ProviderCallError> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof ProviderCallError) return err;
    throw err;
  }
  throw new Error("expected a ProviderCallError");
}

// ============================================================================ MiniMax

test("A5 MiniMax: pinnedModel is minimax/<id> from the pinned pi-ai catalog, never remapped", () => {
  const ids = minimaxCatalogModelIds();
  assert.ok(ids.includes("MiniMax-M3"), `pinned catalog: ${ids.join(", ")}`);
  assert.deepEqual(resolveMinimaxPinnedModel("minimax/MiniMax-M3"), {
    ok: true,
    modelId: "MiniMax-M3",
  });
  for (const bad of [
    "MiniMax-M3",
    "minimax/",
    "/MiniMax-M3",
    "minimax/not-a-model",
    "kimi-coding/MiniMax-M3",
  ]) {
    assert.equal(resolveMinimaxPinnedModel(bad).ok, false, bad);
  }
});

test("A5 MiniMax: the Token Plan port streams on the pinned anthropic-messages endpoint with the plan key", async () => {
  const fake = createFakeKimiTransport({
    type: "stream",
    chunks: ["plan", " ok"],
    model: "MiniMax-M3-0601",
  });
  // No baseUrl override: the request is addressed to the PINNED host (the fake answers it).
  const port = createMinimaxTokenPlanPort({ apiKey: MINIMAX_KEY, fetch: fake.fetch });
  assert.equal(port.providerId, MINIMAX_TOKEN_PLAN_PROVIDER_ID);
  const { result, deltas } = await stream(port, "MiniMax-M3");
  assert.equal(result.text, "plan ok");
  assert.deepEqual(deltas, ["plan", " ok"]);
  assert.equal(result.requestedModelId, "MiniMax-M3");
  assert.equal(
    result.servedModel,
    "MiniMax-M3-0601",
    "the vendor-reported identity is the receipt",
  );
  const request = fake.requests[0];
  assert.equal(fake.requests.length, 1);
  const url = new URL(request?.url ?? "about:blank");
  assert.equal(`${url.origin}${url.pathname}`, `${MINIMAX_BASE_URL}/v1/messages`);
  assert.equal(request?.headers["x-api-key"], MINIMAX_KEY);
  // No vendor client is impersonated: a plain API key never takes pi-ai's Claude OAuth path.
  assert.ok(!(request?.headers["user-agent"] ?? "").startsWith("claude-cli"));
  assert.equal(request?.headers["x-app"], undefined);
});

test("A5 MiniMax: HTTP 429 and 502 are the recorded quota-or-unreachable signal", async () => {
  for (const status of [429, 502]) {
    const fake = createFakeKimiTransport({ type: "status", status, body: '{"type":"error"}' });
    const port = createMinimaxTokenPlanPort({ apiKey: MINIMAX_KEY, fetch: fake.fetch });
    const err = await refusal(() => stream(port, "MiniMax-M3"));
    assert.equal(err.reason, "quota-or-unreachable", String(status));
    assert.equal(err.status, status);
    assert.ok(!err.message.includes(MINIMAX_KEY));
  }
});

test("A5 MiniMax credential class: plan keys only on the plan id, never on the PAYG id; no Claude OAuth shape", () => {
  assert.deepEqual(checkMinimaxCredential(MINIMAX_TOKEN_PLAN_PROVIDER_ID, MINIMAX_KEY), {
    ok: true,
  });
  assert.deepEqual(
    checkMinimaxCredential(MINIMAX_PAYG_PROVIDER_ID, "eyJwYXlnLWtleS1zeW50aGV0aWM"),
    {
      ok: true,
    },
  );
  const refused: Array<[string, string]> = [
    [MINIMAX_TOKEN_PLAN_PROVIDER_ID, "eyJwYXlnLWtleS1zeW50aGV0aWM"], // PAYG-class key on the plan id
    [MINIMAX_PAYG_PROVIDER_ID, MINIMAX_KEY], // plan key on the PAYG id
    [MINIMAX_TOKEN_PLAN_PROVIDER_ID, "sk-cp-sk-ant-oat01-synthetic"], // pi-ai would impersonate Claude
    [MINIMAX_PAYG_PROVIDER_ID, "sk-ant-oat01-synthetic"],
    ["kimi-code", MINIMAX_KEY], // not a MiniMax id at all
  ];
  for (const [providerId, key] of refused) {
    const verdict = checkMinimaxCredential(providerId, key);
    assert.equal(verdict.ok, false, `${providerId} ${key}`);
    if (!verdict.ok) {
      assert.ok(verdict.issue.startsWith(`${providerId}:`), verdict.issue);
      assert.ok(!verdict.issue.includes(key), "the issue never carries the value");
    }
  }
});

test("A5 MiniMax: the Token Plan port refuses a wrong-class key before any request", async () => {
  const fake = createFakeKimiTransport();
  for (const key of ["eyJwYXlnLWtleS1zeW50aGV0aWM", "sk-cp-sk-ant-oat01-synthetic"]) {
    const err = await refusal(() => createMinimaxTokenPlanPort({ apiKey: key, fetch: fake.fetch }));
    assert.ok(!err.message.includes(key));
  }
  assert.equal(fake.requests.length, 0);
});

// ============================================================================ Alibaba

test("A5 Alibaba: key and endpoint classes (sk-sp- / plan hosts vs sk- / pay-as-you-go hosts)", () => {
  assert.equal(alibabaKeyClass("sk-sp-abc"), "plan");
  assert.equal(alibabaKeyClass("sk-abc"), "payg");
  assert.equal(alibabaKeyClass("sk-ws-abc"), "payg");
  assert.equal(alibabaKeyClass("AIzaSomething"), null);
  const endpoints: Array<[string, "plan" | "payg" | null]> = [
    [ALIBABA_CODING_PLAN_BASE_URL, "plan"],
    ["https://coding.dashscope.aliyuncs.com/v1", "plan"],
    ["https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1", "plan"],
    ["https://dashscope-intl.aliyuncs.com/compatible-mode/v1", "payg"],
    ["https://dashscope.aliyuncs.com/compatible-mode/v1", "payg"],
    ["https://dashscope-us.aliyuncs.com/compatible-mode/v1", "payg"],
    ["https://ws123.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1", "payg"],
    ["https://alibaba-fake.invalid/v1", null],
    ["not a url", null],
  ];
  for (const [url, expected] of endpoints) assert.equal(alibabaEndpointClass(url), expected, url);
});

test("A5 Alibaba: base URL / key-class mismatch refused (sk- on the plan endpoint, sk-sp- on PAYG)", () => {
  const plan = ALIBABA_CODING_PLAN_BASE_URL;
  const payg = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
  const paygKey = "sk-synthetic-model-studio-payg-key";
  assert.deepEqual(checkAlibabaCredential(ALIBABA_CODING_PLAN_PROVIDER_ID, ALIBABA_KEY, plan), {
    ok: true,
  });
  assert.deepEqual(checkAlibabaCredential(ALIBABA_PAYG_PROVIDER_ID, paygKey, payg), { ok: true });
  const refused: Array<[string, string, string, RegExp]> = [
    [ALIBABA_CODING_PLAN_PROVIDER_ID, paygKey, plan, /a pay-as-you-go key/], // sk- on plan endpoint
    [ALIBABA_PAYG_PROVIDER_ID, ALIBABA_KEY, payg, /a plan key/], // sk-sp- on PAYG
    [ALIBABA_CODING_PLAN_PROVIDER_ID, ALIBABA_KEY, payg, /endpoint is a pay-as-you-go host/],
    [ALIBABA_PAYG_PROVIDER_ID, paygKey, plan, /endpoint is a plan host/],
    [ALIBABA_CODING_PLAN_PROVIDER_ID, "no-prefix-key", plan, /unrecognized key shape/],
    ["kimi-code", ALIBABA_KEY, plan, /not an Alibaba registry id/],
  ];
  for (const [providerId, key, url, why] of refused) {
    const verdict = checkAlibabaCredential(providerId, key, url);
    assert.equal(verdict.ok, false, `${providerId} ${key} ${url}`);
    if (!verdict.ok) {
      assert.match(verdict.issue, why);
      assert.ok(!verdict.issue.includes(key), "the issue never carries the value");
    }
  }
});

test("A5 Alibaba: pinnedModel is alibaba-coding-plan/<id>, passed through (no pinned catalog for this endpoint)", () => {
  assert.deepEqual(resolveAlibabaCodingPlanPinnedModel("alibaba-coding-plan/qwen3-coder-plus"), {
    ok: true,
    modelId: "qwen3-coder-plus",
  });
  for (const bad of ["qwen3-coder-plus", "alibaba-coding-plan/", "qwen-token-plan/qwen3.8-max"]) {
    assert.equal(resolveAlibabaCodingPlanPinnedModel(bad).ok, false, bad);
  }
});

test("A5 Alibaba: the Coding Plan port streams to the pinned Coding Plan endpoint with the plan key as Bearer", async () => {
  const fake = createFakeDeepSeekTransport({
    reply: { type: "stream", chunks: ["coding", " plan"], model: "qwen3-coder-plus-0928" },
  });
  // No baseUrl override: addressed to the PINNED Coding Plan host (the fake answers it).
  const port = createAlibabaCodingPlanPort({ apiKey: ALIBABA_KEY, fetch: fake.fetch });
  assert.equal(port.providerId, ALIBABA_CODING_PLAN_PROVIDER_ID);
  const { result, deltas } = await stream(port, "qwen3-coder-plus", "standing instructions");
  assert.equal(result.text, "coding plan");
  assert.deepEqual(deltas, ["coding", " plan"]);
  assert.equal(result.requestedModelId, "qwen3-coder-plus");
  assert.equal(result.servedModel, "qwen3-coder-plus-0928");
  assert.equal(result.vendorReported, true);
  const request = fake.requests[0];
  assert.equal(request?.url, `${ALIBABA_CODING_PLAN_BASE_URL}/chat/completions`);
  assert.equal(request?.headers.authorization, `Bearer ${ALIBABA_KEY}`);
  const body = JSON.parse(request?.body ?? "{}") as {
    model?: string;
    store?: unknown;
    messages?: Array<{ role: string }>;
  };
  assert.equal(body.model, "qwen3-coder-plus", "the seat's model id is sent as-is");
  assert.equal("store" in body, false, "pinned compat: no store field to DashScope");
  assert.equal(body.messages?.[0]?.role, "system", "pinned compat: no developer role");
});

test("A5 Alibaba: HTTP 429 is the recorded quota-or-unreachable signal", async () => {
  const fake = createFakeDeepSeekTransport({ reply: { type: "status", status: 429, body: "{}" } });
  const port = createAlibabaCodingPlanPort({ apiKey: ALIBABA_KEY, fetch: fake.fetch });
  const err = await refusal(() => stream(port, "qwen3-coder-plus"));
  assert.equal(err.reason, "quota-or-unreachable");
  assert.ok(!err.message.includes(ALIBABA_KEY));
});

test("A5 Alibaba: the Coding Plan port refuses an sk- key and a pay-as-you-go host before any request", async () => {
  const fake = createFakeDeepSeekTransport();
  const cases: Array<{ apiKey: string; baseUrl?: string }> = [
    { apiKey: "sk-synthetic-model-studio-payg-key" },
    { apiKey: ALIBABA_KEY, baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1" },
  ];
  for (const options of cases) {
    const err = await refusal(() => createAlibabaCodingPlanPort({ ...options, fetch: fake.fetch }));
    assert.ok(!err.message.includes(options.apiKey));
  }
  assert.equal(fake.requests.length, 0);
});
