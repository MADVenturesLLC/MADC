import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface, type Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { Agent, AgentTurnContext, TurnSink } from "./agent.ts";
import { confinedPath } from "./home.ts";
import { acquireThreadLock, holdsThreadLock, type LockHandle, releaseThreadLock } from "./lock.ts";
import {
  alreadyInitialized,
  ErrorCode,
  internalError,
  invalidParams,
  invalidRequest,
  methodNotFound,
  notInitialized,
  RpcError,
  threadNotFound,
  turnAlreadyActive,
  turnNotFound,
} from "./protocol/errors.ts";
import { isValidId, newId } from "./protocol/ids.ts";
import {
  DEFAULT_SEAT_ID,
  type InitializeResult,
  type Item,
  PROTOCOL_VERSION,
  type RequestId,
  type RpcErrorBody,
  SERVER_NAME,
  type ServerNotifications,
  type Thread,
  type ThreadListResult,
  type Turn,
  type TurnStatus,
  type UserInput,
} from "./protocol/types.ts";
import { encodeMessage, isPlainObject, parseLine } from "./protocol/wire.ts";
import type { SeatBacking } from "./seat.ts";
import { type LoadedSeat, loadSeat, seedDefaultSeat } from "./seat-store.ts";
import {
  type RebuiltSession,
  rebuildSession,
  type SessionEventType,
  type SessionPayloads,
  SessionWriter,
  verifySessionFile,
} from "./session-store.ts";

export const ENGINE_VERSION = "0.0.0";

export type EngineOptions = {
  input: Readable;
  output: Writable;
  /** Resolved `$MADC_HOME`. */
  home: string;
  agent: Agent;
  /** stderr logger — never protocol. */
  log?: (message: string) => void;
  /** Test seam: thread id generator for `thread/start` (default `newId("thr")`). */
  newThreadId?: () => string;
};

type TurnRecord = {
  turn: Turn;
  controller: AbortController;
  open: Map<string, Item>;
  /** Set before the terminal transition starts (and before abort listeners run): sink is closed. */
  finalizing: boolean;
};

type ThreadRecord = {
  thread: Thread;
  lock: LockHandle;
  turns: Map<string, TurnRecord>;
  activeTurnId: string | null;
  seat: LoadedSeat;
  session: SessionWriter;
};

const THREAD_LIST_DEFAULT_LIMIT = 50;
const THREAD_LIST_MAX_LIMIT = 200;

function paramsObject(params: unknown): Record<string, unknown> {
  if (params === undefined) return {};
  if (!isPlainObject(params)) throw invalidParams(["params must be an object"]);
  return params;
}

function requireId(p: Record<string, unknown>, key: string, issues: string[]): string {
  const value = p[key];
  if (value === undefined) {
    issues.push(`${key} is required`);
    return "";
  }
  if (!isValidId(value)) {
    issues.push(`${key} must match ^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`);
    return "";
  }
  return value;
}

function throwIfIssues(issues: string[]): void {
  if (issues.length > 0) throw invalidParams(issues);
}

function parseUserInput(value: unknown, issues: string[]): UserInput[] {
  if (!Array.isArray(value)) {
    issues.push("input must be an array");
    return [];
  }
  if (value.length === 0) {
    issues.push("input must not be empty");
    return [];
  }
  const out: UserInput[] = [];
  value.forEach((part: unknown, i: number) => {
    if (!isPlainObject(part) || part.type !== "text") {
      issues.push(`input[${i}].type must be "text"`);
    } else if (typeof part.text !== "string") {
      issues.push(`input[${i}].text must be a string`);
    } else {
      out.push({ type: "text", text: part.text });
    }
  });
  return out;
}

/**
 * One stdio connection = one engine process (protocol pin §2). The CLI spawns this; there is no
 * other listener. Resolves when stdin reaches EOF and cleanup (interrupt in-flight turns, release
 * thread locks) is done.
 */
export class EngineConnection {
  readonly #opts: EngineOptions;
  #initialized = false;
  #closed = false;
  #shutDown = false;
  #rl: Interface | null = null;
  readonly #threads = new Map<string, ThreadRecord>();
  /** Locks this process still holds without a thread record (probe locks whose release failed). */
  readonly #strayLocks: LockHandle[] = [];

  constructor(opts: EngineOptions) {
    this.#opts = opts;
  }

