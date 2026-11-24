/**
 * M3-A1 (`docs/plan/PIN-madc-M3-desktop-protocol.md` §2): read-only `session/search` and
 * `session/read` across verified session chains in `$MADC_HOME/sessions/`.
 */
import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { confinedPath, isStrictlyUnder } from "./home.ts";
import { invalidParams, threadNotFound } from "./protocol/errors.ts";
import { isValidId } from "./protocol/ids.ts";
import { REDACTED, type SessionEvent, verifySessionFile } from "./session-store.ts";

export type SessionSearchMatch = {
  readonly threadId: string;
  readonly seatId: string;
  readonly seq: number;
  readonly hash: string;
  readonly ts: number;
  readonly type: string;
  readonly snippet: string;
};

export type SessionSearchResult = {
  readonly matches: readonly SessionSearchMatch[];
};

export type SessionReadResult = {
  readonly threadId: string;
  readonly events: readonly SessionEvent[];
  readonly chainOk: boolean;
};

const MAX_SNIPPET = 160;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function stripControls(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0x20 && code !== 0x7f) out += s[i];
    else if (code === 0x09 || code === 0x0a || code === 0x0d) out += " ";
  }
  return out;
}

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    if (value !== REDACTED && !value.includes(REDACTED)) {
      out.push(value);
    } else {
      // Strip `[REDACTED]` tokens so redacted secrets or the marker itself never match.
      const stripped = value.split(REDACTED).join(" ").trim();
      if (stripped !== "") out.push(stripped);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) collectStrings(v, out);
  }
}

function makeSnippet(text: string, needleLower: string): string {
  const clean = stripControls(text);
  const idx = clean.toLowerCase().indexOf(needleLower);
  if (idx < 0) return clean.slice(0, MAX_SNIPPET);
  const start = Math.max(0, idx - 40);
  const end = Math.min(clean.length, start + MAX_SNIPPET);
  return clean.slice(start, end);
}

/**
 * Search verified session chains in `$MADC_HOME/sessions/`. Corrupt/unverified chains are skipped.
 */
export function searchSessions(
  home: string,
  params: { readonly query: string; readonly limit?: number; readonly seatId?: string },
): SessionSearchResult {
  const query = typeof params.query === "string" ? params.query.trim() : "";
  if (query === "") {
    throw invalidParams(["query must be a non-empty string"]);
  }
  let limit = DEFAULT_LIMIT;
  if (params.limit !== undefined) {
    if (typeof params.limit !== "number" || !Number.isInteger(params.limit) || params.limit < 1) {
      throw invalidParams(["limit must be a positive integer"]);
    }
    limit = Math.min(params.limit, MAX_LIMIT);
  }
  if (params.seatId !== undefined && !isValidId(params.seatId)) {
    throw invalidParams(["seatId must match the id grammar"]);
  }

  const dir = join(home, "sessions");
  let names: string[];
  try {
    if (!isStrictlyUnder(realpathSync(dir), realpathSync(home))) return { matches: [] };
    names = readdirSync(dir);
  } catch {
    return { matches: [] };
  }

  const needleLower = query.toLowerCase();
  const threadIds = names
    .filter((n) => n.endsWith(".jsonl"))
    .map((n) => n.slice(0, -".jsonl".length))
    .filter((id) => isValidId(id))
    .sort();

  const matches: SessionSearchMatch[] = [];
  for (const threadId of threadIds) {
    if (matches.length >= limit) break;
    const path = join(dir, `${threadId}.jsonl`);
    try {
      if (!lstatSync(path).isFile()) continue;
    } catch {
      continue;
    }
    const verified = verifySessionFile(path, threadId, {}, home);
    if (!verified.ok) continue;
    const seatId = verified.events[0]?.seatId ?? "";
    if (params.seatId !== undefined && seatId !== params.seatId) continue;

    for (const ev of verified.events) {
      if (matches.length >= limit) break;
      const strings: string[] = [];
      collectStrings(ev.payload, strings);
      for (const s of strings) {
        if (s.toLowerCase().includes(needleLower)) {
          matches.push({
            threadId,
            seatId: ev.seatId,
            seq: ev.seq,
            hash: ev.hash,
            ts: ev.ts,
            type: ev.type,
            snippet: makeSnippet(s, needleLower),
          });
          break;
        }
      }
    }
  }

  return { matches };
}

/**
 * Read-only session chain reader for desktop replay (`session/read`).
 */
export function readSessionEvents(home: string, threadId: string): SessionReadResult {
  if (!isValidId(threadId)) {
    throw invalidParams(["threadId must match the id grammar"]);
  }
  const path = confinedPath(home, "sessions", threadId, ".jsonl");
  if (!existsSync(path)) {
    throw threadNotFound(threadId);
  }
  const verified = verifySessionFile(path, threadId, {}, home);
  return {
    threadId,
    events: verified.ok ? verified.events : [],
    chainOk: verified.ok,
  };
}
