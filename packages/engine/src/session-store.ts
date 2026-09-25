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
  fsyncSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
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
    // A function never serializes as data, but an own `toJSON` hook would run during the final
    // stringify, after redaction. Functions become undefined: dropped from objects (a `toJSON`
    // property included), null in arrays, as JSON.stringify already rendered them.
    if (typeof value === "function") return undefined;
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

type SyncFile = (fd: number) => void;
type SyncDir = (dir: string) => void;
const defaultSyncFile: SyncFile = (fd) => fsyncSync(fd);
/**
 * Amendment 2 §4: after a session file is created, fsync its directory so the new name survives a
 * crash. POSIX only; on Windows a directory cannot be opened for fsync, so this is a no-op.
 */
const defaultSyncDir: SyncDir = (dir) => {
  if (process.platform === "win32") return;
  const fd = openSync(dir, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};
let syncFile: SyncFile = defaultSyncFile;
let syncDir: SyncDir = defaultSyncDir;

/**
 * Test seam (Amendment 2 §8 item 4): observe or fail the per-append file fsync and the `sessions/`
 * directory fsync on create. `null` (or an omitted field) restores the real fsync. Internal.
 */
export function setSessionFsyncForTests(hooks: { file?: SyncFile; dir?: SyncDir } | null): void {
  syncFile = hooks?.file ?? defaultSyncFile;
  syncDir = hooks?.dir ?? defaultSyncDir;
}

/**
 * Amendment 2 guards for one writer. `holdsLock` is the §2 ownership check (the thread lock still
 * carries this acquisition's token; server passes `holdsThreadLock(handle)`). `expectedSize` is the
 * verified file size at resume (§2 position). Both default to "no lock bound" / "size seen now" for
 * direct unit use; the engine always passes them.
 */
export type SessionWriterGuards = {
  readonly holdsLock?: () => boolean;
  readonly expectedSize?: number | undefined;
};

/**
 * Appender for one session file. Each append opens the file (`O_APPEND`, never following a
 * symlink), re-checks ownership and position on that fd (Amendment 2 §2), writes its full line(s)
 * through the same fd, fsyncs it (§4), and closes it. A failed write or fsync is rolled back (the
 * file is truncated to its size before the append, best effort), so a torn line or half of a
 * multi-event append is never left behind; a failed ownership or position check writes nothing.
 * After any failed append the writer is broken: every later append fails with the same -32009 and
 * nothing more is written.
 */
export class SessionWriter {
  readonly path: string;
  readonly threadId: string;
  readonly seatId: string;
  #seq: number;
  #prevHash: string;
  #broken = false;
  /** §2 position: file size after this writer's last successful write (or verified at resume). */
  #expectedEnd: number;
  /** §2 ownership: the thread lock still carries this writer's acquisition token. */
  readonly #holdsLock: () => boolean;
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
    expectedEnd: number,
    holdsLock: () => boolean,
  ) {
    this.path = path;
    this.#expectedEnd = expectedEnd;
    this.#holdsLock = holdsLock;
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
   * written (a `sessions/` swapped for a symlink before the snapshot is refused). The new name is
   * made durable by an fsync of the `sessions/` directory before `session.open` is appended
   * (Amendment 2 §4); a failed directory fsync is a failed create (-32009, file removed).
   */
  static create(
    path: string,
    threadId: string,
    seatId: string,
    open: SessionOpenPayload,
    secrets: () => readonly string[],
    ts: number = Date.now(),
    home?: string,
    guards: SessionWriterGuards = {},
  ): SessionWriter {
    let created: { dev: bigint; ino: bigint };
    try {
      const fd = openSync(path, APPEND_FLAGS | constants.O_CREAT | constants.O_EXCL, 0o600);
      try {
        const st = fstatSync(fd, { bigint: true });
        created = { dev: st.dev, ino: st.ino };
      } finally {
        closeSync(fd);
      }
    } catch {
      throw sessionWriteFailed(threadId, path, 0);
    }
    // Cleanup only removes the file this call created, and only while `path` still resolves to it
    // inside the home: after a parent swap an unrelated file of the same name is never deleted.
    const removeCreated = (): void => {
      try {
        const real = realpathSync(path);
        const st = lstatSync(real, { bigint: true });
        if (resolvesUnderHome(real, home) && st.dev === created.dev && st.ino === created.ino) {
          unlinkSync(real);
        }
      } catch {
        // best effort: a leftover empty file under the thread lock is harmless
      }
    };
    let realPath: string;
    try {
      realPath = realpathSync(path);
    } catch {
      removeCreated();
      throw sessionWriteFailed(threadId, path, 0);
    }
    if (!resolvesUnderHome(realPath, home)) {
      // Never unlink through a path that now resolves outside the home; nothing was written.
      throw sessionWriteFailed(threadId, path, 0);
    }
    try {
      syncDir(dirname(realPath));
    } catch {
      removeCreated();
      throw sessionWriteFailed(threadId, path, 0);
    }
    const writer = new SessionWriter(
      path,
      realPath,
      threadId,
      seatId,
      0,
      GENESIS_HASH,
      secrets,
      0, // created exclusively just now: empty
      guards.holdsLock ?? (() => true),
    );
    try {
      writer.append("session.open", open, ts);
    } catch (err) {
      removeCreated();
      throw err;
    }
    return writer;
  }

  /**
   * Continue a verified session (resume): next seq and last hash come from `verifySession`. With
   * `home`, the file must still resolve strictly under realpath(home) (else -32009). With
   * `verifiedFile` (from `verifySessionFile`), it must still be that same file (dev + inode), so a
   * swap between verification and resume never continues another session's chain (else -32009).
   * `guards.expectedSize` is the verified byte size (Amendment 2 §2); every append requires the
   * file to still be exactly that long (plus this writer's own writes).
   */
  static resume(
    path: string,
    threadId: string,
    seatId: string,
    nextSeq: number,
    lastHash: string,
    secrets: () => readonly string[],
    home?: string,
    verifiedFile?: SessionFileId,
    guards: SessionWriterGuards = {},
  ): SessionWriter {
    let realPath: string;
    try {
      realPath = realpathSync(path);
    } catch {
      throw sessionWriteFailed(threadId, path, nextSeq);
    }
    if (!resolvesUnderHome(realPath, home)) throw sessionWriteFailed(threadId, path, nextSeq);
    let expectedEnd = guards.expectedSize;
    if (expectedEnd === undefined) {
      try {
        expectedEnd = lstatSync(realPath).size;
      } catch {
        throw sessionWriteFailed(threadId, path, nextSeq);
      }
    }
    if (verifiedFile !== undefined) {
      let st: { dev: bigint; ino: bigint };
      try {
        st = lstatSync(realPath, { bigint: true });
      } catch {
        throw sessionWriteFailed(threadId, path, nextSeq);
      }
      if (st.dev !== verifiedFile.dev || st.ino !== verifiedFile.ino) {
        throw sessionWriteFailed(threadId, path, nextSeq);
      }
    }
    return new SessionWriter(
      path,
      realPath,
      threadId,
      seatId,
      nextSeq,
      lastHash,
      secrets,
      expectedEnd,
      guards.holdsLock ?? (() => true),
    );
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
   *
   * Amendment 2: on the fd it writes through, the batch first requires (§2) that the thread lock
   * still carries this writer's token and that `fstat(fd).size` is the expected end offset; either
   * failing writes nothing. The write is then fsynced (§4) before it counts; a failed write or
   * fsync truncates back to the prior size. Any failure breaks the writer (-32009).
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
        // §2 ownership: another engine may have taken the thread (lock lost, reclaimed, or a
        // cross-namespace / three-engine reclaim). Never append under a lock we no longer hold.
        if (!this.#holdsLock())
          throw new Error("thread lock no longer carries this writer's token");
        // §2 position: the chain continues only from the bytes this writer last saw on disk.
        const sizeBefore = fstatSync(fd).size;
        if (sizeBefore !== this.#expectedEnd) {
          throw new Error("session file size differs from the writer's expected end offset");
        }
        try {
          let off = 0;
          while (off < bytes.length) off += writeChunk(fd, bytes, off, bytes.length - off);
          // §4: durable before it counts (and before any response or notification exposes it).
          syncFile(fd);
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
    this.#expectedEnd += bytes.length;
    return events;
  }
}

// ------------------------------------------------------------------- verify

/**
 * Amendment 2 §5 failure classes. `torn-tail`: every complete (`\n`-terminated) line verifies and
 * only a non-empty unterminated fragment and/or NUL bytes follow the last `\n` (crash residue).
 * `integrity`: anything else (hash / seq mismatch, malformed complete line, wrong thread, empty or
 * unreadable file); may be tampering. Either way the engine fails closed and never touches the file.
 */
export type SessionFailureKind = "torn-tail" | "integrity";

export type SessionVerifyResult =
  | {
      readonly ok: true;
      readonly events: readonly SessionEvent[];
      readonly nextSeq: number;
      readonly lastHash: string;
      /** `verifySessionFile` only: identity of the file that was read and verified. */
      readonly file?: SessionFileId;
      /** `verifySessionFile` only: byte size of the verified contents (Amendment 2 §2). */
      readonly size?: number;
    }
  | {
      readonly ok: false;
      readonly line: number;
      readonly reason: string;
      readonly kind: SessionFailureKind;
    };

/** dev + inode of a session file (bigint, as `fstat` reports it). */
export type SessionFileId = { readonly dev: bigint; readonly ino: bigint };

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
 * A failure is classified (Amendment 2 §5): an unterminated last line after complete lines that
 * all verify is `torn-tail`; every other failure is `integrity`.
 */
export function verifySessionText(text: string, expectedThreadId?: string): SessionVerifyResult {
  if (text === "") return { ok: false, line: 1, reason: "empty session file", kind: "integrity" };
  if (!text.endsWith("\n")) {
    const complete = text.slice(0, text.lastIndexOf("\n") + 1);
    // The complete lines must verify on their own; a failure there is an integrity failure, even
    // with a torn tail after it.
    if (complete !== "") {
      const head = verifyCompleteLines(complete, expectedThreadId);
      if (!head.ok) return head;
    }
    return {
      ok: false,
      line: text.split("\n").length,
      reason: "unterminated last line",
      kind: "torn-tail",
    };
  }
  return verifyCompleteLines(text, expectedThreadId);
}

/** `text` is non-empty and ends with `\n`. */
function verifyCompleteLines(text: string, expectedThreadId?: string): SessionVerifyResult {
  const lines = text.slice(0, -1).split("\n");
  const events: SessionEvent[] = [];
  let prevHash = GENESIS_HASH;
  let threadId = expectedThreadId;
  let seatId: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const fail = (reason: string): SessionVerifyResult => ({
      ok: false,
      line: i + 1,
      reason,
      kind: "integrity",
    });
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
  const refuse = (reason: string): SessionVerifyResult => ({
    ok: false,
    line: 0,
    reason,
    kind: "integrity",
  });
  let bytes: Buffer;
  let file: SessionFileId;
  try {
    const fd = openNoFollow(path, opts);
    if (fd === null) return refuse("session file is unreadable");
    if (fd === "symlink") return refuse("session file is not a regular file");
    try {
      const st = fstatSync(fd, { bigint: true });
      if (!st.isFile()) return refuse("session file is not a regular file");
      file = { dev: st.dev, ino: st.ino };
      if (home !== undefined) {
        const realHome = realpathSync(home);
        if (!fdIsFileAt(fd, path, (real) => isStrictlyUnder(real, realHome))) {
          return refuse("session file resolves outside MADC_HOME");
        }
      }
      bytes = readFileSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    return refuse("session file is unreadable");
  }
  const result = verifySessionText(bytes.toString("utf8"), expectedThreadId);
  return result.ok ? { ...result, file, size: bytes.length } : result;
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
        // Only {code, message} is rebuilt (ruling item 8), whatever extra fields a line carries.
        const err = p.error as RpcErrorBody | null;
        turn.error =
          p.status === "failed" && err !== null ? { code: err.code, message: err.message } : null;
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
