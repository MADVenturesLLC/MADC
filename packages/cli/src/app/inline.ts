/**
 * Inline mode (DESIGN-SPEC rev 6.2 §5.10, mock-up 12): the Witness look, append-only on the
 * normal screen — no alternate screen, no cursor-up repainting, no fixed bottom bar, no \r
 * redraw, no clear. The identity block prints once; items print as they complete; after the
 * verify the segment's end line and the verdict card print below; the pills print as one status
 * line after each turn. Dotted rows stay dotted in the scrollback; only the end line carries
 * the verified state — never a false solid. Engine stderr (M-1 pipe) prints as dim labelled
 * rows between app lines; the app never draws over or hides it.
 */

import * as readline from "node:readline";
import { MADC_VERSION } from "@madc/core";
import {
  type EngineClient,
  EngineProtocolError,
  PROTOCOL_VERSION,
  spawnEngine,
} from "@madc/engine/client";
import type { Check } from "../doctor.ts";
import { EXIT } from "../exit-codes.ts";
import type { CliIO } from "../io.ts";
import { buildReceiptData } from "./app-receipt.ts";
import { renderHelp } from "./frames.ts";
import { receiptPlain, sanitizeReceiptData } from "./receipt.ts";
import { sanitizeErrorLike, sanitizeItem, sanitizeText, stripControls } from "./sanitize.ts";
import type { ChainVerify, TurnRecord } from "./state.ts";
import { worstExit } from "./state.ts";
import { glyphsFor, Style } from "./style.ts";
import { asciiForced, colorDepth } from "./tiers.ts";
import { renderVerdictCard, type Verdict } from "./verdict.ts";
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

export type InlineOptions = {
  readonly io: CliIO;
  readonly home: string;
  readonly turnIdleMs: number;
  readonly firstPrompt: string | null;
  readonly doctor: { pass: number; warn: number; fail: number; skip: number };
  readonly launchWarnRows: readonly Check[];
  readonly onExit?: ((code: number) => void) | undefined;
  readonly onSighup?: (() => void) | undefined;
  readonly verify?: ((req: VerifyRequest) => Promise<VerifyOutcome>) | undefined;
};

/** Round 7: the tier-W failed-turn error-code classification, shared by inline. */
function failedTurnExitOf(code: number | undefined): number {
  if (code === undefined) return EXIT.failure;
  if (code === -32007 || code === -32008) return EXIT.provider;
  if (code === -32009) return EXIT.session;
  if (code === -32005 || code === -32006 || code === -32602) return EXIT.usage;
  return EXIT.failure;
}

