/**
 * M1-A9 L1 conformance, engine side: ONE mock turn per wired lane through the production provider
 * agent (`createProviderAgent`, the same planner, fallback walk and receipt builder `main.ts`
 * wires), each lane on its REAL adapter over an in-process fake. It proves, per lane, the L1
 * elements the engine owns — the user's text reaches the lane (chat), the lane's deltas reach the
 * sink in order (stream), and the turn closes with one `agentMessage` and one honest `servedModel`
 * receipt naming the lane (plan §2 F; protocol pin §5 P2) — and, for the one vendor lane whose
 * adapter surfaces tool events, that they become `toolCall` / `toolResult` items.
 *
 * The receipt's durable half is lane-independent: the server writes every `servedModel` item as
 * both an `item` event and a `servedModel` event with the same fields (`server.ts`
 * `#persistItem`), which the session tests cover. The per-lane tool round-trips are adapter-level
 * (see `ADAPTER_L1` below), because no direct lane runs a MAD tool loop in M1.
 *
 * Gates are NOT bypassed to get here: each lane is asked in the mode it can serve — the
 * interactive-only plans and the headless-denied Ollama lane (D-M1-3) only on a turn that claims
 * `interactive` AND carries `presence: "verified"`, which in production only the engine's own
 * terminal check can set (M1-A5). The repo gate for `deepseek-payg` and `minimax-token-plan` runs
 * in the server's `turn/start`, before the agent (protocol pin §4.2), and is covered against a
 * test allowlist in `repo-gate.test.ts` and `presence.test.ts`; a clean install still denies every
 * repo there (D-M1-8, D-M1-9).
 *
 * Network-free: `.invalid` hosts, fake vendor children, synthetic keys only.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createAlibabaCodingPlanPort,
  createClaudeCodePort,
  createCodexCodePort,
  createDeepseekPort,
  createGeminiPort,
  createGrokBuildPort,
  createKimiCodePort,
  createMinimaxTokenPlanPort,
  createMistralPort,
  createOllamaCloudPort,
  createXaiPort,
  honestUserAgent,
  type PinnedModelResolution,
  type ProviderPort,
  resolveAlibabaCodingPlanPinnedModel,
  resolveDeepseekPinnedModel,
  resolveGeminiPinnedModel,
  resolveKimiPinnedModel,
  resolveMinimaxPinnedModel,
  resolveMistralPinnedModel,
  resolveOllamaPinnedModel,
  resolveXaiPinnedModel,
} from "@madc/adapters";
import {
  createFakeAcpSpawn,
  createFakeClaudeSpawn,
  createFakeCodexSpawn,
  createFakeDeepSeekTransport,
  createFakeGeminiTransport,
  createFakeKimiTransport,
  createFakeMistralTransport,
  createFakeOllamaTransport,
  createFakeXaiTransport,
  FAKE_CLAUDE_BINARY,
  FAKE_CODEX_BINARY,
  FAKE_GROK_BINARY,
} from "@madc/adapters/testing";
import { getById, listCatalog } from "@madc/registry";
import type { AgentTurnContext, TurnSink } from "./agent.ts";
import type { Presence } from "./presence/policy.ts";
import type { Item, ServedModelItem, TurnMode } from "./protocol/types.ts";
import { createProviderAgent, type ProviderAgentOptions } from "./provider-agent.ts";
import { type EngineSeat, MADC_DEFAULT_SEAT } from "./seat.ts";

const KEY = "test-sentinel-key-a9-engine-l1";
const PROMPT = "what does the README say?";

/** One wired lane's L1 case: how to wire it, how to ask it, and the receipt it must produce. */
type LaneCase = {
  readonly pinnedModel: string;
  /** The turn's claim and the engine's presence verdict (see module docs: gates hold). */
  readonly mode: TurnMode;
  readonly presence: Presence;
  readonly wire: () => { readonly options: ProviderAgentOptions; readonly cleanup?: () => void };
  readonly deltas: readonly string[];
  readonly servedModel: string;
  readonly vendorReported: boolean;
  /** Tool items the lane's adapter surfaces (grok-build only in M1). */
  readonly tools?: (items: readonly Item[]) => void;
};

