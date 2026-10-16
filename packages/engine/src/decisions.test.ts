/**
 * M2-A6 Founder Decision Inbox acceptance & regression tests
 * (`docs/plan/PIN-madc-M2-founder-decision-inbox.md`, M2 build plan §7 M2-A6, §9 P-M2-3, D-439).
 *
 * Covers:
 * 1. Typed `founderDecision` creation via `decision/raise` (explicit and engine-minted `dec_…` id,
 *    same-file and `git` `EvidenceRef`s, no free-text fallback from `agentMessage`).
 * 2. Closed key sets on `founderDecision`, `EvidenceRef` (`session`, `servedModel`, `git`), and
 *    `founderDecision.resolved` (D-439) — refused with `-32010` before redaction, hashing or I/O,
 *    never echoing the caller key; read-side verifier refuses hand-crafted extra keys.
 * 3. Open decisions retrieved across threads (`listOpenDecisions` + `decision/list`), sorted
 *    deterministically by `(ts, threadId, seq)`, skipping unverified/corrupt session files.
 * 4. Append-only Founder decision resolution (`founderDecision.resolved` via `decision/resolve`) on
 *    both warm and cold threads (`accepted-default` with omitted or matching `resolution`, and
 *    `decided` with custom `resolution`), preserving the original `founderDecision` line untouched.
 * 5. Authorization and integrity checks: `decision/resolve` refused while a turn is active (`-32004`)
 *    or when another live process holds the thread lock (`-32004`); `TurnSink` exposes no resolution
 *    capability; `-32010` refusals on unknown `decisionId`, duplicate resolution, `decisionSeq` /
 *    `decisionHash` mismatch, or `accepted-default` resolution mismatch; and `inspectSessionV2`
 *    `decision-resolution-mismatch` findings without echoing payload text.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import {
  createKimiCodePort,
  FOUNDER_DECISION_RAISE_TOOL,
  honestUserAgent,
  type ProviderPort,
} from "@madc/adapters";
import { createFakeKimiTransport } from "@madc/adapters/testing";
import { type Agent, echoAgent, type TurnSink } from "./agent.ts";
import { listOpenDecisions, openDecisionsInChain } from "./decisions.ts";
import { inspectSessionV2 } from "./handoff.ts";
import { acquireThreadLock, releaseThreadLock } from "./lock.ts";
import type { TerminalFacts } from "./presence/policy.ts";
import type { PresenceTerminal } from "./presence/terminal.ts";
import { ErrorCode } from "./protocol/errors.ts";
import { createProviderAgent } from "./provider-agent.ts";
import { seedRosterSeats } from "./seats/roster.ts";
import { ENGINE_VERSION, EngineConnection, type EngineOptions } from "./server.ts";
import {
  GENESIS_HASH,
  type SessionEvent,
  sessionEventHash,
  verifySessionFile,
} from "./session-store.ts";
import { makeHome } from "./testing/harness.ts";

type WireResponse = {
  id: number | string | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: Record<string, unknown> };
};

const TEST_TERMINAL_FACTS: TerminalFacts = {
  device: "16/18",
  session: null,
};

function makeConfirmingTerminal(
  behavior: (prompt: string, signal: AbortSignal) => Promise<boolean> = async () => true,
  facts: TerminalFacts | null = TEST_TERMINAL_FACTS,
): PresenceTerminal & { readonly prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    probe: () => facts,
    confirm: (prompt, signal) => {
      prompts.push(prompt);
      return behavior(prompt, signal);
    },
  };
}

function createHarness(home: string, opts: Partial<EngineOptions> = {}) {
  seedRosterSeats(home);
  const input = new PassThrough();
  const output = new PassThrough();
  const messages: Array<Record<string, unknown>> = [];
  let buf = "";
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    buf += chunk;
    let nl = buf.indexOf("\n");
    while (nl !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim().length > 0) {
        messages.push(JSON.parse(line) as Record<string, unknown>);
      }
      nl = buf.indexOf("\n");
    }
  });
  const logs: string[] = [];
  const conn = new EngineConnection({
    input,
    output,
    home,
    agent: echoAgent,
    log: (m) => logs.push(m),
    ...opts,
  });
  const call = (id: number, method: string, params?: unknown): WireResponse => {
    const before = messages.length;
    conn.handleLine(JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) }));
    const reply = messages.slice(before).find((m) => m.id === id) as WireResponse | undefined;
    assert.ok(reply !== undefined, `expected synchronous reply for ${method} (id=${id})`);
    return reply;
  };
  const callAsync = (id: number, method: string, params?: unknown): Promise<WireResponse> => {
    const before = messages.length;
    conn.handleLine(JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) }));
    return new Promise<WireResponse>((resolve, reject) => {
      const deadline = Date.now() + 5_000;
      const tick = () => {
        const reply = messages.slice(before).find((m) => m.id === id) as WireResponse | undefined;
        if (reply !== undefined) {
          resolve(reply);
          return;
        }
        if (Date.now() > deadline) {
          reject(new Error(`timed out waiting for reply to ${method} (id=${id})`));
          return;
        }
        setTimeout(tick, 5);
      };
      tick();
    });
  };
  const init = () => {
    const r = call(1, "initialize", { clientInfo: { name: "test", version: "0.0.0" } });
    assert.equal(r.error, undefined);
    conn.handleLine(JSON.stringify({ method: "initialized", params: {} }));
  };
  return { conn, call, callAsync, init, messages, logs, shutdown: () => conn.shutdown() };
}

function readEvents(home: string, threadId: string): readonly SessionEvent[] {
  const path = join(home, "sessions", `${threadId}.jsonl`);
  const v = verifySessionFile(path, threadId, {}, home);
  assert.equal(v.ok, true, v.ok ? "" : `line ${v.line}: ${v.reason}`);
  return v.events;
}

function waitTurnCompleted(messages: ReadonlyArray<Record<string, unknown>>, turnId: string) {
  return new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 5_000;
    const tick = () => {
      const found = messages.some(
        (m) =>
          m.method === "turn/completed" &&
          (m.params as { turn?: { id?: string } } | undefined)?.turn?.id === turnId,
      );
      if (found) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`timed out waiting for turn/completed (${turnId})`));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

const threadIdOf = (r: WireResponse): string => (r.result as { thread: { id: string } }).thread.id;
const turnIdOf = (r: WireResponse): string => (r.result as { turn: { id: string } }).turn.id;

test("M2-A6 capability 1 & 2: decision/raise appends a typed founderDecision with verified EvidenceRef[]; free-text agent prose never creates a decision", async () => {
  const h = makeHome();
  const eng = createHarness(h.home);
  try {
    eng.init();
    const startRes = eng.call(2, "thread/start", {});
    const threadId = threadIdOf(startRes);

    // Run a normal turn whose agent output contains prose that looks like a decision request.
    const turnRes = eng.call(3, "turn/start", {
      threadId,
      input: [{ type: "text", text: "FOUNDER_DECISION_REQUIRED: should we ship?" }],
    });
    const turnId = turnIdOf(turnRes);
    await waitTurnCompleted(eng.messages, turnId);

    // No founderDecision is ever inferred from free-text prose or agentMessage items.
    assert.deepEqual(listOpenDecisions(h.home), []);
    const listBefore = eng.call(4, "decision/list", {});
    assert.deepEqual(listBefore.result, { data: [] });

    // Read the verified session events so we can cite the turn.start line in evidenceRefs.
    const eventsBefore = readEvents(h.home, threadId);
    const turnStartEvent = eventsBefore.find((e) => e.type === "turn.start");
    assert.ok(turnStartEvent !== undefined);

    // Raise a typed founderDecision (omitting decisionId so the engine mints dec_<32 hex>).
    const raise1 = eng.call(5, "decision/raise", {
      threadId,
      turnId,
      question: "Approve schema v2 cutover?",
      recommendedDefault: "Proceed with dual-read window",
      evidenceRefs: [
        {
          kind: "session",
          path: `sessions/${threadId}.jsonl`,
          seq: turnStartEvent.seq,
          hash: turnStartEvent.hash,
        },
        {
          kind: "git",
          sha: "7ef9d41785844235ffe97949e57a502830166d64",
          remote: null,
        },
      ],
    });
    assert.equal(raise1.error, undefined);
    const raised = raise1.result as {
      threadId: string;
      decisionId: string;
      seq: number;
      hash: string;
    };
    assert.equal(raised.threadId, threadId);
    assert.match(raised.decisionId, /^dec_[0-9a-f]{32}$/);

    // Also raise one with an explicit caller-supplied decisionId.
    const raise2 = eng.call(6, "decision/raise", {
      threadId,
      turnId,
      decisionId: "dec_explicit_01",
      question: "Keep fallback lane warm?",
      recommendedDefault: "No, keep single-lane strict",
      evidenceRefs: [
        {
          kind: "session",
          path: `sessions/${threadId}.jsonl`,
          seq: turnStartEvent.seq,
          hash: turnStartEvent.hash,
        },
      ],
    });
    assert.equal(raise2.error, undefined);
    assert.equal(raise2.result?.decisionId, "dec_explicit_01");

    const open = listOpenDecisions(h.home);
    assert.equal(open.length, 2);
    assert.equal(open[0]?.decisionId, raised.decisionId);
    assert.equal(open[1]?.decisionId, "dec_explicit_01");
  } finally {
    eng.shutdown();
    h.cleanup();
  }
});

test("M2-A6 D-439 closed key sets: extra keys on founderDecision, EvidenceRef, and founderDecision.resolved refuse -32010 without echoing the key", async () => {
  const h = makeHome();
  const eng = createHarness(h.home);
  try {
    eng.init();
    const startRes = eng.call(2, "thread/start", {});
    const threadId = threadIdOf(startRes);
    const turnRes = eng.call(3, "turn/start", {
      threadId,
      input: [{ type: "text", text: "hello" }],
    });
    const turnId = turnIdOf(turnRes);
    await waitTurnCompleted(eng.messages, turnId);

    const events = readEvents(h.home, threadId);
    const openEvent = events[0] as SessionEvent;
    const sessionRef = {
      kind: "session" as const,
      path: `sessions/${threadId}.jsonl`,
      seq: openEvent.seq,
      hash: openEvent.hash,
    };

    const secretKey = "sk-extra-caller-key-never-echoed-9999";

    // 1. Extra key on founderDecision (via decision/raise)
    const rExtraDecision = eng.call(4, "decision/raise", {
      threadId,
      turnId,
      decisionId: "dec_extra_1",
      question: "Q?",
      recommendedDefault: "D",
      evidenceRefs: [sessionRef],
      [secretKey]: "leaked-value",
    });
    assert.equal(rExtraDecision.error?.code, ErrorCode.EvidenceInvalid);
    assert.deepEqual(rExtraDecision.error?.data?.issues, [
      "founderDecision has a key outside decisionId, turnId, question, recommendedDefault and evidenceRefs",
    ]);
    assert.equal(JSON.stringify(rExtraDecision).includes(secretKey), false);

    // 2. Extra key on session EvidenceRef
    const rExtraSessionRef = eng.call(5, "decision/raise", {
      threadId,
      turnId,
      decisionId: "dec_extra_2",
      question: "Q?",
      recommendedDefault: "D",
      evidenceRefs: [{ ...sessionRef, [secretKey]: "v" }],
    });
    assert.equal(rExtraSessionRef.error?.code, ErrorCode.EvidenceInvalid);
    assert.deepEqual(rExtraSessionRef.error?.data?.issues, [
      "evidenceRefs[0] has a key outside kind, path, seq and hash",
    ]);
    assert.equal(JSON.stringify(rExtraSessionRef).includes(secretKey), false);

    // 3. Extra key on git EvidenceRef
    const rExtraGitRef = eng.call(6, "decision/raise", {
      threadId,
      turnId,
      decisionId: "dec_extra_3",
      question: "Q?",
      recommendedDefault: "D",
      evidenceRefs: [
        {
          kind: "git",
          sha: "7ef9d41785844235ffe97949e57a502830166d64",
          remote: null,
          [secretKey]: "v",
        },
      ],
    });
    assert.equal(rExtraGitRef.error?.code, ErrorCode.EvidenceInvalid);
    assert.deepEqual(rExtraGitRef.error?.data?.issues, [
      "evidenceRefs[0] has a key outside kind, sha and remote",
    ]);
    assert.equal(JSON.stringify(rExtraGitRef).includes(secretKey), false);

    // 4. Missing or empty evidenceRefs refuses -32010
    const rEmptyRefs = eng.call(7, "decision/raise", {
      threadId,
      turnId,
      decisionId: "dec_empty_refs",
      question: "Q?",
      recommendedDefault: "D",
      evidenceRefs: [],
    });
    assert.equal(rEmptyRefs.error?.code, ErrorCode.EvidenceInvalid);
    assert.equal(rEmptyRefs.error?.data?.reason, "evidence-ref-missing");

    // 5. Raise a valid decision, then test extra key on founderDecision.resolved
    const okRaise = eng.call(8, "decision/raise", {
      threadId,
      turnId,
      decisionId: "dec_valid_1",
      question: "Q?",
      recommendedDefault: "Default answer",
      evidenceRefs: [sessionRef],
    });
    assert.equal(okRaise.error, undefined);
    const { seq: decisionSeq, hash: decisionHash } = okRaise.result as {
      seq: number;
      hash: string;
    };

    const rExtraResolve = eng.call(9, "decision/resolve", {
      threadId,
      decisionId: "dec_valid_1",
      decisionSeq,
      decisionHash,
      outcome: "accepted-default",
      [secretKey]: "v",
    });
    assert.equal(rExtraResolve.error?.code, ErrorCode.EvidenceInvalid);
    assert.deepEqual(rExtraResolve.error?.data?.issues, [
      "founderDecision.resolved has a key outside decisionId, decisionSeq, decisionHash, outcome and resolution",
    ]);
    assert.equal(JSON.stringify(rExtraResolve).includes(secretKey), false);
  } finally {
    eng.shutdown();
    h.cleanup();
  }
});

test("M2-A6 capability 3 & 6: open decisions across threads, deterministic ordering, and append-only resolution (warm and cold threads)", async () => {
  const h = makeHome();
  const eng1 = createHarness(h.home, { terminal: makeConfirmingTerminal(async () => true) });
  let threadA = "";
  let threadB = "";
  let decA1 = { decisionId: "dec_a1", seq: 0, hash: "" };
  let decA2 = { decisionId: "dec_a2", seq: 0, hash: "" };
  let decB1 = { decisionId: "dec_b1", seq: 0, hash: "" };

  try {
    eng1.init();
    threadA = threadIdOf(eng1.call(2, "thread/start", {}));
    threadB = threadIdOf(eng1.call(3, "thread/start", { seatId: "hephaestus" }));

    const turnA = turnIdOf(
      eng1.call(4, "turn/start", { threadId: threadA, input: [{ type: "text", text: "a" }] }),
    );
    await waitTurnCompleted(eng1.messages, turnA);

    const turnB = turnIdOf(
      eng1.call(5, "turn/start", { threadId: threadB, input: [{ type: "text", text: "b" }] }),
    );
    await waitTurnCompleted(eng1.messages, turnB);

    const openA = readEvents(h.home, threadA)[0] as SessionEvent;
    const openB = readEvents(h.home, threadB)[0] as SessionEvent;

    const rA1 = eng1.call(6, "decision/raise", {
      threadId: threadA,
      turnId: turnA,
      decisionId: "dec_a1",
      question: "Question A1?",
      recommendedDefault: "Default A1",
      evidenceRefs: [
        { kind: "session", path: `sessions/${threadA}.jsonl`, seq: openA.seq, hash: openA.hash },
      ],
    });
    assert.equal(rA1.error, undefined);
    decA1 = rA1.result as typeof decA1;

    await new Promise((r) => setTimeout(r, 5));
    const rB1 = eng1.call(7, "decision/raise", {
      threadId: threadB,
      turnId: turnB,
      decisionId: "dec_b1",
      question: "Question B1?",
      recommendedDefault: "Default B1",
      evidenceRefs: [
        { kind: "session", path: `sessions/${threadB}.jsonl`, seq: openB.seq, hash: openB.hash },
      ],
    });
    assert.equal(rB1.error, undefined);
    decB1 = rB1.result as typeof decB1;

    await new Promise((r) => setTimeout(r, 5));
    const rA2 = eng1.call(8, "decision/raise", {
      threadId: threadA,
      turnId: turnA,
      decisionId: "dec_a2",
      question: "Question A2?",
      recommendedDefault: "Default A2",
      evidenceRefs: [
        { kind: "session", path: `sessions/${threadA}.jsonl`, seq: openA.seq, hash: openA.hash },
      ],
    });
    assert.equal(rA2.error, undefined);
    decA2 = rA2.result as typeof decA2;

    // Warm resolution of dec_a1 on threadA using "accepted-default" (with resolution omitted).
    const rawLineBefore = readFileSync(join(h.home, "sessions", `${threadA}.jsonl`), "utf8")
      .trimEnd()
      .split("\n")[decA1.seq];
    const resA1 = await eng1.callAsync(9, "decision/resolve", {
      threadId: threadA,
      decisionId: "dec_a1",
      decisionSeq: decA1.seq,
      decisionHash: decA1.hash,
      outcome: "accepted-default",
    });
    assert.equal(resA1.error, undefined);
    assert.equal(resA1.result?.outcome, "accepted-default");
    assert.equal(resA1.result?.resolution, "Default A1");

    // Original founderDecision line at decA1.seq is byte-for-byte unchanged (append-only).
    const linesAfter = readFileSync(join(h.home, "sessions", `${threadA}.jsonl`), "utf8")
      .trimEnd()
      .split("\n");
    assert.equal(linesAfter[decA1.seq], rawLineBefore);

    // decision/list now returns only dec_b1 and dec_a2.
    const list1 = eng1.call(10, "decision/list", {});
    assert.equal(list1.error, undefined);
    const data1 = (list1.result as { data: Array<{ decisionId: string }> }).data;
    assert.deepEqual(
      data1.map((d) => d.decisionId),
      ["dec_b1", "dec_a2"],
    );
  } finally {
    eng1.shutdown();
  }

  // Cold resolution in a fresh engine process (threadB is not loaded yet when decision/resolve arrives).
  const eng2 = createHarness(h.home, { terminal: makeConfirmingTerminal(async () => true) });
  try {
    eng2.init();
    const resB1 = await eng2.callAsync(2, "decision/resolve", {
      threadId: threadB,
      decisionId: "dec_b1",
      decisionSeq: decB1.seq,
      decisionHash: decB1.hash,
      outcome: "decided",
      resolution: "Founder custom direction for B1",
    });
    assert.equal(resB1.error, undefined);
    assert.equal(resB1.result?.outcome, "decided");
    assert.equal(resB1.result?.resolution, "Founder custom direction for B1");

    const list2 = eng2.call(3, "decision/list", {});
    const data2 = (list2.result as { data: Array<{ decisionId: string }> }).data;
    assert.deepEqual(
      data2.map((d) => d.decisionId),
      ["dec_a2"],
    );

    // Both session chains pass verifySessionFile and inspectSessionV2 with zero findings.
    for (const tid of [threadA, threadB]) {
      const events = readEvents(h.home, tid);
      assert.deepEqual(inspectSessionV2(h.home, events), []);
    }
  } finally {
    eng2.shutdown();
    h.cleanup();
  }
});

test("M2-A6 capability 7: authorization boundary & decisionId grammar (positive & negative executable proofs)", async () => {
  const h = makeHome();
  let sinkKeys: string[] = [];
  let releaseTurn1!: () => void;
  const gate1 = new Promise<void>((r) => {
    releaseTurn1 = r;
  });
  let releaseTurn2!: () => void;
  const gate2 = new Promise<void>((r) => {
    releaseTurn2 = r;
  });
  let turnCount = 0;
  let midTurnResolveAttempt: WireResponse | null = null;
  let activeThreadId = "";
  let raisedSeq = 0;
  let raisedHash = "";

  const probingAgent: Agent = {
    name: "probing",
    async run(_ctx, sink: TurnSink) {
      turnCount += 1;
      sinkKeys = Object.keys(sink);
      if (turnCount === 1) {
        await gate1;
        return;
      }
      // Negative proof (agent mid-turn self-resolution attempt): while turn 2 is inProgress, any
      // attempt to invoke decision/resolve on the connection is refused with -32004 TurnAlreadyActive.
      midTurnResolveAttempt = eng.call(200, "decision/resolve", {
        threadId: activeThreadId,
        decisionId: "dec_guard_1",
        decisionSeq: raisedSeq,
        decisionHash: raisedHash,
        outcome: "accepted-default",
      });
      await gate2;
    },
  };
  const eng = createHarness(h.home, {
    agent: probingAgent,
    terminal: makeConfirmingTerminal(async () => true),
  });
  try {
    // 1. Negative proof: uninitialized protocol caller cannot invoke decision/resolve, decision/raise, or decision/list (-32000 NotInitialized).
    const uninitResolve = eng.call(90, "decision/resolve", {
      threadId: "thr_uninit",
      decisionId: "dec_guard_1",
      decisionSeq: 1,
      decisionHash: "0".repeat(64),
      outcome: "accepted-default",
    });
    assert.equal(uninitResolve.error?.code, ErrorCode.NotInitialized);
    const uninitRaise = eng.call(91, "decision/raise", { threadId: "thr_uninit" });
    assert.equal(uninitRaise.error?.code, ErrorCode.NotInitialized);
    const uninitList = eng.call(92, "decision/list", {});
    assert.equal(uninitList.error?.code, ErrorCode.NotInitialized);

    eng.init();
    const threadId = threadIdOf(eng.call(2, "thread/start", {}));
    activeThreadId = threadId;
    const sessionPath = join(h.home, "sessions", `${threadId}.jsonl`);
    const turn1 = turnIdOf(
      eng.call(3, "turn/start", { threadId, input: [{ type: "text", text: "first" }] }),
    );
    releaseTurn1();
    await waitTurnCompleted(eng.messages, turn1);

    // 2. Negative proof: TurnSink passed to Agent.run exposes only item/receipt/raiseDecision callbacks and
    // never exposes EngineConnection, SessionWriter, or any decision/resolve capability.
    assert.deepEqual([...sinkKeys].sort(), [
      "completeItem",
      "delta",
      "fallbackRejected",
      "newItemId",
      "raiseDecision",
      "repoDecision",
      "signal",
      "startItem",
    ]);
    assert.equal(
      sinkKeys.some((k) => /founderDecision|resolve|session|connection/i.test(k)),
      false,
      `TurnSink keys must not expose decision resolution: ${sinkKeys.join(", ")}`,
    );

    const openEvent = readEvents(h.home, threadId)[0] as SessionEvent;
    const validRef = {
      kind: "session" as const,
      path: `sessions/${threadId}.jsonl`,
      seq: openEvent.seq,
      hash: openEvent.hash,
    };

    // 3. Decision ID grammar enforcement on decision/raise (PIN-madc-M1-protocol-messages.md §1,
    // PIN-madc-M2-evidence-schema-v2.md §1 rule 9: ^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$).
    const beforeBadIdBytes = readFileSync(sessionPath, "utf8");
    for (const badId of [
      "",
      "../traversal",
      "dec/slash",
      "dec\\backslash",
      "dec.dot",
      "dec space",
      "_leading_underscore",
      "-leading-dash",
      "a".repeat(129),
      42,
      null,
    ]) {
      const badRaise = eng.call(100, "decision/raise", {
        threadId,
        turnId: turn1,
        decisionId: badId,
        question: "Grammar check?",
        recommendedDefault: "Reject invalid id",
        evidenceRefs: [validRef],
      });
      assert.equal(badRaise.error?.code, ErrorCode.EvidenceInvalid, JSON.stringify(badId));
      assert.equal(badRaise.error?.data?.reason, "field-invalid", JSON.stringify(badId));
      assert.deepEqual(badRaise.error?.data?.issues, ["decisionId must match the id grammar"]);
    }
    assert.equal(readFileSync(sessionPath, "utf8"), beforeBadIdBytes);

    // Raise a valid decision to test resolution boundaries.
    const raiseRes = eng.call(4, "decision/raise", {
      threadId,
      turnId: turn1,
      decisionId: "dec_guard_1",
      question: "Guard test?",
      recommendedDefault: "Default guard",
      evidenceRefs: [validRef],
    });
    assert.equal(raiseRes.error, undefined);
    const { seq: decisionSeq, hash: decisionHash } = raiseRes.result as {
      seq: number;
      hash: string;
    };
    raisedSeq = decisionSeq;
    raisedHash = decisionHash;
    const snapshotAfterRaise = readFileSync(sessionPath, "utf8");

    // 4. Decision ID grammar enforcement on decision/resolve.
    for (const badId of ["", "../traversal", "dec/slash", "dec.dot", "dec space", "_bad", 42]) {
      const badResolve = eng.call(101, "decision/resolve", {
        threadId,
        decisionId: badId,
        decisionSeq,
        decisionHash,
        outcome: "accepted-default",
      });
      assert.equal(badResolve.error?.code, ErrorCode.EvidenceInvalid, JSON.stringify(badId));
      assert.equal(badResolve.error?.data?.reason, "field-invalid", JSON.stringify(badId));
      assert.deepEqual(badResolve.error?.data?.issues, ["decisionId must match the id grammar"]);
    }
    assert.equal(readFileSync(sessionPath, "utf8"), snapshotAfterRaise);

    // 5. Negative proof: while turn 2 is inProgress on this thread, BOTH an in-turn agent attempt
    // AND an external protocol call on the same connection are refused with -32004 TurnAlreadyActive.
    const turn2 = turnIdOf(
      eng.call(5, "turn/start", { threadId, input: [{ type: "text", text: "second" }] }),
    );
    const snapshotDuringTurn2 = readFileSync(sessionPath, "utf8");
    const activeTurnCall = eng.call(6, "decision/resolve", {
      threadId,
      decisionId: "dec_guard_1",
      decisionSeq,
      decisionHash,
      outcome: "accepted-default",
    });
    assert.equal(activeTurnCall.error?.code, ErrorCode.TurnAlreadyActive);
    assert.equal(activeTurnCall.error?.data?.activeTurnId, turn2);
    assert.equal(readFileSync(sessionPath, "utf8"), snapshotDuringTurn2);

    // 6. Negative proof: while eng holds the thread lock on disk, a separate engine connection
    // (such as a subprocess spawned by a vendor agent) attempting decision/resolve is refused with
    // -32004 TurnAlreadyActive and lockHolderPid === process.pid.
    const engForeign = createHarness(h.home);
    try {
      engForeign.init();
      const foreignLockRes = engForeign.call(2, "decision/resolve", {
        threadId,
        decisionId: "dec_guard_1",
        decisionSeq,
        decisionHash,
        outcome: "accepted-default",
      });
      assert.equal(foreignLockRes.error?.code, ErrorCode.TurnAlreadyActive);
      assert.equal(foreignLockRes.error?.data?.activeTurnId, null);
      assert.equal(foreignLockRes.error?.data?.lockHolderPid, process.pid);
    } finally {
      engForeign.shutdown();
    }

    // Complete turn 2 and verify the agent's own mid-turn attempt inside Agent.run was also refused -32004.
    releaseTurn2();
    await waitTurnCompleted(eng.messages, turn2);
    assert.ok(midTurnResolveAttempt !== null);
    assert.equal((midTurnResolveAttempt as WireResponse).error?.code, ErrorCode.TurnAlreadyActive);
    assert.equal((midTurnResolveAttempt as WireResponse).error?.data?.activeTurnId, turn2);
    assert.deepEqual(
      listOpenDecisions(h.home).map((d) => d.decisionId),
      ["dec_guard_1"],
    );

    // 7. Integrity refusals (-32010): wrong decisionSeq, wrong decisionHash, mismatched accepted-default, unknown decisionId.
    const badSeq = eng.call(7, "decision/resolve", {
      threadId,
      decisionId: "dec_guard_1",
      decisionSeq: decisionSeq + 99,
      decisionHash,
      outcome: "accepted-default",
    });
    assert.equal(badSeq.error?.code, ErrorCode.EvidenceInvalid);
    assert.deepEqual(badSeq.error?.data?.issues, [
      "decisionSeq differs from the founderDecision line",
    ]);

    const badHash = eng.call(8, "decision/resolve", {
      threadId,
      decisionId: "dec_guard_1",
      decisionSeq,
      decisionHash: "0".repeat(64),
      outcome: "accepted-default",
    });
    assert.equal(badHash.error?.code, ErrorCode.EvidenceInvalid);
    assert.deepEqual(badHash.error?.data?.issues, [
      "decisionHash differs from the founderDecision line",
    ]);

    const badDefault = eng.call(9, "decision/resolve", {
      threadId,
      decisionId: "dec_guard_1",
      decisionSeq,
      decisionHash,
      outcome: "accepted-default",
      resolution: "Not the recommended default",
    });
    assert.equal(badDefault.error?.code, ErrorCode.EvidenceInvalid);
    assert.deepEqual(badDefault.error?.data?.issues, [
      "resolution differs from the founderDecision recommendedDefault",
    ]);

    const unknownId = eng.call(10, "decision/resolve", {
      threadId,
      decisionId: "dec_nonexistent",
      decisionSeq,
      decisionHash,
      outcome: "decided",
      resolution: "Some resolution",
    });
    assert.equal(unknownId.error?.code, ErrorCode.EvidenceInvalid);
    assert.deepEqual(unknownId.error?.data?.issues, [
      "decisionId has no founderDecision in this file",
    ]);

    // 8. Positive proof: between turns, the initialized lock-holding protocol caller with confirmed
    // engine-owned operator terminal presence resolves the decision via decision/resolve, appending
    // founderDecision.resolved while preserving all prior lines.
    const linesBeforeResolve = readFileSync(sessionPath, "utf8").trimEnd().split("\n");
    const okResolve = await eng.callAsync(11, "decision/resolve", {
      threadId,
      decisionId: "dec_guard_1",
      decisionSeq,
      decisionHash,
      outcome: "accepted-default",
    });
    assert.equal(okResolve.error, undefined);
    assert.equal(okResolve.result?.outcome, "accepted-default");
    assert.equal(okResolve.result?.resolution, "Default guard");
    const linesAfterResolve = readFileSync(sessionPath, "utf8").trimEnd().split("\n");
    assert.equal(linesAfterResolve.length, linesBeforeResolve.length + 1);
    assert.deepEqual(linesAfterResolve.slice(0, linesBeforeResolve.length), linesBeforeResolve);

    // 9. Duplicate resolution of the same decisionId -> -32010
    const dupResolve = eng.call(12, "decision/resolve", {
      threadId,
      decisionId: "dec_guard_1",
      decisionSeq,
      decisionHash,
      outcome: "decided",
      resolution: "Second thoughts",
    });
    assert.equal(dupResolve.error?.code, ErrorCode.EvidenceInvalid);
    assert.deepEqual(dupResolve.error?.data?.issues, [
      "decisionId already has a founderDecision.resolved in this file",
    ]);
  } finally {
    eng.shutdown();
    h.cleanup();
  }
});

test("M2-A6 doctor (inspectSessionV2) & listOpenDecisions: hand-crafted chains with resolution mismatches report decision-resolution-mismatch without echoing payload text, and corrupt files are skipped", () => {
  const h = makeHome();
  try {
    const threadId = "thr_crafted_01";
    const seatId = "madc-default";
    const path = join(h.home, "sessions", `${threadId}.jsonl`);
    const lock = acquireThreadLock(h.home, threadId);
    assert.equal(lock.ok, true);
    if (lock.ok) releaseThreadLock(lock.handle);

    const lines: SessionEvent[] = [];
    let prevHash = GENESIS_HASH;
    const pushLine = (type: SessionEvent["type"], payload: Record<string, unknown>) => {
      const seq = lines.length;
      const ts = 1000 + seq;
      const hash = sessionEventHash(prevHash, {
        v: 1,
        seq,
        ts,
        type,
        threadId,
        seatId,
        payload: payload as unknown as SessionEvent["payload"],
      });
      const ev = {
        v: 1 as const,
        seq,
        ts,
        type,
        threadId,
        seatId,
        prevHash,
        hash,
        payload,
      } as unknown as SessionEvent;
      lines.push(ev);
      prevHash = hash;
      return ev;
    };

    const openEv = pushLine("session.open", {
      cwd: null,
      backing: "kimi-code",
      providerId: "kimi-code",
      pinnedModel: "kimi-for-coding",
      worktree: null,
      handoff: null,
    });
    pushLine("turn.start", { turnId: "turn_1", inputText: "hi" });
    const decEv = pushLine("founderDecision", {
      decisionId: "dec_craft_1",
      turnId: "turn_1",
      question: "SENSITIVE_QUESTION_TEXT",
      recommendedDefault: "SENSITIVE_DEFAULT_TEXT",
      evidenceRefs: [
        {
          kind: "session",
          path: `sessions/${threadId}.jsonl`,
          seq: openEv.seq,
          hash: openEv.hash,
        },
      ],
    });
    // 1. Resolution naming an unknown decisionId
    pushLine("founderDecision.resolved", {
      decisionId: "dec_ghost",
      decisionSeq: 2,
      decisionHash: decEv.hash,
      outcome: "decided",
      resolution: "SENSITIVE_RESOLUTION_TEXT",
    });
    // 2. Resolution of dec_craft_1 with wrong decisionSeq, wrong decisionHash, and mismatched accepted-default resolution
    pushLine("founderDecision.resolved", {
      decisionId: "dec_craft_1",
      decisionSeq: 99,
      decisionHash: "f".repeat(64),
      outcome: "accepted-default",
      resolution: "SENSITIVE_WRONG_DEFAULT",
    });
    // 3. Duplicate resolution of dec_craft_1
    pushLine("founderDecision.resolved", {
      decisionId: "dec_craft_1",
      decisionSeq: decEv.seq,
      decisionHash: decEv.hash,
      outcome: "decided",
      resolution: "SENSITIVE_DUPLICATE_TEXT",
    });
    pushLine("session.close", { reason: "shutdown", worktree: null });

    writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");

    const findings = inspectSessionV2(h.home, lines);
    const codes = findings.map((f) => f.code);
    assert.deepEqual(codes, [
      "decision-resolution-mismatch",
      "decision-resolution-mismatch",
      "decision-resolution-mismatch",
      "decision-resolution-mismatch",
      "decision-resolution-mismatch",
    ]);
    const serialized = JSON.stringify(findings);
    assert.equal(serialized.includes("SENSITIVE_"), false, "findings must never echo payload text");

    // Because the first resolution of dec_craft_1 had mismatched seq/hash/default and the second
    // resolution was a duplicate only after the mismatched one, openDecisionsInChain keeps
    // dec_craft_1 open until a valid resolution matches seq + hash.
    const openInCrafted = openDecisionsInChain(lines.slice(0, 5));
    assert.equal(openInCrafted.length, 1);
    assert.equal(openInCrafted[0]?.decisionId, "dec_craft_1");

    // Also plant a corrupt session file and verify listOpenDecisions skips it via onSkipped.
    const corruptPath = join(h.home, "sessions", "thr_corrupt_01.jsonl");
    appendFileSync(corruptPath, '{"not":"valid session chain"}\n', "utf8");
    const skipped: Array<[string, string]> = [];
    listOpenDecisions(h.home, (tid, reason) => skipped.push([tid, reason]));
    assert.deepEqual(skipped, [["thr_corrupt_01", "session failed verification"]]);
  } finally {
    h.cleanup();
  }
});

test("F1 regression: decision/resolve requires fresh engine-owned operator confirmation bound to thread, decisionId, outcome, and resolution; refuses when unavailable, declined, or cancelled without mutating session", async () => {
  const h = makeHome();
  const eng1 = createHarness(h.home, { terminal: makeConfirmingTerminal(async () => true) });
  try {
    eng1.init();
    const threadId = threadIdOf(eng1.call(2, "thread/start", {}));
    const turnId = turnIdOf(
      eng1.call(3, "turn/start", { threadId, input: [{ type: "text", text: "raise two" }] }),
    );
    await waitTurnCompleted(eng1.messages, turnId);

    const turnStart = readEvents(h.home, threadId).find((e) => e.type === "turn.start");
    assert.ok(turnStart !== undefined);

    const raise1 = eng1.call(4, "decision/raise", {
      threadId,
      turnId,
      decisionId: "dec_f1_alpha",
      question: "Switch primary store?",
      recommendedDefault: "Keep existing store",
      evidenceRefs: [
        {
          kind: "session",
          path: `sessions/${threadId}.jsonl`,
          seq: turnStart.seq,
          hash: turnStart.hash,
        },
      ],
    });
    assert.equal(raise1.error, undefined);
    const dec1Seq = raise1.result?.seq as number;
    const dec1Hash = raise1.result?.hash as string;

    const raise2 = eng1.call(5, "decision/raise", {
      threadId,
      turnId,
      decisionId: "dec_f1_beta",
      question: "Enable strict audit mode?",
      recommendedDefault: "Enable strict mode",
      evidenceRefs: [
        {
          kind: "session",
          path: `sessions/${threadId}.jsonl`,
          seq: turnStart.seq,
          hash: turnStart.hash,
        },
      ],
    });
    assert.equal(raise2.error, undefined);
    const dec2Seq = raise2.result?.seq as number;
    const dec2Hash = raise2.result?.hash as string;

    // Shut down eng1 so the thread is cold and its lock on disk is free.
    eng1.shutdown();

    const sessionPath = join(h.home, "sessions", `${threadId}.jsonl`);
    const coldSnapshot = readFileSync(sessionPath);
    const coldSha256 = createHash("sha256").update(coldSnapshot).digest("hex");

    // 1. Independent caller, free cold lock, no operator confirmation (default non-stdin harness and explicit null probe): REFUSED.
    // Also pass founder-sounding clientInfo/role/presence claims to verify they are ignored.
    const engNoTty = createHarness(h.home, {
      terminal: {
        probe: () => null,
        confirm: async () => true,
        unsupported: "no controlling terminal",
      },
    });
    try {
      const initRes = engNoTty.call(1, "initialize", {
        clientInfo: { name: "founder", version: "1.0.0" },
      });
      assert.equal(initRes.error, undefined);
      engNoTty.conn.handleLine(JSON.stringify({ method: "initialized", params: {} }));

      const resNoTty = await engNoTty.callAsync(2, "decision/resolve", {
        threadId,
        decisionId: "dec_f1_alpha",
        decisionSeq: dec1Seq,
        decisionHash: dec1Hash,
        outcome: "accepted-default",
      });
      assert.equal(resNoTty.error?.code, ErrorCode.EvidenceInvalid);
      assert.equal(resNoTty.error?.data?.reason, "field-invalid");
      assert.equal(
        createHash("sha256").update(readFileSync(sessionPath)).digest("hex"),
        coldSha256,
        "no unauthorized writes when confirmation is unavailable",
      );
    } finally {
      engNoTty.shutdown();
    }

    // 2. Confirmation declined: REFUSED and zero writes.
    const declinedTerm = makeConfirmingTerminal(async () => false);
    const engDecline = createHarness(h.home, { terminal: declinedTerm });
    try {
      engDecline.init();
      const resDeclined = await engDecline.callAsync(2, "decision/resolve", {
        threadId,
        decisionId: "dec_f1_alpha",
        decisionSeq: dec1Seq,
        decisionHash: dec1Hash,
        outcome: "decided",
        resolution: "Migrate next quarter",
      });
      assert.equal(resDeclined.error?.code, ErrorCode.EvidenceInvalid);
      assert.equal(resDeclined.error?.data?.reason, "field-invalid");
      assert.deepEqual(resDeclined.error?.data?.issues, [
        "Founder resolution confirmation declined",
      ]);
      assert.equal(declinedTerm.prompts.length, 1);
      assert.ok(declinedTerm.prompts[0]?.includes(threadId));
      assert.ok(declinedTerm.prompts[0]?.includes("dec_f1_alpha"));
      assert.ok(declinedTerm.prompts[0]?.includes("decided"));
      assert.ok(declinedTerm.prompts[0]?.includes("Migrate next quarter"));
      assert.equal(
        createHash("sha256").update(readFileSync(sessionPath)).digest("hex"),
        coldSha256,
        "no unauthorized writes when confirmation is declined",
      );
    } finally {
      engDecline.shutdown();
    }

    // 3a. Confirmation interrupted / cancelled at the terminal while connection is live: REFUSED (-32010) and zero writes.
    const interruptedTerm = makeConfirmingTerminal(async () => {
      throw new Error("terminal read interrupted");
    });
    const engInterrupt = createHarness(h.home, { terminal: interruptedTerm });
    try {
      engInterrupt.init();
      const resInterrupted = await engInterrupt.callAsync(2, "decision/resolve", {
        threadId,
        decisionId: "dec_f1_alpha",
        decisionSeq: dec1Seq,
        decisionHash: dec1Hash,
        outcome: "accepted-default",
      });
      assert.equal(resInterrupted.error?.code, ErrorCode.EvidenceInvalid);
      assert.deepEqual(resInterrupted.error?.data?.issues, [
        "Founder resolution confirmation cancelled",
      ]);
      assert.equal(
        createHash("sha256").update(readFileSync(sessionPath)).digest("hex"),
        coldSha256,
        "no unauthorized writes when confirmation is interrupted",
      );
    } finally {
      engInterrupt.shutdown();
    }

    // 3b. Confirmation cancelled by engine shutdown / EOF while waiting for keypress: signal aborted, lock released, and zero writes.
    let notifyPrompted!: () => void;
    const promptedReady = new Promise<void>((resolve) => {
      notifyPrompted = resolve;
    });
    let abortObserved = false;
    const cancelTerm = makeConfirmingTerminal((_prompt, signal) => {
      notifyPrompted();
      return new Promise<boolean>((resolve) => {
        if (signal.aborted) {
          abortObserved = true;
          resolve(false);
          return;
        }
        signal.addEventListener(
          "abort",
          () => {
            abortObserved = true;
            resolve(false);
          },
          { once: true },
        );
      });
    });
    const engCancel = createHarness(h.home, { terminal: cancelTerm });
    try {
      engCancel.init();
      engCancel.conn.handleLine(
        JSON.stringify({
          id: 2,
          method: "decision/resolve",
          params: {
            threadId,
            decisionId: "dec_f1_alpha",
            decisionSeq: dec1Seq,
            decisionHash: dec1Hash,
            outcome: "accepted-default",
          },
        }),
      );
      await promptedReady;
      assert.equal(cancelTerm.prompts.length, 1);
      assert.ok(cancelTerm.prompts[0]?.includes(threadId));
      assert.ok(cancelTerm.prompts[0]?.includes("dec_f1_alpha"));
      assert.ok(cancelTerm.prompts[0]?.includes("accepted-default"));
      assert.ok(cancelTerm.prompts[0]?.includes("Keep existing store"));
      // Concurrent call on the same thread while confirmation is pending is refused -32004.
      const concurrentDuringConfirm = engCancel.call(3, "decision/raise", {
        threadId,
        turnId,
        question: "Concurrent?",
        recommendedDefault: "No",
        evidenceRefs: [
          {
            kind: "session",
            path: `sessions/${threadId}.jsonl`,
            seq: turnStart.seq,
            hash: turnStart.hash,
          },
        ],
      });
      assert.equal(concurrentDuringConfirm.error?.code, ErrorCode.TurnAlreadyActive);
      engCancel.shutdown();
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(abortObserved, true, "shutdown must abort pending decision confirmation");
      assert.equal(
        engCancel.messages.find((m) => m.id === 2),
        undefined,
        "cancelled decision/resolve on shutdown is never answered as resolved",
      );
      assert.equal(
        createHash("sha256").update(readFileSync(sessionPath)).digest("hex"),
        coldSha256,
        "no unauthorized writes when confirmation is cancelled on shutdown",
      );
    } finally {
      engCancel.shutdown();
    }

    // 4. Valid operator confirmation: SUCCESS, and a subsequent resolution on the same thread
    // requires a fresh confirmation bound to the second decision (never reusing the first confirmation).
    let confirmCallCount = 0;
    const selectiveTerm = makeConfirmingTerminal(async () => {
      confirmCallCount += 1;
      return confirmCallCount === 1;
    });
    const engConfirm = createHarness(h.home, { terminal: selectiveTerm });
    try {
      engConfirm.init();
      const resOk = await engConfirm.callAsync(2, "decision/resolve", {
        threadId,
        decisionId: "dec_f1_alpha",
        decisionSeq: dec1Seq,
        decisionHash: dec1Hash,
        outcome: "accepted-default",
      });
      assert.equal(resOk.error, undefined);
      assert.equal(resOk.result?.decisionId, "dec_f1_alpha");
      assert.equal(resOk.result?.outcome, "accepted-default");
      assert.equal(resOk.result?.resolution, "Keep existing store");
      assert.equal(selectiveTerm.prompts.length, 1);
      assert.ok(selectiveTerm.prompts[0]?.includes("dec_f1_alpha"));

      // Second resolution on the same warm thread must prompt again (and fails when declined).
      const snapshotAfterFirst = readFileSync(sessionPath, "utf8");
      const resSecond = await engConfirm.callAsync(3, "decision/resolve", {
        threadId,
        decisionId: "dec_f1_beta",
        decisionSeq: dec2Seq,
        decisionHash: dec2Hash,
        outcome: "decided",
        resolution: "Defer strict mode",
      });
      assert.equal(resSecond.error?.code, ErrorCode.EvidenceInvalid);
      assert.deepEqual(resSecond.error?.data?.issues, ["Founder resolution confirmation declined"]);
      assert.equal(selectiveTerm.prompts.length, 2);
      assert.ok(selectiveTerm.prompts[1]?.includes("dec_f1_beta"));
      assert.ok(selectiveTerm.prompts[1]?.includes("Defer strict mode"));
      assert.equal(readFileSync(sessionPath, "utf8"), snapshotAfterFirst);
    } finally {
      engConfirm.shutdown();
    }
  } finally {
    h.cleanup();
  }
});

test("F2 regression: executing agent raises typed decisions mid-turn via TurnSink.raiseDecision and ProviderTurnRequest.raiseDecision; invalid raise refuses -32010 while turn continues; agent cannot resolve", async () => {
  const h = makeHome();
  const sinkKeyList: string[] = [];
  let typeofRaiseDecision = "undefined";
  let invalidRaiseOutcome: unknown = null;
  let validRaiseOutcome: unknown = null;
  let midTurnResolveRpc: WireResponse | null = null;
  let engRef!: ReturnType<typeof createHarness>;

  const midTurnAgent: Agent = {
    name: "mid-turn",
    async run(ctx, sink: TurnSink) {
      sinkKeyList.push(...Object.keys(sink));
      const raiseFn = sink.raiseDecision;
      typeofRaiseDecision = typeof raiseFn;
      assert.equal(typeof raiseFn, "function", "TurnSink must expose raiseDecision during a turn");
      if (typeof raiseFn !== "function") return;
      assert.equal("resolveDecision" in sink, false, "TurnSink must never expose resolveDecision");

      sink.startItem({
        id: "item_before",
        kind: "agentMessage",
        status: "inProgress",
        text: "starting analysis",
      });
      sink.completeItem({
        id: "item_before",
        kind: "agentMessage",
        status: "completed",
        text: "starting analysis",
      });

      // 1. Invalid mid-turn raise (bad evidenceRef seq/hash) -> refuses -32010 and turn continues.
      invalidRaiseOutcome = raiseFn({
        decisionId: "dec_mid_bad",
        question: "Bad raise?",
        recommendedDefault: "No",
        evidenceRefs: [
          {
            kind: "session",
            path: `sessions/${ctx.threadId}.jsonl`,
            seq: 999,
            hash: "0".repeat(64),
          },
        ],
      });

      // 2. Valid mid-turn raise referencing the active turn's turn.start event.
      const eventsNow = readEvents(h.home, ctx.threadId);
      const turnStart = eventsNow.find(
        (e): e is SessionEvent<"turn.start"> =>
          e.type === "turn.start" &&
          (e.payload as SessionEvent<"turn.start">["payload"]).turnId === ctx.turnId,
      );
      assert.ok(turnStart !== undefined);

      validRaiseOutcome = raiseFn({
        decisionId: "dec_mid_ok",
        question: "Adopt mid-turn schema check?",
        recommendedDefault: "Adopt immediately",
        evidenceRefs: [
          {
            kind: "session",
            path: `sessions/${ctx.threadId}.jsonl`,
            seq: turnStart.seq,
            hash: turnStart.hash,
          },
        ],
      });

      // 3. Agent attempts to resolve its own decision mid-turn over RPC -> refused -32004.
      const okDecision = (
        validRaiseOutcome as {
          ok: boolean;
          decision?: { seq: number; hash: string };
        }
      ).decision;
      if (okDecision) {
        midTurnResolveRpc = await engRef.callAsync(99, "decision/resolve", {
          threadId: ctx.threadId,
          decisionId: "dec_mid_ok",
          decisionSeq: okDecision.seq,
          decisionHash: okDecision.hash,
          outcome: "accepted-default",
        });
      }

      // 4. Turn continues after both the refused raise and the valid raise.
      sink.startItem({
        id: "item_after",
        kind: "agentMessage",
        status: "inProgress",
        text: "continuing turn after decision raise",
      });
      sink.completeItem({
        id: "item_after",
        kind: "agentMessage",
        status: "completed",
        text: "continuing turn after decision raise",
      });
    },
  };

  const eng = createHarness(h.home, {
    agent: midTurnAgent,
    terminal: makeConfirmingTerminal(async () => true),
  });
  engRef = eng;
  try {
    eng.init();
    const threadId = threadIdOf(eng.call(2, "thread/start", {}));
    const turnId = turnIdOf(
      eng.call(3, "turn/start", { threadId, input: [{ type: "text", text: "go" }] }),
    );
    await waitTurnCompleted(eng.messages, turnId);
    assert.equal(typeofRaiseDecision, "function", "TurnSink.raiseDecision must be a function");

    const badOut = invalidRaiseOutcome as {
      ok: boolean;
      error?: { code: number; data?: Record<string, unknown> };
    };
    assert.equal(badOut?.ok, false);
    assert.equal(badOut?.error?.code, ErrorCode.EvidenceInvalid);
    assert.equal(badOut?.error?.data?.reason, "evidence-ref-invalid");

    const goodOut = validRaiseOutcome as {
      ok: boolean;
      decision?: {
        threadId: string;
        turnId: string;
        decisionId: string;
        seq: number;
        hash: string;
      };
    };
    assert.equal(goodOut?.ok, true);
    assert.equal(goodOut?.decision?.threadId, threadId);
    assert.equal(goodOut?.decision?.turnId, turnId);
    assert.equal(goodOut?.decision?.decisionId, "dec_mid_ok");

    // Agent could not resolve its own decision during the turn.
    assert.equal(
      (midTurnResolveRpc as WireResponse | null)?.error?.code,
      ErrorCode.TurnAlreadyActive,
    );

    // Decision is appended and appears in the inbox; the invalid one is not.
    const inbox = listOpenDecisions(h.home);
    assert.deepEqual(
      inbox.map((d) => d.decisionId),
      ["dec_mid_ok"],
    );
    const listRpc = eng.call(4, "decision/list", {});
    assert.equal((listRpc.result?.data as unknown[])?.length, 1);

    // Verify the session chain recorded item_before, the -32010 error item, founderDecision, item_after, and turn.end completed.
    const events = readEvents(h.home, threadId);
    const errorItem = events.find((e) => {
      if (e.type !== "item") return false;
      const item = (e.payload as SessionEvent<"item">["payload"]).item;
      return item.kind === "error" && item.code === ErrorCode.EvidenceInvalid;
    });
    assert.ok(errorItem !== undefined, "expected -32010 error item recorded on invalid raise");
    const afterItem = events.find((e) => {
      if (e.type !== "item") return false;
      const item = (e.payload as SessionEvent<"item">["payload"]).item;
      return item.kind === "agentMessage" && item.id === "item_after";
    });
    assert.ok(afterItem !== undefined, "expected turn to continue after validation refusal");

    // Also verify the real createProviderAgent -> ProviderPort.streamTurn(req) path.
    let activeProviderThreadId = "";
    let activeProviderTurnId = "";
    const providerPort: ProviderPort = {
      providerId: "kimi-code",
      async streamTurn(req) {
        assert.equal(
          typeof req.raiseDecision,
          "function",
          "ProviderTurnRequest must receive raiseDecision from createProviderAgent",
        );
        assert.ok(req.raiseDecision !== undefined);
        const turnStartEv = readEvents(h.home, activeProviderThreadId).find(
          (e): e is SessionEvent<"turn.start"> =>
            e.type === "turn.start" &&
            (e.payload as SessionEvent<"turn.start">["payload"]).turnId === activeProviderTurnId,
        );
        assert.ok(turnStartEv !== undefined);
        const providerRaise = req.raiseDecision({
          decisionId: "dec_provider_mid_1",
          question: "Approve provider-raised decision?",
          recommendedDefault: "Approve provider default",
          evidenceRefs: [
            {
              kind: "session",
              path: `sessions/${activeProviderThreadId}.jsonl`,
              seq: turnStartEv.seq,
              hash: turnStartEv.hash,
            },
          ],
        });
        assert.equal(providerRaise.ok, true);
        req.onTextDelta("provider done");
        return {
          text: "provider done",
          requestedModelId: req.modelId,
          servedModel: req.modelId,
          vendorReported: true,
        };
      },
    };

    const engProvider = createHarness(h.home, {
      agent: createProviderAgent({
        directLanes: [
          {
            providerId: "kimi-code",
            credential: "sk-kimi-synthetic-test",
            createPort: () => providerPort,
            resolvePinnedModel: (m) => ({ ok: true, modelId: m }),
          },
        ],
      }),
      terminal: makeConfirmingTerminal(async () => true),
    });
    try {
      engProvider.init();
      const pThreadId = threadIdOf(engProvider.call(2, "thread/start", {}));
      activeProviderThreadId = pThreadId;
      const pTurnId = turnIdOf(
        engProvider.call(3, "turn/start", {
          threadId: pThreadId,
          input: [{ type: "text", text: "provider turn" }],
        }),
      );
      activeProviderTurnId = pTurnId;
      await waitTurnCompleted(engProvider.messages, pTurnId);
      assert.deepEqual(
        listOpenDecisions(h.home)
          .map((d) => d.decisionId)
          .sort(),
        ["dec_mid_ok", "dec_provider_mid_1"],
      );
    } finally {
      engProvider.shutdown();
    }
  } finally {
    eng.shutdown();
    h.cleanup();
  }
});

test("F3 regression: own __proto__ property from JSON.parse is rejected with -32010 on both decision/raise and decision/resolve without mutating the session", async () => {
  const h = makeHome();
  const eng = createHarness(h.home, { terminal: makeConfirmingTerminal(async () => true) });
  try {
    eng.init();
    const threadId = threadIdOf(eng.call(2, "thread/start", {}));
    const turnId = turnIdOf(
      eng.call(3, "turn/start", { threadId, input: [{ type: "text", text: "proto test" }] }),
    );
    await waitTurnCompleted(eng.messages, turnId);

    const turnStart = readEvents(h.home, threadId).find((e) => e.type === "turn.start");
    assert.ok(turnStart !== undefined);
    const sessionPath = join(h.home, "sessions", `${threadId}.jsonl`);
    const snapshotBeforeRaise = readFileSync(sessionPath, "utf8");

    // 1. decision/raise with an own "__proto__" key constructed via JSON.parse.
    const raiseParamsWithProto = JSON.parse(
      `{"threadId":${JSON.stringify(threadId)},"turnId":${JSON.stringify(turnId)},"decisionId":"dec_proto_1","question":"Q?","recommendedDefault":"D","evidenceRefs":[{"kind":"session","path":${JSON.stringify(`sessions/${threadId}.jsonl`)},"seq":${turnStart.seq},"hash":${JSON.stringify(turnStart.hash)}}],"__proto__":"bypass"}`,
    );
    assert.equal(Object.hasOwn(raiseParamsWithProto, "__proto__"), true);
    const protoRaiseRes = await eng.callAsync(4, "decision/raise", raiseParamsWithProto);
    assert.equal(protoRaiseRes.error?.code, ErrorCode.EvidenceInvalid);
    assert.equal(protoRaiseRes.error?.data?.reason, "field-invalid");
    assert.deepEqual(protoRaiseRes.error?.data?.issues, [
      "founderDecision has a key outside decisionId, turnId, question, recommendedDefault and evidenceRefs",
    ]);
    assert.equal(
      readFileSync(sessionPath, "utf8"),
      snapshotBeforeRaise,
      "no session mutation when decision/raise rejects own __proto__",
    );

    // Raise a valid decision so we can test decision/resolve with an own "__proto__" key.
    const validRaise = eng.call(5, "decision/raise", {
      threadId,
      turnId,
      decisionId: "dec_proto_valid",
      question: "Q?",
      recommendedDefault: "D",
      evidenceRefs: [
        {
          kind: "session",
          path: `sessions/${threadId}.jsonl`,
          seq: turnStart.seq,
          hash: turnStart.hash,
        },
      ],
    });
    assert.equal(validRaise.error, undefined);
    const decisionSeq = validRaise.result?.seq as number;
    const decisionHash = validRaise.result?.hash as string;
    const snapshotAfterValidRaise = readFileSync(sessionPath, "utf8");

    // 2. decision/resolve with an own "__proto__" key constructed via JSON.parse.
    const resolveParamsWithProto = JSON.parse(
      `{"threadId":${JSON.stringify(threadId)},"decisionId":"dec_proto_valid","decisionSeq":${decisionSeq},"decisionHash":${JSON.stringify(decisionHash)},"outcome":"accepted-default","__proto__":"bypass"}`,
    );
    assert.equal(Object.hasOwn(resolveParamsWithProto, "__proto__"), true);
    const protoResolveRes = await eng.callAsync(6, "decision/resolve", resolveParamsWithProto);
    assert.equal(protoResolveRes.error?.code, ErrorCode.EvidenceInvalid);
    assert.equal(protoResolveRes.error?.data?.reason, "field-invalid");
    assert.deepEqual(protoResolveRes.error?.data?.issues, [
      "founderDecision.resolved has a key outside decisionId, decisionSeq, decisionHash, outcome and resolution",
    ]);
    assert.equal(
      readFileSync(sessionPath, "utf8"),
      snapshotAfterValidRaise,
      "no session mutation when decision/resolve rejects own __proto__",
    );
  } finally {
    eng.shutdown();
    h.cleanup();
  }
});

test("F4 regression: decision/list returns fixed sanitized error message and never leaks caller keys, values, or secret-shaped strings", () => {
  const h = makeHome();
  const eng = createHarness(h.home);
  try {
    eng.init();
    const secretPayload = JSON.parse(
      '{"SECRET_KEY_MARKER_ALPHA":"SECRET_VALUE_MARKER_OMEGA","sk_live_synthetic_998877":"Bearer eyJ_synthetic_private_marker","__proto__":{"SECRET_PROTO_MARKER":"proto_val"}}',
    );
    const res = eng.call(2, "decision/list", secretPayload);
    assert.equal(res.error?.code, ErrorCode.InvalidParams);
    assert.equal(res.error?.message, "Invalid params");
    assert.deepEqual(res.error?.data?.issues, ["decision/list takes no params"]);

    const observable = `${JSON.stringify(res)}\n${eng.logs.join("\n")}`;
    for (const marker of [
      "SECRET_KEY_MARKER_ALPHA",
      "SECRET_VALUE_MARKER_OMEGA",
      "sk_live_synthetic_998877",
      "eyJ_synthetic_private_marker",
      "SECRET_PROTO_MARKER",
      "proto_val",
    ]) {
      assert.equal(
        observable.includes(marker),
        false,
        `observable response/logs must not leak marker ${marker}`,
      );
    }
  } finally {
    eng.shutdown();
    h.cleanup();
  }
});

test("F5 regression: refused cold resolution on a session with a dangling turn leaves the file byte-for-byte unchanged, while valid cold resolution recovers and resolves", async () => {
  const h = makeHome();
  try {
    seedRosterSeats(h.home);
    const threadId = "thr_cold_dangling_01";
    const seatId = "madc-default";
    const sessionPath = join(h.home, "sessions", `${threadId}.jsonl`);

    // Ensure sessions/ directory exists via lock acquire + release.
    const lock = acquireThreadLock(h.home, threadId);
    assert.equal(lock.ok, true);
    if (lock.ok) releaseThreadLock(lock.handle);

    // Construct a verified session ending in a dangling turn (turn.start with no turn.end) and an open founderDecision.
    const lines: SessionEvent[] = [];
    let prevHash = GENESIS_HASH;
    const pushLine = (type: SessionEvent["type"], payload: Record<string, unknown>) => {
      const seq = lines.length;
      const ts = 2000 + seq;
      const hash = sessionEventHash(prevHash, {
        v: 1,
        seq,
        ts,
        type,
        threadId,
        seatId,
        payload: payload as unknown as SessionEvent["payload"],
      });
      const ev = {
        v: 1 as const,
        seq,
        ts,
        type,
        threadId,
        seatId,
        prevHash,
        hash,
        payload,
      } as unknown as SessionEvent;
      lines.push(ev);
      prevHash = hash;
      return ev;
    };

    const openEv = pushLine("session.open", {
      cwd: null,
      backing: "kimi-code",
      providerId: "kimi-code",
      pinnedModel: "kimi-for-coding",
      worktree: null,
      handoff: null,
    });
    pushLine("turn.start", { turnId: "turn_dangling_1", inputText: "unclosed turn" });
    const decEv = pushLine("founderDecision", {
      decisionId: "dec_cold_dangling",
      turnId: "turn_dangling_1",
      question: "Resolve after crash?",
      recommendedDefault: "Keep safe baseline",
      evidenceRefs: [
        {
          kind: "session",
          path: `sessions/${threadId}.jsonl`,
          seq: openEv.seq,
          hash: openEv.hash,
        },
      ],
    });

    writeFileSync(sessionPath, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");

    const origBytes = readFileSync(sessionPath);
    const origSha256 = createHash("sha256").update(origBytes).digest("hex");
    const origSize = statSync(sessionPath).size;
    const origEvents = readEvents(h.home, threadId);
    const origNextSeq = origEvents.length;
    assert.equal(origNextSeq, 3);

    const assertFileUntouched = (label: string) => {
      const nowBytes = readFileSync(sessionPath);
      const nowSha256 = createHash("sha256").update(nowBytes).digest("hex");
      const nowSize = statSync(sessionPath).size;
      const nowEvents = readEvents(h.home, threadId);
      assert.equal(nowSize, origSize, `${label}: file size must be unchanged`);
      assert.equal(nowSha256, origSha256, `${label}: SHA-256 must be unchanged`);
      assert.equal(
        Buffer.compare(nowBytes, origBytes),
        0,
        `${label}: exact bytes must be unchanged`,
      );
      assert.equal(nowEvents.length, origNextSeq, `${label}: nextSeq must be unchanged`);
    };

    const eng = createHarness(h.home, { terminal: makeConfirmingTerminal(async () => true) });
    try {
      eng.init();

      // 1. Invalid decisionSeq on cold thread with dangling turn -> -32010 and zero bytes written.
      const badSeqRes = await eng.callAsync(2, "decision/resolve", {
        threadId,
        decisionId: "dec_cold_dangling",
        decisionSeq: 99,
        decisionHash: decEv.hash,
        outcome: "accepted-default",
      });
      assert.equal(badSeqRes.error?.code, ErrorCode.EvidenceInvalid);
      assert.deepEqual(badSeqRes.error?.data?.issues, [
        "decisionSeq differs from the founderDecision line",
      ]);
      assertFileUntouched("invalid decisionSeq");

      // 2. Invalid decisionHash on cold thread with dangling turn -> -32010 and zero bytes written.
      const badHashRes = await eng.callAsync(3, "decision/resolve", {
        threadId,
        decisionId: "dec_cold_dangling",
        decisionSeq: decEv.seq,
        decisionHash: "0".repeat(64),
        outcome: "accepted-default",
      });
      assert.equal(badHashRes.error?.code, ErrorCode.EvidenceInvalid);
      assert.deepEqual(badHashRes.error?.data?.issues, [
        "decisionHash differs from the founderDecision line",
      ]);
      assertFileUntouched("invalid decisionHash");

      // 3. Mismatched accepted-default resolution on cold thread -> -32010 and zero bytes written.
      const badDefaultRes = await eng.callAsync(4, "decision/resolve", {
        threadId,
        decisionId: "dec_cold_dangling",
        decisionSeq: decEv.seq,
        decisionHash: decEv.hash,
        outcome: "accepted-default",
        resolution: "Not the recommended default",
      });
      assert.equal(badDefaultRes.error?.code, ErrorCode.EvidenceInvalid);
      assert.deepEqual(badDefaultRes.error?.data?.issues, [
        "resolution differs from the founderDecision recommendedDefault",
      ]);
      assertFileUntouched("mismatched accepted-default");

      // 4. Unknown decisionId on cold thread -> -32010 and zero bytes written.
      const unknownIdRes = await eng.callAsync(5, "decision/resolve", {
        threadId,
        decisionId: "dec_unknown_cold",
        decisionSeq: decEv.seq,
        decisionHash: decEv.hash,
        outcome: "decided",
        resolution: "Custom",
      });
      assert.equal(unknownIdRes.error?.code, ErrorCode.EvidenceInvalid);
      assert.deepEqual(unknownIdRes.error?.data?.issues, [
        "decisionId has no founderDecision in this file",
      ]);
      assertFileUntouched("unknown decisionId");

      // 5. Valid cold resolution with confirmed operator terminal -> recovers dangling turn AND appends founderDecision.resolved, leaving writer usable.
      const okRes = await eng.callAsync(6, "decision/resolve", {
        threadId,
        decisionId: "dec_cold_dangling",
        decisionSeq: decEv.seq,
        decisionHash: decEv.hash,
        outcome: "accepted-default",
      });
      assert.equal(okRes.error, undefined);
      assert.equal(okRes.result?.decisionId, "dec_cold_dangling");
      assert.equal(okRes.result?.outcome, "accepted-default");
      assert.equal(okRes.result?.resolution, "Keep safe baseline");

      const eventsAfter = readEvents(h.home, threadId);
      assert.equal(eventsAfter.length, 5);
      assert.equal(eventsAfter[3]?.type, "turn.end");
      const recoveredEnd = eventsAfter[3]?.payload as SessionEvent<"turn.end">["payload"];
      assert.equal(recoveredEnd.turnId, "turn_dangling_1");
      assert.equal(recoveredEnd.status, "interrupted");
      assert.equal(recoveredEnd.error, null);
      assert.equal(eventsAfter[4]?.type, "founderDecision.resolved");
      const resolvedEv = eventsAfter[4]
        ?.payload as SessionEvent<"founderDecision.resolved">["payload"];
      assert.equal(resolvedEv.decisionId, "dec_cold_dangling");

      // Verify the writer on the now-warm thread remains usable for a subsequent turn.
      const nextTurnId = turnIdOf(
        eng.call(7, "turn/start", { threadId, input: [{ type: "text", text: "after recovery" }] }),
      );
      await waitTurnCompleted(eng.messages, nextTurnId);
      const finalEvents = readEvents(h.home, threadId);
      assert.ok(finalEvents.length > 5);
    } finally {
      eng.shutdown();
    }
  } finally {
    h.cleanup();
  }
});

test("F2 real direct-lane adapter (createKimiCodePort / createDirectKeyPort): native pi-ai founder_decision_raise tool discovery, valid and invalid model-originated raises, authority enforcement, and turn continuation", async () => {
  const h = makeHome();
  const fakeKimi = createFakeKimiTransport();
  const realProviderAgent = createProviderAgent({
    credential: { ok: true, apiKey: "sk-kimi-synthetic-f2-test" },
    createPort: (apiKey) =>
      createKimiCodePort({
        apiKey,
        userAgent: honestUserAgent(ENGINE_VERSION),
        baseUrl: "https://kimi-fake.invalid/coding",
        fetch: fakeKimi.fetch,
      }),
  });
  const eng = createHarness(h.home, {
    agent: realProviderAgent,
    terminal: makeConfirmingTerminal(async () => true),
  });
  try {
    eng.init();
    const threadId = threadIdOf(eng.call(2, "thread/start", {}));
    const openEv = readEvents(h.home, threadId)[0];
    assert.ok(openEv !== undefined && openEv.type === "session.open");

    // Queue synthetic native pi-ai model responses across a single active turn:
    // 1. (C) Invalid model-originated raise: bad evidenceRefs (seq 999 / all-zero hash) -> -32010 tool_result (is_error: true).
    fakeKimi.queueReply({
      type: "tool-call",
      id: "call_f2_invalid_ev",
      name: "founder_decision_raise",
      args: {
        decisionId: "dec_real_invalid_ev",
        question: "Should invalid evidence succeed?",
        recommendedDefault: "Never",
        evidenceRefs: [
          {
            kind: "session",
            path: `sessions/${threadId}.jsonl`,
            seq: 999,
            hash: "0".repeat(64),
          },
        ],
      },
      model: "kimi-for-coding",
    });

    // 2. (E) Authority check: model attempts to override threadId and turnId -> -32010 tool_result (is_error: true).
    fakeKimi.queueReply({
      type: "tool-call",
      id: "call_f2_forged_identity",
      name: "founder_decision_raise",
      args: {
        decisionId: "dec_real_forged_identity",
        threadId: "thr_other_spoofed",
        turnId: "turn_other_spoofed",
        question: "Can the model choose threadId or turnId?",
        recommendedDefault: "Never",
        evidenceRefs: [
          {
            kind: "session",
            path: `sessions/${threadId}.jsonl`,
            seq: openEv.seq,
            hash: openEv.hash,
          },
        ],
      },
      model: "kimi-for-coding",
    });

    // 3. (E) Authority check: model attempts to invoke decision/resolve -> error tool_result (is_error: true).
    fakeKimi.queueReply({
      type: "tool-call",
      id: "call_f2_resolve_forbidden",
      name: "decision/resolve",
      args: {
        threadId,
        decisionId: "dec_real_model_ok",
        outcome: "accepted-default",
      },
      model: "kimi-for-coding",
    });

    // 4. (B) Valid model-originated raise: valid question, recommendedDefault, and evidenceRefs -> recorded mid-turn.
    fakeKimi.queueReply({
      type: "tool-call",
      id: "call_f2_valid_raise",
      name: "founder_decision_raise",
      args: {
        decisionId: "dec_real_model_ok",
        question: "Proceed with native pi-ai founder_decision_raise tool?",
        recommendedDefault: "Proceed with bounded single-tool capability",
        evidenceRefs: [
          {
            kind: "session",
            path: `sessions/${threadId}.jsonl`,
            seq: openEv.seq,
            hash: openEv.hash,
          },
        ],
      },
      model: "kimi-for-coding",
    });

    // 5. (D) Turn continuation: after receiving the structured tool results, the model streams its final output.
    fakeKimi.queueReply({
      type: "stream",
      chunks: ["Decision ", "dec_real_model_ok ", "raised; turn complete."],
      model: "kimi-for-coding",
    });

    const turnId = turnIdOf(
      eng.call(3, "turn/start", {
        threadId,
        input: [{ type: "text", text: "Evaluate and raise a founder decision if needed." }],
      }),
    );
    await waitTurnCompleted(eng.messages, turnId);
    const completedMsg = eng.messages.find(
      (m) =>
        m.method === "turn/completed" &&
        ((m.params as { turn?: { id?: string } })?.turn?.id ?? "") === turnId,
    );
    assert.ok(completedMsg !== undefined);
    const completedTurn = (
      completedMsg.params as {
        turn: {
          id: string;
          status: string;
          items: Array<{ kind: string; text?: string; code?: number }>;
        };
      }
    ).turn;
    assert.equal(completedTurn.status, "completed");

    // A. TOOL DISCOVERY: verify the shipped adapter advertised founder_decision_raise in pi-ai's native Anthropic format.
    const firstReqBody = JSON.parse(fakeKimi.requests[0]?.body ?? "{}") as {
      tools?: Array<{
        name: string;
        description?: string;
        input_schema?: {
          type: string;
          required?: string[];
          properties?: Record<string, unknown>;
        };
      }>;
    };
    assert.ok(
      Array.isArray(firstReqBody.tools),
      `adapter must advertise native tools array (got tools=${String(firstReqBody.tools)}, requests=${fakeKimi.requests.length}, openDecisions=${listOpenDecisions(h.home).length})`,
    );
    assert.equal(
      fakeKimi.requests.length,
      5,
      "expected 4 tool-call round-trips + 1 final completion request",
    );
    assert.equal(firstReqBody.tools.length, 1, "adapter must expose only founder_decision_raise");
    const advertisedTool = firstReqBody.tools[0];
    assert.ok(advertisedTool !== undefined);
    assert.equal(advertisedTool.name, "founder_decision_raise");
    assert.deepEqual([...(advertisedTool.input_schema?.required ?? [])].sort(), [
      "evidenceRefs",
      "question",
      "recommendedDefault",
    ]);
    assert.ok(advertisedTool.input_schema?.properties !== undefined);
    assert.equal("question" in advertisedTool.input_schema.properties, true);
    assert.equal("recommendedDefault" in advertisedTool.input_schema.properties, true);
    assert.equal("evidenceRefs" in advertisedTool.input_schema.properties, true);
    assert.equal("decisionId" in advertisedTool.input_schema.properties, true);
    assert.equal(
      "threadId" in advertisedTool.input_schema.properties,
      false,
      "tool schema must not advertise threadId",
    );
    assert.equal(
      "turnId" in advertisedTool.input_schema.properties,
      false,
      "tool schema must not advertise turnId",
    );

    // C. INVALID MODEL-ORIGINATED RAISE: verify second request carries -32010 tool_result error back to the model.
    const secondReqBody = JSON.parse(fakeKimi.requests[1]?.body ?? "{}") as {
      messages: Array<{
        role: string;
        content: unknown;
      }>;
    };
    const secondReqSerialized = JSON.stringify(secondReqBody.messages);
    assert.equal(secondReqSerialized.includes("call_f2_invalid_ev"), true);
    assert.equal(secondReqSerialized.includes(String(ErrorCode.EvidenceInvalid)), true);
    assert.equal(secondReqSerialized.includes("evidence-ref-invalid"), true);

    // E. AUTHORITY: verify third request carries -32010 field-invalid refusal when model supplies threadId/turnId,
    // and fourth request carries error tool_result when model attempts decision/resolve.
    const thirdReqSerialized = fakeKimi.requests[2]?.body ?? "";
    assert.equal(thirdReqSerialized.includes("call_f2_forged_identity"), true);
    assert.equal(thirdReqSerialized.includes(String(ErrorCode.EvidenceInvalid)), true);
    assert.equal(thirdReqSerialized.includes("field-invalid"), true);

    const fourthReqSerialized = fakeKimi.requests[3]?.body ?? "";
    assert.equal(fourthReqSerialized.includes("call_f2_resolve_forbidden"), true);
    assert.equal(fourthReqSerialized.includes('"is_error":true'), true);

    // B. VALID MODEL-ORIGINATED RAISE: verify fifth request carries structured success tool_result and decision is recorded.
    const fifthReqSerialized = fakeKimi.requests[4]?.body ?? "";
    assert.equal(fifthReqSerialized.includes("call_f2_valid_raise"), true);
    assert.equal(fifthReqSerialized.includes("dec_real_model_ok"), true);

    const openDecisions = listOpenDecisions(h.home);
    assert.equal(openDecisions.length, 1);
    assert.equal(openDecisions[0]?.decisionId, "dec_real_model_ok");
    assert.equal(openDecisions[0]?.threadId, threadId);
    assert.equal(openDecisions[0]?.turnId, turnId);
    assert.equal(
      openDecisions[0]?.question,
      "Proceed with native pi-ai founder_decision_raise tool?",
    );
    assert.equal(
      openDecisions[0]?.recommendedDefault,
      "Proceed with bounded single-tool capability",
    );

    const rpcList = eng.call(4, "decision/list", {});
    assert.equal(rpcList.error, undefined);
    const rpcDecisions = rpcList.result?.data as Array<{ decisionId: string; turnId: string }>;
    assert.equal(rpcDecisions.length, 1);
    assert.equal(rpcDecisions[0]?.decisionId, "dec_real_model_ok");
    assert.equal(rpcDecisions[0]?.turnId, turnId);

    // D. TURN CONTINUATION & SESSION INTEGRITY: verify final assistant output, servedModel receipt, and verified chain.
    const agentMessages = completedTurn.items.filter((i) => i.kind === "agentMessage");
    assert.equal(agentMessages.length, 1);
    assert.equal(agentMessages[0]?.text, "Decision dec_real_model_ok raised; turn complete.");

    const sessionPath = join(h.home, "sessions", `${threadId}.jsonl`);
    const verified = verifySessionFile(sessionPath);
    assert.equal(verified.ok, true, "session chain must verify cleanly");
    const events = readEvents(h.home, threadId);
    const decisionEvents = events.filter((e) => e.type === "founderDecision");
    assert.equal(decisionEvents.length, 1, "only the valid decision may be written");
    assert.equal(
      events.some((e) => e.type === "founderDecision.resolved"),
      false,
      "model must never write founderDecision.resolved",
    );
    assert.equal(
      events.some((e) => e.type === "servedModel"),
      true,
      "servedModel receipt must still be recorded",
    );

    // Bounded tool-call loop & duplicate decision prevention: queue 8 consecutive duplicate tool-calls
    // and verify the adapter executes at most MAX_DECISION_TOOL_ROUNDS (4) tool rounds (5 HTTP requests)
    // and writes zero duplicate decisions.
    const reqCountBeforeLoopTurn = fakeKimi.requests.length;
    for (let i = 0; i < 8; i += 1) {
      fakeKimi.queueReply({
        type: "tool-call",
        id: `call_f2_dup_${i}`,
        name: "founder_decision_raise",
        args: {
          decisionId: "dec_real_model_ok",
          question: "Duplicate raise in loop?",
          recommendedDefault: "No",
          evidenceRefs: [
            {
              kind: "session",
              path: `sessions/${threadId}.jsonl`,
              seq: openEv.seq,
              hash: openEv.hash,
            },
          ],
        },
        model: "kimi-for-coding",
      });
    }
    const loopTurnId = turnIdOf(
      eng.call(5, "turn/start", {
        threadId,
        input: [{ type: "text", text: "Attempt unbounded tool loop." }],
      }),
    );
    await waitTurnCompleted(eng.messages, loopTurnId);
    const loopCompletedMsg = eng.messages.find(
      (m) =>
        m.method === "turn/completed" &&
        ((m.params as { turn?: { id?: string } })?.turn?.id ?? "") === loopTurnId,
    );
    assert.ok(loopCompletedMsg !== undefined);
    const loopTurn = (loopCompletedMsg.params as { turn: { status: string } }).turn;
    assert.equal(
      loopTurn.status,
      "failed",
      "exhausting MAX_DECISION_TOOL_ROUNDS with another tool call must fail the turn",
    );
    assert.equal(
      fakeKimi.requests.length - reqCountBeforeLoopTurn,
      5,
      "MAX_DECISION_TOOL_ROUNDS (4) must cap tool round-trips at 4 (5 HTTP requests total)",
    );
    assert.equal(
      listOpenDecisions(h.home).length,
      1,
      "duplicate decisionId in bounded loop must not create a second decision",
    );
  } finally {
    eng.shutdown();
    h.cleanup();
  }
});

test("F2 tool-limit exhaustion regression: four distinct valid decision-tool rounds followed by a fifth tool-call response fails the provider turn while preserving the four recorded decisions, with no fifth callback, no servedModel receipt, and sanitized error", async () => {
  const h = makeHome();
  const fakeKimi = createFakeKimiTransport();
  const syntheticSecretKey = "sk-kimi-synthetic-exhaust-secret-9911";
  let raiseCallbackCount = 0;

  const realProviderAgent = createProviderAgent({
    credential: { ok: true, apiKey: syntheticSecretKey },
    createPort: (apiKey) => {
      const innerPort = createKimiCodePort({
        apiKey,
        userAgent: honestUserAgent(ENGINE_VERSION),
        baseUrl: "https://kimi-fake.invalid/coding",
        fetch: fakeKimi.fetch,
      });
      return {
        providerId: innerPort.providerId,
        streamTurn(req) {
          const origRaise = req.raiseDecision;
          return innerPort.streamTurn({
            ...req,
            ...(origRaise === undefined
              ? {}
              : {
                  raiseDecision: (input) => {
                    raiseCallbackCount += 1;
                    return origRaise(input);
                  },
                }),
          });
        },
      };
    },
  });

  const eng = createHarness(h.home, {
    agent: realProviderAgent,
    terminal: makeConfirmingTerminal(async () => true),
  });

  try {
    eng.init();
    const threadId = threadIdOf(eng.call(2, "thread/start", {}));
    const openEv = readEvents(h.home, threadId)[0];
    assert.ok(openEv !== undefined && openEv.type === "session.open");

    // Queue four permitted decision-tool rounds (four distinct valid decisions) plus a fifth response
    // requesting another distinct valid decision after MAX_DECISION_TOOL_ROUNDS (4) is exhausted.
    for (let i = 1; i <= 4; i += 1) {
      fakeKimi.queueReply({
        type: "tool-call",
        id: `call_exhaust_${i}`,
        name: "founder_decision_raise",
        args: {
          decisionId: `dec_exhaust_${i}`,
          question: `Permitted decision question ${i}?`,
          recommendedDefault: `Permitted default ${i}`,
          evidenceRefs: [
            {
              kind: "session",
              path: `sessions/${threadId}.jsonl`,
              seq: openEv.seq,
              hash: openEv.hash,
            },
          ],
        },
        model: "kimi-for-coding",
      });
    }
    fakeKimi.queueReply({
      type: "tool-call",
      id: "call_exhaust_5",
      name: "founder_decision_raise",
      args: {
        decisionId: "dec_exhaust_5",
        question: "FifthQuestion_MUST_NOT_EXECUTE_OR_LEAK?",
        recommendedDefault: "FifthDefault_MUST_NOT_EXECUTE_OR_LEAK",
        evidenceRefs: [
          {
            kind: "session",
            path: `sessions/${threadId}.jsonl`,
            seq: openEv.seq,
            hash: openEv.hash,
          },
        ],
      },
      model: "kimi-for-coding",
    });

    const turnId = turnIdOf(
      eng.call(3, "turn/start", {
        threadId,
        input: [{ type: "text", text: "Raise five decisions in five rounds." }],
      }),
    );
    await waitTurnCompleted(eng.messages, turnId);

    const completedMsg = eng.messages.find(
      (m) =>
        m.method === "turn/completed" &&
        ((m.params as { turn?: { id?: string } })?.turn?.id ?? "") === turnId,
    );
    assert.ok(completedMsg !== undefined);
    const finishedTurn = (
      completedMsg.params as {
        turn: {
          id: string;
          status: string;
          error: { code: number; message: string } | null;
          items: Array<{ kind: string; status: string; message?: string; code?: number }>;
        };
      }
    ).turn;

    // 1. Four prior decisions remain recorded; fifth decision is not recorded.
    const openDecisionIds = listOpenDecisions(h.home).map((d) => d.decisionId);
    assert.deepEqual(
      openDecisionIds,
      ["dec_exhaust_1", "dec_exhaust_2", "dec_exhaust_3", "dec_exhaust_4"],
      "four prior decisions must remain recorded and fifth decision must not be recorded",
    );

    // 2. No fifth decision callback is executed and no 6th HTTP request is made.
    assert.equal(
      raiseCallbackCount,
      4,
      "no fifth decision callback may be executed after MAX_DECISION_TOOL_ROUNDS (4)",
    );
    assert.equal(
      fakeKimi.requests.length,
      5,
      "exactly 5 HTTP requests (4 tool rounds + 5th reply)",
    );

    // 3. Turn status is FAILED, not COMPLETED.
    assert.equal(
      finishedTurn.status,
      "failed",
      `turn status must be failed when 5th response requests another tool call (got status=${finishedTurn.status}, openDecisionIds=${JSON.stringify(openDecisionIds)}, raiseCallbackCount=${raiseCallbackCount})`,
    );
    assert.deepEqual(finishedTurn.error, {
      code: ErrorCode.InternalError,
      message: "kimi-code decision tool limit reached",
    });

    // 4. No successful served-model receipt for the failed turn.
    assert.equal(
      finishedTurn.items.some((i) => i.kind === "servedModel"),
      false,
      "failed turn must not contain a servedModel item",
    );

    // 5. Session chain still verifies, records 4 founderDecision events, 0 servedModel events, and turn.end failed.
    const sessionPath = join(h.home, "sessions", `${threadId}.jsonl`);
    const verified = verifySessionFile(sessionPath);
    assert.equal(verified.ok, true, "session chain must verify cleanly after failed turn");
    const events = readEvents(h.home, threadId);
    assert.deepEqual(
      events
        .filter((e) => e.type === "founderDecision")
        .map((e) => (e.payload as SessionEvent<"founderDecision">["payload"]).decisionId),
      ["dec_exhaust_1", "dec_exhaust_2", "dec_exhaust_3", "dec_exhaust_4"],
    );
    assert.equal(
      events.some((e) => e.type === "servedModel"),
      false,
      "session JSONL must not record a servedModel receipt for the failed turn",
    );
    const turnEndEv = events.find((e) => e.type === "turn.end");
    assert.ok(turnEndEv !== undefined);
    const turnEndPayload = turnEndEv.payload as SessionEvent<"turn.end">["payload"];
    assert.equal(turnEndPayload.status, "failed");
    assert.deepEqual(turnEndPayload.error, {
      code: ErrorCode.InternalError,
      message: "kimi-code decision tool limit reached",
    });

    // 6. Error is sanitized: no model text, tool arguments, 5th decision payload, or credentials leak.
    const errorSurface = `${JSON.stringify(finishedTurn.error)}\n${JSON.stringify(turnEndPayload.error)}\n${eng.logs.join("\n")}`;
    for (const forbiddenMarker of [
      syntheticSecretKey,
      "dec_exhaust_5",
      "FifthQuestion_MUST_NOT_EXECUTE_OR_LEAK",
      "FifthDefault_MUST_NOT_EXECUTE_OR_LEAK",
      "call_exhaust_5",
    ]) {
      assert.equal(
        errorSurface.includes(forbiddenMarker),
        false,
        `sanitized error surface must not leak ${forbiddenMarker}`,
      );
    }
  } finally {
    eng.shutdown();
    h.cleanup();
  }
});

test("Copilot Finding 1 regression: decision/resolve terminal confirmation prompt strips all 32 C1 controls (U+0080..U+009F including U+009B) alongside C0/DEL while preserving ordinary Unicode and leaving session bytes unchanged on decline", async () => {
  const h = makeHome();
  const declinedTerm = makeConfirmingTerminal(async () => false);
  const eng = createHarness(h.home, { terminal: declinedTerm });
  try {
    eng.init();
    const threadId = threadIdOf(eng.call(2, "thread/start", {}));
    const turnId = turnIdOf(
      eng.call(3, "turn/start", { threadId, input: [{ type: "text", text: "c1 prompt test" }] }),
    );
    await waitTurnCompleted(eng.messages, turnId);

    const turnStart = readEvents(h.home, threadId).find((e) => e.type === "turn.start");
    assert.ok(turnStart !== undefined);

    const raiseRes = eng.call(4, "decision/raise", {
      threadId,
      turnId,
      decisionId: "dec_c1_prompt_01",
      question: "Confirm C1 sanitization?",
      recommendedDefault: "Safe baseline",
      evidenceRefs: [
        {
          kind: "session",
          path: `sessions/${threadId}.jsonl`,
          seq: turnStart.seq,
          hash: turnStart.hash,
        },
      ],
    });
    assert.equal(raiseRes.error, undefined);
    const decisionSeq = raiseRes.result?.seq as number;
    const decisionHash = raiseRes.result?.hash as string;

    const sessionPath = join(h.home, "sessions", `${threadId}.jsonl`);
    const beforeBytes = readFileSync(sessionPath);
    const beforeSha256 = createHash("sha256").update(beforeBytes).digest("hex");

    const allC1Chars = Array.from({ length: 32 }, (_, i) => String.fromCharCode(0x80 + i)).join("");
    const unicodeText = "Approve café — 決策 α→ω";
    const maliciousResolution = `${unicodeText} ${allC1Chars}\u009b31mCSI_SPOOF\u009b0m\u0007\u001b[2J\u007f`;

    const resolveRes = await eng.callAsync(5, "decision/resolve", {
      threadId,
      decisionId: "dec_c1_prompt_01",
      decisionSeq,
      decisionHash,
      outcome: "decided",
      resolution: maliciousResolution,
    });
    assert.equal(resolveRes.error?.code, ErrorCode.EvidenceInvalid);
    assert.deepEqual(resolveRes.error?.data?.issues, ["Founder resolution confirmation declined"]);

    assert.equal(declinedTerm.prompts.length, 1);
    const prompt = declinedTerm.prompts[0] ?? "";
    assert.equal(
      prompt.includes(unicodeText),
      true,
      "ordinary Unicode text must remain readable in the confirmation prompt",
    );
    for (let cp = 0x80; cp <= 0x9f; cp += 1) {
      const hex = cp.toString(16).toUpperCase().padStart(4, "0");
      assert.equal(
        prompt.includes(String.fromCharCode(cp)),
        false,
        `confirmation prompt must not contain C1 control U+${hex}`,
      );
    }
    for (const c0OrDel of [0x00, 0x07, 0x08, 0x1b, 0x7f]) {
      const hex = c0OrDel.toString(16).toUpperCase().padStart(4, "0");
      assert.equal(
        prompt.includes(String.fromCharCode(c0OrDel)),
        false,
        `confirmation prompt must not contain C0/DEL control U+${hex}`,
      );
    }

    const afterBytes = readFileSync(sessionPath);
    const afterSha256 = createHash("sha256").update(afterBytes).digest("hex");
    assert.equal(
      afterSha256,
      beforeSha256,
      "declined confirmation must not change session SHA-256",
    );
    assert.equal(
      Buffer.compare(afterBytes, beforeBytes),
      0,
      "declined confirmation must leave session bytes unchanged",
    );
  } finally {
    eng.shutdown();
    h.cleanup();
  }
});

test("Copilot Finding 3 regression: listOpenDecisions and decision/list are strictly read-only, preserve 0755 directory permissions and session bytes, do not create missing directories, and preserve symlink/confinement and sanitized skip protections", async () => {
  const h = makeHome();
  const hExternal = makeHome();
  try {
    // 1. Seed a valid open decision in h.home.
    const engSeed = createHarness(h.home);
    let threadId = "";
    try {
      engSeed.init();
      threadId = threadIdOf(engSeed.call(2, "thread/start", {}));
      const turnId = turnIdOf(
        engSeed.call(3, "turn/start", {
          threadId,
          input: [{ type: "text", text: "seed open decision" }],
        }),
      );
      await waitTurnCompleted(engSeed.messages, turnId);
      const openEv = readEvents(h.home, threadId)[0] as SessionEvent;
      const raiseRes = engSeed.call(4, "decision/raise", {
        threadId,
        turnId,
        decisionId: "dec_readonly_01",
        question: "Keep listing read-only?",
        recommendedDefault: "Yes, never mkdir or chmod on list",
        evidenceRefs: [
          {
            kind: "session",
            path: `sessions/${threadId}.jsonl`,
            seq: openEv.seq,
            hash: openEv.hash,
          },
        ],
      });
      assert.equal(raiseRes.error, undefined);
    } finally {
      engSeed.shutdown();
    }

    const sessionsDir = join(h.home, "sessions");
    const sessionPath = join(sessionsDir, `${threadId}.jsonl`);
    const origBytes = readFileSync(sessionPath);
    const origSha256 = createHash("sha256").update(origBytes).digest("hex");

    const engList = createHarness(h.home);
    try {
      engList.init();

      // Set fixture home and sessions directories to 0755.
      chmodSync(h.home, 0o755);
      chmodSync(sessionsDir, 0o755);
      if (process.platform !== "win32") {
        assert.equal(statSync(h.home).mode & 0o777, 0o755);
        assert.equal(statSync(sessionsDir).mode & 0o777, 0o755);
      }

      // Listing returns the open decision without changing permissions or session bytes.
      const listed = listOpenDecisions(h.home);
      assert.deepEqual(
        listed.map((d) => d.decisionId),
        ["dec_readonly_01"],
      );
      const rpcList = engList.call(2, "decision/list", {});
      assert.equal(rpcList.error, undefined);
      const rpcData = (rpcList.result as { data: Array<{ decisionId: string }> }).data;
      assert.deepEqual(
        rpcData.map((d) => d.decisionId),
        ["dec_readonly_01"],
      );
    } finally {
      engList.shutdown();
    }
    if (process.platform !== "win32") {
      assert.equal(
        statSync(h.home).mode & 0o777,
        0o755,
        "listOpenDecisions / decision/list must not tighten home directory permissions from 0755",
      );
      assert.equal(
        statSync(sessionsDir).mode & 0o777,
        0o755,
        "listOpenDecisions / decision/list must not tighten sessions directory permissions from 0755",
      );
    }
    const afterBytes = readFileSync(sessionPath);
    assert.equal(createHash("sha256").update(afterBytes).digest("hex"), origSha256);
    assert.equal(Buffer.compare(afterBytes, origBytes), 0);

    // Preserve allowance for an operator-chosen symlinked home.
    mkdirSync(hExternal.home, { recursive: true, mode: 0o700 });
    const symlinkHome = join(hExternal.home, "operator-symlink-home");
    symlinkSync(h.home, symlinkHome, "dir");
    const viaSymlinkHome = listOpenDecisions(symlinkHome);
    assert.deepEqual(
      viaSymlinkHome.map((d) => d.decisionId),
      ["dec_readonly_01"],
      "operator-chosen symlinked home must continue to list open decisions",
    );
    if (process.platform !== "win32") {
      assert.equal(statSync(h.home).mode & 0o777, 0o755);
      assert.equal(statSync(sessionsDir).mode & 0o777, 0o755);
    }

    // 2. Missing directories remain absent and untouched.
    const missingHome = join(hExternal.home, "absent-madc-home");
    assert.equal(existsSync(missingHome), false);
    assert.deepEqual(listOpenDecisions(missingHome), []);
    assert.equal(existsSync(missingHome), false, "missing home must not be created");

    const homeWithoutSessions = join(hExternal.home, "home-without-sessions");
    mkdirSync(homeWithoutSessions, { mode: 0o755 });
    chmodSync(homeWithoutSessions, 0o755);
    const missingSessionsDir = join(homeWithoutSessions, "sessions");
    assert.equal(existsSync(missingSessionsDir), false);
    assert.deepEqual(listOpenDecisions(homeWithoutSessions), []);
    assert.equal(existsSync(missingSessionsDir), false, "missing sessions/ must not be created");
    if (process.platform !== "win32") {
      assert.equal(statSync(homeWithoutSessions).mode & 0o777, 0o755);
    }

    // 3. Reject symlinked sessions/ components (both external and in-home targets).
    const symSessionsHome = join(hExternal.home, "home-with-symlink-sessions");
    mkdirSync(symSessionsHome, { mode: 0o700 });
    symlinkSync(sessionsDir, join(symSessionsHome, "sessions"), "dir");
    assert.deepEqual(
      listOpenDecisions(symSessionsHome),
      [],
      "symlinked sessions/ pointing outside home must be rejected",
    );

    rmSync(join(symSessionsHome, "sessions"), { recursive: true, force: true });
    const internalTargetDir = join(symSessionsHome, "real-sessions-target");
    mkdirSync(internalTargetDir, { mode: 0o700 });
    writeFileSync(join(internalTargetDir, `${threadId}.jsonl`), origBytes);
    symlinkSync(internalTargetDir, join(symSessionsHome, "sessions"), "dir");
    assert.deepEqual(
      listOpenDecisions(symSessionsHome),
      [],
      "symlinked sessions/ component must be rejected even when target is inside home",
    );

    // 4. Reject symlinked session files and corrupt files while keeping skip diagnostics sanitized.
    const symlinkSessionPath = join(sessionsDir, "thr_symlink_file.jsonl");
    const corruptSessionPath = join(sessionsDir, "thr_corrupt_secret.jsonl");
    symlinkSync(sessionPath, symlinkSessionPath);
    writeFileSync(
      corruptSessionPath,
      '{"secret":"SECRET_CORRUPT_LINE_DO_NOT_LEAK_9911"}\n',
      "utf8",
    );
    try {
      const skipped: Array<[string, string]> = [];
      const afterSkipList = listOpenDecisions(h.home, (tid, reason) => skipped.push([tid, reason]));
      assert.deepEqual(
        afterSkipList.map((d) => d.decisionId),
        ["dec_readonly_01"],
      );
      assert.deepEqual(skipped, [
        ["thr_corrupt_secret", "session failed verification"],
        ["thr_symlink_file", "session failed verification"],
      ]);
      assert.equal(
        JSON.stringify(skipped).includes("SECRET_CORRUPT_LINE_DO_NOT_LEAK_9911"),
        false,
        "skip diagnostics must stay sanitized",
      );
    } finally {
      rmSync(symlinkSessionPath, { force: true });
      rmSync(corruptSessionPath, { force: true });
    }
  } finally {
    hExternal.cleanup();
    h.cleanup();
  }
});

test("Copilot Finding 2 regression: FOUNDER_DECISION_RAISE_TOOL advertises the full decisionId grammar ^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$ and accepts non-dec_ and 128-char IDs while rejecting 129-char IDs", async () => {
  // 1. Verify advertised tool schema description on FOUNDER_DECISION_RAISE_TOOL.
  const paramsSchema = FOUNDER_DECISION_RAISE_TOOL.parameters as {
    properties?: {
      decisionId?: { description?: string };
    };
  };
  const decisionIdDesc = paramsSchema.properties?.decisionId?.description ?? "";
  assert.equal(
    decisionIdDesc.includes("^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$"),
    true,
    `expected FOUNDER_DECISION_RAISE_TOOL decisionId description to include ^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$ (got ${JSON.stringify(decisionIdDesc)})`,
  );
  assert.equal(
    decisionIdDesc.includes("^dec_"),
    false,
    `FOUNDER_DECISION_RAISE_TOOL decisionId description must not narrow grammar to ^dec_ (got ${JSON.stringify(decisionIdDesc)})`,
  );
  assert.equal(
    /optional/i.test(decisionIdDesc) && /generat|omit/i.test(decisionIdDesc),
    true,
    `FOUNDER_DECISION_RAISE_TOOL decisionId description must explain that explicit ID is optional and engine-generated when omitted (got ${JSON.stringify(decisionIdDesc)})`,
  );

  // 2. Verify runtime behavior across non-dec_ ID, 128-character ID, omitted ID, and 129-character ID via real direct-lane tool execution.
  const h = makeHome();
  const fakeKimi = createFakeKimiTransport();
  const realProviderAgent = createProviderAgent({
    credential: { ok: true, apiKey: "sk-kimi-synthetic-f2-id-grammar" },
    createPort: (apiKey) =>
      createKimiCodePort({
        apiKey,
        userAgent: honestUserAgent(ENGINE_VERSION),
        baseUrl: "https://kimi-fake.invalid/coding",
        fetch: fakeKimi.fetch,
      }),
  });
  const eng = createHarness(h.home, {
    agent: realProviderAgent,
    terminal: makeConfirmingTerminal(async () => true),
  });
  try {
    eng.init();
    const threadId = threadIdOf(eng.call(2, "thread/start", {}));
    const openEv = readEvents(h.home, threadId)[0] as SessionEvent;
    const validRef = {
      kind: "session" as const,
      path: `sessions/${threadId}.jsonl`,
      seq: openEv.seq,
      hash: openEv.hash,
    };

    const nonDecId = "custom-decision-id_01";
    const id128 = `A${"b".repeat(126)}9`;
    const id129 = `A${"b".repeat(127)}9`;
    assert.equal(id128.length, 128);
    assert.equal(id129.length, 129);

    // Round 1: non-dec_ ID (positive)
    fakeKimi.queueReply({
      type: "tool-call",
      id: "call_id_non_dec",
      name: "founder_decision_raise",
      args: {
        decisionId: nonDecId,
        question: "Accept non-dec_ explicit decisionId?",
        recommendedDefault: "Accept any valid protocol id",
        evidenceRefs: [validRef],
      },
      model: "kimi-for-coding",
    });
    // Round 2: 128-character ID (positive boundary)
    fakeKimi.queueReply({
      type: "tool-call",
      id: "call_id_128",
      name: "founder_decision_raise",
      args: {
        decisionId: id128,
        question: "Accept 128-char decisionId?",
        recommendedDefault: "Accept max length id",
        evidenceRefs: [validRef],
      },
      model: "kimi-for-coding",
    });
    // Round 3: 129-character ID (negative boundary -> -32010)
    fakeKimi.queueReply({
      type: "tool-call",
      id: "call_id_129",
      name: "founder_decision_raise",
      args: {
        decisionId: id129,
        question: "Reject 129-char decisionId?",
        recommendedDefault: "Reject over-length id",
        evidenceRefs: [validRef],
      },
      model: "kimi-for-coding",
    });
    // Round 4: omitted decisionId (positive -> engine mints dec_<32 hex>)
    fakeKimi.queueReply({
      type: "tool-call",
      id: "call_id_omitted",
      name: "founder_decision_raise",
      args: {
        question: "Mint decisionId when omitted?",
        recommendedDefault: "Engine mints dec_<32 hex>",
        evidenceRefs: [validRef],
      },
      model: "kimi-for-coding",
    });
    fakeKimi.queueReply({
      type: "stream",
      chunks: ["ID grammar checks complete."],
      model: "kimi-for-coding",
    });

    const turnId = turnIdOf(
      eng.call(3, "turn/start", {
        threadId,
        input: [{ type: "text", text: "Test ID grammar boundaries." }],
      }),
    );
    await waitTurnCompleted(eng.messages, turnId);

    // Check advertised wire schema in the first HTTP request.
    const firstReq = JSON.parse(fakeKimi.requests[0]?.body ?? "{}") as {
      tools?: Array<{
        input_schema?: { properties?: { decisionId?: { description?: string } } };
      }>;
    };
    const wireDesc = firstReq.tools?.[0]?.input_schema?.properties?.decisionId?.description ?? "";
    assert.equal(wireDesc.includes("^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$"), true);
    assert.equal(wireDesc.includes("^dec_"), false);

    // Check that the 129-character ID tool call returned an error tool_result (-32010).
    const fourthReqBody = fakeKimi.requests[3]?.body ?? "";
    assert.equal(fourthReqBody.includes("call_id_129"), true);
    assert.equal(fourthReqBody.includes('"is_error":true'), true);
    assert.equal(fourthReqBody.includes("decisionId must match the id grammar"), true);

    // Check open decisions: nonDecId, id128, and the engine-minted dec_<32 hex> are persisted; id129 is not.
    const open = listOpenDecisions(h.home);
    assert.equal(open.length, 3);
    assert.equal(open[0]?.decisionId, nonDecId);
    assert.equal(open[1]?.decisionId, id128);
    assert.match(open[2]?.decisionId ?? "", /^dec_[0-9a-f]{32}$/);
  } finally {
    eng.shutdown();
    h.cleanup();
  }
});

// --- PR #63 round-5 review guards (Argus pr63-review-048c5f1.md: L3, N-L1, N2-L T1) ------------

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function waitFor(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A thread with one finished turn and one raised decision; returns ids and the turn.start ref. */
async function threadWithDecision(eng: ReturnType<typeof createHarness>, home: string) {
  const threadId = threadIdOf(eng.call(2, "thread/start", {}));
  const turnId = turnIdOf(
    eng.call(3, "turn/start", { threadId, input: [{ type: "text", text: "go" }] }),
  );
  await waitTurnCompleted(eng.messages, turnId);
  const ts = readEvents(home, threadId).find((e) => e.type === "turn.start");
  assert.ok(ts !== undefined);
  const ref = { kind: "session", path: `sessions/${threadId}.jsonl`, seq: ts.seq, hash: ts.hash };
  const r = eng.call(4, "decision/raise", {
    threadId,
    turnId,
    decisionId: "dec_guard",
    question: "Q?",
    recommendedDefault: "D",
    evidenceRefs: [ref],
  });
  assert.equal(r.error, undefined);
  return {
    threadId,
    turnId,
    ref,
    decisionSeq: r.result?.seq as number,
    decisionHash: r.result?.hash as string,
  };
}

