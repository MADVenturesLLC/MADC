/**
 * M2 pin §2.1 "A one-way link is not a handoff" and §7 (doctor): the two-way link check a v2
 * engine runs on a handoff TARGET before its first `turn/start` and on every `thread/resume`, and
 * the read-only findings a verifier reports over one session file — handoff state from either
 * side, duplicate ids, a second terminal record (Copilot 4160774801 on #46), evidence refs
 * (same-file, cross-file and `git`), the close-time worktree, and a v2 thread never closed.
 *
 * Directional, per Copilot 4160774858 on #46: a target whose source cannot be read is
 * `handoff-unverifiable` and may NOT serve (the engine refuses `-32010 handoff-one-way`); a source
 * whose target cannot be read serves as today and doctor WARNs. Nothing here writes.
 */
import { join } from "node:path";
import { isPidAlive, readLock } from "./lock.ts";
import { defaultGitRunner, type GitRunner } from "./policy/identity.ts";
import { isValidId } from "./protocol/ids.ts";
import { type SessionEvent, verifySessionFile } from "./session-store.ts";
import {
  type EvidenceRef,
  type SessionOpenHandoffLink,
  sessionRefPath,
  type WorktreeIdentity,
} from "./session-v2.ts";

export type SessionFindingLevel = "warn" | "fail";
/** Pin §7 names (plus `handoff-terminal-conflict`, Copilot 4160774801, and `not-cleanly-closed`). */
export type SessionFindingCode =
  | "handoff-mismatch"
  | "handoff-terminal-conflict"
  | "evidence-ref-mismatch"
  | "duplicate-id"
  | "handoff-incomplete"
  | "handoff-unverifiable"
  | "evidence-ref-unresolved"
  | "worktree-head-unreadable"
  | "not-cleanly-closed";
/** `detail` names seqs, ids and files — never a `brief`, a `question` or any payload text. */
export type SessionFinding = {
  readonly level: SessionFindingLevel;
  readonly code: SessionFindingCode;
  readonly detail: string;
};

/** What the target side knows about itself when it checks its link. */
export type HandoffTargetFacts = {
  readonly threadId: string;
  readonly seatId: string;
  /** The target file's seq-0 hash (G). */
  readonly genesisHash: string;
  readonly link: SessionOpenHandoffLink;
};

export type HandoffTargetCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /** §2.1 state table rows: in progress / crash (`one-way`), closed attempt (`aborted`), tampering (`mismatch`), other file unreadable (`unverifiable`). */
      readonly kind: "one-way" | "aborted" | "mismatch" | "unverifiable";
      readonly issues: string[];
    };

type Chain = { ok: true; events: readonly SessionEvent[] } | { ok: false; reason: string };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Read-only, confined read of another thread's chain. Never creates, locks or appends. */
function readChain(home: string, threadId: string): Chain {
  if (!isValidId(threadId)) return { ok: false, reason: "thread id is outside the id grammar" };
  const path = join(home, "sessions", `${threadId}.jsonl`);
  const v = verifySessionFile(path, threadId, {}, home);
  if (!v.ok) return { ok: false, reason: `line ${v.line}: ${v.reason} (${v.kind})` };
  return { ok: true, events: v.events };
}

function payloadOf(e: SessionEvent): Record<string, unknown> {
  return e.payload as Record<string, unknown>;
}

/** The terminal records (`handoff.link` / `handoff.aborted`) naming `handoffId` after seq `after`. */
function terminalsFor(
  events: readonly SessionEvent[],
  handoffId: string,
  after: number,
): SessionEvent[] {
  return events.filter(
    (e) =>
      e.seq > after &&
      (e.type === "handoff.link" || e.type === "handoff.aborted") &&
      payloadOf(e).handoffId === handoffId,
  );
}

/**
 * §2.1 (b) and (c) checked from the TARGET against the source file. Every `ok: false` is a
 * refusal to serve (`-32010 handoff-one-way`); `kind` says which §2.1 row applies.
 */
