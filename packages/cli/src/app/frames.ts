/**
 * Frame renderers for the Witness layout (DESIGN-SPEC rev 6.2 §5.1–§5.8): pure functions from
 * state + width + style to styled lines. No I/O, no clock — `now` values are passed in — which
 * is what keeps the layout tests deterministic at any captured terminal dimension.
 *
 * Chrome wraps pinned strings and never edits their text (§2): engine-supplied values arrive
 * already sanitised (E11) and pinned separators (· ─ → …) pass through verbatim in every mode.
 */
import { wordmark } from "./art.ts";
import type { ServedModel } from "./receipt.ts";
import type { ChainVerify, TurnRecord } from "./state.ts";
import type { Style } from "./style.ts";
import {
  type Glyphs,
  glyphsFor,
  middleEllipsize,
  padVisible,
  truncateChrome,
  visibleWidth,
  wordWrap,
} from "./style.ts";

/** One launch-doctor row, kept verbatim (id + status + sanitised summary). */
export type DoctorRow = {
  readonly id: string;
  readonly status: "pass" | "warn" | "fail" | "skip" | "init";
  readonly summary: string;
};

/** What the launch doctor reported, for the banner and the evidence pane (§5.1, §5.7). */
export type DoctorSummary = {
  readonly running: boolean;
  readonly pass: number;
  readonly warn: number;
  readonly fail: number;
  readonly skip: number;
  readonly ms: number | null;
  /** Full WARN/FAIL rows in their pinned wording (printed under the banner, §5.1). */
  readonly warnRows: readonly string[];
  /** Every launch row in arrival order (the evidence pane's DOCTOR AT LAUNCH section, §5.7). */
  readonly allRows: readonly DoctorRow[];
  /** True when a launch row ended FAIL (banner stays expanded, input disabled until Enter). */
  readonly failAtLaunch: boolean;
};

/**
 * Derive the whole summary from the retained rows (§5.1/§5.7): counts, the WARN/FAIL banner
 * detail and the FAIL flag all come from the one complete row list — nothing is dropped on
 * the way in, so the evidence pane can show every row and the banner every WARN/FAIL.
 */
export function summarizeDoctor(
  rows: readonly DoctorRow[],
  running: boolean,
  ms: number | null,
): DoctorSummary {
  const detail = rows.filter((r) => r.status === "warn" || r.status === "fail");
  return {
    running,
    pass: rows.filter((r) => r.status === "pass").length,
    warn: rows.filter((r) => r.status === "warn").length,
    fail: rows.filter((r) => r.status === "fail").length,
    skip: rows.filter((r) => r.status === "skip").length,
    ms,
    warnRows: detail.map((r) => `${r.id}: ${r.summary}`),
    allRows: rows,
    failAtLaunch: rows.some((r) => r.status === "fail"),
  };
}

export type RegistrySummary = {
  readonly entries: number;
  readonly wired: readonly string[];
  readonly direct: number;
  readonly vendor: number;
  readonly interactive: number;
  readonly forbidden: number;
};

export type BannerData = {
  readonly version: string;
  readonly protocol: string;
  readonly seatId: string;
  readonly seatSha: string | null;
  readonly backing: string;
  readonly backingLane: string | null;
  readonly requested: string | null;
  readonly served: ServedModel | null;
  readonly home: string;
  readonly homeSource: "env" | "default";
  /** The user's home directory, for the `~/code/madc` cwd form (§5.1) — not MADC_HOME. */
  readonly userHome: string;
  readonly cwd: string;
  readonly threadId: string | null;
  readonly doctor: DoctorSummary;
  readonly registry: RegistrySummary | null;
  readonly uiNote: string | null;
  /** Tool names from the seat (`tools.allow`). Empty when the seat has no allow list. */
  readonly tools?: readonly string[];
  /** Skill names from the seat. The seat schema has no skills field, so this stays empty. */
  readonly skills?: readonly string[];
};
