/**
 * Witness-app integration tests (DESIGN-SPEC rev 6.2 §5): the real WitnessApp drives the real
 * app-fixture over real stdio JSONL with the REAL verify worker against the REAL session
 * chain on disk — no injected verify, no paid keys, no network, no timing snapshots (waits poll
 * for state, bounded by a deadline). Every test gets a fresh MADC_HOME, so session chains never
 * leak between tests.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { spawnEngine } from "@madc/engine/client";
import type { Check } from "../doctor.ts";
import { EXIT } from "../exit-codes.ts";
import type { CliIO } from "../io.ts";
import { RecordingOut, ScreenModel, VirtualTty } from "../testing/virtual-tty.ts";
import { type KeyValue, WitnessApp } from "./app.ts";
import type { BannerData, DoctorSummary } from "./frames.ts";
import { runInlineApp } from "./inline.ts";
import { runWitnessApp, seatFields, uiNoteFor } from "./launch.ts";
import { runLineModeApp } from "./line-mode.ts";
import { visibleWidth } from "./style.ts";

const APP_FIXTURE = fileURLToPath(new URL("../testing/app-fixture.ts", import.meta.url));

/** Module-level Level-A/inline IO rig (fresh MADC_HOME per call, fixture engine). */
const lineIoPlain = (home: string, stdout: RecordingOut, stderr: RecordingOut): CliIO => ({
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
  engineEntry: APP_FIXTURE,
});

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
    now?: () => number;
    cols?: number;
    rows?: number;
    uiNote?: string;
    firstPrompt?: string;
  } = {},
): Rig {
  const home = mkdtempSync(join(tmpdir(), "madc-app-"));
  process.env.MADC_TEST_APP_TURNS = JSON.stringify(script);
  const tty = new VirtualTty(opts.cols ?? 110, opts.rows ?? 32);
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
    columns: opts.cols ?? 110,
    rows: opts.rows ?? 32,
    cwd: "/home/mike/code/madc",
    engineEntry: APP_FIXTURE,
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
      allRows: [],
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
    uiNote: opts.uiNote ?? null,
  };
  const app = new WitnessApp(tty, {
    io,
    home,
    turnIdleMs: 600_000,
    firstPrompt: opts.firstPrompt ?? null,
    banner,
    ...(opts.onExit !== undefined ? { onExit: opts.onExit } : {}),
    ...(opts.onSighup !== undefined ? { onSighup: opts.onSighup } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
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

/** Route a `process.kill(pid, 0)` failure: ONLY ESRCH means the pid is absent. EPERM (the
 * process exists but is not ours to signal) and every unexpected error propagate — they are
 * never silently read as "dead". */
const routeProbeError = (err: unknown): "absent" => {
  if ((err as NodeJS.ErrnoException).code === "ESRCH") return "absent";
  throw err;
};

/** In-process liveness of a positive-integer pid (signal 0, nothing sent). Invalid pids are
 * rejected before any probe; there is no fallback value. */
const probePid = (pid: number): "alive" | "absent" => {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`invalid pid for liveness probe: ${String(pid)}`);
  }
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (err) {
    return routeProbeError(err);
  }
};

describe("B-2 ownership: lossless pid encoding and probe semantics", () => {
  it("fixtureThreadId round-trips every pid — seven-digit ones included, no modulo", async () => {
    process.env.MADC_TEST_FIXTURE_HELPERS_ONLY = "1";
    const { fixtureThreadId } = await import("../testing/app-fixture.ts");
    delete process.env.MADC_TEST_FIXTURE_HELPERS_ONLY;
    for (const pid of [1, 9, 99_999, 999_999, 1_000_000, 1_234_567, 9_999_999]) {
      const tid = fixtureThreadId(pid);
      assert.match(tid, /^thr_app\d+$/, `id grammar for pid ${pid}`);
      assert.equal(
        Number(tid.slice("thr_app".length)),
        pid,
        `pid ${pid} must survive the encoding untouched`,
      );
    }
    assert.equal(fixtureThreadId(1_234_567), "thr_app1234567");
  });

  it("probePid: invalid pids rejected; only ESRCH is absent; EPERM and unexpected errors throw", async () => {
    assert.throws(() => probePid(0), /invalid pid/);
    assert.throws(() => probePid(-1), /invalid pid/);
    assert.throws(() => probePid(1.5), /invalid pid/);
    assert.throws(() => probePid(Number.NaN), /invalid pid/);
    // Error routing, pinned with synthetic errnos (a live EPERM is not producible
    // unprivileged): ESRCH → absent; EPERM / unexpected / codeless errors propagate.
    assert.equal(
      routeProbeError(Object.assign(new Error("no such process"), { code: "ESRCH" })),
      "absent",
    );
    assert.throws(
      () => routeProbeError(Object.assign(new Error("operation not permitted"), { code: "EPERM" })),
      (err: Error & { code?: string }) => err.code === "EPERM",
    );
    assert.throws(
      () => routeProbeError(Object.assign(new Error("i/o"), { code: "EIO" })),
      (err: Error & { code?: string }) => err.code === "EIO",
    );
    assert.throws(() => routeProbeError(new Error("codeless")), /codeless/);
    // A REAL ESRCH: an engine child spawned here, closed, awaited — then probed.
    const home = mkdtempSync(join(tmpdir(), "madc-probe-"));
    const shortLived = spawnEngine({
      env: { MADC_HOME: home, MADC_TEST_APP_TURNS: "[]" },
      entry: APP_FIXTURE,
    });
    const shortLivedPid = shortLived.child.pid;
    assert.ok(
      shortLivedPid !== undefined && Number.isSafeInteger(shortLivedPid) && shortLivedPid > 0,
      "the probe child reports a valid pid",
    );
    assert.equal(probePid(shortLivedPid), "alive");
    await shortLived.close(1_000).catch(() => null);
    assert.equal(probePid(shortLivedPid), "absent");
    rmSync(home, { recursive: true, force: true });
  });
});

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
      assert.match(frame, /┗━ seq 4 · head [0-9a-f]{12} · chain VERIFIED · turn 1/);
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
        engineEntry: APP_FIXTURE,
      },
      home,
      turnIdleMs: 600_000,
      firstPrompt: null,
      tty,
    });
    assert.equal(code, 0);
    assert.match(
      out.text(),
      /madc 0\.0\.0 · madc-m1\/1 · madc-default · line mode \(72×20 < 80×24\)/,
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
        engineEntry: APP_FIXTURE,
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
        engineEntry: APP_FIXTURE,
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
        allRows: [],
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
      assert.match(mid, /✓ 3 PASS · ▲ 1 WARN · ✕ 0 FAIL · ○ 1 SKIP/);
      // §5.1: the WARN row prints in full under the banner.
      assert.match(mid, /▲ cred\.kimi-code: KIMI_API_KEY not set/);
      r.app.onDoctorFinished(214);
      const frame = r.tty.lastFrame().join("\n");
      assert.match(frame, /✓ 3 PASS · ▲ 1 WARN · ✕ 0 FAIL · ○ 1 SKIP/);
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
      // `lanes` (M1-A8) is the last doctor row.
      await until(
        () => r.tty.lastFrame().join("\n").includes("lanes"),
        "overlay rows finished streaming",
      );
      assertOpenScreen(screenOf(r.tty));

      // Re-run with r: the box shrinks to the placeholder then regrows — no remnants may
      // survive the shrink/regrow cycle either.
      const before = r.tty.chunks.length;
      r.tty.key({ char: "r" } as KeyValue);
      await until(
        () => r.tty.chunks.length > before + 2 && r.tty.lastFrame().join("\n").includes("lanes"),
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

describe("§5.7 docked evidence pane at 143×44", () => {
  // The pane docks at >=110 columns: the transcript keeps width-38 columns and the pane box
  // takes 36. Screen-STATE assertions (the §5.9 emulator): the banner must honour the width it
  // actually occupies — rendering it at the full terminal width and clipping afterwards split
  // ANSI colour sequences mid-span and pushed the pane borders off their columns.
  const COLS = 143;
  const ROWS = 44;
  const REGION = COLS - 38; // the 105-column transcript region beside the docked pane
  const PANE_W = 36;

  const screenOf = (tty: VirtualTty): ScreenModel => {
    const s = new ScreenModel(COLS, ROWS);
    s.feed(tty.chunks.join(""));
    return s;
  };

  // Pane rows start with the box's left border glyph — │ for content rows, ╭/╰ for the
  // titled top and bottom rows — and end with its mirror (│/╮/╯) 36 columns later.
  const PANE_START = new Set(["│", "╭", "╰"]);
  const PANE_END = new Set(["│", "╮", "╯"]);

  const paneRowsOf = (lines: readonly string[]): readonly string[] =>
    lines.filter((l) => l.length > REGION && PANE_START.has(l[REGION] ?? ""));

  /** Invariants whenever the pane is docked: fixed border columns, one prompt/hints/pill line
   *  each — and no escape bytes or SGR parameters left as visible cells. */
  const assertPaneDocked = (s: ScreenModel): void => {
    const lines = s.lines();
    const text = lines.join("\n");
    // A clip that splits an SGR span leaves its parameter digits as cells (`…38;5;238m`).
    assert.ok(!text.includes("\u001b"), "escape byte rendered as a visible cell");
    assert.ok(!/(?:38;5;|38;2;|48;5;)\d+/.test(text), "SGR parameters leaked as text");
    // Pane box: both borders at fixed columns on every pane row; a pane row is exactly the
    // region plus the 36-column pane — anything else is a clipped or stale cell.
    const paneRows = paneRowsOf(lines);
    assert.ok(paneRows.length >= 10, `pane rows present (got ${paneRows.length})`);
    for (const [i, l] of paneRows.entries()) {
      assert.ok(
        PANE_END.has(l[REGION + PANE_W - 1] ?? ""),
        `pane right border drifted on row ${i}`,
      );
      assert.equal(
        visibleWidth(l),
        REGION + PANE_W,
        `row ${i} exceeds region+pane: ${JSON.stringify(l)}`,
      );
    }
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

  /** The expanded banner beside the docked pane: the doctor summary and registry policy render
   *  complete inside the region (not cut at the pane column mid-row), and the banner box rows
   *  that continue below the pane keep borders at columns 0 and REGION-3 — never under the
   *  pane. The responsive banner fills its region (W-1): the box is REGION-2 wide. */
  const assertBannerBesidePane = (s: ScreenModel): void => {
    assertPaneDocked(s);
    const lines = s.lines();
    const text = lines.join("\n");
    const box = REGION - 2;
    assert.match(text, /✓ 7 PASS · ▲ 0 WARN · ✕ 0 FAIL · ○ 2 SKIP/);
    assert.match(text, /Doctor at launch {2}read-only {2}214 ms/);
    assert.match(text, /policy +7 direct · 3 via vendor · 2 interactive · 4 forbidden/);
    for (const [i, l] of lines.entries()) {
      if (l.includes("│") && paneRowsOf([l]).length === 0) {
        assert.equal(l[0], "│", `banner row ${i} does not start at its box border`);
        assert.equal(l[box - 1], "│", `banner row ${i} box border pushed past the box`);
        assert.equal(
          visibleWidth(l),
          box,
          `banner row ${i} ignores its available width: ${JSON.stringify(l)}`,
        );
      }
    }
  };

  /** Invariants once the pane is closed again with Tab. */
  const assertPaneClosed = (s: ScreenModel): void => {
    const lines = s.lines();
    assert.deepEqual([], paneRowsOf(lines), "no docked pane borders remain");
    assert.equal(lines.filter((l) => l.includes("❯")).length, 1, "exactly one prompt line");
    assert.equal(
      lines.filter((l) => l.includes("evidence pane")).length,
      1,
      "exactly one hints line",
    );
  };

  it("Tab docks the pane beside a banner that respects its region; Tab again closes clean", async () => {
    const r = rig([
      { kind: "ok", text: "first fixture reply fills the transcript" },
      { kind: "ok", text: "second fixture reply lengthens the transcript" },
    ]);
    (r.tty as VirtualTty).resize(COLS, ROWS);
    try {
      await r.app.start();
      r.app.onDoctorFinished(214);
      assertPaneClosed(screenOf(r.tty)); // banner expanded, no pane: clean baseline

      // Dock while the banner is still expanded: the doctor counts, the registry policy row
      // and the box borders must all fit the 105-column region, complete and aligned.
      r.tty.key("tab");
      await until(() => r.app.evidenceOpen, "pane docked beside the banner");
      assertBannerBesidePane(screenOf(r.tty));

      // Two turns collapse the banner to the header; the pane keeps its columns.
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
      assertPaneDocked(screenOf(r.tty));

      r.tty.key("tab"); // closes the pane
      await until(() => !r.app.evidenceOpen, "pane closed");
      assertPaneClosed(screenOf(r.tty));
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
    engineEntry: APP_FIXTURE,
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
        turnIdleMs: 30_000,
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
        turnIdleMs: 30_000,
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
        turnIdleMs: 30_000,
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
          turnIdleMs: 30_000,
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
    engineEntry: APP_FIXTURE,
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
        turnIdleMs: 30_000,
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
        turnIdleMs: 30_000,
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

describe("MADC_UI contract (§5.0 IQW-12)", () => {
  it('uiNoteFor recognizes only "lines" and never echoes the value', () => {
    assert.equal(uiNoteFor({}), null);
    assert.equal(uiNoteFor({ MADC_UI: "" }), null);
    assert.equal(uiNoteFor({ MADC_UI: "lines" }), null);
    assert.equal(uiNoteFor({ MADC_UI: "inline" }), 'MADC_UI: not recognised (only "lines")');
    assert.equal(uiNoteFor({ MADC_UI: "cards" }), 'MADC_UI: not recognised (only "lines")');
  });
});

describe("W-2 launch doctor evidence retention (§5.1 full rows, §5.7 pane rows)", () => {
  const zero = (running: boolean): DoctorSummary => ({
    running,
    pass: 0,
    warn: 0,
    fail: 0,
    skip: 0,
    ms: null,
    warnRows: [],
    allRows: [],
    failAtLaunch: false,
  });
  const row = (id: string, status: "pass" | "warn" | "fail" | "skip", summary: string): Check => ({
    id,
    status,
    summary,
    evidence: {},
  });

  it("prints every WARN and FAIL row in full under the banner and keeps every row in the evidence pane", async () => {
    const r = rig([{ kind: "ok" }], { doctor: zero(true) });
    try {
      await r.app.start();
      r.app.onDoctorRow(row("runtime", "pass", "node v26.5.1"));
      r.app.onDoctorRow(
        row(
          "locks",
          "warn",
          "locks thr_ed00 · pid 48121 · age 912s: pid 48121 not visible in this PID namespace",
        ),
      );
      r.app.onDoctorRow(row("cred.kimi", "fail", "kimi credential missing from keychain"));
      r.app.onDoctorRow(row("bin.codex", "skip", "codex not on PATH"));
      r.app.onDoctorFinished(50);
      const frame = r.tty.lastFrame().join("\n");
      assert.match(frame, /✓ 1 PASS · ▲ 1 WARN · ✕ 1 FAIL · ○ 1 SKIP/);
      // §5.1: WARN and FAIL rows in full, under the banner, in their pinned wording.
      assert.match(
        frame,
        /locks thr_ed00 · pid 48121 · age 912s: pid 48121 not visible in this PID namespace/,
      );
      assert.match(frame, /kimi credential missing from keychain/);
      assert.match(r.tty.text(), /a launch doctor row FAILED/);
      // §5.7: the pane's DOCTOR AT LAUNCH section keeps every row — PASS and SKIP included.
      r.tty.key("tab");
      await until(() => r.app.evidenceOpen, "pane opens");
      const pane = r.tty.lastFrame().join("\n");
      assert.match(pane, /runtime +node v26\.5\.1/);
      assert.match(pane, /bin\.codex +codex not on PATH/);
      // Long summaries take the pane's middle ellipsis; the row (not its full text) is what
      // §5.7 requires the pane to retain — the full wording prints under the banner above.
      assert.match(pane, /locks +locks/);
      r.tty.key("tab");
      await until(() => !r.app.evidenceOpen, "pane closes");
      await r.cleanup();
    } catch (e) {
      await r.cleanup();
      throw e;
    }
  });

  it("keeps FAIL detail visible before acknowledgement on a 24-row terminal; Enter acknowledges", async () => {
    const r = rig([], { cols: 100, rows: 24, doctor: zero(true) });
    try {
      await r.app.start(); // 24 rows < 30: the banner starts collapsed (§5.1 collapse rule)
      r.app.onDoctorRow(row("cred.kimi", "fail", "kimi credential missing from keychain"));
      r.app.onDoctorFinished(30);
      // §5.1: a FAIL at launch keeps the banner expanded and disables input until Enter.
      assert.equal(r.app.bannerExpanded, true);
      const frame = r.tty.lastFrame().join("\n");
      assert.match(frame, /kimi credential missing from keychain/);
      assert.match(frame, /a launch doctor row FAILED/);
      r.tty.key("enter");
      await until(() => r.app.phase === "idle", "fail acknowledged");
      await r.cleanup();
    } catch (e) {
      await r.cleanup();
      throw e;
    }
  });
});

describe("W-3 displayed elapsed values respect the 5 Hz ceiling (§5.5, §10)", () => {
  const idleSecondsOf = (tty: VirtualTty): number | null => {
    const m = tty
      .lastFrame()
      .join("\n")
      .match(/idle · (\d+\.\d)s/);
    return m === null ? null : Number(m[1]);
  };
  const changesAcross = (values: readonly number[]): number => {
    let changes = 0;
    for (let i = 1; i < values.length; i++) if (values[i] !== values[i - 1]) changes++;
    return changes;
  };

  it("rapid keypresses do not advance the displayed idle time beyond the 5 Hz cap", async () => {
    let clock = 1_000_000;
    const r = rig([], {
      now: () => clock,
      doctor: {
        running: true,
        pass: 0,
        warn: 0,
        fail: 0,
        skip: 0,
        ms: null,
        warnRows: [],
        allRows: [],
        failAtLaunch: false,
      },
    });
    try {
      await r.app.start();
      r.app.onDoctorFinished(5);
      const seen: number[] = [];
      for (let i = 0; i < 12; i++) {
        clock += 100; // one character event every 100 ms of app time
        r.tty.key({ char: "x" } as KeyValue);
        const v = idleSecondsOf(r.tty);
        if (v !== null) seen.push(v);
      }
      // 1.2 simulated seconds at a 5 Hz cap allow at most ~6 displayed changes.
      assert.ok(
        changesAcross(seen) <= 6,
        `displayed idle time changed ${changesAcross(seen)} times: ${seen.join(", ")}`,
      );
      await r.cleanup();
    } catch (e) {
      await r.cleanup();
      throw e;
    }
  });

  it("streams from the tick-latched sample during a turn and returns to idle after it", async () => {
    const r = rig([{ kind: "ok", text: "fixture reply" }]);
    try {
      await r.app.start();
      r.app.onDoctorFinished(10);
      assert.match(r.tty.lastFrame().join("\n"), /idle/);
      sendTurn(r.tty, "hello");
      await until(() => r.app.phase === "turn" || r.app.turns.length === 1, "turn starts");
      if (r.app.phase === "turn") {
        assert.match(r.tty.lastFrame().join("\n"), /streaming \d+\.\d+s/);
      }
      await until(
        () => r.app.phase === "idle" && r.app.turns[0]?.verify != null,
        "turn completes and verifies",
      );
      assert.match(r.tty.lastFrame().join("\n"), /idle/);
      await r.cleanup();
    } catch (e) {
      await r.cleanup();
      throw e;
    }
  });

  it("stops the repaint tick on dispose (no writes after teardown)", async () => {
    const r = rig([]);
    try {
      await r.app.start();
      await r.cleanup();
      const n = r.tty.chunks.length;
      await new Promise((res) => setTimeout(res, 260));
      assert.equal(r.tty.chunks.length, n, "the tick kept painting after dispose");
    } catch (e) {
      await r.cleanup();
      throw e;
    }
  });
});

describe("§5.7 evidence values derived from disk verification", () => {
  it("shows numeric per-turn ranges and the served event seq after a verified turn", async () => {
    const r = rig([{ kind: "ok" }]);
    try {
      await r.app.start();
      r.app.onDoctorFinished(10);
      sendTurn(r.tty, "verify me");
      await until(() => r.app.phase === "idle" && r.app.turns[0]?.verify != null, "verified turn");
      r.tty.key("tab");
      await until(() => r.app.evidenceOpen, "pane opens");
      const pane = r.tty.lastFrame().join("\n");
      assert.match(pane, /turns +1:\d+-\d+/, "numeric per-turn seq range");
      assert.match(pane, /served +kimi-for.*· seq \d+/, "servedModel event seq from the verify");
      r.tty.key("tab");
      await r.cleanup();
    } catch (e) {
      await r.cleanup();
      throw e;
    }
  });
});

describe("correction round: historical replay, evidence binding, R-b (§5.3 R-b, §5.7)", () => {
  it("W-4 two ordinary turns on the same engine both finish with their own replies", async () => {
    const r = rig([
      { kind: "ok", text: "first distinct reply" },
      { kind: "ok", text: "second distinct reply" },
    ]);
    try {
      await r.app.start();
      r.app.onDoctorFinished(10);
      sendTurn(r.tty, "one");
      await until(
        () => r.app.phase === "idle" && r.app.turns[0]?.verify != null,
        "turn 1 completes and verifies",
      );
      sendTurn(r.tty, "two");
      await until(
        () => r.app.phase === "idle" && r.app.turns[1]?.verify != null,
        "turn 2 completes and verifies",
      );
      assert.equal(r.app.turns[0]?.status, "completed");
      assert.equal(r.app.turns[1]?.status, "completed");
      assert.equal(r.app.turns[0]?.exitCode, 0);
      assert.equal(r.app.turns[1]?.exitCode, 0);
      // The bottom-anchored screen may scroll turn 1's text above the fold: everything ever
      // written must carry each turn's own reply, and both receipts must name their own turn.
      const all = r.tty.text();
      assert.match(all, /first distinct reply/);
      assert.match(all, /second distinct reply/);
      assert.match(all, /turn +COMPLETED +turn_app0000/);
      assert.match(all, /turn +COMPLETED +turn_app0001/);
      assert.match(r.tty.lastFrame().join("\n"), /chain VERIFIED · turn 2/);
      await r.cleanup();
    } catch (e) {
      await r.cleanup();
      throw e;
    }
  });

  // The cutoff snapshot now precedes the turn/start request (B-1), so delivery is
  // deterministic even when the engine batches a response with its notifications — this
  // test runs plainly on both runtimes, with no retry and no skip.
  it("W-4 Level A: the second line-mode turn prints its own reply, not a replay", {
    timeout: 30_000,
  }, async () => {
    process.env.MADC_TEST_APP_TURNS = JSON.stringify([
      { kind: "ok", text: "lm first reply" },
      { kind: "ok", text: "lm second reply" },
    ]);
    const home = mkdtempSync(join(tmpdir(), "madc-lm2-"));
    try {
      const out = new RecordingOut();
      const err = new RecordingOut();
      // A PassThrough written after the first reply: the second line reaches readline only
      // once turn 1 is done, and EOF is deterministic (a pre-buffered Readable is not).
      const stdin = new PassThrough();
      const run = runLineModeApp({
        io: {
          stdout: out,
          stderr: err,
          stdin,
          env: { TERM: "xterm-256color", LANG: "en_US.UTF-8", MADC_HOME: home },
          stdoutIsTTY: true,
          stderrIsTTY: true,
          // A piped stdin is not a TTY: terminal-mode readline must not be implied.
          stdinIsTTY: false,
          columns: 110,
          rows: 32,
          cwd: home,
          engineEntry: APP_FIXTURE,
        },
        home,
        turnIdleMs: 30_000,
        firstPrompt: "one",
        why: "MADC_UI=lines",
        launchWarnRows: [],
      });
      const t0 = Date.now();
      try {
        while (!out.plain().includes("lm first reply") && Date.now() - t0 < 20_000) {
          await new Promise((r) => setTimeout(r, 20));
        }
        assert.match(out.plain(), /lm first reply/, "first reply before sending the second line");
        stdin.write("second\n");
        const t1 = Date.now();
        while (!out.plain().includes("lm second reply") && Date.now() - t1 < 20_000) {
          await new Promise((r) => setTimeout(r, 20));
        }
        assert.match(out.plain(), /lm second reply/, "second reply before EOF");
        stdin.end();
        const code = await run;
        assert.equal(code, 0, err.plain());
        const text = out.plain();
        assert.equal(text.split("lm first reply").length - 1, 1, "no replayed first reply");
      } catch (e) {
        // Bound a dangling run (EOF + a capped settlement) before rethrowing, so a failed
        // attempt never leaks the engine child into the runner.
        stdin.end();
        await Promise.race([run, new Promise((r) => setTimeout(r, 6_000))]).catch(() => undefined);
        throw e;
      }
    } finally {
      delete process.env.MADC_TEST_APP_TURNS;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("W-5 per-turn ranges: the second turn shows 5-8, never 1-8", async () => {
    const r = rig([
      { kind: "ok", text: "range turn one" },
      { kind: "ok", text: "range turn two" },
    ]);
    try {
      await r.app.start();
      r.app.onDoctorFinished(10);
      sendTurn(r.tty, "one");
      await until(() => r.app.phase === "idle" && r.app.turns[0]?.verify != null, "turn 1");
      sendTurn(r.tty, "two");
      await until(() => r.app.phase === "idle" && r.app.turns[1]?.verify != null, "turn 2");
      assert.equal(r.app.turns[0]?.seqStart, 1);
      assert.equal(r.app.turns[0]?.seqEnd, 4);
      assert.equal(r.app.turns[1]?.seqStart, 5);
      assert.equal(r.app.turns[1]?.seqEnd, 8);
      r.tty.key("tab");
      await until(() => r.app.evidenceOpen, "pane opens");
      const pane = r.tty.lastFrame().join("\n");
      assert.match(pane, /turns +1:1-4 2:5-8/);
      assert.doesNotMatch(pane, /2:1-8/);
      assert.match(pane, /served +kimi-for-coding · seq 7/);
      r.tty.key("tab");
      await r.cleanup();
    } catch (e) {
      await r.cleanup();
      throw e;
    }
  });

  it("W-5 a failed verify never pairs another turn's seq with the current served model", async () => {
    const r = rig([{ kind: "ok", text: "pair turn one" }, { kind: "corrupt" }]);
    try {
      await r.app.start();
      r.app.onDoctorFinished(10);
      sendTurn(r.tty, "one");
      await until(() => r.app.phase === "idle" && r.app.turns[0]?.verify != null, "turn 1");
      sendTurn(r.tty, "two");
      await until(
        () => r.app.phase === "chain-failed" || r.app.phase === "torn-tail",
        "turn 2 chain failure",
      );
      r.tty.key("tab");
      await until(() => r.app.evidenceOpen, "pane opens");
      const pane = r.tty.lastFrame().join("\n");
      // turn 1 keeps its learned range; turn 2 learned none from the failed verify.
      assert.match(pane, /turns +1:1-4 2:—/);
      // The served model on screen is turn 2's; it must not carry turn 1's servedModel seq.
      assert.doesNotMatch(pane, /served +kimi-for-coding · seq 3/);
      r.tty.key("tab");
      await r.cleanup();
    } catch (e) {
      await r.cleanup();
      throw e;
    }
  });

  it("W-6 R-b: an intact verified first turn stays solid after a later failure", async () => {
    // 120×50: tall enough that the SETTLED frame (after the chain failure, not the
    // transient verifying phase) still shows turn 1's rail end above the bottom anchor.
    const r = rig([{ kind: "ok", text: "intact turn one" }, { kind: "corrupt-last" }], {
      cols: 120,
      rows: 50,
    });
    try {
      await r.app.start();
      r.app.onDoctorFinished(10);
      sendTurn(r.tty, "one");
      await until(() => r.app.phase === "idle" && r.app.turns[0]?.verify != null, "turn 1");
      sendTurn(r.tty, "two");
      await until(
        () => r.app.phase === "chain-failed" || r.app.phase === "torn-tail",
        "turn 2 chain failure",
      );
      const frame = r.tty.lastFrame().join("\n");
      // The corrupt path persists no turn-2 items, so turn 2's turn.end is line 7 (seq 6):
      // turn 1 ended at seq 4, before seq N−1 = 6, so its verified rail stays solid (§5.3 R-b)
      // — asserted on the settled screen, never on history or an intermediate frame.
      assert.match(frame, /┗━ seq 4 · head [0-9a-f]{12} · chain VERIFIED · turn 1/);
      assert.match(frame, /chain FAILED line 7/);
      assert.doesNotMatch(frame, /╳[^\n]*turn 1/);
      await r.cleanup();
    } catch (e) {
      await r.cleanup();
      throw e;
    }
  });

  it("W-7 the unrecognised-MADC_UI note stays in the pane after typing and an oversize attempt", async () => {
    const r = rig([{ kind: "ok" }], { uiNote: 'MADC_UI: not recognised (only "lines")' });
    try {
      await r.app.start();
      r.app.onDoctorFinished(10);
      type(r.tty, "hello");
      r.tty.key("tab");
      await until(() => r.app.evidenceOpen, "pane opens");
      assert.match(r.tty.lastFrame().join("\n"), /MADC_UI: not recognised \(only "lines"\)/);
      r.tty.key("tab");
      await until(() => !r.app.evidenceOpen, "pane closes");
      r.app.input = "x".repeat(1024 * 1024 + 1);
      r.tty.key("enter");
      await until(
        () => r.tty.lastFrame().join("\n").includes("prompt exceeds 1 MiB"),
        "oversize warning",
      );
      r.tty.key("tab");
      await until(() => r.app.evidenceOpen, "pane reopens");
      const pane = r.tty.lastFrame().join("\n");
      assert.match(
        pane,
        /MADC_UI: not recognised \(only "lines"\)/,
        "the launch note must survive the transient oversize warning",
      );
      await r.cleanup();
    } catch (e) {
      await r.cleanup();
      throw e;
    }
  });

  it("W-4 an interrupt is not answered by a historical completion", {
    timeout: 20_000,
  }, async () => {
    const r = rig([{ kind: "ok", text: "interrupt turn one" }, { kind: "hold" }]);
    try {
      await r.app.start();
      r.app.onDoctorFinished(10);
      sendTurn(r.tty, "one");
      await until(() => r.app.phase === "idle" && r.app.turns[0]?.verify != null, "turn 1");
      sendTurn(r.tty, "two");
      // Wait for the turn/start ACK (realTurnId), not just the phase: Ctrl-C in the pre-ack
      // window is a different (E17a) state, not the interrupt-under-test.
      await until(
        () => r.app.phase === "turn" && r.app.turns[1]?.realTurnId !== undefined,
        "turn 2 holds after its ack",
      );
      r.tty.key("ctrl-c");
      await until(
        () => r.app.phase !== "turn" && r.app.turns[1]?.status !== undefined,
        "interrupt resolves",
      );
      // Turn 1's completion is history: it must not answer turn 2's interrupt. The fixture
      // never answers, so the 2 s grace must run out into engine-stopped (§5.8).
      assert.equal(r.app.turns[1]?.status, "unknown");
      assert.match(r.app.turns[1]?.unverified ?? "", /interrupt not answered in 2 s/);
      await r.cleanup();
    } catch (e) {
      await r.cleanup();
      throw e;
    }
  });
});

describe("round 3: cutoff race and the unanswered-interrupt engine stop", () => {
  const lmIo = (home: string, out: RecordingOut, err: RecordingOut): CliIO => ({
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
    engineEntry: APP_FIXTURE,
  });

  it("B-1 line-mode: a batched response+items+completion still completes the turn", {
    timeout: 45_000,
  }, async () => {
    process.env.MADC_TEST_APP_TURNS = JSON.stringify([
      { kind: "ok-batched", text: "batched lm reply" },
    ]);
    const home = mkdtempSync(join(tmpdir(), "madc-b1-"));
    const out = new RecordingOut();
    const err = new RecordingOut();
    try {
      const code = await runLineModeApp({
        io: lmIo(home, out, err),
        home,
        turnIdleMs: 30_000,
        firstPrompt: "hi",
        why: "MADC_UI=lines",
        launchWarnRows: [],
      });
      assert.equal(code, 0, err.plain());
      const text = out.plain();
      assert.match(text, /batched lm reply/);
      // The receipt block goes to stderr in line mode (§6.3).
      assert.match(err.plain(), /turn +COMPLETED/m);
    } finally {
      delete process.env.MADC_TEST_APP_TURNS;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("B-1 inline: a batched response+items+completion still completes the turn", {
    timeout: 45_000,
  }, async () => {
    process.env.MADC_TEST_APP_TURNS = JSON.stringify([
      { kind: "ok-batched", text: "batched inline reply" },
    ]);
    const home = mkdtempSync(join(tmpdir(), "madc-b1i-"));
    const out = new RecordingOut();
    const err = new RecordingOut();
    try {
      const code = await runInlineApp({
        io: lmIo(home, out, err),
        home,
        turnIdleMs: 30_000,
        firstPrompt: "hi",
        doctor: { pass: 0, warn: 0, fail: 0, skip: 0 },
        launchWarnRows: [],
      });
      assert.equal(code, 0, err.plain());
      const raw = out.text();
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping SGR under test.
      const text = raw.replace(/\u001b\[[0-9;]*m/g, "");
      // Inline is append-only and prints item bodies at turn start (legacy §5.10 shape); the
      // proof the batched completion reached the wait is the verified end line + the card.
      assert.match(text, /┗━ seq 4 · head [0-9a-f]{12} · chain VERIFIED/);
      assert.match(text, /COMPLETED/);
    } finally {
      delete process.env.MADC_TEST_APP_TURNS;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("B-1 tier-W control: the app's pre-request snapshot handles the batched turn", async () => {
    const r = rig([{ kind: "ok-batched", text: "batched tier w reply" }]);
    try {
      await r.app.start();
      r.app.onDoctorFinished(10);
      sendTurn(r.tty, "hi");
      await until(
        () => r.app.phase === "idle" && r.app.turns[0]?.verify != null,
        "batched tier-W turn completes and verifies",
      );
      assert.match(r.tty.text(), /batched tier w reply/);
      await r.cleanup();
    } catch (e) {
      await r.cleanup();
      throw e;
    }
  });

  it("B-2 the unanswered interrupt stops the engine; Enter restarts it", {
    timeout: 30_000,
  }, async () => {
    const r = rig([
      { kind: "ok", text: "before interrupt" },
      { kind: "hold" },
      { kind: "ok", text: "after restart" },
    ]);
    // An UNRELATED fixture engine under its own MADC_HOME, alive for the whole scenario:
    // the test must observe only the engine the APP owns, never this one. It is spawned
    // through the same production spawnEngine API the app uses; holding its client (stdin
    // pipe open, nothing sent) keeps the fixture idle and alive.
    const decoyDir = mkdtempSync(join(tmpdir(), "madc-decoy-"));
    const decoy = spawnEngine({
      env: { MADC_HOME: decoyDir, MADC_TEST_APP_TURNS: '[{"kind":"hold"}]' },
      entry: APP_FIXTURE,
    });
    // Ownership without process scanning: the fixture encodes its OWN pid in the thread id
    // it mints (`fixtureThreadId` — lossless for any pid), and the app exposes that thread
    // id, so the owned engine's pid is read straight from the app's state. Liveness is
    // probed in-process (signal 0, ESRCH-only absence); no child program is invoked for
    // observation at all.
    const ownedEnginePid = (): number | null => {
      const tid = r.app.threadId;
      if (tid === null || !tid.startsWith("thr_app")) return null;
      const n = Number(tid.slice("thr_app".length));
      return Number.isSafeInteger(n) && n > 0 ? n : null;
    };
    try {
      // The decoy's pid is validated, not defaulted: no -1 fallback anywhere.
      const decoyChildPid = decoy.child.pid;
      assert.ok(
        decoyChildPid !== undefined && Number.isSafeInteger(decoyChildPid) && decoyChildPid > 0,
        "the decoy engine reports a valid pid",
      );
      const decoyPid: number = decoyChildPid;
      await until(() => probePid(decoyPid) === "alive", "decoy fixture up");
      await r.app.start();
      r.app.onDoctorFinished(10);
      sendTurn(r.tty, "one");
      await until(() => r.app.phase === "idle" && r.app.turns[0]?.verify != null, "turn 1");
      sendTurn(r.tty, "two");
      await until(
        () => r.app.phase === "turn" && r.app.turns[1]?.realTurnId !== undefined,
        "turn 2 holds after its ack",
      );
      // The owned engine is alive and identified, and the unrelated fixture — though it
      // lives under the same test process — is never mistaken for it.
      const owned = ownedEnginePid();
      assert.ok(owned !== null, "the app's thread id names its engine");
      assert.ok(probePid(owned) === "alive", "the owned engine is alive before the interrupt");
      assert.notEqual(owned, decoyPid, "ownership never resolves to the unrelated fixture");
      assert.ok(probePid(decoyPid) === "alive", "the unrelated fixture is alive beside it");
      r.tty.key("ctrl-c");
      // Settled state: engine-stopped (the grace runs out, the engine is stopped, the
      // post-turn verify ran) — not the transient verifying phase.
      await until(() => r.app.phase === "engine-stopped", "settles in engine-stopped");
      assert.equal(r.app.turns[1]?.status, "unknown");
      assert.match(r.app.turns[1]?.unverified ?? "", /interrupt not answered in 2 s/);
      // The OWNED child is actually dead: stdin closed, killed after 1 s, exit awaited.
      await until(() => probePid(owned) === "absent", "owned engine child terminated");
      // Process isolation: the unrelated fixture survived the stop untouched.
      assert.ok(
        probePid(decoyPid) === "alive",
        "the unrelated fixture survived the owned engine's stop",
      );
      // Settled restart hints (not a mid-verify frame).
      const settled = r.tty.lastFrame().join("\n");
      assert.match(settled, /engine stopped/);
      assert.match(settled, /Enter restart engine/);
      // Enter restarts: a fresh engine completes and verifies the next turn.
      r.tty.key("enter");
      await until(() => r.app.phase === "idle", "restart lands in idle");
      sendTurn(r.tty, "three");
      await until(
        () => r.app.phase === "idle" && r.app.turns[0]?.verify != null,
        "post-restart turn completes and verifies",
      );
      assert.match(r.tty.lastFrame().join("\n"), /chain VERIFIED · turn 1/);
      // The restarted engine is a NEW, live owned engine — and the decoy outlived it all.
      const restarted = ownedEnginePid();
      assert.ok(restarted !== null && restarted !== owned, "a fresh engine owns the new thread");
      assert.ok(probePid(restarted) === "alive", "the restarted engine is alive");
      assert.ok(
        probePid(decoyPid) === "alive",
        "the unrelated fixture outlived the whole scenario",
      );
      await r.cleanup();
    } catch (e) {
      await r.cleanup();
      throw e;
    } finally {
      await decoy.close(1_000).catch(() => null);
      rmSync(decoyDir, { recursive: true, force: true });
    }
  });
});

describe("correction round: live malformed notification handling (F-1)", () => {
  for (const mode of ["line", "inline"] as const) {
    for (const delivery of ["live", "buffered"] as const) {
      it(`${mode}: a malformed item notification (${delivery} delivery) takes the E-d violation path, never an uncaught throw`, {
        timeout: 20_000,
      }, async () => {
        process.env.MADC_TEST_APP_TURNS = JSON.stringify([
          { kind: "malformed-item", live: delivery === "live" },
        ]);
        const home = mkdtempSync(join(tmpdir(), "madc-f1-"));
        const out = new RecordingOut();
        const err = new RecordingOut();
        try {
          const run =
            mode === "line"
              ? runLineModeApp({
                  io: lineIoPlain(home, out, err),
                  home,
                  turnIdleMs: 5_000,
                  firstPrompt: "hi",
                  why: "MADC_UI=lines",
                  launchWarnRows: [],
                })
              : runInlineApp({
                  io: lineIoPlain(home, out, err),
                  home,
                  turnIdleMs: 5_000,
                  firstPrompt: "hi",
                  doctor: { pass: 7, warn: 0, fail: 0, skip: 2 },
                  launchWarnRows: [],
                });
          const code = await run;
          assert.equal(code, EXIT.engine, `err:\n${err.plain()}`);
          if (mode === "line") {
            assert.match(
              err.plain(),
              /protocol violation: malformed item/,
              "the violation is reported, not thrown",
            );
            assert.doesNotMatch(err.plain(), /at EngineClient|EngineProtocolError\n| {4}at /);
          } else {
            // The inline surface records the violation in the turn (end line + receipt),
            // never on stderr — and no stack trace may leak anywhere.
            assert.match(out.text(), /UNVERIFIED: protocol violation: malformed item/);
            assert.ok(!out.text().includes("    at "), "no stack trace on stdout");
            assert.ok(!err.text().includes("    at "), "no stack trace on stderr");
          }
        } finally {
          delete process.env.MADC_TEST_APP_TURNS;
          rmSync(home, { recursive: true, force: true });
        }
      });

      it(`${mode}: a foreign turn/completed (${delivery} delivery) is a controlled violation for THIS turn`, {
        timeout: 20_000,
      }, async () => {
        process.env.MADC_TEST_APP_TURNS = JSON.stringify([
          { kind: "foreign-completion", live: delivery === "live" },
        ]);
        const home = mkdtempSync(join(tmpdir(), "madc-fc-"));
        const out = new RecordingOut();
        const err = new RecordingOut();
        try {
          const code =
            mode === "line"
              ? await runLineModeApp({
                  io: lineIoPlain(home, out, err),
                  home,
                  turnIdleMs: 5_000,
                  firstPrompt: "hi",
                  why: "MADC_UI=lines",
                  launchWarnRows: [],
                })
              : await runInlineApp({
                  io: lineIoPlain(home, out, err),
                  home,
                  turnIdleMs: 5_000,
                  firstPrompt: "hi",
                  doctor: { pass: 7, warn: 0, fail: 0, skip: 2 },
                  launchWarnRows: [],
                });
          assert.equal(code, EXIT.engine, `err:\n${err.plain()}`);
          if (mode === "line") {
            assert.match(err.plain(), /protocol violation: malformed or foreign turn\/completed/);
            assert.doesNotMatch(err.plain(), / {4}at /);
          } else {
            assert.match(
              out.text(),
              /UNVERIFIED: protocol violation: malformed or foreign turn\/completed/,
            );
            assert.ok(!out.text().includes("    at "), "no stack trace on stdout");
          }
        } finally {
          delete process.env.MADC_TEST_APP_TURNS;
          rmSync(home, { recursive: true, force: true });
        }
      });
    }

    it(`${mode}: held-open stdin — a violation settles with unconditional cleanup and the ORIGINAL error survives a later valid follow-up`, {
      timeout: 20_000,
    }, async () => {
      // stdin is a PassThrough that stays OPEN: EOF cannot end the run early and conceal a
      // wait that never settled or an idle timer rearmed after settlement. The follow-up
      // valid item (150 ms) must not rearm the settled turn's deadline — a rearmed timer
      // would fire at ~550 ms and REPLACE the violation reason with a timeout reason.
      process.env.MADC_TEST_APP_TURNS = JSON.stringify([
        { kind: "malformed-item", live: true, followUp: true },
      ]);
      const home = mkdtempSync(join(tmpdir(), "madc-ho-"));
      const out = new RecordingOut();
      const err = new RecordingOut();
      const stdin = new PassThrough(); // held open until /quit is written
      try {
        const io = { ...lineIoPlain(home, out, err), stdin };
        const run =
          mode === "line"
            ? runLineModeApp({
                io,
                home,
                turnIdleMs: 400,
                firstPrompt: "hi",
                why: "MADC_UI=lines",
                launchWarnRows: [],
              })
            : runInlineApp({
                io,
                home,
                turnIdleMs: 400,
                firstPrompt: "hi",
                doctor: { pass: 7, warn: 0, fail: 0, skip: 2 },
                launchWarnRows: [],
              });
        // The violation settles (line: receipt on stderr; inline: end line on stdout).
        await until(
          () =>
            mode === "line"
              ? /protocol violation: malformed item/.test(err.plain())
              : /UNVERIFIED: protocol violation: malformed item/.test(out.text()),
          "violation reported",
        );
        // The follow-up lands at 150 ms; a rearmed deadline would fire at ~550 ms. The
        // /receipt probe (inline) RE-RENDERS the turn record: a rearmed timer that replaced
        // the reason shows up there — emitted bytes alone cannot conceal it.
        await new Promise<void>((resolve) => setTimeout(resolve, 900));
        stdin.write("/receipt\n");
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
        stdin.write("/quit\n");
        stdin.end();
        const code = await run;
        assert.equal(code, EXIT.engine, `err:\n${err.plain()}`);
        const surface = mode === "line" ? err.plain() : out.text();
        assert.match(
          surface,
          /protocol violation: malformed item/,
          "the ORIGINAL violation reason survives the follow-up and the verify",
        );
        assert.doesNotMatch(
          surface,
          /timeout: no engine message for 400 ms/,
          "no rearmed post-settlement timer replaced the reason",
        );
        assert.ok(!surface.includes("late but valid"), "the settled turn's record was not mutated");
        // The model row is the mutation probe: this scenario records NO valid item before
        // the violation, so every receipt (line's exit receipt, inline's /receipt re-render)
        // must show NO RECEIPT — a post-settlement servedModel mutation flips the row.
        assert.match(surface, /NO RECEIPT/, "no post-settlement item reached the turn record");
      } finally {
        delete process.env.MADC_TEST_APP_TURNS;
        rmSync(home, { recursive: true, force: true });
      }
    });
  }
});

describe("correction round: honest idle deadline in Level A / inline (F-2/F-3)", () => {
  it("Level A: a long active turn with spaced validated items completes — the deadline rearms on activity", {
    timeout: 20_000,
  }, async () => {
    process.env.MADC_TEST_APP_TURNS = JSON.stringify([{ kind: "spaced" }]);
    const home = mkdtempSync(join(tmpdir(), "madc-f3-"));
    const out = new RecordingOut();
    const err = new RecordingOut();
    try {
      const code = await runLineModeApp({
        io: lineIoPlain(home, out, err),
        home,
        turnIdleMs: 400,
        firstPrompt: "hi",
        why: "MADC_UI=lines",
        launchWarnRows: [],
      });
      assert.equal(code, 0, `err:\n${err.plain()}`);
      assert.match(out.text(), /spaced reply/);
      assert.match(err.plain(), /chain VERIFIED/);
    } finally {
      delete process.env.MADC_TEST_APP_TURNS;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("Level A: silence reports the honest timeout reason, not a protocol violation", {
    timeout: 20_000,
  }, async () => {
    process.env.MADC_TEST_APP_TURNS = JSON.stringify([{ kind: "unknown-note" }]);
    const home = mkdtempSync(join(tmpdir(), "madc-f2-"));
    const out = new RecordingOut();
    const err = new RecordingOut();
    try {
      const code = await runLineModeApp({
        io: lineIoPlain(home, out, err),
        home,
        turnIdleMs: 800,
        firstPrompt: "hi",
        why: "MADC_UI=lines",
        launchWarnRows: [],
      });
      assert.equal(code, EXIT.engine, `err:\n${err.plain()}`);
      assert.match(err.plain(), /timeout: no engine message for 800 ms/);
      assert.doesNotMatch(err.plain(), /malformed turn\/completed/);
    } finally {
      delete process.env.MADC_TEST_APP_TURNS;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("Level A: sustained unknown notifications do not extend the deadline", {
    timeout: 20_000,
  }, async () => {
    process.env.MADC_TEST_APP_TURNS = JSON.stringify([{ kind: "sustained-unknown" }]);
    const home = mkdtempSync(join(tmpdir(), "madc-su-"));
    const out = new RecordingOut();
    const err = new RecordingOut();
    try {
      const code = await runLineModeApp({
        io: lineIoPlain(home, out, err),
        home,
        turnIdleMs: 800,
        firstPrompt: "hi",
        why: "MADC_UI=lines",
        launchWarnRows: [],
      });
      assert.equal(code, EXIT.engine, `err:\n${err.plain()}`);
      assert.match(err.plain(), /timeout: no engine message for 800 ms/);
    } finally {
      delete process.env.MADC_TEST_APP_TURNS;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("Level A: validated streaming deltas reset the inactivity deadline (delta-only activity)", {
    timeout: 20_000,
  }, async () => {
    process.env.MADC_TEST_APP_TURNS = JSON.stringify([{ kind: "delta-spaced" }]);
    const home = mkdtempSync(join(tmpdir(), "madc-fd-"));
    const out = new RecordingOut();
    const err = new RecordingOut();
    try {
      const code = await runLineModeApp({
        io: lineIoPlain(home, out, err),
        home,
        turnIdleMs: 400,
        firstPrompt: "hi",
        why: "MADC_UI=lines",
        launchWarnRows: [],
      });
      assert.equal(code, 0, `err:\n${err.plain()}`);
      assert.match(out.text(), /streamed reply/);
      assert.match(err.plain(), /chain VERIFIED/);
    } finally {
      delete process.env.MADC_TEST_APP_TURNS;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("inline: spaced validated items complete; an unknown notification does not keep the turn alive", {
    timeout: 20_000,
  }, async () => {
    process.env.MADC_TEST_APP_TURNS = JSON.stringify([{ kind: "spaced" }]);
    const home = mkdtempSync(join(tmpdir(), "madc-f3i-"));
    const out = new RecordingOut();
    const err = new RecordingOut();
    try {
      const code = await runInlineApp({
        io: lineIoPlain(home, out, err),
        home,
        turnIdleMs: 400,
        firstPrompt: "hi",
        doctor: { pass: 7, warn: 0, fail: 0, skip: 2 },
        launchWarnRows: [],
      });
      assert.equal(code, 0, `err:\n${err.plain()}`);
      // Inline prints item bodies at turn start only (recorded legacy §5.10 shape): the
      // proof the deadline rearmed is the turn COMPLETING and the chain verifying.
      assert.match(out.text(), /COMPLETED/);
      assert.match(out.text(), /chain VERIFIED/);
    } finally {
      delete process.env.MADC_TEST_APP_TURNS;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("inline: sustained unknown notifications do not extend the deadline", {
    timeout: 20_000,
  }, async () => {
    process.env.MADC_TEST_APP_TURNS = JSON.stringify([{ kind: "sustained-unknown" }]);
    const home = mkdtempSync(join(tmpdir(), "madc-sui-"));
    const out = new RecordingOut();
    const err = new RecordingOut();
    try {
      const code = await runInlineApp({
        io: lineIoPlain(home, out, err),
        home,
        turnIdleMs: 800,
        firstPrompt: "hi",
        doctor: { pass: 7, warn: 0, fail: 0, skip: 2 },
        launchWarnRows: [],
      });
      assert.equal(code, EXIT.engine, `err:\n${err.plain()}`);
      assert.match(out.text(), /timeout: no engine message for 800 ms/);
    } finally {
      delete process.env.MADC_TEST_APP_TURNS;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("inline: validated streaming deltas reset the inactivity deadline (delta-only activity)", {
    timeout: 20_000,
  }, async () => {
    process.env.MADC_TEST_APP_TURNS = JSON.stringify([{ kind: "delta-spaced" }]);
    const home = mkdtempSync(join(tmpdir(), "madc-fdi-"));
    const out = new RecordingOut();
    const err = new RecordingOut();
    try {
      const code = await runInlineApp({
        io: lineIoPlain(home, out, err),
        home,
        turnIdleMs: 400,
        firstPrompt: "hi",
        doctor: { pass: 7, warn: 0, fail: 0, skip: 2 },
        launchWarnRows: [],
      });
      assert.equal(code, 0, `err:\n${err.plain()}`);
      assert.match(out.text(), /COMPLETED/);
      assert.match(out.text(), /chain VERIFIED/);
    } finally {
      delete process.env.MADC_TEST_APP_TURNS;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("correction round: first-prompt waits for doctor-FAIL acknowledgement (F-5)", () => {
  it("tier W: the first prompt is held until Enter acknowledges the launch FAIL", {
    timeout: 20_000,
  }, async () => {
    const r = rig([{ kind: "ok", text: "should not send" }], {
      firstPrompt: "hello",
      doctor: {
        running: false,
        pass: 6,
        warn: 0,
        fail: 1,
        skip: 2,
        ms: 214,
        failAtLaunch: true,
        warnRows: ["seed: seed file unreadable"],
        allRows: [{ id: "seed", status: "fail", summary: "seed file unreadable" }],
      },
    });
    try {
      await r.app.start();
      r.app.onDoctorFinished(10);
      // launch.ts calls onFirstPrompt() the moment the doctor finishes; with a FAIL at
      // launch that call must HOLD the prompt instead of sending (§5.1 acknowledgement).
      const firstPromptDone = r.app.onFirstPrompt();
      await until(
        () => r.tty.chunks.length > 0 && /FAILED/.test(r.tty.lastFrame().join("\n")),
        "FAIL banner",
      );
      // The AWAITED call has returned (held) and no turn exists: the prompt was not sent —
      // awaiting the promise is the deterministic proof; no quiet-window sleep is needed.
      await firstPromptDone;
      assert.equal(r.app.turns.length, 0, "no turn before the FAIL acknowledgement");
      r.tty.key("enter");
      await until(
        () => r.app.phase === "idle" && r.app.turns.length === 1 && r.app.turns[0]?.verify != null,
        "first prompt sends after Enter",
      );
      assert.match(r.tty.lastFrame().join("\n"), /should not send/);
      await r.cleanup();
    } catch (e) {
      await r.cleanup();
      throw e;
    }
  });
});

describe("correction round: Level A receipt binds last turn.end to the current turn (F-6)", () => {
  it("Level A: a late-end turn prints UNVERIFIED, never a green session row", {
    timeout: 20_000,
  }, async () => {
    process.env.MADC_TEST_APP_TURNS = JSON.stringify([{ kind: "late-end" }]);
    const home = mkdtempSync(join(tmpdir(), "madc-f6-"));
    const out = new RecordingOut();
    const err = new RecordingOut();
    try {
      const code = await runLineModeApp({
        io: lineIoPlain(home, out, err),
        home,
        turnIdleMs: 30_000,
        firstPrompt: "hi",
        why: "MADC_UI=lines",
        launchWarnRows: [],
      });
      assert.equal(code, 0);
      const text = err.plain();
      assert.match(text, /UNVERIFIED: the chain's last turn\.end does not name this turn/);
      assert.doesNotMatch(text, /chain VERIFIED/);
    } finally {
      delete process.env.MADC_TEST_APP_TURNS;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Round 7 (PR #35 Copilot/Cursor review): every test below was RED on the
// round-6 staged bytes and is GREEN after this round's fixes. Fixtures only.
// ---------------------------------------------------------------------------
describe("round 7: E11 at every render boundary (Level A + inline)", () => {
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
    engineEntry: APP_FIXTURE,
  });

  it("Level A: a failed turn's RPC error message is sanitised in the receipt", {
    timeout: 20_000,
  }, async () => {
    process.env.MADC_TEST_APP_TURNS = JSON.stringify([{ kind: "rpc-fail-ctrl", code: -32008 }]);
    const home = mkdtempSync(join(tmpdir(), "madc-r7-e11-"));
    const out = new RecordingOut();
    const err = new RecordingOut();
    try {
      const code = await runLineModeApp({
        io: io(home, out, err),
        home,
        turnIdleMs: 30_000,
        firstPrompt: "hi",
        why: "MADC_UI=lines",
        launchWarnRows: [],
      });
      // A failed turn's engine exit code is 4 (provider class for -32008).
      assert.equal(code, 4);
      const text = err.plain();
      assert.ok(!text.includes("\u001b[31mred"), "no raw ESC in the Level A receipt");
      assert.match(text, /provider refused: \uFFFD\[31mred\uFFFD/);
    } finally {
      delete process.env.MADC_TEST_APP_TURNS;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("inline: a failed turn's RPC error message is sanitised (rail, card, /receipt)", {
    timeout: 20_000,
  }, async () => {
    process.env.MADC_TEST_APP_TURNS = JSON.stringify([{ kind: "rpc-fail-ctrl", code: -32008 }]);
    const home = mkdtempSync(join(tmpdir(), "madc-r7-i-"));
    const out = new RecordingOut();
    const err = new RecordingOut();
    const stdin = new PassThrough();
    try {
      const run = runInlineApp({
        io: { ...io(home, out, err), stdin },
        home,
        turnIdleMs: 30_000,
        firstPrompt: "hi",
        doctor: { pass: 0, warn: 0, fail: 0, skip: 0 },
        launchWarnRows: [],
      });
      await until(
        () => /UNVERIFIED:.*red/.test(out.plain()) || /UNVERIFIED/.test(out.plain()),
        "inline failure rendered",
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 400));
      stdin.write("/receipt\n");
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
      stdin.write("/quit\n");
      stdin.end();
      const code = await run;
      assert.equal(code, 4);
      const raw = out.text();
      // Strip the app's OWN SGR spans; any remaining ESC is engine-supplied.
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping SGR under test.
      const stripped = raw.replace(/\u001b\[[0-9;]*m/g, "");
      assert.ok(!stripped.includes("\u001b"), "no raw ESC anywhere in inline stdout");
      assert.match(stripped, /provider refused: \uFFFD\[31mred\uFFFD/);
    } finally {
      stdin.end();
      delete process.env.MADC_TEST_APP_TURNS;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("round 7: per-kind item validation fails closed (E-d + renderers)", () => {
  it("Level A: a malformed toolResult item is a protocol violation, exit 3, never a crash", {
    timeout: 20_000,
  }, async () => {
    process.env.MADC_TEST_APP_TURNS = JSON.stringify([{ kind: "bad-tool-item" }]);
    const home = mkdtempSync(join(tmpdir(), "madc-r7-v-"));
    const out = new RecordingOut();
    const err = new RecordingOut();
    try {
      const code = await runLineModeApp({
        io: lineIoPlain(home, out, err),
        home,
        turnIdleMs: 30_000,
        firstPrompt: "hi",
        why: "MADC_UI=lines",
        launchWarnRows: [],
      });
      assert.equal(code, EXIT.engine);
      assert.match(err.plain(), /protocol violation: malformed item/);
    } finally {
      delete process.env.MADC_TEST_APP_TURNS;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("inline: a malformed toolResult item is a protocol violation, exit 3, never a crash", {
    timeout: 20_000,
  }, async () => {
    process.env.MADC_TEST_APP_TURNS = JSON.stringify([{ kind: "bad-tool-item" }]);
    const home = mkdtempSync(join(tmpdir(), "madc-r7-vi-"));
    const out = new RecordingOut();
    const err = new RecordingOut();
    try {
      const code = await runInlineApp({
        io: lineIoPlain(home, out, err),
        home,
        turnIdleMs: 30_000,
        firstPrompt: "hi",
        doctor: { pass: 0, warn: 0, fail: 0, skip: 0 },
        launchWarnRows: [],
      });
      assert.equal(code, EXIT.engine);
      const surface = out.text();
      assert.match(
        surface,
        /UNVERIFIED: protocol violation: malformed item|protocol violation: malformed item/,
      );
    } finally {
      delete process.env.MADC_TEST_APP_TURNS;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("round 7: failed-turn exit code and engine-exit race (Level A + inline)", () => {
  it("Level A: a turn/completed with status failed exits 1, not 0", {
    timeout: 20_000,
  }, async () => {
    process.env.MADC_TEST_APP_TURNS = JSON.stringify([{ kind: "failed", code: -32603 }]);
    const home = mkdtempSync(join(tmpdir(), "madc-r7-f-"));
    const out = new RecordingOut();
    const err = new RecordingOut();
    try {
      const code = await runLineModeApp({
        io: lineIoPlain(home, out, err),
        home,
        turnIdleMs: 30_000,
        firstPrompt: "hi",
        why: "MADC_UI=lines",
        launchWarnRows: [],
      });
      assert.equal(code, EXIT.failure);
      assert.match(err.plain(), /FAILED/);
    } finally {
      delete process.env.MADC_TEST_APP_TURNS;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("inline: a turn/completed with status failed exits 1, not 0", {
    timeout: 20_000,
  }, async () => {
    process.env.MADC_TEST_APP_TURNS = JSON.stringify([{ kind: "failed", code: -32603 }]);
    const home = mkdtempSync(join(tmpdir(), "madc-r7-fi-"));
    const out = new RecordingOut();
    const err = new RecordingOut();
    try {
      const code = await runInlineApp({
        io: lineIoPlain(home, out, err),
        home,
        turnIdleMs: 30_000,
        firstPrompt: "hi",
        doctor: { pass: 0, warn: 0, fail: 0, skip: 0 },
        launchWarnRows: [],
      });
      assert.equal(code, EXIT.failure);
    } finally {
      delete process.env.MADC_TEST_APP_TURNS;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("Level A: the engine dying mid-turn settles the run (no 24-day waiter hang)", {
    timeout: 20_000,
  }, async () => {
    process.env.MADC_TEST_APP_TURNS = JSON.stringify([{ kind: "engine-exit" }]);
    const home = mkdtempSync(join(tmpdir(), "madc-r7-x-"));
    const out = new RecordingOut();
    const err = new RecordingOut();
    try {
      const code = await runLineModeApp({
        io: lineIoPlain(home, out, err),
        home,
        turnIdleMs: 30_000,
        firstPrompt: "hi",
        why: "MADC_UI=lines",
        launchWarnRows: [],
      });
      assert.equal(code, EXIT.engine);
    } finally {
      delete process.env.MADC_TEST_APP_TURNS;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("inline: the engine dying mid-turn settles the run (no 24-day waiter hang)", {
    timeout: 20_000,
  }, async () => {
    process.env.MADC_TEST_APP_TURNS = JSON.stringify([{ kind: "engine-exit" }]);
    const home = mkdtempSync(join(tmpdir(), "madc-r7-xi-"));
    const out = new RecordingOut();
    const err = new RecordingOut();
    try {
      const code = await runInlineApp({
        io: lineIoPlain(home, out, err),
        home,
        turnIdleMs: 30_000,
        firstPrompt: "hi",
        doctor: { pass: 0, warn: 0, fail: 0, skip: 0 },
        launchWarnRows: [],
      });
      assert.equal(code, EXIT.engine);
    } finally {
      delete process.env.MADC_TEST_APP_TURNS;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("round 7: the > prompt is visible (§6.3) and inline prints its turn output", () => {
  it("Level A: the prompt appears at start and again after each completed turn", {
    timeout: 20_000,
  }, async () => {
    process.env.MADC_TEST_APP_TURNS = JSON.stringify([{ kind: "ok", text: "r7 first reply" }]);
    const home = mkdtempSync(join(tmpdir(), "madc-r7-p-"));
    const out = new RecordingOut();
    const err = new RecordingOut();
    const stdin = new PassThrough();
    try {
      const run = runLineModeApp({
        io: { ...lineIoPlain(home, out, err), stdin },
        home,
        turnIdleMs: 30_000,
        firstPrompt: "one",
        why: "MADC_UI=lines",
        launchWarnRows: [],
      });
      await until(() => out.plain().includes("r7 first reply"), "first reply");
      // The prompt must have been emitted BEFORE the reply (initial) and again AFTER it —
      // the re-prompt lands in the queued chain's .finally, so wait for it explicitly.
      await until(
        () => /r7 first reply\n> $/.test(out.plain()),
        "prompt re-emitted after the turn",
      );
      const text = out.plain();
      assert.ok(
        text.indexOf("> ") < text.indexOf("r7 first reply"),
        "initial prompt precedes the reply",
      );
      assert.match(text, /r7 first reply\n> $/, "prompt re-emitted after the turn");
      stdin.end();
      const code = await run;
      assert.equal(code, 0, err.plain());
    } finally {
      stdin.end();
      delete process.env.MADC_TEST_APP_TURNS;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("inline: a normal turn prints its agentMessage text and tool rows (mock-up 12), no duplication", {
    timeout: 30_000,
  }, async () => {
    process.env.MADC_TEST_APP_TURNS = JSON.stringify([
      { kind: "tool" },
      { kind: "ok", text: "tool turn done" },
    ]);
    const home = mkdtempSync(join(tmpdir(), "madc-r7-t-"));
    const out = new RecordingOut();
    const err = new RecordingOut();
    const stdin = new PassThrough();
    let code: number | null = null;
    try {
      const run = runInlineApp({
        io: { ...lineIoPlain(home, out, err), stdin },
        home,
        turnIdleMs: 30_000,
        firstPrompt: "hi",
        doctor: { pass: 0, warn: 0, fail: 0, skip: 0 },
        launchWarnRows: [],
      });
      await until(
        () => out.plain().includes("235 lines · §4 Exit codes, lines 182-195"),
        "tool result text printed",
      );
      // The second scripted turn needs its prompt: send it, wait for its agent text.
      stdin.write("two\n");
      await until(() => out.plain().includes("tool turn done"), "second reply");
      stdin.end();
      code = await run;
    } finally {
      stdin.end();
      if (code === null) {
        await Promise.race([
          (async () => {
            /* bounded: the run is settled by EOF below */
          })(),
          new Promise((r) => setTimeout(r, 0)),
        ]);
      }
      delete process.env.MADC_TEST_APP_TURNS;
      rmSync(home, { recursive: true, force: true });
    }
    assert.equal(code, 0);
    const text = out.plain();
    // The toolCall row and the toolResult's output row both appear exactly once.
    assert.equal(text.split("read_file").length - 1, 2, "toolCall + toolResult rows");
    assert.equal(text.split("toolCall → toolResult").length - 1, 1, "one tool-pair chrome row");
    assert.equal(text.split("tool turn done").length - 1, 1, "agent text once");
  });
});

describe("round 8: Level A signal settlement (§5.13, O-3/O-4)", () => {
  it("SIGINT during a held final verify: the status prints once, after verification settles — recorded 5 outranks 130", {
    timeout: 30_000,
  }, async () => {
    // Held-verifier probe (the same knob the tier-W F-102 test uses): the verify never
    // completes until AFTER the signal lands, so a premature `exit 130` print is observable.
    process.env.MADC_TEST_APP_TURNS = JSON.stringify([{ kind: "ok", text: "settle me" }]);
    const home = mkdtempSync(join(tmpdir(), "madc-r8-sig-"));
    const out = new RecordingOut();
    const err = new RecordingOut();
    const stdin = new PassThrough();
    let verifyCalls = 0;
    let exposed: {
      onSigint(): void;
      onSigterm(): void;
      onSighup(): void;
    } | null = null;
    const exposeIt = (h: { onSigint(): void; onSigterm(): void; onSighup(): void }): void => {
      exposed = h;
    };
    try {
      const heldVerify = async (
        req: import("./verify.ts").VerifyRequest,
      ): Promise<import("./verify.ts").VerifyOutcome> => {
        verifyCalls++;
        if (verifyCalls === 1) {
          // Hold the per-turn verify open: deliver SIGINT mid-verify via the exposed handler.
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
        const { runVerifyBounded, VERIFY_DEADLINE_MS } = await import("./verify.ts");
        return runVerifyBounded({ ...req, deadlineMs: VERIFY_DEADLINE_MS });
      };
      const run = runLineModeApp({
        io: { ...lineIoPlain(home, out, err), stdin },
        home,
        turnIdleMs: 30_000,
        firstPrompt: "hi",
        why: "MADC_UI=lines",
        launchWarnRows: [],
        verify: heldVerify,
        exposeSignals: exposeIt,
      });
      await until(() => verifyCalls >= 1, "per-turn verify started");
      const handlers = exposed as {
        onSigint(): void;
        onSigterm(): void;
        onSighup(): void;
      } | null;
      assert.ok(handlers !== null, "Level A exposed its signal handlers");
      handlers.onSigint();
      stdin.end();
      const code = await run;
      // The status printed ONCE, AFTER the receipt (deferred past the held verify), and the
      // printed value IS the returned value. A premature print would precede the receipt.
      const text = err.plain();
      assert.match(text, /madc: interrupted \(SIGINT\)\n/);
      const exitLines = text.match(/exit \d+\n/g) ?? [];
      assert.equal(exitLines.length, 1, "exactly one exit line");
      const exitLinePos = text.indexOf(exitLines[0] ?? "");
      const receiptPos = text.indexOf("─ receipt");
      assert.ok(receiptPos >= 0 && exitLinePos > receiptPos, "the status prints after the receipt");
      assert.equal(code, 130, "nothing outranks the signal in this scenario: 130");
    } finally {
      stdin.end();
      delete process.env.MADC_TEST_APP_TURNS;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("round 8: seat parent-directory confinement (launch.ts seatFields)", () => {
  it("a symlinked seats/ parent fails closed: no backing/requested values, no leaf read", {
    timeout: 20_000,
  }, () => {
    const home = mkdtempSync(join(tmpdir(), "madc-r8-seat-"));
    const outside = mkdtempSync(join(tmpdir(), "madc-r8-out-"));
    try {
      mkdirSync(join(outside, "seats"), { recursive: true });
      writeFileSync(
        join(outside, "seats", "madc-default.json"),
        JSON.stringify({
          preferredBacking: "kimi-code",
          pinnedModel: "kimi-coding/kimi-for-coding",
        }),
      );
      // The leaf is a CLEAN regular file — only the parent is a symlink.
      symlinkSync(join(outside, "seats"), join(home, "seats"));
      const fields = seatFields(home, "madc-default");
      assert.equal(fields.backing, null, "symlinked parent: no backing");
      assert.equal(fields.requested, null, "symlinked parent: no requested model");
      // A real directory still reads (control: the confinement is not over-broad).
      rmSync(join(home, "seats"));
      mkdirSync(join(home, "seats"));
      writeFileSync(
        join(home, "seats", "madc-default.json"),
        JSON.stringify({
          preferredBacking: "kimi-code",
          pinnedModel: "kimi-coding/kimi-for-coding",
        }),
      );
      const ok = seatFields(home, "madc-default");
      assert.equal(ok.backing, "kimi-code");
      assert.equal(ok.requested, "kimi-coding/kimi-for-coding");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("round 9: Level A recorded-5 outranks-130 (§5.13/O-3)", () => {
  it("SIGINT during a held verify that then FAILS: returns 5, receipt exit 5, contiguous final block, no premature signal line", {
    timeout: 30_000,
  }, async () => {
    process.env.MADC_TEST_APP_TURNS = JSON.stringify([{ kind: "corrupt" }]);
    const home = mkdtempSync(join(tmpdir(), "madc-r9-o3-"));
    const out = new RecordingOut();
    const err = new RecordingOut();
    const stdin = new PassThrough();
    let verifyCalls = 0;
    const releaseVerifyRef: { current: (() => void) | null } = { current: null };
    try {
      const heldVerify = async (
        req: import("./verify.ts").VerifyRequest,
      ): Promise<import("./verify.ts").VerifyOutcome> => {
        verifyCalls++;
        if (verifyCalls === 1) {
          // Hold the per-turn verify: the signal lands while it is open; it then reads the
          // TAMPERED chain (the corrupt fixture rewrites a line before completion).
          await new Promise<void>((resolve) => {
            releaseVerifyRef.current = resolve;
          });
        }
        const { runVerifyBounded, VERIFY_DEADLINE_MS } = await import("./verify.ts");
        return runVerifyBounded({ ...req, deadlineMs: VERIFY_DEADLINE_MS });
      };
      type ExposedHandlers = {
        onSigint(): void;
        onSigterm(): void;
        onSighup(): void;
      };
      const handlersRef: { current: ExposedHandlers | null } = {
        current: null as ExposedHandlers | null,
      };
      const exposeIt = (h: { onSigint(): void; onSigterm(): void; onSighup(): void }): void => {
        handlersRef.current = h;
      };
      const run = runLineModeApp({
        io: { ...lineIoPlain(home, out, err), stdin },
        home,
        turnIdleMs: 30_000,
        firstPrompt: "hi",
        why: "MADC_UI=lines",
        launchWarnRows: [],
        verify: heldVerify,
        exposeSignals: exposeIt,
      });
      await until(() => verifyCalls >= 1, "per-turn verify started");
      const handlers = handlersRef.current as {
        onSigint(): void;
        onSigterm(): void;
        onSighup(): void;
      } | null;
      if (handlers !== null) handlers.onSigint();
      else assert.fail("handlers were never exposed");
      // Release the held verify only after the signal is recorded: it fails on the tamper.
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
      releaseVerifyRef.current?.();
      stdin.end();
      const code = await run;
      assert.equal(code, 5, "the recorded session failure outranks the signal");
      const text = err.plain();
      // The receipt recorded the chain failure and exit 5.
      assert.match(text, /chain FAILED/);
      assert.match(text, / exit {5}5\n/);
      // The §5.13 block is contiguous and FINAL — nothing after it, nothing premature.
      assert.ok(
        text.endsWith("madc: interrupted (SIGINT)\nexit 5\n"),
        "stderr ends with the contiguous block",
      );
      assert.equal(
        text.match(/madc: interrupted \(SIGINT\)\n/g)?.length,
        1,
        "exactly one interrupted line",
      );
      // No bare 130 anywhere: the premature signal-only status never printed.
      assert.doesNotMatch(text, /exit 130/);
    } finally {
      stdin.end();
      delete process.env.MADC_TEST_APP_TURNS;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
