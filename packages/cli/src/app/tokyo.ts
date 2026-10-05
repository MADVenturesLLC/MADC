/**
 * Tokyo Night full-screen chat (CLI look spec, Founder 2026-10-04).
 *
 * Four regions only: conversation, git side panel, status bar, composer.
 * Green and ✓ are painted only for a verified chain line. A failed turn gets
 * the red line and no green. Open §12 items are not given new copy here.
 */
import { execFileSync } from "node:child_process";
import type { ServedModel } from "./receipt.ts";
import type { TurnRecord } from "./state.ts";
import {
  type Glyphs,
  glyphsFor,
  middleEllipsize,
  type Role,
  type Style,
  wordWrap,
} from "./style.ts";

export type GitSnapshot =
  | { readonly kind: "not-repo" }
  | {
      readonly kind: "repo";
      readonly branch: string;
      readonly hashes: readonly string[];
      readonly ahead: number | null;
      readonly behind: number | null;
    };

/** `~/…` form. A cwd whose info-box row would pass 28 columns takes a middle ellipsis. */
export function displayCwd(cwd: string, home: string): string {
  if (home !== "" && cwd === home) return "~";
  if (home !== "" && cwd.startsWith(`${home}/`)) return `~${cwd.slice(home.length)}`;
  return cwd;
}

const GIT_CACHE: { cwd: string; at: number; snap: GitSnapshot } = {
  cwd: "",
  at: 0,
  snap: { kind: "not-repo" },
};

function gitOut(cwd: string, args: readonly string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 1500,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Read the panel by running git in `cwd`. Calls inside one 200 ms window share
 * a result so a paint burst does not spawn git more than once. That window is
 * the existing elapsed-time tick, not a Founder answer to Q1.
 */
export function readGitPanel(cwd: string, now = Date.now()): GitSnapshot {
  if (GIT_CACHE.cwd === cwd && now - GIT_CACHE.at < 200) return GIT_CACHE.snap;
  const snap = readGitPanelNow(cwd);
  GIT_CACHE.cwd = cwd;
  GIT_CACHE.at = now;
  GIT_CACHE.snap = snap;
  return snap;
}

/** Uncached read, for tests. */
export function readGitPanelNow(cwd: string): GitSnapshot {
  const inside = gitOut(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inside !== "true") return { kind: "not-repo" };
  const branch = gitOut(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]) ?? "";
  const log = gitOut(cwd, ["log", "-2", "--abbrev=6", "--format=%h"]);
  const hashes = (log ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s !== "")
    .slice(0, 2);
  const ab = gitOut(cwd, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]);
  let ahead: number | null = null;
  let behind: number | null = null;
  if (ab !== null) {
    const parts = ab.split(/\s+/);
    const a = Number(parts[0]);
    const b = Number(parts[1]);
    if (Number.isFinite(a) && Number.isFinite(b)) {
      ahead = a;
      behind = b;
    }
  }
  return { kind: "repo", branch, hashes, ahead, behind };
}

/** `/doctor` starts only when the composer begins with `/` (not after a trim). */
export function doctorCommandStarts(raw: string): boolean {
  if (!raw.startsWith("/")) return false;
  const word = raw.trim().split(/\s+/)[0] ?? "";
  return word === "/doctor";
}

type Cell = { ch: string; role: Role | "plain" };

const PANEL_INNER = 12;

function cells(width: number): Cell[] {
  return Array.from({ length: width }, () => ({ ch: " ", role: "plain" as const }));
}

function put(row: Cell[], col: number, text: string, role: Role | "plain"): void {
  let i = 0;
  for (const ch of text) {
    const at = col + i;
    if (at >= 0 && at < row.length) row[at] = { ch, role };
    i += 1;
  }
}

