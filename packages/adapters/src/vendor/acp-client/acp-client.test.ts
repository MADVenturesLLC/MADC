/**
 * Generic ACP client tests (Act M1-A6). No real vendor agent, no credentials, no network: every
 * child is the `fake-acp-agent.ts` fixture run as a real process of the test runtime (Node or
 * Bun), driven through a neutral test spec so the client is proven generic (Grok Build's own spec
 * is covered in `../grok-build.test.ts`).
 */
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ProviderCallError,
  type ProviderToolEvent,
  type ProviderTurnRequest,
} from "../../provider-port.ts";
import { createFakeAcpSpawn, FAKE_GROK_BINARY } from "../../testing/index.ts";
import {
  type AcpAgentSpec,
  type AcpSpawn,
  createAcpPort,
  createToolTracker,
  findAgentBinary,
  parseSessionUpdate,
  permissionOutcome,
  reportedModelOf,
  toolOutputText,
} from "./index.ts";

const MODEL = "acp-test-model";
const INSTRUCTIONS = "You are a test seat.";
const HOSTILE = "account details";

const TEST_SPEC: AcpAgentSpec = Object.freeze({
  providerId: "acp-test",
  args: (modelId: string) => [`--model=${modelId}`],
  trailingQuietMs: 0,
  trailingMaxMs: 0,
});

const AUTH_SPEC: AcpAgentSpec = Object.freeze({
  ...TEST_SPEC,
  selectAuth: (methods: readonly { id: string }[]) =>
    methods.some((m) => m.id === "cached_token")
      ? { methodId: "cached_token", meta: { headless: true } }
      : null,
});

type WireMessage = {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: Record<string, unknown>;
};

type Recorded = {
  deltas: string[];
  tools: ProviderToolEvent[];
  request: ProviderTurnRequest;
  controller: AbortController;
};

function turnRequest(overrides: Partial<ProviderTurnRequest> = {}): Recorded {
  const controller = new AbortController();
  const deltas: string[] = [];
  const tools: ProviderToolEvent[] = [];
  const request: ProviderTurnRequest = {
    modelId: MODEL,
    systemPrompt: INSTRUCTIONS,
    messages: [{ role: "user", text: "say hi" }],
    signal: controller.signal,
    onTextDelta: (delta) => deltas.push(delta),
    onToolEvent: (event) => tools.push(event),
    ...overrides,
  };
  return { deltas, tools, request, controller };
}

async function withFake(
  mode: string,
  fn: (ctx: {
    spawn: AcpSpawn;
    wire: () => WireMessage[];
    argv: () => { argv: string[]; cwd: string; xaiApiKeyPresent: boolean } | null;
  }) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "madc-m1a6-"));
  const wireLog = join(dir, "wire.jsonl");
  const argvLog = join(dir, "argv.jsonl");
  try {
    await fn({
      spawn: createFakeAcpSpawn({
        MADC_TEST_ACP_MODE: mode,
        MADC_TEST_ACP_WIRE_LOG: wireLog,
        MADC_TEST_ACP_ARGV_LOG: argvLog,
      }),
      wire: () =>
        existsSync(wireLog)
          ? readFileSync(wireLog, "utf8")
              .split("\n")
              .filter((line) => line !== "")
              .map((line) => JSON.parse(line) as WireMessage)
          : [],
      argv: () =>
        existsSync(argvLog)
          ? (JSON.parse(readFileSync(argvLog, "utf8").split("\n")[0] ?? "null") as {
              argv: string[];
              cwd: string;
              xaiApiKeyPresent: boolean;
            })
          : null,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function expectCallError(promise: Promise<unknown>): Promise<ProviderCallError> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof ProviderCallError, `expected ProviderCallError, got ${String(err)}`);
    assert.ok(!err.message.includes(HOSTILE), "vendor text never surfaces in the error");
    return err;
  }
  assert.fail("expected the turn to fail");
}

async function waitFor(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}

// --- pure mappers -------------------------------------------------------------------------------

