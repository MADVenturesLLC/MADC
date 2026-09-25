/** Shared test helpers: temp MADC_HOME + engine spawn. Not a test file itself. */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EngineClient, spawnEngine, withoutUndefined } from "../client.ts";
import type { InitializeResult } from "../protocol/types.ts";

export const ECHO_ENGINE = fileURLToPath(new URL("./echo-engine.ts", import.meta.url));
export const KIMI_FAKE_ENGINE = fileURLToPath(new URL("./kimi-fake-engine.ts", import.meta.url));
export const HANG_ENGINE = fileURLToPath(new URL("./hang-agent-engine.ts", import.meta.url));
export const FAILING_ENGINE = fileURLToPath(new URL("./failing-agent-engine.ts", import.meta.url));
export const EXIT_ENGINE = fileURLToPath(new URL("./exit-engine.ts", import.meta.url));

export function makeHome(): { home: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "madc-a2-"));
  const home = join(root, "home");
  return { home, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Credential-looking names never reach a test engine unless a test sets them explicitly. */
const SECRET_ENV_NAME = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i;

/**
 * Hermetic child env: the developer's ambient credentials (e.g. a real `KIMI_API_KEY`) are removed,
 * then `extra` is applied. Tests can therefore never pick up or leak a real key.
 */
export function hermeticEnv(
  extra: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const name of Object.keys(process.env)) {
    if (SECRET_ENV_NAME.test(name)) env[name] = undefined;
  }
  return { ...env, ...extra };
}

/** Spawns a test engine (default: the echo fixture) with a hermetic env. */
export function startEngine(
  home: string,
  entry: string = ECHO_ENGINE,
  extraEnv: Record<string, string | undefined> = {},
): EngineClient {
  return spawnEngine({ env: hermeticEnv({ ...extraEnv, MADC_HOME: home }), entry });
}

/**
 * Like `startEngine`, but stderr is piped and captured (tests that assert what reaches the logs).
 * Production spawns keep stderr inherited (protocol pin §2).
 */
export function startEngineCapturingStderr(
  home: string,
  entry: string = ECHO_ENGINE,
  extraEnv: Record<string, string | undefined> = {},
): { client: EngineClient; stderr: () => string } {
  const args =
    process.versions.bun !== undefined ? [entry] : ["--disable-warning=ExperimentalWarning", entry];
  const child = spawn(process.execPath, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: withoutUndefined({ ...process.env, ...hermeticEnv({ ...extraEnv, MADC_HOME: home }) }),
  });
  let captured = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    captured += chunk;
  });
  return { client: new EngineClient(child), stderr: () => captured };
}

export async function handshake(client: EngineClient): Promise<InitializeResult> {
  const result = await client.request("initialize", {
    clientInfo: { name: "madc-test", version: "0.0.0" },
  });
  client.notify("initialized", {});
  return result;
}

/** Run `fn` with a fresh MADC_HOME and engine; always closes the engine and deletes the dir. */
export async function withEngine(
  fn: (client: EngineClient, home: string) => Promise<void>,
  entry?: string,
): Promise<void> {
  const { home, cleanup } = makeHome();
  const client = startEngine(home, entry);
  try {
    await fn(client, home);
  } finally {
    await client.close();
    cleanup();
  }
}

export async function expectRpcError(
  promise: Promise<unknown>,
): Promise<{ code: number; data: Record<string, unknown> | undefined }> {
  try {
    await promise;
  } catch (err) {
    const e = err as { code?: unknown; data?: Record<string, unknown> };
    if (typeof e.code === "number") return { code: e.code, data: e.data };
    throw err;
  }
  throw new Error("expected an RPC error response");
}
