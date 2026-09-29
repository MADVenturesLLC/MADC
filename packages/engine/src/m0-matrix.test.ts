/**
 * M0-A8 matrix (plan §10 criterion E — the matrix/tests half of the act; criterion F is the
 * runbook at docs/runbook/M0.md): the always-in-CI guarantee, auditable by file name in CI
 * logs. This file is self-contained — no paid keys, no vendor binaries, no network:
 *
 *  1. Registry FORBID: a forbidden provider throws via `assertAllowed` (fail-closed).
 *  2. Registry ALLOW: `kimi-code` direct, and `claude-code` + `codex` vendor-agent intents, pass.
 *  3. The M0 happy path end to end — engine `thread/start` → `turn/start` → items →
 *     `turn/completed` → `servedModel` receipt → the session JSONL hash chain verifies — against
 *     `testing/kimi-fake-engine.ts`: the production provider agent over an in-process fake
 *     transport on a `.invalid` host (RFC 6761: never resolves). The key is a dummy sentinel; the
 *     harness strips any real credential from the child env.
 *
 * The full suite runs on Node 22.19 + Bun (`.github/workflows/ci.yml`); nothing here is gated on
 * keys, PATH entries, or platform, so every test in this file runs in every CI job.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { assertAllowed, RegistryDeniedError } from "@madc/registry";
import type { Item, Turn } from "./protocol/types.ts";
import { verifySessionFile } from "./session-store.ts";
import {
  handshake,
  KIMI_FAKE_ENGINE,
  makeHome,
  startEngineCapturingStderr,
} from "./testing/harness.ts";

// ------------------------------------------------------------------ 1. registry forbid

test("matrix forbid: forbidden providers throw via assertAllowed (fail-closed)", () => {
  for (const providerId of [
    "zai-glm-coding-plan",
    "gemini-antigravity-signin",
    "chatgpt-token-replay",
    "claude-subscription-http",
  ]) {
    assert.throws(
      () => assertAllowed({ providerId, mode: "headless", connect: "direct", requireLive: true }),
      (err: unknown) => err instanceof RegistryDeniedError && err.reason === "forbidden",
      providerId,
    );
  }
  // Fail-closed on the unknown too: an id the catalog does not carry is denied, never defaulted.
  assert.throws(
    () =>
      assertAllowed({
        providerId: "not-a-real-provider",
        mode: "headless",
        connect: "direct",
      }),
    (err: unknown) => err instanceof RegistryDeniedError && err.reason === "unknown-provider",
  );
});

// ------------------------------------------------------------------ 2. registry allow

test("matrix allow: kimi-code direct, claude-code + codex vendor-agent intents pass", () => {
  const kimi = assertAllowed({
    providerId: "kimi-code",
    mode: "headless",
    connect: "direct",
    requireLive: true,
  });
  assert.equal(kimi.status, "allowed-direct");
  assert.equal(kimi.wired, true);

  for (const providerId of ["claude-code", "codex"] as const) {
    const entry = assertAllowed({
      providerId,
      mode: "headless",
      connect: "vendor-agent",
      requireLive: true,
    });
    assert.equal(entry.status, "allowed-via-vendor-agent", providerId);
    assert.equal(entry.wired, true, providerId);
    // …and the same backing is refused on a direct intent (vendor-agent only).
    assert.throws(
      () => assertAllowed({ providerId, mode: "headless", connect: "direct", requireLive: true }),
      (err: unknown) => err instanceof RegistryDeniedError && err.reason === "connect-mismatch",
      providerId,
    );
  }
});

// ------------------------------------------------------------------ 3. M0 happy path

test("matrix happy path: thread → turn → items → servedModel receipt → session chain verifies", async () => {
  const { home, cleanup } = makeHome();
  const { client } = startEngineCapturingStderr(home, KIMI_FAKE_ENGINE, {
    KIMI_API_KEY: "test-sentinel-key-m0-matrix",
    MADC_TEST_KIMI_REPLY: JSON.stringify({
      type: "stream",
      chunks: ["Hi", " from", " Kimi"],
      model: "kimi-for-coding-2026-09",
    }),
  });
  try {
    await handshake(client);
    const { thread } = await client.request("thread/start", {});
    const threadId = (thread as { id: string }).id;
    const { turn } = await client.request("turn/start", {
      threadId,
      input: [{ type: "text", text: "say hi" }],
    });
    const turnId = (turn as { id: string }).id;
    const done = await client.waitFor(
      (m) => m.method === "turn/completed" && (m.params as { turn: Turn }).turn.id === turnId,
    );
    const final = (done.params as { turn: Turn }).turn;

    assert.equal(final.status, "completed");
    assert.equal(final.error, null);
    assert.deepEqual(
      final.items.map((item) => item.kind),
      ["userMessage", "agentMessage", "servedModel"],
    );
    const agent = final.items[1] as Extract<Item, { kind: "agentMessage" }>;
    assert.equal(agent.text, "Hi from Kimi");

    // The servedModel receipt: what was asked, what served, and which backing/provider served it.
    const receipt = final.items[2] as Extract<Item, { kind: "servedModel" }>;
    assert.deepEqual(
      { ...receipt, id: "" },
      {
        id: "",
        kind: "servedModel",
        status: "completed",
        requestedModel: "kimi-coding/kimi-for-coding",
        servedModel: "kimi-for-coding-2026-09",
        backing: "kimi-code",
        providerId: "kimi-code",
        // M1 P2 fields (protocol pin §5): upstream reported a different model.
        lane: "allowed-direct",
        mode: "headless",
        fallbackFrom: null,
        vendorReported: true,
      },
    );
    assert.deepEqual(client.protocolViolations, []);

    // The session JSONL: the pinned event sequence, a continuous seq, and a chain that verifies.
    const path = join(home, "sessions", `${threadId}.jsonl`);
    const events = readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as { seq: number; type: string });
    // The receipt is dual-written (seat pin §4.2): an `item` event plus the dedicated
    // `servedModel` event, one append batch, so the third `item` is the receipt itself.
    assert.deepEqual(
      events.map((e) => e.type),
      ["session.open", "turn.start", "item", "item", "item", "servedModel", "turn.end"],
    );
    assert.deepEqual(
      events.map((e) => e.seq),
      events.map((_, i) => i),
      "seq is continuous 0..n-1",
    );
    const verified = verifySessionFile(path, threadId);
    assert.equal(verified.ok, true, verified.ok ? "" : `line ${verified.line}: ${verified.reason}`);
  } finally {
    await client.close();
    cleanup();
  }
});
