/**
 * M2 evidence schema v2 (`docs/plan/PIN-madc-M2-evidence-schema-v2.md`, merged as M2-A0, #46):
 * the pinned shapes of the room events (§2), `EvidenceRef` (§3), the reserved M4 receipts (§4),
 * the write-time validator (rule 1.5: checked BEFORE redaction and hashing, nothing appended on a
 * fault), the structural-field rule redaction must respect (Copilot 4160774703 on #46), and the
 * chain index a writer keeps so same-file evidence refs resolve at write time (D-M2-A0-4) and a
 * second terminal record for one handoff is refused (Copilot 4160774801 on #46).
 *
 * Pure: no I/O and no import of the session store, so the store can import this module without a
 * cycle. The envelope and the hash formula are untouched (rules 1.1, 1.2; D-M2-A0-6).
 */
import { isAbsolute } from "node:path";
import { normalizeRemote } from "@madc/registry";
import type { EvidenceRefusal } from "./protocol/errors.ts";
import { isValidId } from "./protocol/ids.ts";
import { memoryPathIssue } from "./seat.ts";

// ------------------------------------------------------------------ §2 shapes

/** §2.2: engine-owned identity of the git work tree a thread runs in. Never caller-supplied. */
export type WorktreeIdentity = {
  /** Absolute realpath of the git top-level that contains the thread's cwd (seat pin §5). */
  topLevel: string;
  /** Normalized `origin` remote (seat pin §5), or null when absent or its endpoints disagree. */
  remote: string | null;
  /** `HEAD` at that top-level, 40 lowercase hex; null only for an unborn branch. */
  head: string | null;
};

/** §2.1 step 2: the additive `handoff` field of a handoff TARGET's `session.open`. */
export type SessionOpenHandoffLink = {
  sourceThreadId: string;
  sourceSeatId: string;
  handoffId: string;
  /** seq of the source `handoff.out` line. */
  sourceSeq: number;
  /** That line's hash (H), 64 lowercase hex. */
  sourceHash: string;
};

/** §2.1 step 1 (source chain). */
export type HandoffOutPayload = {
  handoffId: string;
  /** The source turn that raised the handoff; null when the operator raised it between turns. */
  turnId: string | null;
  targetSeatId: string;
  /** The work handed over, verbatim; non-empty after trim. */
  brief: string;
};

/** §2.1 step 3 (source chain). */
export type HandoffLinkPayload = {
  handoffId: string;
  targetThreadId: string;
  targetSeatId: string;
  /** The target file's seq-0 hash (G), 64 lowercase hex. */
  targetGenesisHash: string;
};

export type HandoffAbortReason =
  | "target-open-failed"
  | "target-genesis-unavailable"
  | "interrupted";
export const HANDOFF_ABORT_REASONS: readonly HandoffAbortReason[] = Object.freeze([
  "target-open-failed",
  "target-genesis-unavailable",
  "interrupted",
]);

/** §2.1 (D-M2-A0-3): written instead of `handoff.link` when step 2 did not complete. */
export type HandoffAbortedPayload = {
  handoffId: string;
  reason: HandoffAbortReason;
  error: { code: number; message: string } | null;
};

/** §3: the one reference type every evidence-bearing field uses. */
export type EvidenceRef =
  | { kind: "session"; path: string; seq: number; hash: string }
  | { kind: "servedModel"; path: string; seq: number; hash: string }
  | { kind: "git"; sha: string; remote: string | null };

/** §2.3: the escalation, never the answer. */
export type FounderDecisionPayload = {
  decisionId: string;
  turnId: string;
  question: string;
  /** Exactly one; non-empty after trim. */
  recommendedDefault: string;
  /** At least one; each well-formed under §3; same-file refs resolved at write time. */
  evidenceRefs: EvidenceRef[];
};

// ------------------------------------------------------------- §4 reserved (M4)

/** §4.1: defined here, not stored — no engine writes it before the M4 pin. */
export type MemoryWritePayload = {
  turnId: string;
  path: string;
  op: "append";
  bytes: number;
  contentSha256: string;
  requestedModel: string;
  servedModel: string;
  providerId: string;
  lane: string;
  vendorReported: boolean;
};

