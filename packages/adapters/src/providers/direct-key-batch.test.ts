/**
 * M1-A4 direct-key batch: lane config, `pinnedModel` resolution and the two lane-specific
 * prohibitions — Gemini auth keys only, and NO xAI consumer OAuth.
 *
 * Network-free and credential-free: nothing here opens a socket. Every key is a synthetic sentinel.
 * The wire-level conformance runs (chat, stream, tool round-trip, served-model receipt) live in the
 * per-lane `*.conformance.test.ts` files against the fake transports.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { getById } from "@madc/registry";
import {
  buildDeepseekProvider,
  buildGeminiProvider,
  buildMistralProvider,
  buildXaiProvider,
  createDeepseekPort,
  createGeminiPort,
  createMistralPort,
  createXaiPort,
  DEEPSEEK_BASE_URL,
  DEEPSEEK_PI_PROVIDER,
  DEEPSEEK_PROVIDER_ID,
  DEEPSEEK_WIRE_API,
  deepseekCatalogModelIds,
  GEMINI_BASE_URL,
  GEMINI_PI_PROVIDER,
  GEMINI_PROVIDER_ID,
  GEMINI_STANDARD_KEY_PREFIX,
  GEMINI_STANDARD_KEY_WARNING,
  GEMINI_WIRE_API,
  geminiCatalogModelIds,
  looksLikeStandardGeminiKey,
  MISTRAL_BASE_URL,
  MISTRAL_PI_PROVIDER,
  MISTRAL_PROVIDER_ID,
  MISTRAL_WIRE_API,
  mistralCatalogModelIds,
  resolveDeepseekPinnedModel,
  resolveGeminiPinnedModel,
  resolveMistralPinnedModel,
  resolveXaiPinnedModel,
  stockXaiProviderHasOAuth,
  XAI_BASE_URL,
  XAI_PI_PROVIDER,
  XAI_PROVIDER_ID,
  XAI_WIRE_API,
  xaiCatalogModelIds,
} from "../index.ts";

const SENTINEL = "test-sentinel-key-a4-0123456789abcdef";

/** registry id → the pi-ai provider / wire api / endpoint the lane must be configured with. */
const LANES = [
  {
    id: MISTRAL_PROVIDER_ID,
    pi: MISTRAL_PI_PROVIDER,
    api: MISTRAL_WIRE_API,
    baseUrl: MISTRAL_BASE_URL,
    build: buildMistralProvider,
    ids: mistralCatalogModelIds,
    resolve: resolveMistralPinnedModel,
  },
  {
    id: DEEPSEEK_PROVIDER_ID,
    pi: DEEPSEEK_PI_PROVIDER,
    api: DEEPSEEK_WIRE_API,
    baseUrl: DEEPSEEK_BASE_URL,
    build: buildDeepseekProvider,
    ids: deepseekCatalogModelIds,
    resolve: resolveDeepseekPinnedModel,
  },
  {
    id: GEMINI_PROVIDER_ID,
    pi: GEMINI_PI_PROVIDER,
    api: GEMINI_WIRE_API,
    baseUrl: GEMINI_BASE_URL,
    build: buildGeminiProvider,
    ids: geminiCatalogModelIds,
    resolve: resolveGeminiPinnedModel,
  },
  {
    id: XAI_PROVIDER_ID,
    pi: XAI_PI_PROVIDER,
    api: XAI_WIRE_API,
    baseUrl: XAI_BASE_URL,
    build: buildXaiProvider,
    ids: xaiCatalogModelIds,
    resolve: resolveXaiPinnedModel,
  },
] as const;

test("A4: the four registry ids are wired, allowed-direct and direct-connect", () => {
  for (const lane of LANES) {
    const entry = getById(lane.id);
    assert.ok(entry, `${lane.id} must be in the catalog`);
    assert.equal(entry.wired, true, `${lane.id} must be wired by M1-A4`);
    assert.equal(entry.status, "allowed-direct", lane.id);
    assert.equal(entry.connect, "direct", lane.id);
    assert.equal(entry.credentialClass, "payg", lane.id);
  }
  // Exactly these four flipped in this act; the rest of the catalog is unchanged.
  assert.deepEqual(LANES.map((lane) => lane.id).sort(), [
    "deepseek-payg",
    "gemini-api-key",
    "mistral-pro",
    "xai-api",
  ]);
});

test("A4: the consumer sign-in lanes this act must NOT enable stay forbidden", () => {
  // Gemini accepts auth keys only, and xAI uses an API key from the M1-A2 keychain: neither
  // subscription/consumer sign-in path is wired, enabled or reachable from these adapters.
  for (const id of ["gemini-antigravity-signin", "xai-consumer-signin", "zai-glm-coding-plan"]) {
    const entry = getById(id);
    assert.ok(entry, id);
    assert.equal(entry.status, "forbidden", id);
    assert.equal(entry.wired, false, id);
  }
});

