/**
 * Claude Code adapter tests (Act M0-A5). No real `claude` binary, no credentials: every child is
 * the `fake-claude.ts` fixture run as a real process of the test runtime; binary detection is
 * tested against temp directories.
 */
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CLAUDE_CODE_PROVIDER_ID,
  createClaudeCodePort,
  findClaudeBinary,
  ProviderCallError,
  type ProviderTurnRequest,
  resolveClaudePinnedModel,
} from "./index.ts";
import { createFakeClaudeSpawn, FAKE_CLAUDE_BINARY } from "./testing/index.ts";

const MODEL = "claude-sonnet-4-5";

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "madc-a5-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withTempDirAsync(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "madc-a5-"));
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
    messages: [{ role: "user", text: "hello claude" }],
    signal: new AbortController().signal,
    onTextDelta: () => undefined,
    ...overrides,
  };
}

/** Port over the fixture child; `mode` selects the fixture behavior via its env. */
function fakePort(mode?: string, argvLog?: string) {
  const env: Record<string, string> = {};
  if (mode !== undefined) env.MADC_TEST_CLAUDE_MODE = mode;
  if (argvLog !== undefined) env.MADC_TEST_CLAUDE_ARGV_LOG = argvLog;
  const base = createFakeClaudeSpawn();
  return createClaudeCodePort({
    binaryPath: FAKE_CLAUDE_BINARY,
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

test("binary detection: PATH lookup finds an executable, misses nothing / non-executables", () => {
  withTempDir((dir) => {
    const bin = join(dir, "claude");
    writeFileSync(bin, "#!/bin/sh\n", { mode: 0o644 });
    if (process.platform === "win32") {
      assert.equal(findClaudeBinary({ PATH: dir, PATHEXT: ".EXE" }), null, "wrong extension");
      return;
    }
    assert.equal(findClaudeBinary({ PATH: dir }), null, "not executable");
    chmodSync(bin, 0o755);
    assert.equal(findClaudeBinary({ PATH: dir }), bin);
    assert.equal(findClaudeBinary({ PATH: "" }), null);
    assert.equal(findClaudeBinary({}), null);
    assert.equal(findClaudeBinary({ PATH: `${dir}/nope` }), null);
  });
});

// Skip reason: PATHEXT is Windows-only. Boolean `skip`: bun 1.3.11's node:test shim (CI) runs a
// test whose `skip` is a string; a boolean is honored there and on Node.
test("binary detection on Windows honors PATHEXT", {
  skip: process.platform !== "win32",
}, () => {
  withTempDir((dir) => {
    const bin = join(dir, "claude.EXE");
    writeFileSync(bin, "MZ");
    assert.equal(findClaudeBinary({ PATH: dir, PATHEXT: ".EXE;.BAT" }), bin);
    assert.equal(findClaudeBinary({ PATH: dir, PATHEXT: ".BAT" }), null);
  });
});

test("pinnedModel: non-empty vendor model name passes through verbatim; blank refused", () => {
  assert.deepEqual(resolveClaudePinnedModel("opus"), { ok: true, modelId: "opus" });
  assert.deepEqual(resolveClaudePinnedModel(" claude-sonnet-4-5 "), {
    ok: true,
    modelId: "claude-sonnet-4-5",
  });
  for (const bad of ["", "   "]) {
    assert.equal(resolveClaudePinnedModel(bad).ok, false, bad);
  }
});

test("happy path: task sent via documented headless flags; result mapped; servedModel from vendor", async () => {
  await withTempDirAsync(async (dir) => {
    const argvLog = join(dir, "argv.jsonl");
    const deltas: string[] = [];
    const port = fakePort(undefined, argvLog);
    assert.equal(port.providerId, CLAUDE_CODE_PROVIDER_ID);
    const result = await port.streamTurn(turnRequest({ onTextDelta: (d) => deltas.push(d) }));
    assert.equal(result.text, "fake claude answer to: hello claude");
    assert.deepEqual(deltas, [result.text], "capture-and-emit: one delta with the full text");
    assert.equal(result.requestedModelId, MODEL);
    assert.equal(result.servedModel, MODEL);
    const seen = JSON.parse(readFileSync(argvLog, "utf8").trim()) as {
      prompt: string;
      model: string;
      systemPrompt: string | null;
    };
    assert.deepEqual(seen, {
      prompt: "hello claude",
      model: MODEL,
      systemPrompt: "system prompt",
    });
  });
});

test("system prompt flag is omitted when the request has none", async () => {
  await withTempDirAsync(async (dir) => {
    const argvLog = join(dir, "argv.jsonl");
    const port = fakePort(undefined, argvLog);
    const { systemPrompt: _omit, ...request } = turnRequest();
    await port.streamTurn(request);
    const seen = JSON.parse(readFileSync(argvLog, "utf8").trim()) as {
      systemPrompt: string | null;
    };
    assert.equal(seen.systemPrompt, null);
  });
});

test("servedModel falls back to the requested id when the vendor reports none", async () => {
  const result = await fakePort("no-model").streamTurn(turnRequest());
  assert.equal(result.servedModel, MODEL);
});

test("child non-zero exit → failed; stderr content never reaches the error", async () => {
  const err = await failureOf(fakePort("nonzero").streamTurn(turnRequest()));
  assert.equal(err.kind, "failed");
  assert.equal(err.reason, undefined);
  assert.equal(err.message, "claude-code child exited 1");
  assert.ok(!err.message.includes("account details"));
});

test("malformed output → failed with the pinned code path (MAD-authored message)", async () => {
  const err = await failureOf(fakePort("malformed").streamTurn(turnRequest()));
  assert.equal(err.kind, "failed");
  assert.equal(err.message, "claude-code output was not a result object");
});

test("vendor error result (is_error) → failed", async () => {
  const err = await failureOf(fakePort("error-result").streamTurn(turnRequest()));
  assert.equal(err.kind, "failed");
  assert.equal(err.message, "claude-code reported an error result");
});

test("abort (turn/interrupt) kills the child and ends the call as aborted", async () => {
  const controller = new AbortController();
  const port = fakePort("hang");
  const pending = port.streamTurn(turnRequest({ signal: controller.signal }));
  setTimeout(() => controller.abort(), 50);
  const err = await failureOf(pending);
  assert.equal(err.kind, "aborted");
  assert.equal(err.message, "claude-code turn aborted");
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
    const err = new Error("spawn /gone/claude ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    queueMicrotask(() => child.emit("error", err));
    return child;
  };
  const port = createClaudeCodePort({ binaryPath: "/gone/claude", spawn: vanishingSpawn });
  const err = await failureOf(port.streamTurn(turnRequest()));
  assert.equal(err.kind, "failed");
  assert.equal(err.reason, "binary-missing");
  assert.equal(err.message, "claude-code binary could not be started");
});

// Live check: only when the operator machine actually has the vendor binary. CI never has it, so
// this is skipped there (plan §10 A5). Nothing about the run is recorded beyond pass/fail — the
// prompt is fixed and trivial, and the answer text is never printed.
const LIVE_CLAUDE = findClaudeBinary(process.env);
test("live: the real unmodified claude binary answers one headless turn", {
  // Skip reason: claude not on PATH. Boolean `skip`: bun 1.3.11's node:test shim (CI) runs a
  // test whose `skip` is a string; a boolean is honored there and on Node.
  skip: LIVE_CLAUDE === null,
  timeout: 180_000,
}, async () => {
  const port = createClaudeCodePort({ binaryPath: LIVE_CLAUDE as string });
  const { systemPrompt: _omit, ...request } = turnRequest({
    modelId: "sonnet",
    messages: [{ role: "user", text: "Reply with the single word: ok" }],
  });
  const result = await port.streamTurn(request);
  assert.ok(result.text.length > 0, "empty result text");
  assert.ok(result.servedModel.length > 0, "no servedModel reported");
});
