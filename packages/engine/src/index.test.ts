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
  // M2-A1 (evidence schema v2): the refusal code, the reserved set, the link check, the doctor
  // findings and the engine-owned worktree identity are host surface.
  assert.equal(engine.ErrorCode.EvidenceInvalid, -32010);
  assert.deepEqual([...engine.RESERVED_EVENT_TYPES], ["memory.write", "tool.call"]);
  assert.equal(typeof engine.inspectSessionV2, "function");
  assert.equal(typeof engine.checkHandoffTarget, "function");
  assert.equal(typeof engine.resolveWorktreeIdentity, "function");
  assert.equal(typeof engine.validateForWrite, "function");
  assert.equal(typeof engine.SessionChainIndex, "function");
});

test("@madc/engine/client (CLI surface) carries no engine loop or agents", () => {
  assert.equal(typeof sdk.spawnEngine, "function");
  // M1-A2: the CLI spawns the one-shot `madc-engine auth-set` child through the SDK; the store
  // itself (and the runner) stay host-side, so the CLI never touches a credential value.
  assert.equal(typeof sdk.spawnAuthSet, "function");
  assert.equal(sdk.ErrorCode.TurnAlreadyActive, -32004);
  // M2-A1: the CLI classifies -32010 (exit table) and reads doctor findings through
  // `inspectMadcHome`; it never gets the writer, the index or the link check.
  assert.equal(sdk.ErrorCode.EvidenceInvalid, -32010);
  for (const hostOnly of [
    "runEngine",
    "EngineConnection",
    "echoAgent",
    "startStdioEngine",
    "SessionWriter",
    "SessionChainIndex",
    "checkHandoffTarget",
    "inspectSessionV2",
    "resolveWorktreeIdentity",
    "seedDefaultSeat",
    // M1-A7: the CLI never reaches the seed writer. (M1-A8 moved `listSeatSummaries` onto the
    // surface, read-only, for doctor — see the next test.)
    "seedSeatFile",
    "seedRosterSeats",
    "runAuthSet",
    "createCredentialStore",
    "defaultAgentFactory",
  ]) {
    assert.equal(Object.hasOwn(sdk, hostOnly), false, `${hostOnly} must not be on the CLI surface`);
  }
});

test("M1-A8: the CLI surface adds only read-only seat listing and pure registry policy", () => {
  // `madc seats ls` calls the `seat/list` METHOD. Doctor cannot: an engine start seeds the roster
  // and tightens modes in the real $MADC_HOME, and plain doctor is read-only there (CLI pin §3). It
  // therefore reads the same projection through the same function, read-only, in its bounded child.
  assert.equal(sdk.listSeatSummaries, engine.listSeatSummaries);
  assert.equal(typeof sdk.canServe, "function");
  assert.equal(sdk.DEFAULT_STALE_DAYS, 30);
});
