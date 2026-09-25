import { randomUUID } from "node:crypto";
import { linkSync, lstatSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { confinedPath } from "./home.ts";

/** Contents of `sessions/<threadId>.lock` (protocol pin §3.3). */
export type LockInfo = { pid: number; startedAt: number };

export type LockState =
  | { state: "missing" }
  | { state: "corrupt" }
  | { state: "held"; info: LockInfo };

export type AcquireResult =
  | { ok: true; path: string }
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

function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    if (errCode(err) !== "ENOENT") throw err;
  }
}

/**
 * Create-exclusive lock. The full `{ pid, startedAt }` body is written to a private temp file and
 * hard-linked into place (`link` fails with EEXIST if the lock exists), so readers never observe a
 * half-written lock. A lock whose pid is dead (or whose body is unreadable) is reclaimed.
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
    try {
      linkSync(tmp, path);
      return { ok: true, path };
    } catch (err) {
      if (errCode(err) !== "EEXIST") throw err;
    } finally {
      removeQuietly(tmp);
    }

    const current = readLock(path);
    if (current.state === "missing") continue;
    if (current.state === "held") {
      if (current.info.pid === pid) return { ok: true, path };
      lastHolder = current.info.pid;
      if (isPidAlive(current.info.pid)) {
        return { ok: false, path, holderPid: current.info.pid };
      }
    }
    // Dead holder or corrupt body → reclaim and retry.
    removeQuietly(path);
  }
  return { ok: false, path, holderPid: lastHolder };
}

/** Release only if the lock on disk is still ours. */
export function releaseThreadLock(path: string, pid: number = process.pid): void {
  const current = readLock(path);
  if (current.state === "held" && current.info.pid === pid) {
    removeQuietly(path);
  }
}

/** True iff the lock on disk exists and names `pid`. */
export function holdsThreadLock(path: string, pid: number = process.pid): boolean {
  const current = readLock(path);
  return current.state === "held" && current.info.pid === pid;
}
