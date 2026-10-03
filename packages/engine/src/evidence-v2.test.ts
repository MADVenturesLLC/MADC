/**
 * M2-A1: the first writer of a §2 event — M2 evidence schema v2 pin
 * (docs/plan/PIN-madc-M2-evidence-schema-v2.md) §10 acceptance at the WRITER and VERIFIER level:
 * item 3 (evidence or nothing), item 5 (additive both ways), item 7 (redaction), item 8 (reserved
 * stays reserved) and item 9 (nothing written on refusal, for every refusal in §2–§4), plus the
 * two Copilot threads on #46 the commission closes here: 4160774703 (a structural field that
 * redaction would rewrite is refused before the append) and 4160774801 (exactly one terminal
 * record per handoff). Items 1, 2, 4 and 6 run through the engine in `handoff-gate.test.ts`.
 *
 * Network-free, in-process, real files under a temp dir. Every refusal is checked for the pinned
 * -32010 `data` shape, an unchanged file (size + sha256), an unchanged `nextSeq`, a writer that is
 * not broken, and a later valid append that succeeds.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { inspectSessionV2 } from "./handoff.ts";
import { ErrorCode, EVIDENCE_REFUSALS, RpcError } from "./protocol/errors.ts";
import {
  GENESIS_HASH,
  REDACTED,
  RESERVED_EVENT_TYPES,
  rebuildSession,
  SESSION_EVENT_TYPES,
  SessionChainIndex,
  type SessionEvent,
  type SessionOpenPayload,
  SessionWriter,
  sessionEventHash,
  unguardedSessionWriterForTests,
  verifySessionFile,
  verifySessionText,
} from "./session-store.ts";
import { V2_EVENT_TYPES } from "./session-v2.ts";

const HEX64 = "a".repeat(64);
const SHA40 = "b".repeat(40);
const BACKING = "kimi-code";
const V1_OPEN: SessionOpenPayload = {
  cwd: null,
  backing: BACKING,
  providerId: BACKING,
  pinnedModel: "m",
};
const V2_OPEN: SessionOpenPayload = { ...V1_OPEN, worktree: null, handoff: null };
const GHP = `ghp_${"A1b2C3d4E5".repeat(4)}`; // matches /\bgh[pousr]_[A-Za-z0-9]{20,}/ AND the id grammar
const AKIA = `AKIA${"ABCDEFGH".repeat(2)}`; // matches /\bAKIA[0-9A-Z]{16}\b/ AND the id grammar
const SK = `sk-${"abcdefghij".repeat(2)}`; // matches /\bsk-[A-Za-z0-9_-]{16,}/
const XAI = `xai-${"0123456789".repeat(2)}`;

type Snapshot = { size: number; sha: string };
const snapshot = (path: string): Snapshot => ({
  size: statSync(path).size,
  sha: createHash("sha256").update(readFileSync(path)).digest("hex"),
});

type Line = SessionEvent & { payload: Record<string, unknown> };
const readLines = (path: string): Line[] =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as Line);

/** The seat pin §4.3 formula, written independently of the engine (the base's own check). */
function independentVerify(path: string): void {
  let prev = GENESIS_HASH;
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
      );
    }
    return value;
  };
  readLines(path).forEach((line, i) => {
    assert.equal(line.seq, i);
    assert.equal(line.v, 1, "envelope stays v: 1 (D-M2-A0-6)");
    assert.deepEqual(
      Object.keys(line).sort(),
      ["hash", "payload", "prevHash", "seatId", "seq", "threadId", "ts", "type", "v"],
      `line ${i + 1}: exactly the nine envelope keys (rule 1.1)`,
    );
    assert.equal(line.prevHash, prev, `line ${i + 1} prevHash`);
    const { v, seq, ts, type, threadId, seatId, payload } = line;
    const json = JSON.stringify(canonical({ v, seq, ts, type, threadId, seatId, payload }));
    const expected = createHash("sha256").update(`${prev}\n${json}`, "utf8").digest("hex");
    assert.equal(line.hash, expected, `line ${i + 1} hash (formula unchanged, rule 1.2)`);
    prev = line.hash;
  });
}

type Fixture = { dir: string; path: string; writer: SessionWriter; cleanup: () => void };