function encode(row: Cell[], style: Style, surface: "screen" | "bar"): string {
  const bg = style.surfaceBg(surface);
  let out = "";
  let i = 0;
  while (i < row.length) {
    const role = row[i]?.role ?? "plain";
    let j = i + 1;
    while (j < row.length && row[j]?.role === role) j += 1;
    const text = row
      .slice(i, j)
      .map((c) => c.ch)
      .join("");
    if (style.depth === "none" || (style.depth === "16" && role === "plain" && bg === null)) {
      out += text;
    } else {
      const parts: string[] = [];
      if (role !== "plain") {
        const fg = style.fgSgr(role);
        if (fg !== null) parts.push(fg);
      }
      if (bg !== null) parts.push(bg);
      out += parts.length === 0 ? text : `\u001b[${parts.join(";")}m${text}\u001b[0m`;
    }
    i = j;
  }
  return out;
}

function boxTop(title: string, g: Glyphs): string {
  const inner = 14;
  const label = ` ${title} `;
  const rest = Math.max(0, inner - label.length);
  const left = Math.floor(rest / 2);
  const right = rest - left;
  return `${g.boxTopLeft}${g.boxHorizontal.repeat(left)}${label}${g.boxHorizontal.repeat(right)}${g.boxTopRight}`;
}

function boxBottom(g: Glyphs): string {
  return `${g.boxBottomLeft}${g.boxHorizontal.repeat(14)}${g.boxBottomRight}`;
}

function boxRow(content: string, g: Glyphs): string {
  const body =
    content.length >= PANEL_INNER ? content.slice(0, PANEL_INNER) : content.padEnd(PANEL_INNER);
  return `${g.boxVertical} ${body} ${g.boxVertical}`;
}

/** The 7-row git panel. Not-a-repo keeps the box and says the folder isn't a repo. */
export function gitPanelRows(snap: GitSnapshot, g: Glyphs): { text: string; role: Role }[][] {
  const top = boxTop("git", g);
  const bottom = boxBottom(g);
  const rows: { text: string; role: Role }[][] = [];
  const pushPlain = (line: string, marks: { at: number; len: number; role: Role }[]): void => {
    const parts: { text: string; role: Role }[] = [];
    let i = 0;
    const sorted = [...marks].sort((a, b) => a.at - b.at);
    for (const m of sorted) {
      if (m.at > i) parts.push({ text: line.slice(i, m.at), role: "border" });
      parts.push({ text: line.slice(m.at, m.at + m.len), role: m.role });
      i = m.at + m.len;
    }
    if (i < line.length) parts.push({ text: line.slice(i), role: "border" });
    rows.push(parts);
  };
  // Title word sits inside the top rule. Colour the word accent, the rule border.
  const titleAt = top.indexOf("git");
  pushPlain(top, [{ at: titleAt, len: 3, role: "accent" }]);
  if (snap.kind === "not-repo") {
    // Decided sentence, wrapped to the 12-column content width. Not a Q2 edge case.
    const phrase = ["the folder", "isn't a", "repo", "", ""];
    for (const line of phrase) {
      pushPlain(boxRow(line, g), [{ at: 2, len: line.length, role: "dim" }]);
    }
    pushPlain(bottom, []);
    return rows;
  }
  const branch = snap.branch;
  const branchRoom = 4;
  // Q2 (long branch) is open: clip to the 4-column value, no ellipsis design.
  const branchShown = branch.length <= branchRoom ? branch : branch.slice(0, branchRoom);
  const branchLine = boxRow(`branch  ${branchShown}`, g);
  pushPlain(branchLine, [
    { at: 2, len: 6, role: "dim" },
    { at: 10, len: branchShown.length, role: "bright" },
  ]);
  const hashRows = [snap.hashes[0] ?? "", snap.hashes[1] ?? ""];
  const graph = g.boxVertical;
  const body = [
    hashRows[0] === "" ? "" : `* ${hashRows[0]}`,
    hashRows[0] !== "" && hashRows[1] !== "" ? graph : "",
    hashRows[1] === "" ? "" : `* ${hashRows[1]}`,
    snap.ahead === null || snap.behind === null ? "" : `↑${snap.ahead} ↓${snap.behind}`,
  ];
  body.forEach((line, idx) => {
    const boxed = boxRow(line, g);
    const marks: { at: number; len: number; role: Role }[] = [];
    if (line.startsWith("* ")) {
      marks.push({ at: 2, len: 1, role: "accent" });
      marks.push({ at: 4, len: line.length - 2, role: "fg" });
    } else if (line === graph) {
      marks.push({ at: 2, len: 1, role: "dim" });
    } else if (line.startsWith("↑")) {
      marks.push({ at: 2, len: line.length, role: "dim" });
    }
    void idx;
    pushPlain(boxed, marks);
  });
  pushPlain(bottom, []);
  return rows;
}

