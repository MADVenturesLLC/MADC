import { mkdirSync, realpathSync } from "node:fs";
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
 * Resolve `$MADC_HOME/<subdir>/<id><ext>` with confinement:
 * 1. `id` must match the protocol id grammar — checked FIRST, before any path join or mkdir (→ -32602).
 * 2. The real path of `<subdir>` (after symlinks) must stay under the real path of `$MADC_HOME`.
 * Dirs are created `0700` (best effort on Windows).
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
  return target;
}
