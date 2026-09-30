/**
 * M1-A5: the CLI's turn mode claim (`mode.ts`; M1 plan §7 M1-A5, protocol pin §3.3 P3). The claim
 * is `interactive` only with stdin AND stdout on a TTY and no `-p`; the engine still never trusts it
 * alone (its own presence check is `packages/engine/src/presence.test.ts`).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { type CliIO, wrapProcessIO } from "./io.ts";
import { claimMode } from "./mode.ts";

const LAUNCHER = fileURLToPath(new URL("./testing/cli-launcher.ts", import.meta.url));
const ECHO = fileURLToPath(new URL("../../engine/src/testing/echo-engine.ts", import.meta.url));
const SECRET_ENV_NAME = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i;

test("A5 claimMode: interactive only with stdin and stdout on a TTY and no -p", () => {
  for (const stdinIsTTY of [false, true]) {
    for (const stdoutIsTTY of [false, true]) {
      for (const print of [false, true]) {
        const expected = stdinIsTTY && stdoutIsTTY && !print ? "interactive" : "headless";
        assert.equal(
          claimMode({ stdinIsTTY, stdoutIsTTY, print }),
          expected,
          JSON.stringify({ stdinIsTTY, stdoutIsTTY, print }),
        );
      }
    }
  }
});

test("A5 (Copilot review of PR #39): the real-process IO wrapper forwards every TTY fact, stdinIsTTY included", () => {
  let cwdReads = 0;
  const out = { write: () => true };
  const base = (stdinIsTTY: boolean | undefined): CliIO => ({
    stdout: out,
    stderr: out,
    stdin: new PassThrough(),
    env: {},
    stdoutIsTTY: true,
    stderrIsTTY: false,
    ...(stdinIsTTY === undefined ? {} : { stdinIsTTY }),
    get cwd() {
      cwdReads += 1;
      return "/work";
    },
  });
  for (const stdinIsTTY of [true, false]) {
    const io = wrapProcessIO(base(stdinIsTTY), out, out);
    assert.equal(io.stdinIsTTY, stdinIsTTY);
    assert.equal(io.stdoutIsTTY, true);
    assert.equal(io.stderrIsTTY, false);
    // With both TTYs forwarded, a non-print surface can claim interactive; `-p` never can.
    const facts = { stdinIsTTY: io.stdinIsTTY === true, stdoutIsTTY: io.stdoutIsTTY };
    assert.equal(claimMode({ ...facts, print: false }), stdinIsTTY ? "interactive" : "headless");
    assert.equal(claimMode({ ...facts, print: true }), "headless");
  }
  assert.equal(wrapProcessIO(base(undefined), out, out).stdinIsTTY, undefined);
  assert.equal(cwdReads, 0, "cwd stays lazy (F-130)");
});

test("A5 madc -p: the one-shot claims headless, and the session JSONL records it", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "madc-a5-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  mkdirSync(join(root, "user"));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !SECRET_ENV_NAME.test(k)) env[k] = v;
  }
  Object.assign(env, {
    MADC_HOME: home,
    HOME: join(root, "user"),
    USERPROFILE: join(root, "user"),
    MADC_TEST_ENGINE_ENTRY: ECHO,
  });
  const runtimeArgs =
    process.versions.bun !== undefined ? [] : ["--disable-warning=ExperimentalWarning"];
  const child = spawn(process.execPath, [...runtimeArgs, LAUNCHER, "-p", "claim check"], {
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });
  child.stdin.end();
  let stderr = "";
  child.stdout.resume();
  child.stderr.setEncoding("utf8").on("data", (c: string) => {
    stderr += c;
  });
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  assert.equal(code, 0, stderr);

  const sessions = readdirSync(join(home, "sessions")).filter((n) => n.endsWith(".jsonl"));
  assert.equal(sessions.length, 1);
  const start = readFileSync(join(home, "sessions", sessions[0] ?? ""), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> })
    .find((event) => event.type === "turn.start");
  assert.equal(start?.payload.mode, "headless");
  assert.equal(start?.payload.presence, "absent");
});
