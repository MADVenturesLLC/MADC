/**
 * Test-only spawn seam for the Claude Code adapter (Act M0-A5): every "binary" run is a real
 * child process of the current runtime executing `fake-claude.ts`, so abort/kill, exit codes, and
 * stdout capture are exercised exactly as with the vendor binary — on Node and Bun alike.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ClaudeSpawn } from "../claude-code.ts";

/** Absolute path of the fake `claude` fixture script. */
export const FAKE_CLAUDE_ENTRY = fileURLToPath(new URL("./fake-claude.ts", import.meta.url));

/** Sentinel binary path handed to the port; the fake spawn ignores it and runs the fixture. */
export const FAKE_CLAUDE_BINARY = "/fake/bin/claude";

/**
 * A `ClaudeSpawn` that runs `fake-claude.ts` under the current runtime (`node` or `bun`) with the
 * adapter's args appended, so the fixture sees exactly the argv the adapter builds.
 */
export function createFakeClaudeSpawn(): ClaudeSpawn {
  return (_command, args, options) =>
    spawn(process.execPath, [FAKE_CLAUDE_ENTRY, ...args], {
      ...options,
      env: { ...process.env, ...options.env },
    });
}
