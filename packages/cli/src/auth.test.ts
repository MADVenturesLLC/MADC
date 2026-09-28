/**
 * M1-A2 end-to-end — `madc auth set|rm|status <providerId>` (plan §7 A2; protocol pin §2/§3.5).
 * The real CLI (`testing/cli-launcher.ts` → `bin.ts`) runs as a child process against the real
 * engine bin (`auth set` one-shot) and the echo fixture engine (`auth rm|status` JSONL sessions),
 * with the FAKE keychain shims and SYNTHETIC keys only — never a real keychain, never a real
 * credential, temp MADC_HOME only.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ENGINE_SRC = fileURLToPath(new URL("../../engine/src/", import.meta.url));
const REAL_BIN = join(ENGINE_SRC, "bin.ts");
const ECHO = join(ENGINE_SRC, "testing", "echo-engine.ts");
const FAKE_KEYCHAIN = join(ENGINE_SRC, "testing", "fake-keychain.ts");
const LAUNCHER = fileURLToPath(new URL("./testing/cli-launcher.ts", import.meta.url));
const SECRET_ENV_NAME = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i;
const SYNTHETIC = "sk-synthetic-cli-auth-test-0123456789";

type Sandbox = { root: string; home: string; bin: string; cleanup: () => void };

function sandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "madc-a2-cli-"));
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

type RunOptions = {
  engine?: string;
  env?: Record<string, string | undefined>;
  stdin?: string;
};

function runCli(sb: Sandbox, args: string[], opts: RunOptions = {}): Promise<RunResult> {
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
  if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
  else child.stdin.end();
  return new Promise((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

/**
 * The CLI may not import engine code (plan §6), so the fake-keychain shim writer is duplicated
 * here on purpose: `exec <runtime> fake-keychain.ts <tool> "$@"`.
 */
function keychainSandbox(
  sb: Sandbox,
  platform: "darwin" | "linux" = "darwin",
): {
  env: Record<string, string>;
  accountFile: (providerId: string) => string;
} {
  const shimDir = join(sb.root, "shims");
  mkdirSync(shimDir, { recursive: true });
  const accounts = join(sb.root, "accounts");
  mkdirSync(accounts, { recursive: true });
  const runtime = process.execPath;
  const flags = process.versions.bun !== undefined ? "" : "--disable-warning=ExperimentalWarning ";
  const write = (name: string, tool: string): string => {
    const p = join(shimDir, name);
    writeFileSync(p, `#!/bin/sh\nexec "${runtime}" ${flags}"${FAKE_KEYCHAIN}" ${tool} "$@"\n`, {
      mode: 0o755,
    });
    chmodSync(p, 0o755);
    return p;
  };
  const env =
    platform === "darwin"
      ? {
          MADC_TEST_KEYCHAIN_PLATFORM: "darwin",
          MADC_TEST_KEYCHAIN_SECURITY: write("security-shim", "security"),
          MADC_TEST_KEYCHAIN_DIR: accounts,
        }
      : {
          MADC_TEST_KEYCHAIN_PLATFORM: "linux",
          MADC_TEST_KEYCHAIN_SECRET_TOOL: write("secret-tool-shim", "secret-tool"),
          MADC_TEST_KEYCHAIN_DIR: accounts,
        };
  return { env, accountFile: (providerId) => join(accounts, encodeURIComponent(providerId)) };
}

// --------------------------------------------------------------------------- parse surface

