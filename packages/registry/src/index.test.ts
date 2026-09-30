import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type AllowedDirectEntry,
  assertAllowed,
  canServe,
  checkEntry,
  getById,
  isStale,
  lanesFor,
  listCatalog,
  type ProviderEntry,
  RegistryDeniedError,
} from "./index.ts";

/** Roadmap §3 rows (11 subscriptions) plus the forbidden sub-paths (criterion A). */
const ROADMAP_COVERED_IDS = [
  "ollama-cloud",
  "kimi-code",
  "mistral-pro",
  "deepseek-payg",
  "gemini-api-key",
  "claude-code",
  "codex",
  "minimax-token-plan",
  "alibaba-coding-plan",
  "zai-glm-coding-plan",
  "xai-api",
  "grok-build",
  "gemini-antigravity-signin",
  "chatgpt-token-replay",
  "claude-subscription-http",
  "xai-consumer-signin",
] as const;

const FORBIDDEN_IDS = [
  "zai-glm-coding-plan",
  "gemini-antigravity-signin",
  "chatgpt-token-replay",
  "claude-subscription-http",
  "xai-consumer-signin",
] as const;

/** M1-plan ids whose PAYG terms were not re-verified on 2026-09-24, plus kept M0 stubs. */
const OTHER_IDS = [
  "minimax-payg",
  "alibaba-model-studio-payg",
  "openrouter",
  "groq-cloud",
  "github-copilot",
] as const;

function denialReason(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof RegistryDeniedError) return err.reason;
    throw err;
  }
  throw new Error("expected RegistryDeniedError, nothing was thrown");
}

test("catalog v2: every roadmap §3 row, the forbidden sub-paths, and the M1 ids resolve (criterion A)", () => {
  const ids = new Set(listCatalog().map((e) => e.id));
  for (const id of [...ROADMAP_COVERED_IDS, ...OTHER_IDS]) {
    assert.ok(ids.has(id), `missing catalog entry: ${id}`);
    assert.ok(getById(id) !== undefined, `getById did not resolve: ${id}`);
  }
  assert.equal(listCatalog().length, 21, "16 roadmap-covered + 2 PAYG + 3 kept stubs");

  // Unknown ids fail closed: an id not in the catalog resolves to undefined, never to an entry.
  assert.equal(getById("not-a-real-provider"), undefined);

  // Criterion A fields on every roadmap-covered row.
  for (const id of ROADMAP_COVERED_IDS) {
    const entry = getById(id);
    assert.ok(entry, id);
    assert.ok(entry.status.length > 0, `${id} missing status`);
    assert.ok(entry.sourceQuote.length > 0, `${id} missing sourceQuote`);
    assert.ok(entry.sourceUrl.length > 0, `${id} missing sourceUrl`);
    assert.ok(entry.termsUrl.length > 0, `${id} missing termsUrl`);
    assert.ok(entry.verifiedAt.length > 0, `${id} missing verifiedAt`);
  }

  // Live wiring is the M0 three plus the lanes whose adapter acts have landed (M1-A3:
  // ollama-cloud; M1-A4: mistral-pro, deepseek-payg, gemini-api-key, xai-api; M1-A5: the two
  // interactive-only plans); every other lane is a stub until its adapter act. `deepseek-payg`
  // being wired does not open the lane: it is repo-gated with an empty allowlist on a clean install
  // (D-M1-8, seat pin §5). The two plans being wired does not open them headless: their status
  // still denies every headless turn, and interactive turns need the engine presence check.
  assert.deepEqual(
    listCatalog()
      .filter((e) => e.wired)
      .map((e) => e.id)
      .sort(),
    [
      "alibaba-coding-plan",
      "claude-code",
      "codex",
      "deepseek-payg",
      "gemini-api-key",
      "kimi-code",
      "minimax-token-plan",
      "mistral-pro",
      "ollama-cloud",
      "xai-api",
    ],
  );
  // M1-A5: the plan ids stay in the plan billing class; wiring them never moved them to PAYG.
  for (const id of ["minimax-token-plan", "alibaba-coding-plan"] as const) {
    const entry = getById(id);
    assert.ok(entry && entry.status === "interactive-only", id);
    assert.equal(entry.credentialClass, "plan-interactive", id);
  }

  // The PAYG ids carry an honest "never verified" date and no terms page (fail-closed stale).
  for (const id of ["minimax-payg", "alibaba-model-studio-payg"] as const) {
    const entry = getById(id);
    assert.ok(entry && entry.status === "allowed-direct", id);
    assert.equal(entry.verifiedAt, "", `${id} must not claim a verification date`);
    assert.equal(entry.termsUrl, "", `${id} must not pin an unverified terms page`);
    assert.equal(entry.wired, false, `${id} stays unwired until a PAYG terms source is cited`);
  }

  for (const id of ["openrouter", "groq-cloud", "github-copilot"] as const) {
    const entry = getById(id);
    assert.ok(entry, id);
    assert.equal(entry.termsUrl, "", `${id} has no pinned live terms page`);
    assert.equal(entry.verifiedAt, "", `${id} must not claim a live terms verification`);
    assert.equal(isStale(entry, Date.parse("2026-09-25")), true, `${id} stays stale`);
  }
});

