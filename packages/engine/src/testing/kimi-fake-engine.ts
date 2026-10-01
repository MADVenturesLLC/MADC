/**
 * Test fixture: the production provider agent (seat from `$MADC_HOME/seats`, registry + credential
 * preflight, real pi-ai Kimi Code port) with an in-process fake transport instead of the network.
 * The base URL is a `.invalid` host (RFC 6761: never resolves), so even a missing fake could not
 * reach a real endpoint.
 *
 * - `MADC_TEST_KIMI_REPLY`: JSON `FakeKimiReply` (default: a short successful stream).
 * - `MADC_TEST_WIRE_LOG`: file that receives one JSON line per provider request (headers, body).
 * - `MADC_TEST_TOOL_OUTPUT`: when set, each turn first emits a fixture `toolCall` + `toolResult`
 *   whose output is this text (redaction tests: secrets in tool output).
 */
import { appendFileSync } from "node:fs";
import { createKimiCodePort, honestUserAgent, readKimiCredential } from "@madc/adapters";
import { createFakeKimiTransport, type FakeKimiReply } from "@madc/adapters/testing";
import type { Agent } from "../agent.ts";
import { startStdioEngine } from "../main.ts";
import { createProviderAgent } from "../provider-agent.ts";
import { applyRegistryTestClock } from "./registry-test-clock.ts";

applyRegistryTestClock();

import { ENGINE_VERSION } from "../server.ts";

export const FAKE_KIMI_BASE_URL = "https://kimi-fake.invalid/coding";

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

const provider = createProviderAgent({
  credential: readKimiCredential(process.env),
  createPort: (apiKey) =>
    createKimiCodePort({
      apiKey,
      userAgent: honestUserAgent(ENGINE_VERSION),
      baseUrl: FAKE_KIMI_BASE_URL,
      fetch: recordingFetch,
    }),
  log: (line) => process.stderr.write(`[madc-engine] ${line}\n`),
});

const toolOutput = process.env.MADC_TEST_TOOL_OUTPUT;
const agent: Agent =
  toolOutput === undefined
    ? provider
    : {
        ...provider,
        name: "provider+fixture-tool",
        async run(ctx, sink) {
          const callId = sink.newItemId();
          const call = {
            id: callId,
            kind: "toolCall",
            status: "completed",
            name: "fixture_tool",
            arguments: {},
          } as const;
          sink.startItem(call);
          sink.completeItem(call);
          const result = {
            id: sink.newItemId(),
            kind: "toolResult",
            status: "completed",
            callId,
            name: "fixture_tool",
            output: toolOutput,
            isError: false,
          } as const;
          sink.startItem(result);
          sink.completeItem(result);
          await provider.run(ctx, sink);
        },
      };

await startStdioEngine(agent);
