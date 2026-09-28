/**
 * M1-A2 acceptance — the one-shot `madc-engine auth-set <providerId>` (protocol pin §2: a separate
 * process, NOT a JSONL session). Covers: exactly-one-argument arity (a credential on the command
 * line is rejected, never echoed), registry-lane policy refusals (forbidden + vendor-agent lanes:
 * madc never stores consumer-login tokens), the no-TTY refusal unless the pinned
 * `MADC_DEV_ENV_KEYS=1` development exception is set (D-M1-5), the no-echo TTY prompt, the stdin
 * path under the flag, and the bin-level interception end to end. Fake keychain + SYNTHETIC keys
 * only — never a real keychain, never a real credential.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { ENGINE_ENTRY } from "../client.ts";
import { keychainEnv, writeKeychainShims } from "../testing/keychain-shim.ts";
import { runAuthSet } from "./auth-set.ts";
import { type CredentialStore, createCredentialStore } from "./store.ts";

const SYNTHETIC = "sk-synthetic-auth-set-test-0123456789";

/** In-memory store double: records `set` calls; nothing else. */
function fakeStore(failWrite = false): CredentialStore & {
  sets: Array<{ providerId: string; secret: string }>;
} {
  const sets: Array<{ providerId: string; secret: string }> = [];
  return {
    sets,
    status: async () => false,
    source: async () => null,
    get: async () => null,
    set: async (providerId, secret) => {
      if (failWrite) throw new Error("keychain write failed (test)");
      sets.push({ providerId, secret });
    },
    remove: async () => undefined,
  };
}

function captureStderr(): { write(chunk: string): unknown; text: () => string } {
  let out = "";
  return { write: (chunk: string) => (out += chunk), text: () => out };
}

/** A stdin double with the raw-mode surface `promptSecretNoEcho` needs (no real TTY involved). */
type FakeRawStdin = PassThrough & { isRaw: boolean; setRawMode(b: boolean): PassThrough };

function fakeRawStdin(): FakeRawStdin {
  const stream = new PassThrough() as FakeRawStdin;
  stream.isRaw = false;
  stream.setRawMode = (b: boolean) => {
    stream.isRaw = b;
    return stream;
  };
  return stream;
}

function stdinFrom(text: string): NodeJS.ReadableStream {
  const stream = new PassThrough();
  stream.end(text);
  return stream;
}

// ------------------------------------------------------------------------- usage / arity

test("A2 auth-set: zero or extra arguments are usage errors — a credential on the command line is rejected and never echoed", async () => {
  const store = fakeStore();
  const err = captureStderr();
  assert.equal(await runAuthSet([], { store, stderr: err, env: {} }), 2);
  assert.match(err.text(), /exactly one argument/);

  const err2 = captureStderr();
  const code = await runAuthSet(["kimi-code", SYNTHETIC], { store, stderr: err2, env: {} });
  assert.equal(code, 2);
  assert.ok(
    !err2.text().includes(SYNTHETIC),
    "the rejected command-line credential is never echoed back",
  );
  assert.deepEqual(store.sets, [], "nothing is stored from a command-line credential");
});

test("A2 auth-set: id grammar and unknown ids are usage errors", async () => {
  const store = fakeStore();
  const badGrammar = captureStderr();
  assert.equal(await runAuthSet(["../escape"], { store, stderr: badGrammar, env: {} }), 2);
  assert.match(badGrammar.text(), /\^\[A-Za-z0-9\]/);
  const unknown = captureStderr();
  assert.equal(await runAuthSet(["no-such-provider"], { store, stderr: unknown, env: {} }), 2);
  assert.match(unknown.text(), /unknown provider id/);
  assert.deepEqual(store.sets, []);
});

test("A2 fix 4126239605: the unknown-provider diagnostic never interpolates the sole argument (it may be a credential)", async () => {
  // The defect: `unknown provider id ${providerId}` echoed the raw argument, so a credential-shaped
  // sole argument (`madc-engine auth-set sk-…`) was printed to stderr. The message must be
  // identifier-independent, like the arity and grammar paths already are.
  const store = fakeStore();
  for (const sole of [
    "sk-synthetic-sole-argument-credential-0123456789",
    "sk-sp-synthetic-sole-plan-credential-0123456789",
    "xai-synthetic-sole-argument-credential-01",
  ]) {
    const err = captureStderr();
    const code = await runAuthSet([sole], { store, stderr: err, env: {} });
    assert.equal(code, 2, sole);
    assert.match(err.text(), /unknown provider id/, sole);
    assert.ok(!err.text().includes(sole), `the diagnostic echoes the sole argument: ${sole}`);
    assert.ok(!err.text().includes(sole.replace(/^(sk-sp-|sk-|xai-)/, "")), "no partial echo");
  }
  assert.deepEqual(store.sets, []);
});

