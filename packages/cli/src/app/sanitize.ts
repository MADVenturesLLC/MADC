/**
 * Erratum §3e E11 sanitising, shared by the one-shot and the Witness app (§5.10 E-a): every
 * engine-supplied string the CLI draws — agent text, deltas, tool names/arguments/results and
 * error messages — has every C0 control character except TAB and LF, plus DEL and the C1 range,
 * replaced with U+FFFD (no ANSI injection from a model). Chrome never passes an engine byte
 * through raw. `--json` carries text verbatim.
 */

// biome-ignore lint/suspicious/noControlCharactersInRegex: E11 replaces exactly these control ranges with U+FFFD.
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F\u0080-\u009F]/g;

export function stripControls(s: string): string {
  return s.replace(CONTROL_CHARS, "\uFFFD");
}

export function sanitizeText(text: string): string {
  return stripControls(text);
}

function sanitizeUnknown(value: unknown): unknown {
  if (typeof value === "string") return sanitizeText(value);
  if (Array.isArray(value)) return value.map(sanitizeUnknown);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizeUnknown(v);
    }
    return out;
  }
  return value;
}

/** Sanitise one wire item's display fields (id/kind/status are grammar-validated, kept). */
export function sanitizeItem(
  item: import("@madc/engine/client").Item,
): import("@madc/engine/client").Item {
  const base = { ...item } as Record<string, unknown>;
  for (const key of Object.keys(base)) {
    if (key === "id" || key === "kind" || key === "status") continue;
    base[key] = sanitizeUnknown(base[key]);
  }
  return base as unknown as import("@madc/engine/client").Item;
}
