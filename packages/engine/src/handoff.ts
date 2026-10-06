/**
 * M2 pin §2.1 "A one-way link is not a handoff" and §7 (doctor): the two-way link check a v2
 * engine runs on a handoff TARGET before its first `turn/start` and on every `thread/resume`, and
 * the read-only findings a verifier reports over one session file — handoff state from either
 * side, duplicate ids, a second terminal record (Copilot 4160774801 on #46), evidence refs
 * (same-file, cross-file and `git`), the close-time worktree, and a v2 thread never closed. M2-A4
 * (`docs/plan/PIN-madc-M2-brief-delivery.md`) adds the brief read a target's next `turn/start`
 * serves, and doctor's `brief-unserved` finding and served-marker check.
 *
 * Directional, per Copilot 4160774858 on #46: a target whose source cannot be read is
 * `handoff-unverifiable` and may NOT serve (the engine refuses `-32010 handoff-one-way`); a source
 * whose target cannot be read serves as today and doctor WARNs. Nothing here writes.
 */
import { join } from "node:path";
import { isPidAlive, readLock } from "./lock.ts";
import { defaultGitRunner, type GitRunner } from "./policy/identity.ts";
import { isValidId } from "./protocol/ids.ts";
import {
  rebuildSession,
  type SessionEvent,
  v2LineIssue,
  verifySessionFile,
} from "./session-store.ts";
import {
  type BriefServedMarker,
  briefServedPlacementIssues,
  checkV2Payload,
  type EvidenceRef,
  type SessionOpenHandoffLink,
  sessionRefPath,
  type WorktreeIdentity,
} from "./session-v2.ts";

export type SessionFindingLevel = "warn" | "fail";
/**
 * Pin §7 names, plus `handoff-terminal-conflict` (Copilot 4160774801), `not-cleanly-closed`, and
 * `integrity` (pin §7 "malformed v2 payload … FAIL (integrity)", rule 1.5) for a hash-valid line
 * whose schema-v2 payload is malformed — reported, never thrown (Copilot 4165236079); and
 * `brief-unserved` (M2 brief-delivery pin §5) for a verified target that has not served its brief.
 */
export type SessionFindingCode =
  | "integrity"
  | "brief-unserved"
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

/**
 * Read-only, confined read of another thread's chain. Never creates, locks or appends. A chain
 * counts as readable only when it verifies (envelope, seq, hashes and the v2 shapes) AND every
 * known payload rebuilds (Copilot 4165236039: the full event payload shape, M0/M1 included, is
 * validated before a chain is used by the handoff gate).
 */
function readChain(home: string, threadId: string): Chain {
  if (!isValidId(threadId)) return { ok: false, reason: "thread id is outside the id grammar" };
  const path = join(home, "sessions", `${threadId}.jsonl`);
  const v = verifySessionFile(path, threadId, {}, home);
  if (!v.ok) return { ok: false, reason: `line ${v.line}: ${v.reason} (${v.kind})` };
  try {
    rebuildSession(v.events);
  } catch (err) {
    return { ok: false, reason: `${err instanceof Error ? err.message : String(err)} (integrity)` };
  }
  return { ok: true, events: v.events };
}

function payloadOf(e: SessionEvent): Record<string, unknown> {
  return e.payload as Record<string, unknown>;
}

