/**
 * M1-A6 Grok Build wiring, end to end through a spawned engine. The fixture engine
 * (`grok-fake-engine.ts`) runs the production provider agent with grok-build over the generic ACP
 * client and the `fake-acp-agent.ts` fixture child — no real `grok` binary, no credentials, no
 * network.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { EngineClient } from "./client.ts";
import type { Item, Turn } from "./protocol/types.ts";
import { MADC_DEFAULT_SEAT } from "./seat.ts";
import { verifySessionText } from "./session-store.ts";
import {
  expectRpcError,
  GROK_FAKE_ENGINE,
  handshake,
  makeHome,
  seatFileBody,
  startEngineCapturingStderr,
  writeSeatFile,
} from "./testing/harness.ts";

const GROK_MODEL = "grok-4.7";
/** What the fixture's binary detector reports when `grok` is "present". */
const FAKE_GROK_BINARY = "/fake/bin/grok";

type Setup = {
  seats?: Record<string, unknown>[];
  /** Fixture `detectGrokBinary` answer; absent → the grok binary is missing. */
  binary?: string;
  /** Fixture-child behavior (see fake-acp-agent.ts). */
  mode?: string;
  /** Simulate the grok binary vanishing between preflight and spawn. */
  spawnError?: boolean;
};

type WireMessage = { id?: number; method?: string; params?: Record<string, unknown> };

type Run = {
  client: EngineClient;
  home: string;
  stderr: () => string;
  wire: () => WireMessage[];
  spawned: () => { argv: string[]; xaiApiKeyPresent: boolean }[];
};

function jsonLines<T>(path: string): T[] {
  return existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as T)
    : [];
}

async function withGrokEngine(setup: Setup, fn: (run: Run) => Promise<void>): Promise<void> {
  const { home, cleanup } = makeHome();
  const wireLog = join(home, "..", "acp-wire.jsonl");
  const argvLog = join(home, "..", "acp-argv.jsonl");
  const extra: Record<string, string | undefined> = {
    MADC_TEST_ACP_WIRE_LOG: wireLog,
    MADC_TEST_ACP_ARGV_LOG: argvLog,
  };
  if (setup.binary !== undefined) extra.MADC_TEST_GROK_BINARY = setup.binary;
  if (setup.mode !== undefined) extra.MADC_TEST_ACP_MODE = setup.mode;
  if (setup.spawnError === true) extra.MADC_TEST_GROK_SPAWN_ERROR = "1";
  for (const seat of setup.seats ?? []) writeSeatFile(home, seat);
  const { client, stderr } = startEngineCapturingStderr(home, GROK_FAKE_ENGINE, extra);
  try {
    await handshake(client);
    await fn({
      client,
      home,
      stderr,
      wire: () => jsonLines<WireMessage>(wireLog),
      spawned: () => jsonLines(argvLog),
    });
  } finally {
    await client.close();
    cleanup();
  }
}

/** A grok-build backed seat file body (madc-default fields with the backing swapped). */
function grokSeat(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...seatFileBody(MADC_DEFAULT_SEAT),
    id,
    preferredBacking: "grok-build",
    pinnedModel: GROK_MODEL,
    ...overrides,
  };
}

async function startThread(client: EngineClient, seatId: string): Promise<string> {
  const { thread } = await client.request("thread/start", { seatId });
  return thread.id;
}

async function runTurn(client: EngineClient, threadId: string, text = "hi"): Promise<Turn> {
  const { turn } = await client.request("turn/start", {
    threadId,
    input: [{ type: "text", text }],
  });
  const done = await client.waitFor(
    (m) => m.method === "turn/completed" && (m.params as { turn: Turn }).turn.id === turn.id,
  );
  return (done.params as { turn: Turn }).turn;
}

type SessionLine = { type: string; payload: Record<string, unknown> };

function assertChainVerifies(home: string, threadId: string): SessionLine[] {
  const text = readFileSync(join(home, "sessions", `${threadId}.jsonl`), "utf8");
  const verified = verifySessionText(text, threadId);
  assert.ok(verified.ok, `hash chain: ${verified.ok === false ? verified.reason : ""}`);
  return text
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as SessionLine);
}

