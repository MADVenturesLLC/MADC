/**
 * Engine-owned credential store (Act M1-A2, plan §7; protocol pin §2; D-M1-5). Credentials live
 * in the OS keychain, reached as CHILD PROCESSES (`node:child_process` only — no native npm
 * dependency, no new dependency of any kind):
 *
 * - macOS: `security` CLI (`add-generic-password` / `find-generic-password` /
 *   `delete-generic-password`) with the fixed service name `madc` and one account per registry
 *   provider id. Apple's CLI takes the secret via its own `-w` argument; that is the standard OS
 *   mechanism. The prohibition is on secrets in madc's OWN command line, protocol, logs and files.
 * - Linux: `secret-tool` (libsecret) `store` / `lookup` / `clear` with the stable attributes
 *   `service madc provider <providerId>`; the secret goes to `secret-tool store` via STDIN, never
 *   argv.
 *
 * Other platforms have no backend in M1 (Windows keychain is deferred, M1 plan §3): probes answer
 * absent and writes/removes fail; the env fallback below still works where the flag allows it.
 *
 * The store NEVER logs a secret value and never writes one to `$MADC_HOME`, session JSONL or a
 * protocol payload. `get` is engine-internal only; the protocol exposes presence only.
 *
 * Env fallback (pinned development exception, D-M1-5): only when the env var
 * `MADC_DEV_ENV_KEYS=1` may `get` / `status` / `source` additionally resolve a credential from a
 * per-provider environment variable (`kimi-code` keeps M0's `KIMI_API_KEY`; every other provider
 * derives `MADC_API_KEY_<ID uppercased, non-alphanumerics as _>`). When the flag is NOT set, env
 * vars never satisfy credential presence. The keychain always wins over env; the source
 * (`keychain` | `env`) is tracked so `madc doctor` can disclose it.
 *
 * Test seams (mirroring the existing `MADC_TEST_*` knobs; production never sets them):
 * `MADC_TEST_KEYCHAIN_SECURITY` / `MADC_TEST_KEYCHAIN_SECRET_TOOL` replace the backend binary, and
 * `MADC_TEST_KEYCHAIN_PLATFORM` forces the platform selection, so tests drive fake keychain
 * processes with synthetic keys and never touch a real keychain.
 */
import { spawn } from "node:child_process";

/**
 * Where a stored credential resolves from (M1-A2, D-M1-5). Engine-internal presence metadata —
 * never a value, and never a protocol field: `auth/status` on the wire is exactly the pinned
 * `{ providerId, present }` (protocol pin §3.5).
 */
export type CredentialSource = "keychain" | "env";

export const KEYCHAIN_SERVICE = "madc";
export const MADC_DEV_ENV_KEYS = "MADC_DEV_ENV_KEYS";

/** M0's Kimi env mapping, preserved under the D-M1-5 flag. */
const ENV_KEY_BY_PROVIDER: Readonly<Record<string, string>> = Object.freeze({
  "kimi-code": "KIMI_API_KEY",
});

/** Per-provider env var honored ONLY under `MADC_DEV_ENV_KEYS=1` (D-M1-5 dev exception). */
export function credentialEnvVar(providerId: string): string {
  return (
    ENV_KEY_BY_PROVIDER[providerId] ??
    `MADC_API_KEY_${providerId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`
  );
}

export type RunCommandSpec = {
  readonly command: string;
  readonly args: readonly string[];
  /** Written to the child's stdin (`secret-tool store`); the secret never enters argv here. */
  readonly input?: string;
};

/**
 * `code` is the child's exit code, or `null` when the command could not be spawned or had to be
 * killed (timeout). `stdout` may carry a secret on read paths — never log it.
 */
export type RunCommandResult = { readonly code: number | null; stdout: string; stderr: string };

export type RunCommand = (spec: RunCommandSpec) => Promise<RunCommandResult>;

export type CredentialStoreDeps = {
  /** Defaults to `MADC_TEST_KEYCHAIN_PLATFORM` (test seam), else `process.platform`. */
  readonly platform?: string;
  /** Defaults to `process.env` (read live at construction). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Injectable child-process runner (tests drive fake keychain processes). */
  readonly runCommand?: RunCommand;
  /** Backend binary overrides; default to the `MADC_TEST_*` seams, then the OS tool names. */
  readonly securityCommand?: string;
  readonly secretToolCommand?: string;
};

