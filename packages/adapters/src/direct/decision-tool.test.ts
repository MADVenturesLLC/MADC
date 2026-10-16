/**
 * PR #63 round-5 review (Argus pr63-review-048c5f1.md) N2-L / N2-M (part) / N4-L: the direct-lane
 * `founder_decision_raise` round trip, driven through the real port code and fake transports.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createKimiCodePort, honestUserAgent } from "../index.ts";
import type {
  ProviderDecisionRaiseInput,
  ProviderDecisionRaiseOutcome,
  ProviderTurnRequest,
} from "../provider-port.ts";
import { createOllamaCloudPort } from "../providers/ollama-cloud.ts";
import { createFakeKimiTransport, createFakeOllamaTransport } from "../testing/index.ts";
import { FOUNDER_DECISION_RAISE_TOOL_NAME, MAX_DECISION_TOOL_ROUNDS } from "./generic.ts";

const KEY = "test-sentinel-key-dt01";
const MODEL = "kimi-for-coding";

function turnRequest(overrides: Partial<ProviderTurnRequest> = {}): ProviderTurnRequest {
  return {
    modelId: MODEL,
    messages: [{ role: "user", text: "hello" }],
    signal: new AbortController().signal,
    onTextDelta: () => undefined,
    ...overrides,
  };
}

function kimi() {
  const transport = createFakeKimiTransport();
  const port = createKimiCodePort({
    apiKey: KEY,
    userAgent: honestUserAgent("0.0.0"),
    baseUrl: "https://kimi-fake.invalid/coding",
    fetch: transport.fetch,
  });
  return { transport, port };
}

const ok: ProviderDecisionRaiseOutcome = {
  ok: true,
  decision: {
    threadId: "thr_a",
    turnId: "turn_a",
    decisionId: "dec_a",
    seq: 3,
    hash: "a".repeat(64),
  },
};

/** The tool results the port sent back, read from the follow-up request bodies. */
function toolResults(bodies: readonly string[]) {
  const out: Array<{ is_error: boolean | undefined; text: string }> = [];
  for (const b of bodies) {
    const msgs = (JSON.parse(b) as { messages: Array<{ role: string; content: unknown }> })
      .messages;
    const last = msgs[msgs.length - 1];
    if (last?.role !== "user" || !Array.isArray(last.content)) continue;
    for (const part of last.content as Array<Record<string, unknown>>) {
      if (part.type !== "tool_result") continue;
      const c = part.content;
      const text = Array.isArray(c)
        ? (c as Array<{ text?: string }>).map((x) => x.text ?? "").join("")
        : String(c);
      out.push({ is_error: part.is_error as boolean | undefined, text });
    }
  }
  return out;
}

test("N2-M (part): no raise capability → the request advertises no tools (M1 body shape); with it → exactly founder_decision_raise", async () => {
  const a = kimi();
  await a.port.streamTurn(turnRequest());
  const bodyA = JSON.parse(a.transport.requests[0]?.body ?? "{}") as { tools?: unknown };
  assert.equal(Object.hasOwn(bodyA, "tools"), false);

  const b = kimi();
  await b.port.streamTurn(turnRequest({ raiseDecision: () => ok }));
  const bodyB = JSON.parse(b.transport.requests[0]?.body ?? "{}") as {
    tools?: Array<{ name: string }>;
  };
  assert.deepEqual(
    bodyB.tools?.map((t) => t.name),
    [FOUNDER_DECISION_RAISE_TOOL_NAME],
  );
});

test("N2-M (part): openai-completions lane (ollama-cloud) sends the tool as a function only when a raise capability exists", async () => {
  const mk = () => {
    const transport = createFakeOllamaTransport({ tags: ["gpt-oss:120b"] });
    const port = createOllamaCloudPort({
      apiKey: KEY,
      baseUrl: "https://ollama-fake.invalid/v1",
      tagsUrl: "https://ollama-fake.invalid/api/tags",
      fetch: transport.fetch,
    });
    return { transport, port };
  };
  const chatBody = (reqs: ReadonlyArray<{ url: string; body: string }>) =>
    JSON.parse(reqs.find((r) => r.url.includes("chat"))?.body ?? "{}") as {
      tools?: Array<{ type: string; function: { name: string } }>;
    };
  const a = mk();
  await a.port.streamTurn(turnRequest({ modelId: "gpt-oss:120b" }));
  assert.equal(Object.hasOwn(chatBody(a.transport.requests), "tools"), false);
  const b = mk();
  await b.port.streamTurn(turnRequest({ modelId: "gpt-oss:120b", raiseDecision: () => ok }));
  const tools = chatBody(b.transport.requests).tools;
  assert.deepEqual(
    tools?.map((t) => [t.type, t.function.name]),
    [["function", FOUNDER_DECISION_RAISE_TOOL_NAME]],
  );
});

