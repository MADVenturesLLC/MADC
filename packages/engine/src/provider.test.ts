/**
 * M0-A3 Kimi wiring, end to end through a spawned engine. Network-free: the fixture engine runs the
 * production provider agent with an in-process fake transport and a `.invalid` base URL. Keys are
 * dummy sentinels; the harness strips any real credential from the child env.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { FakeKimiReply, FakeKimiRequest } from "@madc/adapters/testing";
import { ENGINE_ENTRY, type EngineClient } from "./client.ts";
import type { Item, Turn } from "./protocol/types.ts";
import {
  expectRpcError,
  handshake,
  KIMI_FAKE_ENGINE,
  makeHome,
  startEngine,
  startEngineCapturingStderr,
} from "./testing/harness.ts";

const KEY = "test-sentinel-key-4b7e";

type Setup = {
  key?: string;
  reply?: FakeKimiReply;
  seat?: Record<string, unknown>;
  entry?: string;
};

type Run = {
  client: EngineClient;
  home: string;
  stderr: () => string;
  wire: () => FakeKimiRequest[];
};

async function withKimiEngine(setup: Setup, fn: (run: Run) => Promise<void>): Promise<void> {
  const { home, cleanup } = makeHome();
  const wireLog = join(home, "..", "wire.jsonl");
  const extra: Record<string, string | undefined> = { MADC_TEST_WIRE_LOG: wireLog };
  if (setup.key !== undefined) extra.KIMI_API_KEY = setup.key;
  if (setup.reply !== undefined) extra.MADC_TEST_KIMI_REPLY = JSON.stringify(setup.reply);
  if (setup.seat !== undefined) extra.MADC_TEST_SEAT_JSON = JSON.stringify(setup.seat);
  const { client, stderr } = startEngineCapturingStderr(
    home,
    setup.entry ?? KIMI_FAKE_ENGINE,
    extra,
  );
  const wire = () =>
    existsSync(wireLog)
      ? readFileSync(wireLog, "utf8")
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => JSON.parse(line) as FakeKimiRequest)
      : [];
  try {
    await handshake(client);
    await fn({ client, home, stderr, wire });
  } finally {
    await client.close();
    cleanup();
  }
}

async function startThread(client: EngineClient, seatId?: string): Promise<string> {
  const { thread } = await client.request("thread/start", seatId === undefined ? {} : { seatId });
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

/** stdout and stderr are separate pipes: poll stderr instead of assuming ordering. */
async function until(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function assertNoSecret(run: Run, secret: string): void {
  assert.ok(!JSON.stringify(run.client.messages).includes(secret), "secret on protocol wire");
  assert.ok(!run.stderr().includes(secret), "secret on stderr");
  for (const file of readdirSync(run.home, { recursive: true, withFileTypes: true })) {
    if (!file.isFile()) continue;
    const content = readFileSync(join(file.parentPath, file.name), "utf8");
    assert.ok(!content.includes(secret), `secret written to ${file.name}`);
  }
}

test("A3 happy path: userMessage → agentMessage (streamed) → servedModel → turn/completed", async () => {
  await withKimiEngine(
    {
      key: KEY,
      reply: { type: "stream", chunks: ["Hi", " from", " Kimi"], model: "kimi-for-coding-2026-09" },
    },
    async (run) => {
      const threadId = await startThread(run.client);
      const turn = await runTurn(run.client, threadId, "say hi");
      assert.equal(turn.status, "completed");
      assert.equal(turn.error, null);
      assert.deepEqual(
        turn.items.map((item) => item.kind),
        ["userMessage", "agentMessage", "servedModel"],
      );
      const agent = turn.items[1] as Extract<Item, { kind: "agentMessage" }>;
      assert.equal(agent.text, "Hi from Kimi");
      const deltas = run.client.notifications
        .filter((n) => n.method === "item/agentMessage/delta")
        .map((n) => (n.params as { delta: string }).delta);
      assert.deepEqual(deltas, ["Hi", " from", " Kimi"]);
      const receipt = turn.items[2] as Extract<Item, { kind: "servedModel" }>;
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
        },
      );
      const wire = run.wire();
      assert.equal(wire.length, 1);
      const body = JSON.parse(wire[0]?.body ?? "{}") as { model: string; system: unknown };
      assert.equal(body.model, "kimi-for-coding");
      assert.match(JSON.stringify(body.system), /You are madc-default/);
      assert.deepEqual(run.client.protocolViolations, []);
    },
  );
});

test("servedModel falls back to the requested catalog id when upstream reports the same model", async () => {
  await withKimiEngine(
    { key: KEY, reply: { type: "stream", chunks: ["ok"], model: "kimi-for-coding" } },
    async (run) => {
      const turn = await runTurn(run.client, await startThread(run.client));
      const receipt = turn.items.find((item) => item.kind === "servedModel");
      assert.equal(
        (receipt as { servedModel: string } | undefined)?.servedModel,
        "kimi-for-coding",
      );
    },
  );
});