export type CredentialStore = {
  /** Presence only. An existing-but-empty keychain record counts as present. */
  status(providerId: string): Promise<boolean>;
  /**
   * Where the credential resolves from, or null when absent. Engine-internal presence metadata
   * (the pinned `auth/status` wire shape is `{ providerId, present }` only).
   */
  source(providerId: string): Promise<CredentialSource | null>;
  /**
   * Engine-internal only — never exposed via the protocol. An existing keychain record wins:
   * a readable one (even empty) is returned as-is; an UNREADABLE one (failed or timed-out read
   * while the probe says present) answers null. The `MADC_DEV_ENV_KEYS=1` env fallback applies
   * ONLY when the keychain probe says absent. Callers validate usability.
   */
  get(providerId: string): Promise<string | null>;
  set(providerId: string, secret: string): Promise<void>;
  remove(providerId: string): Promise<void>;
};

/** Upper bound on one keychain invocation; a hung backend fails instead of stalling the engine. */
const COMMAND_TIMEOUT_MS = 10_000;

/**
 * Spawn one keychain child. `env` is the store's own environment record (production:
 * `process.env`, so forwarding it is equivalent to inheritance; tests: the seam env that carries
 * `MADC_TEST_KEYCHAIN_DIR` to the fake keychain child).
 */
