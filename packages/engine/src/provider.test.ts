/**
 * M0-A3 Kimi wiring, end to end through a spawned engine. Network-free: the fixture engine runs the
 * production provider agent with an in-process fake transport and a `.invalid` base URL. Keys are
 * dummy sentinels; the harness strips any real credential from the child env.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readKimiCredential } from "@madc/adapters";
import type { FakeKimiReply, FakeKimiRequest } from "@madc/adapters/testing";
import { ENGINE_ENTRY, type EngineClient } from "./client.ts";
import { RpcError } from "./protocol/errors.ts";
import type { Item, Turn } from "./protocol/types.ts";
import { createProviderAgent } from "./provider-agent.ts";
import { type EngineSeat, MADC_DEFAULT_SEAT } from "./seat.ts";
import {
  expectRpcError,
  handshake,
  KIMI_FAKE_ENGINE,
  makeHome,
  seatFileBody,
  startEngine,
  startEngineCapturingStderr,
  writeSeatFile,
} from "./testing/harness.ts";

const KEY = "test-sentinel-key-4b7e";

type Setup = {
  key?: string;
  reply?: FakeKimiReply;
  /** Seat files written to `$MADC_HOME/seats/<id>.json` before the engine starts. */
  seats?: Record<string, unknown>[];
  toolOutput?: string;
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
  if (setup.toolOutput !== undefined) extra.MADC_TEST_TOOL_OUTPUT = setup.toolOutput;
  for (const seat of setup.seats ?? []) writeSeatFile(home, seat);
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
          // M1 P2 fields: upstream reported a DIFFERENT model → vendorReported true.
          lane: "allowed-direct",
          mode: "headless",
          fallbackFrom: null,
          vendorReported: true,
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
    // Ruling item 10: a refused turn writes nothing — the session holds only session.open.
    const lines = readFileSync(join(run.home, "sessions", `${threadId}.jsonl`), "utf8")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => (JSON.parse(l) as { type: string }).type);
    assert.deepEqual(lines, ["session.open"]);
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

/** A seat file body: `madc-default` fields with overrides (written under `$MADC_HOME/seats`). */
function seatJson(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  // Through the file projection: the in-memory v1 seat carries S2's migrated `fallbacks`, which a
  // v1 FILE must not (M1-A7).
  return { ...seatFileBody(MADC_DEFAULT_SEAT), id, ...overrides };
}

/** In-process preflight of the provider agent for a seat built in code (bypasses seat files). */
function preflightFor(
  seat: EngineSeat,
  key: string | undefined = KEY,
  claudeBinary: string | null = null,
): RpcError | null {
  let created = 0;
  const agent = createProviderAgent({
    credential: readKimiCredential(key === undefined ? {} : { KIMI_API_KEY: key }),
    createPort: () => {
      created++;
      return {
        providerId: "kimi-code",
        streamTurn: () => Promise.reject(new Error("preflight never streams")),
      };
    },
    createClaudePort: () => {
      created++;
      return {
        providerId: "claude-code",
        streamTurn: () => Promise.reject(new Error("preflight never streams")),
      };
    },
    detectClaudeBinary: () => claudeBinary,
  });
  try {
    agent.preflight?.({
      threadId: "thr_unit",
      seatId: seat.id,
      seat,
      seatPath: "/madc-home/seats/unit.json",
      input: [{ type: "text", text: "x" }],
      cwd: null,
    });
    assert.equal(created, 0, "preflight is side-effect free: no port built");
    return null;
  } catch (err) {
    assert.equal(created, 0, "refusal happened before any port was built");
    if (err instanceof RpcError) return err;
    throw err;
  }
}

