import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { getById, listCatalog } from "./index.ts";

/**
 * Acceptance (M1-A1): `sourceQuote` equals the text quoted in roadmap §3 for every
 * roadmap-covered row. Kept M0 stubs quote the subscription-lanes brief; the two
 * PAYG ids quote the M1 plan's M1-A1 note. Verbatim substring per id — a lane's
 * terms quote cannot drift from its cited source without this test failing.
 */
const root = new URL("../../../", import.meta.url);
const roadmap = readFileSync(new URL("docs/plan/ROADMAP-madc-post-M0.md", root), "utf8");
const brief = readFileSync(new URL("docs/plan/subscription-lanes-2026-09-24.md", root), "utf8");
const m1Plan = readFileSync(new URL("docs/plan/PLAN-madc-M1-build-plan.md", root), "utf8");

const ROADMAP_QUOTED_IDS = [
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
  "claude-subscription-http",
  "xai-consumer-signin",
] as const;

const BRIEF_QUOTED_IDS = [
  "openrouter",
  "groq-cloud",
  "github-copilot",
  "chatgpt-token-replay",
] as const;

const M1_PLAN_QUOTED_IDS = ["minimax-payg", "alibaba-model-studio-payg"] as const;

test("sourceQuote equals the text quoted in roadmap §3 (acceptance)", () => {
  for (const id of ROADMAP_QUOTED_IDS) {
    const entry = getById(id);
    assert.ok(entry, id);
    assert.ok(
      roadmap.includes(entry.sourceQuote),
      `${id}: sourceQuote is not a verbatim quote of ROADMAP-madc-post-M0.md §3:\n${entry.sourceQuote}`,
    );
    assert.equal(
      entry.sourceUrl,
      "docs/plan/ROADMAP-madc-post-M0.md#3-subscription-table-all-lanes",
      `${id}: sourceUrl should cite the roadmap table`,
    );
  }
});

test("kept-stub and chatgpt-token-replay quotes are verbatim from the subscription-lanes brief", () => {
  for (const id of BRIEF_QUOTED_IDS) {
    const entry = getById(id);
    assert.ok(entry, id);
    assert.ok(
      brief.includes(entry.sourceQuote),
      `${id}: sourceQuote is not a verbatim quote of subscription-lanes-2026-09-24.md:\n${entry.sourceQuote}`,
    );
  }
});

test("PAYG ids quote the M1 plan's M1-A1 note (terms not re-verified 2026-09-24)", () => {
  for (const id of M1_PLAN_QUOTED_IDS) {
    const entry = getById(id);
    assert.ok(entry, id);
    assert.ok(
      m1Plan.includes(entry.sourceQuote),
      `${id}: sourceQuote is not a verbatim quote of PLAN-madc-M1-build-plan.md:\n${entry.sourceQuote}`,
    );
  }
});

test("every catalog id is covered by exactly one quote source", () => {
  const covered: Set<string> = new Set([
    ...ROADMAP_QUOTED_IDS,
    ...BRIEF_QUOTED_IDS,
    ...M1_PLAN_QUOTED_IDS,
  ]);
  for (const entry of listCatalog()) {
    assert.ok(covered.has(entry.id), `${entry.id} is not covered by a quote-source test`);
  }
  assert.equal(covered.size, listCatalog().length);
});
