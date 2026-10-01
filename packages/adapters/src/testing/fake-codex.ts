/**
 * Test-only fixture child standing in for `codex app-server` (Act M0-A6). Spawned as a real
 * process via `createFakeCodexSpawn` (same runtime as the test runner), it speaks the app-server
 * JSON-RPC flow the adapter codes against (initialize → initialized → thread/start → turn/start →
 * item/turn notifications → turn/completed) and answers per `MADC_TEST_CODEX_MODE`:
 *
 * - unset / `ok`       — full happy flow; agentMessage text in two deltas + item/completed
 * - `no-model`         — thread/start result without the top-level `model` (servedModel falls
 *                        back to the requested id)
 * - `no-delta`         — no delta notifications; text only at item/completed (capture fallback)
 * - `turn-failed`      — error notification + turn/completed status failed with hostile
 *                        upstream-looking detail that must never surface
 * - `request-error`    — turn/start gets a JSON-RPC error response (hostile body)
 * - `nonzero`          — hostile text on stderr, exit 1
 * - `malformed`        — a non-JSON line on stdout mid-flow
 * - `hang`             — handshake + turn/start answered, turn never completes; turn/interrupt
 *                        is acknowledged but the process runs until killed (abort tests)
 * - `same-chunk`       — the turn/start response AND the whole turn notification flow (delta,
 *                        item/completed, turn/completed) in ONE stdout write (regression: events
 *                        flushed with the response must not be dropped before the turnId binding)
 * - `exit-after-init`  — answers initialize, then exits 0 at once (regression: the next write
 *                        lands on the closed stdin pipe → EPIPE must settle the turn, never crash)
 * - `vanish`           — exits 127 immediately (spawn-raced binary-missing is covered by a stub
 *                        spawn that emits `error`; this mode covers the close-without-turn path)
 * - `tool-round-trip`  — M1-A9 L1: the vendor runs one tool ITSELF before it answers — a
 *                        synthetic `commandExecution` item (started → completed, with output)
 *                        between the user item and the agentMessage, and listed in the
 *                        turn/completed items. The adapter reads only an item's `type`, so the
 *                        fixture carries just enough fields to look like one.
 *
 * Records every client message it receives to `MADC_TEST_CODEX_WIRE_LOG` (one JSON line each)
 * when set, so tests can assert exactly what the adapter would have sent to the vendor binary.
 */
import { appendFileSync } from "node:fs";

const mode = process.env.MADC_TEST_CODEX_MODE ?? "ok";
const wireLog = process.env.MADC_TEST_CODEX_WIRE_LOG;

const THREAD_ID = "thr_fakecodex";
const TURN_ID = "turn_fakecodex";
const AGENT_ITEM_ID = "item_fakeagent";
const HOSTILE = "upstream 400 detail with account details that must never surface";

