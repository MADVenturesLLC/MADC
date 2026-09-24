import assert from "node:assert/strict";
import { test } from "node:test";
import { REGISTRY_PLACEHOLDER } from "./index.ts";

test("registry placeholder export resolves", () => {
  assert.equal(REGISTRY_PLACEHOLDER, "registry");
});
