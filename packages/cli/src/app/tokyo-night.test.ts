/**
 * Honesty guards for the Tokyo Night CLI look. These fail if a guard is removed:
 * no green on a failed turn; tool/time/hash colour is foreground not muted; a folder
 * that is not a repo keeps the panel; the model slot says requested before a receipt;
 * /doctor starts only when `/` is the first character; Ctrl-B restores the startup box;
 * every turn keeps one verdict line.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { CliIO } from "../io.ts";
import { WitnessApp } from "./app.ts";
import type { BannerData } from "./frames.ts";
import type { TurnRecord } from "./state.ts";
import { glyphsFor, Style } from "./style.ts";
import {
  doctorCommandStarts,
  gitPanelRows,
  modelSlot,
  readGitPanelNow,
  renderTokyoFrame,
  verdictOf,
} from "./tokyo.ts";
import { RecordingOut, VirtualTty } from "../testing/virtual-tty.ts";

const FG = "38;2;169;177;214";
const MUTED = "38;2;86;95;137";
const GREEN = "38;2;158;206;106";
const RED = "38;2;247;118;142";

const style = Style.forDepth("true", false);
const g = glyphsFor(false);

function turn(over: Partial<TurnRecord> & Pick<TurnRecord, "status">): TurnRecord {
  return {
    turnId: "turn_local",
    userText: "read the receipt format and tell me if exit 0 is enough",
    items: [],
    exitCode: 0,
    inAppInterrupted: false,
    seqStart: null,
    seqEnd: null,
    verify: null,
    unverified: null,
    revoked: false,
    startTime: 0,
    endTime: 1000,
    ...over,
  };
}

const gitRepo = {
  kind: "repo" as const,
  branch: "main",
  hashes: ["c4e1a9", "8b20df"],
  ahead: 1,
  behind: 0,
};

function frame(turns: TurnRecord[], over: Partial<Parameters<typeof renderTokyoFrame>[0]> = {}) {
  return renderTokyoFrame({
    width: 100,
    height: 36,
    startup: null,
    turns,
    verifying: false,
    git: gitRepo,
    status: {
      seatId: "madc-default",
      phase: "idle",
      turns,
      turnSeconds: 4.2,
      totalSeconds: 12.4,
      requestedModel: "moonshot-v1",
      servedModel: null,
    },
    composer: "",
    composerRole: "fg",
    notes: [],
    style,
    ...over,
  });
}

describe("Tokyo Night honesty guards", () => {
  it("a failed turn is only the red line: no green SGR and no checkmark", () => {
    const failed = turn({
      status: "failed",
      exitCode: 1,
      items: [
        {
          kind: "error",
          id: "err1",
          status: "completed",
          code: -32603,
          message: "provider down",
        },
      ],
      verify: { kind: "verified", seq: 4, headHash: "a1b2c3d4e5f6aaaa" },
    });
    const text = frame([failed], {
      status: {
        seatId: "madc-default",
        phase: "idle",
        turns: [failed],
        turnSeconds: 4.2,
        totalSeconds: 12.4,
        requestedModel: "moonshot-v1",
        servedModel: null,
      },
    }).join("\n");
    assert.match(text, /✗ error -32603 provider down/);
    assert.ok(text.includes(RED), "the failure line is red");
    assert.ok(!text.includes(GREEN), "no green on a failed turn");
    assert.ok(!text.includes("✓"), "no checkmark on a failed turn");
    assert.ok(!text.includes("chain VERIFIED"), "no verified words on a failed turn");
    assert.ok(!text.includes("ready"), "status bar must not say ready");
  });

  it("chain FAILED is red, regular weight, and not green", () => {
    const failed = turn({
      status: "completed",
      verify: { kind: "failed", line: 4, reason: "hash mismatch", failureKind: "integrity" },
      unverified: "chain FAILED line 4: hash mismatch",
    });
    const text = frame([failed], {
      status: {
        seatId: "madc-default",
        phase: "chain-failed",
        turns: [failed],
        turnSeconds: 4.2,
        totalSeconds: 12.4,
        requestedModel: "moonshot-v1",
        servedModel: "moonshot-v1",
      },
    }).join("\n");
    assert.match(text, /✗ chain FAILED line 4: hash mismatch/);
    assert.match(text, /chain failed/);
    assert.ok(text.includes(RED));
    assert.ok(!text.includes(GREEN));
    assert.ok(!text.includes("\u001b[1;"), "verdict is not bold");
    assert.ok(!text.includes("✓"));
  });

  it("tool, elapsed time, and git hash use foreground, not muted", () => {
    const ok = turn({
      status: "completed",
      items: [
        {
          kind: "toolCall",
          id: "c1",
          status: "completed",
          name: "read_file",
          arguments: { path: "docs/plan/PIN-madc-M0-cli.md" },
        },
        {
          kind: "toolResult",
          id: "r1",
          status: "completed",
          callId: "c1",
          name: "read_file",
          output: "ok",
          isError: false,
        },
        {
          kind: "agentMessage",
          id: "a1",
          status: "completed",
          text: "Exit 0 is not enough on its own. The receipt still has to show the chain verified, the served model, and the session head.",
        },
      ],
      verify: { kind: "verified", seq: 4, headHash: "a1b2c3d4e5f6aaaa" },
    });
    const lines = frame([ok], {
      status: {
        seatId: "madc-default",
        phase: "idle",
        turns: [ok],
        turnSeconds: 4.2,
        totalSeconds: 12.4,
        requestedModel: "moonshot-v1",
        servedModel: "moonshot-v1",
      },
    });
    const tool = lines.find((l) => l.includes("read_file")) ?? "";
    assert.match(tool, /read_file docs\/plan\/PIN-madc-M0-cli\.md/);
    assert.ok(tool.includes(FG), "tool line is foreground");
    assert.ok(!tool.includes(MUTED), "tool line is not muted");
    const time = lines.find((l) => l.includes("4.2s / 12.4s")) ?? "";
    const timeAt = time.indexOf("4.2s / 12.4s");
    const timeSpan = time.slice(0, timeAt);
    assert.ok(timeSpan.includes(FG), "elapsed time is foreground");
    assert.ok(!timeSpan.endsWith(MUTED), "elapsed time is not muted");
    const hash = lines.find((l) => l.includes("c4e1a9")) ?? "";
    const hashAt = hash.indexOf("c4e1a9");
    assert.ok(hash.slice(Math.max(0, hashAt - 40), hashAt).includes(FG));
    assert.ok(!hash.slice(Math.max(0, hashAt - 20), hashAt).includes(MUTED));
  });

  it("a failed tool call turns that tool line red", () => {
    const bad = turn({
      status: "completed",
      items: [
        { kind: "toolCall", id: "c1", status: "completed", name: "read_file", arguments: "x" },
        {
          kind: "toolResult",
          id: "r1",
          status: "completed",
          callId: "c1",
          name: "read_file",
          output: "no",
          isError: true,
        },
      ],
      verify: { kind: "verified", seq: 4, headHash: "a1b2c3d4e5f6aaaa" },
    });
    const tool = frame([bad]).find((l) => l.includes("read_file")) ?? "";
    assert.ok(tool.includes(RED));
    assert.ok(!tool.includes(GREEN));
  });

  it("a folder that is not a repo keeps the git panel and says so", () => {
    const dir = mkdtempSync(join(tmpdir(), "madc-not-repo-"));
    try {
      const snap = readGitPanelNow(dir);
      assert.equal(snap.kind, "not-repo");
      const rows = gitPanelRows(snap, g).map((parts) => parts.map((p) => p.text).join(""));
      assert.equal(rows.length, 7);
      assert.match(rows[0] ?? "", /git/);
      assert.match(rows.join("\n"), /the folder/);
      assert.match(rows.join("\n"), /isn't a/);
      assert.match(rows.join("\n"), /repo/);
      assert.match(rows[0] ?? "", /┌/);
      assert.match(rows[6] ?? "", /└/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ahead/behind keeps the arrows in ASCII mode", () => {
    const rows = gitPanelRows(gitRepo, glyphsFor(true)).map((p) => p.map((x) => x.text).join(""));
    assert.match(rows.join("\n"), /↑1 ↓0/);
    assert.doesNotMatch(rows.join("\n"), /\+1 -0/);
  });

  it("the model slot is labeled requested until a servedModel receipt", () => {
    assert.equal(modelSlot("moonshot-v1", null), "requested moonshot-v1");
    assert.equal(modelSlot("moonshot-v1", ""), "requested moonshot-v1");
    assert.equal(modelSlot("moonshot-v1", "kimi-for-coding"), "kimi-for-coding");
    const before = frame([]).join("\n");
    assert.match(before, /requested moonshot-v1/);
    const after = frame([], {
      status: {
        seatId: "madc-default",
        phase: "idle",
        turns: [],
        turnSeconds: 4.2,
        totalSeconds: 12.4,
        requestedModel: "moonshot-v1",
        servedModel: "kimi-for-coding",
      },
    }).join("\n");
    assert.match(after, /kimi-for-coding/);
    assert.doesNotMatch(after, /requested/);
  });

  it("every turn keeps its own verdict line", () => {
    const a = turn({
      turnId: "t1",
      status: "completed",
      userText: "read the receipt format and tell me if exit 0 is enough",
      verify: { kind: "verified", seq: 4, headHash: "a1b2c3d4e5f6aaaa" },
    });
    const b = turn({
      turnId: "t2",
      status: "completed",
      userText: "show me the doctor rows",
      verify: { kind: "verified", seq: 8, headHash: "bbbbbbbbbbbbcccc" },
    });
    const text = frame([a, b]).join("\n");
    const hits = text.match(/chain VERIFIED/g) ?? [];
    assert.equal(hits.length, 2);
    assert.match(text, /✓ seq 4 · head a1b2c3d4e5f6 · chain VERIFIED/);
    assert.match(text, /✓ seq 8 · head bbbbbbbbbbbb · chain VERIFIED/);
  });

  it("verdictOf does not return green for a failed status", () => {
    const v = verdictOf(
      turn({
        status: "failed",
        verify: { kind: "verified", seq: 1, headHash: "a1b2c3d4e5f6aaaa" },
      }),
      g,
      false,
    );
    assert.equal(v?.role, "err");
    assert.ok(!v?.text.includes("VERIFIED"));
  });

  it("/doctor starts only when the composer begins with /", () => {
    assert.equal(doctorCommandStarts("/doctor"), true);
    assert.equal(doctorCommandStarts("/doctor now"), true);
    assert.equal(doctorCommandStarts(" /doctor"), false);
    assert.equal(doctorCommandStarts("x/doctor"), false);
    assert.equal(doctorCommandStarts("/help"), false);
  });

  it("Ctrl-B brings the startup box back after the first turn", () => {
    const home = mkdtempSync(join(tmpdir(), "madc-tokyo-"));
    const tty = new VirtualTty(100, 36);
    const banner: BannerData = {
      version: "0.0.0",
      protocol: "madc-m1/1",
      seatId: "madc-default",
      seatSha: null,
      backing: "kimi-code",
      backingLane: null,
      requested: "moonshot-v1",
      served: null,
      home,
      homeSource: "default",
      userHome: "/home/mike",
      cwd: home,
      threadId: null,
      doctor: {
        running: false,
        pass: 0,
        warn: 0,
        fail: 0,
        skip: 0,
        ms: 1,
        warnRows: [],
        allRows: [],
        failAtLaunch: false,
      },
      registry: null,
      uiNote: null,
      tools: ["read_file", "doctor"],
      skills: [],
    };
    const io: CliIO = {
      stdout: new RecordingOut(),
      stderr: new RecordingOut(),
      stdin: process.stdin,
      env: { TERM: "xterm-256color", LANG: "en_US.UTF-8", COLORTERM: "truecolor" },
      stdoutIsTTY: true,
      stderrIsTTY: true,
      stdinIsTTY: true,
      columns: 100,
      rows: 36,
      cwd: home,
    };
    const app = new WitnessApp(tty, {
      io,
      home,
      turnIdleMs: 600_000,
      firstPrompt: null,
      banner,
      now: () => 0,
    });
    try {
      app.onDoctorFinished(1);
      app.turns = [
        turn({
          status: "completed",
          verify: { kind: "verified", seq: 4, headHash: "a1b2c3d4e5f6aaaa" },
        }),
      ];
      app.bannerExpanded = false;
      app.paint();
      const hidden = tty.lastFrame().join("\n");
      assert.doesNotMatch(hidden, /version {3}madc 0\.0\.0/);
      assert.match(hidden, /chain VERIFIED/);
      app.onKey("ctrl-b");
      const shown = tty.lastFrame().join("\n");
      assert.match(shown, /madc 0\.0\.0/);
      assert.match(shown, /read_file/);
      assert.match(shown, /doctor/);
      assert.match(shown, /Skills/);
      app.input = " /doctor";
      app.onKey("enter");
      assert.equal(app.doctorOverlayOpen, false);
      app.input = "/doctor";
      app.onKey("enter");
      assert.equal(app.doctorOverlayOpen, true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
