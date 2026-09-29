/**
 * M1-A3 acceptance (engine side) — the generic direct-key port wiring, the quota-or-unreachable
 * signal and the D-M1-7 same-lane fallback rule, plus the D-M1-3 headless denial end to end.
 * Mock transports and synthetic keys only; no live provider, no network, no real credential.
 *
 * Fallback mechanics are exercised at the agent level with code-built seats: v1 seat FILES cannot
 * carry `fallbacks` (the v2 file schema and the seeded roster are M1-A7), so a file-driven
 * fallback e2e is an A7 acceptance item by design.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ProviderCallError,
  type ProviderPort,
  type ProviderTurnResult,
  resolveKimiPinnedModel,
} from "@madc/adapters";
import type { AgentTurnContext, TurnSink } from "./agent.ts";
import { defaultAgentFactory } from "./main.ts";
import { ErrorCode, RpcError } from "./protocol/errors.ts";
import type { Item, ServedModelItem } from "./protocol/types.ts";
import { createProviderAgent, type DirectLane } from "./provider-agent.ts";
import { type EngineSeat, MADC_DEFAULT_SEAT } from "./seat.ts";
import {
  type FallbackRejectedPayload,
  rebuildSession,
  unguardedSessionWriterForTests,
  verifySessionFile,
  verifySessionText,
} from "./session-store.ts";
import {
  DIRECT_FAKE_ENGINE,
  expectRpcError,
  handshake,
  makeHome,
  startEngine,
  writeSeatFile,
} from "./testing/harness.ts";
import { keychainEnv, writeKeychainShims } from "./testing/keychain-shim.ts";

const KEY = "test-sentinel-key-a3fb";

// --------------------------------------------------------------------------- agent-level seams

type Captured = {
  started: Item[];
  items: Item[];
  deltas: Array<{ id: string; delta: string }>;
  rejections: FallbackRejectedPayload[];
};

function captureSink(): TurnSink & { captured: Captured } {
  const captured: Captured = { started: [], items: [], deltas: [], rejections: [] };
  const controller = new AbortController();
  let n = 0;
  return {
    captured,
    signal: controller.signal,
    newItemId: () => {
      n += 1;
      return `item_${n}`;
    },
    startItem: (item) => {
      captured.started.push({ ...item, status: "inProgress" } as Item);
    },
    delta: (id, delta) => {
      captured.deltas.push({ id, delta });
    },
    completeItem: (item) => {
      captured.items.push({ ...item, status: "completed" } as Item);
    },
    fallbackRejected: (payload) => {
      captured.rejections.push(payload);
    },
  };
}

type Step = { readonly ok: string; readonly servedModel?: string } | { readonly quota: number };

/** A port driven by a script: `{ quota: n }` throws the recorded signal; `{ ok }` serves. */
function scriptedPort(
  providerId: string,
  script: readonly Step[],
): {
  port: ProviderPort;
  calls: () => number;
} {
  let i = 0;
  return {
    calls: () => i,
    port: {
      providerId,
      streamTurn: async (request): Promise<ProviderTurnResult> => {
        const step = script[Math.min(i, script.length - 1)];
        i += 1;
        if (step !== undefined && "quota" in step) {
          throw new ProviderCallError(
            "failed",
            step.quota,
            `${providerId} request failed (HTTP ${step.quota})`,
            "quota-or-unreachable",
          );
        }
        const ok = (step as { ok: string }).ok;
        request.onTextDelta(ok);
        return {
          text: ok,
          requestedModelId: request.modelId,
          servedModel: (step as { servedModel?: string }).servedModel ?? request.modelId,
        };
      },
    },
  };
}

function kimiLane(port: ProviderPort): DirectLane {
  return {
    providerId: "kimi-code",
    credential: KEY,
    createPort: () => port,
    resolvePinnedModel: resolveKimiPinnedModel,
  };
}