/** §4.2: defined here, not stored — no engine writes it before the M4 pin. */
export type ToolCallReceiptPayload = {
  turnId: string;
  callId: string;
  name: string;
  server: string | null;
  call: { seq: number; hash: string };
  result: { seq: number; hash: string } | null;
  decision: "allowed" | "denied";
  reason: string | null;
};

/** The four §2 event types this act's writer can append. */
export type V2EventType = "handoff.out" | "handoff.link" | "handoff.aborted" | "founderDecision";
export const V2_EVENT_TYPES: readonly V2EventType[] = Object.freeze([
  "handoff.out",
  "handoff.link",
  "handoff.aborted",
  "founderDecision",
]);

/**
 * §4 / §10 item 8: reserved names. The verifier validates their shape when it meets one in a file
 * (D-M2-A0-2); the writer refuses them with `-32010 reserved`. A guard test fails if either name
 * enters the writable set before the M4 pin.
 */
export type ReservedEventType = "memory.write" | "tool.call";
export const RESERVED_EVENT_TYPES: readonly ReservedEventType[] = Object.freeze([
  "memory.write",
  "tool.call",
]);

// ----------------------------------------------------------------- validation

/** One validation fault: the pinned refusal reason and a human-readable field-level issue. */
export type ShapeIssue = { readonly reason: EvidenceRefusal; readonly issue: string };

const HEX64 = /^[0-9a-f]{64}$/;
const SHA40 = /^[0-9a-f]{40}$/;
/** §3: `sessions/<threadId>.jsonl`, relative to `$MADC_HOME`, `<threadId>` in the id grammar. */
const SESSION_REF_PATH = /^sessions\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\.jsonl$/;
const LANE_STATUSES: readonly unknown[] = [
  "allowed-direct",
  "allowed-via-vendor-agent",
  "interactive-only",
  "forbidden",
];

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
const isStr = (v: unknown): v is string => typeof v === "string";
const isNonEmpty = (v: unknown): v is string => isStr(v) && v.trim() !== "";
const isHex64 = (v: unknown): v is string => isStr(v) && HEX64.test(v);
const isSha40 = (v: unknown): v is string => isStr(v) && SHA40.test(v);
const isSeq = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
/** Rule 1.6: "missing" is absent or `undefined`; `null` is a value. */
const present = (p: Record<string, unknown>, key: string): boolean =>
  Object.hasOwn(p, key) && p[key] !== undefined;
/** A normalized remote (seat pin §5) is its own normalization. */
const isNormalizedRemote = (v: unknown): v is string => {
  if (!isStr(v)) return false;
  const n = normalizeRemote(v);
  return n.ok && n.remote === v;
};

const missing = (field: string): ShapeIssue => ({
  reason: "field-missing",
  issue: `${field} is required`,
});
const invalid = (field: string, why: string): ShapeIssue => ({
  reason: "field-invalid",
  issue: `${field} ${why}`,
});

/** A field that must be present (rule 1.6) and satisfy `ok`. */
function field(
  p: Record<string, unknown>,
  name: string,
  ok: (v: unknown) => boolean,
  why: string,
  out: ShapeIssue[],
  prefix = "",
): void {
  const label = `${prefix}${name}`;
  if (!present(p, name)) out.push(missing(label));
  else if (!ok(p[name])) out.push(invalid(label, why));
}

/** §3 well-formedness of one `EvidenceRef` (every fault is `evidence-ref-invalid`). */
export function checkEvidenceRef(ref: unknown, where: string): ShapeIssue[] {
  const bad = (why: string): ShapeIssue => ({
    reason: "evidence-ref-invalid",
    issue: `${where} ${why}`,
  });
  if (!isPlainRecord(ref)) return [bad("must be an object")];
  const out: ShapeIssue[] = [];
  const kind = ref.kind;
  if (kind === "session" || kind === "servedModel") {
    if (!isStr(ref.path) || !SESSION_REF_PATH.test(ref.path)) {
      out.push(bad("path must be sessions/<threadId>.jsonl"));
    }
    if (!isSeq(ref.seq)) out.push(bad("seq must be a non-negative integer"));
    if (!isHex64(ref.hash)) out.push(bad("hash must be 64 lowercase hex"));
    return out;
  }
  if (kind === "git") {
    if (!isSha40(ref.sha)) out.push(bad("sha must be 40 lowercase hex"));
    if (!present(ref, "remote")) out.push(bad("remote is required (null allowed)"));
    else if (ref.remote !== null && !isNormalizedRemote(ref.remote)) {
      out.push(bad("remote must be a normalized remote or null"));
    }
    return out;
  }
  return [bad('kind must be "session", "servedModel" or "git"')];
}

