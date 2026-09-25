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
  EngineRpcError,
  type Item,
  PROTOCOL_VERSION,
  spawnEngine,
  type Turn,
  verifySessionFile,
  type WireMessage,
} from "@madc/engine/client";
import {
  type Classified,
  classifyCode,
  type ErrorClass,
  type ErrorSite,
  EXIT,
} from "./exit-codes.ts";
import { type CliIO, sleep, TimeoutError, withTimeout } from "./io.ts";

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

function servedModelOf(item: Item | null | undefined): ServedModel | null {
  if (item === null || typeof item !== "object" || item.kind !== "servedModel") return null;
  return {
    requestedModel: item.requestedModel,
    servedModel: item.servedModel,
    backing: item.backing,
    providerId: item.providerId,
  };
}

export async function runOneShot(io: CliIO, opts: OneShotOptions): Promise<number> {
  const startedAt = Date.now();
  let threadId: string | null = null;
  let turnId: string | null = null;
  let turn: Turn | null = null;
  let served: ServedModel | null = null;
  let error: ErrorOut | null = null;
  let exit: number = EXIT.ok;
  let signalExit: number | null = null;
  // The engine's exit code from `close()`; `null` = killed by a signal (incl. our close timeout).
  let engineExit: number | null | undefined;
  let violationTimer: ReturnType<typeof setInterval> | undefined;
  let malformedItem = false;
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
  // First SIGINT before the turn exists is held (Bugbot 4107608856): if `turn/start` is in
  // flight, the turn is interrupted as soon as its id is known; if it was not sent yet, it never
  // is. A second SIGINT forces.
  let sigintPending = false;
  const onSigint = () => {
    signalExit = signalExit ?? EXIT.sigint;
    if (!softUsed && turnId !== null) {
      softUsed = true;
      softNow();
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

  const fail = (c: Classified, code: number | null, message: string) => {
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
    // turn wait with the protocol exit 3 instead of waiting forever.
    const violated = new Promise<never>((_, reject) => {
      violationTimer = setInterval(() => {
        if (c.protocolViolations.length > 0) {
          clearInterval(violationTimer);
          reject(new ProtocolMismatch("protocol violation: non-JSON line on engine stdout"));
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
          RESPONSE_TIMEOUT_MS,
        ),
      );
      if (init.protocolVersion !== PROTOCOL_VERSION) {
        throw new ProtocolMismatch(`engine speaks ${String(init.protocolVersion)}`);
      }
      c.notify("initialized", {});
      site = "thread/start";
      const started = await step(
        withTimeout(
          c.request("thread/start", {
            cwd: io.cwd,
            ...(opts.seatId !== undefined ? { seatId: opts.seatId } : {}),
          }),
          RESPONSE_TIMEOUT_MS,
        ),
      );
      threadId = started.thread.id;
      site = "request";
      const tid = threadId;
      // Observe every message from here on, in order (deltas are display only).
      const done = c.waitFor((m: WireMessage) => {
        const params = m.params as Record<string, unknown> | undefined;
        if (m.method === "item/agentMessage/delta" && params?.threadId === tid) {
          const delta = String(params.delta ?? "");
          if (stream) {
            clearStatus();
            io.stdout.write(delta);
          }
          streamed += delta;
        } else if (m.method === "item/completed" && params?.threadId === tid) {
          // Copilot r4108213460: a malformed item never throws inside the client's reader; it is
          // a protocol violation (exit 3) through the normal result path.
          if (params.item === null || typeof params.item !== "object") malformedItem = true;
          const s = servedModelOf(params.item as Item | null | undefined);
          if (s !== null) served = s;
        }
        // One turn per thread in a one-shot: match on the thread, since `turn/completed` can be
        // read in the same chunk as the `turn/start` response, before `turnId` is known here.
        return (
          m.method === "turn/completed" && (params?.turn as Turn | undefined)?.threadId === tid
        );
      }, NO_TIMEOUT_MS);
      done.catch(() => undefined);
      if (stream && io.stderrIsTTY) {
        statusTimer = setInterval(() => {
          io.stderr.write(`\r… ${seatId} · ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
        }, 200);
      }
      if (sigintPending) throw new Forced();
      const ts = await step(
        withTimeout(
          c.request("turn/start", { threadId: tid, input: [{ type: "text", text: opts.prompt }] }),
          RESPONSE_TIMEOUT_MS,
        ),
      );
      turnId = ts.turn.id;
      turn = ts.turn;
      if (sigintPending && !softUsed) {
        // SIGINT arrived before the turn existed: now it can be interrupted.
        softUsed = true;
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
      if (completed !== null) turn = (completed.params as { turn: Turn }).turn;
    } catch (err) {
      if (err instanceof Forced) {
        // exit code comes from the signal
      } else if (err instanceof EngineRpcError) {
        fail(classifyCode(err.code, site), err.code, err.message);
      } else if (err instanceof EngineExitedError) {
        // The engine exits 2 on a bad MADC_HOME (usage class); any other early exit is engine.
        const usage = err.exitCode === EXIT.usage;
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
    }
  } catch (err) {
    fail({ exit: EXIT.engine, class: "engine" }, null, `engine spawn failed: ${errorMessage(err)}`);
  } finally {
    clearStatus();
    clearInterval(violationTimer);
    if (client !== null) {
      // After a signal: close stdin and kill the engine if it is still running after 1 s.
      engineExit = await client.close(signalExit !== null ? KILL_AFTER_MS : CLOSE_TIMEOUT_MS);
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
        ? "engine did not exit after stdin closed (killed)"
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
  if (signalExit === null && malformedItem) {
    fail(
      { exit: EXIT.engine, class: "engine" },
      null,
      "protocol violation: item/completed without an item",
    );
  }

  // ---- session receipt: re-read and verify after the engine exited
  let session: SessionOut | null = null;
  if (threadId !== null) {
    session = verifyThread(opts.home, threadId, finalTurn?.id ?? null);
    if (session.chain === "failed" && (exit === EXIT.ok || exit === EXIT.failure)) {
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

  if (stream) {
    if (streamed === "" && text !== "") io.stdout.write(text);
    if ((streamed || text) !== "" && !(streamed || text).endsWith("\n")) io.stdout.write("\n");
  } else if (text !== "") {
    io.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  }
  if (threadId !== null) {
    io.stderr.write(receipt(finalTurn, durationMs, served, session, error, exit));
  } else if (error !== null) {
    const e = error as ErrorOut;
    io.stderr.write(
      `madc: ${e.class} error${e.code === null ? "" : ` ${e.code}`}: ${e.message}\nexit ${exit}\n`,
    );
  }
  return exit;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Read-only re-read + verify of `sessions/<threadId>.jsonl` (CLI pin §2 `session` line). */
function verifyThread(home: string, threadId: string, turnId: string | null): SessionOut {
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
    return { path, seq, headHash: v.lastHash, chain: "unverified", reason: "no turn was started" };
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

const RULE = `─ receipt ${"─".repeat(45)}`;

function receipt(
  turn: Turn | null,
  durationMs: number,
  served: ServedModel | null,
  session: SessionOut | null,
  error: ErrorOut | null,
  exit: number,
): string {
  const lines = [RULE];
  if (turn === null) {
    lines.push(` turn     ${"NOT STARTED".padEnd(20)} -`);
  } else {
    lines.push(
      ` turn     ${turn.status.toUpperCase().padEnd(20)} ${turn.id.padEnd(15)} ${(durationMs / 1000).toFixed(1)}s`,
    );
  }
  lines.push(
    served === null
      ? " model    NO RECEIPT"
      : ` model    ${served.requestedModel} → ${served.servedModel}   (${served.backing})`,
  );
  if (session !== null) {
    lines.push(` session  ${session.path}`);
    if (session.chain === "failed") {
      lines.push(`          chain FAILED line ${session.line}: ${session.reason}`);
    } else if (session.chain === "unverified") {
      const where =
        session.seq === null ? "" : `seq ${session.seq} · head ${session.headHash.slice(0, 12)} · `;
      lines.push(`          ${where}UNVERIFIED: ${session.reason}`);
    } else {
      lines.push(
        `          seq ${session.seq} · head ${session.headHash.slice(0, 12)} · chain VERIFIED`,
      );
    }
  }
  if (error !== null) {
    lines.push(
      ` error    ${error.class}${error.code === null ? "" : ` ${error.code}`}: ${error.message}`,
    );
  }
  lines.push(` exit     ${exit}`);
  return `${lines.join("\n")}\n`;
}
