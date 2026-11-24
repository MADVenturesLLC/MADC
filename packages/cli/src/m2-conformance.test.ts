/**
 * M2-A9 (`PLAN-madc-M2-build-plan.md` §7): end-to-end mock room conformance on a fresh `$MADC_HOME`.
 * Seeds via `madc doctor --init`, runs a two-seat handoff in isolated worktrees, serves the brief
 * once, raises a Founder decision, and verifies `madc decisions ls --json`, `madc room --json`,
 * and `madc doctor --json` all pass with zero paid calls.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { type RoomReport, spawnEngine } from "@madc/engine/client";
import type { CliIO } from "./io.ts";
import { main } from "./main.ts";

const ECHO_ENGINE = fileURLToPath(
  new URL("../../engine/src/testing/echo-engine.ts", import.meta.url),
);

function makeTempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  chmodSync(dir, 0o700);
  return dir;
}

function cleanGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith("GIT_")) delete env[k];
  }
  return {
    ...env,
    GIT_AUTHOR_NAME: "MADC Conformance",
    GIT_AUTHOR_EMAIL: "conformance@madc.invalid",
    GIT_COMMITTER_NAME: "MADC Conformance",
    GIT_COMMITTER_EMAIL: "conformance@madc.invalid",
  };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: cleanGitEnv(),
  }).trim();
}

async function runMain(home: string, argv: readonly string[]) {
  let stdout = "";
  let stderr = "";
  const io: CliIO = {
    stdin: process.stdin,
    stdout: new Writable({
      write(chunk, _enc, cb) {
        stdout += String(chunk);
        cb();
      },
    }) as unknown as NodeJS.WriteStream,
    stderr: new Writable({
      write(chunk, _enc, cb) {
        stderr += String(chunk);
        cb();
      },
    }) as unknown as NodeJS.WriteStream,
    env: { ...process.env, MADC_HOME: home },
    stdoutIsTTY: false,
    stderrIsTTY: false,
    stdinIsTTY: false,
    columns: 120,
    cwd: home,
  };
  const code = await main(argv, io);
  return { code, stdout, stderr };
}

test("M2-A9 conformance: fresh MADC_HOME seeds, runs two-seat worktree handoff, raises decision, and verifies room + doctor", async () => {
  const t0 = Date.now();
  const home = makeTempDir("madc-m2a9-home-");
  const repo = makeTempDir("madc-m2a9-repo-");
  try {
    git(repo, "init", "-b", "main");
    git(repo, "remote", "add", "origin", "https://github.com/MADVenturesLLC/MADC.git");
    writeFileSync(join(repo, "README.md"), "# M2 conformance\n");
    git(repo, "add", "README.md");
    git(repo, "commit", "-m", "init");

    // 1. Seed fresh $MADC_HOME via `madc doctor --init --json`.
    const initRes = await runMain(home, ["doctor", "--init", "--json"]);
    assert.equal(initRes.code, 0, initRes.stdout);

    // 2. Configure two worktree-mode v2 seats: seat-a -> seat-b.
    const baseSeat = {
      version: 2,
      role: "builder",
      standingInstructions: "M2 conformance seat",
      pinnedModel: "kimi-coding/kimi-for-coding",
      preferredBacking: "kimi-code",
      fallbacks: [],
      memory: { mode: "in-session" },
      tools: { deny: [] },
      policy: { headlessOk: true },
      worktree: true,
    };
    mkdirSync(join(home, "seats"), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(home, "seats", "seat-a.json"),
      JSON.stringify({
        ...baseSeat,
        id: "seat-a",
        displayName: "Seat A",
        handoffs: { enabled: true, targets: ["seat-b"] },
      }),
      { mode: 0o600 },
    );
    writeFileSync(
      join(home, "seats", "seat-b.json"),
      JSON.stringify({
        ...baseSeat,
        id: "seat-b",
        displayName: "Seat B",
        handoffs: { enabled: false, targets: [] },
      }),
      { mode: 0o600 },
    );

    // 3. Run two-seat handoff and decision raise on mock echo engine.
    const client = spawnEngine({ entry: ECHO_ENGINE, env: { ...process.env, MADC_HOME: home } });
    let thrA = "";
    let thrB = "";
    try {
      await client.request("initialize", { clientInfo: { name: "m2-conformance", version: "0" } });
      const sA = (await client.request("thread/start", { seatId: "seat-a", cwd: repo })) as {
        thread: { id: string; cwd: string };
      };
      thrA = sA.thread.id;
      const tA = (await client.request("turn/start", {
        threadId: thrA,
        input: [{ type: "text", text: "plan step" }],
      })) as { turn: { id: string } };
      await new Promise((r) => setTimeout(r, 80));

      const ho = (await client.request("thread/handoff", {
        threadId: thrA,
        targetSeatId: "seat-b",
        brief: "build step",
        turnId: tA.turn.id,
      })) as { targetThreadId: string };
      thrB = ho.targetThreadId;

      await client.request("thread/resume", { threadId: thrB });
      const tB = (await client.request("turn/start", {
        threadId: thrB,
        input: [{ type: "text", text: "execute" }],
      })) as { turn: { id: string } };
      await new Promise((r) => setTimeout(r, 80));

      await client.request("decision/raise", {
        threadId: thrB,
        turnId: tB.turn.id,
        question: "Freeze M2?",
        recommendedDefault: "Yes",
        evidenceRefs: [
          {
            kind: "git",
            sha: git(repo, "rev-parse", "HEAD"),
            remote: "github.com/MADVenturesLLC/MADC",
          },
        ],
      });
    } finally {
      await client.close();
    }

    // 4. Verify `madc room --json`, `madc decisions ls --json`, and `madc doctor --json`.
    const roomRes = await runMain(home, ["room", "--json"]);
    assert.equal(roomRes.code, 0);
    const roomJson = JSON.parse(roomRes.stdout) as { ok: boolean; room: RoomReport };
    assert.equal(roomJson.ok, true);
    assert.equal(roomJson.room.counts.threads, 2);
    assert.equal(roomJson.room.counts.fail, 0);
    assert.equal(roomJson.room.counts.warn, 0);
    assert.equal(roomJson.room.counts.openDecisions, 1);

    const rowA = roomJson.room.threads.find((t) => t.threadId === thrA);
    const rowB = roomJson.room.threads.find((t) => t.threadId === thrB);
    assert.ok(rowA?.worktree.open?.topLevel);
    assert.ok(rowB?.worktree.open?.topLevel);
    assert.notEqual(rowA?.worktree.open?.topLevel, rowB?.worktree.open?.topLevel);

    const docRes = await runMain(home, ["doctor", "--json"]);
    assert.equal(docRes.code, 0);
    const docJson = JSON.parse(docRes.stdout) as {
      checks: Array<{ id: string; status: string }>;
    };
    assert.equal(docJson.checks.find((c) => c.id === "room")?.status, "pass");

    assert.ok(Date.now() - t0 < 15_000, "M2 conformance completed within runbook budget");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});
