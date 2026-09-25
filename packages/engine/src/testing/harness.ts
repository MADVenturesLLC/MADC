/** Shared test helpers: temp MADC_HOME + engine spawn. Not a test file itself. */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ENGINE_ENTRY, EngineClient, spawnEngine } from "../client.ts";
import type { InitializeResult } from "../protocol/types.ts";

export const HANG_ENGINE = fileURLToPath(new URL("./hang-agent-engine.ts", import.meta.url));
export const FAILING_ENGINE = fileURLToPath(new URL("./failing-agent-engine.ts", import.meta.url));
export const EXIT_ENGINE = fileURLToPath(new URL("./exit-engine.ts", import.meta.url));

export function makeHome(): { home: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "madc-a2-"));
  const home = join(root, "home");
  return { home, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export function startEngine(home: string, entry?: string): EngineClient {
  return spawnEngine(
    entry === undefined ? { env: { MADC_HOME: home } } : { env: { MADC_HOME: home }, entry },
  );
}

/**
 * Like `startEngine`, but stderr is piped and captured (tests that assert what reaches the logs).
 * Production spawns keep stderr inherited (protocol pin §2).
 */
export function startEngineCapturingStderr(
  home: string,
  entry: string = ENGINE_ENTRY,
): { client: EngineClient; stderr: () => string } {
  const args =
    process.versions.bun !== undefined ? [entry] : ["--disable-warning=ExperimentalWarning", entry];
  const child = spawn(process.execPath, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, MADC_HOME: home },
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
