/**
 * Session JSONL with a hash chain (seat pin §4, plan D5): `$MADC_HOME/sessions/<threadId>.jsonl`,
 * one event per line, append-only. Every payload is redacted BEFORE hashing, so the chain covers
 * exactly the bytes on disk. Only the thread-lock holder appends (protocol pin §3.3).
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { isStrictlyUnder } from "./home.ts";
import { type OpenNoFollowOptions, openNoFollow } from "./lock.ts";
import { ErrorCode, RpcError, type SessionWriteFailedData } from "./protocol/errors.ts";
import { isValidId } from "./protocol/ids.ts";
import type { Item, RpcErrorBody, Thread, Turn, TurnStatus } from "./protocol/types.ts";
import type { SeatBacking } from "./seat.ts";

export const GENESIS_HASH = "0".repeat(64);
export const REDACTED = "[REDACTED]";

export type SessionOpenPayload = {
  cwd: string | null;
  backing: SeatBacking;
  providerId: string;
  pinnedModel: string;
};
export type TurnStartPayload = { turnId: string; inputText: string };
export type ItemPayload = { turnId: string; item: Item };
export type ServedModelPayload = {
  turnId: string;
  requestedModel: string;
  servedModel: string;
  backing: SeatBacking;
  providerId: string;
};
export type TurnEndPayload = {
  turnId: string;
  status: Exclude<TurnStatus, "inProgress">;
  error: { code: number; message: string } | null;
};
export type SessionClosePayload = { reason: string };

export type SessionPayloads = {
  "session.open": SessionOpenPayload;
  "turn.start": TurnStartPayload;
  item: ItemPayload;
  servedModel: ServedModelPayload;
  "turn.end": TurnEndPayload;
  "session.close": SessionClosePayload;
};
export type SessionEventType = keyof SessionPayloads;
export const SESSION_EVENT_TYPES: readonly SessionEventType[] = Object.freeze([
  "session.open",
  "turn.start",
  "item",
  "servedModel",
  "turn.end",
  "session.close",
]);

export type SessionEvent<T extends SessionEventType = SessionEventType> = {
  v: 1;
  seq: number;
  ts: number;
  type: T;
  threadId: string;
  seatId: string;
  prevHash: string;
  hash: string;
  payload: SessionPayloads[T];
};

// ------------------------------------------------------------------ hashing

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Sorted-key JSON (seat pin §4.3): keys sorted recursively (JS default sort), arrays keep order,
 * no whitespace, `JSON.stringify` value rules (so `undefined`-valued keys are omitted).
 */
export function sortedKeyJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (!isPlainRecord(v)) return v;
    // Object.fromEntries defines own data properties, so a `__proto__` key is kept (and hashed)
    // instead of hitting the prototype setter.
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, v[k]]),
    );
  });
}

/** `sha256_hex(prevHash + "\n" + sortedKeyJson(body))`, body = envelope minus prevHash / hash. */
export function sessionEventHash(
  prevHash: string,
  body: Omit<SessionEvent, "prevHash" | "hash">,
): string {
  const { v, seq, ts, type, threadId, seatId, payload } = body;
  const canonical = sortedKeyJson({ v, seq, ts, type, threadId, seatId, payload });
  return createHash("sha256").update(`${prevHash}\n${canonical}`, "utf8").digest("hex");
}

// ---------------------------------------------------------------- redaction

/** Token shapes redacted from every payload string (seat pin §4.2). */
export const TOKEN_PATTERNS: readonly RegExp[] = Object.freeze([
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bxox[abp]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
]);

/**
 * Redactor for one append: (1) every exact secret value the engine holds (longest first) and then
 * (2) every token-shaped substring becomes `[REDACTED]`, in every string of the payload (object
 * keys included). Returns a new value; the input is not mutated.
 */
export function createRedactor(secrets: readonly string[]): (value: unknown) => unknown {
  const exact = [...new Set(secrets.filter((s) => s !== ""))].sort((a, b) => b.length - a.length);
  const redactString = (s: string): string => {
    let out = s;
    for (const secret of exact) if (out.includes(secret)) out = out.split(secret).join(REDACTED);
    for (const re of TOKEN_PATTERNS) out = out.replace(re, REDACTED);
    return out;
  };
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return redactString(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value !== null && typeof value === "object") {
      // Own data properties only (a `__proto__` key stays a key, never the prototype setter).
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [redactString(k), walk(v)]));
    }
    return value;
  };
  return walk;
}

