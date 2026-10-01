/**
 * Line-mode app (DESIGN-SPEC rev 6.2 §5.0 tier A, §6.3): one plain identity line, a `>` prompt,
 * agent text to stdout, the §6.2 receipt after each turn to stderr, doctor WARN/FAIL rows at
 * launch. No alternate screen, no cursor addressing. `MADC_UI=lines` also selects it (Q7).
 */

import * as readline from "node:readline";
import { MADC_VERSION } from "@madc/core";
import {
  DEFAULT_SEAT_ID,
  type EngineClient,
  EngineExitedError,
  EngineProtocolError,
  PROTOCOL_VERSION,
  spawnEngine,
} from "@madc/engine/client";
import type { Check } from "../doctor.ts";
import { EXIT } from "../exit-codes.ts";
import type { CliIO } from "../io.ts";
import { claimMode } from "../mode.ts";
import { buildReceiptData } from "./app-receipt.ts";
import { receiptPlain, receiptTierA, sanitizeReceiptData } from "./receipt.ts";
import { sanitizeErrorLike, sanitizeItem, sanitizeText, stripControls } from "./sanitize.ts";
import type { TurnRecord } from "./state.ts";
import { worstExit } from "./state.ts";
import { glyphsFor, Style } from "./style.ts";
import { asciiForced, colorDepth } from "./tiers.ts";
import {
  runVerifyBounded,
  VERIFY_DEADLINE_MS,
  type VerifyOutcome,
  type VerifyRequest,
} from "./verify.ts";
import {
  classifyMessage,
  classifyThreadStartFailure,
  isDomainId,
  isItemShape,
  isThreadShape,
  isTurnShape,
  violationMessage,
} from "./wire.ts";

export type LineModeOptions = {
  readonly io: CliIO;
  readonly home: string;
  readonly turnIdleMs: number;
  readonly firstPrompt: string | null;
  /** M1-A8 (`madc -s <seatId>`): the seat the thread opens on. Default madc-default. */
  readonly seatId?: string;
  readonly why: string;
  readonly launchWarnRows: readonly Check[];
  /**
   * PR #35 round 7 (Copilot r4136803817/r4136804256): the mode EXPOSES its signal handlers
   * upward through this callback, so the production entry's process listeners can forward
   * SIGINT/SIGTERM/SIGHUP to the SELECTED mode (Level A has no raw-mode Ctrl-C of its own;
   * these handlers ARE its signal behaviour: SIGINT/SIGTERM quit by interrupt 130/143 with
   * the §5.13 lines, SIGHUP hands back to the entry's re-raise hook, O-4).
   */
  readonly exposeSignals?:
    | ((h: { onSigint(): void; onSigterm(): void; onSighup(): void }) => void)
    | undefined;
  readonly onExit?: ((code: number) => void) | undefined;
  readonly onSighup?: (() => void) | undefined;
  readonly verify?: ((req: VerifyRequest) => Promise<VerifyOutcome>) | undefined;
};

