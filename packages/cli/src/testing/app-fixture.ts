/**
 * Test fixture: a scripted MULTI-TURN engine for Witness-app tests (stdio JSONL, node:* only,
 * no engine imports — the same constraint as fake-engine.ts). The turn script comes from
 * `MADC_TEST_APP_TURNS` (a JSON array); each `turn/start` pops the next entry:
 *
 *   {"kind":"ok","text":"…"}            turn completes; servedModel receipt; chain intact
 *   {"kind":"ok-batched","text":"…"}    like ok, but the turn/start response, the item
 *                                       notifications and turn/completed arrive in ONE stdout
 *                                       write — a deterministic cutoff-race repro (the wait
 *                                       snapshot must be taken before the request)
 *   {"kind":"failed","code":-32603}     turn ends failed with the given code (exit-class 1)
 *   {"kind":"interrupted"}              turn ends interrupted right away
 *   {"kind":"late-end"}                 turn.end names ANOTHER turn id (verify passes, UNVERIFIED)
 *   {"kind":"corrupt"}                  after this turn, the session file is tampered with
 *   {"kind":"corrupt-last"}             like corrupt, but the LAST turn.end line is tampered
 *                                       (an earlier verified turn's range stays intact)
 *   {"kind":"tool"}                     emits toolCall + toolResult items before the agent text
 *   {"kind":"engine-exit"}              the process exits 3 mid-turn (engine gone)
 *
 * The session JSONL is a real seat-pin §4.3 hash chain, so the app's real verify worker runs
 * against it; `corrupt` rewrites one line so the next read-only verify fails (R-b red break).
 */
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

type TurnScript =
  | { readonly kind: "ok"; readonly text?: string }
  | { readonly kind: "ok-batched"; readonly text?: string }
  | { readonly kind: "ctrl" }
  | { readonly kind: "served-ctrl" }
  | { readonly kind: "rpc-fail-ctrl"; readonly code?: number }
  | { readonly kind: "bad-tool-item" }
  | { readonly kind: "failed"; readonly code: number }
  | { readonly kind: "interrupted" }
  | { readonly kind: "hold" }
  | { readonly kind: "malformed-item"; readonly live?: boolean; readonly followUp?: boolean }
  | { readonly kind: "foreign-completion"; readonly live?: boolean }
  | { readonly kind: "delta-spaced" }
  | { readonly kind: "sustained-unknown" }
  | { readonly kind: "spaced" }
  | { readonly kind: "unknown-note" }
  | { readonly kind: "late-end" }
  | { readonly kind: "corrupt" }
  | { readonly kind: "corrupt-last" }
  | { readonly kind: "tool" }
  | { readonly kind: "engine-exit" };

const script: TurnScript[] = JSON.parse(process.env.MADC_TEST_APP_TURNS ?? "[]") as TurnScript[];
/** Once-per-run thread/start failure mode: rpc-2 | rpc-5 | malformed | die (test-only). */
const threadStartMode = process.env.MADC_TEST_THREAD_START ?? "";
const home = process.env.MADC_HOME ?? "";
/** True when this module is imported only for its exported helpers (a test asserts the
 * thread-id encoding without spawning anything): the readline wiring — the module's only
 * runtime side effect — is skipped. Spawned child engines never set this variable. */
const helpersOnly = process.env.MADC_TEST_FIXTURE_HELPERS_ONLY === "1";
/** Thread id minted from an engine process id: a restarted engine (fresh process, same
 * home) must not append a fresh seq-0 chain into the dead engine's session file. The
 * encoding is LOSSLESS — `thr_app` + the decimal pid, zero-padded to at least six digits —
 * so tests can read the owning engine's pid back out of an app-visible thread id for any
 * pid, seven-digit ones included (no modulo, no truncation). */
