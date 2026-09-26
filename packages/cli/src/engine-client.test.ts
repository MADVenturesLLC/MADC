/**
 * Founder allowance A1 (erratum §3e E1) client-level tests: a malformed error body on a reply to
 * a pending request rejects that request with `EngineProtocolError` and never throws inside the
 * readline listener; the `EngineRpcError` constructor never throws on a non-object body. Runs on
 * Node and Bun (the fixture engine runs under the test's own runtime).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  type EngineClient,
  EngineProtocolError,
  EngineRpcError,
  spawnEngine,
} from "@madc/engine/client";

const FAKE = fileURLToPath(new URL("./testing/fake-engine.ts", import.meta.url));

function sandbox(): { home: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "madc-a7e1-"));
  return { home: join(root, "home"), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

async function withFakeClient(
  scenario: string,
  env: Record<string, string>,
  fn: (client: EngineClient) => Promise<void>,
): Promise<void> {
  const sb = sandbox();
  const savedScenario = process.env.MADC_TEST_FAKE_SCENARIO;
  const savedBody = process.env.MADC_TEST_ERROR_BODY;
  try {
    process.env.MADC_TEST_FAKE_SCENARIO = scenario;
    for (const [k, v] of Object.entries(env)) process.env[k] = v;
    const client = spawnEngine({ env: { MADC_HOME: sb.home }, entry: FAKE });
    try {
      await fn(client);
    } finally {
      await client.close(1_000);
    }
  } finally {
    if (savedScenario === undefined) delete process.env.MADC_TEST_FAKE_SCENARIO;
    else process.env.MADC_TEST_FAKE_SCENARIO = savedScenario;
    if (savedBody === undefined) delete process.env.MADC_TEST_ERROR_BODY;
    else process.env.MADC_TEST_ERROR_BODY = savedBody;
    sb.cleanup();
  }
}

test("A1: error null / string / object-without-shape / non-integer code reject with EngineProtocolError", async () => {
  for (const body of ["null", '"x"', "{}", '{"code":1.5,"message":"x"}']) {
    await withFakeClient("e1-client", { MADC_TEST_ERROR_BODY: body }, async (client) => {
      await assert.rejects(
        client.request("initialize", { clientInfo: { name: "t", version: "0" } }),
        (err: unknown) => {
          assert.ok(err instanceof EngineProtocolError, String(err));
          assert.equal((err as Error).message, "malformed error response");
          return true;
        },
        `error body ${body}`,
      );
      // The line is in `messages`, and the client still settles a later request normally.
      assert.ok(
        client.messages.some((m) => Object.hasOwn(m, "error")),
        "the malformed reply is logged",
      );
      const later = await client.request("thread/start", {});
      assert.deepEqual(later, { ok: true });
    });
  }
});

test("A1: an error reply with no pending id throws nothing and settles nothing", async () => {
  await withFakeClient("e1-client-unmatched", {}, async (client) => {
    const r = await client.request("initialize", { clientInfo: { name: "t", version: "0" } });
    assert.deepEqual(r, { ok: true }, "the real answer still settles its request");
    assert.equal(client.messages.length, 2);
    assert.deepEqual(client.messages[0], { id: 999, error: null });
  });
});

test("A1: EngineRpcError never throws on a non-object body; object bodies are copied unchanged", () => {
  for (const body of [null, "x", 5, true]) {
    const err = new EngineRpcError(body as never);
    assert.equal(err.code, -32603, String(body));
    assert.equal(err.message, "malformed error response");
    assert.deepEqual(err.data, { rawError: body });
  }
  const ok = new EngineRpcError({ code: -32008, message: "m", data: { a: 1 } });
  assert.equal(ok.code, -32008);
  assert.equal(ok.message, "m");
  assert.deepEqual(ok.data, { a: 1 });
  const noData = new EngineRpcError({ code: -32603, message: "n" });
  assert.equal(noData.data, undefined);
});