export async function runLineModeApp(opts: LineModeOptions): Promise<number> {
  const io = opts.io;
  const style = Style.forDepth(
    io.env.NO_COLOR !== undefined || io.env.TERM === "dumb" ? "none" : colorDepth(io.env),
    asciiForced(io.env),
  );
  const g = glyphsFor(style.ascii);
  const seatId = opts.seatId ?? DEFAULT_SEAT_ID;
  io.stdout.write(
    `madc ${MADC_VERSION} · ${PROTOCOL_VERSION} · ${seatId} · line mode (${opts.why})\n`,
  );
  for (const row of opts.launchWarnRows) {
    io.stderr.write(`${stripControls(row.summary)}\n`);
  }
  let exitCode = 0;
  const turns: TurnRecord[] = [];
  const sessionCodes: { code: number; reason: string }[] = [];
  let threadId: string | null = null;
  let client: EngineClient | null = null;
  const verify =
    opts.verify ??
    ((req: VerifyRequest) => runVerifyBounded({ ...req, deadlineMs: VERIFY_DEADLINE_MS }));

  const finish = (): number => {
    const worst = worstExit({
      turns,
      sessionCodes,
      signal: null,
      finalVerifyFailedAfterSignal: false,
    }).code;
    return worst;
  };

  const rl = readline.createInterface({
    input: io.stdin,
    terminal: io.stdinIsTTY === true,
    prompt: "> ",
  });
  // Track closure through the SUPPORTED close event (TS2551: `Interface` has no `closed`).
  let rlClosed = false;
  rl.on("close", () => {
    rlClosed = true;
  });
  // §6.3 (round 7, Copilot r4136803909): the pinned `> ` prompt must be VISIBLE — readline
  // only emits it to its OWN output stream, which this interface was never given, so
  // rl.prompt() writes nothing. The prompt is emitted through the CliIO output contract
  // instead: a bare "> " (the preceding line's newline puts it at a line start; in terminal
  // mode the cursor sits after it awaiting input). Printed once at start and again after
  // each queued line's turn settles.
  const showPrompt = (): void => {
    if (rlClosed) return;
    try {
      io.stdout.write("> ");
    } catch {
      // a stream that already errored: the prompt is cosmetic, never fatal
    }
  };
  showPrompt();
  let releaseQuitting: (() => void) | null = null;
  const quitting = new Promise<"quit">((resolve) => {
    releaseQuitting = () => resolve("quit");
  });
  quitting.catch(() => undefined);
  const quit = (code: number): void => {
    exitCode = code;
    releaseQuitting?.();
    rl.close();
  };
  // Round 7 (§5.13 / §17 M-2 (d)): Level A's signal behaviour, exposed upward for the
  // production entry's process listeners. The signal is RECORDED and the §5.13 first line
  // prints at signal time, but the exit status is computed and printed ONCE at the end —
  // after the queued turns drain, the engine shuts down and every verification settles —
  // so the shared worstExit ranking (a recorded 2/3/5 outranks 130/143; O-3: a verify that
  // fails after the signal records 5) decides the printed line AND the returned status.
  let recordedSignal: "SIGINT" | "SIGTERM" | null = null;
  // O-3: a verification that fails AFTER the signal records class 5, which outranks the
  // raw signal code in the final status (worstExit's finalVerifyFailedAfterSignal input).
  let chainFailedAfterSignal = false;
  const noteSessionCode = (code: number): void => {
    if (recordedSignal !== null && code === EXIT.session) chainFailedAfterSignal = true;
  };
  const sigintQuit = (): void => {
    if (rlClosed || recordedSignal !== null) return; // already settled: no second line pair
    recordedSignal = "SIGINT";
    rl.close();
    releaseQuitting?.();
  };
  const sigtermQuit = (): void => {
    if (rlClosed || recordedSignal !== null) return; // already settled: no second line pair
    recordedSignal = "SIGTERM";
    rl.close();
    releaseQuitting?.();
  };
  const sighupRaise = (): void => {
    // O-4 (ruled): no app exit code for SIGHUP — the best-effort line, close the input,
    // then the ENTRY re-raises the signal so the OS reports death by SIGHUP (129). No
    // quit(129) and no deferred exit line: the process dies by the re-raised signal.
    if (rlClosed) return;
    io.stderr.write("madc: interrupted (SIGHUP)\n");
    rl.close();
    releaseQuitting?.();
    opts.onSighup?.();
  };
  opts.exposeSignals?.({ onSigint: sigintQuit, onSigterm: sigtermQuit, onSighup: sighupRaise });
  rl.on("SIGINT", () => {
    sigintQuit();
  });

  const send = async (prompt: string): Promise<void> => {
    if (client === null) {
      client = spawnEngine({
        env: { MADC_HOME: opts.home },
        ...(io.engineEntry !== undefined ? { entry: io.engineEntry } : {}),
      });
      client.exited.catch(() => undefined);
      const c = client;
      try {
        const init = await c.request("initialize", {
          clientInfo: { name: "madc", version: MADC_VERSION },
        });
        if (
          init === null ||
          typeof init !== "object" ||
          (init as Record<string, unknown>).protocolVersion !== PROTOCOL_VERSION
        ) {
          throw new EngineProtocolError(
            "protocol violation: initialize returned an invalid result",
          );
        }
        c.notify("initialized", {});
      } catch (err) {
        sessionCodes.push({
          code: EXIT.engine,
          reason: err instanceof Error ? err.message : String(err),
        });
        client = null;
        return;
      }
    }
    const c = client;
    try {
      if (threadId === null) {
        const started = (await c.request("thread/start", { seatId, cwd: io.cwd })) as
          | { thread?: unknown }
          | undefined;
        if (!isThreadShape(started?.thread, seatId)) {
          throw new EngineProtocolError(
            "protocol violation: thread/start returned an invalid thread",
          );
        }
        threadId = started.thread.id;
      }
    } catch (err) {
      // Shared classification (§5.11): seat RPC → 2, RPC -32009 → 5, everything else
      // (protocol errors, engine exit, malformed responses) → 3. E11: the engine-supplied
      // message is sanitised before it is stored or written.
      const cls = classifyThreadStartFailure(err);
      const message = stripControls(err instanceof Error ? err.message : String(err));
      sessionCodes.push({ code: cls.exit, reason: message });
      io.stderr.write(
        `madc: ${cls.label} error${cls.code === null ? "" : ` ${cls.code}`}: ${message}\nexit ${finish()}\n`,
      );
      return;
    }
    const tid = threadId;
    if (tid === null) return;
    const turn: TurnRecord = {
      turnId: `pending-${turns.length}`,
      status: "running",
      exitCode: 0,
      inAppInterrupted: false,
      seqStart: null,
      seqEnd: null,
      verify: null,
      unverified: null,
      revoked: false,
      startTime: Date.now(),
      endTime: null,
      userText: prompt,
      items: [],
    };
    turns.push(turn);
    // Correction round: the wait matcher NEVER throws — a throw would escape through the
    // engine's readline 'line' listener (uncaught). Violations reject a raced promise; the
    // idle deadline is an INACTIVITY deadline, rearmed only on validated notifications.
    let rejectViolation: ((m: string) => void) | null = null;
    const violation = new Promise<never>((_, reject) => {
      rejectViolation = (m: string) => reject(new EngineProtocolError(m));
    });
    violation.catch(() => undefined);
    const violate = (m: string): void => {
      rejectViolation?.(m);
    };
    // A holder, not a plain local: the promise executor assigns on a later tick, which TS's
    // control-flow analysis cannot see (the same idiom as the app's violatedRef).
    const idleRef: { current: (() => void) | null } = { current: null };
    const idleFired = new Promise<"idle">((resolve) => {
      idleRef.current = () => resolve("idle");
    });
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let idleDidFire = false;
    let settled = false; // the turn wait is over: no matcher side effects, no rearm
    const armIdle = (): void => {
      if (settled || idleDidFire || idleRef.current === null) return;
      if (idleTimer !== null) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleDidFire = true;
        // Honest reason (§5.7 words-first): the engine went silent — nothing malformed.
        sessionCodes.push({
          code: EXIT.engine,
          reason: `timeout: no engine message for ${opts.turnIdleMs} ms`,
        });
        turn.status = "unknown";
        turn.unverified = `timeout: no engine message for ${opts.turnIdleMs} ms`;
        idleRef.current?.();
      }, opts.turnIdleMs);
      idleTimer.unref?.();
    };
    const disarmIdle = (): void => {
      if (idleTimer !== null) clearTimeout(idleTimer);
      idleTimer = null;
    };
    // Engine-exit race (PR #35 round 7, Copilot r4136804305-family): a child that dies
    // mid-turn settles this wait as a class-3 engine failure — the readline loop never
    // hangs on the 2,147,483,647 ms waiter for a dead child.
    const engineGone = c.exited.then((code) => {
      if (settled) return "engine-gone" as const;
      sessionCodes.push({
        code: EXIT.engine,
        reason: `engine exited (code ${String(code)}) before responding`,
      });
      turn.status = "unknown";
      turn.unverified = `engine exited (code ${String(code)}) before responding`;
      return "engine-gone" as const;
    });
    engineGone.catch(() => undefined);
    try {
      // The cutoff snapshot is taken BEFORE the request: the engine may batch the
      // turn/start response and this turn's notifications into one stdout write, and those
      // notifications must land AFTER the cutoff — a post-request snapshot would discard
      // the whole batch as history and the wait would never see the completion.
      const waitSince = c.messages.length;
      let scanned = waitSince;
      const ts = await c.request("turn/start", {
        threadId: tid,
        input: [{ type: "text", text: prompt }],
        // I2: Level A is also a witnessed, TTY-gated surface (main.ts's app gate); it sends the
        // same mode CLAIM the tier-W app sends. `print: false` — the `-p` one-shot never runs
        // through here.
        mode: claimMode({
          stdinIsTTY: io.stdinIsTTY === true,
          stdoutIsTTY: io.stdoutIsTTY,
          print: false,
        }),
      });
      const t = (ts as { turn?: unknown } | undefined)?.turn;
      if (!isTurnShape(t) || !isDomainId(t.id) || t.threadId !== tid) {
        throw new EngineProtocolError("protocol violation: turn/start returned an invalid turn");
      }
      turn.realTurnId = t.id;
      armIdle();
      const done = c.waitFor(
        (m) => {
          if (settled) return false; // the wait is over: late messages are inert
          const params = m.params as Record<string, unknown> | undefined;
          if (m.method === "item/agentMessage/delta") {
            // A validated delta for THIS turn is activity (identity first, then rearm).
            if (
              params === null ||
              typeof params !== "object" ||
              params.threadId !== tid ||
              params.turnId !== turn.realTurnId ||
              !isDomainId(params.itemId) ||
              typeof params.delta !== "string"
            ) {
              violate("protocol violation: malformed or foreign item/completed or delta");
              return false;
            }
            armIdle();
            return false;
          }
          if (m.method === "item/completed" || m.method === "item/started") {
            if (
              params === null ||
              typeof params !== "object" ||
              params.threadId !== tid ||
              !isDomainId(params.turnId) ||
              !isItemShape(params.item)
            ) {
              // Live or buffered: recorded, never thrown (the matcher runs in the readline
              // listener for live messages).
              violate("protocol violation: malformed item");
              return false;
            }
            if (m.method === "item/completed" && params.turnId === turn.realTurnId) {
              turn.items.push(sanitizeItem(params.item));
            }
            armIdle(); // a validated item is activity
          } else if (m.method === "turn/completed" && !Object.hasOwn(m, "id")) {
            // E-d: only THIS turn's completion ends the wait; historical messages are skipped
            // via `since`, and a live foreign or malformed completion stays a violation.
            const tEnd = (params as { turn?: unknown } | undefined)?.turn;
            if (!isTurnShape(tEnd) || tEnd.threadId !== tid || tEnd.id !== turn.realTurnId) {
              violate("protocol violation: malformed or foreign turn/completed");
              return false;
            }
            disarmIdle();
            return true;
          }
          return false; // unknown notifications are not activity: the deadline is not rearmed
        },
        2_147_483_647,
        waitSince,
      );
      // Violation poll (§3b rule 5); the idle deadline and quitting bound the turn wait.
      const poll = setInterval(() => {
        if (c.protocolViolations.length > 0) {
          io.stderr.write(
            `madc: engine error ${EXIT.engine}: protocol violation: non-JSON line on engine stdout\n`,
          );
          quit(EXIT.engine);
          return;
        }
        for (; scanned < c.messages.length; scanned++) {
          const cls = classifyMessage(c.messages[scanned]);
          if (cls.kind !== "ok") {
            io.stderr.write(`madc: engine error ${EXIT.engine}: ${violationMessage(cls)}\n`);
            quit(EXIT.engine);
            return;
          }
        }
      }, 100);
      poll.unref?.();
      let raced: Awaited<typeof done> | "idle" | "quit" | "engine-gone";
      try {
        raced = await Promise.race([done, violation, idleFired, quitting, engineGone]);
      } finally {
        // Unconditional settlement cleanup: runs when the race RESOLVES and when the
        // violation REJECTS through it (the throw must not skip cleanup) — the poll stops,
        // the idle timer is disarmed and can never rearm, and the (possibly unresolved)
        // waiter is removed so a late engine message runs no matcher code.
        settled = true;
        clearInterval(poll);
        disarmIdle();
        c.cancelWaiters();
        done.catch(() => undefined);
      }
      if (raced === "quit") return;
      if (raced !== "idle" && raced !== "engine-gone") {
        const t2 = (raced as { params?: { turn?: unknown } }).params?.turn;
        if (isTurnShape(t2) && t2.id === turn.realTurnId) {
          turn.items = t2.items.map(sanitizeItem);
          turn.status =
            t2.status === "completed"
              ? "completed"
              : t2.status === "interrupted"
                ? "interrupted"
                : t2.status === "failed"
                  ? "failed"
                  : "unknown";
          // PR #35 round 7 (Copilot r4136804022): a FAILED turn ends class 1 for this turn
          // — never a silent 0 (interrupted stays 0, completed 0, per §5.11). The tier-W
          // error-code classification applies too: a turn error carrying -32007/-32008 is a
          // PROVIDER failure (exit 4), -32009 session (5), seat codes usage (2) — the same
          // classes the full app's #classifyItemErrorCode rules.
          turn.exitCode =
            t2.status === "completed"
              ? 0
              : t2.status === "interrupted"
                ? 0
                : t2.status === "failed"
                  ? failedTurnExitOf(t2.error?.code)
                  : turn.exitCode;
          // Round 7 (tier-W parity): a failed completion's error body becomes a turn error
          // ITEM (E11-sanitised) so the receipt's error row renders it — the same shape the
          // full app pushes for tDone.error.
          if (t2.status === "failed" && t2.error !== null) {
            turn.items = [
              ...turn.items,
              {
                id: `${t2.id}-error`,
                kind: "error",
                status: "completed",
                message: sanitizeText(t2.error.message),
                code: t2.error.code,
              } as TurnRecord["items"][number],
            ];
          }
          for (const item of t2.items) {
            if (item.kind === "agentMessage") {
              io.stdout.write(`${stripControls(item.text)}\n`);
            }
          }
        } else {
          turn.status = "unknown";
          sessionCodes.push({
            code: EXIT.engine,
            reason: "protocol violation: malformed turn/completed",
          });
        }
      }
    } catch (err) {
      // E11 (round 7, Copilot r4136803580): the caught message is engine-supplied —
      // sanitised at THIS boundary, before storage or render.
      const reason = sanitizeErrorLike(err);
      turn.status = "unknown";
      turn.unverified = reason;
      sessionCodes.push({
        code: EXIT.engine,
        reason,
      });
    }
    // R-a: the per-turn verify, then the §6.2 receipt to stderr (§6.3). The session row is
    // bound to THIS turn: when the chain's last turn.end names another turn (or is missing),
    // the row stays UNVERIFIED — never a green VERIFIED session for foreign end evidence.
    if (threadId !== null) {
      const outcome2 = await verify({
        path: `${opts.home}/sessions/${threadId}.jsonl`,
        threadId,
        home: opts.home,
        deadlineMs: VERIFY_DEADLINE_MS,
      });
      const session = sessionFromOutcome(
        outcome2,
        `${opts.home}/sessions/${threadId}.jsonl`,
        turn.realTurnId,
      );
      if (outcome2.kind === "result" && !outcome2.result.ok) {
        noteSessionCode(EXIT.session);
        sessionCodes.push({ code: EXIT.session, reason: "chain FAILED" });
      }
      const data = buildReceiptData({
        turn,
        served: servedOf(turn),
        session,
        error: errorOf(turn),
        exit: worstExit({ turns, sessionCodes, signal: null, finalVerifyFailedAfterSignal: false })
          .code,
      });
      // E11 at the data boundary (§5.10 E-a, round 7, Copilot r4136804072): the session row
      // can carry a raw verifier reason; the DATA is sanitised before the §6.2 spans wrap it.
      // Depth none (NO_COLOR, TERM=dumb): the plain bytes, never SGR (Copilot r4136804256).
      io.stderr.write(
        style.depth === "none"
          ? receiptPlain(sanitizeReceiptData(data))
          : receiptTierA(sanitizeReceiptData(data)),
      );
    }
  };

  const promptTurn = async (line: string): Promise<void> => {
    const text = line.trim();
    if (text === "") return;
    if (text === "/quit" || text === "/exit") {
      quit(finish());
      return;
    }
    if (text.startsWith("//")) {
      await send(text.slice(1));
      return;
    }
    if (text.startsWith("/")) {
      io.stderr.write(`unknown command ${text.split(/\s+/)[0] ?? text} · line mode offers /quit\n`);
      return;
    }
    await send(text);
  };

  let queued: Promise<void> = Promise.resolve();
  rl.on("line", (line) => {
    queued = queued
      .then(() => promptTurn(line))
      .catch(() => undefined)
      .finally(() => {
        // Re-prompt after each queued line settles: the §6.3 `> ` after every turn.
        if (!rlClosed) showPrompt();
      });
  });
  const firstLine = opts.firstPrompt;
  if (firstLine !== null) {
    queued = queued
      .then(() => promptTurn(firstLine))
      .catch(() => undefined)
      .finally(() => {
        if (!rlClosed) showPrompt();
      });
  }
  await new Promise<void>((resolve) => {
    rl.on("close", resolve);
  });
  // Drain the queued turns BEFORE tearing down: an EOF that arrives while the first send is in
  // flight (a piped stdin) must not null the client under the running turn.
  await queued;
  // The closure assignments above are invisible to control-flow analysis; widen explicitly.
  const closing = client as EngineClient | null;
  client = null;
  if (closing !== null) {
    await closing.close(5_000).catch(() => null);
  }
  void g;
  void style;
  // A recorded signal settles HERE — once, after shutdown and every verification: the
  // shared ranking prints and returns the same final status (§5.13, O-3/O-4 precede the
  // raw 130/143; the SIGHUP path never reaches this line, the entry re-raised it).
  if (recordedSignal !== null) {
    const code = worstExit({
      turns,
      sessionCodes,
      signal: recordedSignal,
      finalVerifyFailedAfterSignal: chainFailedAfterSignal,
    }).code;
    // §5.13/IQW-10 (round 9): the interrupted/exit lines emit CONTIGUOUSLY as the final
    // stderr block — after every verification settled and every receipt was written. The
    // shared ranking decides the single printed/returned value: a recorded 2/3/5 (and
    // O-3's verify-failure-after-signal → 5) outranks the raw 130/143.
    io.stderr.write(`madc: interrupted (${recordedSignal})\nexit ${code}\n`);
    return code;
  }
  return exitCode !== 0 ? exitCode : finish();
}

