/**
 * Verdict cards (DESIGN-SPEC rev 6.2 §6.1, §7): the earned big verdicts. The green COMPLETED
 * word appears only when the chain VERIFIED and the exit is 0 — i.e. only after the session was
 * re-read from disk, the chain verified, and the last turn.end named the completed turn. A
 * failed chain or an engine failure shows the equally prominent red word (hard rule: failure is
 * never quieter than success — same art size, bold, red).
 */
import { blockArtWidth, verdictArt } from "./art.ts";
import { paintReceiptRow, type ReceiptData, type ReceiptRow, receiptParts } from "./receipt.ts";
import { type Glyphs, padVisible, type Style, visibleWidth } from "./style.ts";

export type Verdict =
  | { readonly kind: "completed" }
  | { readonly kind: "failed" }
  | { readonly kind: "exit"; readonly code: number }
  /** UNVERIFIED with exit 0: warn title, no big art (§6.1, §7). */
  | { readonly kind: "unverified" };

export type CardTitle = {
  readonly glyph: "check" | "cross" | "warn";
  readonly label: string;
};

/** The card's title row: ▌ ✓ chain VERIFIED · exit 0 / ▌ ✕ <cause> · exit <n> / ▌ ▲ UNVERIFIED · exit 0. */
export function cardTitle(verdict: Verdict, data: ReceiptData): CardTitle {
  switch (verdict.kind) {
    case "completed":
      return { glyph: "check", label: `chain VERIFIED · exit ${data.exit}` };
    case "unverified":
      return { glyph: "warn", label: `UNVERIFIED · exit ${data.exit}` };
    case "failed":
      return {
        glyph: "cross",
        label: `${data.error?.class ?? "turn"}${data.error === null ? "" : ` · exit ${data.exit}`}`,
      };
    case "exit":
      return {
        glyph: "cross",
        label: `${data.error?.class ?? "engine"} · exit ${verdict.code}`,
      };
  }
}

/**
 * One verdict card. `roleTint` is the card background (okbg for COMPLETED, errbg otherwise,
 * warnbg for the UNVERIFIED-no-art card); every receipt row keeps its pinned text and gets the
 * card's ▌ edge in the role colour. The card is one write in production.
 */
export function renderVerdictCard(
  verdict: Verdict,
  data: ReceiptData,
  _width: number,
  style: Style,
  g: Glyphs,
  opts?: { readonly titleSuffix?: string },
): string[] {
  const tint: "okbg" | "errbg" | "warnbg" =
    verdict.kind === "completed" ? "okbg" : verdict.kind === "unverified" ? "warnbg" : "errbg";
  const role: "ok" | "err" | "warn" =
    verdict.kind === "completed" ? "ok" : verdict.kind === "unverified" ? "warn" : "err";
  const title = cardTitle(verdict, data);
  const glyph = title.glyph === "check" ? g.check : title.glyph === "warn" ? g.warn : g.cross;
  const suffix = opts?.titleSuffix ?? "";
  const titleRow = `${style.role(role, g.band)} ${style.tint(tint, `${style.role(role, glyph)} ${style.bold(role, title.label)}${suffix}`)}`;
  const rows: string[] = [titleRow];
  if (verdict.kind !== "unverified") {
    const word =
      verdict.kind === "completed"
        ? "COMPLETED"
        : verdict.kind === "failed"
          ? "FAILED"
          : `EXIT ${verdict.code}`;
    const art = verdictArt(word, style.ascii, (row) => style.role(role, row));
    for (const row of art) rows.push(`${style.role(role, g.band)} ${style.tint(tint, row)}`);
  }
  const receiptRows: ReceiptRow[] = receiptParts(data);
  receiptRows.forEach((row) => {
    const text = row.parts.map((p) => p.text).join("");
    // §6.1: the pinned rows verbatim inside the card. The spans are the same structure the
    // tier-A receipt paints (paintReceiptRow) — but zero SGR at depth none (NO_COLOR, IQ-16).
    const styled =
      style.depth === "none"
        ? text
        : paintReceiptRow(row, {
            completedGreen: data.session?.chain === "verified" && data.exit === 0,
          });
    rows.push(
      `${style.role(role, g.band)} ${style.tint(tint, padVisible(styled, Math.max(visibleWidth(text), 0)))}`,
    );
  });
  return rows;
}

/** Card width: content-driven, capped at the terminal (§6.1: fits the COMPLETED art + edge). */
export function cardWidth(lines: readonly string[], terminalWidth: number): number {
  let widest = 0;
  for (const line of lines) widest = Math.max(widest, visibleWidth(line));
  return Math.min(Math.max(widest + 1, 40), Math.max(terminalWidth, 40));
}

/** The -32009-on-thread/start card (§7): session-level startup failure, no receipt rows. */
export function renderSessionStartFailedCard(
  code: number,
  message: string,
  width: number,
  style: Style,
  g: Glyphs,
): string[] {
  const rows: string[] = [
    `${style.role("err", g.band)} ${style.tint("errbg", `${style.role("err", `${g.cross} session error ${code}`)} ${style.bold("err", "· exit class 5")}`)}`,
  ];
  // §7: the big art is EXIT 5 (the exit class); the engine's -32009 stays in the title.
  for (const row of verdictArt("EXIT 5", style.ascii, (r) => style.role("err", r))) {
    rows.push(`${style.role("err", g.band)} ${style.tint("errbg", row)}`);
  }
  rows.push(`${style.role("err", g.band)} ${style.tint("errbg", style.role("err", message))}`);
  rows.push(
    `${style.role("err", g.band)} ${style.tint("errbg", style.role("dim", "the session file could not be created, so nothing was recorded"))}`,
  );
  rows.push(
    `${style.role("err", g.band)} ${style.tint("errbg", style.role("dim", "run madc doctor: its locks row shows the sessions/ mode"))}`,
  );
  void width;
  return rows;
}

/** Big-art width for gating the 80-column card (§6.1: the card fits the art plus the edge). */
export function verdictArtWidth(word: string): number {
  return blockArtWidth(word);
}
