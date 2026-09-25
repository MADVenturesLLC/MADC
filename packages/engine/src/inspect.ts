/**
 * Read-only home report (seat pin §6 item 8, plan A4 "doctor reports seat + last session").
 * `madc doctor` lands in A7; until then this engine export is the A4 helper it will call.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { RpcError } from "./protocol/errors.ts";
import { isValidId } from "./protocol/ids.ts";
import { DEFAULT_SEAT_ID } from "./protocol/types.ts";
import { loadSeat, seatFilePath } from "./seat-store.ts";
import { verifySessionFile } from "./session-store.ts";

export type SeatReport =
  | { readonly id: string; readonly path: string; readonly ok: true }
  | {
      readonly id: string;
      readonly path: string;
      readonly ok: false;
      readonly code: number;
      readonly issues: readonly string[];
    };

export type SessionReport = {
  readonly threadId: string;
  readonly path: string;
  readonly seatId: string | null;
  readonly events: number;
  readonly chain:
    | { readonly ok: true }
    | { readonly ok: false; readonly line: number; readonly reason: string };
};

export type HomeReport = {
  readonly home: string;
  readonly seat: SeatReport;
  /** Most recently modified `sessions/<threadId>.jsonl`, or null when there is none. */
  readonly lastSession: SessionReport | null;
};

function seatReport(home: string, seatId: string): SeatReport {
  const path = seatFilePath(home, seatId);
  try {
    loadSeat(home, seatId);
    return { id: seatId, path, ok: true };
  } catch (err) {
    if (err instanceof RpcError) {
      const issues = Array.isArray(err.data?.issues) ? (err.data.issues as string[]) : [];
      return { id: seatId, path, ok: false, code: err.code, issues };
    }
    throw err;
  }
}

/** Newest session file by mtime (ties: larger file name). */
function lastSessionPath(home: string): { threadId: string; path: string } | null {
  const dir = join(home, "sessions");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  let best: { threadId: string; path: string; mtime: number } | null = null;
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const threadId = name.slice(0, -".jsonl".length);
    if (!isValidId(threadId)) continue;
    const path = join(dir, name);
    let mtime: number;
    try {
      const st = statSync(path);
      if (!st.isFile()) continue;
      mtime = st.mtimeMs;
    } catch {
      continue;
    }
    if (
      best === null ||
      mtime > best.mtime ||
      (mtime === best.mtime && name > `${best.threadId}.jsonl`)
    ) {
      best = { threadId, path, mtime };
    }
  }
  return best === null ? null : { threadId: best.threadId, path: best.path };
}

/** Seat id + validity, last session path, and whether its hash chain verifies. Never writes. */
export function inspectMadcHome(home: string, seatId: string = DEFAULT_SEAT_ID): HomeReport {
  const last = lastSessionPath(home);
  let lastSession: SessionReport | null = null;
  if (last !== null) {
    const result = verifySessionFile(last.path, last.threadId);
    lastSession = result.ok
      ? {
          ...last,
          seatId: result.events[0]?.seatId ?? null,
          events: result.events.length,
          chain: { ok: true },
        }
      : {
          ...last,
          seatId: null,
          events: 0,
          chain: { ok: false, line: result.line, reason: result.reason },
        };
  }
  return { home, seat: seatReport(home, seatId), lastSession };
}
