/**
 * Test fixture: a scripted stand-in engine (stdio JSONL, node:* only) for CLI exit-class tests the
 * real engine cannot produce on demand. `MADC_TEST_FAKE_SCENARIO`:
 * - `unknown-code`: `thread/start` answers an error code outside the protocol table (-32099).
 * - `bad-protocol`: `initialize` reports protocolVersion `madc-m0/999`.
 * - `bad-chain`: the turn completes, but the thread's session file does not verify.
 * - `turn-failed-internal`: the turn ends `failed` with -32603 (agent failure, exit 1).
 * The A7-follow-up scenarios (erratum §3a-§3e) are named at their branches below.
 */
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const scenario = process.env.MADC_TEST_FAKE_SCENARIO ?? "";
const home = process.env.MADC_HOME ?? "";
const send = (m: unknown) => process.stdout.write(`${JSON.stringify(m)}\n`);
/** One write (one chunk): the lines arrive at the CLI together. */
const sendChunk = (...messages: unknown[]) =>
  process.stdout.write(`${messages.map((m) => JSON.stringify(m)).join("\n")}\n`);
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

/** Keep the process alive after stdin EOF (the CLI's close must kill it). */
const keepAlive = () => setInterval(() => undefined, 1_000);

const mark = process.env.MADC_TEST_FAKE_MARK;
const record = (what: string) => {
  if (mark !== undefined) appendFileSync(mark, `${what}\n`);
};

