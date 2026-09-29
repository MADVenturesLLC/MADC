/**
 * M0-A6 Codex wiring, end to end through a spawned engine. The fixture engine
 * (`codex-fake-engine.ts`) runs the production provider agent with all three M0 backings over
 * fakes — codex via the `fake-codex.ts` fixture app-server child — no real `codex` binary, no
 * credentials, no network.
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
  CODEX_FAKE_ENGINE,
  expectRpcError,
  handshake,
  makeHome,
  seatFileBody,
  startEngineCapturingStderr,
  writeSeatFile,
} from "./testing/harness.ts";

const CODEX_MODEL = "gpt-5.1-codex";
const CLAUDE_MODEL = "claude-sonnet-4-5";
/** What the fixture's binary detectors report when a binary is "present". */
const FAKE_CODEX_BINARY = "/fake/bin/codex";
const FAKE_CLAUDE_BINARY = "/fake/bin/claude";

type Setup = {
  /** Seat files written to `$MADC_HOME/seats/<id>.json` before the engine starts. */
  seats?: Record<string, unknown>[];
  /** Fixture `detectCodexBinary` answer; absent → the codex binary is missing. */
  binary?: string;
  /** Fixture `detectClaudeBinary` answer; absent → the claude binary is missing. */
  claudeBinary?: string;
  /** Fixture-child behavior (see fake-codex.ts). */
  mode?: string;
  /** Simulate the codex binary vanishing between preflight and spawn. */
  spawnError?: boolean;
};

/** One client message the fixture child received (what the adapter sent to `codex app-server`). */
type WireMessage = { id?: number; method?: string; params?: Record<string, unknown> };

type Run = {
  client: EngineClient;
  home: string;
  stderr: () => string;
  wire: () => WireMessage[];
};

async function withCodexEngine(setup: Setup, fn: (run: Run) => Promise<void>): Promise<void> {
  const { home, cleanup } = makeHome();
  const wireLog = join(home, "..", "codex-wire.jsonl");
  const extra: Record<string, string | undefined> = { MADC_TEST_CODEX_WIRE_LOG: wireLog };
  if (setup.binary !== undefined) extra.MADC_TEST_CODEX_BINARY = setup.binary;
  if (setup.claudeBinary !== undefined) extra.MADC_TEST_CLAUDE_BINARY = setup.claudeBinary;
  if (setup.mode !== undefined) extra.MADC_TEST_CODEX_MODE = setup.mode;
  if (setup.spawnError === true) extra.MADC_TEST_CODEX_SPAWN_ERROR = "1";
  for (const seat of setup.seats ?? []) writeSeatFile(home, seat);
  const { client, stderr } = startEngineCapturingStderr(home, CODEX_FAKE_ENGINE, extra);
  const wire = () =>
    existsSync(wireLog)
      ? readFileSync(wireLog, "utf8")
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => JSON.parse(line) as WireMessage)
      : [];
  try {
    await handshake(client);
    await fn({ client, home, stderr, wire });
  } finally {
    await client.close();
    cleanup();
  }
}