test("defense in depth: the agent's registry check still refuses seats built in code (-32007 / -32008)", () => {
  const cases: Array<[string, number, Record<string, unknown>]> = [
    // M1-A1 (D-M1-3): allowed-direct no longer implies a headless allow; the policy denial
    // (-32007 headless-not-permitted) fires before the unwired stub state (-32008).
    [
      "ollama-cloud",
      -32007,
      { providerId: "ollama-cloud", status: "allowed-direct", reason: "headless-not-permitted" },
    ],
    [
      "zai-glm-coding-plan",
      -32007,
      { providerId: "zai-glm-coding-plan", status: "forbidden", reason: "forbidden" },
    ],
    [
      "claude-subscription-http",
      -32007,
      { providerId: "claude-subscription-http", status: "forbidden", reason: "forbidden" },
    ],
    [
      "no-such-provider",
      -32007,
      { providerId: "no-such-provider", status: null, reason: "unknown-provider" },
    ],
    [
      "minimax-token-plan",
      -32007,
      {
        providerId: "minimax-token-plan",
        status: "interactive-only",
        reason: "interactive-only-headless",
      },
    ],
    ["codex", -32008, { providerId: "codex", reason: "unwired" }],
    // A5: the adapter is in this build (preflightFor wires it) but no binary is detected.
    ["claude-code", -32008, { providerId: "claude-code", reason: "binary-missing" }],
  ];
  for (const [backing, code, data] of cases) {
    const err = preflightFor({ ...MADC_DEFAULT_SEAT, preferredBacking: backing });
    assert.equal(err?.code, code, backing);
    assert.deepEqual(err?.data, data, backing);
  }
  assert.equal(preflightFor(MADC_DEFAULT_SEAT), null, "the built-in seat passes preflight");
  // The kimi-only build path (adapter absent) → unwired is covered end to end below via
  // KIMI_FAKE_ENGINE; with a detected binary the claude-code seat passes preflight.
  assert.equal(
    preflightFor(
      { ...MADC_DEFAULT_SEAT, preferredBacking: "claude-code", pinnedModel: "claude-sonnet-4-5" },
      KEY,
      "/fake/bin/claude",
    ),
    null,
    "a claude-code seat with a detected binary passes preflight",
  );
  // A blank vendor model name is a seat error, not a provider refusal.
  const blankModel = preflightFor(
    { ...MADC_DEFAULT_SEAT, preferredBacking: "claude-code", pinnedModel: "  " },
    KEY,
    "/fake/bin/claude",
  );
  assert.equal(blankModel?.code, -32006);
  assert.deepEqual(blankModel?.data?.issues, ["pinnedModel must be a non-empty vendor model name"]);
});

test("A4/M1-A3 (S1): seat-file backings validate against the registry — forbidden, unknown and unwired → -32006 at thread/start", async () => {
  // M1 seat pin S1 (realized here in M1-A3): a backing is valid iff its registry entry exists,
  // is wired and is not forbidden. "ollama-cloud" — the M0 counter-example — is a VALID backing
  // since M1-A3 wired it; its headless denial is a turn-preflight matter, asserted below.
  const badSeats: Array<[Record<string, unknown>, string]> = [
    [
      seatJson("zai", { preferredBacking: "zai-glm-coding-plan" }),
      'preferredBacking "zai-glm-coding-plan" is a forbidden lane',
    ],
    [
      seatJson("nope", { preferredBacking: "no-such-provider" }),
      'preferredBacking "no-such-provider" is not a registry provider id',
    ],
    [
      // openrouter is a kept stub no M1 act wires (mistral-pro was this fixture until M1-A4).
      seatJson("unwired-stub", { preferredBacking: "openrouter" }),
      'preferredBacking "openrouter" is not wired in this build',
    ],
  ];
  const seats = [
    ...badSeats.map(([seat]) => seat),
    seatJson("oll", { preferredBacking: "ollama-cloud" }),
  ];
  await withKimiEngine({ key: KEY, seats }, async (run) => {
    for (const [seat, issue] of badSeats) {
      const err = await expectRpcError(
        run.client.request("thread/start", { seatId: seat.id as string }),
      );
      assert.equal(err.code, -32006, String(seat.id));
      assert.equal(err.data?.path, join(run.home, "seats", `${String(seat.id)}.json`));
      assert.deepEqual(err.data?.issues, [issue]);
    }
    assert.equal(run.wire().length, 0);
    assert.deepEqual(readdirSync(join(run.home, "sessions")), [], "no session or lock written");

    // D-M1-3/D-M1-4: the wired headless-denied lane LOADS (the seat is valid; interactive use is
    // allowed by the registry), but every engine turn is headless until A5, so the turn is
    // refused -32007 headless-not-permitted before any provider request.
    const threadId = await startThread(run.client, "oll");
    const turnErr = await expectRpcError(
      run.client.request("turn/start", { threadId, input: [{ type: "text", text: "x" }] }),
    );
    assert.equal(turnErr.code, -32007);
    assert.deepEqual(turnErr.data, {
      providerId: "ollama-cloud",
      status: "allowed-direct",
      reason: "headless-not-permitted",
    });
    assert.equal(run.wire().length, 0, "refused before any provider request");
  });
});

