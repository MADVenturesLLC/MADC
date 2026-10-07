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
import { getById, type ProviderStatus } from "@madc/registry";
import { isStrictlyUnder } from "./home.ts";
import { type OpenNoFollowOptions, openNoFollow } from "./lock.ts";
import type { Presence } from "./presence/policy.ts";
import {
  ErrorCode,
  evidenceInvalid,
  RpcError,
  type SessionWriteFailedData,
} from "./protocol/errors.ts";
import { isValidId } from "./protocol/ids.ts";
import type { Item, RpcErrorBody, Thread, Turn, TurnMode, TurnStatus } from "./protocol/types.ts";
import {
  type BriefServedMarker,
  checkV2Payload,
  type FounderDecisionPayload,
  type HandoffAbortedPayload,
  type HandoffLinkPayload,
  type HandoffOutPayload,
  RESERVED_EVENT_TYPES,
  type ReservedEventType,
  redactionRefusal,
  SessionChainIndex,
  type SessionOpenHandoffLink,
  turnIdOf,
  validateForWrite,
  type WorktreeIdentity,
  type WriteRefusal,
} from "./session-v2.ts";

export const GENESIS_HASH = "0".repeat(64);
export const REDACTED = "[REDACTED]";

export type SessionOpenPayload = {
  cwd: string | null;
  /** Any wired registry id (seat pin S1, widened in M1-A3; M0 was the SeatBacking union). */
  backing: string;
  providerId: string;
  pinnedModel: string;
  /**
   * M2 pin §2.1 / §2.2 (schema v2, additive): a v2 engine writes BOTH `handoff` (the source link of
   * a handoff target, else null) and `worktree` (engine-owned identity, else null); a v1 line has
   * neither. One without the other is refused at write time and is an integrity failure on read.
   */
  handoff?: SessionOpenHandoffLink | null;
  worktree?: WorktreeIdentity | null;
};
/**
 * M1-A5 TTY facts of the presence check that verified a turn (M1 plan §7 M1-A5: "TTY facts … go
 * into `turn.start`"): the terminal's `device` (`major/minor`), its `session` id where the OS
 * exposes one (else null), and whether this turn's presence came from a fresh `keypress` or was
 * `carried` from an earlier confirmation on the same terminal. Present only with presence `verified`.
 */
export type TurnStartTty = {
  device: string;
  session: string | null;
  confirmation: "keypress" | "carried";
};
/**
 * `turn.start` (seat pin §4.2). M1-A5 writes `mode` (the claim; P3: absent → `headless`) and
 * `presence` on every new line, and `tty` exactly when presence is verified. They are optional in
 * this type because lines written before M1-A5 carry none of them; such a line reads as
 * `headless` / `absent`. A partial set is refused by `checkPayload`.
 */
export type TurnStartPayload = {
  turnId: string;
  inputText: string;
  mode?: TurnMode;
  presence?: Presence;
  tty?: TurnStartTty;
  /**
   * Brief-delivery pin §3 (M2-A4): the served marker on a handoff target's FIRST `turn.start`.
   * Optional: a line written before M2-A4, or on a target that served no brief, carries none.
   * Its shape and its once-only placement are validated by `checkV2Payload` / `briefServedPlacementIssues`.
   */
  briefServed?: BriefServedMarker;
};
export type ItemPayload = { turnId: string; item: Item };
export type ServedModelPayload = {
  turnId: string;
  requestedModel: string;
  servedModel: string;
  backing: string;
  providerId: string;
  /** P2 (M1 protocol pin §5 / seat pin §4.2): registry status of the serving lane. */
  lane: ProviderStatus;
  /** P2: the turn's mode — the claim (§3.3), `headless` when absent. */
  mode: TurnMode;
  /** P2: previous backing id on a fallback hop; null on the primary. */
  fallbackFrom: string | null;
  /** P2: true only if the vendor/adapter reported a model identity. */
  vendorReported: boolean;
};
/** One lane identity for the same-lane rule (D-M1-7). Forbidden entries have no billing class. */
export type FallbackLane = { status: ProviderStatus; credentialClass: string };
/** Seat pin §4.2 (S4): a fallback candidate rejected before any call under the same-lane rule. */
export type FallbackRejectedPayload = {
  turnId: string;
  candidate: string;
  assignedLane: FallbackLane;
  candidateLane: FallbackLane;
  reason: "fallback-lane-mismatch";
};
export type TurnEndPayload = {
  turnId: string;
  status: Exclude<TurnStatus, "inProgress">;
  error: { code: number; message: string } | null;
};
/**
 * Seat pin §4.2 (S4, added by M1-A4): one repo-gated provider decision, recording the RESOLVED
 * identity (normalized remote, realpath'd top-level) and the reason. `remote` / `topLevel` are null
 * on the half that could not be resolved, so an ambiguous identity never reports a value it did not
 * establish. Carries no credential and never the caller-supplied `cwd` string.
 */
export type RepoDecisionPayload = {
  turnId: string;
  providerId: string;
  remote: string | null;
  topLevel: string | null;
  decision: "allow" | "deny";
  reason: string;
};
/**
 * `session.close` (seat pin §4.2). M2 pin §2.2 (D-M2-A0-5): a v2 engine writes it on every clean
 * shutdown, with `worktree.head` re-read at the RECORDED top-level (null when it can no longer be
 * read). Optional in the type because M1 never wrote the key.
 */
export type SessionClosePayload = { reason: string; worktree?: WorktreeIdentity | null };

