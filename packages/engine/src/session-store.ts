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
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
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

const APPEND_FLAGS = constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0);

/**
 * Appender for one session file. Each append opens the file (`O_APPEND`, never following a
 * symlink), writes one full line, and closes it. After any failed append the writer is broken:
 * every later append fails with the same -32009 and nothing more is written, so a torn line is
 * never followed by more events.
 */
export class SessionWriter {
  readonly path: string;
  readonly threadId: string;
  readonly seatId: string;
  #seq: number;
  #prevHash: string;
  #broken = false;
  readonly #secrets: () => readonly string[];

  private constructor(
    path: string,
    threadId: string,
    seatId: string,
    seq: number,
    prevHash: string,
    secrets: () => readonly string[],
  ) {
    this.path = path;
    this.threadId = threadId;
    this.seatId = seatId;
    this.#seq = seq;
    this.#prevHash = prevHash;
    this.#secrets = secrets;
  }

  /**
   * Start a new session: create the file exclusively (0600) and append `session.open` (seq 0).
   * Any failure → -32009 `{ threadId, path, seq: 0 }`, and a file this call created is removed.
   */
  static create(
    path: string,
    threadId: string,
    seatId: string,
    open: SessionOpenPayload,
    secrets: () => readonly string[],
    ts: number = Date.now(),
  ): SessionWriter {
    let fd: number;
    try {
      fd = openSync(path, APPEND_FLAGS | constants.O_CREAT | constants.O_EXCL, 0o600);
      closeSync(fd);
    } catch {
      throw sessionWriteFailed(threadId, path, 0);
    }
    const writer = new SessionWriter(path, threadId, seatId, 0, GENESIS_HASH, secrets);
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

  /** Continue a verified session (resume): next seq and last hash come from `verifySession`. */
  static resume(
    path: string,
    threadId: string,
    seatId: string,
    nextSeq: number,
    lastHash: string,
    secrets: () => readonly string[],
  ): SessionWriter {
    return new SessionWriter(path, threadId, seatId, nextSeq, lastHash, secrets);
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
    const seq = this.#seq;
    if (this.#broken) throw sessionWriteFailed(this.threadId, this.path, seq);
    const redacted = createRedactor(this.#secrets())(payload) as SessionPayloads[T];
    const body = {
      v: 1 as const,
      seq,
      ts,
      type,
      threadId: this.threadId,
      seatId: this.seatId,
      payload: redacted,
    };
    const hash = sessionEventHash(this.#prevHash, body);
    const event: SessionEvent<T> = {
      v: 1,
      seq,
      ts,
      type,
      threadId: this.threadId,
      seatId: this.seatId,
      prevHash: this.#prevHash,
      hash,
      payload: redacted,
    };
    const bytes = Buffer.from(`${JSON.stringify(event)}\n`, "utf8");
    try {
      const fd = openSync(this.path, APPEND_FLAGS);
      try {
        let off = 0;
        while (off < bytes.length) off += writeSync(fd, bytes, off, bytes.length - off);
      } finally {
        closeSync(fd);
      }
    } catch {
      this.#broken = true;
      throw sessionWriteFailed(this.threadId, this.path, seq);
    }
    this.#seq = seq + 1;
    this.#prevHash = hash;
    return event;
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
 * or unterminated last line fails, reporting the 1-based line number.
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
    if (!SESSION_EVENT_TYPES.includes(e.type)) return fail("unknown event type");
    if ((i === 0) !== (e.type === "session.open")) return fail("session.open must be line 1 only");
    if (typeof e.threadId !== "string" || !isValidId(e.threadId)) return fail("bad threadId");
    if (threadId !== undefined && e.threadId !== threadId) return fail("threadId changed");
    threadId = e.threadId;
    if (typeof e.seatId !== "string" || !isValidId(e.seatId)) return fail("bad seatId");
    if (seatId !== undefined && e.seatId !== seatId) return fail("seatId changed");
    seatId = e.seatId;
    if (e.prevHash !== prevHash) return fail("prevHash does not match the previous hash");
    if (!isPlainRecord(e.payload)) return fail("payload is not an object");
    const payloadIssue = checkPayload(e.type, e.payload);
    if (payloadIssue !== null) return fail(payloadIssue);
    if (sessionEventHash(prevHash, e) !== e.hash) return fail("hash mismatch");
    prevHash = e.hash;
    events.push(e);
  }
  return { ok: true, events, nextSeq: events.length, lastHash: prevHash };
}

const isStr = (v: unknown): v is string => typeof v === "string";
const TURN_END_STATUSES: readonly unknown[] = ["completed", "interrupted", "failed"];

/**
 * Shape of each event payload (what `rebuildSession` reads). A hash-valid line with a malformed
 * payload is rejected like any other bad line, so a crafted file can never crash list / resume.
 */
function checkPayload(type: SessionEventType, p: Record<string, unknown>): string | null {
  switch (type) {
    case "session.open":
      return (p.cwd === null || isStr(p.cwd)) &&
        isStr(p.backing) &&
        isStr(p.providerId) &&
        isStr(p.pinnedModel)
        ? null
        : "malformed session.open payload";
    case "turn.start":
      return isValidId(p.turnId) && isStr(p.inputText) ? null : "malformed turn.start payload";
    case "item": {
      const item = p.item;
      if (!isValidId(p.turnId) || !isPlainRecord(item) || !isStr(item.id) || !isStr(item.kind)) {
        return "malformed item payload";
      }
      if (
        item.kind === "userMessage" &&
        !(
          Array.isArray(item.content) &&
          item.content.every((part: unknown) => isPlainRecord(part) && isStr(part.text))
        )
      ) {
        return "malformed item payload";
      }
      return null;
    }
    case "servedModel":
      return isValidId(p.turnId) &&
        isStr(p.requestedModel) &&
        isStr(p.servedModel) &&
        isStr(p.backing) &&
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

const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

/**
 * Read and verify `sessions/<threadId>.jsonl`. The final path component must be a regular file,
 * never a symlink (lstat + `O_NOFOLLOW` where available), so a planted link cannot make list /
 * resume / the home report read data from outside `MADC_HOME`.
 */
export function verifySessionFile(path: string, expectedThreadId?: string): SessionVerifyResult {
  let text: string;
  try {
    if (!lstatSync(path).isFile()) {
      return { ok: false, line: 0, reason: "session file is not a regular file" };
    }
    const fd = openSync(path, READ_FLAGS);
    try {
      if (!fstatSync(fd).isFile()) {
        return { ok: false, line: 0, reason: "session file is not a regular file" };
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