export const fixtureThreadId = (pid: number): string => `thr_app${String(pid).padStart(6, "0")}`;
const threadId = fixtureThreadId(process.pid);
const seatId = "madc-default";
const sessionFile = join(home, "sessions", `${threadId}.jsonl`);
const send = (m: unknown): void => {
  process.stdout.write(`${JSON.stringify(m)}\n`);
};
const sendChunk = (...messages: unknown[]): void => {
  process.stdout.write(`${messages.map((m) => JSON.stringify(m)).join("\n")}\n`);
};

/** Seat pin §4.3 chain, node:* only (the CLI may not import engine code). */
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
  const body = { v: 1, seq, ts: 1 + seq, type, threadId, seatId, payload };
  const hash = createHash("sha256")
    .update(`${prevHash}\n${sortedKeyJson(body)}`, "utf8")
    .digest("hex");
  const { payload: p, ...head } = body;
  appendFileSync(sessionFile, `${JSON.stringify({ ...head, prevHash, hash, payload: p })}\n`);
  prevHash = hash;
  seq++;
}

const keepAlive = (): void => {
  const timer = setInterval(() => undefined, 1_000);
  timer.unref?.();
};

/** The interrupt-answer mode: the fixture exits cleanly on EOF after answering an interrupt. */
const interruptAnswer = process.env.MADC_TEST_APP_INTERRUPT_ANSWER === "1";

let turnCounter = 0;
const rl = helpersOnly ? null : createInterface({ input: process.stdin });
rl?.on("close", () => {
  if (interruptAnswer) process.exit(0); // answered-interrupt sessions end cleanly on EOF
  // Stay alive after EOF like the one-shot fixtures: the CLI's close kills us.
  keepAlive();
});