test("A2 CLI: auth parse errors are usage failures and NEVER echo a command-line credential", async () => {
  const sb = sandbox();
  try {
    const bare = await runCli(sb, ["auth"]);
    assert.equal(bare.code, 2);
    assert.match(bare.stderr, /auth needs a subcommand: set \| rm \| status/);

    const unknownSub = await runCli(sb, ["auth", SYNTHETIC]);
    assert.equal(unknownSub.code, 2);
    assert.match(unknownSub.stderr, /unknown auth subcommand/);
    assert.ok(
      !unknownSub.stderr.includes(SYNTHETIC) && !unknownSub.stdout.includes(SYNTHETIC),
      "an unrecognized subcommand is never echoed (it may be a credential)",
    );

    const noId = await runCli(sb, ["auth", "set"]);
    assert.equal(noId.code, 2);
    assert.match(noId.stderr, /auth set needs a <providerId>/);

    // The classic mistake: the key as a second argument. Rejected — and not printed back.
    const withKey = await runCli(sb, ["auth", "set", "kimi-code", SYNTHETIC]);
    assert.equal(withKey.code, 2);
    assert.match(withKey.stderr, /a credential on the command line is never accepted/);
    assert.ok(
      !withKey.stderr.includes(SYNTHETIC) && !withKey.stdout.includes(SYNTHETIC),
      "the rejected credential is never echoed",
    );

    // §3e E8: with `--json` anywhere in argv, a parse-level usage failure prints one JSON object
    // on stdout and NOTHING on stderr — the auth commands obey the same pinned shape.
    const json = await runCli(sb, ["auth", "status", "kimi-code", "--json"]);
    assert.equal(json.code, 2);
    assert.equal(json.stderr, "");
    const usage = JSON.parse(json.stdout) as {
      ok: boolean;
      exitCode: number;
      error: { message: string; class: string };
    };
    assert.equal(usage.ok, false);
    assert.equal(usage.exitCode, 2);
    assert.equal(usage.error.class, "usage");
    assert.match(usage.error.message, /--json is only valid with doctor or -p/);

    const withP = await runCli(sb, ["auth", "rm", "kimi-code", "-p", "hi"]);
    assert.equal(withP.code, 2);
    const withInit = await runCli(sb, ["auth", "rm", "kimi-code", "--init"]);
    assert.equal(withInit.code, 2);

    const help = await runCli(sb, ["--help"]);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /madc auth set <providerId>/);
    assert.match(help.stdout, /madc auth rm <providerId>/);
    assert.match(help.stdout, /madc auth status <providerId>/);
  } finally {
    sb.cleanup();
  }
});

// -------------------------------------------------------------------------------- auth set

test("A2 CLI: `madc auth set` runs the one-shot engine child, stores via the fake keychain, stdout stays empty", async () => {
  const sb = sandbox();
  try {
    const kc = keychainSandbox(sb);
    const r = await runCli(sb, ["auth", "set", "kimi-code"], {
      engine: REAL_BIN,
      env: { ...kc.env, MADC_DEV_ENV_KEYS: "1" },
      stdin: `  ${SYNTHETIC}\n`,
    });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, "", "no protocol stream, no echo: stdout stays empty");
    assert.equal(readFileSync(kc.accountFile("kimi-code"), "utf8"), SYNTHETIC);
    assert.match(r.stderr, /credential stored for kimi-code/);
    assert.ok(!r.stderr.includes(SYNTHETIC), "the confirmation never carries the value");
  } finally {
    sb.cleanup();
  }
});

test("A2 CLI: `madc auth set` without a TTY refuses (exit 2) unless MADC_DEV_ENV_KEYS=1 — acceptance", async () => {
  const sb = sandbox();
  try {
    const kc = keychainSandbox(sb);
    const r = await runCli(sb, ["auth", "set", "kimi-code"], {
      engine: REAL_BIN,
      env: kc.env, // the dev flag is absent
      stdin: `${SYNTHETIC}\n`,
    });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /without a TTY/);
    assert.match(r.stderr, /MADC_DEV_ENV_KEYS=1/);
    assert.equal(existsSync(kc.accountFile("kimi-code")), false, "nothing is stored");
    assert.ok(!r.stdout.includes(SYNTHETIC) && !r.stderr.includes(SYNTHETIC));
  } finally {
    sb.cleanup();
  }
});

test("A2 CLI: `madc auth set` refuses forbidden and vendor-agent lanes (exit 4) — no consumer-login tokens", async () => {
  const sb = sandbox();
  try {
    const kc = keychainSandbox(sb);
    const forbidden = await runCli(sb, ["auth", "set", "chatgpt-token-replay"], {
      engine: REAL_BIN,
      env: { ...kc.env, MADC_DEV_ENV_KEYS: "1" },
      stdin: `${SYNTHETIC}\n`,
    });
    assert.equal(forbidden.code, 4);
    assert.match(forbidden.stderr, /forbidden lane/);
    const vendor = await runCli(sb, ["auth", "set", "claude-code"], {
      engine: REAL_BIN,
      env: { ...kc.env, MADC_DEV_ENV_KEYS: "1" },
      stdin: `${SYNTHETIC}\n`,
    });
    assert.equal(vendor.code, 4);
    assert.match(vendor.stderr, /vendor binary owns its login/);
    assert.equal(existsSync(kc.accountFile("chatgpt-token-replay")), false);
    assert.equal(existsSync(kc.accountFile("claude-code")), false);
  } finally {
    sb.cleanup();
  }
});

// -------------------------------------------------------------------------- auth status / rm

