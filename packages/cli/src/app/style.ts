/**
 * Colour tokens and glyphs (Tokyo Night CLI spec §4, §7). Depth rules are rev 6.2 §3.3 with
 * the palette swapped: `depth: "none"` emits zero SGR (NO_COLOR, no TTY, TERM=dumb). Green is
 * the verified-evidence role only. `darker` (#0e0e14) is not a CLI token.
 */

export type ColorDepth = "none" | "16" | "256" | "true";

/**
 * Omarchy Tokyo Night (§4.1). 16-colour column is the spec's SGR column. 256 column is the
 * nearest xterm index. `accent2` is the same blue as `accent` (the spec has one accent).
 * `dim` and `faint` are both muted: tool lines, elapsed times and git hashes use `fg`, not these.
 */
const ROLE_SGR = {
  fg: { true: "38;2;169;177;214", 256: "38;5;146", 16: "39" },
  bright: { true: "38;2;192;202;245", 256: "38;5;153", 16: "97" },
  dim: { true: "38;2;86;95;137", 256: "38;5;60", 16: "90" },
  faint: { true: "38;2;86;95;137", 256: "38;5;60", 16: "90" },
  border: { true: "38;2;65;72;104", 256: "38;5;239", 16: "90" },
  accent: { true: "38;2;122;162;247", 256: "38;5;111", 16: "34" },
  accent2: { true: "38;2;122;162;247", 256: "38;5;111", 16: "34" },
  ok: { true: "38;2;158;206;106", 256: "38;5;149", 16: "32" },
  warn: { true: "38;2;224;175;104", 256: "38;5;179", 16: "33" },
  err: { true: "38;2;247;118;142", 256: "38;5;210", 16: "31" },
  /** Text on a filled chip: the screen background, so a fill keeps contrast. */
  bgText: { true: "38;2;26;27;38", 256: "38;5;234", 16: "30" },
} as const;

/** Screen and status-bar fills. 16-colour and NO_COLOR paint nothing (§4.2). */
export const SURFACE_BG = {
  screen: { true: "48;2;26;27;38", 256: "48;5;234", 16: null },
  bar: { true: "48;2;36;40;59", 256: "48;5;236", 16: null },
} as const;

/** Truecolor-only card tints (§3.1); 256 collapses to 234/235, 16-colour to none. */
const TINT_BG = {
  okbg: { true: "48;2;16;35;27", 256: "48;5;234", 16: null },
  errbg: { true: "48;2;44;21;32", 256: "48;5;235", 16: null },
  warnbg: { true: "48;2;42;36;21", 256: "48;5;235", 16: null },
  runbg: { true: "48;2;28;29;53", 256: "48;5;234", 16: null },
  surface: { true: "48;2;22;25;37", 256: "48;5;234", 16: null },
  pill: { true: "48;2;34;38;56", 256: "48;5;235", 16: null },
  accent: { true: "48;2;182;156;255", 256: "48;5;147", 16: "47" },
  ok: { true: "48;2;94;232;160", 256: "48;5;79", 16: "42" },
  warn: { true: "48;2;255;204;102", 256: "48;5;221", 16: "43" },
  err: { true: "48;2;255;107;125", 256: "48;5;204", 16: "41" },
} as const;

export type Role = keyof typeof ROLE_SGR;
export type Tint = keyof typeof TINT_BG;

export class Style {
  readonly depth: ColorDepth;
  readonly ascii: boolean;
  /** Reverse video for key caps in 16-colour mode ([word] under NO_COLOR, per §4/§5.8). */
  readonly keycapReverse: boolean;

  constructor(depth: ColorDepth, ascii: boolean, keycapReverse = depth === "16") {
    this.depth = depth;
    this.ascii = ascii;
    this.keycapReverse = keycapReverse;
  }

  static forDepth(depth: ColorDepth, ascii: boolean): Style {
    return new Style(depth, ascii);
  }

  /** Wrap `text` in the role's SGR span; zero bytes when depth is "none" (IQ-16). */
  role(r: Role, text: string): string {
    if (this.depth === "none") return text;
    return `\u001b[${ROLE_SGR[r][this.depth]}m${text}\u001b[0m`;
  }

  /** Foreground SGR for a role, or null when this depth paints no colour. */
  fgSgr(r: Role): string | null {
    if (this.depth === "none") return null;
    return ROLE_SGR[r][this.depth];
  }

  /** Background fill for the screen or the status bar. Null in 16-colour and NO_COLOR. */
  surfaceBg(which: keyof typeof SURFACE_BG): string | null {
    if (this.depth === "none" || this.depth === "16") return null;
    return SURFACE_BG[which][this.depth];
  }

  /** Bold variant (used by FAIL rows, chain FAILED inside a red value, exit digits ≠ 0). */
  bold(r: Role, text: string): string {
    if (this.depth === "none") return text;
    return `\u001b[1;${ROLE_SGR[r][this.depth]}m${text}\u001b[0m`;
  }