// ------------------------------------------------------------------- writer

export function sessionWriteFailed(threadId: string, path: string, seq: number): RpcError {
  return new RpcError(ErrorCode.SessionWriteFailed, "Session write failed", {
    threadId,
    path,
    seq,
  } satisfies SessionWriteFailedData);
}

// O_NOFOLLOW: a symlink at the path fails (ELOOP). O_NONBLOCK: a FIFO planted at the path fails
// (ENXIO) or opens without blocking; the fd is then fstat-checked to be a regular file.
const APPEND_BASE_FLAGS = constants.O_WRONLY | constants.O_APPEND | (constants.O_NONBLOCK ?? 0);
const APPEND_FLAGS = APPEND_BASE_FLAGS | (constants.O_NOFOLLOW ?? 0);
const HAS_APPEND_NOFOLLOW = constants.O_NOFOLLOW !== undefined;

let appendOpenOpts: OpenNoFollowOptions = {};

/** Test seam: force the no-O_NOFOLLOW append path / inject a swap after lstat (null resets). Internal. */
export function setSessionAppendOpenForTests(opts: OpenNoFollowOptions | null): void {
  appendOpenOpts = opts ?? {};
}

/**
 * Open the session file for appending without following a symlink. With O_NOFOLLOW this is one
 * open. Without it (e.g. Windows) it is lstat → open → fstat, and the fd is used only if it is the
 * very file lstat saw (same dev + inode), as lock.ts `openNoFollow` does for reads: a symlink, or a
 * swap to one between lstat and open, is refused before a byte is written.
 */
function openForAppend(path: string): number {
  const noFollowFlag = appendOpenOpts.noFollowFlag ?? HAS_APPEND_NOFOLLOW;
  if (noFollowFlag) return openSync(path, APPEND_FLAGS);
  const seen = lstatSync(path, { bigint: true });
  if (seen.isSymbolicLink()) throw new Error("session file is a symlink");
  appendOpenOpts.afterLstat?.();
  const fd = openSync(path, APPEND_BASE_FLAGS);
  const opened = fstatSync(fd, { bigint: true });
  if (opened.dev !== seen.dev || opened.ino !== seen.ino) {
    closeSync(fd);
    throw new Error("session file changed while it was being opened");
  }
  return fd;
}

/**
 * The open fd is the file now at `path`, and `path` (every component, parents included) resolves to
 * a real path `accept` allows. A parent directory swapped for a symlink after the path was confined
 * changes the real path; a swap undone after the open changes the inode. Either is refused.
 */
function fdIsFileAt(fd: number, path: string, accept: (real: string) => boolean): boolean {
  const real = realpathSync(path);
  if (!accept(real)) return false;
  const seen = lstatSync(real, { bigint: true });
  const opened = fstatSync(fd, { bigint: true });
  return seen.dev === opened.dev && seen.ino === opened.ino;
}

/** True without a home; with one, `real` must be strictly under realpath(home). */
function resolvesUnderHome(real: string, home: string | undefined): boolean {
  if (home === undefined) return true;
  try {
    return isStrictlyUnder(real, realpathSync(home));
  } catch {
    return false;
  }
}

type WriteChunk = (fd: number, buf: Buffer, off: number, len: number) => number;
let writeChunk: WriteChunk = (fd, buf, off, len) => writeSync(fd, buf, off, len);

/** Test seam: replace the low-level write (null restores `writeSync`). Internal. */
export function setSessionWriteForTests(fn: WriteChunk | null): void {
  writeChunk = fn ?? ((fd, buf, off, len) => writeSync(fd, buf, off, len));
}

/**
 * Appender for one session file. Each append opens the file (`O_APPEND`, never following a
 * symlink), writes its full line(s) through one fd, and closes it. A failed append is rolled back
 * (the file is truncated to its size before the append, best effort), so a torn line or half of a
 * multi-event append is never left behind. After any failed append the writer is broken: every
 * later append fails with the same -32009 and nothing more is written.
 */