test("A2 CLI: `madc auth status` prints presence only — never a value", async () => {
  const sb = sandbox();
  try {
    const kc = keychainSandbox(sb);
    const absent = await runCli(sb, ["auth", "status", "kimi-code"], { engine: ECHO, env: kc.env });
    assert.equal(absent.code, 0, absent.stderr);
    assert.equal(absent.stdout, "kimi-code: absent\n");

    writeFileSync(kc.accountFile("kimi-code"), SYNTHETIC, { mode: 0o600 });
    const present = await runCli(sb, ["auth", "status", "kimi-code"], {
      engine: ECHO,
      env: kc.env,
    });
    assert.equal(present.code, 0, present.stderr);
    assert.equal(present.stdout, "kimi-code: present\n");
    assert.ok(
      !present.stdout.includes(SYNTHETIC) && !present.stderr.includes(SYNTHETIC),
      "presence only, never a value",
    );
  } finally {
    sb.cleanup();
  }
});

test("A2 CLI: `madc auth status` on an unknown id is a usage failure (engine -32602)", async () => {
  const sb = sandbox();
  try {
    const kc = keychainSandbox(sb);
    const r = await runCli(sb, ["auth", "status", "no-such-provider"], {
      engine: ECHO,
      env: kc.env,
    });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /-32602/);
  } finally {
    sb.cleanup();
  }
});

test("A2 CLI: `madc auth rm` removes the stored credential and is idempotent", async () => {
  const sb = sandbox();
  try {
    const kc = keychainSandbox(sb);
    writeFileSync(kc.accountFile("kimi-code"), SYNTHETIC, { mode: 0o600 });
    const first = await runCli(sb, ["auth", "rm", "kimi-code"], { engine: ECHO, env: kc.env });
    assert.equal(first.code, 0, first.stderr);
    assert.equal(first.stdout, "kimi-code: removed\n");
    assert.equal(existsSync(kc.accountFile("kimi-code")), false);
    assert.ok(!first.stdout.includes(SYNTHETIC) && !first.stderr.includes(SYNTHETIC));
    const again = await runCli(sb, ["auth", "rm", "kimi-code"], { engine: ECHO, env: kc.env });
    assert.equal(again.code, 0, again.stderr);
    assert.equal(again.stdout, "kimi-code: removed\n");
  } finally {
    sb.cleanup();
  }
});

// ------------------------------------------------------------------- doctor disclosure (D-M1-5)

type DoctorJson = {
  checks: Array<{ id: string; status: string; summary: string; evidence: Record<string, unknown> }>;
};

function credRow(report: DoctorJson) {
  const row = report.checks.find((c) => c.id === "cred.kimi-code");
  assert.ok(row, "cred.kimi-code row exists");
  return row;
}

test("A2 doctor: MADC_DEV_ENV_KEYS=1 is disclosed loudly (WARN); unset means keychain-only (SKIP)", async () => {
  const sb = sandbox();
  try {
    const flagged = await runCli(sb, ["doctor", "--json"], {
      engine: ECHO,
      env: { MADC_DEV_ENV_KEYS: "1" },
    });
    assert.equal(flagged.code, 0, flagged.stdout);
    const flaggedRow = credRow(JSON.parse(flagged.stdout) as DoctorJson);
    assert.equal(flaggedRow.status, "warn");
    assert.match(flaggedRow.summary, /MADC_DEV_ENV_KEYS=1 dev exception \(D-M1-5\)/);
    assert.equal(flaggedRow.evidence.devEnvKeys, true);

    const flaggedWithKey = await runCli(sb, ["doctor", "--json"], {
      engine: ECHO,
      env: { MADC_DEV_ENV_KEYS: "1", KIMI_API_KEY: SYNTHETIC },
    });
    const withKeyRow = credRow(JSON.parse(flaggedWithKey.stdout) as DoctorJson);
    assert.equal(withKeyRow.status, "warn");
    assert.match(withKeyRow.summary, /env fallback ACTIVE/);
    assert.ok(
      !flaggedWithKey.stdout.includes(SYNTHETIC) && !flaggedWithKey.stderr.includes(SYNTHETIC),
      "doctor never prints the key",
    );

    const unset = await runCli(sb, ["doctor", "--json"], {
      engine: ECHO,
      env: { KIMI_API_KEY: SYNTHETIC }, // set but IGNORED without the flag
    });
    assert.equal(unset.code, 0, unset.stdout);
    const unsetRow = credRow(JSON.parse(unset.stdout) as DoctorJson);
    assert.equal(unsetRow.status, "skip");
    assert.match(unsetRow.summary, /OS keychain/);
    assert.match(unsetRow.summary, /madc auth status kimi-code/);
    assert.equal(unsetRow.evidence.devEnvKeys, false);
    assert.ok(!unset.stdout.includes(SYNTHETIC));
  } finally {
    sb.cleanup();
  }
});
