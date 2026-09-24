import assert from "node:assert/strict";
import { test } from "node:test";
import { ADAPTERS_PLACEHOLDER } from "./index.ts";

test("adapters placeholder export resolves", () => {
  assert.equal(ADAPTERS_PLACEHOLDER, "adapters");
});
