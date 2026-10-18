/**
 * M2-A6 guard tests for PR #63 review findings (Argus round 5, `pr63-review-048c5f1.md`):
 * M1 (inbox-closing guards in `openDecisionsInChain`), L1 (writer index ignores a mismatched
 * `founderDecision.resolved` line), L2 (doctor "no prior founderDecision"). Each test drives the
 * public function on a hand-built, hash-valid chain and asserts the observable outcome.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { openDecisionsInChain } from "./decisions.ts";
import { inspectSessionV2 } from "./handoff.ts";
import { GENESIS_HASH, type SessionEvent, sessionEventHash } from "./session-store.ts";
import { SessionChainIndex, validateForWrite } from "./session-v2.ts";
import { makeHome } from "./testing/harness.ts";

const THREAD = "thr_guard_01";
const SEAT = "madc-default";
const DEFAULT_TEXT = "ship the default";

function chain() {
  const lines: SessionEvent[] = [];
  let prevHash = GENESIS_HASH;
  const push = (type: SessionEvent["type"], payload: Record<string, unknown>): SessionEvent => {
    const seq = lines.length;
    const ts = 1000 + seq;
    const hash = sessionEventHash(prevHash, {
      v: 1,
      seq,
      ts,
      type,
      threadId: THREAD,
      seatId: SEAT,
      payload: payload as unknown as SessionEvent["payload"],
    });
    const ev = {
      v: 1,
      seq,
      ts,
      type,
      threadId: THREAD,
      seatId: SEAT,
      prevHash,
      hash,
      payload,
    } as unknown as SessionEvent;
    lines.push(ev);
    prevHash = hash;
    return ev;
  };
  const open = push("session.open", {
    cwd: null,
    backing: "kimi-code",
    providerId: "kimi-code",
    pinnedModel: "kimi-for-coding",
    worktree: null,
    handoff: null,
  });
  push("turn.start", { turnId: "turn_1", inputText: "hi" });
  return { lines, push, open };
}

function raise(c: ReturnType<typeof chain>, decisionId = "dec_g1"): SessionEvent {
  return c.push("founderDecision", {
    decisionId,
    turnId: "turn_1",
    question: "which way?",
    recommendedDefault: DEFAULT_TEXT,
    evidenceRefs: [
      {
        kind: "session",
        path: `sessions/${THREAD}.jsonl`,
        seq: c.open.seq,
        hash: c.open.hash,
      },
    ],
  });
}

const openIds = (lines: readonly SessionEvent[]) =>
  openDecisionsInChain(lines).map((d) => d.decisionId);

test("M1: a resolution with only decisionSeq wrong leaves the decision open", () => {
  const c = chain();
  const dec = raise(c);
  c.push("founderDecision.resolved", {
    decisionId: "dec_g1",
    decisionSeq: dec.seq + 1,
    decisionHash: dec.hash,
    outcome: "decided",
    resolution: "x",
  });
  assert.deepEqual(openIds(c.lines), ["dec_g1"]);
});

test("M1: a resolution with only decisionHash wrong leaves the decision open", () => {
  const c = chain();
  const dec = raise(c);
  c.push("founderDecision.resolved", {
    decisionId: "dec_g1",
    decisionSeq: dec.seq,
    decisionHash: "0".repeat(64),
    outcome: "decided",
    resolution: "x",
  });
  assert.deepEqual(openIds(c.lines), ["dec_g1"]);
});

test("M1: accepted-default whose resolution differs from recommendedDefault leaves the decision open", () => {
  const c = chain();
  const dec = raise(c);
  c.push("founderDecision.resolved", {
    decisionId: "dec_g1",
    decisionSeq: dec.seq,
    decisionHash: dec.hash,
    outcome: "accepted-default",
    resolution: "not the default",
  });
  assert.deepEqual(openIds(c.lines), ["dec_g1"]);
});

test("M1 control: a fully matching resolution closes the decision, and a bad one then a good one closes it", () => {
  const c = chain();
  const dec = raise(c);
  c.push("founderDecision.resolved", {
    decisionId: "dec_g1",
    decisionSeq: dec.seq,
    decisionHash: "0".repeat(64),
    outcome: "decided",
    resolution: "x",
  });
  assert.deepEqual(openIds(c.lines), ["dec_g1"]);
  c.push("founderDecision.resolved", {
    decisionId: "dec_g1",
    decisionSeq: dec.seq,
    decisionHash: dec.hash,
    outcome: "accepted-default",
    resolution: DEFAULT_TEXT,
  });
  assert.deepEqual(openIds(c.lines), []);
});

function writerAccepts(lines: readonly SessionEvent[], payload: Record<string, unknown>) {
  const index = SessionChainIndex.fromEvents(lines);
  return validateForWrite("founderDecision.resolved", payload, {
    threadId: THREAD,
    seatId: SEAT,
    index,
  });
}

for (const [label, bad] of [
  ["decisionSeq", (dec: SessionEvent) => ({ decisionSeq: dec.seq + 1, decisionHash: dec.hash })],
  ["decisionHash", (dec: SessionEvent) => ({ decisionSeq: dec.seq, decisionHash: "0".repeat(64) })],
] as const) {
  test(`L1: a file holding a resolution with a mismatched ${label} does not make the writer refuse the real resolution`, () => {
    const c = chain();
    const dec = raise(c);
    c.push("founderDecision.resolved", {
      decisionId: "dec_g1",
      ...bad(dec),
      outcome: "decided",
      resolution: "x",
    });
    const good = {
      decisionId: "dec_g1",
      decisionSeq: dec.seq,
      decisionHash: dec.hash,
      outcome: "decided",
      resolution: "y",
    };
    assert.equal(writerAccepts(c.lines, good), null);
    // Control: once a matching resolution is in the file, a second one is refused.
    c.push("founderDecision.resolved", good);
    assert.notEqual(writerAccepts(c.lines, good), null);
  });
}

function noPriorFindings(lines: readonly SessionEvent[]) {
  const h = makeHome();
  try {
    return inspectSessionV2(h.home, lines).filter(
      (f) =>
        f.code === "decision-resolution-mismatch" && f.detail.includes("no prior founderDecision"),
    );
  } finally {
    h.cleanup();
  }
}

test("L2: doctor reports a resolution that comes before its founderDecision as having no prior founderDecision", () => {
  const c = chain();
  const resolvedEarly = c.push("founderDecision.resolved", {
    decisionId: "dec_g1",
    decisionSeq: 3,
    decisionHash: "0".repeat(64),
    outcome: "decided",
    resolution: "x",
  });
  raise(c);
  const found = noPriorFindings(c.lines);
  assert.equal(found.length, 1);
  assert.match(found[0]?.detail ?? "", new RegExp(`at seq ${resolvedEarly.seq} `));
});

test("L2: doctor reports a resolution naming an unknown decisionId as having no prior founderDecision", () => {
  const c = chain();
  const dec = raise(c);
  c.push("founderDecision.resolved", {
    decisionId: "dec_unknown",
    decisionSeq: dec.seq,
    decisionHash: dec.hash,
    outcome: "decided",
    resolution: "x",
  });
  assert.equal(noPriorFindings(c.lines).length, 1);
  // Control: a matching resolution yields no such finding.
  const c2 = chain();
  const d2 = raise(c2);
  c2.push("founderDecision.resolved", {
    decisionId: "dec_g1",
    decisionSeq: d2.seq,
    decisionHash: d2.hash,
    outcome: "decided",
    resolution: "x",
  });
  assert.equal(noPriorFindings(c2.lines).length, 0);
});
