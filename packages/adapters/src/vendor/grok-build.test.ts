/**
 * Grok Build lane tests (Act M1-A6). No real `grok` binary, no credentials, no network: every
 * child is the `fake-acp-agent.ts` fixture run as a real process of the test runtime. The optional
 * live step at the bottom runs only on an operator machine that opts in (never in CI).
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ProviderTurnRequest } from "../provider-port.ts";
import { createFakeAcpSpawn, FAKE_GROK_BINARY } from "../testing/index.ts";
import {
  createGrokBuildPort,
  findGrokBinary,
  GROK_API_KEY_ENV,
  GROK_AUTH_API_KEY,
  GROK_AUTH_CACHED_TOKEN,
  GROK_BUILD_PROVIDER_ID,
  grokApiKeyPresent,
  grokBuildArgs,
  grokBuildSpec,
  resolveGrokPinnedModel,
  selectGrokAuth,
} from "./grok-build.ts";

const MODEL = "grok-4.7";

function request(overrides: Partial<ProviderTurnRequest> = {}): ProviderTurnRequest {
  return {
    modelId: MODEL,
    messages: [{ role: "user", text: "say hi" }],
    signal: new AbortController().signal,
    onTextDelta: () => undefined,
    ...overrides,
  };
}

type WireMessage = { method?: string; params?: Record<string, unknown> };

async function withFakeGrok(
  mode: string,
  fn: (ctx: {
    spawn: ReturnType<typeof createFakeAcpSpawn>;
    wire: () => WireMessage[];
    spawned: () => { argv: string[]; cwd: string; xaiApiKeyPresent: boolean };
  }) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "madc-m1a6-grok-"));
  const wireLog = join(dir, "wire.jsonl");
  const argvLog = join(dir, "argv.jsonl");
  try {
    await fn({
      spawn: createFakeAcpSpawn({
        MADC_TEST_ACP_MODE: mode,
        MADC_TEST_ACP_WIRE_LOG: wireLog,
        MADC_TEST_ACP_ARGV_LOG: argvLog,
      }),
      wire: () =>
        existsSync(wireLog)
          ? readFileSync(wireLog, "utf8")
              .split("\n")
              .filter((l) => l !== "")
              .map((l) => JSON.parse(l) as WireMessage)
          : [],
      spawned: () => JSON.parse(readFileSync(argvLog, "utf8").split("\n")[0] ?? "{}"),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("argv: --no-auto-update before `agent`, own agent process, bound model, never auto-approve", () => {
  const args = grokBuildArgs(MODEL);
  assert.deepEqual(args, ["--no-auto-update", "agent", "--no-leader", "--model=grok-4.7", "stdio"]);
  // grok 1.0.44 rejects --no-auto-update after `stdio`: it must precede the subcommand.
  assert.ok(args.indexOf("--no-auto-update") < args.indexOf("agent"));
  assert.equal(args.at(-1), "stdio");
  for (const forbidden of ["--always-approve", "--yolo", "--permission-mode"]) {
    assert.ok(!args.some((arg) => arg.startsWith(forbidden)), forbidden);
  }
  // Even a hostile model name stays bound to --model (the resolver refuses it first anyway).
  assert.deepEqual(grokBuildArgs("--always-approve").slice(3, 4), ["--model=--always-approve"]);
});

test("pinnedModel: vendor model names pass; empty, flag-like, spaced or control names are refused", () => {
  for (const ok of ["grok-4.7", "grok-code-fast-1", " grok-4.7 ", "xai/grok-4.7:latest"]) {
    assert.deepEqual(resolveGrokPinnedModel(ok), { ok: true, modelId: ok.trim() });
  }
  for (const bad of ["", "   ", "--always-approve", "-m", "grok 4", "grok\n4", "grok\u0000"]) {
    const resolved = resolveGrokPinnedModel(bad);
    assert.equal(resolved.ok, false, JSON.stringify(bad));
  }
});

test("auth choice: API-key class only when XAI_API_KEY is present and offered, else cached login", () => {
  const both = [{ id: GROK_AUTH_CACHED_TOKEN }, { id: GROK_AUTH_API_KEY }];
  assert.deepEqual(selectGrokAuth(both, true), {
    methodId: GROK_AUTH_API_KEY,
    meta: { headless: true },
  });
  assert.deepEqual(selectGrokAuth(both, false), {
    methodId: GROK_AUTH_CACHED_TOKEN,
    meta: { headless: true },
  });
  assert.deepEqual(selectGrokAuth([{ id: GROK_AUTH_API_KEY }], true)?.methodId, GROK_AUTH_API_KEY);
  // Key present but only the cached login offered: use what the agent offers.
  assert.equal(selectGrokAuth([{ id: GROK_AUTH_CACHED_TOKEN }], true)?.methodId, "cached_token");
  // Nothing usable: no authenticate call at all (→ -32008 no-credentials).
  assert.equal(selectGrokAuth([{ id: GROK_AUTH_API_KEY }], false), null);
  assert.equal(selectGrokAuth([{ id: "oauth-browser" }], true), null);
  assert.equal(selectGrokAuth([], true), null);
});

test("XAI_API_KEY is tested for presence only — its value is never read", () => {
  const env = {};
  Object.defineProperty(env, GROK_API_KEY_ENV, {
    enumerable: true,
    get() {
      throw new Error("the credential value was read");
    },
  });
  assert.equal(grokApiKeyPresent(env), true);
  assert.equal(grokApiKeyPresent({}), false);
  assert.equal(grokApiKeyPresent({ OTHER: "x" }), false);
});

test("spec: registry id, xAI-documented trailing window, argv builder", () => {
  const spec = grokBuildSpec();
  assert.equal(spec.providerId, GROK_BUILD_PROVIDER_ID);
  assert.equal(spec.providerId, "grok-build");
  assert.equal(spec.trailingQuietMs, 300);
  assert.equal(spec.trailingMaxMs, 3_000);
  assert.deepEqual(spec.args(MODEL), grokBuildArgs(MODEL));
});

test("round trip: argv, headless authenticate with the cached login, env inherited unmodified", async () => {
  await withFakeGrok("ok", async ({ spawn, wire, spawned }) => {
    const port = createGrokBuildPort({
      binaryPath: FAKE_GROK_BINARY,
      spawn,
      clientVersion: "9.9.9",
      apiKeyPresent: () => false,
      trailingQuietMs: 20,
    });
    assert.equal(port.providerId, "grok-build");
    const result = await port.streamTurn(request());
    assert.equal(result.text, "fake acp answer to: say hi");
    assert.equal(result.servedModel, MODEL);
    assert.equal(result.vendorReported, true);
    const child = spawned();
    assert.deepEqual(child.argv, grokBuildArgs(MODEL));
    assert.equal(child.cwd, process.cwd());
    // madc never injects (or strips) XAI_API_KEY: the child sees exactly what this process has.
    assert.equal(child.xaiApiKeyPresent, Object.hasOwn(process.env, GROK_API_KEY_ENV));
    assert.deepEqual(
      wire().map((m) => m.method),
      ["initialize", "authenticate", "session/new", "session/prompt"],
    );
    assert.deepEqual(wire()[1]?.params, {
      methodId: "cached_token",
      _meta: { headless: true },
    });
  });
});

test("round trip: the API-key class authenticates with xai.api_key", async () => {
  await withFakeGrok("ok", async ({ spawn, wire }) => {
    const port = createGrokBuildPort({
      binaryPath: FAKE_GROK_BINARY,
      spawn,
      apiKeyPresent: () => true,
      trailingQuietMs: 20,
    });
    await port.streamTurn(request());
    assert.deepEqual(wire().find((m) => m.method === "authenticate")?.params, {
      methodId: "xai.api_key",
      _meta: { headless: true },
    });
  });
});

test("no sign-in: an agent offering nothing usable fails no-credentials before any prompt", async () => {
  await withFakeGrok("no-auth", async ({ spawn, wire }) => {
    const port = createGrokBuildPort({ binaryPath: FAKE_GROK_BINARY, spawn });
    await assert.rejects(port.streamTurn(request()), (err: unknown) => {
      assert.ok(err instanceof Error && "reason" in err);
      assert.equal((err as { reason?: string }).reason, "no-credentials");
      assert.equal(err.message, "grok-build offers no usable sign-in");
      return true;
    });
    assert.ok(!wire().some((m) => m.method === "session/prompt"));
  });
});

test("binary detection is a read-only PATH lookup for `grok`", () => {
  assert.equal(findGrokBinary({ PATH: "" }), null);
  const dir = fileURLToPath(new URL("../testing/", import.meta.url));
  // A directory on PATH without a `grok` executable: not found (nothing is executed).
  assert.equal(findGrokBinary({ PATH: dir }), null);
});

/**
 * Forbidden paths (M1 plan §7 M1-A6; roadmap D-R4) as a source guard: the Grok Build lane and the
 * generic ACP client never touch a home directory or a vendor credential store, never read files
 * at all, never import pi-ai (no xAI OAuth), and never set --always-approve. Comments are stripped
 * first, so the prose that NAMES the forbidden paths does not trip the guard.
 */
