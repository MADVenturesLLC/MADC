import assert from "node:assert/strict";
import { test } from "node:test";
import * as engine from "./index.ts";
import * as sdk from "./sdk.ts";

test("engine public surface exports protocol constants, host, and client SDK", () => {
  assert.equal(engine.PROTOCOL_VERSION, "madc-m0/1");
  assert.equal(engine.SERVER_NAME, "madc-engine");
  assert.equal(engine.DEFAULT_SEAT_ID, "madc-default");
  assert.equal(typeof engine.runEngine, "function");
  assert.equal(typeof engine.spawnEngine, "function");
  assert.equal(engine.echoAgent.name, "echo");
});

test("@madc/engine/client (CLI surface) carries no engine loop or agents", () => {
  assert.equal(typeof sdk.spawnEngine, "function");
  assert.equal(sdk.ErrorCode.TurnAlreadyActive, -32004);
  for (const hostOnly of ["runEngine", "EngineConnection", "echoAgent", "startStdioEngine"]) {
    assert.equal(Object.hasOwn(sdk, hostOnly), false, `${hostOnly} must not be on the CLI surface`);
  }
});
