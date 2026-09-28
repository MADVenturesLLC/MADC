/**
 * The Full WITNESS app (DESIGN-SPEC rev 6.2 §5): bare `madc` on a capable TTY. Alternate screen
 * + raw input (§5.0), per-turn rail with the dotted→solid→break semantics (§5.3), tool cards,
 * status pills, Tab evidence pane, /commands, earned verdicts, and the ruled exit ladder
 * (§5.11) with the required exit receipt (§5.12) and signal exit line (§5.13).
 *
 * The class takes its terminal, clock, verify runner and engine spawn as dependencies, so tests
 * drive it in-process with a virtual TTY and fixture engines — no sleeps, no real TTY.
 */

import { MADC_VERSION } from "@madc/core";
import {
  type EngineClient,
  EngineExitedError,
  EngineProtocolError,
  EngineRpcError,
  type Item,
  PROTOCOL_VERSION,
  spawnEngine,
  type WireMessage,
} from "@madc/engine/client";
import type { Check } from "../doctor.ts";
import { EXIT } from "../exit-codes.ts";
import type { CliIO } from "../io.ts";
import { buildReceiptData } from "./app-receipt.ts";
import { overlayWidth, renderOverlay } from "./doctor-view.ts";
import {
  type AppStateView,
  type BannerData,
  type DoctorSummary,
  renderBanner,
  renderHeader,
  renderHelp,
  renderHints,
  renderPills,
  renderTurn,
} from "./frames.ts";
import { receiptPlain } from "./receipt.ts";
import { sanitizeItem, sanitizeText, stripControls } from "./sanitize.ts";
import { type ChainVerify, railOf, type SessionCode, type TurnRecord, worstExit } from "./state.ts";
import { type Glyphs, glyphsFor, padVisible, Style, truncateChrome } from "./style.ts";
import { asciiForced, colorDepth } from "./tiers.ts";
import { renderSessionStartFailedCard, renderVerdictCard, type Verdict } from "./verdict.ts";
import {
  runVerifyBounded,
  VERIFY_DEADLINE_MS,
  type VerifyOutcome,
  type VerifyRequest,
} from "./verify.ts";
import {
  classifyMessage,
  classifyThreadStartFailure,
  isDomainId,
  isItemShape,
  isThreadShape,
  isTurnShape,
  violationMessage,
} from "./wire.ts";

export { buildReceiptData } from "./app-receipt.ts";

const INTERRUPT_GRACE_MS = 2_000;
const KILL_AFTER_MS = 1_000;
const CLOSE_TIMEOUT_MS = 5_000;
export const DEFAULT_TURN_IDLE_MS = 600_000;
/** §5.1: the banner collapses at launch below 30 rows (IQW-6 keeps the rest of the rule). */
const BANNER_MIN_ROWS = 30;

/** Decoded key names from the raw-mode reader. */
export type KeyValue =
  | "enter"
  | "tab"
  | "esc"
  | "backspace"
  | "ctrl-b"
  | "ctrl-c"
  | "ctrl-d"
  | { readonly char: string };

/** Decode a raw stdin chunk into keys (§5.8). CSI sequences are swallowed; a lone ESC is Esc. */
export function decodeKeys(data: string): KeyValue[] {
  const keys: KeyValue[] = [];
  let i = 0;
  while (i < data.length) {
    const ch = data[i] ?? "";
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x1b) {
      if (data[i + 1] === "[") {
        // CSI sequence: swallow up to the final byte (0x40–0x7e); not an Esc press.
        i += 2;
        while (i < data.length) {
          const c = data.charCodeAt(i);
          i++;
          if (c >= 0x40 && c <= 0x7e) break;
        }
        continue;
      }
      keys.push("esc");
      i++;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      keys.push("enter");
      i++;
      continue;
    }
    if (ch === "\t") {
      keys.push("tab");
      i++;
      continue;
    }
    if (code === 0x7f || code === 0x08) {
      keys.push("backspace");
      i++;
      continue;
    }
    if (code === 0x02) {
      keys.push("ctrl-b");
      i++;
      continue;
    }
    if (code === 0x03) {
      keys.push("ctrl-c");
      i++;
      continue;
    }
    if (code === 0x04) {
      keys.push("ctrl-d");
      i++;
      continue;
    }
    if (code < 0x20) {
      i++; // other control bytes: ignored chrome input
      continue;
    }
    // UTF-8: read the full code point.
    const cp = data.codePointAt(i) ?? code;
    const str = String.fromCodePoint(cp);
    keys.push({ char: str });
    i += str.length;
  }
  return keys;
}

/** Terminal abstraction so tests run the app without a real TTY. */
export type AppTty = {
  write(s: string): void;
  columns(): number;
  rows(): number;
  setRawMode(on: boolean): void;
  onKey(cb: (key: KeyValue) => void): void;
  onResize(cb: () => void): void;
};

export type AppOptions = {
  readonly io: CliIO;
  readonly home: string;
  readonly turnIdleMs: number;
  readonly firstPrompt: string | null;
  readonly banner: BannerData;
  /** Test seams. */
  readonly now?: () => number;
  readonly verify?: (req: VerifyRequest) => Promise<VerifyOutcome>;
  readonly onExit?: (code: number) => void;
  readonly onSighup?: () => void;
  /**
   * §5.8.1 O-2: called when a signal lands inside the final-verify window; the production entry
   * removes that signal's listener and re-raises, so the OS reports death by the signal.
   */
  readonly onFinalVerifySignal?: ((signal: "SIGINT" | "SIGTERM" | "SIGHUP") => void) | undefined;
};

type QuitPlan = {
  readonly kind: "quit" | "interrupt" | "sighup";
  readonly signal: "SIGINT" | "SIGTERM" | "SIGHUP" | null;
};

export class WitnessApp {
  readonly #tty: AppTty;
  readonly #io: CliIO;
  readonly #style: Style;
  #g: Glyphs;
  /** 5 Hz repaint tick (§5.5); cleared with the screen. */
  #tick: ReturnType<typeof setInterval> | null = null;
  readonly #home: string;
  readonly #turnIdleMs: number;
  readonly #now: () => number;
  readonly #verify: (req: VerifyRequest) => Promise<VerifyOutcome>;
  readonly #onExit: (code: number) => void;
  readonly #onSighup: () => void;
  readonly #onFinalVerifySignal: ((signal: "SIGINT" | "SIGTERM" | "SIGHUP") => void) | null;
  readonly #startedAt: number;
  readonly #banner: BannerData;

  phase: AppStateView["phase"] = "launching";
  bannerExpanded = true;
  evidenceOpen = false;
  doctorOverlayOpen = false;
  doctorOverlayRows: string[] = [];
  input = "";
  turns: TurnRecord[] = [];
  sessionCodes: SessionCode[] = [];
  threadId: string | null = null;
  threadStatus: string | null = null;
  served: import("./receipt.ts").ServedModel | null = null;
  sessionPath: string | null = null;
  lastVerify: ChainVerify | null = null;
  lastEndNamesTurn = false;
  stderrRows: string[] = [];
  uiNote: string | null = null;
  doctor: DoctorSummary;
  #client: EngineClient | null = null;
  #currentTurn: TurnRecord | null = null;
  #quit: QuitPlan | null = null;
  #interruptPending = false;
  #firstPromptSent = false;
  #firstPrompt: string | null;
  #doctorRunning = true;
  #streamSeconds: number | null = null;
  #signalDuringFinalVerify = false;
  /** True while the §5.8.1 final verify (or the exit write) runs — the O-2 window. */
  #finalVerifyInFlight = false;

