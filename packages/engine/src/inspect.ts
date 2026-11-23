/**
 * Read-only home report (seat pin §6 item 8, plan A4 "doctor reports seat + last session").
 * `madc doctor` lands in A7; until then this engine export is the A4 helper it will call.
 */
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { openDecisionsInChain } from "./decisions.ts";
import { inspectSessionV2, type SessionFinding, type SessionFindingLevel } from "./handoff.ts";
import { isStrictlyUnder } from "./home.ts";
import { RpcError } from "./protocol/errors.ts";
import { isValidId } from "./protocol/ids.ts";
import { DEFAULT_SEAT_ID, type OpenDecisionSummary } from "./protocol/types.ts";
import { loadSeat, seatFilePath } from "./seat-store.ts";
import { type SessionFailureKind, verifySessionFile } from "./session-store.ts";
import type { SessionOpenHandoffLink, WorktreeIdentity } from "./session-v2.ts";

export type { SessionFinding, SessionFindingCode, SessionFindingLevel } from "./handoff.ts";

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
    | {
        readonly ok: false;
        readonly line: number;
        readonly reason: string;
        /** Amendment 2 §5: `torn-tail` (crash residue) or `integrity` (may be tampering). */
        readonly kind: SessionFailureKind;
      };
  /**
   * M2 pin §7: the schema-v2 findings over a chain that verifies (handoff links from either side,
   * duplicate ids, evidence refs, the close-time worktree, a v2 thread never closed, and — M2
   * brief-delivery pin §5 — a handoff target that has not served its brief). Empty when the chain
   * does not verify (the chain row already FAILs) and for a v1 file with no v2 lines.
   */
  readonly findings: readonly SessionFinding[];
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

/**
 * Newest session file by mtime (ties: larger file name). Only regular files (never symlinks) in a
 * `sessions/` directory that resolves under the real `MADC_HOME` are considered.
 */
function lastSessionPath(home: string): { threadId: string; path: string } | null {
  const dir = join(home, "sessions");
  let names: string[];
  try {
    if (!isStrictlyUnder(realpathSync(dir), realpathSync(home))) return null;
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
      const st = lstatSync(path);
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
    const result = verifySessionFile(last.path, last.threadId, {}, home);
    lastSession = result.ok
      ? {
          ...last,
          seatId: result.events[0]?.seatId ?? null,
          events: result.events.length,
          chain: { ok: true },
          findings: inspectSessionV2(home, result.events),
        }
      : {
          ...last,
          seatId: null,
          events: 0,
          chain: { ok: false, line: result.line, reason: result.reason, kind: result.kind },
          findings: [],
        };
  }
  return { home, seat: seatReport(home, seatId), lastSession };
}

export type RoomThreadRow = {
  readonly threadId: string;
  readonly path: string;
  readonly seatId: string | null;
  readonly level: "pass" | SessionFindingLevel;
  readonly chain: SessionReport["chain"];
  readonly handoff: {
    readonly inbound: SessionOpenHandoffLink | null;
    readonly outboundCount: number;
    readonly oneWay: boolean;
  };
  readonly worktree: {
    readonly open: WorktreeIdentity | null;
    readonly close: WorktreeIdentity | null;
    readonly missing: boolean;
  };
  readonly openDecisions: readonly OpenDecisionSummary[];
  readonly findings: readonly SessionFinding[];
};

export type RoomReport = {
  readonly home: string;
  readonly threads: readonly RoomThreadRow[];
  readonly counts: {
    readonly threads: number;
    readonly pass: number;
    readonly warn: number;
    readonly fail: number;
    readonly openDecisions: number;
  };
};

function allSessionPaths(home: string): Array<{ threadId: string; path: string }> {
  const dir = join(home, "sessions");
  let names: string[];
  try {
    if (!isStrictlyUnder(realpathSync(dir), realpathSync(home))) return [];
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: Array<{ threadId: string; path: string }> = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const threadId = name.slice(0, -".jsonl".length);
    if (!isValidId(threadId)) continue;
    const path = join(dir, name);
    try {
      if (!lstatSync(path).isFile()) continue;
    } catch {
      continue;
    }
    out.push({ threadId, path });
  }
  out.sort((a, b) => (a.threadId < b.threadId ? -1 : a.threadId > b.threadId ? 1 : 0));
  return out;
}

/**
 * M2-A8: read-only room aggregation across all valid session files in `$MADC_HOME/sessions`.
 * Never writes, locks, seeds, or prints payload text.
 */
export function inspectRoom(home: string): RoomReport {
  const files = allSessionPaths(home);
  const threads: RoomThreadRow[] = [];
  let pass = 0;
  let warn = 0;
  let fail = 0;
  let openDecisions = 0;

  for (const { threadId, path } of files) {
    const verified = verifySessionFile(path, threadId, {}, home);
    if (!verified.ok) {
      fail += 1;
      threads.push({
        threadId,
        path,
        seatId: null,
        level: "fail",
        chain: {
          ok: false,
          line: verified.line,
          reason: verified.reason,
          kind: verified.kind,
        },
        handoff: { inbound: null, outboundCount: 0, oneWay: false },
        worktree: { open: null, close: null, missing: false },
        openDecisions: [],
        findings: [
          {
            level: "fail",
            code: "integrity",
            detail: `line ${verified.line}: ${verified.reason}`,
          },
        ],
      });
      continue;
    }

    const events = verified.events;
    const findings = inspectSessionV2(home, events);
    const open = events[0]?.type === "session.open" ? events[0] : undefined;
    const openPayload =
      open !== undefined && open.payload !== null && typeof open.payload === "object"
        ? (open.payload as Record<string, unknown>)
        : null;
    const inbound =
      openPayload !== null && openPayload.handoff !== undefined && openPayload.handoff !== null
        ? (openPayload.handoff as SessionOpenHandoffLink)
        : null;
    const openWorktree =
      openPayload !== null && openPayload.worktree !== undefined && openPayload.worktree !== null
        ? (openPayload.worktree as WorktreeIdentity)
        : null;
    let closeWorktree: WorktreeIdentity | null = null;
    let outboundCount = 0;
    for (const ev of events) {
      if (ev.type === "handoff.out") outboundCount += 1;
      if (
        ev.type === "session.close" &&
        ev.payload !== null &&
        typeof ev.payload === "object" &&
        "worktree" in ev.payload
      ) {
        closeWorktree = (ev.payload as { worktree: WorktreeIdentity | null }).worktree ?? null;
      }
    }

    const decisions = openDecisionsInChain(events);
    openDecisions += decisions.length;

    const hasFail = findings.some((f) => f.level === "fail");
    const hasWarn = findings.some((f) => f.level === "warn");
    const level: RoomThreadRow["level"] = hasFail ? "fail" : hasWarn ? "warn" : "pass";
    if (level === "fail") fail += 1;
    else if (level === "warn") warn += 1;
    else pass += 1;

    threads.push({
      threadId,
      path,
      seatId: open?.seatId ?? null,
      level,
      chain: { ok: true },
      handoff: {
        inbound,
        outboundCount,
        oneWay: findings.some(
          (f) => f.code === "handoff-mismatch" || f.code === "handoff-unverifiable",
        ),
      },
      worktree: {
        open: openWorktree,
        close: closeWorktree,
        missing: findings.some((f) => f.code === "worktree-head-unreadable"),
      },
      openDecisions: decisions,
      findings,
    });
  }

  return {
    home,
    threads,
    counts: {
      threads: threads.length,
      pass,
      warn,
      fail,
      openDecisions,
    },
  };
}
