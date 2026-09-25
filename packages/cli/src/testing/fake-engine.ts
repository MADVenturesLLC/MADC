/**
 * Test fixture: a scripted stand-in engine (stdio JSONL, node:* only) for CLI exit-class tests the
 * real engine cannot produce on demand. `MADC_TEST_FAKE_SCENARIO`:
 * - `unknown-code`: `thread/start` answers an error code outside the protocol table (-32099).
 * - `bad-protocol`: `initialize` reports protocolVersion `madc-m0/999`.
 * - `bad-chain`: the turn completes, but the thread's session file does not verify.
 * - `turn-failed-internal`: the turn ends `failed` with -32603 (agent failure, exit 1).
 */
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const scenario = process.env.MADC_TEST_FAKE_SCENARIO ?? "";
const home = process.env.MADC_HOME ?? "";
const send = (m: unknown) => process.stdout.write(`${JSON.stringify(m)}\n`);
const threadId = scenario === "bad-thread-id" ? "../escape" : "thr_fake0001";
const turnId = "turn_fake0001";
const sessionFile = () => join(home, "sessions", `${threadId}.jsonl`);

/** Seat pin §4.3 chain, reimplemented with node:* only (the CLI may not import engine code). */
function sortedKeyJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v as object)
            .sort()
            .map((k) => [k, (v as Record<string, unknown>)[k]]),
        )
      : v,
  );
}
let seq = 0;
let prevHash = "0".repeat(64);
function append(type: string, payload: Record<string, unknown>): void {
  const body = { v: 1, seq, ts: 1 + seq, type, threadId, seatId: "madc-default", payload };
  const hash = createHash("sha256")
    .update(`${prevHash}\n${sortedKeyJson(body)}`, "utf8")
    .digest("hex");
  const { payload: p, ...head } = body;
  appendFileSync(sessionFile(), `${JSON.stringify({ ...head, prevHash, hash, payload: p })}\n`);
  prevHash = hash;
  seq++;
}