test("forbidden ids throw for both modes and both connects", () => {
  for (const id of FORBIDDEN_IDS) {
    for (const mode of ["headless", "interactive"] as const) {
      for (const connect of ["direct", "vendor-agent"] as const) {
        assert.equal(
          denialReason(() => assertAllowed({ providerId: id, mode, connect })),
          "forbidden",
          `${id} ${mode} ${connect}`,
        );
      }
    }
  }
});

test("unknown provider denied (fail-closed)", () => {
  assert.equal(
    denialReason(() =>
      assertAllowed({ providerId: "not-a-real-provider", mode: "headless", connect: "direct" }),
    ),
    "unknown-provider",
  );
});

test("interactive-only throws interactive-only-headless on headless; interactive direct passes", () => {
  for (const id of ["minimax-token-plan", "alibaba-coding-plan"] as const) {
    assert.equal(
      denialReason(() => assertAllowed({ providerId: id, mode: "headless", connect: "direct" })),
      "interactive-only-headless",
      id,
    );
    const allowed = assertAllowed({ providerId: id, mode: "interactive", connect: "direct" });
    assert.equal(allowed.id, id);
  }
});

test("headless policy: ollama-cloud refuses headless with headless-not-permitted, allows interactive", () => {
  // The D-M1-3 default: allowed-direct alone never implies a headless allow.
  assert.equal(
    denialReason(() =>
      assertAllowed({ providerId: "ollama-cloud", mode: "headless", connect: "direct" }),
    ),
    "headless-not-permitted",
  );
  // Policy denial applies with requireLive too (the headless gate does not depend on wiring).
  assert.equal(
    denialReason(() =>
      assertAllowed({
        providerId: "ollama-cloud",
        mode: "headless",
        connect: "direct",
        requireLive: true,
      }),
    ),
    "headless-not-permitted",
  );
  // Interactive use with the key stays allowed — and live since M1-A3 wired the adapter.
  const interactive = assertAllowed({
    providerId: "ollama-cloud",
    mode: "interactive",
    connect: "direct",
  });
  assert.equal(interactive.id, "ollama-cloud");
  const interactiveLive = assertAllowed({
    providerId: "ollama-cloud",
    mode: "interactive",
    connect: "direct",
    requireLive: true,
  });
  assert.equal(interactiveLive.id, "ollama-cloud");

  // D-M1-3: headless flips only as a reviewed catalog change carrying headlessPermission.
  const ollama = getById("ollama-cloud");
  assert.ok(ollama && ollama.status === "allowed-direct");
  if (ollama.headless === "allowed") {
    assert.ok(
      ollama.headlessPermission,
      "ollama-cloud headless:allowed requires headlessPermission { by, date, note, sourceUrl }",
    );
  } else {
    assert.equal(ollama.headless, "denied");
    assert.equal(ollama.headlessPermission, undefined);
  }
});

test("an allowed-direct entry without a headless field fails the type check", () => {
  // @ts-expect-error M1-A1: `headless` is required on allowed-direct entries, no default
  const missingHeadless: ProviderEntry = {
    id: "bad-entry",
    status: "allowed-direct",
    connect: "direct",
    credentialClass: "payg",
    wired: false,
    sourceQuote: "q",
    sourceUrl: "u",
    termsUrl: "u",
    verifiedAt: "2026-09-24",
  };
  // Runtime shape (types stripped): the field is simply absent.
  assert.equal("headless" in missingHeadless, false);
});