/** A codex backed seat file body (madc-default fields with the backing swapped). */
function codexSeat(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    // File projection: a v1 FILE must not carry S2's migrated `fallbacks` (M1-A7).
    ...seatFileBody(MADC_DEFAULT_SEAT),
    id,
    preferredBacking: "codex",
    pinnedModel: CODEX_MODEL,
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

function sessionLines(home: string, threadId: string): SessionLine[] {
  return readFileSync(join(home, "sessions", `${threadId}.jsonl`), "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as SessionLine);
}

/** The durable record verifies (seat pin §4.3) and ends with a closed turn. */
function assertChainVerifies(home: string, threadId: string): SessionLine[] {
  const text = readFileSync(join(home, "sessions", `${threadId}.jsonl`), "utf8");
  const verified = verifySessionText(text, threadId);
  assert.ok(verified.ok, `hash chain: ${verified.ok === false ? verified.reason : ""}`);
  return sessionLines(home, threadId);
}

/** Vendor stderr/upstream text is hostile detail: it must never reach the wire, logs, or MADC_HOME. */
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

test("A6 happy path: a codex seat runs a turn; receipt on the wire and in session JSONL", async () => {
  await withCodexEngine(
    { seats: [codexSeat("codex-seat")], binary: FAKE_CODEX_BINARY },
    async (run) => {
      const threadId = await startThread(run.client, "codex-seat");
      const turn = await runTurn(run.client, threadId, "say hi");
      assert.equal(turn.status, "completed");
      assert.equal(turn.error, null);
      assert.deepEqual(
        turn.items.map((item) => item.kind),
        ["userMessage", "agentMessage", "servedModel"],
      );
      const agent = turn.items[1] as Extract<Item, { kind: "agentMessage" }>;
      assert.equal(agent.text, "fake codex answer to: say hi");
      const receipt = turn.items[2] as Extract<Item, { kind: "servedModel" }>;
      assert.deepEqual(
        { ...receipt, id: "" },
        {
          id: "",
          kind: "servedModel",
          status: "completed",
          requestedModel: CODEX_MODEL,
          servedModel: CODEX_MODEL,
          backing: "codex",
          providerId: "codex",
          // M1 P2 fields (see the claude happy path): echo = not vendor-reported.
          lane: "allowed-via-vendor-agent",
          mode: "headless",
          fallbackFrom: null,
          vendorReported: false,
        },
      );
      // Dual write (seat pin §4.2): the JSONL servedModel event equals the protocol receipt.
      const lines = assertChainVerifies(run.home, threadId);
      const receiptEvent = lines.find((l) => l.type === "servedModel");
      assert.ok(receiptEvent !== undefined, "servedModel event in session JSONL");
      assert.deepEqual(receiptEvent.payload, {
        turnId: turn.id,
        requestedModel: CODEX_MODEL,
        servedModel: CODEX_MODEL,
        backing: "codex",
        providerId: "codex",
        lane: "allowed-via-vendor-agent",
        mode: "headless",
        fallbackFrom: null,
        vendorReported: false,
      });
      assert.equal(lines.at(-1)?.type, "turn.end");
      assert.deepEqual(lines.at(-1)?.payload, {
        turnId: turn.id,
        status: "completed",
        error: null,
      });
      assert.deepEqual(run.client.protocolViolations, []);
    },
  );
});

test("A6: the seat's pinnedModel and standingInstructions reach the vendor app-server verbatim", async () => {
  await withCodexEngine(
    {
      seats: [codexSeat("codex-mini", { pinnedModel: "gpt-5.1-codex-mini" })],
      binary: FAKE_CODEX_BINARY,
    },
    async (run) => {
      const threadId = await startThread(run.client, "codex-mini");
      const turn = await runTurn(run.client, threadId, "review this");
      assert.equal(turn.status, "completed");
      const receipt = turn.items.find((item) => item.kind === "servedModel") as
        | Extract<Item, { kind: "servedModel" }>
        | undefined;
      assert.equal(receipt?.requestedModel, "gpt-5.1-codex-mini");
      assert.equal(
        receipt?.servedModel,
        "gpt-5.1-codex-mini",
        "fixture echoes the model it received",
      );
      const wire = run.wire();
      const threadStart = wire.find((m) => m.method === "thread/start");
      assert.deepEqual(threadStart?.params, {
        model: "gpt-5.1-codex-mini",
        approvalPolicy: "never",
        ephemeral: true,
        developerInstructions: MADC_DEFAULT_SEAT.standingInstructions,
      });
      const turnStart = wire.find((m) => m.method === "turn/start");
      assert.deepEqual(turnStart?.params, {
        threadId: "thr_fakecodex",
        input: [{ type: "text", text: "review this", text_elements: [] }],
      });
      // MAD identifies itself honestly in the app-server handshake.
      const initialize = wire.find((m) => m.method === "initialize");
      assert.ok(initialize !== undefined);
      const clientInfo = initialize.params?.clientInfo as Record<string, unknown>;
      assert.equal(clientInfo.name, "madc");
    },
  );
});

test("binary missing → -32008 binary-missing at turn/start, before any child or turn", async () => {
  await withCodexEngine({ seats: [codexSeat("codex-seat")] }, async (run) => {
    const threadId = await startThread(run.client, "codex-seat");
    const err = await expectRpcError(
      run.client.request("turn/start", { threadId, input: [{ type: "text", text: "x" }] }),
    );
    assert.equal(err.code, -32008);
    assert.deepEqual(err.data, { providerId: "codex", reason: "binary-missing" });
    assert.ok(!run.client.notifications.some((n) => n.method === "turn/started"));
    assert.equal(run.wire().length, 0, "no child was spawned");
    // A refused turn writes nothing — the session holds only session.open.
    assert.deepEqual(
      sessionLines(run.home, threadId).map((l) => l.type),
      ["session.open"],
    );
  });
});

test("binary vanishes between preflight and spawn → turn failed -32008 (protocol pin §4.2)", async () => {
  await withCodexEngine(
    { seats: [codexSeat("codex-seat")], binary: FAKE_CODEX_BINARY, spawnError: true },
    async (run) => {
      const threadId = await startThread(run.client, "codex-seat");
      const turn = await runTurn(run.client, threadId);
      assert.equal(turn.status, "failed");
      assert.deepEqual(turn.error, {
        code: -32008,
        message: "Provider unavailable",
        data: { providerId: "codex", reason: "binary-missing" },
      });
      assert.ok(!turn.items.some((item) => item.kind === "servedModel"));
      const lines = assertChainVerifies(run.home, threadId);
      assert.equal(lines.at(-1)?.type, "turn.end");
      assert.deepEqual(lines.at(-1)?.payload, {
        turnId: turn.id,
        status: "failed",
        error: { code: -32008, message: "Provider unavailable" },
      });
    },
  );
});

test("vendor child non-zero exit → turn failed -32603; vendor stderr never surfaces", async () => {
  await withCodexEngine(
    { seats: [codexSeat("codex-seat")], binary: FAKE_CODEX_BINARY, mode: "nonzero" },
    async (run) => {
      const threadId = await startThread(run.client, "codex-seat");
      const turn = await runTurn(run.client, threadId);
      assert.equal(turn.status, "failed");
      assert.deepEqual(turn.error, {
        code: -32603,
        message: "codex app-server child exited 1",
      });
      assert.deepEqual(
        turn.items.map((item) => [item.kind, item.status]),
        [
          ["userMessage", "completed"],
          ["agentMessage", "failed"],
          ["error", "completed"],
        ],
      );
      assertChainVerifies(run.home, threadId);
      assertNeverSurfaces(run, "account details");
    },
  );
});

test("vendor-reported failed turn → turn failed -32603; upstream detail never surfaces", async () => {
  await withCodexEngine(
    { seats: [codexSeat("codex-seat")], binary: FAKE_CODEX_BINARY, mode: "turn-failed" },
    async (run) => {
      const threadId = await startThread(run.client, "codex-seat");
      const turn = await runTurn(run.client, threadId);
      assert.equal(turn.status, "failed");
      assert.deepEqual(turn.error, { code: -32603, message: "codex turn failed" });
      assertChainVerifies(run.home, threadId);
      assertNeverSurfaces(run, "account details");
    },
  );
});

test("servedModel falls back to the requested id when the vendor reports no model", async () => {
  await withCodexEngine(
    { seats: [codexSeat("codex-seat")], binary: FAKE_CODEX_BINARY, mode: "no-model" },
    async (run) => {
      const turn = await runTurn(run.client, await startThread(run.client, "codex-seat"));
      assert.equal(turn.status, "completed");
      const receipt = turn.items.find((item) => item.kind === "servedModel") as
        | Extract<Item, { kind: "servedModel" }>
        | undefined;
      assert.equal(receipt?.servedModel, CODEX_MODEL);
    },
  );
});

test("turn/interrupt interrupts the app-server turn and kills the child; no receipt", async () => {
  await withCodexEngine(
    { seats: [codexSeat("codex-seat")], binary: FAKE_CODEX_BINARY, mode: "hang" },
    async (run) => {
      const threadId = await startThread(run.client, "codex-seat");
      const { turn } = await run.client.request("turn/start", {
        threadId,
        input: [{ type: "text", text: "x" }],
      });
      await run.client.waitForNotification("turn/started");
      // Wait until the vendor turn is actually active (the fixture received turn/start), plus a
      // beat for the adapter to register the turnId, so it has a turn to interrupt.
      for (let i = 0; i < 200 && !run.wire().some((m) => m.method === "turn/start"); i++) {
        await new Promise((r) => setTimeout(r, 5));
      }
      await new Promise((r) => setTimeout(r, 50));
      await run.client.request("turn/interrupt", { threadId, turnId: turn.id });
      const done = await run.client.waitFor(
        (m) => m.method === "turn/completed" && (m.params as { turn: Turn }).turn.id === turn.id,
      );
      const final = (done.params as { turn: Turn }).turn;
      assert.equal(final.status, "interrupted");
      assert.ok(!final.items.some((item) => item.kind === "servedModel"));
      // The adapter sent the app-server's documented interrupt for the active turn. The fixture
      // logs it when it reads its stdin, which can land after the engine's turn/completed —
      // poll for it (the abort grace guarantees it arrives before the child is killed).
      let interrupt: WireMessage | undefined;
      for (let i = 0; i < 400 && interrupt === undefined; i++) {
        interrupt = run.wire().find((m) => m.method === "turn/interrupt");
        if (interrupt === undefined) await new Promise((r) => setTimeout(r, 5));
      }
      assert.deepEqual(interrupt?.params, { threadId: "thr_fakecodex", turnId: "turn_fakecodex" });
      const lines = assertChainVerifies(run.home, threadId);
      assert.ok(!lines.some((l) => l.type === "servedModel"));
      assert.equal(lines.at(-1)?.type, "turn.end");
      assert.equal(lines.at(-1)?.payload.status, "interrupted");
    },
  );
});

test("the kimi and claude-code backings still work on the same engine (A3/A5 unaffected)", async () => {
  await withCodexEngine(
    {
      seats: [
        {
          ...seatFileBody(MADC_DEFAULT_SEAT),
          id: "claude-seat",
          preferredBacking: "claude-code",
          pinnedModel: CLAUDE_MODEL,
        },
      ],
      binary: FAKE_CODEX_BINARY,
      claudeBinary: FAKE_CLAUDE_BINARY,
    },
    async (run) => {
      // claude-code: full turn through its own fake child, receipt intact.
      const claudeThread = await startThread(run.client, "claude-seat");
      const claudeTurn = await runTurn(run.client, claudeThread, "say hi");
      assert.equal(claudeTurn.status, "completed");
      const claudeReceipt = claudeTurn.items.find((item) => item.kind === "servedModel") as
        | Extract<Item, { kind: "servedModel" }>
        | undefined;
      assert.equal(claudeReceipt?.backing, "claude-code");
      assert.equal(claudeReceipt?.servedModel, CLAUDE_MODEL);
      // kimi: no key in the hermetic env → the kimi preflight refusal is untouched.
      const kimiThread = await startThread(run.client, "madc-default");
      const err = await expectRpcError(
        run.client.request("turn/start", {
          threadId: kimiThread,
          input: [{ type: "text", text: "x" }],
        }),
      );
      assert.equal(err.code, -32008);
      assert.deepEqual(err.data, { providerId: "kimi-code", reason: "no-credentials" });
    },
  );
});
