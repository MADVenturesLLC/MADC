/**
 * `madc -p` presentation tiers (DESIGN-SPEC rev 6.2 §6.1, §6.2) and the doctor's tier-W rows
 * (§8): tier-W chrome around the pinned bytes, tier-A SGR spans, tier-P plain bytes unchanged.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { Check } from "../doctor.ts";
import { collectDoctor } from "../doctor.ts";
import type { CliIO } from "../io.ts";
import { runOneShot, statusPill } from "../oneshot.ts";
import { doctorHeaderW, doctorPendingRowW, doctorResultW, doctorRowW } from "./doctor-view.ts";
import { glyphsFor, Style } from "./style.ts";
import { renderSessionStartFailedCard } from "./verdict.ts";

const FAKE_ENGINE = fileURLToPath(new URL("../testing/fake-engine.ts", import.meta.url));

class Rec {
  readonly chunks: string[] = [];
  write(chunk: string): void {
    this.chunks.push(chunk);
  }
  text(): string {
    return this.chunks.join("");
  }
  plain(): string {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping the SGR spans under test.
    return this.text().replace(/\u001b\[[0-9;]*m/g, "");
  }
}

/** A fresh MADC_HOME per test: the fake engine appends its session chain, so a shared home
 * would break the second run's verify. */
const newHome = (): string => mkdtempSync(join(tmpdir(), "madc-card-"));

const io = (over: Partial<CliIO>, stdout: Rec, stderr: Rec, home: string): CliIO => ({
  stdout,
  stderr,
  stdin: process.stdin,
  env: { TERM: "xterm-256color", LANG: "en_US.UTF-8", KIMI_API_KEY: "test-sentinel-key-witness" },
  stdoutIsTTY: true,
  stderrIsTTY: true,
  stdinIsTTY: false,
  columns: 110,
  rows: 32,
  cwd: home,
  engineEntry: FAKE_ENGINE,
  ...over,
});

const ESC = "\u001b[";

