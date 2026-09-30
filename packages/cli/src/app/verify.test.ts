/**
 * The bounded verify runner (DESIGN-SPEC §5.3 R-a/R-g, §17.1 O-1): the real worker path against
 * a real session chain, and the deadline path through the app's verify seam.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { SessionVerifyResult } from "@madc/engine/client";
import { runVerifyBounded, VERIFY_DEADLINE_MS } from "./verify.ts";

const home = mkdtempSync(join(tmpdir(), "madc-verify-"));
const threadId = "thr_verifyfixt01";

function sortedKeyJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v as object)
            .sort()
            .map((k) => [k, (v as Record<string, unknown>)[k]]),
        )
      : v,
  );
}
let seq = 0;
let prevHash = "0".repeat(64);
function append(type: string, payload: Record<string, unknown>): string {
  const body = { v: 1, seq, ts: 1 + seq, type, threadId, seatId: "madc-default", payload };
  const hash = createHash("sha256")
    .update(`${prevHash}\n${sortedKeyJson(body)}`, "utf8")
    .digest("hex");
  const { payload: p, ...head } = body;
  const line = `${JSON.stringify({ ...head, prevHash, hash, payload: p })}\n`;
  prevHash = hash;
  seq++;
  return line;
}

const sessionPath = join(home, "sessions", `${threadId}.jsonl`);
mkdirSync(join(home, "sessions"), { recursive: true });
writeFileSync(
  sessionPath,
  [
    append("session.open", {
      cwd: null,
      backing: "kimi-code",
      providerId: "kimi-code",
      pinnedModel: "m",
    }),
    append("turn.start", { turnId: "turn_v1", inputText: "hi" }),
    append("turn.end", { turnId: "turn_v1", status: "completed", error: null }),
  ].join(""),
);

describe("runVerifyBounded (real worker)", () => {
  it("verifies a real chain in a node:worker_threads worker and reports the head hash", async () => {
    const out = await runVerifyBounded({
      path: sessionPath,
      threadId,
      home,
      deadlineMs: VERIFY_DEADLINE_MS,
    });
    assert.equal(out.kind, "result");
    if (out.kind !== "result") return;
    assert.equal(out.result.ok, true);
    if (out.result.ok) {
      assert.equal(out.result.events.length, 3);
      assert.match(out.result.lastHash, /^[0-9a-f]{64}$/);
    }
  });

  it("reports a tampered file as a failure with the verifier's line and reason", async () => {
    const tampered = join(home, "sessions", "tampered.jsonl");
    const good = [
      append("session.open", {
        cwd: null,
        backing: "kimi-code",
        providerId: "kimi-code",
        pinnedModel: "m",
      }),
      append("turn.start", { turnId: "turn_t1", inputText: "hi" }),
    ].join("");
    const broken = good.replace(/"hash":"[0-9a-f]{4}/, '"hash":"zzzz');
    writeFileSync(tampered, broken);
    const out = await runVerifyBounded({
      path: tampered,
      threadId: "thr_tampered01",
      home,
      deadlineMs: VERIFY_DEADLINE_MS,
    });
    assert.equal(out.kind, "result");
    if (out.kind !== "result") return;
    assert.equal(out.result.ok, false);
    if (!out.result.ok) {
      assert.equal(out.result.kind, "integrity");
      assert.ok(out.result.line >= 1);
      assert.ok(out.result.reason.length > 0);
    }
  });

  it("survives a torn tail (an unterminated last line) with the torn-tail kind", async () => {
    const torn = join(home, "sessions", "torn.jsonl");
    // A local seq-0 chain: the module-level append() counter is shared, and a torn-tail prefix
    // must verify on its own (seq from 0).
    const localHash = (prev: string, body: string): string =>
      createHash("sha256").update(`${prev}\n${body}`, "utf8").digest("hex");
    const line = (seq: number, type: string, prev: string, hash: string): string =>
      `${JSON.stringify({
        v: 1,
        seq,
        ts: 1 + seq,
        type,
        threadId,
        seatId: "madc-default",
        prevHash: prev,
        hash,
        payload: {},
      })}\n`;
    const body0 = sortedKeyJson({
      v: 1,
      seq: 0,
      ts: 1,
      type: "session.open",
      threadId,
      seatId: "madc-default",
      payload: {},
    });
    const body1 = sortedKeyJson({
      v: 1,
      seq: 1,
      ts: 2,
      type: "turn.start",
      threadId,
      seatId: "madc-default",
      payload: {},
    });
    const h0 = localHash("0".repeat(64), body0);
    const h1 = localHash(h0, body1);
    writeFileSync(
      torn,
      line(0, "session.open", "0".repeat(64), h0) +
        line(1, "turn.start", h0, h1) +
        '{"v":1,"seq":2,"ts":3,"type":"tu',
    );
    const out = await runVerifyBounded({
      path: torn,
      threadId,
      home,
      deadlineMs: VERIFY_DEADLINE_MS,
    });
    assert.equal(out.kind, "result");
    if (out.kind !== "result") return;
    assert.equal(out.result.ok, false);
    if (!out.result.ok) assert.equal(out.result.kind, "torn-tail");
  });

  it("the exported deadline is the ruled 30 000 ms (O-1)", () => {
    assert.equal(VERIFY_DEADLINE_MS, 30_000);
  });
});

describe("the in-process seam", () => {
  it("returns the injected result under the same race", async () => {
    const out = await runVerifyBounded(
      { path: sessionPath, threadId, home, deadlineMs: VERIFY_DEADLINE_MS },
      () =>
        ({
          ok: true,
          events: [
            { seq: 0, type: "session.open" },
            { seq: 1, type: "turn.start" },
            { seq: 2, type: "turn.end" },
          ],
          nextSeq: 3,
          lastHash: "a".repeat(64),
        }) as unknown as SessionVerifyResult,
    );
    assert.equal(out.kind, "result");
    if (out.kind === "result" && out.result.ok) {
      assert.equal(out.result.nextSeq, 3);
    }
  });
});