/** Evidence pin rule 1.6: "missing" is absent or `undefined`. */
function present(p: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(p, key) && p[key] !== undefined;
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

function unverifiableSource(
  link: SessionOpenHandoffLink,
  reason: string,
): Exclude<HandoffTargetCheck, { ok: true }> {
  return {
    ok: false,
    kind: "unverifiable",
    issues: [
      `source session ${link.sourceThreadId} cannot be read or does not verify (${reason}): the link is unverifiable (handoff-unverifiable), so this target cannot serve`,
    ],
  };
}

/**
 * §2.1 (b) and (c) checked from the TARGET against the source file. Every `ok: false` is a
 * refusal to serve (`-32010 handoff-one-way`); `kind` says which §2.1 row applies.
 */
export function checkHandoffTarget(home: string, target: HandoffTargetFacts): HandoffTargetCheck {
  const source = readChain(home, target.link.sourceThreadId);
  if (!source.ok) return unverifiableSource(target.link, source.reason);
  return checkLinkIn(source.events, target);
}

export type HandoffBriefRead =
  | { readonly ok: true; readonly brief: string }
  | Exclude<HandoffTargetCheck, { ok: true }>;

/**
 * M2 brief-delivery pin §2: the brief an unserved target's next `turn/start` serves, read from the
 * source's own `handoff.out` (hash-pinned, redacted on disk) on the SAME verified read that
 * re-checks §2.1 (b) and (c). Never from a caller and never from a cache: a link that does not
 * verify at this read yields no brief, and its issues never carry the brief text.
 */
export function readHandoffBrief(home: string, target: HandoffTargetFacts): HandoffBriefRead {
  const source = readChain(home, target.link.sourceThreadId);
  if (!source.ok) return unverifiableSource(target.link, source.reason);
  const check = checkLinkIn(source.events, target);
  if (!check.ok) return check;
  // (b) held: this is the `handoff.out` at sourceSeq with hash H, whose `brief` the verifier
  // shape-checked as a non-empty string (evidence pin rule 1.5). Fail closed regardless.
  const brief = payloadOf(source.events[target.link.sourceSeq] as SessionEvent).brief;
  if (typeof brief !== "string") {
    return {
      ok: false,
      kind: "mismatch",
      issues: [`source line ${target.link.sourceSeq} carries no brief`],
    };
  }
  return { ok: true, brief };
}

/** §2.1 (b) and (c) of `target` against the source's verified `events`. */
function checkLinkIn(
  events: readonly SessionEvent[],
  target: HandoffTargetFacts,
): HandoffTargetCheck {
  const { link } = target;
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
  lines: readonly SessionEvent[],
  deps: InspectSessionDeps = {},
): SessionFinding[] {
  const findings: SessionFinding[] = [];
  const fail = (code: SessionFindingCode, detail: string): void => {
    findings.push({ level: "fail", code, detail });
  };
  const warn = (code: SessionFindingCode, detail: string): void => {
    findings.push({ level: "warn", code, detail });
  };
  const open = lines[0];
  if (open === undefined || open.type !== "session.open") return findings;
  // Rule 1.5 / pin §7 (Copilot 4165236079): a hash-valid line whose v2 payload is malformed is a
  // FAIL `integrity` finding, and that line takes no further part — the inspection never throws
  // on a shape it was handed. (The verifier already refuses such a file; this guards a caller
  // that hands over lines it parsed itself.)
  const { threadId, seatId } = open;
  if (!isPlainRecord(open.payload)) {
    fail("integrity", "line 1: payload is not an object");
    return findings;
  }
  const openPayload = payloadOf(open);
  const events: SessionEvent[] = [];
  for (const e of lines) {
    if (!isPlainRecord(e.payload)) {
      fail("integrity", `line ${e.seq + 1}: payload is not an object`);
      continue;
    }
    const issue = v2LineIssue(e.type, payloadOf(e), { seatId: e.seatId, open: openPayload });
    if (issue !== null) {
      fail("integrity", `line ${e.seq + 1}: ${issue}`);
      if (e === open) return findings; // nothing below can be judged without a sound open
      continue;
    }
    events.push(e);
  }
  const v2Open = Object.hasOwn(openPayload, "worktree");
  const openWorktree = (openPayload.worktree ?? null) as WorktreeIdentity | null;

  // --- this thread as a handoff TARGET (§2.1 (b)/(c) against the source file)
  const link = openPayload.handoff as SessionOpenHandoffLink | null | undefined;
  let linkVerified = false;
  if (link !== undefined && link !== null) {
    const check = checkHandoffTarget(home, { threadId, seatId, genesisHash: open.hash, link });
    if (!check.ok) findings.push(targetFinding(check));
    linkVerified = check.ok;
  }

  // --- the brief (M2 brief-delivery pin §3, §5). A served marker stands only on a target's first
  // turn.start and names its own link; anything else is FAIL `integrity` (rule 1.5, read side).
  // A target whose link verifies and whose brief was not served WARNs `brief-unserved`. Details
  // name ids and seqs only, never the brief.
  const starts = events.filter((e) => e.type === "turn.start");
  starts.forEach((e, prior) => {
    const p = payloadOf(e);
    if (!present(p, "briefServed")) return;
    const shape = checkV2Payload("turn.start", p);
    const issues =
      shape.length > 0
        ? shape
        : briefServedPlacementIssues(p.briefServed as BriefServedMarker, link, prior);
    if (issues.length > 0) {
      fail("integrity", `line ${e.seq + 1}: ${issues.map((i) => i.issue).join("; ")}`);
    }
  });
  if (link !== undefined && link !== null && linkVerified) {
    const where = `handoff ${link.handoffId} (source ${link.sourceThreadId} seq ${link.sourceSeq})`;
    const first = starts[0];
    if (first === undefined) {
      warn(
        "brief-unserved",
        `${where}: no turn.start yet; this target's next turn/start serves it`,
      );
    } else if (!present(payloadOf(first), "briefServed")) {
      warn(
        "brief-unserved",
        `${where}: the first turn.start (seq ${first.seq}) carries no briefServed; the brief was never served`,
      );
    }
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
        // Argus P12 (pin §2.3 `:199`, D-M2-A0-4): a same-file ref must name a seq BELOW its own
        // line. A writer can never produce one at or after it (a line cannot cite a hash that
        // depends on itself), so it is a wrong cited hash, not a fact doctor could not establish.
        if (ref.seq >= e.seq) {
          fail(
            "evidence-ref-mismatch",
            `${where}: ${ref.path} seq ${ref.seq} is not below this line's seq ${e.seq}`,
          );
          return;
        }
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

  // --- reserved tool.call receipts (pin §4.2; Argus P22 option (a), Copilot r4168208974): `call`
  // and a non-null `result` are same-file refs to `item` lines. Nothing legitimate writes the type
  // before M4 (D-M2-A0-2), so a ref that does not resolve to an `item` line with that hash is a
  // wrong cited hash: FAIL `evidence-ref-mismatch`.
  for (const e of events) {
    if ((e.type as string) !== "tool.call") continue;
    const p = payloadOf(e);
    const pairs: Array<[string, unknown]> = [
      ["call", p.call],
      ["result", p.result],
    ];
    for (const [name, ref] of pairs) {
      if (!isPlainRecord(ref)) continue; // `result: null` (denied before it ran); shape is verify's
      const line = events.find((l) => l.seq === ref.seq);
      if (line === undefined || line.type !== "item" || line.hash !== ref.hash) {
        fail(
          "evidence-ref-mismatch",
          `tool.call at seq ${e.seq} ${name}: seq ${String(ref.seq)} is not an item line with the cited hash`,
        );
        continue;
      }
      // Copilot r4174562336 / Argus PR #48 r1 K3 (pin §4.2 :264, :267-268): `call` names the
      // `item` line that holds the `toolCall` whose id is the receipt's `callId`, and `result` the
      // line that holds that call's `toolResult` (its `callId`). Any other item is a wrong cited
      // line. The detail never echoes the caller's ids.
      const item = payloadOf(line).item;
      const kind = name === "call" ? "toolCall" : "toolResult";
      const linked =
        isPlainRecord(item) &&
        item.kind === kind &&
        typeof p.callId === "string" &&
        (name === "call" ? item.id : item.callId) === p.callId;
      if (!linked) {
        fail(
          "evidence-ref-mismatch",
          `tool.call at seq ${e.seq} ${name}: seq ${String(ref.seq)} is not the ${kind} item of the receipt's callId`,
        );
      }
    }
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