function assertNeverSurfaces(run: Run, text: string): void {
  assert.ok(!JSON.stringify(run.client.messages).includes(text), "on the protocol wire");
  assert.ok(!run.stderr().includes(text), "on stderr");
  for (const file of readdirSync(run.home, { recursive: true, withFileTypes: true })) {
    if (!file.isFile()) continue;
    assert.ok(
      !readFileSync(join(file.parentPath, file.name), "utf8").includes(text),
      `written to ${file.name}`,
    );
  }
}

type Receipt = Extract<Item, { kind: "servedModel" }>;

test("M1-A6 happy path: a grok-build seat runs a turn over ACP; vendor-reported receipt on wire and JSONL", async () => {
  await withGrokEngine(
    { seats: [grokSeat("grok-seat")], binary: FAKE_GROK_BINARY },
    async (run) => {
      const threadId = await startThread(run.client, "grok-seat");
      const turn = await runTurn(run.client, threadId, "say hi");
      assert.equal(turn.status, "completed");
      assert.equal(turn.error, null);
      assert.deepEqual(
        turn.items.map((item) => item.kind),
        ["userMessage", "agentMessage", "servedModel"],
      );
      const agent = turn.items[1] as Extract<Item, { kind: "agentMessage" }>;
      assert.equal(agent.text, "fake acp answer to: say hi");
      const expected = {
        requestedModel: GROK_MODEL,
        servedModel: GROK_MODEL,
        backing: "grok-build",
        providerId: "grok-build",
        lane: "allowed-via-vendor-agent",
        mode: "headless",
        fallbackFrom: null,
        // The fake agent reported its model through an ACP `model` config option.
        vendorReported: true,
      };
      const receipt = turn.items[2] as Receipt;
      assert.deepEqual(
        { ...receipt, id: "" },
        {
          id: "",
          kind: "servedModel",
          status: "completed",
          ...expected,
        },
      );
      const lines = assertChainVerifies(run.home, threadId);
      const receiptEvent = lines.find((l) => l.type === "servedModel");
      assert.deepEqual(receiptEvent?.payload, { turnId: turn.id, ...expected });
      assert.deepEqual(lines.at(-1)?.payload, {
        turnId: turn.id,
        status: "completed",
        error: null,
      });
      // The deltas streamed to the client concatenate to the authoritative text.
      const deltas = run.client.notifications
        .filter((n) => n.method === "item/agentMessage/delta")
        .map((n) => (n.params as { delta: string }).delta)
        .join("");
      assert.equal(deltas, agent.text);
      assert.deepEqual(run.client.protocolViolations, []);
    },
  );
});

test("spawn: `grok --no-auto-update agent --no-leader --model=<pinned> stdio`, never --always-approve", async () => {
  await withGrokEngine(
    { seats: [grokSeat("grok-seat")], binary: FAKE_GROK_BINARY },
    async (run) => {
      const turn = await runTurn(run.client, await startThread(run.client, "grok-seat"));
      assert.equal(turn.status, "completed");
      const [child] = run.spawned();
      assert.deepEqual(child?.argv, [
        "--no-auto-update",
        "agent",
        "--no-leader",
        `--model=${GROK_MODEL}`,
        "stdio",
      ]);
      // The hermetic test env carries no XAI_API_KEY and madc never injects one: cached login.
      assert.equal(child?.xaiApiKeyPresent, false);
      const auth = run.wire().find((m) => m.method === "authenticate");
      assert.deepEqual(auth?.params, { methodId: "cached_token", _meta: { headless: true } });
      // The seat's standing instructions lead the ACP prompt (ACP has no system-prompt field).
      const prompt = run.wire().find((m) => m.method === "session/prompt");
      assert.deepEqual(prompt?.params?.prompt, [
        { type: "text", text: MADC_DEFAULT_SEAT.standingInstructions },
        { type: "text", text: "hi" },
      ]);
    },
  );
});

test("no vendor model report → the receipt records the requested model, vendorReported false", async () => {
  await withGrokEngine(
    { seats: [grokSeat("grok-seat")], binary: FAKE_GROK_BINARY, mode: "no-model" },
    async (run) => {
      const turn = await runTurn(run.client, await startThread(run.client, "grok-seat"));
      assert.equal(turn.status, "completed");
      const receipt = turn.items.find((item) => item.kind === "servedModel") as Receipt;
      assert.equal(receipt.requestedModel, GROK_MODEL);
      assert.equal(receipt.servedModel, GROK_MODEL);
      assert.equal(receipt.vendorReported, false);
    },
  );
});