  /** Card/background tint for one line. Truecolor only; 256 → 234/235; 16 → no tint (§3.1). */
  tint(t: Tint, text: string): string {
    if (this.depth === "none") return text;
    const bg = TINT_BG[t][this.depth];
    if (bg === null) return text;
    return `\u001b[${bg}m${text}\u001b[0m`;
  }

  /** A filled pill: role background with background-coloured text (§3.1 "filled pills"). */
  filled(t: Tint, text: string): string {
    if (this.depth === "none") return `[${text}]`;
    const bg = TINT_BG[t][this.depth];
    if (bg === null) return text;
    return `\u001b[${bg}m\u001b[${ROLE_SGR.bgText[this.depth]}m${text}\u001b[0m`;
  }

  /** A pill on the pill background (§5.6 "pill bg"). */
  pill(t: Tint, text: string): string {
    if (this.depth === "none") return `[${text}]`;
    const bg = TINT_BG[t][this.depth];
    if (bg === null) return text;
    return `\u001b[${bg}m${text}\u001b[0m`;
  }

  /** A dim pill: plain dim text in colour modes; [word] under NO_COLOR (§5.6's column). */
  dimPill(text: string): string {
    if (this.depth === "none") return `[${text}]`;
    return this.role("dim", text);
  }

  /** Key cap: reverse-video dim fill; [word] under NO_COLOR and in ASCII fallback (§4). */
  keycap(word: string): string {
    if (this.depth === "none" || this.ascii) return `[${word}]`;
    if (this.keycapReverse) return `\u001b[7m${word}\u001b[0m`;
    // PR #35 round 7 (Copilot r4136804281): the pill background follows the SELECTED depth —
    // a 256-colour terminal gets `48;5;…`, never a hard-coded truecolor SGR it may not support.
    const bg = TINT_BG.pill[this.depth];
    if (bg === null) return `[${word}]`;
    return `\u001b[${ROLE_SGR.dim[this.depth]}m\u001b[${bg}m${word}\u001b[0m`;
  }
}

/** The glyphs of §4; ASCII fallback swaps the chrome glyphs only, never the pinned bytes. */
export type Glyphs = {
  readonly check: string;
  readonly warn: string;
  readonly cross: string;
  readonly idle: string;
  readonly running: string;
  readonly diamond: string;
  readonly railDotted: string;
  readonly railSolid: string;
  readonly railBreak: string;
  readonly railEndVerified: string;
  readonly railEndUnverified: string;
  readonly band: string;
  readonly prompt: string;
  readonly arrow: string;
  readonly middleDot: string;
  readonly emDash: string;
  readonly ellipsis: string;
  /** Rounded box chrome (banner, overlay); ASCII fallback per §4. Not the pinned receipt rule. */
  readonly boxTopLeft: string;
  readonly boxTopRight: string;
  readonly boxBottomLeft: string;
  readonly boxBottomRight: string;
  readonly boxHorizontal: string;
  readonly boxVertical: string;
  readonly hollow: string;
};

const UTF8_GLYPHS: Glyphs = {
  check: "\u2713",
  warn: "\u25b2",
  cross: "\u2717",
  idle: "\u25cb",
  running: "\u25cf",
  diamond: "\u25c6",
  railDotted: "\u2506",
  railSolid: "\u2503",
  railBreak: "\u2573",
  railEndVerified: "\u2517\u2501",
  railEndUnverified: "\u2575",
  band: "\u258c",
  prompt: "\u276f",
  // Pinned bytes (§4): \u00b7 \u2500 \u2192 \u2026 stay exactly as pinned in every mode, ASCII included.
  arrow: "\u2192",
  middleDot: "\u00b7",
  emDash: "\u2500",
  ellipsis: "\u2026",
  boxTopLeft: "\u250c",
  boxTopRight: "\u2510",
  boxBottomLeft: "\u2514",
  boxBottomRight: "\u2518",
  boxHorizontal: "\u2500",
  boxVertical: "\u2502",
  /** Agent mark and Skills mark (§7). ASCII is `*`, same as the section diamond. */
  hollow: "\u25c7",
};

const ASCII_GLYPHS: Glyphs = {
  check: "v",
  warn: "!",
  cross: "x",
  idle: "-",
  running: "*",
  diamond: "*",
  railDotted: ":",
  railSolid: "|",
  railBreak: "X",
  railEndVerified: "`=",
  railEndUnverified: "'",
  band: "|",
  prompt: ">",
  // The receipt rule's \u2500 and the \u00b7 separators are pinned bytes, not chrome glyphs (§4).
  arrow: "\u2192",
  middleDot: "\u00b7",
  emDash: "\u2500",
  ellipsis: "\u2026",
  boxTopLeft: "+",
  boxTopRight: "+",
  boxBottomLeft: "+",
  boxBottomRight: "+",
  boxHorizontal: "-",
  boxVertical: "|",
  hollow: "*",
};

export function glyphsFor(ascii: boolean): Glyphs {
  return ascii ? ASCII_GLYPHS : UTF8_GLYPHS;
}

