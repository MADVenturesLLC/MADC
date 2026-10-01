/**
 * M1-A8 acceptance (protocol pin §3.5 P4, §5 `ProviderSummary`, §8.3): `provider/list` round-trips
 * over the JSONL protocol, covers every catalog entry, reports presence as booleans only, and
 * judges terms freshness against the registry's 30-day window. The engine runs as a child process
 * (echo fixture) against the FAKE keychain with SYNTHETIC keys, and in-process with an injected
 * clock — never a real keychain, never a real credential, never a vendor binary executed.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import { isStale, listCatalog } from "@madc/registry";
import { echoAgent } from "../agent.ts";
import { ErrorCode } from "../protocol/errors.ts";
import type { ProviderListParams, ProviderSummary } from "../protocol/types.ts";
import { EngineConnection } from "../server.ts";
import { ECHO_ENGINE, expectRpcError, handshake, startEngine } from "../testing/harness.ts";
import { keychainEnv, writeKeychainShims } from "../testing/keychain-shim.ts";
import { listProviderSummaries, type ProviderPresence } from "./list.ts";

const SYNTHETIC = "sk-synthetic-provider-list-test-0123456789";
const BASE_KEYS = ["id", "status", "wired", "verifiedAt", "stale"];

/** Temp home, fake keychain (darwin shape) and a PATH dir that holds only what a test plants. */
function sandbox(): {
  home: string;
  bin: string;
  env: Record<string, string>;
  accountFile: (providerId: string) => string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "madc-a8-providers-"));
  const shims = writeKeychainShims(join(root, "shims"));
  const accounts = join(root, "accounts");
  mkdirSync(accounts, { recursive: true });
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  return {
    home: join(root, "home"),
    bin,
    env: { ...keychainEnv(shims, accounts, "darwin"), PATH: bin },
    accountFile: (providerId) => join(accounts, encodeURIComponent(providerId)),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** A file that a PATH lookup finds (regular, executable). It is never run: it exits 97 if it is. */
function plantBinary(dir: string, name: string): void {
  const path = join(dir, name);
  writeFileSync(path, "#!/bin/sh\nexit 97\n");
  chmodSync(path, 0o755);
}

/** The presence field a `connect` value may carry (protocol types: one or neither, never both). */
function allowedKeys(entryConnect: string, hasBinaryAdapter: boolean): string[] {
  if (entryConnect === "direct") return [...BASE_KEYS, "credentialsPresent"].sort();
  if (entryConnect === "vendor-agent" && hasBinaryAdapter) {
    return [...BASE_KEYS, "binaryPresent"].sort();
  }
  return [...BASE_KEYS].sort();
}

const BINARY_LANES = new Set(["claude-code", "codex", "grok-build"]);

test("A8 §3.5 provider/list covers every catalog entry, in catalog order, with presence only", async () => {
  const sb = sandbox();
  plantBinary(sb.bin, "claude");
  writeFileSync(sb.accountFile("mistral-pro"), SYNTHETIC, { mode: 0o600 });
  const client = startEngine(sb.home, ECHO_ENGINE, sb.env);
  try {
    await handshake(client);
    const { data } = await client.request("provider/list", {});
    const catalog = listCatalog();
    assert.deepStrictEqual(
      data.map((p) => p.id),
      catalog.map((e) => e.id),
      "every entry — wired, unwired and forbidden — in catalog order",
    );
    const now = Date.now();
    for (const entry of catalog) {
      const row = data.find((p) => p.id === entry.id) as ProviderSummary;
      assert.deepStrictEqual(
        Object.keys(row).sort(),
        allowedKeys(entry.connect, BINARY_LANES.has(entry.id)),
        `${entry.id}: exactly the pinned fields for a ${entry.connect} lane`,
      );
      assert.equal(row.status, entry.status);
      assert.equal(row.wired, entry.wired);
      assert.equal(row.verifiedAt, entry.verifiedAt);
      assert.equal(row.stale, isStale(entry, now), `${entry.id}: stale is the registry's answer`);
    }
    const byId = new Map(data.map((p) => [p.id, p]));
    // Credential presence: only the one stored key.
    for (const p of data) {
      if (p.credentialsPresent !== undefined) {
        assert.equal(p.credentialsPresent, p.id === "mistral-pro", `${p.id} credentials`);
      }
    }
    // Binary presence: the planted `claude` is found; codex and grok are not on this PATH.
    assert.equal(byId.get("claude-code")?.binaryPresent, true);
    assert.equal(byId.get("codex")?.binaryPresent, false);
    assert.equal(byId.get("grok-build")?.binaryPresent, false);
    // A vendor-agent entry with no adapter in this build carries no guess.
    assert.equal(Object.hasOwn(byId.get("github-copilot") ?? {}, "binaryPresent"), false);
    // Forbidden entries carry neither presence field.
    for (const p of data.filter((x) => x.status === "forbidden")) {
      assert.equal(Object.hasOwn(p, "credentialsPresent"), false, p.id);
      assert.equal(Object.hasOwn(p, "binaryPresent"), false, p.id);
    }
    // Presence only: no response on the wire carries the stored value (or a fragment of it).
    const wire = JSON.stringify(client.messages);
    assert.ok(!wire.includes(SYNTHETIC), "the secret never crosses the protocol stream");
    assert.ok(!wire.includes(SYNTHETIC.slice(0, 12)), "not even a prefix of it");
  } finally {
    await client.close();
    sb.cleanup();
  }
});

test("A8 §3.5 provider/list takes no params (-32602) and is refused before initialize (-32000)", async () => {
  const sb = sandbox();
  const client = startEngine(sb.home, ECHO_ENGINE, sb.env);
  try {
    const early = await expectRpcError(client.request("provider/list", {}));
    assert.equal(early.code, ErrorCode.NotInitialized);
    await handshake(client);
    const bad = await expectRpcError(
      client.request("provider/list", { providerId: "kimi-code" } as unknown as ProviderListParams),
    );
    assert.equal(bad.code, ErrorCode.InvalidParams);
    assert.deepStrictEqual(bad.data, {
      issues: ["provider/list takes no params (got providerId)"],
    });
    // Absent params are the pinned `{}` too.
    const { data } = await client.request(
      "provider/list",
      undefined as unknown as ProviderListParams,
    );
    assert.equal(data.length, listCatalog().length);
  } finally {
    await client.close();
    sb.cleanup();
  }
});

/** In-process engine with injected presence and clock; answers one `provider/list`. */
async function listInProcess(
  presence: ProviderPresence,
  now: number,
): Promise<readonly ProviderSummary[]> {
  const root = mkdtempSync(join(tmpdir(), "madc-a8-providers-ip-"));
  const input = new PassThrough();
  const lines: Array<Record<string, unknown>> = [];
  const output = new Writable({
    write(chunk, _enc, cb) {
      for (const line of String(chunk).split("\n")) if (line !== "") lines.push(JSON.parse(line));
      cb();
    },
  });
  const conn = new EngineConnection({
    input,
    output,
    home: join(root, "home"),
    agent: echoAgent,
    log: () => {},
    providerPresence: presence,
    now: () => now,
  });
  const done = conn.run();
  try {
    input.write(
      `${JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "t", version: "0" } } })}\n`,
    );
    input.write(`${JSON.stringify({ id: 2, method: "provider/list", params: {} })}\n`);
    const deadline = Date.now() + 5_000;
    for (;;) {
      const hit = lines.find((m) => m.id === 2);
      if (hit !== undefined) {
        return (hit.result as { data: ProviderSummary[] }).data;
      }
      if (Date.now() > deadline) throw new Error("provider/list timed out");
      await new Promise((r) => setTimeout(r, 5));
    }
  } finally {
    input.end();
    await done;
    rmSync(root, { recursive: true, force: true });
  }
}

const NONE: ProviderPresence = { credentials: async () => false, binary: () => false };

test("A8 stale follows the registry's 30-day window on the engine's clock (D-M1-6)", async () => {
  // Every wired entry was verified 2026-09-24: exactly 30 days later is not stale, 31 days is.
  const fresh = await listInProcess(NONE, Date.parse("2026-10-24T00:00:00Z"));
  const stale = await listInProcess(NONE, Date.parse("2026-10-25T00:00:00Z"));
  for (const entry of listCatalog()) {
    const f = fresh.find((p) => p.id === entry.id);
    const s = stale.find((p) => p.id === entry.id);
    if (entry.verifiedAt === "2026-09-24") {
      assert.equal(f?.stale, false, `${entry.id} fresh on day 30`);
      assert.equal(s?.stale, true, `${entry.id} stale on day 31`);
    }
    if (entry.verifiedAt === "") {
      // Never verified: stale on every clock (fail-closed, registry M1-A1).
      assert.equal(f?.stale, true, `${entry.id} never verified`);
      assert.equal(s?.stale, true, `${entry.id} never verified`);
    }
  }
});

test("A8 a credential probe that fails reports absent, never present", async () => {
  const data = await listProviderSummaries(
    {
      credentials: async (id) => {
        if (id === "kimi-code") throw new Error("keychain backend hung");
        return id === "xai-api";
      },
      binary: (id) => (id === "codex" ? true : id === "claude-code" ? false : null),
    },
    Date.parse("2026-09-30T00:00:00Z"),
  );
  const byId = new Map(data.map((p) => [p.id, p]));
  assert.equal(byId.get("kimi-code")?.credentialsPresent, false);
  assert.equal(byId.get("xai-api")?.credentialsPresent, true);
  assert.equal(byId.get("codex")?.binaryPresent, true);
  assert.equal(byId.get("claude-code")?.binaryPresent, false);
  // `null` from the binary probe = no adapter in this build: the field is omitted, not guessed.
  assert.equal(Object.hasOwn(byId.get("grok-build") ?? {}, "binaryPresent"), false);
});