/** §2.2 `WorktreeIdentity | null`. */
export function checkWorktreeIdentity(v: unknown, where: string): ShapeIssue[] {
  if (v === null) return [];
  if (!isPlainRecord(v)) return [invalid(where, "must be an object or null")];
  const out: ShapeIssue[] = [];
  const at = `${where}.`;
  field(v, "topLevel", (x) => isStr(x) && isAbsolute(x), "must be an absolute path", out, at);
  if (!present(v, "remote")) out.push(missing(`${at}remote`));
  else if (v.remote !== null && !isNormalizedRemote(v.remote)) {
    out.push(invalid(`${at}remote`, "must be a normalized remote or null"));
  }
  if (!present(v, "head")) out.push(missing(`${at}head`));
  else if (v.head !== null && !isSha40(v.head)) {
    out.push(invalid(`${at}head`, "must be 40 lowercase hex or null"));
  }
  return out;
}

/** §2.1 step 2: `session.open.handoff` (`SessionOpenHandoffLink | null`). */
export function checkHandoffLink(v: unknown, where = "handoff"): ShapeIssue[] {
  if (v === null) return [];
  if (!isPlainRecord(v)) return [invalid(where, "must be an object or null")];
  const out: ShapeIssue[] = [];
  const at = `${where}.`;
  field(v, "sourceThreadId", isValidId, "must match the id grammar", out, at);
  field(v, "sourceSeatId", isValidId, "must match the id grammar", out, at);
  field(v, "handoffId", isValidId, "must match the id grammar", out, at);
  field(v, "sourceSeq", isSeq, "must be a non-negative integer", out, at);
  field(v, "sourceHash", isHex64, "must be 64 lowercase hex", out, at);
  return out;
}

function checkHandoffOut(p: Record<string, unknown>): ShapeIssue[] {
  const out: ShapeIssue[] = [];
  field(p, "handoffId", isValidId, "must match the id grammar", out);
  if (!present(p, "turnId")) out.push(missing("turnId"));
  else if (p.turnId !== null && !isValidId(p.turnId)) {
    out.push(invalid("turnId", "must match the id grammar or be null"));
  }
  field(p, "targetSeatId", isValidId, "must match the id grammar", out);
  field(p, "brief", isNonEmpty, "must be a non-empty string", out);
  return out;
}

function checkHandoffLinkPayload(p: Record<string, unknown>): ShapeIssue[] {
  const out: ShapeIssue[] = [];
  field(p, "handoffId", isValidId, "must match the id grammar", out);
  field(p, "targetThreadId", isValidId, "must match the id grammar", out);
  field(p, "targetSeatId", isValidId, "must match the id grammar", out);
  field(p, "targetGenesisHash", isHex64, "must be 64 lowercase hex", out);
  return out;
}

function checkHandoffAborted(p: Record<string, unknown>): ShapeIssue[] {
  const out: ShapeIssue[] = [];
  field(p, "handoffId", isValidId, "must match the id grammar", out);
  field(
    p,
    "reason",
    (v) => (HANDOFF_ABORT_REASONS as readonly unknown[]).includes(v),
    `must be one of ${HANDOFF_ABORT_REASONS.join(", ")}`,
    out,
  );
  if (!present(p, "error")) out.push(missing("error"));
  else if (p.error !== null) {
    const e = p.error;
    if (!isPlainRecord(e) || typeof e.code !== "number" || !isStr(e.message)) {
      out.push(invalid("error", "must be { code: number, message: string } or null"));
    }
  }
  return out;
}