test("source guard: no ~/.grok, no file reads, no pi-ai import, no --always-approve in code", () => {
  const vendorDir = fileURLToPath(new URL("./", import.meta.url));
  const sources = [
    join(vendorDir, "grok-build.ts"),
    ...readdirSync(join(vendorDir, "acp-client"))
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .map((name) => join(vendorDir, "acp-client", name)),
  ];
  assert.ok(sources.length >= 4);
  for (const path of sources) {
    const code = readFileSync(path, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    for (const banned of [
      /\.grok\b/,
      /homedir/,
      /readFile/,
      /createReadStream/,
      /@earendil-works\/pi-ai/,
      /always-approve/,
      /yolo/,
      /oauth/i,
    ]) {
      assert.ok(!banned.test(code), `${path} matches ${banned}`);
    }
  }
});

// Live step (optional; runbook docs/runbook/M1.md §1): only on an operator machine that has the
// unmodified `grok` on PATH, is signed in (`grok login`) or exports XAI_API_KEY, and opts in by
// naming a model via MADC_TEST_GROK_LIVE_MODEL. CI has neither, so this is always skipped there.
// Nothing is recorded beyond pass/fail — the prompt is fixed and trivial and the answer is never
// printed. Conditional `test.skip` registration: bun 1.3.11's node:test shim (CI) ignores the
// options-object `skip`.
const LIVE_GROK = findGrokBinary(process.env);
const LIVE_MODEL = process.env.MADC_TEST_GROK_LIVE_MODEL;
if (LIVE_GROK === null || LIVE_MODEL === undefined || LIVE_MODEL.trim() === "") {
  test.skip("live: the real unmodified grok agent stdio answers one turn");
} else {
  test("live: the real unmodified grok agent stdio answers one turn", {
    timeout: 180_000,
  }, async () => {
    const port = createGrokBuildPort({ binaryPath: LIVE_GROK as string });
    const result = await port.streamTurn(
      request({
        modelId: (LIVE_MODEL as string).trim(),
        messages: [{ role: "user", text: "Reply with the single word: ok" }],
      }),
    );
    assert.ok(result.text.length > 0, "empty result text");
    assert.ok(result.servedModel.length > 0, "no servedModel");
  });
}
