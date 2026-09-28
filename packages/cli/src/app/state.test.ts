/**
 * The app exit ladder (DESIGN-SPEC rev 6.2 §5.11, ruled by §17 M-2 and §17.1 O-3…O-6): every
 * row of the §5.11 table as a deterministic test.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { railOf, type TurnRecord, worstExit } from "./state.ts";

const turn = (over: Partial<TurnRecord>): TurnRecord => ({
  turnId: "t",
  status: "completed",
  exitCode: 0,
  inAppInterrupted: false,
  seqStart: null,
  seqEnd: null,
  verify: null,
  unverified: null,
  revoked: false,
  startTime: 0,
  endTime: 1,
  items: [],
  ...over,
});

describe("§5.11 worst-code ranking (3 > 2 > 5 > signals > 4 > 1 > 0)", () => {
  const run = (
    turns: TurnRecord[],
    signal: "SIGINT" | "SIGTERM" | "SIGHUP" | null = null,
    failedAfter = false,
  ): number =>
    worstExit({ turns, sessionCodes: [], signal, finalVerifyFailedAfterSignal: failedAfter }).code;

  it("a 5 replaces only 0, 1 or 4; an existing 2 or 3 stays", () => {
    const session5 = turn({ exitCode: 5 });
    assert.equal(run([session5, turn({ exitCode: 1 })]), 5);
    assert.equal(run([turn({ exitCode: 3 }), session5]), 3);
    assert.equal(run([turn({ exitCode: 2 }), session5]), 2);
    assert.equal(run([turn({ exitCode: 4 }), session5]), 5);
  });
  it("SIGINT exits 130 and never replaces a recorded 2, 3 or 5", () => {
    assert.equal(run([turn({ exitCode: 0 })], "SIGINT"), 130);
    assert.equal(run([turn({ exitCode: 4 })], "SIGINT"), 130);
    assert.equal(run([turn({ exitCode: 1 })], "SIGINT"), 130);
    assert.equal(run([turn({ exitCode: 2 })], "SIGINT"), 2);
    assert.equal(run([turn({ exitCode: 3 })], "SIGINT"), 3);
    assert.equal(run([turn({ exitCode: 5 })], "SIGINT"), 5);
  });
  it("SIGTERM exits 143 under the same rule", () => {
    assert.equal(run([turn({ exitCode: 0 })], "SIGTERM"), 143);
    assert.equal(run([turn({ exitCode: 2 })], "SIGTERM"), 2);
  });
  it("a final verify that fails after the signal exits 5, not 130/143 (O-3)", () => {
    assert.equal(run([turn({ exitCode: 0 })], "SIGINT", true), 5);
    assert.equal(run([turn({ exitCode: 0 })], "SIGTERM", true), 5);
  });
  it("an in-app interrupted turn counts 0 for that turn (O-5), other turns still rank", () => {
    const interrupted = turn({ status: "interrupted", exitCode: 0, inAppInterrupted: true });
    assert.equal(run([interrupted]), 0);
    assert.equal(run([interrupted, turn({ exitCode: 4 })]), 4);
  });
  it("no turns: 0 when the final check passed, 5 when it failed (M-2 c)", () => {
    assert.equal(run([]), 0);
    const failed: Parameters<typeof worstExit>[0] = {
      turns: [],
      sessionCodes: [],
      signal: null,
      finalVerifyFailedAfterSignal: true,
    };
    assert.equal(worstExit(failed).code, 5);
  });
  it("a session code recorded without a turn ranks like any event (-32009 → 5, seat → 2)", () => {
    const r = (codes: { code: number }[]): number =>
      worstExit({
        turns: [],
        sessionCodes: codes.map((c) => ({ ...c, reason: "fixture" })),
        signal: null,
        finalVerifyFailedAfterSignal: false,
      }).code;
    assert.equal(r([{ code: 5 }]), 5);
    assert.equal(r([{ code: 2 }]), 2);
    assert.equal(r([{ code: 3 }]), 3);
  });
  it("a signal never makes the exit 0, even with all-zero turns", () => {
    assert.notEqual(run([turn({ exitCode: 0 }), turn({ exitCode: 0 })], "SIGINT"), 0);
  });
  it("the worst turn decides the receipt block; a tie keeps the later turn (§5.12)", () => {
    const a = turn({ exitCode: 4, turnId: "a" });
    const b = turn({ exitCode: 4, turnId: "b" });
    const r = worstExit({
      turns: [a, b],
      sessionCodes: [],
      signal: null,
      finalVerifyFailedAfterSignal: false,
    });
    assert.equal(r.code, 4);
    assert.equal(r.worstTurn?.turnId, "b");
  });
});

describe("§5.3 rail derivation (never solid without a passing verify, R-f)", () => {
  it("running turns are dotted", () => {
    assert.equal(railOf(turn({ status: "running" })), "dotted");
  });
  it("a completed turn with no verify is dotted", () => {
    assert.equal(railOf(turn({ status: "completed" })), "dotted");
  });
  it("solid only when a passing verify covers the turn and no UNVERIFIED reason stands", () => {
    assert.equal(
      railOf(
        turn({
          status: "completed",
          verify: { kind: "verified", seq: 6, headHash: "a".repeat(64) },
        }),
      ),
      "solid",
    );
    assert.equal(
      railOf(
        turn({
          status: "completed",
          verify: { kind: "verified", seq: 6, headHash: "a".repeat(64) },
          unverified: "the chain's last turn.end does not name this turn",
        }),
      ),
      "dotted",
    );
  });
  it("a revoked turn (R-b) is a red break", () => {
    assert.equal(railOf(turn({ revoked: true })), "break");
  });
});
