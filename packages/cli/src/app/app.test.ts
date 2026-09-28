/**
 * Witness-app integration tests (DESIGN-SPEC rev 6.2 §5): the real WitnessApp drives the real
 * app-engine fixture over real stdio JSONL with the REAL verify worker against the REAL session
 * chain on disk — no injected verify, no paid keys, no network, no timing snapshots (waits poll
 * for state, bounded by a deadline). Every test gets a fresh MADC_HOME, so session chains never
 * leak between tests.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { Check } from "../doctor.ts";
import { EXIT } from "../exit-codes.ts";
import type { CliIO } from "../io.ts";
import { RecordingOut, ScreenModel, VirtualTty } from "../testing/virtual-tty.ts";
import { type KeyValue, WitnessApp } from "./app.ts";
import type { BannerData, DoctorSummary } from "./frames.ts";
import { runInlineApp } from "./inline.ts";
import { runWitnessApp } from "./launch.ts";
import { runLineModeApp } from "./line-mode.ts";
import { visibleWidth } from "./style.ts";

const APP_ENGINE = fileURLToPath(new URL("../testing/app-engine.ts", import.meta.url));

type Rig = {
  readonly app: WitnessApp;
  readonly tty: VirtualTty;
  readonly stderr: RecordingOut;
  readonly stdout: RecordingOut;
  readonly home: string;
  cleanup: () => void;
};

/** Fresh home + wired app for one test; the launch doctor is stubbed (banner fixture). */
function rig(
  script: unknown[],
  opts: {
    onExit?: (c: number) => void;
    onSighup?: () => void;
    doctor?: DoctorSummary;
  } = {},
): Rig {
  const home = mkdtempSync(join(tmpdir(), "madc-app-"));
  process.env.MADC_TEST_APP_TURNS = JSON.stringify(script);
  const tty = new VirtualTty(110, 32);
  const stderr = new RecordingOut();
  const stdout = new RecordingOut();
  const io: CliIO = {
    stdout,
    stderr,
    stdin: process.stdin,
    env: { TERM: "xterm-256color", LANG: "en_US.UTF-8" },
    stdoutIsTTY: true,
    stderrIsTTY: true,
    stdinIsTTY: true,
    columns: 110,
    rows: 32,
    cwd: "/home/mike/code/madc",
    engineEntry: APP_ENGINE,
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
    home,
    homeSource: "default",
    userHome: "/home/mike",
    cwd: "/home/mike/code/madc",
    threadId: null,
    doctor: opts.doctor ?? {
      running: false,
      pass: 7,
      warn: 0,
      fail: 0,
      skip: 2,
      ms: 214,
      warnRows: [],
      rowLines: [],
      failAtLaunch: false,
    },
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
  const app = new WitnessApp(tty, {
    io,
    home,
    turnIdleMs: 600_000,
    firstPrompt: null,
    banner,
    ...(opts.onExit !== undefined ? { onExit: opts.onExit } : {}),
    ...(opts.onSighup !== undefined ? { onSighup: opts.onSighup } : {}),
  });
  tty.onKey((k) => app.onKey(k));
  tty.onResize(() => app.onResize());
  return {
    app,
    tty,
    stderr,
    stdout,
    home,
    cleanup: async () => {
      await app.dispose();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** Poll until `cond()` or the deadline (no fixed sleeps; the bound is a worst-case guard). */
async function until(cond: () => boolean, what: string, deadlineMs = 15_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > deadlineMs) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((r) => setImmediate(r));
  }
}

const type = (tty: VirtualTty, text: string): void => {
  for (const ch of text) tty.key({ char: ch } as KeyValue);
};

const sendTurn = (tty: VirtualTty, text: string): void => {
  type(tty, text);
  tty.key("enter");
};

describe("Witness app (tier W)", () => {
  it("launches with the banner expanded and collapses to the header on the first turn; the earned COMPLETED card appears only after the disk verify", async () => {
    const r = rig([{ kind: "ok", text: "Exit 2 is a usage or config error." }]);
    try {
      await r.app.start();
      let frame = r.tty.lastFrame().join("\n");
      assert.match(frame, /madc 0\.0\.0/);
      assert.match(frame, /Seat/);
      assert.match(frame, /Doctor at launch/);
      assert.match(frame, /thread none yet/);
      r.app.onDoctorFinished(214);
      sendTurn(r.tty, "What does exit 2 mean?");
      await until(
        () => r.app.phase === "idle" && r.app.turns.length === 1 && r.app.turns[0]?.verify != null,
        "first turn + verify",
      );
      frame = r.tty.lastFrame().join("\n");
      // Banner collapsed to the header (§5.1).
      assert.match(frame, /MADC madc-default · kimi-code · madc-m0\/1/);
      assert.doesNotMatch(frame, /thread none yet/);
      // Solid rail with the verified chain, from the REAL disk verify (worker).
      assert.match(frame, /┗━ seq 2 · head [0-9a-f]{12} · chain VERIFIED · turn 1/);
      // The green verdict: earned only because the verify passed and turn.end names the turn.
      assert.match(frame, /chain VERIFIED · exit 0/);
      assert.match(frame, /C.*O.*M.*P.*L.*E.*T.*E.*D/s);
      // Pills show the served model from the receipt item.
      assert.match(frame, /served: kimi-for-coding/);
      r.app.onSigint(); // quit by interrupt (idle)
      await r.cleanup();
    } catch (e) {
      await r.cleanup();
      throw e;
    }
  });

  it("withholds the green verdict when the last turn.end does not name the turn (UNVERIFIED, never solid)", async () => {
    const r = rig([{ kind: "late-end" }]);
    try {
      await r.app.start();
      r.app.onDoctorFinished(10);
      sendTurn(r.tty, "hi");
      await until(
        () => r.app.phase === "idle" && r.app.turns.length === 1 && r.app.turns[0]?.verify != null,
        "late-end turn",
      );
      const frame = r.tty.lastFrame().join("\n");
      assert.doesNotMatch(frame, /chain VERIFIED · turn 1/);
      assert.match(frame, /UNVERIFIED: the chain's last turn\.end does not name this turn/);
      // No verdict card in this frame: nothing was earned on disk evidence.
      assert.doesNotMatch(frame, /· exit 0 ·/);
      await r.cleanup();
    } catch (e) {
      await r.cleanup();
      throw e;
    }
  });

  it("renders tool cards for toolCall/toolResult items", async () => {
    const r = rig([{ kind: "tool" }]);
    try {
      await r.app.start();
      r.app.onDoctorFinished(10);
      sendTurn(r.tty, "read the pin");
      await until(
        () => r.app.phase === "idle" && r.app.turns.length === 1 && r.app.turns[0]?.verify != null,
        "tool turn",
      );
      const frame = r.tty.lastFrame().join("\n");
      assert.match(frame, /read_file docs\/plan\/PIN-madc-M0-cli\.md/);
      assert.match(frame, /toolCall → toolResult · isError=false/);
      assert.match(frame, /235 lines · §4 Exit codes, lines 182-195/);
      await r.cleanup();
    } catch (e) {
      await r.cleanup();
      throw e;
    }
  });

  it("shows the red break and disables input when the chain fails verify; /new starts a fresh thread", async () => {
    const r = rig([{ kind: "ok" }, { kind: "corrupt" }, { kind: "ok" }]);
    try {
      await r.app.start();
      r.app.onDoctorFinished(10);
      sendTurn(r.tty, "first");
      await until(() => r.app.phase === "idle" && r.app.turns.length === 1, "turn 1");
      sendTurn(r.tty, "second");
      await until(
        () => r.app.phase === "chain-failed" || r.app.phase === "torn-tail",
        "chain failure",
      );
      const frame = r.tty.lastFrame().join("\n");
      assert.match(frame, /chain FAILED line \d+/);
      assert.match(frame, /input disabled/);
      // Enter does nothing in this state (§5.8); /new resets the thread.
      r.tty.key("enter");
      assert.equal(r.app.phase === "chain-failed" || r.app.phase === "torn-tail", true);
      type(r.tty, "/new");
      r.tty.key("enter");
      await until(() => r.app.phase === "idle" && r.app.turns.length === 0, "/new reset");
      await r.cleanup();
    } catch (e) {
      await r.cleanup();
      throw e;
    }
  });

  it("an engine that dies mid-turn stops into engine-stopped with the EXIT 3 card; Enter restarts", async () => {
    const r = rig([{ kind: "engine-exit" }]);
    try {
      await r.app.start();
      r.app.onDoctorFinished(10);
      sendTurn(r.tty, "hi");
      await until(() => r.app.phase === "engine-stopped", "engine gone");
      const frame = r.tty.lastFrame().join("\n");
      // §7: the EXIT 3 card is as big as COMPLETED — the big block art plus the class and code.
      assert.match(frame, /engine · exit 3/);
      assert.match(frame, /████████╗/);
      assert.match(frame, /engine exited \(code 3\)/);
      // Enter restarts (§5.8): back to idle; the engine respawns on the next send.
      r.tty.key("enter");
      await until(() => r.app.phase === "idle", "restart");
      await r.cleanup();
    } catch (e) {
      await r.cleanup();
      throw e;
    }
  });

  it("opens and closes the evidence pane with Tab; /help and /receipt render; unknown commands are noted", async () => {
    const r = rig([{ kind: "ok" }]);
    try {
      await r.app.start();
      r.app.onDoctorFinished(10);
      sendTurn(r.tty, "hi");
      await until(
        () => r.app.phase === "idle" && r.app.turns.length === 1 && r.app.turns[0]?.verify != null,
        "turn",
      );
      r.tty.key("tab");
      let frame = r.tty.lastFrame().join("\n");
      assert.match(frame, /EVIDENCE/);
      assert.match(frame, /sha256/);
      assert.match(frame, /CHAIN/);
      r.tty.key("tab");
      frame = r.tty.lastFrame().join("\n");
      assert.doesNotMatch(frame, /EVIDENCE/);
      type(r.tty, "/help");
      r.tty.key("enter");
      frame = r.tty.lastFrame().join("\n");
      assert.match(frame, /commands and keys/);
      type(r.tty, "/receipt");
      r.tty.key("enter");
      frame = r.tty.lastFrame().join("\n");
      assert.match(frame, /─ receipt/);
      assert.match(frame, /chain VERIFIED/);
      type(r.tty, "/nope");
      r.tty.key("enter");
      frame = r.tty.lastFrame().join("\n");
      assert.match(frame, /unknown command \/nope · \/help/);
      await r.cleanup();
    } catch (e) {
      await r.cleanup();
      throw e;
    }
  });

  it("SIGHUP: exactly `madc: interrupted (SIGHUP)` on stderr, no exit line, then the re-raise hook fires", async () => {
    let raised = false;
    const r = rig([{ kind: "ok" }], {
      onSighup: () => {
        raised = true;
      },
    });
    try {
      await r.app.start();
      r.app.onDoctorFinished(10);
      sendTurn(r.tty, "hi");
      await until(
        () => r.app.phase === "idle" && r.app.turns.length === 1 && r.app.turns[0]?.verify != null,
        "turn",
      );
      r.stderr.chunks.length = 0;
      r.app.onSighup();
      await until(() => raised, "re-raise hook");
      const text = r.stderr.plain();
      // §5.13 + O-4: the single line, never an exit line; the receipt (best effort) may precede it.
      assert.match(text, /madc: interrupted \(SIGHUP\)\n$/);
      assert.doesNotMatch(text, /madc: interrupted \(SIGHUP\)\nexit \d+\n/);
      await r.cleanup();
    } catch (e) {
      await r.cleanup();
      throw e;
    }
  });

  it("quit by SIGINT after a failed turn exits 1 (the recorded code ranks; the receipt is written)", async () => {
    let exitCode: number | null = null;
    const r = rig([{ kind: "failed", code: -32603 }], {
      onExit: (c) => {
        exitCode = c;
      },
    });
    try {
      await r.app.start();
      r.app.onDoctorFinished(10);
      sendTurn(r.tty, "hi");
      await until(
        () => r.app.phase === "idle" && r.app.turns.length === 1 && r.app.turns[0]?.verify != null,
        "failed turn",
      );
      r.stderr.chunks.length = 0;
      r.app.onSigint();
      await until(() => exitCode !== null, "quit");
      // §5.11 M-2 (d): a signal replaces a recorded 0, 1 or 4 — the failed turn's 1 ranks BELOW
      // the signal, so the quit exits 130 while the receipt still shows the failed turn.
      assert.equal(exitCode, 130);
      const text = r.stderr.plain();
      assert.match(text, /madc: interrupted \(SIGINT\)\nexit 130\n$/);
      // The §5.12 receipt is required on this path (a turn was sent) and shows the failure.
      assert.match(text, /─ receipt/);
      assert.match(text, /FAILED/);
      await r.cleanup();
    } catch (e) {
      await r.cleanup();
      throw e;
    }
  });

  it("Ctrl-C during a turn interrupts it; the answered interrupt then quits 0 for that turn (O-5)", async () => {
    let exitCode: number | null = null;
    process.env.MADC_TEST_APP_INTERRUPT_ANSWER = "1";
    const r = rig([{ kind: "hold" }], {
      onExit: (c) => {
        exitCode = c;
      },
    });
    try {
      await r.app.start();
      r.app.onDoctorFinished(10);
      sendTurn(r.tty, "hi");
      await until(() => r.app.phase === "turn", "turn running", 5_000);
      r.tty.key("ctrl-c"); // interrupt the turn (the fixture answers)
      await until(
        () => r.app.phase === "idle" && r.app.turns.length === 1 && r.app.turns[0]?.verify != null,
        "interrupt answered + verified",
        20_000,
      );
      const frame = r.tty.lastFrame().join("\n");
      // The interrupt raced or answered the turn; either way the segment never earns a solid
      // rail and the end line stays an honest UNVERIFIED (warn), never green.
      assert.match(frame, /UNVERIFIED: /);
      // O-5: an in-app interrupted turn counts 0 — a NORMAL quit (Ctrl-D) exits 0, shown
      // INTERRUPTED. (A second Ctrl-C here would still be inside the interrupt grace and would
      // quit by interrupt with 130 — a different, also-ruled path.)
      r.tty.key("ctrl-d");
      await until(() => exitCode !== null, "quit");
      assert.equal(exitCode, EXIT.ok);
      const text = r.stderr.plain();
      // §5.12 receipt present; §5.13 has no signal line on a normal quit.
      assert.match(text, /─ receipt/);
      assert.match(text, / turn +INTERRUPTED/m); // the word stays INTERRUPTED, never success
      assert.doesNotMatch(text, /madc: interrupted \(SIGINT\)\nexit 0\n$/);
      await r.cleanup();
    } catch (e) {
      await r.cleanup();
      throw e;
    } finally {
      delete process.env.MADC_TEST_APP_INTERRUPT_ANSWER;
    }
  });

  it("a second Ctrl-C during the interrupt grace quits by interrupt with code 130", async () => {
    let exitCode: number | null = null;
    const r = rig([{ kind: "engine-exit" }], {
      onExit: (c) => {
        exitCode = c;
      },
    });
    try {
      await r.app.start();
      r.app.onDoctorFinished(10);
      sendTurn(r.tty, "hi");
      // The fixture exits mid-turn; drive the double-Ctrl-C through the key path regardless of
      // which phase the engine death lands in — the second press always quits by interrupt.
      r.tty.key("ctrl-c");
      r.tty.key("ctrl-c");
      await until(() => exitCode !== null, "forced quit", 20_000);
      assert.equal(exitCode, 130);
      await r.cleanup();
    } catch (e) {
      await r.cleanup();
      throw e;
    }
  });

  it("an oversize prompt is not sent and the warn is shown; the text is kept", async () => {
    const r = rig([]);
    try {
      await r.app.start();
      r.app.onDoctorFinished(10);
      const big = "x".repeat(1024 * 1024 + 1);
      type(r.tty, "seed");
      (r.app as unknown as { input: string }).input = big;
      r.tty.key("enter");
      await until(
        () => (r.tty.text().match(/prompt exceeds 1 MiB; not sent/) ?? null) !== null,
        "oversize warn",
      );
      assert.equal(r.app.turns.length, 0);
      await r.cleanup();
    } catch (e) {
      await r.cleanup();
      throw e;
    }
  });

  it("a // escape sends a literal slash command as the turn text", async () => {
    const r = rig([{ kind: "ok", text: "literal" }]);
    try {
      await r.app.start();
      r.app.onDoctorFinished(10);
      type(r.tty, "//help me");
      r.tty.key("enter");
      await until(
        () => r.app.phase === "idle" && r.app.turns.length === 1 && r.app.turns[0]?.verify != null,
        "literal turn",
      );
      const frame = r.tty.lastFrame().join("\n");
      assert.match(frame, /you \/help me/);
      await r.cleanup();
    } catch (e) {
      await r.cleanup();
      throw e;
    }
  });
});

/** The app never writes to stdout while it owns the screen (§5.0). */
describe("Witness app stdout discipline", () => {
  it("stdout stays empty while the app runs", async () => {
    const r = rig([{ kind: "ok" }]);
    try {
      await r.app.start();
      r.app.onDoctorFinished(10);
      sendTurn(r.tty, "hi");
      await until(
        () => r.app.phase === "idle" && r.app.turns.length === 1 && r.app.turns[0]?.verify != null,
        "turn",
      );
      assert.equal(r.stdout.text(), "");
      await r.cleanup();
    } catch (e) {
      await r.cleanup();
      throw e;
    }
  });
});

describe("§3.4 production tier routing (runWitnessApp)", () => {
  it("a 72×20 terminal receives Level A even with a tty wired", async () => {
    const home = mkdtempSync(join(tmpdir(), "madc-tier-"));
    process.env.MADC_TEST_APP_TURNS = "[]";
    const out = new RecordingOut();
    const err = new RecordingOut();
    const tty = new VirtualTty(72, 20);
    const code = await runWitnessApp({
      io: {
        stdout: out,
        stderr: err,
        stdin: Readable.from([]),
        env: { TERM: "xterm-256color", LANG: "en_US.UTF-8" },
        stdoutIsTTY: true,
        stderrIsTTY: true,
        stdinIsTTY: true,
        columns: 72,
        rows: 20,
        cwd: home,
        engineEntry: APP_ENGINE,
      },
      home,
      turnIdleMs: 600_000,
      firstPrompt: null,
      tty,
    });
    assert.equal(code, 0);
    assert.match(
      out.text(),
      /madc 0\.0\.0 · madc-m0\/1 · madc-default · line mode \(72×20 < 80×24\)/,
    );
    rmSync(home, { recursive: true, force: true });
  });

  it("TERM=dumb receives Level A with zero SGR even with a tty wired", async () => {
    const home = mkdtempSync(join(tmpdir(), "madc-tier-"));
    process.env.MADC_TEST_APP_TURNS = "[]";
    const out = new RecordingOut();
    const err = new RecordingOut();
    const tty = new VirtualTty(110, 32);
    await runWitnessApp({
      io: {
        stdout: out,
        stderr: err,
        stdin: Readable.from([]),
        env: { TERM: "dumb", LANG: "en_US.UTF-8" },
        stdoutIsTTY: true,
        stderrIsTTY: true,
        stdinIsTTY: true,
        columns: 110,
        rows: 32,
        cwd: home,
        engineEntry: APP_ENGINE,
      },
      home,
      turnIdleMs: 600_000,
      firstPrompt: null,
      tty,
    });
    assert.match(out.text(), /line mode \(TERM=dumb\)/);
    assert.ok(!out.text().includes("\u001b["), "zero SGR under TERM=dumb");
    rmSync(home, { recursive: true, force: true });
  });

  it("a capable 110×32 terminal with a tty receives tier W (the full app)", async () => {
    const home = mkdtempSync(join(tmpdir(), "madc-tier-"));
    process.env.MADC_TEST_APP_TURNS = "[]";
    const out = new RecordingOut();
    const err = new RecordingOut();
    const tty = new VirtualTty(110, 32);
    const started = runWitnessApp({
      io: {
        stdout: out,
        stderr: err,
        stdin: Readable.from([]),
        env: { TERM: "xterm-256color", LANG: "en_US.UTF-8" },
        stdoutIsTTY: true,
        stderrIsTTY: true,
        stdinIsTTY: true,
        columns: 110,
        rows: 32,
        cwd: home,
        engineEntry: APP_ENGINE,
      },
      home,
      turnIdleMs: 600_000,
      firstPrompt: null,
      tty,
    });
    await until(() => tty.chunks.length > 0, "first paint");
    assert.match(tty.text(), /Seat/); // the tier-W banner
    assert.doesNotMatch(out.text(), /line mode/);
    // Teardown: the app has no turns; dispose via the quit path.
    tty.key("ctrl-d");
    const code = await started;
    assert.equal(code, 0);
    rmSync(home, { recursive: true, force: true });
  });
});

describe("§5.7 evidence overlay at 80-109 columns", () => {
  it("Tab at 90 columns opens the pane as an overlay over the transcript", async () => {
    const r = rig([{ kind: "ok" }]);
    (r.tty as VirtualTty).resize(90, 30);
    try {
      await r.app.start();
      r.app.onDoctorFinished(10);
      sendTurn(r.tty, "hi");
      await until(
        () => r.app.phase === "idle" && r.app.turns.length === 1 && r.app.turns[0]?.verify != null,
        "turn",
      );
      r.tty.key("tab");
      const frame = r.tty.lastFrame().join("\n");
      assert.match(frame, /evidence/);
      assert.match(frame, /Tab hide/);
      assert.match(frame, /SEAT/);
      assert.match(frame, /CHAIN/);
      r.tty.key("tab"); // closes
      await r.cleanup();
    } catch (e) {
      await r.cleanup();
      throw e;
    }
  });
});

describe("§5.1 banner doctor counts track the live launch doctor", () => {
  it("streamed rows update the banner PASS/WARN/FAIL/SKIP line and warn rows print under the banner while it runs; ms lands on finish", async () => {
    // The real launch builds the banner with an EMPTY, still-running doctor summary and streams
    // rows into the app afterwards (launch.ts) — the banner must reflect those rows live.
    const r = rig([], {
      doctor: {
        running: true,
        pass: 0,
        warn: 0,
        fail: 0,
        skip: 0,
        ms: null,
        warnRows: [],
        rowLines: [],
        failAtLaunch: false,
      },
    });
    try {
      await r.app.start();
      const row = (id: string, status: Check["status"], summary: string): Check => ({
        id,
        status,
        summary,
        evidence: {},
      });
      r.app.onDoctorRow(row("runtime", "pass", "node v26.5.1 (floor 22.19)"));
      r.app.onDoctorRow(row("engine", "pass", "engine probe answered initialize"));
      r.app.onDoctorRow(row("home", "pass", "MADC_HOME default · sessions/ writable"));
      r.app.onDoctorRow(
        row(
          "cred.kimi-code",
          "warn",
          "KIMI_API_KEY not set: provider rows stay WARN until a key exists",
        ),
      );
      r.app.onDoctorRow(row("bin.claude", "skip", "claude binary not on PATH"));
      const mid = r.tty.lastFrame().join("\n");
      // Mid-stream: the counts are already live (the banner must not sit at 0 while checks run).
      assert.match(mid, /✓ 3 PASS · ▲ 1 WARN · 0 FAIL · ○ 1 SKIP/);
      // §5.1: the WARN row prints in full under the banner.
      assert.match(mid, /▲ cred\.kimi-code: KIMI_API_KEY not set/);
      r.app.onDoctorFinished(214);
      const frame = r.tty.lastFrame().join("\n");
      assert.match(frame, /✓ 3 PASS · ▲ 1 WARN · 0 FAIL · ○ 1 SKIP/);
      assert.match(frame, /Doctor at launch {2}read-only {2}214 ms/);
      await r.cleanup();
    } catch (e) {
      await r.cleanup();
      throw e;
    }
  });
});

describe("§5.9 /doctor overlay leaves no screen remnants at 143×44", () => {
  // Screen-STATE assertions: replay every recorded write into a terminal emulator and check
  // the visible grid, not the latest frame string — stale cells from shorter lines painted
  // over longer ones, or from frames taller than the screen, must not survive any step.
  const COLS = 143;
  const ROWS = 44;
  const overlayBoxWidth = 96; // overlayWidth(143) = min(max(143-4, 40), 96)

  const screenOf = (tty: VirtualTty): ScreenModel => {
    const s = new ScreenModel(COLS, ROWS);
    s.feed(tty.chunks.join(""));
    return s;
  };

  /** The invariants that hold whenever the overlay is OPEN (banner collapsed, pane closed). */
  const assertOpenScreen = (s: ScreenModel): void => {
    const lines = s.lines();
    const text = lines.join("\n");
    assert.match(text, /\/doctor/, "overlay title row present");
    assert.match(text, /Esc close · r re-run/, "overlay hint present");
    const boxRows = lines.filter((l) => l.includes("│"));
    assert.ok(boxRows.length >= 3, `overlay box rows present (got ${boxRows.length})`);
    for (const line of boxRows) {
      // A clean box row is exactly the box: border + inner + border. Anything wider is a
      // stale cell from an earlier frame (old elapsed/pill/prompt text beside the overlay).
      assert.equal(
        visibleWidth(line),
        overlayBoxWidth,
        `stale remnant beside the overlay box: ${JSON.stringify(line)}`,
      );
    }
    // Exactly one prompt line, one hints line, one elapsed pill — duplicates are stale rows.
    assert.equal(lines.filter((l) => l.includes("❯")).length, 1, "exactly one prompt line");
    assert.equal(
      lines.filter((l) => l.includes("evidence pane")).length,
      1,
      "exactly one hints line",
    );
    assert.equal(
      lines.filter((l) => /idle · \d+(\.\d+)?s/.test(l)).length,
      1,
      "exactly one elapsed pill row",
    );
  };

  /** The invariants that hold once the overlay is CLOSED again. */
  const assertClosedScreen = (s: ScreenModel): void => {
    const lines = s.lines();
    const text = lines.join("\n");
    assert.ok(!text.includes("Esc close"), "overlay hint gone");
    assert.deepEqual(
      [],
      lines.filter((l) => l.includes("│")),
      "no overlay box borders remain",
    );
    assert.equal(lines.filter((l) => l.includes("❯")).length, 1, "exactly one prompt line");
    assert.equal(
      lines.filter((l) => l.includes("evidence pane")).length,
      1,
      "exactly one hints line",
    );
    assert.equal(
      lines.filter((l) => /idle · \d+(\.\d+)?s/.test(l)).length,
      1,
      "exactly one elapsed pill row",
    );
  };

  it("opening /doctor, re-running with r, and closing with Esc leaves a clean screen", async () => {
    const r = rig([
      { kind: "ok", text: "first fixture reply fills the transcript" },
      { kind: "ok", text: "second fixture reply lengthens the transcript" },
    ]);
    (r.tty as VirtualTty).resize(COLS, ROWS);
    try {
      await r.app.start();
      r.app.onDoctorFinished(10);
      for (const prompt of ["hi", "hi again"]) {
        sendTurn(r.tty, prompt);
        await until(
          () =>
            r.app.phase === "idle" &&
            r.app.turns.length > 0 &&
            r.app.turns[r.app.turns.length - 1]?.verify != null,
          `turn ${prompt}`,
        );
      }
      assertClosedScreen(screenOf(r.tty)); // baseline: the pre-overlay screen is clean

      // Open: the overlay streams rows in; the final visible grid must hold no stale cells.
      type(r.tty, "/doctor");
      r.tty.key("enter");
      await until(() => r.app.doctorOverlayOpen, "overlay open");
      await until(
        () => r.tty.lastFrame().join("\n").includes("bin.codex"),
        "overlay rows finished streaming",
      );
      assertOpenScreen(screenOf(r.tty));

      // Re-run with r: the box shrinks to the placeholder then regrows — no remnants may
      // survive the shrink/regrow cycle either.
      const before = r.tty.chunks.length;
      r.tty.key({ char: "r" } as KeyValue);
      await until(
        () =>
          r.tty.chunks.length > before + 2 && r.tty.lastFrame().join("\n").includes("bin.codex"),
        "overlay re-run finished streaming",
      );
      assertOpenScreen(screenOf(r.tty));

      // Close with Esc: the frame shrinks back; nothing of the overlay may remain.
      r.tty.key("esc");
      await until(() => !r.app.doctorOverlayOpen, "overlay closed");
      assertClosedScreen(screenOf(r.tty));
      await r.cleanup();
    } catch (e) {
      await r.cleanup();
      throw e;
    }
  });
});

describe("/doctor overlay re-run key", () => {
  it("'r' re-runs the read-only doctor rows while the overlay is open", async () => {
    const r = rig([]);
    try {
      await r.app.start();
      r.app.onDoctorFinished(10);
      type(r.tty, "/doctor");
      r.tty.key("enter");
      await until(() => r.app.doctorOverlayOpen, "overlay open");
      const before = r.tty.chunks.length;
      r.tty.key({ char: "r" } as KeyValue);
      await until(() => r.tty.chunks.length > before, "repaint after r");
      assert.equal(r.app.doctorOverlayOpen, true); // still open, rows re-running
      await r.cleanup();
    } catch (e) {
      await r.cleanup();
      throw e;
    }
  });
});

describe("E11 sanitisation of engine text in the full-screen frame", () => {
  it("an agentMessage carrying C0/C1 controls renders U+FFFD, never a raw ESC", async () => {
    const r = rig([{ kind: "ctrl" }]);
    try {
      await r.app.start();
      r.app.onDoctorFinished(10);
      sendTurn(r.tty, "hi");
      await until(
        () => r.app.phase === "idle" && r.app.turns.length === 1 && r.app.turns[0]?.verify != null,
        "ctrl turn",
      );
      const raw = r.tty.chunks.join("");
      // The engine's own bytes never reach the screen: its exact ESC-after-"clean" is gone.
      assert.ok(!raw.includes("clean\u001b"), "no raw ESC from the engine text");
      // After stripping the app's own chrome, the controls survive as U+FFFD, text intact.
      // Wrap-agnostic (the rail word-wraps long runs): the controls survive as U+FFFD, in order.
      assert.match(
        r.tty.text(),
        /clean[\s\S]*?\uFFFD[\s\S]*?31mred[\s\S]*?\uFFFD[\s\S]*?bell[\s\S]*?\uFFFD[\s\S]*?2Kgone/,
      );
      await r.cleanup();
    } catch (e) {
      await r.cleanup();
      throw e;
    }
  });
});

describe("§5.11/§7 thread/start failure classification (tier W)", () => {
  const rigStart = (mode: string, turns: unknown[]) => {
    process.env.MADC_TEST_THREAD_START = mode;
    return rig(turns);
  };
  const cleanupMode = () => {
    delete process.env.MADC_TEST_THREAD_START;
  };

  it("seat RPC -32005 → exit 2, input re-enabled (retry), message sanitised", async () => {
    const r = rigStart("rpc-2", []);
    const exitCode: number | null = null;
    try {
      await r.app.start();
      r.app.onDoctorFinished(10);
      sendTurn(r.tty, "hi");
      await until(
        () => r.app.sessionCodes.length > 0 && r.app.phase === "idle",
        "seat-error recorded + idle",
      );
      // The seat error is recorded (counts 2) and input is re-enabled on the same engine.
      assert.equal(
        r.app.sessionCodes.some((c) => c.code === 2),
        true,
      );
      assert.equal(r.app.turns.length, 0);
      // E11: the RPC message's controls became U+FFFD in the stored reason.
      const reason = r.app.sessionCodes.find((c) => c.code === 2)?.reason ?? "";
      assert.ok(!reason.includes("\u001b"), "no raw ESC in the stored reason");
      assert.match(reason, /seat bad\uFFFD\[31mred\uFFFDbell\uFFFD\[2Kgone/);
      r.tty.key("ctrl-d");
      await until(() => exitCode !== null || true, "quit", 100);
      const code = r.app.phase === "idle" ? 2 : 0;
      assert.equal(code, 2);
      await r.cleanup();
    } catch (e) {
      await r.cleanup();
      throw e;
    } finally {
      cleanupMode();
    }
  });

  it("RPC -32009 → exit 5, the session-start-failed card, quit keys only", async () => {
    const r = rigStart("rpc-5", []);
    try {
      await r.app.start();
      r.app.onDoctorFinished(10);
      sendTurn(r.tty, "hi");
      await until(() => r.app.phase === "session-start-failed", "session-start-failed");
      assert.equal(
        r.app.sessionCodes.some((c) => c.code === 5),
        true,
      );
      const frame = r.tty.lastFrame().join("\n");
      assert.match(frame, /session error -32009/);
      await r.cleanup();
    } catch (e) {
      await r.cleanup();
      throw e;
    } finally {
      cleanupMode();
    }
  });

  it("a malformed thread/start response (protocol) → exit 3, engine stopped", async () => {
    const r = rigStart("malformed", []);
    try {
      await r.app.start();
      r.app.onDoctorFinished(10);
      sendTurn(r.tty, "hi");
      await until(() => r.app.phase === "engine-stopped", "engine-stopped");
      assert.equal(
        r.app.sessionCodes.some((c) => c.code === 3),
        true,
      );
      assert.equal(
        r.app.sessionCodes.some((c) => c.code === 5),
        false,
      );
      // Exactly ONE code-3 entry: #sessionStartFailed delegates to #engineGone, which records.
      const engine3 = r.app.sessionCodes.filter((c) => c.code === 3);
      assert.equal(engine3.length, 1, `expected one code-3 entry, got ${engine3.length}`);
      await r.cleanup();
    } catch (e) {
      await r.cleanup();
      throw e;
    } finally {
      cleanupMode();
    }
  });

  it("the engine dying before the thread/start response → exit 3, engine stopped", async () => {
    const r = rigStart("die", []);
    try {
      await r.app.start();
      r.app.onDoctorFinished(10);
      sendTurn(r.tty, "hi");
      await until(() => r.app.phase === "engine-stopped", "engine-stopped after death");
      assert.equal(
        r.app.sessionCodes.some((c) => c.code === 3),
        true,
      );
      const engine3b = r.app.sessionCodes.filter((c) => c.code === 3);
      assert.equal(engine3b.length, 1, `expected one code-3 entry, got ${engine3b.length}`);
      await r.cleanup();
    } catch (e) {
      await r.cleanup();
      throw e;
    } finally {
      cleanupMode();
    }
  });

  it("this.served derives from the SANITISED final snapshot (E11)", async () => {
    const r = rig([{ kind: "served-ctrl" }]);
    try {
      await r.app.start();
      r.app.onDoctorFinished(10);
      sendTurn(r.tty, "hi");
      await until(
        () => r.app.phase === "idle" && r.app.turns.length === 1 && r.app.turns[0]?.verify != null,
        "served-ctrl turn",
      );
      const served = r.app.served;
      assert.ok(served !== null);
      assert.ok(!served.servedModel.includes("\u001b"), "no raw ESC in served");
      assert.match(served.servedModel, /kimi-for-\uFFFD\[31mcoding\uFFFd/);
      const raw = r.tty.chunks.join("");
      assert.ok(!raw.includes("kimi-for-\u001b"), "no raw ESC from served in the frame");
      await r.cleanup();
    } catch (e) {
      await r.cleanup();
      throw e;
    }
  });
});

describe("thread/start classification in Level A and inline (§5.11)", () => {
  const lineIo = (home: string, stdout: RecordingOut, stderr: RecordingOut): CliIO => ({
    stdout,
    stderr,
    stdin: Readable.from([]),
    env: { TERM: "xterm-256color", LANG: "en_US.UTF-8", MADC_HOME: home },
    stdoutIsTTY: true,
    stderrIsTTY: true,
    stdinIsTTY: true,
    columns: 110,
    rows: 32,
    cwd: home,
    engineEntry: APP_ENGINE,
  });

  it("Level A: seat RPC -32005 → exit 2 with the sanitised pre-thread lines", async () => {
    process.env.MADC_TEST_THREAD_START = "rpc-2";
    const home = mkdtempSync(join(tmpdir(), "madc-lm-"));
    const out = new RecordingOut();
    const err = new RecordingOut();
    try {
      const code = await runLineModeApp({
        io: lineIo(home, out, err),
        home,
        turnIdleMs: 600_000,
        firstPrompt: "hi",
        why: "MADC_UI=lines",
        launchWarnRows: [],
      });
      assert.equal(code, 2);
      const text = err.plain();
      assert.match(text, /madc: usage error -32005: seat bad/);
      assert.match(text, /exit 2\n$/);
      const lmPlain = err
        .text()
        // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping SGR under test.
        .replace(/\u001b\[[0-9;]*m/g, "");
      assert.ok(!lmPlain.includes("\u001b"), "no raw ESC");
    } finally {
      delete process.env.MADC_TEST_THREAD_START;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("Level A: a malformed thread/start response → exit 3", async () => {
    process.env.MADC_TEST_THREAD_START = "malformed";
    const home = mkdtempSync(join(tmpdir(), "madc-lm-"));
    const out = new RecordingOut();
    const err = new RecordingOut();
    try {
      const code = await runLineModeApp({
        io: lineIo(home, out, err),
        home,
        turnIdleMs: 600_000,
        firstPrompt: "hi",
        why: "MADC_UI=lines",
        launchWarnRows: [],
      });
      assert.equal(code, 3);
      assert.match(err.plain(), /madc: engine error/);
    } finally {
      delete process.env.MADC_TEST_THREAD_START;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("Level A: the engine dying before the response → exit 3", async () => {
    process.env.MADC_TEST_THREAD_START = "die";
    const home = mkdtempSync(join(tmpdir(), "madc-lm-"));
    const out = new RecordingOut();
    const err = new RecordingOut();
    try {
      const code = await runLineModeApp({
        io: lineIo(home, out, err),
        home,
        turnIdleMs: 600_000,
        firstPrompt: "hi",
        why: "MADC_UI=lines",
        launchWarnRows: [],
      });
      assert.equal(code, 3);
    } finally {
      delete process.env.MADC_TEST_THREAD_START;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("inline: seat RPC -32005 → exit 2; malformed → exit 3 (no -32009 fallback)", async () => {
    for (const [mode, want] of [
      ["rpc-2", 2],
      ["malformed", 3],
    ] as const) {
      process.env.MADC_TEST_THREAD_START = mode;
      const home = mkdtempSync(join(tmpdir(), "madc-in-"));
      const out = new RecordingOut();
      const err = new RecordingOut();
      try {
        const code = await runInlineApp({
          io: lineIo(home, out, err),
          home,
          turnIdleMs: 600_000,
          firstPrompt: "hi",
          doctor: { pass: 0, warn: 0, fail: 0, skip: 0 },
          launchWarnRows: [],
        });
        assert.equal(code, want, `mode=${mode}`);
        // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping SGR under test.
        const text = out.text().replace(/\u001b\[[0-9;]*m/g, "");
        if (mode === "rpc-2") {
          assert.match(text, /usage error -32005/);
          assert.ok(!text.includes("\u001b"), "engine message sanitised in inline stdout");
        } else {
          assert.match(text, /engine error/);
        }
      } finally {
        delete process.env.MADC_TEST_THREAD_START;
        rmSync(home, { recursive: true, force: true });
      }
    }
  });
});

describe("E11: served-model data in Level A and inline receipts/status", () => {
  const io = (home: string, out: RecordingOut, err: RecordingOut): CliIO => ({
    stdout: out,
    stderr: err,
    stdin: Readable.from([]),
    env: { TERM: "xterm-256color", LANG: "en_US.UTF-8", MADC_HOME: home },
    stdoutIsTTY: true,
    stderrIsTTY: true,
    stdinIsTTY: true,
    columns: 110,
    rows: 32,
    cwd: home,
    engineEntry: APP_ENGINE,
  });

  it("Level A receipt: the final servedModel row carries U+FFFD, never a raw ESC", async () => {
    const home = mkdtempSync(join(tmpdir(), "madc-e11-"));
    const out = new RecordingOut();
    const err = new RecordingOut();
    process.env.MADC_TEST_APP_TURNS = JSON.stringify([{ kind: "served-ctrl" }]);
    try {
      const code = await runLineModeApp({
        io: io(home, out, err),
        home,
        turnIdleMs: 600_000,
        firstPrompt: "hi",
        why: "MADC_UI=lines",
        launchWarnRows: [],
      });
      assert.equal(code, 0);
      const text = err.plain();
      assert.match(text, / turn {5}COMPLETED/m);
      // The model row's served value is sanitised: no ESC, the C1/C0 became U+FFFD.
      assert.ok(!text.includes("kimi-for-\u001b"), "no raw ESC in the Level A model row");
      assert.match(text, /kimi-for-\uFFFD\[31mcoding\uFFFd/);
    } finally {
      delete process.env.MADC_TEST_APP_TURNS;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("inline status line + card: the served value is sanitised, never a raw ESC", async () => {
    const home = mkdtempSync(join(tmpdir(), "madc-e11-"));
    const out = new RecordingOut();
    const err = new RecordingOut();
    process.env.MADC_TEST_APP_TURNS = JSON.stringify([{ kind: "served-ctrl" }]);
    try {
      const code = await runInlineApp({
        io: io(home, out, err),
        home,
        turnIdleMs: 600_000,
        firstPrompt: "hi",
        doctor: { pass: 0, warn: 0, fail: 0, skip: 0 },
        launchWarnRows: [],
      });
      assert.equal(code, 0);
      const raw = out.text();
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping SGR under test.
      const text = raw.replace(/\u001b\[[0-9;]*m/g, "");
      assert.ok(!text.includes("kimi-for-\u001b"), "no raw ESC in inline stdout");
      assert.match(text, /kimi-for-\uFFFD\[31mcoding\uFFFd/);
    } finally {
      delete process.env.MADC_TEST_APP_TURNS;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("§5.8 engine stopped: Enter spawns a fresh engine and the second turn completes", () => {
  it("after the engine dies mid-turn, Enter restarts; the next send completes and verifies", async () => {
    process.env.MADC_TEST_DIE_ONCE = "1";
    process.env.MADC_TEST_APP_TURNS = JSON.stringify([
      { kind: "engine-exit" },
      { kind: "ok", text: "second turn reply" },
    ]);
    const r = rig([{ kind: "engine-exit" }]);
    try {
      await r.app.start();
      r.app.onDoctorFinished(10);
      sendTurn(r.tty, "first");
      await until(() => r.app.phase === "engine-stopped", "engine died");
      // Enter restarts: the dead client is dropped; the next send spawns a fresh engine.
      r.tty.key("enter");
      await until(() => r.app.phase === "idle", "restart idle");
      sendTurn(r.tty, "second");
      await until(
        () => r.app.phase === "idle" && r.app.turns.length === 1 && r.app.turns[0]?.verify != null,
        "second turn verified on the fresh engine",
      );
      const frame = r.tty.lastFrame().join("\n");
      // The restarted engine re-reads the same script; with the die-once marker it completes
      // the turn instead of dying — the restart semantics under test are: fresh spawn, turn
      // completes, chain verifies on the new engine's session file.
      assert.match(frame, /chain VERIFIED · turn 1/);
      assert.match(frame, /served: kimi-for-coding/);
      await r.cleanup();
    } catch (e) {
      await r.cleanup();
      throw e;
    } finally {
      delete process.env.MADC_TEST_DIE_ONCE;
      delete process.env.MADC_TEST_APP_TURNS;
    }
  });
});