export function checkHandoffTarget(home: string, target: HandoffTargetFacts): HandoffTargetCheck {
  const { link } = target;
  const source = readChain(home, link.sourceThreadId);
  if (!source.ok) {
    return {
      ok: false,
      kind: "unverifiable",
      issues: [
        `source session ${link.sourceThreadId} cannot be read or does not verify (${source.reason}): the link is unverifiable (handoff-unverifiable), so this target cannot serve`,
      ],
    };
  }
  const events = source.events;
  const issues: string[] = [];
  const out = events[link.sourceSeq];
  if (out === undefined) {
    issues.push(`source line ${link.sourceSeq} does not exist`);
  } else {
    const p = payloadOf(out);
    if (out.type !== "handoff.out") {
      issues.push(`source line ${link.sourceSeq} is ${out.type}, not handoff.out`);
    }
    if (out.hash !== link.sourceHash) {
      issues.push(`source line ${link.sourceSeq} hash differs from the recorded sourceHash`);
    }
    if (out.seatId !== link.sourceSeatId) {
      issues.push("source seat differs from the recorded sourceSeatId");
    }
    if (p.handoffId !== link.handoffId) {
      issues.push(`source line ${link.sourceSeq} handoffId differs from the recorded handoffId`);
    }
    if (p.targetSeatId !== target.seatId) {
      issues.push(`source line ${link.sourceSeq} targetSeatId is not this thread's seat`);
    }
  }
  if (issues.length > 0) return { ok: false, kind: "mismatch", issues };
  const terminals = terminalsFor(events, link.handoffId, link.sourceSeq);
  if (terminals.length === 0) {
    return {
      ok: false,
      kind: "one-way",
      issues: [
        `source session ${link.sourceThreadId} has no handoff.link or handoff.aborted for handoff ${link.handoffId} (handoff-incomplete)`,
      ],
    };
  }
  if (terminals.length > 1) {
    return {
      ok: false,
      kind: "mismatch",
      issues: [
        `source session ${link.sourceThreadId} has ${terminals.length} terminal records for handoff ${link.handoffId} (handoff-terminal-conflict)`,
      ],
    };
  }
  const terminal = terminals[0] as SessionEvent;
  const tp = payloadOf(terminal);
  if (terminal.type === "handoff.aborted") {
    return {
      ok: false,
      kind: "aborted",
      issues: [
        `source session ${link.sourceThreadId} recorded handoff.aborted (${String(tp.reason)}) for handoff ${link.handoffId}: this target is orphaned`,
      ],
    };
  }
  if (tp.targetThreadId !== target.threadId) {
    issues.push(`source handoff.link (seq ${terminal.seq}) names another targetThreadId`);
  }
  if (tp.targetSeatId !== target.seatId) {
    issues.push(`source handoff.link (seq ${terminal.seq}) names another targetSeatId`);
  }
  if (tp.targetGenesisHash !== target.genesisHash) {
    issues.push(
      `source handoff.link (seq ${terminal.seq}) targetGenesisHash differs from this file's seq-0 hash`,
    );
  }
  if (issues.length > 0) return { ok: false, kind: "mismatch", issues };
  return { ok: true };
}

function targetFinding(check: Exclude<HandoffTargetCheck, { ok: true }>): SessionFinding {
  const detail = check.issues.join("; ");
  switch (check.kind) {
    case "mismatch":
      return { level: "fail", code: "handoff-mismatch", detail };
    case "unverifiable":
      return { level: "warn", code: "handoff-unverifiable", detail };
    case "one-way":
    case "aborted":
      return { level: "warn", code: "handoff-incomplete", detail };
  }
}

/** Lock liveness for the pin §7 "not cleanly closed" row: a missing, dead or unreadable lock is not live. */
function lockIsLive(home: string, threadId: string): boolean {
  try {
    const lock = readLock(join(home, "sessions", `${threadId}.lock`));
    return lock.state === "held" && isPidAlive(lock.pid);
  } catch {
    return false;
  }
}