test("honesty: no credentials → -32008 no-credentials at turn/start, before any provider request", async () => {
  await withKimiEngine({}, async (run) => {
    const threadId = await startThread(run.client);
    const err = await expectRpcError(
      run.client.request("turn/start", { threadId, input: [{ type: "text", text: "x" }] }),
    );
    assert.equal(err.code, -32008);
    assert.deepEqual(err.data, { providerId: "kimi-code", reason: "no-credentials" });
    assert.equal(run.wire().length, 0);
    assert.ok(!run.client.notifications.some((n) => n.method === "turn/started"));
  });
});

test("honesty: a Claude OAuth token in KIMI_API_KEY is refused (-32008), never sent", async () => {
  const token = "sk-ant-oat01-sentinel-7d1a";
  await withKimiEngine({ key: token }, async (run) => {
    const threadId = await startThread(run.client);
    const err = await expectRpcError(
      run.client.request("turn/start", { threadId, input: [{ type: "text", text: "x" }] }),
    );
    assert.equal(err.code, -32008);
    assert.deepEqual(err.data, { providerId: "kimi-code", reason: "no-credentials" });
    assert.equal(run.wire().length, 0);
    assertNoSecret(run, token);
  });
});

test("honesty: unwired backing (ollama-cloud stub, D2) → -32008 unwired, no request", async () => {
  await withKimiEngine({ key: KEY, seat: { preferredBacking: "ollama-cloud" } }, async (run) => {
    const threadId = await startThread(run.client);
    const err = await expectRpcError(
      run.client.request("turn/start", { threadId, input: [{ type: "text", text: "x" }] }),
    );
    assert.equal(err.code, -32008);
    assert.deepEqual(err.data, { providerId: "ollama-cloud", reason: "unwired" });
    assert.equal(run.wire().length, 0);
  });
});

test("honesty: registry refusals → -32007 (forbidden, unknown-provider), no request", async () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    [
      "zai-glm-coding-plan",
      { providerId: "zai-glm-coding-plan", status: "forbidden", reason: "forbidden" },
    ],
    [
      "claude-subscription-http",
      { providerId: "claude-subscription-http", status: "forbidden", reason: "forbidden" },
    ],
    [
      "no-such-provider",
      { providerId: "no-such-provider", status: null, reason: "unknown-provider" },
    ],
    [
      "minimax-token-plan",
      {
        providerId: "minimax-token-plan",
        status: "interactive-only",
        reason: "interactive-only-headless",
      },
    ],
  ];
  for (const [backing, data] of cases) {
    await withKimiEngine({ key: KEY, seat: { preferredBacking: backing } }, async (run) => {
      const threadId = await startThread(run.client);
      const err = await expectRpcError(
        run.client.request("turn/start", { threadId, input: [{ type: "text", text: "x" }] }),
      );
      assert.equal(err.code, -32007, backing);
      assert.deepEqual(err.data, data);
      assert.equal(run.wire().length, 0);
    });
  }
});

test("registry-allowed backing without an adapter in this build (claude-code) → -32008 unwired", async () => {
  await withKimiEngine({ key: KEY, seat: { preferredBacking: "claude-code" } }, async (run) => {
    const threadId = await startThread(run.client);
    const err = await expectRpcError(
      run.client.request("turn/start", { threadId, input: [{ type: "text", text: "x" }] }),
    );
    assert.equal(err.code, -32008);
    assert.deepEqual(err.data, { providerId: "claude-code", reason: "unwired" });
    assert.equal(run.wire().length, 0);
  });
});

test("honesty: pinnedModel mismatch → -32006 SeatInvalid, no request", async () => {
  for (const pinnedModel of ["anthropic/claude-sonnet-4-5", "kimi-coding/not-a-model"]) {
    await withKimiEngine({ key: KEY, seat: { pinnedModel } }, async (run) => {
      const threadId = await startThread(run.client);
      const err = await expectRpcError(
        run.client.request("turn/start", { threadId, input: [{ type: "text", text: "x" }] }),
      );
      assert.equal(err.code, -32006, pinnedModel);
      assert.equal(err.data?.seatId, "madc-default");
      assert.equal(err.data?.path, "(built-in)");
      assert.ok(Array.isArray(err.data?.issues) && err.data.issues.length === 1);
      assert.equal(run.wire().length, 0);
    });
  }
});

test("a thread on a seat other than the built-in one → -32005 SeatNotFound at turn/start", async () => {
  await withKimiEngine({ key: KEY }, async (run) => {
    const threadId = await startThread(run.client, "reviewer");
    const err = await expectRpcError(
      run.client.request("turn/start", { threadId, input: [{ type: "text", text: "x" }] }),
    );
    assert.equal(err.code, -32005);
    assert.deepEqual(err.data, {
      seatId: "reviewer",
      path: join(run.home, "seats", "reviewer.json"),
    });
    assert.equal(run.wire().length, 0);
  });
});

