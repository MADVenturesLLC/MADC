import assert from "node:assert/strict";
import { test } from "node:test";
import { runCli } from "./bin.ts";

test("cli prints MADC_VERSION and returns 0", () => {
  let out = "";
  const code = runCli((s) => {
    out += s;
  });
  assert.equal(code, 0);
  assert.equal(out, "0.0.0\n");
});