export class SessionWriter {
  readonly path: string;
  readonly threadId: string;
  readonly seatId: string;
  #seq: number;
  #prevHash: string;
  #broken = false;
  readonly #secrets: () => readonly string[];
  /**
   * Real path at create / resume; with a home it was checked to be strictly under realpath(home).
   * Every append must still resolve here.
   */
  readonly #realPath: string;

  private constructor(
    path: string,
    realPath: string,
    threadId: string,
    seatId: string,
    seq: number,
    prevHash: string,
    secrets: () => readonly string[],
  ) {
    this.path = path;
    this.#realPath = realPath;
    this.threadId = threadId;
    this.seatId = seatId;
    this.#seq = seq;
    this.#prevHash = prevHash;
    this.#secrets = secrets;
  }

  /**
   * Start a new session: create the file exclusively (0600) and append `session.open` (seq 0).
   * Any failure → -32009 `{ threadId, path, seq: 0 }`, and a file this call created is removed.
   * With `home`, the created file must resolve strictly under realpath(home) before anything is
   * written (a `sessions/` swapped for a symlink before the snapshot is refused).
   */
  static create(
    path: string,
    threadId: string,
    seatId: string,
    open: SessionOpenPayload,
    secrets: () => readonly string[],
    ts: number = Date.now(),
    home?: string,
  ): SessionWriter {
    let fd: number;
    try {
      fd = openSync(path, APPEND_FLAGS | constants.O_CREAT | constants.O_EXCL, 0o600);
      closeSync(fd);
    } catch {
      throw sessionWriteFailed(threadId, path, 0);
    }
    let realPath: string;
    try {
      realPath = realpathSync(path);
    } catch {
      try {
        unlinkSync(path);
      } catch {
        // best effort: the file was created by this call under the thread lock
      }
      throw sessionWriteFailed(threadId, path, 0);
    }
    if (!resolvesUnderHome(realPath, home)) {
      // Never unlink through a path that now resolves outside the home; nothing was written.
      throw sessionWriteFailed(threadId, path, 0);
    }
    const writer = new SessionWriter(path, realPath, threadId, seatId, 0, GENESIS_HASH, secrets);
    try {
      writer.append("session.open", open, ts);
    } catch (err) {
      try {
        unlinkSync(path);
      } catch {
        // best effort: the file was created by this call under the thread lock
      }
      throw err;
    }
    return writer;
  }

  /**
   * Continue a verified session (resume): next seq and last hash come from `verifySession`. With
   * `home`, the file must still resolve strictly under realpath(home) (else -32009).
   */
  static resume(
    path: string,
    threadId: string,
    seatId: string,
    nextSeq: number,
    lastHash: string,
    secrets: () => readonly string[],
    home?: string,
  ): SessionWriter {
    let realPath: string;
    try {
      realPath = realpathSync(path);
    } catch {
      throw sessionWriteFailed(threadId, path, nextSeq);
    }
    if (!resolvesUnderHome(realPath, home)) throw sessionWriteFailed(threadId, path, nextSeq);
    return new SessionWriter(path, realPath, threadId, seatId, nextSeq, lastHash, secrets);
  }

  get nextSeq(): number {
    return this.#seq;
  }

  get broken(): boolean {
    return this.#broken;
  }

  /** Redact, hash, and append one event. Returns the event exactly as written. */
  append<T extends SessionEventType>(
    type: T,
    payload: SessionPayloads[T],
    ts: number = Date.now(),
  ): SessionEvent<T> {
    return this.appendAll([{ type, payload }], ts)[0] as SessionEvent<T>;
  }

