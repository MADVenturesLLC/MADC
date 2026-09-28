/**
 * Block art (DESIGN-SPEC rev 6.2 §4): the MADC wordmark (ANSI-Shadow letterforms, violet→cyan
 * gradient per §3.1) and the big verdict art (COMPLETED / FAILED / EXIT n). The exact
 * letterforms are decoration — §14 lists the ANSI-Shadow art as illustrative — while the words
 * they spell are normative and the ASCII fallback uses the #### WORD #### form. The glyphs are
 * never followed by U+FE0F (no emoji presentation).
 */

const ANSI_SHADOW: Readonly<Record<string, readonly string[]>> = {
  A: [" █████╗ ", "██╔══██╗", "███████║", "██╔══██║", "██║  ██║", "╚═╝  ╚═╝"],
  C: [" ██████╗", "██╔════╝", "██║     ", "██║     ", "╚█████╗ ", " ╚════╝ "],
  D: ["██████╗ ", "██╔══██╗", "██║  ██║", "██║  ██║", "██████╔╝", "╚═════╝ "],
  E: ["███████╗", "██╔════╝", "█████╗  ", "██╔══╝  ", "███████╗", "╚══════╝"],
  F: ["███████╗", "██╔════╝", "█████╗  ", "██╔══╝  ", "██║     ", "╚═╝     "],
  I: ["██╗", "██║", "██║", "██║", "██║", "╚═╝"],
  L: ["██╗     ", "██║     ", "██║     ", "██║     ", "███████╗", "╚══════╝"],
  M: ["███╗   ███╗", "████╗ ████║", "██╔████╔██║", "██║╚██╔╝██║", "██║ ╚═╝ ██║", "╚═╝     ╚═╝"],
  O: [" ██████╗ ", "██╔═══██╗", "██║   ██║", "██║   ██║", "╚██████╔╝", " ╚═════╝ "],
  P: ["██████╗ ", "██╔══██╗", "██████╔╝", "██╔═══╝ ", "██║     ", "╚═╝     "],
  T: ["████████╗", "╚══██╔══╝", "   ██║   ", "   ██║   ", "   ██║   ", "   ╚═╝   "],
  X: ["██╗  ██╗", "╚██╗██╔╝", " ╚███╔╝ ", " ██╔██╗ ", "██╔╝╚██╗", "╚═╝  ╚═╝"],
  "0": [" ██████╗ ", "██╔═████╗", "██║██╔██║", "████╔╝██║", "╚██████╔╝", " ╚═════╝ "],
  "1": [" ██╗", "███║", "╚██║", " ██║", " ██║", " ╚═╝"],
  "2": ["███████╗", "██╔════╝", "███████╗", "╚════██║", "███████║", "╚══════╝"],
  "3": ["███████╗", "╚════██║", " █████╔╝", " ╚════██║", "███████║", "╚══════╝"],
  "4": ["██╗  ██╗", "██║  ██║", "███████║", "╚════██║", "     ██║", "     ╚═╝"],
  "5": ["███████╗", "██╔════╝", "███████╗", "╚════██║", "███████║", "╚══════╝"],
  " ": ["  ", "  ", "  ", "  ", "  ", "  "],
};

const ROWS = 6;

/** Raw (uncoloured) block-art rows for `word`; every unsupported character becomes a space. */
export function blockArtRows(word: string): string[] {
  const blank = ANSI_SHADOW[" "] ?? ["  ", "  ", "  ", "  ", "  ", "  "];
  const glyphs = [...word.toUpperCase()].map((ch) => ANSI_SHADOW[ch] ?? blank);
  const rows: string[] = [];
  for (let r = 0; r < ROWS; r++) {
    let line = "";
    for (const gl of glyphs) {
      const row = gl[r];
      line += row ?? " ".repeat((gl[0] ?? "").length);
    }
    rows.push(line);
  }
  return rows;
}

const VIOLET = [182, 156, 255] as const; // accent #b69cff
const CYAN = [125, 249, 255] as const; // accent2 #7df9ff

/** The wordmark: block art with the violet→cyan row gradient (truecolor; solid accent otherwise). */
export function wordmark(depth: "none" | "16" | "256" | "true"): string[] {
  const rows = blockArtRows("MADC");
  if (depth === "none") return rows;
  if (depth !== "true") {
    return rows.map((row) => {
      const trimmed = row.replace(/\s+$/, "");
      return `\u001b[95m${trimmed}\u001b[0m${" ".repeat(row.length - trimmed.length)}`;
    });
  }
  return rows.map((row, i) => {
    const t = i / (ROWS - 1);
    const c = [
      Math.round(VIOLET[0] + (CYAN[0] - VIOLET[0]) * t),
      Math.round(VIOLET[1] + (CYAN[1] - VIOLET[1]) * t),
      Math.round(VIOLET[2] + (CYAN[2] - VIOLET[2]) * t),
    ];
    // Trailing spaces would paint the background: keep them outside the colour span.
    const trimmed = row.replace(/\s+$/, "");
    return `\u001b[38;2;${c[0]};${c[1]};${c[2]}m${trimmed}\u001b[0m${" ".repeat(row.length - trimmed.length)}`;
  });
}

/**
 * Big verdict art: role-coloured block art. The `#### WORD ####` ASCII form is used only for
 * the ASCII glyph fallback — under NO_COLOR with a UTF-8 locale the block art stays (§10: it is
 * characters, not colour) with `paint` as the no-op the style gives at depth none.
 */
export function verdictArt(word: string, ascii: boolean, paint: (row: string) => string): string[] {
  if (ascii) {
    return [`#### ${word} ####`];
  }
  return blockArtRows(word).map((row) => {
    const trimmed = row.replace(/\s+$/, "");
    const pad = row.length - trimmed.length;
    return `${paint(trimmed)}${" ".repeat(pad)}`;
  });
}

/** Visible width of a block-art word (letters joined with no separator). */
export function blockArtWidth(word: string): number {
  return blockArtRows(word)[0]?.length ?? 0;
}
