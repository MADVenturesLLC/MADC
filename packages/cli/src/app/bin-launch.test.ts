/**
 * bin.ts TTY-launch regression (§5.0): the real production entry — `runBin` wrapping the
 * streams — must pass stdinIsTTY/columns/rows through its guarded-io rebuild, so a TTY opens
 * the Full WITNESS app instead of printing USAGE. The child fakes the TTY flags on its stdio
 * (isTTY + dimensions + a no-op setRawMode) and then runs the real exported `runBin` — the
 * flags are exactly the input under test; with them dropped (the regression), main()'s app
 * gate saw undefined and printed USAGE.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin.ts", import.meta.url));
const APP_FIXTURE = fileURLToPath(new URL("../testing/app-fixture.ts", import.meta.url));

// The import specifier must be a LITERAL relative path (the honesty scanner flags
// non-literal dynamic imports; the child runs with cwd at the worktree root).
const PRELUDE = `
process.stdin.isTTY = true;
process.stdin.setRawMode = () => process.stdin;
process.stdout.isTTY = true;
process.stdout.columns = 110;
process.stdout.rows = 32;
process.stderr.isTTY = true;
const { runBin } = await import("./packages/cli/src/bin.ts");
await runBin();
`;

describe("bin.ts TTY launch regression", () => {
  it("bare madc on a full TTY opens the Full WITNESS banner, not USAGE", {
    timeout: 60_000,
  }, async () => {
    const home = mkdtempSync(join(tmpdir(), "madc-pty-"));
    try {
      // Seed the seat first (the banner reads it read-only; the app gate needs no key).
      const init = spawnSync(
        process.execPath,
        ["--disable-warning=ExperimentalWarning", BIN, "doctor", "--init"],
        {
          env: { ...process.env, MADC_HOME: home, KIMI_API_KEY: "x" },
          encoding: "utf8",
          timeout: 60_000,
        },
      );
      assert.equal(init.status, 0, `doctor --init failed: ${init.stderr}`);
      const out = await new Promise<string>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", PRELUDE],
          {
            env: {
              ...process.env,
              MADC_HOME: home,
              MADC_TEST_ENGINE_ENTRY: APP_FIXTURE,
              MADC_TEST_APP_TURNS: "[]",
              TERM: "xterm-256color",
              LANG: "en_US.UTF-8",
            },
          },
        );
        let buf = "";
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`banner never opened; captured: ${JSON.stringify(buf.slice(0, 300))}`));
        }, 30_000);
        const seen = (): boolean =>
          buf.includes("Seat") || buf.includes("madc 0.0.0") || buf.includes("usage:");
        child.stdout?.on("data", (c: Buffer) => {
          buf += c.toString("utf8");
          if (seen()) {
            clearTimeout(timer);
            child.kill("SIGKILL");
          }
        });
        child.stderr?.on("data", (c: Buffer) => {
          buf += c.toString("utf8");
          if (seen()) {
            clearTimeout(timer);
            child.kill("SIGKILL");
          }
        });
        child.on("exit", () => {
          clearTimeout(timer);
          resolve(buf);
        });
        child.on("error", reject);
      });
      // The regression: with the fields dropped the gate read non-TTY and printed USAGE.
      assert.ok(!out.includes("usage:"), "bare madc on a TTY must not print USAGE");
      assert.ok(!out.includes("interactive chat arrives"), "no CHAT_RESERVED on a TTY");
      // The Full WITNESS banner opened through the real bin path (wordmark + Seat section).
      assert.ok(
        out.includes("Seat") || out.includes("madc 0.0.0"),
        `the banner did not open; captured: ${JSON.stringify(out.slice(0, 300))}`,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("MADC_UI=inline is not a recognized mode: the tier-W app opens with the pane note (§5.0 IQW-12)", {
    timeout: 60_000,
  }, async () => {
    const home = mkdtempSync(join(tmpdir(), "madc-pty-"));
    try {
      const init = spawnSync(
        process.execPath,
        ["--disable-warning=ExperimentalWarning", BIN, "doctor", "--init"],
        {
          env: { ...process.env, MADC_HOME: home, KIMI_API_KEY: "x" },
          encoding: "utf8",
          timeout: 60_000,
        },
      );
      assert.equal(init.status, 0, `doctor --init failed: ${init.stderr}`);
      const out = await new Promise<string>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", PRELUDE],
          {
            env: {
              ...process.env,
              MADC_HOME: home,
              MADC_TEST_ENGINE_ENTRY: APP_FIXTURE,
              MADC_TEST_APP_TURNS: "[]",
              MADC_UI: "inline",
              TERM: "xterm-256color",
              LANG: "en_US.UTF-8",
            },
          },
        );
        let buf = "";
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`app never opened; captured: ${JSON.stringify(buf.slice(0, 300))}`));
        }, 30_000);
        const seen = (): boolean =>
          buf.includes("Seat") || buf.includes("madc 0.0.0") || buf.includes("usage:");
        const onData = (c: Buffer): void => {
          buf += c.toString("utf8");
          if (seen()) {
            clearTimeout(timer);
            child.kill("SIGKILL");
          }
        };
        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);
        child.on("exit", () => {
          clearTimeout(timer);
          resolve(buf);
        });
        child.on("error", reject);
      });
      // IQW-12: only "lines" is recognized; "inline" counts as unset, so the full tier-W app
      // opens — alternate screen and all — not the legacy append-only inline mode (§5.10).
      assert.ok(
        out.includes("\u001b[?1049h"),
        "the tier-W app must enter the alternate screen even with MADC_UI=inline",
      );
      assert.ok(!out.includes("line mode ("), "MADC_UI=inline must not select line mode");
      assert.ok(
        !out.includes("engine stderr is shown as-is"),
        "MADC_UI=inline must not select the legacy inline mode",
      );
      assert.ok(
        out.includes('MADC_UI: not recognised (only "lines")'),
        "the unrecognised value is noted without echoing it",
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// Round 9: Level A through the REAL production entry — the same TTY prelude as above, but
// MADC_UI=lines selects line mode inside main()'s tier gate, and the child is driven to a
// real signal outcome. runBin → main → launch → runLineModeApp is the exact production
// chain; no signal-driver indirection and no mirrored process listeners.
type LevelAResult = {
  code: number | null;
  childSignal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
};

function runLevelA(
  env: Record<string, string>,
  deliver: (child: import("node:child_process").ChildProcess) => void,
  opts: { readonly driveTurn?: boolean; readonly endStdinOnPrompt?: boolean } = {},
): Promise<LevelAResult> {
  const home = mkdtempSync(join(tmpdir(), "madc-lae-"));
  // The prelude must run from a REAL FILE: under `node -e` the app's verify worker
  // (node:worker_threads) fails module resolution and every verify reads "worker failed".
  // Relative specifiers resolve against the prelude file's own URL (NOT cwd), so the
  // file lives in the worktree root — where the LITERAL "./packages/cli/src/bin.ts"
  // resolves (the honesty scanner flags non-literal dynamic imports). Unique per run
  // and removed on every exit path; the worktree never carries a stale prelude.
  const root = fileURLToPath(new URL("../../../..", import.meta.url));
  const preludeFile = join(root, `.level-a-prelude-${process.pid}-${Date.now()}.mjs`);
  writeFileSync(
    preludeFile,
    `process.stdin.isTTY = true;
process.stdin.setRawMode = () => process.stdin;
process.stdout.isTTY = true;
process.stdout.columns = 110;
process.stdout.rows = 32;
process.stderr.isTTY = true;
const { runBin } = await import("./packages/cli/src/bin.ts");
await runBin(process.env.MADC_TEST_ENGINE_ENTRY);
`,
  );
  const cleanup = (): void => {
    rmSync(preludeFile, { force: true });
    rmSync(home, { recursive: true, force: true });
  };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", preludeFile], {
      env: {
        ...process.env,
        MADC_HOME: home,
        MADC_TEST_ENGINE_ENTRY: APP_FIXTURE,
        TERM: "xterm-256color",
        LANG: "en_US.UTF-8",
        MADC_UI: "lines",
        TMPDIR: process.env.TMPDIR ?? "/tmp",
        ...env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";
    let prompted = false;
    let delivered = false;
    const driveTurn = opts.driveTurn !== false;
    child.stdout?.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
      // Drive a real turn: after the FIRST `> ` prompt, send the line exactly once (the
      // re-prompt after the turn also matches the tail regex — the flag holds it).
      if (!prompted && /(^|\n)> $/.test(stdout)) {
        prompted = true;
        if (opts.endStdinOnPrompt === true) setTimeout(() => child.stdin?.end(), 25);
        else if (driveTurn) setTimeout(() => child.stdin?.write("hi\n"), 25);
      }
    });
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
      // Deliver the signal once the first turn settled (its receipt landed on stderr) —
      // after a settle tick so the verify worker is fully wound down (the tier-W tests
      // use the same 50-100 ms grace before signalling).
      if (driveTurn && !delivered && stderr.includes("─ receipt")) {
        delivered = true;
        setTimeout(() => deliver(child), 100);
      }
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      cleanup();
      reject(
        new Error(
          `Level A child never settled: ${JSON.stringify({
            stderr: stderr.slice(0, 200),
            stdout: stdout.slice(0, 200),
          })}`,
        ),
      );
    }, 30_000);
    child.on("exit", (code, childSignal) => {
      clearTimeout(timer);
      cleanup();
      resolve({ code, childSignal: childSignal ?? null, stderr, stdout });
    });
    child.on("error", reject);
  });
}

describe("round 9: Level A signal behaviour through runBin → main → launch (§5.13, O-3/O-4)", () => {
  it("MADC_UI=lines selects Level A through the real entry (line-mode identity line)", {
    timeout: 60_000,
  }, async () => {
    // No turn is driven: stdin ends the moment the `> ` prompt appears.
    const r = await runLevelA({ MADC_TEST_APP_TURNS: "[]" }, () => {}, {
      driveTurn: false,
      endStdinOnPrompt: true,
    });
    assert.match(r.stdout, /line mode \(MADC_UI=lines\)/);
    assert.ok(!r.stdout.includes("Seat\n"), "no tier-W banner");
  });

  it("SIGINT: deferred contiguous block, exactly one exit line, 130", {
    timeout: 60_000,
  }, async () => {
    const r = await runLevelA({ MADC_TEST_APP_TURNS: JSON.stringify([{ kind: "ok" }]) }, (c) =>
      c.kill("SIGINT"),
    );
    assert.match(r.stderr, /madc: interrupted \(SIGINT\)\nexit 130\n$/);
    assert.equal(r.stderr.match(/exit \d+\n/g)?.length, 1, "one exit line only");
    assert.equal(r.code, 130);
  });

  it("SIGTERM: the same rule, 143", {
    timeout: 60_000,
  }, async () => {
    const r = await runLevelA({ MADC_TEST_APP_TURNS: JSON.stringify([{ kind: "ok" }]) }, (c) =>
      c.kill("SIGTERM"),
    );
    assert.match(r.stderr, /madc: interrupted \(SIGTERM\)\nexit 143\n$/);
    assert.equal(r.code, 143);
  });

  it("SIGHUP: the one-line best-effort marker, then death BY the signal — never exit(129)", {
    timeout: 60_000,
  }, async () => {
    const r = await runLevelA({ MADC_TEST_APP_TURNS: JSON.stringify([{ kind: "ok" }]) }, (c) =>
      c.kill("SIGHUP"),
    );
    assert.equal(r.childSignal, "SIGHUP");
    assert.equal(r.code, null);
    assert.match(r.stderr, /madc: interrupted \(SIGHUP\)\n$/);
    assert.doesNotMatch(r.stderr, /madc: interrupted \(SIGHUP\)\nexit /);
  });

  it("recorded-failure ranking: a recorded engine failure (3) outranks the raw 130 (SIGINT)", {
    timeout: 60_000,
  }, async () => {
    // The pinned order is 3 > 2 > 5 > 130/143 > 4 > 1 > 0: a signal replaces only 0/1/4.
    // The engine dying mid-turn records class 3, which the signal must NOT replace.
    const r = await runLevelA(
      { MADC_TEST_APP_TURNS: JSON.stringify([{ kind: "engine-exit" }]) },
      (c) => c.kill("SIGINT"),
    );
    assert.match(r.stderr, /exit +3\n/, "the receipt records the engine failure");
    assert.match(r.stderr, /madc: interrupted \(SIGINT\)\nexit 3\n$/);
    assert.equal(r.code, 3, "the recorded engine failure outranks the signal");
  });
});