function fixture(
  threadId = "thr_src",
  seatId = "madc-default",
  open: SessionOpenPayload = V2_OPEN,
  secrets: () => readonly string[] = () => [],
): Fixture {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "madc-m2a1-"));
  mkdirSync(join(dir, "sessions"), { mode: 0o700 });
  const path = join(dir, "sessions", `${threadId}.jsonl`);
  const writer = unguardedSessionWriterForTests.create(path, threadId, seatId, open, secrets);
  return { dir, path, writer, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

type AnyWriter = { append(type: string, payload: unknown): SessionEvent; nextSeq: number };
/** Reach the writer with a type the TS surface refuses (reserved / unknown names). */
const raw = (writer: SessionWriter): AnyWriter => writer as unknown as AnyWriter;

/**
 * §10 item 9: the refusal's -32010 data, then file size + sha256, `nextSeq` and `broken` are all
 * unchanged. Returns the `data` so a test can check `issues`.
 */
function expectRefusal(
  f: Fixture,
  type: string,
  payload: unknown,
  reason: string,
  turnId: string | null = null,
): Record<string, unknown> {
  const before = snapshot(f.path);
  const seq = f.writer.nextSeq;
  let data: Record<string, unknown> | undefined;
  assert.throws(
    () => raw(f.writer).append(type, payload),
    (err: unknown) => {
      assert.ok(err instanceof RpcError, `${type}: an RpcError, got ${String(err)}`);
      assert.equal(err.code, ErrorCode.EvidenceInvalid, `${type}: code -32010`);
      data = err.data;
      return true;
    },
  );
  assert.ok(data);
  assert.deepEqual(
    Object.keys(data).sort(),
    ["issues", "reason", "threadId", "turnId", "type"],
    "pin §5 data shape",
  );
  assert.equal(data.threadId, f.writer.threadId);
  assert.equal(data.turnId, turnId);
  assert.equal(data.type, type);
  assert.equal(data.reason, reason, `${type}: reason (${JSON.stringify(data.issues)})`);
  assert.ok(EVIDENCE_REFUSALS.includes(data.reason as never));
  assert.ok(Array.isArray(data.issues) && data.issues.length > 0, "issues name the fault");
  assert.deepEqual(snapshot(f.path), before, `${type}: nothing appended (size + sha256)`);
  assert.equal(f.writer.nextSeq, seq, `${type}: nextSeq unchanged`);
  assert.equal(f.writer.broken, false, `${type}: writer not broken`);
  return data;
}

const servedModel = (turnId: string) => ({
  turnId,
  requestedModel: "m",
  servedModel: "m-served",
  backing: BACKING,
  providerId: BACKING,
  lane: "allowed-direct" as const,
  mode: "headless" as const,
  fallbackFrom: null,
  vendorReported: true,
});

/** session.open, turn.start, item, servedModel, turn.end (seqs 0..4) — a receipt to cite. */
function servedTurn(f: Fixture): { receipt: SessionEvent; open: SessionEvent } {
  const open = readLines(f.path)[0] as SessionEvent;
  f.writer.append("turn.start", { turnId: "turn_1", inputText: "hi" });
  f.writer.append("item", {
    turnId: "turn_1",
    item: { id: "item_1", kind: "agentMessage", status: "completed", text: "hi" },
  });
  const receipt = f.writer.append("servedModel", servedModel("turn_1"));
  f.writer.append("turn.end", { turnId: "turn_1", status: "completed", error: null });
  return { receipt, open };
}

const decision = (refs: unknown[], id = "dec_1") => ({
  decisionId: id,
  turnId: "turn_1",
  question: "Keep -32010?",
  recommendedDefault: "Keep it.",
  evidenceRefs: refs,
});

// ------------------------------------------------------------------ item 8

test("M2 §10.8 reserved stays reserved: memory.write and tool.call refuse -32010 reserved; the writable set excludes them", () => {
  // The guard: a reserved name entering the writable set before the M4 pin fails here.
  assert.deepEqual([...RESERVED_EVENT_TYPES], ["memory.write", "tool.call"]);
  for (const name of RESERVED_EVENT_TYPES) {
    assert.equal(
      (SESSION_EVENT_TYPES as readonly string[]).includes(name),
      false,
      `${name} must not be writable before the M4 pin (pin §4, §10 item 8)`,
    );
  }
  assert.deepEqual(
    [...SESSION_EVENT_TYPES].slice(-4),
    [...V2_EVENT_TYPES],
    "the four §2 types are the only additions to the writable set",
  );
  const f = fixture();
  try {
    const memoryWrite = {
      turnId: "turn_1",
      path: "memory/madc-default.md",
      op: "append",
      bytes: 12,
      contentSha256: HEX64,
      requestedModel: "m",
      servedModel: "m",
      providerId: BACKING,
      lane: "allowed-direct",
      vendorReported: true,
    };
    const toolCall = {
      turnId: "turn_1",
      callId: "item_9",
      name: "read",
      server: null,
      call: { seq: 0, hash: HEX64 },
      result: null,
      decision: "denied",
      reason: "deny: *",
    };
    // Well-formed shapes are still refused: the reservation, not the shape, is the rule.
    const m = expectRefusal(f, "memory.write", memoryWrite, "reserved", "turn_1");
    assert.match(String(m.issues), /reserved for M4/);
    expectRefusal(f, "tool.call", toolCall, "reserved", "turn_1");
    // A name outside the vocabulary altogether is an engine fault, not a record.
    assert.throws(() => raw(f.writer).append("m5.whatever", { x: 1 }), TypeError);
    // The writer is not broken: the next valid append succeeds.
    const next = f.writer.append("turn.start", { turnId: "turn_1", inputText: "x" });
    assert.equal(next.seq, 1);
    assert.equal(verifySessionFile(f.path, "thr_src").ok, true);
  } finally {
    f.cleanup();
  }
});

/** A raw chain for the verifier tests: `lines` as {type, payload}, hashed with the engine's formula. */
function rawChain(
  lines: ReadonlyArray<{ type: string; payload: Record<string, unknown> }>,
  threadId = "thr_raw",
  seatId = "madc-default",
): string {
  let prev = GENESIS_HASH;
  return lines
    .map(({ type, payload }, seq) => {
      const body = { v: 1 as const, seq, ts: 1000 + seq, type, threadId, seatId, payload };
      const hash = sessionEventHash(prev, body as never);
      const { payload: p, ...head } = body;
      const line = JSON.stringify({ ...head, prevHash: prev, hash, payload: p });
      prev = hash;
      return `${line}\n`;
    })
    .join("");
}

test("M2 D-M2-A0-2: a reserved line met in a file is shape-validated — well-formed tolerated, malformed is an integrity failure", () => {
  const memoryWrite = {
    turnId: "turn_1",
    path: "memory/madc-default.md",
    op: "append",
    bytes: 12,
    contentSha256: HEX64,
    requestedModel: "m",
    servedModel: "m",
    providerId: BACKING,
    lane: "allowed-direct",
    vendorReported: true,
  };
  const toolCall = {
    turnId: "turn_1",
    callId: "item_9",
    name: "read",
    server: null,
    call: { seq: 1, hash: HEX64 },
    result: { seq: 2, hash: HEX64 },
    decision: "allowed",
    reason: null,
  };
  const open = { type: "session.open", payload: { ...V2_OPEN } };
  const good = verifySessionText(
    rawChain([
      open,
      { type: "memory.write", payload: memoryWrite },
      { type: "tool.call", payload: toolCall },
    ]),
  );
  assert.equal(good.ok, true);
  assert.doesNotThrow(() => rebuildSession(good.ok ? good.events : []));
  for (const [type, payload] of [
    ["memory.write", { ...memoryWrite, bytes: 0 }],
    ["memory.write", { ...memoryWrite, path: "../etc/passwd.md" }],
    ["memory.write", { ...memoryWrite, op: "replace" }],
    ["tool.call", { ...toolCall, call: { seq: -1, hash: HEX64 } }],
    ["tool.call", { ...toolCall, decision: "maybe" }],
  ] as const) {
    // M2-A1 correction (Argus 5391475289 miss 1): the verifier itself refuses the line — it does
    // not stop at the hash — and rebuild refuses the same lines when handed them directly.
    const text = rawChain([open, { type, payload }]);
    const bad = verifySessionText(text);
    assert.equal(bad.ok, false, type);
    assert.equal(bad.ok ? "" : `${bad.kind} ${bad.reason}`, `integrity malformed ${type} payload`);
    const parsed = text
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as SessionEvent);
    assert.throws(() => rebuildSession(parsed), new RegExp(`line 2: malformed ${type} payload`));
  }
});

// ------------------------------------------------------------------ item 3