function checkFounderDecision(p: Record<string, unknown>): ShapeIssue[] {
  const out: ShapeIssue[] = [];
  // Evidence first (§2.3 "Evidence or nothing"): absent or empty is its own pinned reason.
  const refs = p.evidenceRefs;
  if (!present(p, "evidenceRefs") || !Array.isArray(refs) || refs.length === 0) {
    out.push({ reason: "evidence-ref-missing", issue: "evidenceRefs must list at least one ref" });
  } else {
    refs.forEach((ref: unknown, i) => {
      out.push(...checkEvidenceRef(ref, `evidenceRefs[${i}]`));
    });
  }
  field(p, "decisionId", isValidId, "must match the id grammar", out);
  field(p, "turnId", isValidId, "must match the id grammar", out);
  field(p, "question", isNonEmpty, "must be a non-empty string", out);
  field(p, "recommendedDefault", isNonEmpty, "must be a non-empty string", out);
  return out;
}

/**
 * What a shape check may know beyond the payload (M2-A1 correction, Argus 5391475289 misses 2
 * and 4): the envelope seat, so a reserved `memory.write` names that seat's OWN confined memory
 * file (§4.1: "a seat writes only its own memory"), and whether the file's `session.open` is a v2
 * line, so a v2 `session.close` must carry `worktree` (§2.2) while a v1 close may stay keyless.
 */
export type ShapeContext = {
  readonly seatId?: string;
  readonly openV2?: boolean;
};

function checkMemoryWrite(p: Record<string, unknown>, ctx: ShapeContext): ShapeIssue[] {
  const out: ShapeIssue[] = [];
  field(p, "turnId", isValidId, "must match the id grammar", out);
  field(
    p,
    "path",
    (v) => isStr(v) && memoryPathIssue(v) === null,
    "must be a seat memory path",
    out,
  );
  // §4.1 (Copilot 4165236118): the seat is the envelope seatId, and its confined memory file is
  // `memory/<seatId>.md` (seats/memory.ts): another seat's file, or a nested path, is invalid.
  if (ctx.seatId !== undefined && isStr(p.path) && p.path !== `memory/${ctx.seatId}.md`) {
    out.push(
      invalid("path", `must be the envelope seat's own memory file memory/${ctx.seatId}.md`),
    );
  }
  field(p, "op", (v) => v === "append", 'must be "append"', out);
  field(p, "bytes", (v) => isSeq(v) && v > 0, "must be a positive integer", out);
  field(p, "contentSha256", isHex64, "must be 64 lowercase hex", out);
  for (const name of ["requestedModel", "servedModel", "providerId"]) {
    field(p, name, isStr, "must be a string", out);
  }
  field(p, "lane", (v) => LANE_STATUSES.includes(v), "must be a registry status", out);
  field(p, "vendorReported", (v) => typeof v === "boolean", "must be a boolean", out);
  return out;
}

function checkToolCall(p: Record<string, unknown>): ShapeIssue[] {
  const out: ShapeIssue[] = [];
  const refOk = (v: unknown): boolean => isPlainRecord(v) && isSeq(v.seq) && isHex64(v.hash);
  field(p, "turnId", isValidId, "must match the id grammar", out);
  field(p, "callId", isValidId, "must match the id grammar", out);
  field(p, "name", isStr, "must be a string", out);
  field(p, "server", (v) => v === null || isStr(v), "must be a string or null", out);
  field(p, "call", refOk, "must be { seq, hash }", out);
  field(p, "result", (v) => v === null || refOk(v), "must be { seq, hash } or null", out);
  field(
    p,
    "decision",
    (v) => v === "allowed" || v === "denied",
    'must be "allowed" or "denied"',
    out,
  );
  field(p, "reason", (v) => v === null || isStr(v), "must be a string or null", out);
  return out;
}

/**
 * The schema-v2 shape of one payload (§2–§4). For `session.open` and `session.close` only the
 * additive v2 fields are checked here: the M1 fields keep their M1 checks in the store. A
 * `session.open` with `handoff` or `worktree` but not both is a fault (§2.2 verifier rule); one
 * with neither is a v1 line. Every other M1 type has no v2 fields and reports nothing.
 */