const sessionSha = (home: string, threadId: string) =>
  createHash("sha256")
    .update(readFileSync(join(home, "sessions", `${threadId}.jsonl`)))
    .digest("hex");

test("L3 S2/S4: while a warm resolution waits for confirmation, a second resolve and a raise are refused -32004 and nothing is appended", async () => {
  const h = makeHome();
  const gate = deferred<boolean>();
  const term = makeConfirmingTerminal(() => gate.promise);
  const eng = createHarness(h.home, { terminal: term });
  try {
    eng.init();
    const t = await threadWithDecision(eng, h.home);
    const pending = eng.callAsync(10, "decision/resolve", {
      threadId: t.threadId,
      decisionId: "dec_guard",
      decisionSeq: t.decisionSeq,
      decisionHash: t.decisionHash,
      outcome: "accepted-default",
    });
    await waitFor(() => term.prompts.length === 1, "confirmation prompt");
    const before = sessionSha(h.home, t.threadId);

    const second = eng.call(11, "decision/resolve", {
      threadId: t.threadId,
      decisionId: "dec_guard",
      decisionSeq: t.decisionSeq,
      decisionHash: t.decisionHash,
      outcome: "decided",
      resolution: "other",
    });
    assert.equal(second.error?.code, ErrorCode.TurnAlreadyActive);
    const raise = eng.call(12, "decision/raise", {
      threadId: t.threadId,
      turnId: t.turnId,
      decisionId: "dec_guard_2",
      question: "Q2?",
      recommendedDefault: "D2",
      evidenceRefs: [t.ref],
    });
    assert.equal(raise.error?.code, ErrorCode.TurnAlreadyActive);
    assert.equal(sessionSha(h.home, t.threadId), before, "no append while confirming");
    assert.equal(term.prompts.length, 1, "the refused resolve never prompted");

    gate.resolve(true);
    const done = await pending;
    assert.equal(done.error, undefined);
  } finally {
    eng.shutdown();
    h.cleanup();
  }
});

