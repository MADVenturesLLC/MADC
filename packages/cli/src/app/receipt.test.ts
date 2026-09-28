/**
 * Receipt byte-identity (CLI pin §2 rows, DESIGN-SPEC §6.2): the plain join reproduces the
 * pinned oneshot.ts bytes exactly, and the tier-A spans land on the pinned tokens only.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { receiptParts, receiptPlain, receiptTierA } from "./receipt.ts";

const verified: Parameters<typeof receiptPlain>[0] = {
  turn: { status: "completed", id: "turn_65e5958bb6914f76", durationMs: 4800 },
  turnWord: "COMPLETED",
  served: {
    requestedModel: "kimi-coding/kimi-for-coding",
    servedModel: "kimi-for-coding",
    backing: "kimi-code",
    providerId: "kimi-code",
  },
  session: {
    path: "/home/mike/.madc/sessions/thr_ed00.jsonl",
    seq: 14,
    headHash: "3c91e07a5b2d0000000000000000000000000000000000000000000000000000",
    chain: "verified",
  },
  error: null,
  exit: 0,
};

describe("pinned receipt bytes", () => {
  it("joins to the exact oneshot.ts receipt", () => {
    assert.equal(
      receiptPlain(verified),
      [
        `─ receipt ${"─".repeat(45)}`,
        " turn     COMPLETED            turn_65e5958bb6914f76 4.8s",
        " model    kimi-coding/kimi-for-coding → kimi-for-coding   (kimi-code)",
        " session  /home/mike/.madc/sessions/thr_ed00.jsonl",
        "          seq 14 · head 3c91e07a5b2d · chain VERIFIED",
        " exit     0",
        "",
      ].join("\n"),
    );
  });
  it("NOT STARTED row keeps the pinned shape", () => {
    const out = receiptPlain({ ...verified, turn: null, turnWord: "NOT STARTED" });
    assert.match(out, /^ turn {5}NOT STARTED {10}-$/m);
  });
  it("NO RECEIPT model row", () => {
    const out = receiptPlain({ ...verified, served: null });
    assert.match(out, /^ model {4}NO RECEIPT$/m);
  });
  it("chain FAILED session row carries line N and the reason", () => {
    const out = receiptPlain({
      ...verified,
      session: {
        path: "/home/mike/.madc/sessions/thr_ed00.jsonl",
        seq: null,
        headHash: null,
        chain: "failed",
        line: 4,
        reason: "hash mismatch",
      },
    });
    assert.match(out, /^ {10}chain FAILED line 4: hash mismatch$/m);
  });
  it("UNVERIFIED keeps the seq/head prefix when a seq exists", () => {
    const out = receiptPlain({
      ...verified,
      session: {
        path: "/home/mike/.madc/sessions/thr_ed00.jsonl",
        seq: 6,
        headHash: "7d50df2c6d5f0000000000000000000000000000000000000000000000000000",
        chain: "unverified",
        reason: "the chain's last turn.end does not name this turn",
      },
    });
    assert.match(
      out,
      /^ {10}seq 6 · head 7d50df2c6d5f · UNVERIFIED: the chain's last turn\.end does not name this turn$/m,
    );
  });
});

describe("§6.2 tier-A spans", () => {
  const ESC = "\u001b[";
  it("COMPLETED is 1;32 only with chain VERIFIED + exit 0", () => {
    const out = receiptTierA(verified);
    assert.ok(out.includes(`${ESC}1;32mCOMPLETED${ESC}0m`));
    assert.ok(out.includes(`${ESC}32mchain VERIFIED${ESC}0m`));
    assert.ok(/exit {4,}/.test(out) && out.includes(`${ESC}32m0${ESC}0m`));
    // head hash cyan (36) when verified; the seq prefix stays uncoloured (§6.2 tokens)
    assert.ok(out.includes(` seq 14 · head ${ESC}36m3c91e07a5b2d${ESC}0m · ${ESC}32m`));
  });
  it("UNVERIFIED is warn 33 and never green; exit 0 uncoloured without the chain", () => {
    const out = receiptTierA({
      ...verified,
      session: {
        path: "/home/mike/.madc/sessions/thr_ed00.jsonl",
        seq: 6,
        headHash: "7d50df2c6d5f0000000000000000000000000000000000000000000000000000",
        chain: "unverified",
        reason: "no reason",
      },
    });
    assert.ok(out.includes(`${ESC}33mCOMPLETED${ESC}0m`));
    assert.ok(out.includes(`${ESC}33mUNVERIFIED: no reason${ESC}0m`));
    assert.match(out, /exit {4,}0\n/); // 0 without chain VERIFIED: no SGR
  });
  it("≠0 exit digits are 1;31 and never green", () => {
    const out = receiptTierA({ ...verified, exit: 130 });
    assert.ok(/exit {4,}/.test(out) && out.includes(`${ESC}1;31m130${ESC}0m`));
  });
  it("the chain-failure session value uses the IQ-3 in-span form", () => {
    const out = receiptTierA({
      ...verified,
      session: {
        path: "/home/mike/.madc/sessions/thr_ed00.jsonl",
        seq: null,
        headHash: null,
        chain: "failed",
        line: 4,
        reason: "hash mismatch",
      },
    });
    assert.ok(out.includes(`${ESC}1;31mchain FAILED${ESC}0;31m line 4: hash mismatch${ESC}0m`));
  });
  it("the error row carrying a chain failure uses the same RQ-2 in-span form", () => {
    const out = receiptTierA({
      ...verified,
      error: { code: null, message: "chain FAILED line 4: hash mismatch", class: "session" },
    });
    // ERR1 RQ-2 exact bytes: the head span resets through the bold opener, not a close.
    assert.ok(
      out.includes(
        `${ESC}31m error    session: ${ESC}1;31mchain FAILED${ESC}0;31m line 4: hash mismatch${ESC}0m`,
      ),
    );
  });
  it("IQ-7: no span is left open at a line end (ESC[0m before every newline where needed)", () => {
    const out = receiptTierA({
      ...verified,
      error: { code: null, message: "chain FAILED line 4: hash mismatch", class: "session" },
    });
    for (const line of out.split("\n")) {
      let open = false;
      // biome-ignore lint/suspicious/noControlCharactersInRegex: the SGR spans ARE the control sequences under test.
      for (const m of line.matchAll(/\u001b\[([0-9;]*)m/g)) {
        const code = m[1] ?? "";
        open = code !== "0";
      }
      assert.ok(!open, `span left open at line end: ${JSON.stringify(line)}`);
    }
  });
  it("plain and tier-A share the same text (SGR stripped == plain bytes)", () => {
    const plain = receiptPlain(verified);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping the SGR spans under test.
    const stripped = receiptTierA(verified).replace(/\u001b\[[0-9;]*m/g, "");
    assert.equal(stripped, plain);
  });
  it("parts expose the row structure (used by the §6.1 card)", () => {
    const rows = receiptParts(verified);
    assert.equal(rows[0]?.parts[0]?.text, `─ receipt ${"─".repeat(45)}`);
    assert.equal(rows.length, 6);
  });
});
