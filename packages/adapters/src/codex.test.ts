/**
 * Codex adapter tests (Act M0-A6). No real `codex` binary, no credentials: every child is the
 * `fake-codex.ts` fixture (a fake JSON-RPC app-server) run as a real process of the test runtime;
 * binary detection is tested against temp directories.
 */
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CODEX_PROVIDER_ID,
  createCodexCodePort,
  findCodexBinary,
  ProviderCallError,
  type ProviderTurnRequest,
  resolveCodexPinnedModel,
} from "./index.ts";
import { createFakeCodexSpawn, FAKE_CODEX_BINARY } from "./testing/index.ts";

const MODEL = "gpt-5.1-codex";

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "madc-a6-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withTempDirAsync(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "madc-a6-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function turnRequest(overrides: Partial<ProviderTurnRequest> = {}): ProviderTurnRequest {
  return {
    modelId: MODEL,
    systemPrompt: "system prompt",
    messages: [{ role: "user", text: "hello codex" }],
    signal: new AbortController().signal,
    onTextDelta: () => undefined,
    ...overrides,
  };
}

/** Port over the fixture child; `mode` selects the fixture behavior via its env. */
function fakePort(mode?: string, wireLog?: string) {
  const env: Record<string, string> = {};
  if (mode !== undefined) env.MADC_TEST_CODEX_MODE = mode;
  if (wireLog !== undefined) env.MADC_TEST_CODEX_WIRE_LOG = wireLog;
  const base = createFakeCodexSpawn();
  return createCodexCodePort({
    binaryPath: FAKE_CODEX_BINARY,
    spawn: (command, args, options) => base(command, args, { ...options, env }),
  });
}

async function failureOf(promise: Promise<unknown>): Promise<ProviderCallError> {
  const err = await promise.then(
    () => assert.fail("expected failure"),
    (e: unknown) => e,
  );
  assert.ok(err instanceof ProviderCallError, String(err));
  return err;
}

/** Client messages the fixture received (what the adapter would have sent to `codex`). */
type WireMessage = { id?: number; method?: string; params?: Record<string, unknown> };

function wireMessages(wireLog: string): WireMessage[] {
  if (!existsSync(wireLog)) return [];
  return readFileSync(wireLog, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as WireMessage);
}

test("binary detection: PATH lookup finds an executable, misses nothing / non-executables", () => {
  withTempDir((dir) => {
    const bin = join(dir, "codex");
    writeFileSync(bin, "#!/bin/sh\n", { mode: 0o644 });
    if (process.platform === "win32") {
      assert.equal(findCodexBinary({ PATH: dir, PATHEXT: ".EXE" }), null, "wrong extension");
      return;
    }
    assert.equal(findCodexBinary({ PATH: dir }), null, "not executable");
    chmodSync(bin, 0o755);
    assert.equal(findCodexBinary({ PATH: dir }), bin);
    assert.equal(findCodexBinary({ PATH: "" }), null);
    assert.equal(findCodexBinary({}), null);
    assert.equal(findCodexBinary({ PATH: `${dir}/nope` }), null);
  });
});

// Skip reason on non-Windows: PATHEXT is Windows-only. Conditional `test.skip` registration —
// bun 1.3.11's node:test shim (CI) ignores the options-object `skip` entirely (string or
// boolean, verified against the release binary); `test.skip` is honored there and on Node.
if (process.platform !== "win32") {
  test.skip("binary detection on Windows honors PATHEXT");
} else {
  test("binary detection on Windows honors PATHEXT", () => {
    withTempDir((dir) => {
      const bin = join(dir, "codex.EXE");
      writeFileSync(bin, "MZ");
      assert.equal(findCodexBinary({ PATH: dir, PATHEXT: ".EXE;.BAT" }), bin);
      assert.equal(findCodexBinary({ PATH: dir, PATHEXT: ".BAT" }), null);
    });
  });
}

test("pinnedModel: non-empty vendor model name passes through verbatim; blank refused", () => {
  assert.deepEqual(resolveCodexPinnedModel("gpt-5.1-codex-mini"), {
    ok: true,
    modelId: "gpt-5.1-codex-mini",
  });
  assert.deepEqual(resolveCodexPinnedModel(" gpt-5.1-codex "), {
    ok: true,
    modelId: "gpt-5.1-codex",
  });
  for (const bad of ["", "   "]) {
    assert.equal(resolveCodexPinnedModel(bad).ok, false, bad);
  }
});

