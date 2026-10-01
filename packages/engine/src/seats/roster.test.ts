/**
 * M1-A7 acceptance — the seeded roster (seat pin §3 S3 / M1 plan §6), the v2 file schema and its
 * v1 migration (S2), the `seat/list` projection (protocol pin §3.5 P4), and the D-M1-7 same-lane
 * rule run against the seeded cells. Mock transports and synthetic keys only: no live provider, no
 * network, no paid call, no real credential.
 *
 * Two coverage limits are stated rather than papered over:
 *
 * 1. `plan-interactive` → `payg` is covered at the predicate level. Both ids (`minimax-token-plan`,
 *    `minimax-payg`) are `wired: false` until M1-A5, so S1/S2 refuse a seat file that names either
 *    one (-32006 at load) and `assertAllowed(requireLive)` refuses a turn on them. There is
 *    therefore no seat and no turn this build could run that pair through; the rule itself is the
 *    unit under test, and it is the same predicate the turn-time walk calls.
 * 2. `surface-architect` gets no served turn here. Every engine turn in this build is `headless`
 *    (provider-agent `TURN_MODE`; mode attestation is M1-A5, which this act must not start) and
 *    `ollama-cloud` ships `headless: "denied"` (D-M1-3), so its pinned A7 behaviour is the refusal
 *    before any provider request — asserted below — plus its own memory path at thread/start.
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  ProviderCallError,
  type ProviderPort,
  type ProviderTurnResult,
  resolveKimiPinnedModel,
} from "@madc/adapters";
import { getById, type ProviderEntry } from "@madc/registry";
import type { AgentTurnContext, TurnSink } from "../agent.ts";
import { ErrorCode, RpcError } from "../protocol/errors.ts";
import type { Item, SeatListParams, ServedModelItem, Turn } from "../protocol/types.ts";
import { createProviderAgent, type DirectLane } from "../provider-agent.ts";
import { type EngineSeat, MADC_DEFAULT_SEAT } from "../seat.ts";
import { loadSeat, seedSeatFile, serializeSeat } from "../seat-store.ts";
import { type FallbackRejectedPayload, verifySessionFile } from "../session-store.ts";
import {
  CODEX_FAKE_ENGINE,
  DIRECT_FAKE_ENGINE,
  ECHO_ENGINE,
  expectRpcError,
  handshake,
  makeHome,
  seatFileBody,
  startEngineCapturingStderr,
  writeSeatFile,
} from "../testing/harness.ts";
import { laneMismatch, neverEligibleFallbacks } from "./lane.ts";
import { ensureSeatMemoryFile } from "./memory.ts";
import {
  DAEDALUS_SEAT,
  HEPHAESTUS_SEAT,
  PROMETHEUS_SEAT,
  ROSTER_SEATS,
  SURFACE_ARCHITECT_SEAT,
  seedRosterSeats,
} from "./roster.ts";

const POSIX = process.platform !== "win32";
const KIMI_KEY = "test-sentinel-key-a7roster";
const OLLAMA_KEY = "ollama-sentinel-key-a7roster";
/** The model id this act locks for `surface-architect` (planning record OLL-17 / OLL-19). */
const OLLAMA_MODEL = "gpt-oss:120b";
const FAKE_CLAUDE_BINARY = "/fake/bin/claude";
const FAKE_CODEX_BINARY = "/fake/bin/codex";

/** The five seeded ids, and the plan §6 cell each one must reproduce. */
const ROSTER = [
  {
    id: "daedalus",
    version: 2,
    displayName: "Daedalus",
    role: "architect",
    preferredBacking: "claude-code",
    pinnedModel: "claude-sonnet-4-5",
    fallbacks: ["kimi-code"],
    headlessOk: true,
  },
  {
    id: "hephaestus",
    version: 2,
    displayName: "Hephaestus",
    role: "builder",
    preferredBacking: "codex",
    pinnedModel: "gpt-5.1-codex",
    fallbacks: ["claude-code"],
    headlessOk: true,
  },
  {
    id: "prometheus",
    version: 2,
    displayName: "Prometheus",
    role: "idea and research",
    preferredBacking: "kimi-code",
    pinnedModel: "kimi-coding/kimi-for-coding",
    fallbacks: [],
    headlessOk: true,
  },
  {
    id: "surface-architect",
    version: 2,
    displayName: "Surface Architect",
    role: "contracts and pins",
    preferredBacking: "ollama-cloud",
    pinnedModel: `ollama-cloud/${OLLAMA_MODEL}`,
    fallbacks: [],
    headlessOk: false,
  },
  {
    id: "madc-default",
    version: 1,
    displayName: null,
    role: "general builder",
    preferredBacking: "kimi-code",
    pinnedModel: "kimi-coding/kimi-for-coding",
    fallbacks: [],
    headlessOk: true,
  },
] as const;

const ROSTER_IDS = ROSTER.map((seat) => seat.id);

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

function readSeat(home: string, id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(home, "seats", `${id}.json`), "utf8")) as Record<
    string,
    unknown
  >;
}