export type {
  EvidenceRef,
  FounderDecisionPayload,
  HandoffAbortedPayload,
  HandoffAbortReason,
  HandoffLinkPayload,
  HandoffOutPayload,
  MemoryWritePayload,
  ReservedEventType,
  SessionOpenHandoffLink,
  ToolCallReceiptPayload,
  WorktreeIdentity,
} from "./session-v2.ts";
export { RESERVED_EVENT_TYPES, SessionChainIndex } from "./session-v2.ts";

export type SessionPayloads = {
  "session.open": SessionOpenPayload;
  "turn.start": TurnStartPayload;
  item: ItemPayload;
  servedModel: ServedModelPayload;
  "fallback.rejected": FallbackRejectedPayload;
  "repo.decision": RepoDecisionPayload;
  "turn.end": TurnEndPayload;
  "session.close": SessionClosePayload;
  // M2 pin §2 (schema v2 on the unchanged v:1 envelope, D-M2-A0-6). `memory.write` and
  // `tool.call` are deliberately NOT here: they are reserved for M4 (pin §4, §10 item 8).
  "handoff.out": HandoffOutPayload;
  "handoff.link": HandoffLinkPayload;
  "handoff.aborted": HandoffAbortedPayload;
  founderDecision: FounderDecisionPayload;
};
export type SessionEventType = keyof SessionPayloads;
/** The WRITABLE set. A reserved M4 name entering it before the M4 pin fails the §10 item 8 guard. */
export const SESSION_EVENT_TYPES: readonly SessionEventType[] = Object.freeze([
  "session.open",
  "turn.start",
  "item",
  "servedModel",
  "fallback.rejected",
  "repo.decision",
  "turn.end",
  "session.close",
  "handoff.out",
  "handoff.link",
  "handoff.aborted",
  "founderDecision",
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

/** Token shapes redacted from every payload string (seat pin §4.2, plus the M1 shapes of S6). */
export const TOKEN_PATTERNS: readonly RegExp[] = Object.freeze([
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  // S6 (M1-A2): the new providers' key shapes — xAI (`xai-…`) and the Alibaba plan (`sk-sp-…`,
  // which the generic `sk-…` shape above only catches from 16 chars after `sk-`).
  /\bxai-[A-Za-z0-9_-]{8,}/g,
  /\bsk-sp-[A-Za-z0-9_-]{8,}/g,
  // S6 (M1-A5): the MiniMax Token Plan Subscription Key (`sk-cp-…`, planning record MM-32..39), for
  // the same reason as `sk-sp-…`: the generic `sk-…` shape only catches it from 16 characters.
  /\bsk-cp-[A-Za-z0-9_-]{8,}/g,
  // S6 (M1-A4): the Gemini lane's standard Google API-key shape. `gemini-api-key` accepts AUTH keys
  // only and the auth-key shape is not documented in any pinned source, so this catches the shape
  // Google's page names as the one being retired — and the planning record's own secret grep lists
  // `AIza` alongside `sk-` and `ghp_`.
  /\bAIza[A-Za-z0-9_-]{20,}/g,
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

/** Test seams for resume's re-read (Argus pre-check of 15d4d9c, L1): `openNoFollow`'s options plus a
 * hook that runs after resume's identity check and before the open, and one that runs after the fd
 * checks and before the read (Argus pre-check of d55725d, M3). Null resets. Internal. */
export type SessionResumeReadOptions = OpenNoFollowOptions & {
  beforeOpen?: () => void;
  beforeRead?: () => void;
};
let resumeReadOpts: SessionResumeReadOptions = {};
export function setSessionResumeReadForTests(opts: SessionResumeReadOptions | null): void {
  resumeReadOpts = opts ?? {};
}

/**
 * Resume's re-read (K2), through one fd like every other read and append here: `openNoFollow`
 * (O_NOFOLLOW | O_NONBLOCK, so a symlink fails and a FIFO planted at the path cannot block), then
 * `fstat`: a regular file and, when the caller verified one, that very file (dev + inode). Null on
 * any failure (missing, a symlink, not a regular file, another file, unreadable).
 */
function readSessionForResume(
  realPath: string,
  verifiedFile: SessionFileId | undefined,
): Buffer | null {
  try {
    resumeReadOpts.beforeOpen?.();
    const fd = openNoFollow(realPath, resumeReadOpts);
    if (fd === null || fd === "symlink") return null;
    try {
      const st = fstatSync(fd, { bigint: true });
      if (!st.isFile()) return null;
      if (
        verifiedFile !== undefined &&
        (st.dev !== verifiedFile.dev || st.ino !== verifiedFile.ino)
      ) {
        return null;
      }
      resumeReadOpts.beforeRead?.();
      return readFileSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
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
type TruncateFile = (fd: number, size: number) => void;
type CloseFile = (fd: number) => void;
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
let truncateFile: TruncateFile = (fd, size) => ftruncateSync(fd, size);
let closeFile: CloseFile = (fd) => closeSync(fd);

/**
 * Test seam (Amendment 2 §8 item 4): observe or fail the per-append file fsync and the `sessions/`
 * directory fsync on create. `null` (or an omitted field) restores the real fsync. Internal.
 */
export function setSessionFsyncForTests(hooks: { file?: SyncFile; dir?: SyncDir } | null): void {
  syncFile = hooks?.file ?? defaultSyncFile;
  syncDir = hooks?.dir ?? defaultSyncDir;
}

/** Test seam (Amendment 3 1b-t): fail the rollback truncate. `null` restores `ftruncateSync`. Internal. */
export function setSessionTruncateForTests(fn: TruncateFile | null): void {
  truncateFile = fn ?? ((fd, size) => ftruncateSync(fd, size));
}

/**
 * Test seam (Amendment 3 1e): fail the append-path close. Only the close that ends an append runs
 * through this (Amendment 3 rule 4); every other close in this module is direct. `null` restores
 * `closeSync`. Internal.
 */
export function setSessionCloseForTests(fn: CloseFile | null): void {
  closeFile = fn ?? ((fd) => closeSync(fd));
}

function errCode(err: unknown): string | undefined {
  return err !== null && typeof err === "object" && "code" in err
    ? String((err as { code: unknown }).code)
    : undefined;
}

/**
 * Amendment 2 guards for one writer. `holdsLock` is the §2 ownership check (the thread lock still
 * carries this acquisition's token; server passes `holdsThreadLock(handle)`). `expectedSize` is the
 * verified file size at resume (§2 position).
 *
 * Amendment 3 item 3 (Founder: Option A, note 6 rejected, ledger D-184): both `create` and
 * `resume` REQUIRE `holdsLock`, and `resume` REQUIRES `expectedSize` (the verified size) — no
 * defaults. The only unguarded mode is the explicit, module-only `unguardedSessionWriterForTests`
 * opt-in below; a caller can always pass `() => true` itself.
 */
export type SessionWriterGuards = {
  readonly holdsLock: () => boolean;
  readonly expectedSize?: number | undefined;
};

/** `resume` guards: the verified byte size is required (Amendment 3 item 3, Option A). */
export type SessionResumeGuards = SessionWriterGuards & { readonly expectedSize: number };

/**
 * Append-path hooks. `onCloseFailed` reports a close that failed AFTER the batch's fsync returned
 * (Amendment 3 rule 4): the batch counts, the writer is not broken, and the fd is not retried; the
 * engine logs the line this hook feeds. `code` is the close error's `.code` (or `"error"`).
 */
export type SessionWriterHooks = {
  readonly onCloseFailed?: (code: string) => void;
};

/**
 * Appender for one session file. Each append opens the file (`O_APPEND`, never following a
 * symlink), re-checks ownership and position on that fd (Amendment 2 §2), writes its full line(s)
 * through the same fd, fsyncs it (§4), and closes it. A failed write or fsync is rolled back (the
 * file is truncated to its size before the append and the truncate is fsynced, Amendment 3 rule
 * 2), so a torn line or half of a multi-event append is never left behind; a failed ownership or
 * position check writes nothing. After any failed append the writer is broken: every later append
 * fails with the same -32009 and nothing more is written. If the rollback itself failed, the
 * writer is poisoned (Amendment 3 rule 3) for the life of the engine process.
 */
export class SessionWriter {
  readonly path: string;
  readonly threadId: string;
  readonly seatId: string;
  #seq: number;
  #prevHash: string;
  #broken = false;
  /** Amendment 3 rule 3: the refused batch whose rollback (truncate or its fsync) failed. */
  #poisonedSeq: { readonly first: number; readonly last: number } | null = null;
  /** §2 position: file size after this writer's last successful write (or verified at resume). */
  #expectedEnd: number;
  /** §2 ownership: the thread lock still carries this writer's acquisition token. */
  readonly #holdsLock: () => boolean;
  readonly #secrets: () => readonly string[];
  readonly #hooks: SessionWriterHooks;
  /**
   * Real path at create / resume; with a home it was checked to be strictly under realpath(home).
   * Every append must still resolve here.
   */
  readonly #realPath: string;
  /**
   * M2 pin D-M2-A0-4: the verified file this writer holds, as an index — every line's hash and
   * type, the handoff states and the decision ids — so a same-file evidence ref, a duplicate id and
   * a second terminal record are refused at write time without re-reading the file. Built from the
   * verified events at resume, from the `session.open` at create, and told every durable append.
   */
  readonly #index: SessionChainIndex;

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
    hooks: SessionWriterHooks,
    index: SessionChainIndex,
  ) {
    this.path = path;
    this.#expectedEnd = expectedEnd;
    this.#holdsLock = holdsLock;
    this.#hooks = hooks;
    this.#realPath = realPath;
    this.threadId = threadId;
    this.seatId = seatId;
    this.#seq = seq;
    this.#prevHash = prevHash;
    this.#secrets = secrets;
    this.#index = index;
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
    home: string | undefined,
    guards: SessionWriterGuards,
    hooks: SessionWriterHooks = {},
  ): SessionWriter {
    // Amendment 3 item 3 (Option A): `guards` is a required parameter — omitting it (or a
    // holdsLock that is not a function) is a tsc error AND a run-time throw (3c; Founder: fix it,
    // no deviation).
    if (typeof guards?.holdsLock !== "function") {
      throw new TypeError("SessionWriter.create requires a holdsLock guard (Amendment 3 item 3)");
    }
    const holdsLock = guards.holdsLock;
    // M2 pin rule 1.5 / §2.2 ("no file is created"): the `session.open` record is validated BEFORE
    // the file exists, so a malformed `handoff` or `worktree` refuses -32010 with nothing on disk.
    const index = new SessionChainIndex();
    const refusal = validateForWrite("session.open", open, { threadId, seatId, index });
    if (refusal !== null) {
      throw evidenceInvalid({
        threadId,
        turnId: null,
        type: "session.open",
        reason: refusal.reason,
        issues: refusal.issues,
      });
    }
    // Argus P13 (Copilot review 5391183893): the structural-redaction refusal for `session.open`
    // (an id, path or remote redaction would rewrite) is ALSO decided before the file exists, so
    // that refusal leaves nothing on disk either — no create-then-unlink window. The same check
    // still runs again in `append` below (unchanged), on the same payload and secrets.
    const structural = redactionRefusal("session.open", open, createRedactor(secrets())(open));
    if (structural !== null) {
      throw evidenceInvalid({
        threadId,
        turnId: null,
        type: "session.open",
        reason: structural.reason,
        issues: structural.issues,
      });
    }
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
      holdsLock,
      hooks,
      index,
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
   *
   * M2 (D-M2-A0-4): `index` is the chain index of the verified events (`SessionChainIndex
   * .fromEvents(verified.events)`), so same-file evidence refs resolve at write time. It is
   * REQUIRED (Argus P11): there is no default empty index any more — an empty one made a v2 file
   * look like v1, so the writer accepted a keyless `session.close` its own verifier then FAILed.
   * The index must describe the chain being continued: `index.length === nextSeq` and its last
   * line's hash is `lastHash` (genesis for an empty chain), else `TypeError` and no writer.
   */
  static resume(
    path: string,
    threadId: string,
    seatId: string,
    nextSeq: number,
    lastHash: string,
    secrets: () => readonly string[],
    home: string | undefined,
    verifiedFile: SessionFileId | undefined,
    guards: SessionResumeGuards,
    hooks: SessionWriterHooks = {},
    index: SessionChainIndex,
  ): SessionWriter {
    // Amendment 3 item 3 (Option A): `guards` is a required parameter — resume binds the lock and
    // the verified size, and omitting either is a tsc error AND a run-time throw (3c).
    if (typeof guards?.holdsLock !== "function") {
      throw new TypeError("SessionWriter.resume requires a holdsLock guard (Amendment 3 item 3)");
    }
    if (typeof guards.expectedSize !== "number") {
      throw new TypeError(
        "SessionWriter.resume requires the verified size (expectedSize) (Amendment 3 item 3)",
      );
    }
    // Argus P11: the index is required and must be the index of THIS chain (length and head
    // hash), so a caller cannot hand the writer an index for another file, a forged one, or none.
    if (!(index instanceof SessionChainIndex)) {
      throw new TypeError(
        "SessionWriter.resume requires the chain index of the verified events (SessionChainIndex.fromEvents)",
      );
    }
    const holdsLock = guards.holdsLock;
    const expectedEnd = guards.expectedSize;
    let realPath: string;
    try {
      realPath = realpathSync(path);
    } catch {
      throw sessionWriteFailed(threadId, path, nextSeq);
    }
    if (!resolvesUnderHome(realPath, home)) throw sessionWriteFailed(threadId, path, nextSeq);
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
    // Argus F2: the writer keeps its OWN copy. The caller's object stays mutable after resume (its
    // `note()`), and a line noted on it later must never become a line this writer resolves.
    const own = index.clone();
    // Argus P11: checked after the file checks above, so their -32009 keeps its precedence.
    const indexHead = nextSeq === 0 ? GENESIS_HASH : own.lineAt(nextSeq - 1)?.hash;
    if (own.length !== nextSeq || indexHead !== lastHash) {
      throw new TypeError(
        "SessionWriter.resume: the chain index does not describe the chain being continued (length / last hash)",
      );
    }
    // Copilot r4174562359 / Argus PR #48 r1 K2 (completes P11): length and head do not prove the
    // middle lines. Resume re-verifies the bytes it continues (the verified `expectedEnd`), every
    // line of the caller's index must be the file's line at that seq (hash and type), and the
    // writer's index is built from the file's own events, so neither a forged middle line nor a
    // payload noted under a real hash can become something this writer resolves. An unreadable or
    // short file, or one that is not a regular file (Argus pre-check of 15d4d9c, L1: read through
    // one O_NOFOLLOW | O_NONBLOCK fd + fstat, never by path), is -32009 (like the identity checks
    // above); a chain that is not the one named by `nextSeq` / `lastHash` / `index` is TypeError.
    const bytes = readSessionForResume(realPath, verifiedFile);
    if (bytes === null) throw sessionWriteFailed(threadId, path, nextSeq);
    if (bytes.length < expectedEnd) throw sessionWriteFailed(threadId, path, nextSeq);
    const onDisk =
      expectedEnd === 0
        ? ({ ok: true, events: [], nextSeq: 0, lastHash: GENESIS_HASH } as const)
        : verifySessionText(bytes.subarray(0, expectedEnd).toString("utf8"), threadId);
    const fileIndex = onDisk.ok ? SessionChainIndex.fromEvents(onDisk.events) : null;
    const differs =
      !onDisk.ok ||
      fileIndex === null ||
      onDisk.nextSeq !== nextSeq ||
      onDisk.lastHash !== lastHash ||
      Array.from({ length: nextSeq }, (_, seq) => seq).some((seq) => {
        const mine = own.lineAt(seq);
        const disk = fileIndex.lineAt(seq);
        return mine?.hash !== disk?.hash || mine?.type !== disk?.type;
      });
    if (differs || fileIndex === null) {
      throw new TypeError(
        "SessionWriter.resume: the chain index does not describe the chain being continued (a line differs from the file)",
      );
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
      holdsLock,
      hooks,
      fileIndex,
    );
  }

  get nextSeq(): number {
    return this.#seq;
  }

  /** The file's seq-0 hash (G for a handoff target, M2 pin §2.1), or null before `session.open`. */
  get genesisHash(): string | null {
    return this.#index.lineAt(0)?.hash ?? null;
  }

  /** Hash and type of the chained line at `seq`, as this writer knows it (M2 pin D-M2-A0-4). */
  lineAt(seq: number): { readonly hash: string; readonly type: string } | undefined {
    return this.#index.lineAt(seq);
  }

  get broken(): boolean {
    return this.#broken;
  }

  /** Amendment 3 rule 3: the rollback of a refused batch failed; poisoned for the process life. */
  get poisoned(): boolean {
    return this.#poisonedSeq !== null;
  }

  /**
   * First and last seq of the refused batch whose rollback failed (rule 3's stderr line; the C2
   * entry carries `first`). Null while the writer is not poisoned.
   */
  get poisonedSeq(): { readonly first: number; readonly last: number } | null {
    return this.#poisonedSeq;
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
   * The `turnId` a -32010 `data` may echo (Argus G1; the D-350/D-375 class): the payload's
   * well-formed id only when redaction leaves it unchanged, else null. A refused payload never
   * reaches the redactor, so a configured secret or a token-shaped id would otherwise leave the
   * engine verbatim in the error. A secrets source that throws fails closed to null.
   */
  #echoableTurnId(payload: unknown): string | null {
    const t = turnIdOf(payload);
    if (t === null) return null;
    try {
      return createRedactor(this.#secrets())(t) === t ? t : null;
    } catch {
      return null;
    }
  }

  /**
   * Append several events as one unit (consecutive seqs, one write through one fd): either all of
   * them are durable or none is (rolled back on failure). Used for the servedModel dual write.
   *
   * Amendment 2: on the fd it writes through, the batch first requires (§2) that the thread lock
   * still carries this writer's token and that `fstat(fd).size` is the expected end offset; either
   * failing writes nothing. The write is then fsynced (§4) before it counts. Any failure breaks
   * the writer (-32009).
   *
   * Amendment 3 item 1: a failed write or fsync is truncated back to the pre-batch offset AND the
   * truncate is fsynced before the -32009 (rule 2). If the truncate or that fsync fails, the writer
   * is poisoned for the process life in addition to broken (rule 3). A close that fails after the
   * batch's fsync returned does not break the writer and is reported through `onCloseFailed`
   * (rule 4); a close failure on the error path is ignored.
   */
  appendAll(
    entries: ReadonlyArray<{ type: SessionEventType; payload: SessionPayloads[SessionEventType] }>,
    ts: number = Date.now(),
  ): SessionEvent[] {
    const firstSeq = this.#seq;
    if (this.#broken) throw sessionWriteFailed(this.threadId, this.path, firstSeq);
    // M2 pin rule 1.5: validity is checked BEFORE redaction, hashing and any I/O. On a fault
    // nothing is written, no fd is opened, and the writer is NOT broken (the file, its offset and
    // the chain are untouched because no bytes were attempted). A reserved M4 name refuses
    // `reserved` (§4); a type outside the vocabulary altogether is an engine fault, not a record.
    const refuse = (type: string, payload: unknown, refusal: WriteRefusal): RpcError =>
      evidenceInvalid({
        threadId: this.threadId,
        turnId: this.#echoableTurnId(payload),
        type,
        reason: refusal.reason,
        issues: refusal.issues,
      });
    // Entries of one batch are validated against the index as it will be once the earlier entries
    // of the same batch are durable, so a duplicate id inside a batch is refused too.
    const shadow = this.#index.clone();
    for (const { type, payload } of entries) {
      if (
        !(SESSION_EVENT_TYPES as readonly string[]).includes(type) &&
        !(RESERVED_EVENT_TYPES as readonly string[]).includes(type)
      ) {
        throw new TypeError(`unknown session event type ${JSON.stringify(type)}`);
      }
      const refusal = validateForWrite(type, payload, {
        threadId: this.threadId,
        seatId: this.seatId,
        index: shadow,
      });
      if (refusal !== null) throw refuse(type, payload, refusal);
      shadow.note({ type, hash: "", payload });
    }
    const redact = createRedactor(this.#secrets());
    const events: SessionEvent[] = [];
    let prevHash = this.#prevHash;
    for (const [i, { type, payload }] of entries.entries()) {
      const redacted = redact(payload) as SessionPayloads[SessionEventType];
      // Copilot 4160774703 (#46): a structural field (id, hash, path, SHA, remote) that redaction
      // would rewrite is refused here, before the append, instead of persisting as `[REDACTED]`.
      const structural = redactionRefusal(type, payload, redacted);
      if (structural !== null) throw refuse(type, payload, structural);
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
      let durable = false;
      let batchError: unknown = null;
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
          durable = true;
        } catch (err) {
          // Amendment 3 rule 2: truncate back to the pre-batch offset, then fsync, before -32009.
          try {
            truncateFile(fd, sizeBefore);
            syncFile(fd);
          } catch {
            // Rule 3: the rollback itself did not reach disk — poisoned for the process life.
            this.#poisonedSeq = { first: firstSeq, last: firstSeq + events.length - 1 };
          }
          batchError = err;
        }
      } finally {
        try {
          closeFile(fd);
        } catch (closeErr) {
          // Rule 4: once the batch is durable the batch counts — the append succeeds, the writer
          // is not broken, and the fd is not retried (the engine logs the hook's line). On the
          // error path the close error is ignored; the rule 2 / rule 3 outcome stands.
          if (durable && batchError === null) {
            this.#hooks.onCloseFailed?.(errCode(closeErr) ?? "error");
          }
        }
      }
      if (batchError !== null) throw batchError;
    } catch {
      this.#broken = true;
      throw sessionWriteFailed(this.threadId, this.path, firstSeq);
    }
    this.#seq = firstSeq + events.length;
    this.#prevHash = prevHash;
    this.#expectedEnd += bytes.length;
    // The batch is durable: the index now holds every line this writer knows to be on disk.
    for (const e of events) this.#index.note(e);
    return events;
  }
}

/**
 * Amendment 3 item 3 (Option A): the ONLY unguarded writer mode — an explicit opt-in, named so a
 * review sees it, for unit tests and fixtures. `holdsLock` is `() => true`; resume reads the file
 * size at resume time (the pre-Amendment-3 default the option rejected). Module-only by rule: it
 * MUST NOT be a static member of `SessionWriter` and MUST NOT be re-exported from the package
 * entry (`index.ts`) or `@madc/engine/client` (`sdk.ts`); 3d's export-surface test pins that.
 * `testing/fifo-append-probe.ts` reaches it by importing `../session-store.ts` directly.
 */
export const unguardedSessionWriterForTests = {
  create(
    path: string,
    threadId: string,
    seatId: string,
    open: SessionOpenPayload,
    secrets: () => readonly string[],
    ts?: number,
    home?: string,
    hooks?: SessionWriterHooks,
  ): SessionWriter {
    return SessionWriter.create(
      path,
      threadId,
      seatId,
      open,
      secrets,
      ts,
      home,
      { holdsLock: () => true },
      hooks,
    );
  },
  resume(
    path: string,
    threadId: string,
    seatId: string,
    nextSeq: number,
    lastHash: string,
    secrets: () => readonly string[],
    home?: string,
    verifiedFile?: SessionFileId,
    hooks?: SessionWriterHooks,
  ): SessionWriter {
    let expectedSize: number;
    try {
      expectedSize = lstatSync(realpathSync(path)).size;
    } catch {
      throw sessionWriteFailed(threadId, path, nextSeq);
    }
    // M2: a test resume reads the file it continues, so same-file refs resolve exactly as the
    // engine's resume (which builds the index from the events it verified) resolves them. A file
    // the confined verifier refuses (a fixture outside the home, a symlinked fixture) is read as
    // text so the required index (Argus P11) still describes it; anything else gets an empty
    // index, which resume then refuses unless the chain is empty.
    const verified = verifySessionFile(path, threadId, {}, home);
    let events: readonly SessionEvent[] | undefined = verified.ok ? verified.events : undefined;
    if (events === undefined) {
      try {
        const text = verifySessionText(readFileSync(realpathSync(path), "utf8"), threadId);
        if (text.ok) events = text.events;
      } catch {
        // unreadable: fall through to an empty index
      }
    }
    const index = SessionChainIndex.fromEvents(events ?? []);
    return SessionWriter.resume(
      path,
      threadId,
      seatId,
      nextSeq,
      lastHash,
      secrets,
      home,
      verifiedFile,
      { holdsLock: () => true, expectedSize },
      hooks,
      index,
    );
  },
} as const;

// ------------------------------------------------------------------- verify

/**
 * Amendment 3 item 2 failure classes (replaces Amendment 2 §5's paragraph). `torn-tail` (crash
 * residue): the file is 0 bytes, or it splits into a prefix `P` of complete (`\n`-terminated)
 * lines that all verify (`P` may be empty) and a non-empty remainder `R` that either (i) contains
 * no `\n` (the unterminated-fragment case, NUL fragments included) or (ii) consists only of NUL
 * bytes and ASCII whitespace, with or without a trailing `\n`. `integrity`: every other failure
 * (a complete line that does not parse, fails the envelope or schema checks, breaks `seq` or the
 * hash chain, or names the wrong thread). Either way the engine fails closed and never touches
 * the file.
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

/** Amendment 3 item 2 (b)(ii): NUL bytes and ASCII whitespace (space, tab, CR, LF) only. */
const CRASH_RESIDUE_CHARS: ReadonlySet<string> = new Set(["\x00", " ", "\t", "\r", "\n"]);
const isCrashResidueTail = (s: string): boolean =>
  [...s].every((ch) => CRASH_RESIDUE_CHARS.has(ch));

/**
 * Verify a session file's text (seat pin §4.3): recompute every hash forward from seq 0. Any
 * unparseable line, envelope drift, seq gap, prevHash break, hash mismatch, thread / seat change,
 * or unterminated last line fails, reporting the 1-based line number. Payloads are not
 * shape-checked here and unknown event types pass, so events added later (envelope v:1) still
 * verify; `rebuildSession` checks the M0 payload shapes before any state is built from them.
 * Failures classify per Amendment 3 item 2 (see {@link SessionFailureKind}): a 0-byte file, an
 * unterminated fragment after verifying complete lines, and a NUL/whitespace-only remainder are
 * `torn-tail`; everything else is `integrity`.
 */
export function verifySessionText(text: string, expectedThreadId?: string): SessionVerifyResult {
  // Item 2 (a): a crash after the directory fsync but before the first data fsync leaves 0 bytes.
  if (text === "") return { ok: false, line: 1, reason: "empty session file", kind: "torn-tail" };
  const events: SessionEvent[] = [];
  let prevHash = GENESIS_HASH;
  let threadId = expectedThreadId;
  let seatId: string | undefined;
  let offset = 0; // one past the last verified complete line; R = text.slice(offset)
  for (let i = 0; ; i++) {
    const nl = text.indexOf("\n", offset);
    if (nl === -1) {
      if (offset === text.length) {
        return { ok: true, events, nextSeq: events.length, lastHash: prevHash };
      }
      // Item 2 (b)(i): the remainder holds no `\n` (unterminated fragment, NULs included).
      return { ok: false, line: i + 1, reason: "unterminated last line", kind: "torn-tail" };
    }
    const fail = (reason: string): SessionVerifyResult => {
      // Item 2 (b)(ii): the remainder from this line on is only NULs and ASCII whitespace.
      if (isCrashResidueTail(text.slice(offset))) {
        return {
          ok: false,
          line: i + 1,
          reason: "trailing NUL/whitespace-only residue",
          kind: "torn-tail",
        };
      }
      return { ok: false, line: i + 1, reason, kind: "integrity" };
    };
    let e: SessionEvent;
    try {
      e = JSON.parse(text.slice(offset, nl)) as SessionEvent;
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
    // M2 pin rule 1.5 (Argus 5391475289 miss 1, Copilot 4165236039 / 4165236079): a hash-valid
    // line whose SCHEMA-V2 payload is malformed is an integrity failure here, on the read path
    // doctor and the handoff gate use — the verifier does not stop at the hash. M0/M1 payload
    // shapes stay `rebuildSession`'s (the M1 contract: "payloads are not shape-checked here").
    const v2Issue = v2LineIssue(e.type, e.payload, {
      seatId: e.seatId,
      open: (events[0]?.payload as Record<string, unknown> | undefined) ?? e.payload,
    });
    if (v2Issue !== null) return fail(v2Issue);
    prevHash = e.hash;
    events.push(e);
    offset = nl + 1;
  }
}

/**
 * Rule 1.5, read side: the schema-v2 shape fault of one hash-valid line, or null. `open` is the
 * file's `session.open` payload (the line itself at seq 0): it says whether the file is v2 (a
 * `worktree` key on the open), which a `session.close` must then carry and match by `topLevel`
 * (§2.2); `seatId` is the envelope seat a reserved `memory.write` must name (§4.1). Shared by
 * `verifySessionText`, `rebuildSession` and `inspectSessionV2`, so one rule decides all three.
 */
export function v2LineIssue(
  type: string,
  payload: Record<string, unknown>,
  ctx: { readonly seatId: string; readonly open: Record<string, unknown> },
): string | null {
  const openV2 = Object.hasOwn(ctx.open, "worktree") && ctx.open.worktree !== undefined;
  switch (type) {
    case "session.open":
      return checkV2Payload("session.open", payload).length === 0
        ? null
        : "malformed session.open payload";
    case "session.close": {
      if (checkV2Payload("session.close", payload, { openV2 }).length > 0) {
        return "malformed session.close payload";
      }
      // §2.2: a close identity names the open's top-level; a v2 engine never writes one for a
      // thread whose open recorded none.
      const close = payload.worktree;
      if (close !== undefined && close !== null) {
        const o = ctx.open.worktree as WorktreeIdentity | null | undefined;
        if (o === undefined || o === null || (close as WorktreeIdentity).topLevel !== o.topLevel) {
          return "session.close worktree does not match session.open";
        }
      }
      return null;
    }
    case "handoff.out":
    case "handoff.link":
    case "handoff.aborted":
    case "founderDecision":
    case "memory.write":
    case "tool.call":
      return checkV2Payload(type, payload, { seatId: ctx.seatId }).length === 0
        ? null
        : `malformed ${type} payload`;
    default:
      return null;
  }
}

const isStr = (v: unknown): v is string => typeof v === "string";
const TURN_END_STATUSES: readonly unknown[] = ["completed", "interrupted", "failed"];

const ITEM_STATUSES: readonly unknown[] = ["inProgress", "completed", "failed"];
/** Registry statuses (M1 seat pin §4.2 `lane` / same-lane payloads). */
const PROVIDER_STATUSES: readonly unknown[] = [
  "allowed-direct",
  "allowed-via-vendor-agent",
  "interactive-only",
  "forbidden",
];
const TURN_MODES: readonly unknown[] = ["interactive", "headless"];
const PRESENCES: readonly unknown[] = ["verified", "absent"];
const TTY_CONFIRMATIONS: readonly unknown[] = ["keypress", "carried"];
/** M1 seat pin §4.2 `repo.decision` (added by M1-A4). */
const REPO_DECISIONS: readonly unknown[] = ["allow", "deny"];
const REPO_ALLOW_REASONS: readonly unknown[] = ["repo-allowed", "not-repo-gated"];
const REPO_DENY_REASONS: readonly unknown[] = ["repo-not-allowed", "repo-identity-ambiguous"];

/**
 * A receipt / `session.open` backing is any WIRED registry id (seat pin S1; M0's three-literal
 * list widened in M1-A3 — `ollama-cloud` joined when its adapter landed).
 */
function isWiredBacking(v: unknown): boolean {
  return isStr(v) && getById(v)?.wired === true;
}

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
        isWiredBacking(item.backing) &&
        isStr(item.providerId) &&
        PROVIDER_STATUSES.includes(item.lane) &&
        TURN_MODES.includes(item.mode) &&
        (item.fallbackFrom === null || isStr(item.fallbackFrom)) &&
        typeof item.vendorReported === "boolean"
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
function checkPayload(
  type: SessionEventType | ReservedEventType,
  p: Record<string, unknown>,
  ctx: { readonly seatId: string; readonly open: Record<string, unknown> },
): string | null {
  switch (type) {
    case "session.open":
      // M2 pin §2.2 verifier rule: `handoff` and `worktree` both present (each an object or null)
      // or both absent (a v1 line); one without the other, or a malformed one, is an integrity
      // failure exactly like a malformed M1 field (the v2 half is `v2LineIssue`, as in verify).
      return (p.cwd === null || isStr(p.cwd)) &&
        isWiredBacking(p.backing) &&
        isStr(p.providerId) &&
        isStr(p.pinnedModel)
        ? v2LineIssue("session.open", p, ctx)
        : "malformed session.open payload";
    case "turn.start": {
      // M1-A5: a pre-A5 line carries none of `mode` / `presence` / `tty`; an A5 line carries
      // `mode` AND `presence` together, and `tty` exactly when presence is `verified`. A partial
      // set is malformed, never read as a weaker claim.
      const legacy = p.mode === undefined && p.presence === undefined && p.tty === undefined;
      const tty = p.tty;
      const a5 =
        TURN_MODES.includes(p.mode) &&
        PRESENCES.includes(p.presence) &&
        (p.presence === "verified"
          ? isPlainRecord(tty) &&
            isStr(tty.device) &&
            (tty.session === null || isStr(tty.session)) &&
            TTY_CONFIRMATIONS.includes(tty.confirmation)
          : tty === undefined);
      return isValidId(p.turnId) && isStr(p.inputText) && (legacy || a5)
        ? null
        : "malformed turn.start payload";
    }
    case "item":
      return isValidId(p.turnId) && isM0Item(p.item) ? null : "malformed item payload";
    case "servedModel":
      return isValidId(p.turnId) &&
        isStr(p.requestedModel) &&
        isStr(p.servedModel) &&
        isWiredBacking(p.backing) &&
        isStr(p.providerId) &&
        PROVIDER_STATUSES.includes(p.lane) &&
        TURN_MODES.includes(p.mode) &&
        (p.fallbackFrom === null || isStr(p.fallbackFrom)) &&
        typeof p.vendorReported === "boolean"
        ? null
        : "malformed servedModel payload";
    case "fallback.rejected": {
      const laneOk = (lane: unknown): boolean =>
        isPlainRecord(lane) &&
        PROVIDER_STATUSES.includes(lane.status) &&
        isStr(lane.credentialClass);
      return isValidId(p.turnId) &&
        isStr(p.candidate) &&
        laneOk(p.assignedLane) &&
        laneOk(p.candidateLane) &&
        p.reason === "fallback-lane-mismatch"
        ? null
        : "malformed fallback.rejected payload";
    }
    case "repo.decision": {
      const reasonOk =
        (p.decision === "allow" && REPO_ALLOW_REASONS.includes(p.reason)) ||
        (p.decision === "deny" && REPO_DENY_REASONS.includes(p.reason));
      return isValidId(p.turnId) &&
        isStr(p.providerId) &&
        (p.remote === null || isStr(p.remote)) &&
        (p.topLevel === null || isStr(p.topLevel)) &&
        REPO_DECISIONS.includes(p.decision) &&
        reasonOk
        ? null
        : "malformed repo.decision payload";
    }
    case "turn.end": {
      const err = p.error;
      const errOk =
        err === null || (isPlainRecord(err) && typeof err.code === "number" && isStr(err.message));
      return isValidId(p.turnId) && TURN_END_STATUSES.includes(p.status) && errOk
        ? null
        : "malformed turn.end payload";
    }
    case "session.close":
      // M2 pin §2.2: a v2 file's close carries `worktree` (identity or null) naming the open's
      // top-level; a v1 close may stay keyless (`v2LineIssue`, as in verify).
      return isStr(p.reason)
        ? v2LineIssue("session.close", p, ctx)
        : "malformed session.close payload";
    // M2 pin §2.1 / §2.3 (schema v2) and the reserved M4 names (§4, D-M2-A0-2: validated when
    // met, so a malformed reserved line is an integrity failure, never a tolerated unknown).
    case "handoff.out":
    case "handoff.link":
    case "handoff.aborted":
    case "founderDecision":
    case "memory.write":
    case "tool.call":
      return v2LineIssue(type, p, ctx);
  }
}

/** The types `rebuildSession` shape-checks: the writable set plus the reserved M4 names. */
const SHAPE_CHECKED_TYPES: readonly string[] = [...SESSION_EVENT_TYPES, ...RESERVED_EVENT_TYPES];

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
  const openPayload = open.payload as Record<string, unknown>;
  for (const e of events) {
    // Payload shapes are checked here, for the known event types only (M0/M1, the M2 v2 types and
    // the reserved M4 names): the verifier covers the envelope, seq, hash chain and — since the
    // M2-A1 correction — the v2 shapes; unknown event types and extra payload fields are ignored
    // (M2 pin rule 1.3, additive both ways).
    if (SHAPE_CHECKED_TYPES.includes(e.type)) {
      const issue = checkPayload(
        e.type as SessionEventType | ReservedEventType,
        e.payload as Record<string, unknown>,
        { seatId: e.seatId, open: openPayload },
      );
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
