import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type {
  ClientRequestMethod,
  ClientRequests,
  RequestId,
  RpcErrorBody,
  ServerNotificationMethod,
  ServerNotifications,
} from "./protocol/types.ts";

/** Default engine entry (this package's `bin.ts`). */
export const ENGINE_ENTRY = fileURLToPath(new URL("./bin.ts", import.meta.url));

export type SpawnEngineOptions = {
  /** Merged over `process.env` (e.g. `{ MADC_HOME }`); an `undefined` value removes the variable. */
  env?: Record<string, string | undefined>;
  /** Alternate engine entry script (tests use fixtures). */
  entry?: string;
  /** Runtime binary; defaults to the current one (`node` or `bun`). */
  runtime?: string;
};

export class EngineRpcError extends Error {
  readonly code: number;
  readonly data: Record<string, unknown> | undefined;
  constructor(body: RpcErrorBody) {
    super(body.message);
    this.name = "EngineRpcError";
    this.code = body.code;
    this.data = body.data;
  }
}

/** Transport error: the engine child exited (or never started) before answering a request. */
export class EngineExitedError extends Error {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  constructor(exitCode: number | null, signal: NodeJS.Signals | null) {
    super(`engine exited (code ${exitCode}, signal ${signal}) before responding`);
    this.name = "EngineExitedError";
    this.exitCode = exitCode;
    this.signal = signal;
  }
}

export type WireMessage = Record<string, unknown>;
export type Notification = { method: string; params: unknown };

type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void };
type Waiter = { match: (m: WireMessage) => boolean; resolve: (m: WireMessage) => void };

/**
 * Thin protocol client over a child engine's stdio. Client SDK only — no loop, tools, or adapters;
 * this is what `packages/cli` may import (plan §6).
 */
export class EngineClient {
  readonly child: ChildProcess;
  /** Every message received, in order. */
  readonly messages: WireMessage[] = [];
  /** stdout lines that were not valid JSON objects (must stay empty: stdout is protocol only). */
  readonly protocolViolations: string[] = [];
  readonly exited: Promise<number | null>;
  #nextId = 1;
  #terminated = false;
  readonly #pending = new Map<RequestId, Pending>();
  #waiters: Waiter[] = [];

  constructor(child: ChildProcess) {
    this.child = child;
    const stdout = child.stdout;
    if (stdout === null) throw new Error("engine stdout must be piped");
    createInterface({ input: stdout, crlfDelay: Number.POSITIVE_INFINITY }).on("line", (line) =>
      this.#onLine(line),
    );
    // Writes to a dead or never-started child fail asynchronously; the terminal path below settles
    // every caller, so stdin write errors carry no extra information.
    child.stdin?.on("error", () => undefined);
    this.exited = new Promise((resolve) => {
      const finish = (code: number | null, signal: NodeJS.Signals | null) => {
        if (this.#terminated) return;
        this.#terminated = true;
        // A response that never arrived will never arrive: fail every pending request.
        const err = new EngineExitedError(code, signal);
        for (const pending of this.#pending.values()) pending.reject(err);
        this.#pending.clear();
        resolve(code);
      };
      child.once("exit", (code, signal) => finish(code, signal));
      // A failed spawn (bad runtime or entry) emits `error` and never `exit`.
      child.on("error", () => {
        if (child.pid === undefined) finish(null, null);
      });
    });
  }

  get pid(): number {
    if (this.child.pid === undefined) throw new Error("engine not started");
    return this.child.pid;
  }

  get notifications(): Notification[] {
    return this.messages
      .filter((m) => typeof m.method === "string" && !Object.hasOwn(m, "id"))
      .map((m) => ({ method: m.method as string, params: m.params }));
  }

  #onLine(line: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      this.protocolViolations.push(line);
      return;
    }
    if (msg === null || typeof msg !== "object" || Array.isArray(msg)) {
      this.protocolViolations.push(line);
      return;
    }
    const m = msg as WireMessage;
    this.messages.push(m);
    const id = m.id as RequestId | null | undefined;
    if (id !== undefined && id !== null && this.#pending.has(id)) {
      const pending = this.#pending.get(id);
      this.#pending.delete(id);
      if (Object.hasOwn(m, "error")) pending?.reject(new EngineRpcError(m.error as RpcErrorBody));
      else pending?.resolve(m.result);
    }
    const still: Waiter[] = [];
    for (const w of this.#waiters) {
      if (w.match(m)) w.resolve(m);
      else still.push(w);
    }
    this.#waiters = still;
  }