test("vendor tool events become toolCall / toolResult items before the agentMessage", async () => {
  await withGrokEngine(
    { seats: [grokSeat("grok-seat")], binary: FAKE_GROK_BINARY, mode: "tools" },
    async (run) => {
      const threadId = await startThread(run.client, "grok-seat");
      const turn = await runTurn(run.client, threadId);
      assert.equal(turn.status, "completed");
      assert.deepEqual(
        turn.items.map((item) => [item.kind, item.status]),
        [
          ["userMessage", "completed"],
          ["toolCall", "completed"],
          ["toolResult", "completed"],
          ["toolCall", "completed"],
          ["toolResult", "completed"],
          // A call the vendor never finished is closed without an invented result.
          ["toolCall", "completed"],
          ["agentMessage", "completed"],
          ["servedModel", "completed"],
        ],
      );
      const [, readCall, readResult, execCall, execResult, openCall] = turn.items as Item[];
      assert.deepEqual(
        { ...readCall, id: "" },
        {
          id: "",
          kind: "toolCall",
          status: "completed",
          name: "Read README.md",
          arguments: { path: "README.md" },
        },
      );
      assert.deepEqual(
        { ...readResult, id: "" },
        {
          id: "",
          kind: "toolResult",
          status: "completed",
          callId: readCall?.id,
          name: "Read README.md",
          output: "# MADC",
          isError: false,
        },
      );
      assert.equal((execResult as Extract<Item, { kind: "toolResult" }>).callId, execCall?.id);
      assert.equal((execResult as Extract<Item, { kind: "toolResult" }>).isError, true);
      assert.equal((openCall as Extract<Item, { kind: "toolCall" }>).name, "Search the web");
      const agent = turn.items.find((item) => item.kind === "agentMessage");
      assert.equal((agent as Extract<Item, { kind: "agentMessage" }>).text, "Looking. Done.");
      // Every tool item is durable in the verified session chain too.
      const lines = assertChainVerifies(run.home, threadId);
      const kinds = lines
        .filter((l) => l.type === "item")
        .map((l) => (l.payload.item as Item).kind);
      assert.deepEqual(
        kinds.filter((k) => k === "toolCall" || k === "toolResult"),
        ["toolCall", "toolResult", "toolCall", "toolResult", "toolCall"],
      );
      assert.deepEqual(run.client.protocolViolations, []);
    },
  );
});

test("binary missing → -32008 binary-missing at turn/start, before any child or turn", async () => {
  await withGrokEngine({ seats: [grokSeat("grok-seat")] }, async (run) => {
    const threadId = await startThread(run.client, "grok-seat");
    const err = await expectRpcError(
      run.client.request("turn/start", { threadId, input: [{ type: "text", text: "x" }] }),
    );
    assert.equal(err.code, -32008);
    assert.deepEqual(err.data, { providerId: "grok-build", reason: "binary-missing" });
    assert.ok(!run.client.notifications.some((n) => n.method === "turn/started"));
    assert.deepEqual(run.spawned(), [], "no child was spawned");
    assert.deepEqual(run.wire(), []);
  });
});

test("binary vanishes between preflight and spawn → turn failed -32008 binary-missing", async () => {
  await withGrokEngine(
    { seats: [grokSeat("grok-seat")], binary: FAKE_GROK_BINARY, spawnError: true },
    async (run) => {
      const threadId = await startThread(run.client, "grok-seat");
      const turn = await runTurn(run.client, threadId);
      assert.equal(turn.status, "failed");
      assert.deepEqual(turn.error, {
        code: -32008,
        message: "Provider unavailable",
        data: { providerId: "grok-build", reason: "binary-missing" },
      });
      assert.ok(!turn.items.some((item) => item.kind === "servedModel"));
      assertChainVerifies(run.home, threadId);
    },
  );
});