test("parseSessionUpdate: text chunks, tool updates and model reports map; the rest is dropped", () => {
  const at = (update: Record<string, unknown>, sessionId = "s1") => ({ sessionId, update });
  assert.deepEqual(
    parseSessionUpdate(
      at({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } }),
      "s1",
    ),
    { kind: "text", text: "hi" },
  );
  const tool = { sessionUpdate: "tool_call", toolCallId: "c1", title: "Read" };
  assert.deepEqual(parseSessionUpdate(at(tool), "s1"), { kind: "tool", update: tool });
  assert.deepEqual(
    parseSessionUpdate(
      at({
        sessionUpdate: "config_option_update",
        configOptions: [{ id: "m", category: "model", type: "select", currentValue: "g-1" }],
      }),
      "s1",
    ),
    { kind: "model", modelId: "g-1" },
  );
  for (const dropped of [
    at({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } }, "other"),
    at({ sessionUpdate: "agent_message_chunk", content: { type: "image", data: "…" } }),
    at({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" } }),
    at({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } }),
    at({ sessionUpdate: "plan", entries: [] }),
    at({ sessionUpdate: "usage_update", used: 1 }),
    at({ sessionUpdate: "tool_call", title: "no id" }),
    at({ sessionUpdate: "config_option_update", configOptions: [] }),
    { sessionId: "s1" },
    null,
  ]) {
    assert.deepEqual(parseSessionUpdate(dropped, "s1"), { kind: "ignored" });
  }
});

test("reportedModelOf reads only explicit model reports — never guesses", () => {
  assert.equal(
    reportedModelOf({
      configOptions: [
        { id: "mode", category: "mode", type: "select", currentValue: "plan" },
        { id: "model", category: "model", type: "select", currentValue: "grok-4.7" },
      ],
    }),
    "grok-4.7",
  );
  assert.equal(reportedModelOf({ models: { currentModelId: "legacy-1" } }), "legacy-1");
  for (const none of [
    {},
    { configOptions: [{ category: "model", type: "boolean", currentValue: true }] },
    { configOptions: [{ category: "model", type: "select", currentValue: "" }] },
    { configOptions: [{ category: "thought_level", type: "select", currentValue: "high" }] },
    { models: { availableModels: [{ modelId: "a" }] } },
    { model: "not-a-report-shape" },
    null,
  ]) {
    assert.equal(reportedModelOf(none), null);
  }
});

test("permissionOutcome refuses: reject_once when offered, else cancelled; never an allow option", () => {
  const options = [
    { optionId: "a1", kind: "allow_once" },
    { optionId: "a2", kind: "allow_always" },
    { optionId: "r2", kind: "reject_always" },
    { optionId: "r1", kind: "reject_once" },
  ];
  assert.deepEqual(permissionOutcome({ options }, false), { outcome: "selected", optionId: "r1" });
  // Only allow options (or a persisting reject_always): no selection at all.
  assert.deepEqual(permissionOutcome({ options: options.slice(0, 3) }, false), {
    outcome: "cancelled",
  });
  assert.deepEqual(permissionOutcome({}, false), { outcome: "cancelled" });
  // After session/cancel, ACP requires `cancelled` for every pending request.
  assert.deepEqual(permissionOutcome({ options }, true), { outcome: "cancelled" });
});

test("toolOutputText: text content in order, diffs/terminals named, rawOutput fallback", () => {
  assert.equal(
    toolOutputText(
      [
        { type: "content", content: { type: "text", text: "line 1" } },
        { type: "diff", path: "src/a.ts", oldText: "x", newText: "y" },
        { type: "terminal", terminalId: "t1" },
        { type: "content", content: { type: "image", data: "…" } },
      ],
      "ignored when content has text",
    ),
    "line 1\n[diff] src/a.ts\n[terminal] t1",
  );
  assert.equal(toolOutputText(undefined, "plain"), "plain");
  assert.equal(toolOutputText([], { exitCode: 1 }), '{"exitCode":1}');
  assert.equal(toolOutputText(null, null), "");
});