function sessionEvents(home: string, threadId: string): Array<Record<string, unknown>> {
  return readFileSync(join(home, "sessions", `${threadId}.jsonl`), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function entry(id: string): ProviderEntry {
  const found = getById(id);
  assert.ok(found, `${id} is a catalog id`);
  return found;
}

// --------------------------------------------------------------------------- seeding (S3, §8.1)

test("A7: a fresh $MADC_HOME seeds exactly the five roster seats with the plan §6 cells (S3)", () => {
  const { home, cleanup } = makeHome();
  try {
    const report = seedRosterSeats(home);
    assert.deepEqual(report.failures, [], "no seat was refused");
    assert.deepEqual(
      report.seats.map((s) => s.created),
      [true, true, true, true, true],
      "all five were created",
    );
    assert.deepEqual(
      report.seats.map((s) => s.path.split("/").pop()),
      ROSTER_IDS.map((id) => `${id}.json`),
      "seeded in seat pin §3 order",
    );
    assert.deepEqual(
      readdirSync(join(home, "seats")).sort(),
      ROSTER_IDS.map((id) => `${id}.json`).sort(),
      "exactly the five roster seats, and nothing else",
    );

    for (const expected of ROSTER) {
      const onDisk = readSeat(home, expected.id);
      assert.equal(onDisk.version, expected.version, expected.id);
      assert.equal(onDisk.role, expected.role, expected.id);
      assert.equal(onDisk.preferredBacking, expected.preferredBacking, expected.id);
      assert.equal(onDisk.pinnedModel, expected.pinnedModel, expected.id);
      assert.deepEqual(
        onDisk.policy,
        { headlessOk: expected.headlessOk },
        `${expected.id} headlessOk`,
      );
      // Its OWN memory path (plan A7 forbidden: "shared memory between seats").
      assert.deepEqual(
        onDisk.memory,
        { mode: "file", path: `memory/${expected.id}.md` },
        `${expected.id} memory`,
      );
      assert.deepEqual(
        onDisk.handoffs,
        { enabled: false, targets: [] },
        `${expected.id} handoffs stay disabled`,
      );
      // `displayName` and `fallbacks` are v2 FILE keys. The `madc-default` seed stays the M0 v1
      // file, so it carries neither — its `fallbacks: []` is S2's in-memory migration, which is
      // asserted below against the loaded seat, not against these bytes.
      if (expected.version === 1) {
        assert.equal(Object.hasOwn(onDisk, "displayName"), false, `${expected.id} is a v1 file`);
        assert.equal(Object.hasOwn(onDisk, "fallbacks"), false, `${expected.id} is a v1 file`);
      } else {
        assert.equal(onDisk.displayName, expected.displayName, expected.id);
        assert.deepEqual(onDisk.fallbacks, [...expected.fallbacks], expected.id);
      }
      if (POSIX) assert.equal(mode(join(home, "seats", `${expected.id}.json`)), 0o600, expected.id);
    }
    if (POSIX) {
      for (const sub of ["seats", "sessions", "memory"]) {
        assert.equal(mode(join(home, sub)), 0o700, sub);
      }
    }
    // The v1 seed's in-memory migration (S2): the loaded seat carries the empty list its file
    // does not, and the four v2 seats load with their persisted order.
    assert.deepEqual(loadSeat(home, "madc-default").seat.fallbacks, []);
    assert.deepEqual(loadSeat(home, "daedalus").seat.fallbacks, ["kimi-code"]);
    assert.deepEqual(loadSeat(home, "prometheus").seat.fallbacks, []);
    assert.deepEqual(loadSeat(home, "surface-architect").seat.fallbacks, []);

    // The two cells the act pins by name.
    const daedalus = readSeat(home, "daedalus");
    assert.deepEqual(
      daedalus.fallbacks,
      ["kimi-code"],
      "daedalus keeps kimi-code as written: the hop crosses allowed-via-vendor-agent into " +
        "allowed-direct, so it is always rejected and is never 'fixed' here",
    );
    const surface = readSeat(home, "surface-architect");
    assert.equal(surface.preferredBacking, "ollama-cloud");
    assert.deepEqual(surface.fallbacks, [], "I3 Option B: impossible seed fallback emptied");
    assert.deepEqual(surface.policy, { headlessOk: false }, "D-M1-3 unchanged");
    assert.deepEqual(
      readSeat(home, "prometheus").fallbacks,
      [],
      "I3 Option B: pinnedModel cannot resolve across direct namespaces",
    );

    // The M0 default seat is still the v1 seed, byte for byte.
    assert.equal(
      readFileSync(join(home, "seats", "madc-default.json"), "utf8"),
      serializeSeat(MADC_DEFAULT_SEAT),
    );
  } finally {
    cleanup();
  }
});

test("A7: a second start leaves every seed byte-identical and rewrites nothing (§8.1)", async () => {
  const { home, cleanup } = makeHome();
  const { client, stderr } = startEngineCapturingStderr(home, ECHO_ENGINE);
  try {
    await handshake(client);
    const bytes = new Map(
      ROSTER_IDS.map((id) => [id, readFileSync(join(home, "seats", `${id}.json`))]),
    );
    const mtimes = new Map(
      ROSTER_IDS.map((id) => [id, statSync(join(home, "seats", `${id}.json`)).mtimeMs]),
    );
    await client.close();

    const second = startEngineCapturingStderr(home, ECHO_ENGINE).client;
    try {
      await handshake(second);
      await second.request("seat/list", {});
      for (const id of ROSTER_IDS) {
        const path = join(home, "seats", `${id}.json`);
        assert.deepEqual(readFileSync(path), bytes.get(id), `${id}: byte-identical`);
        assert.equal(statSync(path).mtimeMs, mtimes.get(id), `${id}: not rewritten`);
      }
    } finally {
      await second.close();
    }
    assert.equal(stderr().includes("seed failed"), false, `no seed failure: ${stderr()}`);
  } finally {
    await client.close();
    cleanup();
  }
});

test("A7: an operator-edited roster seat is never overwritten; the missing four still seed", () => {
  const { home, cleanup } = makeHome();
  try {
    const path = writeSeatFile(home, {
      ...seatFileBody(DAEDALUS_SEAT),
      role: "operator-edited role",
    });
    const before = readFileSync(path, "utf8");
    const report = seedRosterSeats(home);
    assert.deepEqual(report.failures, []);
    assert.deepEqual(
      report.seats.map((s) => [s.path.split("/").pop(), s.created]),
      [
        ["daedalus.json", false],
        ["hephaestus.json", true],
        ["prometheus.json", true],
        ["surface-architect.json", true],
        ["madc-default.json", true],
      ],
    );
    assert.equal(readFileSync(path, "utf8"), before, "the operator's file wins");
    assert.equal(readSeat(home, "daedalus").role, "operator-edited role");
  } finally {
    cleanup();
  }
});

test("A7: a refusal on one seat is reported, never passed off as created:false, and never stops the others", () => {
  const { home, cleanup } = makeHome();
  try {
    // A symlink where a seat file belongs: Amendment 3 item 4 makes this an error, never
    // `created:false`, and never a write through the link.
    const outside = join(home, "..", "outside-a7");
    writeSeatFile(outside, seatFileBody(HEPHAESTUS_SEAT));
    writeSeatFile(home, seatFileBody(DAEDALUS_SEAT)); // creates home/seats/
    symlinkSync(join(outside, "seats", "hephaestus.json"), join(home, "seats", "hephaestus.json"));

    const report = seedRosterSeats(home);
    assert.equal(report.failures.length, 1, JSON.stringify(report.failures));
    assert.equal(report.failures[0]?.seatId, "hephaestus");
    assert.match(report.failures[0]?.message ?? "", /symlink|regular file/);
    assert.deepEqual(
      report.seats.map((s) => [s.path.split("/").pop(), s.created]),
      [
        ["daedalus.json", false],
        ["prometheus.json", true],
        ["surface-architect.json", true],
        ["madc-default.json", true],
      ],
      "the other four still landed",
    );
    // The link target outside the home was never written through.
    assert.equal(
      readFileSync(join(outside, "seats", "hephaestus.json"), "utf8"),
      serializeSeat(HEPHAESTUS_SEAT),
    );
  } finally {
    cleanup();
  }
});

// ------------------------------------------------------------- seat/list (protocol pin §3.5 P4)

test("A7: seat/list reports all five seats with the locked projection, and takes no params", async () => {
  const { home, cleanup } = makeHome();
  const { client, stderr } = startEngineCapturingStderr(home, ECHO_ENGINE);
  try {
    await handshake(client);
    const { data } = await client.request("seat/list", {});
    assert.deepEqual(
      data.map((s) => s.id),
      [...ROSTER_IDS].sort(),
      "every seeded seat, sorted by id",
    );
    assert.deepEqual(
      data,
      [...data].sort((a, b) => (a.id < b.id ? -1 : 1)),
      "deterministic order",
    );
    for (const summary of data) assert.equal(summary.ok, true, `${summary.id} loads`);

    const byId = new Map(data.map((s) => [s.id, s]));
    const daedalus = byId.get("daedalus");
    assert.ok(daedalus?.ok);
    assert.deepEqual(
      { ...daedalus, warnings: daedalus.warnings.length },
      {
        id: "daedalus",
        ok: true,
        path: join(home, "seats", "daedalus.json"),
        version: 2,
        displayName: "Daedalus",
        role: "architect",
        pinnedModel: "claude-sonnet-4-5",
        preferredBacking: "claude-code",
        fallbacks: ["kimi-code"],
        memory: { mode: "file", path: "memory/daedalus.md" },
        tools: { deny: ["writes outside docs/**", "git push to main"] },
        policy: { headlessOk: true },
        warnings: 1,
      },
      "the A7 projection of a v2 roster seat",
    );
    // The load warning names both lanes and the pinned reason (seat pin §2).
    assert.match(daedalus.warnings[0] ?? "", /seat daedalus/);
    assert.match(daedalus.warnings[0] ?? "", /fallback kimi-code can never be eligible/);
    assert.match(daedalus.warnings[0] ?? "", /fallback-lane-mismatch/);
    assert.match(daedalus.warnings[0] ?? "", /allowed-via-vendor-agent\/vendor-session/);
    assert.match(daedalus.warnings[0] ?? "", /allowed-direct\/payg/);

    const surface = byId.get("surface-architect");
    assert.ok(surface?.ok);
    assert.equal(surface.pinnedModel, `ollama-cloud/${OLLAMA_MODEL}`);
    assert.deepEqual(surface.policy, { headlessOk: false });
    assert.deepEqual(surface.fallbacks, [], "I3 Option B: empty seed fallbacks");
    assert.deepEqual(surface.warnings, [], "empty fallbacks → no lane-mismatch warning");
    const prometheus = byId.get("prometheus");
    assert.ok(prometheus?.ok);
    assert.deepEqual(prometheus.fallbacks, []);
    assert.deepEqual(prometheus.warnings, [], "empty fallbacks → no warning");

    const hephaestus = byId.get("hephaestus");
    assert.ok(hephaestus?.ok);
    assert.deepEqual(hephaestus.warnings, [], "codex → claude-code is same-lane");

    // A v1 seat projects as v1: no displayName in its schema, and the migrated empty fallbacks.
    const fallbackDefault = byId.get("madc-default");
    assert.ok(fallbackDefault?.ok);
    assert.equal(fallbackDefault.version, 1);
    assert.equal(fallbackDefault.displayName, null);
    assert.deepEqual(fallbackDefault.fallbacks, []);

    // No secret-bearing field exists to leak; assert the projection carries no credential keys.
    for (const summary of data) {
      assert.equal(/key|token|secret|credential|password/i.test(JSON.stringify(summary)), false);
    }

    // The same warning reaches the log when the seat is loaded for a thread (seat pin §2: seat
    // load warns; `seat/list` reports).
    await client.request("thread/start", { seatId: "daedalus" });
    assert.match(stderr(), /fallback kimi-code can never be eligible/);

    // Params are pinned as `{}`: anything else is -32602, so the method can never be handed a value.
    const err = await expectRpcError(
      client.request("seat/list", { providerId: "kimi-code" } as unknown as SeatListParams),
    );
    assert.equal(err.code, ErrorCode.InvalidParams);
    assert.deepEqual(err.data, {
      issues: ["seat/list takes no params (got providerId)"],
    });
  } finally {
    await client.close();
    cleanup();
  }
});

test("A7: seat/list reports a seat file that does not load instead of hiding it", async () => {
  const { home, cleanup } = makeHome();
  const { client } = startEngineCapturingStderr(home, ECHO_ENGINE);
  try {
    writeSeatFile(home, {
      ...seatFileBody(PROMETHEUS_SEAT),
      id: "broken",
      preferredBacking: "zai-glm-coding-plan",
    });
    await handshake(client);
    const { data } = await client.request("seat/list", {});
    const broken = data.find((s) => s.id === "broken");
    assert.ok(broken !== undefined && broken.ok === false);
    assert.equal(broken.code, ErrorCode.SeatInvalid);
    assert.deepEqual(broken.issues, ['preferredBacking "zai-glm-coding-plan" is a forbidden lane']);
    assert.equal(data.filter((s) => s.ok).length, ROSTER_IDS.length, "the roster still lists");
  } finally {
    await client.close();
    cleanup();
  }
});

// ------------------------------------------------------- v2 schema and the v1 migration (S2)

test("A7: a v1 seat file loads as v2 in memory with fallbacks [] and is never rewritten (S2)", () => {
  const { home, cleanup } = makeHome();
  try {
    const path = writeSeatFile(home, { ...seatFileBody(MADC_DEFAULT_SEAT), id: "legacy" });
    const before = readFileSync(path);
    const loaded = loadSeat(home, "legacy");
    assert.equal(loaded.seat.version, 1, "the file's own version is kept");
    assert.deepEqual(loaded.seat.fallbacks, [], "migrated in memory to an empty list");
    assert.equal(loaded.seat.displayName, undefined, "a v1 schema has no displayName");
    assert.deepEqual(loaded.warnings, []);
    assert.deepEqual(readFileSync(path), before, "never rewritten");
    assert.equal(existsSync(join(home, "memory", "legacy.md")), false, "load alone writes nothing");
  } finally {
    cleanup();
  }
});

test("A7: a v2 seat file round-trips through the serializer and loads back identical", () => {
  const { home, cleanup } = makeHome();
  try {
    for (const seat of ROSTER_SEATS) {
      if (seat.version !== 2) continue;
      const path = writeSeatFile(home, seatFileBody(seat), serializeSeat(seat));
      const loaded = loadSeat(home, seat.id);
      assert.deepEqual(
        { ...loaded.seat, fallbacks: [...loaded.seat.fallbacks] },
        {
          ...seat,
          fallbacks: [...seat.fallbacks],
        },
        seat.id,
      );
      assert.equal(readFileSync(path, "utf8"), serializeSeat(seat), `${seat.id} bytes`);
    }
  } finally {
    cleanup();
  }
});

test("A7: a forbidden backing gives -32006 SeatInvalid, and each fallbacks entry is validated like preferredBacking", async () => {
  const { home, cleanup } = makeHome();
  const { client } = startEngineCapturingStderr(home, ECHO_ENGINE);
  try {
    await handshake(client);
    const cases: Array<{ name: string; seat: Record<string, unknown>; issues: string[] }> = [
      {
        name: "forbidden-backing",
        seat: { preferredBacking: "zai-glm-coding-plan" },
        issues: ['preferredBacking "zai-glm-coding-plan" is a forbidden lane'],
      },
      {
        name: "forbidden-fallback",
        seat: { fallbacks: ["zai-glm-coding-plan"] },
        issues: ['fallbacks[0] "zai-glm-coding-plan" is a forbidden lane'],
      },
      {
        name: "unwired-fallback",
        // openrouter is a kept stub no M1 act wires (mistral-pro was this fixture until M1-A4).
        seat: { fallbacks: ["openrouter"] },
        issues: ['fallbacks[0] "openrouter" is not wired in this build'],
      },
      {
        name: "unknown-fallback",
        seat: { fallbacks: ["no-such-provider"] },
        issues: ['fallbacks[0] "no-such-provider" is not a registry provider id'],
      },
      {
        name: "second-fallback-only",
        seat: { fallbacks: ["kimi-code", "openrouter"] },
        issues: ['fallbacks[1] "openrouter" is not wired in this build'],
      },
      {
        name: "fallbacks-not-array",
        seat: { fallbacks: "kimi-code" },
        issues: ["fallbacks must be an array of registry provider ids at version 2"],
      },
    ];
    for (const c of cases) {
      const path = writeSeatFile(home, {
        ...seatFileBody(PROMETHEUS_SEAT),
        id: c.name,
        ...c.seat,
      });
      const err = await expectRpcError(client.request("thread/start", { seatId: c.name }));
      assert.equal(err.code, ErrorCode.SeatInvalid, c.name);
      assert.deepEqual(err.data, { seatId: c.name, path, issues: c.issues }, c.name);
    }
    const sessions = existsSync(join(home, "sessions")) ? readdirSync(join(home, "sessions")) : [];
    assert.deepEqual(sessions, [], "no lock or session file for a refused seat");
  } finally {
    await client.close();
    cleanup();
  }
});

// ----------------------------------------------- one mock turn per seat, each its own memory path

test("A7 e2e: each served roster seat runs one mock turn on its own backing and writes only its own memory path", async () => {
  const { home, cleanup } = makeHome();
  const { client, stderr } = startEngineCapturingStderr(home, CODEX_FAKE_ENGINE, {
    KIMI_API_KEY: KIMI_KEY,
    MADC_TEST_CLAUDE_BINARY: FAKE_CLAUDE_BINARY,
    MADC_TEST_CODEX_BINARY: FAKE_CODEX_BINARY,
  });
  try {
    await handshake(client);
    // One seat at a time: after each thread, that seat's memory file exists and no earlier one
    // changed — the paths are per seat, never shared.
    const served: Array<{ id: string; backing: string; lane: string; pinnedModel: string }> = [
      {
        id: "daedalus",
        backing: "claude-code",
        lane: "allowed-via-vendor-agent",
        pinnedModel: "claude-sonnet-4-5",
      },
      {
        id: "hephaestus",
        backing: "codex",
        lane: "allowed-via-vendor-agent",
        pinnedModel: "gpt-5.1-codex",
      },
      {
        id: "prometheus",
        backing: "kimi-code",
        lane: "allowed-direct",
        pinnedModel: "kimi-coding/kimi-for-coding",
      },
      {
        id: "madc-default",
        backing: "kimi-code",
        lane: "allowed-direct",
        pinnedModel: "kimi-coding/kimi-for-coding",
      },
    ];
    const seen: string[] = [];
    for (const expect of served) {
      const { thread } = await client.request("thread/start", { seatId: expect.id });
      const threadId = thread.id;
      seen.push(expect.id);
      const own = join(home, "memory", `${expect.id}.md`);
      assert.equal(existsSync(own), true, `${expect.id}: its own memory path was written`);
      if (POSIX) assert.equal(mode(own), 0o600, `${expect.id}: memory file is 0600`);
      assert.deepEqual(
        readdirSync(join(home, "memory")).sort(),
        [...seen].map((id) => `${id}.md`).sort(),
        `${expect.id}: no other seat's memory path was touched`,
      );

      const { turn } = await client.request("turn/start", {
        threadId,
        input: [{ type: "text", text: "say hi" }],
      });
      const done = await client.waitFor(
        (m) => m.method === "turn/completed" && (m.params as { turn: Turn }).turn.id === turn.id,
      );
      const final = (done.params as { turn: Turn }).turn;
      assert.equal(final.status, "completed", `${expect.id}: turn completed`);
      const receipt = final.items.find((i) => i.kind === "servedModel") as ServedModelItem;
      assert.equal(receipt.backing, expect.backing, `${expect.id}: served on its own backing`);
      assert.equal(receipt.providerId, expect.backing, expect.id);
      assert.equal(receipt.requestedModel, expect.pinnedModel, expect.id);
      assert.equal(receipt.lane, expect.lane, expect.id);
      assert.equal(receipt.mode, "headless", "every turn in this build is headless (pre-A5)");
      assert.equal(receipt.fallbackFrom, null, `${expect.id}: served on the primary`);
      assert.ok(
        final.items.some((i) => i.kind === "userMessage") &&
          final.items.some((i) => i.kind === "agentMessage"),
        `${expect.id}: user + agent items`,
      );

      // The durable receipt agrees with the wire, and the chain verifies (seat pin §8.4).
      const events = sessionEvents(home, threadId);
      const types = events.map((e) => e.type);
      assert.equal(types[0], "session.open", expect.id);
      assert.equal(types[1], "turn.start", expect.id);
      assert.equal(types.at(-1), "turn.end", expect.id);
      assert.equal(
        types.filter((t) => t === "servedModel").length,
        1,
        `${expect.id}: one durable receipt`,
      );
      assert.ok(
        types.filter((t) => t === "item").length >= 2,
        `${expect.id}: user + agent items are durable`,
      );
      const open = events[0]?.payload as Record<string, unknown>;
      assert.equal(open.backing, expect.backing, expect.id);
      assert.equal(open.pinnedModel, expect.pinnedModel, expect.id);
      const servedEvent = events.find((e) => e.type === "servedModel");
      assert.deepEqual(
        servedEvent?.payload,
        {
          turnId: turn.id,
          requestedModel: expect.pinnedModel,
          servedModel: receipt.servedModel,
          backing: expect.backing,
          providerId: expect.backing,
          lane: expect.lane,
          mode: "headless",
          fallbackFrom: null,
          vendorReported: receipt.vendorReported,
        },
        `${expect.id}: JSONL receipt`,
      );
      assert.equal(
        verifySessionFile(join(home, "sessions", `${threadId}.jsonl`), threadId, {}, home).ok,
        true,
        expect.id,
      );
    }
    assert.equal(stderr().includes("seed failed"), false, stderr());
  } finally {
    await client.close();
    cleanup();
  }
});

test("A7 e2e: surface-architect owns its memory path, and every turn is refused headless-not-permitted before any provider request (D-M1-3/D-M1-4)", async () => {
  const { home, cleanup } = makeHome();
  const wireLog = join(home, "..", "surface-ollama-wire.jsonl");
  const { client } = startEngineCapturingStderr(home, DIRECT_FAKE_ENGINE, {
    KIMI_API_KEY: KIMI_KEY,
    MADC_API_KEY_OLLAMA_CLOUD: OLLAMA_KEY,
    MADC_TEST_OLLAMA_TAGS: JSON.stringify([OLLAMA_MODEL]),
    MADC_TEST_OLLAMA_WIRE_LOG: wireLog,
  });
  try {
    await handshake(client);
    const seeded = readSeat(home, "surface-architect");
    assert.equal(seeded.pinnedModel, `ollama-cloud/${OLLAMA_MODEL}`);
    assert.deepEqual(seeded.policy, { headlessOk: false });

    const { thread } = await client.request("thread/start", { seatId: "surface-architect" });
    const threadId = thread.id;
    // The seat LOADED, so its own memory path exists even though no turn can serve in this build.
    assert.equal(existsSync(join(home, "memory", "surface-architect.md")), true);
    assert.equal(existsSync(join(home, "memory", "prometheus.md")), false, "no other seat's path");

    const err = await expectRpcError(
      client.request("turn/start", { threadId, input: [{ type: "text", text: "x" }] }),
    );
    assert.equal(err.code, ErrorCode.ProviderDenied);
    assert.deepEqual(err.data, {
      providerId: "ollama-cloud",
      status: "allowed-direct",
      reason: "headless-not-permitted",
    });
    assert.equal(existsSync(wireLog), false, "no ollama request left the engine");
    assert.equal(
      sessionEvents(home, threadId).some((e) => e.type === "servedModel"),
      false,
      "a refused turn writes no servedModel receipt",
    );
  } finally {
    await client.close();
    cleanup();
  }
});

// -------------------------------------------------------- fallback receipts (file-driven, S2)

test("A7 e2e: a v2 seat file's persisted fallbacks drive the walk — the primary failure and the served hop both land durably with an honest fallbackFrom", async () => {
  const { home, cleanup } = makeHome();
  const { client } = startEngineCapturingStderr(home, DIRECT_FAKE_ENGINE, {
    KIMI_API_KEY: KIMI_KEY,
    // 429 first (the recorded quota-or-unreachable signal), then a served reply.
    MADC_TEST_KIMI_REPLIES: JSON.stringify([
      { type: "status", status: 429, body: '{"error":"rate limited"}' },
      { type: "stream", chunks: ["served", " by fallback"], model: "kimi-for-coding" },
    ]),
  });
  try {
    // A fixture seat, not a roster edit: `fallbacks` only reaches a FILE at version 2 (S2), which
    // is what this act lands. kimi-code → kimi-code is the one served hop this build can express
    // from a seat file — a seat carries ONE lane-namespaced `pinnedModel`, and S2 pins no
    // per-fallback model field, so no second direct lane can resolve it (see the header note).
    writeSeatFile(home, {
      ...seatFileBody(PROMETHEUS_SEAT),
      id: "fb-served",
      displayName: "Fallback Fixture",
      fallbacks: ["kimi-code"],
      memory: { mode: "file", path: "memory/fb-served.md" },
    });
    await handshake(client);
    const { thread } = await client.request("thread/start", { seatId: "fb-served" });
    const threadId = thread.id;
    const { turn } = await client.request("turn/start", {
      threadId,
      input: [{ type: "text", text: "hi" }],
    });
    const done = await client.waitFor(
      (m) => m.method === "turn/completed" && (m.params as { turn: Turn }).turn.id === turn.id,
    );
    const final = (done.params as { turn: Turn }).turn;
    assert.equal(final.status, "completed");

    // Receipt 1: the primary failure, recorded as an error item naming the signal.
    const errorItem = final.items.find((i) => i.kind === "error") as
      | Extract<Item, { kind: "error" }>
      | undefined;
    assert.ok(errorItem, "the primary failure is recorded");
    assert.match(errorItem.message, /kimi-code/);
    assert.match(errorItem.message, /quota-or-unreachable/);
    assert.equal(errorItem.code, ErrorCode.ProviderUnavailable);
    // Receipt 2: the served hop, with fallbackFrom naming the previous backing.
    const receipt = final.items.find((i) => i.kind === "servedModel") as ServedModelItem;
    assert.equal(receipt.fallbackFrom, "kimi-code", "the hop is never disguised as the primary");
    assert.equal(receipt.lane, "allowed-direct");
    assert.equal(receipt.vendorReported, false);

    // Both are durable, in order, and the chain verifies. The failed primary attempt's open
    // agentMessage closes as `failed` when the turn ends (provider-agent), so it is durable too —
    // last, and never presented as completed.
    const events = sessionEvents(home, threadId);
    const items = events
      .filter((e) => e.type === "item")
      .map((e) => (e.payload as { item: Item }).item);
    assert.deepEqual(
      items.map((i) => [i.kind, i.status]),
      [
        ["userMessage", "completed"],
        ["error", "completed"],
        ["agentMessage", "completed"],
        ["servedModel", "completed"],
        ["agentMessage", "failed"],
      ],
    );
    assert.equal(
      (items[2] as Extract<Item, { kind: "agentMessage" }>).text,
      "served by fallback",
      "the completed agentMessage is the served hop's",
    );
    const servedEvent = events.find((e) => e.type === "servedModel");
    assert.ok(servedEvent !== undefined, "the hop wrote a durable servedModel event");
    assert.equal(
      (servedEvent.payload as Record<string, unknown>).fallbackFrom,
      "kimi-code",
      "the durable receipt carries fallbackFrom",
    );
    assert.equal(
      verifySessionFile(join(home, "sessions", `${threadId}.jsonl`), threadId, {}, home).ok,
      true,
    );
  } finally {
    await client.close();
    cleanup();
  }
});

test("A7 e2e: a cross-lane candidate from a v2 seat file is rejected before any call — fallback.rejected is durable and no servedModel is written for it", async () => {
  const { home, cleanup } = makeHome();
  const { client, stderr } = startEngineCapturingStderr(home, DIRECT_FAKE_ENGINE, {
    KIMI_API_KEY: KIMI_KEY,
    MADC_TEST_KIMI_REPLIES: JSON.stringify([
      { type: "status", status: 429, body: '{"error":"rate limited"}' },
    ]),
    MADC_TEST_CLAUDE_BINARY: FAKE_CLAUDE_BINARY,
  });
  try {
    // kimi-code (allowed-direct/payg) → claude-code (allowed-via-vendor-agent/vendor-session):
    // both status and billing differ, so the candidate is rejected before any call.
    writeSeatFile(home, {
      ...seatFileBody(PROMETHEUS_SEAT),
      id: "fb-rejected",
      displayName: "Rejected Fixture",
      fallbacks: ["claude-code"],
      memory: { mode: "file", path: "memory/fb-rejected.md" },
    });
    await handshake(client);
    const { thread } = await client.request("thread/start", { seatId: "fb-rejected" });
    const threadId = thread.id;
    // turn/start itself succeeds: the primary passes preflight (credentials present, lane allowed)
    // and only fails on the wire, which surfaces as a `failed` turn/completed — not as an RPC error
    // response. "If none is eligible, the turn fails with the primary's error."
    const { turn } = await client.request("turn/start", {
      threadId,
      input: [{ type: "text", text: "hi" }],
    });
    const done = await client.waitFor(
      (m) => m.method === "turn/completed" && (m.params as { turn: Turn }).turn.id === turn.id,
    );
    const final = (done.params as { turn: Turn }).turn;
    assert.equal(final.status, "failed");
    assert.equal(final.error?.code, ErrorCode.ProviderUnavailable);
    assert.deepEqual(final.error?.data, {
      providerId: "kimi-code",
      reason: "quota-or-unreachable",
    });

    const events = sessionEvents(home, threadId);
    const rejected = events.filter((e) => e.type === "fallback.rejected");
    assert.equal(rejected.length, 1, "exactly one durable rejection");
    assert.deepEqual(rejected[0]?.payload, {
      turnId: expectTurnId(events),
      candidate: "claude-code",
      assignedLane: { status: "allowed-direct", credentialClass: "payg" },
      candidateLane: { status: "allowed-via-vendor-agent", credentialClass: "vendor-session" },
      reason: "fallback-lane-mismatch",
    } satisfies FallbackRejectedPayload);
    assert.equal(rejected[0]?.seatId, "fb-rejected", "the envelope names the seat");
    // No servedModel receipt for the rejected candidate — or for anyone: nobody served.
    assert.equal(
      events.some((e) => e.type === "servedModel"),
      false,
      "no servedModel receipt for a rejected candidate",
    );
    const items = events
      .filter((e) => e.type === "item")
      .map((e) => (e.payload as { item: Item }).item);
    const mismatch = items.filter(
      (i) => i.kind === "error" && i.message.includes("fallback-lane-mismatch"),
    );
    assert.equal(mismatch.length, 1, "the paired error-style item");
    assert.match((mismatch[0] as Extract<Item, { kind: "error" }>).message, /fb-rejected/);
    assert.match((mismatch[0] as Extract<Item, { kind: "error" }>).message, /claude-code/);
    assert.match((mismatch[0] as Extract<Item, { kind: "error" }>).message, /allowed-direct\/payg/);
    assert.match(
      (mismatch[0] as Extract<Item, { kind: "error" }>).message,
      /allowed-via-vendor-agent\/vendor-session/,
    );
    assert.equal(
      verifySessionFile(join(home, "sessions", `${threadId}.jsonl`), threadId, {}, home).ok,
      true,
    );
    assert.match(stderr(), /rejected fallback-lane-mismatch/);
  } finally {
    await client.close();
    cleanup();
  }
});

function expectTurnId(events: Array<Record<string, unknown>>): string {
  const turnStart = events.find((e) => e.type === "turn.start");
  assert.ok(turnStart !== undefined, "the session recorded turn.start");
  return (turnStart.payload as { turnId: string }).turnId;
}

// ------------------------------------- the seeded daedalus cell (vendor-agent → direct), and the
// ------------------------------------- eligible same-lane candidate that is actually used

type Captured = { items: Item[]; rejections: FallbackRejectedPayload[] };

function captureSink(): TurnSink & { captured: Captured } {
  const captured: Captured = { items: [], rejections: [] };
  const controller = new AbortController();
  let n = 0;
  return {
    captured,
    signal: controller.signal,
    newItemId: () => {
      n += 1;
      return `item_${n}`;
    },
    startItem: () => undefined,
    delta: () => undefined,
    completeItem: (item) => {
      captured.items.push({ ...item, status: "completed" } as Item);
    },
    fallbackRejected: (payload) => {
      captured.rejections.push(payload);
      return true;
    },
  };
}

type Step = { readonly ok: string; readonly servedModel?: string } | { readonly quota: number };

/** A port driven by a script: `{ quota: n }` throws the recorded signal; `{ ok }` serves. */
function scriptedPort(
  providerId: string,
  script: readonly Step[],
): { port: ProviderPort; calls: () => number } {
  let i = 0;
  return {
    calls: () => i,
    port: {
      providerId,
      streamTurn: async (request): Promise<ProviderTurnResult> => {
        const step = script[Math.min(i, script.length - 1)];
        i += 1;
        if (step !== undefined && "quota" in step) {
          throw new ProviderCallError(
            "failed",
            step.quota,
            `${providerId} request failed (HTTP ${step.quota})`,
            "quota-or-unreachable",
          );
        }
        const ok = (step as { ok: string }).ok;
        request.onTextDelta(ok);
        return {
          text: ok,
          requestedModelId: request.modelId,
          servedModel: (step as { servedModel?: string }).servedModel ?? request.modelId,
        };
      },
    },
  };
}

function ctxFor(seat: EngineSeat, seatPath: string): AgentTurnContext {
  return {
    threadId: "thr_a7",
    seatId: seat.id,
    seat,
    seatPath,
    input: [{ type: "text", text: "hi" }],
    // No roster seat is backed by a repo-gated lane, so identity is never resolved (M1-A4).
    cwd: null,
    turnId: "turn_a7",
  };
}

test("A7: the SEEDED daedalus cell rejects kimi-code before any call (vendor-agent → direct) and writes no receipt for it", async () => {
  const { home, cleanup } = makeHome();
  try {
    seedRosterSeats(home);
    const loaded = loadSeat(home, "daedalus");
    assert.deepEqual(loaded.seat.fallbacks, ["kimi-code"], "the seeded cell, as written");

    const claude = scriptedPort("claude-code", [{ quota: 429 }]);
    const kimi = scriptedPort("kimi-code", [{ ok: "must never serve" }]);
    const kimiLane: DirectLane = {
      providerId: "kimi-code",
      credential: KIMI_KEY,
      createPort: () => kimi.port,
      resolvePinnedModel: resolveKimiPinnedModel,
    };
    const agent = createProviderAgent({
      directLanes: [kimiLane],
      createClaudePort: () => claude.port,
      detectClaudeBinary: () => FAKE_CLAUDE_BINARY,
      createCodexPort: () => {
        throw new Error("never built");
      },
      detectCodexBinary: () => null,
    });
    const sink = captureSink();
    const err = await agent.run(ctxFor(loaded.seat, loaded.path), sink).then(
      () => null,
      (e: unknown) => e,
    );

    assert.ok(err instanceof RpcError, "the primary's error stands when nobody is eligible");
    assert.equal(err.code, ErrorCode.ProviderUnavailable);
    assert.deepEqual(err.data, { providerId: "claude-code", reason: "quota-or-unreachable" });
    assert.equal(claude.calls(), 1, "only the primary was called");
    assert.equal(kimi.calls(), 0, "the mismatched candidate is rejected BEFORE any call");
    assert.deepEqual(sink.captured.rejections, [
      {
        turnId: "turn_a7",
        candidate: "kimi-code",
        assignedLane: { status: "allowed-via-vendor-agent", credentialClass: "vendor-session" },
        candidateLane: { status: "allowed-direct", credentialClass: "payg" },
        reason: "fallback-lane-mismatch",
      },
    ]);
    assert.equal(
      sink.captured.items.some((i) => i.kind === "servedModel"),
      false,
      "no servedModel receipt for the rejected candidate",
    );
    const mismatch = sink.captured.items.filter(
      (i) => i.kind === "error" && i.message.includes("fallback-lane-mismatch"),
    );
    assert.equal(mismatch.length, 1);
    assert.match((mismatch[0] as Extract<Item, { kind: "error" }>).message, /seat daedalus/);
    assert.match(
      (mismatch[0] as Extract<Item, { kind: "error" }>).message,
      /allowed-via-vendor-agent\/vendor-session/,
    );
    assert.match((mismatch[0] as Extract<Item, { kind: "error" }>).message, /allowed-direct\/payg/);
  } finally {
    cleanup();
  }
});

test("A7: an eligible same-lane candidate is used — a fixture codex seat hops to claude-code and receipts fallbackFrom honestly", async () => {
  const { home, cleanup } = makeHome();
  try {
    // A FIXTURE seat for the eligible case, as the act requires; the §6 roster is not edited to
    // manufacture one. codex → claude-code is same-lane (allowed-via-vendor-agent + vendor-session)
    // and both vendor resolvers take a vendor model name, so the seat's one pinnedModel resolves on
    // both hops.
    const path = writeSeatFile(home, {
      ...seatFileBody(HEPHAESTUS_SEAT),
      id: "fb-eligible",
      displayName: "Eligible Fixture",
      memory: { mode: "file", path: "memory/fb-eligible.md" },
    });
    const loaded = loadSeat(home, "fb-eligible");
    assert.deepEqual(loaded.seat.fallbacks, ["claude-code"], "persisted at version 2 and reloaded");
    assert.deepEqual(loaded.warnings, [], "an eligible fallback warns about nothing");

    const codex = scriptedPort("codex", [{ quota: 502 }]);
    const claude = scriptedPort("claude-code", [{ ok: "served by the fallback" }]);
    const agent = createProviderAgent({
      createCodexPort: () => codex.port,
      detectCodexBinary: () => FAKE_CODEX_BINARY,
      createClaudePort: () => claude.port,
      detectClaudeBinary: () => FAKE_CLAUDE_BINARY,
    });
    const sink = captureSink();
    await agent.run(ctxFor(loaded.seat, path), sink);

    assert.equal(codex.calls(), 1, "the primary was attempted");
    assert.equal(claude.calls(), 1, "the eligible candidate served");
    assert.deepEqual(sink.captured.rejections, [], "a same-lane hop is not a rejection");
    const receipt = sink.captured.items.find((i) => i.kind === "servedModel") as ServedModelItem;
    assert.deepEqual(
      { ...receipt, id: "" },
      {
        id: "",
        kind: "servedModel",
        status: "completed",
        requestedModel: "gpt-5.1-codex",
        servedModel: "gpt-5.1-codex",
        backing: "claude-code",
        providerId: "claude-code",
        lane: "allowed-via-vendor-agent",
        mode: "headless",
        fallbackFrom: "codex",
        // The vendor reported no distinct identity, so the receipt records the requested model and
        // says so (protocol pin §5 P2 honesty rule).
        vendorReported: false,
      },
    );
    const agentMessage = sink.captured.items.find((i) => i.kind === "agentMessage");
    assert.equal(
      (agentMessage as Extract<Item, { kind: "agentMessage" }>).text,
      "served by the fallback",
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------- the rule itself (D-M1-7, S2)

test("A7: the same-lane predicate — status OR billing difference rejects; an equal lane does not", () => {
  // plan-interactive → payg. Predicate level on purpose: both ids are `wired: false` until M1-A5,
  // so no seat file can carry them (S1/S2 → -32006) and no turn can be planned on them.
  assert.deepEqual(laneMismatch(entry("minimax-token-plan"), entry("minimax-payg")), {
    assignedLane: { status: "interactive-only", credentialClass: "plan-interactive" },
    candidateLane: { status: "allowed-direct", credentialClass: "payg" },
  });
  assert.deepEqual(laneMismatch(entry("alibaba-coding-plan"), entry("alibaba-model-studio-payg")), {
    assignedLane: { status: "interactive-only", credentialClass: "plan-interactive" },
    candidateLane: { status: "allowed-direct", credentialClass: "payg" },
  });
  // A PAYG id is never a fallback for a plan id, and the reverse is the same mismatch.
  assert.notEqual(laneMismatch(entry("minimax-payg"), entry("minimax-token-plan")), null);

  // vendor-agent → direct (the seeded daedalus cell) and its mirror image.
  assert.deepEqual(laneMismatch(entry("claude-code"), entry("kimi-code")), {
    assignedLane: { status: "allowed-via-vendor-agent", credentialClass: "vendor-session" },
    candidateLane: { status: "allowed-direct", credentialClass: "payg" },
  });
  assert.notEqual(laneMismatch(entry("kimi-code"), entry("claude-code")), null);

  // Equal lanes: status AND billing both equal → eligible on the lane axis.
  assert.equal(laneMismatch(entry("codex"), entry("claude-code")), null);
  assert.equal(laneMismatch(entry("kimi-code"), entry("ollama-cloud")), null);
  assert.equal(laneMismatch(entry("ollama-cloud"), entry("kimi-code")), null);

  // A forbidden entry has no billing class, so it never shares a lane with anything.
  assert.notEqual(laneMismatch(entry("kimi-code"), entry("zai-glm-coding-plan")), null);

  // The load-time warning list, per seeded seat.
  assert.deepEqual(
    neverEligibleFallbacks("claude-code", ["kimi-code"]).map((n) => n.candidate),
    ["kimi-code"],
    "daedalus warns",
  );
  assert.deepEqual(neverEligibleFallbacks("codex", ["claude-code"]), [], "hephaestus does not");
  // I3 Option B emptied prometheus/surface seed fallbacks; same-lane kimi↔ollama is still
  // asserted via laneMismatch above. Seeded cells warn about nothing because the lists are empty.
  assert.deepEqual(neverEligibleFallbacks("kimi-code", []), [], "prometheus has none");
  assert.deepEqual(neverEligibleFallbacks("ollama-cloud", []), [], "surface has none");
  assert.deepEqual(neverEligibleFallbacks("kimi-code", []), [], "madc-default has none");
  // Order is preserved and an unknown id is a load failure, not a warning.
  assert.deepEqual(
    neverEligibleFallbacks("codex", ["kimi-code", "claude-code", "no-such-provider"]).map(
      (n) => n.candidate,
    ),
    ["kimi-code"],
  );
});

test("A7: the seeded roster's pinnedModel values are the ones this act locked", () => {
  assert.equal(DAEDALUS_SEAT.pinnedModel, "claude-sonnet-4-5");
  assert.equal(HEPHAESTUS_SEAT.pinnedModel, "gpt-5.1-codex");
  assert.equal(PROMETHEUS_SEAT.pinnedModel, "kimi-coding/kimi-for-coding");
  assert.deepEqual(PROMETHEUS_SEAT.fallbacks, [], "I3 Option B");
  assert.equal(SURFACE_ARCHITECT_SEAT.pinnedModel, `ollama-cloud/${OLLAMA_MODEL}`);
  assert.deepEqual(SURFACE_ARCHITECT_SEAT.fallbacks, [], "I3 Option B");
  assert.equal(MADC_DEFAULT_SEAT.pinnedModel, "kimi-coding/kimi-for-coding");
  // The Ollama id is the /api/tags spelling (planning record OLL-17/OLL-19), not an invented one.
  assert.match(SURFACE_ARCHITECT_SEAT.pinnedModel, /^ollama-cloud\/gpt-oss:120b$/);
  assert.deepEqual(
    ROSTER_SEATS.map((s) => s.id),
    ROSTER_IDS,
    "seat pin §3 order",
  );
});

// ------------------------------------------------------------------ Copilot review regressions
// Each test below pins one finding from the PR #37 review so the fix cannot silently regress.

test("A7 review r4137933951: the seed writer refuses an id outside the protocol grammar, before any path join", () => {
  const { home, cleanup } = makeHome();
  try {
    assert.equal(seedSeatFile(home, MADC_DEFAULT_SEAT).created, true, "the home dirs exist");
    // The precondition that makes the escape reachable. Without it the dot-prefixed temp name
    // ENOENTs first and the hole hides, so the test supplies it: with the grammar guard removed,
    // this seed lands at `$MADC_HOME/escape.json` and reports `created: true` (verified by probe).
    mkdirSync(join(home, "seats", "..."), { mode: 0o700 });

    for (const id of ["../escape", "..", "a/b", ".hidden", ""]) {
      assert.throws(
        () => seedSeatFile(home, { ...MADC_DEFAULT_SEAT, id }),
        /must match \^\[A-Za-z0-9\]/,
        id,
      );
    }
    assert.equal(existsSync(join(home, "escape.json")), false, "no seat file outside seats/");
    assert.deepEqual(
      readdirSync(home).sort(),
      ["memory", "seats", "sessions"],
      "the home gained no stray name",
    );
    // The already-seeded default is untouched and still reports created:false.
    assert.equal(seedSeatFile(home, MADC_DEFAULT_SEAT).created, false);
  } finally {
    cleanup();
  }
});

test("A7 review r4137934009: a seat declaring another seat's memory path materializes nothing", () => {
  const { home, cleanup } = makeHome();
  try {
    const borrowed: EngineSeat = {
      ...DAEDALUS_SEAT,
      memory: { mode: "file", path: "memory/hephaestus.md" },
    };
    assert.equal(
      ensureSeatMemoryFile(home, borrowed),
      null,
      "a declared path that is not the seat's own is left alone",
    );
    assert.equal(
      existsSync(join(home, "memory", "hephaestus.md")),
      false,
      "no other seat's file was created",
    );

    // Its OWN pinned default path still materializes, exclusively, 0600, and is never rewritten.
    const own = ensureSeatMemoryFile(home, DAEDALUS_SEAT);
    assert.equal(own?.created, true);
    assert.equal(existsSync(join(home, "memory", "daedalus.md")), true);
    if (POSIX) assert.equal(mode(join(home, "memory", "daedalus.md")), 0o600);
    assert.equal(ensureSeatMemoryFile(home, DAEDALUS_SEAT)?.created, false, "never overwritten");

    // An in-session seat has no path at all.
    assert.equal(
      ensureSeatMemoryFile(home, { ...DAEDALUS_SEAT, memory: { mode: "in-session" } }),
      null,
    );
  } finally {
    cleanup();
  }
});

test("A7 review r4137934052: a nested memory path with a swapped intermediate component cannot escape the home", () => {
  const { home, cleanup } = makeHome();
  const outside = join(home, "..", "outside-a7-mem");
  try {
    mkdirSync(join(home, "memory"), { recursive: true, mode: 0o700 });
    mkdirSync(outside, { recursive: true, mode: 0o700 });
    // `memory/team` is a symlink out of the home. O_NOFOLLOW protects only the FINAL component, so
    // a declared nested path is never created by this act at all.
    symlinkSync(outside, join(home, "memory", "team"));
    const seat: EngineSeat = {
      ...DAEDALUS_SEAT,
      id: "team-seat",
      memory: { mode: "file", path: "memory/team/team-seat.md" },
    };
    assert.equal(ensureSeatMemoryFile(home, seat), null);
    assert.deepEqual(readdirSync(outside), [], "nothing was created through the swapped component");
    // The seat's own default path is still available to it, and stays inside the home.
    assert.equal(
      ensureSeatMemoryFile(home, {
        ...DAEDALUS_SEAT,
        id: "team-seat",
        memory: { mode: "file", path: "memory/team-seat.md" },
      })?.created,
      true,
    );
    assert.equal(existsSync(join(home, "memory", "team-seat.md")), true);
    assert.deepEqual(readdirSync(outside), [], "still nothing outside");
  } finally {
    cleanup();
  }
});

test("A7 review r4137934103: the serializer refuses a v2 seat with no usable displayName, so the writer can never seed an unloadable seat", () => {
  const missing = { ...DAEDALUS_SEAT, displayName: undefined } as unknown as EngineSeat;
  assert.throws(() => serializeSeat(missing), /displayName is required at version 2/);
  assert.throws(
    () => serializeSeat({ ...DAEDALUS_SEAT, displayName: "   " }),
    /displayName is required at version 2/,
  );
  // v1 is unaffected: its schema has no displayName key, so the bytes must not gain one.
  assert.equal(serializeSeat(MADC_DEFAULT_SEAT).includes("displayName"), false);
  // The refusal reaches the seed writer, the only caller that persists bytes.
  const { home, cleanup } = makeHome();
  try {
    assert.throws(() => seedSeatFile(home, missing), /displayName is required at version 2/);
    assert.equal(existsSync(join(home, "seats", "daedalus.json")), false, "nothing half-written");
  } finally {
    cleanup();
  }
});

test("A7 review r4137934156: seat/list never echoes a stem that could not be a seat id, and still reports an unloadable seat", async () => {
  const { home, cleanup } = makeHome();
  const { client } = startEngineCapturingStderr(home, ECHO_ENGINE);
  try {
    await handshake(client);
    const seats = join(home, "seats");
    // A stem outside the protocol id grammar: `thread/start` refuses it with -32602 before any path
    // join, so it is not a seat — and its operator-controlled name never enters a response the CLI
    // prints verbatim.
    writeFileSync(join(seats, "bad.id.json"), serializeSeat(DAEDALUS_SEAT), { mode: 0o600 });
    // A grammar-valid stem whose file does not load IS reported rather than hidden.
    writeFileSync(join(seats, "mismatch.json"), serializeSeat(DAEDALUS_SEAT), { mode: 0o600 });

    const { data } = await client.request("seat/list", {});
    const ids = data.map((s) => s.id);
    assert.equal(ids.includes("bad.id"), false, "an impossible seat id is not echoed");
    for (const id of ids) {
      assert.match(
        id,
        /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/,
        "every listed id satisfies the grammar",
      );
    }
    const mismatch = data.find((s) => s.id === "mismatch");
    assert.ok(mismatch !== undefined && mismatch.ok === false, "an unloadable seat is reported");
    assert.equal(mismatch.code, ErrorCode.SeatInvalid);
    assert.deepEqual(mismatch.issues, ['id "daedalus" must equal the filename stem "mismatch"']);
    assert.deepEqual(
      ids.sort(),
      [...ROSTER_IDS, "mismatch"].sort(),
      "the roster still lists in full",
    );
  } finally {
    await client.close();
    cleanup();
  }
});