function inProgress(turnId: string): Record<string, unknown> {
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

const agentItem = (id: string, text: string): Record<string, unknown> => ({
  id,
  kind: "agentMessage",
  status: "completed",
  text,
});
/** M1 protocol pin §5 P2 fields the session verifier requires on every servedModel receipt. */
const RECEIPT_P2 = {
  lane: "allowed-direct",
  mode: "headless",
  fallbackFrom: null,
  vendorReported: true,
} as const;

const servedItemCtrl = (id: string): Record<string, unknown> => ({
  id,
  kind: "servedModel",
  status: "completed",
  requestedModel: "kimi-coding/kimi-for-coding",
  servedModel: "kimi-for-\u001b[31mcoding\u0007",
  backing: "kimi-code",
  providerId: "kimi-code",
  ...RECEIPT_P2,
});

const servedItem = (id: string): Record<string, unknown> => ({
  id,
  kind: "servedModel",
  status: "completed",
  requestedModel: "kimi-coding/kimi-for-coding",
  servedModel: "kimi-for-coding",
  backing: "kimi-code",
  providerId: "kimi-code",
  ...RECEIPT_P2,
});

function servedDiskPayload(turnId: string, item: Record<string, unknown>): Record<string, unknown> {
  return {
    turnId,
    requestedModel: item.requestedModel,
    servedModel: item.servedModel,
    backing: item.backing,
    providerId: item.providerId,
    lane: item.lane,
    mode: item.mode,
    fallbackFrom: item.fallbackFrom,
    vendorReported: item.vendorReported,
  };
}

rl?.on("line", (line) => {
  const msg = JSON.parse(line) as { id?: number; method: string; params?: Record<string, unknown> };
  if (msg.id === undefined) return;
  switch (msg.method) {
    case "initialize": {
      send({
        id: msg.id,
        result: {
          serverInfo: { name: "madc-engine", version: "0.0.0" },
          protocolVersion: "madc-m1/1",
        },
      });
      return;
    }
    case "thread/start": {
      // thread/start failure modes (classification + E11 tests): answered BEFORE any session
      // file exists. rpc-2 carries C0/C1 controls in the message; malformed answers a
      // well-formed non-thread result; die exits before responding.
      if (threadStartMode === "rpc-2") {
        send({
          id: msg.id,
          error: { code: -32005, message: "seat bad\u001b[31mred\u0007bell\u001b[2Kgone" },
        });
        return;
      }
      if (threadStartMode === "rpc-5") {
        send({ id: msg.id, error: { code: -32009, message: "sessions/ not writable" } });
        return;
      }
      if (threadStartMode === "malformed") {
        send({ id: msg.id, result: { thread: { id: "thr_../escape" } } });
        return;
      }
      if (threadStartMode === "die") {
        process.exit(3);
      }
      mkdirSync(join(home, "sessions"), { recursive: true });
      if (seq === 0) {
        append("session.open", {
          cwd: null,
          backing: "kimi-code",
          providerId: "kimi-code",
          pinnedModel: "kimi-coding/kimi-for-coding",
        });
      }
      send({
        id: msg.id,
        result: {
          thread: {
            id: threadId,
            seatId,
            cwd: null,
            createdAt: 1,
            updatedAt: 1,
            status: "active",
            preview: "",
          },
        },
      });
      send({ method: "thread/started", params: { thread: { id: threadId, seatId } } });
      return;
    }
    case "turn/start": {
      const turnId = `turn_app${String(turnCounter).padStart(4, "0")}`;
      turnCounter++;
      const step = script.shift() ?? { kind: "ok", text: "fixture reply" };
      if (step.kind === "hold") {
        // The turn starts and then goes silent until turn/interrupt arrives (the app's Ctrl-C).
        append("turn.start", { turnId, inputText: "hi" });
        send({ id: msg.id, result: { turn: inProgress(turnId) } });
        keepAlive();
        return;
      }
      if (step.kind === "malformed-item") {
        // Correction-round repro (live delivery escape): a malformed item notification — the
        // item id fails the domain-id grammar, so the consumers' wait matcher classifies it.
        // live: a SEPARATE stdout write while the client's wait is already pending (delivery
        // through the readline callback); otherwise response + malformed item arrive in ONE
        // write (already-buffered history at the wait's cutoff).
        // followUp: a VALID item arrives 150 ms later — post-settlement activity that must
        // not rearm the settled turn's idle timer or mutate its record (cleanup proof).
        append("turn.start", { turnId, inputText: "hi" });
        const malformed = {
          method: "item/completed",
          params: {
            threadId,
            turnId,
            item: { id: "item_../escape", kind: "agentMessage", status: "completed", text: "x" },
          },
        };
        if (step.live === true) {
          send({ id: msg.id, result: { turn: inProgress(turnId) } });
          setTimeout(() => send(malformed), 40);
        } else {
          sendChunk({ id: msg.id, result: { turn: inProgress(turnId) } }, malformed);
        }
        if (step.followUp === true) {
          // A VALID servedModel item arrives 150 ms later — post-settlement activity that
          // must not rearm the settled turn's idle timer or mutate its record: a served row
          // is observable in inline's /receipt re-render (proof the waiter still ran).
          setTimeout(
            () =>
              send({
                method: "item/completed",
                params: {
                  threadId,
                  turnId,
                  item: servedItem(`item_fu${turnCounter}`),
                },
              }),
            150,
          );
        }
        keepAlive();
        return;
      }
      if (step.kind === "foreign-completion") {
        // Correction-round repro: a well-ENVELOPED turn/completed naming ANOTHER turn id on
        // this thread — foreign, so the consumer must take the controlled violation path
        // (live delivery in its own write, or buffered in the same write as the response).
        append("turn.start", { turnId, inputText: "hi" });
        const foreign = {
          method: "turn/completed",
          params: {
            turn: {
              id: "turn_other999",
              threadId,
              status: "completed",
              items: [agentItem(`item_o${turnCounter}`, "not this turn")],
              error: null,
              startedAt: 1,
              completedAt: 2,
            },
          },
        };
        if (step.live === true) {
          send({ id: msg.id, result: { turn: inProgress(turnId) } });
          setTimeout(() => send(foreign), 40);
        } else {
          sendChunk({ id: msg.id, result: { turn: inProgress(turnId) } }, foreign);
        }
        keepAlive();
        return;
      }
      if (step.kind === "delta-spaced") {
        // Correction-round repro (delta activity): validated streaming deltas spaced well
        // past a short inactivity deadline, then the completion — only consumers that reset
        // the deadline on VALIDATED deltas (after identity checks) complete this turn.
        append("turn.start", { turnId, inputText: "hi" });
        send({ id: msg.id, result: { turn: inProgress(turnId) } });
        const delta = (n: 1 | 2, at: number): void => {
          setTimeout(
            () =>
              send({
                method: "item/agentMessage/delta",
                params: { threadId, turnId, itemId: `item_x${n}`, delta: `part${n} ` },
              }),
            at,
          );
        };
        delta(1, 250);
        delta(2, 500);
        const finalDelta = [
          agentItem(`item_a${turnCounter}`, "streamed reply"),
          servedItem(`item_s${turnCounter}`),
        ];
        setTimeout(() => {
          send({
            method: "turn/completed",
            params: {
              turn: {
                id: turnId,
                threadId,
                status: "completed",
                items: finalDelta,
                error: null,
                startedAt: 1,
                completedAt: 2,
              },
            },
          });
          for (const item of finalDelta) {
            if (item.kind === "servedModel") {
              append("servedModel", servedDiskPayload(turnId, item));
            } else {
              append("item", { turnId, item });
            }
          }
          append("turn.end", { turnId, status: "completed", error: null });
        }, 750);
        keepAlive();
        return;
      }
      if (step.kind === "sustained-unknown") {
        // Correction-round companion: well-formed UNKNOWN notifications arriving
        // continuously — none of them may extend the inactivity deadline.
        append("turn.start", { turnId, inputText: "hi" });
        send({ id: msg.id, result: { turn: inProgress(turnId) } });
        for (const at of [100, 200, 300]) {
          setTimeout(() => send({ method: "thread/updated", params: { threadId } }), at);
        }
        keepAlive();
        return;
      }
      if (step.kind === "spaced") {
        // Correction-round repro (idle-deadline class): validated item notifications spaced
        // so a total-turn deadline fires before the completion, while a deadline rearmed on
        // each validated notification completes comfortably.
        append("turn.start", { turnId, inputText: "hi" });
        send({ id: msg.id, result: { turn: inProgress(turnId) } });
        const partNote = (n: 1 | 2) => ({
          method: "item/completed",
          params: {
            threadId,
            turnId,
            item: agentItem(`item_d${n}_${turnCounter}`, `part ${n}`),
          },
        });
        setTimeout(() => send(partNote(1)), 250);
        setTimeout(() => send(partNote(2)), 500);
        const finalSpaced = [
          agentItem(`item_a${turnCounter}`, "spaced reply"),
          servedItem(`item_s${turnCounter}`),
        ];
        setTimeout(() => {
          send({
            method: "turn/completed",
            params: {
              turn: {
                id: turnId,
                threadId,
                status: "completed",
                items: finalSpaced,
                error: null,
                startedAt: 1,
                completedAt: 2,
              },
            },
          });
          for (const item of finalSpaced) {
            if (item.kind === "servedModel") {
              append("servedModel", servedDiskPayload(turnId, item));
            } else {
              append("item", { turnId, item });
            }
          }
          append("turn.end", { turnId, status: "completed", error: null });
        }, 750);
        keepAlive();
        return;
      }
      if (step.kind === "unknown-note") {
        // Correction-round companion: a well-formed UNKNOWN notification (envelope-ok, method
        // the consumers do not handle) must NOT reset the inactivity deadline.
        append("turn.start", { turnId, inputText: "hi" });
        send({ id: msg.id, result: { turn: inProgress(turnId) } });
        setTimeout(() => send({ method: "thread/updated", params: { threadId } }), 100);
        keepAlive();
        return;
      }
      if (step.kind === "rpc-fail-ctrl") {
        // E11 catch-path repro: the turn END failed with an RPC error body whose message
        // carries C0/C1 controls — the consumers' turn-wait catch (EngineRpcError path or
        // the malformed-completion path) stores that message into the turn record and
        // session codes; every render of it must carry U+FFFD, never a raw ESC.
        append("turn.start", { turnId, inputText: "hi" });
        send({ id: msg.id, result: { turn: inProgress(turnId) } });
        send({
          method: "turn/completed",
          params: {
            turn: {
              id: turnId,
              threadId,
              status: "failed",
              items: [],
              error: {
                code: step.code ?? -32008,
                message: "provider refused: \u001b[31mred\u0007bell\u001b[2Kgone",
              },
              startedAt: 1,
              completedAt: 2,
            },
          },
        });
        append("turn.end", { turnId, status: "failed", error: null });
        return;
      }
      if (step.kind === "bad-tool-item") {
        // Wire-validation repro (isItemShape per-kind fields): a well-enveloped
        // item/completed for a toolResult whose kind-specific fields are wrong types. The
        // wait matchers must classify it as a protocol violation — never push it into the
        // turn record where the renderers call `output.split` on a non-string.
        append("turn.start", { turnId, inputText: "hi" });
        const bad = {
          method: "item/completed",
          params: {
            threadId,
            turnId,
            item: {
              id: `item_t${turnCounter}`,
              kind: "toolResult",
              status: "completed",
              callId: 7,
              name: "read_file",
              output: 42,
              isError: "false",
            },
          },
        };
        sendChunk({ id: msg.id, result: { turn: inProgress(turnId) } }, bad);
        keepAlive();
        return;
      }
      if (step.kind === "engine-exit") {
        // die-once: the first engine process dies; a restarted engine (fresh process, same
        // home) sees the marker and completes the turn normally — for restart tests.
        if (process.env.MADC_TEST_DIE_ONCE === "1") {
          const marker = join(home, ".die-once");
          try {
            readFileSync(marker);
            // marker exists: this is the restarted engine — fall through to a normal turn.
          } catch {
            writeFileSync(marker, "1");
            send({ id: msg.id, result: { turn: inProgress(turnId) } });
            append("turn.start", { turnId, inputText: "hi" });
            setTimeout(() => process.exit(3), 30);
            return;
          }
        } else {
          send({ id: msg.id, result: { turn: inProgress(turnId) } });
          append("turn.start", { turnId, inputText: "hi" });
          setTimeout(() => process.exit(3), 30);
          return;
        }
      }
      append("turn.start", { turnId, inputText: "hi" });
      const items: Record<string, unknown>[] = [];
      if (step.kind === "tool") {
        items.push({
          id: `item_c${turnCounter}`,
          kind: "toolCall",
          status: "completed",
          name: "read_file",
          arguments: { path: "docs/plan/PIN-madc-M0-cli.md" },
        });
        items.push({
          id: `item_r${turnCounter}`,
          kind: "toolResult",
          status: "completed",
          callId: `item_c${turnCounter}`,
          name: "read_file",
          output: "235 lines · §4 Exit codes, lines 182-195",
          isError: false,
        });
      }
      const error = step.kind === "failed" ? { code: step.code, message: "fixture failure" } : null;
      const endTurnId = step.kind === "late-end" ? "turn_other000" : turnId;
      if (step.kind === "interrupted") {
        sendChunk(
          { id: msg.id, result: { turn: inProgress(turnId) } },
          {
            method: "turn/completed",
            params: { turn: { ...inProgress(turnId), status: "interrupted", completedAt: 2 } },
          },
        );
        append("turn.end", { turnId: endTurnId, status: "interrupted", error: null });
        return;
      }
      const agentText =
        step.kind === "ctrl"
          ? "clean\u001b[31mred\u0007bell\u001b[2Kgone"
          : step.kind === "ok" || step.kind === "ok-batched"
            ? (step.text ??
              "Exit 2 is a usage or config error: bad flags, empty or oversize prompt.")
            : "x";
      const finalItems =
        step.kind === "failed"
          ? items
          : [
              ...items,
              agentItem(`item_a${turnCounter}`, agentText),
              step.kind === "served-ctrl"
                ? servedItemCtrl(`item_s${turnCounter}`)
                : servedItem(`item_s${turnCounter}`),
            ];
      // The corrupt scenario tampers BEFORE turn/completed reaches the client, so the client's
      // read-only verify cannot win the race against the tamper.
      if (step.kind === "corrupt" || step.kind === "corrupt-last") {
        send({ id: msg.id, result: { turn: inProgress(turnId) } });
        append("turn.end", { turnId: endTurnId, status: "completed", error: null });
        try {
          const text = readFileSync(sessionFile, "utf8");
          const lines = text.split("\n");
          // corrupt hits the FIRST turn.end line; corrupt-last the LAST — the R-b test needs a
          // tamper that lands after an earlier verified turn's remembered range.
          const hits = lines
            .map((l, i) => (l.includes('"turn.end"') ? i : -1))
            .filter((i) => i >= 0);
          const idx =
            step.kind === "corrupt-last" ? (hits[hits.length - 1] ?? -1) : (hits[0] ?? -1);
          if (idx >= 0 && lines[idx] !== undefined) {
            lines[idx] = `${lines[idx].slice(0, -4)}beef}`;
            writeFileSync(sessionFile, lines.join("\n"));
          }
        } catch {
          // never block the fixture on tamper
        }
        send({
          method: "turn/completed",
          params: {
            turn: {
              id: turnId,
              threadId,
              status: "completed",
              items: finalItems,
              error: null,
              startedAt: 1,
              completedAt: 2,
            },
          },
        });
        return;
      }
      if (step.kind === "ok-batched") {
        // Deterministic cutoff repro: response + item notifications + completion in ONE
        // stdout write, so they all land before the caller's post-request code runs.
        sendChunk(
          { id: msg.id, result: { turn: inProgress(turnId) } },
          ...finalItems.map((item) => ({
            method: "item/completed",
            params: { threadId, turnId, item },
          })),
          {
            method: "turn/completed",
            params: {
              turn: {
                id: turnId,
                threadId,
                status: "completed",
                items: finalItems,
                error: null,
                startedAt: 1,
                completedAt: 2,
              },
            },
          },
        );
      } else {
        send({ id: msg.id, result: { turn: inProgress(turnId) } });
        for (const item of finalItems) {
          send({
            method: "item/completed",
            params: { threadId, turnId, item },
          });
        }
        send({
          method: "turn/completed",
          params: {
            turn: {
              id: turnId,
              threadId,
              status: error === null ? "completed" : "failed",
              items: finalItems,
              error,
              startedAt: 1,
              completedAt: 2,
            },
          },
        });
      }
      // Persist the items the way the real engine does (§0.2): an `item` event per completed
      // item and the servedModel receipt as its own event — the disk shape the app's §5.7
      // evidence (per-turn ranges, served seq) derives from the read-only verify.
      for (const item of finalItems) {
        if (item.kind === "servedModel") {
          append("servedModel", servedDiskPayload(turnId, item));
        } else {
          append("item", { turnId, item });
        }
      }
      append("turn.end", {
        turnId: endTurnId,
        status: error === null ? "completed" : "failed",
        error,
      });
      return;
    }
    case "turn/interrupt": {
      if (process.env.MADC_TEST_APP_INTERRUPT_ANSWER === "1") {
        // Answer the interrupt: the turn ends interrupted, like the app's Ctrl-C path expects.
        const turnId = `turn_app${String(Math.max(0, turnCounter - 1)).padStart(4, "0")}`;
        append("turn.end", { turnId, status: "interrupted", error: null });
        send({ id: msg.id, result: {} });
        send({
          method: "turn/completed",
          params: { turn: { ...inProgress(turnId), status: "interrupted", completedAt: 2 } },
        });
        return;
      }
      send({ id: msg.id, result: {} });
      return;
    }
    default:
      send({ id: msg.id, error: { code: -32601, message: "Method not found" } });
  }
});