function seatWith(overrides: Partial<EngineSeat> = {}): EngineSeat {
  return { ...MADC_DEFAULT_SEAT, ...overrides };
}

function ctxFor(seat: EngineSeat): AgentTurnContext {
  return {
    threadId: "thr_fb",
    seatId: seat.id,
    seat,
    seatPath: join(tmpdir(), `${seat.id}.json`),
    input: [{ type: "text", text: "hi" }],
    turnId: "turn_fb",
  };
}

// ---------------------------------------------------------------------------------- quota path

test("A3: a 429 with no fallbacks fails the turn -32008 quota-or-unreachable and emits an error item", async () => {
  const { port, calls } = scriptedPort("kimi-code", [{ quota: 429 }]);
  const agent = createProviderAgent({ directLanes: [kimiLane(port)] });
  const sink = captureSink();
  const err = await agent.run(ctxFor(seatWith()), sink).then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err instanceof RpcError);
  assert.equal(err.code, ErrorCode.ProviderUnavailable);
  assert.deepEqual(err.data, { providerId: "kimi-code", reason: "quota-or-unreachable" });
  const errorItems = sink.captured.items.filter((i) => i.kind === "error");
  assert.equal(errorItems.length, 1, "the recorded signal produces exactly one error item");
  assert.match((errorItems[0] as { message: string }).message, /quota-or-unreachable/);
  assert.equal((errorItems[0] as { code?: number }).code, ErrorCode.ProviderUnavailable);
  assert.equal(calls(), 1);
  assert.deepEqual(sink.captured.rejections, []);
  assert.deepEqual(
    [...(agent.redactValues ?? [])],
    [KEY],
    "the resolved lane key is redacted by exact value",
  );
});

test("A3: a 502 records the same signal", async () => {
  const { port } = scriptedPort("kimi-code", [{ quota: 502 }]);
  const agent = createProviderAgent({ directLanes: [kimiLane(port)] });
  const err = await agent.run(ctxFor(seatWith()), captureSink()).then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err instanceof RpcError);
  assert.deepEqual(err.data, { providerId: "kimi-code", reason: "quota-or-unreachable" });
});

// ----------------------------------------------------------------------- same-lane rule (D-M1-7)