test("A4: each lane builds the pinned pi-ai provider on its own wire api and endpoint", () => {
  for (const lane of LANES) {
    const provider = lane.build();
    assert.equal(provider.id, lane.pi, `${lane.id} → pi-ai provider`);
    assert.equal(provider.baseUrl, lane.baseUrl, `${lane.id} → endpoint`);
    // The models the lane resolves against are the pinned pi-ai catalog's, on this lane's api.
    const ids = lane.ids();
    assert.ok(ids.length > 0, `${lane.id} must have a non-empty pinned catalog`);
    for (const model of provider.getModels()) {
      assert.equal(model.api, lane.api, `${lane.id}/${model.id} → wire api`);
      assert.ok(ids.includes(model.id), `${model.id} must be listed by the lane`);
    }
  }
});

test("A4: pinnedModel must be <pi provider>/<catalog id> — wrong provider, unknown model and bare ids are refused", () => {
  for (const lane of LANES) {
    const known = lane.ids()[0];
    assert.ok(known, `${lane.id} catalog must not be empty`);

    // Accepted: the lane's own pi provider with a catalog model id.
    assert.deepEqual(lane.resolve(`${lane.pi}/${known}`), { ok: true, modelId: known }, lane.id);

    // Refused: a bare id with no provider half.
    const bare = lane.resolve(known);
    assert.equal(bare.ok, false, `${lane.id}: a bare model id must be refused`);
    assert.match(bare.ok ? "" : bare.issue, /pinnedModel must be/, lane.id);

    // Refused: another lane's pi provider, even with a model this catalog does list.
    const foreign = lane.resolve(`not-${lane.pi}/${known}`);
    assert.equal(foreign.ok, false, `${lane.id}: a foreign provider prefix must be refused`);
    assert.match(foreign.ok ? "" : foreign.issue, /does not match backing/, lane.id);
    assert.match(
      foreign.ok ? "" : foreign.issue,
      new RegExp(lane.id),
      "the issue names the backing",
    );

    // Refused: an unknown model under the right provider — never silently remapped.
    const unknown = lane.resolve(`${lane.pi}/no-such-model-a4`);
    assert.equal(unknown.ok, false, `${lane.id}: an unknown model must be refused`);
    assert.match(
      unknown.ok ? "" : unknown.issue,
      /is not in the pi-ai 0\.87\.1 .* catalog/,
      lane.id,
    );

    // Refused: empty halves.
    assert.equal(lane.resolve(`${lane.pi}/`).ok, false, lane.id);
    assert.equal(lane.resolve(`/${known}`).ok, false, lane.id);
    assert.equal(lane.resolve("").ok, false, lane.id);
  }
});

test("A4: the pi provider ids differ from the registry ids where the catalog says so (seat pin §3)", () => {
  // A receipt's `requestedModel` carries the PI provider, not the registry id — pin these so a
  // future rename cannot silently change what a receipt means.
  assert.equal(MISTRAL_PI_PROVIDER, "mistral");
  assert.equal(DEEPSEEK_PI_PROVIDER, "deepseek");
  assert.equal(GEMINI_PI_PROVIDER, "google");
  assert.equal(XAI_PI_PROVIDER, "xai");
  assert.notEqual(MISTRAL_PROVIDER_ID, MISTRAL_PI_PROVIDER);
  assert.notEqual(GEMINI_PROVIDER_ID, GEMINI_PI_PROVIDER);
  assert.notEqual(XAI_PROVIDER_ID, XAI_PI_PROVIDER);
  assert.notEqual(DEEPSEEK_PROVIDER_ID, DEEPSEEK_PI_PROVIDER);
});

// --------------------------------------------------------------------- xAI: no OAuth

test("A4 xAI: the built provider has NO OAuth descriptor — pi-ai's SuperGrok/X sign-in is not enabled", () => {
  // `xaiProvider()` ships `auth: { apiKey, oauth }`, where oauth is a lazyOAuth for "Sign in with
  // SuperGrok or X Premium". Roadmap §3 row 11 classifies that consumer sign-in as forbidden
  // (registry id `xai-consumer-signin`), so the lane rebuilds the provider without it. This is a
  // STRUCTURAL assertion: there is no OAuth descriptor for pi-ai to fall back to.
  const provider = buildXaiProvider();
  assert.deepEqual(Object.keys(provider.auth).sort(), ["apiKey"], "apiKey only, never oauth");
  assert.equal("oauth" in provider.auth, false);
  assert.equal(provider.auth.apiKey !== undefined, true);
  // And the rest of the provider is still the pinned pi-ai xAI lane, not a re-imagined one.
  assert.equal(provider.id, XAI_PI_PROVIDER);
  assert.equal(provider.baseUrl, XAI_BASE_URL);
  assert.deepEqual(
    provider
      .getModels()
      .map((m) => m.id)
      .sort(),
    [...xaiCatalogModelIds()].sort(),
  );
});