test("M2 §10.3 evidence or nothing: empty, malformed and mismatched refs each refuse with the pinned reason; nothing appended; a later valid decision appends", () => {
  const f = fixture();
  try {
    const { receipt, open } = servedTurn(f);
    const sessionRef = { kind: "session", path: "sessions/thr_src.jsonl", seq: 0, hash: open.hash };
    const receiptRef = {
      kind: "servedModel",
      path: "sessions/thr_src.jsonl",
      seq: receipt.seq,
      hash: receipt.hash,
    };
    // evidenceRefs missing or []: the pinned `evidence-ref-missing`. (Mutation: accept [].)
    expectRefusal(f, "founderDecision", decision([]), "evidence-ref-missing", "turn_1");
    const noKey = decision([sessionRef]) as Record<string, unknown>;
    delete noKey.evidenceRefs;
    expectRefusal(f, "founderDecision", noKey, "evidence-ref-missing", "turn_1");
    // Malformed under §3: `evidence-ref-invalid`.
    for (const ref of [
      { kind: "url", url: "https://example.invalid" },
      "free text",
      { kind: "session", path: "/abs/sessions/thr_src.jsonl", seq: 0, hash: open.hash },
      { kind: "session", path: "sessions/../thr_src.jsonl", seq: 0, hash: open.hash },
      { kind: "session", path: "sessions/thr_src.lock", seq: 0, hash: open.hash },
      { kind: "session", path: "sessions/thr_src.jsonl", seq: -1, hash: open.hash },
      { kind: "session", path: "sessions/thr_src.jsonl", seq: 0, hash: open.hash.toUpperCase() },
      { kind: "git", sha: "abc", remote: null },
      { kind: "git", sha: SHA40 },
      { kind: "git", sha: SHA40, remote: "https://github.com/o/r.git" },
    ]) {
      expectRefusal(f, "founderDecision", decision([ref]), "evidence-ref-invalid", "turn_1");
    }
    // Same-file refs are resolved at write time (D-M2-A0-4): wrong hash, seq not below nextSeq,
    // and a `servedModel` ref at a line of another type.
    expectRefusal(
      f,
      "founderDecision",
      decision([{ ...sessionRef, hash: HEX64 }]),
      "evidence-ref-invalid",
      "turn_1",
    );
    expectRefusal(
      f,
      "founderDecision",
      decision([{ ...sessionRef, seq: f.writer.nextSeq, hash: open.hash }]),
      "evidence-ref-invalid",
      "turn_1",
    );
    expectRefusal(
      f,
      "founderDecision",
      decision([{ ...receiptRef, seq: 1, hash: (readLines(f.path)[1] as Line).hash }]),
      "evidence-ref-invalid",
      "turn_1",
    );
    // The other required fields.
    expectRefusal(
      f,
      "founderDecision",
      { ...decision([sessionRef]), question: "   " },
      "field-invalid",
      "turn_1",
    );
    expectRefusal(
      f,
      "founderDecision",
      { ...decision([sessionRef]), recommendedDefault: ["a", "b"] },
      "field-invalid",
      "turn_1",
    );
    const noDefault = decision([sessionRef]) as Record<string, unknown>;
    delete noDefault.recommendedDefault;
    expectRefusal(f, "founderDecision", noDefault, "field-missing", "turn_1");
    expectRefusal(
      f,
      "founderDecision",
      { ...decision([sessionRef]), decisionId: "bad.id" },
      "field-invalid",
      "turn_1",
    );
    // Then a valid decision appends, and the turn continues (a later turn.end still appends).
    const ok = f.writer.append("founderDecision", {
      ...decision([sessionRef, receiptRef, { kind: "git", sha: SHA40, remote: null }]),
      evidenceRefs: [sessionRef, receiptRef, { kind: "git", sha: SHA40, remote: null }],
    } as never);
    assert.equal(ok.type, "founderDecision");
    assert.equal(ok.seq, 5);
    expectRefusal(f, "founderDecision", decision([sessionRef], "dec_1"), "field-invalid", "turn_1");
    f.writer.append("turn.end", { turnId: "turn_1", status: "completed", error: null });
    independentVerify(f.path);
    const v = verifySessionFile(f.path, "thr_src");
    assert.equal(v.ok, true);
    const rebuilt = rebuildSession(v.ok ? v.events : []);
    assert.equal(rebuilt.turns.length, 1, "founderDecision is not a turn");
    // The verifier side resolves the same-file refs and reports no mismatch; the `git` ref has no
    // recorded worktree to resolve against, so it is reported unresolved (§3: never silently
    // accepted), and nothing is a FAIL.
    const findings = inspectSessionV2(f.dir, v.ok ? v.events : []).filter(
      (x) => x.code.startsWith("evidence-ref") || x.code === "duplicate-id",
    );
    assert.deepEqual(
      findings.map((x) => `${x.level} ${x.code}`),
      ["warn evidence-ref-unresolved"],
    );
  } finally {
    f.cleanup();
  }
});

// ------------------------------------------------------------------ item 9

