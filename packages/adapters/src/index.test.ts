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

test("adapters export the Claude Code vendor backing (A5)", () => {
  assert.equal(adapters.CLAUDE_CODE_PROVIDER_ID, "claude-code");
  assert.equal(adapters.CLAUDE_BINARY_NAME, "claude");
  assert.equal(typeof adapters.createClaudeCodePort, "function");
  assert.equal(typeof adapters.findClaudeBinary, "function");
  assert.equal(typeof adapters.resolveClaudePinnedModel, "function");
});