let answeredFirst = false;
const rl = createInterface({ input: process.stdin });
// "exit-nonzero": the turn completes normally, then the engine exits 7 on stdin EOF.
// "failed-exit1" / "provider-failed-exit1" (§3a): a failed turn, then exit 1 on EOF.
rl.on("close", () => {
  if (scenario === "exit-nonzero") process.exitCode = 7;
  if (scenario === "failed-exit1" || scenario === "provider-failed-exit1") process.exitCode = 1;
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
const agentItem = (text: string) => ({
  id: "item_a1",
  kind: "agentMessage",
  status: "completed",
  text,
});
function completedTurn(items: unknown[], error: Record<string, unknown> | null) {
  return {
    id: turnId,
    threadId,
    status: error === null ? "completed" : "failed",
    items,
    error,
    startedAt: 1,
    completedAt: 2,
  };
}
const defaultItems = () => [agentItem("fake reply")];
const receipt = (itemId: string, servedModel: string, backing = "kimi-code") => ({
  id: itemId,
  kind: "servedModel",
  status: "completed",
  requestedModel: "kimi-for-coding",
  servedModel,
  backing,
  providerId: "kimi-code",
});

rl.on("line", (line) => {
  const msg = JSON.parse(line) as { id?: number; method: string; params?: Record<string, unknown> };
  if (msg.id === undefined) return;
  // "e1-client" (allowance A1 client tests): the FIRST request gets a malformed error body
  // (MADC_TEST_ERROR_BODY, raw JSON), later requests a well-formed result.
  if (scenario === "e1-client") {
    if (!answeredFirst) {
      answeredFirst = true;
      process.stdout.write(
        `{"id":${JSON.stringify(msg.id)},"error":${process.env.MADC_TEST_ERROR_BODY ?? "null"}}\n`,
      );
    } else {
      send({ id: msg.id, result: { ok: true } });
    }
    return;
  }
  // "e1-client-unmatched": an error reply with no pending id is stored and ignored.
  if (scenario === "e1-client-unmatched") {
    process.stdout.write('{"id":999,"error":null}\n');
    send({ id: msg.id, result: { ok: true } });
    return;
  }
  // "never-answer-*": silence at one stage (request-timeout tests, doctor signal test).
  if (scenario === "never-answer-init") return;
  // "exit2-early" (§3e E5): exit 2 before answering initialize.
  if (scenario === "exit2-early") process.exit(2);
  // Record received methods only where a test reads them back (§3e E15). Recording for every
  // scenario would create the mark file at `initialize`, breaking the "slow-start" marker, which
  // must appear only when `turn/start` arrives (cli.test.ts Bugbot 4107608856).
  if (scenario === "slow-init") record(msg.method);
  switch (msg.method) {
    case "initialize": {
      if (scenario === "slow-init") {
        // "slow-init" (§3e E15): the initialize answer is delayed 10 s (the test signals meanwhile).
        setTimeout(() => {
          send({
            id: msg.id,
            result: {
              serverInfo: { name: "madc-engine", version: "0.0.0" },
              protocolVersion: "madc-m0/1",
            },
          });
        }, 10_000);
        return;
      }
      if (scenario === "unmatched-storm-init") {
        // Unmatched well-formed responses while initialize is pending: the request timeout must
        // still fire on its original deadline (§3b rules 1/3).
        const storm = setInterval(() => send({ id: "zz-unmatched", result: {} }), 100);
        rl.on("close", () => clearInterval(storm));
        return;
      }
      if (scenario === "e1-init-null") {
        // §3e E1: a null error body on the initialize reply.
        process.stdout.write(`{"id":${JSON.stringify(msg.id)},"error":null}\n`);
        return;
      }
      if (scenario === "init-rpc-error") {
        // §3e E10: an RPC error answer to initialize (then exit 0 on EOF).
        send({ id: msg.id, error: { code: -32603, message: "x" } });
        return;
      }
      if (scenario === "n7-serverinfo-missing") {
        send({ id: msg.id, result: { protocolVersion: "madc-m0/1" } });
        return;
      }
      if (scenario === "n7-serverinfo-name") {
        send({
          id: msg.id,
          result: {
            serverInfo: { name: "other-engine", version: "0.0.0" },
            protocolVersion: "madc-m0/1",
          },
        });
        return;
      }
      if (scenario === "n7-init-null-result") {
        // §3b N7: a well-formed frame whose initialize result is unusable.
        send({ id: msg.id, result: null });
        return;
      }
      if (scenario === "init-then-hang") {
        // §3e E7: initialize is answered, then the engine never exits on stdin EOF.
        send({
          id: msg.id,
          result: {
            serverInfo: { name: "madc-engine", version: "0.0.0" },
            protocolVersion: "madc-m0/1",
          },
        });
        keepAlive();
        return;
      }
      send({
        id: msg.id,
        result: {
          serverInfo: { name: "madc-engine", version: "0.0.0" },
          protocolVersion: scenario === "bad-protocol" ? "madc-m0/999" : "madc-m0/1",
        },
      });
      return;
    }
    case "thread/start": {
      if (scenario === "never-answer-thread") return;
      if (scenario === "unknown-code") {
        send({ id: msg.id, error: { code: -32099, message: "from the future" } });
        return;
      }
      if (scenario === "thread-start-busy") {
        // §3e E16 F-152: an RPC error on thread/start (human-mode one-line error).
        send({ id: msg.id, error: { code: -32004, message: "Turn already active" } });
        return;
      }
      const thread = {
        id: threadId,
        seatId: scenario === "n7-thread-seat" ? "other_seat" : "madc-default",
        cwd: null,
        createdAt: scenario === "n7-thread-bad" ? "x" : 1,
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
      if (scenario === "n5-thread-bad") {
        // §3b N5: a thread/started that fails the Thread shape.
        send({ method: "thread/started", params: { thread: { id: threadId } } });
      }
      if (scenario === "n5-thread-seat") {
        // §3b N5: a thread/started for another seat.
        send({ method: "thread/started", params: { thread: { ...thread, seatId: "other_seat" } } });
      }
      return;
    }
    case "turn/start": {
      if (scenario === "never-answer-turn") return;
      if (scenario === "unmatched-storm-turn-pending") {
        // Unmatched well-formed responses while turn/start is pending (§3b rule 3: no reset).
        const storm = setInterval(() => send({ id: "zz-unmatched", result: {} }), 100);
        rl.on("close", () => clearInterval(storm));
        return;
      }
      if (scenario === "n2-pending") {
        // §3b N2 (b): both an id and a method on the pending turn/start id → exit 3, not 4.
        send({ id: msg.id, method: "x", error: { code: -32008, message: "m" } });
        return;
      }
      if (scenario === "n4-both") {
        // §3b N4: both result and error on the pending turn/start id → exit 3, not 4.
        send({ id: msg.id, result: {}, error: { code: -32008, message: "m" } });
        return;
      }
      if (scenario === "e1-error-null-turn") {
        process.stdout.write(`{"id":${JSON.stringify(msg.id)},"error":null}\n`);
        return;
      }
      if (scenario === "e1-error-string") {
        process.stdout.write(`{"id":${JSON.stringify(msg.id)},"error":"boom"}\n`);
        return;
      }
      const foreignItem = {
        method: "item/completed",
        params: {
          threadId: "thr_other000",
          turnId: "turn_other",
          item: { id: "item_x", kind: "agentMessage", status: "completed", text: "x" },
        },
      };
      if (scenario === "e1-bad-item-first") {
        // §3e E1 / §3e E17 (4): a bad item, then a malformed error body on the pending id, in ONE
        // write (bad item first) → the E1 message wins and the turn stays UNKNOWN.
        sendChunk(foreignItem, { id: msg.id, error: null });
        return;
      }
      if (scenario === "e17-bad-item-then-refusal") {
        // §3e E17 (5): a bad item, then a well-formed error reply in one write → NOT STARTED.
        sendChunk(foreignItem, { id: msg.id, error: { code: -32004, message: "m" } });
        return;
      }
      if (scenario === "e17a-n2-then-refusal") {
        // E17a (8): an N2 frame that does not settle turn/start, then a well-formed refusal.
        sendChunk(
          { id: 99, method: "server/ask" },
          { id: msg.id, error: { code: -32008, message: "m" } },
        );
        return;
      }
      if (scenario === "e17a-n2-other-error") {
        // E17a (9): the N2 frame's error has a different code/message than the refusal.
        sendChunk(
          { id: 99, method: "server/ask", error: { code: -32000, message: "other" } },
          { id: msg.id, error: { code: -32008, message: "m" } },
        );
        return;
      }
      if (scenario === "e17a-method7-then-refusal") {
        // E17a (10): the N4 frame has no own id, so rule 4 does not match it.
        sendChunk(
          { method: 7, error: { code: -32008, message: "m" } },
          { id: msg.id, error: { code: -32008, message: "m" } },
        );
        return;
      }
      if (scenario === "e17a-n4-turn") {
        // E17a (7): both result and error on the pending id, the result a valid started turn.
        send({
          id: msg.id,
          result: { turn: inProgress() },
          error: { code: -32008, message: "m" },
        });
        return;
      }
      if (scenario === "e17-late-response") {
        // §3e E17 (2): a foreign-threadId delta at once, the response 200 ms later, and the
        // engine stays up past the CLI's EOF so the late reply arrives during the close.
        send({
          method: "item/agentMessage/delta",
          params: { threadId: "thr_other000", turnId: "turn_x", itemId: "item_a1", delta: "F" },
        });
        setTimeout(() => {
          append("turn.start", { turnId, inputText: "hi" });
          send({ id: msg.id, result: { turn: inProgress() } });
          setTimeout(() => process.exit(0), 100);
        }, 200);
        return;
      }
      const foreignDelta = {
        method: "item/agentMessage/delta",
        params: { threadId: "thr_other000", turnId: "turn_x", itemId: "item_a1", delta: "F" },
      };
      if (scenario === "e17-resp-then-delta" || scenario === "e17-delta-then-resp") {
        // §3e E17 (1): the turn/start response and a foreign-threadId delta in ONE write.
        append("turn.start", { turnId, inputText: "hi" });
        const response = { id: msg.id, result: { turn: inProgress() } };
        if (scenario === "e17-resp-then-delta") sendChunk(response, foreignDelta);
        else sendChunk(foreignDelta, response);
        return;
      }
      if (scenario === "silent-turn" || scenario === "silent-turn-rm") {
        // §3c: the turn starts and nothing ever arrives again; the engine ignores EOF.
        append("turn.start", { turnId, inputText: "hi" });
        send({ id: msg.id, result: { turn: inProgress() } });
        keepAlive();
        return;
      }
      if (scenario === "silent-turn-junk") {
        append("turn.start", { turnId, inputText: "hi" });
        send({ id: msg.id, result: { turn: inProgress() } });
        keepAlive();
        return;
      }
      if (scenario === "interrupt-then-hang") {
        // §3e E2: the turn runs until interrupted; after answering the interrupt the engine
        // ignores EOF (the CLI kills it 1 s after the grace, before the session re-read).
        append("turn.start", { turnId, inputText: "hi" });
        send({ id: msg.id, result: { turn: inProgress() } });
        keepAlive();
        return;
      }
      if (scenario === "interrupt-completes" || scenario === "interrupt-fails-provider") {
        // §3c test 6: the turn runs silent until the idle deadline makes the CLI interrupt.
        append("turn.start", { turnId, inputText: "hi" });
        send({ id: msg.id, result: { turn: inProgress() } });
        return;
      }
      if (scenario === "turn-inprogress" || scenario === "turn-bogus-status") {
        // §3e E16 F-59/F-60: turn/completed with a non-terminal status → 3, printed verbatim.
        append("turn.start", { turnId, inputText: "hi" });
        send({ id: msg.id, result: { turn: inProgress() } });
        const t =
          scenario === "turn-inprogress" ? inProgress() : { ...inProgress(), status: "bogus" };
        send({ method: "turn/completed", params: { turn: t } });
        return;
      }
      if (scenario === "unknown-storm-turn" || scenario === "unmatched-storm-turn") {
        // §3b rules 1/3 + §3c test 2: unknown notifications (or unmatched responses) every
        // 100 ms are ignored and never reset the idle deadline.
        append("turn.start", { turnId, inputText: "hi" });
        send({ id: msg.id, result: { turn: inProgress() } });
        if (scenario === "unknown-storm-turn") {
          setInterval(() => send({ method: "bogus/x", params: {} }), 100);
        } else {
          setInterval(() => send({ id: "zz-unmatched", result: {} }), 100);
        }
        keepAlive();
        return;
      }
      if (scenario === "unknown-notification" || scenario === "unmatched-mid-turn") {
        // §3b rule 1 / N1 positive: one ignored message mid-turn; the run is unchanged.
        append("turn.start", { turnId, inputText: "hi" });
        send({ id: msg.id, result: { turn: inProgress() } });
        if (scenario === "unknown-notification") send({ method: "bogus/x", params: {} });
        else send({ id: "zz-unmatched", result: {} });
        append("turn.end", { turnId, status: "completed", error: null });
        send({ method: "turn/completed", params: { turn: completedTurn(defaultItems(), null) } });
        return;
      }
      if (scenario === "n2-mid-turn" || scenario === "n3-params" || scenario === "n3-jsonrpc") {
        // §3b N2 (a) / N3: one malformed object mid-turn → exit 3.
        append("turn.start", { turnId, inputText: "hi" });
        send({ id: msg.id, result: { turn: inProgress() } });
        if (scenario === "n2-mid-turn") send({ id: 99, method: "server/ask" });
        if (scenario === "n3-params") process.stdout.write('{"params":{}}\n');
        if (scenario === "n3-jsonrpc") process.stdout.write('{"jsonrpc":"2.0"}\n');
        return;
      }
      if (scenario === "n4-method") {
        append("turn.start", { turnId, inputText: "hi" });
        send({ id: msg.id, result: { turn: inProgress() } });
        process.stdout.write('{"method":7}\n');
        return;
      }
      if (scenario === "n2-completed") {
        // §3b N2 (c) + rule 7: an id-carrying turn/completed never ends the turn → exit 3 with
        // the turn still the inProgress snapshot.
        append("turn.start", { turnId, inputText: "hi" });
        send({ id: msg.id, result: { turn: inProgress() } });
        send({
          id: 9,
          method: "turn/completed",
          params: { turn: completedTurn(defaultItems(), null) },
        });
        return;
      }
      if (scenario === "n5-turn-thread" || scenario === "n5-turn-status") {
        // §3b N5: a turn/started for another thread, or with a status that is not inProgress.
        append("turn.start", { turnId, inputText: "hi" });
        send({ id: msg.id, result: { turn: inProgress() } });
        if (scenario === "n5-turn-thread") {
          send({
            method: "turn/started",
            params: { turn: { ...inProgress(), threadId: "thr_other000" } },
          });
        } else {
          send({ method: "turn/started", params: { turn: completedTurn([], null) } });
        }
        return;
      }
      if (
        scenario === "n5-item-id" ||
        scenario === "n5-item-status" ||
        scenario === "n5-item-turn"
      ) {
        // §3b N5: a bad item id, a completed item at started, or another turn's item.
        append("turn.start", { turnId, inputText: "hi" });
        send({ id: msg.id, result: { turn: inProgress() } });
        if (scenario === "n5-item-id") {
          send({
            method: "item/started",
            params: {
              threadId,
              turnId,
              item: { id: "../x", kind: "agentMessage", status: "inProgress", text: "" },
            },
          });
        } else if (scenario === "n5-item-status") {
          send({
            method: "item/started",
            params: { threadId, turnId, item: agentItem("x") },
          });
        } else {
          send({
            method: "item/started",
            params: {
              threadId,
              turnId: "turn_other",
              item: { id: "item_x", kind: "agentMessage", status: "inProgress", text: "" },
            },
          });
        }
        return;
      }
      if (scenario === "n6-backing-notify" || scenario === "n6-backing-snapshot") {
        // §3b N6 (D-188): a servedModel backing outside the pinned three → exit 3.
        append("turn.start", { turnId, inputText: "hi" });
        send({ id: msg.id, result: { turn: inProgress() } });
        if (scenario === "n6-backing-notify") {
          send({
            method: "item/completed",
            params: { threadId, turnId, item: receipt("item_s1", "model-a", "ollama-cloud") },
          });
          return;
        }
        append("turn.end", { turnId, status: "completed", error: null });
        send({
          method: "turn/completed",
          params: {
            turn: completedTurn(
              [agentItem("q"), receipt("item_s1", "model-a", "ollama-cloud")],
              null,
            ),
          },
        });
        return;
      }
      if (scenario === "served-two" || scenario === "served-extra-notify") {
        // §3e E3: two servedModel items matched per id → 0 with the last in snapshot order; a
        // notification missing from the snapshot → 3.
        append("turn.start", { turnId, inputText: "hi" });
        send({ id: msg.id, result: { turn: inProgress() } });
        send({
          method: "item/completed",
          params: { threadId, turnId, item: receipt("item_sa", "model-a") },
        });
        send({
          method: "item/completed",
          params: { threadId, turnId, item: receipt("item_sb", "model-b") },
        });
        if (scenario === "served-extra-notify") {
          send({
            method: "item/completed",
            params: { threadId, turnId, item: receipt("item_sc", "model-c") },
          });
        }
        append("turn.end", { turnId, status: "completed", error: null });
        const snapItems =
          scenario === "served-two"
            ? [agentItem("q"), receipt("item_sa", "model-a"), receipt("item_sb", "model-b")]
            : [agentItem("q"), receipt("item_sa", "model-a"), receipt("item_sb", "model-b")];
        send({ method: "turn/completed", params: { turn: completedTurn(snapItems, null) } });
        return;
      }
      if (scenario === "turn-interrupted") {
        // §3e E4: the engine interrupts the turn on its own (no CLI signal) → exit 1.
        append("turn.start", { turnId, inputText: "hi" });
        send({ id: msg.id, result: { turn: inProgress() } });
        append("turn.end", { turnId, status: "interrupted", error: null });
        send({
          method: "turn/completed",
          params: { turn: { ...inProgress(), status: "interrupted", completedAt: 2 } },
        });
        return;
      }
      if (scenario === "exit2-mid") {
        // §3e E5: an engine exit 2 after initialize answered is an unexpected exit → 3.
        append("turn.start", { turnId, inputText: "hi" });
        send({ id: msg.id, result: { turn: inProgress() } });
        process.exit(2);
      }
      if (
        scenario === "failed-exit1" ||
        scenario === "provider-failed-exit1" ||
        scenario === "turn-failed-provider" ||
        scenario === "turn-failed-seat" ||
        scenario === "turn-failed-seat-nosession" ||
        scenario === "junk-failed-seat" ||
        scenario === "junk-completed-nosession"
      ) {
        // §3a (a)/(b), §3d (b)/(d)/(f)/(a): failed turns with provider/usage codes, a non-JSON
        // line, and/or a removed session file.
        append("turn.start", { turnId, inputText: "hi" });
        send({ id: msg.id, result: { turn: inProgress() } });
        const code =
          scenario === "provider-failed-exit1" || scenario === "turn-failed-provider"
            ? -32008
            : scenario === "failed-exit1"
              ? -32603
              : -32005;
        if (scenario === "junk-failed-seat" || scenario === "junk-completed-nosession") {
          process.stdout.write("this is not json\n");
        }
        const error =
          scenario === "junk-completed-nosession" ? null : { code, message: "failed turn" };
        append("turn.end", {
          turnId,
          status: error === null ? "completed" : "failed",
          error,
        });
        send({ method: "turn/completed", params: { turn: completedTurn(defaultItems(), error) } });
        if (scenario === "turn-failed-seat-nosession" || scenario === "junk-completed-nosession") {
          unlinkSync(sessionFile());
        }
        return;
      }
      if (scenario === "completed-ignore-eof") {
        // §3a (c) / §3d (e): the turn completes; the engine ignores EOF (killed at close).
        append("turn.start", { turnId, inputText: "hi" });
        send({ id: msg.id, result: { turn: inProgress() } });
        append("turn.end", { turnId, status: "completed", error: null });
        send({ method: "turn/completed", params: { turn: completedTurn(defaultItems(), null) } });
        keepAlive();
        return;
      }
      if (scenario === "delta-tick" || scenario === "item-started-tick") {
        // §3c tests 3/4: listed notifications every 300 ms reset the idle deadline → exit 0.
        append("turn.start", { turnId, inputText: "hi" });
        send({ id: msg.id, result: { turn: inProgress() } });
        let ticks = 0;
        const timer = setInterval(() => {
          ticks++;
          if (scenario === "delta-tick") {
            send({
              method: "item/agentMessage/delta",
              params: { threadId, turnId, itemId: "item_a1", delta: `d${ticks}` },
            });
          } else {
            send({
              method: "item/started",
              params: {
                threadId,
                turnId,
                item: {
                  id: `item_t${ticks}`,
                  kind: "agentMessage",
                  status: "inProgress",
                  text: "",
                },
              },
            });
          }
          if (ticks >= 6) {
            clearInterval(timer);
            append("turn.end", { turnId, status: "completed", error: null });
            send({
              method: "turn/completed",
              params: { turn: completedTurn(defaultItems(), null) },
            });
          }
        }, 300);
        return;
      }
      if (scenario === "bad-item-started-quiet") {
        // §3c test 5: a listed notification that fails its checks → exit 3 promptly.
        append("turn.start", { turnId, inputText: "hi" });
        send({ id: msg.id, result: { turn: inProgress() } });
        send({
          method: "item/started",
          params: {
            threadId,
            turnId: "turn_other",
            item: { id: "item_x", kind: "agentMessage", status: "inProgress", text: "" },
          },
        });
        return;
      }
      if (scenario === "bad-item-junk") {
        // §3c test 16: a malformed item followed by a non-JSON line (no idle timeout in play).
        append("turn.start", { turnId, inputText: "hi" });
        send({ id: msg.id, result: { turn: inProgress() } });
        send({ method: "item/completed", params: { threadId, turnId } });
        process.stdout.write("this is not json\n");
        return;
      }
      if (scenario === "early-completed" || scenario === "early-completed-other") {
        // §3e E16 F-69: turn/completed before the turn/start response; for this turn → 0, for
        // another turn → 3.
        append("turn.start", { turnId, inputText: "hi" });
        const early =
          scenario === "early-completed"
            ? completedTurn(defaultItems(), null)
            : { ...completedTurn(defaultItems(), null), id: "turn_other" };
        send({ method: "turn/completed", params: { turn: early } });
        append("turn.end", { turnId: early.id as string, status: "completed", error: null });
        send({ id: msg.id, result: { turn: inProgress() } });
        return;
      }
      if (scenario === "json-null-line") {
        // Copilot PR #23: a JSON but non-object stdout line mid-turn (null and an array) → the
        // client logs it as a protocol violation; the CLI exits 3 and never crashes.
        append("turn.start", { turnId, inputText: "hi" });
        send({ id: msg.id, result: { turn: inProgress() } });
        process.stdout.write("null\n[]\n");
        return;
      }
      if (scenario === "blank-line") {
        // §3e E16 F-73: a blank line on engine stdout is a non-JSON line → exit 3.
        append("turn.start", { turnId, inputText: "hi" });
        send({ id: msg.id, result: { turn: inProgress() } });
        process.stdout.write("\n");
        return;
      }
      if (scenario === "self-sigterm") {
        // §3e E16 F-89: the engine is killed by an outside signal after the completed turn.
        append("turn.start", { turnId, inputText: "hi" });
        send({ id: msg.id, result: { turn: inProgress() } });
        append("turn.end", { turnId, status: "completed", error: null });
        send({ method: "turn/completed", params: { turn: completedTurn(defaultItems(), null) } });
        setTimeout(() => process.kill(process.pid, "SIGTERM"), 50);
        return;
      }
      if (scenario === "ctrl-text" || scenario === "ctrl-delta") {
        // §3e E11: control characters in the final text and in a streamed delta.
        append("turn.start", { turnId, inputText: "hi" });
        send({ id: msg.id, result: { turn: inProgress() } });
        if (scenario === "ctrl-delta") {
          send({
            method: "item/agentMessage/delta",
            params: { threadId, turnId, itemId: "item_a1", delta: "x\u001b[31my\u0007" },
          });
          append("turn.end", { turnId, status: "completed", error: null });
          send({
            method: "turn/completed",
            params: { turn: completedTurn([agentItem("done")], null) },
          });
          return;
        }
        append("turn.end", { turnId, status: "completed", error: null });
        send({
          method: "turn/completed",
          params: { turn: completedTurn([agentItem("a[31mbc\r\n")], null) },
        });
        return;
      }
      if (scenario === "long-text") {
        // §3e E12/E13: a 200 001-byte final text; the engine stays alive until the CLI's EOF, so
        // the engine-side Bun truncation (F-78) cannot mask the CLI's result.
        append("turn.start", { turnId, inputText: "hi" });
        send({ id: msg.id, result: { turn: inProgress() } });
        append("turn.end", { turnId, status: "completed", error: null });
        send({
          method: "turn/completed",
          params: { turn: completedTurn([agentItem("y".repeat(200_001))], null) },
        });
        return;
      }
      if (scenario === "stderr-log") {
        // §3e E9: engine log lines pass through the inherited stderr, also in --json mode.
        append("turn.start", { turnId, inputText: "hi" });
        send({ id: msg.id, result: { turn: inProgress() } });
        process.stderr.write("[fake] log\n");
        append("turn.end", { turnId, status: "completed", error: null });
        send({ method: "turn/completed", params: { turn: completedTurn(defaultItems(), null) } });
        return;
      }
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
      if (scenario === "slow-start-800") {
        // §3c test 12: the turn/start response is delayed 800 ms, turn/completed within 50 ms.
        setTimeout(() => {
          append("turn.start", { turnId, inputText: "hi" });
          send({ id: msg.id, result: { turn: inProgress() } });
          setTimeout(() => {
            append("turn.end", { turnId, status: "completed", error: null });
            send({
              method: "turn/completed",
              params: { turn: completedTurn([agentItem("q")], null) },
            });
          }, 50);
        }, 800);
        return;
      }
      // §3e E14: one scenario per turn/start result sub-check.
      if (scenario === "start-no-shape") {
        const { threadId: _omit, ...noThread } = inProgress();
        send({ id: msg.id, result: { turn: noThread } });
        return;
      }
      if (scenario === "start-bad-id") {
        send({ id: msg.id, result: { turn: { ...inProgress(), id: "../x" } } });
        return;
      }
      if (scenario === "start-other-thread") {
        send({ id: msg.id, result: { turn: { ...inProgress(), threadId: "thr_other000" } } });
        return;
      }
      if (scenario === "start-status-completed") {
        send({
          id: msg.id,
          result: { turn: { ...inProgress(), status: "completed", completedAt: null } },
        });
        return;
      }
      if (scenario === "start-items") {
        send({ id: msg.id, result: { turn: { ...inProgress(), items: [agentItem("x")] } } });
        return;
      }
      if (scenario === "start-completedat") {
        send({ id: msg.id, result: { turn: { ...inProgress(), completedAt: 2 } } });
        return;
      }
      const turn = inProgress();
      if (scenario === "start-completed") {
        // "start-completed": turn/start answers an already completed, populated turn and no
        // turn/completed ever follows (a CLI that waits would hang).
        send({
          id: msg.id,
          result: {
            turn: {
              ...turn,
              status: "completed",
              items: [{ id: "item_a1", kind: "agentMessage", status: "completed", text: "x" }],
              completedAt: 2,
            },
          },
        });
        return;
      }
      if (scenario === "delta-early-other-turn") {
        // A foreign-turn delta that arrives before the turn/start response (turnId not yet known).
        send({
          method: "item/agentMessage/delta",
          params: { threadId, turnId: "turn_other", itemId: "item_a1", delta: "FOREIGN-DELTA" },
        });
      }
      const quietItem = (forTurn: string, item: unknown) =>
        send({ method: "item/completed", params: { threadId, turnId: forTurn, item } });
      const okItem = { id: "item_q1", kind: "agentMessage", status: "completed", text: "q" };
      // "early-foreign-item-quiet": a well-formed item for another turn BEFORE the response.
      if (scenario === "early-foreign-item-quiet") quietItem("turn_other", okItem);
      send({ id: msg.id, result: { turn } });
      // "*-quiet": one malformed or foreign item/delta, then silence (no turn/completed ever).
      if (scenario.endsWith("-quiet")) {
        if (scenario === "bad-item-quiet")
          quietItem(turnId, { id: "item_q1", kind: "agentMessage" });
        if (scenario === "foreign-item-quiet") quietItem("turn_other", okItem);
        if (scenario === "bad-delta-quiet") {
          send({
            method: "item/agentMessage/delta",
            params: { threadId, turnId, itemId: "item_q1", delta: 42 },
          });
        }
        return;
      }
      // "junk-failed": a non-JSON line, then the turn fails -32603 (the violation must win: 3).
      const failed = scenario === "turn-failed-internal" || scenario === "junk-failed";
      const providerFailed = scenario === "provider-failed-no-session";
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
      if (scenario === "delta-other-turn" || scenario === "delta-non-string") {
        // A delta for another turn of this thread, or with a non-string delta.
        send({
          method: "item/agentMessage/delta",
          params: {
            threadId,
            turnId: scenario === "delta-other-turn" ? "turn_other" : turnId,
            itemId: "item_a1",
            delta: scenario === "delta-other-turn" ? "FOREIGN-DELTA" : 42,
          },
        });
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
        const { error: _omit, ...rest } = {
          ...turn,
          status: "completed",
          completedAt: 2,
        } as Record<string, unknown>;
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
      if (scenario === "bad-item-id") {
        // "bad-item-id": a well-formed agentMessage item whose id breaks the domain-id grammar.
        send({
          method: "turn/completed",
          params: {
            turn: {
              ...turn,
              status: "completed",
              items: [{ id: "../x", kind: "agentMessage", status: "completed", text: "x" }],
              completedAt: 2,
            },
          },
        });
        return;
      }
      if (scenario === "served-snapshot-only" || scenario === "served-mismatch") {
        // The served-model receipt only in the turn/completed snapshot, or a notification that
        // disagrees with the snapshot.
        if (scenario === "served-mismatch") {
          send({
            method: "item/completed",
            params: { threadId, turnId, item: receipt("item_s1", "model-a") },
          });
        }
        send({
          method: "turn/completed",
          params: {
            turn: {
              ...turn,
              status: "completed",
              items: [...items, receipt("item_s1", "model-b")],
              completedAt: 2,
            },
          },
        });
        return;
      }
      if (scenario === "unknown-kind") {
        // "unknown-kind": a turn whose only item has a kind/status outside the pinned unions.
        send({
          method: "turn/completed",
          params: {
            turn: {
              ...turn,
              status: "completed",
              items: [{ id: "item_x", kind: "unknown", status: "bogus" }],
              completedAt: 2,
            },
          },
        });
        return;
      }
      if (scenario === "completed-with-error") {
        // "completed-with-error": status completed but a provider error attached.
        send({
          method: "turn/completed",
          params: {
            turn: {
              ...turn,
              status: "completed",
              error: { code: -32008, message: "no-credentials" },
              completedAt: 2,
            },
          },
        });
        return;
      }
      if (scenario === "no-thread-turn") {
        // "no-thread-turn": turn/completed whose turn has no threadId at all.
        send({ method: "turn/completed", params: { turn: { id: turnId, status: "completed" } } });
        return;
      }
      if (scenario === "bad-turn") {
        // "bad-turn": turn/completed names the thread but carries no items array.
        send({ method: "turn/completed", params: { turn: { threadId, status: "completed" } } });
        return;
      }
      if (providerFailed) {
        // "provider-failed-no-session": the turn fails -32008 and the session file is gone
        // afterwards, so the post-turn chain verify fails (exit 5 outranks provider 4).
        unlinkSync(sessionFile());
        send({
          method: "turn/completed",
          params: {
            turn: {
              ...turn,
              status: "failed",
              items: [],
              error: { code: -32008, message: "no-credentials" },
              completedAt: 2,
            },
          },
        });
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
      record("turn/interrupt");
      if (scenario === "interrupt-then-hang") {
        append("turn.end", { turnId, status: "interrupted", error: null });
        send({ id: msg.id, result: {} });
        send({
          method: "turn/completed",
          params: { turn: { ...inProgress(), status: "interrupted", completedAt: 2 } },
        });
        keepAlive();
        return;
      }
      if (scenario === "silent-turn" || scenario === "silent-turn-rm") {
        // §3c tests 1/7/8/11: the interrupt is received but never answered; the engine never
        // exits on EOF either (the CLI kills it after 1 s).
        if (scenario === "silent-turn-rm") unlinkSync(sessionFile());
        keepAlive();
        return;
      }
      if (scenario === "silent-turn-junk") {
        // §3c test 16: a non-JSON line during the idle-timeout grace.
        process.stdout.write("this is not json\n");
        keepAlive();
        return;
      }
      if (scenario === "interrupt-completes" || scenario === "interrupt-fails-provider") {
        // §3c test 6: the grace reports a turn outcome; the idle timeout's exit 3 still wins.
        const error =
          scenario === "interrupt-fails-provider"
            ? { code: -32008, message: "no-credentials" }
            : null;
        append("turn.end", { turnId, status: error === null ? "completed" : "failed", error });
        send({ id: msg.id, result: {} });
        send({
          method: "turn/completed",
          params: { turn: completedTurn([agentItem("late reply")], error) },
        });
        return;
      }
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
