import assert from "node:assert/strict";
import { test } from "node:test";
import * as adapters from "./index.ts";

test("adapters export the provider seam and the Kimi Code backing (A3)", () => {
  assert.equal(adapters.KIMI_CODE_PROVIDER_ID, "kimi-code");
  assert.equal(adapters.KIMI_PI_PROVIDER, "kimi-coding");
  assert.equal(typeof adapters.createKimiCodePort, "function");
  assert.equal(typeof adapters.ProviderCallError, "function");
  assert.ok(!("ADAPTERS_PLACEHOLDER" in adapters));
});
