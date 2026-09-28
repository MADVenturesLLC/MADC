/**
 * Tier-W doctor presentation (DESIGN-SPEC rev 6.2 §8): the doctor card's header band, the
 * `<glyph> <WORD 4> <id padded 14> <summary>` rows streamed as each check finishes (pending rows
 * replaced in place), the hanging indent 23 for wrapped summaries, and the RESULT line on a tint
 * that is never okbg (the "all good" ban holds). Row text is the pinned doctor wording; only
 * chrome is added, and only on a TTY — non-TTY bytes are unchanged.
 */

import type { Check, CheckStatus } from "../doctor.ts";
import {
  type Glyphs,
  middleEllipsize,
  padVisible,
  type Style,
  visibleWidth,
  wordWrap,
} from "./style.ts";

const STATUS_GLYPH: Readonly<Record<CheckStatus, string>> = {
  pass: "✓",
  warn: "▲",
  fail: "✕",
  skip: "○",
  init: "◆",
};

const STATUS_ROLE: Readonly<Record<CheckStatus, "ok" | "warn" | "err" | "dim" | "accent2">> = {
  pass: "ok",
  warn: "warn",
  fail: "err",
  skip: "dim",
  init: "accent2",
};

/** `✓ PASS  runtime       node 22.19.0 (floor 22.19)` with the hanging indent 23 (§8). */
export function doctorRowW(c: Check, style: Style, _g: Glyphs, width: number): string[] {
  const glyph = style.role(STATUS_ROLE[c.status], STATUS_GLYPH[c.status]);
  const word = style.role(STATUS_ROLE[c.status], c.status.toUpperCase().padEnd(4));
  const head = `${glyph} ${word}  ${c.id.padEnd(14)} `;
  // The --init row is `INIT  seeded <path>` / `INIT  already present (…)` (CLI pin §3).
  const text = c.id === "init" && c.status === "init" ? c.summary : c.summary;
  const wrapped = wordWrap(text, Math.max(10, width - 23));
  return wrapped.map((line, i) => (i === 0 ? `${head}${line}` : `${" ".repeat(23)}${line}`));
}

/** The pending placeholder row: `○ ···· <id> running` dim, replaced in place when done (§8). */
export function doctorPendingRowW(id: string, style: Style): string {
  return `${style.role("dim", "○ ····")} ${id.padEnd(14)} ${style.role("dim", "running")}`;
}

/** Header band: `▌ madc doctor · madc <v> · protocol <p>` (§8). */
export function doctorHeaderW(version: string, protocol: string, style: Style, g: Glyphs): string {
  return `${style.role("accent", g.band)} ${style.filled("accent", "madc doctor")} ${style.role("dim", "·")} madc ${version} ${style.role("dim", "·")} protocol ${style.role("accent2", protocol)}`;
}

/** RESULT line on a tint: errbg when FAIL, warnbg when WARN, surface otherwise — never okbg (§8). */
export function doctorResultW(
  resultLine: string,
  fail: number,
  warn: number,
  style: Style,
): string {
  const tint = fail > 0 ? "errbg" : warn > 0 ? "warnbg" : "surface";
  return style.tint(tint, resultLine);
}

/** Width helper for the overlay box: at most 96 columns (§5.9), centred on the terminal. */
export function overlayWidth(terminalWidth: number): number {
  return Math.min(Math.max(terminalWidth - 4, 40), 96);
}

/** Box the given lines in a rounded overlay of `boxW` columns, centred (§5.9). */
export function renderOverlay(
  title: string,
  lines: readonly string[],
  boxW: number,
  style: Style,
  g: Glyphs,
  hint: string,
): string[] {
  const inner = Math.max(boxW - 2, 20);
  const rows: string[] = [];
  const titleWidth = visibleWidth(title) + visibleWidth(hint) + 2;
  rows.push(
    style.role(
      "border",
      `${g.boxTopLeft}${g.boxHorizontal} ${title} ${g.boxHorizontal.repeat(Math.max(0, inner - titleWidth))} ${hint} ${g.boxTopRight}`,
    ),
  );
  for (const line of lines) {
    // §9: chrome-only truncation — a line longer than the box is middle-ellipsised so the
    // border column always lands at the same offset.
    const fits = visibleWidth(line) <= inner ? line : middleEllipsize(line, inner);
    rows.push(
      style.role("border", g.boxVertical) +
        padVisible(fits, inner) +
        style.role("border", g.boxVertical),
    );
  }
  rows.push(
    style.role("border", `${g.boxBottomLeft}${g.boxHorizontal.repeat(inner)}${g.boxBottomRight}`),
  );
  return rows;
}
