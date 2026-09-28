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
  padVisible,
  truncateChrome,
  visibleWidth,
  wordWrap,
} from "./style.ts";

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
  /** Row lines for the evidence pane's DOCTOR AT LAUNCH section (id + summary). */
  readonly rowLines: readonly string[];
  /** True when a launch row ended FAIL (banner stays expanded, input disabled until Enter). */
  readonly failAtLaunch: boolean;
};

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
};

const WARN = "▲";
const OK = "✓";
const IDLE = "○";

/** `~/code/madc` form for the banner cwd and header (§5.1); outside $HOME stays absolute. */
export function displayCwd(cwd: string, home: string): string {
  if (home !== "" && cwd === home) return "~";
  if (home !== "" && cwd.startsWith(`${home}/`)) return `~${cwd.slice(home.length)}`;
  return cwd;
}

/** Thread id with the head…tail ellipsis used across the chrome (§9: head 8 + … + tail 4). */
export function shortId(id: string): string {
  if (id.length <= 13) return id;
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

/**
 * The pre-conversation banner (§5.1): one rounded box titled `madc <version>`; wordmark and
 * identity lines on the left; Seat, Doctor at launch and Registry on the right. Below 80
 * columns of right-column room the right column stacks under the wordmark (§9).
 */
export function renderBanner(d: BannerData, width: number, style: Style, g: Glyphs): string[] {
  const boxWidth = Math.max(40, Math.min(width - 2, 102));
  const inner = boxWidth - 2;
  const stacked = width < 110;
  const left: string[] = [
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    style.role("accent", d.seatId),
    style.role("dim", d.backing),
    `madc ${d.version} · ${style.role("accent2", d.protocol)}`,
    style.role("dim", displayCwd(d.cwd, d.userHome)),
    style.role("dim", `home ${d.homeSource === "env" ? "(MADC_HOME)" : "(default)"}`),
    style.role("dim", `thread ${d.threadId === null ? "none yet" : shortId(d.threadId)}`),
  ];
  const mark = wordmark(style.depth);
  for (let i = 0; i < mark.length && i < 6; i++) left[i] = mark[i] ?? "";
  const servedLine =
    d.served === null
      ? `${style.role("dim", `${IDLE} awaiting servedModel receipt`)}`
      : style.role("accent2", d.served.servedModel);
  const right: string[] = [];
  right.push(style.role("accent", "Seat"));
  right.push(
    `  ${style.role("dim", "seat")}      ${style.role("accent", d.seatId)}${d.seatSha === null ? "" : style.role("accent2", ` · sha256:${d.seatSha}`)}`,
  );
  right.push(
    `  ${style.role("dim", "backing")}   ${d.backing}${d.backingLane === null ? "" : style.role("dim", ` · ${d.backingLane}`)}`,
  );
  right.push(`  ${style.role("dim", "requested")} ${d.requested ?? "—"}`);
  right.push(`  ${style.role("dim", "served")}    ${servedLine}`);
  right.push("");
  const doctorMs = d.doctor.ms === null ? "" : `  ${style.role("dim", `${d.doctor.ms} ms`)}`;
  right.push(
    `${style.role("accent", "Doctor at launch")}  ${style.role("dim", "read-only")}${doctorMs}`,
  );
  right.push(
    `  ${style.role("ok", `${OK} ${d.doctor.pass} PASS`)} · ${style.role("warn", `${WARN} ${d.doctor.warn} WARN`)} · ${style.role("err", `${d.doctor.fail} FAIL`)} · ${style.role("dim", `${IDLE} ${d.doctor.skip} SKIP`)}  ${style.role("dim", "/doctor for rows")}`,
  );
  right.push("");
  if (d.registry !== null) {
    right.push(
      `${style.role("accent", "Registry")}  ${style.role("dim", `${d.registry.entries} entries`)}`,
    );
    right.push(
      `  ${style.role("dim", "wired")}     ${style.role("accent2", d.registry.wired.join(", "))}`,
    );
    right.push(
      `  ${style.role("dim", "policy")}    ${style.role("dim", `${d.registry.direct} direct · ${d.registry.vendor} via vendor · ${d.registry.interactive} interactive · ${d.registry.forbidden} forbidden`)}`,
    );
    right.push("");
  }
  if (d.uiNote !== null) right.push(style.role("warn", d.uiNote));
  right.push(
    style.role(
      "dim",
      `${d.registry === null ? "" : `${d.registry.entries} registry entries · `}1 seat · /help for commands`,
    ),
  );

  const rows: string[] = [];
  const title = ` ${style.role("accent", `madc ${d.version}`)} `;
  const titleWidth = visibleWidth(` madc ${d.version} `);
  const dashCount = Math.max(0, inner - titleWidth - 2);
  rows.push(
    style.role(
      "border",
      `${g.boxTopLeft}${g.boxHorizontal}${title}${g.boxHorizontal.repeat(Math.max(0, dashCount - 1))}${g.boxTopRight}`,
    ),
  );
  const paintRow = (text: string): string =>
    style.role("border", `${g.boxVertical}`) +
    padVisible(text, inner) +
    style.role("border", g.boxVertical);
  if (stacked) {
    for (const line of left) rows.push(paintRow(line));
    rows.push(paintRow(""));
    for (const line of right) rows.push(paintRow(line));
  } else {
    const height = Math.max(left.length, right.length);
    for (let i = 0; i < height; i++) {
      const l = truncateChrome(left[i] ?? "", 46);
      const r = (right[i] ?? "").trimEnd();
      rows.push(
        style.role("border", g.boxVertical) +
          padVisible(l, 46) +
          r +
          " ".repeat(Math.max(0, inner - 46 - visibleWidth(r))) +
          style.role("border", g.boxVertical),
      );
    }
  }
  rows.push(
    style.role("border", `${g.boxBottomLeft}${g.boxHorizontal.repeat(inner)}${g.boxBottomRight}`),
  );
  // §5.1: every doctor WARN or FAIL row prints in full under the banner, in its pinned wording.
  for (const row of d.doctor.warnRows) {
    rows.push(`${style.role("warn", `${WARN} `)}${row}`);
  }
  return rows;
}

/** The one-line header the banner collapses to (§5.2); cwd is dropped at 80 columns (§9). */
export function renderHeader(
  d: {
    seatId: string;
    backing: string;
    protocol: string;
    cwd: string;
    userHome: string;
    threadId: string | null;
  },
  width: number,
  style: Style,
): string {
  const parts = [
    style.filled("accent", "MADC"),
    style.role("accent", d.seatId),
    style.role("dim", "·"),
    d.backing,
    style.role("dim", "·"),
    style.role("accent2", d.protocol),
  ];
  if (width >= 81)
    parts.push(style.role("dim", "·"), style.role("dim", displayCwd(d.cwd, d.userHome)));
  if (d.threadId !== null) {
    parts.push(style.role("dim", "·"), "thread", style.role("accent2", shortId(d.threadId)));
  }
  const left = parts.join(" ");
  const hint = style.role("dim", `▸ banner Ctrl-B`);
  const pad = Math.max(1, width - visibleWidth(left) - visibleWidth(hint) - 1);
  return `${left}${" ".repeat(pad)}${hint}`;
}

/** Which state the transcript's live turn is in, for the rail end line and pills (§5.3, §5.6). */
export type AppStateView = {
  readonly phase:
    | "launching"
    | "idle"
    | "turn"
    | "verifying"
    | "chain-failed"
    | "torn-tail"
    | "engine-stopped"
    | "session-start-failed";
  readonly seatId: string;
  readonly threadId: string | null;
  readonly threadStatus: string | null;
  readonly sessionPath: string | null;
  readonly turns: readonly TurnRecord[];
  readonly served: ServedModel | null;
  readonly lastVerify: ChainVerify | null;
  readonly streamSeconds: number | null;
  readonly elapsedSeconds: number;
  readonly idleSeconds: number | null;
  readonly doctor: DoctorSummary;
  readonly turnCount: number;
  readonly lastEndNamesTurn: boolean;
  readonly exitHint: number | null;
  readonly sessionCode: { code: number; reason: string } | null;
};

export type ToolPair = {
  call: { id: string; name: string; argument: string } | null;
  result: { id: string; name: string; output: string; isError: boolean } | null;
};

/** Pair the turn's toolCall/toolResult items by `callId` for card rendering (§5.4). */
export function toolPairs(turn: TurnRecord): ToolPair[] {
  const pairs: ToolPair[] = [];
  const pending = new Map<string, ToolPair>();
  for (const item of turn.items) {
    if (item.kind === "toolCall") {
      const pair: ToolPair = {
        call: { id: item.id, name: item.name, argument: JSON.stringify(item.arguments ?? "") },
        result: null,
      };
      pending.set(item.id, pair);
      pairs.push(pair);
    } else if (item.kind === "toolResult") {
      const result = { id: item.id, name: item.name, output: item.output, isError: item.isError };
      const pair = pending.get(item.callId);
      if (pair === undefined) pairs.push({ call: null, result });
      else pair.result = result;
    }
  }
  return pairs;
}

const RAIL_INDENT = "  ";

/** The card title's argument: a string argument verbatim; an object's string values joined. */
function toolArgument(argument: string): string {
  if (argument === "") return "";
  try {
    const parsed: unknown = JSON.parse(argument);
    if (typeof parsed === "string") return parsed;
    if (parsed !== null && typeof parsed === "object") {
      const values = Object.values(parsed as Record<string, unknown>)
        .filter((v): v is string => typeof v === "string")
        .join(" ");
      if (values !== "") return values;
    }
    return argument;
  } catch {
    return argument;
  }
}

/** One turn's rail segment with its items (§5.3–§5.5); `durationMs` is supplied by the caller. */
export function renderTurn(
  turn: TurnRecord,
  view: {
    seatId: string;
    requestedModel: string | null;
    userText: string | null;
    nowMs: number;
    turnNumber: number;
  },
  width: number,
  style: Style,
  g: Glyphs,
): string[] {
  const lines: string[] = [];
  const railDotted = style.role("warn", g.railDotted);
  const railSolid = style.role("ok", g.railSolid);
  const railErr = style.role("err", g.railSolid);
  const _rail = turn.revoked ? railErr : turn.status === "running" ? railDotted : railSolid;
  const dottedRail = railDotted;
  // userMessage band (§5.4): pill background, accent edge, text wrapped at the rail column.
  if (view.userText !== null) {
    const wrapped = wordWrap(view.userText, Math.max(10, width - 8));
    wrapped.forEach((textLine, i) => {
      const label = i === 0 ? `${style.role("accent", "you")} ` : "    ";
      lines.push(
        RAIL_INDENT +
          style.role("warn", g.railDotted) +
          " " +
          style.tint("pill", `${g.band} ${label}${textLine}`),
      );
    });
  }
  // §5.4 notification row (not an Item): ○ turn/started turn_… · requested <model> (dim).
  if (turn.realTurnId !== undefined) {
    lines.push(
      RAIL_INDENT +
        dottedRail +
        " " +
        style.role(
          "dim",
          `${g.idle} turn/started ${turn.realTurnId}${view.requestedModel === null ? "" : ` · requested ${view.requestedModel}`}`,
        ),
    );
  }
  // §5.5 streaming: the deltas appear on the running turn's dotted rail (display-only); the
  // authoritative item/completed text replaces them below once the item lands.
  if (turn.status === "running" && turn.deltaText !== undefined && turn.deltaText !== "") {
    const hasAgent = turn.items.some((i) => i.kind === "agentMessage");
    if (!hasAgent) {
      for (const line of wordWrap(turn.deltaText, Math.max(10, width - 6)).slice(-3)) {
        lines.push(`${RAIL_INDENT + dottedRail}   ${style.role("fg", line)}`);
      }
    }
  }
  // tool cards (§5.4): surface card, accent2 edge; err edge + ✕ when isError; never green.
  for (const pair of toolPairs(turn)) {
    if (pair.call === null && pair.result === null) continue;
    const err = pair.result?.isError === true;
    const edge = err ? style.role("err", g.band) : style.role("accent2", g.band);
    const glyph = err ? style.role("err", g.cross) : style.role("accent2", g.diamond);
    const name = pair.call?.name ?? pair.result?.name ?? "";
    const arg = pair.call === null ? "" : ` ${toolArgument(pair.call.argument)}`;
    // Montage style: the card title carries the tool name + argument on the left and the
    // right-side meta (result size · item id) right-aligned on the SAME line.
    const metaText =
      pair.result === null
        ? "running"
        : `${pair.result.output.split("\n")[0]?.slice(0, 24) ?? ""} · ${pair.result.id.slice(0, 8)}`;
    const titleText = `${glyph} ${style.role("accent2", name)}${arg}`;
    const titleWidth = visibleWidth(titleText);
    const metaWidth = visibleWidth(metaText);
    const gutter = Math.max(1, width - 6 - titleWidth - metaWidth);
    lines.push(
      RAIL_INDENT +
        dottedRail +
        " " +
        edge +
        " " +
        titleText +
        " ".repeat(gutter) +
        style.role("dim", metaText),
    );
    lines.push(
      RAIL_INDENT +
        dottedRail +
        "   " +
        style.role(
          "dim",
          `toolCall ${g.arrow} toolResult · isError=${String(pair.result?.isError ?? false)}`,
        ),
    );
    if (pair.result !== null) {
      const summary = wordWrap(pair.result.output.replace(/\n/g, " "), Math.max(10, width - 12));
      for (const line of summary.slice(0, 2)) {
        lines.push(`${RAIL_INDENT + dottedRail}   ${style.role("fg", line)}`);
      }
    }
  }
  // agentMessage row (§5.4): ◆ seat · agentMessage · item/completed, then the wrapped text.
  const agent = turn.items.find((i) => i.kind === "agentMessage");
  if (agent !== undefined && agent.kind === "agentMessage") {
    lines.push(
      RAIL_INDENT +
        dottedRail +
        " " +
        style.role("accent2", g.diamond) +
        " " +
        style.filled("pill", style.role("accent", view.seatId)) +
        " " +
        style.role("dim", `· agentMessage · item/completed`),
    );
    for (const textLine of wordWrap(agent.text, Math.max(10, width - 6))) {
      lines.push(`${RAIL_INDENT + dottedRail}   ${textLine}`);
    }
  }
  // error item card (§5.4, IQW-8): err edge, ✕ error <code>, message after E11.
  for (const item of turn.items) {
    if (item.kind !== "error") continue;
    const code = item.code === undefined ? "" : ` ${item.code}`;
    lines.push(
      RAIL_INDENT +
        dottedRail +
        " " +
        style.role("err", g.band) +
        " " +
        style.tint("errbg", `${style.role("err", `${g.cross} error${code}`)} ${item.message}`),
    );
  }
  // Rail end line (§5.3 table) — only from recorded evidence, never from a status alone (R-f).
  lines.push(...renderRailEnd(turn, view, width, style, g));
  return lines;
}

function renderRailEnd(
  turn: TurnRecord,
  view: { nowMs: number; turnNumber: number },
  _width: number,
  style: Style,
  g: Glyphs,
): string[] {
  const solidLead = turn.revoked
    ? style.role("err", g.railEndVerified)
    : style.role("ok", g.railEndVerified);
  if (turn.status === "running") return [];
  if (turn.revoked) {
    // R-b: the remembered range contains or follows the failed line; the reason text is the
    // verifier's chain-FAILED value verbatim.
    return [
      RAIL_INDENT +
        style.role("err", g.railBreak) +
        " " +
        style.role("err", turn.unverified ?? "chain FAILED"),
    ];
  }
  if (turn.status === "unknown") {
    // §5.3 engine-gone row: ╳ engine exited · turn not recorded as ended (reason verbatim).
    return [
      RAIL_INDENT +
        style.role("err", g.railBreak) +
        " " +
        style.role("err", turn.unverified ?? "engine exited · turn not recorded as ended"),
    ];
  }
  if (turn.verify?.kind === "verified" && turn.unverified === null) {
    return [
      RAIL_INDENT +
        solidLead +
        " " +
        style.role("dim", `seq ${turn.verify.seq} · head ${turn.verify.headHash.slice(0, 12)} · `) +
        style.role("ok", "chain VERIFIED") +
        style.role("dim", ` · turn ${view.turnNumber}`),
    ];
  }
  const reason =
    turn.unverified ?? (turn.status === "interrupted" ? "interrupted" : "verify pending");
  return [
    RAIL_INDENT +
      style.role("warn", g.railEndUnverified) +
      " " +
      style.role(
        "dim",
        `seq ${turn.verify?.kind === "verified" ? turn.verify.seq : "?"} · head ${
          turn.verify?.kind === "verified" ? turn.verify.headHash.slice(0, 12) : ""
        }${turn.verify?.kind === "verified" ? " · " : ""}`,
      ) +
      style.role("warn", `UNVERIFIED: ${reason}`),
  ];
}

/** Status pills (§5.6): activity, seat, served, thread, chain, clock. Under NO_COLOR the pill
 * glyphs take their ASCII forms ([* streaming 2.6s], [- idle · 4.8s], per §5.6's column). */
export function renderPills(state: AppStateView, style: Style, g: Glyphs): string {
  const pg = glyphsFor(style.ascii || style.depth === "none");
  const pills: string[] = [];
  if (state.phase === "turn") {
    pills.push(
      style.filled(
        "accent",
        `${pg.running} streaming ${Number(state.streamSeconds ?? 0).toFixed(1)}s`,
      ),
    );
  } else if (state.phase === "verifying") {
    pills.push(style.filled("warn", `${pg.running} verifying`));
  } else if (state.phase === "session-start-failed") {
    pills.push(style.filled("err", `${pg.cross} exit 5 · session`));
  } else if (state.phase === "engine-stopped") {
    pills.push(style.filled("err", `${pg.cross} engine stopped`));
  } else {
    pills.push(
      style.pill(
        "pill",
        `${pg.idle} idle${state.idleSeconds === null ? "" : ` · ${state.idleSeconds.toFixed(1)}s`}`,
      ),
    );
  }
  pills.push(style.filled("accent", state.seatId));
  if (state.served === null) {
    pills.push(style.dimPill(`${pg.idle} served: awaiting receipt`));
  } else {
    pills.push(style.role("accent2", `served: ${state.served.servedModel}`));
  }
  if (state.threadId === null) {
    pills.push(style.dimPill(`${pg.idle} thread: none yet`));
  } else {
    pills.push(style.role("accent2", shortId(state.threadId)));
  }
  pills.push(renderChainPill(state, style, g));
  pills.push(style.role("dim", `${Math.floor(state.elapsedSeconds)}s`));
  return pills.join(" ");
}

export function renderChainPill(state: AppStateView, style: Style, _g: Glyphs): string {
  const pg = glyphsFor(style.ascii || style.depth === "none");
  const v = state.lastVerify;
  if (state.phase === "chain-failed" && v?.kind === "failed") {
    return style.filled("err", `${pg.cross} chain FAILED line ${v.line}`);
  }
  if (v === null) return style.dimPill(`${pg.idle} chain: nothing yet`);
  if (v.kind === "verified") {
    const last = state.turns[state.turns.length - 1];
    const named = state.lastEndNamesTurn;
    if (last !== undefined && named && last.unverified === null) {
      return style.filled("ok", `seq ${v.seq} · ${pg.check} chain VERIFIED`);
    }
    const turnNo = state.turns.length;
    return style.tint(
      "warnbg",
      `turn ${turnNo} ${style.role("warn", `${pg.warn} UNVERIFIED yet`)}`,
    );
  }
  if (v.kind === "failed") {
    return style.filled("err", `${pg.cross} chain FAILED line ${v.line}`);
  }
  return style.tint("warnbg", style.role("warn", `${pg.warn} UNVERIFIED yet`));
}

/** Key hints: only keys that act in the current state (§5.8, IQW4-3). */
export function renderHints(
  state: AppStateView,
  paneOpen: boolean,
  style: Style,
  _g: Glyphs,
): string {
  const cap = (k: string, label: string): string => `${style.keycap(k)} ${label}`;
  switch (state.phase) {
    case "launching":
      return [cap("Tab", "evidence pane"), cap("Ctrl-B", "banner")].join("   ");
    case "turn":
    case "verifying": {
      const items = [cap("Ctrl-C", "interrupt"), cap("Tab", "evidence")];
      if (paneOpen) items.push(cap("Esc", "close pane"));
      items.push(cap("Ctrl-B", "banner"));
      return items.join("   ");
    }
    case "chain-failed":
    case "torn-tail":
      return [
        cap("/doctor", "session row"),
        cap("/new", "new thread"),
        cap("/receipt", ""),
        cap("Ctrl-D", state.exitHint === null ? "exit" : `exit ${state.exitHint}`),
      ].join("   ");
    case "engine-stopped":
      return [
        cap("Ctrl-D", "quit"),
        cap("/doctor", "check engine"),
        cap("/receipt", ""),
        cap("Enter", "restart engine"),
      ].join("   ");
    case "session-start-failed":
      return [cap("Ctrl-D", "quit"), cap("Ctrl-C", "quit")].join("   ");
    default:
      return [
        cap("Enter", "send"),
        cap("/help", ""),
        cap("/doctor", "rows"),
        cap("Tab", "evidence pane"),
        cap("Ctrl-B", "banner"),
        cap("Ctrl-D", "exit"),
      ].join("   ");
  }
}

/** The /help listing (§5.8): the M0 keys and commands. */
export function renderHelp(style: Style, g: Glyphs): string[] {
  const rows: string[] = [
    style.role("accent", "commands and keys"),
    `  ${style.keycap("Enter")} send · ${style.keycap("/help")} this list · ${style.keycap("/doctor")} doctor rows · ${style.keycap("/receipt")} last receipt`,
    `  ${style.keycap("/new")} new thread · ${style.keycap("Tab")} evidence pane · ${style.keycap("Ctrl-B")} banner · ${style.keycap("Ctrl-D")} quit`,
    `  ${style.keycap("Ctrl-C")} interrupt a turn (again: quit) · ${style.keycap("Esc")} close pane or overlay`,
    style.role("dim", "A line starting // sends a literal /…; empty input is not sent."),
    style.role(
      "dim",
      `The rail is dotted ${g.railDotted} until a read-only verify passes, solid ${g.railSolid} after, red ${g.railBreak} on a failed chain.`,
    ),
  ];
  return rows;
}
