import { createInterface, type Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { Agent, TurnSink } from "./agent.ts";
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

export const ENGINE_VERSION = "0.0.0";

export type EngineOptions = {
  input: Readable;
  output: Writable;
  /** Resolved `$MADC_HOME`. */
  home: string;
  agent: Agent;
  /** stderr logger — never protocol. */
  log?: (message: string) => void;
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

    const id = newId("thr");
    const lock = acquireThreadLock(this.#opts.home, id);
    if (!lock.ok) throw turnAlreadyActive(id, null, lock.holderPid ?? undefined);

    const now = Date.now();
    const thread: Thread = {
      id,
      seatId,
      cwd: typeof p.cwd === "string" ? p.cwd : null,
      createdAt: now,
      updatedAt: now,
      status: "idle",
      preview: "",
    };
    this.#threads.set(id, { thread, lock: lock.handle, turns: new Map(), activeTurnId: null });
    return { value: { thread }, after: () => this.#notify("thread/started", { thread }) };
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

    // A2 thread store is in-memory per engine process; the durable JSONL-backed load lands in A4
    // (seat pin §4). Nothing to load → release the lock we just took and report not found. If it
    // cannot be released now, keep the handle so shutdown releases it (never orphan our own lock).
    let released = false;
    try {
      released = releaseThreadLock(lock.handle);
    } catch {
      released = false;
    }
    if (!released && holdsThreadLock(lock.handle)) this.#strayLocks.push(lock.handle);
    throw threadNotFound(threadId);
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

    const all = [...this.#threads.values()]
      .map((r) => r.thread)
      .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
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
    this.#ensureLock(record);

    const now = Date.now();
    const turn: Turn = {
      id: newId("turn"),
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
        this.#runTurn(record, turnRecord, input);
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

  #runTurn(record: ThreadRecord, tr: TurnRecord, input: UserInput[]): void {
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

    const ctx = {
      threadId: turn.threadId,
      turnId: turn.id,
      seatId: record.thread.seatId,
      input,
    };
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
    }
    const now = Date.now();
    turn.status = status;
    turn.error = status === "failed" ? error : null;
    turn.completedAt = now;
    record.activeTurnId = null;
    record.thread.status = "idle";
    record.thread.updatedAt = now;
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