test("M2 §10.9 nothing written on refusal: every §2–§4 refusal row leaves size, sha256 and nextSeq unchanged and the writer usable", () => {
  const f = fixture();
  try {
    const out = f.writer.append("handoff.out", {
      handoffId: "ho_ok",
      turnId: null,
      targetSeatId: "hephaestus",
      brief: "ok",
    });
    const okOut = { handoffId: "ho_2", turnId: "turn_1", targetSeatId: "hephaestus", brief: "x" };
    const okLink = {
      handoffId: "ho_ok",
      targetThreadId: "thr_tgt",
      targetSeatId: "hephaestus",
      targetGenesisHash: HEX64,
    };
    const okAborted = { handoffId: "ho_ok", reason: "interrupted" as const, error: null };
    const drop = (o: Record<string, unknown>, k: string) => {
      const c = { ...o };
      delete c[k];
      return c;
    };
    const rows: Array<[string, unknown, string, string | null]> = [
      // handoff.out (§2.1 refusals)
      ["handoff.out", drop(okOut, "handoffId"), "field-missing", "turn_1"],
      ["handoff.out", drop(okOut, "turnId"), "field-missing", null],
      ["handoff.out", { ...okOut, turnId: "bad id" }, "field-invalid", null],
      ["handoff.out", drop(okOut, "targetSeatId"), "field-missing", "turn_1"],
      ["handoff.out", drop(okOut, "brief"), "field-missing", "turn_1"],
      ["handoff.out", { ...okOut, brief: " \n\t" }, "field-invalid", "turn_1"],
      ["handoff.out", { ...okOut, handoffId: "has.dot" }, "field-invalid", "turn_1"],
      ["handoff.out", { ...okOut, handoffId: "ho_ok" }, "field-invalid", "turn_1"],
      ["handoff.out", { ...okOut, targetSeatId: 7 }, "field-invalid", "turn_1"],
      // handoff.link
      ["handoff.link", drop(okLink, "targetGenesisHash"), "field-missing", null],
      ["handoff.link", { ...okLink, targetGenesisHash: "abc" }, "field-invalid", null],
      [
        "handoff.link",
        { ...okLink, targetGenesisHash: HEX64.toUpperCase() },
        "field-invalid",
        null,
      ],
      ["handoff.link", drop(okLink, "targetThreadId"), "field-missing", null],
      ["handoff.link", drop(okLink, "targetSeatId"), "field-missing", null],
      ["handoff.link", { ...okLink, handoffId: "ho_unknown" }, "field-invalid", null],
      // handoff.aborted
      ["handoff.aborted", drop(okAborted, "error"), "field-missing", null],
      ["handoff.aborted", drop(okAborted, "handoffId"), "field-missing", null],
      ["handoff.aborted", { ...okAborted, reason: "gave-up" }, "field-invalid", null],
      ["handoff.aborted", drop(okAborted, "reason"), "field-missing", null],
      [
        "handoff.aborted",
        { ...okAborted, error: { code: "x", message: 1 } },
        "field-invalid",
        null,
      ],
      ["handoff.aborted", { ...okAborted, handoffId: "ho_unknown" }, "field-invalid", null],
      // session.close (§2.2)
      [
        "session.close",
        { reason: "shutdown", worktree: { topLevel: "/elsewhere", remote: null, head: SHA40 } },
        "field-invalid",
        null,
      ],
      [
        "session.close",
        { reason: "shutdown", worktree: { topLevel: "/x", remote: null } },
        "field-missing",
        null,
      ],
      [
        "session.close",
        { reason: "shutdown", worktree: { topLevel: "rel", remote: null, head: null } },
        "field-invalid",
        null,
      ],
      [
        "session.close",
        { reason: "shutdown", worktree: { topLevel: "/x", remote: null, head: "zz" } },
        "field-invalid",
        null,
      ],
      // reserved (§4)
      ["memory.write", { turnId: "turn_1" }, "reserved", "turn_1"],
      ["tool.call", {}, "reserved", null],
    ];
    for (const [type, payload, reason, turnId] of rows)
      expectRefusal(f, type, payload, reason, turnId);
    // The writer is usable after every refusal: the valid records append and the chain verifies.
    f.writer.append("handoff.out", okOut);
    f.writer.append("handoff.link", { ...okLink, handoffId: "ho_2" });
    f.writer.append("handoff.aborted", okAborted);
    f.writer.append("session.close", { reason: "shutdown", worktree: null });
    // open(0), out ho_ok(1), out ho_2(2), link ho_2(3), aborted ho_ok(4), close(5) → next is 6.
    assert.equal(f.writer.nextSeq, 6);
    assert.equal(out.seq, 1);
    independentVerify(f.path);
    const v = verifySessionFile(f.path, "thr_src");
    assert.equal(v.ok, true);
    assert.doesNotThrow(() => rebuildSession(v.ok ? v.events : []));
  } finally {
    f.cleanup();
  }
});

test("M2 §2.2 at thread/start: a malformed session.open handoff or worktree refuses -32010 and NO file is created", () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "madc-m2a1-open-"));
  mkdirSync(join(dir, "sessions"), { mode: 0o700 });
  try {
    const link = {
      sourceThreadId: "thr_a",
      sourceSeatId: "daedalus",
      handoffId: "ho_1",
      sourceSeq: 7,
      sourceHash: HEX64,
    };
    const wt = { topLevel: "/repo", remote: "github.com/owner/repo", head: SHA40 };
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["worktree without handoff", { ...V1_OPEN, worktree: null }, "field-missing"],
      ["handoff without worktree", { ...V1_OPEN, handoff: null }, "field-missing"],
      [
        "handoff.sourceHash too short",
        { ...V2_OPEN, handoff: { ...link, sourceHash: "ab" } },
        "field-invalid",
      ],
      [
        "handoff.sourceSeq negative",
        { ...V2_OPEN, handoff: { ...link, sourceSeq: -1 } },
        "field-invalid",
      ],
      [
        "handoff.sourceSeq float",
        { ...V2_OPEN, handoff: { ...link, sourceSeq: 1.5 } },
        "field-invalid",
      ],
      [
        "handoff missing handoffId",
        { ...V2_OPEN, handoff: { ...link, handoffId: undefined } },
        "field-missing",
      ],
      ["handoff not an object", { ...V2_OPEN, handoff: "thr_a" }, "field-invalid"],
      [
        "worktree.topLevel relative",
        { ...V2_OPEN, worktree: { ...wt, topLevel: "repo" } },
        "field-invalid",
      ],
      ["worktree.head not hex", { ...V2_OPEN, worktree: { ...wt, head: "HEAD" } }, "field-invalid"],
      [
        "worktree.remote not normalized",
        { ...V2_OPEN, worktree: { ...wt, remote: "git@github.com:owner/repo.git" } },
        "field-invalid",
      ],
      [
        "worktree missing remote",
        { ...V2_OPEN, worktree: { topLevel: "/repo", head: null } },
        "field-missing",
      ],
    ];
    for (const [name, open, reason] of cases) {
      const path = join(
        dir,
        "sessions",
        `thr_${cases.indexOf(cases.find((c) => c[0] === name) as never)}.jsonl`,
      );
      assert.throws(
        () =>
          SessionWriter.create(path, "thr_x", "madc-default", open as never, () => [], 1, dir, {
            holdsLock: () => true,
          }),
        (err: unknown) =>
          err instanceof RpcError &&
          err.code === ErrorCode.EvidenceInvalid &&
          err.data?.reason === reason &&
          err.data?.type === "session.open" &&
          err.data?.turnId === null,
        name,
      );
      assert.equal(existsSync(path), false, `${name}: no file is created`);
    }
    // And the same shapes are integrity failures when met in a file (§2.2 verifier rule).
    for (const [name, open] of cases) {
      const text = rawChain([{ type: "session.open", payload: open }]);
      const v = verifySessionText(text);
      assert.equal(v.ok, false, name);
      assert.equal(
        v.ok ? "" : `${v.line} ${v.kind} ${v.reason}`,
        "1 integrity malformed session.open payload",
        name,
      );
      const parsed = text
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => JSON.parse(l) as SessionEvent);
      assert.throws(() => rebuildSession(parsed), /line 1: malformed session.open payload/, name);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ item 7