function directLane(
  providerId: string,
  createPort: (apiKey: string) => ProviderPort,
  resolvePinnedModel: (pinnedModel: string) => PinnedModelResolution,
  apiKey = KEY,
): ProviderAgentOptions {
  return { directLanes: [{ providerId, credential: apiKey, createPort, resolvePinnedModel }] };
}

const HEADLESS = { mode: "headless", presence: "absent" } as const;
const PRESENT = { mode: "interactive", presence: "verified" } as const;

/**
 * Every wired lane in this build, keyed by registry id. The guard test below fails when the
 * registry wires a lane that has no case here, so a new lane cannot ship without engine-side L1.
 */
const LANES: Readonly<Record<string, LaneCase>> = {
  "kimi-code": {
    pinnedModel: "kimi-coding/kimi-for-coding",
    ...HEADLESS,
    wire: () => {
      const fake = createFakeKimiTransport({
        type: "stream",
        chunks: ["L1 ", "kimi"],
        model: "kimi-for-coding-0905",
      });
      return {
        options: directLane(
          "kimi-code",
          (apiKey) =>
            createKimiCodePort({
              apiKey,
              userAgent: honestUserAgent("0.0.0"),
              baseUrl: "https://kimi-fake.invalid/coding",
              fetch: fake.fetch,
            }),
          resolveKimiPinnedModel,
        ),
      };
    },
    deltas: ["L1 ", "kimi"],
    // anthropic-messages: pi-ai sets responseModel only when it differs, so a distinct id is the
    // vendor-reported case and the engine derives `true`.
    servedModel: "kimi-for-coding-0905",
    vendorReported: true,
  },
  "ollama-cloud": {
    pinnedModel: "ollama-cloud/gpt-oss-120b",
    // D-M1-3: headless is denied, so the lane serves only a presence-verified interactive turn.
    ...PRESENT,
    wire: () => {
      const fake = createFakeOllamaTransport({
        tags: ["gpt-oss-120b"],
        reply: { type: "stream", chunks: ["L1 ", "ollama"], model: "gpt-oss-120b-0910" },
      });
      return {
        options: directLane(
          "ollama-cloud",
          (apiKey) =>
            createOllamaCloudPort({
              apiKey,
              baseUrl: "https://ollama-fake.invalid/v1",
              tagsUrl: "https://ollama-fake.invalid/api/tags",
              fetch: fake.fetch,
            }),
          resolveOllamaPinnedModel,
        ),
      };
    },
    deltas: ["L1 ", "ollama"],
    servedModel: "gpt-oss-120b-0910",
    vendorReported: true,
  },
  "mistral-pro": {
    pinnedModel: "mistral/mistral-small-latest",
    ...HEADLESS,
    wire: () => {
      const fake = createFakeMistralTransport({
        reply: { type: "stream", chunks: ["L1 ", "mistral"], model: "mistral-small-2509" },
      });
      return {
        options: directLane(
          "mistral-pro",
          (apiKey) =>
            createMistralPort({
              apiKey,
              baseUrl: "https://mistral-fake.invalid",
              fetch: fake.fetch,
            }),
          resolveMistralPinnedModel,
        ),
      };
    },
    deltas: ["L1 ", "mistral"],
    // pi-ai 0.87.1's mistral-conversations wire never assigns responseModel: the frames' model is
    // invisible, so the receipt is the requested id and claims no vendor identity (A4 note).
    servedModel: "mistral-small-latest",
    vendorReported: false,
  },
  "deepseek-payg": {
    pinnedModel: "deepseek/deepseek-flash",
    ...HEADLESS,
    wire: () => {
      const fake = createFakeDeepSeekTransport({
        reply: { type: "stream", chunks: ["L1 ", "deepseek"], model: "deepseek-flash-0408" },
      });
      return {
        options: directLane(
          "deepseek-payg",
          (apiKey) =>
            createDeepseekPort({
              apiKey,
              baseUrl: "https://deepseek-fake.invalid",
              fetch: fake.fetch,
            }),
          resolveDeepseekPinnedModel,
        ),
      };
    },
    deltas: ["L1 ", "deepseek"],
    servedModel: "deepseek-flash-0408",
    vendorReported: true,
  },
  "gemini-api-key": {
    pinnedModel: "google/gemini-2.5-flash",
    ...HEADLESS,
    wire: () => {
      // pi-ai's google adapter refuses a custom fetch, so the fake patches globalThis.fetch for
      // the duration of this one case and restores the exact prior reference afterwards.
      const fake = createFakeGeminiTransport({
        reply: { type: "stream", chunks: ["L1 ", "gemini"], model: "gemini-2.5-flash-002" },
      });
      fake.install();
      return {
        options: directLane(
          "gemini-api-key",
          (apiKey) => createGeminiPort({ apiKey, baseUrl: "https://gemini-fake.invalid/v1beta" }),
          resolveGeminiPinnedModel,
        ),
        cleanup: () => fake.restore(),
      };
    },
    deltas: ["L1 ", "gemini"],
    // google-generative-ai never assigns responseModel in pi-ai 0.87.1 (A4 note).
    servedModel: "gemini-2.5-flash",
    vendorReported: false,
  },
  "xai-api": {
    pinnedModel: "xai/grok-4.7",
    ...HEADLESS,
    wire: () => {
      const fake = createFakeXaiTransport({
        reply: { type: "stream", chunks: ["L1 ", "xai"], model: "grok-4.7-0920" },
      });
      return {
        options: directLane(
          "xai-api",
          (apiKey) =>
            createXaiPort({ apiKey, baseUrl: "https://xai-fake.invalid/v1", fetch: fake.fetch }),
          resolveXaiPinnedModel,
        ),
      };
    },
    deltas: ["L1 ", "xai"],
    // openai-responses never assigns responseModel in pi-ai 0.87.1 (A4 note).
    servedModel: "grok-4.7",
    vendorReported: false,
  },
  "minimax-token-plan": {
    pinnedModel: "minimax/MiniMax-M3",
    // interactive-only: served only with the claim AND engine-verified presence (M1-A5).
    ...PRESENT,
    wire: () => {
      const fake = createFakeKimiTransport({
        type: "stream",
        chunks: ["L1 ", "minimax"],
        model: "MiniMax-M3-0601",
      });
      return {
        options: directLane(
          "minimax-token-plan",
          (apiKey) =>
            createMinimaxTokenPlanPort({
              apiKey,
              baseUrl: "https://minimax-fake.invalid/anthropic",
              fetch: fake.fetch,
            }),
          resolveMinimaxPinnedModel,
          "sk-cp-synthetic-token-plan-key-a9-engine",
        ),
      };
    },
    deltas: ["L1 ", "minimax"],
    servedModel: "MiniMax-M3-0601",
    vendorReported: true,
  },
  "alibaba-coding-plan": {
    pinnedModel: "alibaba-coding-plan/qwen3-coder-plus",
    ...PRESENT,
    wire: () => {
      const fake = createFakeDeepSeekTransport({
        reply: { type: "stream", chunks: ["L1 ", "alibaba"], model: "qwen3-coder-plus-0928" },
      });
      return {
        options: directLane(
          "alibaba-coding-plan",
          (apiKey) =>
            createAlibabaCodingPlanPort({
              apiKey,
              baseUrl: "https://alibaba-fake.invalid/v1",
              fetch: fake.fetch,
            }),
          resolveAlibabaCodingPlanPinnedModel,
          "sk-sp-synthetic-coding-plan-key-a9-engine",
        ),
      };
    },
    deltas: ["L1 ", "alibaba"],
    servedModel: "qwen3-coder-plus-0928",
    vendorReported: true,
  },
  "claude-code": {
    pinnedModel: "claude-sonnet-4-5",
    ...HEADLESS,
    wire: () => {
      const spawn = createFakeClaudeSpawn();
      return {
        options: {
          createClaudePort: (binaryPath) => createClaudeCodePort({ binaryPath, spawn }),
          detectClaudeBinary: () => FAKE_CLAUDE_BINARY,
        },
      };
    },
    // Capture-and-emit (M0-A5): one delta, the final text.
    deltas: [`fake claude answer to: ${PROMPT}`],
    // The fixture's `modelUsage` names the requested model. The adapter sets no vendorReported
    // flag, so the engine derives it from `servedModel !== requestedModelId` and an equal id reads
    // `false`: the rule can under-claim a vendor report, never over-claim one.
    servedModel: "claude-sonnet-4-5",
    vendorReported: false,
  },
  codex: {
    pinnedModel: "gpt-5.1-codex",
    ...HEADLESS,
    wire: () => {
      const spawn = createFakeCodexSpawn();
      return {
        options: {
          createCodexPort: (binaryPath) =>
            createCodexCodePort({ binaryPath, spawn, clientVersion: "0.0.0" }),
          detectCodexBinary: () => FAKE_CODEX_BINARY,
        },
      };
    },
    deltas: ["fake codex answer", ` to: ${PROMPT}`],
    // Same derived rule as claude-code: `thread/start` echoes the requested model.
    servedModel: "gpt-5.1-codex",
    vendorReported: false,
  },
  "grok-build": {
    pinnedModel: "grok-4.7",
    ...HEADLESS,
    wire: () => {
      const spawn = createFakeAcpSpawn({ MADC_TEST_ACP_MODE: "tools" });
      return {
        options: {
          createGrokPort: (binaryPath) =>
            createGrokBuildPort({
              binaryPath,
              spawn,
              clientVersion: "0.0.0",
              apiKeyPresent: () => false,
              trailingQuietMs: 20,
            }),
          detectGrokBinary: () => FAKE_GROK_BINARY,
        },
      };
    },
    deltas: ["Looking. ", "Done."],
    // The agent reported its model over ACP: the adapter states vendorReported itself.
    servedModel: "grok-4.7",
    vendorReported: true,
    tools: (items) => {
      // The vendor's read tool: one toolCall and its matching toolResult, ahead of the answer.
      const calls = items.filter((i) => i.kind === "toolCall") as Array<
        Item & { kind: "toolCall"; name: string; arguments: unknown }
      >;
      const results = items.filter((i) => i.kind === "toolResult") as Array<
        Item & { kind: "toolResult"; callId: string; output: string; isError: boolean }
      >;
      const read = calls.find((c) => JSON.stringify(c.arguments) === '{"path":"README.md"}');
      assert.ok(read, `a toolCall for the read tool, got ${JSON.stringify(calls)}`);
      const readResult = results.find((r) => r.callId === read.id);
      assert.ok(readResult, "its toolResult");
      assert.equal(readResult.output, "# MADC");
      assert.equal(readResult.isError, false);
      const answerAt = items.findIndex((i) => i.kind === "agentMessage");
      assert.ok(items.indexOf(readResult) < answerAt, "tool items close before the answer");
    },
  },
};