export function checkV2Payload(
  type: string,
  p: Record<string, unknown>,
  ctx: ShapeContext = {},
): ShapeIssue[] {
  switch (type) {
    case "session.open": {
      const hasHandoff = present(p, "handoff");
      const hasWorktree = present(p, "worktree");
      if (hasHandoff !== hasWorktree) {
        return [missing(hasHandoff ? "worktree" : "handoff")];
      }
      if (!hasHandoff) return [];
      return [...checkHandoffLink(p.handoff), ...checkWorktreeIdentity(p.worktree, "worktree")];
    }
    case "session.close":
      // §2.2 (Copilot 4165236142): after a v2 open the close carries `worktree` (object or null);
      // only a v1 file's close may be keyless.
      if (!present(p, "worktree")) return ctx.openV2 === true ? [missing("worktree")] : [];
      return checkWorktreeIdentity(p.worktree, "worktree");
    case "handoff.out":
      return checkHandoffOut(p);
    case "handoff.link":
      return checkHandoffLinkPayload(p);
    case "handoff.aborted":
      return checkHandoffAborted(p);
    case "founderDecision":
      return checkFounderDecision(p);
    case "memory.write":
      return checkMemoryWrite(p, ctx);
    case "tool.call":
      return checkToolCall(p);
    default:
      return [];
  }
}

// ----------------------------------------------------------------- chain index

/** What the index keeps per chained line: enough to resolve a same-file `EvidenceRef`. */
export type ChainLine = { readonly hash: string; readonly type: string };
export type HandoffState = "open" | "linked" | "aborted";

/**
 * D-M2-A0-4: the writer holds the verified file, so it can resolve a same-file ref, refuse a
 * duplicate `handoffId` / `decisionId` (§2.1, §2.3 "unique within the file") and refuse a second
 * terminal record for one handoff (Copilot 4160774801) without re-reading the file. Built from the
 * verified events at resume, from nothing at create, and told every durable append.
 */
export class SessionChainIndex {
  readonly #lines: ChainLine[] = [];
  readonly #handoffs = new Map<string, HandoffState>();
  readonly #decisions = new Set<string>();
  /** `undefined` while no `session.open` was noted, or the open is a v1 line (no `worktree` key). */
  #openWorktree: WorktreeIdentity | null | undefined = undefined;

  static fromEvents(
    events: ReadonlyArray<{
      readonly type: string;
      readonly hash: string;
      readonly payload: unknown;
    }>,
  ): SessionChainIndex {
    const index = new SessionChainIndex();
    for (const e of events) index.note(e);
    return index;
  }

