/**
 * The pinned receipt rows (CLI pin §2 "Receipt block"; oneshot.ts bytes, §6 unchanged) in one
 * place, shared by the one-shot, the tier-W verdict card (§6.1) and the app's exit receipt
 * (§5.12). `receiptParts` returns every line as ordered parts with an optional tier-A SGR code
 * (§6.2, normative for Level A); the plain renderer joins the parts, which reproduces the pinned
 * bytes exactly, and any styling wraps whole parts only — the text never changes. Nothing here
 * executes anything: every part is plain display text that the caller writes to a stream.
 */

import { stripControls } from "./sanitize.ts";

export type ServedModel = {
  readonly requestedModel: string;
  readonly servedModel: string;
  readonly backing: string;
  readonly providerId: string;
};

export type SessionOut =
  | { path: string; seq: number; headHash: string; chain: "verified" }
  | { path: string; seq: number; headHash: string; chain: "unverified"; reason: string }
  | { path: string; seq: null; headHash: null; chain: "failed"; line: number; reason: string }
  | { path: string; seq: null; headHash: null; chain: "unverified"; reason: string };

export type ErrorOut = { code: number | null; message: string; class: string };

export type ReceiptData = {
  /** null → ` turn     <turnWord>             -` (oneshot.ts "NOT STARTED"/"UNKNOWN" rows). */
  readonly turn: { status: string; id: string; durationMs: number } | null;
  readonly turnWord: string;
  readonly served: ServedModel | null;
  readonly session: SessionOut | null;
  readonly error: ErrorOut | null;
  readonly exit: number;
};

export type ReceiptPart = { readonly text: string; readonly sgr?: string | undefined };
export type ReceiptRow = { readonly parts: readonly ReceiptPart[] };

const RULE = `─ receipt ${"─".repeat(45)}`;

/**
 * The pinned rows as parts. With the optional SGR codes ignored this joins to the exact
 * oneshot.ts receipt bytes (verified byte-for-byte by the tests).
 */
export function receiptParts(data: ReceiptData): ReceiptRow[] {
  const rows: ReceiptRow[] = [{ parts: [{ text: RULE }] }];
  // §6.2: "Padding is computed on the plain text. The SGR wraps the word, and pad spaces go
  // outside it." Word and padding are separate parts so the span never covers the padding.
  if (data.turn === null) {
    const word = data.turnWord;
    rows.push({
      parts: [
        { text: " turn     " },
        { text: word, sgr: turnWordSgr(word) },
        { text: word.padEnd(20).slice(word.length) },
        { text: " -" },
      ],
    });
  } else {
    const word = data.turn.status.toUpperCase();
    rows.push({
      parts: [
        { text: " turn     " },
        { text: word, sgr: turnWordSgr(word) },
        { text: word.padEnd(20).slice(word.length) },
        {
          text: ` ${data.turn.id.padEnd(15)} ${(data.turn.durationMs / 1000).toFixed(1)}s`,
        },
      ],
    });
  }
  rows.push(
    data.served === null
      ? { parts: [{ text: " model    " }, { text: "NO RECEIPT", sgr: "1;33" }] }
      : {
          parts: [
            { text: " model    " },
            {
              text: `${data.served.requestedModel} → ${data.served.servedModel}   (${data.served.backing})`,
            },
          ],
        },
  );
  if (data.session !== null) {
    rows.push({ parts: [{ text: ` session  ${data.session.path}` }] });
    if (data.session.chain === "failed") {
      // IQ-3 exact bytes: ESC[1;31m chain FAILED ESC[0;31m line N: <reason> ESC[0m.
      rows.push({
        parts: [
          { text: "          " },
          { text: "chain FAILED", sgr: "1;31" },
          { text: ` line ${data.session.line}: ${data.session.reason}`, sgr: "0;31" },
        ],
      });
    } else if (data.session.chain === "unverified") {
      const parts: ReceiptPart[] = [{ text: "          " }];
      if (data.session.seq !== null) {
        parts.push({ text: `seq ${data.session.seq} · head ` });
        parts.push({ text: data.session.headHash.slice(0, 12), sgr: "36" });
        parts.push({ text: " · " });
      }
      parts.push({ text: `UNVERIFIED: ${data.session.reason}`, sgr: "33" });
      rows.push({ parts });
    } else {
      rows.push({
        parts: [
          { text: "          " },
          { text: `seq ${data.session.seq} · head ` },
          { text: data.session.headHash.slice(0, 12), sgr: "36" },
          { text: " · " },
          { text: "chain VERIFIED", sgr: "32" },
        ],
      });
    }
  }
  if (data.error !== null) {
    const codeText = data.error.code === null ? "" : ` ${data.error.code}`;
    const head = ` error    ${data.error.class}${codeText}: `;
    // RQ-2: when the error row carries a chain failure, the value uses the session value's
    // in-span form (bold chain FAILED inside a red value). The captured groups are display text.
    const chainMatch = data.error.message.match(/^chain FAILED line (\d+): (.*)$/s);
    if (chainMatch !== null) {
      const lineNo = chainMatch[1] ?? "";
      const reason = chainMatch[2] ?? "";
      rows.push({
        parts: [
          { text: head, sgr: "31" },
          { text: "chain FAILED", sgr: "1;31" },
          { text: ` line ${lineNo}: ${reason}`, sgr: "0;31" },
        ],
      });
    } else {
      rows.push({ parts: [{ text: `${head}${data.error.message}`, sgr: "31" }] });
    }
  }
  rows.push({ parts: [{ text: " exit     " }, { text: String(data.exit), sgr: exitSgr(data) }] });
  return rows;
}

