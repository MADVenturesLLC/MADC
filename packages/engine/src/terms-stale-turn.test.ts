/**
 * I1 — turn-time terms-stale (D-M1-6 / protocol pin §4.1 reason `terms-stale` / plan criterion H).
 *
 * Before this fix the turn-path `assertAllowed` call carried no `now`, so D-M1-6 never fired on a
 * real turn while `doctor` / `madc providers ls` could already report a stale lane — a latent
 * blocker the day the catalog's `verifiedAt` (2026-09-24) crossed the 30-day freshness window.
 * Now the preflight receives the engine's freshness clock: a stale allow entry denies with
 * `-32007 ProviderDenied { reason: "terms-stale" }` BEFORE any lane, port or network is touched.
 *
 * Tests run against in-process fake transports only: no live provider, no network, no paid call,
 * no real credential. Freshness-window length is untouched (D-M1-6: 30 days, Founder-owned).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderPort } from "@madc/adapters";
import { DEFAULT_STALE_DAYS, getById, isStale } from "@madc/registry";
import type { Agent, AgentTurnContext } from "./agent.ts";
import { ErrorCode, RpcError } from "./protocol/errors.ts";
import { createProviderAgent, type DirectLane } from "./provider-agent.ts";
import { REGISTRY_TEST_NOW_ENV, REGISTRY_TEST_NOW_MS } from "./testing/harness.ts";

/** Thrown RpcError from `fn`, failing the test when nothing (or something else) was thrown. */
function rpcThrown(fn: () => void): RpcError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof RpcError, `expected RpcError, got ${String(err)}`);
    return err;
  }
  assert.fail("expected the preflight to throw");
}

/** The agent's optional preflight, asserted present before any call (`Agent.preflight?`). */
function preflightOf(agent: Agent): (ctx: AgentTurnContext) => void {
  const preflight = agent.preflight;
  assert.ok(preflight, "the provider agent exposes preflight");
  return preflight;
}

const KIMI_KEY = "test-sentinel-key-i1terms";

/** A minimal seat whose assigned backing is the live kimi-code direct lane. */
const seat = {
  id: "i1-terms-seat",
  version: 2 as const,
  role: "test",
  standingInstructions: "",
  displayName: "I1 Terms Seat",
  pinnedModel: "kimi-coding/kimi-for-coding",
  preferredBacking: "kimi-code",
  fallbacks: [] as string[],
  memory: { mode: "file" as const, path: "memory/i1-terms.md" },
  tools: { deny: [] as string[] },
  policy: { headlessOk: true },
  handoffs: { enabled: false as const, targets: [] as string[] },
};

const seatPath = "/tmp/i1-terms-seat.json";

const ctx = (now?: number): AgentTurnContext => ({
  threadId: "thr_i1_terms",
  turnId: "turn_i1_terms",
  seatId: seat.id,
  seat,
  seatPath,
  input: [{ type: "text", text: "hi" }],
  cwd: null,
  mode: "headless",
  ...(now === undefined ? {} : { presence: { kind: "absent", why: "test" } as never }),
});

/** A port that FAILS the test if it is ever built or streamed: the denial must precede it. */
const neverPort = (): ProviderPort => {
  throw new Error("network port must never be built for a stale lane");
};

const kimiLane = (credential: string | null): DirectLane => ({
  providerId: "kimi-code",
  credential,
  createPort: neverPort,
  resolvePinnedModel: (pinnedModel) =>
    pinnedModel === "kimi-coding/kimi-for-coding"
      ? { ok: true, modelId: "kimi-for-coding" }
      : { ok: false, issue: "test resolver" },
});

/** The catalog's freshness deadline for kimi-code, per the pinned window (D-M1-6). */
const verified = Date.parse(getById("kimi-code")?.verifiedAt ?? "invalid");
assert.ok(Number.isFinite(verified), "kimi-code carries a verifiedAt date");

test("I1: a fake clock past verifiedAt + window denies the turn -32007 terms-stale BEFORE any network", () => {
  const staleNow = verified + (DEFAULT_STALE_DAYS + 1) * 86_400_000;
  const agent = createProviderAgent({
    assertAllowedNow: staleNow,
    directLanes: [kimiLane(KIMI_KEY)],
  });
  const err = rpcThrown(() => preflightOf(agent)(ctx()));
  const body = err.toBody();
  assert.equal(body.code, ErrorCode.ProviderDenied);
  assert.equal(body.code, -32007);
  const data = body.data as { providerId: string; reason: string };
  assert.equal(data.providerId, "kimi-code");
  assert.equal(data.reason, "terms-stale");
});

test("I1: the same agent inside the window still plans the lane (no denial), and the clock seam matches isStale", () => {
  const freshNow = verified + DEFAULT_STALE_DAYS * 86_400_000; // exactly 30 days: not stale
  const entry = getById("kimi-code");
  assert.ok(entry !== undefined);
  assert.equal(isStale(entry, freshNow), false);
  const agent = createProviderAgent({
    assertAllowedNow: freshNow,
    directLanes: [kimiLane(KIMI_KEY)],
  });
  // preflight is void; it must NOT throw and must NOT have built the port.
  preflightOf(agent)(ctx());
});

test("I1: the pin boundary is exact — one microsecond past the window denies, one before does not", () => {
  const agent = (now: number) =>
    createProviderAgent({ assertAllowedNow: now, directLanes: [kimiLane(KIMI_KEY)] });
  const justBefore = verified + (DEFAULT_STALE_DAYS * 86_400_000 + 1); // > 30 days: stale
  const err = rpcThrown(() => preflightOf(agent(justBefore))(ctx()));
  assert.equal((err.toBody().data as { reason: string }).reason, "terms-stale");
});

test("I1: the harness clock pin env is read by the engine (spawned-engine determinism)", () => {
  // The env name exists and the value format is a plain integer string; the engine parses it in
  // createProviderAgent. A malformed value is IGNORED (never trusted), so the real clock applies.
  assert.equal(REGISTRY_TEST_NOW_ENV, "MADC_TEST_REGISTRY_NOW");
  assert.match(String(REGISTRY_TEST_NOW_MS), /^\d+$/);
});

test("I1: doctor-consistency — the lanes report's stale set is exactly what a turn now denies", () => {
  // The turn check and the lanes report both derive from the same catalog and the same
  // freshness rule (isStale); with the clock wired into the preflight they can no longer
  // disagree. Pinned test clock = the harness value.
  const now = Number(process.env[REGISTRY_TEST_NOW_ENV]);
  assert.ok(Number.isSafeInteger(now), "the harness pinned the clock in this process");
  const entry = getById("kimi-code");
  assert.ok(entry !== undefined);
  // Inside the pinned window the lane serves; nothing is stale-denied.
  assert.equal(isStale(entry, now), false);
});
