/**
 * M0-A5 Claude Code wiring, end to end through a spawned engine. The fixture engine
 * (`claude-fake-engine.ts`) runs the production provider agent with the claude-code adapter over
 * the `fake-claude.ts` fixture child — no real `claude` binary, no credentials, no network.
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
  CLAUDE_FAKE_ENGINE,
  expectRpcError,
  handshake,
  makeHome,
  startEngineCapturingStderr,
  writeSeatFile,
} from "./testing/harness.ts";

const CLAUDE_MODEL = "claude-sonnet-4-5";
/** What the fixture's `detectClaudeBinary` reports when the binary is "present". */
const FAKE_BINARY = "/fake/bin/claude";

type Setup = {
  /** Seat files written to `$MADC_HOME/seats/<id>.json` before the engine starts. */
  seats?: Record<string, unknown>[];
  /** Fixture `detectClaudeBinary` answer; absent → the binary is missing. */
  binary?: string;
  /** Fixture-child behavior (see fake-claude.ts). */
  mode?: string;
  /** Simulate the binary vanishing between preflight and spawn. */
  spawnError?: boolean;
};

/** One recorded fixture-child invocation (what the adapter would have passed to `claude`). */
type ClaudeArgv = { prompt: string; model: string; systemPrompt: string | null };

type Run = {
  client: EngineClient;
  home: string;
  stderr: () => string;
  argv: () => ClaudeArgv[];
};

async function withClaudeEngine(setup: Setup, fn: (run: Run) => Promise<void>): Promise<void> {
  const { home, cleanup } = makeHome();
  const argvLog = join(home, "..", "claude-argv.jsonl");
  const extra: Record<string, string | undefined> = { MADC_TEST_CLAUDE_ARGV_LOG: argvLog };
  if (setup.binary !== undefined) extra.MADC_TEST_CLAUDE_BINARY = setup.binary;
  if (setup.mode !== undefined) extra.MADC_TEST_CLAUDE_MODE = setup.mode;
  if (setup.spawnError === true) extra.MADC_TEST_CLAUDE_SPAWN_ERROR = "1";
  for (const seat of setup.seats ?? []) writeSeatFile(home, seat);
  const { client, stderr } = startEngineCapturingStderr(home, CLAUDE_FAKE_ENGINE, extra);
  const argv = () =>
    existsSync(argvLog)
      ? readFileSync(argvLog, "utf8")
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => JSON.parse(line) as ClaudeArgv)
      : [];
  try {
    await handshake(client);
    await fn({ client, home, stderr, argv });
  } finally {
    await client.close();
    cleanup();
  }
}

