import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { confinedPath } from "./home.ts";

/**
 * Contents of `sessions/<threadId>.lock` — exactly `{ pid, startedAt, token }` (protocol pin §3.3,
 * Amendment 1). `token` is 128 random bits as 32 lowercase hex chars, fresh on every acquisition.
 * The token is private to the holder: it never goes on the wire, into logs, or into session JSONL.
 */
export type LockInfo = { pid: number; startedAt: number; token: string };

export const LOCK_TOKEN_PATTERN = /^[0-9a-f]{32}$/;

/**
 * What is on disk at a lock path.
 * - `held`: a parseable body with a positive integer pid. `token` is null when it is missing or does
 *   not match `LOCK_TOKEN_PATTERN` (legacy / corrupt body, pin §3.3 (c)).
 * - `corrupt`: unreadable, not JSON, no usable pid, or a symlink (never followed). Nobody can be
 *   shown to hold it, so it is treated like a dead holder.
 */
export type LockState =
  | { state: "missing" }
  | { state: "corrupt"; fingerprint: string }
  | {
      state: "held";
      pid: number;
      startedAt: unknown;
      token: string | null;
      fingerprint: string;
    };

/** The holder's private record of one acquisition. */
export type LockHandle = { path: string; pid: number; startedAt: number; token: string };

export type AcquireResult =
  | { ok: true; path: string; handle: LockHandle }
  | { ok: false; path: string; holderPid: number | null };

export function threadLockPath(home: string, threadId: string): string {
  return confinedPath(home, "sessions", threadId, ".lock");
}

export function newLockToken(): string {
  return randomBytes(16).toString("hex");
}

function errCode(err: unknown): string | undefined {
  return err !== null && typeof err === "object" && "code" in err
    ? String((err as { code: unknown }).code)
    : undefined;
}

function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    if (errCode(err) !== "ENOENT") throw err;
  }
}

// Every lock read goes through one fd opened with O_NOFOLLOW (a symlink at the path fails with
// ELOOP instead of being followed) and O_NONBLOCK (a FIFO planted there cannot block the engine);
// the fd is then checked with fstat to be a regular file.
const HAS_NOFOLLOW = typeof constants.O_NOFOLLOW === "number";
const OPEN_READ_NOFOLLOW =
  constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/** Test seams for `openNoFollow`. */
export type OpenNoFollowOptions = { noFollowFlag?: boolean; afterLstat?: () => void };

/**
 * Open `path` for reading without following a symlink. Null if missing; "symlink" if it is one (or
 * if the path changed while it was opened). Without O_NOFOLLOW (e.g. Windows) the check is
 * lstat → open → fstat, and the fd is accepted only if it is the very file lstat saw (same dev +
 * inode): a swap to a symlink between lstat and open yields a different inode and is refused, so a
 * symlink target is never read or trusted. Internal; exported for tests.
 */
export function openNoFollow(
  path: string,
  opts: OpenNoFollowOptions = {},
): number | null | "symlink" {
  const noFollowFlag = opts.noFollowFlag ?? HAS_NOFOLLOW;
  try {
    if (noFollowFlag) return openSync(path, OPEN_READ_NOFOLLOW);
    const seen = lstatSync(path, { bigint: true });
    if (seen.isSymbolicLink()) return "symlink";
    opts.afterLstat?.();
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const opened = fstatSync(fd, { bigint: true });
    if (opened.dev !== seen.dev || opened.ino !== seen.ino) {
      closeSync(fd);
      return "symlink";
    }
    return fd;
  } catch (err) {
    const code = errCode(err);
    if (code === "ENOENT") return null;
    if (code === "ELOOP") return "symlink";
    throw err;
  }
}

export class LockPathNotAFileError extends Error {
  constructor(path: string) {
    super(`lock path is not a regular file: ${path}`);
    this.name = "LockPathNotAFileError";
  }
}

