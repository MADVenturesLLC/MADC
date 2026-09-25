import assert from "node:assert/strict";
import { test } from "node:test";
import { assertAllowed, getById, listCatalog, RegistryDeniedError } from "./index.ts";

test("catalog lists M0 live providers and required stubs", () => {
  const ids = new Set(listCatalog().map((e) => e.id));
  for (const id of [
    "kimi-code",
    "claude-code",
    "codex",
    "ollama-cloud",
    "zai-glm-coding-plan",
    "gemini-antigravity-signin",
    "chatgpt-token-replay",
    "claude-subscription-http",
    "minimax-token-plan",
    "alibaba-coding-plan",
    "mistral-pro",
    "deepseek-payg",
  ]) {
    assert.ok(ids.has(id), `missing catalog entry: ${id}`);
  }

  assert.equal(getById("kimi-code")?.wired, true);
  assert.equal(getById("claude-code")?.wired, true);
  assert.equal(getById("codex")?.wired, true);
  assert.equal(getById("ollama-cloud")?.wired, false);

  for (const entry of listCatalog()) {
    assert.ok(entry.sourceQuote.length > 0, `${entry.id} missing sourceQuote`);
    assert.ok(entry.sourceUrl.length > 0, `${entry.id} missing sourceUrl`);
  }
});

test("forbidden path throws", () => {
  for (const id of [
    "zai-glm-coding-plan",
    "gemini-antigravity-signin",
    "chatgpt-token-replay",
    "claude-subscription-http",
  ]) {
    assert.throws(
      () =>
        assertAllowed({
          providerId: id,
          mode: "interactive",
          connect: "direct",
        }),
      (err: unknown) => err instanceof RegistryDeniedError && err.reason === "forbidden",
    );
  }
});

test("unknown provider denied (fail-closed)", () => {
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

test("interactive-only blocked in headless", () => {
  assert.throws(
    () =>
      assertAllowed({
        providerId: "minimax-token-plan",
        mode: "headless",
        connect: "direct",
      }),
    (err: unknown) =>
      err instanceof RegistryDeniedError && err.reason === "interactive-only-headless",
  );

  assert.throws(
    () =>
      assertAllowed({
        providerId: "alibaba-coding-plan",
        mode: "headless",
        connect: "direct",
      }),
    (err: unknown) =>
      err instanceof RegistryDeniedError && err.reason === "interactive-only-headless",
  );

  const allowed = assertAllowed({
    providerId: "minimax-token-plan",
    mode: "interactive",
    connect: "direct",
  });
  assert.equal(allowed.id, "minimax-token-plan");
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
});

test("claude-code and codex require vendor-agent; direct denied", () => {
  for (const id of ["claude-code", "codex"] as const) {
    assert.throws(
      () =>
        assertAllowed({
          providerId: id,
          mode: "headless",
          connect: "direct",
          requireLive: true,
        }),
      (err: unknown) => err instanceof RegistryDeniedError && err.reason === "connect-mismatch",
    );

    const entry = assertAllowed({
      providerId: id,
      mode: "interactive",
      connect: "vendor-agent",
      requireLive: true,
    });
    assert.equal(entry.status, "allowed-via-vendor-agent");
    assert.equal(entry.wired, true);
  }
});

test("unwired allowed-direct denied when live required; stub lookup ok", () => {
  const stub = getById("ollama-cloud");
  assert.ok(stub);
  assert.equal(stub.status, "allowed-direct");
  assert.equal(stub.wired, false);

  assert.throws(
    () =>
      assertAllowed({
        providerId: "ollama-cloud",
        mode: "headless",
        connect: "direct",
        requireLive: true,
      }),
    (err: unknown) => err instanceof RegistryDeniedError && err.reason === "unwired",
  );

  const allowedStub = assertAllowed({
    providerId: "ollama-cloud",
    mode: "headless",
    connect: "direct",
  });
  assert.equal(allowedStub.id, "ollama-cloud");
});

test("allowed-direct rejects vendor-agent intent", () => {
  assert.throws(
    () =>
      assertAllowed({
        providerId: "kimi-code",
        mode: "headless",
        connect: "vendor-agent",
      }),
    (err: unknown) => err instanceof RegistryDeniedError && err.reason === "connect-mismatch",
  );
});

test("catalog entries are frozen; mutation cannot poison assertAllowed", () => {
  const unwired = getById("ollama-cloud");
  assert.ok(unwired);
  assert.equal(unwired.wired, false);
  assert.throws(
    () => {
      (unwired as { wired: boolean }).wired = true;
    },
    (err: unknown) => err instanceof TypeError,
  );
  assert.equal(getById("ollama-cloud")?.wired, false);
  assert.throws(
    () =>
      assertAllowed({
        providerId: "ollama-cloud",
        mode: "headless",
        connect: "direct",
        requireLive: true,
      }),
    (err: unknown) => err instanceof RegistryDeniedError && err.reason === "unwired",
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
  assert.throws(
    () =>
      assertAllowed({
        providerId: "zai-glm-coding-plan",
        mode: "interactive",
        connect: "direct",
      }),
    (err: unknown) => err instanceof RegistryDeniedError && err.reason === "forbidden",
  );

  assert.throws(
    () => {
      (listCatalog() as unknown as { pop: () => unknown }).pop();
    },
    (err: unknown) => err instanceof TypeError,
  );
});
