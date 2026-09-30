/**
 * `seat/list` (M1-A7; protocol pin §3.5 P4, seat pin §2). Read-only: enumerates
 * `$MADC_HOME/seats/*.json`, loads each through the same confined, validated loader `thread/start`
 * uses, and projects it to the `SeatSummary` this act locks. Never writes, never creates, and never
 * reads a seat file any other way than `loadSeat` does (no-follow fd, real-path confinement, inode
 * re-check), so listing cannot be turned into a read of something outside `$MADC_HOME`.
 *
 * A seat whose file does not load is reported as `ok: false` with its code and issues rather than
 * dropped: an operator who can see `seats/<id>.json` on disk must be able to see why the engine
 * refuses it (and M1-A8's doctor reads the same projection). Names that could never be a seat id
 * are the one exception, and why is stated on `listSeatSummaries`.
 */
import { readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { isStrictlyUnder } from "../home.ts";
import { RpcError } from "../protocol/errors.ts";
import { isValidId } from "../protocol/ids.ts";
import type { SeatSummary } from "../protocol/types.ts";
import { type LoadedSeat, loadSeat } from "../seat-store.ts";

const SEAT_FILE_SUFFIX = ".json";

/** The M1-A7 projection of one loaded seat (protocol pin §3.5 defers this shape to this act). */
export function seatSummary(loaded: LoadedSeat): SeatSummary {
  const { seat } = loaded;
  return {
    id: seat.id,
    ok: true,
    path: loaded.path,
    version: seat.version,
    // A v1 seat has no displayName in its schema (S2); `null` says that honestly, where "" would
    // be indistinguishable from an empty name.
    displayName: seat.displayName ?? null,
    role: seat.role,
    pinnedModel: seat.pinnedModel,
    preferredBacking: seat.preferredBacking,
    fallbacks: [...seat.fallbacks],
    memory:
      seat.memory.mode === "file"
        ? { mode: "file", path: seat.memory.path }
        : { mode: "in-session" },
    tools: { deny: [...seat.tools.deny] },
    policy: { headlessOk: seat.policy.headlessOk },
    warnings: [...loaded.warnings],
  };
}

/**
 * Every seat in `$MADC_HOME/seats/`, sorted by seat id. Two kinds of name are deliberately NOT
 * listed, and neither is a seat this engine could ever load:
 *
 * - dot-names — the seed writer's temp files start with "." precisely so they can never be read as
 *   a seat (and they end in `.tmp`, so the suffix filter already excludes them);
 * - a stem that is not a valid protocol id (e.g. `bad.id.json`) — `thread/start` refuses such a
 *   `seatId` with -32602 before any path join, so the file is unreachable as a seat by
 *   construction. It is skipped rather than reported because reporting it would echo
 *   operator-controlled filename bytes into a protocol response the CLI prints verbatim; a stray
 *   file in `seats/` is home-level junk and belongs to `madc doctor` (M1-A8), which reports the
 *   directory itself.
 *
 * A name that IS a valid seat id but whose file does not load is reported as `ok: false` with its
 * code and issues, never dropped. A `seats/` that is missing, unreadable, or does not resolve
 * strictly inside the real `$MADC_HOME` lists nothing (fail-safe for a read-only report; doctor is
 * the surface that says why).
 */
export function listSeatSummaries(home: string): SeatSummary[] {
  const dir = join(home, "seats");
  let names: string[];
  try {
    const realDir = realpathSync(dir);
    if (!isStrictlyUnder(realDir, realpathSync(home))) return [];
    names = readdirSync(realDir);
  } catch {
    return [];
  }
  const ids = names
    .filter((name) => name.endsWith(SEAT_FILE_SUFFIX))
    .map((name) => name.slice(0, -SEAT_FILE_SUFFIX.length))
    .filter((id) => !id.startsWith(".") && isValidId(id))
    .sort();
  const summaries: SeatSummary[] = [];
  for (const id of ids) {
    try {
      summaries.push(seatSummary(loadSeat(home, id)));
    } catch (err) {
      if (err instanceof RpcError) {
        summaries.push({
          id,
          ok: false,
          path: join(dir, `${id}${SEAT_FILE_SUFFIX}`),
          code: err.code,
          issues: Array.isArray(err.data?.issues) ? (err.data.issues as string[]) : [],
        });
        continue;
      }
      throw err;
    }
  }
  return summaries;
}
