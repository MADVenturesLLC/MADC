/**
 * The seat's own memory path (M1 seat pin §1 `$MADC_HOME/memory/<seatId>.md`, §8 item 4).
 *
 * A thread on a seat materializes that seat's OWN memory file, and only that file: seats never
 * share one (M1 plan §7 M1-A7 forbidden: "shared memory between seats"). The file is created empty
 * and never overwritten — the pin calls it "optional standing memory notes (append-only text)", and
 * no act in M1 commissions a memory content format ("memory store beyond the per-seat file" is an
 * M1 non-goal), so nothing is appended here. Creating it 0600 leaves the path an append-only target
 * the act that owns the format can write into.
 *
 * Only the pinned default path `memory/<seatId>.md` is ever materialized. The schema lets a seat
 * declare any `memory/*.md` (M0 pins "relative, normalized, under `memory/`, ends `.md`" — not
 * "named after the seat", and a nested path is a loadable M0 case), but a declared path is left
 * alone here, because creating it would mean either
 *
 * - writing a file named by one seat's config into another seat's memory path (a seat declaring
 *   `memory/hephaestus.md` would have `daedalus`'s thread create it), or
 * - resolving an intermediate path component the seat file controls. `O_NOFOLLOW` protects only the
 *   FINAL component, so a `memory/team` swapped to a symlink after seat load would put the create
 *   outside `$MADC_HOME` however carefully the leaf itself is checked.
 *
 * With the id grammar enforced and the file directly inside `memory/`, there is no intermediate
 * component left to swap: `confinedPath()` validates the id BEFORE any join, refuses a symlinked or
 * non-directory `memory/`, realpath-confines the result under the real home, and tightens the dirs
 * to 0700. The create itself stays exclusive and no-follow, so an existing file, directory, FIFO or
 * symlink at the path is reported as "exists" and never written through.
 */
import { closeSync, constants, fstatSync, openSync } from "node:fs";
import { confinedPath } from "../home.ts";
import type { EngineSeat } from "../seat.ts";

export type SeatMemoryFile = {
  /** The real, confined path of the seat's own memory file. */
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
 * Ensure the seat's own `memory/<seatId>.md` exists under the real `$MADC_HOME`. Returns `null`
 * when there is nothing for this act to materialize: an `in-session` seat has no path, and a seat
 * that declares a different `memory/*.md` keeps whatever the operator put there (see the header —
 * no act commissions memory content, so there is nothing to write into it either way).
 *
 * Throws when `memory/` is not a real directory under the home or the file cannot be created; the
 * caller logs and carries on, because memory notes are optional and a refusal here must never fake
 * a receipt or fail a thread that could otherwise serve.
 */
export function ensureSeatMemoryFile(home: string, seat: EngineSeat): SeatMemoryFile | null {
  const memory = seat.memory;
  if (memory.mode !== "file") return null;
  if (memory.path !== `memory/${seat.id}.md`) return null;
  const target = confinedPath(home, "memory", seat.id, ".md");
  let fd: number;
  try {
    fd = openSync(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
  } catch (err) {
    // Already there (an earlier thread, the operator's own notes, or a symlink we must not
    // follow): leave it exactly as it is.
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