test("registry-allowed seat backing without an adapter in this build (claude-code) → -32008 unwired", async () => {
  await withKimiEngine(
    {
      key: KEY,
      seats: [seatJson("claude", { preferredBacking: "claude-code", pinnedModel: "opus" })],
    },
    async (run) => {
      const threadId = await startThread(run.client, "claude");
      const err = await expectRpcError(
        run.client.request("turn/start", { threadId, input: [{ type: "text", text: "x" }] }),
      );
      assert.equal(err.code, -32008);
      assert.deepEqual(err.data, { providerId: "claude-code", reason: "unwired" });
      assert.equal(run.wire().length, 0);
    },
  );
});

test("honesty: pinnedModel mismatch → -32006 at thread/start with the seat file path; no thread, no request", async () => {
  for (const pinnedModel of ["anthropic/claude-sonnet-4-5", "kimi-coding/not-a-model"]) {
    await withKimiEngine(
      { key: KEY, seats: [seatJson("pinned", { pinnedModel })] },
      async (run) => {
        const err = await expectRpcError(run.client.request("thread/start", { seatId: "pinned" }));
        assert.equal(err.code, -32006, pinnedModel);
        assert.equal(err.data?.seatId, "pinned");
        assert.equal(err.data?.path, join(run.home, "seats", "pinned.json"));
        assert.ok(Array.isArray(err.data?.issues) && err.data.issues.length === 1);
        assert.notEqual(err.data?.path, "(built-in)");
        assert.ok(!run.client.notifications.some((n) => n.method === "thread/started"));
        assert.deepEqual(readdirSync(join(run.home, "sessions")), []);
        assert.equal(run.wire().length, 0);
      },
    );
  }
});

test("defense in depth: turn/start preflight re-checks pinnedModel with the same code and real path", () => {
  const err = preflightFor({ ...MADC_DEFAULT_SEAT, pinnedModel: "kimi-coding/not-a-model" });
  assert.equal(err?.code, -32006);
  assert.equal(err?.data?.path, "/madc-home/seats/unit.json");
});

test("A4: a seat id with no seat file → -32005 SeatNotFound at thread/start (no thread, no lock)", async () => {
  await withKimiEngine({ key: KEY }, async (run) => {
    const err = await expectRpcError(run.client.request("thread/start", { seatId: "reviewer" }));
    assert.equal(err.code, -32005);
    assert.deepEqual(err.data, {
      seatId: "reviewer",
      path: join(run.home, "seats", "reviewer.json"),
    });
    assert.deepEqual(readdirSync(join(run.home, "sessions")), []);
    assert.ok(!run.client.notifications.some((n) => n.method === "thread/started"));
    assert.equal(run.wire().length, 0);
  });
});

test("A4: a named seat file drives the turn (its standingInstructions reach the provider)", async () => {
  const seat = seatJson("prometheus", {
    role: "reviewer",
    standingInstructions: "You are prometheus, a careful reviewer.",
    memory: { mode: "in-session" },
  });
  await withKimiEngine({ key: KEY, seats: [seat] }, async (run) => {
    const threadId = await startThread(run.client, "prometheus");
    const turn = await runTurn(run.client, threadId);
    assert.equal(turn.status, "completed");
    const body = JSON.parse(run.wire()[0]?.body ?? "{}") as { system: unknown };
    assert.match(JSON.stringify(body.system), /You are prometheus, a careful reviewer\./);
    assert.doesNotMatch(JSON.stringify(body.system), /madc-default/);
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
      // Ruling item 6: no durable receipt either; the turn is closed as interrupted on disk.
      const types = readFileSync(join(run.home, "sessions", `${threadId}.jsonl`), "utf8")
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => JSON.parse(l) as { type: string; payload: { status?: string } });
      assert.ok(!types.some((l) => l.type === "servedModel"));
      assert.equal(types.at(-1)?.type, "turn.end");
      assert.equal(types.at(-1)?.payload.status, "interrupted");
    },
  );
});

