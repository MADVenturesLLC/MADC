/**
 * M1-A8 `madc -s <seatId>` on the interactive entry: the Witness app (tier W), its line mode
 * (tier A), the launch path that picks between them, and `main()`'s routing all open their
 * thread on the selected seat — the seat the app shows is the seat it asks the engine for and the
 * only seat it accepts a thread on. The app-fixture engine answers on the requested seat and
 * records it as the session envelope's `seatId`, so each test reads the selection back from disk.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { CliIO } from "../io.ts";
import { main } from "../main.ts";
import { RecordingOut, VirtualTty } from "../testing/virtual-tty.ts";
import { type KeyValue, WitnessApp } from "./app.ts";
import type { BannerData } from "./frames.ts";
import { runWitnessApp } from "./launch.ts";
import { runLineModeApp } from "./line-mode.ts";

const APP_FIXTURE = fileURLToPath(new URL("../testing/app-fixture.ts", import.meta.url));

/** The envelope `seatId` of every line of the one session file the fixture wrote. */
function sessionSeats(home: string): string[] {
  const dir = join(home, "sessions");
  const files = readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
  assert.equal(files.length, 1, "one session file");
  return readFileSync(join(dir, files[0] ?? ""), "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => (JSON.parse(l) as { seatId: string }).seatId);
}

async function until(cond: () => boolean, what: string, deadlineMs = 15_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > deadlineMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setImmediate(r));
  }
}

function lineIo(home: string, stdout: RecordingOut, stderr: RecordingOut): CliIO {
  return {
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
  };
}

function bannerFor(home: string, seatId: string): BannerData {
  return {
    version: "0.0.0",
    protocol: "madc-m1/1",
    seatId,
    seatSha: null,
    backing: "claude-code",
    backingLane: "allowed-via-vendor-agent",
    requested: null,
    served: null,
    home,
    homeSource: "env",
    userHome: "/home/mike",
    cwd: home,
    threadId: null,
    doctor: {
      running: false,
      pass: 1,
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
  };
}

describe("M1-A8 madc -s <seatId> on the interactive entry", () => {
  it("tier W: the app opens its thread on the banner's seat and the session records it", async () => {
    const home = mkdtempSync(join(tmpdir(), "madc-a8-seat-w-"));
    process.env.MADC_TEST_APP_TURNS = JSON.stringify([{ kind: "ok", text: "on daedalus" }]);
    const tty = new VirtualTty(110, 32);
    const app = new WitnessApp(tty, {
      io: lineIo(home, new RecordingOut(), new RecordingOut()),
      home,
      turnIdleMs: 600_000,
      firstPrompt: null,
      banner: bannerFor(home, "daedalus"),
    });
    tty.onKey((k) => app.onKey(k));
    try {
      await app.start();
      app.onDoctorFinished(1);
      for (const ch of "hi") tty.key({ char: ch } as KeyValue);
      tty.key("enter");
      await until(
        () => app.phase === "idle" && app.turns.length === 1 && app.turns[0]?.verify != null,
        "turn on daedalus + verify",
      );
      // The thread came back on the requested seat (isThreadShape refuses any other seat).
      assert.ok(app.threadId !== null, "thread started");
      assert.ok(
        sessionSeats(home).every((s) => s === "daedalus"),
        "the engine was asked for daedalus",
      );
      assert.match(tty.lastFrame().join("\n"), /seat {2}daedalus/);
    } finally {
      await app.dispose();
      delete process.env.MADC_TEST_APP_TURNS;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("line mode: the header names the seat and thread/start asks for it", async () => {
    const home = mkdtempSync(join(tmpdir(), "madc-a8-seat-a-"));
    process.env.MADC_TEST_APP_TURNS = JSON.stringify([{ kind: "ok", text: "on hephaestus" }]);
    const out = new RecordingOut();
    const err = new RecordingOut();
    try {
      const code = await runLineModeApp({
        io: lineIo(home, out, err),
        home,
        turnIdleMs: 30_000,
        firstPrompt: "hi",
        seatId: "hephaestus",
        why: "MADC_UI=lines",
        launchWarnRows: [],
      });
      assert.equal(code, 0, err.text());
      assert.match(out.text().split("\n")[0] ?? "", /· hephaestus · line mode \(MADC_UI=lines\)$/);
      assert.deepEqual([...new Set(sessionSeats(home))], ["hephaestus"]);
    } finally {
      delete process.env.MADC_TEST_APP_TURNS;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("line mode without -s keeps madc-default (the M0 default, byte-identical header)", async () => {
    const home = mkdtempSync(join(tmpdir(), "madc-a8-seat-d-"));
    process.env.MADC_TEST_APP_TURNS = JSON.stringify([{ kind: "ok" }]);
    const out = new RecordingOut();
    try {
      const code = await runLineModeApp({
        io: lineIo(home, out, new RecordingOut()),
        home,
        turnIdleMs: 30_000,
        firstPrompt: "hi",
        why: "MADC_UI=lines",
        launchWarnRows: [],
      });
      assert.equal(code, 0);
      assert.match(out.text().split("\n")[0] ?? "", /· madc-default · line mode/);
      assert.deepEqual([...new Set(sessionSeats(home))], ["madc-default"]);
    } finally {
      delete process.env.MADC_TEST_APP_TURNS;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("runWitnessApp carries the seat into the mode it selects (tier A here)", {
    timeout: 60_000,
  }, async () => {
    const home = mkdtempSync(join(tmpdir(), "madc-a8-seat-l-"));
    process.env.MADC_TEST_APP_TURNS = JSON.stringify([{ kind: "ok" }]);
    const out = new RecordingOut();
    const err = new RecordingOut();
    try {
      const io: CliIO = {
        ...lineIo(home, out, err),
        env: { ...lineIo(home, out, err).env, MADC_UI: "lines" },
      };
      const code = await runWitnessApp({
        io,
        home,
        turnIdleMs: 30_000,
        firstPrompt: "hi",
        seatId: "prometheus",
      });
      assert.equal(code, 0, err.text());
      assert.match(out.text(), /· prometheus · line mode/);
      assert.deepEqual([...new Set(sessionSeats(home))], ["prometheus"]);
    } finally {
      delete process.env.MADC_TEST_APP_TURNS;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("main(): `madc -s daedalus hi` on a full TTY routes to the app on daedalus (not USAGE)", {
    timeout: 60_000,
  }, async () => {
    // The production routing — parseArgs → main's app gate → witnessEntry → runWitnessApp →
    // the selected mode — in-process, with TTY-shaped io and the fixture engine. MADC_UI=lines
    // selects line mode, which reads io.stdin (empty: EOF after the first prompt), so nothing
    // here touches the real terminal.
    const home = mkdtempSync(join(tmpdir(), "madc-a8-seat-main-"));
    process.env.MADC_TEST_APP_TURNS = JSON.stringify([{ kind: "ok" }]);
    const out = new RecordingOut();
    const err = new RecordingOut();
    try {
      const base = lineIo(home, out, err);
      const code = await main(["-s", "daedalus", "hi"], {
        ...base,
        env: { ...base.env, MADC_UI: "lines" },
      });
      assert.equal(code, 0, err.text());
      assert.ok(!err.text().includes("usage:"), "no USAGE on a TTY");
      assert.match(out.text(), /· daedalus · line mode \(MADC_UI=lines\)/);
      assert.deepEqual([...new Set(sessionSeats(home))], ["daedalus"]);
    } finally {
      delete process.env.MADC_TEST_APP_TURNS;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