test("happy path: documented app-server flow; deltas streamed; servedModel from the vendor", async () => {
  await withTempDirAsync(async (dir) => {
    const wireLog = join(dir, "wire.jsonl");
    const deltas: string[] = [];
    const port = fakePort(undefined, wireLog);
    assert.equal(port.providerId, CODEX_PROVIDER_ID);
    const result = await port.streamTurn(turnRequest({ onTextDelta: (d) => deltas.push(d) }));
    assert.equal(result.text, "fake codex answer to: hello codex");
    assert.deepEqual(deltas, ["fake codex answer", " to: hello codex"], "deltas forwarded live");
    assert.equal(result.requestedModelId, MODEL);
    assert.equal(result.servedModel, MODEL);
    const wire = wireMessages(wireLog);
    const initialize = wire.find((m) => m.method === "initialize");
    assert.ok(initialize !== undefined);
    const clientInfo = initialize.params?.clientInfo as Record<string, unknown>;
    assert.equal(clientInfo.name, "madc");
    assert.ok(wire.some((m) => m.method === "initialized" && m.id === undefined));
    const threadStart = wire.find((m) => m.method === "thread/start");
    assert.deepEqual(threadStart?.params, {
      model: MODEL,
      approvalPolicy: "never",
      ephemeral: true,
      developerInstructions: "system prompt",
    });
    const turnStart = wire.find((m) => m.method === "turn/start");
    assert.deepEqual(turnStart?.params, {
      threadId: "thr_fakecodex",
      input: [{ type: "text", text: "hello codex", text_elements: [] }],
    });
  });
});

test("developerInstructions is omitted when the request has no system prompt", async () => {
  await withTempDirAsync(async (dir) => {
    const wireLog = join(dir, "wire.jsonl");
    const port = fakePort(undefined, wireLog);
    const { systemPrompt: _omit, ...request } = turnRequest();
    await port.streamTurn(request);
    const threadStart = wireMessages(wireLog).find((m) => m.method === "thread/start");
    assert.deepEqual(threadStart?.params, {
      model: MODEL,
      approvalPolicy: "never",
      ephemeral: true,
    });
  });
});

test("servedModel falls back to the requested id when the vendor reports none", async () => {
  const result = await fakePort("no-model").streamTurn(turnRequest());
  assert.equal(result.servedModel, MODEL);
});

test("no deltas from the vendor: the completed text is capture-and-emitted as one delta", async () => {
  const deltas: string[] = [];
  const result = await fakePort("no-delta").streamTurn(
    turnRequest({ onTextDelta: (d) => deltas.push(d) }),
  );
  assert.equal(result.text, "fake codex answer to: hello codex");
  assert.deepEqual(deltas, [result.text]);
});

test("vendor reports a failed turn → failed; upstream detail never reaches the error", async () => {
  const err = await failureOf(fakePort("turn-failed").streamTurn(turnRequest()));
  assert.equal(err.kind, "failed");
  assert.equal(err.message, "codex turn failed");
  assert.ok(!err.message.includes("account details"));
});

test("vendor error response to turn/start → failed; hostile body never surfaces", async () => {
  const err = await failureOf(fakePort("request-error").streamTurn(turnRequest()));
  assert.equal(err.kind, "failed");
  assert.equal(err.message, "codex app-server turn/start failed");
  assert.ok(!err.message.includes("account details"));
});

test("child non-zero exit → failed; stderr content never reaches the error", async () => {
  const err = await failureOf(fakePort("nonzero").streamTurn(turnRequest()));
  assert.equal(err.kind, "failed");
  assert.equal(err.reason, undefined);
  assert.equal(err.message, "codex app-server child exited 1");
  assert.ok(!err.message.includes("account details"));
});

test("malformed output → failed with a MAD-authored message", async () => {
  const err = await failureOf(fakePort("malformed").streamTurn(turnRequest()));
  assert.equal(err.kind, "failed");
  assert.equal(err.message, "codex app-server output was not JSON-RPC");
});

test("same-chunk flush: response plus turn notifications in ONE stdout write still completes", async () => {
  // Regression: turnId was assigned only when the turn/start await resumed, so notifications in
  // the same data chunk as the response were dropped and the turn never settled.
  const deltas: string[] = [];
  const result = await fakePort("same-chunk").streamTurn(
    turnRequest({ onTextDelta: (d) => deltas.push(d) }),
  );
  assert.equal(result.text, "fake codex answer to: hello codex");
  assert.deepEqual(deltas, ["fake codex answer to: hello codex"]);
  assert.equal(result.requestedModelId, MODEL);
  assert.equal(result.servedModel, MODEL);
});

test("child exits after initialize: the next write hits the closed pipe; turn fails, no crash", async () => {
  // Regression: EPIPE on vendor stdin is an async stream 'error', not a thrown write — without a
  // stdin error listener it crashed the engine; and the outstanding thread/start request must not
  // hang (pending is flushed on settle).
  const err = await failureOf(fakePort("exit-after-init").streamTurn(turnRequest()));
  assert.equal(err.kind, "failed");
  assert.equal(err.reason, undefined);
  assert.match(err.message, /^codex app-server (child exited 0|stdin closed)$/);
});

test("spawn that throws synchronously (EACCES) → failed without the binary-missing reason", async () => {
  const throwingSpawn = (): ChildProcess => {
    const err = new Error("spawn EACCES") as NodeJS.ErrnoException;
    err.code = "EACCES";
    throw err;
  };
  const port = createCodexCodePort({ binaryPath: "/nope/codex", spawn: throwingSpawn });
  const err = await failureOf(port.streamTurn(turnRequest()));
  assert.equal(err.kind, "failed");
  assert.equal(err.reason, undefined);
  assert.equal(err.message, "codex app-server child failed to start");
});