const mark = process.env.MADC_TEST_FAKE_MARK;
const rl = createInterface({ input: process.stdin });
// "exit-nonzero": the turn completes normally, then the engine exits 7 on stdin EOF.
rl.on("close", () => {
  if (scenario === "exit-nonzero") process.exitCode = 7;
});
function inProgress(): Record<string, unknown> {
  return {
    id: turnId,
    threadId,
    status: "inProgress",
    items: [],
    error: null,
    startedAt: 1,
    completedAt: null,
  };
}
rl.on("line", (line) => {
  const msg = JSON.parse(line) as { id?: number; method: string; params?: Record<string, unknown> };
  if (msg.id === undefined) return;
  switch (msg.method) {
    case "initialize":
      send({
        id: msg.id,
        result: {
          serverInfo: { name: "madc-engine", version: "0.0.0" },
          protocolVersion: scenario === "bad-protocol" ? "madc-m0/999" : "madc-m0/1",
        },
      });
      return;
    case "thread/start": {
      if (scenario === "unknown-code") {
        send({ id: msg.id, error: { code: -32099, message: "from the future" } });
        return;
      }
      const thread = {
        id: threadId,
        seatId: "madc-default",
        cwd: null,
        createdAt: 1,
        updatedAt: 1,
        status: "idle",
        preview: "",
      };
      mkdirSync(join(home, "sessions"), { recursive: true });
      if (scenario === "bad-chain") writeFileSync(sessionFile(), '{"not":"a chain"}\n');
      else
        append("session.open", {
          cwd: null,
          backing: "kimi-code",
          providerId: "kimi-code",
          pinnedModel: "m",
        });
      send({ id: msg.id, result: { thread } });
      return;
    }
    case "turn/start": {
      if (scenario === "junk-hang") {
        // "junk-hang": a non-JSON stdout line mid-turn, then the turn never completes.
        send({ id: msg.id, result: { turn: inProgress() } });
        process.stdout.write("this is not json\n");
        return;
      }
      if (scenario === "slow-start") {
        // "slow-start": the turn/start response is delayed 1.5 s (the test signals meanwhile),
        // then the turn runs until turn/interrupt.
        if (mark !== undefined) writeFileSync(mark, "turn/start\n");
        setTimeout(() => {
          append("turn.start", { turnId, inputText: "hi" });
          send({ id: msg.id, result: { turn: inProgress() } });
        }, 1500);
        return;
      }
      const turn = {
        id: turnId,
        threadId,
        status: "inProgress",
        items: [],
        error: null,
        startedAt: 1,
        completedAt: null,
      };
      send({ id: msg.id, result: { turn } });
      // "junk-failed": a non-JSON line, then the turn fails -32603 (the violation must win: 3).
      const failed = scenario === "turn-failed-internal" || scenario === "junk-failed";
      if (scenario === "junk-failed") process.stdout.write("this is not json\n");
      // "delta-only": a delta is streamed but the completed turn carries no agentMessage item.
      if (scenario === "delta-only") {
        send({
          method: "item/agentMessage/delta",
          params: { threadId, turnId, itemId: "item_a1", delta: "streamed only" },
        });
      }
      if (scenario !== "bad-chain") {
        append("turn.start", { turnId, inputText: "hi" });
        const error = failed ? { code: -32603, message: "Agent failed" } : null;
        append("turn.end", { turnId, status: failed ? "failed" : "completed", error });
      }
      if (scenario === "item-other-turn") {
        // "item-other-turn": a well-formed item/completed bound to another turn id.
        send({
          method: "item/completed",
          params: {
            threadId,
            turnId: "turn_other",
            item: { id: "item_x", kind: "agentMessage", status: "completed", text: "x" },
          },
        });
      }
      if (scenario === "bad-item") {
        // "bad-item": valid JSON, but an item/completed notification without an item.
        send({ method: "item/completed", params: { threadId, turnId } });
      }
      const items =
        scenario === "delta-only"
          ? []
          : [{ id: "item_a1", kind: "agentMessage", status: "completed", text: "fake reply" }];
      if (scenario === "no-error-field") {
        // "no-error-field": turn/completed omits the required `error` field.
        const { error: _omit, ...rest } = { ...turn, status: "completed", completedAt: 2 };
        send({ method: "turn/completed", params: { turn: rest } });
        return;
      }
      if (scenario === "wrong-turn-id") {
        // "wrong-turn-id": a well-formed turn/completed for another turn of the same thread.
        send({
          method: "turn/completed",
          params: { turn: { ...turn, id: "turn_other", status: "completed", completedAt: 2 } },
        });
        return;
      }
      if (scenario === "bad-turn-item") {
        // "bad-turn-item": a well-formed turn whose agentMessage item has no text.
        send({
          method: "turn/completed",
          params: {
            turn: {
              ...turn,
              status: "completed",
              items: [{ id: "item_a1", kind: "agentMessage", status: "completed" }],
              completedAt: 2,
            },
          },
        });
        return;
      }
      if (scenario === "bad-turn") {
        // "bad-turn": turn/completed names the thread but carries no items array.
        send({ method: "turn/completed", params: { turn: { threadId, status: "completed" } } });
        return;
      }
      send({
        method: "turn/completed",
        params: {
          turn: {
            ...turn,
            status: failed ? "failed" : "completed",
            items,
            error: failed ? { code: -32603, message: "Agent failed" } : null,
            completedAt: 2,
          },
        },
      });
      return;
    }
    case "turn/interrupt": {
      if (mark !== undefined) appendFileSync(mark, "turn/interrupt\n");
      append("turn.end", { turnId, status: "interrupted", error: null });
      send({ id: msg.id, result: {} });
      send({
        method: "turn/completed",
        params: { turn: { ...inProgress(), status: "interrupted", completedAt: 2 } },
      });
      return;
    }
    default:
      send({ id: msg.id, error: { code: -32601, message: "Method not found" } });
  }
});