  sendRaw(line: string): void {
    this.child.stdin?.write(line.endsWith("\n") ? line : `${line}\n`);
  }

  request<M extends ClientRequestMethod>(
    method: M,
    params?: ClientRequests[M]["params"],
  ): Promise<ClientRequests[M]["result"]>;
  request(method: string, params?: unknown): Promise<unknown>;
  request(method: string, params?: unknown): Promise<unknown> {
    const id = this.#nextId++;
    const msg = params === undefined ? { id, method } : { id, method, params };
    return new Promise((resolve, reject) => {
      if (this.#terminated || this.child.exitCode !== null || this.child.signalCode !== null) {
        reject(new EngineExitedError(this.child.exitCode, this.child.signalCode));
        return;
      }
      this.#pending.set(id, { resolve, reject });
      this.sendRaw(JSON.stringify(msg));
    });
  }

  notify(method: string, params: unknown = {}): void {
    this.sendRaw(JSON.stringify({ method, params }));
  }

  /** Resolve with the first message (already received or future) matching `match`. */
  waitFor(match: (m: WireMessage) => boolean, timeoutMs = 10_000): Promise<WireMessage> {
    const seen = this.messages.find(match);
    if (seen !== undefined) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiters = this.#waiters.filter((w) => w !== waiter);
        reject(new Error(`timed out after ${timeoutMs}ms waiting for engine message`));
      }, timeoutMs);
      const waiter: Waiter = {
        match,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      };
      this.#waiters.push(waiter);
    });
  }

  async waitForNotification<M extends ServerNotificationMethod>(
    method: M,
    predicate: (params: ServerNotifications[M]) => boolean = () => true,
    timeoutMs?: number,
  ): Promise<ServerNotifications[M]> {
    const m = await this.waitFor(
      (msg) =>
        msg.method === method &&
        !Object.hasOwn(msg, "id") &&
        predicate(msg.params as ServerNotifications[M]),
      timeoutMs,
    );
    return m.params as ServerNotifications[M];
  }

  /** Close stdin (EOF) and wait for exit; kills after `timeoutMs`. */
  async close(timeoutMs = 5_000): Promise<number | null> {
    this.child.stdin?.end();
    const timer = setTimeout(() => this.child.kill("SIGKILL"), timeoutMs);
    try {
      return await this.exited;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Spawn the engine as a child process — stdio ["pipe", "pipe", "inherit"] (protocol pin §2).
 * No daemon, no network listener: the connection is this child's stdin/stdout.
 */
/** Drops `undefined` entries (Node would otherwise pass the string "undefined" to the child). */
export function withoutUndefined(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) if (value !== undefined) out[name] = value;
  return out;
}

export function spawnEngine(opts: SpawnEngineOptions = {}): EngineClient {
  const runtime = opts.runtime ?? process.execPath;
  const isBun = runtime === process.execPath && process.versions.bun !== undefined;
  const args = isBun
    ? [opts.entry ?? ENGINE_ENTRY]
    : ["--disable-warning=ExperimentalWarning", opts.entry ?? ENGINE_ENTRY];
  const child = spawn(runtime, args, {
    stdio: ["pipe", "pipe", "inherit"],
    env: withoutUndefined({ ...process.env, ...opts.env }),
  });
  return new EngineClient(child);
}