test("A3: fallback walks the seat list — lane mismatches are rejected before any call, a headless-denied lane is skipped, and an eligible hop serves with fallbackFrom", async () => {
  const { port, calls } = scriptedPort("kimi-code", [{ quota: 429 }, { ok: "served by fallback" }]);
  const agent = createProviderAgent({ directLanes: [kimiLane(port)] });
  const sink = captureSink();
  const seat = seatWith({
    id: "prometheus",
    fallbacks: [
      "claude-code", // vendor-agent lane → status differs → pinned rejection
      "minimax-token-plan", // interactive-only + plan-interactive → both differ → rejection
      "ollama-cloud", // SAME lane, but headless-denied (D-M1-3) → skipped, never called
      "kimi-code", // same lane, allowed, credential present → serves the hop
    ],
  });
  await agent.run(ctxFor(seat), sink);
  assert.equal(calls(), 2, "primary attempt + the eligible hop; nothing else is called");

  // The pinned fallback.rejected payloads — one per mismatched candidate, in list order.
  assert.deepEqual(sink.captured.rejections, [
    {
      turnId: "turn_fb",
      candidate: "claude-code",
      assignedLane: { status: "allowed-direct", credentialClass: "payg" },
      candidateLane: { status: "allowed-via-vendor-agent", credentialClass: "vendor-session" },
      reason: "fallback-lane-mismatch",
    },
    {
      turnId: "turn_fb",
      candidate: "minimax-token-plan",
      assignedLane: { status: "allowed-direct", credentialClass: "payg" },
      candidateLane: { status: "interactive-only", credentialClass: "plan-interactive" },
      reason: "fallback-lane-mismatch",
    },
  ]);

  // The paired error-style items name the seat, the candidate, both lanes and the reason.
  const messages = sink.captured.items
    .filter((i) => i.kind === "error")
    .map((i) => (i as { message: string }).message);
  const mismatch = messages.filter((m) => m.includes("fallback-lane-mismatch"));
  assert.equal(mismatch.length, 2);
  assert.match(mismatch[0] ?? "", /seat prometheus/);
  assert.match(mismatch[0] ?? "", /claude-code/);
  assert.match(mismatch[0] ?? "", /allowed-direct\/payg/);
  assert.match(mismatch[0] ?? "", /allowed-via-vendor-agent\/vendor-session/);
  assert.match(mismatch[1] ?? "", /minimax-token-plan/);
  // The headless-denied same-lane candidate is skipped WITHOUT a lane-mismatch record.
  assert.ok(!messages.some((m) => m.includes("ollama-cloud") && m.includes("lane-mismatch")));

  // The served hop: agentMessage + receipt with an honest fallbackFrom (previous backing id).
  // (A self-hop is the only registry-legal SERVED fallback in A3: until A4 wires another
  // headless-allowed direct lane, kimi-code is the single eligible candidate; A7 re-runs the
  // pinned cases against the seeded roster.)
  const agentMessage = sink.captured.items.find((i) => i.kind === "agentMessage");
  assert.equal((agentMessage as { text: string }).text, "served by fallback");
  const receipt = sink.captured.items.find((i) => i.kind === "servedModel") as ServedModelItem;
  assert.ok(receipt);
  assert.deepEqual(
    { ...receipt, id: "" },
    {
      id: "",
      kind: "servedModel",
      status: "completed",
      requestedModel: "kimi-coding/kimi-for-coding",
      servedModel: "kimi-for-coding",
      backing: "kimi-code",
      providerId: "kimi-code",
      lane: "allowed-direct",
      mode: "headless",
      fallbackFrom: "kimi-code",
      vendorReported: false,
    },
  );
});

test("A3: a candidate without credentials is skipped; when nobody can serve, the PRIMARY's quota error stands", async () => {
  const { port, calls } = scriptedPort("kimi-code", [{ quota: 429 }]);
  const agent = createProviderAgent({
    directLanes: [
      kimiLane(port),
      {
        // xai-api is same-lane (allowed-direct + payg) and headless-allowed, but UNWIRED until
        // A4: assertAllowed(requireLive) denies it → skipped before any call.
        providerId: "xai-api",
        credential: null,
        createPort: () => {
          throw new Error("never built");
        },
        resolvePinnedModel: () => ({ ok: false, issue: "never" }),
      },
    ],
  });
  const sink = captureSink();
  const seat = seatWith({ fallbacks: ["xai-api"] });
  const err = await agent.run(ctxFor(seat), sink).then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err instanceof RpcError);
  assert.equal(err.code, ErrorCode.ProviderUnavailable);
  assert.deepEqual(err.data, { providerId: "kimi-code", reason: "quota-or-unreachable" });
  assert.equal(calls(), 1, "only the primary was ever called");
  assert.deepEqual(sink.captured.rejections, [], "an unwired skip is not a lane mismatch");
});

test("A3: non-quota failures keep the M0 path — no fallback, -32603", async () => {
  const failing: ProviderPort = {
    providerId: "kimi-code",
    streamTurn: async () => {
      throw new ProviderCallError("failed", 500, "kimi-code request failed (HTTP 500)");
    },
  };
  let extraCalls = 0;
  const agent = createProviderAgent({
    directLanes: [
      kimiLane(failing),
      {
        providerId: "xai-api",
        credential: "unused",
        createPort: () => ({
          providerId: "xai-api",
          streamTurn: async () => {
            extraCalls += 1;
            throw new Error("unreachable");
          },
        }),
        resolvePinnedModel: () => ({ ok: true, modelId: "x" }),
      },
    ],
  });
  const sink = captureSink();
  const err = await agent.run(ctxFor(seatWith({ fallbacks: ["xai-api"] })), sink).then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err instanceof RpcError);
  assert.equal(err.code, ErrorCode.InternalError);
  assert.equal(extraCalls, 0, "only the quota-or-unreachable signal drives fallback in A3");
  assert.deepEqual(
    sink.captured.items.filter((i) => i.kind === "error"),
    [],
  );
});