export async function runInlineApp(opts: InlineOptions): Promise<number> {
  const io = opts.io;
  const style = Style.forDepth(
    io.env.NO_COLOR !== undefined || io.env.TERM === "dumb" ? "none" : colorDepth(io.env),
    asciiForced(io.env),
  );
  const g = glyphsFor(style.ascii);
  const out = io.stdout;
  // Identity block (§5.10): printed once, then only appends.
  out.write(
    `${style.filled("accent", "MADC")} madc-default · kimi-code · ${style.role("accent2", PROTOCOL_VERSION)} · inline mode\n`,
  );
  out.write(
    `doctor ${style.role("ok", `✓ ${opts.doctor.pass} PASS`)} · ${style.role("warn", `▲ ${opts.doctor.warn} WARN`)} · ${style.role("err", `${opts.doctor.fail} FAIL`)} · ${style.role("dim", `○ ${opts.doctor.skip} SKIP`)}\n`,
  );
  out.write(
    `${style.role("faint", "engine stderr is shown as-is, labelled, between app lines")}\n`,
  );

  const turns: TurnRecord[] = [];
  const sessionCodes: { code: number; reason: string }[] = [];
  let threadId: string | null = null;
  let client: EngineClient | null = null;
  const verify =
    opts.verify ??
    ((req: VerifyRequest) => runVerifyBounded({ ...req, deadlineMs: VERIFY_DEADLINE_MS }));
  let releaseQuitting: (() => void) | null = null;
  const quitting = new Promise<"quit">((resolve) => {
    releaseQuitting = () => resolve("quit");
  });
  quitting.catch(() => undefined);

  const worst = (signal: "SIGINT" | "SIGTERM" | "SIGHUP" | null): number =>
    worstExit({ turns, sessionCodes, signal, finalVerifyFailedAfterSignal: false }).code;

  const renderTurnAppend = (turn: TurnRecord): void => {
    if (turn.userText !== undefined) {
      out.write(
        `${style.role("warn", g.railDotted)} ${style.role("accent", "you")} ${stripControls(turn.userText)}\n`,
      );
    }
    out.write(
      `${style.role("warn", g.railDotted)} ${style.role("dim", `○ turn/started ${turn.realTurnId ?? ""}`)}\n`,
    );
    renderTurnItems(turn);
    // The end line carries the verified state; the dotted rows above stay dotted (§5.10).
    renderTurnEndLine(turn);
  };

  /** Every recorded item's rows (the turn/start append; the list is empty that early). */
  const renderTurnItems = (turn: TurnRecord): void => {
    for (const item of turn.items) renderItemRows(item);
  };

  /**
   * ONE item's rows (§5.10 mock-up 12: "items print as they complete"). Called from the wait
   * matcher as each validated item/completed lands — append-only, so the completed snapshot
   * later prints only items whose id was never printed (no duplication).
   */
  const renderItemRows = (item: import("@madc/engine/client").Item): void => {
    if (item.kind === "agentMessage") {
      out.write(
        `${style.role("warn", g.railDotted)} ${style.role("accent2", g.diamond)} ${style.role("accent", "madc-default")} ${style.role("dim", "· agentMessage · item/completed")}\n`,
      );
      for (const line of stripControls(item.text).split("\n")) {
        out.write(`${style.role("warn", g.railDotted)}   ${line}\n`);
      }
    }
    if (item.kind === "toolCall") {
      out.write(
        `${style.role("warn", g.railDotted)} ${style.role("accent2", g.band)} ${style.role("accent2", `◆ ${item.name}`)}\n`,
      );
    }
    if (item.kind === "toolResult") {
      out.write(
        `${style.role("warn", g.railDotted)}   ${style.role("dim", `toolCall → toolResult · ${item.name} · isError=${String(item.isError)}`)}\n`,
      );
      for (const line of stripControls(item.output).split("\n").slice(0, 2)) {
        out.write(`${style.role("warn", g.railDotted)}   ${line}\n`);
      }
    }
    if (item.kind === "error") {
      out.write(
        `${style.role("err", `${g.cross} error${item.code === undefined ? "" : ` ${item.code}`}`)} ${stripControls(item.message)}\n`,
      );
    }
  };

  /** The end line only: after the per-turn verify, printed below the appended rows (§5.10). */
  const renderTurnEndLine = (turn: TurnRecord): void => {
    const v = turn.verify;
    if (turn.revoked || v?.kind === "failed") {
      out.write(`${style.role("err", `${g.railBreak} ${turn.unverified ?? "chain FAILED"}`)}\n`);
    } else if (v?.kind === "verified" && turn.unverified === null) {
      out.write(
        `${style.role("ok", g.railEndVerified)} ${style.role("dim", `seq ${v.seq} · head ${v.headHash.slice(0, 12)} · `)}${style.role("ok", "chain VERIFIED")}\n`,
      );
    } else {
      out.write(
        `${style.role("warn", g.railEndUnverified)} ${style.role("warn", `UNVERIFIED: ${turn.unverified ?? "verify pending"}`)}\n`,
      );
    }
  };

  const verdictOf = (turn: TurnRecord): Verdict | null => {
    if (turn.revoked || turn.verify?.kind === "failed") return { kind: "failed" };
    if (
      turn.verify?.kind === "verified" &&
      turn.unverified === null &&
      turn.status === "completed" &&
      turn.exitCode === 0
    ) {
      return { kind: "completed" };
    }
    if (turn.status === "failed" && turn.exitCode !== 0) return { kind: "failed" };
    return null;
  };

  const servedOf = (turn: TurnRecord): import("./receipt.ts").ServedModel | null => {
    const item = [...turn.items].reverse().find((i) => i.kind === "servedModel");
    return item !== undefined && item.kind === "servedModel"
      ? {
          requestedModel: item.requestedModel,
          servedModel: item.servedModel,
          backing: item.backing,
          providerId: item.providerId,
        }
      : null;
  };

  const sessionPathOf = (): string | null =>
    threadId === null ? null : `${opts.home}/sessions/${threadId}.jsonl`;

  const sessionOf = (turn: TurnRecord): import("./receipt.ts").SessionOut | null => {
    const path = sessionPathOf();
    const v = turn.verify;
    if (path === null || v === null) return null;
    if (v.kind === "verified") {
      // The verified chain row binds to THIS turn like line mode's sessionFromOutcome: when
      // the turn carries an unverified reason (foreign last turn.end, a live violation), the
      // row stays UNVERIFIED with the seq/head evidence — never green for foreign ends.
      if (turn.unverified !== null) {
        return {
          path,
          seq: v.seq,
          headHash: v.headHash,
          chain: "unverified",
          reason: turn.unverified,
        };
      }
      return { path, seq: v.seq, headHash: v.headHash, chain: "verified" };
    }
    if (v.kind === "failed") {
      return { path, seq: null, headHash: null, chain: "failed", line: v.line, reason: v.reason };
    }
    return {
      path,
      seq: null,
      headHash: null,
      chain: "unverified",
      reason: turn.unverified ?? "verify pending",
    };
  };

  const send = async (prompt: string): Promise<void> => {
    if (client === null) {
      client = spawnEngine({
        env: { MADC_HOME: opts.home },
        stderr: "pipe",
        ...(io.engineEntry !== undefined ? { entry: io.engineEntry } : {}),
      });
      const c = client;
      c.onStderrLine = (line) => {
        out.write(`${style.role("faint", `engine stderr: ${stripControls(line)}`)}\n`);
      };
      c.exited.catch(() => undefined);
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
        const started = (await c.request("thread/start", { cwd: io.cwd })) as
          | { thread?: unknown }
          | undefined;
        if (!isThreadShape(started?.thread, "madc-default")) {
          throw new EngineProtocolError(
            "protocol violation: thread/start returned an invalid thread",
          );
        }
        threadId = started.thread.id;
      }
    } catch (err) {
      // Shared classification (§5.11): seat RPC → 2, RPC -32009 → 5, everything else
      // (protocol errors, engine exit, malformed responses) → 3. E11 on the message.
      const cls = classifyThreadStartFailure(err);
      const message = stripControls(err instanceof Error ? err.message : String(err));
      sessionCodes.push({ code: cls.exit, reason: message });
      out.write(
        `${style.role("err", `${g.cross} ${cls.label} error${cls.code === null ? "" : ` ${cls.code}`}`)} ${message}\n`,
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
    // Append-only dedup (PR #35 round 7, Copilot r4136803428): item ids whose rows already
    // printed — the completed snapshot re-prints none of them.
    const printedIds = new Set<string>();
    // Correction round: same shared shape as line mode — the matcher never throws (a throw
    // escapes through the readline listener), the idle deadline is an inactivity deadline
    // rearmed only on validated notifications, and the timeout reason is honest.
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
    // Engine-exit race (PR #35 round 7, Copilot r4136803517-family): the child dying mid-turn
    // must settle THIS wait as a class-3 engine failure — never leave the 2,147,483,647 ms
    // waiter pending for a dead child.
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
      });
      const t = (ts as { turn?: unknown } | undefined)?.turn;
      if (!isTurnShape(t) || !isDomainId(t.id) || t.threadId !== tid) {
        throw new EngineProtocolError("protocol violation: turn/start returned an invalid turn");
      }
      turn.realTurnId = t.id;
      renderTurnAppend(turn);
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
              // Correction round: recorded, never thrown (live messages run this matcher
              // inside the engine's readline listener).
              violate("protocol violation: malformed item");
              return false;
            }
            if (m.method === "item/completed" && params.turnId === turn.realTurnId) {
              turn.items.push(sanitizeItem(params.item));
              // Append-only (§5.10): the item's rows print NOW, as it completes.
              renderItemRows(
                turn.items[turn.items.length - 1] as import("@madc/engine/client").Item,
              );
              printedIds.add(params.item.id);
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
      const poll = setInterval(() => {
        if (c.protocolViolations.length > 0) {
          sessionCodes.push({
            code: EXIT.engine,
            reason: "protocol violation: non-JSON line on engine stdout",
          });
          releaseQuitting?.();
          return;
        }
        for (; scanned < c.messages.length; scanned++) {
          const cls = classifyMessage(c.messages[scanned]);
          if (cls.kind !== "ok") {
            sessionCodes.push({ code: EXIT.engine, reason: violationMessage(cls) });
            releaseQuitting?.();
            return;
          }
        }
      }, 100);
      poll.unref?.();
      let raced: Awaited<typeof done> | "idle" | "quit" | "engine-gone";
      try {
        raced = await Promise.race([done, violation, idleFired, quitting, engineGone]);
      } finally {
        // Unconditional settlement cleanup (same as line mode): runs when the race RESOLVES
        // and when the violation REJECTS through it (the throw must not skip cleanup).
        settled = true;
        clearInterval(poll);
        disarmIdle();
        c.cancelWaiters();
        done.catch(() => undefined);
      }
      if (raced === "quit") return;
      if (raced !== "idle" && raced !== "engine-gone") {
        const t2 = (raced.params as { turn?: unknown } | undefined)?.turn;
        if (isTurnShape(t2) && t2.id === turn.realTurnId) {
          // Append-only dedup: the snapshot replaces the record, but only items whose rows
          // have NOT printed (a repeated id never prints twice) render now.
          turn.items = t2.items.map(sanitizeItem);
          for (const item of turn.items) {
            if (!printedIds.has(item.id)) {
              renderItemRows(item);
              printedIds.add(item.id);
            }
          }
          turn.status =
            t2.status === "completed"
              ? "completed"
              : t2.status === "interrupted"
                ? "interrupted"
                : t2.status === "failed"
                  ? "failed"
                  : "unknown";
          // Round 7: the tier-W error-code classification (a -32007/-32008 turn error is a
          // PROVIDER failure, exit 4) — the same classes the full app rules for failed turns.
          if (t2.status === "failed") turn.exitCode = failedTurnExitOf(t2.error?.code);
          // Round 7 (tier-W parity): a failed completion's error body becomes a turn error
          // ITEM (E11-sanitised) so the rail error row and /receipt render it. The wait has
          // settled by now, so the row prints HERE (the matcher will never deliver it).
          if (t2.status === "failed" && t2.error !== null) {
            const errorItem = {
              id: `${t2.id}-error`,
              kind: "error",
              status: "completed",
              message: sanitizeText(t2.error.message),
              code: t2.error.code,
            } as TurnRecord["items"][number];
            turn.items = [...turn.items, errorItem];
            renderItemRows(errorItem);
          }
        } else {
          turn.status = "unknown";
          turn.unverified = "the chain's last turn.end does not name this turn";
        }
      }
    } catch (err) {
      // E11 (round 7): the caught message is engine-supplied — sanitised at THIS boundary,
      // before it is stored into the turn record or a session code (Copilot r4136803580).
      const reason = sanitizeErrorLike(err);
      turn.status = "unknown";
      turn.unverified = reason;
      sessionCodes.push({
        code: EXIT.engine,
        reason,
      });
    }
    // R-a: read-only verify after the turn, then the end line + verdict card print below (§5.10).
    if (turn.status === "failed" && turn.exitCode === 0) turn.exitCode = EXIT.failure;
    const path = sessionPathOf();
    if (path !== null) {
      const outcome = await verify({
        path,
        threadId: threadId ?? "",
        home: opts.home,
        deadlineMs: VERIFY_DEADLINE_MS,
      });
      if (outcome.kind === "deadline") {
        turn.verify = { kind: "interrupted" };
        turn.unverified = "verify interrupted";
      } else if (!outcome.result.ok) {
        turn.verify = {
          kind: "failed",
          line: outcome.result.line,
          reason: outcome.result.reason,
          failureKind: outcome.result.kind,
        };
        turn.unverified = `chain FAILED line ${outcome.result.line}: ${outcome.result.reason}`;
        sessionCodes.push({ code: EXIT.session, reason: "chain FAILED" });
      } else {
        let lastEnd: string | null = null;
        for (const e of outcome.result.events) {
          if (e.type === "turn.end") {
            lastEnd = String((e.payload as { turnId?: unknown }).turnId);
          }
        }
        const v: ChainVerify = {
          kind: "verified",
          seq: outcome.result.events[outcome.result.events.length - 1]?.seq ?? 0,
          headHash: outcome.result.lastHash,
        };
        turn.verify = v;
        // A reason the turn already carries (a violation, a timeout) is PRESERVED across the
        // verify — the same rule as the tier-W app (W-4): the verify never rewrites history.
        if (lastEnd !== turn.realTurnId && turn.unverified === null) {
          turn.unverified = "the chain's last turn.end does not name this turn";
        }
      }
      turn.endTime = Date.now();
      renderTurnEnd(turn);
      const verdict = verdictOf(turn);
      if (verdict !== null) {
        const card = renderVerdictCard(
          verdict,
          // E11 at the data boundary (§5.10 E-a, round 7): sessionOf can carry a raw verifier
          // reason into the styled card; the card's chrome must never run through the
          // control-char replacer, so the DATA is sanitised before assembly.
          sanitizeReceiptData(
            buildReceiptData({
              turn,
              served: servedOf(turn),
              session: sessionOf(turn),
              error: null,
              exit: verdict.kind === "completed" ? 0 : turn.exitCode,
            }),
          ),
          io.columns ?? 80,
          style,
          g,
          { titleSuffix: verdict.kind === "completed" ? " printed below, never repainted" : "" },
        );
        for (const line of card) out.write(`${line}\n`);
      }
      // The pills print as one status line after each turn (§5.10), then the prompt (§9).
      const served = servedOf(turn);
      out.write(
        `${style.pill("pill", `${g.idle} idle`)} ${served === null ? style.role("dim", "served: awaiting receipt") : style.role("accent2", `served: ${served.servedModel}`)} ${threadId === null ? "" : style.role("accent2", threadId)} ${chainPill(turn)}\n`,
      );
    }
  };

  const chainPill = (turn: TurnRecord): string => {
    const v = turn.verify;
    if (turn.revoked || v?.kind === "failed") {
      return style.filled("err", `${g.cross} chain FAILED`);
    }
    if (v?.kind === "verified" && turn.unverified === null) {
      return style.filled("ok", `seq ${v.seq} · ${g.check} chain VERIFIED`);
    }
    return style.tint("warnbg", style.role("warn", "▲ UNVERIFIED"));
  };

  const renderTurnEnd = (turn: TurnRecord): void => {
    // The end line only (the body already printed append-only above).
    const v = turn.verify;
    if (turn.revoked || v?.kind === "failed") {
      out.write(`${style.role("err", `${g.railBreak} ${turn.unverified ?? "chain FAILED"}`)}\n`);
    } else if (v?.kind === "verified" && turn.unverified === null) {
      out.write(
        `${style.role("ok", g.railEndVerified)} ${style.role("dim", `seq ${v.seq} · head ${v.headHash.slice(0, 12)} · `)}${style.role("ok", "chain VERIFIED")}\n`,
      );
    } else {
      out.write(
        `${style.role("warn", g.railEndUnverified)} ${style.role("warn", `UNVERIFIED: ${turn.unverified ?? "verify pending"}`)}\n`,
      );
    }
  };

  const _evidenceBlock = (): void => {
    out.write(`${style.role("accent", "EVIDENCE")}\n`);
    out.write(`  seat       madc-default\n`);
    out.write(`  thread     ${threadId ?? "—"}\n`);
    out.write(
      `  chain      ${turns.length === 0 ? "nothing yet" : chainPill(turns[turns.length - 1] ?? ({} as TurnRecord))}\n`,
    );
    for (let i = 0; i < turns.length; i++) {
      const t = turns[i];
      if (t === undefined) continue;
      out.write(`  turn ${i + 1}      ${t.status}\n`);
    }
  };

  const doctorRows = async (): Promise<void> => {
    const { collectDoctor } = await import("../doctor.ts");
    await collectDoctor(
      io,
      { json: false, init: false },
      {
        onRow: (c) => {
          out.write(`${c.status.toUpperCase().padEnd(4)} ${c.id.padEnd(14)} ${c.summary}\n`);
        },
      },
    );
  };

  const rl = readline.createInterface({
    input: io.stdin,
    terminal: io.stdinIsTTY === true,
    prompt: `${g.prompt} `,
  });
  // Track closure through the SUPPORTED close event (TS2551: `Interface` has no `closed`).
  let rlClosed = false;
  rl.on("close", () => {
    rlClosed = true;
  });
  // §6.3/§9 (round 7, Copilot r4136803801): the prompt must be VISIBLE — readline only
  // emits it to its OWN output stream, which this interface was never given, so rl.prompt()
  // writes nothing. The prompt goes through the CliIO output contract instead: the bare
  // glyph prompt (append-only, always landing below the previous output, never repainted).
  // Re-emitted after each queued line's turn settles.
  const showPrompt = (): void => {
    if (rlClosed) return;
    try {
      io.stdout.write(`${g.prompt} `);
    } catch {
      // a stream that already errored: the prompt is cosmetic, never fatal
    }
  };
  showPrompt();
  rl.on("SIGINT", () => {
    io.stderr.write("madc: interrupted (SIGINT)\n");
    io.stderr.write(`exit ${worst("SIGINT")}\n`);
    releaseQuitting?.();
    rl.close();
  });
  let queued: Promise<void> = Promise.resolve();
  rl.on("line", (line) => {
    queued = queued
      .then(async () => {
        const text = line.trim();
        if (text === "") return;
        if (text === "/quit") {
          io.stderr.write(`exit ${worst(null)}\n`);
          releaseQuitting?.();
          rl.close();
          return;
        }
        if (text === "/help") {
          for (const l of renderHelp(style, g)) out.write(`${stripControls(l)}\n`);
          return;
        }
        if (text === "/doctor") {
          await doctorRows();
          return;
        }
        if (text === "/receipt") {
          const last = turns[turns.length - 1];
          if (last !== undefined) {
            out.write(
              // E11 at the data boundary (round 7, Copilot r4136803652): the receipt re-render
              // is a second inline output path — the same sanitised data as the verdict card.
              receiptPlain(
                sanitizeReceiptData(
                  buildReceiptData({
                    turn: last,
                    served: servedOf(last),
                    session: sessionOf(last),
                    error: null,
                    exit: last.exitCode,
                  }),
                ),
              ),
            );
          }
          return;
        }
        if (text === "/new") {
          if (client !== null) {
            const c = client;
            client = null;
            await c.close(5_000).catch(() => null);
          }
          turns.length = 0;
          threadId = null;
          return;
        }
        if (text.startsWith("//")) {
          await send(text.slice(1));
          return;
        }
        if (text.startsWith("/")) {
          out.write(
            `${style.role("dim", `unknown command ${text.split(/\s+/)[0] ?? text} · /help`)}\n`,
          );
          return;
        }
        await send(text);
      })
      .catch(() => undefined)
      .finally(() => {
        // Re-prompt after each queued line settles (append-only, below the output).
        if (!rlClosed) showPrompt();
      });
  });
  const firstInline = opts.firstPrompt;
  if (firstInline !== null) {
    queued = queued
      .then(() => send(firstInline))
      .catch(() => undefined)
      .finally(() => {
        if (!rlClosed) showPrompt();
      });
  }
  await new Promise<void>((resolve) => {
    rl.on("close", resolve);
  });
  // Drain the queued turns BEFORE teardown: an EOF that arrives while the first send is in
  // flight (a piped stdin) must not null the client under the running turn.
  await queued;
  // The closure assignments above are invisible to control-flow analysis; widen explicitly.
  const closing = client as EngineClient | null;
  client = null;
  if (closing !== null) {
    await closing.close(5_000).catch(() => null);
  }
  return worst(null);
}