/**
 * Where each wired lane's ADAPTER-level L1 lives (chat, stream and the tool round-trip on the
 * lane's own configuration). Paths are relative to `packages/`.
 */
const ADAPTER_L1: Readonly<Record<string, readonly string[]>> = {
  "kimi-code": ["adapters/src/kimi-code.test.ts", "adapters/src/providers/direct-lane-l1.test.ts"],
  "ollama-cloud": [
    "adapters/src/providers/ollama-cloud.test.ts",
    "adapters/src/providers/direct-lane-l1.test.ts",
  ],
  "mistral-pro": ["adapters/src/providers/direct-key-conformance.test.ts"],
  "deepseek-payg": ["adapters/src/providers/direct-key-conformance.test.ts"],
  "gemini-api-key": ["adapters/src/providers/direct-key-conformance.test.ts"],
  "xai-api": ["adapters/src/providers/direct-key-conformance.test.ts"],
  "minimax-token-plan": [
    "adapters/src/providers/interactive-plans.test.ts",
    "adapters/src/providers/direct-lane-l1.test.ts",
  ],
  "alibaba-coding-plan": [
    "adapters/src/providers/interactive-plans.test.ts",
    "adapters/src/providers/direct-lane-l1.test.ts",
  ],
  "claude-code": ["adapters/src/vendor/vendor-lane-l1.test.ts"],
  codex: ["adapters/src/vendor/vendor-lane-l1.test.ts"],
  "grok-build": ["adapters/src/vendor/vendor-lane-l1.test.ts"],
};