function defaultRunCommand(
  spec: RunCommandSpec,
  env: Readonly<Record<string, string | undefined>>,
): Promise<RunCommandResult> {
  return new Promise((resolve) => {
    const child = spawn(spec.command, [...spec.args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: env as NodeJS.ProcessEnv,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, COMMAND_TIMEOUT_MS);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", () => finish(null));
    // `close`, not `exit`: Node may emit `exit` before the child's last stdout chunk is delivered,
    // which would read an existing record as "" (found by M1-A5 CI). `close` waits for stdio.
    child.on("close", (code) => finish(code));
    // A dead child's stdin errors with EPIPE; the exit path above already settled the outcome.
    child.stdin.on("error", () => undefined);
    child.stdin.end(spec.input ?? "");
  });
}

type KeychainBackend = {
  /** Presence only — implementations must not print the secret (`find-generic-password` without `-w`). */
  probe(providerId: string): Promise<boolean>;
  /**
   * Readable record → its value (an empty record reads as `""`). ABSENT or UNREADABLE (non-zero
   * exit, timeout → code null) → null; null therefore does NOT prove absence — `get` consults
   * `probe` before any env fallback so status/source/get stay in agreement (PR #34 hold).
   */
  read(providerId: string): Promise<string | null>;
  write(providerId: string, secret: string): Promise<void>;
  /** Idempotent: removing an absent entry succeeds. */
  remove(providerId: string): Promise<void>;
};

/** macOS `security` CLI. Exit 44 (errSecItemNotFound) = absent. */
function darwinBackend(run: RunCommand, command: string): KeychainBackend {
  return {
    async probe(providerId) {
      const r = await run({
        command,
        args: ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", providerId],
      });
      return r.code === 0;
    },
    async read(providerId) {
      const r = await run({
        command,
        args: ["find-generic-password", "-w", "-s", KEYCHAIN_SERVICE, "-a", providerId],
      });
      if (r.code !== 0) return null;
      // `security -w` prints the password followed by one newline it adds itself.
      return r.stdout.endsWith("\n") ? r.stdout.slice(0, -1) : r.stdout;
    },
    async write(providerId, secret) {
      const r = await run({
        command,
        args: [
          "add-generic-password",
          "-U",
          "-s",
          KEYCHAIN_SERVICE,
          "-a",
          providerId,
          "-w",
          secret,
        ],
      });
      if (r.code !== 0)
        throw new Error(`keychain write failed (security exited ${String(r.code)})`);
    },
    async remove(providerId) {
      const r = await run({
        command,
        args: ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", providerId],
      });
      if (r.code !== 0 && r.code !== 44) {
        throw new Error(`keychain delete failed (security exited ${String(r.code)})`);
      }
    },
  };
}

/** Linux `secret-tool` (libsecret). The secret travels via stdin on `store`, never argv. */
function linuxBackend(run: RunCommand, command: string): KeychainBackend {
  const attrs = (providerId: string): readonly string[] => [
    "service",
    KEYCHAIN_SERVICE,
    "provider",
    providerId,
  ];
  return {
    async probe(providerId) {
      const r = await run({ command, args: ["lookup", ...attrs(providerId)] });
      return r.code === 0;
    },
    async read(providerId) {
      const r = await run({ command, args: ["lookup", ...attrs(providerId)] });
      // `secret-tool lookup` prints the stored bytes verbatim (no added newline).
      return r.code === 0 ? r.stdout : null;
    },
    async write(providerId, secret) {
      const r = await run({
        command,
        args: ["store", `--label=madc ${providerId}`, ...attrs(providerId)],
        input: secret,
      });
      if (r.code !== 0) {
        throw new Error(`keychain write failed (secret-tool exited ${String(r.code)})`);
      }
    },
    async remove(providerId) {
      const r = await run({ command, args: ["clear", ...attrs(providerId)] });
      // Exit 1 = nothing matched (already absent); remove stays idempotent.
      if (r.code !== 0 && r.code !== 1) {
        throw new Error(`keychain delete failed (secret-tool exited ${String(r.code)})`);
      }
    },
  };
}

/** No keychain backend on this platform in M1 (Windows is deferred, M1 plan §3). */
const unavailableBackend: KeychainBackend = {
  probe: () => Promise.resolve(false),
  read: () => Promise.resolve(null),
  write: () =>
    Promise.reject(
      new Error("no OS keychain backend on this platform (M1 supports macOS and Linux)"),
    ),
  remove: () =>
    Promise.reject(
      new Error("no OS keychain backend on this platform (M1 supports macOS and Linux)"),
    ),
};

/**
 * Build the store. The child-process runner and platform are injectable so tests drive fake
 * keychain processes with synthetic keys; production wiring uses the real defaults.
 */
export function createCredentialStore(deps: CredentialStoreDeps = {}): CredentialStore {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? env.MADC_TEST_KEYCHAIN_PLATFORM ?? process.platform;
  // The default runner forwards THIS env record to the keychain child: in production that is
  // process.env (equivalent to inheritance); under test seams it carries MADC_TEST_KEYCHAIN_DIR
  // to the fake keychain without mutating the test process's environment.
  const run: RunCommand = deps.runCommand ?? ((spec) => defaultRunCommand(spec, env));
  const backend =
    platform === "darwin"
      ? darwinBackend(run, deps.securityCommand ?? env.MADC_TEST_KEYCHAIN_SECURITY ?? "security")
      : platform === "linux"
        ? linuxBackend(
            run,
            deps.secretToolCommand ?? env.MADC_TEST_KEYCHAIN_SECRET_TOOL ?? "secret-tool",
          )
        : unavailableBackend;

  /** D-M1-5: env satisfies presence only under the exact flag value "1". */
  const envValue = (providerId: string): string | null => {
    if (env[MADC_DEV_ENV_KEYS] !== "1") return null;
    const raw = env[credentialEnvVar(providerId)]?.trim() ?? "";
    return raw === "" ? null : raw;
  };

  return Object.freeze({
    async status(providerId) {
      return (await backend.probe(providerId)) || envValue(providerId) !== null;
    },
    async source(providerId) {
      if (await backend.probe(providerId)) return "keychain";
      return envValue(providerId) !== null ? "env" : null;
    },
    async get(providerId) {
      // Agreement rules (PR #34 Witness hold 5345049106 + Copilot 4126239668):
      // 1. A successfully read record always wins — even an empty one (returned as-is; usability
      //    is the caller's check: readKimiCredential rejects "" → -32008 no-credentials).
      // 2. A FAILED read is not absence. The darwin `read` (`find-generic-password -w`) is a
      //    different command from `probe` (the same lookup without `-w`) and can fail (exit ≠ 0,
      //    timeout → code null) on an EXISTING record. The probe — the same call status() and
      //    source() answer from — decides: record present but unreadable → null. The env
      //    fallback NEVER supersedes an existing record, readable or not.
      // 3. Only when the probe says absent does the MADC_DEV_ENV_KEYS=1 env fallback apply.
      const stored = await backend.read(providerId);
      if (stored !== null) return stored;
      if (await backend.probe(providerId)) return null;
      return envValue(providerId);
    },
    set(providerId, secret) {
      return backend.write(providerId, secret);
    },
    remove(providerId) {
      return backend.remove(providerId);
    },
  });
}