/** Classify a body. `fingerprint` is the exact bytes seen (pin §3.3 (b) compares pid+startedAt+token). */
export function parseLockBody(text: string): LockState {
  const fingerprint = `file:${text}`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { state: "corrupt", fingerprint };
  }
  if (parsed === null || typeof parsed !== "object") return { state: "corrupt", fingerprint };
  const body = parsed as Record<string, unknown>;
  const pid = body.pid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return { state: "corrupt", fingerprint };
  }
  // A token only counts on a well-formed body: exactly { pid, startedAt, token } with a finite
  // startedAt. Anything else is a legacy/corrupt body (pin §3.3 (c)): locked while its pid lives.
  const wellFormed =
    Object.keys(body).length === 3 &&
    typeof body.startedAt === "number" &&
    Number.isFinite(body.startedAt) &&
    typeof body.token === "string" &&
    LOCK_TOKEN_PATTERN.test(body.token);
  const token = wellFormed ? (body.token as string) : null;
  return { state: "held", pid, startedAt: body.startedAt, token, fingerprint };
}

/**
 * Read the lock at `path` through a single no-follow fd (never re-opening the path after a check).
 * A symlink is `corrupt` and never trusted; any other non-regular file (directory, FIFO, device) is
 * refused with `LockPathNotAFileError` rather than reclaimed.
 */
export function readLock(path: string): LockState {
  const fd = openNoFollow(path);
  if (fd === null) return { state: "missing" };
  if (fd === "symlink") return { state: "corrupt", fingerprint: "symlink" };
  try {
    if (!fstatSync(fd).isFile()) throw new LockPathNotAFileError(path);
    return parseLockBody(readFileSync(fd, "utf8"));
  } finally {
    closeSync(fd);
  }
}

/** `kill(pid, 0)`: ESRCH → dead; EPERM (exists, not ours) or anything else → treat as alive. */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errCode(err) !== "ESRCH";
  }
}

/**
 * Exclusive create with a fresh token: the complete body goes to a private temp file which is
 * hard-linked into place. `link` fails with EEXIST if the lock exists (same semantics as O_EXCL),
 * and readers never see a half-written body (an empty file would look corrupt and be reclaimed).
 */
function createExclusive(path: string, pid: number): LockHandle | null {
  const handle: LockHandle = { path, pid, startedAt: Date.now(), token: newLockToken() };
  const tmp = `${path}.tmp-${newLockToken()}`;
  const body: LockInfo = { pid, startedAt: handle.startedAt, token: handle.token };
  writeFileSync(tmp, JSON.stringify(body), { flag: "wx", mode: 0o600 });
  try {
    linkSync(tmp, path);
    return handle;
  } catch (err) {
    if (errCode(err) !== "EEXIST") throw err;
    return null;
  } finally {
    removeQuietly(tmp);
  }
}

export type ReclaimOutcome =
  /** The observed dead/corrupt lock was deleted. */
  | { outcome: "reclaimed" }
  /** Nothing at the path any more (another reclaimer or the holder removed it). */
  | { outcome: "gone" }
  /** The file changed after it was judged; it was put back (or left aside) and never deleted. */
  | { outcome: "restored"; holderPid: number | null };

/**
 * Pin §3.3 (b): remove a lock that was judged dead/corrupt. Rename it aside to a name unique to
 * this attempt (atomic: of several reclaimers exactly one moves the file), re-read the moved body,
 * and delete it only if it is byte-for-byte what was judged (same pid + startedAt + token, or the
 * same missing/invalid token for a (c) body). Otherwise link it back to the lock path and report the
 * thread as locked; if the path was taken meanwhile, the moved file is left in place — a lock that
 * was not judged dead is never deleted. Internal; exported for tests.
 */
export function reclaimIfUnchanged(
  path: string,
  observedFingerprint: string,
  reclaimerToken: string = newLockToken(),
): ReclaimOutcome {
  const aside = `${path}.reclaim-${reclaimerToken}`;
  try {
    renameSync(path, aside);
  } catch (err) {
    if (errCode(err) === "ENOENT") return { outcome: "gone" };
    throw err;
  }
  const moved = readLock(aside);
  if (moved.state !== "missing" && moved.fingerprint === observedFingerprint) {
    removeQuietly(aside);
    return { outcome: "reclaimed" };
  }
  try {
    linkSync(aside, path);
    removeQuietly(aside); // `aside` was a second name for the restored lock
  } catch (err) {
    if (errCode(err) !== "EEXIST") throw err;
  }
  return { outcome: "restored", holderPid: moved.state === "held" ? moved.pid : null };
}