test("createToolTracker: call once, latest fields win, one result per call, failed → isError", () => {
  const events: ProviderToolEvent[] = [];
  const tracker = createToolTracker((event) => events.push(event));
  tracker.apply({ toolCallId: "c1", title: "Read file", kind: "read", rawInput: { p: 1 } });
  tracker.apply({ toolCallId: "c1", status: "in_progress", rawInput: { p: 2 } });
  tracker.apply({
    toolCallId: "c1",
    status: "completed",
    content: [{ type: "content", content: { type: "text", text: "ok" } }],
  });
  tracker.apply({ toolCallId: "c1", status: "failed" }); // after the result: ignored
  tracker.apply({ toolCallId: "c2", name: "bash", status: "failed", rawOutput: "boom" });
  tracker.apply({ toolCallId: "c3", kind: "fetch" });
  assert.deepEqual(events, [
    { kind: "call", callId: "c1", name: "Read file", arguments: { p: 1 } },
    {
      kind: "result",
      callId: "c1",
      name: "Read file",
      arguments: { p: 2 },
      output: "ok",
      isError: false,
    },
    { kind: "call", callId: "c2", name: "bash", arguments: null },
    { kind: "result", callId: "c2", name: "bash", arguments: null, output: "boom", isError: true },
    { kind: "call", callId: "c3", name: "fetch", arguments: null },
  ]);
});

// --- round trips through the fake agent child ---------------------------------------------------

test("happy path: handshake, session, prompt; text streamed; the agent's model report is the receipt", async () => {
  await withFake("ok", async ({ spawn, wire, argv }) => {
    const port = createAcpPort({
      spec: TEST_SPEC,
      binaryPath: FAKE_GROK_BINARY,
      spawn,
      clientVersion: "1.2.3",
    });
    assert.equal(port.providerId, "acp-test");
    const turn = turnRequest();
    const result = await port.streamTurn(turn.request);
    assert.deepEqual(result, {
      text: "fake acp answer to: say hi",
      requestedModelId: MODEL,
      servedModel: MODEL,
      vendorReported: true,
    });
    assert.deepEqual(turn.deltas, ["fake acp answer", " to: say hi"]);
    assert.deepEqual(turn.tools, []);
    assert.deepEqual(argv()?.argv, [`--model=${MODEL}`]);
    const messages = wire();
    // Strict JSON-RPC 2.0 outbound (ACP), madc identified honestly, nothing served to the agent.
    for (const message of messages) assert.equal(message.jsonrpc, "2.0");
    assert.deepEqual(
      messages.map((m) => m.method),
      ["initialize", "session/new", "session/prompt"],
      "no authenticate when the spec does not ask for it",
    );
    assert.deepEqual(messages[0]?.params, {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "madc", version: "1.2.3" },
    });
    assert.deepEqual(messages[1]?.params, { cwd: process.cwd(), mcpServers: [] });
    // ACP has no system-prompt channel: the seat instructions lead the prompt blocks.
    assert.deepEqual(messages[2]?.params, {
      sessionId: "sess_fakeacp",
      prompt: [
        { type: "text", text: INSTRUCTIONS },
        { type: "text", text: "say hi" },
      ],
    });
  });
});

test("no model report → servedModel is the requested id with vendorReported false", async () => {
  await withFake("no-model", async ({ spawn }) => {
    const port = createAcpPort({ spec: TEST_SPEC, binaryPath: FAKE_GROK_BINARY, spawn });
    const { systemPrompt: _omit, ...request } = turnRequest().request;
    const result = await port.streamTurn(request);
    assert.equal(result.servedModel, MODEL);
    assert.equal(result.vendorReported, false);
  });
});

test("model reports: legacy currentModelId, a mid-turn config update, and a same-chunk update", async () => {
  for (const [mode, served] of [
    ["legacy-model", MODEL],
    ["model-update", "grok-served-later"],
    ["same-chunk", "grok-same-chunk"],
  ] as const) {
    await withFake(mode, async ({ spawn }) => {
      const port = createAcpPort({ spec: TEST_SPEC, binaryPath: FAKE_GROK_BINARY, spawn });
      const result = await port.streamTurn(turnRequest().request);
      assert.equal(result.servedModel, served, mode);
      assert.equal(result.vendorReported, true, mode);
    });
  }
});

