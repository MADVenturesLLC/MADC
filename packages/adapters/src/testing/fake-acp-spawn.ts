/**
 * Test-only spawn seam for the generic ACP client (Act M1-A6): every "binary" run is a real child
 * process of the current runtime executing `fake-acp-agent.ts`, so abort/kill, exit codes, and the
 * stdio JSON-RPC link are exercised exactly as with a vendor ACP agent — on Node and Bun alike.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AcpSpawn } from "../vendor/acp-client/client.ts";

/** Absolute path of the fake ACP agent fixture script. */
export const FAKE_ACP_AGENT_ENTRY = fileURLToPath(new URL("./fake-acp-agent.ts", import.meta.url));

/** Sentinel binary path handed to the port; the fake spawn ignores it and runs the fixture. */
export const FAKE_GROK_BINARY = "/fake/bin/grok";

/**
 * An `AcpSpawn` that runs `fake-acp-agent.ts` under the current runtime (`node` or `bun`) with the
 * client's args appended, so the fixture sees exactly the argv the adapter builds. `env` extends
 * the inherited environment for the fixture's own knobs only.
 */
export function createFakeAcpSpawn(env: Readonly<Record<string, string>> = {}): AcpSpawn {
  return (_command, args, options) =>
    spawn(process.execPath, [FAKE_ACP_AGENT_ENTRY, ...args], {
      ...options,
      env: { ...process.env, ...options.env, ...env },
    });
}