test("N-L1 N9/N10/N12: while a cold resolution waits for confirmation, raise, a second resolve and thread/resume are refused -32004 and nothing is appended", async () => {
  const h = makeHome();
  const eng1 = createHarness(h.home);
  eng1.init();
  const t = await threadWithDecision(eng1, h.home);
  eng1.shutdown();

  const gate = deferred<boolean>();
  const term = makeConfirmingTerminal(() => gate.promise);
  const eng = createHarness(h.home, { terminal: term });
  try {
    eng.init();
    const before = sessionSha(h.home, t.threadId);
    const pending = eng.callAsync(10, "decision/resolve", {
      threadId: t.threadId,
      decisionId: "dec_guard",
      decisionSeq: t.decisionSeq,
      decisionHash: t.decisionHash,
      outcome: "accepted-default",
    });
    await waitFor(() => term.prompts.length === 1, "confirmation prompt");

    const raise = eng.call(11, "decision/raise", {
      threadId: t.threadId,
      turnId: t.turnId,
      decisionId: "dec_guard_2",
      question: "Q2?",
      recommendedDefault: "D2",
      evidenceRefs: [t.ref],
    });
    assert.equal(raise.error?.code, ErrorCode.TurnAlreadyActive, "raise (N9)");
    assert.deepEqual(
      raise.error?.data,
      { threadId: t.threadId, activeTurnId: null },
      "raise (N9) data",
    );
    const second = await eng.callAsync(12, "decision/resolve", {
      threadId: t.threadId,
      decisionId: "dec_guard",
      decisionSeq: t.decisionSeq,
      decisionHash: t.decisionHash,
      outcome: "decided",
      resolution: "other",
    });
    assert.equal(second.error?.code, ErrorCode.TurnAlreadyActive, "second resolve (N10)");
    assert.deepEqual(
      second.error?.data,
      { threadId: t.threadId, activeTurnId: null },
      "second resolve (N10) data",
    );
    const resume = await eng.callAsync(13, "thread/resume", { threadId: t.threadId });
    assert.equal(resume.error?.code, ErrorCode.TurnAlreadyActive, "resume (N12)");
    assert.deepEqual(
      resume.error?.data,
      { threadId: t.threadId, activeTurnId: null },
      "resume (N12) data",
    );
    assert.equal(term.prompts.length, 1, "refused calls never prompted");
    assert.equal(sessionSha(h.home, t.threadId), before, "no append while confirming");

    gate.resolve(true);
    assert.equal((await pending).error, undefined);
  } finally {
    eng.shutdown();
    h.cleanup();
  }
});

