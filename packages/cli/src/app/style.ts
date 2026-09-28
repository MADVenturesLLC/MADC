/**
 * Colour tokens, glyphs and chrome helpers (DESIGN-SPEC rev 6.2 §3.1, §4, §5.6, §10).
 *
 * A `Style` is decided once per output from the tier decision: `depth: "none"` emits zero SGR
 * (NO_COLOR, no TTY, TERM=dumb — bold and reverse included, IQ-16), while the layout, glyphs and
 * words stay. Truecolor tints collapse to the 256 palette (234/235) and to none in 16-colour
 * mode; the rail and glyph always carry the state, so the tint is never the only signal.
 */

export type ColorDepth = "none" | "16" | "256" | "true";

/** §3.1 role SGR per depth (dark palette; 16-colour column of the spec table). */
const ROLE_SGR = {
  fg: { true: "97", 256: "97", 16: "39" },
  dim: { true: "38;2;165;171;191", 256: "38;5;145", 16: "37" },
  faint: { true: "38;2;100;107;130", 256: "38;5;60", 16: "90" },
  border: { true: "38;2;59;64;88", 256: "38;5;238", 16: "90" },
  accent: { true: "38;2;182;156;255", 256: "38;5;147", 16: "95" },
  accent2: { true: "38;2;125;249;255", 256: "38;5;123", 16: "96" },
  ok: { true: "38;2;94;232;160", 256: "38;5;79", 16: "92" },
  warn: { true: "38;2;255;204;102", 256: "38;5;221", 16: "93" },
  err: { true: "38;2;255;107;125", 256: "38;5;204", 16: "91" },
  /** Filled-pill text: terminal background colour, so a role fill keeps contrast (§3.1). */
  bgText: { true: "38;2;13;14;20", 256: "38;5;233", 16: "30" },
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
    return `\u001b[${ROLE_SGR.dim[this.depth]}m\u001b[48;2;34;38;56m${word}\u001b[0m`;
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
};

const UTF8_GLYPHS: Glyphs = {
  check: "✓",
  warn: "▲",
  cross: "✕",
  idle: "○",
  running: "●",
  diamond: "◆",
  railDotted: "┆",
  railSolid: "┃",
  railBreak: "╳",
  railEndVerified: "┗━",
  railEndUnverified: "╵",
  band: "▌",
  prompt: "❯",
  // Pinned bytes (§4): · ─ → … stay exactly as pinned in every mode, ASCII included.
  arrow: "→",
  middleDot: "·",
  emDash: "─",
  ellipsis: "…",
  boxTopLeft: "╭",
  boxTopRight: "╮",
  boxBottomLeft: "╰",
  boxBottomRight: "╯",
  boxHorizontal: "─",
  boxVertical: "│",
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
  // The receipt rule's ─ and the · separators are pinned bytes, not chrome glyphs (§4).
  arrow: "→",
  middleDot: "·",
  emDash: "─",
  ellipsis: "…",
  boxTopLeft: "+",
  boxTopRight: "+",
  boxBottomLeft: "+",
  boxBottomRight: "+",
  boxHorizontal: "-",
  boxVertical: "|",
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
    // The block art (█ ╗ ╔ ╚ ╝ ═ ║ ▌ ▎ ┆ ┃ ╳ ┗ ╵ ❯ ✓ ▲ ✕ ○ ● ◆) is single-cell in practice.
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
      // re-wrapped — engine text is agent content, so this is the wrap-at-the-rail-column case).
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

/** Truncate to `width` with an ellipsis when over (chrome only; §9 truncation rules). */
export function truncateChrome(s: string, width: number): string {
  if (width <= 1) return s;
  if (visibleWidth(s) <= width) return s;
  const glyphs = glyphsFor(false);
  let out = "";
  let acc = 0;
  for (const ch of s) {
    if (acc >= width - 1) break;
    out += ch;
    acc += 1;
  }
  return out + glyphs.ellipsis;
}

/** Middle-ellipsize to `width` (§9 chrome truncation: paths keep head+tail around a …). */
export function middleEllipsize(s: string, width: number): string {
  if (width <= 1 || visibleWidth(s) <= width) return s;
  const e = glyphsFor(false).ellipsis;
  const keep = Math.max(1, width - 1);
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  let out = "";
  let acc = 0;
  for (const ch of s) {
    if (acc >= head) break;
    out += ch;
    acc += 1;
  }
  let back = "";
  acc = 0;
  for (const ch of [...s].reverse()) {
    if (acc >= tail) break;
    back = ch + back;
    acc += 1;
  }
  return out + e + back;
}