test("tool events: call/result pairs in order, failed → isError, an unfinished call has no result", async () => {
  await withFake("tools", async ({ spawn }) => {
    const port = createAcpPort({ spec: TEST_SPEC, binaryPath: FAKE_GROK_BINARY, spawn });
    const turn = turnRequest();
    const result = await port.streamTurn(turn.request);
    assert.equal(result.text, "Looking. Done.", "thoughts and plans never join the text");
    assert.deepEqual(turn.tools, [
      {
        kind: "call",
        callId: "call_read",
        name: "Read README.md",
        arguments: { path: "README.md" },
      },
      {
        kind: "result",
        callId: "call_read",
        name: "Read README.md",
        arguments: { path: "README.md" },
        output: "# MADC",
        isError: false,
      },
      {
        kind: "call",
        callId: "call_exec",
        name: "Run npm test",
        arguments: { command: "npm test" },
      },
      {
        kind: "result",
        callId: "call_exec",
        name: "Run npm test",
        arguments: { command: "npm test" },
        output: '{"exitCode":1}',
        isError: true,
      },
      { kind: "call", callId: "call_open", name: "Search the web", arguments: null },
    ]);
  });
});

test("approval posture: a permission request is refused with reject_once, never allowed", async () => {
  await withFake("permission", async ({ spawn, wire }) => {
    const port = createAcpPort({ spec: TEST_SPEC, binaryPath: FAKE_GROK_BINARY, spawn });
    const result = await port.streamTurn(turnRequest().request);
    assert.equal(result.text, "permission answered");
    const answer = wire().find((m) => m.id === 900 && m.method === undefined);
    assert.deepEqual(answer?.result, {
      outcome: { outcome: "selected", optionId: "opt-reject-once" },
    });
    assert.equal(answer?.jsonrpc, "2.0");
  });
});

test("agent→client methods MAD does not serve are answered -32601 (no fs access lent)", async () => {
  await withFake("fs-request", async ({ spawn, wire }) => {
    const port = createAcpPort({ spec: TEST_SPEC, binaryPath: FAKE_GROK_BINARY, spawn });
    const result = await port.streamTurn(turnRequest().request);
    assert.equal(result.text, "fs answered");
    const answer = wire().find((m) => m.id === 900 && m.method === undefined);
    assert.deepEqual(answer?.error, { code: -32601, message: "Method not found" });
  });
});

test("trailing chunks after the prompt response are kept inside the quiet window", async () => {
  await withFake("trailing", async ({ spawn }) => {
    const port = createAcpPort({
      spec: { ...TEST_SPEC, trailingQuietMs: 150, trailingMaxMs: 2_000 },
      binaryPath: FAKE_GROK_BINARY,
      spawn,
    });
    const turn = turnRequest();
    const result = await port.streamTurn(turn.request);
    assert.equal(result.text, "late answer");
    assert.deepEqual(turn.deltas, ["late ", "answer"]);
  });
});

test("an agent that exits right after answering still completes the turn (close during drain)", async () => {
  await withFake("exit-after-answer", async ({ spawn }) => {
    const port = createAcpPort({
      spec: { ...TEST_SPEC, trailingQuietMs: 500, trailingMaxMs: 2_000 },
      binaryPath: FAKE_GROK_BINARY,
      spawn,
    });
    const result = await port.streamTurn(turnRequest().request);
    assert.equal(result.text, "fake acp answer");
  });
});

test("abort mid-prompt sends session/cancel for the session and rejects aborted", async () => {
  await withFake("hang", async ({ spawn, wire }) => {
    const port = createAcpPort({ spec: TEST_SPEC, binaryPath: FAKE_GROK_BINARY, spawn });
    const turn = turnRequest();
    const pending = port.streamTurn(turn.request);
    await waitFor(() => turn.deltas.length > 0, "the partial chunk");
    turn.controller.abort();
    const err = await expectCallError(pending);
    assert.equal(err.kind, "aborted");
    const cancel = wire().find((m) => m.method === "session/cancel");
    assert.deepEqual(cancel?.params, { sessionId: "sess_fakeacp" });
    assert.equal(cancel?.id, undefined, "session/cancel is a notification");
  });
});

