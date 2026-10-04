/**
 * M1-A2 acceptance (protocol pin §3.5 and §8.3) — the `auth/*` presence methods over the JSONL
 * protocol, the no-secret schema test, and the redactor's new key shapes (seat pin §4.2 / S6).
 * The engine runs as a child process (echo fixture); credentials live in the FAKE keychain with
 * SYNTHETIC keys only — never a real keychain, never a real credential.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultAgentFactory } from "./main.ts";
import { denyAllRepoPolicy } from "./policy/store.ts";
import { ErrorCode } from "./protocol/errors.ts";
import { CLIENT_REQUEST_METHODS, CLIENT_REQUEST_PARAM_FIELDS } from "./protocol/types.ts";
import { createRedactor, REDACTED, verifySessionFile } from "./session-store.ts";
import { ECHO_ENGINE, expectRpcError, handshake, startEngine } from "./testing/harness.ts";
import { keychainEnv, writeKeychainShims } from "./testing/keychain-shim.ts";

const SYNTHETIC = "sk-synthetic-auth-proto-test-0123456789";

/** Temp home + fake-keychain seams for one engine child (darwin shape by default). */
function authSandbox(): {
  home: string;
  accounts: string;
  env: Record<string, string>;
  accountFile: (providerId: string) => string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "madc-a2-auth-"));
  const shims = writeKeychainShims(join(root, "bin"));
  const accounts = join(root, "accounts");
  mkdirSync(accounts, { recursive: true });
  return {
    home: join(root, "home"),
    accounts,
    env: keychainEnv(shims, accounts, "darwin"),
    accountFile: (providerId) => join(accounts, encodeURIComponent(providerId)),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Every wire message the client saw, serialized — the no-secret assertions scan this. */
function wireText(client: { messages: readonly unknown[] }): string {
  return JSON.stringify(client.messages);
}

// ----------------------------------------------------------------------- §3.5 auth/status

test("A2 §3.5 auth/status answers the exact pinned presence shape — and nothing else", async () => {
  const sb = authSandbox();
  const client = startEngine(sb.home, ECHO_ENGINE, sb.env);
  try {
    await handshake(client);
    const absent = await client.request("auth/status", { providerId: "kimi-code" });
    // deepStrictEqual pins the wire shape: presence only, never a value, no extra fields.
    assert.deepStrictEqual(absent, { providerId: "kimi-code", present: false });

    writeFileSync(sb.accountFile("kimi-code"), SYNTHETIC, { mode: 0o600 });
    const present = await client.request("auth/status", { providerId: "kimi-code" });
    assert.deepStrictEqual(present, { providerId: "kimi-code", present: true });
    assert.ok(!wireText(client).includes(SYNTHETIC), "no protocol response carries the secret");

    // Presence queries are harmless on every catalog lane, forbidden ones included.
    const forbidden = await client.request("auth/status", { providerId: "zai-glm-coding-plan" });
    assert.deepStrictEqual(forbidden, { providerId: "zai-glm-coding-plan", present: false });
  } finally {
    await client.close();
    sb.cleanup();
  }
});

test("A2 env fallback reaches presence only under MADC_DEV_ENV_KEYS=1 (D-M1-5)", async () => {
  const sb = authSandbox();
  const flagged = startEngine(sb.home, ECHO_ENGINE, {
    ...sb.env,
    MADC_DEV_ENV_KEYS: "1",
    KIMI_API_KEY: SYNTHETIC,
  });
  try {
    await handshake(flagged);
    const present = await flagged.request("auth/status", { providerId: "kimi-code" });
    assert.deepStrictEqual(present, { providerId: "kimi-code", present: true });
    assert.ok(!wireText(flagged).includes(SYNTHETIC));
  } finally {
    await flagged.close();
  }
  // Same env key, flag unset: the environment never satisfies presence.
  const unflagged = startEngine(sb.home, ECHO_ENGINE, { ...sb.env, KIMI_API_KEY: SYNTHETIC });
  try {
    await handshake(unflagged);
    const absent = await unflagged.request("auth/status", { providerId: "kimi-code" });
    assert.deepStrictEqual(absent, { providerId: "kimi-code", present: false });
  } finally {
    await unflagged.close();
    sb.cleanup();
  }
});

// ----------------------------------------------------------------------- §3.5 auth/remove

test("A2 §3.5 auth/remove removes through the store and is idempotent", async () => {
  const sb = authSandbox();
  const client = startEngine(sb.home, ECHO_ENGINE, sb.env);
  try {
    await handshake(client);
    writeFileSync(sb.accountFile("kimi-code"), SYNTHETIC, { mode: 0o600 });
    assert.deepStrictEqual(await client.request("auth/remove", { providerId: "kimi-code" }), {});
    assert.equal(existsSync(sb.accountFile("kimi-code")), false);
    assert.deepStrictEqual(await client.request("auth/status", { providerId: "kimi-code" }), {
      providerId: "kimi-code",
      present: false,
    });
    // Removing an absent credential succeeds (exit-44 path tolerated engine-side).
    assert.deepStrictEqual(await client.request("auth/remove", { providerId: "kimi-code" }), {});
    assert.ok(!wireText(client).includes(SYNTHETIC));
  } finally {
    await client.close();
    sb.cleanup();
  }
});

// ----------------------------------------------------------------------------- validation

test("A2 auth/* validation: id grammar and catalog membership → -32602; before initialize → -32000", async () => {
  const sb = authSandbox();
  const client = startEngine(sb.home, ECHO_ENGINE, sb.env);
  try {
    // Before `initialize`: -32000 with the method name (protocol pin §2).
    const early = await expectRpcError(client.request("auth/status", { providerId: "kimi-code" }));
    assert.equal(early.code, ErrorCode.NotInitialized);
    assert.deepStrictEqual(early.data, { method: "auth/status" });

    await handshake(client);
    for (const method of ["auth/status", "auth/remove"] as const) {
      const missing = await expectRpcError(client.request(method, {}));
      assert.equal(missing.code, ErrorCode.InvalidParams, method);
      const missingIssues = missing.data?.issues;
      assert.ok(
        Array.isArray(missingIssues) && missingIssues.includes("providerId is required"),
        method,
      );

      const grammar = await expectRpcError(client.request(method, { providerId: "../escape" }));
      assert.equal(grammar.code, ErrorCode.InvalidParams, method);

      const unknown = await expectRpcError(
        client.request(method, { providerId: "no-such-provider" }),
      );
      assert.equal(unknown.code, ErrorCode.InvalidParams, method);
      const unknownIssues = unknown.data?.issues;
      assert.ok(
        Array.isArray(unknownIssues) &&
          unknownIssues.includes("providerId is not a registry catalog id"),
        method,
      );
    }
  } finally {
    await client.close();
    sb.cleanup();
  }
});

// ------------------------------------------------- no secret ever crosses the protocol (P4)

test("A2 §3.5/P4 there is no auth/set over JSONL: -32601, the secret is never echoed and nothing is stored", async () => {
  const sb = authSandbox();
  const client = startEngine(sb.home, ECHO_ENGINE, sb.env);
  try {
    await handshake(client);
    const err = await expectRpcError(
      client.request("auth/set", { providerId: "kimi-code", secret: SYNTHETIC }),
    );
    assert.equal(err.code, ErrorCode.MethodNotFound);
    assert.deepStrictEqual(err.data, { method: "auth/set" });
    assert.ok(!wireText(client).includes(SYNTHETIC), "the error path never echoes the secret");
    assert.equal(existsSync(sb.accountFile("kimi-code")), false);
  } finally {
    await client.close();
    sb.cleanup();
  }
});

test("A2 schema test: no JSONL method accepts a secret value (pin §8.3)", () => {
  // The complete M1 method list, as pinned (protocol pin §3): M0's six, the two presence methods
  // (M1-A2), `seat/list` (M1-A7) and `provider/list` (M1-A8); plus `thread/handoff`, the one
  // method the M2 handoff procedure pin authorizes (M2-A2). No `auth/set`, and nothing whose name
  // suggests a secret-carrying request.
  assert.deepStrictEqual(
    [...CLIENT_REQUEST_METHODS],
    [
      "initialize",
      "thread/start",
      "thread/resume",
      "thread/list",
      "turn/start",
      "turn/interrupt",
      "seat/list",
      "provider/list",
      "auth/status",
      "auth/remove",
      "thread/handoff",
    ],
  );
  assert.ok(!CLIENT_REQUEST_METHODS.some((m) => /set|secret|credential|token/i.test(m)));
  // Every method's declared top-level params fields are exactly the known non-secret set.
  assert.deepStrictEqual(
    Object.keys(CLIENT_REQUEST_PARAM_FIELDS).sort(),
    [...CLIENT_REQUEST_METHODS].sort(),
  );
  const NON_SECRET_FIELDS = new Set([
    "clientInfo",
    "seatId",
    "cwd",
    "threadId",
    "limit",
    "cursor",
    "input",
    // M1-A5 (protocol pin §3.3 P3): the turn's mode claim, the enum "interactive" | "headless".
    "mode",
    "turnId",
    "providerId",
    // M2-A2 (`thread/handoff`): a seat id, and the brief — free text like `input`, redacted before
    // it is hashed and written (evidence pin rule 1.4) and never echoed in an error's `data`.
    "targetSeatId",
    "brief",
  ]);
  for (const [method, fields] of Object.entries(CLIENT_REQUEST_PARAM_FIELDS)) {
    // `seat/list` and `provider/list` are the two methods protocol pin §3.5 gives empty params
    // (`{}`): they declare no field, which is the strongest possible no-secret shape. Every other
    // method declares some.
    if (method === "seat/list" || method === "provider/list") {
      assert.deepStrictEqual([...fields], [], `${method} takes no params`);
      continue;
    }
    assert.ok(fields.length > 0, `${method} declares its params`);
    for (const field of fields) {
      assert.ok(NON_SECRET_FIELDS.has(field), `${method}.${field} is not a declared field`);
      assert.ok(
        !/secret|key|token|credential|password|value/i.test(field),
        `${method}.${field} looks secret-carrying`,
      );
    }
  }
});

test("A2 a raw secret line on the session stdin stays a -32700 parse error and is never echoed", async () => {
  const sb = authSandbox();
  const client = startEngine(sb.home, ECHO_ENGINE, sb.env);
  try {
    await handshake(client);
    // Stdin in a JSONL session is pure protocol: a bare secret line hits the parse-error path.
    client.sendRaw(SYNTHETIC);
    const msg = await client.waitFor(
      (m) => m.id === null && (m.error as { code?: number } | undefined)?.code === -32700,
      10_000,
    );
    const error = msg.error as { code: number; message: string; data?: unknown };
    assert.equal(error.code, ErrorCode.ParseError);
    assert.equal(error.data, undefined, "-32700 carries no data (pin §4.1)");
    assert.ok(!wireText(client).includes(SYNTHETIC), "the parse-error path never echoes the line");
    assert.equal(existsSync(sb.accountFile("kimi-code")), false);
  } finally {
    await client.close();
    sb.cleanup();
  }
});

// ------------------------------------------------------- redaction (seat pin §4.2 / S6, plan G)

test("A2/A4 redaction: xai-…, sk-sp-…, AIza… and generic sk-… shapes never persist, and the chain still verifies", async () => {
  const sb = authSandbox();
  const client = startEngine(sb.home, ECHO_ENGINE, sb.env);
  try {
    await handshake(client);
    const { thread } = await client.request("thread/start", {});
    const xai = "xai-synthetic-redaction-key-0123456789";
    const plan = "sk-sp-synthetic-plan-key-0123456789";
    const generic = "sk-synthetic-generic-key-0123456789abcdef";
    // S6 (M1-A4): the Gemini lane's standard Google API-key shape.
    const gemini = "AIzaSySyntheticGeminiKeyValue0123456789";
    const text = `pasted ${xai} and ${plan} and ${generic} and ${gemini}`;
    const { turn } = await client.request("turn/start", {
      threadId: thread.id,
      input: [{ type: "text", text }],
    });
    await client.waitForNotification("turn/completed", (p) => p.turn.id === turn.id);

    const path = join(sb.home, "sessions", `${thread.id}.jsonl`);
    const onDisk = readFileSync(path, "utf8");
    for (const secret of [xai, plan, generic, gemini]) {
      assert.ok(!onDisk.includes(secret), `${secret.slice(0, 8)}… must never persist`);
    }
    assert.ok(onDisk.includes(REDACTED));
    // turn.start carries the user text — it must hold the redacted forms.
    const turnStart = onDisk
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as { type: string; payload: Record<string, unknown> })
      .find((e) => e.type === "turn.start");
    assert.ok(JSON.stringify(turnStart?.payload).includes(REDACTED));

    // Redaction runs BEFORE hashing, so the chain covers exactly the redacted bytes on disk.
    const verified = verifySessionFile(path, thread.id, {}, sb.home);
    assert.ok(verified.ok, "the hash chain still verifies over the redacted lines");
  } finally {
    await client.close();
    sb.cleanup();
  }
});

test("A2 the redactor learns every stored key: the store-resolved credential is redacted by exact value", async () => {
  const root = mkdtempSync(join(tmpdir(), "madc-a2-learn-"));
  const saved: Record<string, string | undefined> = {};
  try {
    const shims = writeKeychainShims(join(root, "bin"));
    const accounts = join(root, "accounts");
    mkdirSync(accounts, { recursive: true });
    // A credential with NO token shape: only exact-value learning can catch it.
    const learned = "synthetic-learned-value-with-no-token-shape-01";
    writeFileSync(join(accounts, "kimi-code"), learned, { mode: 0o600 });
    const env = keychainEnv(shims, accounts, "darwin");
    for (const [name, value] of Object.entries(env)) {
      saved[name] = process.env[name];
      process.env[name] = value;
    }
    const agent = await defaultAgentFactory({
      home: join(root, "home"),
      repoPolicy: denyAllRepoPolicy(),
    });
    assert.deepStrictEqual([...(agent.redactValues ?? [])], [learned]);
    const redacted = createRedactor(agent.redactValues ?? [])({
      text: `before ${learned} after`,
    }) as { text: string };
    assert.equal(redacted.text, `before ${REDACTED} after`);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
