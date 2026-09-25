import { randomUUID } from "node:crypto";
import { linkSync, lstatSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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

/** Mutation guard for a lock file: `<lock>.guard`. Internal; exported for tests. */
export function lockGuardPath(lockPath: string): string {
  return `${lockPath}.guard`;
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

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Create `target` exclusively with a complete `{ pid, startedAt }` body: written to a private temp
 * file, then hard-linked into place (`link` fails with EEXIST if `target` exists), so readers never
 * observe a half-written file. Returns true iff this call created `target`.
 */
function linkExclusive(target: string, pid: number): boolean {
  const tmp = `${target}.${pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify({ pid, startedAt: Date.now() } satisfies LockInfo), {
    flag: "wx",
    mode: 0o600,
  });
  try {
    linkSync(tmp, target);
    return true;
  } catch (err) {
    if (errCode(err) !== "EEXIST") throw err;
    return false;
  } finally {
    removeQuietly(tmp);
  }
}

const GUARD_ATTEMPTS = 50;
const GUARD_WAIT_MS = 2;

/**
 * Run `fn` while holding the lock's mutation guard (`<lock>.guard`, created exclusively, body
 * `{ pid, startedAt }` of this process). Every operation that REMOVES a lock file (dead-lock reclaim,
 * release) runs under the guard; acquisition only ever links into an absent path. So while the guard
 * is held, the lock file cannot be swapped between an identity check and the unlink that follows —
 * the lock is never moved aside or left briefly absent. A guard held by a live process is waited on
 * briefly; one left behind by a dead process (or with an unreadable body) is broken. Returns
 * `{ ok: false }` if the guard could not be taken.
 */
function withLockGuard<T>(lockPath: string, fn: () => T): { ok: true; value: T } | { ok: false } {
  const guard = lockGuardPath(lockPath);
  for (let attempt = 0; attempt < GUARD_ATTEMPTS; attempt++) {
    if (linkExclusive(guard, process.pid)) {
      try {
        return { ok: true, value: fn() };
      } finally {
        // Only a dead holder's guard is ever broken, so while we run this is still ours.
        removeQuietly(guard);
      }
    }
    const held = readLock(guard);
    if (held.state === "missing") continue;
    if (held.state === "held" && isPidAlive(held.info.pid)) {
      sleepSync(GUARD_WAIT_MS);
      continue;
    }
    removeQuietly(guard); // left by a crashed process (or tampered with): break it
  }
  return { ok: false };
}

/**
 * Reclaim a lock judged dead/corrupt only if `path` still holds exactly that file (same dev/inode
 * and body). Verification and unlink happen under the lock's mutation guard, so a lock that another
 * engine installed after the judgement is never deleted. Returns true iff the observed lock was
 * removed. Internal; exported for tests.
 */
export function reclaimIfUnchanged(path: string, seenId: FileId, seen: LockState): boolean {
  const res = withLockGuard(path, () => {
    const id = fileId(path);
    if (id === null || id.dev !== seenId.dev || id.ino !== seenId.ino) return false;
    if (!sameLockState(readLock(path), seen)) return false;
    removeQuietly(path);
    return true;
  });
  return res.ok && res.value;
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
    reclaimIfUnchanged(path, seenId, current);
  }
  return { ok: false, path, holderPid: lastHolder };
}

/**
 * Release only if the lock on disk is still THIS acquisition's file (dev/inode + body). The check
 * and the unlink run under the lock's mutation guard, so a replacement lock installed by another
 * engine is never deleted and the lock path is never left briefly absent. Returns true iff our lock
 * was removed. If the guard stays busy, the lock is left in place; once this process exits it is a
 * dead-pid lock and is reclaimed by the next acquirer.
 */
export function releaseThreadLock(handle: LockHandle): boolean {
  const res = withLockGuard(handle.path, () => {
    if (!isHandleFile(handle.path, handle)) return false;
    removeQuietly(handle.path);
    return true;
  });
  return res.ok && res.value;
}

/** True iff the lock on disk is this acquisition's file (dev/inode + `{ pid, startedAt }`). */
export function holdsThreadLock(handle: LockHandle): boolean {
  return isHandleFile(handle.path, handle);
}