test("N2-L G1/G6/G3/G7: unknown tool → -32601 isError; non-object args reach raiseDecision unchanged and a refusal is isError; the assistant toolCall precedes its tool_result", async () => {
  const { transport, port } = kimi();
  transport.queueReply({
    type: "tool-call",
    id: "call_unknown",
    name: "decision/resolve",
    args: {},
    model: MODEL,
  });
  transport.queueReply({
    type: "tool-call",
    id: "call_refused",
    name: FOUNDER_DECISION_RAISE_TOOL_NAME,
    args: { question: "" },
    model: MODEL,
  });
  const seen: unknown[] = [];
  const result = await port.streamTurn(
    turnRequest({
      raiseDecision: (input: ProviderDecisionRaiseInput) => {
        seen.push(input);
        return { ok: false, error: { code: -32010, message: "Evidence invalid" } };
      },
    }),
  );
  assert.equal(typeof result.text, "string");
  const bodies = transport.requests.map((r) => r.body);
  assert.equal(bodies.length, 3);
  const results = toolResults(bodies);
  assert.equal(results.length, 2);
  assert.equal(results[0]?.is_error, true, "G1 unknown tool is an error result");
  assert.equal(
    (JSON.parse(results[0]?.text ?? "{}") as { error: { code: number } }).error.code,
    -32601,
  );
  assert.equal(results[1]?.is_error, true, "G3 refused raise is an error result");
  assert.equal(seen.length, 1, "only the founder_decision_raise call reached the engine");
  assert.deepEqual(seen[0], { question: "" });
  assert.equal(
    Object.getPrototypeOf(seen[0]),
    Object.prototype,
    "G6 args arrive as a plain object",
  );

  // G7: in the second request the assistant tool_use sits right before the user tool_result.
  const msgs = (
    JSON.parse(bodies[1] ?? "{}") as { messages: Array<{ role: string; content: unknown }> }
  ).messages;
  const n = msgs.length;
  assert.equal(msgs[n - 2]?.role, "assistant");
  assert.ok(
    ((msgs[n - 2]?.content ?? []) as Array<{ type: string; id?: string }>).some(
      (p) => p.type === "tool_use" && p.id === "call_unknown",
    ),
  );
  assert.equal(msgs[n - 1]?.role, "user");
});

test("N2-L G2: a tool call on a turn with no raise capability gets a -32010 isError result, and nothing is raised", async () => {
  const { transport, port } = kimi();
  transport.queueReply({
    type: "tool-call",
    id: "call_x",
    name: FOUNDER_DECISION_RAISE_TOOL_NAME,
    args: { question: "q" },
    model: MODEL,
  });
  await port.streamTurn(turnRequest());
  const results = toolResults(transport.requests.map((r) => r.body));
  assert.equal(results.length, 1);
  assert.equal(results[0]?.is_error, true);
  assert.equal(
    (JSON.parse(results[0]?.text ?? "{}") as { error: { code: number } }).error.code,
    -32010,
  );
});

test("N4-L: tool-round exhaustion fails with its own fixed message, not the network-failure text", async () => {
  const { transport, port } = kimi();
  for (let i = 0; i <= MAX_DECISION_TOOL_ROUNDS; i++) {
    transport.queueReply({
      type: "tool-call",
      id: `call_${i}`,
      name: FOUNDER_DECISION_RAISE_TOOL_NAME,
      args: { question: `SECRET_Q_${i}` },
      model: MODEL,
    });
  }
  await assert.rejects(
    port.streamTurn(turnRequest({ raiseDecision: () => ok })),
    (err: Error & { kind?: string; status?: unknown; reason?: unknown }) => {
      assert.equal(err.message, "kimi-code decision tool limit reached");
      assert.equal(err.kind, "failed");
      assert.equal(err.status, null);
      assert.equal(err.reason, undefined);
      return true;
    },
  );
});

test("N4-L abort priority: a signal aborted while the over-limit response arrives fails as aborted, not as the tool limit", async () => {
  const transport = createFakeKimiTransport();
  const controller = new AbortController();
  let calls = 0;
  const fetchAbortingOnLast: typeof globalThis.fetch = async (input, init) => {
    calls += 1;
    const res = await transport.fetch(input, init);
    if (calls <= MAX_DECISION_TOOL_ROUNDS) return res;
    const bytes = await res.arrayBuffer();
    controller.abort();
    return new Response(bytes, { status: res.status, headers: res.headers });
  };
  const port = createKimiCodePort({
    apiKey: KEY,
    userAgent: honestUserAgent("0.0.0"),
    baseUrl: "https://kimi-fake.invalid/coding",
    fetch: fetchAbortingOnLast,
  });
  for (let i = 0; i <= MAX_DECISION_TOOL_ROUNDS; i++) {
    transport.queueReply({
      type: "tool-call",
      id: `call_${i}`,
      name: FOUNDER_DECISION_RAISE_TOOL_NAME,
      args: { question: `q${i}` },
      model: MODEL,
    });
  }
  await assert.rejects(
    port.streamTurn(turnRequest({ signal: controller.signal, raiseDecision: () => ok })),
    (err: Error & { kind?: string }) => {
      assert.equal(err.kind, "aborted");
      assert.equal(err.message, "kimi-code request aborted");
      return true;
    },
  );
  assert.equal(calls, MAX_DECISION_TOOL_ROUNDS + 1);
});
