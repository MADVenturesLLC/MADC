/**
 * M1-A9 L1 mock conformance — the three wired vendor-agent lanes: Claude Code (M0-A5), Codex
 * (M0-A6) and Grok Build over the generic ACP client (M1-A6). L1 is the plan §7 M1-A4 set — chat,
 * stream, one tool round-trip, served-model receipt — asked of every wired lane by M1-A9. No real
 * vendor binary, no credentials, no network: every child is a fixture run as a real process of the
 * test runtime (Node or Bun).
 *
 * A vendor agent runs its OWN tool loop; MAD never declares tools to it. So for these lanes "one tool
 * round-trip" means: the vendor uses a tool inside a MAD turn, the turn still completes with the
 * vendor's post-tool answer and an honest receipt, and MAD surfaces the tool activity exactly as far
 * as the adapter can see it. That differs by lane, and the tests pin the truth rather than a nicer
 * story:
 *
 * | Lane | stream | tool activity surfaced as `toolCall` / `toolResult` items |
 * | --- | --- | --- |
 * | `claude-code` | capture-and-emit: one delta with the final text (M0-A5, print mode) | **no** — `--output-format json` carries no tool events |
 * | `codex` | the vendor's own deltas | **no** — the M0 adapter maps only `agentMessage` items |
 * | `grok-build` | the vendor's own chunks | **yes** — ACP `tool_call` / `tool_call_update` |
 *
 * The two "no" cells are recorded M1 gaps (M1-A9 PR body), not failures: the adapters were
 * accepted that way in M0, and widening them is not this act's scope. The engine-side receipt for
 * each lane is proved in `packages/engine/src/lane-l1.test.ts`.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createClaudeCodePort, createCodexCodePort } from "../index.ts";
import type { ProviderToolEvent, ProviderTurnRequest } from "../provider-port.ts";
import {
  createFakeAcpSpawn,
  createFakeClaudeSpawn,
  createFakeCodexSpawn,
  FAKE_CLAUDE_BINARY,
  FAKE_CODEX_BINARY,
  FAKE_GROK_BINARY,
} from "../testing/index.ts";
import { createGrokBuildPort } from "./grok-build.ts";

type Recorded = { deltas: string[]; tools: ProviderToolEvent[]; request: ProviderTurnRequest };

function turn(modelId: string, text: string): Recorded {
  const deltas: string[] = [];
  const tools: ProviderToolEvent[] = [];
  return {
    deltas,
    tools,
    request: {
      modelId,
      systemPrompt: "You are an L1 conformance seat.",
      messages: [{ role: "user", text }],
      signal: new AbortController().signal,
      onTextDelta: (delta) => deltas.push(delta),
      onToolEvent: (event) => tools.push(event),
    },
  };
}

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "madc-a9-l1-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function jsonLines<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as T);
}

// ===================================================================== Claude Code

test("A9 L1 Claude Code: chat + capture-and-emit stream + vendor tool round-trip + receipt", async () => {
  await withDir(async (dir) => {
    const MODEL = "claude-sonnet-4-5";
    const argvLog = join(dir, "argv.jsonl");
    const base = createFakeClaudeSpawn();
    const port = createClaudeCodePort({
      binaryPath: FAKE_CLAUDE_BINARY,
      spawn: (command, args, options) =>
        base(command, args, {
          ...options,
          env: { MADC_TEST_CLAUDE_MODE: "tool-round-trip", MADC_TEST_CLAUDE_ARGV_LOG: argvLog },
        }),
    });
    const t = turn(MODEL, "what does the README say?");
    const result = await port.streamTurn(t.request);

    // chat: the prompt, model and standing instructions reach the vendor through print mode.
    assert.deepEqual(jsonLines(argvLog), [
      {
        prompt: "what does the README say?",
        model: MODEL,
        systemPrompt: "You are an L1 conformance seat.",
      },
    ]);
    // tool round-trip: the vendor ran a tool itself (`num_turns: 2`) and answered after it; the
    // turn completes with that post-tool answer.
    assert.equal(result.text, "fake claude answer after one tool call: what does the README say?");
    // stream: capture-and-emit — exactly one delta, equal to the final text.
    assert.deepEqual(t.deltas, [result.text]);
    // Pinned gap: print mode's JSON result has no tool events, so MAD surfaces none.
    assert.deepEqual(t.tools, []);
    // receipt: the vendor's own `modelUsage` key; the adapter states no vendorReported flag, so the
    // engine derives it (`servedModel !== requestedModelId`, protocol pin §5).
    assert.equal(result.requestedModelId, MODEL);
    assert.equal(result.servedModel, MODEL);
    assert.equal("vendorReported" in result, false);
  });
});

// ========================================================================== Codex

test("A9 L1 Codex: chat + stream + vendor tool round-trip + receipt", async () => {
  await withDir(async (dir) => {
    const MODEL = "gpt-5.1-codex";
    const wireLog = join(dir, "wire.jsonl");
    const base = createFakeCodexSpawn();
    const port = createCodexCodePort({
      binaryPath: FAKE_CODEX_BINARY,
      spawn: (command, args, options) =>
        base(command, args, {
          ...options,
          env: { MADC_TEST_CODEX_MODE: "tool-round-trip", MADC_TEST_CODEX_WIRE_LOG: wireLog },
        }),
    });
    const t = turn(MODEL, "what does the README say?");
    const result = await port.streamTurn(t.request);

    // chat: the documented app-server flow carries the model and the user's text.
    const wire = jsonLines<{ method?: string; params?: Record<string, unknown> }>(wireLog);
    assert.deepEqual(
      wire.map((m) => m.method).filter((m) => m !== undefined),
      ["initialize", "initialized", "thread/start", "turn/start"],
    );
    assert.equal(wire.find((m) => m.method === "thread/start")?.params?.model, MODEL);
    assert.deepEqual(wire.find((m) => m.method === "turn/start")?.params?.input, [
      { type: "text", text: "what does the README say?", text_elements: [] },
    ]);
    // tool round-trip: the vendor's `commandExecution` item ran before the answer; the turn
    // completes with the post-tool agentMessage only (the command's output is not answer text).
    assert.equal(result.text, "fake codex answer to: what does the README say?");
    // stream: the vendor's own deltas, in order, and nothing from the tool item.
    assert.deepEqual(t.deltas, ["fake codex answer", " to: what does the README say?"]);
    assert.equal(t.deltas.join(""), result.text);
    // Pinned gap: the M0 adapter maps only agentMessage items, so MAD surfaces no tool events.
    assert.deepEqual(t.tools, []);
    // receipt: `thread/start`'s vendor-resolved model; no vendorReported flag (engine derives it).
    assert.equal(result.requestedModelId, MODEL);
    assert.equal(result.servedModel, MODEL);
    assert.equal("vendorReported" in result, false);
  });
});

// ===================================================================== Grok Build

test("A9 L1 Grok Build: chat + stream + vendor tool round-trip surfaced as tool events + receipt", async () => {
  await withDir(async (dir) => {
    const MODEL = "grok-4.7";
    const wireLog = join(dir, "wire.jsonl");
    const port = createGrokBuildPort({
      binaryPath: FAKE_GROK_BINARY,
      spawn: createFakeAcpSpawn({ MADC_TEST_ACP_MODE: "tools", MADC_TEST_ACP_WIRE_LOG: wireLog }),
      clientVersion: "0.0.0",
      apiKeyPresent: () => false,
      trailingQuietMs: 20,
    });
    const t = turn(MODEL, "what does the README say?");
    const result = await port.streamTurn(t.request);

    // chat: the ACP flow carries the standing instructions and the user's text as prompt blocks.
    const wire = jsonLines<{ method?: string; params?: Record<string, unknown> }>(wireLog);
    assert.deepEqual(
      wire.map((m) => m.method),
      ["initialize", "authenticate", "session/new", "session/prompt"],
    );
    assert.deepEqual(wire[3]?.params?.prompt, [
      { type: "text", text: "You are an L1 conformance seat." },
      { type: "text", text: "what does the README say?" },
    ]);
    // stream: the agent's own chunks, in order; the text is their concatenation.
    assert.deepEqual(t.deltas, ["Looking. ", "Done."]);
    assert.equal(result.text, "Looking. Done.");
    // tool round-trip: the vendor's read tool is surfaced as one call and its one result, in order.
    const read = t.tools.filter((event) => event.callId === "call_read");
    assert.deepEqual(
      read.map((event) => event.kind),
      ["call", "result"],
    );
    const [call, done] = read;
    assert.equal(call?.name, done?.name);
    assert.deepEqual(call?.arguments, { path: "README.md" });
    assert.ok(done?.kind === "result");
    assert.equal(done.output, "# MADC");
    assert.equal(done.isError, false);
    // receipt: the agent reported its model through ACP, so the receipt says so.
    assert.equal(result.requestedModelId, MODEL);
    assert.equal(result.servedModel, MODEL);
    assert.equal(result.vendorReported, true);
  });
});