/** A claude-code backed seat file body (madc-default fields with the backing swapped). */
function claudeSeat(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...MADC_DEFAULT_SEAT,
    id,
    preferredBacking: "claude-code",
    pinnedModel: CLAUDE_MODEL,
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

/** Vendor stderr text is hostile detail: it must never reach the wire, logs, or MADC_HOME. */
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

test("A5 happy path: a claude-code seat runs a turn; receipt on the wire and in session JSONL", async () => {
  await withClaudeEngine({ seats: [claudeSeat("sonnet")], binary: FAKE_BINARY }, async (run) => {
    const threadId = await startThread(run.client, "sonnet");
    const turn = await runTurn(run.client, threadId, "say hi");
    assert.equal(turn.status, "completed");
    assert.equal(turn.error, null);
    assert.deepEqual(
      turn.items.map((item) => item.kind),
      ["userMessage", "agentMessage", "servedModel"],
    );
    const agent = turn.items[1] as Extract<Item, { kind: "agentMessage" }>;
    assert.equal(agent.text, "fake claude answer to: say hi");
    const receipt = turn.items[2] as Extract<Item, { kind: "servedModel" }>;
    assert.deepEqual(
      { ...receipt, id: "" },
      {
        id: "",
        kind: "servedModel",
        status: "completed",
        requestedModel: CLAUDE_MODEL,
        servedModel: CLAUDE_MODEL,
        backing: "claude-code",
        providerId: "claude-code",
        // M1 P2 fields: the vendor fake echoes the requested model, so nothing was
        // vendor-reported; the lane is the vendor-agent one; mode is headless until A5.
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
      requestedModel: CLAUDE_MODEL,
      servedModel: CLAUDE_MODEL,
      backing: "claude-code",
      providerId: "claude-code",
      lane: "allowed-via-vendor-agent",
      mode: "headless",
      fallbackFrom: null,
      vendorReported: false,
    });
    assert.equal(lines.at(-1)?.type, "turn.end");
    assert.deepEqual(lines.at(-1)?.payload, { turnId: turn.id, status: "completed", error: null });
    assert.deepEqual(run.client.protocolViolations, []);
  });
});

test("A5: the seat's pinnedModel and standingInstructions reach the vendor child verbatim", async () => {
  await withClaudeEngine(
    { seats: [claudeSeat("opus", { pinnedModel: "opus" })], binary: FAKE_BINARY },
    async (run) => {
      const threadId = await startThread(run.client, "opus");
      const turn = await runTurn(run.client, threadId, "review this");
      assert.equal(turn.status, "completed");
      const receipt = turn.items.find((item) => item.kind === "servedModel") as
        | Extract<Item, { kind: "servedModel" }>
        | undefined;
      assert.equal(receipt?.requestedModel, "opus");
      assert.equal(receipt?.servedModel, "opus", "fixture echoes the --model it received");
      const [seen] = run.argv();
      assert.ok(seen !== undefined);
      assert.equal(seen.prompt, "review this");
      assert.equal(seen.model, "opus");
      assert.match(seen.systemPrompt ?? "", /You are madc-default/);
    },
  );
});

test("binary missing → -32008 binary-missing at turn/start, before any child or turn", async () => {
  await withClaudeEngine({ seats: [claudeSeat("sonnet")] }, async (run) => {
    const threadId = await startThread(run.client, "sonnet");
    const err = await expectRpcError(
      run.client.request("turn/start", { threadId, input: [{ type: "text", text: "x" }] }),
    );
    assert.equal(err.code, -32008);
    assert.deepEqual(err.data, { providerId: "claude-code", reason: "binary-missing" });
    assert.ok(!run.client.notifications.some((n) => n.method === "turn/started"));
    assert.equal(run.argv().length, 0, "no child was spawned");
    // A refused turn writes nothing — the session holds only session.open.
    assert.deepEqual(
      sessionLines(run.home, threadId).map((l) => l.type),
      ["session.open"],
    );
  });
});

test("binary vanishes between preflight and spawn → turn failed -32008 (protocol pin §4.2)", async () => {
  await withClaudeEngine(
    { seats: [claudeSeat("sonnet")], binary: FAKE_BINARY, spawnError: true },
    async (run) => {
      const threadId = await startThread(run.client, "sonnet");
      const turn = await runTurn(run.client, threadId);
      assert.equal(turn.status, "failed");
      assert.deepEqual(turn.error, {
        code: -32008,
        message: "Provider unavailable",
        data: { providerId: "claude-code", reason: "binary-missing" },
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
  await withClaudeEngine(
    { seats: [claudeSeat("sonnet")], binary: FAKE_BINARY, mode: "nonzero" },
    async (run) => {
      const threadId = await startThread(run.client, "sonnet");
      const turn = await runTurn(run.client, threadId);
      assert.equal(turn.status, "failed");
      assert.deepEqual(turn.error, {
        code: -32603,
        message: "claude-code child exited 1",
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

test("servedModel falls back to the requested id when the vendor reports no model", async () => {
  await withClaudeEngine(
    { seats: [claudeSeat("sonnet")], binary: FAKE_BINARY, mode: "no-model" },
    async (run) => {
      const turn = await runTurn(run.client, await startThread(run.client, "sonnet"));
      assert.equal(turn.status, "completed");
      const receipt = turn.items.find((item) => item.kind === "servedModel") as
        | Extract<Item, { kind: "servedModel" }>
        | undefined;
      assert.equal(receipt?.servedModel, CLAUDE_MODEL);
    },
  );
});

test("turn/interrupt kills the vendor child → interrupted, no receipt on wire or disk", async () => {
  await withClaudeEngine(
    { seats: [claudeSeat("sonnet")], binary: FAKE_BINARY, mode: "hang" },
    async (run) => {
      const threadId = await startThread(run.client, "sonnet");
      const { turn } = await run.client.request("turn/start", {
        threadId,
        input: [{ type: "text", text: "x" }],
      });
      await run.client.waitForNotification("turn/started");
      await run.client.request("turn/interrupt", { threadId, turnId: turn.id });
      const done = await run.client.waitFor(
        (m) => m.method === "turn/completed" && (m.params as { turn: Turn }).turn.id === turn.id,
      );
      const final = (done.params as { turn: Turn }).turn;
      assert.equal(final.status, "interrupted");
      assert.ok(!final.items.some((item) => item.kind === "servedModel"));
      const lines = assertChainVerifies(run.home, threadId);
      assert.ok(!lines.some((l) => l.type === "servedModel"));
      assert.equal(lines.at(-1)?.type, "turn.end");
      assert.equal(lines.at(-1)?.payload.status, "interrupted");
    },
  );
});

test("the kimi backing still works on the same engine (one agent, both M0 backings)", async () => {
  await withClaudeEngine({ binary: FAKE_BINARY }, async (run) => {
    const threadId = await startThread(run.client, "madc-default");
    const err = await expectRpcError(
      run.client.request("turn/start", { threadId, input: [{ type: "text", text: "x" }] }),
    );
    // No key in the hermetic env → the kimi preflight refusal is untouched by the A5 wiring.
    assert.equal(err.code, -32008);
    assert.deepEqual(err.data, { providerId: "kimi-code", reason: "no-credentials" });
  });
});