  /** An independent copy (the writer validates a batch against a shadow before it is durable). */
  clone(): SessionChainIndex {
    const copy = new SessionChainIndex();
    copy.#lines.push(...this.#lines);
    for (const [id, state] of this.#handoffs) copy.#handoffs.set(id, state);
    for (const id of this.#decisions) copy.#decisions.add(id);
    copy.#openWorktree = this.#openWorktree;
    return copy;
  }

  /** Number of chained lines, i.e. the next seq. */
  get length(): number {
    return this.#lines.length;
  }

  lineAt(seq: number): ChainLine | undefined {
    return this.#lines[seq];
  }

  handoffState(handoffId: string): HandoffState | undefined {
    return this.#handoffs.get(handoffId);
  }

  hasDecision(decisionId: string): boolean {
    return this.#decisions.has(decisionId);
  }

  /** The `worktree` the file's `session.open` recorded; `undefined` for a v1 open. */
  get openWorktree(): WorktreeIdentity | null | undefined {
    return this.#openWorktree;
  }

  /** Record one durable line (in seq order). Tolerates malformed payloads: it indexes, never judges. */
  note(e: { readonly type: string; readonly hash: string; readonly payload: unknown }): void {
    this.#lines.push({ hash: e.hash, type: e.type });
    const p = isPlainRecord(e.payload) ? e.payload : {};
    switch (e.type) {
      case "session.open":
        if (this.#lines.length === 1 && present(p, "worktree")) {
          const w = p.worktree;
          this.#openWorktree =
            w !== null && checkWorktreeIdentity(w, "worktree").length === 0
              ? (w as WorktreeIdentity)
              : null;
        }
        break;
      case "handoff.out":
        if (isStr(p.handoffId) && !this.#handoffs.has(p.handoffId)) {
          this.#handoffs.set(p.handoffId, "open");
        }
        break;
      case "handoff.link":
        if (isStr(p.handoffId)) this.#handoffs.set(p.handoffId, "linked");
        break;
      case "handoff.aborted":
        if (isStr(p.handoffId)) this.#handoffs.set(p.handoffId, "aborted");
        break;
      case "founderDecision":
        if (isStr(p.decisionId)) this.#decisions.add(p.decisionId);
        break;
      default:
        break;
    }
  }
}

// ------------------------------------------------------------- write-time rule

export type WriteRefusal = { readonly reason: EvidenceRefusal; readonly issues: string[] };

/** The same-file ref path of a thread (§3): `sessions/<threadId>.jsonl`. */
export function sessionRefPath(threadId: string): string {
  return `sessions/${threadId}.jsonl`;
}

/** The `turnId` a -32010 `data` carries: the payload's, when it is a well-formed id; else null. */
export function turnIdOf(payload: unknown): string | null {
  return isPlainRecord(payload) && isValidId(payload.turnId) ? payload.turnId : null;
}

function toRefusal(issues: readonly ShapeIssue[]): WriteRefusal | null {
  const first = issues[0];
  if (first === undefined) return null;
  return { reason: first.reason, issues: issues.map((i) => i.issue) };
}

/** D-M2-A0-4: a same-file `session` / `servedModel` ref must name a line this writer has. */
function sameFileRefIssues(
  refs: readonly unknown[],
  selfPath: string,
  index: SessionChainIndex,
): ShapeIssue[] {
  const out: ShapeIssue[] = [];
  refs.forEach((ref, i) => {
    if (!isPlainRecord(ref) || ref.path !== selfPath) return;
    if (ref.kind !== "session" && ref.kind !== "servedModel") return;
    const where = `evidenceRefs[${i}]`;
    const seq = ref.seq as number;
    const line = index.lineAt(seq);
    if (line === undefined) {
      out.push({
        reason: "evidence-ref-invalid",
        issue: `${where} names seq ${seq}, which is not below the next seq ${index.length}`,
      });
      return;
    }
    if (line.hash !== ref.hash) {
      out.push({ reason: "evidence-ref-invalid", issue: `${where} hash differs from line ${seq}` });
    }
    if (ref.kind === "servedModel" && line.type !== "servedModel") {
      out.push({
        reason: "evidence-ref-invalid",
        issue: `${where} line ${seq} is ${line.type}, not servedModel`,
      });
    }
  });
  return out;
}

/**
 * Rule 1.5: validity BEFORE the append. Reserved names refuse `reserved` (§4); a shape fault
 * refuses with the pinned reason (§2–§4 tables); a same-file ref that does not resolve, a duplicate
 * `handoffId` / `decisionId`, a terminal record without its `handoff.out` or after another
 * terminal, and a `session.close.worktree` whose `topLevel` differs from the open's refuse too.
 * `null` means the payload may be redacted, hashed and written.
 */
export function validateForWrite(
  type: string,
  payload: unknown,
  ctx: { readonly threadId: string; readonly seatId: string; readonly index: SessionChainIndex },
): WriteRefusal | null {
  if ((RESERVED_EVENT_TYPES as readonly string[]).includes(type)) {
    return {
      reason: "reserved",
      issues: [`${type} is reserved for M4 (pin §4); no engine writes it before the M4 pin`],
    };
  }
  if (!isPlainRecord(payload)) {
    return { reason: "field-invalid", issues: ["payload must be an object"] };
  }
  const { index } = ctx;
  // The index knows whether this file's open is a v2 line (its `worktree` key was noted).
  const issues = checkV2Payload(type, payload, {
    seatId: ctx.seatId,
    openV2: index.openWorktree !== undefined,
  });
  if (issues.length > 0) return toRefusal(issues);
  const p = payload;
  switch (type) {
    case "handoff.out": {
      const id = p.handoffId as string;
      if (index.handoffState(id) !== undefined) {
        issues.push(invalid("handoffId", `${id} is already used in this file`));
      }
      break;
    }
    case "handoff.link":
    case "handoff.aborted": {
      const id = p.handoffId as string;
      const state = index.handoffState(id);
      if (state === undefined) {
        issues.push(invalid("handoffId", `${id} has no handoff.out in this file`));
      } else if (state !== "open") {
        issues.push(invalid("handoffId", `${id} already has a terminal record (${state})`));
      }
      break;
    }
    case "founderDecision": {
      const id = p.decisionId as string;
      if (index.hasDecision(id)) {
        issues.push(invalid("decisionId", `${id} is already used in this file`));
      }
      issues.push(
        ...sameFileRefIssues(
          p.evidenceRefs as readonly unknown[],
          sessionRefPath(ctx.threadId),
          index,
        ),
      );
      break;
    }
    case "session.close": {
      if (present(p, "worktree") && p.worktree !== null) {
        const open = index.openWorktree;
        const close = p.worktree as WorktreeIdentity;
        if (open === undefined || open === null) {
          issues.push(invalid("worktree", "must be null when session.open recorded no worktree"));
        } else if (close.topLevel !== open.topLevel) {
          issues.push(invalid("worktree.topLevel", "differs from the session.open worktree"));
        }
      }
      break;
    }
    default:
      break;
  }
  return toRefusal(issues);
}

// --------------------------------------------------- structural fields vs redaction

/**
 * Copilot 4160774703 (#46): redaction runs over every string, but an id, a hash, a path, a SHA or
 * a remote rewritten to `[REDACTED]` would break the id grammar (rule 1.9) and make a cross-file
 * link unresolvable. The structural view of a payload is everything except its free-text fields;
 * the view must be byte-identical before and after redaction, else the event is refused before
 * the append. M1 types have no structural rule (unchanged); `session.open` / `session.close` are
 * checked on their v2 subtrees only.
 */
export function structuralView(type: string, payload: unknown): unknown {
  if (!isPlainRecord(payload)) return null;
  const p = payload;
  switch (type) {
    case "session.open":
      return {
        ...(present(p, "handoff") ? { handoff: p.handoff } : {}),
        ...(present(p, "worktree") ? { worktree: p.worktree } : {}),
      };
    case "session.close":
      return present(p, "worktree") ? { worktree: p.worktree } : {};
    case "handoff.out": {
      const { brief: _brief, ...rest } = p;
      return rest;
    }
    case "handoff.aborted": {
      const { error, ...rest } = p;
      if (!isPlainRecord(error)) return { ...rest, error };
      const { message: _message, ...errRest } = error;
      return { ...rest, error: errRest };
    }
    case "founderDecision": {
      const { question: _q, recommendedDefault: _r, ...rest } = p;
      return rest;
    }
    case "handoff.link":
      return p;
    default:
      return null;
  }
}

/** Paths at which two values differ (own-property order independent). Leaves are compared by `===`. */
function diffPaths(a: unknown, b: unknown, path: string, out: string[]): void {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      out.push(path);
      return;
    }
    a.forEach((v, i) => {
      diffPaths(v, b[i], `${path}[${i}]`, out);
    });
    return;
  }
  if (isPlainRecord(a) || isPlainRecord(b)) {
    if (!isPlainRecord(a) || !isPlainRecord(b)) {
      out.push(path);
      return;
    }
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of [...keys].sort()) {
      diffPaths(a[k], b[k], path === "" ? k : `${path}.${k}`, out);
    }
    return;
  }
  if (a !== b) out.push(path);
}

/** The refusal when redaction changed a structural field; `null` when it changed none. */
export function redactionRefusal(
  type: string,
  before: unknown,
  after: unknown,
): WriteRefusal | null {
  const out: string[] = [];
  diffPaths(structuralView(type, before), structuralView(type, after), "", out);
  if (out.length === 0) return null;
  return {
    reason: "field-invalid",
    issues: out.map((p) => `redaction would rewrite structural field ${p === "" ? "payload" : p}`),
  };
}
