/**
 * M1-A2 acceptance — the engine-owned credential store: macOS `security` and Linux `secret-tool`
 * driven as CHILD PROCESSES (no native npm dependency), the pinned `MADC_DEV_ENV_KEYS=1`
 * development exception (D-M1-5), and the no-backend platform path. Every backend call here goes
 * through the fake keychain shims with SYNTHETIC keys only — never a real keychain, never a real
 * credential.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { keychainEnv, writeKeychainShims } from "../testing/keychain-shim.ts";
import {
  createCredentialStore,
  credentialEnvVar,
  KEYCHAIN_SERVICE,
  MADC_DEV_ENV_KEYS,
  type RunCommand,
  type RunCommandSpec,
} from "./store.ts";

const SYNTHETIC = "sk-synthetic-store-test-0123456789abcdef";
const SYNTHETIC_2 = "xai-synthetic-store-test-0123456789";

/** Temp root + fake keychain (shims + account dir) for one platform shape. */
function fakeKeychain(platform: "darwin" | "linux"): {
  env: Record<string, string>;
  accountFile: (providerId: string) => string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "madc-a2-store-"));
  const shims = writeKeychainShims(join(root, "bin"));
  const accounts = join(root, "accounts");
  mkdirSync(accounts, { recursive: true });
  return {
    env: keychainEnv(shims, accounts, platform),
    accountFile: (providerId) => join(accounts, encodeURIComponent(providerId)),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Records every child-process spec and answers a fixed result (no real children). */
function recordingRun(answer: { code: number | null; stdout?: string; stderr?: string }): {
  run: RunCommand;
  specs: RunCommandSpec[];
} {
  const specs: RunCommandSpec[] = [];
  return {
    specs,
    run: async (spec) => {
      specs.push(spec);
      return { code: answer.code, stdout: answer.stdout ?? "", stderr: answer.stderr ?? "" };
    },
  };
}

// ------------------------------------------------------------------ darwin (macOS `security`)

test("A2 darwin: set/get/status/source/remove round-trip through a fake `security` child process", async () => {
  const kc = fakeKeychain("darwin");
  try {
    const store = createCredentialStore({ env: kc.env });
    assert.equal(await store.status("kimi-code"), false);
    assert.equal(await store.source("kimi-code"), null);
    assert.equal(await store.get("kimi-code"), null);

    await store.set("kimi-code", SYNTHETIC);
    assert.equal(readFileSync(kc.accountFile("kimi-code"), "utf8"), SYNTHETIC);
    assert.equal(await store.status("kimi-code"), true);
    assert.equal(await store.source("kimi-code"), "keychain");
    // `security find-generic-password -w` adds one trailing newline; the store strips exactly it.
    assert.equal(await store.get("kimi-code"), SYNTHETIC);

    await store.remove("kimi-code");
    assert.equal(existsSync(kc.accountFile("kimi-code")), false);
    assert.equal(await store.status("kimi-code"), false);
    await store.remove("kimi-code"); // idempotent: exit 44 (errSecItemNotFound) is tolerated
  } finally {
    kc.cleanup();
  }
});

test("A2 darwin: the fixed service name and one account per registry id (command shape)", async () => {
  const rec = recordingRun({ code: 0 });
  const store = createCredentialStore({ platform: "darwin", env: {}, runCommand: rec.run });
  await store.set("xai-api", SYNTHETIC_2);
  assert.deepEqual(rec.specs, [
    {
      command: "security",
      args: [
        "add-generic-password",
        "-U",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        "xai-api",
        "-w",
        SYNTHETIC_2,
      ],
    },
  ]);
  // Presence probes never ask for the value (no `-w` on the probe path).
  await store.status("xai-api");
  const probe = rec.specs.at(-1);
  assert.deepEqual(probe?.args, ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", "xai-api"]);
});

// ------------------------------------------------------------------- linux (`secret-tool`)

test("A2 linux: set/get/remove round-trip through a fake `secret-tool`; the secret travels via stdin, never argv", async () => {
  const kc = fakeKeychain("linux");
  try {
    const store = createCredentialStore({ env: kc.env });
    assert.equal(await store.status("xai-api"), false);
    await store.set("xai-api", SYNTHETIC_2);
    assert.equal(readFileSync(kc.accountFile("xai-api"), "utf8"), SYNTHETIC_2);
    assert.equal(await store.source("xai-api"), "keychain");
    // `secret-tool lookup` prints the stored bytes verbatim (no added newline to strip).
    assert.equal(await store.get("xai-api"), SYNTHETIC_2);
    await store.remove("xai-api");
    assert.equal(existsSync(kc.accountFile("xai-api")), false);
    await store.remove("xai-api"); // idempotent: exit 1 (nothing matched) is tolerated
  } finally {
    kc.cleanup();
  }
});

test("A2 linux: stable attributes, stdin-borne secret, and no secret in argv (command shape)", async () => {
  const rec = recordingRun({ code: 0 });
  const store = createCredentialStore({ platform: "linux", env: {}, runCommand: rec.run });
  await store.set("minimax-token-plan", SYNTHETIC);
  const spec = rec.specs[0];
  assert.equal(spec?.command, "secret-tool");
  assert.deepEqual(spec?.args, [
    "store",
    "--label=madc minimax-token-plan",
    "service",
    KEYCHAIN_SERVICE,
    "provider",
    "minimax-token-plan",
  ]);
  assert.equal(spec?.input, SYNTHETIC);
  assert.ok(
    spec !== undefined && !spec.args.some((a) => a.includes(SYNTHETIC)),
    "the secret never enters argv on the linux backend",
  );
});

// ------------------------------------------------------- env fallback (D-M1-5 dev exception)

/** win32 platform = no keychain backend: isolates the env-fallback logic (no children spawn). */
function envOnlyStore(env: Record<string, string | undefined>) {
  return createCredentialStore({ platform: "win32", env });
}

test('A2 env fallback: absent unless MADC_DEV_ENV_KEYS is exactly "1" (D-M1-5)', async () => {
  const key = SYNTHETIC;
  assert.equal(await envOnlyStore({ KIMI_API_KEY: key }).status("kimi-code"), false);
  assert.equal(await envOnlyStore({ KIMI_API_KEY: key }).get("kimi-code"), null);
  for (const flag of ["0", "true", "yes", ""]) {
    const store = envOnlyStore({ [MADC_DEV_ENV_KEYS]: flag, KIMI_API_KEY: key });
    assert.equal(await store.status("kimi-code"), false, `flag "${flag}" must not enable env`);
    assert.equal(await store.get("kimi-code"), null);
  }
  const on = envOnlyStore({ [MADC_DEV_ENV_KEYS]: "1", KIMI_API_KEY: `  ${key}  ` });
  assert.equal(await on.status("kimi-code"), true);
  assert.equal(await on.source("kimi-code"), "env");
  assert.equal(await on.get("kimi-code"), key, "the value is trimmed");
  const blank = envOnlyStore({ [MADC_DEV_ENV_KEYS]: "1", KIMI_API_KEY: "   " });
  assert.equal(await blank.status("kimi-code"), false, "a blank env value is not a credential");
});

test("A2 env fallback: the keychain always wins over env", async () => {
  const kc = fakeKeychain("darwin");
  try {
    writeFileSync(kc.accountFile("kimi-code"), SYNTHETIC, { mode: 0o600 });
    const store = createCredentialStore({
      env: { ...kc.env, [MADC_DEV_ENV_KEYS]: "1", KIMI_API_KEY: SYNTHETIC_2 },
    });
    assert.equal(await store.source("kimi-code"), "keychain");
    assert.equal(await store.get("kimi-code"), SYNTHETIC);
  } finally {
    kc.cleanup();
  }
});

test("A2 credentialEnvVar: M0's KIMI_API_KEY is preserved; every other id derives MADC_API_KEY_<ID>", () => {
  assert.equal(credentialEnvVar("kimi-code"), "KIMI_API_KEY");
  assert.equal(credentialEnvVar("xai-api"), "MADC_API_KEY_XAI_API");
  assert.equal(credentialEnvVar("alibaba-coding-plan"), "MADC_API_KEY_ALIBABA_CODING_PLAN");
  assert.equal(credentialEnvVar("minimax-token-plan"), "MADC_API_KEY_MINIMAX_TOKEN_PLAN");
});

test("A2 env fallback: derived per-provider vars resolve only under the flag", async () => {
  const store = envOnlyStore({
    [MADC_DEV_ENV_KEYS]: "1",
    MADC_API_KEY_XAI_API: SYNTHETIC_2,
  });
  assert.equal(await store.source("xai-api"), "env");
  assert.equal(await store.get("xai-api"), SYNTHETIC_2);
  assert.equal(await store.status("kimi-code"), false);
});

// ------------------------------------------------------------- platform + failure semantics

test("A2 platform without a backend: probes answer absent, writes and removes fail, env fallback still works under the flag", async () => {
  const store = envOnlyStore({});
  assert.equal(await store.status("kimi-code"), false);
  assert.equal(await store.get("kimi-code"), null);
  await assert.rejects(() => store.set("kimi-code", SYNTHETIC), /no OS keychain backend/);
  await assert.rejects(() => store.remove("kimi-code"), /no OS keychain backend/);
  const flagged = envOnlyStore({ [MADC_DEV_ENV_KEYS]: "1", KIMI_API_KEY: SYNTHETIC });
  assert.equal(await flagged.get("kimi-code"), SYNTHETIC);
});

test("A2 failures never throw on probes and never carry the secret: a missing backend binary answers absent", async () => {
  const store = createCredentialStore({
    platform: "darwin",
    env: {},
    securityCommand: join(tmpdir(), "madc-a2-definitely-missing-security"),
  });
  assert.equal(await store.status("kimi-code"), false); // spawn ENOENT → absent, no throw
  assert.equal(await store.get("kimi-code"), null);
  await assert.rejects(
    () => store.set("kimi-code", SYNTHETIC),
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      assert.match(message, /keychain write failed/);
      assert.ok(!message.includes(SYNTHETIC), "the failure message never carries the secret");
      return true;
    },
  );
});

test("A2 a killed or unspawnable backend (code null) reads as absent and fails writes", async () => {
  const rec = recordingRun({ code: null });
  const store = createCredentialStore({ platform: "darwin", env: {}, runCommand: rec.run });
  assert.equal(await store.status("kimi-code"), false);
  assert.equal(await store.get("kimi-code"), null);
  await assert.rejects(() => store.set("kimi-code", SYNTHETIC), /security exited null/);
});

test("A2 a nonzero backend exit fails the write with the exit code only", async () => {
  const rec = recordingRun({ code: 3, stderr: SYNTHETIC_2 }); // stderr echoing the secret stays inside
  const store = createCredentialStore({ platform: "linux", env: {}, runCommand: rec.run });
  await assert.rejects(
    () => store.set("xai-api", SYNTHETIC),
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      assert.equal(message, "keychain write failed (secret-tool exited 3)");
      return true;
    },
  );
});