test("N-L1 N1/N3: resolve with no controlling terminal reports 'confirmation unavailable'; a terminal that changes during the prompt is refused; neither writes", async () => {
  const h = makeHome();
  const eng1 = createHarness(h.home, { terminal: makeConfirmingTerminal() });
  try {
    eng1.init();
    const t = await threadWithDecision(eng1, h.home);
    const resolveParams = {
      threadId: t.threadId,
      decisionId: "dec_guard",
      decisionSeq: t.decisionSeq,
      decisionHash: t.decisionHash,
      outcome: "accepted-default",
    };
    eng1.shutdown();
    const before = sessionSha(h.home, t.threadId);

    const engNone = createHarness(h.home, {
      terminal: {
        probe: () => null,
        confirm: async () => true,
        unsupported: "no controlling terminal",
      },
    });
    try {
      engNone.init();
      const r = await engNone.callAsync(2, "decision/resolve", resolveParams);
      assert.equal(r.error?.code, ErrorCode.EvidenceInvalid);
      assert.deepEqual(r.error?.data?.issues, [
        "Founder resolution confirmation unavailable (no controlling terminal)",
      ]);
    } finally {
      engNone.shutdown();
    }
    assert.equal(sessionSha(h.home, t.threadId), before);

    let probes = 0;
    const swapping: PresenceTerminal & { prompts: string[] } = {
      prompts: [],
      probe: () => (probes++ === 0 ? TEST_TERMINAL_FACTS : { device: "16/99", session: null }),
      confirm: async (prompt) => {
        swapping.prompts.push(prompt);
        return true;
      },
    };
    const engSwap = createHarness(h.home, { terminal: swapping });
    try {
      engSwap.init();
      const r = await engSwap.callAsync(2, "decision/resolve", resolveParams);
      assert.equal(r.error?.code, ErrorCode.EvidenceInvalid);
      assert.deepEqual(r.error?.data?.issues, [
        "Founder resolution confirmation failed (controlling terminal changed)",
      ]);
      assert.equal(swapping.prompts.length, 1);
    } finally {
      engSwap.shutdown();
    }
    assert.equal(sessionSha(h.home, t.threadId), before, "no write on a changed terminal");
  } finally {
    h.cleanup();
  }
});

