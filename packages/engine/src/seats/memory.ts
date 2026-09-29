/**
 * The seat's own memory path (M1 seat pin §1 `$MADC_HOME/memory/<seatId>.md`, §8 item 4).
 *
 * A turn on a seat whose `memory.mode` is `"file"` materializes that seat's own memory file, and
 * only that file: seats never share one (M1 plan §7 M1-A7 forbidden: "shared memory between
 * seats"). The file is created empty and never overwritten — the pin calls it "optional standing
 * memory notes (append-only text)", and no act in M1 commissions a memory content format ("memory
 * store beyond the per-seat file" is an M1 non-goal), so nothing is appended here. Creating it
 * 0600 leaves the path an append-only target the act that owns the format can write into.
 *
 * Confinement is re-checked at write time, not trusted from seat load: the path must resolve
 * strictly inside the real `memory/` directory, which must itself resolve strictly inside the real
 * `$MADC_HOME`, and the create is exclusive and no-follow — so a symlink, directory or FIFO at the
 * path is left alone (EEXIST → "exists") instead of being written through.
 */
import { closeSync, constants, fstatSync, openSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { confinedPath, isStrictlyUnder } from "../home.ts";
import type { EngineSeat } from "../seat.ts";

const MEMORY_PREFIX = "memory/";

export type SeatMemoryFile = {
  /** The real, confined path of the seat's memory file. */
  readonly path: string;
  /** False when the file already existed — it is never overwritten and never appended to here. */
  readonly created: boolean;
};

function errCode(err: unknown): string | undefined {
  return err !== null && typeof err === "object" && "code" in err
    ? String((err as { code: unknown }).code)
    : undefined;
}

/**
 * Ensure `seat.memory.path` exists under the real `$MADC_HOME/memory/`. Returns `null` for an
 * `in-session` seat (there is no path to materialize). Throws when the path does not confine, when
 * `memory/` is not a real directory, or when the file cannot be created — the caller logs and the
 * turn proceeds: memory notes are optional, and a refusal here must not fake a receipt.
 */
export function ensureSeatMemoryFile(home: string, seat: EngineSeat): SeatMemoryFile | null {
  const memory = seat.memory;
  if (memory.mode !== "file") return null;
  // The audited directory logic (real dir, not a symlink, 0700, strictly under the real home).
  // The returned path is a confined reference for `memory/<seatId>.md`; the seat's own file name
  // comes from `memory.path` and is confined again below.
  confinedPath(home, "memory", seat.id, ".md");
  const realMemory = realpathSync(join(home, "memory"));
  const realHome = realpathSync(home);
  if (!isStrictlyUnder(realMemory, realHome)) {
    throw new Error("memory/ resolves outside MADC_HOME");
  }
  if (!memory.path.startsWith(MEMORY_PREFIX)) {
    throw new Error(`memory.path must be under "${MEMORY_PREFIX}"`);
  }
  const target = join(realMemory, memory.path.slice(MEMORY_PREFIX.length));
  if (!isStrictlyUnder(target, realMemory)) {
    throw new Error("memory.path resolves outside MADC_HOME/memory");
  }
  let fd: number;
  try {
    fd = openSync(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
  } catch (err) {
    // Already there (a seat file, an operator's notes, or a symlink we must not follow): leave it.
    if (errCode(err) === "EEXIST") return { path: target, created: false };
    throw err;
  }
  try {
    const st = fstatSync(fd, { bigint: true });
    if (!st.isFile() || st.nlink !== 1n) {
      throw new Error("memory path is not a single-name regular file");
    }
  } finally {
    closeSync(fd);
  }
  return { path: target, created: true };
}
