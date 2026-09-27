/**
 * Test-only spawn seam for the Codex adapter (Act M0-A6): every "binary" run is a real child
 * process of the current runtime executing `fake-codex.ts`, so abort/kill, exit codes, and the
 * stdio JSON-RPC link are exercised exactly as with the vendor binary — on Node and Bun alike.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { CodexSpawn } from "../codex.ts";

/** Absolute path of the fake `codex app-server` fixture script. */
export const FAKE_CODEX_ENTRY = fileURLToPath(new URL("./fake-codex.ts", import.meta.url));

/** Sentinel binary path handed to the port; the fake spawn ignores it and runs the fixture. */
export const FAKE_CODEX_BINARY = "/fake/bin/codex";

/**
 * A `CodexSpawn` that runs `fake-codex.ts` under the current runtime (`node` or `bun`) with the
 * adapter's args appended, so the fixture sees exactly the argv the adapter builds.
 */
export function createFakeCodexSpawn(): CodexSpawn {
  return (_command, args, options) =>
    spawn(process.execPath, [FAKE_CODEX_ENTRY, ...args], {
      ...options,
      env: { ...process.env, ...options.env },
    });
}
