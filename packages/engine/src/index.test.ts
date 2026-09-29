import assert from "node:assert/strict";
import { test } from "node:test";
import * as engine from "./index.ts";
import * as sdk from "./sdk.ts";

test("engine public surface exports protocol constants, host, and client SDK", () => {
  assert.equal(engine.PROTOCOL_VERSION, "madc-m1/1");
  assert.equal(engine.SERVER_NAME, "madc-engine");
  assert.equal(engine.DEFAULT_SEAT_ID, "madc-default");
  assert.equal(typeof engine.runEngine, "function");
  assert.equal(typeof engine.spawnEngine, "function");
  assert.equal(engine.echoAgent.name, "echo");
  // A4: the seed writer doctor --init reuses, and the home report helper.
  assert.equal(typeof engine.seedDefaultSeat, "function");
  // M1-A7: the roster seed writer and the `seat/list` projection are host surface too.
  assert.equal(typeof engine.seedRosterSeats, "function");
  assert.equal(typeof engine.seedSeatFile, "function");
  assert.equal(typeof engine.listSeatSummaries, "function");
  assert.equal(engine.ROSTER_SEATS.length, 5);
  assert.equal(typeof engine.inspectMadcHome, "function");
  assert.equal(typeof engine.verifySessionFile, "function");
  // M1-A2: the credential store and the one-shot auth-set runner are host surface.
  assert.equal(typeof engine.runAuthSet, "function");
  assert.equal(typeof engine.createCredentialStore, "function");
  assert.equal(typeof engine.credentialEnvVar, "function");
  assert.equal(engine.MADC_DEV_ENV_KEYS, "MADC_DEV_ENV_KEYS");
  assert.equal(engine.KEYCHAIN_SERVICE, "madc");
});

test("@madc/engine/client (CLI surface) carries no engine loop or agents", () => {
  assert.equal(typeof sdk.spawnEngine, "function");
  // M1-A2: the CLI spawns the one-shot `madc-engine auth-set` child through the SDK; the store
  // itself (and the runner) stay host-side, so the CLI never touches a credential value.
  assert.equal(typeof sdk.spawnAuthSet, "function");
  assert.equal(sdk.ErrorCode.TurnAlreadyActive, -32004);
  for (const hostOnly of [
    "runEngine",
    "EngineConnection",
    "echoAgent",
    "startStdioEngine",
    "SessionWriter",
    "seedDefaultSeat",
    // M1-A7: the CLI reaches seats through the `seat/list` method, never through the writer or the
    // host-side projection.
    "seedSeatFile",
    "seedRosterSeats",
    "listSeatSummaries",
    "runAuthSet",
    "createCredentialStore",
    "defaultAgentFactory",
  ]) {
    assert.equal(Object.hasOwn(sdk, hostOnly), false, `${hostOnly} must not be on the CLI surface`);
  }
});