describe("§6.1 madc -p tier-W verdict card", () => {
  it("wraps the pinned receipt rows in the COMPLETED card on a full TTY (stderr, one write)", async () => {
    const home = newHome();
    const stdout = new Rec();
    const stderr = new Rec();
    const code = await runOneShot(io({}, stdout, stderr, home), {
      prompt: "hi",
      seatId: undefined,
      json: false,
      home,
      turnIdleMs: 600_000,
    });
    assert.equal(code, 0);
    const card = stderr.plain();
    // Title row, the big art, and the pinned receipt rows verbatim inside the card.
    assert.match(card, /✓ seq \d+ · head [0-9a-f]{12} · chain VERIFIED/);
    assert.doesNotMatch(card, /✓ chain VERIFIED · exit 0/);
    assert.doesNotMatch(card, /████/);
    assert.match(card, /─ receipt /);
    assert.match(card, / turn {5}COMPLETED/);
    // The fake engine's default turn carries no servedModel item: the pinned NO RECEIPT row.
    assert.match(card, / model {4}NO RECEIPT/);
    assert.match(card, / {10}seq \d+ · head [0-9a-f]{12} · chain VERIFIED/);
    assert.match(card, / exit {5}0/);
    // The card itself is one write (the status-clear chunk precedes it; IQ-14 keeps the clear).
    const cardWrites = stderr.chunks.filter((c) => c.includes("─ receipt"));
    assert.equal(cardWrites.length, 1);
    // stdout stays the plain agent text (no chrome on stdout).
    assert.equal(stdout.text(), "fake reply\n");
    rmSync(home, { recursive: true, force: true });
  });

  it("piped output keeps today's plain receipt bytes (no card, no SGR)", async () => {
    const home = newHome();
    const stdout = new Rec();
    const stderr = new Rec();
    const code = await runOneShot(
      io({ stdoutIsTTY: false, stderrIsTTY: false, columns: undefined }, stdout, stderr, home),
      { prompt: "hi", seatId: undefined, json: false, home, turnIdleMs: 600_000 },
    );
    assert.equal(code, 0);
    const text = stderr.text();
    assert.ok(!text.includes("\u001b["), "no ANSI on piped stderr");
    assert.match(text, /^─ receipt ─+$/m);
    assert.doesNotMatch(text, /✓ chain VERIFIED · exit 0/); // no card title
    assert.match(text, / turn {5}COMPLETED/);
    rmSync(home, { recursive: true, force: true });
  });

  it("NO_COLOR on a TTY keeps the card layout with zero SGR", async () => {
    const home = newHome();
    const stdout = new Rec();
    const stderr = new Rec();
    await runOneShot(
      io(
        { env: { TERM: "xterm-256color", NO_COLOR: "1", LANG: "en_US.UTF-8" } },
        stdout,
        stderr,
        home,
      ),
      { prompt: "hi", seatId: undefined, json: false, home, turnIdleMs: 600_000 },
    );
    const text = stderr.text();
    // The status clear (\r\x1b[K) is not colour and stays in every tier (IQ-14).
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping the pinned clear sequence.
    const withoutClear = text.replace(/\u001b\[K/g, "");
    assert.ok(!withoutClear.includes("\u001b["), "zero SGR under NO_COLOR");
    assert.match(text, /─ receipt /); // the card is drawn, uncoloured
    assert.match(text, / turn {5}COMPLETED/);
    rmSync(home, { recursive: true, force: true });
  });

  it("tier A (72 columns): the §6.2 SGR receipt, no card", async () => {
    const home = newHome();
    const stdout = new Rec();
    const stderr = new Rec();
    await runOneShot(io({ columns: 72, rows: 20 }, stdout, stderr, home), {
      prompt: "hi",
      seatId: undefined,
      json: false,
      home,
      turnIdleMs: 600_000,
    });
    const text = stderr.text();
    assert.ok(text.includes(`${ESC}1;32mCOMPLETED${ESC}0m`));
    assert.ok(text.includes(`${ESC}32mchain VERIFIED${ESC}0m`));
    assert.doesNotMatch(text, /▌/); // no card edge in tier A
    // Pinned text unchanged under the spans.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping the SGR spans under test.
    const bare = text.replace(/\u001b\[[0-9;]*m/g, "");
    assert.match(bare, / turn {5}COMPLETED/);
    rmSync(home, { recursive: true, force: true });
  });

  it("the status line keeps its pinned text with the accent fill in tier W and the \\r\\x1b[K clear", async () => {
    const home = newHome();
    const stdout = new Rec();
    const stderr = new Rec();
    await runOneShot(io({}, stdout, stderr, home), {
      prompt: "hi",
      seatId: undefined,
      json: false,
      home,
      turnIdleMs: 600_000,
    });
    // The pill used the filled accent (SGR around the unchanged text); the clear is unchanged.
    assert.ok(stderr.text().includes("\r\u001b[K"), "the pinned clear sequence stays");
    rmSync(home, { recursive: true, force: true });
  });

  it("--json is byte-identical: one JSON object, no card, no status line", async () => {
    const home = newHome();
    const stdout = new Rec();
    const stderr = new Rec();
    const code = await runOneShot(io({}, stdout, stderr, home), {
      prompt: "hi",
      seatId: undefined,
      json: true,
      home,
      turnIdleMs: 600_000,
    });
    assert.equal(code, 0);
    const lines = stdout
      .text()
      .split("\n")
      .filter((l) => l !== "");
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0] ?? "{}") as {
      ok: boolean;
      session: { chain: string } | null;
    };
    assert.equal(parsed.ok, true);
    assert.equal(parsed.session?.chain, "verified");
    assert.equal(stderr.text(), "");
    rmSync(home, { recursive: true, force: true });
  });
});

