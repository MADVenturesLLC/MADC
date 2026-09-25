import { chmodSync, mkdirSync, realpathSync, statSync } from "node:fs";
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

function isStrictlyUnder(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !isAbsolute(rel) && rel.split(sep)[0] !== "..";
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
 * Resolve `$MADC_HOME/<subdir>/<id><ext>` with confinement:
 * 1. `id` must match the protocol id grammar — checked FIRST, before any path join or mkdir (→ -32602).
 * 2. The real path of `<subdir>` (after symlinks) must stay under the real path of `$MADC_HOME`.
 * 3. Only then are the verified real dirs tightened to `0700` (best effort on Windows).
 */
export function confinedPath(home: string, subdir: HomeSubdir, id: string, ext: string): string {
  if (!isValidId(id)) {
    throw invalidParams([`${subdir} id must match ^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`]);
  }
  mkdirSync(join(home, subdir), { recursive: true, mode: 0o700 });
  const realHome = realpathSync(home);
  const realDir = realpathSync(join(home, subdir));
  const target = join(realDir, `${id}${ext}`);
  if (!isStrictlyUnder(realDir, realHome) || !isStrictlyUnder(target, realHome)) {
    // Session / lock paths have no dedicated code in §4.1; seat/memory escapes are A4 (-32006).
    throw internalError("Resolved path escapes MADC_HOME");
  }
  // Never chmod before confinement: a symlinked subdir must not get an outside dir tightened.
  enforcePrivateDir(realHome);
  enforcePrivateDir(realDir);
  return target;
}
