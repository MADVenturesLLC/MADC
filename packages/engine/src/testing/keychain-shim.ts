/**
 * Test helper (M1-A2): shim scripts that make the REAL child-process path of the credential store
 * drive `fake-keychain.ts` instead of the OS tools. `MADC_TEST_KEYCHAIN_SECURITY` /
 * `MADC_TEST_KEYCHAIN_SECRET_TOOL` point at the shims, `MADC_TEST_KEYCHAIN_PLATFORM` pins the
 * backend selection and `MADC_TEST_KEYCHAIN_DIR` is the fake's account-file directory, so tests
 * exercise `security` / `secret-tool` command shapes end to end with SYNTHETIC keys only and never
 * touch a real keychain. Not a test file itself; no import side effects.
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const FAKE_KEYCHAIN = fileURLToPath(new URL("./fake-keychain.ts", import.meta.url));

export type KeychainShims = {
  /** Executable standing in for the macOS `security` CLI. */
  readonly security: string;
  /** Executable standing in for the Linux `secret-tool`. */
  readonly secretTool: string;
};

/** Write both shims into `dir` (`exec <runtime> fake-keychain.ts <tool> "$@"`); returns their paths. */
export function writeKeychainShims(dir: string): KeychainShims {
  mkdirSync(dir, { recursive: true });
  const runtime = process.execPath;
  const flags = process.versions.bun !== undefined ? "" : "--disable-warning=ExperimentalWarning ";
  const write = (name: string, tool: string): string => {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\nexec "${runtime}" ${flags}"${FAKE_KEYCHAIN}" ${tool} "$@"\n`, {
      mode: 0o755,
    });
    chmodSync(path, 0o755); // writeFileSync's mode is umask-filtered; the execute bits are required
    return path;
  };
  return {
    security: write("security-shim", "security"),
    secretTool: write("secret-tool-shim", "secret-tool"),
  };
}

/**
 * The env seams that point a store (or a spawned engine child) at the fake keychain for one
 * platform shape. Pass through `createCredentialStore({ env })` or a harness `extraEnv`.
 */
export function keychainEnv(
  shims: KeychainShims,
  accountDir: string,
  platform: "darwin" | "linux",
): Record<string, string> {
  return platform === "darwin"
    ? {
        MADC_TEST_KEYCHAIN_PLATFORM: "darwin",
        MADC_TEST_KEYCHAIN_SECURITY: shims.security,
        MADC_TEST_KEYCHAIN_DIR: accountDir,
      }
    : {
        MADC_TEST_KEYCHAIN_PLATFORM: "linux",
        MADC_TEST_KEYCHAIN_SECRET_TOOL: shims.secretTool,
        MADC_TEST_KEYCHAIN_DIR: accountDir,
      };
}
