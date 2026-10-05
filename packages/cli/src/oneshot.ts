/**
 * Headless one-shot `madc -p` (CLI pin §2): spawn the engine, `initialize`, `thread/start`,
 * `turn/start`, consume items until `turn/completed`, EOF, wait for exit, then re-read and verify
 * the thread's session JSONL for the receipt. No loop, tool or provider code: the engine owns all
 * of that. Statuses are printed verbatim (uppercased); only turn statuses decide the exit code.
 */
import { join } from "node:path";
import { MADC_VERSION } from "@madc/core";
import {
  type EngineClient,
  EngineExitedError,
  EngineProtocolError,
  EngineRpcError,
  type Item,
  PROTOCOL_VERSION,
  spawnEngine,
  type Thread,
  type Turn,
  verifySessionFile,
  type WireMessage,
} from "@madc/engine/client";
import {
  type ReceiptData,
  receiptPlain,
  receiptTierA,
  sanitizeReceiptData,
} from "./app/receipt.ts";
import { glyphsFor, Style } from "./app/style.ts";
import { decideTier } from "./app/tiers.ts";
import type { Verdict } from "./app/verdict.ts";
import {
  classifyMessage,
  isDomainId,
  isErrorBody,
  isItemShape,
  isThreadShape,
  isTurnShape,
  stripControls,
  violationMessage,
} from "./app/wire.ts";
import {
  type Classified,
  classifyCode,
  type ErrorClass,
  type ErrorSite,
  EXIT,
} from "./exit-codes.ts";
import { type CliIO, sleep, TimeoutError, withTimeout } from "./io.ts";
import { claimMode } from "./mode.ts";

/** `classifyMessage` moved to app/wire.ts (shared with the app); re-exported for importers. */
export { classifyMessage };

const DEFAULT_SEAT = "madc-default";
export const PROMPT_CAP_BYTES = 1024 * 1024;
const RESPONSE_TIMEOUT_MS = 30_000;
const INTERRUPT_GRACE_MS = 2_000;
const KILL_AFTER_MS = 1_000;
const CLOSE_TIMEOUT_MS = 5_000;
const NO_TIMEOUT_MS = 2_147_483_647; // max setTimeout delay

type ServedModel = {
  requestedModel: string;
  servedModel: string;
  backing: string;
  providerId: string;
};

type SessionOut =
  | { path: string; seq: number; headHash: string; chain: "verified" }
  | { path: string; seq: number; headHash: string; chain: "unverified"; reason: string }
  | { path: string; seq: null; headHash: null; chain: "failed"; line: number; reason: string }
  | { path: string; seq: null; headHash: null; chain: "unverified"; reason: string };

type ErrorOut = { code: number | null; message: string; class: ErrorClass };

export type OneShotOptions = {
  readonly prompt: string;
  readonly seatId: string | undefined;
  readonly json: boolean;
  readonly home: string;
  /** Turn idle deadline in ms (erratum §3c). Required: `main.ts` fills it from `parseTurnIdleMs`. */
  readonly turnIdleMs: number;
  /** Test-only: request timeout for initialize / thread/start / turn/start (default 30 000 ms). */
  readonly responseTimeoutMs?: number;
};

class Forced extends Error {}
class ProtocolMismatch extends Error {}

/** Read the `-p -` prompt from stdin until EOF (UTF-8), capped at 1 MiB. Null if over the cap. */
export async function readPromptFromStdin(io: CliIO): Promise<string | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of io.stdin) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : (chunk as Buffer);
    total += buf.length;
    if (total > PROMPT_CAP_BYTES) return null;
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function finalText(items: readonly Item[]): string {
  let text = "";
  for (const item of items) {
    if (item.kind === "agentMessage" && item.status === "completed") text = item.text;
  }
  return text;
}

// The wire validators and E11 sanitiser moved to `app/wire.ts` (shared with the Witness app,
// DESIGN-SPEC §5.10 E-d); the imports above keep the same names for every call site below.

function servedModelOf(item: Item | null | undefined): ServedModel | null {
  if (item === null || typeof item !== "object" || item.kind !== "servedModel") return null;
  return {
    requestedModel: item.requestedModel,
    servedModel: item.servedModel,
    backing: item.backing,
    providerId: item.providerId,
  };
}

function sameServed(a: ServedModel | null, b: ServedModel | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.requestedModel === b.requestedModel &&
    a.servedModel === b.servedModel &&
    a.backing === b.backing &&
    a.providerId === b.providerId
  );
}

/** The recorded outcome of the `turn/start` request (erratum §3e E17: value / rejected / pending). */
type TurnStartState =
  | { readonly kind: "pending" }
  | { readonly kind: "value"; readonly value: unknown }
  | { readonly kind: "rejected"; readonly error: EngineRpcError };

/** What the receipt's `turn` line and the session reason show when no turn object is known. */
type TurnStartDisplay = "not-started" | "unknown-no-answer" | "unknown-bad-result";