describe("§8 doctor tier-W presentation", () => {
  const check = (over: Partial<Check>): Check => ({
    id: "runtime",
    status: "pass",
    summary: "node 22.19.0 (floor 22.19)",
    evidence: {},
    ...over,
  });
  const style = Style.forDepth("true", false);
  const g = glyphsFor(false);

  it("rows render as <glyph> <WORD 4> <id 14> <summary> with the hanging indent 23", () => {
    const rows = doctorRowW(check({}), style, g, 110);
    assert.equal(rows.length, 1);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping the SGR spans under test.
    const bare = (rows[0] ?? "").replace(/\u001b\[[0-9;]*m/g, "");
    assert.match(bare, /PASS {2}runtime {8}node 22\.19\.0 \(floor 22\.19\)/);
    const long = doctorRowW(
      check({
        id: "locks",
        status: "warn",
        summary:
          "thr_ed00484335834366bddf8dc4b5578cc4 · pid 48121 · age 912s: pid 48121 not visible in this PID namespace: dead here, or live in another container. M0 supports one PID namespace per MADC_HOME (Amendment 2 §1); do not resume this thread from two places",
      }),
      style,
      g,
      96,
    );
    assert.ok(long.length > 1, "long summaries wrap");
    for (const line of long.slice(1)) {
      assert.match(line, /^ {23}\S/);
    }
  });

  it("the pending row is the dim ○ ···· <id> running placeholder", () => {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping the SGR spans under test.
    const bare = doctorPendingRowW("engine", style, g).replace(/\u001b\[[0-9;]*m/g, "");
    assert.match(bare, /○ ···· +engine +running/);
  });

  it("round 8: ASCII mode renders the selected glyph set — `v PASS` and `- ····`, never `✓`/`○`", () => {
    const asciiStyle = Style.forDepth("true", true);
    const asciiG = glyphsFor(true);
    const bareRow = doctorRowW(check({}), asciiStyle, asciiG, 110)
      .join("\n")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping the SGR spans under test.
      .replace(/\u001b\[[0-9;]*m/g, "");
    assert.match(bareRow, /^v PASS {2}runtime/);
    assert.ok(!bareRow.includes("✓"), "no Unicode check glyph in ASCII mode");
    const barePending = doctorPendingRowW("engine", asciiStyle, asciiG).replace(
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping the SGR spans under test.
      /\u001b\[[0-9;]*m/g,
      "",
    );
    assert.match(barePending, /- ···· +engine +running/);
    // Ordinary Unicode rendering is preserved.
    const uniRow = doctorRowW(check({}), style, g, 110)
      .join("\n")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping the SGR spans under test.
      .replace(/\u001b\[[0-9;]*m/g, "");
    assert.match(uniRow, /^✓ PASS {2}runtime/);
  });

  it("the header band carries madc doctor · madc <v> · protocol <p>", () => {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping the SGR spans under test.
    const header = doctorHeaderW("0.0.0", "madc-m0/1", style, g).replace(/\u001b\[[0-9;]*m/g, "");
    assert.match(header, /madc doctor · madc 0\.0\.0 · protocol madc-m0\/1/);
  });

  it("the RESULT tint is errbg on FAIL, warnbg on WARN, surface otherwise — never okbg", () => {
    const line = "RESULT  1 FAIL · 2 WARN · 2 SKIP · 24 ms   exit 1";
    assert.ok(doctorResultW(line, 1, 2, style).startsWith(`${ESC}48;2;44;21;32mRESULT`));
    assert.ok(
      doctorResultW(line.replace("1 FAIL", "0 FAIL"), 0, 2, style).startsWith(
        `${ESC}48;2;42;36;21mRESULT`,
      ),
    );
    assert.ok(
      doctorResultW(
        line.replace("1 FAIL", "0 FAIL").replace("2 WARN", "0 WARN"),
        0,
        0,
        style,
      ).startsWith(`${ESC}48;2;22;25;37mRESULT`),
    );
    assert.ok(!doctorResultW(line, 0, 0, style).startsWith(`${ESC}48;2;16;35;27m`)); // never okbg
  });

  it("non-TTY bytes are unchanged: the collected run writes nothing", async () => {
    const stdout = new Rec();
    const stderr = new Rec();
    const someHome = newHome();
    const quietIo: CliIO = {
      ...io(
        { stdoutIsTTY: false, stderrIsTTY: false, columns: undefined },
        stdout,
        stderr,
        someHome,
      ),
      env: { KIMI_API_KEY: "" },
    };
    const run = await collectDoctor(quietIo, { json: false, init: false }, {});
    assert.equal(stdout.text(), ""); // collectDoctor never writes
    // runtime, engine, home, seat, session, locks, registry, policy, cred, bin.claude, bin.codex,
    // and the M1-A8 seats + lanes rows.
    assert.equal(run.checks.length, 13);
    assert.equal(typeof run.exitCode, "number");
    rmSync(someHome, { recursive: true, force: true });
  });
});

describe("§6.2 pre-thread error lines (both-TTY gate)", () => {
  it("the message line is 31 and the exit digits 1;31 on a TTY; plain when piped", async () => {
    // thread/start-busy (-32004) refuses before any turn: the pre-thread two-line shape.
    process.env.MADC_TEST_FAKE_SCENARIO = "thread-start-busy";
    try {
      const home = newHome();
      const stdout = new Rec();
      const stderr = new Rec();
      const code = await runOneShot(io({}, stdout, stderr, home), {
        prompt: "hi",
        seatId: undefined,
        json: false,
        home,
        turnIdleMs: 600_000,
      });
      assert.equal(code, 3); // -32004 is an unknown-classed thread/start error → engine class
      const ttyText = stderr.plain();
      assert.match(ttyText, /madc: engine error -32004: Turn already active\nexit 3\n/);
      const styled = stderr.text();
      assert.ok(styled.includes(`${ESC}31mmadc: engine error -32004`));
      assert.ok(styled.includes(`exit ${ESC}1;31m3${ESC}0m`));
      // Piped: the same bytes, zero SGR (both-TTY gate fails on the piped stderr).
      const stdout2 = new Rec();
      const stderr2 = new Rec();
      const code2 = await runOneShot(
        io({ stderrIsTTY: false, stdoutIsTTY: false, columns: undefined }, stdout2, stderr2, home),
        { prompt: "hi", seatId: undefined, json: false, home, turnIdleMs: 600_000 },
      );
      assert.equal(code2, 3);
      assert.equal(stderr2.text(), stderr2.text()); // sanity
      assert.ok(!stderr2.text().includes("\u001b["), "plain bytes when piped");
      assert.match(stderr2.text(), /^madc: engine error -32004: Turn already active\nexit 3\n$/);
      rmSync(home, { recursive: true, force: true });
    } finally {
      delete process.env.MADC_TEST_FAKE_SCENARIO;
    }
  });
});

describe("§7 EXIT 5 card for -32009 on thread/start", () => {
  it("the big art reads EXIT 5; the engine's -32009 stays in the title", () => {
    const style = Style.forDepth("none", false);
    const g = glyphsFor(false);
    const rows = renderSessionStartFailedCard(-32009, "sessions/ is not readable", 110, style, g);
    const text = rows.join("\n");
    assert.match(text, /session error -32009/);
    // UTF-8 keeps the block art under NO_COLOR (§10); it spells EXIT 5, never EXIT -32009.
    assert.match(text, /████████╗ {2}███████/);
    assert.doesNotMatch(text, /EXIT -32009/);
    // The ASCII glyph fallback (§4) uses the #### WORD #### form.
    const asciiStyle = Style.forDepth("none", true);
    const asciiRows = renderSessionStartFailedCard(
      -32009,
      "sessions/ is not readable",
      110,
      asciiStyle,
      glyphsFor(true),
    );
    assert.match(asciiRows.join("\n"), /#### EXIT 5 ####/);
  });
});

describe("round 8: statusPill uses the REAL terminal facts (P-7)", () => {
  it("a capable terminal gets the tier-W filled pill; a limited terminal stays plain", () => {
    const text = "… madc-default · 2.3s";
    const capable = statusPill(text, io({}, new Rec(), new Rec(), newHome()));
    const limited = statusPill(
      text,
      io({ columns: 40, rows: 10, stdoutIsTTY: false }, new Rec(), new Rec(), newHome()),
    );
    // Pills are retired. Both terminals keep the pinned text with no fill.
    assert.equal(capable, text, "capable terminal: pinned text, no fill");
    assert.ok(!capable.includes("\u001b["), "no SGR fill");
    assert.equal(limited, text, "limited terminal: plain text, no SGR");
  });
});