// ----------------------------------------------------------------------- lane policy (A2 forbidden)

test("A2 auth-set: forbidden lanes are refused (exit 4) — including every consumer-login/token-replay id", async () => {
  const store = fakeStore();
  for (const id of [
    "zai-glm-coding-plan",
    "chatgpt-token-replay",
    "claude-subscription-http",
    "xai-consumer-signin",
    "gemini-antigravity-signin",
  ]) {
    const err = captureStderr();
    assert.equal(
      await runAuthSet([id], {
        store,
        stderr: err,
        env: { MADC_DEV_ENV_KEYS: "1" },
        stdin: stdinFrom(`${SYNTHETIC}\n`),
      }),
      4,
      id,
    );
    assert.match(err.text(), /forbidden lane/, id);
  }
  assert.deepEqual(store.sets, []);
});

test("A2 auth-set: vendor-agent lanes are refused (exit 4) — the vendor binary owns its login", async () => {
  const store = fakeStore();
  for (const id of ["claude-code", "codex", "grok-build", "github-copilot"]) {
    const err = captureStderr();
    assert.equal(
      await runAuthSet([id], {
        store,
        stderr: err,
        env: { MADC_DEV_ENV_KEYS: "1" },
        stdin: stdinFrom(`${SYNTHETIC}\n`),
      }),
      4,
      id,
    );
    assert.match(err.text(), /vendor binary owns its login|vendor-agent lane/, id);
  }
  assert.deepEqual(store.sets, []);
});

// ---------------------------------------------------------------- no-TTY refusal (D-M1-5 gate)

test("A2 auth-set: without a TTY it refuses to run unless MADC_DEV_ENV_KEYS=1 (acceptance)", async () => {
  const store = fakeStore();
  const err = captureStderr();
  const code = await runAuthSet(["kimi-code"], {
    store,
    stderr: err,
    env: {}, // flag absent
    stdin: stdinFrom(`${SYNTHETIC}\n`),
  });
  assert.equal(code, 2);
  assert.match(err.text(), /without a TTY/);
  assert.match(err.text(), /MADC_DEV_ENV_KEYS=1/);
  assert.deepEqual(store.sets, [], "the stdin secret is not read without the flag");

  // A flag value other than exactly "1" does not unlock the stdin path either.
  for (const flag of ["0", "true", ""]) {
    const strict = fakeStore();
    const errStrict = captureStderr();
    assert.equal(
      await runAuthSet(["kimi-code"], {
        store: strict,
        stderr: errStrict,
        env: { MADC_DEV_ENV_KEYS: flag },
        stdin: stdinFrom(`${SYNTHETIC}\n`),
      }),
      2,
      `flag "${flag}"`,
    );
    assert.deepEqual(strict.sets, []);
  }
});

test("A2 auth-set: under MADC_DEV_ENV_KEYS=1 the no-TTY path reads the secret from stdin (trimmed), stores it, exit 0", async () => {
  const store = fakeStore();
  const err = captureStderr();
  const code = await runAuthSet(["kimi-code"], {
    store,
    stderr: err,
    env: { MADC_DEV_ENV_KEYS: "1" },
    stdin: stdinFrom(`  ${SYNTHETIC}\n`),
  });
  assert.equal(code, 0);
  assert.deepEqual(store.sets, [{ providerId: "kimi-code", secret: SYNTHETIC }]);
  assert.match(err.text(), /credential stored for kimi-code \(keychain\)/);
  assert.ok(!err.text().includes(SYNTHETIC), "the confirmation never carries the value");
});

test("A2 auth-set: interactive-only plan lanes accept their plan keys (ruling 12: credential class by registry entry)", async () => {
  const store = fakeStore();
  const err = captureStderr();
  const code = await runAuthSet(["minimax-token-plan"], {
    store,
    stderr: err,
    env: { MADC_DEV_ENV_KEYS: "1" },
    stdin: stdinFrom("sk-sp-synthetic-plan-key-0123456789\n"),
  });
  assert.equal(code, 0);
  assert.deepEqual(store.sets, [
    { providerId: "minimax-token-plan", secret: "sk-sp-synthetic-plan-key-0123456789" },
  ]);
});