/**
 * Erratum §3e E17a rule 4: a `rejected` state stands only when the reply that settled `turn/start`
 * was a well-formed error reply. If any message logged since `turn/start` was sent carries an own
 * id, an error body with the same code and message, and an N2 or N4 hit, the settling message was
 * malformed and the state is really `pending` (UNKNOWN, never false evidence).
 */
function refusalSettledByMalformed(
  messages: readonly WireMessage[],
  from: number,
  error: EngineRpcError,
): boolean {
  for (let i = from; i < messages.length; i++) {
    const m = messages[i] as WireMessage;
    if (!Object.hasOwn(m, "id")) continue;
    if (!Object.hasOwn(m, "error") || !isErrorBody(m.error)) continue;
    const body = m.error as { code: number; message: string };
    if (body.code !== error.code || body.message !== error.message) continue;
    const cls = classifyMessage(m);
    if (cls.kind === "n2" || cls.kind === "n4") return true;
  }
  return false;
}

export async function runOneShot(io: CliIO, opts: OneShotOptions): Promise<number> {
  const startedAt = Date.now();
  const responseTimeoutMs = opts.responseTimeoutMs ?? RESPONSE_TIMEOUT_MS;
  const turnIdleMs = opts.turnIdleMs;
  let threadId: string | null = null;
  let turnId: string | null = null;
  let turn: Turn | null = null;
  let served: ServedModel | null = null;
  let error: ErrorOut | null = null;
  let exit: number = EXIT.ok;
  let signalExit: number | null = null;
  // The engine's exit code from `close()`; `null` = killed by a signal (incl. our close timeout).
  let engineExit: number | null | undefined;
  let closeBudgetMs = CLOSE_TIMEOUT_MS;
  let closeTookMs = 0;
  let violationTimer: ReturnType<typeof setInterval> | undefined;
  let malformedItem = false;
  // §3e E1: a malformed error body on a reply (own flag, own message slot), set by the catch
  // branch or by the §3b rule 6 post-close re-check.
  let malformedResponse = false;
  // §3e E5: exit 2 only when the engine exits 2 before the initialize response was received.
  let initAnswered = false;
  // Copilot r4109541728 / Bugbot 4109544363: a malformed or foreign item/delta must END the wait
  // (fail closed, exit 3), not just be remembered: an engine that then goes quiet would otherwise
  // leave the unbounded turn wait hanging forever. `violate()` records it and rejects every step.
  let violateNow: () => void = () => {};
  const itemViolated = new Promise<never>((_, reject) => {
    violateNow = () =>
      reject(
        new ProtocolMismatch("protocol violation: malformed or foreign item/completed or delta"),
      );
  });
  itemViolated.catch(() => undefined);
  const violate = () => {
    malformedItem = true;
    violateNow();
  };
  const pendingDeltas: Array<{ turnId: string; delta: string }> = [];
  const renderDelta = (delta: string) => {
    if (stream) {
      clearStatus();
      io.stdout.write(stripControls(delta));
    }
    streamed += delta;
  };
  const itemTurnIds = new Set<string>();
  const turnStartedIds = new Set<string>();
  // §3e E3: notified servedModel items, matched to the turn/completed snapshot per item id.
  const servedByItemId = new Map<string, ServedModel>();
  let streamed = "";
  const stream = io.stdoutIsTTY && !opts.json;
  const seatId = opts.seatId ?? DEFAULT_SEAT;

  // ---- signals (CLI pin §2 "Interrupt")
  let forceNow: () => void = () => {};
  const forced = new Promise<void>((resolve) => {
    forceNow = resolve;
  });
  let softNow: () => void = () => {};
  const soft = new Promise<void>((resolve) => {
    softNow = resolve;
  });
  let softUsed = false;
  // §3e E15: a first SIGINT before `turn/start` has been sent forces at once; once it is in
  // flight the SIGINT is held (Bugbot 4107608856) and interrupts the turn once its id is known.
  // A second SIGINT forces.
  let turnStartSent = false;
  let sigintPending = false;
  const onSigint = () => {
    signalExit = signalExit ?? EXIT.sigint;
    if (!softUsed && turnId !== null) {
      softUsed = true;
      disarmIdle();
      softNow();
    } else if (!softUsed && !turnStartSent) {
      forceNow();
    } else if (!softUsed && !sigintPending) {
      sigintPending = true;
    } else {
      forceNow();
    }
  };
  const onSigterm = () => {
    signalExit = EXIT.sigterm;
    forceNow();
  };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  // ---- §3c turn idle deadline (monotonic timer, re-armed on valid listed notifications)
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let idleStarted = false;
  let idleTimedOut = false;
  function disarmIdle(): void {
    if (idleTimer === undefined) return;
    clearTimeout(idleTimer);
    idleTimer = undefined;
  }
  const onIdleDeadline = () => {
    idleTimer = undefined;
    // Record first, then mark: the sticky guard in `fail` absorbs later exit-3 fails, not this one.
    fail(
      { exit: EXIT.engine, class: "engine" },
      null,
      `timeout: no engine message for ${turnIdleMs} ms`,
    );
    idleTimedOut = true;
    // The soft interrupt counts as used (a later SIGINT is the second one), then the first-Ctrl-C
    // path runs: turn/interrupt, the 2 s grace, EOF, kill after 1 s.
    softUsed = true;
    softNow();
  };
  const armIdle = () => {
    if (!idleStarted || idleTimedOut) return;
    disarmIdle();
    idleTimer = setTimeout(onIdleDeadline, turnIdleMs);
  };

  const fail = (c: Classified, code: number | null, message: string) => {
    // §3c rule 4: the idle-timeout message is sticky — a later exit-3 fail keeps exit 3 but does
    // not replace it. Every other exit-3 message stays last-writer-wins (no first-cause rule).
    if (idleTimedOut && c.exit === EXIT.engine) {
      exit = EXIT.engine;
      return;
    }
    exit = c.exit;
    error = { code, message, class: c.class };
  };

  // ---- live status line (TTY only): "… <seat> · 1.2s"
  let statusTimer: ReturnType<typeof setInterval> | undefined;
  const clearStatus = () => {
    if (statusTimer === undefined) return;
    clearInterval(statusTimer);
    statusTimer = undefined;
    io.stderr.write("\r\u001b[K");
  };

  // ---- §3e E17: the turn field when the turn/start step ends early
  let tsLogStart = 0;
  let tsState: TurnStartState = { kind: "pending" };
  let turnStartDisplay: TurnStartDisplay = "not-started";

  let client: EngineClient | null = null;
  try {
    client = spawnEngine({
      env: { MADC_HOME: opts.home },
      ...(io.engineEntry !== undefined ? { entry: io.engineEntry } : {}),
    });
    const c = client;
    const exited = c.exited.then((code) => {
      throw new EngineExitedError(code, c.child.signalCode);
    });
    exited.catch(() => undefined);
    // Copilot r4107904955: the client only records a malformed stdout line; it never rejects a
    // waiter. Poll for one so a violating engine that then hangs ends the (otherwise unbounded)
    // turn wait with the protocol exit 3 instead of waiting forever. §3b rule 5: the same poll
    // classifies each new entry of `client.messages` (N2–N4) and ends the current step at once.
    let scannedMessages = 0;
    const violated = new Promise<never>((_, reject) => {
      violationTimer = setInterval(() => {
        if (c.protocolViolations.length > 0) {
          clearInterval(violationTimer);
          reject(new ProtocolMismatch("protocol violation: non-JSON line on engine stdout"));
          return;
        }
        for (; scannedMessages < c.messages.length; scannedMessages++) {
          const cls = classifyMessage(c.messages[scannedMessages]);
          if (cls.kind === "ok") continue;
          clearInterval(violationTimer);
          reject(new ProtocolMismatch(violationMessage(cls)));
          return;
        }
      }, 100);
    });
    violated.catch(() => undefined);
    /** Race a step against a forced signal exit, an early engine exit and a protocol violation. */
    const step = <T>(p: Promise<T>): Promise<T> => {
      p.catch(() => undefined);
      return Promise.race([
        p,
        exited,
        violated,
        itemViolated,
        forced.then(() => {
          throw new Forced();
        }),
      ]);
    };

    let site: ErrorSite = "request";
    try {
      const init = await step(
        withTimeout(
          c.request("initialize", { clientInfo: { name: "madc", version: MADC_VERSION } }),
          responseTimeoutMs,
        ),
      );
      // §3b N7: the initialize result must be an object with the pinned protocolVersion and a
      // well-formed serverInfo (never a raw TypeError for a missing result).
      if (init === null || typeof init !== "object") {
        throw new ProtocolMismatch("protocol violation: initialize returned an invalid result");
      }
      const initResult = init as Record<string, unknown>;
      if (initResult.protocolVersion !== PROTOCOL_VERSION) {
        throw new ProtocolMismatch(`engine speaks ${String(initResult.protocolVersion)}`);
      }
      const serverInfo = initResult.serverInfo;
      if (
        serverInfo === null ||
        typeof serverInfo !== "object" ||
        (serverInfo as Record<string, unknown>).name !== "madc-engine" ||
        typeof (serverInfo as Record<string, unknown>).version !== "string"
      ) {
        throw new ProtocolMismatch("protocol violation: initialize returned an invalid result");
      }
      initAnswered = true;
      c.notify("initialized", {});
      site = "thread/start";
      const started = await step(
        withTimeout(
          c.request("thread/start", {
            cwd: io.cwd,
            ...(opts.seatId !== undefined ? { seatId: opts.seatId } : {}),
          }),
          responseTimeoutMs,
        ),
      );
      // Copilot review 5322990263 ("previously missed"): the id becomes a path component in the
      // receipt verifier, so it must match the pinned grammar; §3b N7 adds the full Thread shape
      // with the seat the CLI asked for. Anything else is a protocol error.
      const startedThread = (started as { thread?: unknown } | undefined)?.thread;
      if (!isThreadShape(startedThread, seatId)) {
        throw new ProtocolMismatch("protocol violation: thread/start returned an invalid thread");
      }
      threadId = startedThread.id;
      site = "request";
      const tid = threadId;
      // Observe every message from here on, in order (deltas are display only).
      const done = c.waitFor((m: WireMessage) => {
        const params = m.params as Record<string, unknown> | undefined;
        if (m.method === "item/agentMessage/delta") {
          // Copilot r4109335573: the delta envelope is validated like item/completed; a malformed
          // or foreign-turn delta is never rendered and is a protocol violation (exit 3).
          if (
            params === undefined ||
            params === null ||
            typeof params !== "object" ||
            params.threadId !== tid ||
            !isDomainId(params.turnId) ||
            !isDomainId(params.itemId) ||
            typeof params.delta !== "string"
          ) {
            violate();
          } else if (turnId === null) {
            // Bugbot 4109381360: before `turn/start` has answered, hold the delta; it is rendered
            // only once its turn id is known to be this turn's (never foreign text on stdout).
            pendingDeltas.push({ turnId: params.turnId, delta: params.delta });
            armIdle();
          } else if (params.turnId !== turnId) {
            violate();
          } else {
            renderDelta(params.delta);
            armIdle();
          }
        } else if (m.method === "item/completed" || m.method === "item/started") {
          // Copilot r4108213460 / r4109051056: the envelope is validated too. This connection has
          // exactly one thread, so an item notification without a well-formed
          // { threadId: <this>, turnId, item } is a protocol violation (exit 3), never silently
          // ignored. The turnId is bound to this turn once `turn/start` has answered (it can
          // arrive first). §3b N5: `item/started` carries an inProgress item (pin §5 lifecycle).
          if (
            params === undefined ||
            params === null ||
            typeof params !== "object" ||
            params.threadId !== tid ||
            !isDomainId(params.turnId) ||
            !isItemShape(params.item) ||
            (m.method === "item/started" && (params.item as Item).status !== "inProgress")
          ) {
            violate();
          } else if (turnId !== null && params.turnId !== turnId) {
            // Once this turn's id is known, a foreign-turn item fails closed at once.
            violate();
          } else {
            itemTurnIds.add(params.turnId);
            const s = servedModelOf(params.item);
            if (s !== null) servedByItemId.set((params.item as Item).id, s);
            armIdle();
          }
        } else if (m.method === "thread/started") {
          // §3b N5: the full Thread shape, for this connection's thread and the asked seat.
          if (
            params === undefined ||
            params === null ||
            typeof params !== "object" ||
            !isThreadShape(params.thread, seatId) ||
            (params.thread as Thread).id !== tid
          ) {
            violate();
          } else {
            armIdle();
          }
        } else if (m.method === "turn/started") {
          // §3b N5: a just-started turn of this thread; bound to this turn's id when it is known
          // (it can arrive before the `turn/start` response, like items).
          const t =
            params === undefined || params === null || typeof params !== "object"
              ? undefined
              : params.turn;
          if (
            !isTurnShape(t) ||
            !isDomainId(t.id) ||
            t.threadId !== tid ||
            t.status !== "inProgress"
          ) {
            violate();
          } else if (turnId !== null && t.id !== turnId) {
            violate();
          } else {
            turnStartedIds.add(t.id);
            armIdle();
          }
        }
        // A one-shot connection has exactly one thread and one turn, so ANY `turn/completed` ends
        // the wait (it can arrive before the `turn/start` response) — §3b rule 7: only the
        // notification (no own `id`); an id-carrying one is N2, never the end of the turn. Its
        // shape, thread and turn id are validated afterwards; a malformed one is a protocol
        // violation, never an endless wait (Copilot r4109123473).
        if (m.method === "turn/completed" && !Object.hasOwn(m, "id")) {
          disarmIdle();
          return true;
        }
        return false;
      }, NO_TIMEOUT_MS);
      done.catch(() => undefined);
      if (stream && io.stderrIsTTY) {
        statusTimer = setInterval(() => {
          const text = `… ${seatId} · ${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
          // P-7: the same pinned text, drawn as a filled pill in tier W; the \r\x1b[K clear is
          // unchanged in every tier (IQ-14).
          io.stderr.write(`\r\u001b[K${statusPill(text, io)}`);
        }, 200);
      }
      if (sigintPending) throw new Forced();
      // §3e E17: keep a reference to the request and record its settlement (value / rejected /
      // pending), so an early end of the step never prints false evidence about the turn.
      tsLogStart = c.messages.length;
      const tsRequest = c.request("turn/start", {
        threadId: tid,
        input: [{ type: "text", text: opts.prompt }],
        // M1-A5 (P3): the one-shot is `-p`, so its claim is always `headless` (`mode.ts`).
        mode: claimMode({
          stdinIsTTY: io.stdinIsTTY === true,
          stdoutIsTTY: io.stdoutIsTTY,
          print: true,
        }),
      });
      turnStartSent = true;
      tsRequest.then(
        (value) => {
          tsState = { kind: "value", value };
        },
        (reason: unknown) => {
          // `rejected` means a well-formed error reply only (E17a); an EngineProtocolError or an
          // EngineExitedError records nothing (the state stays pending).
          if (reason instanceof EngineRpcError) tsState = { kind: "rejected", error: reason };
        },
      );
      const ts = await step(withTimeout(tsRequest, responseTimeoutMs));
      if (!isTurnShape(ts?.turn) || !isDomainId(ts.turn.id) || ts.turn.threadId !== tid) {
        throw new ProtocolMismatch("protocol violation: turn/start returned an invalid turn");
      }
      // Copilot r4109466190: `turn/start` returns the turn as just started. A completed or
      // pre-populated start result would never be followed by `turn/completed`, so it is a
      // protocol violation (exit 3) before any wait, never a hang.
      if (
        ts.turn.status !== "inProgress" ||
        ts.turn.items.length !== 0 ||
        ts.turn.completedAt !== null
      ) {
        throw new ProtocolMismatch(
          "protocol violation: turn/start returned a turn that is not just started",
        );
      }
      turnId = ts.turn.id;
      turn = ts.turn;
      // §3c rule 2: the idle clock starts now that the turn id is known.
      idleStarted = true;
      armIdle();
      for (const d of pendingDeltas.splice(0)) {
        if (d.turnId === turnId) renderDelta(d.delta);
        else violate();
      }
      // Items and turn/started that arrived before `turn/start` answered are bound to this turn
      // now, not at completion (a foreign one followed by silence must not hang).
      for (const id of itemTurnIds) if (id !== turnId) violate();
      for (const id of turnStartedIds) if (id !== turnId) violate();
      if (sigintPending && !softUsed) {
        // SIGINT arrived before the turn existed: now it can be interrupted.
        softUsed = true;
        disarmIdle();
        softNow();
      }
      const outcome = await step(
        Promise.race([done.then((m) => m), soft.then(() => "soft" as const)]),
      );
      let completed: WireMessage | null = outcome === "soft" ? null : outcome;
      if (outcome === "soft") {
        c.request("turn/interrupt", { threadId: tid, turnId }).catch(() => undefined);
        completed = await step(
          Promise.race([done, sleep(INTERRUPT_GRACE_MS).then(() => null)]),
        ).catch((err: unknown) => {
          if (err instanceof EngineExitedError) return null;
          throw err;
        });
      }
      if (completed !== null) {
        // Copilot r4108653874: validate the completed turn before trusting it; a malformed one is
        // a protocol violation (exit 3) and never reaches the receipt / JSON renderers.
        const t = (completed.params as { turn?: unknown } | undefined)?.turn;
        // Copilot r4108865790: it must be THIS turn (id from turn/start, same thread).
        if (isTurnShape(t) && t.id === turnId && t.threadId === tid) {
          turn = t;
          // `turn/completed.items` is authoritative: §3e E3 — each notified servedModel item must
          // match the snapshot item with the same item id, and the receipt uses the LAST
          // servedModel item in snapshot order (several are legal, protocol pin §5).
          const snap = t.items.filter((i) => i.kind === "servedModel");
          for (const [id, s] of servedByItemId) {
            const match = snap.find((i) => i.id === id);
            if (match === undefined || !sameServed(servedModelOf(match), s)) {
              malformedItem = true;
            }
          }
          served = snap.length > 0 ? servedModelOf(snap[snap.length - 1] as Item) : null;
        } else malformedItem = true;
        for (const id of itemTurnIds) if (id !== turnId) malformedItem = true;
      }
    } catch (err) {
      if (err instanceof Forced) {
        // exit code comes from the signal
      } else if (err instanceof EngineProtocolError) {
        // §3e E1: a malformed error body on a reply is a protocol violation (own flag, own
        // message slot; the E1 override re-applies this message after the malformed-item one).
        malformedResponse = true;
        fail(
          { exit: EXIT.engine, class: "engine" },
          null,
          "protocol violation: malformed error response",
        );
      } else if (err instanceof EngineRpcError) {
        fail(classifyCode(err.code, site), err.code, err.message);
      } else if (err instanceof EngineExitedError) {
        // The engine exits 2 on a bad MADC_HOME (usage class) — §3e E5: only before initialize
        // has answered; afterwards an exit 2 is an unexpected engine exit (engine class).
        const usage = err.exitCode === EXIT.usage && !initAnswered;
        fail(
          usage ? { exit: EXIT.usage, class: "usage" } : { exit: EXIT.engine, class: "engine" },
          null,
          `engine exited (code ${String(err.exitCode)}, signal ${String(err.signal)})`,
        );
      } else if (err instanceof TimeoutError || err instanceof ProtocolMismatch) {
        fail({ exit: EXIT.engine, class: "engine" }, null, err.message);
      } else {
        fail({ exit: EXIT.engine, class: "engine" }, null, errorMessage(err));
      }
      // §3e E17 / E17a: the step ended after `turn/start` was sent without a turn object. Read the
      // recorded state once, here: a valid value binds the turn (status verbatim); a well-formed
      // refusal stays NOT STARTED; everything else is UNKNOWN, never false evidence (CLI:16).
      if (turnId === null && turnStartSent) {
        // The state is recorded inside promise callbacks, so the declared type is re-asserted
        // here (control flow alone narrows it to the initial value).
        const state = tsState as TurnStartState;
        if (state.kind === "value") {
          const v = state.value as { turn?: unknown } | undefined;
          const t = v?.turn;
          if (
            threadId !== null &&
            isTurnShape(t) &&
            isDomainId(t.id) &&
            t.threadId === threadId &&
            t.status === "inProgress" &&
            t.items.length === 0 &&
            t.completedAt === null
          ) {
            turnId = t.id;
            turn = t;
          } else {
            turnStartDisplay = "unknown-bad-result";
          }
        } else if (
          state.kind === "rejected" &&
          !refusalSettledByMalformed(c.messages, tsLogStart, state.error)
        ) {
          turnStartDisplay = "not-started";
        } else {
          turnStartDisplay = "unknown-no-answer";
        }
      }
    }
  } catch (err) {
    fail({ exit: EXIT.engine, class: "engine" }, null, `engine spawn failed: ${errorMessage(err)}`);
  } finally {
    clearStatus();
    clearInterval(violationTimer);
    disarmIdle();
    if (client !== null) {
      // After a signal or the idle deadline: close stdin and kill the engine if it is still
      // running after 1 s (§3e E2, §3c rule 4a); otherwise allow the 5 s close.
      closeBudgetMs = signalExit !== null || idleTimedOut ? KILL_AFTER_MS : CLOSE_TIMEOUT_MS;
      const closeStart = Date.now();
      engineExit = await client.close(closeBudgetMs);
      closeTookMs = Date.now() - closeStart;
    }
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }

  // ---- turn outcome → exit (statuses are printed verbatim; only these decide the exit)
  const finalTurn = turn as Turn | null;
  if (error === null && finalTurn !== null) {
    if (finalTurn.status === "completed") {
      exit = EXIT.ok;
    } else if (finalTurn.status === "failed") {
      const code = finalTurn.error?.code ?? null;
      const c =
        code === null ? { exit: EXIT.failure, class: "turn" as const } : classifyCode(code, "turn");
      fail(c, code, finalTurn.error?.message ?? "turn failed");
    } else if (finalTurn.status === "interrupted") {
      fail({ exit: EXIT.failure, class: "interrupted" }, null, "turn interrupted");
    } else {
      fail(
        { exit: EXIT.engine, class: "engine" },
        null,
        `turn did not complete (${finalTurn.status})`,
      );
    }
  }
  // Copilot r4107601276: a turn that completed but an engine that then exits non-zero or has to
  // be killed on close is an unexpected engine exit (exit 3), unless we signalled it ourselves.
  if (exit === EXIT.ok && signalExit === null && engineExit !== undefined && engineExit !== 0) {
    fail(
      { exit: EXIT.engine, class: "engine" },
      null,
      engineExit === null
        ? // §3e E16 F-89: the message is chosen by who killed the engine — an outside signal when
          // the close returned before its own timeout, our close timeout otherwise.
          client !== null && client.child.signalCode !== null && closeTookMs < closeBudgetMs
          ? `engine was killed by ${client.child.signalCode} after the turn`
          : "engine did not exit after stdin closed (killed)"
        : `engine exited with code ${engineExit} after the turn`,
    );
  }
  // Protocol violations override any turn/provider/session class (the pin makes them exit 3;
  // Copilot r4108455720); a signal exit still wins below.
  if (signalExit === null && client !== null && client.protocolViolations.length > 0) {
    fail(
      { exit: EXIT.engine, class: "engine" },
      null,
      "protocol violation: non-JSON line on engine stdout",
    );
  }
  // §3b rule 6: post-close re-check — the live check can lose a race (the client settles a
  // pending request synchronously), so scan every entry of `client.messages` with the
  // classifier. It overrides any exit so far, including 2, 4 and 5, and runs even if the live
  // check already fired. A malformed error body on a reply also sets the E1 flag.
  if (signalExit === null && client !== null) {
    let firstHit: string | null = null;
    for (const m of client.messages) {
      const cls = classifyMessage(m);
      if (cls.kind === "ok") continue;
      if (cls.kind === "n4" && cls.malformedError) malformedResponse = true;
      if (firstHit === null) firstHit = violationMessage(cls);
    }
    if (firstHit !== null) fail({ exit: EXIT.engine, class: "engine" }, null, firstHit);
  }
  if (signalExit === null && malformedItem) {
    fail(
      { exit: EXIT.engine, class: "engine" },
      null,
      "protocol violation: malformed item/completed or turn/completed",
    );
  }
  // §3e E1: the malformed-response override (its own flag and message), directly after the
  // malformed-item override, so that message cannot replace this one.
  if (signalExit === null && malformedResponse) {
    fail(
      { exit: EXIT.engine, class: "engine" },
      null,
      "protocol violation: malformed error response",
    );
  }

  // ---- session receipt: re-read and verify after the engine exited
  let session: SessionOut | null = null;
  if (threadId !== null) {
    // §3e E17: a refused turn/start keeps "no turn was started"; a sent but unanswered or
    // check-failing one is UNKNOWN with its own reason.
    const noTurnReason =
      turnStartDisplay === "unknown-bad-result"
        ? "turn unknown (turn/start result failed checks)"
        : turnStartDisplay === "unknown-no-answer"
          ? "turn unknown (turn/start sent, no answer)"
          : "no turn was started";
    session = verifyThread(opts.home, threadId, finalTurn?.id ?? null, noTurnReason);
    // CLI pin §4: a post-turn chain verify `failed` is exit 5. It outranks a turn failure (1) and
    // a provider failure (4) (Copilot r4109541743); protocol/engine (3) and signals still win.
    if (
      session.chain === "failed" &&
      (exit === EXIT.ok || exit === EXIT.failure || exit === EXIT.provider)
    ) {
      fail(
        { exit: EXIT.session, class: "session" },
        null,
        `chain FAILED line ${session.line}: ${session.reason}`,
      );
    }
  }
  if (signalExit !== null) {
    exit = signalExit;
    const e = error as ErrorOut | null;
    error = {
      code: e?.code ?? null,
      message: e?.message ?? "interrupted by signal",
      class: "interrupted",
    };
  }

  // `turn/completed.items` is authoritative; deltas were display only (Copilot review 5322493871).
  const text = finalTurn === null ? "" : finalText(finalTurn.items);
  const durationMs =
    finalTurn !== null && finalTurn.completedAt !== null
      ? finalTurn.completedAt - finalTurn.startedAt
      : Date.now() - startedAt;

  if (opts.json) {
    const out = {
      ok: exit === EXIT.ok,
      exitCode: exit,
      madcVersion: MADC_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      seatId,
      threadId,
      turn:
        finalTurn === null
          ? null
          : { id: finalTurn.id, status: finalTurn.status, error: finalTurn.error, durationMs },
      text,
      servedModel: served,
      session,
      error,
    };
    io.stdout.write(`${JSON.stringify(out)}\n`);
    return exit;
  }

  // Human mode: engine-supplied text has control characters replaced (§3e E11).
  const cleanText = stripControls(text);
  if (stream) {
    if (streamed === "" && cleanText !== "") io.stdout.write(cleanText);
    if ((streamed || cleanText) !== "" && !(streamed || cleanText).endsWith("\n")) {
      io.stdout.write("\n");
    }
  } else if (cleanText !== "") {
    io.stdout.write(cleanText.endsWith("\n") ? cleanText : `${cleanText}\n`);
  }
  // §3.3/§3.4: the receipt's tier (both-TTY gate for every human stderr line, RQ-1). Piped
  // stdout, --json and TERM=dumb keep today's plain bytes exactly (hard rule 1).
  const tier = decideTier({
    stdoutIsTTY: io.stdoutIsTTY,
    stderrIsTTY: io.stderrIsTTY,
    stdinIsTTY: false,
    columns: io.columns,
    rows: io.rows,
    env: io.env,
    json: opts.json,
    human: true,
  });
  const style = Style.forDepth(tier.depth, tier.ascii);
  const g = glyphsFor(tier.ascii);
  if (threadId !== null) {
    const turnWord = turnStartDisplay === "not-started" ? "NOT STARTED" : "UNKNOWN";
    const data: ReceiptData = {
      turn: finalTurn === null ? null : { status: finalTurn.status, id: finalTurn.id, durationMs },
      turnWord,
      served,
      session,
      error,
      exit,
    };
    if (tier.tier === "W" && io.stderrIsTTY) {
      // One-line verdict instead of the retired card. The pinned receipt rows follow,
      // with the same §6.2 spans tier A uses (bytes of the receipt itself unchanged).
      const line = oneShotVerdictLine(oneShotVerdict(exit, session, finalTurn), session, style, g);
      const clean = sanitizeReceiptData(data);
      const receipt = tier.depth === "none" ? receiptPlain(clean) : receiptTierA(clean);
      io.stderr.write(`${line}\n${receipt}`);
    } else if (tier.tier === "A") {
      // §6.2 spans are chrome: engine values were sanitised at the data boundary, so the
      // assembled receipt must not run through the control-char replacer.
      io.stderr.write(receiptTierA(sanitizeReceiptData(data)));
    } else {
      io.stderr.write(stripControls(receiptPlain(data)));
    }
  } else if (error !== null) {
    const e = error as ErrorOut;
    const messageLine = `madc: ${stripControls(e.class)} error${e.code === null ? "" : ` ${e.code}`}: ${stripControls(e.message)}\n`;
    const exitLine = `exit ${exit}\n`;
    // §6.2: pre-thread message 31, exit digits 1;31 (IQ-5) under the same both-TTY gate. The
    // engine-supplied parts were sanitised above; the spans are chrome and stay.
    if (tier.depth !== "none" && io.stderrIsTTY) {
      io.stderr.write(
        `\u001b[31m${messageLine.replace("\n", "")}\u001b[0m\nexit \u001b[1;31m${exit}\u001b[0m\n`,
      );
    } else {
      io.stderr.write(`${messageLine}${exitLine}`);
    }
  }
  return exit;
}

/** One line, same weight as the chat verdict. No block art. Green only when verified. */
function oneShotVerdictLine(
  verdict: Verdict,
  session: SessionOut | null,
  style: Style,
  g: ReturnType<typeof glyphsFor>,
): string {
  const head = session?.headHash?.slice(0, 12) ?? "";
  const seq = session?.seq;
  let text: string;
  let role: "ok" | "err" | "warn" = "err";
  if (
    verdict.kind === "completed" &&
    session?.chain === "verified" &&
    seq !== null &&
    head !== ""
  ) {
    text = `${g.check} seq ${seq} · head ${head} · chain VERIFIED`;
    role = "ok";
  } else if (session?.chain === "failed") {
    text = `${g.cross} chain FAILED line ${session.line}: ${session.reason}`;
    role = "err";
  } else if (verdict.kind === "unverified") {
    const why = session?.chain === "unverified" ? session.reason : "UNVERIFIED";
    text =
      seq !== null && head !== ""
        ? `${g.warn} seq ${seq} · head ${head} · UNVERIFIED: ${why}`
        : `${g.warn} UNVERIFIED: ${why}`;
    role = "warn";
  } else if (verdict.kind === "exit") {
    text = `${g.cross} engine exited · turn not recorded as ended`;
    role = "err";
  } else {
    text = `${g.cross} chain FAILED`;
    role = "err";
  }
  return style.role(role, text);
}

/** §6.1 verdict rule: COMPLETED only on chain VERIFIED + exit 0; FAILED for turn/chain failure;
 * EXIT n otherwise; UNVERIFIED exit 0 draws the warn title with no big art. */
function oneShotVerdict(exit: number, session: SessionOut | null, turn: Turn | null): Verdict {
  if (exit === EXIT.ok) {
    if (session?.chain === "verified" && turn !== null && turn.status === "completed") {
      return { kind: "completed" };
    }
    return { kind: "unverified" };
  }
  if (turn?.status === "failed" || session?.chain === "failed") return { kind: "failed" };
  return { kind: "exit", code: exit };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** §6.1 P-7: the status text unchanged; tier W adds the accent fill, tier A stays plain.
 * Round 8: the tier decision uses the REAL CliIO terminal facts (TTY flags, columns, rows,
 * env) — the previous call supplied undefined dimensions and forced stdin non-TTY, which
 * selected Level A on every terminal, so the pill never got its tier-W fill. */
export function statusPill(text: string, io: CliIO): string {
  const tier = decideTier({
    stdoutIsTTY: io.stdoutIsTTY,
    stderrIsTTY: io.stderrIsTTY,
    stdinIsTTY: io.stdinIsTTY === true,
    columns: io.columns,
    rows: io.rows,
    env: io.env,
    json: false,
    human: true,
  });
  // Pills are retired. The pinned status text is unchanged in every tier.
  void tier;
  return text;
}

/** Read-only re-read + verify of `sessions/<threadId>.jsonl` (CLI pin §2 `session` line). */
function verifyThread(
  home: string,
  threadId: string,
  turnId: string | null,
  noTurnReason: string,
): SessionOut {
  const path = join(home, "sessions", `${threadId}.jsonl`);
  const v = verifySessionFile(path, threadId, {}, home);
  if (!v.ok)
    return { path, seq: null, headHash: null, chain: "failed", line: v.line, reason: v.reason };
  const last = v.events[v.events.length - 1];
  const seq = last?.seq ?? 0;
  let lastEnd: string | null = null;
  for (const e of v.events) {
    if (e.type === "turn.end") lastEnd = String((e.payload as { turnId?: unknown }).turnId);
  }
  if (turnId === null) {
    return { path, seq, headHash: v.lastHash, chain: "unverified", reason: noTurnReason };
  }
  if (lastEnd !== turnId) {
    return {
      path,
      seq,
      headHash: v.lastHash,
      chain: "unverified",
      reason: "the chain's last turn.end does not name this turn",
    };
  }
  return { path, seq, headHash: v.lastHash, chain: "verified" };
}

// The pinned receipt rows moved to `app/receipt.ts` (shared with the app's exit receipt and
// the tier-W verdict card, DESIGN-SPEC §5.12/§6.1); `receiptPlain` reproduces these bytes.
