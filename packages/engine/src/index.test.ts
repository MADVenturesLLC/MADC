import assert from "node:assert/strict";
import { test } from "node:test";
import { ENGINE_PLACEHOLDER } from "./index.ts";

test("engine placeholder export resolves", () => {
  assert.equal(ENGINE_PLACEHOLDER, "engine");
});