test("A2 auth-set: empty input and an over-cap stdin are usage errors", async () => {
  const blank = fakeStore();
  const errBlank = captureStderr();
  assert.equal(
    await runAuthSet(["kimi-code"], {
      store: blank,
      stderr: errBlank,
      env: { MADC_DEV_ENV_KEYS: "1" },
      stdin: stdinFrom("   \n"),
    }),
    2,
  );
  assert.match(errBlank.text(), /empty credential/);

  const over = fakeStore();
  const errOver = captureStderr();
  const huge = stdinFrom(`${"x".repeat(64 * 1024 + 1)}`);
  assert.equal(
    await runAuthSet(["kimi-code"], {
      store: over,
      stderr: errOver,
      env: { MADC_DEV_ENV_KEYS: "1" },
      stdin: huge,
    }),
    2,
  );
  assert.match(errOver.text(), /exceeds 65536 bytes/);
  assert.deepEqual(over.sets, []);
});

test("A2 auth-set: a keychain write failure exits 1 and the error never carries the secret", async () => {
  const store = fakeStore(true);
  const err = captureStderr();
  const code = await runAuthSet(["kimi-code"], {
    store,
    stderr: err,
    env: { MADC_DEV_ENV_KEYS: "1" },
    stdin: stdinFrom(`${SYNTHETIC}\n`),
  });
  assert.equal(code, 1);
  assert.match(err.text(), /could not store the credential/);
  assert.ok(!err.text().includes(SYNTHETIC));
});

// ---------------------------------------------------------------------------- no-echo TTY prompt

test("A2 auth-set: the TTY prompt reads with echo disabled, edits with backspace, and never echoes the secret", async () => {
  const store = fakeStore();
  const err = captureStderr();
  const stdin = fakeRawStdin();
  const run = runAuthSet(["kimi-code"], {
    store,
    stderr: err,
    env: {},
    stdin,
    stdinIsTTY: true,
  });
  stdin.write("ab\u007Fc\r"); // "abc" with a backspace edit, terminated by CR
  assert.equal(await run, 0);
  assert.deepEqual(store.sets, [{ providerId: "kimi-code", secret: "ac" }]);
  assert.match(err.text(), /Enter credential for kimi-code: /);
  assert.ok(!err.text().includes("ac"), "characters are never echoed");
  assert.equal(stdin.isRaw, false, "raw mode is restored");
});

test("A2 auth-set: Ctrl-C at the prompt exits 130 and stores nothing", async () => {
  const store = fakeStore();
  const err = captureStderr();
  const stdin = fakeRawStdin();
  const run = runAuthSet(["kimi-code"], {
    store,
    stderr: err,
    env: {},
    stdin,
    stdinIsTTY: true,
  });
  stdin.write("partial\u0003");
  assert.equal(await run, 130);
  assert.match(err.text(), /interrupted/);
  assert.deepEqual(store.sets, []);
});

test("A2 auth-set: an empty prompt line is a usage error", async () => {
  const store = fakeStore();
  const err = captureStderr();
  const stdin = fakeRawStdin();
  const run = runAuthSet(["kimi-code"], {
    store,
    stderr: err,
    env: {},
    stdin,
    stdinIsTTY: true,
  });
  stdin.write("\r");
  assert.equal(await run, 2);
  assert.match(err.text(), /empty credential/);
  assert.deepEqual(store.sets, []);
});

// ------------------------------------------------------------- bin-level interception (e2e)