test("staleness: a stale allow entry denies with terms-stale; founderOverride lets it through", () => {
  const verified = "2026-09-24";
  const freshNow = Date.parse("2026-10-24T00:00:00Z"); // exactly 30 days: not stale
  const staleNow = Date.parse("2026-10-25T00:00:00Z"); // 31 days: stale

  // Fresh at the boundary ("more than 30 days old" denies).
  assert.equal(
    assertAllowed({ providerId: "kimi-code", mode: "headless", connect: "direct", now: freshNow })
      .id,
    "kimi-code",
  );

  // Stale direct lane.
  assert.equal(
    denialReason(() =>
      assertAllowed({
        providerId: "kimi-code",
        mode: "headless",
        connect: "direct",
        now: staleNow,
      }),
    ),
    "terms-stale",
  );

  // Interactive-only plans are allow entries for freshness too.
  assert.equal(
    denialReason(() =>
      assertAllowed({
        providerId: "minimax-token-plan",
        mode: "interactive",
        connect: "direct",
        now: staleNow,
      }),
    ),
    "terms-stale",
  );

  // A per-entry Founder override lets a stale entry through.
  const overridden: AllowedDirectEntry = {
    id: "kimi-code",
    status: "allowed-direct",
    connect: "direct",
    wire: "anthropic-compat",
    clientIdentity: "honest-ua-required",
    wired: true,
    credentialClass: "payg",
    headless: "allowed",
    verifiedAt: verified,
    termsUrl: "https://www.kimi.com/code/docs/en/",
    sourceQuote: "q",
    sourceUrl: "u",
    founderOverride: { by: "founder", date: "2026-10-25", note: "re-verification in flight" },
  };
  assert.equal(
    checkEntry(overridden, {
      providerId: "kimi-code",
      mode: "headless",
      connect: "direct",
      now: staleNow,
    }).id,
    "kimi-code",
  );

  // Without an override the same shape denies.
  const { founderOverride: _dropped, ...bare } = overridden;
  assert.equal(
    denialReason(() =>
      checkEntry(bare, {
        providerId: "kimi-code",
        mode: "headless",
        connect: "direct",
        now: staleNow,
      }),
    ),
    "terms-stale",
  );

  // No clock supplied: freshness is not enforced at this layer (M0 behavior preserved).
  assert.equal(
    assertAllowed({ providerId: "kimi-code", mode: "headless", connect: "direct" }).id,
    "kimi-code",
  );
});

test("staleness never flips forbidden", () => {
  const farFuture = Date.parse("2030-01-01");
  for (const id of FORBIDDEN_IDS) {
    assert.equal(
      denialReason(() =>
        assertAllowed({ providerId: id, mode: "interactive", connect: "direct", now: farFuture }),
      ),
      "forbidden",
      id,
    );
  }
});

test("isStale units: never-verified is stale; the 30-day boundary is exact", () => {
  const kimi = getById("kimi-code");
  assert.ok(kimi);
  const now = Date.parse("2026-10-24T00:00:00Z");
  assert.equal(isStale(kimi, now), false, "exactly 30 days is not stale");
  assert.equal(isStale(kimi, now + 1), true, "30 days + 1ms is stale");
  assert.equal(isStale(kimi, Date.parse("2026-10-23")), false);
  assert.equal(isStale(kimi, now, 0), true, "a zero-day window stales any past date");

  const payg = getById("minimax-payg");
  assert.ok(payg);
  assert.equal(isStale(payg, Date.parse("2026-09-25")), true, "empty verifiedAt is always stale");

  const garbage = { ...kimi, verifiedAt: "not-a-date" };
  assert.equal(isStale(garbage, now), true, "unparseable verifiedAt is stale (fail-closed)");
});

test("staleness fails closed for invalid clocks, windows, and verification dates", () => {
  const kimi = getById("kimi-code");
  assert.ok(kimi);
  const now = Date.parse("2026-09-25T00:00:00Z");

  for (const invalidNow of [Number.NaN, Infinity, -Infinity, null, "2026-09-25"]) {
    assert.equal(isStale(kimi, invalidNow as number), true, String(invalidNow));
    assert.equal(
      denialReason(() =>
        assertAllowed({
          providerId: "kimi-code",
          mode: "headless",
          connect: "direct",
          now: invalidNow as number,
        }),
      ),
      "terms-stale",
      String(invalidNow),
    );
  }
  assert.equal(isStale(kimi, 0), true, "a verification date after the clock is stale");

  for (const invalidDays of [Number.NaN, Infinity, -Infinity, -1]) {
    assert.equal(isStale(kimi, now, invalidDays), true, String(invalidDays));
  }
  for (const verifiedAt of ["2026-09-26", "2099-01-01", "2026-02-30"]) {
    assert.equal(isStale({ ...kimi, verifiedAt }, now), true, verifiedAt);
  }
});

test("kimi-code allowed-direct passes (headless ok)", () => {
  const entry = assertAllowed({
    providerId: "kimi-code",
    mode: "headless",
    connect: "direct",
    requireLive: true,
  });
  assert.equal(entry.status, "allowed-direct");
  assert.equal(entry.wired, true);
  assert.equal(entry.clientIdentity, "honest-ua-required");
  assert.equal(entry.wire, "anthropic-compat");
  assert.equal(entry.credentialClass, "payg");
});

