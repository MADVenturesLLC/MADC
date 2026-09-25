import { randomUUID } from "node:crypto";
import { linkSync, lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { confinedPath } from "./home.ts";

/** Contents of `sessions/<threadId>.lock` (protocol pin §3.3 — exactly `{ pid, startedAt }`). */
export type LockInfo = { pid: number; startedAt: number };

export type LockState =
  | { state: "missing" }
  | { state: "corrupt" }
  | { state: "held"; info: LockInfo };

/** Device + inode of a lock file (the file itself, never a symlink target). */
export type FileId = { dev: bigint; ino: bigint };

/**
 * Per-acquisition ownership token. The pin fixes the lock body to `{ pid, startedAt }`, so the token
 * is that body plus the device/inode of the exact file this acquisition created (inode numbers are
 * reused after deletion, so body and inode must both match).
 */
export type LockHandle = {
  path: string;
  pid: number;
  startedAt: number;
  dev: bigint;
  ino: bigint;
};

export type AcquireResult =
  | { ok: true; path: string; handle: LockHandle }
  | { ok: false; path: string; holderPid: number | null };

export function threadLockPath(home: string, threadId: string): string {
  return confinedPath(home, "sessions", threadId, ".lock");
}

function errCode(err: unknown): string | undefined {
  return err !== null && typeof err === "object" && "code" in err
    ? String((err as { code: unknown }).code)
    : undefined;
}

export function readLock(path: string): LockState {
  let text: string;
  try {
    // A symlink planted at the lock path is never followed.
    if (lstatSync(path).isSymbolicLink()) return { state: "corrupt" };
    text = readFileSync(path, "utf8");
  } catch (err) {
    if (errCode(err) === "ENOENT") return { state: "missing" };
    throw err;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      Number.isInteger((parsed as LockInfo).pid) &&
      (parsed as LockInfo).pid > 0 &&
      typeof (parsed as LockInfo).startedAt === "number"
    ) {
      const { pid, startedAt } = parsed as LockInfo;
      return { state: "held", info: { pid, startedAt } };
    }
  } catch {
    // fall through
  }
  return { state: "corrupt" };
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

export function fileId(path: string): FileId | null {
  try {
    const st = lstatSync(path, { bigint: true });
    return { dev: st.dev, ino: st.ino };
  } catch (err) {
    if (errCode(err) === "ENOENT") return null;
    throw err;
  }
}

function sameId(a: FileId | null, b: FileId): boolean {
  return a !== null && a.dev === b.dev && a.ino === b.ino;
}

function sameLockState(a: LockState, b: LockState): boolean {
  if (a.state === "held" && b.state === "held") {
    return a.info.pid === b.info.pid && a.info.startedAt === b.info.startedAt;
  }
  return a.state === b.state;
}

/** True iff `path` is the handle's file: same dev/inode AND same `{ pid, startedAt }` body. */
function isHandleFile(path: string, h: LockHandle): boolean {
  if (!sameId(fileId(path), h)) return false;
  const body = readLock(path);
  return body.state === "held" && body.info.pid === h.pid && body.info.startedAt === h.startedAt;
}

function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    if (errCode(err) !== "ENOENT") throw err;
  }
}

/**
 * Exclusive create: the complete body goes to a private temp file which is hard-linked into place.
 * `link` fails with EEXIST if the lock exists (same semantics as O_EXCL), and readers never see a
 * half-written body (an empty file would otherwise look corrupt and be reclaimed).
 */
function createExclusive(path: string, pid: number): LockHandle | null {
  const startedAt = Date.now();
  const tmp = `${path}.${pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify({ pid, startedAt } satisfies LockInfo), {
    flag: "wx",
    mode: 0o600,
  });
  try {
    linkSync(tmp, path);
    const id = fileId(tmp); // same inode as `path` until tmp is unlinked below
    return id === null ? null : { path, pid, startedAt, ...id };
  } catch (err) {
    if (errCode(err) !== "EEXIST") throw err;
    return null;
  } finally {
    removeQuietly(tmp);
  }
}

/**
 * Remove a lock that was judged dead/corrupt. `rename` to a unique per-attempt name is atomic, so of
 * several reclaimers exactly one moves the file; the moved file is then checked against what was
 * judged (dev/inode + body) and deleted only if it matches. If it does not match (a fresh lock was
 * installed between the judgement and the rename), it is linked back into place and the caller
 * retries; if yet another lock already took the path, the moved file is left alone — a lock that was
 * not judged dead is never deleted. Returns true iff the judged lock was removed.
 * Internal; exported for tests.
 */
export function reclaimIfUnchanged(path: string, seenId: FileId, seen: LockState): boolean {
  const moved = `${path}.${process.pid}.${randomUUID()}.stale`;
  try {
    renameSync(path, moved);
  } catch (err) {
    if (errCode(err) === "ENOENT") return false; // another reclaimer won the rename
    throw err;
  }
  if (sameId(fileId(moved), seenId) && sameLockState(readLock(moved), seen)) {
    removeQuietly(moved);
    return true;
  }
  // Not the judged file: put it back. On success `moved` is a second name for the same inode and
  // is dropped; on EEXIST a newer lock owns the path and `moved` is left as-is (never deleted).
  try {
    linkSync(moved, path);
    removeQuietly(moved);
  } catch (err) {
    if (errCode(err) !== "EEXIST") throw err;
  }
  return false;
}

/**
 * Take `sessions/<threadId>.lock`. Live foreign holder → refused with its pid. Dead holder or
 * unreadable body → reclaimed (see `reclaimIfUnchanged`) and creation retried.
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

    const seenId = fileId(path);
    const current = readLock(path);
    if (seenId === null || current.state === "missing") continue;
    if (current.state === "held") {
      if (current.info.pid === pid) {
        // Re-entrant: this process already holds it; adopt the on-disk file as our handle.
        if (sameId(fileId(path), seenId)) {
          return { ok: true, path, handle: { path, ...current.info, ...seenId } };
        }
        continue;
      }
      lastHolder = current.info.pid;
      if (isPidAlive(current.info.pid)) return { ok: false, path, holderPid: current.info.pid };
    }
    reclaimIfUnchanged(path, seenId, current);
  }
  return { ok: false, path, holderPid: lastHolder };
}

/**
 * Release only this acquisition's lock: read identity (dev/inode + body), unlink only on a match.
 * Residual (documented): the check and the unlink are two syscalls; a replacement can only appear
 * in between if our lock was already removed by someone else in that same instant.
 * Returns true iff our lock was removed.
 */
export function releaseThreadLock(handle: LockHandle): boolean {
  if (!isHandleFile(handle.path, handle)) return false;
  removeQuietly(handle.path);
  return true;
}

/** True iff the lock on disk is this acquisition's file (dev/inode + `{ pid, startedAt }`). */
export function holdsThreadLock(handle: LockHandle): boolean {
  return isHandleFile(handle.path, handle);
}
