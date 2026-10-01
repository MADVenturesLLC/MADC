/**
 * Test fixture (Act M1-A6): the production provider agent with grok-build wired over the generic
 * ACP client and the `fake-acp-agent.ts` fixture child (plus codex over its fake, so tests can
 * prove the M0 vendor path is unaffected). No real `grok` binary, no network, no credentials.
 *
 * - `MADC_TEST_GROK_BINARY`: reported as the detected `grok` path at preflight; unset → the binary
 *   is missing and grok-build turns refuse with -32008 `binary-missing`.
 * - `MADC_TEST_ACP_MODE` / `MADC_TEST_ACP_WIRE_LOG` / `MADC_TEST_ACP_ARGV_LOG`: fixture-child
 *   behavior and recording (see `packages/adapters/src/testing/fake-acp-agent.ts`).
 * - `MADC_TEST_GROK_SPAWN_ERROR`: when set, the grok spawn emits ENOENT instead of running the
 *   fixture child — the binary vanishing between preflight and spawn (protocol pin §4.2).
 * - `MADC_TEST_CODEX_BINARY` / `MADC_TEST_CODEX_MODE`: as in `codex-fake-engine.ts`.
 */
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createCodexCodePort, createGrokBuildPort } from "@madc/adapters";
import { createFakeAcpSpawn, createFakeCodexSpawn } from "@madc/adapters/testing";
import { startStdioEngine } from "../main.ts";
import { createProviderAgent } from "../provider-agent.ts";
import { applyRegistryTestClock } from "./registry-test-clock.ts";

applyRegistryTestClock();

import { ENGINE_VERSION } from "../server.ts";

/** Behaves like node's ENOENT: an `error` event, silent stdio, no result. */
function vanishingSpawn(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  const fakeStream = () =>
    Object.assign(new EventEmitter(), { setEncoding: () => undefined }) as unknown as NonNullable<
      ChildProcess["stdout"]
    >;
  child.stdout = fakeStream();
  child.stderr = fakeStream();
  child.stdin = Object.assign(new EventEmitter(), {
    write: () => true,
  }) as unknown as NonNullable<ChildProcess["stdin"]>;
  child.kill = () => true;
  const err = new Error("spawn grok ENOENT") as NodeJS.ErrnoException;
  err.code = "ENOENT";
  queueMicrotask(() => child.emit("error", err));
  return child;
}

const grokSpawn =
  process.env.MADC_TEST_GROK_SPAWN_ERROR === undefined ? createFakeAcpSpawn() : vanishingSpawn;

const provider = createProviderAgent({
  createCodexPort: (binaryPath) =>
    createCodexCodePort({
      binaryPath,
      spawn: createFakeCodexSpawn(),
      clientVersion: ENGINE_VERSION,
    }),
  detectCodexBinary: () => process.env.MADC_TEST_CODEX_BINARY ?? null,
  // Production options except the spawn seam: the real trailing-update window and the real
  // XAI_API_KEY presence test on the (hermetic) environment.
  createGrokPort: (binaryPath) =>
    createGrokBuildPort({ binaryPath, spawn: grokSpawn, clientVersion: ENGINE_VERSION }),
  detectGrokBinary: () => process.env.MADC_TEST_GROK_BINARY ?? null,
  log: (line) => process.stderr.write(`[madc-engine] ${line}\n`),
});

await startStdioEngine(provider);