export type InspectSessionDeps = {
  /** Test seam for `git cat-file -e` (default: the engine's own runner). */
  readonly runGit?: GitRunner;
};

/**
 * Pin §7: the v2 findings over one VERIFIED chain (`events` from `verifySessionFile`). FAIL means
 * a link or a cited hash is wrong; WARN means a fact could not be established. Read-only: it never
 * edits, repairs or deletes a file (Amendment 2 §5; Amendment 3 §2).
 */
export function inspectSessionV2(
  home: string,
  events: readonly SessionEvent[],
  deps: InspectSessionDeps = {},
): SessionFinding[] {
  const findings: SessionFinding[] = [];
  const open = events[0];
  if (open === undefined || open.type !== "session.open") return findings;
  const { threadId, seatId } = open;
  const openPayload = payloadOf(open);
  const v2Open = Object.hasOwn(openPayload, "worktree");
  const openWorktree = (openPayload.worktree ?? null) as WorktreeIdentity | null;
  const fail = (code: SessionFindingCode, detail: string): void => {
    findings.push({ level: "fail", code, detail });
  };
  const warn = (code: SessionFindingCode, detail: string): void => {
    findings.push({ level: "warn", code, detail });
  };

  // --- this thread as a handoff TARGET (§2.1 (b)/(c) against the source file)
  const link = openPayload.handoff;
  if (link !== undefined && link !== null) {
    const check = checkHandoffTarget(home, {
      threadId,
      seatId,
      genesisHash: open.hash,
      link: link as SessionOpenHandoffLink,
    });
    if (!check.ok) findings.push(targetFinding(check));
  }

  // --- this thread as a handoff SOURCE
  const outs = new Map<string, SessionEvent>();
  const terminals = new Map<string, SessionEvent[]>();
  for (const e of events) {
    const id = payloadOf(e).handoffId;
    if (typeof id !== "string") continue;
    if (e.type === "handoff.out") {
      if (outs.has(id)) fail("duplicate-id", `handoff.out at seq ${e.seq} reuses handoffId ${id}`);
      else outs.set(id, e);
    } else if (e.type === "handoff.link" || e.type === "handoff.aborted") {
      const list = terminals.get(id) ?? [];
      list.push(e);
      terminals.set(id, list);
    }
  }
  for (const [id, list] of terminals) {
    if (!outs.has(id)) {
      fail(
        "handoff-mismatch",
        `${list[0]?.type} at seq ${list[0]?.seq} names handoff ${id}, which has no handoff.out`,
      );
    }
  }
  for (const [id, out] of outs) {
    const list = (terminals.get(id) ?? []).filter((e) => e.seq > out.seq);
    if (list.length === 0) {
      warn(
        "handoff-incomplete",
        `handoff ${id} (handoff.out at seq ${out.seq}) has no handoff.link or handoff.aborted`,
      );
      continue;
    }
    if (list.length > 1) {
      fail(
        "handoff-terminal-conflict",
        `handoff ${id} has ${list.length} terminal records (seqs ${list.map((e) => e.seq).join(", ")}); exactly one handoff.link or handoff.aborted is allowed`,
      );
      continue;
    }
    const terminal = list[0] as SessionEvent;
    if (terminal.type === "handoff.aborted") continue; // a recorded failure: OK
    const lp = payloadOf(terminal);
    const targetThreadId = String(lp.targetThreadId);
    const target = readChain(home, targetThreadId);
    if (!target.ok) {
      warn(
        "handoff-unverifiable",
        `handoff ${id}: target session ${targetThreadId} cannot be read or does not verify (${target.reason})`,
      );
      continue;
    }
    const genesis = target.events[0] as SessionEvent;
    const th = payloadOf(genesis).handoff;
    const issues: string[] = [];
    if (genesis.hash !== lp.targetGenesisHash) {
      issues.push("target seq-0 hash differs from handoff.link targetGenesisHash");
    }
    if (genesis.seatId !== lp.targetSeatId || genesis.seatId !== payloadOf(out).targetSeatId) {
      issues.push("target seat differs from the recorded targetSeatId");
    }
    if (
      !isPlainRecord(th) ||
      th.sourceThreadId !== threadId ||
      th.sourceSeatId !== seatId ||
      th.handoffId !== id ||
      th.sourceSeq !== out.seq ||
      th.sourceHash !== out.hash
    ) {
      issues.push("target session.open.handoff does not name this handoff.out by seq and hash");
    }
    if (issues.length > 0) {
      fail("handoff-mismatch", `handoff ${id} → ${targetThreadId}: ${issues.join("; ")}`);
    }
  }

  // --- founderDecision: unique ids, evidence refs resolved (§3)
  const runGit = deps.runGit ?? defaultGitRunner;
  const selfPath = sessionRefPath(threadId);
  const decisions = new Set<string>();
  const chains = new Map<string, Chain>();
  const chainOf = (id: string): Chain => {
    let c = chains.get(id);
    if (c === undefined) {
      c = readChain(home, id);
      chains.set(id, c);
    }
    return c;
  };
  for (const e of events) {
    if (e.type !== "founderDecision") continue;
    const p = payloadOf(e);
    const id = String(p.decisionId);
    if (decisions.has(id))
      fail("duplicate-id", `founderDecision at seq ${e.seq} reuses decisionId ${id}`);
    decisions.add(id);
    const refs = Array.isArray(p.evidenceRefs) ? (p.evidenceRefs as EvidenceRef[]) : [];
    refs.forEach((ref, i) => {
      const where = `founderDecision ${id} evidenceRefs[${i}]`;
      if (ref.kind === "git") {
        if (openWorktree === null) {
          warn(
            "evidence-ref-unresolved",
            `${where}: git ${ref.sha} cannot be resolved (no worktree recorded)`,
          );
          return;
        }
        const probe = runGit(["cat-file", "-e", ref.sha], openWorktree.topLevel);
        if (probe.code !== 0) {
          warn(
            "evidence-ref-unresolved",
            `${where}: git ${ref.sha} not found in ${openWorktree.topLevel}`,
          );
        }
        return;
      }
      let lines: readonly SessionEvent[];
      if (ref.path === selfPath) {
        lines = events;
      } else {
        const other = chainOf(ref.path.slice("sessions/".length, -".jsonl".length));
        if (!other.ok) {
          warn(
            "evidence-ref-unresolved",
            `${where}: ${ref.path} cannot be read or does not verify (${other.reason})`,
          );
          return;
        }
        lines = other.events;
      }
      const line = lines[ref.seq];
      if (line === undefined) {
        warn("evidence-ref-unresolved", `${where}: ${ref.path} has no line at seq ${ref.seq}`);
        return;
      }
      if (line.hash !== ref.hash) {
        fail(
          "evidence-ref-mismatch",
          `${where}: ${ref.path} seq ${ref.seq} hash differs from the cited hash`,
        );
      } else if (ref.kind === "servedModel" && line.type !== "servedModel") {
        fail(
          "evidence-ref-mismatch",
          `${where}: ${ref.path} seq ${ref.seq} is ${line.type}, not servedModel`,
        );
      }
    });
  }

  // --- worktree at close (§2.2) and the clean-close rule (D-M2-A0-5), v2 files only
  for (const e of events) {
    if (e.type !== "session.close") continue;
    if (openWorktree !== null && payloadOf(e).worktree === null) {
      warn(
        "worktree-head-unreadable",
        `session.close at seq ${e.seq} could not re-read HEAD at ${openWorktree.topLevel}`,
      );
    }
  }
  const last = events[events.length - 1];
  if (
    v2Open &&
    last !== undefined &&
    last.type !== "session.close" &&
    !lockIsLive(home, threadId)
  ) {
    warn(
      "not-cleanly-closed",
      `no session.close after seq ${last.seq} and the thread lock is not live`,
    );
  }
  return findings;
}
