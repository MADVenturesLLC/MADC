/**
 * Test fixture: the production provider agent (built-in seat, registry + credential preflight,
 * real pi-ai Kimi Code port) with an in-process fake transport instead of the network. The base URL
 * is a `.invalid` host (RFC 6761: never resolves), so even a missing fake could not reach a real
 * endpoint.
 *
 * - `MADC_TEST_KIMI_REPLY`: JSON `FakeKimiReply` (default: a short successful stream).
 * - `MADC_TEST_WIRE_LOG`: file that receives one JSON line per provider request (headers, body).
 * - `MADC_TEST_SEAT_JSON`: JSON seat-field overrides (honesty tests for refusal paths).
 */
import { appendFileSync } from "node:fs";
import { createKimiCodePort, honestUserAgent, readKimiCredential } from "@madc/adapters";
import { createFakeKimiTransport, type FakeKimiReply } from "@madc/adapters/testing";
import { startStdioEngine } from "../main.ts";
import { createProviderAgent } from "../provider-agent.ts";
import { type EngineSeat, MADC_DEFAULT_SEAT } from "../seat.ts";
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
const overrides = JSON.parse(process.env.MADC_TEST_SEAT_JSON ?? "{}") as Partial<EngineSeat>;
const seat: EngineSeat = { ...MADC_DEFAULT_SEAT, ...overrides };

await startStdioEngine(({ home }) =>
  createProviderAgent({
    home,
    seat,
    credential: readKimiCredential(process.env),
    createPort: (apiKey) =>
      createKimiCodePort({
        apiKey,
        userAgent: honestUserAgent(ENGINE_VERSION),
        baseUrl: FAKE_KIMI_BASE_URL,
        fetch: recordingFetch,
      }),
    log: (line) => process.stderr.write(`[madc-engine] ${line}\n`),
  }),
);