test("claude-code and codex require vendor-agent; direct denied", () => {
  for (const id of ["claude-code", "codex"] as const) {
    assert.equal(
      denialReason(() =>
        assertAllowed({ providerId: id, mode: "headless", connect: "direct", requireLive: true }),
      ),
      "connect-mismatch",
      id,
    );

    const entry = assertAllowed({
      providerId: id,
      mode: "interactive",
      connect: "vendor-agent",
      requireLive: true,
    });
    assert.equal(entry.status, "allowed-via-vendor-agent");
    assert.equal(entry.wired, true);
    assert.equal(entry.credentialClass, "vendor-session");
  }
});

test("unwired allowed-direct denied when live required; stub lookup ok", () => {
  // openrouter is a kept M0 stub: allowed-direct with headless: "allowed", still unwired because no
  // M1 act lands its adapter (mistral-pro / xai-api were the fixtures here until M1-A4 wired them).
  const stub = getById("openrouter");
  assert.ok(stub);
  assert.equal(stub.status, "allowed-direct");
  assert.equal(stub.wired, false);

  assert.equal(
    denialReason(() =>
      assertAllowed({
        providerId: "openrouter",
        mode: "headless",
        connect: "direct",
        requireLive: true,
      }),
    ),
    "unwired",
  );

  const allowedStub = assertAllowed({
    providerId: "openrouter",
    mode: "headless",
    connect: "direct",
  });
  assert.equal(allowedStub.id, "openrouter");
});

test("allowed-direct rejects vendor-agent intent", () => {
  assert.equal(
    denialReason(() =>
      assertAllowed({ providerId: "kimi-code", mode: "headless", connect: "vendor-agent" }),
    ),
    "connect-mismatch",
  );
});

test("lanesFor / canServe: mode policy per lane", () => {
  const headlessIds = new Set(lanesFor("headless").map((e) => e.id));
  const interactiveIds = new Set(lanesFor("interactive").map((e) => e.id));

  // Headless: no ollama-cloud (D-M1-3), no interactive-only plans, nothing forbidden.
  assert.equal(headlessIds.has("ollama-cloud"), false);
  assert.equal(headlessIds.has("minimax-token-plan"), false);
  assert.equal(headlessIds.has("alibaba-coding-plan"), false);
  for (const id of FORBIDDEN_IDS) assert.equal(headlessIds.has(id), false, id);
  // Wired lanes, allowed-direct stubs with headless allowed, and vendor agents serve headless
  // (canServe is mode policy only — it does not read `wired`; see catalog.ts).
  for (const id of ["kimi-code", "claude-code", "codex", "grok-build", "mistral-pro", "xai-api"]) {
    assert.ok(headlessIds.has(id), id);
  }

  // Interactive: everything non-forbidden, including ollama-cloud and the plans.
  for (const id of ["ollama-cloud", "minimax-token-plan", "alibaba-coding-plan", "kimi-code"]) {
    assert.ok(interactiveIds.has(id), id);
  }
  for (const id of FORBIDDEN_IDS) assert.equal(interactiveIds.has(id), false, id);

  const ollama = getById("ollama-cloud");
  assert.ok(ollama);
  assert.equal(canServe(ollama, "interactive"), true);
  assert.equal(canServe(ollama, "headless"), false);
});

test("catalog entries are frozen; mutation cannot poison assertAllowed", () => {
  // openrouter is still an unwired stub (M1-A4 wired mistral-pro, the previous fixture here).
  const unwired = getById("openrouter");
  assert.ok(unwired);
  assert.equal(unwired.wired, false);
  assert.throws(
    () => {
      (unwired as { wired: boolean }).wired = true;
    },
    (err: unknown) => err instanceof TypeError,
  );
  assert.equal(getById("openrouter")?.wired, false);

  const headlessDenied = getById("ollama-cloud");
  assert.ok(headlessDenied && headlessDenied.status === "allowed-direct");
  assert.throws(
    () => {
      (headlessDenied as { headless: string }).headless = "allowed";
    },
    (err: unknown) => err instanceof TypeError,
  );
  assert.equal(
    denialReason(() =>
      assertAllowed({ providerId: "ollama-cloud", mode: "headless", connect: "direct" }),
    ),
    "headless-not-permitted",
  );

  const forbidden = listCatalog().find((e) => e.id === "zai-glm-coding-plan");
  assert.ok(forbidden);
  assert.equal(forbidden.status, "forbidden");
  assert.throws(
    () => {
      (forbidden as { status: string }).status = "allowed-direct";
    },
    (err: unknown) => err instanceof TypeError,
  );
  assert.equal(getById("zai-glm-coding-plan")?.status, "forbidden");
  assert.equal(
    denialReason(() =>
      assertAllowed({ providerId: "zai-glm-coding-plan", mode: "interactive", connect: "direct" }),
    ),
    "forbidden",
  );

  assert.throws(
    () => {
      (listCatalog() as unknown as { pop: () => unknown }).pop();
    },
    (err: unknown) => err instanceof TypeError,
  );
});