function paintParts(
  row: Cell[],
  col: number,
  parts: readonly { text: string; role: Role }[],
): void {
  let at = col;
  for (const p of parts) {
    put(row, at, p.text, p.role);
    at += p.text.length;
  }
}

export type StartupInfo = {
  readonly version: string;
  readonly protocol: string;
  readonly seatId: string;
  readonly model: string;
  readonly cwd: string;
  readonly userHome: string;
  readonly tools: readonly string[];
  readonly skills: readonly string[];
};

function startupLines(
  info: StartupInfo,
  g: Glyphs,
): { parts: { text: string; role: Role }[]; col: number }[] {
  const cwdFull = displayCwd(info.cwd, info.userHome);
  const cwd = cwdFull.length > 18 ? middleEllipsize(cwdFull, 18) : cwdFull;
  const rows: [string, string, Role][] = [
    ["version", `madc ${info.version}`, "bright"],
    ["protocol", info.protocol, "accent"],
    ["seat", info.seatId, "bright"],
    ["model", info.model, "bright"],
    ["cwd", cwd, "bright"],
  ];
  const inner = 30;
  const contentW = 28;
  const topLabel = " madc ";
  const dash = inner - topLabel.length;
  const left = Math.floor(dash / 2);
  const right = dash - left;
  const lines: { parts: { text: string; role: Role }[]; col: number }[] = [];
  lines.push({
    col: 2,
    parts: [
      { text: g.boxTopLeft + g.boxHorizontal.repeat(left), role: "border" },
      { text: topLabel, role: "accent" },
      { text: g.boxHorizontal.repeat(right) + g.boxTopRight, role: "border" },
    ],
  });
  for (const [key, value, role] of rows) {
    const body = `${key.padEnd(8)}  ${value}`.padEnd(contentW).slice(0, contentW);
    const keyEnd = Math.min(8, body.length);
    lines.push({
      col: 2,
      parts: [
        { text: `${g.boxVertical} `, role: "border" },
        { text: body.slice(0, keyEnd), role: "dim" },
        { text: body.slice(keyEnd, 10), role: "dim" },
        { text: body.slice(10), role },
        { text: ` ${g.boxVertical}`, role: "border" },
      ],
    });
  }
  lines.push({
    col: 2,
    parts: [
      {
        text: `${g.boxBottomLeft}${g.boxHorizontal.repeat(inner)}${g.boxBottomRight}`,
        role: "border",
      },
    ],
  });
  lines.push({ col: 2, parts: [] });
  lines.push({
    col: 2,
    parts: [
      { text: g.diamond, role: "accent" },
      { text: " Tools", role: "accent" },
    ],
  });
  for (const tool of info.tools) {
    lines.push({ col: 4, parts: [{ text: tool, role: "dim" }] });
  }
  lines.push({
    col: 2,
    parts: [
      { text: g.hollow, role: "dim" },
      { text: " Skills", role: "dim" },
    ],
  });
  for (const skill of info.skills) {
    lines.push({ col: 4, parts: [{ text: skill, role: "dim" }] });
  }
  return lines;
}

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

