import assert from "node:assert/strict";
import { test } from "node:test";
import { MADC_VERSION } from "./index.ts";

test("placeholder: workspace wiring resolves", () => {
  assert.equal(MADC_VERSION, "0.0.0");
});
