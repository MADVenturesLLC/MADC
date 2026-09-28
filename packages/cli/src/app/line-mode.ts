/**
 * Line-mode app (DESIGN-SPEC rev 6.2 §5.0 tier A, §6.3): one plain identity line, a `>` prompt,
 * agent text to stdout, the §6.2 receipt after each turn to stderr, doctor WARN/FAIL rows at
 * launch. No alternate screen, no cursor addressing. `MADC_UI=lines` also selects it (Q7).
 */

import * as readline from "node:readline";
import { MADC_VERSION } from "@madc/core";
import {
  type EngineClient,
  EngineExitedError,
  EngineProtocolError,
  PROTOCOL_VERSION,
  spawnEngine,
} from "@madc/engine/client";
import type { Check } from "../doctor.ts";
import { EXIT } from "../exit-codes.ts";
import type { CliIO } from "../io.ts";
import { buildReceiptData } from "./app-receipt.ts";
import { receiptTierA } from "./receipt.ts";
import { sanitizeItem, stripControls } from "./sanitize.ts";
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
  readonly why: string;
  readonly launchWarnRows: readonly Check[];
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
  io.stdout.write(
    `madc ${MADC_VERSION} · ${PROTOCOL_VERSION} · madc-default · line mode (${opts.why})\n`,
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
  rl.on("SIGINT", () => {
    quit(130);
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
    try {
      const ts = await c.request("turn/start", {
        threadId: tid,
        input: [{ type: "text", text: prompt }],
      });
      const t = (ts as { turn?: unknown } | undefined)?.turn;
      if (!isTurnShape(t) || !isDomainId(t.id) || t.threadId !== tid) {
        throw new EngineProtocolError("protocol violation: turn/start returned an invalid turn");
      }
      turn.realTurnId = t.id;
      let scanned = c.messages.length;
      const done = c.waitFor((m) => {
        const params = m.params as Record<string, unknown> | undefined;
        if (m.method === "item/completed" || m.method === "item/started") {
          if (
            params === null ||
            typeof params !== "object" ||
            params.threadId !== tid ||
            !isDomainId(params.turnId) ||
            !isItemShape(params.item)
          ) {
            throw new EngineProtocolError("protocol violation: malformed item");
          }
          if (m.method === "item/completed" && params.turnId === turn.realTurnId) {
            turn.items.push(sanitizeItem(params.item));
          }
        } else if (m.method === "turn/completed" && !Object.hasOwn(m, "id")) {
          return true;
        }
        return false;
      }, 2_147_483_647);
      // Violation poll (§3b rule 5); the idle deadline and quitting bound the turn wait.
      const idleFired = new Promise<"idle">((resolve) => {
        const t = setTimeout(() => resolve("idle"), opts.turnIdleMs);
        t.unref?.();
      });
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
      const raced = await Promise.race([done, idleFired, quitting]);
      clearInterval(poll);
      if (raced === "quit") return;
      const outcome = raced;
      const t2 =
        outcome === "idle" ? undefined : (outcome as { params?: { turn?: unknown } }).params?.turn;
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
        turn.exitCode =
          t2.status === "completed" ? 0 : t2.status === "interrupted" ? 0 : turn.exitCode;
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
    } catch (err) {
      turn.status = "unknown";
      sessionCodes.push({
        code: EXIT.engine,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
    // R-a: the per-turn verify, then the §6.2 receipt to stderr (§6.3).
    if (threadId !== null) {
      const outcome2 = await verify({
        path: `${opts.home}/sessions/${threadId}.jsonl`,
        threadId,
        home: opts.home,
        deadlineMs: VERIFY_DEADLINE_MS,
      });
      const session = sessionFromOutcome(outcome2, `${opts.home}/sessions/${threadId}.jsonl`);
      if (outcome2.kind === "result" && !outcome2.result.ok) {
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
      io.stderr.write(receiptTierA(data));
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
    queued = queued.then(() => promptTurn(line)).catch(() => undefined);
  });
  const firstLine = opts.firstPrompt;
  if (firstLine !== null) {
    queued = queued.then(() => promptTurn(firstLine)).catch(() => undefined);
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
  return exitCode !== 0 ? exitCode : finish();
}

function sessionFromOutcome(
  outcome: VerifyOutcome,
  path: string,
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
  void lastEnd;
  return {
    path,
    seq: v.events[v.events.length - 1]?.seq ?? 0,
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