test("turn/interrupt maps to ACP session/cancel; the turn ends interrupted with no receipt", async () => {
  await withGrokEngine(
    { seats: [grokSeat("grok-seat")], binary: FAKE_GROK_BINARY, mode: "hang" },
    async (run) => {
      const threadId = await startThread(run.client, "grok-seat");
      const { turn } = await run.client.request("turn/start", {
        threadId,
        input: [{ type: "text", text: "x" }],
      });
      // Wait until the vendor prompt is in flight (its partial chunk streamed as a delta).
      await run.client.waitForNotification("item/agentMessage/delta");
      await run.client.request("turn/interrupt", { threadId, turnId: turn.id });
      const done = await run.client.waitFor(
        (m) => m.method === "turn/completed" && (m.params as { turn: Turn }).turn.id === turn.id,
      );
      const final = (done.params as { turn: Turn }).turn;
      assert.equal(final.status, "interrupted");
      assert.ok(!final.items.some((item) => item.kind === "servedModel"));
      // The fixture logs session/cancel when it reads its stdin, which can land after the engine's
      // turn/completed — poll (the cancel grace guarantees it is written before any kill).
      let cancel: WireMessage | undefined;
      for (let i = 0; i < 400 && cancel === undefined; i++) {
        cancel = run.wire().find((m) => m.method === "session/cancel");
        if (cancel === undefined) await new Promise((r) => setTimeout(r, 5));
      }
      assert.deepEqual(cancel?.params, { sessionId: "sess_fakeacp" });
      const lines = assertChainVerifies(run.home, threadId);
      assert.ok(!lines.some((l) => l.type === "servedModel"));
      assert.equal(lines.at(-1)?.payload.status, "interrupted");
    },
  );
});

test("Grok not signed in → turn failed -32008 no-credentials; vendor detail never surfaces", async () => {
  for (const mode of ["no-auth", "auth-error", "auth-required"]) {
    await withGrokEngine(
      { seats: [grokSeat("grok-seat")], binary: FAKE_GROK_BINARY, mode },
      async (run) => {
        const threadId = await startThread(run.client, "grok-seat");
        const turn = await runTurn(run.client, threadId);
        assert.equal(turn.status, "failed", mode);
        assert.deepEqual(
          turn.error,
          {
            code: -32008,
            message: "Provider unavailable",
            data: { providerId: "grok-build", reason: "no-credentials" },
          },
          mode,
        );
        assert.ok(!run.wire().some((m) => m.method === "session/prompt"), mode);
        assertChainVerifies(run.home, threadId);
        assertNeverSurfaces(run, "account details");
      },
    );
  }
});

test("agent child non-zero exit → turn failed -32603; vendor stderr never surfaces", async () => {
  await withGrokEngine(
    { seats: [grokSeat("grok-seat")], binary: FAKE_GROK_BINARY, mode: "nonzero" },
    async (run) => {
      const threadId = await startThread(run.client, "grok-seat");
      const turn = await runTurn(run.client, threadId);
      assert.equal(turn.status, "failed");
      assert.deepEqual(turn.error, { code: -32603, message: "grok-build agent child exited 1" });
      assertChainVerifies(run.home, threadId);
      assertNeverSurfaces(run, "account details");
    },
  );
});

test("a flag-like pinnedModel is refused -32006 at turn/start before any spawn", async () => {
  await withGrokEngine(
    {
      seats: [grokSeat("grok-seat", { pinnedModel: "--always-approve" })],
      binary: FAKE_GROK_BINARY,
    },
    async (run) => {
      const threadId = await startThread(run.client, "grok-seat");
      const err = await expectRpcError(
        run.client.request("turn/start", { threadId, input: [{ type: "text", text: "x" }] }),
      );
      assert.equal(err.code, -32006);
      assert.deepEqual(run.spawned(), [], "no child was spawned");
    },
  );
});

test("the codex vendor path is unaffected on the same engine", async () => {
  await withGrokEngine(
    {
      seats: [
        {
          ...seatFileBody(MADC_DEFAULT_SEAT),
          id: "codex-seat",
          preferredBacking: "codex",
          pinnedModel: "gpt-5.1-codex",
        },
      ],
      binary: FAKE_GROK_BINARY,
    },
    async (run) => {
      // codex binary not reported by this fixture → its own preflight refusal, untouched.
      const threadId = await startThread(run.client, "codex-seat");
      const err = await expectRpcError(
        run.client.request("turn/start", { threadId, input: [{ type: "text", text: "x" }] }),
      );
      assert.equal(err.code, -32008);
      assert.deepEqual(err.data, { providerId: "codex", reason: "binary-missing" });
      assert.deepEqual(run.spawned(), [], "grok was never spawned for a codex seat");
    },
  );
});
