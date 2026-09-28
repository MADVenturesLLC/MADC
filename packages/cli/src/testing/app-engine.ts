/**
 * Test fixture: a scripted MULTI-TURN engine for Witness-app tests (stdio JSONL, node:* only,
 * no engine imports — the same constraint as fake-engine.ts). The turn script comes from
 * `MADC_TEST_APP_TURNS` (a JSON array); each `turn/start` pops the next entry:
 *
 *   {"kind":"ok","text":"…"}            turn completes; servedModel receipt; chain intact
 *   {"kind":"failed","code":-32603}     turn ends failed with the given code (exit-class 1)
 *   {"kind":"interrupted"}              turn ends interrupted right away
 *   {"kind":"late-end"}                 turn.end names ANOTHER turn id (verify passes, UNVERIFIED)
 *   {"kind":"corrupt"}                  after this turn, the session file is tampered with
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
  | { readonly kind: "ctrl" }
  | { readonly kind: "served-ctrl" }
  | { readonly kind: "failed"; readonly code: number }
  | { readonly kind: "interrupted" }
  | { readonly kind: "hold" }
  | { readonly kind: "late-end" }
  | { readonly kind: "corrupt" }
  | { readonly kind: "tool" }
  | { readonly kind: "engine-exit" };

const script: TurnScript[] = JSON.parse(process.env.MADC_TEST_APP_TURNS ?? "[]") as TurnScript[];
/** Once-per-run thread/start failure mode: rpc-2 | rpc-5 | malformed | die (test-only). */
const threadStartMode = process.env.MADC_TEST_THREAD_START ?? "";
const home = process.env.MADC_HOME ?? "";
// Per-process thread id: a restarted engine (fresh process, same home) must not append a
// fresh seq-0 chain into the dead engine's session file.
const threadId = `thr_app${String(process.pid % 1_000_000).padStart(6, "0")}`;
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
const rl = createInterface({ input: process.stdin });
rl.on("close", () => {
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
const servedItemCtrl = (id: string): Record<string, unknown> => ({
  id,
  kind: "servedModel",
  status: "completed",
  requestedModel: "kimi-coding/kimi-for-coding",
  servedModel: "kimi-for-\u001b[31mcoding\u0007",
  backing: "kimi-code",
  providerId: "kimi-code",
});

const servedItem = (id: string): Record<string, unknown> => ({
  id,
  kind: "servedModel",
  status: "completed",
  requestedModel: "kimi-coding/kimi-for-coding",
  servedModel: "kimi-for-coding",
  backing: "kimi-code",
  providerId: "kimi-code",
});

rl.on("line", (line) => {
  const msg = JSON.parse(line) as { id?: number; method: string; params?: Record<string, unknown> };
  if (msg.id === undefined) return;
  switch (msg.method) {
    case "initialize": {
      send({
        id: msg.id,
        result: {
          serverInfo: { name: "madc-engine", version: "0.0.0" },
          protocolVersion: "madc-m0/1",
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
          : step.kind === "ok"
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
      if (step.kind === "corrupt") {
        send({ id: msg.id, result: { turn: inProgress(turnId) } });
        append("turn.end", { turnId: endTurnId, status: "completed", error: null });
        try {
          const text = readFileSync(sessionFile, "utf8");
          const lines = text.split("\n");
          const idx = lines.findIndex((l) => l.includes('"turn.end"'));
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
