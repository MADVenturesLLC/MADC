/**
 * Process-level signal behaviour (DESIGN-SPEC §5.8.1, §5.13; §17.1 O-2/O-3/O-4): a child runs
 * the real driver (real app, real engine fixture, real verify worker) and the test observes the
 * OS-visible result — SIGHUP death by signal (the shell reports 129), the exact §5.13 lines,
 * and the §5.12 receipt on the real stderr.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const APP_FIXTURE = fileURLToPath(new URL("../testing/app-fixture.ts", import.meta.url));
const DRIVER = fileURLToPath(new URL("../testing/signal-driver.ts", import.meta.url));

function runDriver(
  signal: "sighup" | "sigint" | "sigterm",
  env: Record<string, string> = {},
  opts: { readonly levelA?: boolean } = {},
): Promise<{
  code: number | null;
  childSignal: NodeJS.Signals | null;
  stderr: string;
}> {
  const home = mkdtempSync(join(tmpdir(), "madc-sig-"));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", DRIVER], {
      env: {
        ...process.env,
        MADC_TEST_SIGNAL: signal,
        MADC_TEST_APP_TURNS: JSON.stringify([{ kind: "ok" }]),
        MADC_HOME: home,
        MADC_TEST_ENGINE_ENTRY: APP_FIXTURE,
        TMPDIR: process.env.TMPDIR ?? "/tmp",
        ...env,
      },
      // Level A runs hold stdin OPEN (a pipe the test never writes): the mode waits at its
      // input loop like production, so the delivered signal lands mid-run, not after exit.
      stdio: [opts.levelA === true ? "pipe" : "ignore", "ignore", "pipe"],
    });
    if (opts.levelA === true) {
      // The signal handler closes the child's readline but cannot close OUR end of the
      // pipe: end it shortly after the signal is delivered (the driver sends it once the
      // session settles), so the drained queue completes and the child exits with the
      // deferred status. Generous window: the driver waits for turn.end first.
      setTimeout(() => child.stdin?.end(), 4_000).unref?.();
    }
    let stderr = "";
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    child.on("exit", (code, childSignal) => {
      rmSync(home, { recursive: true, force: true });
      resolve({ code, childSignal: childSignal ?? null, stderr });
    });
  });
}

describe("§5.13 signal exit lines (process level)", () => {
  it("SIGHUP: the process dies BY the signal (the OS reports 129), stderr ends with exactly `madc: interrupted (SIGHUP)` and no exit line", {
    timeout: 60_000,
  }, async () => {
    const r = await runDriver("sighup");
    // O-4: the app re-raises SIGHUP after the restore, so the process is killed by the signal —
    // shells show 129. The app itself never calls exit(129).
    assert.equal(r.childSignal, "SIGHUP");
    assert.equal(r.code, null);
    // §5.13: the single line, never an `exit <n>` after it. The §5.12 receipt precedes it
    // (best effort, the terminal state is recorded here).
    assert.match(r.stderr, /madc: interrupted \(SIGHUP\)\n$/);
    assert.doesNotMatch(r.stderr, /madc: interrupted \(SIGHUP\)\nexit \d+\n/);
    // A recorded failure would still show in the receipt (nothing was recorded in this run).
    assert.match(r.stderr, /─ receipt/);
  });

  it("SIGINT: the app exits 130 after the final verify, with the receipt and the §5.13 line", {
    timeout: 60_000,
  }, async () => {
    const r = await runDriver("sigint");
    assert.equal(r.code, 130);
    assert.equal(r.childSignal, null);
    assert.match(r.stderr, /madc: interrupted \(SIGINT\)\nexit 130\n$/);
    assert.match(r.stderr, /─ receipt/);
    assert.match(r.stderr, /chain VERIFIED/);
  });

  it("SIGTERM: the app exits 143 under the same rule", { timeout: 60_000 }, async () => {
    const r = await runDriver("sigterm");
    assert.equal(r.code, 143);
    assert.equal(r.childSignal, null);
    assert.match(r.stderr, /madc: interrupted \(SIGTERM\)\nexit 143\n$/);
  });
});

describe("§5.8.1 O-2: a second signal during the final verify (F-102 path)", () => {
  it("the process dies BY the signal with no receipt and no §5.13 line", {
    timeout: 60_000,
  }, async () => {
    const home = mkdtempSync(join(tmpdir(), "madc-sig2-"));
    const result = await new Promise<{
      code: number | null;
      childSignal: NodeJS.Signals | null;
      stderr: string;
      sawMarker: boolean;
    }>((resolve) => {
      const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", DRIVER], {
        env: {
          ...process.env,
          MADC_TEST_SIGNAL: "sigint", // the FIRST signal starts the quit flow
          MADC_TEST_VERIFY_HOLD_MS: "8000", // hold the final verify open
          MADC_TEST_APP_TURNS: JSON.stringify([{ kind: "ok" }]),
          MADC_HOME: home,
          MADC_TEST_ENGINE_ENTRY: APP_FIXTURE,
          TMPDIR: process.env.TMPDIR ?? "/tmp",
        },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      let sawMarker = false;
      child.stderr?.on("data", (c: Buffer) => {
        const text = c.toString("utf8");
        stderr += text;
        if (text.includes("[final-verify-start]")) {
          sawMarker = true;
          // The second signal lands INSIDE the held final-verify window.
          setTimeout(() => child.kill("SIGINT"), 50);
        }
      });
      child.on("exit", (code, childSignal) => {
        rmSync(home, { recursive: true, force: true });
        resolve({ code, childSignal: childSignal ?? null, stderr, sawMarker });
      });
    });
    // We reached the window at all.
    assert.ok(result.sawMarker, "the final-verify marker never appeared on stderr");
    // O-2: restore + re-raise — the OS reports death by SIGINT (shells show 130); the app
    // itself picked no code and wrote neither the receipt nor the §5.13 line.
    assert.equal(result.childSignal, "SIGINT");
    assert.equal(result.code, null);
    assert.ok(!result.stderr.includes("─ receipt"), "no receipt on the F-102 path");
    assert.ok(!result.stderr.includes("madc: interrupted (SIGINT)"), "no §5.13 line");
  });
});

describe("round 8: Level A signal wiring through the production entry (§5.13, O-3/O-4)", () => {
  it("Level A SIGINT: the exit status prints ONCE after settlement (130 when nothing outranks it)", {
    timeout: 60_000,
  }, async () => {
    const r = await runDriver("sigint", { MADC_TEST_LEVEL_A: "1" }, { levelA: true });
    // The §5.13 line pair, printed after the run settled (deferred status).
    assert.match(r.stderr, /madc: interrupted \(SIGINT\)\n/);
    assert.match(r.stderr, /exit 130\n$/);
    // Exactly ONE exit line: no premature print before the verify settled.
    assert.equal(r.stderr.match(/exit \d+\n/g)?.length, 1, "one exit line only");
    assert.equal(r.code, 130);
  });

  it("Level A SIGHUP: best-effort line, then the entry re-raises — death by the signal (129)", {
    timeout: 60_000,
  }, async () => {
    const r = await runDriver("sighup", { MADC_TEST_LEVEL_A: "1" }, { levelA: true });
    assert.equal(r.childSignal, "SIGHUP");
    assert.equal(r.code, null);
    assert.match(r.stderr, /madc: interrupted \(SIGHUP\)\n$/);
    // O-4: no exit line ever follows the SIGHUP marker.
    assert.doesNotMatch(r.stderr, /madc: interrupted \(SIGHUP\)\nexit \d+\n/);
  });
});