function send(msg: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function turn(
  status: string,
  items: unknown[] = [],
  error: unknown = null,
): Record<string, unknown> {
  return {
    id: TURN_ID,
    items,
    status,
    error,
    startedAt: 1,
    completedAt: status === "inProgress" ? null : 2,
  };
}

function agentItem(text: string): Record<string, unknown> {
  return { type: "agentMessage", id: AGENT_ITEM_ID, text, phase: "final_answer" };
}

let prompt = "";

function completeTurn(): void {
  send({ method: "turn/started", params: { threadId: THREAD_ID, turn: turn("inProgress") } });
  const userItem = {
    type: "userMessage",
    id: "item_fakeuser",
    content: [{ type: "text", text: prompt, text_elements: [] }],
  };
  send({
    method: "item/started",
    params: { item: userItem, threadId: THREAD_ID, turnId: TURN_ID, startedAtMs: 1 },
  });
  send({
    method: "item/completed",
    params: { item: userItem, threadId: THREAD_ID, turnId: TURN_ID, completedAtMs: 2 },
  });
  const toolItems: Record<string, unknown>[] = [];
  if (mode === "tool-round-trip") {
    const command = (status: string, output: string | null, exitCode: number | null) => ({
      type: "commandExecution",
      id: "item_fakecommand",
      command: "cat README.md",
      cwd: "/fake/workspace",
      status,
      aggregatedOutput: output,
      exitCode,
    });
    send({
      method: "item/started",
      params: {
        item: command("inProgress", null, null),
        threadId: THREAD_ID,
        turnId: TURN_ID,
        startedAtMs: 2,
      },
    });
    const done = command("completed", "# MADC\n", 0);
    send({
      method: "item/completed",
      params: { item: done, threadId: THREAD_ID, turnId: TURN_ID, completedAtMs: 3 },
    });
    toolItems.push(done);
  }
  const full = `fake codex answer to: ${prompt}`;
  send({
    method: "item/started",
    params: { item: agentItem(""), threadId: THREAD_ID, turnId: TURN_ID, startedAtMs: 3 },
  });
  if (mode !== "no-delta") {
    send({
      method: "item/agentMessage/delta",
      params: {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        itemId: AGENT_ITEM_ID,
        delta: "fake codex answer",
      },
    });
    send({
      method: "item/agentMessage/delta",
      params: {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        itemId: AGENT_ITEM_ID,
        delta: ` to: ${prompt}`,
      },
    });
  }
  send({
    method: "item/completed",
    params: { item: agentItem(full), threadId: THREAD_ID, turnId: TURN_ID, completedAtMs: 4 },
  });
  send({
    method: "turn/completed",
    params: { threadId: THREAD_ID, turn: turn("completed", [...toolItems, agentItem(full)]) },
  });
}

function failTurn(): void {
  send({
    method: "error",
    params: {
      error: { message: HOSTILE, codexErrorInfo: "other", additionalDetails: null },
      willRetry: false,
      threadId: THREAD_ID,
      turnId: TURN_ID,
    },
  });
  send({
    method: "turn/completed",
    params: {
      threadId: THREAD_ID,
      turn: turn("failed", [], {
        message: HOSTILE,
        codexErrorInfo: "other",
        additionalDetails: null,
      }),
    },
  });
}

function handle(msg: Record<string, unknown>): void {
  if (wireLog !== undefined) {
    appendFileSync(wireLog, `${JSON.stringify(msg)}\n`);
  }
  switch (msg.method) {
    case "initialize":
      if (mode === "exit-after-init") {
        // Flush the response, then die before the next client message is written.
        process.stdout.write(
          `${JSON.stringify({
            id: msg.id,
            result: {
              userAgent: "fake-codex/0.0.0",
              codexHome: "/fake/codex-home",
              platformFamily: "unix",
              platformOs: "macos",
            },
          })}\n`,
          () => process.exit(0),
        );
        return;
      }
      send({
        id: msg.id,
        result: {
          userAgent: "fake-codex/0.0.0",
          codexHome: "/fake/codex-home",
          platformFamily: "unix",
          platformOs: "macos",
        },
      });
      return;
    case "initialized":
      return;
    case "thread/start": {
      const params = (msg.params ?? {}) as Record<string, unknown>;
      const result: Record<string, unknown> = {
        thread: { id: THREAD_ID, turns: [] },
        modelProvider: "openai",
      };
      if (mode !== "no-model") result.model = params.model;
      send({ id: msg.id, result });
      return;
    }
    case "turn/start": {
      if (mode === "request-error") {
        send({ id: msg.id, error: { code: -32602, message: HOSTILE } });
        return;
      }
      const params = (msg.params ?? {}) as Record<string, unknown>;
      const input = Array.isArray(params.input) ? (params.input as Record<string, unknown>[]) : [];
      const first = input[0];
      prompt = typeof first?.text === "string" ? first.text : "";
      if (mode === "same-chunk") {
        // ONE stdout write: the response plus the whole turn flow in a single chunk.
        const full = `fake codex answer to: ${prompt}`;
        const agent = agentItem(full);
        const lines = [
          { id: msg.id, result: { turn: turn("inProgress") } },
          { method: "turn/started", params: { threadId: THREAD_ID, turn: turn("inProgress") } },
          {
            method: "item/agentMessage/delta",
            params: { threadId: THREAD_ID, turnId: TURN_ID, itemId: AGENT_ITEM_ID, delta: full },
          },
          {
            method: "item/completed",
            params: { item: agent, threadId: THREAD_ID, turnId: TURN_ID, completedAtMs: 4 },
          },
          {
            method: "turn/completed",
            params: { threadId: THREAD_ID, turn: turn("completed", [agent]) },
          },
        ];
        process.stdout.write(`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
        return;
      }
      send({ id: msg.id, result: { turn: turn("inProgress") } });
      if (mode === "hang") return;
      setTimeout(mode === "turn-failed" ? failTurn : completeTurn, 10);
      return;
    }
    case "turn/interrupt":
      // Acknowledged; in `hang` mode the turn still never completes (the adapter escalates).
      send({ id: msg.id, result: {} });
      return;
    default:
      return;
  }
}

switch (mode) {
  case "nonzero":
    process.stderr.write(`fake codex: exploded with account details that must never surface\n`);
    process.exit(1);
    break;
  case "vanish":
    process.exit(127);
    break;
  default: {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      buf += chunk;
      let at = buf.indexOf("\n");
      while (at >= 0) {
        const line = buf.slice(0, at);
        buf = buf.slice(at + 1);
        if (line.trim() !== "") {
          if (mode === "malformed") {
            process.stdout.write("this is not json\n");
            process.exit(0);
          }
          handle(JSON.parse(line) as Record<string, unknown>);
        }
        at = buf.indexOf("\n");
      }
    });
  }
}
