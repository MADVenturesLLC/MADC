/**
 * M2-A6 Founder Decision Inbox (`docs/plan/PIN-madc-M2-founder-decision-inbox.md` §4.2):
 * read-only scan of `$MADC_HOME/sessions/*.jsonl` returning every open `founderDecision` across
 * verified session chains, in deterministic `(ts, threadId, seq)` order.
 *
 * Read-only: never creates directories, takes locks, or modifies session files. Any file that fails
 * `verifySessionFile` or `rebuildSession` is skipped (reported to `onSkipped`) and never
 * contributes a decision.
 */
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { isStrictlyUnder } from "./home.ts";
import { isValidId } from "./protocol/ids.ts";
import type { OpenDecisionSummary } from "./protocol/types.ts";
import {
  type EvidenceRef,
  type FounderDecisionPayload,
  type FounderDecisionResolvedPayload,
  rebuildSession,
  type SessionEvent,
  verifySessionFile,
} from "./session-store.ts";

export type { OpenDecisionSummary } from "./protocol/types.ts";

function copyEvidenceRef(ref: EvidenceRef): EvidenceRef {
  return ref.kind === "git"
    ? { kind: "git", sha: ref.sha, remote: ref.remote }
    : { kind: ref.kind, path: ref.path, seq: ref.seq, hash: ref.hash };
}

/**
 * Extract open `founderDecision` records from a single verified, rebuilt session event chain.
 * A `founderDecision` is closed only by a subsequent `founderDecision.resolved` in the same chain
 * whose `decisionId`, `decisionSeq`, and `decisionHash` match the `founderDecision` line (and whose
 * `resolution` equals `recommendedDefault` when `outcome === "accepted-default"`).
 */
export function openDecisionsInChain(events: readonly SessionEvent[]): OpenDecisionSummary[] {
  const origins = new Map<string, SessionEvent<"founderDecision">>();
  const resolved = new Set<string>();
  for (const e of events) {
    if (e.type === "founderDecision") {
      const p = e.payload as FounderDecisionPayload;
      if (!origins.has(p.decisionId)) {
        origins.set(p.decisionId, e as SessionEvent<"founderDecision">);
      }
    } else if (e.type === "founderDecision.resolved") {
      const p = e.payload as FounderDecisionResolvedPayload;
      const origin = origins.get(p.decisionId);
      if (origin === undefined || origin.seq >= e.seq || resolved.has(p.decisionId)) continue;
      if (p.decisionSeq !== origin.seq || p.decisionHash !== origin.hash) continue;
      if (p.outcome === "accepted-default" && p.resolution !== origin.payload.recommendedDefault) {
        continue;
      }
      resolved.add(p.decisionId);
    }
  }
  const out: OpenDecisionSummary[] = [];
  for (const [decisionId, e] of origins) {
    if (resolved.has(decisionId)) continue;
    const p = e.payload;
    out.push({
      threadId: e.threadId,
      seatId: e.seatId,
      seq: e.seq,
      hash: e.hash,
      ts: e.ts,
      decisionId: p.decisionId,
      turnId: p.turnId,
      question: p.question,
      recommendedDefault: p.recommendedDefault,
      evidenceRefs: p.evidenceRefs.map(copyEvidenceRef),
    });
  }
  return out;
}

/**
 * Scan `$MADC_HOME/sessions/*.jsonl` and return all open `founderDecision` summaries across
 * verified session files, sorted deterministically by `(ts, threadId, seq)`.
 */
export function listOpenDecisions(
  home: string,
  onSkipped?: (threadId: string, reason: string) => void,
): OpenDecisionSummary[] {
  const dir = join(home, "sessions");
  let realHome: string;
  let realDir: string;
  let names: string[];
  try {
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) return [];
    realHome = realpathSync(home);
    realDir = realpathSync(dir);
    if (!isStrictlyUnder(realDir, realHome)) return [];
    names = readdirSync(realDir).sort();
  } catch {
    return [];
  }
  const open: OpenDecisionSummary[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const threadId = name.slice(0, -".jsonl".length);
    if (!isValidId(threadId)) continue;
    const path = join(realDir, `${threadId}.jsonl`);
    if (!isStrictlyUnder(path, realHome)) continue;
    const verified = verifySessionFile(path, threadId, {}, home);
    if (!verified.ok) {
      onSkipped?.(threadId, "session failed verification");
      continue;
    }
    try {
      rebuildSession(verified.events);
    } catch {
      onSkipped?.(threadId, "session could not be rebuilt");
      continue;
    }
    open.push(...openDecisionsInChain(verified.events));
  }
  open.sort(
    (a, b) =>
      a.ts - b.ts || (a.threadId < b.threadId ? -1 : a.threadId > b.threadId ? 1 : a.seq - b.seq),
  );
  return open;
}
