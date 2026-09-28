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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin.ts", import.meta.url));
const APP_ENGINE = fileURLToPath(new URL("./app-engine.ts", import.meta.url));

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
              MADC_TEST_ENGINE_ENTRY: APP_ENGINE,
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
});