test("honesty: the key never reaches the protocol wire, stderr, or MADC_HOME (success path)", async () => {
  await withKimiEngine({ key: KEY }, async (run) => {
    const turn = await runTurn(run.client, await startThread(run.client));
    assert.equal(turn.status, "completed");
    const [request] = run.wire();
    assert.ok(request !== undefined);
    assert.equal(request.headers["x-api-key"], KEY);
    assert.match(request.headers["user-agent"] ?? "", /^madc\/0\.0\.0 \(pi-ai\/0\.87\.1; /);
    assert.equal(request.headers["x-app"], undefined);
    assertNoSecret(run, KEY);
  });
});

test("honesty: provider auth failure echoing the key → turn failed -32603, key nowhere in wire/stderr", async () => {
  await withKimiEngine(
    {
      key: KEY,
      reply: {
        type: "status",
        status: 401,
        body: JSON.stringify({
          type: "error",
          error: { type: "authentication_error", message: `bad ${KEY}` },
        }),
      },
    },
    async (run) => {
      const turn = await runTurn(run.client, await startThread(run.client));
      assert.equal(turn.status, "failed");
      assert.deepEqual(turn.error, {
        code: -32603,
        message: "kimi-code request failed (HTTP 401)",
      });
      assert.deepEqual(
        turn.items.map((item) => [item.kind, item.status]),
        [
          ["userMessage", "completed"],
          ["agentMessage", "failed"],
          ["error", "completed"],
        ],
      );
      assert.ok(!turn.items.some((item) => item.kind === "servedModel"));
      await until(() => run.stderr().includes("HTTP 401"));
      assert.match(run.stderr(), /provider kimi-code: kimi-code request failed \(HTTP 401\)/);
      assertNoSecret(run, KEY);
    },
  );
});

test("turn/interrupt mid-stream → interrupted, no servedModel receipt", async () => {
  await withKimiEngine(
    { key: KEY, reply: { type: "hang", model: "kimi-for-coding" } },
    async (run) => {
      const threadId = await startThread(run.client);
      const { turn } = await run.client.request("turn/start", {
        threadId,
        input: [{ type: "text", text: "x" }],
      });
      await run.client.waitForNotification("item/agentMessage/delta");
      await run.client.request("turn/interrupt", { threadId, turnId: turn.id });
      const done = await run.client.waitFor(
        (m) => m.method === "turn/completed" && (m.params as { turn: Turn }).turn.id === turn.id,
      );
      const final = (done.params as { turn: Turn }).turn;
      assert.equal(final.status, "interrupted");
      assert.ok(!final.items.some((item) => item.kind === "servedModel"));
    },
  );
});

test("production engine entry defaults to the Kimi agent: no key → -32008 no-credentials", async () => {
  const { home, cleanup } = makeHome();
  const client = startEngine(home, ENGINE_ENTRY);
  try {
    await handshake(client);
    const { thread } = await client.request("thread/start", {});
    const err = await expectRpcError(
      client.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "x" }] }),
    );
    assert.equal(err.code, -32008);
    assert.deepEqual(err.data, { providerId: "kimi-code", reason: "no-credentials" });
  } finally {
    await client.close();
    cleanup();
  }
});

test("plan §6: only packages/adapters imports @earendil-works/pi-ai, and only kimi-code.ts there", () => {
  const packagesDir = new URL("../../", import.meta.url);
  const offenders: string[] = [];
  for (const pkg of readdirSync(packagesDir)) {
    const src = new URL(`${pkg}/src/`, packagesDir);
    if (!existsSync(src)) continue;
    for (const file of readdirSync(src, { recursive: true, withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith(".ts") || file.name.endsWith(".test.ts")) continue;
      const path = join(file.parentPath, file.name);
      if (!/from\s+["']@earendil-works\/pi-ai/.test(readFileSync(path, "utf8"))) continue;
      const rel = path.slice(path.indexOf("packages/"));
      if (rel !== "packages/adapters/src/kimi-code.ts") offenders.push(rel);
    }
  }
  assert.deepEqual(offenders, []);
  for (const pkg of ["core", "engine", "registry", "cli"]) {
    const manifest = readFileSync(new URL(`${pkg}/package.json`, packagesDir), "utf8");
    assert.ok(!manifest.includes("@earendil-works/"), `${pkg} depends on pi packages`);
  }
});

test("honesty: an ambient KIMI_API_KEY in the test runner never reaches a test engine", async () => {
  const previous = process.env.KIMI_API_KEY;
  process.env.KIMI_API_KEY = "ambient-runner-sentinel-2c9d";
  try {
    await withKimiEngine({}, async (run) => {
      const threadId = await startThread(run.client);
      const err = await expectRpcError(
        run.client.request("turn/start", { threadId, input: [{ type: "text", text: "x" }] }),
      );
      assert.equal(err.code, -32008);
      assert.deepEqual(err.data, { providerId: "kimi-code", reason: "no-credentials" });
      assert.equal(run.wire().length, 0);
    });
  } finally {
    if (previous === undefined) delete process.env.KIMI_API_KEY;
    else process.env.KIMI_API_KEY = previous;
  }
});