export type VerdictPaint = { readonly text: string; readonly role: "ok" | "err" | "warn" };

/**
 * One verdict line for a settled turn. Green only when the verify passed, the
 * last turn.end named this turn, and the turn is not a failure. A failed turn
 * returns only red. Revoked turns keep the red text already stored on them
 * (Q4's redraw was not redesigned). Interrupted glyph is Q10: no line.
 */
export function verdictOf(turn: TurnRecord, g: Glyphs, verifying: boolean): VerdictPaint | null {
  if (turn.revoked) {
    const stored = turn.unverified ?? "chain FAILED";
    return { text: `${g.cross} ${stored}`, role: "err" };
  }
  if (turn.status === "running") return null;
  if (turn.status === "unknown") {
    const why = turn.unverified ?? "engine exited · turn not recorded as ended";
    return { text: `${g.cross} ${why}`, role: "err" };
  }
  if (turn.verify?.kind === "failed" && turn.verify.failureKind === "torn-tail") {
    return {
      text: `${g.warn} torn tail at line ${turn.verify.line}: crash residue, not tamper`,
      role: "warn",
    };
  }
  if (turn.verify?.kind === "failed") {
    return {
      text: `${g.cross} chain FAILED line ${turn.verify.line}: ${turn.verify.reason}`,
      role: "err",
    };
  }
  const errorItem = turn.items.find((i) => i.kind === "error");
  if (turn.status === "failed" || errorItem !== undefined) {
    if (errorItem !== undefined && errorItem.kind === "error") {
      const code = errorItem.code === undefined ? "" : ` ${errorItem.code}`;
      return { text: `${g.cross} error${code} ${errorItem.message}`, role: "err" };
    }
    return { text: `${g.cross} chain FAILED`, role: "err" };
  }
  if (turn.verify === null && verifying) {
    return { text: `${g.warn} seq ? · UNVERIFIED yet`, role: "warn" };
  }
  if (turn.verify?.kind === "interrupted") {
    return { text: `${g.warn} UNVERIFIED: verify interrupted`, role: "warn" };
  }
  if (turn.verify?.kind === "verified" && turn.unverified === null && turn.status === "completed") {
    const head = turn.verify.headHash.slice(0, 12);
    return {
      text: `${g.check} seq ${turn.verify.seq} · head ${head} · chain VERIFIED`,
      role: "ok",
    };
  }
  if (turn.verify?.kind === "verified" && turn.unverified !== null) {
    const head = turn.verify.headHash.slice(0, 12);
    return {
      text: `${g.warn} seq ${turn.verify.seq} · head ${head} · UNVERIFIED: ${turn.unverified}`,
      role: "warn",
    };
  }
  // Decided word (spec §6.2). The glyph that combines it with a verify is Q10, so none is drawn.
  if (turn.status === "interrupted") return { text: "interrupted", role: "warn" };
  return null;
}

type Rich = { parts: { text: string; role: Role }[]; col: number };