/**
 * Take `sessions/<threadId>.lock` with a fresh token. A holder whose pid is alive — including this
 * process under a different token — refuses with its pid (-32004 upstream). A dead pid, or a body
 * with no usable pid, is reclaimed per `reclaimIfUnchanged` and creation retried.
 */
export function acquireThreadLock(
  home: string,
  threadId: string,
  pid: number = process.pid,
): AcquireResult {
  const path = threadLockPath(home, threadId);
  let lastHolder: number | null = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const created = createExclusive(path, pid);
    if (created !== null) return { ok: true, path, handle: created };

    const current = readLock(path);
    if (current.state === "missing") continue;
    if (current.state === "held") {
      lastHolder = current.pid;
      // Live pid → locked, whatever the token (pin §3.3 (c)); ownership is never adopted.
      if (isPidAlive(current.pid)) return { ok: false, path, holderPid: current.pid };
    }
    const result = reclaimIfUnchanged(path, current.fingerprint);
    if (result.outcome === "restored") {
      return { ok: false, path, holderPid: result.holderPid ?? lastHolder };
    }
  }
  return { ok: false, path, holderPid: lastHolder };
}

/**
 * Read the lock through an open fd and report whether it carries `handle.token`. The fd pins the
 * inode, so `sameFile()` below can tell whether the path still names the file that was read.
 */
function withOpenLock<T>(
  handle: LockHandle,
  fn: (body: LockState, pinned: { dev: bigint; ino: bigint }) => T,
): T | null {
  const fd = openNoFollow(handle.path);
  if (fd === null || fd === "symlink") return null;
  try {
    const st = fstatSync(fd, { bigint: true });
    if (!st.isFile()) return null;
    const body = parseLockBody(readFileSync(fd, "utf8"));
    return fn(body, { dev: st.dev, ino: st.ino });
  } finally {
    closeSync(fd);
  }
}

function carriesToken(body: LockState, handle: LockHandle): boolean {
  return body.state === "held" && body.token !== null && body.token === handle.token;
}

/** True iff `path` (not following symlinks) is still the pinned file. */
function sameFile(path: string, pinned: { dev: bigint; ino: bigint }): boolean {
  try {
    const now = lstatSync(path, { bigint: true });
    return now.dev === pinned.dev && now.ino === pinned.ino;
  } catch (err) {
    if (errCode(err) === "ENOENT") return false;
    throw err;
  }
}

/** Test seam: runs between the token check and the unlink (lets tests swap the file there). */
export type ReleaseHooks = { beforeUnlink?: () => void };

/**
 * Pin §3.3 (a): unlink the lock only if the on-disk token is this holder's token, and only if the
 * path still names the file whose body was checked (`lstat` vs `fstat` dev + inode; the open fd pins
 * the inode so it cannot be reused while we look). POSIX has no compare-and-unlink: a replacement
 * installed after the `lstat` would need our live lock to have been removed by someone else, which
 * (b) never does for a live pid. Returns true iff our lock was removed.
 */
export function releaseThreadLock(handle: LockHandle, hooks: ReleaseHooks = {}): boolean {
  return (
    withOpenLock(handle, (body, pinned) => {
      if (!carriesToken(body, handle)) return false;
      hooks.beforeUnlink?.();
      if (!sameFile(handle.path, pinned)) return false;
      try {
        unlinkSync(handle.path);
      } catch (err) {
        if (errCode(err) === "ENOENT") return false;
        throw err;
      }
      return true;
    }) ?? false
  );
}

/** True iff the lock on disk carries this acquisition's token. */
export function holdsThreadLock(handle: LockHandle): boolean {
  return (
    withOpenLock(handle, (body, pinned) => {
      return carriesToken(body, handle) && sameFile(handle.path, pinned);
    }) ?? false
  );
}