/** Visible width of `s`: SGR spans and the ANSI-Shadow block art characters count as zero. */
export function visibleWidth(s: string): number {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: SGR sequences are exactly what we strip here.
  const bare = s.replace(/\u001b\[[0-9;]*m/g, "");
  let width = 0;
  for (const ch of bare) {
    const code = ch.codePointAt(0) ?? 0;
    // The block art (\u2588 \u2557 \u2554 \u255a \u255d \u2550 \u2551 \u258c \u258e \u2506 \u2503 \u2573 \u2517 \u2575 \u276f \u2713 \u25b2 \u2715 \u25cb \u25cf \u25c6) is single-cell in practice.
    width += 1;
    if (code >= 0x1f300 && code <= 0x1faff) width += 1; // defensive: never expected in this UI
  }
  return width;
}

/** Pad `s` (already styled) with spaces so its visible width is `width`. */
export function padVisible(s: string, width: number): string {
  const pad = width - visibleWidth(s);
  return pad > 0 ? s + " ".repeat(pad) : s;
}

/** Word-wrap plain (already sanitised) text at `width`; never emits an empty first line. */
export function wordWrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph === "") {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of paragraph.split(/ /)) {
      if (line === "") {
        line = word;
      } else if (visibleWidth(line) + 1 + visibleWidth(word) <= width) {
        line += ` ${word}`;
      } else {
        out.push(line);
        line = word;
      }
      // A single word longer than the width is hard-split (chrome only; pinned rows are never
      // re-wrapped \u2014 engine text is agent content, so this is the wrap-at-the-rail-column case).
      while (visibleWidth(line) > width && width > 0) {
        let cut = 0;
        let acc = 0;
        for (const ch of line) {
          if (acc >= width) break;
          acc += 1;
          cut += ch.length;
        }
        out.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    out.push(line);
  }
  return out;
}

/**
 * Clip tokens of `s`: SGR spans and visible characters, in order. A span is one zero-width
 * token \u2014 a clip may drop it whole but never split it, because a dangling `\u001b[38;\u2026`
 * prints its parameter bytes as cells and corrupts every width computed after it (\u00a75.7 docked
 * pane, \u00a79 chrome truncation).
 */
function clipTokens(s: string): { esc: boolean; text: string }[] {
  const toks: { esc: boolean; text: string }[] = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === "\u001b") {
      // Style-built lines are well-formed `\u001b[\u2026m`; a malformed escape degrades to one
      // zero-width char rather than swallowing the text that follows it.
      // biome-ignore lint/suspicious/noControlCharactersInRegex: SGR sequences are exactly what we match here.
      const m = s.slice(i).match(/^\u001b\[[0-9;]*m/);
      const text = m === null ? (s[i] ?? "") : m[0];
      toks.push({ esc: true, text });
      i += text.length;
      continue;
    }
    const ch = String.fromCodePoint(s.codePointAt(i) ?? 0x20);
    toks.push({ esc: false, text: ch });
    i += ch.length;
  }
  return toks;
}

/** Truncate to `width` with an ellipsis when over (chrome only; \u00a79 truncation rules). */
export function truncateChrome(s: string, width: number): string {
  if (width <= 1) return s;
  if (visibleWidth(s) <= width) return s;
  const glyphs = glyphsFor(false);
  let out = "";
  let acc = 0;
  for (const t of clipTokens(s)) {
    if (t.esc) {
      out += t.text;
      continue;
    }
    if (acc >= width - 1) break;
    out += t.text;
    acc += 1;
  }
  // Close any span the cut left open: the ellipsis and the cells painted after this line (the
  // docked pane's padding and border) must not inherit the clipped text's colour.
  const reset = out.includes("\u001b[") ? "\u001b[0m" : "";
  return out + glyphs.ellipsis + reset;
}

/** Middle-ellipsize to `width` (\u00a79 chrome truncation: paths keep head+tail around a \u2026). */
export function middleEllipsize(s: string, width: number): string {
  if (width <= 1 || visibleWidth(s) <= width) return s;
  const e = glyphsFor(false).ellipsis;
  const keep = Math.max(1, width - 1);
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  const toks = clipTokens(s);
  let front = "";
  let acc = 0;
  for (const t of toks) {
    if (!t.esc) {
      if (acc >= head) break;
      acc += 1;
    }
    front += t.text;
  }
  let back = "";
  acc = 0;
  let i = toks.length - 1;
  for (; i >= 0; i--) {
    const t = toks[i];
    if (t === undefined) continue;
    if (!t.esc) {
      if (acc >= tail) break;
      acc += 1;
    }
    back = t.text + back;
  }
  // The retained tail must keep the colour it had in `s`, not the head's: the span that styled
  // it can sit before chars the cut dropped (red 12345 / green 67890 \u2192 the green opener is
  // left of the dropped `67`). Scan past the dropped visible chars to the escape run that was
  // active at the tail's first kept char and carry it over. A run of `\u001b[0m` means the
  // tail was default-coloured; anything before that run was already closed, so the scan stops
  // at the first run found.
  let styleRun = "";
  for (; i >= 0; i--) {
    const t = toks[i];
    if (t === undefined) continue;
    if (t.esc) {
      styleRun = t.text + styleRun;
      continue;
    }
    if (styleRun !== "") break;
  }
  return front + e + styleRun + back;
}
