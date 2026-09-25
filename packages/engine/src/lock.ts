import { randomUUID } from "node:crypto";
import { linkSync, lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { confinedPath } from "./home.ts";

/** Contents of `sessions/<threadId>.lock` (protocol pin §3.3). */
export type LockInfo = { pid: number; startedAt: number };

export type LockState =
  | { state: "missing" }
  | { state: "corrupt" }
  | { state: "held"; info: LockInfo };

/** Device + inode of a lock file (the file itself, never a symlink target). */
export type FileId = { dev: bigint; ino: bigint };

/**
 * Per-acquisition ownership token: the device + inode of the exact lock file this acquisition
 * linked into place, plus its pinned `{ pid, startedAt }` body. Inode numbers can be reused as soon
 * as a file is deleted, so both must match for the on-disk lock to count as "this acquisition".
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

/** True iff `path` is the handle's file: same dev/inode AND same `{ pid, startedAt }` body. */
function isHandleFile(path: string, h: LockHandle): boolean {
  const id = fileId(path);
  if (id === null || id.dev !== h.dev || id.ino !== h.ino) return false;
  const body = readLock(path);
  return body.state === "held" && body.info.pid === h.pid && body.info.startedAt === h.startedAt;
}

function handleFor(path: string, pid: number): LockHandle | null {
  const id = fileId(path);
  if (id === null) return null;
  const body = readLock(path);
  if (body.state !== "held" || body.info.pid !== pid) return null;
  return { path, pid, startedAt: body.info.startedAt, ...id };
}

function sameLockState(a: LockState, b: LockState): boolean {
  if (a.state === "held" && b.state === "held") {
    return a.info.pid === b.info.pid && a.info.startedAt === b.info.startedAt;
  }
  return a.state === b.state;
}

function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    if (errCode(err) !== "ENOENT") throw err;
  }
}

/**
 * Reclaim a lock judged dead/corrupt only if `path` still holds exactly that file (same dev/inode
 * and body). The lock is first atomically renamed aside; if it changed in the meantime (another
 * engine reclaimed it and installed its own), it is linked back and left alone. Returns true iff
 * the observed lock was removed. Internal; exported for tests.
 */
export function reclaimIfUnchanged(
  path: string,
  seenId: FileId,
  seen: LockState,
  pid: number = process.pid,
): boolean {
  const aside = `${path}.${pid}.${randomUUID()}.reclaim`;
  try {
    renameSync(path, aside);
  } catch (err) {
    if (errCode(err) === "ENOENT") return false;
    throw err;
  }
  try {
    const id = fileId(aside);
    const sameFile = id !== null && id.dev === seenId.dev && id.ino === seenId.ino;
    if (sameFile && sameLockState(readLock(aside), seen)) return true;
    try {
      linkSync(aside, path);
    } catch (err) {
      if (errCode(err) !== "EEXIST") throw err;
    }
    return false;
  } finally {
    removeQuietly(aside);
  }
}

/**
 * Create-exclusive lock. The full `{ pid, startedAt }` body is written to a private temp file and
 * hard-linked into place (`link` fails with EEXIST if the lock exists), so readers never observe a
 * half-written lock. A lock whose pid is dead (or whose body is unreadable) is reclaimed — but only
 * if it is still the very file that was judged (see `reclaimIfUnchanged`).
 */
export function acquireThreadLock(
  home: string,
  threadId: string,
  pid: number = process.pid,
): AcquireResult {
  const path = threadLockPath(home, threadId);
  let lastHolder: number | null = null;

  for (let attempt = 0; attempt < 5; attempt++) {
    const tmp = `${path}.${pid}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify({ pid, startedAt: Date.now() } satisfies LockInfo), {
      flag: "wx",
      mode: 0o600,
    });
    let handle: LockHandle | null = null;
    try {
      linkSync(tmp, path);
      // tmp and path are the same inode until tmp is unlinked below.
      handle = handleFor(tmp, pid);
    } catch (err) {
      if (errCode(err) !== "EEXIST") throw err;
    } finally {
      removeQuietly(tmp);
    }
    if (handle !== null) return { ok: true, path, handle: { ...handle, path } };

    const seenId = fileId(path);
    const current = readLock(path);
    if (current.state === "missing" || seenId === null) continue;
    if (current.state === "held") {
      if (current.info.pid === pid) {
        // Re-entrant: this process already holds it; adopt the on-disk file as our handle.
        const handle = handleFor(path, pid);
        if (handle !== null) return { ok: true, path, handle };
        continue;
      }
      lastHolder = current.info.pid;
      if (isPidAlive(current.info.pid)) {
        return { ok: false, path, holderPid: current.info.pid };
      }
    }
    // Dead holder or corrupt body → reclaim only the file we judged, then retry.
    reclaimIfUnchanged(path, seenId, current, pid);
  }
  return { ok: false, path, holderPid: lastHolder };
}

/**
 * Release only if the lock on disk is still THIS acquisition's file. Check-then-unlink on the path
 * would race with a replacement lock, so the lock is first atomically renamed to a private name;
 * the renamed file is then compared against the handle's identity. Ours → unlinked. Not ours (the lock
 * was replaced after ours vanished) → linked back into place (EEXIST: a newer lock already exists,
 * leave it) and the private name removed. The foreign lock is never deleted.
 */
export function releaseThreadLock(handle: LockHandle): void {
  const aside = `${handle.path}.${handle.pid}.${randomUUID()}.release`;
  try {
    renameSync(handle.path, aside);
  } catch (err) {
    if (errCode(err) === "ENOENT") return;
    throw err;
  }
  try {
    if (!isHandleFile(aside, handle)) {
      try {
        linkSync(aside, handle.path);
      } catch (err) {
        if (errCode(err) !== "EEXIST") throw err;
      }
    }
  } finally {
    removeQuietly(aside);
  }
}

/** True iff the lock on disk is this acquisition's file (dev/inode + `{ pid, startedAt }`). */
export function holdsThreadLock(handle: LockHandle): boolean {
  return isHandleFile(handle.path, handle);
}
