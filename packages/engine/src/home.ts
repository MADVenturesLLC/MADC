import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { internalError, invalidParams } from "./protocol/errors.ts";
import { isValidId } from "./protocol/ids.ts";

/**
 * `$MADC_HOME` (seat pin §1): optional override; unset → `$HOME/.madc`.
 * When set it must be absolute.
 */
export function resolveMadcHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.MADC_HOME;
  if (override !== undefined && override !== "") {
    if (!isAbsolute(override)) {
      throw new Error("MADC_HOME must be an absolute path");
    }
    return resolve(override);
  }
  return join(homedir(), ".madc");
}

export type HomeSubdir = "sessions" | "seats" | "memory";

/** `child` is strictly inside `parent` (both already resolved). */
export function isStrictlyUnder(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !isAbsolute(rel) && rel.split(sep)[0] !== "..";
}

function errCode(err: unknown): string | undefined {
  return err !== null && typeof err === "object" && "code" in err
    ? String((err as { code: unknown }).code)
    : undefined;
}

/**
 * `mkdir`'s mode only applies to newly created dirs, so a pre-existing `$MADC_HOME` or subdir keeps
 * whatever it had. Tighten group/other bits to reach the pinned `0700` (seat pin §1). POSIX only;
 * best effort on Windows (mode bits are not meaningful there).
 */
export function enforcePrivateDir(dir: string): void {
  if (process.platform === "win32") return;
  const mode = statSync(dir).mode & 0o777;
  if ((mode & 0o077) !== 0) chmodSync(dir, mode & 0o700);
}

/**
 * `enforcePrivateDir` for a directory already checked with `lstat` (real directory, `expected`
 * dev + inode), without a path-based chmod after that check: the directory is opened no-follow
 * (`O_DIRECTORY | O_NOFOLLOW`), the fd must still be that same directory (fstat dev + inode), and
 * group/other bits are cleared with `fchmod` on the fd. Returns false (nothing changed) if the path
 * no longer names the checked directory. Windows: the same no-op as `enforcePrivateDir` (mode bits
 * are not meaningful there and Node has no no-follow directory open; PR #10 Windows waiver). On
 * POSIX the dev + inode check alone pins the fd to the checked directory even if a platform lacks
 * one of the flags; fchmod then only ever touches that directory.
 */
export function enforcePrivateDirAt(
  dir: string,
  expected: { readonly dev: bigint; readonly ino: bigint },
): boolean {
  if (process.platform === "win32") return true;
  let fd: number;
  try {
    fd = openSync(
      dir,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
    );
  } catch (err) {
    const code = errCode(err);
    if (code === "ELOOP" || code === "ENOTDIR" || code === "ENOENT") return false;
    // An owner-unreadable directory (e.g. 0300) cannot be opened O_RDONLY. If it is still the
    // checked directory and has no group/other bits there is nothing to tighten (the path-based
    // `enforcePrivateDir` never chmod'ed it either); otherwise fail closed rather than chmod by path.
    if (code === "EACCES" && noGroupOtherBits(dir, expected)) return true;
    throw err;
  }
  try {
    const st = fstatSync(fd, { bigint: true });
    if (!st.isDirectory() || st.dev !== expected.dev || st.ino !== expected.ino) return false;
    const mode = Number(st.mode & 0o777n);
    if ((mode & 0o077) !== 0) fchmodSync(fd, mode & 0o700);
    return true;
  } finally {
    closeSync(fd);
  }
}

/** `dir` is still the lstat-checked real directory `expected` and its mode has no 0o077 bits. */
function noGroupOtherBits(
  dir: string,
  expected: { readonly dev: bigint; readonly ino: bigint },
): boolean {
  try {
    const st = lstatSync(dir, { bigint: true });
    return (
      st.isDirectory() &&
      !st.isSymbolicLink() &&
      st.dev === expected.dev &&
      st.ino === expected.ino &&
      (st.mode & 0o077n) === 0n
    );
  } catch {
    return false;
  }
}

const ESCAPES = "Resolved path escapes MADC_HOME";

/**
 * Ensure `$MADC_HOME/<subdir>` is a real directory (not a symlink) without touching anything
 * outside `$MADC_HOME`: the component is `lstat`ed first and a symlink / non-directory is rejected
 * BEFORE any mkdir or chmod; only a missing component is created (non-recursively, so an existing
 * symlink is never followed).
 */
function ensureSubdir(dir: string): void {
  for (let attempt = 0; attempt < 2; attempt++) {
    let isDir = false;
    try {
      const st = lstatSync(dir);
      if (st.isSymbolicLink() || !st.isDirectory()) throw internalError(ESCAPES);
      isDir = true;
    } catch (err) {
      if (errCode(err) !== "ENOENT") throw err;
    }
    if (isDir) return;
    try {
      mkdirSync(dir, { mode: 0o700 });
      return;
    } catch (err) {
      if (errCode(err) !== "EEXIST") throw err; // raced with another creator: re-check it
    }
  }
  throw internalError(ESCAPES);
}

/**
 * Resolve `$MADC_HOME/<subdir>/<id><ext>` with confinement:
 * 1. `id` must match the protocol id grammar — checked FIRST, before any path join or mkdir (→ -32602).
 * 2. `<subdir>` must be a real directory directly under `$MADC_HOME` — a symlinked component is
 *    rejected before anything is created or chmod'ed (→ -32603).
 * 3. Defense in depth: the real path must stay under the real path of `$MADC_HOME`.
 * 4. Only then are the verified dirs tightened to `0700` (best effort on Windows).
 * `$MADC_HOME` itself is operator-chosen and may be a symlink; it is created if missing.
 */
export function confinedPath(home: string, subdir: HomeSubdir, id: string, ext: string): string {
  if (!isValidId(id)) {
    throw invalidParams([`${subdir} id must match ^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`]);
  }
  mkdirSync(home, { recursive: true, mode: 0o700 });
  ensureSubdir(join(home, subdir));
  const realHome = realpathSync(home);
  const realDir = realpathSync(join(home, subdir));
  const target = join(realDir, `${id}${ext}`);
  if (!isStrictlyUnder(realDir, realHome) || !isStrictlyUnder(target, realHome)) {
    // Session / lock paths have no dedicated code in §4.1; seat/memory escapes are A4 (-32006).
    throw internalError(ESCAPES);
  }
  enforcePrivateDir(realHome);
  enforcePrivateDir(realDir);
  return target;
}
