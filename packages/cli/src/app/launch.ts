/**
 * App launch (DESIGN-SPEC rev 6.2 §5.0–§5.1): the TTY gates have already passed in `main.ts`;
 * this builds the pre-conversation banner data (§5.1) from pinned sources — the launch doctor
 * (streamed, read-only), the seat file's sha/backing/requested model, the registry catalog —
 * then runs the tier-W app or the tier-A line mode. Only `MADC_UI=lines` is recognized
 * (§5.0 IQW-12): any other value counts as unset and is noted in the evidence pane. The
 * append-only inline mode (§5.10, mock-up 12) was the M-1-denial contingency and stays in
 * `inline.ts` as fixture coverage only — it is no longer selectable from the environment.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { listCatalog, PROTOCOL_VERSION } from "@madc/engine/client";
import type { Check } from "../doctor.ts";
import { collectDoctor, confinedDirId, confinedSeatSha, sameDirId } from "../doctor.ts";
import type { CliIO } from "../io.ts";
import { type AppTty, WitnessApp } from "./app.ts";
import {
  type BannerData,
  type DoctorRow,
  type DoctorSummary,
  type RegistrySummary,
  summarizeDoctor,
} from "./frames.ts";
import { runLineModeApp } from "./line-mode.ts";
import { stripControls } from "./sanitize.ts";
import { decideAppTier } from "./tiers.ts";
import type { VerifyOutcome, VerifyRequest } from "./verify.ts";

export type LaunchOptions = {
  readonly io: CliIO;
  readonly home: string;
  readonly turnIdleMs: number;
  readonly firstPrompt: string | null;
  readonly tty?: AppTty;
  /** Called with the live app so the production entry can wire process signals to it. */
  readonly onApp?: (app: WitnessApp) => void;
  readonly onSighup?: (() => void) | undefined;
  /** §5.8.1 O-2: a signal inside the final-verify window; the entry re-raises it. */
  readonly onFinalVerifySignal?: ((signal: "SIGINT" | "SIGTERM" | "SIGHUP") => void) | undefined;
  /**
   * Round 7 (§5.13/O-4): receives the SELECTED mode's signal handlers (Level A exposes
   * them; tier W arrives through `onApp`), so the production entry's process listeners
   * forward SIGINT/SIGTERM/SIGHUP to whichever mode actually runs.
   */
  readonly exposeSignals?:
    | ((h: { onSigint(): void; onSigterm(): void; onSighup(): void }) => void)
    | undefined;
  readonly verify?: (req: VerifyRequest) => Promise<VerifyOutcome>;
};

const SEAT = "madc-default";

/**
 * §5.0 IQW-12: only `MADC_UI=lines` is recognized. Unset, empty and every other value count
 * as unset (no exit, no stderr line); an unrecognised value is noted in the evidence pane —
 * the fixed wording names the one recognized mode and never echoes the value (CLI:107).
 */
export function uiNoteFor(env: { readonly MADC_UI?: string }): string | null {
  const ui = env.MADC_UI;
  return ui !== undefined && ui !== "" && ui !== "lines"
    ? 'MADC_UI: not recognised (only "lines")'
    : null;
}

/** Read-only read of the seat file's `preferredBacking` / `pinnedModel` for the banner fields.
 * PR #35 round 7 (Copilot r4136803718/r4136803764 + round 8): the read uses the repository's
 * safe, confined, non-blocking pattern (`sha256OrNull`'s discipline, doctor.ts:85): O_NOFOLLOW
 * where available, lstat→open→fstat inode identity where not, O_NONBLOCK so a planted FIFO
 * cannot block the launch, and an fstat regular-file gate. The PARENT `seats/` directory is
 * confined too (the `confinedDirId` before/after identity discipline from doctor.ts): a
 * symlinked `seats/` parent is rejected even when the leaf itself is clean. The returned
 * display values are E11-sanitised (a tampered seat can never inject ANSI/control bytes into
 * the banner).
 */