type Captured = { items: Item[]; deltas: string[] };

function captureSink(): TurnSink & { captured: Captured } {
  const captured: Captured = { items: [], deltas: [] };
  let n = 0;
  return {
    captured,
    signal: new AbortController().signal,
    newItemId: () => {
      n += 1;
      return `item_${n}`;
    },
    startItem: () => undefined,
    delta: (_id, delta) => {
      captured.deltas.push(delta);
    },
    completeItem: (item) => {
      captured.items.push({ ...item, status: "completed" } as Item);
    },
    fallbackRejected: () => true,
    repoDecision: () => true,
  };
}

function ctxFor(providerId: string, lane: LaneCase): AgentTurnContext {
  const seat: EngineSeat = {
    ...MADC_DEFAULT_SEAT,
    id: "l1-seat",
    pinnedModel: lane.pinnedModel,
    preferredBacking: providerId,
  };
  return {
    threadId: "thr_l1",
    seatId: seat.id,
    seat,
    seatPath: join(tmpdir(), `${seat.id}.json`),
    input: [{ type: "text", text: PROMPT }],
    cwd: null,
    turnId: "turn_l1",
    mode: lane.mode,
    presence: lane.presence,
  };
}

const WIRED = listCatalog()
  .filter((entry) => entry.wired)
  .map((entry) => entry.id)
  .sort();