function transcriptLines(
  turns: readonly TurnRecord[],
  g: Glyphs,
  wrap: number,
  verifying: boolean,
): Rich[] {
  const lines: Rich[] = [];
  turns.forEach((turn, index) => {
    if (index > 0) {
      lines.push({ col: 2, parts: [{ text: g.boxHorizontal.repeat(3), role: "dim" }] });
    }
    const user = turn.userText ?? "";
    if (user !== "") {
      const wrapped = wordWrap(user, Math.max(8, wrap));
      wrapped.forEach((text, i) => {
        lines.push({
          col: i === 0 ? 2 : 4,
          parts:
            i === 0
              ? [
                  { text: g.prompt, role: "accent" },
                  { text: " ", role: "fg" },
                  { text, role: "fg" },
                ]
              : [{ text, role: "fg" }],
        });
      });
      lines.push({ col: 2, parts: [] });
    }
    const agent = turn.items.find((i) => i.kind === "agentMessage");
    const agentText =
      agent !== undefined && agent.kind === "agentMessage"
        ? agent.text
        : turn.status === "running"
          ? (turn.deltaText ?? "")
          : "";
    if (agentText !== "") {
      const wrapped = wordWrap(agentText, Math.max(8, wrap));
      wrapped.forEach((text, i) => {
        lines.push({
          col: i === 0 ? 2 : 4,
          parts:
            i === 0
              ? [
                  { text: g.hollow, role: "dim" },
                  { text: " ", role: "fg" },
                  { text, role: "fg" },
                ]
              : [{ text, role: "fg" }],
        });
      });
    }
    for (const item of turn.items) {
      if (item.kind !== "toolCall") continue;
      const arg = toolArgument(JSON.stringify(item.arguments ?? ""));
      const failed = turn.items.some(
        (r) => r.kind === "toolResult" && r.callId === item.id && r.isError,
      );
      const role: Role = failed ? "err" : "fg";
      const text = `${item.name}${arg === "" ? "" : ` ${arg}`}`;
      lines.push({
        col: 6,
        parts: [
          { text: g.boxVertical, role },
          { text: " ", role },
          { text, role },
        ],
      });
    }
    const verdict = verdictOf(turn, g, verifying && index === turns.length - 1);
    if (verdict !== null) {
      lines.push({ col: 2, parts: [] });
      const wrapped = wordWrap(verdict.text, Math.max(8, wrap));
      wrapped.forEach((text, i) => {
        lines.push({
          col: i === 0 ? 2 : 4,
          parts: [{ text, role: verdict.role }],
        });
      });
    }
  });
  return lines;
}

export type StatusInput = {
  readonly seatId: string;
  readonly phase:
    | "launching"
    | "idle"
    | "turn"
    | "verifying"
    | "chain-failed"
    | "torn-tail"
    | "engine-stopped"
    | "session-start-failed";
  readonly turns: readonly TurnRecord[];
  readonly turnSeconds: number;
  readonly totalSeconds: number;
  readonly requestedModel: string | null;
  readonly servedModel: string | null;
};

/** Status center. `ready` is accent, never green. Q10 states get no invented word. */
export function statusCenter(input: StatusInput): { word: string; role: Role } | null {
  switch (input.phase) {
    case "turn":
      return { word: "streaming", role: "accent" };
    case "verifying":
      return { word: "verifying…", role: "dim" };
    case "chain-failed":
      return { word: "chain failed", role: "err" };
    case "engine-stopped":
      return { word: "engine stopped", role: "err" };
    case "session-start-failed":
      return { word: "session start failed", role: "err" };
    case "torn-tail":
      return null;
    default: {
      const last = input.turns[input.turns.length - 1];
      if (last === undefined) return { word: "ready", role: "accent" };
      if (
        last.revoked ||
        last.status === "failed" ||
        last.status === "unknown" ||
        last.status === "interrupted" ||
        last.unverified !== null
      ) {
        return null;
      }
      if (last.verify?.kind === "verified" && last.status === "completed") {
        return { word: "ready", role: "accent" };
      }
      if (last.status === "running") return { word: "streaming", role: "accent" };
      return null;
    }
  }
}

/** Model slot. Requested is labeled until a servedModel receipt exists. */
export function modelSlot(requested: string | null, served: string | null): string {
  if (served !== null && served !== "") return served;
  if (requested !== null && requested !== "") return `requested ${requested}`;
  return "";
}

export type TokyoFrameInput = {
  readonly width: number;
  readonly height: number;
  readonly startup: StartupInfo | null;
  readonly turns: readonly TurnRecord[];
  readonly verifying: boolean;
  readonly git: GitSnapshot;
  readonly status: StatusInput;
  readonly composer: string;
  readonly composerRole: Role;
  readonly notes: readonly Rich[];
  readonly style: Style;
};