test("M2 §10.7 redaction: a brief, question, recommendedDefault or abort message carrying a key shape is [REDACTED] on disk and the chain still verifies", () => {
  const f = fixture("thr_src", "madc-default", V2_OPEN, () => ["exact-secret-value-1"]);
  try {
    const { open } = servedTurn(f);
    f.writer.append("handoff.out", {
      handoffId: "ho_1",
      turnId: "turn_1",
      targetSeatId: "hephaestus",
      brief: `use ${GHP} and ${SK} and exact-secret-value-1 to log in`,
    });
    f.writer.append("handoff.aborted", {
      handoffId: "ho_1",
      reason: "target-open-failed",
      error: { code: -32006, message: `seat refused; Bearer ${"t".repeat(24)}` },
    });
    f.writer.append("founderDecision", {
      decisionId: "dec_1",
      turnId: "turn_1",
      question: `Rotate ${XAI}?`,
      recommendedDefault: `Yes, ${AKIA} must go.`,
      evidenceRefs: [{ kind: "session", path: "sessions/thr_src.jsonl", seq: 0, hash: open.hash }],
    });
    const text = readFileSync(f.path, "utf8");
    for (const secret of [GHP, SK, XAI, AKIA, "exact-secret-value-1", `Bearer ${"t".repeat(24)}`]) {
      assert.equal(text.includes(secret), false, `${secret.slice(0, 6)}… never reaches the file`);
    }
    const lines = readLines(f.path);
    assert.equal(
      (lines[5] as Line).payload.brief,
      `use ${REDACTED} and ${REDACTED} and ${REDACTED} to log in`,
    );
    assert.equal(
      ((lines[6] as Line).payload.error as { message: string }).message,
      `seat refused; ${REDACTED}`,
    );
    assert.equal((lines[7] as Line).payload.question, `Rotate ${REDACTED}?`);
    assert.equal((lines[7] as Line).payload.recommendedDefault, `Yes, ${REDACTED} must go.`);
    // Rule 1.4: a redacted field still satisfies its type rule — the file verifies and rebuilds.
    independentVerify(f.path);
    const v = verifySessionFile(f.path, "thr_src");
    assert.equal(v.ok, true);
    assert.doesNotThrow(() => rebuildSession(v.ok ? v.events : []));
  } finally {
    f.cleanup();
  }
});