test("L3 S6/S8: a malformed payload on an unknown thread is refused -32010 (shape first, turnId null), not -32002", () => {
  const h = makeHome();
  const eng = createHarness(h.home);
  try {
    eng.init();
    const raise = eng.call(2, "decision/raise", {
      threadId: "thr_never_existed",
      question: "",
      recommendedDefault: "D",
      evidenceRefs: [],
    });
    assert.equal(raise.error?.code, ErrorCode.EvidenceInvalid, "raise shape check before lookup");
    assert.equal(raise.error?.data?.turnId, null);
    const resolve = eng.call(3, "decision/resolve", {
      threadId: "thr_never_existed",
      decisionId: "dec_x",
      decisionSeq: -1,
      decisionHash: "nothex",
      outcome: "maybe",
    });
    assert.equal(
      resolve.error?.code,
      ErrorCode.EvidenceInvalid,
      "resolve shape check before lookup",
    );
    assert.equal(resolve.error?.data?.turnId, null);
    assert.equal(existsSync(join(h.home, "sessions", "thr_never_existed.jsonl")), false);
  } finally {
    eng.shutdown();
    h.cleanup();
  }
});

test("N-L1 N16/N17, N2-L T1: TurnSink.raiseDecision refuses a caller turnId, a null-prototype input, and any call after the turn ended; none appends a decision", async () => {
  const h = makeHome();
  let sinkRef: TurnSink | undefined;
  const outcomes: Record<string, unknown> = {};
  const agent: Agent = {
    name: "guard-agent",
    async run(ctx, sink) {
      sinkRef = sink;
      const ts = readEvents(h.home, ctx.threadId).find((e) => e.type === "turn.start");
      assert.ok(ts !== undefined);
      const valid = {
        question: "Q?",
        recommendedDefault: "D",
        evidenceRefs: [
          { kind: "session", path: `sessions/${ctx.threadId}.jsonl`, seq: ts.seq, hash: ts.hash },
        ],
      };
      outcomes.callerTurnId = sink.raiseDecision?.({ ...valid, turnId: ctx.turnId } as never);
      outcomes.nullProto = sink.raiseDecision?.(Object.assign(Object.create(null), valid));
      outcomes.validInput = valid;
    },
  };
  const eng = createHarness(h.home, { agent });
  try {
    eng.init();
    const threadId = threadIdOf(eng.call(2, "thread/start", {}));
    const turnId = turnIdOf(
      eng.call(3, "turn/start", { threadId, input: [{ type: "text", text: "go" }] }),
    );
    await waitTurnCompleted(eng.messages, turnId);
    const code = (o: unknown) => (o as { ok: boolean; error?: { code: number } }).error?.code;
    assert.equal((outcomes.callerTurnId as { ok: boolean }).ok, false, "T1");
    assert.equal(code(outcomes.callerTurnId), ErrorCode.EvidenceInvalid, "T1");
    assert.equal((outcomes.nullProto as { ok: boolean }).ok, false, "N17");
    assert.equal(code(outcomes.nullProto), ErrorCode.EvidenceInvalid, "N17");

    const late = sinkRef?.raiseDecision?.(outcomes.validInput as never);
    assert.equal((late as { ok: boolean }).ok, false, "N16");
    assert.equal(code(late), ErrorCode.TurnNotFound, "N16");
    assert.equal(
      readEvents(h.home, threadId).filter((e) => e.type === "founderDecision").length,
      0,
      "no decision appended by any refused raise",
    );
  } finally {
    eng.shutdown();
    h.cleanup();
  }
});

