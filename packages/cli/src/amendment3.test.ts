/**
 * M0 Amendment 3 acceptance, CLI side: doctor prints the torn-tail row text (CLI pin §3 `session`
 * row) for every item-2 2a case (2c), and WARNs on the `locks` row with the pinned item-5 rule 4
 * text for an owner-unreadable `sessions/` (5b). Real CLI as a child process, temp MADC_HOME only.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const POSIX = process.platform !== "win32";
const LAUNCHER = fileURLToPath(new URL("./testing/cli-launcher.ts", import.meta.url));
const FIXTURES = fileURLToPath(new URL("../../engine/src/testing/", import.meta.url));
const ECHO = join(FIXTURES, "echo-engine.ts");
const SECRET_ENV_NAME = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i;

type Sandbox = { root: string; home: string; bin: string; cleanup: () => void };

function sandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "madc-a3-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  mkdirSync(join(root, "user"));
  return {
    root,
    home: join(root, "home"),
    bin,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

type RunResult = { code: number | null; signal: string | null; stdout: string; stderr: string };

function runCli(
  sb: Sandbox,
  args: string[],
  opts: { engine?: string; env?: Record<string, string | undefined> } = {},
): Promise<RunResult> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !SECRET_ENV_NAME.test(k) && k !== "NO_COLOR") env[k] = v;
  }
  Object.assign(env, {
    MADC_HOME: sb.home,
    HOME: join(sb.root, "user"),
    USERPROFILE: join(sb.root, "user"),
    PATH: sb.bin,
  });
  if (opts.engine !== undefined) env.MADC_TEST_ENGINE_ENTRY = opts.engine;
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  const runtimeArgs =
    process.versions.bun !== undefined ? [] : ["--disable-warning=ExperimentalWarning"];
  const child = spawn(process.execPath, [...runtimeArgs, LAUNCHER, ...args], {
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (c: string) => (stdout += c));
  child.stderr.setEncoding("utf8").on("data", (c: string) => (stderr += c));
  child.stdin.end();
  return new Promise((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

const sha256 = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string, rel: string) => {
    let names: string[];
    try {
      names = readdirSync(d).map(String);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (rel === "" && name === "user") continue;
      const p = join(d, name);
      const r = rel === "" ? name : `${rel}/${name}`;
      try {
        out[r] = sha256(p);
      } catch {
        out[r] = "<dir>";
        walk(p, r);
      }
    }
  };
  walk(dir, "");
  return out;
}

type DoctorJson = {
  checks: Array<{ id: string; status: string; summary: string; evidence: Record<string, unknown> }>;
};

function check(report: DoctorJson, id: string) {
  const c = report.checks.find((x) => x.id === id);
  assert.ok(c, `check ${id}`);
  return c;
}

async function seedWithSession(sb: Sandbox): Promise<string> {
  const init = await runCli(sb, ["doctor", "--init", "--json"]);
  assert.equal(init.code, 0, init.stdout + init.stderr);
  const one = await runCli(sb, ["-p", "seed turn"], { engine: ECHO });
  assert.equal(one.code, 0, one.stderr);
  const [path] = readdirSync(join(sb.home, "sessions"))
    .filter((n) => n.endsWith(".jsonl"))
    .map((n) => join(sb.home, "sessions", n));
  assert.ok(path, "the seeded session file");
  return path;
}

const TORN_ROW =
  /^torn tail at line \d+: crash residue, not tamper \(file untouched; repair lands in M1\)$/;

test("A3 2c: doctor prints the torn-tail row text for every 2a crash-residue case and never modifies the file", {
  timeout: 120_000,
}, async () => {
  const sb = sandbox();
  try {
    const path = await seedWithSession(sb);
    const good = readFileSync(path, "utf8");
    const cases: Array<[string, string]> = [
      ["0-byte file", ""],
      ["valid lines + NULs (no newline)", `${good}${"\0".repeat(3)}`],
      ["valid lines + NULs + newline", `${good}${"\0".repeat(3)}\n`],
      ["valid lines + whitespace-only tail", `${good} \t \n`],
      ["valid lines + several NUL-only lines", `${good}\0\n\0\n\0\n`],
      ["valid lines + one trailing blank line", `${good}\n`],
      ["a file that is only NULs", "\0\0\0\0\0"],
    ];
    for (const [name, content] of cases) {
      writeFileSync(path, content);
      const sha = sha256(path);
      const r = await runCli(sb, ["doctor", "--json"]);
      assert.equal(r.code, 1, `${name}: doctor FAILs the row`);
      const report = JSON.parse(r.stdout) as DoctorJson;
      assert.equal(check(report, "session").status, "fail", name);
      assert.match(
        check(report, "session").summary,
        TORN_ROW,
        `${name}: ${check(report, "session").summary}`,
      );
      assert.equal(sha256(path), sha, `${name}: doctor never modifies the file`);
    }
    writeFileSync(path, good);
    const ok = await runCli(sb, ["doctor", "--json"]);
    assert.equal(check(JSON.parse(ok.stdout) as DoctorJson, "session").status, "pass");
  } finally {
    sb.cleanup();
  }
});

test("A3 5b: doctor WARNs on the locks row with the rule 4 text for mode 0300 and mode 0000, and changes nothing", {
  timeout: 60_000,
}, async () => {
  if (!POSIX) {
    console.log("SKIP A3 5b: POSIX mode bits only (Windows is a best-effort no-op)");
    return;
  }
  const sb = sandbox();
  const sessions = join(sb.home, "sessions");
  try {
    const init = await runCli(sb, ["doctor", "--init", "--json"]);
    assert.equal(init.code, 0, init.stdout + init.stderr);
    for (const mode of [0o300, 0o000] as const) {
      chmodSync(sessions, mode);
      const before = snapshot(sb.root);
      const r = await runCli(sb, ["doctor", "--json"]);
      const locks = check(JSON.parse(r.stdout) as DoctorJson, "locks");
      assert.equal(locks.status, "warn", `mode ${mode.toString(8)}: ${locks.summary}`);
      const mode4 = mode.toString(8).padStart(4, "0");
      assert.equal(
        locks.summary,
        `sessions/ mode ${mode4}: unsupported in M0 (needs owner read for directory fsync)`,
      );
      assert.deepEqual(snapshot(sb.root), before, `mode ${mode4}: doctor changed nothing`);
      chmodSync(sessions, 0o700);
    }
    const ok = await runCli(sb, ["doctor", "--json"]);
    assert.equal(check(JSON.parse(ok.stdout) as DoctorJson, "locks").status, "pass");
  } finally {
    try {
      chmodSync(sessions, 0o700);
    } catch {
      // not created
    }
    sb.cleanup();
  }
});
