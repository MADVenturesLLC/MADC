/**
 * `seat/list` (M1-A7; protocol pin §3.5 P4, seat pin §2). Read-only: enumerates
 * `$MADC_HOME/seats/*.json`, loads each through the same confined, validated loader `thread/start`
 * uses, and projects it to the `SeatSummary` this act locks. Never writes, never creates, and never
 * reads a seat file any other way than `loadSeat` does (no-follow fd, real-path confinement, inode
 * re-check), so listing cannot be turned into a read of something outside `$MADC_HOME`.
 *
 * A file that does not load is reported as `ok: false` with its code and issues rather than
 * dropped: an operator who can see `seats/<id>.json` on disk must be able to see why the engine
 * refuses it (and M1-A8's doctor reads the same projection).
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
 * Every `seats/<id>.json` in `$MADC_HOME`, sorted by seat id. Dot-names are skipped: the seed
 * writer's temp files start with "." precisely so they can never be loaded as a seat. A `seats/`
 * that is missing, unreadable, or does not resolve strictly inside the real `$MADC_HOME` lists
 * nothing (fail-safe for a read-only report; `madc doctor` is the surface that says why).
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