test("abort escalates to a kill when the agent ignores session/cancel", async () => {
  await withFake("hang-deaf", async ({ spawn, wire }) => {
    const port = createAcpPort({ spec: TEST_SPEC, binaryPath: FAKE_GROK_BINARY, spawn });
    const turn = turnRequest();
    const pending = port.streamTurn(turn.request);
    await waitFor(() => turn.deltas.length > 0, "the partial chunk");
    const startedAt = Date.now();
    turn.controller.abort();
    const err = await expectCallError(pending);
    assert.equal(err.kind, "aborted");
    assert.ok(Date.now() - startedAt < 5_000, "SIGTERM after the cancel grace");
    await waitFor(() => wire().some((m) => m.method === "session/cancel"), "session/cancel");
  });
});

test("an already-aborted signal never reaches a prompt", async () => {
  await withFake("ok", async ({ spawn, wire }) => {
    const port = createAcpPort({ spec: TEST_SPEC, binaryPath: FAKE_GROK_BINARY, spawn });
    const turn = turnRequest();
    turn.controller.abort();
    const err = await expectCallError(port.streamTurn(turn.request));
    assert.equal(err.kind, "aborted");
    assert.ok(!wire().some((m) => m.method === "session/prompt"));
  });
});

test("already aborted: the killed agent's EPIPE landing before 'close' still ends aborted", async () => {
  // M1-A9 regression for the test above, made deterministic. The client kills the agent at once,
  // while the handshake still writes `initialize` into the dying pipe; the EPIPE can reach the
  // stdin 'error' handler BEFORE the child's 'close' (it did on CI for `main` @ e83e517). This stub
  // pins that order, and the turn must read as the abort it is, not as a vendor failure.
  const killedBeforeClose: AcpSpawn = () => {
    const child = new EventEmitter() as ChildProcess;
    const stream = () =>
      Object.assign(new EventEmitter(), { setEncoding: () => undefined }) as unknown as NonNullable<
        ChildProcess["stdout"]
      >;
    child.stdout = stream();
    child.stderr = stream();
    const stdin = new EventEmitter();
    child.stdin = Object.assign(stdin, {
      write: () => {
        const err = new Error("write EPIPE") as NodeJS.ErrnoException;
        err.code = "EPIPE";
        queueMicrotask(() => stdin.emit("error", err));
        return false;
      },
    }) as unknown as NonNullable<ChildProcess["stdin"]>;
    let killed = false;
    child.kill = () => {
      if (!killed) {
        killed = true;
        setTimeout(() => child.emit("close", null, "SIGTERM"), 20);
      }
      return true;
    };
    return child;
  };
  const port = createAcpPort({
    spec: TEST_SPEC,
    binaryPath: FAKE_GROK_BINARY,
    spawn: killedBeforeClose,
  });
  const turn = turnRequest();
  turn.controller.abort();
  const err = await expectCallError(port.streamTurn(turn.request));
  assert.equal(err.kind, "aborted");
  assert.equal(err.message, "acp-test turn aborted");
});

test("auth: the spec's choice is sent with its _meta; no usable method or a refusal → no-credentials", async () => {
  await withFake("ok", async ({ spawn, wire }) => {
    const port = createAcpPort({ spec: AUTH_SPEC, binaryPath: FAKE_GROK_BINARY, spawn });
    await port.streamTurn(turnRequest().request);
    const auth = wire().find((m) => m.method === "authenticate");
    assert.deepEqual(auth?.params, { methodId: "cached_token", _meta: { headless: true } });
  });
  for (const mode of ["no-auth", "auth-error", "auth-required"]) {
    await withFake(mode, async ({ spawn, wire }) => {
      const port = createAcpPort({ spec: AUTH_SPEC, binaryPath: FAKE_GROK_BINARY, spawn });
      const err = await expectCallError(port.streamTurn(turnRequest().request));
      assert.equal(err.kind, "failed", mode);
      assert.equal(err.reason, "no-credentials", mode);
      assert.ok(!wire().some((m) => m.method === "session/prompt"), mode);
      if (mode === "no-auth") {
        assert.ok(!wire().some((m) => m.method === "authenticate"), "nothing to authenticate with");
      }
    });
  }
});