  run(): Promise<void> {
    const { input, output } = this.#opts;
    this.#seedHome();
    // A dead stdout ends the connection exactly like EOF (interrupt turns, release locks).
    output.on("error", () => this.#onOutputFailure());
    const rl = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
    this.#rl = rl;
    rl.on("line", (line) => this.handleLine(line));
    return new Promise((resolve) => {
      rl.once("close", () => {
        this.shutdown();
        resolve();
      });
    });
  }

  /**
   * Seat pin §1: on engine start, seed `seats/madc-default.json` if missing (never overwritten).
   * A failure is logged, not fatal: `thread/start` then reports the seat error itself.
   */
  #seedHome(): void {
    try {
      seedDefaultSeat(this.#opts.home);
    } catch (err) {
      this.#log(`seed failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** EOF / output failure / signal: in-flight turns end `interrupted`; locks are released. */
  shutdown(): void {
    if (this.#shutDown) return;
    this.#shutDown = true;
    for (const record of this.#threads.values()) {
      const active =
        record.activeTurnId === null ? undefined : record.turns.get(record.activeTurnId);
      if (active !== undefined) this.#finishTurn(record, active, "interrupted");
    }
    this.releaseLocks();
    this.#closed = true;
    this.#rl?.close();
  }

  /** stdout is gone: nothing can be answered any more, so stop and clean up (same path as EOF). */
  #onOutputFailure(): void {
    this.#closed = true;
    // Closing readline emits "close", which runs shutdown(); before run() there is none.
    if (this.#rl === null) this.shutdown();
    else this.#rl.close();
  }

  releaseLocks(): void {
    const handles = [...[...this.#threads.values()].map((r) => r.lock), ...this.#strayLocks];
    for (const handle of handles) {
      try {
        releaseThreadLock(handle);
      } catch {
        // best effort; a dead-pid lock is reclaimed by the next engine
      }
    }
  }

  handleLine(line: string): void {
    if (this.#closed) return; // no dispatch after shutdown / output failure
    const msg = parseLine(line);
    if (msg === null) return;
    if (msg.kind === "invalid") {
      this.#send({ id: msg.id, error: msg.error.toBody() });
      return;
    }
    if (msg.kind === "notification") {
      // Only `initialized` is defined client → server; unknown notifications are ignored (no id to answer).
      return;
    }
    let result: { value: unknown; after?: () => void };
    try {
      result = this.#dispatch(msg.method, msg.params);
    } catch (err) {
      this.#sendError(msg.id, err);
      return;
    }
    this.#send({ id: msg.id, result: result.value });
    try {
      result.after?.();
    } catch (err) {
      // The response is already on the wire; never answer the same id twice.
      this.#log(`post-response error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  #sendError(id: RequestId, err: unknown): void {
    if (err instanceof RpcError) {
      this.#send({ id, error: err.toBody() });
      return;
    }
    this.#log(`internal error: ${err instanceof Error ? err.message : String(err)}`);
    this.#send({ id, error: internalError().toBody() });
  }

  #dispatch(method: string, params: unknown): { value: unknown; after?: () => void } {
    if (method === "initialize") return { value: this.#initialize(params) };
    if (method === "initialized") throw invalidRequest("initialized is a notification");
    if (!this.#initialized) throw notInitialized(method);
    switch (method) {
      case "thread/start":
        return this.#threadStart(params);
      case "thread/resume":
        return this.#threadResume(params);
      case "thread/list":
        return { value: this.#threadList(params) };
      case "turn/start":
        return this.#turnStart(params);
      case "turn/interrupt":
        return this.#turnInterrupt(params);
      default:
        throw methodNotFound(method);
    }
  }

  // ---------------------------------------------------------------- handshake

  #initialize(params: unknown): InitializeResult {
    if (this.#initialized) throw alreadyInitialized();
    const p = paramsObject(params);
    const issues: string[] = [];
    const info = p.clientInfo;
    if (!isPlainObject(info)) {
      issues.push("clientInfo is required");
    } else {
      if (typeof info.name !== "string" || info.name === "")
        issues.push("clientInfo.name must be a non-empty string");
      if (typeof info.version !== "string") issues.push("clientInfo.version must be a string");
      if (info.title !== undefined && typeof info.title !== "string")
        issues.push("clientInfo.title must be a string");
    }
    throwIfIssues(issues);
    this.#initialized = true;
    return {
      serverInfo: { name: SERVER_NAME, version: ENGINE_VERSION },
      protocolVersion: PROTOCOL_VERSION,
    };
  }

  // ------------------------------------------------------------------ threads

  #threadStart(params: unknown): { value: { thread: Thread }; after: () => void } {
    const p = paramsObject(params);
    const issues: string[] = [];
    let seatId: string = DEFAULT_SEAT_ID;
    if (p.seatId !== undefined) {
      if (isValidId(p.seatId)) seatId = p.seatId;
      else issues.push("seatId must match ^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$");
    }
    if (p.cwd !== undefined && typeof p.cwd !== "string") issues.push("cwd must be a string");
    throwIfIssues(issues);

    // Seat load happens in thread/start (protocol pin §4.2): -32005 / -32006 before any lock.
    const seat = loadSeat(this.#opts.home, seatId);

    const id = this.#opts.newThreadId?.() ?? newId("thr");
    if (!isValidId(id)) throw internalError("Generated thread id is invalid");
    const lock = acquireThreadLock(this.#opts.home, id);
    if (!lock.ok) throw turnAlreadyActive(id, null, lock.holderPid ?? undefined);
    const handle = lock.handle;

    const now = Date.now();
    const cwd = typeof p.cwd === "string" ? p.cwd : null;
    let session: SessionWriter;
    try {
      const path = confinedPath(this.#opts.home, "sessions", id, ".jsonl");
      session = SessionWriter.create(
        path,
        id,
        seatId,
        {
          cwd,
          backing: seat.seat.preferredBacking as SeatBacking,
          providerId: seat.seat.preferredBacking,
          pinnedModel: seat.seat.pinnedModel,
        },
        () => this.#secrets(this.#threads.get(id)?.lock ?? handle),
        now, // session.open ts == thread.createdAt
      );
    } catch (err) {
      this.#releaseOrKeep(handle);
      throw err;
    }
    const thread: Thread = {
      id,
      seatId,
      cwd,
      createdAt: now,
      updatedAt: now,
      status: "idle",
      preview: "",
    };
    this.#threads.set(id, {
      thread,
      lock: handle,
      turns: new Map(),
      activeTurnId: null,
      seat,
      session,
    });
    return { value: { thread }, after: () => this.#notify("thread/started", { thread }) };
  }

  /** Exact values redacted from every session append: the agent's secrets and our lock token. */
  #secrets(lock: LockHandle): string[] {
    return [...(this.#opts.agent.redactValues ?? []), lock.token];
  }

  /** Release a lock we took; if that fails while we still hold it, keep it for shutdown. */
  #releaseOrKeep(handle: LockHandle): void {
    let released = false;
    try {
      released = releaseThreadLock(handle);
    } catch {
      released = false;
    }
    try {
      if (!released && holdsThreadLock(handle)) this.#strayLocks.push(handle);
    } catch {
      // unreadable lock: nothing more we can do; a dead-pid lock is reclaimed later
    }
  }

  #threadResume(params: unknown): { value: { thread: Thread }; after: () => void } {
    const p = paramsObject(params);
    const issues: string[] = [];
    const threadId = requireId(p, "threadId", issues);
    throwIfIssues(issues);

    const known = this.#threads.get(threadId);
    if (known !== undefined) {
      // Known in this process: still verify we own the on-disk lock before resuming (§3.3).
      this.#ensureLock(known);
      const thread = known.thread;
      return { value: { thread }, after: () => this.#notify("thread/started", { thread }) };
    }

    // Lock first, then load under the lock (§3.3). A live foreign holder wins → -32004.
    const lock = acquireThreadLock(this.#opts.home, threadId);
    if (!lock.ok) throw turnAlreadyActive(threadId, null, lock.holderPid ?? undefined);

    const handle = lock.handle;
    let record: ThreadRecord;
    try {
      record = this.#loadColdThread(threadId, handle);
    } catch (err) {
      // Not found / unverifiable / seat error: release the lock we just took (or keep it for
      // shutdown if it cannot be released now — never orphan our own lock).
      this.#releaseOrKeep(handle);
      throw err;
    }
    this.#threads.set(threadId, record);
    const thread = record.thread;
    return { value: { thread }, after: () => this.#notify("thread/started", { thread }) };
  }

  /**
   * Cold resume under the thread lock (seat pin §4): verify `sessions/<threadId>.jsonl`, rebuild
   * thread + turns (engine state only; no model history replay), load the seat it was opened with,
   * and continue the chain. A turn whose `turn.end` is missing (engine died mid-turn) is closed as
   * `interrupted` by appending a `turn.end` event.
   */
  #loadColdThread(threadId: string, handle: LockHandle): ThreadRecord {
    const path = confinedPath(this.#opts.home, "sessions", threadId, ".jsonl");
    if (!existsSync(path)) throw threadNotFound(threadId);
    const verified = verifySessionFile(path, threadId);
    if (!verified.ok) {
      this.#log(
        `session ${threadId} failed verification at line ${verified.line}: ${verified.reason}`,
      );
      throw internalError("Session record failed verification");
    }
    const rebuilt: RebuiltSession = rebuildSession(verified.events);
    const seat = loadSeat(this.#opts.home, rebuilt.thread.seatId);
    const session = SessionWriter.resume(
      path,
      threadId,
      rebuilt.thread.seatId,
      verified.nextSeq,
      verified.lastHash,
      () => this.#secrets(this.#threads.get(threadId)?.lock ?? handle),
    );
    for (const turnId of rebuilt.danglingTurnIds) {
      session.append("turn.end", { turnId, status: "interrupted", error: null });
    }
    const turns = new Map<string, TurnRecord>();
    for (const turn of rebuilt.turns) {
      turns.set(turn.id, {
        turn,
        controller: new AbortController(),
        open: new Map(),
        finalizing: true,
      });
    }
    return {
      thread: rebuilt.thread,
      lock: handle,
      turns,
      activeTurnId: null,
      seat,
      session,
    };
  }

  #threadList(params: unknown): ThreadListResult {
    const p = paramsObject(params);
    const issues: string[] = [];
    let limit = THREAD_LIST_DEFAULT_LIMIT;
    if (p.limit !== undefined) {
      if (typeof p.limit !== "number" || !Number.isInteger(p.limit) || p.limit < 1) {
        issues.push("limit must be a positive integer");
      } else {
        limit = Math.min(p.limit, THREAD_LIST_MAX_LIMIT);
      }
    }
    if (p.cursor !== undefined && !isValidId(p.cursor)) issues.push("cursor is invalid");
    throwIfIssues(issues);

    const all = [...[...this.#threads.values()].map((r) => r.thread), ...this.#diskThreads()].sort(
      (a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
    );
    let start = 0;
    if (typeof p.cursor === "string") {
      const idx = all.findIndex((t) => t.id === p.cursor);
      if (idx === -1) throw invalidParams(["cursor is invalid"]);
      start = idx + 1;
    }
    const page = all.slice(start, start + limit);
    const last = page.at(-1);
    return {
      data: page.map(({ id, seatId, createdAt, updatedAt, preview, status }) => ({
        id,
        seatId,
        createdAt,
        updatedAt,
        preview,
        status,
      })),
      nextCursor: start + limit < all.length && last !== undefined ? last.id : null,
    };
  }

  /**
   * Threads recorded on disk but not loaded in this process (durable store, seat pin §4). Read-only:
   * no lock is taken. A file that does not verify is skipped (and logged), never listed.
   */
  #diskThreads(): Thread[] {
    let names: string[];
    try {
      names = readdirSync(join(this.#opts.home, "sessions"));
    } catch {
      return [];
    }
    const out: Thread[] = [];
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const threadId = name.slice(0, -".jsonl".length);
      if (!isValidId(threadId) || this.#threads.has(threadId)) continue;
      let path: string;
      try {
        path = confinedPath(this.#opts.home, "sessions", threadId, ".jsonl");
      } catch {
        continue;
      }
      const verified = verifySessionFile(path, threadId);
      if (!verified.ok) {
        this.#log(`thread/list: skipping ${threadId} (session failed verification)`);
        continue;
      }
      out.push(rebuildSession(verified.events).thread);
    }
    return out;
  }

  /** Verify this process still owns the thread's lock file; re-take it or yield (-32004). */
  #ensureLock(record: ThreadRecord): void {
    if (holdsThreadLock(record.lock)) return;
    const lock = acquireThreadLock(this.#opts.home, record.thread.id);
    if (!lock.ok) throw turnAlreadyActive(record.thread.id, null, lock.holderPid ?? undefined);
    record.lock = lock.handle;
  }

  // -------------------------------------------------------------------- turns

  #turnStart(params: unknown): { value: { turn: Turn }; after: () => void } {
    const p = paramsObject(params);
    const issues: string[] = [];
    const threadId = requireId(p, "threadId", issues);
    const input = parseUserInput(p.input, issues);
    throwIfIssues(issues);

    const record = this.#threads.get(threadId);
    if (record === undefined) throw threadNotFound(threadId);
    if (record.activeTurnId !== null) throw turnAlreadyActive(threadId, record.activeTurnId);
    // Seat / registry / credential refusals are response errors before any turn exists (§4.2).
    const ctx = this.#turnContext(record, input);
    this.#opts.agent.preflight?.(ctx);
    this.#ensureLock(record);

    const now = Date.now();
    const turnId = newId("turn");
    // turn.start is durable before the turn exists: an append failure is a -32009 response error.
    record.session.append(
      "turn.start",
      { turnId, inputText: input.map((part) => part.text).join("\n") },
      now, // == turn.startedAt
    );
    const turn: Turn = {
      id: turnId,
      threadId,
      status: "inProgress",
      items: [],
      error: null,
      startedAt: now,
      completedAt: null,
    };
    const turnRecord: TurnRecord = {
      turn,
      controller: new AbortController(),
      open: new Map(),
      finalizing: false,
    };
    record.turns.set(turn.id, turnRecord);
    record.activeTurnId = turn.id;
    record.thread.status = "active";
    record.thread.updatedAt = now;
    if (record.thread.preview === "") record.thread.preview = input[0]?.text ?? "";

    const snapshot = structuredClone(turn);
    return {
      value: { turn: snapshot },
      after: () => {
        this.#notify("turn/started", { turn: structuredClone(turn) });
        this.#runTurn(record, turnRecord, { ...ctx, turnId: turn.id });
      },
    };
  }

  #turnInterrupt(params: unknown): { value: Record<string, never>; after?: () => void } {
    const p = paramsObject(params);
    const issues: string[] = [];
    const threadId = requireId(p, "threadId", issues);
    const turnId = requireId(p, "turnId", issues);
    throwIfIssues(issues);

    const record = this.#threads.get(threadId);
    if (record === undefined) throw threadNotFound(threadId);
    const turnRecord = record.turns.get(turnId);
    if (turnRecord === undefined) throw turnNotFound(threadId, turnId);
    if (turnRecord.turn.status !== "inProgress") return { value: {} };
    return { value: {}, after: () => this.#finishTurn(record, turnRecord, "interrupted") };
  }

  #turnContext(record: ThreadRecord, input: UserInput[]): Omit<AgentTurnContext, "turnId"> {
    return {
      threadId: record.thread.id,
      seatId: record.thread.seatId,
      seat: record.seat.seat,
      seatPath: record.seat.path,
      input,
    };
  }

  /**
   * Durable record of one completed item (seat pin §4.2): an `item` event, plus the dedicated
   * `servedModel` event for a receipt (dual write). Returns false after a -32009 failure, which
   * fails the turn.
   */
  #persistItem(record: ThreadRecord, tr: TurnRecord, item: Item): boolean {
    const turnId = tr.turn.id;
    try {
      record.session.append("item", { turnId, item });
      if (item.kind === "servedModel") {
        record.session.append("servedModel", {
          turnId,
          requestedModel: item.requestedModel,
          servedModel: item.servedModel,
          backing: item.backing,
          providerId: item.providerId,
        });
      }
      return true;
    } catch (err) {
      if (!(err instanceof RpcError)) throw err;
      this.#finishTurn(record, tr, "failed", err.toBody());
      return false;
    }
  }

  /** Append during the terminal transition; the turn is already ending, so failures are logged. */
  #appendFinal<T extends SessionEventType>(
    record: ThreadRecord,
    type: T,
    payload: SessionPayloads[T],
    ts?: number,
  ): SessionPayloads[T] | null {
    try {
      return record.session.append(type, payload, ts).payload;
    } catch (err) {
      this.#log(
        `session append failed (${type}): ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  #runTurn(record: ThreadRecord, tr: TurnRecord, ctx: AgentTurnContext): void {
    const { input } = ctx;
    const { turn } = tr;
    const live = () => turn.status === "inProgress" && !tr.finalizing;
    const sink: TurnSink = {
      signal: tr.controller.signal,
      newItemId: () => newId("item"),
      startItem: (item) => {
        if (!live() || !isValidId(item.id) || tr.open.has(item.id)) return;
        const started = { ...item, status: "inProgress" } as Item;
        tr.open.set(item.id, started);
        this.#notify("item/started", { threadId: turn.threadId, turnId: turn.id, item: started });
      },
      delta: (itemId, delta) => {
        const open = tr.open.get(itemId);
        if (!live() || open === undefined || open.kind !== "agentMessage") return;
        open.text += delta;
        this.#notify("item/agentMessage/delta", {
          threadId: turn.threadId,
          turnId: turn.id,
          itemId,
          delta,
        });
      },
      completeItem: (item) => {
        if (!live() || !tr.open.has(item.id)) return;
        tr.open.delete(item.id);
        // The engine owns the lifecycle: a completed item is `completed`, whatever the agent sent.
        const completed = { ...item, status: "completed" } as Item;
        turn.items.push(completed);
        this.#notify("item/completed", {
          threadId: turn.threadId,
          turnId: turn.id,
          item: completed,
        });
        this.#persistItem(record, tr, completed);
      },
    };

    const userItem: Item = {
      id: newId("item"),
      kind: "userMessage",
      status: "completed",
      content: input.map((part) => ({ type: "text", text: part.text })),
    };
    sink.startItem(userItem);
    sink.completeItem(userItem);
    if (!live()) return; // the user item could not be recorded (-32009): never call the agent

    Promise.resolve()
      .then(() => this.#opts.agent.run(ctx, sink))
      .then(
        () => {
          if (live()) this.#finishTurn(record, tr, "completed");
        },
        (err: unknown) => {
          if (!live()) return;
          const body: RpcErrorBody =
            err instanceof RpcError
              ? err.toBody()
              : { code: ErrorCode.InternalError, message: "Agent failed" };
          if (!(err instanceof RpcError)) {
            this.#log(`agent error: ${err instanceof Error ? err.message : String(err)}`);
          }
          this.#finishTurn(record, tr, "failed", body);
        },
      );
  }

  /** Terminal transition. Open items close as `failed`; a failed turn also gets an `error` item. */
  #finishTurn(
    record: ThreadRecord,
    tr: TurnRecord,
    status: Exclude<TurnStatus, "inProgress">,
    error: RpcErrorBody | null = null,
  ): void {
    const { turn } = tr;
    if (turn.status !== "inProgress" || tr.finalizing) return;
    // Close the sink BEFORE abort: abort listeners run synchronously and must not emit or mutate.
    tr.finalizing = true;
    tr.controller.abort();
    const ref = { threadId: turn.threadId, turnId: turn.id };
    for (const item of tr.open.values()) {
      const closed = { ...item, status: "failed" } as Item;
      turn.items.push(closed);
      this.#notify("item/completed", { ...ref, item: closed });
      this.#appendFinal(record, "item", { turnId: turn.id, item: closed });
    }
    tr.open.clear();
    if (status === "failed" && error !== null) {
      const errItem: Item = {
        id: newId("item"),
        kind: "error",
        status: "completed",
        message: error.message,
        code: error.code,
      };
      this.#notify("item/started", { ...ref, item: { ...errItem, status: "inProgress" } as Item });
      turn.items.push(errItem);
      this.#notify("item/completed", { ...ref, item: errItem });
      this.#appendFinal(record, "item", { turnId: turn.id, item: errItem });
    }
    const now = Date.now();
    turn.status = status;
    turn.error = status === "failed" ? error : null;
    turn.completedAt = now;
    record.activeTurnId = null;
    record.thread.status = "idle";
    record.thread.updatedAt = now;
    this.#appendFinal(
      record,
      "turn.end",
      {
        turnId: turn.id,
        status,
        error: turn.error === null ? null : { code: turn.error.code, message: turn.error.message },
      },
      now, // == turn.completedAt
    );
    this.#notify("turn/completed", { turn: structuredClone(turn) });
  }

  // ------------------------------------------------------------------ output

  #notify<M extends keyof ServerNotifications>(method: M, params: ServerNotifications[M]): void {
    this.#send({ method, params });
  }

  #send(message: Parameters<typeof encodeMessage>[0]): void {
    if (this.#closed) return;
    try {
      this.#opts.output.write(encodeMessage(message));
    } catch {
      this.#onOutputFailure();
    }
  }

  #log(message: string): void {
    (this.#opts.log ?? ((m: string) => process.stderr.write(`[madc-engine] ${m}\n`)))(message);
  }
}

export function runEngine(opts: EngineOptions): Promise<void> {
  return new EngineConnection(opts).run();
}