test("spawn error event other than ENOENT (EACCES) → failed without the binary-missing reason", async () => {
  const eaccesSpawn = (): ChildProcess => {
    const child = new EventEmitter() as ChildProcess;
    const fakeStream = () =>
      Object.assign(new EventEmitter(), { setEncoding: () => undefined }) as unknown as NonNullable<
        ChildProcess["stdout"]
      >;
    child.stdout = fakeStream();
    child.stderr = fakeStream();
    child.kill = () => true;
    const err = new Error("spawn /nope/codex EACCES") as NodeJS.ErrnoException;
    err.code = "EACCES";
    queueMicrotask(() => child.emit("error", err));
    return child;
  };
  const port = createCodexCodePort({ binaryPath: "/nope/codex", spawn: eaccesSpawn });
  const err = await failureOf(port.streamTurn(turnRequest()));
  assert.equal(err.kind, "failed");
  assert.equal(err.reason, undefined);
  assert.equal(err.message, "codex binary could not be started");
});

test("abort (turn/interrupt) sends the documented interrupt, kills the child, ends aborted", async () => {
  await withTempDirAsync(async (dir) => {
    const wireLog = join(dir, "wire.jsonl");
    const controller = new AbortController();
    const port = fakePort("hang", wireLog);
    const pending = port.streamTurn(turnRequest({ signal: controller.signal }));
    // Abort once the fixture has the turn (wire log shows turn/start was received), plus a beat
    // for the adapter to register the turnId.
    for (let i = 0; i < 200 && !wireMessages(wireLog).some((m) => m.method === "turn/start"); i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    const err = await failureOf(pending);
    assert.equal(err.kind, "aborted");
    assert.equal(err.message, "codex turn aborted");
    // The fixture logs the interrupt when it reads its stdin, which can land just before it dies.
    let interrupt: WireMessage | undefined;
    for (let i = 0; i < 400 && interrupt === undefined; i++) {
      interrupt = wireMessages(wireLog).find((m) => m.method === "turn/interrupt");
      if (interrupt === undefined) await new Promise((r) => setTimeout(r, 5));
    }
    assert.deepEqual(interrupt?.params, { threadId: "thr_fakecodex", turnId: "turn_fakecodex" });
  });
});

test("binary that vanishes at spawn → failed with reason binary-missing (protocol pin §4.2)", async () => {
  // A stub spawn that behaves like node's ENOENT: 'error' emitted, no stdio data, no 'close'
  // before the promise settles.
  const vanishingSpawn = (): ChildProcess => {
    const child = new EventEmitter() as ChildProcess;
    const fakeStream = () =>
      Object.assign(new EventEmitter(), { setEncoding: () => undefined }) as unknown as NonNullable<
        ChildProcess["stdout"]
      >;
    child.stdout = fakeStream();
    child.stderr = fakeStream();
    child.kill = () => true;
    const err = new Error("spawn /gone/codex ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    queueMicrotask(() => child.emit("error", err));
    return child;
  };
  const port = createCodexCodePort({ binaryPath: "/gone/codex", spawn: vanishingSpawn });
  const err = await failureOf(port.streamTurn(turnRequest()));
  assert.equal(err.kind, "failed");
  assert.equal(err.reason, "binary-missing");
  assert.equal(err.message, "codex binary could not be started");
});

// Live check: only when the operator machine actually has the vendor binary AND names a model
// their codex auth serves via MADC_TEST_CODEX_LIVE_MODEL (ChatGPT sign-in and API-key accounts
// serve different model names — verified on the reference machine — and the vendor binary is the
// authority on what it accepts, so there is no portable default). CI has neither, so this is
// always skipped there (plan §10 A6). Nothing about the run is recorded beyond pass/fail — the
// prompt is fixed and trivial, and the answer text is never printed.
const LIVE_CODEX = findCodexBinary(process.env);
const LIVE_MODEL = process.env.MADC_TEST_CODEX_LIVE_MODEL;
const liveAppServer = async (): Promise<void> => {
  const port = createCodexCodePort({ binaryPath: LIVE_CODEX as string });
  const { systemPrompt: _omit, ...request } = turnRequest({
    modelId: LIVE_MODEL as string,
    messages: [{ role: "user", text: "Reply with the single word: ok" }],
  });
  const result = await port.streamTurn(request);
  assert.ok(result.text.length > 0, "empty result text");
  assert.ok(result.servedModel.length > 0, "no servedModel reported");
};
// Skip reasons: codex not on PATH, or MADC_TEST_CODEX_LIVE_MODEL unset/blank (set it to a model
// your codex auth serves). Conditional `test.skip` registration — bun 1.3.11's node:test shim
// (CI) ignores the options-object `skip` entirely; `test.skip` is honored there and on Node.
if (LIVE_CODEX === null || LIVE_MODEL === undefined || LIVE_MODEL.trim() === "") {
  test.skip("live: the real unmodified codex app-server answers one turn");
} else {
  test(
    "live: the real unmodified codex app-server answers one turn",
    {
      timeout: 180_000,
    },
    liveAppServer,
  );
}