function sessionFromOutcome(
  outcome: VerifyOutcome,
  path: string,
  realTurnId: string | undefined,
): import("./receipt.ts").SessionOut | null {
  if (outcome.kind === "deadline") {
    return { path, seq: null, headHash: null, chain: "unverified", reason: "verify interrupted" };
  }
  const v = outcome.result;
  if (!v.ok) {
    return { path, seq: null, headHash: null, chain: "failed", line: v.line, reason: v.reason };
  }
  let lastEnd: string | null = null;
  for (const e of v.events) {
    if (e.type === "turn.end") lastEnd = String((e.payload as { turnId?: unknown }).turnId);
  }
  const seq = v.events[v.events.length - 1]?.seq ?? 0;
  if (realTurnId === undefined || lastEnd !== realTurnId) {
    // The chain verified, but its last turn.end does not name THIS turn: the session row
    // keeps the verified seq/head as UNVERIFIED evidence — never a green success row.
    return {
      path,
      seq,
      headHash: v.lastHash,
      chain: "unverified",
      reason: "the chain's last turn.end does not name this turn",
    };
  }
  return {
    path,
    seq,
    headHash: v.lastHash,
    chain: "verified",
  };
}

function servedOf(turn: TurnRecord): import("./receipt.ts").ServedModel | null {
  const item = [...turn.items].reverse().find((i) => i.kind === "servedModel");
  return item !== undefined && item.kind === "servedModel"
    ? {
        requestedModel: item.requestedModel,
        servedModel: item.servedModel,
        backing: item.backing,
        providerId: item.providerId,
      }
    : null;
}

function errorOf(turn: TurnRecord): import("./receipt.ts").ErrorOut | null {
  const item = turn.items.find((i) => i.kind === "error");
  if (item !== undefined && item.kind === "error") {
    return { code: item.code ?? null, message: item.message, class: "turn" };
  }
  if (turn.unverified !== null) {
    return { code: null, message: turn.unverified, class: "engine" };
  }
  return null;
}

export { EngineExitedError };

/** Round 7: the tier-W failed-turn error-code classification, shared by Level A. */
function failedTurnExitOf(code: number | undefined): number {
  if (code === undefined) return EXIT.failure;
  if (code === -32007 || code === -32008) return EXIT.provider;
  if (code === -32009) return EXIT.session;
  if (code === -32005 || code === -32006 || code === -32602) return EXIT.usage;
  return EXIT.failure;
}