/** Spawn the REAL engine bin with `auth-set` and piped stdio; synthetic keys only. */
function spawnBinAuthSet(
  providerId: string,
  env: Record<string, string>,
  stdinText: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const args =
    process.versions.bun !== undefined
      ? [ENGINE_ENTRY, "auth-set", providerId]
      : ["--disable-warning=ExperimentalWarning", ENGINE_ENTRY, "auth-set", providerId];
  const child = spawn(process.execPath, args, { stdio: ["pipe", "pipe", "pipe"], env });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (c: string) => (stdout += c));
  child.stderr.setEncoding("utf8").on("data", (c: string) => (stderr += c));
  child.stdin.end(stdinText);
  return new Promise((resolve) => {
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("A2 bin e2e: `madc-engine auth-set` intercepts before any JSONL session, stores via the fake keychain, stdout stays empty", async () => {
  const root = mkdtempSync(join(tmpdir(), "madc-a2-bin-"));
  try {
    const shims = writeKeychainShims(join(root, "bin"));
    const accounts = join(root, "accounts");
    mkdirSync(accounts, { recursive: true });
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    const env = {
      ...keychainEnv(shims, accounts, "darwin"),
      MADC_DEV_ENV_KEYS: "1",
      MADC_HOME: home,
      HOME: root,
    };
    const r = await spawnBinAuthSet("kimi-code", env, `${SYNTHETIC}\n`);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, "", "engine stdout stays empty — the protocol stream is never involved");
    assert.equal(readFileSync(join(accounts, "kimi-code"), "utf8"), SYNTHETIC);
    assert.match(r.stderr, /credential stored for kimi-code/);
    assert.ok(!r.stdout.includes(SYNTHETIC) && !r.stderr.includes(SYNTHETIC));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("A2 bin e2e: without a TTY and without the flag the one-shot refuses (exit 2) and writes nothing — not even to $MADC_HOME", async () => {
  const root = mkdtempSync(join(tmpdir(), "madc-a2-bin-"));
  try {
    const shims = writeKeychainShims(join(root, "bin"));
    const accounts = join(root, "accounts");
    mkdirSync(accounts, { recursive: true });
    const home = join(root, "home", "nested"); // never created by auth-set
    const env = {
      ...keychainEnv(shims, accounts, "darwin"),
      MADC_HOME: home,
      HOME: root,
    };
    const r = await spawnBinAuthSet("kimi-code", env, `${SYNTHETIC}\n`);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /without a TTY/);
    assert.equal(existsSync(join(accounts, "kimi-code")), false);
    assert.equal(existsSync(home), false, "auth-set never creates or writes $MADC_HOME");
    assert.ok(!r.stdout.includes(SYNTHETIC) && !r.stderr.includes(SYNTHETIC));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("A2 bin e2e: a forbidden lane is refused (exit 4) before any prompt or stdin read", async () => {
  const root = mkdtempSync(join(tmpdir(), "madc-a2-bin-"));
  try {
    const shims = writeKeychainShims(join(root, "bin"));
    const accounts = join(root, "accounts");
    mkdirSync(accounts, { recursive: true });
    const env = {
      ...keychainEnv(shims, accounts, "darwin"),
      MADC_DEV_ENV_KEYS: "1",
      HOME: root,
    };
    const r = await spawnBinAuthSet("chatgpt-token-replay", env, `${SYNTHETIC}\n`);
    assert.equal(r.code, 4);
    assert.match(r.stderr, /forbidden lane/);
    assert.equal(existsSync(join(accounts, "chatgpt-token-replay")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("A2 bin e2e: the JSONL engine still starts for every other invocation (auth-set is the only intercepted subcommand)", async () => {
  // A regression guard for the bin interception: with no `auth-set` argv the bin must start the
  // stdio protocol server (an initialize round-trip answers), not the one-shot.
  const root = mkdtempSync(join(tmpdir(), "madc-a2-bin-"));
  try {
    const home = join(root, "home");
    const args =
      process.versions.bun !== undefined
        ? [ENGINE_ENTRY]
        : ["--disable-warning=ExperimentalWarning", ENGINE_ENTRY];
    const child = spawn(process.execPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { MADC_HOME: home, HOME: root, MADC_TEST_KEYCHAIN_PLATFORM: "win32" },
    });
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (c: string) => (stdout += c));
    child.stdin.write(
      `${JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "t", version: "0" } } })}\n`,
    );
    const answered = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 15_000);
      const check = (): void => {
        if (stdout.includes('"protocolVersion"')) {
          clearTimeout(timer);
          resolve(true);
        }
      };
      child.stdout.on("data", check);
      check();
    });
    child.stdin.end();
    await new Promise((resolve) => child.on("close", resolve));
    assert.ok(answered, "the default invocation still serves the JSONL protocol");
    assert.match(stdout, /"madc-m1\/1"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Guard against accidental fixture drift: the account file layout the fake keychain writes. */
test("A2 fake keychain fixture: account files are 0600 and hold exactly the stored bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "madc-a2-fake-"));
  try {
    const shims = writeKeychainShims(join(root, "bin"));
    const accounts = join(root, "accounts");
    const store = createCredentialStore({
      env: keychainEnv(shims, accounts, "linux"),
    });
    await store.set("kimi-code", SYNTHETIC);
    const path = join(accounts, "kimi-code");
    assert.equal(readFileSync(path, "utf8"), SYNTHETIC);
    if (process.platform !== "win32") {
      assert.equal(statSync(path).mode & 0o777, 0o600);
    }
    writeFileSync(path, "rotated", { mode: 0o600 });
    assert.equal(await store.get("kimi-code"), "rotated");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