// ------------------------------------------------------------- fallback.rejected durability

test("A3: a fallback.rejected event is durable, chain-verifies, and survives rebuild; malformed payloads are refused", () => {
  const root = mkdtempSync(join(tmpdir(), "madc-a3-fb-"));
  try {
    const path = join(root, "thr_fb.jsonl");
    const w = unguardedSessionWriterForTests.create(
      path,
      "thr_fb",
      "madc-default",
      { cwd: null, backing: "kimi-code", providerId: "kimi-code", pinnedModel: "m" },
      () => [],
    );
    w.append("turn.start", { turnId: "turn_1", inputText: "hi" });
    const rejection: FallbackRejectedPayload = {
      turnId: "turn_1",
      candidate: "claude-code",
      assignedLane: { status: "allowed-direct", credentialClass: "payg" },
      candidateLane: { status: "allowed-via-vendor-agent", credentialClass: "vendor-session" },
      reason: "fallback-lane-mismatch",
    };
    w.append("fallback.rejected", rejection);
    w.append("turn.end", {
      turnId: "turn_1",
      status: "failed",
      error: { code: -32008, message: "m" },
    });
    const verified = verifySessionFile(path, "thr_fb");
    assert.equal(verified.ok, true, "the chain covers the new event type");
    const vt = verifySessionText(readFileSync(path, "utf8"));
    assert.equal(vt.ok, true);
    const rebuilt = rebuildSession(vt.ok ? vt.events : []);
    assert.equal(rebuilt.turns.length, 1, "rebuild tolerates the new event type");
    const lines = readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as { type: string; payload: unknown });
    const event = lines.find((l) => l.type === "fallback.rejected");
    assert.deepEqual(event?.payload, rejection);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------------------- engine e2e

test("A3 e2e: an ollama-cloud seat file loads (S1) and every headless turn is refused -32007 before any provider request (D-M1-3/D-M1-4)", async () => {
  const { home, cleanup } = makeHome();
  const wireLog = join(home, "..", "ollama-wire.jsonl");
  const client = startEngine(home, DIRECT_FAKE_ENGINE, {
    KIMI_API_KEY: KEY,
    MADC_API_KEY_OLLAMA_CLOUD: "ollama-sentinel-key-e2e",
    MADC_TEST_OLLAMA_TAGS: JSON.stringify(["gpt-oss-120b"]),
    MADC_TEST_WIRE_LOG: join(home, "..", "kimi-wire.jsonl"),
    MADC_TEST_OLLAMA_WIRE_LOG: wireLog,
  });
  try {
    writeSeatFile(home, {
      ...MADC_DEFAULT_SEAT,
      id: "surface-architect",
      role: "contracts and pins",
      preferredBacking: "ollama-cloud",
      pinnedModel: "ollama-cloud/gpt-oss-120b",
      policy: { headlessOk: false },
      memory: { mode: "in-session" },
    });
    await handshake(client);
    const { thread } = await client.request("thread/start", { seatId: "surface-architect" });
    const threadId = (thread as { id: string }).id;
    const err = await expectRpcError(
      client.request("turn/start", { threadId, input: [{ type: "text", text: "x" }] }),
    );
    assert.equal(err.code, ErrorCode.ProviderDenied);
    assert.deepEqual(err.data, {
      providerId: "ollama-cloud",
      status: "allowed-direct",
      reason: "headless-not-permitted",
    });
    // The seat LOADED, so a session exists with the widened backing — and it verifies.
    const path = join(home, "sessions", `${threadId}.jsonl`);
    const open = JSON.parse(readFileSync(path, "utf8").split("\n")[0] ?? "") as {
      type: string;
      payload: { backing: string };
    };
    assert.equal(open.type, "session.open");
    assert.equal(open.payload.backing, "ollama-cloud");
    assert.equal(verifySessionFile(path, threadId, {}, home).ok, true);
    // Not one provider request — not tags, not chat.
    assert.equal(existsSync(wireLog), false, "no ollama request left the engine");
  } finally {
    await client.close();
    cleanup();
  }
});

test("A3 e2e: the kimi lane runs through the two-lane fixture engine and dual-writes the P2 receipt", async () => {
  const { home, cleanup } = makeHome();
  const client = startEngine(home, DIRECT_FAKE_ENGINE, {
    KIMI_API_KEY: KEY,
    MADC_TEST_KIMI_REPLY: JSON.stringify({
      type: "stream",
      chunks: ["Hi", " A3"],
      model: "kimi-for-coding-2026-09",
    }),
  });
  try {
    await handshake(client);
    const { thread } = await client.request("thread/start", {});
    const threadId = (thread as { id: string }).id;
    const { turn } = await client.request("turn/start", {
      threadId,
      input: [{ type: "text", text: "say hi" }],
    });
    const done = await client.waitFor(
      (m) =>
        m.method === "turn/completed" &&
        (m.params as { turn: { id: string } }).turn.id === (turn as { id: string }).id,
    );
    const final = (done.params as { turn: { status: string; items: Item[] } }).turn;
    assert.equal(final.status, "completed");
    const receipt = final.items.find((i) => i.kind === "servedModel") as ServedModelItem;
    assert.deepEqual(
      { ...receipt, id: "" },
      {
        id: "",
        kind: "servedModel",
        status: "completed",
        requestedModel: "kimi-coding/kimi-for-coding",
        servedModel: "kimi-for-coding-2026-09",
        backing: "kimi-code",
        providerId: "kimi-code",
        lane: "allowed-direct",
        mode: "headless",
        fallbackFrom: null,
        vendorReported: true,
      },
    );
    // Dual write with the P2 payload, chain intact.
    const path = join(home, "sessions", `${threadId}.jsonl`);
    const events = readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as { type: string; payload: Record<string, unknown> });
    const served = events.find((e) => e.type === "servedModel");
    assert.deepEqual(served?.payload, {
      turnId: (turn as { id: string }).id,
      requestedModel: "kimi-coding/kimi-for-coding",
      servedModel: "kimi-for-coding-2026-09",
      backing: "kimi-code",
      providerId: "kimi-code",
      lane: "allowed-direct",
      mode: "headless",
      fallbackFrom: null,
      vendorReported: true,
    });
    assert.equal(verifySessionFile(path, threadId, {}, home).ok, true);
  } finally {
    await client.close();
    cleanup();
  }
});

test("A3: defaultAgentFactory resolves every direct lane from the M1-A2 store and the redactor learns each key", async () => {
  const root = mkdtempSync(join(tmpdir(), "madc-a3-learn-"));
  const saved: Record<string, string | undefined> = {};
  try {
    const shims = writeKeychainShims(join(root, "bin"));
    const accounts = join(root, "accounts");
    mkdirSync(accounts, { recursive: true });
    const kimiKey = "synthetic-kimi-lane-key-a3-0001";
    const ollamaKey = "synthetic-ollama-lane-key-a3-0002";
    writeFileSync(join(accounts, "kimi-code"), kimiKey, { mode: 0o600 });
    writeFileSync(join(accounts, "ollama-cloud"), ollamaKey, { mode: 0o600 });
    const env = keychainEnv(shims, accounts, "darwin");
    for (const [name, value] of Object.entries(env)) {
      saved[name] = process.env[name];
      process.env[name] = value;
    }
    const agent = await defaultAgentFactory({ home: join(root, "home") });
    const learned = [...(agent.redactValues ?? [])].sort();
    assert.deepEqual(learned, [kimiKey, ollamaKey].sort());
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
