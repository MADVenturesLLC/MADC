/**
 * M2-A5 (`PIN-madc-M2-seat-worktree.md` §4): vendor adapters (`claude-code`, `codex`, `acp-client`)
 * receive `request.cwd` and pass it to child `spawn` (and `session/new` for ACP).
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createClaudeCodePort } from "./claude-code.ts";
import { createCodexCodePort } from "./codex.ts";
import {
  createFakeAcpSpawn,
  createFakeClaudeSpawn,
  createFakeCodexSpawn,
  FAKE_CLAUDE_BINARY,
  FAKE_CODEX_BINARY,
  FAKE_GROK_BINARY,
} from "./testing/index.ts";
import { createAcpPort } from "./vendor/acp-client/client.ts";

test("M2-A5 vendor cwd placement: claude-code, codex, and acp-client forward request.cwd to spawn and session/new", async () => {
  const dir = mkdtempSync(join(tmpdir(), "madc-vendor-cwd-"));
  const targetCwd = "/tmp/madc-worktree-cwd-check";
  const wireLog = join(dir, "acp-wire.jsonl");

  try {
    let claudeSpawnCwd: string | URL | undefined;
    const baseClaude = createFakeClaudeSpawn();
    const claude = createClaudeCodePort({
      binaryPath: FAKE_CLAUDE_BINARY,
      spawn: (cmd, args, opts) => {
        claudeSpawnCwd = opts.cwd;
        return baseClaude(cmd, args, { ...opts, cwd: undefined });
      },
    });
    await claude.streamTurn({
      modelId: "claude-sonnet-4-5",
      messages: [{ role: "user", text: "hi" }],
      cwd: targetCwd,
      signal: new AbortController().signal,
      onTextDelta: () => {},
    });
    assert.equal(claudeSpawnCwd, targetCwd);

    let codexSpawnCwd: string | URL | undefined;
    const baseCodex = createFakeCodexSpawn();
    const codex = createCodexCodePort({
      binaryPath: FAKE_CODEX_BINARY,
      spawn: (cmd, args, opts) => {
        codexSpawnCwd = opts.cwd;
        return baseCodex(cmd, args, { ...opts, cwd: undefined });
      },
    });
    await codex.streamTurn({
      modelId: "gpt-5.1-codex",
      messages: [{ role: "user", text: "hi" }],
      cwd: targetCwd,
      signal: new AbortController().signal,
      onTextDelta: () => {},
    });
    assert.equal(codexSpawnCwd, targetCwd);

    let acpSpawnCwd: string | URL | undefined;
    const baseAcp = createFakeAcpSpawn({
      MADC_TEST_ACP_MODE: "ok",
      MADC_TEST_ACP_WIRE_LOG: wireLog,
    });
    const acp = createAcpPort({
      spec: {
        providerId: "grok-build",
        args: () => ["agent", "stdio"],
        trailingQuietMs: 5,
        trailingMaxMs: 25,
      },
      binaryPath: FAKE_GROK_BINARY,
      spawn: (cmd, args, opts) => {
        acpSpawnCwd = opts.cwd;
        return baseAcp(cmd, args, { ...opts, cwd: undefined });
      },
    });
    await acp.streamTurn({
      modelId: "grok-4",
      messages: [{ role: "user", text: "hi" }],
      cwd: targetCwd,
      signal: new AbortController().signal,
      onTextDelta: () => {},
    });
    assert.equal(acpSpawnCwd, targetCwd);
    const wire = readFileSync(wireLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
    const sessionNew = wire.find((m) => m.method === "session/new");
    assert.equal(sessionNew?.params?.cwd, targetCwd);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