  /**
   * Append several events as one unit (consecutive seqs, one write through one fd): either all of
   * them are durable or none is (rolled back on failure). Used for the servedModel dual write.
   */
  appendAll(
    entries: ReadonlyArray<{ type: SessionEventType; payload: SessionPayloads[SessionEventType] }>,
    ts: number = Date.now(),
  ): SessionEvent[] {
    const firstSeq = this.#seq;
    if (this.#broken) throw sessionWriteFailed(this.threadId, this.path, firstSeq);
    const redact = createRedactor(this.#secrets());
    const events: SessionEvent[] = [];
    let prevHash = this.#prevHash;
    for (const [i, { type, payload }] of entries.entries()) {
      const redacted = redact(payload) as SessionPayloads[SessionEventType];
      const body = {
        v: 1 as const,
        seq: firstSeq + i,
        ts,
        type,
        threadId: this.threadId,
        seatId: this.seatId,
        payload: redacted,
      };
      const hash = sessionEventHash(prevHash, body);
      // Line key order stays v..seatId, prevHash, hash, payload (as A4 has always written it);
      // the hash itself uses sorted keys.
      const { payload: p, ...head } = body;
      events.push({ ...head, prevHash, hash, payload: p });
      prevHash = hash;
    }
    const text = events.map((e) => `${JSON.stringify(e)}\n`).join("");
    const bytes = Buffer.from(text, "utf8");
    try {
      const fd = openForAppend(this.path);
      try {
        const st = fstatSync(fd);
        if (!st.isFile()) throw new Error("session file is not a regular file");
        if (!fdIsFileAt(fd, this.path, (real) => real === this.#realPath)) {
          throw new Error("session file no longer resolves to its confined path");
        }
        const sizeBefore = st.size;
        try {
          let off = 0;
          while (off < bytes.length) off += writeChunk(fd, bytes, off, bytes.length - off);
        } catch (err) {
          try {
            ftruncateSync(fd, sizeBefore);
          } catch {
            // best effort; the verifier still rejects a torn tail
          }
          throw err;
        }
      } finally {
        closeSync(fd);
      }
    } catch {
      this.#broken = true;
      throw sessionWriteFailed(this.threadId, this.path, firstSeq);
    }
    this.#seq = firstSeq + events.length;
    this.#prevHash = prevHash;
    return events;
  }
}

// ------------------------------------------------------------------- verify

export type SessionVerifyResult =
  | {
      readonly ok: true;
      readonly events: readonly SessionEvent[];
      readonly nextSeq: number;
      readonly lastHash: string;
    }
  | { readonly ok: false; readonly line: number; readonly reason: string };

const ENVELOPE_KEYS = [
  "hash",
  "payload",
  "prevHash",
  "seatId",
  "seq",
  "threadId",
  "ts",
  "type",
  "v",
].join(",");

/**
 * Verify a session file's text (seat pin §4.3): recompute every hash forward from seq 0. Any
 * unparseable line, envelope drift, seq gap, prevHash break, hash mismatch, thread / seat change,
 * or unterminated last line fails, reporting the 1-based line number. Payloads are not
 * shape-checked here and unknown event types pass, so events added later (envelope v:1) still
 * verify; `rebuildSession` checks the M0 payload shapes before any state is built from them.
 */
export function verifySessionText(text: string, expectedThreadId?: string): SessionVerifyResult {
  if (text === "") return { ok: false, line: 1, reason: "empty session file" };
  if (!text.endsWith("\n")) {
    return { ok: false, line: text.split("\n").length, reason: "unterminated last line" };
  }
  const lines = text.slice(0, -1).split("\n");
  const events: SessionEvent[] = [];
  let prevHash = GENESIS_HASH;
  let threadId = expectedThreadId;
  let seatId: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const fail = (reason: string): SessionVerifyResult => ({ ok: false, line: i + 1, reason });
    let e: SessionEvent;
    try {
      e = JSON.parse(lines[i] ?? "") as SessionEvent;
    } catch {
      return fail("line is not valid JSON");
    }
    if (!isPlainRecord(e)) return fail("line is not a JSON object");
    if (Object.keys(e).sort().join(",") !== ENVELOPE_KEYS) return fail("envelope keys differ");
    if (e.v !== 1) return fail("unsupported v");
    if (e.seq !== i) return fail(`seq ${String(e.seq)} where ${i} expected`);
    if (typeof e.ts !== "number" || !Number.isFinite(e.ts)) return fail("ts is not a number");
    // Unknown event types are tolerated (later milestones add events additively, envelope v:1).
    if (typeof e.type !== "string" || (e.type as string) === "")
      return fail("type is not a string");
    if ((i === 0) !== (e.type === "session.open")) return fail("session.open must be line 1 only");
    if (typeof e.threadId !== "string" || !isValidId(e.threadId)) return fail("bad threadId");
    if (threadId !== undefined && e.threadId !== threadId) return fail("threadId changed");
    threadId = e.threadId;
    if (typeof e.seatId !== "string" || !isValidId(e.seatId)) return fail("bad seatId");
    if (seatId !== undefined && e.seatId !== seatId) return fail("seatId changed");
    seatId = e.seatId;
    if (e.prevHash !== prevHash) return fail("prevHash does not match the previous hash");
    if (!isPlainRecord(e.payload)) return fail("payload is not an object");
    if (sessionEventHash(prevHash, e) !== e.hash) return fail("hash mismatch");
    prevHash = e.hash;
    events.push(e);
  }
  return { ok: true, events, nextSeq: events.length, lastHash: prevHash };
}

const isStr = (v: unknown): v is string => typeof v === "string";
const TURN_END_STATUSES: readonly unknown[] = ["completed", "interrupted", "failed"];

const ITEM_STATUSES: readonly unknown[] = ["inProgress", "completed", "failed"];
const SERVED_BACKINGS: readonly unknown[] = ["kimi-code", "claude-code", "codex"];

/** Each M0 `Item` variant (protocol/types.ts) with its required fields. Extra fields are allowed. */
function isM0Item(item: unknown): boolean {
  if (!isPlainRecord(item) || !isValidId(item.id) || !ITEM_STATUSES.includes(item.status)) {
    return false;
  }
  switch (item.kind) {
    case "userMessage":
      return (
        Array.isArray(item.content) &&
        item.content.every(
          (part: unknown) => isPlainRecord(part) && part.type === "text" && isStr(part.text),
        )
      );
    case "agentMessage":
      return isStr(item.text);
    case "toolCall":
      return isStr(item.name) && Object.hasOwn(item, "arguments");
    case "toolResult":
      return (
        isStr(item.callId) &&
        isStr(item.name) &&
        isStr(item.output) &&
        typeof item.isError === "boolean"
      );
    case "error":
      return isStr(item.message) && (item.code === undefined || typeof item.code === "number");
    case "servedModel":
      return (
        isStr(item.requestedModel) &&
        isStr(item.servedModel) &&
        SERVED_BACKINGS.includes(item.backing) &&
        isStr(item.providerId)
      );
    default:
      return false;
  }
}

/**
 * Shape of each M0 event payload (what `rebuildSession` reads). Extra fields are allowed. A
 * hash-valid line with a malformed payload makes `rebuildSession` throw, so a crafted file is
 * skipped by list and refused by resume (-32603), never crashing either.
 */
function checkPayload(type: SessionEventType, p: Record<string, unknown>): string | null {
  switch (type) {
    case "session.open":
      return (p.cwd === null || isStr(p.cwd)) &&
        SERVED_BACKINGS.includes(p.backing) &&
        isStr(p.providerId) &&
        isStr(p.pinnedModel)
        ? null
        : "malformed session.open payload";
    case "turn.start":
      return isValidId(p.turnId) && isStr(p.inputText) ? null : "malformed turn.start payload";
    case "item":
      return isValidId(p.turnId) && isM0Item(p.item) ? null : "malformed item payload";
    case "servedModel":
      return isValidId(p.turnId) &&
        isStr(p.requestedModel) &&
        isStr(p.servedModel) &&
        SERVED_BACKINGS.includes(p.backing) &&
        isStr(p.providerId)
        ? null
        : "malformed servedModel payload";
    case "turn.end": {
      const err = p.error;
      const errOk =
        err === null || (isPlainRecord(err) && typeof err.code === "number" && isStr(err.message));
      return isValidId(p.turnId) && TURN_END_STATUSES.includes(p.status) && errOk
        ? null
        : "malformed turn.end payload";
    }
    case "session.close":
      return isStr(p.reason) ? null : "malformed session.close payload";
  }
}

/**
 * Read and verify `sessions/<threadId>.jsonl`. The final path component must be a regular file,
 * never a symlink, so a planted link cannot make list / resume / the home report read data from
 * outside `MADC_HOME`. The open is `openNoFollow` (lock.ts): `O_NOFOLLOW` where available,
 * otherwise lstat → open → fstat with the same dev + inode required, so a swap to a symlink
 * between the check and the open is refused. With `home`, the opened file must also still resolve
 * (parent directories included) strictly under the real `home`, and be the file found there, so a
 * `sessions/` directory swapped for a symlink after confinement is never read. `opts` are test seams.
 */
export function verifySessionFile(
  path: string,
  expectedThreadId?: string,
  opts: OpenNoFollowOptions = {},
  home?: string,
): SessionVerifyResult {
  let text: string;
  try {
    const fd = openNoFollow(path, opts);
    if (fd === null) return { ok: false, line: 0, reason: "session file is unreadable" };
    if (fd === "symlink") {
      return { ok: false, line: 0, reason: "session file is not a regular file" };
    }
    try {
      if (!fstatSync(fd).isFile()) {
        return { ok: false, line: 0, reason: "session file is not a regular file" };
      }
      if (home !== undefined) {
        const realHome = realpathSync(home);
        if (!fdIsFileAt(fd, path, (real) => isStrictlyUnder(real, realHome))) {
          return { ok: false, line: 0, reason: "session file resolves outside MADC_HOME" };
        }
      }
      text = readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return { ok: false, line: 0, reason: "session file is unreadable" };
  }
  return verifySessionText(text, expectedThreadId);
}

// ------------------------------------------------------------------ rebuild

export type RebuiltSession = {
  readonly thread: Thread;
  readonly turns: Turn[];
  /** Turns whose `turn.end` is missing (engine died mid-turn); rebuilt as `interrupted`. */
  readonly danglingTurnIds: string[];
};

/**
 * Rebuild thread + turns from verified events (thread/resume, thread/list). Turns are engine state
 * only; they are not replayed to the model in M0-A4 (Surface ruling on PR #12, item 12).
 */
export function rebuildSession(events: readonly SessionEvent[], now = Date.now()): RebuiltSession {
  const open = events[0] as SessionEvent<"session.open"> | undefined;
  if (open === undefined || open.type !== "session.open") {
    throw new Error("session does not start with session.open");
  }
  const turns = new Map<string, Turn>();
  let preview: string | null = null;
  for (const e of events) {
    // Payload shapes are checked here, for the M0 event types only: the verifier covers the
    // envelope, seq and hash chain; unknown event types and extra payload fields are ignored.
    if (SESSION_EVENT_TYPES.includes(e.type)) {
      const issue = checkPayload(e.type, e.payload as Record<string, unknown>);
      if (issue !== null) throw new Error(`line ${e.seq + 1}: ${issue}`);
    }
    if (e.type === "turn.start") {
      const p = e.payload as TurnStartPayload;
      turns.set(p.turnId, {
        id: p.turnId,
        threadId: open.threadId,
        status: "inProgress",
        items: [],
        error: null,
        startedAt: e.ts,
        completedAt: null,
      });
    } else if (e.type === "item") {
      const p = e.payload as ItemPayload;
      turns.get(p.turnId)?.items.push(p.item);
      if (preview === null && p.item.kind === "userMessage") {
        preview = p.item.content[0]?.text ?? "";
      }
    } else if (e.type === "turn.end") {
      const p = e.payload as TurnEndPayload;
      const turn = turns.get(p.turnId);
      if (turn !== undefined) {
        turn.status = p.status;
        turn.error = p.status === "failed" ? (p.error as RpcErrorBody | null) : null;
        turn.completedAt = e.ts;
      }
    }
  }
  const danglingTurnIds: string[] = [];
  for (const turn of turns.values()) {
    if (turn.status === "inProgress") {
      danglingTurnIds.push(turn.id);
      turn.status = "interrupted";
      turn.completedAt = now;
    }
  }
  const last = events[events.length - 1] ?? open;
  const all = [...turns.values()];
  return {
    thread: {
      id: open.threadId,
      seatId: open.seatId,
      cwd: open.payload.cwd,
      createdAt: open.ts,
      updatedAt: last.ts,
      status: "idle",
      preview: preview ?? "",
    },
    turns: all,
    danglingTurnIds,
  };
}