test("production engine entry defaults to the Kimi agent: no key → -32008 no-credentials", async () => {
  const { home, cleanup } = makeHome();
  // M1-A2: the production entry resolves the key through the credential store. The win32 seam
  // selects the no-backend path so this test never probes a live keychain (and hermeticEnv has
  // already stripped every ambient credential plus MADC_DEV_ENV_KEYS): no key → -32008.
  const client = startEngine(home, ENGINE_ENTRY, { MADC_TEST_KEYCHAIN_PLATFORM: "win32" });
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

/** Static `from`, side-effect `import "…"`, dynamic `import(…)`, and `require(…)` of any pi-ai entry. */
const PI_AI_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']@earendil-works\/pi-ai/;

/**
 * The only files allowed to import pi-ai (plan §6, generalized by M1-A3): the direct-key lane
 * modules inside packages/adapters. The package-level rule is unchanged — core/engine/registry/cli
 * never import pi-ai — and fakes never do either. M1-A4 adds its four lane modules.
 *
 * M1-A4 also allowlists ONE test file, a documented narrowing of the M1-A3 "tests never do either"
 * convention: the act's acceptance adds an L1 tool round-trip, M1 commissions no direct-lane tool
 * loop, and the Founder ruled (2026-09-30) that the round-trip is proved against the lane's own
 * pi-ai configuration instead of by widening the shared `ProviderPort` seam. Driving pi-ai's catalog
 * is unavoidable for that, and the file is inside `packages/adapters`, so plan §5's package rule
 * still holds. See that file's module docs.
 *
 * M1-A9 allowlists the second (and last) one under the same ruling: L1 for the four wired direct
 * lanes M1-A4 did not cover (kimi-code, ollama-cloud, minimax-token-plan, alibaba-coding-plan).
 */
const PI_AI_IMPORTERS: readonly string[] = [
  "adapters/src/kimi-code.ts",
  "adapters/src/direct/generic.ts",
  "adapters/src/providers/ollama-cloud.ts",
  "adapters/src/providers/mistral.ts",
  "adapters/src/providers/deepseek.ts",
  "adapters/src/providers/gemini.ts",
  "adapters/src/providers/xai.ts",
  "adapters/src/providers/minimax.ts",
  "adapters/src/providers/alibaba-coding.ts",
  "adapters/src/providers/direct-key-conformance.test.ts",
  "adapters/src/providers/direct-lane-l1.test.ts",
];

test("plan §6: only packages/adapters imports @earendil-works/pi-ai, and only its direct-key lane modules", () => {
  const packagesDir = new URL("../../", import.meta.url);
  const packagesPath = fileURLToPath(packagesDir);
  const offenders: string[] = [];
  let scanned = 0;
  for (const pkg of readdirSync(packagesDir)) {
    const src = new URL(`${pkg}/src/`, packagesDir);
    if (!existsSync(src)) continue;
    // Test sources count too: nothing but the lane modules may import pi-ai directly.
    for (const file of readdirSync(src, { recursive: true, withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith(".ts")) continue;
      const path = join(file.parentPath, file.name);
      scanned++;
      if (!PI_AI_IMPORT.test(readFileSync(path, "utf8"))) continue;
      // Platform-independent: compare POSIX-style paths relative to packages/ (Windows uses `\`).
      const rel = relative(packagesPath, path).split(sep).join("/");
      if (!PI_AI_IMPORTERS.includes(rel)) offenders.push(rel);
    }
  }
  assert.ok(scanned > 20, `importer scan saw only ${scanned} files`);
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
