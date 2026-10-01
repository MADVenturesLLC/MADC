/**
 * Test fixture (Act M0-A5): the production provider agent with BOTH M0 backings wired over fakes —
 * Kimi Code via the in-process fake transport (`.invalid` base URL, like `kimi-fake-engine.ts`)
 * and claude-code via the `fake-claude.ts` fixture child. No real `claude` binary, no network,
 * no credentials.
 *
 * - `MADC_TEST_KIMI_REPLY` / `MADC_TEST_WIRE_LOG`: as in `kimi-fake-engine.ts`.
 * - `MADC_TEST_CLAUDE_BINARY`: reported as the detected `claude` path at preflight; unset → the
 *   binary is missing and claude-code turns refuse with -32008 `binary-missing`.
 * - `MADC_TEST_CLAUDE_MODE` / `MADC_TEST_CLAUDE_ARGV_LOG`: fixture-child behavior / argv recording
 *   (see `packages/adapters/src/testing/fake-claude.ts`).
 * - `MADC_TEST_CLAUDE_SPAWN_ERROR`: when set, the claude spawn emits ENOENT instead of running the
 *   fixture child — the binary vanishing between preflight and spawn (protocol pin §4.2).
 */
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { appendFileSync } from "node:fs";
import {
  createClaudeCodePort,
  createKimiCodePort,
  honestUserAgent,
  readKimiCredential,
} from "@madc/adapters";
import {
  createFakeClaudeSpawn,
  createFakeKimiTransport,
  type FakeKimiReply,
} from "@madc/adapters/testing";
import { startStdioEngine } from "../main.ts";
import { createProviderAgent } from "../provider-agent.ts";
import { applyRegistryTestClock } from "./registry-test-clock.ts";

applyRegistryTestClock();

import { ENGINE_VERSION } from "../server.ts";

/** Same never-resolving host as `kimi-fake-engine.ts` (defined there; it is a side-effecting entry). */
const FAKE_KIMI_BASE_URL = "https://kimi-fake.invalid/coding";

const reply = process.env.MADC_TEST_KIMI_REPLY;
const transport = createFakeKimiTransport(
  reply === undefined ? undefined : (JSON.parse(reply) as FakeKimiReply),
);
const wireLog = process.env.MADC_TEST_WIRE_LOG;
const recordingFetch: typeof globalThis.fetch = async (input, init) => {
  const seen = transport.requests.length;
  try {
    return await transport.fetch(input, init);
  } finally {
    const request = transport.requests[seen];
    if (wireLog !== undefined && request !== undefined) {
      appendFileSync(wireLog, `${JSON.stringify(request)}\n`);
    }
  }
};

/** Behaves like node's ENOENT: an `error` event, silent stdio, no result. */
function vanishingSpawn(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  const fakeStream = () =>
    Object.assign(new EventEmitter(), { setEncoding: () => undefined }) as unknown as NonNullable<
      ChildProcess["stdout"]
    >;
  child.stdout = fakeStream();
  child.stderr = fakeStream();
  child.kill = () => true;
  const err = new Error("spawn claude ENOENT") as NodeJS.ErrnoException;
  err.code = "ENOENT";
  queueMicrotask(() => child.emit("error", err));
  return child;
}

const claudeSpawn =
  process.env.MADC_TEST_CLAUDE_SPAWN_ERROR === undefined ? createFakeClaudeSpawn() : vanishingSpawn;

const provider = createProviderAgent({
  credential: readKimiCredential(process.env),
  createPort: (apiKey) =>
    createKimiCodePort({
      apiKey,
      userAgent: honestUserAgent(ENGINE_VERSION),
      baseUrl: FAKE_KIMI_BASE_URL,
      fetch: recordingFetch,
    }),
  createClaudePort: (binaryPath) => createClaudeCodePort({ binaryPath, spawn: claudeSpawn }),
  detectClaudeBinary: () => process.env.MADC_TEST_CLAUDE_BINARY ?? null,
  log: (line) => process.stderr.write(`[madc-engine] ${line}\n`),
});

await startStdioEngine(provider);