test("vendor failures fail the turn with MAD-authored messages; vendor text never surfaces", async () => {
  const cases: [string, string][] = [
    ["prompt-error", "acp-test ACP session/prompt failed"],
    ["agent-cancelled", "acp-test turn was cancelled by the agent"],
    ["bad-stop", "acp-test turn failed"],
    ["bad-version", "acp-test ACP protocol version unsupported"],
    ["nonzero", "acp-test agent child exited 1"],
    ["malformed", "acp-test ACP output was not JSON-RPC"],
    ["vanish", "acp-test agent child exited 127"],
  ];
  for (const [mode, message] of cases) {
    await withFake(mode, async ({ spawn }) => {
      const port = createAcpPort({ spec: TEST_SPEC, binaryPath: FAKE_GROK_BINARY, spawn });
      const err = await expectCallError(port.streamTurn(turnRequest().request));
      assert.equal(err.kind, "failed", mode);
      assert.equal(err.message, message, mode);
      assert.equal(err.reason, undefined, mode);
    });
  }
});

test("refusal is an answered turn: the text stands", async () => {
  await withFake("refusal", async ({ spawn }) => {
    const port = createAcpPort({ spec: TEST_SPEC, binaryPath: FAKE_GROK_BINARY, spawn });
    const result = await port.streamTurn(turnRequest().request);
    assert.equal(result.text, "I can't help with that.");
  });
});

test("the agent dying after initialize settles the turn (EPIPE never crashes the engine)", async () => {
  await withFake("exit-after-init", async ({ spawn }) => {
    const port = createAcpPort({ spec: TEST_SPEC, binaryPath: FAKE_GROK_BINARY, spawn });
    const err = await expectCallError(port.streamTurn(turnRequest().request));
    assert.equal(err.kind, "failed");
  });
});

test("ENOENT at spawn → binary-missing; an empty binary path is refused up front", async () => {
  const vanishing: AcpSpawn = () => {
    const child = new EventEmitter() as ChildProcess;
    const stream = () =>
      Object.assign(new EventEmitter(), { setEncoding: () => undefined }) as unknown as NonNullable<
        ChildProcess["stdout"]
      >;
    child.stdout = stream();
    child.stderr = stream();
    child.stdin = Object.assign(new EventEmitter(), {
      write: () => true,
    }) as unknown as NonNullable<ChildProcess["stdin"]>;
    child.kill = () => true;
    const err = new Error("spawn ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    queueMicrotask(() => child.emit("error", err));
    return child;
  };
  const port = createAcpPort({ spec: TEST_SPEC, binaryPath: FAKE_GROK_BINARY, spawn: vanishing });
  const err = await expectCallError(port.streamTurn(turnRequest().request));
  assert.equal(err.reason, "binary-missing");
  assert.equal(err.message, "acp-test binary could not be started");
  assert.throws(
    () => createAcpPort({ spec: TEST_SPEC, binaryPath: "  " }),
    (e: unknown) => e instanceof ProviderCallError,
  );
});

test("findAgentBinary finds an executable on PATH and skips non-executables", () => {
  const dir = mkdtempSync(join(tmpdir(), "madc-m1a6-bin-"));
  try {
    const plain = join(dir, "plain");
    mkdirSync(plain);
    const exe = join(plain, "fake-agent");
    writeFileSync(exe, "#!/bin/sh\n");
    if (process.platform !== "win32") {
      chmodSync(exe, 0o644);
      assert.equal(findAgentBinary({ PATH: plain }, "fake-agent"), null, "not executable");
      chmodSync(exe, 0o755);
    }
    assert.equal(findAgentBinary({ PATH: plain }, "fake-agent"), exe);
    assert.equal(findAgentBinary({ PATH: "" }, "fake-agent"), null);
    assert.equal(findAgentBinary({}, "fake-agent"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