// --- N-M1: thread/handoff step 1 rows 4a and 6a (inbox pin §4.4, Surface ruling 2026-10-16) ------

const handoffParams = (threadId: string) => ({
  threadId,
  turnId: null,
  targetSeatId: "surface-architect",
  brief: "hand this on",
});

test("N-M1 row 4a: thread/handoff on a source held for a pending cold decision/resolve confirmation is refused -32004 { threadId, activeTurnId: null } and appends nothing", async () => {
  const h = makeHome();
  const eng1 = createHarness(h.home);
  eng1.init();
  const t = await threadWithDecision(eng1, h.home);
  eng1.shutdown();
  const gate = deferred<boolean>();
  const term = makeConfirmingTerminal(() => gate.promise);
  const eng = createHarness(h.home, { terminal: term });
  try {
    eng.init();
    const before = sessionSha(h.home, t.threadId);
    const pending = eng.callAsync(10, "decision/resolve", {
      threadId: t.threadId,
      decisionId: "dec_guard",
      decisionSeq: t.decisionSeq,
      decisionHash: t.decisionHash,
      outcome: "accepted-default",
    });
    await waitFor(() => term.prompts.length === 1, "confirmation prompt");
    const r = eng.call(11, "thread/handoff", handoffParams(t.threadId));
    assert.equal(r.error?.code, ErrorCode.TurnAlreadyActive);
    assert.deepEqual(r.error?.data, { threadId: t.threadId, activeTurnId: null });
    assert.equal(sessionSha(h.home, t.threadId), before, "row 4a appends nothing");
    gate.resolve(false);
    await pending;
  } finally {
    eng.shutdown();
    h.cleanup();
  }
});