test("A9 L1 guard: every wired registry lane has an engine-side L1 case and adapter-level L1", () => {
  assert.deepEqual(Object.keys(LANES).sort(), WIRED, "LANES covers exactly the wired lanes");
  assert.deepEqual(Object.keys(ADAPTER_L1).sort(), WIRED, "ADAPTER_L1 covers exactly them too");
  const packages = new URL("../../", import.meta.url);
  for (const [lane, files] of Object.entries(ADAPTER_L1)) {
    for (const file of files) {
      assert.ok(existsSync(new URL(file, packages)), `${lane}: ${file} exists`);
    }
  }
  // The two PAYG ids stay unwired until a PAYG terms source is cited (M1-A1): no case, no L1.
  for (const id of ["minimax-payg", "alibaba-model-studio-payg"]) {
    assert.equal(getById(id)?.wired, false, `${id} is still unwired`);
  }
});

for (const providerId of WIRED) {
  test(`A9 L1 engine: ${providerId} — chat, stream and an honest servedModel receipt`, async () => {
    const lane = LANES[providerId];
    assert.ok(lane, `no L1 case for wired lane ${providerId}`);
    const entry = getById(providerId);
    assert.ok(entry);
    const { options, cleanup } = lane.wire();
    try {
      const agent = createProviderAgent(options);
      const sink = captureSink();
      await agent.run(ctxFor(providerId, lane), sink);
      const { items, deltas } = sink.captured;

      // stream: the lane's deltas, in order.
      assert.deepEqual(deltas, lane.deltas);
      // chat: one completed agentMessage carrying the lane's answer (the deltas' concatenation).
      const answers = items.filter((i) => i.kind === "agentMessage");
      assert.equal(answers.length, 1);
      assert.equal((answers[0] as { text: string }).text, lane.deltas.join(""));
      assert.equal(
        items.filter((i) => i.kind === "error").length,
        0,
        "no error item on a served turn",
      );
      lane.tools?.(items);
      if (lane.tools === undefined) {
        assert.equal(
          items.filter((i) => i.kind === "toolCall" || i.kind === "toolResult").length,
          0,
          "this lane's adapter surfaces no tool items in M1",
        );
      }

      // receipt: exactly one, last, naming the lane honestly (protocol pin §5 P2, plan §2 F).
      const receipts = items.filter((i) => i.kind === "servedModel") as ServedModelItem[];
      assert.equal(receipts.length, 1);
      assert.equal(items.at(-1)?.kind, "servedModel", "the receipt closes the turn");
      const receipt = receipts[0] as ServedModelItem;
      assert.deepEqual(
        { ...receipt, id: "" },
        {
          id: "",
          kind: "servedModel",
          status: "completed",
          requestedModel: lane.pinnedModel,
          servedModel: lane.servedModel,
          backing: providerId,
          providerId,
          lane: entry.status,
          mode: lane.mode,
          fallbackFrom: null,
          vendorReported: lane.vendorReported,
        },
      );
    } finally {
      cleanup?.();
    }
  });
}