test("Copilot 4160774703 (#46): a structural field that redaction would rewrite is refused before the append, never persisted as [REDACTED]", () => {
  const f = fixture("thr_src", "madc-default", V2_OPEN, () => ["ho_exact"]);
  try {
    const { open } = servedTurn(f);
    const okOut = { handoffId: "ho_1", turnId: "turn_1", targetSeatId: "hephaestus", brief: "x" };
    // Token-shaped ids that ALSO satisfy the id grammar: a pattern would rewrite them.
    const d1 = expectRefusal(
      f,
      "handoff.out",
      { ...okOut, handoffId: GHP },
      "field-invalid",
      "turn_1",
    );
    assert.match(String(d1.issues), /redaction would rewrite structural field handoffId/);
    const d2 = expectRefusal(
      f,
      "handoff.out",
      { ...okOut, targetSeatId: AKIA },
      "field-invalid",
      "turn_1",
    );
    assert.match(String(d2.issues), /structural field targetSeatId/);
    // An exact secret the engine holds that happens to equal an id.
    const d3 = expectRefusal(
      f,
      "handoff.out",
      { ...okOut, handoffId: "ho_exact" },
      "field-invalid",
      "turn_1",
    );
    assert.match(String(d3.issues), /structural field handoffId/);
    // A same-file evidence path naming a token-shaped thread id (rule 1.9 would be broken).
    const d4 = expectRefusal(
      f,
      "founderDecision",
      decision([{ kind: "session", path: `sessions/${GHP}.jsonl`, seq: 0, hash: open.hash }]),
      "field-invalid",
      "turn_1",
    );
    assert.match(String(d4.issues), /structural field evidenceRefs\[0\]\.path/);
    // handoff.link / aborted ids too.
    f.writer.append("handoff.out", okOut);
    expectRefusal(
      f,
      "handoff.link",
      {
        handoffId: "ho_1",
        targetThreadId: GHP,
        targetSeatId: "hephaestus",
        targetGenesisHash: HEX64,
      },
      "field-invalid",
    );
    // Free text is still redacted, not refused: the brief above carried nothing, so add one now.
    const ok = f.writer.append("handoff.aborted", {
      handoffId: "ho_1",
      reason: "interrupted",
      error: { code: 1, message: `token ${GHP}` },
    });
    assert.equal((ok.payload.error as { message: string }).message, `token ${REDACTED}`);
    // session.open: a worktree top-level with a token-shaped segment is refused, no file created.
    const path2 = join(f.dir, "sessions", "thr_two.jsonl");
    assert.throws(
      () =>
        SessionWriter.create(
          path2,
          "thr_two",
          "madc-default",
          { ...V2_OPEN, worktree: { topLevel: `/work/${SK}`, remote: null, head: null } },
          () => [],
          1,
          f.dir,
          { holdsLock: () => true },
        ),
      (err: unknown) =>
        err instanceof RpcError &&
        err.code === ErrorCode.EvidenceInvalid &&
        /structural field worktree\.topLevel/.test(String(err.data?.issues)),
    );
    assert.equal(existsSync(path2), false);
    independentVerify(f.path);
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------- Copilot 4160774801

test("Copilot 4160774801 (#46): exactly one terminal record per handoff — a second handoff.link, an abort after a link, a link after an abort, and a terminal without its handoff.out are refused; doctor FAILs a crafted conflict", () => {
  const f = fixture();
  try {
    const link = (id: string) => ({
      handoffId: id,
      targetThreadId: "thr_tgt",
      targetSeatId: "hephaestus",
      targetGenesisHash: HEX64,
    });
    const aborted = (id: string) => ({
      handoffId: id,
      reason: "interrupted" as const,
      error: null,
    });
    // Without an out: refused.
    expectRefusal(f, "handoff.link", link("ho_1"), "field-invalid");
    expectRefusal(f, "handoff.aborted", aborted("ho_1"), "field-invalid");
    f.writer.append("handoff.out", {
      handoffId: "ho_1",
      turnId: null,
      targetSeatId: "hephaestus",
      brief: "a",
    });
    // Duplicate out id: refused.
    expectRefusal(
      f,
      "handoff.out",
      { handoffId: "ho_1", turnId: null, targetSeatId: "hephaestus", brief: "again" },
      "field-invalid",
    );
    f.writer.append("handoff.link", link("ho_1"));
    const d = expectRefusal(f, "handoff.link", link("ho_1"), "field-invalid");
    assert.match(String(d.issues), /already has a terminal record \(linked\)/);
    expectRefusal(f, "handoff.aborted", aborted("ho_1"), "field-invalid");
    f.writer.append("handoff.out", {
      handoffId: "ho_2",
      turnId: null,
      targetSeatId: "hephaestus",
      brief: "b",
    });
    f.writer.append("handoff.aborted", aborted("ho_2"));
    expectRefusal(f, "handoff.link", link("ho_2"), "field-invalid");
    expectRefusal(f, "handoff.aborted", aborted("ho_2"), "field-invalid");
    // Inside one batch too: the second entry sees the first.
    const before = snapshot(f.path);
    assert.throws(
      () =>
        f.writer.appendAll([
          {
            type: "handoff.out",
            payload: { handoffId: "ho_3", turnId: null, targetSeatId: "hephaestus", brief: "c" },
          },
          {
            type: "handoff.out",
            payload: { handoffId: "ho_3", turnId: null, targetSeatId: "hephaestus", brief: "c2" },
          },
        ]),
      (err: unknown) => err instanceof RpcError && err.code === ErrorCode.EvidenceInvalid,
    );
    assert.deepEqual(snapshot(f.path), before, "a refused batch writes neither entry");
    // A resumed writer (index rebuilt from the file) remembers the terminals.
    const v = verifySessionFile(f.path, "thr_src");
    assert.equal(v.ok, true);
    const resumed = unguardedSessionWriterForTests.resume(
      f.path,
      "thr_src",
      "madc-default",
      v.ok ? v.nextSeq : 0,
      v.ok ? v.lastHash : "",
      () => [],
      f.dir,
    );
    const g = { dir: f.dir, path: f.path, writer: resumed, cleanup: () => {} };
    expectRefusal(g, "handoff.link", link("ho_1"), "field-invalid");
    expectRefusal(g, "handoff.link", link("ho_2"), "field-invalid");
    // The verifier side (doctor): a crafted file with two links for one id is FAIL.
    const crafted = rawChain([
      { type: "session.open", payload: { ...V2_OPEN } },
      {
        type: "handoff.out",
        payload: { handoffId: "ho_9", turnId: null, targetSeatId: "hephaestus", brief: "z" },
      },
      { type: "handoff.link", payload: link("ho_9") },
      { type: "handoff.link", payload: link("ho_9") },
      { type: "handoff.aborted", payload: aborted("ho_9") },
    ]);
    const cv = verifySessionText(crafted);
    assert.equal(cv.ok, true, "the chain itself verifies: the conflict is a link finding");
    const findings = inspectSessionV2(f.dir, cv.ok ? cv.events : []);
    assert.deepEqual(
      findings.filter((x) => x.code === "handoff-terminal-conflict").map((x) => x.level),
      ["fail"],
    );
  } finally {
    f.cleanup();
  }
});

// ------------------------------------------------------------------ item 5

test("M2 §10.5 additive both ways: a v1 fixture verifies and rebuilds unchanged; a v2 fixture keeps the base's tolerance (unknown types, extra fields, same envelope and hash formula)", () => {
  // (a) a v1 file: no v2 keys anywhere.
  const v1 = fixture("thr_v1", "madc-default", V1_OPEN);
  try {
    v1.writer.append("turn.start", { turnId: "turn_1", inputText: "hi" });
    v1.writer.append("turn.end", { turnId: "turn_1", status: "completed", error: null });
    independentVerify(v1.path);
    const v = verifySessionFile(v1.path, "thr_v1");
    assert.equal(v.ok, true);
    const rebuilt = rebuildSession(v.ok ? v.events : []);
    assert.equal(rebuilt.turns[0]?.status, "completed");
    assert.deepEqual(Object.keys((v.ok ? v.events[0]?.payload : {}) as object).sort(), [
      "backing",
      "cwd",
      "pinnedModel",
      "providerId",
    ]);
    // The verifier reports nothing v2 about a v1 file (no `not-cleanly-closed` either: v1 engines
    // never promised a close).
    assert.deepEqual(inspectSessionV2(v1.dir, v.ok ? v.events : []), []);
  } finally {
    v1.cleanup();
  }
  // (b) a v2 file with every §2 type, plus what the base already tolerated: an unknown type and
  // extra fields on session.open and on a v2 payload.
  const open = {
    ...V2_OPEN,
    worktree: { topLevel: "/repo", remote: "github.com/owner/repo", head: SHA40 },
    future: "ignored",
  };
  const text = rawChain([
    { type: "session.open", payload: open },
    { type: "turn.start", payload: { turnId: "turn_1", inputText: "hi" } },
    {
      type: "handoff.out",
      payload: {
        handoffId: "ho_1",
        turnId: "turn_1",
        targetSeatId: "hephaestus",
        brief: "b",
        extra: 1,
      },
    },
    {
      type: "handoff.link",
      payload: {
        handoffId: "ho_1",
        targetThreadId: "thr_t",
        targetSeatId: "hephaestus",
        targetGenesisHash: HEX64,
      },
    },
    { type: "m5.unknown", payload: { anything: ["goes"] } },
    { type: "founderDecision", payload: decision([{ kind: "git", sha: SHA40, remote: null }]) },
    {
      type: "handoff.out",
      payload: { handoffId: "ho_2", turnId: null, targetSeatId: "hephaestus", brief: "c" },
    },
    { type: "handoff.aborted", payload: { handoffId: "ho_2", reason: "interrupted", error: null } },
    { type: "turn.end", payload: { turnId: "turn_1", status: "completed", error: null } },
    {
      type: "session.close",
      payload: {
        reason: "shutdown",
        worktree: { topLevel: "/repo", remote: "github.com/owner/repo", head: SHA40 },
      },
    },
  ]);
  const v2 = verifySessionText(text, "thr_raw");
  assert.equal(v2.ok, true, v2.ok ? "" : `${v2.line}: ${v2.reason}`);
  const rebuilt = rebuildSession(v2.ok ? v2.events : []);
  assert.equal(rebuilt.turns.length, 1, "v2 lines add no turn");
  assert.equal(rebuilt.turns[0]?.status, "completed");
  assert.equal(rebuilt.thread.cwd, null);
  for (const e of v2.ok ? v2.events : []) {
    assert.equal(e.v, 1);
    assert.deepEqual(Object.keys(e).sort(), [
      "hash",
      "payload",
      "prevHash",
      "seatId",
      "seq",
      "threadId",
      "ts",
      "type",
      "v",
    ]);
  }
  // A tenth envelope key must keep failing (rule 1.1).
  const tenth = text.replace('"v":1,"seq":2,', '"v":1,"seq":2,"extra":true,');
  assert.notEqual(tenth, text);
  const bad = verifySessionText(tenth);
  assert.equal(bad.ok, false);
  assert.equal(bad.ok ? "" : bad.reason, "envelope keys differ");
  // §2.2 verifier rule on close: a worktree naming another top-level is an integrity failure.
  const badClose = rawChain([
    { type: "session.open", payload: open },
    {
      type: "session.close",
      payload: { reason: "shutdown", worktree: { topLevel: "/other", remote: null, head: null } },
    },
  ]);
  const bc = verifySessionText(badClose);
  assert.equal(bc.ok, false);
  assert.equal(
    bc.ok ? "" : `${bc.line} ${bc.kind} ${bc.reason}`,
    "2 integrity session.close worktree does not match session.open",
  );
});

// ------------------------------------------------------------- writer index

test("M2 D-M2-A0-4: the writer's index — genesisHash, lineAt, and a resume that resolves same-file refs from the verified file", () => {
  const f = fixture();
  try {
    const open = readLines(f.path)[0] as Line;
    assert.equal(f.writer.genesisHash, open.hash);
    assert.deepEqual(f.writer.lineAt(0), { hash: open.hash, type: "session.open" });
    assert.equal(f.writer.lineAt(1), undefined);
    const { receipt } = servedTurn(f);
    assert.deepEqual(f.writer.lineAt(receipt.seq), { hash: receipt.hash, type: "servedModel" });
    const v = verifySessionFile(f.path, "thr_src");
    assert.equal(v.ok, true);
    const resumed = unguardedSessionWriterForTests.resume(
      f.path,
      "thr_src",
      "madc-default",
      v.ok ? v.nextSeq : 0,
      v.ok ? v.lastHash : "",
      () => [],
      f.dir,
    );
    assert.equal(resumed.genesisHash, open.hash);
    const ok = resumed.append("founderDecision", {
      ...decision([
        {
          kind: "servedModel",
          path: "sessions/thr_src.jsonl",
          seq: receipt.seq,
          hash: receipt.hash,
        },
      ]),
      evidenceRefs: [
        {
          kind: "servedModel",
          path: "sessions/thr_src.jsonl",
          seq: receipt.seq,
          hash: receipt.hash,
        },
      ],
    });
    assert.equal(ok.seq, 5);
    // Kept (Argus P11 moved the blind-writer case below to resume): the fail-closed same-file rule
    // that case exercised still refuses a ref that is not below the next seq, on the real index.
    const g = { dir: f.dir, path: f.path, writer: resumed, cleanup: () => {} };
    const d = expectRefusal(
      g,
      "founderDecision",
      decision(
        [{ kind: "session", path: "sessions/thr_src.jsonl", seq: 6, hash: open.hash }],
        "dec_2",
      ),
      "evidence-ref-invalid",
      "turn_1",
    );
    assert.match(String(d.issues), /not below the next seq 6/);
    // A resume WITHOUT the verified events (an empty index) is now refused at resume itself
    // (Argus P11): no writer exists that could resolve, or fail to resolve, a same-file ref.
    const before = snapshot(f.path);
    assert.throws(
      () =>
        SessionWriter.resume(
          f.path,
          "thr_src",
          "madc-default",
          6,
          ok.hash,
          () => [],
          f.dir,
          undefined,
          { holdsLock: () => true, expectedSize: statSync(f.path).size },
          undefined,
          new SessionChainIndex(),
        ),
      TypeError,
    );
    assert.deepEqual(snapshot(f.path), before, "nothing appended by the refused resume");
    independentVerify(f.path);
  } finally {
    f.cleanup();
  }
});

// ------------------------------------------------ M2-A1 correction (Argus 5391475289)

test("Argus 5391475289 miss 1 (Copilot 4165236039/4165236079): a hash-valid malformed v2 payload is an integrity failure in verifySessionText; inspectSessionV2 reports FAIL integrity and never throws", () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "madc-m2a1-miss1-"));
  try {
    const open = { type: "session.open", payload: { ...V2_OPEN } };
    const sessionRef = { kind: "session", path: "sessions/thr_raw.jsonl", seq: 0, hash: HEX64 };
    const bad: Array<[string, { type: string; payload: Record<string, unknown> }]> = [
      [
        "founderDecision evidenceRefs [null]",
        { type: "founderDecision", payload: decision([null]) },
      ],
      ["founderDecision evidenceRefs []", { type: "founderDecision", payload: decision([]) }],
      [
        "founderDecision ref with bad path",
        { type: "founderDecision", payload: decision([{ ...sessionRef, path: "/etc/passwd" }]) },
      ],
      [
        "handoff.out empty brief",
        {
          type: "handoff.out",
          payload: { handoffId: "ho_1", turnId: null, targetSeatId: "hephaestus", brief: " " },
        },
      ],
      [
        "handoff.link short hash",
        {
          type: "handoff.link",
          payload: {
            handoffId: "ho_1",
            targetThreadId: "thr_t",
            targetSeatId: "hephaestus",
            targetGenesisHash: "ab",
          },
        },
      ],
      [
        "handoff.aborted bad reason",
        { type: "handoff.aborted", payload: { handoffId: "ho_1", reason: "nope", error: null } },
      ],
      [
        "memory.write bytes 0",
        {
          type: "memory.write",
          payload: {
            turnId: "turn_1",
            path: "memory/madc-default.md",
            op: "append",
            bytes: 0,
            contentSha256: HEX64,
            requestedModel: "m",
            servedModel: "m",
            providerId: BACKING,
            lane: "allowed-direct",
            vendorReported: true,
          },
        },
      ],
      [
        "tool.call bad decision",
        {
          type: "tool.call",
          payload: {
            turnId: "turn_1",
            callId: "item_1",
            name: "x",
            server: null,
            call: { seq: 0, hash: HEX64 },
            result: null,
            decision: "maybe",
            reason: null,
          },
        },
      ],
    ];
    for (const [name, line] of bad) {
      const text = rawChain([open, line]);
      // The verifier does not stop at the hash (rule 1.5): integrity, line 2, the pinned reason.
      const v = verifySessionText(text, "thr_raw");
      assert.equal(v.ok, false, name);
      if (v.ok) continue;
      assert.equal(v.kind, "integrity", name);
      assert.equal(v.line, 2, name);
      assert.equal(v.reason, `malformed ${line.type} payload`, name);
      // And the file-level reader (what doctor and the handoff gate use) refuses it the same way.
      const path = join(dir, `${name.replace(/\W+/g, "_")}.jsonl`);
      writeFileSync(path, text);
      const vf = verifySessionFile(path, "thr_raw");
      assert.equal(vf.ok, false, name);
      assert.equal(vf.ok ? "" : vf.reason, `malformed ${line.type} payload`, name);
      // inspectSessionV2 handed the parsed lines reports a FAIL and does not throw.
      const parsed = text
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => JSON.parse(l) as SessionEvent);
      let findings: ReturnType<typeof inspectSessionV2> = [];
      assert.doesNotThrow(() => {
        findings = inspectSessionV2(dir, parsed);
      }, name);
      // (The fixture is a v2 open with no close and no lock, so `not-cleanly-closed` rides along.)
      assert.deepEqual(
        findings.filter((f) => f.code === "integrity").map((f) => `${f.level} ${f.code}`),
        ["fail integrity"],
        name,
      );
      assert.match(findings[0]?.detail ?? "", /^line 2: malformed /, name);
    }
    // A well-formed v2 file still verifies and reports nothing: the rule is additive.
    const good = rawChain([
      open,
      {
        type: "handoff.out",
        payload: { handoffId: "ho_1", turnId: null, targetSeatId: "hephaestus", brief: "b" },
      },
      {
        type: "handoff.aborted",
        payload: { handoffId: "ho_1", reason: "interrupted", error: null },
      },
      { type: "session.close", payload: { reason: "shutdown", worktree: null } },
    ]);
    const gv = verifySessionText(good, "thr_raw");
    assert.equal(gv.ok, true, gv.ok ? "" : gv.reason);
    assert.deepEqual(
      inspectSessionV2(dir, gv.ok ? gv.events : []).filter((f) => f.code === "integrity"),
      [],
    );
    // The M1 contract is unchanged: a malformed M0 payload still verifies (rebuild refuses it).
    const m0 = verifySessionText(
      rawChain([open, { type: "turn.start", payload: { turnId: "bad id", inputText: "x" } }]),
      "thr_raw",
    );
    assert.equal(m0.ok, true);
    assert.throws(
      () => rebuildSession(m0.ok ? m0.events : []),
      /line 2: malformed turn.start payload/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Argus 5391475289 miss 2 (Copilot 4165236142): after a v2 open, a session.close without the worktree key does not verify, does not rebuild, and is refused by the writer; a v1 close may stay keyless", () => {
  const v2open = { type: "session.open", payload: { ...V2_OPEN } };
  const v1open = { type: "session.open", payload: { ...V1_OPEN } };
  const keyless = { type: "session.close", payload: { reason: "shutdown" } };
  // Read side.
  const v2 = verifySessionText(rawChain([v2open, keyless]), "thr_raw");
  assert.equal(v2.ok, false);
  assert.equal(
    v2.ok ? "" : `${v2.line} ${v2.kind} ${v2.reason}`,
    "2 integrity malformed session.close payload",
  );
  const v1 = verifySessionText(rawChain([v1open, keyless]), "thr_raw");
  assert.equal(v1.ok, true);
  assert.doesNotThrow(() => rebuildSession(v1.ok ? v1.events : []));
  // A v1 file closed by a v2 engine carries `worktree: null`: that still verifies.
  const v1v2 = verifySessionText(
    rawChain([v1open, { type: "session.close", payload: { reason: "shutdown", worktree: null } }]),
    "thr_raw",
  );
  assert.equal(v1v2.ok, true);
  // Write side: the writer on a v2 open refuses the keyless close; on a v1 open it accepts it.
  const f2 = fixture("thr_src", "madc-default", V2_OPEN);
  try {
    const d = expectRefusal(f2, "session.close", { reason: "shutdown" }, "field-missing");
    assert.match(String(d.issues), /worktree is required/);
    f2.writer.append("session.close", { reason: "shutdown", worktree: null });
    assert.equal(verifySessionFile(f2.path, "thr_src").ok, true);
  } finally {
    f2.cleanup();
  }
  const f1 = fixture("thr_v1", "madc-default", V1_OPEN);
  try {
    f1.writer.append("session.close", { reason: "shutdown" });
    const v = verifySessionFile(f1.path, "thr_v1");
    assert.equal(v.ok, true);
    assert.doesNotThrow(() => rebuildSession(v.ok ? v.events : []));
  } finally {
    f1.cleanup();
  }
});

test("Argus 5391475289 miss 4 (Copilot 4165236118): a memory.write naming another seat's memory file, or a nested path, fails the shape check (verify, rebuild, inspect); the type stays reserved for the writer", () => {
  const open = { type: "session.open", payload: { ...V2_OPEN } };
  const receipt = (path: string) => ({
    turnId: "turn_1",
    path,
    op: "append",
    bytes: 3,
    contentSha256: HEX64,
    requestedModel: "m",
    servedModel: "m",
    providerId: BACKING,
    lane: "allowed-direct",
    vendorReported: true,
  });
  // The envelope seat of rawChain is madc-default.
  const own = verifySessionText(
    rawChain([open, { type: "memory.write", payload: receipt("memory/madc-default.md") }]),
    "thr_raw",
  );
  assert.equal(own.ok, true, own.ok ? "" : own.reason);
  assert.doesNotThrow(() => rebuildSession(own.ok ? own.events : []));
  for (const path of [
    "memory/other-seat.md",
    "memory/team/madc-default.md",
    "memory/madc-default/notes.md",
  ]) {
    const text = rawChain([open, { type: "memory.write", payload: receipt(path) }]);
    const v = verifySessionText(text, "thr_raw");
    assert.equal(v.ok, false, path);
    assert.equal(
      v.ok ? "" : `${v.kind} ${v.reason}`,
      "integrity malformed memory.write payload",
      path,
    );
    const parsed = text
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as SessionEvent);
    assert.throws(() => rebuildSession(parsed), /line 2: malformed memory.write payload/, path);
    assert.deepEqual(
      inspectSessionV2("/nonexistent-home", parsed)
        .filter((f) => f.code === "integrity")
        .map((f) => `${f.level} ${f.code}`),
      ["fail integrity"],
      path,
    );
  }
  // Another seat's envelope makes the same path its own: the rule is the envelope seat, not a name.
  const theirs = verifySessionText(
    rawChain(
      [open, { type: "memory.write", payload: receipt("memory/hephaestus.md") }],
      "thr_raw",
      "hephaestus",
    ),
    "thr_raw",
  );
  assert.equal(theirs.ok, true, theirs.ok ? "" : theirs.reason);
  // The writer still refuses the type before any shape check: reserved, nothing appended.
  const f = fixture();
  try {
    expectRefusal(f, "memory.write", receipt("memory/madc-default.md"), "reserved", "turn_1");
    expectRefusal(f, "memory.write", receipt("memory/other-seat.md"), "reserved", "turn_1");
  } finally {
    f.cleanup();
  }
});
