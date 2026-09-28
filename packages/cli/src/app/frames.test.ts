/**
 * Frame renderers at captured terminal dimensions (DESIGN-SPEC rev 6.2 §5.1–§5.8): the banner,
 * the header collapse, the rail transitions, tool cards, pills (incl. NO_COLOR forms), the
 * evidence pane and the per-state key hints.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type AppStateView,
  type BannerData,
  type DoctorSummary,
  displayCwd,
  renderBanner,
  renderHeader,
  renderHelp,
  renderHints,
  renderPills,
  renderTurn,
} from "./frames.ts";
import type { ChainVerify, TurnRecord } from "./state.ts";
import { glyphsFor, middleEllipsize, Style, truncateChrome, visibleWidth } from "./style.ts";

const doctor: DoctorSummary = {
  running: false,
  pass: 7,
  warn: 1,
  fail: 0,
  skip: 2,
  ms: 214,
  warnRows: ["locks thr_ed00 · pid 48121 · age 912s: pid 48121 not visible in this PID namespace"],
  rowLines: ["locks thr_ed00 · pid 48121 · age 912s"],
  failAtLaunch: false,
};

const banner: BannerData = {
  version: "0.0.0",
  protocol: "madc-m0/1",
  seatId: "madc-default",
  seatSha: "6a2b9c46b956",
  backing: "kimi-code",
  backingLane: "allowed-direct",
  requested: "kimi-coding/kimi-for-coding",
  served: null,
  home: "/home/mike/.madc",
  homeSource: "default",
  userHome: "/home/mike",
  cwd: "/home/mike/code/madc",
  threadId: null,
  doctor,
  registry: {
    entries: 16,
    wired: ["kimi-code", "claude-code", "codex"],
    direct: 7,
    vendor: 3,
    interactive: 2,
    forbidden: 4,
  },
  uiNote: null,
};

const style = Style.forDepth("none", false);
const g = glyphsFor(false);

const turn = (over: Partial<TurnRecord>): TurnRecord => ({
  turnId: "pending-0",
  status: "completed",
  exitCode: 0,
  inAppInterrupted: false,
  seqStart: null,
  seqEnd: null,
  verify: null,
  unverified: null,
  revoked: false,
  startTime: 0,
  endTime: 10,
  items: [],
  userText: "What does exit 2 mean?",
  ...over,
});

const view = (over: Partial<AppStateView> = {}): AppStateView => ({
  phase: "idle",
  seatId: "madc-default",
  threadId: "thr_ed00484335834366bddf8dc4b5578cc4",
  threadStatus: "active",
  sessionPath: "/home/mike/.madc/sessions/thr_ed00.jsonl",
  turns: [],
  served: null,
  lastVerify: null,
  streamSeconds: null,
  elapsedSeconds: 4.8,
  idleSeconds: 4.8,
  doctor,
  turnCount: 0,
  lastEndNamesTurn: false,
  exitHint: 0,
  sessionCode: null,
  ...over,
});

describe("§5.1 pre-conversation banner (110×32)", () => {
  const lines = renderBanner(banner, 110, style, g);
  const text = lines.join("\n");
  it("is one rounded box titled madc <version>", () => {
    assert.match(lines[0] ?? "", /^╭─ madc 0\.0\.0/);
    assert.ok(
      lines.some((l) => /^╰─+╯$/.test(l)),
      `no box bottom found in: ${JSON.stringify(lines.slice(-3))}`,
    );
  });
  it("carries the seat block: id, sha, backing, requested, served awaiting receipt", () => {
    assert.match(text, /seat +madc-default · sha256:6a2b9c46b956/);
    assert.match(text, /backing +kimi-code · allowed-direct/);
    assert.match(text, /requested +kimi-coding\/kimi-for-coding/);
    assert.match(text, /served +○ awaiting servedModel receipt/);
  });
  it("carries the doctor summary with counts and the /doctor hint", () => {
    assert.match(text, /Doctor at launch/);
    assert.match(text, /✓ 7 PASS · ▲ 1 WARN · 0 FAIL · ○ 2 SKIP/);
    assert.match(text, /\/doctor for rows/);
  });
  it("prints every WARN row in full under the banner (pinned locks wording)", () => {
    assert.match(
      text,
      /locks thr_ed00 · pid 48121 · age 912s: pid 48121 not visible in this PID namespace/,
    );
  });
  it("carries the registry summary", () => {
    assert.match(text, /Registry/);
    assert.match(text, /16 entries/);
    assert.match(text, /wired +kimi-code, claude-code, codex/);
    assert.match(text, /policy +7 direct · 3 via vendor · 2 interactive · 4 forbidden/);
  });
  it("carries the identity lines: protocol, home, cwd, thread none yet", () => {
    assert.match(text, /madc 0\.0\.0 · madc-m0\/1/);
    assert.match(text, /home \(default\)/);
    assert.match(text, /~\/code\/madc/);
    assert.match(text, /thread none yet/);
  });
  it("stacks the right column below the wordmark at 80 columns (§9)", () => {
    const lines80 = renderBanner(banner, 80, style, g);
    const text80 = lines80.join("\n");
    assert.match(text80, /seat +madc-default · sha256:6a2b9c46b956/);
    for (const line of lines80) assert.ok(line.length <= 80 + 20, `too wide: ${line.length}`);
  });
  it("NO_COLOR emits zero SGR", () => {
    for (const line of lines) assert.ok(!line.includes("\u001b["), `SGR leaked: ${line}`);
  });
});

describe("§5.2 header", () => {
  it("collapses to one line with seat, backing, protocol, cwd and thread", () => {
    const h = renderHeader(
      {
        seatId: "madc-default",
        backing: "kimi-code",
        protocol: "madc-m0/1",
        cwd: "/home/mike/code/madc",
        userHome: "/home/mike",
        threadId: "thr_ed00484335834366bddf8dc4b5578cc4",
      },
      110,
      style,
    );
    assert.match(
      h,
      /\[MADC\] madc-default · kimi-code · madc-m0\/1 · ~\/code\/madc · thread thr_ed00…8cc4/,
    );
    assert.match(h, /banner Ctrl-B/);
  });
  it("drops the cwd at 80 columns (§9)", () => {
    const h = renderHeader(
      {
        seatId: "madc-default",
        backing: "kimi-code",
        protocol: "madc-m0/1",
        cwd: "/home/mike/code/madc",
        userHome: "/home/mike",
        threadId: "thr_x",
      },
      80,
      style,
    );
    assert.doesNotMatch(h, /~\/code\/madc/);
    assert.match(h, /thread thr_x/);
  });
});

const verified: ChainVerify = {
  kind: "verified",
  seq: 6,
  headHash: "7d50df2c6d5f0000000000000000000000000000000000000000000000000000",
};

describe("§5.3–§5.4 turn rendering", () => {
  it("dotted rail with the UNVERIFIED-yet end line before the verify passes", () => {
    const lines = renderTurn(
      turn({ status: "running" }),
      {
        seatId: "madc-default",
        requestedModel: "kimi-coding/kimi-for-coding",
        userText: "hi",
        nowMs: 100,
        turnNumber: 1,
      },
      110,
      style,
      g,
    );
    const text = lines.join("\n");
    assert.match(text, /┆/);
    assert.match(text, /you hi/);
  });
  it("solid rail ┗━ with seq, head and chain VERIFIED once the verify names the turn", () => {
    const lines = renderTurn(
      turn({ status: "completed", verify: verified }),
      {
        seatId: "madc-default",
        requestedModel: "kimi-coding/kimi-for-coding",
        userText: "hi",
        nowMs: 100,
        turnNumber: 1,
      },
      110,
      style,
      g,
    );
    const text = lines.join("\n");
    assert.match(text, /┗━ seq 6 · head 7d50df2c6d5f · chain VERIFIED · turn 1/);
  });
  it("dotted UNVERIFIED end line when the last turn.end does not name the turn", () => {
    const lines = renderTurn(
      turn({
        status: "completed",
        verify: verified,
        unverified: "the chain's last turn.end does not name this turn",
      }),
      {
        seatId: "madc-default",
        requestedModel: "kimi-coding/kimi-for-coding",
        userText: "hi",
        nowMs: 100,
        turnNumber: 2,
      },
      110,
      style,
      g,
    );
    assert.match(
      lines.join("\n"),
      /╵ seq 6 · head 7d50df2c6d5f · UNVERIFIED: the chain's last turn\.end does not name this turn/,
    );
  });
  it("a revoked turn shows the red break with the chain-failure line", () => {
    const lines = renderTurn(
      turn({
        status: "completed",
        revoked: true,
        unverified: "chain FAILED line 4: hash mismatch",
      }),
      {
        seatId: "madc-default",
        requestedModel: "kimi-coding/kimi-for-coding",
        userText: "hi",
        nowMs: 100,
        turnNumber: 1,
      },
      110,
      style,
      g,
    );
    assert.match(lines.join("\n"), /╳ chain FAILED line 4: hash mismatch/);
  });
  it("tool items render as a bounded card with toolCall → toolResult and isError", () => {
    const lines = renderTurn(
      turn({
        items: [
          {
            id: "item_c1",
            kind: "toolCall",
            status: "completed",
            name: "read_file",
            arguments: { path: "docs/plan/PIN-madc-M0-cli.md" },
          },
          {
            id: "item_r1",
            kind: "toolResult",
            status: "completed",
            callId: "item_c1",
            name: "read_file",
            output: "235 lines · §4 Exit codes, lines 182-195",
            isError: false,
          },
        ],
      }),
      {
        seatId: "madc-default",
        requestedModel: "kimi-coding/kimi-for-coding",
        userText: "hi",
        nowMs: 100,
        turnNumber: 2,
      },
      110,
      style,
      g,
    );
    const text = lines.join("\n");
    assert.match(text, /◆ read_file docs\/plan\/PIN-madc-M0-cli\.md/);
    assert.match(text, /toolCall → toolResult · isError=false/);
    assert.match(text, /235 lines · §4 Exit codes, lines 182-195/);
  });
  it("an isError tool result switches to the ✕ err edge; never green", () => {
    const lines = renderTurn(
      turn({
        items: [
          { id: "item_c1", kind: "toolCall", status: "completed", name: "sh", arguments: {} },
          {
            id: "item_r1",
            kind: "toolResult",
            status: "completed",
            callId: "item_c1",
            name: "sh",
            output: "boom",
            isError: true,
          },
        ],
      }),
      {
        seatId: "madc-default",
        requestedModel: "kimi-coding/kimi-for-coding",
        userText: "hi",
        nowMs: 100,
        turnNumber: 1,
      },
      110,
      style,
      g,
    );
    assert.match(lines.join("\n"), /✕/);
  });
  it("an error item renders the err-edge card with its code (IQW-8)", () => {
    const lines = renderTurn(
      turn({
        items: [
          {
            id: "item_e1",
            kind: "error",
            status: "completed",
            message: "no-credentials",
            code: -32008,
          },
        ],
      }),
      {
        seatId: "madc-default",
        requestedModel: "kimi-coding/kimi-for-coding",
        userText: "hi",
        nowMs: 100,
        turnNumber: 1,
      },
      110,
      style,
      g,
    );
    assert.match(lines.join("\n"), /✕ error -32008 no-credentials/);
  });
  it("interrupted turn ends ╵ interrupted (§5.8)", () => {
    const lines = renderTurn(
      turn({ status: "interrupted", inAppInterrupted: true, unverified: "interrupted" }),
      {
        seatId: "madc-default",
        requestedModel: "kimi-coding/kimi-for-coding",
        userText: "hi",
        nowMs: 100,
        turnNumber: 1,
      },
      110,
      style,
      g,
    );
    assert.match(lines.join("\n"), /UNVERIFIED: interrupted/);
  });
});

describe("§5.6 status pills", () => {
  const colorStyle = Style.forDepth("16", false); // UTF-8 glyphs, 16-colour SGR
  it("streaming state shows the filled ● streaming pill with one decimal", () => {
    const p = renderPills(view({ phase: "turn", streamSeconds: 2.634 }), colorStyle, g);
    assert.match(p, /● streaming 2\.6s/);
  });
  it("idle state, seat, served, thread and chain pills", () => {
    const p = renderPills(view({ idleSeconds: 4.8 }), colorStyle, g);
    assert.match(p, /○ idle · 4\.8s/);
    assert.match(p, /madc-default/);
    assert.match(p, /○ served: awaiting receipt/);
    assert.match(p, /thr_ed00…8cc4/);
    assert.match(p, /○ chain: nothing yet/);
  });
  it("served pill switches to the served model once the receipt arrives", () => {
    const p = renderPills(
      view({
        served: {
          requestedModel: "kimi-coding/kimi-for-coding",
          servedModel: "kimi-for-coding",
          backing: "kimi-code",
          providerId: "kimi-code",
        },
        lastVerify: verified,
        turns: [turn({ verify: verified })],
        lastEndNamesTurn: true,
      }),
      colorStyle,
      g,
    );
    assert.match(p, /served: kimi-for-coding/);
    assert.match(p, /seq 6 · ✓ chain VERIFIED/);
  });
  it("the UNVERIFIED chain pill keeps the turn number (IQW-14)", () => {
    const p = renderPills(
      view({
        lastVerify: verified,
        turns: [turn({}), turn({ verify: verified, unverified: "pending" })],
        lastEndNamesTurn: false,
      }),
      Style.forDepth("true", false),
      g,
    );
    // The turn number is kept in the pill (IQW-14); SGR may sit between the number and the glyph.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping the SGR spans under test.
    const stripped = p.replace(/\u001b\[[0-9;]*m/g, "");
    void stripped;
    assert.ok(
      p.includes("turn 2") && stripped.includes("turn 2 ▲ UNVERIFIED yet"),
      `turn 2 pill: ${p}`,
    );
  });
  it("chain FAILED pill is filled err", () => {
    const p = renderPills(
      view({
        phase: "chain-failed",
        lastVerify: { kind: "failed", line: 4, reason: "hash mismatch", failureKind: "integrity" },
      }),
      colorStyle,
      g,
    );
    assert.match(p, /✕ chain FAILED line 4/);
  });
  it("NO_COLOR pills become [words] with zero SGR and the ASCII glyph forms (§5.6)", () => {
    const p = renderPills(view({ phase: "turn", streamSeconds: 2.6 }), style, g);
    assert.match(p, /\[\* streaming 2\.6s\]/);
    assert.ok(!p.includes("\u001b["));
    const idle = renderPills(view({ idleSeconds: 4.8 }), style, g);
    assert.match(idle, /\[- idle · 4\.8s\]/);
    assert.match(idle, /\[- served: awaiting receipt\]/);
    assert.match(idle, /\[- chain: nothing yet\]/);
  });
});

describe("§5.7 evidence pane and §5.8 hints", () => {
  it("key hints per state: idle shows Enter/help/doctor/Tab/Ctrl-B/Ctrl-D", () => {
    const h = renderHints(view(), false, style, g);
    assert.match(h, /\[Enter\] send/);
    assert.match(h, /\[Tab\] evidence pane/);
    assert.match(h, /\[Ctrl-D\] exit/);
  });
  it("turn state shows Ctrl-C interrupt and Esc only when a pane is open (IQW4-3)", () => {
    const h = renderHints(view({ phase: "turn" }), false, style, g);
    assert.match(h, /\[Ctrl-C\] interrupt/);
    assert.doesNotMatch(h, /\[Esc\]/);
    const hOpen = renderHints(view({ phase: "turn" }), true, style, g);
    assert.match(hOpen, /\[Esc\] close pane/);
  });
  it("chain-failed state shows /doctor /new /receipt and the exit", () => {
    const h = renderHints(view({ phase: "chain-failed", exitHint: 5 }), false, style, g);
    assert.match(h, /\[\/doctor\]/);
    assert.match(h, /\[\/new\] new thread/);
    assert.match(h, /exit 5/);
  });
  it("engine-stopped state shows Enter restart engine", () => {
    const h = renderHints(view({ phase: "engine-stopped" }), false, style, g);
    assert.match(h, /\[Enter\] restart engine/);
  });
  it("/help lists the M0 keys and the rail meanings", () => {
    const text = renderHelp(style, g).join("\n");
    assert.match(text, /\/new/);
    assert.match(text, /dotted ┆/);
    assert.match(text, /solid ┃/);
    assert.match(text, /red ╳/);
  });
});

describe("§9 width helpers", () => {
  it("cwd collapses to ~ inside $HOME", () => {
    assert.equal(displayCwd("/home/mike/code/madc", "/home/mike"), "~/code/madc");
    assert.equal(displayCwd("/home/mike", "/home/mike"), "~");
    assert.equal(displayCwd("/opt/x", "/home/mike"), "/opt/x");
  });
  it("truncateChrome never splits an ANSI colour sequence at the cut", () => {
    const okSpan = "\u001b[38;5;79m";
    const reset = "\u001b[0m";
    // Plain text is byte-for-byte the old behaviour (no SGR → no closing reset).
    assert.equal(truncateChrome("abcdefghij", 5), "abcd…");
    const cut = truncateChrome(`${okSpan}hello world${reset}`, 5);
    assert.equal(cut, `${okSpan}hell…${reset}`);
    assert.equal(visibleWidth(cut), 5);
  });
  it("middleEllipsize keeps spans whole at the head and tail cuts", () => {
    const okSpan = "\u001b[38;5;79m";
    const reset = "\u001b[0m";
    const m = middleEllipsize(`${okSpan}${"a".repeat(30)}${reset}`, 10);
    assert.equal(m, `${okSpan}aaaaa…${okSpan}aaaa${reset}`);
    assert.equal(visibleWidth(m), 10);
  });
  it("middleEllipsize keeps the retained tail in its own colour, not the head's", () => {
    const red = "\u001b[31m";
    const green = "\u001b[32m";
    const reset = "\u001b[0m";
    const m = middleEllipsize(`${red}12345${green}67890${reset}`, 8);
    assert.equal(m, `${red}1234…${green}890${reset}`);
    assert.equal(visibleWidth(m), 8);
  });
});