test("N-M1 row 6a (confirming): thread/handoff while a warm decision/resolve confirmation is pending is refused -32004 { threadId, activeTurnId: null } and appends nothing", async () => {
  const h = makeHome();
  const gate = deferred<boolean>();
  const term = makeConfirmingTerminal(() => gate.promise);
  const eng = createHarness(h.home, { terminal: term });
  try {
    eng.init();
    const t = await threadWithDecision(eng, h.home);
    const pending = eng.callAsync(10, "decision/resolve", {
      threadId: t.threadId,
      decisionId: "dec_guard",
      decisionSeq: t.decisionSeq,
      decisionHash: t.decisionHash,
      outcome: "accepted-default",
    });
    await waitFor(() => term.prompts.length === 1, "confirmation prompt");
    const before = sessionSha(h.home, t.threadId);
    const r = eng.call(11, "thread/handoff", handoffParams(t.threadId));
    assert.equal(r.error?.code, ErrorCode.TurnAlreadyActive);
    assert.deepEqual(r.error?.data, { threadId: t.threadId, activeTurnId: null });
    assert.equal(sessionSha(h.home, t.threadId), before, "row 6a appends nothing");
    gate.resolve(false);
    await pending;
  } finally {
    eng.shutdown();
    h.cleanup();
  }
});

test("N-M1 row 6a (active turn): thread/handoff while a turn is running is refused -32004 { threadId, activeTurnId: <turn> } and appends nothing", async () => {
  const h = makeHome();
  const hold = deferred<void>();
  let started = false;
  const agent: Agent = {
    name: "blocking",
    async run() {
      started = true;
      await hold.promise;
    },
  };
  const eng = createHarness(h.home, { agent });
  try {
    eng.init();
    const threadId = threadIdOf(eng.call(2, "thread/start", {}));
    const turnId = turnIdOf(
      eng.call(3, "turn/start", { threadId, input: [{ type: "text", text: "go" }] }),
    );
    await waitFor(() => started, "turn running");
    const before = sessionSha(h.home, threadId);
    const r = eng.call(4, "thread/handoff", handoffParams(threadId));
    assert.equal(r.error?.code, ErrorCode.TurnAlreadyActive);
    assert.deepEqual(r.error?.data, { threadId, activeTurnId: turnId });
    assert.equal(sessionSha(h.home, threadId), before, "row 6a appends nothing");
    hold.resolve();
    await waitTurnCompleted(eng.messages, turnId);
  } finally {
    eng.shutdown();
    h.cleanup();
  }
});