test("A4 xAI: the stock pi-ai provider this lane replaces DOES carry OAuth (the strip is load-bearing)", () => {
  // Guards the test above from passing vacuously: if a future pi-ai drops xAI OAuth, this assertion
  // fails and tells us the strip became redundant rather than silently stopping to matter. Read
  // through the lane module, because plan §6 forbids tests importing pi-ai directly.
  assert.equal(stockXaiProviderHasOAuth(), true, "stock xaiProvider still ships oauth");
  assert.equal("oauth" in buildXaiProvider().auth, false, "the lane's provider does not");
});

test("A4 xAI: the port is built with the API key and reports the registry id", () => {
  const port = createXaiPort({ apiKey: SENTINEL });
  assert.equal(port.providerId, XAI_PROVIDER_ID);
});

// ------------------------------------------------------------------ Gemini: auth keys

test("A4 Gemini: the pi-ai google provider is API-key only (no Google OAuth to strip)", () => {
  const provider = buildGeminiProvider();
  assert.deepEqual(Object.keys(provider.auth).sort(), ["apiKey"]);
  assert.equal("oauth" in provider.auth, false);
  assert.equal(provider.baseUrl, GEMINI_BASE_URL);
});

test("A4 Gemini: a standard-shaped key is recognized as a likely failure", () => {
  // Google's pinned page: "On September 2026 : the Gemini API will reject requests from standard
  // keys . You must migrate to auth keys". Only the STANDARD shape is recognized — the auth-key
  // shape is not documented in any pinned source, so the classifier never claims a key is valid.
  assert.equal(
    looksLikeStandardGeminiKey(`${GEMINI_STANDARD_KEY_PREFIX}SyFakedStandardKeyValue0123456789ab`),
    true,
  );
  assert.equal(looksLikeStandardGeminiKey(GEMINI_STANDARD_KEY_PREFIX), true);
  // Anything else is left alone: an auth key, a sentinel, an empty string.
  for (const key of [SENTINEL, "", "ya29.faked-auth-key", "aiza-not-at-the-start"]) {
    assert.equal(looksLikeStandardGeminiKey(key), false, JSON.stringify(key));
  }
});

test("A4 Gemini: a standard-shaped credential warns once, and the warning never carries the value", () => {
  const standard = `${GEMINI_STANDARD_KEY_PREFIX}SyFakedStandardKeyValue0123456789ab`;
  const warnings: string[] = [];
  const port = createGeminiPort({ apiKey: standard, warn: (line) => warnings.push(line) });
  assert.equal(port.providerId, GEMINI_PROVIDER_ID);
  assert.deepEqual(warnings, [GEMINI_STANDARD_KEY_WARNING], "exactly one warning at construction");
  // The credential value, its length and any substring of it must not appear.
  assert.equal(warnings[0]?.includes(standard), false);
  assert.equal(warnings[0]?.includes(standard.slice(4)), false);
  assert.equal(warnings[0]?.includes(String(standard.length)), false);
  // It says what is wrong and cites the source, so the operator can act on it.
  assert.match(warnings[0] ?? "", /standard Google API-key shape/);
  assert.match(warnings[0] ?? "", /auth keys only/);
  assert.match(warnings[0] ?? "", /ai\.google\.dev\/gemini-api\/docs\/api-key/);
});

test("A4 Gemini: an auth-shaped credential produces no warning, and no warn surface is required", () => {
  const authShaped = "ya29.faked-auth-key-value";
  const warnings: string[] = [];
  assert.equal(
    createGeminiPort({ apiKey: authShaped, warn: (line) => warnings.push(line) }).providerId,
    GEMINI_PROVIDER_ID,
  );
  assert.deepEqual(warnings, []);
  // A missing `warn` is fine: the classifier must never throw because nobody was listening.
  assert.equal(
    createGeminiPort({ apiKey: GEMINI_STANDARD_KEY_PREFIX }).providerId,
    GEMINI_PROVIDER_ID,
  );
});

// --------------------------------------------------------------- port construction

test("A4: every lane's port carries its registry id and accepts a base-URL test seam", () => {
  const ports = [
    [createMistralPort({ apiKey: SENTINEL }), MISTRAL_PROVIDER_ID],
    [createDeepseekPort({ apiKey: SENTINEL }), DEEPSEEK_PROVIDER_ID],
    [createGeminiPort({ apiKey: SENTINEL }), GEMINI_PROVIDER_ID],
    [createXaiPort({ apiKey: SENTINEL }), XAI_PROVIDER_ID],
  ] as const;
  for (const [port, id] of ports) {
    assert.equal(port.providerId, id);
    assert.equal(typeof port.streamTurn, "function");
  }
  // The seam is how the conformance tests reach a mock; production never sets it.
  for (const port of [
    createMistralPort({ apiKey: SENTINEL, baseUrl: "https://mistral-fake.invalid" }),
    createDeepseekPort({ apiKey: SENTINEL, baseUrl: "https://deepseek-fake.invalid" }),
    createGeminiPort({ apiKey: SENTINEL, baseUrl: "https://gemini-fake.invalid/v1beta" }),
    createXaiPort({ apiKey: SENTINEL, baseUrl: "https://xai-fake.invalid/v1" }),
  ]) {
    assert.equal(typeof port.streamTurn, "function");
  }
});