  constructor(tty: AppTty, opts: AppOptions) {
    this.#tty = tty;
    this.#io = opts.io;
    this.#home = opts.home;
    this.#turnIdleMs = opts.turnIdleMs;
    this.#now = opts.now ?? Date.now;
    this.#verify =
      opts.verify ?? ((req) => runVerifyBounded({ ...req, deadlineMs: VERIFY_DEADLINE_MS }));
    this.#onExit = opts.onExit ?? (() => {});
    this.#onSighup = opts.onSighup ?? (() => {});
    this.#onFinalVerifySignal = opts.onFinalVerifySignal ?? null;
    this.#startedAt = this.#now();
    this.#banner = opts.banner;
    this.#firstPrompt = opts.firstPrompt;
    // §3.3: NO_COLOR (any value) or TERM=dumb → zero SGR; otherwise the colour rules.
    this.#style = Style.forDepth(
      opts.io.env.NO_COLOR !== undefined || opts.io.env.TERM === "dumb"
        ? "none"
        : colorDepth(opts.io.env),
      asciiForced(opts.io.env),
    );
    this.#g = glyphsFor(this.#style.ascii);
    this.doctor = opts.banner.doctor;
  }

  // ------------------------------------------------------------------ frame painting
  #frame(): string[] {
    const width = this.#tty.columns();
    const rows = Math.max(this.#tty.rows(), 10);
    if (width < 80 || rows < 24) {
      const msg = `terminal too small · need 80×24 · now ${width}×${rows}`;
      const pad = Math.max(0, Math.floor((width - msg.length) / 2));
      return ["", " ".repeat(pad) + msg, ""];
    }
    const lines: string[] = [];
    // The docked pane (>=110) takes a 38-column right column; the banner, header and
    // transcript render at the width they actually occupy so cards/wraps align to the rail,
    // not the full screen — and the banner is never drawn wider than its region and clipped
    // afterwards (§5.7), because a clip cannot repair a box composed too wide.
    const paneDocked = this.evidenceOpen && width >= 110;
    const transcriptWidth = paneDocked ? width - 38 : width;
    if (this.bannerExpanded) {
      lines.push(...renderBanner(this.#bannerView(), transcriptWidth, this.#style, this.#g));
    } else {
      lines.push(
        renderHeader(
          {
            seatId: this.#banner.seatId,
            backing: this.#banner.backing,
            protocol: this.#banner.protocol,
            cwd: this.#banner.cwd,
            userHome: this.#banner.userHome,
            threadId: this.threadId,
          },
          transcriptWidth,
          this.#style,
        ),
      );
    }
    if (this.doctor.failAtLaunch && this.phase === "launching") {
      lines.push(
        this.#style.role(
          "err",
          "a launch doctor row FAILED: press Enter to acknowledge and enable input",
        ),
      );
    }
    for (const turn of this.turns) {
      const number = this.turns.indexOf(turn) + 1;
      lines.push(
        ...renderTurn(
          turn,
          {
            seatId: this.#banner.seatId,
            requestedModel: this.#banner.requested,
            userText: this.#userTextOf(turn),
            nowMs: this.#now(),
            turnNumber: number,
          },
          transcriptWidth,
          this.#style,
          this.#g,
        ),
      );
      const verdict = this.#earnedVerdict(turn);
      if (verdict !== null) {
        lines.push(
          ...renderVerdictCard(
            verdict,
            buildReceiptData({
              turn,
              served: this.#servedOf(turn),
              session: this.#sessionOf(turn),
              error: this.#errorOf(turn),
              exit: turn.exitCode,
            }),
            width,
            this.#style,
            this.#g,
          ),
        );
      }
    }
    if (this.phase === "session-start-failed" && this.sessionCodes.length > 0) {
      const sc = this.sessionCodes[this.sessionCodes.length - 1];
      if (sc !== undefined) {
        lines.push(...renderSessionStartFailedCard(-32009, sc.reason, width, this.#style, this.#g));
      }
    }
    if (this.phase === "engine-stopped" && this.turns.length > 0) {
      // §7 engine row: engine gone / violation / idle timeout → the EXIT 3 card, always as big
      // as COMPLETED (failure is never quieter than success).
      const last = this.turns[this.turns.length - 1];
      if (last !== undefined) {
        const worst = this.#worstCode(null);
        lines.push(
          ...renderVerdictCard(
            worst === EXIT.engine ? { kind: "exit", code: worst } : { kind: "failed" },
            buildReceiptData({
              turn: last,
              served: this.#servedOf(last),
              session: this.#sessionOf(last),
              error: this.#errorOf(last),
              exit: last.exitCode,
            }),
            width,
            this.#style,
            this.#g,
          ),
        );
      }
    }
    lines.push(renderPills(this.#view(), this.#style, this.#g));
    if (this.uiNote !== null) {
      lines.push(this.#style.role("warn", this.uiNote));
    }
    if (this.#now() < this.#helpUntil) {
      lines.push(...this.#helpLines);
    }
    if (this.phase === "chain-failed" || this.phase === "torn-tail") {
      lines.push(
        this.#style.role(
          "warn",
          `${this.#g.cross} this thread's chain failed verify: input disabled · /doctor · /new`,
        ),
      );
    }
    const prompt =
      this.phase === "turn" || this.phase === "verifying"
        ? `${this.#style.role("accent", this.#g.prompt)} turn in progress: typing kept; Enter and /commands wait for turn + verify`
        : `${this.#style.role("accent", this.#g.prompt)} ${this.input}${this.#style.role("accent", "▊")}`;
    lines.push(prompt);
    lines.push(renderHints(this.#view(), this.evidenceOpen, this.#style, this.#g));
    const merged = this.#mergeEvidence(lines, width);
    if (this.doctorOverlayOpen) {
      return [
        ...merged.slice(0, Math.max(0, merged.length - 3)),
        ...renderOverlay(
          "/doctor",
          this.doctorOverlayRows,
          overlayWidth(width),
          this.#style,
          this.#g,
          "Esc close · r re-run",
        ),
        ...merged.slice(Math.max(0, merged.length - 3)),
      ];
    }
    return merged;
  }

  #mergeEvidence(left: string[], width: number): string[] {
    if (!this.evidenceOpen || width < 110) {
      // §5.7: at 80-109 columns the pane opens as an overlay over the transcript (the state
      // under it is kept; Esc restores the full frame).
      if (this.evidenceOpen && width >= 80) {
        const overlay = renderOverlay(
          "evidence",
          this.#evidenceLines(),
          overlayWidth(width),
          this.#style,
          this.#g,
          "Tab hide",
        );
        const top = Math.max(0, Math.floor((left.length - overlay.length) / 2) - 2);
        return [...left.slice(0, top), ...overlay, ...left.slice(top + overlay.length)];
      }
      return left;
    }
    // Montage style: a bordered evidence column (rounded top/bottom, EVIDENCE title with the
    // Tab hide hint) docked on the right at >=110 — the same box shape as the /doctor overlay.
    const pane = renderOverlay(
      "EVIDENCE",
      this.#evidenceLines(),
      36,
      this.#style,
      this.#g,
      "Tab hide",
    );
    const out: string[] = [];
    const height = Math.max(left.length, pane.length);
    for (let i = 0; i < height; i++) {
      const l = left[i] ?? "";
      const r = pane[i] ?? "";
      const col = width - 38;
      const trimmed = truncateChrome(l, col);
      const padded = padVisible(trimmed, col);
      out.push(`${padded}${r}`);
    }
    return out;
  }

  #evidenceLines(): string[] {
    const s = this.#style;
    const dim = (label: string, value: string): string =>
      `${s.role("dim", label.padEnd(10))} ${value}`;
    const rows: string[] = [
      `${s.role("accent", "EVIDENCE")}  ${s.keycap("Tab")} hide`,
      "",
      s.role("accent", "SEAT"),
      dim("seat", this.#banner.seatId),
      dim("sha256", this.#banner.seatSha ?? "—"),
      dim("backing", this.#banner.backing),
      dim("requested", this.#banner.requested ?? "—"),
      dim(
        "served",
        this.served === null
          ? s.role("warn", "▲ NO RECEIPT yet")
          : s.role("accent2", this.served.servedModel),
      ),
      "",
      s.role("accent", "THREAD"),
      dim("thread", this.threadId === null ? "—" : this.threadId),
      dim("status", this.threadStatus ?? "—"),
      dim("file", this.sessionPath ?? "—"),
      "",
      s.role("accent", "CHAIN"),
      dim(
        "last",
        this.lastVerify === null
          ? s.role("dim", "nothing yet")
          : this.lastVerify.kind === "verified"
            ? s.role("ok", `✓ VERIFIED seq ${this.lastVerify.seq}`)
            : this.lastVerify.kind === "failed"
              ? s.role("err", `✕ FAILED line ${this.lastVerify.line}`)
              : s.role("warn", "▲ in progress"),
      ),
      dim(
        "head",
        this.lastVerify?.kind === "verified" ? this.lastVerify.headHash.slice(0, 12) : "—",
      ),
      dim(
        "turns",
        this.turns
          .map(
            (t, i) =>
              `${i + 1}:${railOf(t) === "solid" ? "solid" : railOf(t) === "break" ? "break" : "dotted"}`,
          )
          .join(" ") || "—",
      ),
      "",
      s.role("accent", "DOCTOR AT LAUNCH"),
      ...this.doctor.rowLines.slice(0, 8),
      "",
      ...(this.uiNote === null ? [] : [s.role("warn", this.uiNote)]),
      ...this.stderrRows.slice(-4).map((r) => s.role("faint", `engine stderr: ${r}`)),
    ];
    return rows;
  }

  paint(): void {
    const frame = this.#frame();
    const height = Math.max(this.#tty.rows(), 10);
    // Bottom-anchored viewport: a frame taller than the screen keeps its LAST `height` lines —
    // pills, prompt and hints always stay visible — because a frame that scrolls the terminal
    // mid-paint misaligns every row after the scroll and stale cells survive anywhere the new
    // lines are shorter than the old ones.
    const visible = frame.length > height ? frame.slice(frame.length - height) : frame;
    // Erase-to-end-of-row after every line: a shorter line painted over a longer earlier one
    // must not leave the old tail beside it (old elapsed text, prompt/hint rows, box borders).
    // \u001b[J then clears everything below the frame, so the screen can hold no remnants.
    this.#tty.write(`\u001b[H${visible.join("\u001b[K\n")}\u001b[K\u001b[J`);
  }

  #bannerView(): BannerData {
    // The banner's doctor block is the LIVE summary (§5.1: counts move as the launch doctor
    // streams; ms lands on finish), not the frozen construction-time fixture.
    return {
      ...this.#banner,
      doctor: this.doctor,
      threadId: this.threadId,
      uiNote: this.uiNote,
    };
  }

  #userTextOf(turn: TurnRecord): string | null {
    const item = turn.items.find((i) => i.kind === "userMessage");
    if (item !== undefined && item.kind === "userMessage") {
      return item.content.map((c) => c.text).join("");
    }
    return turn.userText ?? null;
  }

  #servedOf(turn: TurnRecord): import("./receipt.ts").ServedModel | null {
    const item = [...turn.items].reverse().find((i) => i.kind === "servedModel");
    return item !== undefined && item.kind === "servedModel"
      ? {
          requestedModel: item.requestedModel,
          servedModel: item.servedModel,
          backing: item.backing,
          providerId: item.providerId,
        }
      : null;
  }

  #sessionOf(turn: TurnRecord): import("./receipt.ts").SessionOut | null {
    if (this.sessionPath === null) return null;
    const v = turn.verify;
    if (v === null) return null;
    if (v.kind === "verified") {
      return { path: this.sessionPath, seq: v.seq, headHash: v.headHash, chain: "verified" };
    }
    if (v.kind === "failed") {
      return {
        path: this.sessionPath,
        seq: null,
        headHash: null,
        chain: "failed",
        line: v.line,
        reason: v.reason,
      };
    }
    return {
      path: this.sessionPath,
      seq: null,
      headHash: null,
      chain: "unverified",
      reason: turn.unverified ?? "verify interrupted",
    };
  }

  /** The engine error this turn recorded, for the receipt's error row. */
  #errorOf(turn: TurnRecord): import("./receipt.ts").ErrorOut | null {
    const item = turn.items.find((i) => i.kind === "error");
    if (item !== undefined && item.kind === "error") {
      return {
        code: item.code ?? null,
        message: item.message,
        class:
          item.code === -32009
            ? "session"
            : item.code !== undefined && (item.code === -32007 || item.code === -32008)
              ? "provider"
              : "turn",
      };
    }
    if (turn.unverified !== null && (turn.status === "unknown" || turn.revoked)) {
      const chainMatch = turn.unverified.match(/^chain FAILED line (\d+): (.*)$/s);
      if (chainMatch !== null) {
        return { code: null, message: turn.unverified, class: "session" };
      }
      return { code: null, message: turn.unverified, class: "engine" };
    }
    return null;
  }

  /** The verdict the turn has EARNED on disk evidence (§7): green only after the verify passed. */
  #earnedVerdict(turn: TurnRecord): Verdict | null {
    if (turn.status === "running") return null;
    if (turn.revoked || turn.verify?.kind === "failed") return { kind: "failed" };
    if (turn.verify?.kind === "verified" && turn.unverified === null) {
      if (turn.status === "completed" && turn.exitCode === 0) return { kind: "completed" };
      if (turn.status === "failed" || turn.status === "interrupted") {
        return turn.exitCode === 0 ? null : { kind: "failed" };
      }
      return null;
    }
    return null;
  }

  #view(): AppStateView {
    return {
      phase: this.phase,
      seatId: this.#banner.seatId,
      threadId: this.threadId,
      threadStatus: this.threadStatus,
      sessionPath: this.sessionPath,
      turns: this.turns,
      served: this.served,
      lastVerify: this.lastVerify,
      streamSeconds: this.#streamSeconds,
      elapsedSeconds: (this.#now() - this.#startedAt) / 1000,
      idleSeconds: this.#streamSeconds === null ? (this.#now() - this.#startedAt) / 1000 : null,
      doctor: this.doctor,
      turnCount: this.turns.length,
      lastEndNamesTurn: this.lastEndNamesTurn,
      exitHint: this.#worstCode(null),
      sessionCode: this.sessionCodes[this.sessionCodes.length - 1] ?? null,
    };
  }

  #worstCode(signal: "SIGINT" | "SIGTERM" | "SIGHUP" | null): number {
    return worstExit({
      turns: this.turns,
      sessionCodes: this.sessionCodes,
      signal,
      finalVerifyFailedAfterSignal: this.#signalDuringFinalVerify,
    }).code;
  }

  // ------------------------------------------------------------------ lifecycle
  async start(): Promise<void> {
    this.#tty.write("\u001b[?1049h\u001b[H\u001b[2J\u001b[?25l");
    this.#tty.setRawMode(true);
    this.bannerExpanded = this.#tty.rows() >= BANNER_MIN_ROWS;
    this.#tick = setInterval(() => {
      if (this.#quit !== null) return;
      const current = this.#currentTurn;
      if (this.phase === "turn" && current !== null) {
        this.#streamSeconds = Math.max(0, (this.#now() - current.startTime) / 1000);
      }
      this.paint();
    }, 200); // 5 Hz ceiling (§5.5: the elapsed updates at <=5 Hz; no spinner, no animation)
    this.#tick.unref?.();
    this.paint();
  }

  /** Launch doctor rows arrive here as they finish (§5.1: WARN/FAIL rows print in full). */
  onDoctorRow(check: Check): void {
    const counts = { ...this.doctor };
    if (check.status === "pass") counts.pass++;
    if (check.status === "warn") {
      counts.warn++;
      counts.warnRows = [...counts.warnRows, `${check.id}: ${check.summary}`];
      counts.rowLines = [...counts.rowLines, `${check.id} ${check.summary}`];
    }
    if (check.status === "fail") {
      counts.fail++;
      counts.failAtLaunch = true;
      counts.rowLines = [...counts.rowLines, `${check.id} ${check.summary}`];
    }
    if (check.status === "skip") counts.skip++;
    this.doctor = counts;
    this.paint();
  }

  onDoctorFinished(ms: number): void {
    this.doctor = { ...this.doctor, running: false, ms };
    this.#doctorRunning = false;
    if (this.doctor.failAtLaunch) {
      this.phase = "launching"; // input disabled until Enter acknowledges (§5.1)
    } else if (this.phase === "launching") {
      this.phase = "idle";
    }
    this.paint();
  }

  // ------------------------------------------------------------------ input
  onKey(key: KeyValue): void {
    if (key === "ctrl-c") {
      this.#onCtrlC();
      return;
    }
    if (key === "ctrl-d") {
      this.#onQuit("quit", null);
      return;
    }
    if (key === "ctrl-b") {
      this.bannerExpanded = !this.bannerExpanded;
      this.paint();
      return;
    }
    if (key === "tab") {
      this.evidenceOpen = !this.evidenceOpen;
      this.paint();
      return;
    }
    if (this.doctorOverlayOpen && typeof key === "object" && "char" in key && key.char === "r") {
      void this.#runDoctorOverlay();
      return;
    }
    if (key === "esc") {
      if (this.doctorOverlayOpen) {
        this.doctorOverlayOpen = false;
        this.paint();
      } else if (this.evidenceOpen) {
        this.evidenceOpen = false;
        this.paint();
      }
      return;
    }
    if (key === "backspace") {
      this.input = this.input.slice(0, -1);
      this.paint();
      return;
    }
    if (key === "enter") {
      this.#onEnter();
      return;
    }
    if (typeof key === "object" && "char" in key) {
      this.input += key.char;
      this.uiNote = null; // any new keypress clears a transient note (chrome, not evidence)
      this.paint();
    }
  }

  /** `madc "<text>"`: the first turn is sent once the launch doctor has finished (§5.1). */
  async onFirstPrompt(): Promise<void> {
    if (this.#firstPromptSent || this.#firstPrompt === null) return;
    this.#firstPromptSent = true;
    await this.#send(this.#firstPrompt);
  }

  async #onEnter(): Promise<void> {
    // §5.1 IQW-6: while the launch doctor runs, Enter does not send.
    if (this.#doctorRunning) return;
    if (this.doctor.failAtLaunch && this.phase === "launching") {
      this.phase = "idle";
      this.doctor = { ...this.doctor, failAtLaunch: false };
      this.paint();
      return;
    }
    if (this.phase === "engine-stopped") {
      await this.#restartEngine();
      return;
    }
    // IQW4-3: during a turn or a verify the input stays editable but Enter and every /word do
    // nothing and print nothing. The text is kept and can be sent once the state is idle.
    if (this.phase === "turn" || this.phase === "verifying") return;
    const text = this.input.trim();
    if (text === "") return; // never sent empty (CLI:35)
    if (Buffer.byteLength(this.input, "utf8") > 1024 * 1024) {
      this.uiNote = "▲ prompt exceeds 1 MiB; not sent";
      this.paint();
      return;
    }
    // §5.8: after chain FAILED or a torn tail the plain send is disabled until /new, but the
    // /commands still act (Q5). In the session-start-failed state only quit keys act (§5.8).
    const sendBlocked = this.phase === "chain-failed" || this.phase === "torn-tail";
    if (this.phase === "session-start-failed") return;
    if (text.startsWith("/") && !text.startsWith("//")) {
      this.#command(text);
      return;
    }
    if (sendBlocked) return;
    if (text.startsWith("//")) {
      this.input = text.slice(1);
      await this.#send(this.input);
      return;
    }
    await this.#send(this.input);
  }

  #command(line: string): void {
    const word = line.split(/\s+/)[0] ?? line;
    this.input = "";
    if (word === "/help") {
      this.#helpLines = renderHelp(this.#style, this.#g);
      this.#helpUntil = this.#now() + 60_000;
      this.paint();
      return;
    }
    if (word === "/doctor") {
      void this.#runDoctorOverlay();
      return;
    }
    if (word === "/receipt") {
      this.#showReceipt();
      return;
    }
    if (word === "/new") {
      void this.#newThread();
      return;
    }
    this.uiNote = `unknown command ${word} · /help`;
    this.paint();
  }

  #helpLines: string[] = [];
  #helpUntil = 0;

  #showReceipt(): void {
    const last = this.turns[this.turns.length - 1];
    if (last === undefined) {
      this.uiNote = "no turn yet · /receipt shows the last turn's pinned rows";
      this.paint();
      return;
    }
    const data = buildReceiptData({
      turn: last,
      served: this.#servedOf(last),
      session: this.#sessionOf(last),
      error: this.#errorOf(last),
      exit: last.exitCode,
    });
    this.#helpLines = receiptPlain(data).split("\n");
    this.#helpUntil = this.#now() + 60_000;
    this.paint();
  }

  async #newThread(): Promise<void> {
    if (this.#client !== null) {
      const c = this.#client;
      this.#client = null;
      await c.close(CLOSE_TIMEOUT_MS).catch(() => null);
    }
    this.turns = [];
    this.threadId = null;
    this.threadStatus = null;
    this.served = null;
    this.sessionPath = null;
    this.lastVerify = null;
    this.lastEndNamesTurn = false;
    this.phase = "idle";
    this.paint();
  }

  async #runDoctorOverlay(): Promise<void> {
    this.doctorOverlayOpen = true;
    this.doctorOverlayRows = [
      this.#style.role("dim", "read-only · rows stream as each check finishes"),
    ];
    this.paint();
    const { collectDoctor } = await import("../doctor.ts");
    const rows: string[] = [];
    await collectDoctor(
      this.#io,
      { json: false, init: false },
      {
        onRow: (c) => {
          rows.push(`${c.status.toUpperCase().padEnd(4)} ${c.id.padEnd(14)} ${c.summary}`);
          this.doctorOverlayRows = rows;
          this.paint();
        },
      },
    );
    this.paint();
  }

  async #restartEngine(): Promise<void> {
    // §5.8 "engine stopped": Enter restarts the engine with a new thread — the DEAD client is
    // closed and dropped so the next send spawns a fresh engine (a stale client would reject
    // every request with EngineExitedError).
    const dead = this.#client;
    this.#client = null;
    if (dead !== null) await dead.close(KILL_AFTER_MS).catch(() => null);
    this.#currentTurn = null;
    this.turns = [];
    this.threadId = null;
    this.sessionPath = null;
    this.lastVerify = null;
    this.phase = "idle";
    this.paint();
  }

  // ------------------------------------------------------------------ engine + turns
  async #send(prompt: string): Promise<void> {
    this.input = "";
    if (this.#client === null) {
      this.#client = spawnEngine({
        env: { MADC_HOME: this.#home },
        stderr: "pipe",
        ...(this.#io.engineEntry !== undefined ? { entry: this.#io.engineEntry } : {}),
      });
      const c = this.#client;
      c.onStderrLine = (line) => {
        this.stderrRows = [...this.stderrRows.slice(-19), stripControls(line)];
        this.paint();
      };
      c.exited.then((code) => {
        if (this.#client === c && this.#currentTurn?.status === "running" && this.#quit === null) {
          this.#engineGone(`engine exited (code ${String(code)})`);
        }
      });
      c.exited.catch(() => undefined);
      try {
        const init = await c.request("initialize", {
          clientInfo: { name: "madc", version: MADC_VERSION },
        });
        if (
          init === null ||
          typeof init !== "object" ||
          (init as Record<string, unknown>).protocolVersion !== PROTOCOL_VERSION
        ) {
          throw new EngineProtocolError(
            "protocol violation: initialize returned an invalid result",
          );
        }
        c.notify("initialized", {});
      } catch (err) {
        this.#engineGone(this.#errorMessage(err));
        return;
      }
    }
    const client = this.#client;
    if (client === null) return;
    try {
      if (this.threadId === null) {
        const started = (await client.request("thread/start", {
          cwd: this.#io.cwd,
        })) as { thread?: unknown } | undefined;
        if (!isThreadShape(started?.thread, this.#banner.seatId)) {
          throw new EngineProtocolError(
            "protocol violation: thread/start returned an invalid thread",
          );
        }
        this.threadId = sanitizeText(started.thread.id);
        this.threadStatus = sanitizeText(started.thread.status);
        this.sessionPath = `${this.#home}/sessions/${this.threadId}.jsonl`;
      }
    } catch (err) {
      this.#sessionStartFailed(err);
      return;
    }
    const threadId = this.threadId;
    if (threadId === null) return;
    const turn: TurnRecord = {
      turnId: `pending-${this.turns.length}`,
      status: "running",
      exitCode: 0,
      inAppInterrupted: false,
      seqStart: null,
      seqEnd: null,
      verify: null,
      unverified: null,
      revoked: false,
      startTime: this.#now(),
      endTime: null,
      userText: sanitizeText(prompt),
      items: [],
    };
    this.#currentTurn = turn;
    this.turns = [...this.turns, turn];
    this.phase = "turn";
    this.#streamSeconds = 0;
    // §5.1 collapse rule: the banner collapses to the header on the first turn/start (sent).
    if (this.turns.length === 1) this.bannerExpanded = false;
    this.paint();
    const outcome = await this.#runTurn(client, threadId, turn, prompt);
    if (this.#quit !== null) return; // quit flow owns the rest
    turn.endTime = this.#now();
    if (outcome === "completed" || outcome === "failed" || outcome === "interrupted") {
      turn.status = outcome;
      turn.exitCode =
        outcome === "completed"
          ? 0
          : outcome === "interrupted"
            ? 0 // in-app interrupt, answered + verified: 0 for this turn (§17.1 O-5)
            : (turn.items.find((i) => i.kind === "error") as { code?: number } | undefined)
                  ?.code === undefined
              ? EXIT.failure
              : this.#classifyItemErrorCode(turn);
      if (outcome === "interrupted") turn.inAppInterrupted = true;
    } else {
      // timeout / violation / engine exit paths recorded their own class already
    }
    // R-a: read-only verify after every turn/completed, before the next input (§5.3).
    this.phase = "verifying";
    this.paint();
    if (this.threadId !== null && this.sessionPath !== null) {
      const outcome2 = await this.#verify.call(this, {
        path: this.sessionPath,
        threadId: this.threadId,
        home: this.#home,
        deadlineMs: VERIFY_DEADLINE_MS,
      });
      this.#applyVerify(turn, outcome2);
    }
    // A failed verify puts the app into a terminal chain state; only a clean verify returns to
    // idle (§5.8: input disabled until /new). applyVerify may have widened the phase beyond the
    // flow-narrowed "verifying", so the widened union is asserted here.
    const phaseNow = this.phase as AppStateView["phase"];
    if (phaseNow !== "chain-failed" && phaseNow !== "torn-tail") {
      this.phase = "idle";
    }
    this.#streamSeconds = null;
    this.paint();
  }

  #classifyItemErrorCode(turn: TurnRecord): number {
    const errItem = turn.items.find((i) => i.kind === "error");
    if (errItem !== undefined && errItem.kind === "error" && errItem.code !== undefined) {
      const code = errItem.code;
      if (code === -32007 || code === -32008) return EXIT.provider;
      if (code === -32009) return EXIT.session;
      if (code === -32005 || code === -32006 || code === -32602) return EXIT.usage;
      return EXIT.failure;
    }
    return EXIT.failure;
  }

  #applyVerify(turn: TurnRecord, outcome: VerifyOutcome): void {
    if (outcome.kind === "deadline") {
      turn.verify = { kind: "interrupted" };
      turn.unverified = "verify interrupted";
      this.lastVerify = { kind: "interrupted" };
      this.lastEndNamesTurn = false;
      return;
    }
    const v = outcome.result;
    if (!v.ok) {
      turn.verify = {
        kind: "failed",
        line: v.line,
        reason: v.reason,
        failureKind: v.kind,
      };
      this.lastVerify = turn.verify;
      if (v.kind === "torn-tail") {
        turn.unverified = `torn tail at line ${v.line}: crash residue, not tamper`;
        this.phase = "torn-tail";
      } else {
        // R-b: revoke solid for every turn at or after the failed line.
        for (const t of this.turns) t.revoked = true;
        turn.unverified = `chain FAILED line ${v.line}: ${v.reason}`;
        this.phase = "chain-failed";
        this.sessionCodes = [...this.sessionCodes, { code: EXIT.session, reason: "chain FAILED" }];
      }
      this.lastEndNamesTurn = false;
      return;
    }
    let lastEnd: string | null = null;
    for (const e of v.events) {
      if (e.type === "turn.end") lastEnd = String((e.payload as { turnId?: unknown }).turnId);
    }
    if (lastEnd !== null && lastEnd === turn.realTurnId) {
      turn.verify = {
        kind: "verified",
        seq: v.events[v.events.length - 1]?.seq ?? 0,
        headHash: v.lastHash,
      };
      turn.seqStart = v.events.find((e) => e.type === "turn.start")?.seq ?? null;
      turn.seqEnd = v.events[v.events.length - 1]?.seq ?? null;
      this.lastVerify = turn.verify;
      this.lastEndNamesTurn = true;
      turn.unverified = null;
    } else {
      turn.verify = {
        kind: "verified",
        seq: v.events[v.events.length - 1]?.seq ?? 0,
        headHash: v.lastHash,
      };
      this.lastVerify = turn.verify;
      this.lastEndNamesTurn = false;
      turn.unverified = "the chain's last turn.end does not name this turn";
    }
  }

  #engineGone(message: string): void {
    // Cancel the unbounded waiter timers: a dead engine never settles them and the 24-day
    // timeout would keep the parent's loop alive (client.cancelWaiters, app-act latitude).
    this.#client?.cancelWaiters();
    if (this.#currentTurn !== null && this.#currentTurn.status === "running") {
      this.#currentTurn.status = "unknown";
      this.#currentTurn.unverified = message;
      this.#currentTurn.endTime = this.#now();
    }
    this.sessionCodes = [...this.sessionCodes, { code: EXIT.engine, reason: message }];
    this.phase = "engine-stopped";
    this.#streamSeconds = null;
    this.paint();
  }

  #sessionStartFailed(err: unknown): void {
    // Shared classification (§5.11): seat RPC -32005/-32006/-32602 → 2 (retry on the same
    // engine, IQW-18); RPC -32009 → 5 (session-start-failed, quit keys only); every other
    // failure — protocol errors, engine exit, malformed responses — → 3 (engine stopped).
    const cls = classifyThreadStartFailure(err);
    const message = sanitizeText(this.#errorMessage(err));
    if (cls.exit === EXIT.usage) {
      // Exactly ONE sessionCodes entry per failure: the engine class records its own inside
      // #engineGone, so this branch must not push a second.
      this.sessionCodes = [...this.sessionCodes, { code: cls.exit, reason: message }];
      this.seatError = `${cls.label} error${cls.code === null ? "" : ` ${cls.code}`}: ${message}`;
      this.phase = "idle"; // the next send retries thread/start on the same engine
    } else if (cls.exit === EXIT.session) {
      this.sessionCodes = [...this.sessionCodes, { code: cls.exit, reason: message }];
      this.sessionStartError = { code: cls.code ?? -32009, message };
      this.phase = "session-start-failed";
    } else {
      this.#engineGone(message);
    }
    this.paint();
  }

  sessionStartError: { code: number; message: string } | null = null;
  seatError: string | null = null;

  #errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  /**
   * One witnessed turn: send turn/start, consume notifications with the erratum §3b validation
   * set (E-d applies it to the app), the per-turn idle deadline (E-b), and the served-model
   * receipt check (E3). Deltas are display-only.
   */
  async #runTurn(
    client: EngineClient,
    threadId: string,
    turn: TurnRecord,
    prompt: string,
  ): Promise<"completed" | "failed" | "interrupted" | "timeout" | "violation" | "engine-gone"> {
    const scannedStart = client.messages.length;
    const deadline = this.#turnIdleMs;
    // A holder, not a plain local: the promise executor assigns on a later tick, which TS's
    // control-flow analysis cannot see.
    const violatedRef: { current: ((m: string) => void) | null } = { current: null };
    const violation = new Promise<never>((_, reject) => {
      violatedRef.current = (m: string) => reject(new EngineProtocolError(m));
    });
    violation.catch(() => undefined);
    const violate = (m: string): void => violatedRef.current?.(m);
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let idleFired = false;
    const armIdle = (): void => {
      if (idleFired) return;
      if (idleTimer !== null) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleFired = true;
        idleDeadline();
      }, deadline);
      idleTimer.unref?.();
    };
    const disarmIdle = (): void => {
      if (idleTimer !== null) clearTimeout(idleTimer);
      idleTimer = null;
    };
    let softInterrupt: (() => void) | null = null;
    const soft = new Promise<"soft">((resolve) => {
      softInterrupt = () => resolve("soft");
    });
    soft.catch(() => undefined);
    this.#interruptTurn = () => {
      softInterrupt?.();
    };
    const idleDeadline = (): void => {
      this.sessionCodes = [
        ...this.sessionCodes,
        {
          code: EXIT.engine,
          reason: `timeout: no engine message for ${deadline} ms`,
        },
      ];
      turn.unverified = `timeout: no engine message for ${deadline} ms`;
      softInterrupt?.();
    };
    let result: "completed" | "failed" | "interrupted" | "timeout" | "violation" | "engine-gone" =
      "engine-gone";
    try {
      // Live protocol-violation poll (erratum §3b rule 5, as the one-shot's).
      let scanned = scannedStart;
      const poll = setInterval(() => {
        if (client.protocolViolations.length > 0) {
          violate("protocol violation: non-JSON line on engine stdout");
          return;
        }
        for (; scanned < client.messages.length; ) {
          const m = client.messages[scanned];
          scanned++;
          if (m === undefined) break;
          const cls = classifyMessage(m);
          if (cls.kind !== "ok") {
            violate(violationMessage(cls));
            return;
          }
        }
      }, 100);
      poll.unref?.();
      try {
        armIdle();
        const ts = await Promise.race([
          client.request("turn/start", {
            threadId,
            input: [{ type: "text", text: prompt }],
          }),
          violation,
          soft,
        ]);
        if (ts === "soft") {
          result = await this.#interruptFlow(client, threadId, turn, violation);
          return result;
        }
        const t = (ts as { turn?: unknown } | undefined)?.turn;
        if (!isTurnShape(t) || !isDomainId(t.id) || t.threadId !== threadId) {
          throw new EngineProtocolError("protocol violation: turn/start returned an invalid turn");
        }
        if (t.status !== "inProgress" || t.items.length !== 0 || t.completedAt !== null) {
          throw new EngineProtocolError(
            "protocol violation: turn/start returned a turn that is not just started",
          );
        }
        turn.realTurnId = t.id;
        // Observe the listed notifications (deltas display-only; E3 served-model matching).
        const done = client.waitFor((m: WireMessage) => {
          const params = m.params as Record<string, unknown> | undefined;
          if (m.method === "item/agentMessage/delta") {
            if (
              params === undefined ||
              params === null ||
              typeof params !== "object" ||
              params.threadId !== threadId ||
              !isDomainId(params.turnId) ||
              !isDomainId(params.itemId) ||
              typeof params.delta !== "string"
            ) {
              violate("protocol violation: malformed or foreign item/completed or delta");
            } else if (params.turnId !== turn.realTurnId) {
              violate("protocol violation: malformed or foreign item/completed or delta");
            } else {
              armIdle();
              turn.deltaText = (turn.deltaText ?? "") + sanitizeText(params.delta as string);
              this.paint();
            }
          } else if (m.method === "item/completed" || m.method === "item/started") {
            if (
              params === undefined ||
              params === null ||
              typeof params !== "object" ||
              params.threadId !== threadId ||
              !isDomainId(params.turnId) ||
              !isItemShape(params.item) ||
              (m.method === "item/started" && (params.item as Item).status !== "inProgress")
            ) {
              violate("protocol violation: malformed or foreign item/completed or delta");
            } else if (params.turnId !== turn.realTurnId) {
              violate("protocol violation: malformed or foreign item/completed or delta");
            } else {
              armIdle();
              const item = sanitizeItem(params.item as Item);
              if (m.method === "item/completed") {
                turn.items = [...turn.items.filter((i) => i.id !== item.id), item];
                if (item.kind === "servedModel") {
                  this.served = {
                    requestedModel: item.requestedModel,
                    servedModel: item.servedModel,
                    backing: item.backing,
                    providerId: item.providerId,
                  };
                }
                this.paint();
              }
            }
          } else if (m.method === "turn/started") {
            const t2 = params?.turn;
            if (!isTurnShape(t2) || t2.threadId !== threadId || t2.status !== "inProgress") {
              violate("protocol violation: malformed turn/started");
            } else {
              armIdle();
            }
          } else if (m.method === "turn/completed" && !Object.hasOwn(m, "id")) {
            disarmIdle();
            return true;
          }
          return false;
        }, 2_147_483_647);
        done.catch(() => undefined);
        const outcome = await Promise.race([done, violation, soft]);
        if (outcome === "soft") {
          result = await this.#interruptFlow(client, threadId, turn, violation);
          return result;
        }
        const tDone = (outcome.params as { turn?: unknown } | undefined)?.turn;
        if (isTurnShape(tDone) && tDone.id === turn.realTurnId && tDone.threadId === threadId) {
          turn.items = tDone.items.map(sanitizeItem);
          // this.served derives from the SANITIZED snapshot (E11 at the boundary).
          const servedItems = turn.items.filter((i) => i.kind === "servedModel");
          if (servedItems.length > 0) {
            const last = servedItems[servedItems.length - 1];
            if (last !== undefined && last.kind === "servedModel") {
              this.served = {
                requestedModel: last.requestedModel,
                servedModel: last.servedModel,
                backing: last.backing,
                providerId: last.providerId,
              };
            }
          }
          result =
            tDone.status === "completed"
              ? "completed"
              : tDone.status === "interrupted"
                ? "interrupted"
                : "failed";
          if (tDone.status === "failed" && tDone.error !== null) {
            turn.items = [
              ...turn.items,
              {
                id: `${tDone.id}-error`,
                kind: "error",
                status: "completed",
                message: sanitizeText(tDone.error.message),
                code: tDone.error.code,
              } as Item,
            ];
          }
        } else {
          violate("protocol violation: malformed or foreign turn/completed");
        }
        return result;
      } finally {
        disarmIdle();
      }
    } catch (err) {
      this.#client?.cancelWaiters();
      if (err instanceof EngineProtocolError) {
        this.sessionCodes = [...this.sessionCodes, { code: EXIT.engine, reason: err.message }];
        turn.unverified = err.message;
        return "violation";
      }
      if (err instanceof EngineExitedError) {
        this.#engineGone(this.#errorMessage(err));
        return "engine-gone";
      }
      if (err instanceof EngineRpcError) {
        turn.items = [
          ...turn.items,
          {
            id: `${turn.turnId}-error`,
            kind: "error",
            status: "completed",
            message: sanitizeText(err.message),
            code: err.code,
          } as Item,
        ];
        turn.exitCode = this.#classifyItemErrorCode(turn);
        return "failed";
      }
      this.sessionCodes = [
        ...this.sessionCodes,
        { code: EXIT.engine, reason: this.#errorMessage(err) },
      ];
      return "violation";
    }
  }

  /** Ctrl-C during a turn: turn/interrupt, the 2 s grace; the second press forces the quit. */
  async #interruptFlow(
    client: EngineClient,
    threadId: string,
    turn: TurnRecord,
    violation: Promise<never>,
  ): Promise<"completed" | "failed" | "interrupted" | "timeout" | "violation" | "engine-gone"> {
    const turnId = turn.realTurnId;
    if (turnId === undefined) return "interrupted";
    client.request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
    const answered = await Promise.race([
      client
        .waitForNotification("turn/completed", () => true, INTERRUPT_GRACE_MS)
        .then(() => true)
        .catch(() => false),
      violation,
    ]);
    if (!answered) {
      // Grace ran out: engine stopped, class 3 (§5.8 interrupt rules).
      this.sessionCodes = [
        ...this.sessionCodes,
        { code: EXIT.engine, reason: "interrupt not answered in 2 s · engine stopped" },
      ];
      turn.status = "unknown";
      turn.unverified = "interrupt not answered in 2 s · engine stopped";
      this.#engineStoppedAfterInterrupt = true;
      return "timeout";
    }
    turn.status = "interrupted";
    turn.inAppInterrupted = true;
    turn.unverified = "interrupted";
    return "interrupted";
  }

  #interruptTurn: (() => void) | null = null;
  #engineStoppedAfterInterrupt = false;

  // ------------------------------------------------------------------ quit + signals
  #onCtrlC(): void {
    if (
      (this.phase === "turn" || this.phase === "verifying") &&
      !this.#interruptPending &&
      this.#currentTurn !== null
    ) {
      this.#interruptPending = true;
      this.#interruptTurn?.();
      // A second Ctrl-C during the grace forces the stop and quits by interrupt (IQW5-4).
      setTimeout(() => {
        this.#interruptPending = false;
      }, INTERRUPT_GRACE_MS).unref?.();
      return;
    }
    this.#onQuit("interrupt", "SIGINT");
  }

  #onQuit(kind: QuitPlan["kind"], signal: QuitPlan["signal"]): void {
    if (this.#quit !== null) return;
    this.#quit = { kind, signal };
    void this.#finish(kind, signal);
  }

  onSigint(): void {
    // §5.8.1 O-2: a signal that arrives while the final verify (or the exit write) is running
    // takes the one-shot's F-102 path — restore, re-raise, no receipt and no §5.13 line.
    if (this.#quit !== null && this.#finalVerifyInFlight) {
      this.#signalDuringFinalVerifyInterrupt("SIGINT");
      return;
    }
    this.#onCtrlC();
  }

  onSigterm(): void {
    if (this.#quit !== null && this.#finalVerifyInFlight) {
      this.#signalDuringFinalVerifyInterrupt("SIGTERM");
      return;
    }
    this.#onQuit("interrupt", "SIGTERM");
  }

  /**
   * SIGHUP (§5.0, §5.13, §17.1 O-4): best-effort restore and engine stop, the §5.12 receipt and
   * the single line `madc: interrupted (SIGHUP)` — never an `exit` line — then default handling
   * is restored and SIGHUP is re-raised so the OS reports it (shells show 129). The app itself
   * never calls exit(129); a recorded 2/3/5 stays in the receipt but not in the exit status.
   */
  onSighup(): void {
    if (this.#quit !== null && this.#finalVerifyInFlight) {
      this.#signalDuringFinalVerifyInterrupt("SIGHUP");
      return;
    }
    if (this.#quit !== null) return;
    this.#quit = { kind: "sighup", signal: "SIGHUP" };
    void this.#finish("sighup", "SIGHUP");
  }

  /**
   * §5.8.1 "A signal during the final verify" (§17.1 O-2, RULED): for M0 the app deliberately
   * copies the one-shot's F-102 gap (LEDGER D-203, owned by the M1 CLI act) — restore the
   * terminal synchronously, hand the signal back through the caller's re-raise hook, and write
   * no receipt and no §5.13 line. The shell reports death by that signal.
   */
  #signalDuringFinalVerifyInterrupt(signal: "SIGINT" | "SIGTERM" | "SIGHUP"): void {
    this.#finalVerifyInFlight = false;
    this.#restore();
    this.#onFinalVerifySignal?.(signal);
  }

  async #finish(kind: QuitPlan["kind"], signal: QuitPlan["signal"]): Promise<void> {
    // Stop the engine: close stdin; kill after 1 s when we signalled (§5.8.1), 5 s otherwise.
    const client = this.#client;
    if (client !== null) {
      this.#client = null;
      if (this.#currentTurn?.status === "running" || this.#engineStoppedAfterInterrupt) {
        await client.close(KILL_AFTER_MS).catch(() => null);
      } else {
        await client.close(CLOSE_TIMEOUT_MS).catch(() => null);
      }
    }
    // R-g: one final verify after the engine exits, bounded (O-1) — except when there is no
    // thread (R-g) or a signal arrives during the verify (O-2, below).
    let finalVerifyFailed = false;
    let finalVerify: ChainVerify | null = this.lastVerify;
    if (this.threadId !== null && this.sessionPath !== null) {
      // §5.8.1 O-2 window: a signal while this verify (or the exit write below) runs takes the
      // F-102 path via #signalDuringFinalVerifyInterrupt — restore, re-raise, no receipt.
      this.#finalVerifyInFlight = true;
      const outcome = await this.#verify({
        path: this.sessionPath,
        threadId: this.threadId,
        home: this.#home,
        deadlineMs: VERIFY_DEADLINE_MS,
      });
      if (!this.#finalVerifyInFlight) return; // a signal during the verify took over (O-2)
      this.#finalVerifyInFlight = false;
      if (outcome.kind === "deadline") {
        finalVerify = { kind: "interrupted" };
      } else if (!outcome.result.ok) {
        finalVerifyFailed = true;
        finalVerify = {
          kind: "failed",
          line: outcome.result.line,
          reason: outcome.result.reason,
          failureKind: outcome.result.kind,
        };
      } else {
        let lastEnd: string | null = null;
        for (const e of outcome.result.events) {
          if (e.type === "turn.end") {
            lastEnd = String((e.payload as { turnId?: unknown }).turnId);
          }
        }
        const lastTurn = this.turns[this.turns.length - 1];
        const named = lastTurn !== undefined && lastEnd === lastTurn.realTurnId;
        finalVerify = {
          kind: "verified",
          seq: outcome.result.events[outcome.result.events.length - 1]?.seq ?? 0,
          headHash: outcome.result.lastHash,
        };
        this.lastEndNamesTurn = named;
        if (lastTurn !== undefined && lastTurn.verify === null) {
          lastTurn.verify = finalVerify;
          if (named) {
            lastTurn.unverified = null;
          } else {
            lastTurn.unverified = "the chain's last turn.end does not name this turn";
          }
        }
      }
      this.lastVerify = finalVerify;
      if (finalVerifyFailed) {
        for (const t of this.turns) t.revoked = true;
        this.sessionCodes = [...this.sessionCodes, { code: EXIT.session, reason: "chain FAILED" }];
      }
    }
    if (signal !== null && finalVerifyFailed) {
      this.#signalDuringFinalVerify = true;
    }
    // Restore (§5.0): cursor on, leave the alternate screen, cooked mode.
    this.#finalVerifyInFlight = true; // the exit write is inside the O-2 window too (§5.8.1)
    this.#restore();
    // §5.12: the required exit receipt, when at least one turn/start was sent. On SIGHUP this
    // write is best effort (the terminal may be gone); the receipt still shows a recorded 2/3/5.
    const receipt = this.#exitReceipt(signal, finalVerifyFailed);
    if (receipt !== null) this.#io.stderr.write(receipt);
    this.#finalVerifyInFlight = false;
    if (signal !== null) {
      // §5.13: madc: interrupted (<SIG>) / exit <n>; SIGHUP writes only the first line (O-4).
      if (kind === "sighup") {
        this.#io.stderr.write("madc: interrupted (SIGHUP)\n");
        this.#onSighup();
        return;
      }
      const code = this.#worstCode(signal);
      this.#io.stderr.write(`madc: interrupted (${signal})\nexit ${code}\n`);
      this.#onExit(code);
      return;
    }
    const code = this.#worstCode(null);
    this.#onExit(code);
  }

  #exitReceipt(
    signal: "SIGINT" | "SIGTERM" | "SIGHUP" | null,
    failedAfterSignal: boolean,
  ): string | null {
    if (this.turns.length === 0) return null; // no turn/start sent → no receipt (§5.12)
    const last = this.turns[this.turns.length - 1];
    if (last === undefined) return null;
    const code = worstExit({
      turns: this.turns,
      sessionCodes: this.sessionCodes,
      signal,
      finalVerifyFailedAfterSignal: failedAfterSignal,
    });
    const blockFor = (turn: TurnRecord): string =>
      receiptPlain(
        buildReceiptData({
          turn,
          served: this.#servedOf(turn),
          session: this.#sessionOf(turn),
          error: this.#errorOf(turn),
          exit: code.code,
        }),
      );
    let out = blockFor(last);
    if (
      code.worstTurn !== null &&
      code.worstTurn !== last &&
      code.worstTurn.realTurnId !== undefined
    ) {
      out += blockFor(code.worstTurn);
    }
    return out;
  }

  /** Teardown helper (tests): stop the engine child without the quit flow. */
  async dispose(): Promise<void> {
    if (this.#tick !== null) {
      clearInterval(this.#tick);
      this.#tick = null;
    }
    const c = this.#client;
    this.#client = null;
    if (c !== null) {
      await c.close(KILL_AFTER_MS).catch(() => null);
      // Release the child's pipes even when the child died on its own (engine-exit scenarios):
      // the readline wrappers keep the sockets until destroyed.
      c.child.stdin?.destroy();
      c.child.stdout?.destroy();
      c.child.stderr?.destroy();
    }
  }

  #restore(): void {
    if (this.#tick !== null) {
      clearInterval(this.#tick);
      this.#tick = null;
    }
    this.#tty.write("\u001b[?25h\u001b[?1049l");
    this.#tty.setRawMode(false);
  }

  onResize(): void {
    this.paint();
  }
}