export function renderTokyoFrame(input: TokyoFrameInput): string[] {
  const width = input.width;
  const height = input.height;
  if (width < 80 || height < 24) {
    const msg = `terminal too small · need 80×24 · now ${width}×${height}`;
    const pad = Math.max(0, Math.floor((Math.max(width, msg.length) - msg.length) / 2));
    const grid = Array.from({ length: Math.max(height, 1) }, () =>
      cells(Math.max(width, msg.length)),
    );
    const mid = Math.floor((grid.length - 1) / 2);
    const row = grid[mid];
    if (row !== undefined) put(row, pad, msg, "warn");
    return grid.map((r) => encode(r, input.style, "screen"));
  }
  const g = glyphsFor(input.style.ascii);
  const grid: Cell[][] = Array.from({ length: height }, () => cells(width));
  const convRight = width - 22;
  const wrap = width - 26;
  const content: Rich[] = [];
  if (input.startup !== null) content.push(...startupLines(input.startup, g));
  content.push(...transcriptLines(input.turns, g, wrap, input.verifying));
  content.push(...input.notes);
  const viewH = height - 3;
  let visible: Rich[] = [];
  if (input.startup !== null && input.turns.length > 0) {
    const startup = startupLines(input.startup, g);
    const rest = content.slice(startup.length);
    const room = Math.max(0, viewH - startup.length);
    const tail = rest.length > room ? rest.slice(rest.length - room) : rest;
    visible = [...startup.slice(0, viewH), ...tail];
  } else if (content.length > viewH) {
    visible = content.slice(content.length - viewH);
  } else {
    visible = content;
  }
  visible.forEach((line, i) => {
    const row = grid[i + 1];
    if (row === undefined) return;
    let col = line.col;
    for (const p of line.parts) {
      const room = convRight - col;
      if (room <= 0) break;
      const text = p.text.length > room ? p.text.slice(0, room) : p.text;
      put(row, col, text, p.role);
      col += text.length;
    }
  });
  const panel = gitPanelRows(input.git, g);
  for (let i = 0; i < panel.length && i < 7; i++) {
    const row = grid[i + 1];
    const parts = panel[i];
    if (row === undefined || parts === undefined) continue;
    paintParts(row, width - 20, parts);
  }
  const bar = grid[height - 2];
  const composer = grid[height - 1];
  if (bar !== undefined) {
    for (const c of bar) c.role = "plain";
    const center = statusCenter(input.status);
    put(bar, 2, "seat", "dim");
    put(bar, 8, input.status.seatId, "fg");
    const leftUsed = 8 + input.status.seatId.length;
    const time = `${input.status.turnSeconds.toFixed(1)}s / ${input.status.totalSeconds.toFixed(1)}s`;
    const word = center?.word ?? "";
    const end = width - 2;
    let model = modelSlot(input.status.requestedModel, input.status.servedModel);
    const reserved = leftUsed + 2 + word.length + 2 + time.length + 2;
    const modelRoom = Math.max(0, end - reserved);
    if (model.length > modelRoom) model = modelRoom === 0 ? "" : model.slice(0, modelRoom);
    const right = model === "" ? time : `${time}  ${model}`;
    const rightAt = Math.max(leftUsed + 1, end - right.length);
    put(bar, rightAt, right, "fg");
    if (center !== null && word !== "") {
      const freeStart = leftUsed + 1;
      const freeEnd = rightAt - 1;
      let at = Math.floor((width - word.length) / 2);
      if (at < freeStart) at = freeStart;
      if (at + word.length > freeEnd) at = Math.max(freeStart, freeEnd - word.length);
      if (at >= freeStart && at + word.length <= freeEnd) put(bar, at, word, center.role);
    }
  }
  if (composer !== undefined) {
    put(composer, 2, g.prompt, "accent");
    put(composer, 4, input.composer, input.composerRole);
  }
  return grid.map((row, i) => encode(row, input.style, i === height - 2 ? "bar" : "screen"));
}

export type { Rich, ServedModel };