export function seatFields(
  home: string,
  seatId: string,
): { backing: string | null; requested: string | null } {
  // Parent confinement first: `seats/` must be a real directory resolving under the real
  // home — a symlinked parent (even to an innocent-looking tree) fails closed.
  const parentBefore = confinedDirId(home, "seats");
  if (parentBefore === null) return { backing: null, requested: null };
  const path = join(home, "seats", `${seatId}.json`);
  let fd: number | undefined;
  try {
    const nofollow = constants.O_NOFOLLOW;
    // Without O_NOFOLLOW (Windows): lstat → open → fstat, and the opened inode must be the
    // one lstat saw, so a symlink is never followed.
    const pre = nofollow === undefined ? lstatSync(path) : null;
    if (pre !== null && !pre.isFile()) return { backing: null, requested: null };
    fd = openSync(path, constants.O_RDONLY | (nofollow ?? 0) | (constants.O_NONBLOCK ?? 0));
    const st = fstatSync(fd);
    if (!st.isFile()) return { backing: null, requested: null };
    if (pre !== null && (pre.ino !== st.ino || pre.dev !== st.dev)) {
      return { backing: null, requested: null };
    }
    // Re-derive the parent identity AFTER the open: the same real directory, unchanged
    // while the leaf was being opened (no swapped parent under the race window).
    if (!sameDirId(parentBefore, confinedDirId(home, "seats"))) {
      return { backing: null, requested: null };
    }
    const raw = JSON.parse(readFileSync(fd, "utf8")) as {
      preferredBacking?: unknown;
      pinnedModel?: unknown;
    };
    const clean = (v: unknown): string | null =>
      typeof v === "string" && v !== "" ? stripControls(v) : null;
    return { backing: clean(raw.preferredBacking), requested: clean(raw.pinnedModel) };
  } catch {
    return { backing: null, requested: null };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function buildRegistrySummary(): RegistrySummary | null {
  try {
    const entries = listCatalog();
    return {
      entries: entries.length,
      wired: entries.filter((e) => e.wired).map((e) => e.id),
      direct: entries.filter((e) => e.status === "allowed-direct").length,
      vendor: entries.filter((e) => e.status === "allowed-via-vendor-agent").length,
      interactive: entries.filter((e) => e.status === "interactive-only").length,
      forbidden: entries.filter((e) => e.status === "forbidden").length,
    };
  } catch {
    return null;
  }
}

/** Collect the launch doctor once, read-only, and split the rows for the banner and line mode. */
async function launchDoctor(io: CliIO): Promise<{ rows: Check[]; ms: number }> {
  const rows: Check[] = [];
  const run = await collectDoctor(
    { ...io, stdout: { write: () => undefined } },
    { json: false, init: false },
    {
      onRow: (c) => {
        rows.push(c);
      },
    },
  );
  return { rows, ms: run.ms };
}

const warnRowsOf = (rows: readonly Check[]): Check[] =>
  rows.filter((c) => c.status === "warn" || c.status === "fail");

const doctorRowOf = (c: Check): DoctorRow => ({
  id: c.id,
  status: c.status,
  summary: stripControls(c.summary),
});

const doctorSummary = (
  rows: readonly Check[],
  running: boolean,
  ms: number | null,
): DoctorSummary => summarizeDoctor(rows.map(doctorRowOf), running, ms);

function bannerData(
  io: CliIO,
  home: string,
  rows: readonly Check[],
  ms: number | null,
  uiNote: string | null,
): BannerData {
  const seat = seatFields(home, SEAT);
  const lane =
    seat.backing !== null
      ? (buildRegistrySummary()?.wired.includes(seat.backing) ?? false)
        ? (listCatalog().find((e) => e.id === seat.backing)?.status ?? null)
        : null
      : null;
  return {
    version: "0.0.0",
    protocol: PROTOCOL_VERSION,
    seatId: SEAT,
    seatSha: confinedSeatSha(home, `${SEAT}.json`)?.slice(0, 12) ?? null,
    backing: seat.backing ?? "kimi-code",
    backingLane: lane,
    requested: seat.requested,
    served: null,
    home,
    homeSource: io.env.MADC_HOME !== undefined && io.env.MADC_HOME !== "" ? "env" : "default",
    userHome: homedir(),
    cwd: io.cwd,
    threadId: null,
    doctor: doctorSummary(rows, ms === null, ms),
    registry: buildRegistrySummary(),
    uiNote,
  };
}

export async function runWitnessApp(opts: LaunchOptions): Promise<number> {
  const io = opts.io;
  // §3.4 production tier selection: the app's own gate decides W vs A from the REAL terminal
  // dimensions and env, not just MADC_UI — a limited terminal (below 80×24, TERM unset, TERM
  // exactly dumb, MADC_UI=lines, win32 without VT) receives Level A even when a tty is wired.
  const tier = decideAppTier({
    stdinIsTTY: io.stdinIsTTY === true,
    stdoutIsTTY: io.stdoutIsTTY,
    stderrIsTTY: io.stderrIsTTY,
    columns: io.columns,
    rows: io.rows,
    env: io.env,
    platform: process.platform,
  });
  if (opts.tty === undefined || tier.tier !== "W") {
    // Tier A / not a full TTY: the doctor runs to completion before the loop (line mode has no
    // live banner); only its WARN/FAIL rows surface (§6.3).
    const { rows } = await launchDoctor(io);
    const why = tier.lineModeWhy ?? "not a full TTY";
    // Round 7 (§5.13/O-4 through the production entry): the selected mode's signal
    // handlers are forwarded to the entry's process listeners so Level A gets the same
    // signal behaviour as tier W — the entry decides re-raise semantics.
    return runLineModeApp({
      io,
      home: opts.home,
      turnIdleMs: opts.turnIdleMs,
      firstPrompt: opts.firstPrompt,
      why,
      launchWarnRows: warnRowsOf(rows),
      exposeSignals: opts.exposeSignals ?? undefined,
      ...(opts.onSighup !== undefined ? { onSighup: opts.onSighup } : {}),
      ...(opts.verify !== undefined ? { verify: opts.verify } : {}),
    });
  }

  // Tier W: the full Witness app; the banner paints first and the launch doctor streams in (§5.1).
  const tty = opts.tty;
  const rows: Check[] = [];
  let doctorMs: number | null = null;
  const banner = bannerData(io, opts.home, rows, doctorMs, uiNoteFor(io.env));
  return await new Promise<number>((resolve) => {
    const app = new WitnessApp(tty, {
      io,
      home: opts.home,
      turnIdleMs: opts.turnIdleMs,
      firstPrompt: opts.firstPrompt,
      banner,
      ...(opts.verify !== undefined ? { verify: opts.verify } : {}),
      ...(opts.onSighup !== undefined ? { onSighup: opts.onSighup } : {}),
      ...(opts.onFinalVerifySignal !== undefined
        ? { onFinalVerifySignal: opts.onFinalVerifySignal }
        : {}),
      onExit: (code) => resolve(code),
    });
    opts.onApp?.(app);
    // Wire the terminal to the app: decoded keys and resizes drive the state machine.
    tty.onKey((k) => app.onKey(k));
    tty.onResize(() => app.onResize());
    void app.start().then(() => {
      void collectDoctor(
        { ...io, stdout: { write: () => undefined } },
        { json: false, init: false },
        {
          onRow: (c) => {
            if (c.status === "warn" || c.status === "fail") rows.push(c);
            app.onDoctorRow(c);
          },
        },
      ).then((run) => {
        doctorMs = run.ms;
        app.onDoctorFinished(run.ms);
        if (opts.firstPrompt !== null) {
          void app.onFirstPrompt();
        }
      });
    });
  });
}
