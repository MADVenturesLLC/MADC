import { randomUUID } from "node:crypto";

/**
 * Domain id grammar (protocol pin §1, seat pin §1 "Path confinement").
 * No `.`, `/`, `\`, whitespace, or control chars; 1..128 chars.
 * Every threadId / turnId / itemId / seatId must pass this BEFORE it is joined into a path.
 */
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function isValidId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

/** `ho`: the engine-assigned `handoffId` of `thread/handoff` (M2 handoff procedure pin §2). */
export type IdPrefix = "thr" | "turn" | "item" | "ho";

/** `thr_…`, `turn_…`, `item_…`, `ho_…` (32 hex chars after the prefix; always matches ID_PATTERN). */
export function newId(prefix: IdPrefix): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}