/** §6.2 turn-word colours: COMPLETED only green when the chain verified; unlisted words warn. */
function turnWordSgr(word: string): string {
  switch (word) {
    case "COMPLETED":
      return "33"; // receiptTierA upgrades it to 1;32 only with chain VERIFIED + exit 0
    case "FAILED":
      return "1;31";
    case "INTERRUPTED":
      return "33";
    case "NOT STARTED":
      return "31";
    default:
      return "33";
  }
}

function exitSgr(data: ReceiptData): string | undefined {
  if (data.exit === 0) {
    return data.session?.chain === "verified" ? "32" : undefined;
  }
  return "1;31";
}

/**
 * E11 at the data boundary (DESIGN-SPEC §5.10 E-a): every engine-supplied string that will flow
 * into a styled frame is sanitised BEFORE assembly, so the frame's own chrome (SGR, glyphs) is
 * never fed through the control-char replacer. Plain-text renderers may still strip the whole
 * assembled block, which is equivalent for chrome-less bytes.
 */
export function sanitizeReceiptData(data: ReceiptData): ReceiptData {
  return {
    turn:
      data.turn === null
        ? null
        : {
            status: data.turn.status,
            id: stripControls(data.turn.id),
            durationMs: data.turn.durationMs,
          },
    turnWord: stripControls(data.turnWord),
    served:
      data.served === null
        ? null
        : {
            requestedModel: stripControls(data.served.requestedModel),
            servedModel: stripControls(data.served.servedModel),
            backing: stripControls(data.served.backing),
            providerId: stripControls(data.served.providerId),
          },
    session:
      data.session === null
        ? null
        : data.session.chain === "failed"
          ? {
              path: stripControls(data.session.path),
              seq: null,
              headHash: null,
              chain: "failed",
              line: data.session.line,
              reason: stripControls(data.session.reason),
            }
          : data.session.chain === "unverified"
            ? data.session.seq === null
              ? {
                  path: stripControls(data.session.path),
                  seq: null,
                  headHash: null,
                  chain: "unverified",
                  reason: stripControls(data.session.reason),
                }
              : {
                  path: stripControls(data.session.path),
                  seq: data.session.seq,
                  headHash: data.session.headHash,
                  chain: "unverified",
                  reason: stripControls(data.session.reason),
                }
            : {
                path: stripControls(data.session.path),
                seq: data.session.seq,
                headHash: data.session.headHash,
                chain: "verified",
              },
    error:
      data.error === null
        ? null
        : {
            code: data.error.code,
            class: stripControls(data.error.class),
            message: stripControls(data.error.message),
          },
    exit: data.exit,
  };
}

/**
 * One styled line from a row's parts (§6.2 + IQ-3/RQ-2 exact bytes): a span opens before its
 * text; it is closed by `\u001b[0m` only when the NEXT part carries no SGR of its own — the
 * in-span form (`ESC[1;31m chain FAILED ESC[0;31m line N: … ESC[0m`) resets through the next
 * opener instead of an intermediate close, and every line still ends reset (IQ-7). With
 * `completedGreen`, the COMPLETED word upgrades to 1;32 when the chain verified and the exit
 * is 0 (§6.2 first row); the padding part never takes colour.
 */
export function paintReceiptRow(
  row: ReceiptRow,
  opts?: { readonly completedGreen?: boolean },
): string {
  const parts = [...row.parts];
  let out = "";
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p === undefined) break;
    const next = parts[i + 1];
    if (p.sgr === undefined) {
      out += p.text;
      continue;
    }
    let sgr = p.sgr;
    if (sgr === "33" && p.text === "COMPLETED" && opts?.completedGreen === true) sgr = "1;32";
    out += `\u001b[${sgr}m${p.text}`;
    if (next?.sgr === undefined) out += "\u001b[0m";
  }
  return out;
}

/** Plain bytes: identical to the pinned receipt (join of the parts). */
export function receiptPlain(data: ReceiptData): string {
  const lines = receiptParts(data).map((row) => row.parts.map((p) => p.text).join(""));
  return `${lines.join("\n")}\n`;
}

/**
 * Tier-A receipt: §6.2 SGR spans around the pinned tokens under the both-TTY gate.
 */
export function receiptTierA(data: ReceiptData): string {
  const verifiedOk = data.session?.chain === "verified" && data.exit === 0;
  const lines = receiptParts(data).map((row) =>
    paintReceiptRow(row, { completedGreen: verifiedOk }),
  );
  return `${lines.join("\n")}\n`;
}
