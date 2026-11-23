/**
 * M2-A8 (`PLAN-madc-M2-build-plan.md` §7): `madc room [--json]` and `madc doctor` v2 room row.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { test } from "node:test";
import { inspectRoom, type RoomReport } from "@madc/engine/client";
import { parseArgs } from "./args.ts";
import type { CliIO } from "./io.ts";
import { main } from "./main.ts";

function makeTempHome(): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), "madc-m2a8-"));
  chmodSync(home, 0o700);
  mkdirSync(join(home, "seats"), { mode: 0o700 });
  mkdirSync(join(home, "sessions"), { mode: 0o700 });
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
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

test("M2-A8 parseArgs: room [--json] and usage rejections", () => {
  assert.deepEqual(parseArgs(["room"]), { kind: "room", json: false });
  assert.deepEqual(parseArgs(["room", "--json"]), { kind: "room", json: true });
  assert.deepEqual(parseArgs(["--json", "room"]), { kind: "room", json: true });
  assert.equal(parseArgs(["room", "--init"]).kind, "usage");
  assert.equal(parseArgs(["room", "-s", "madc-default"]).kind, "usage");
  assert.equal(parseArgs(["room", "extra"]).kind, "usage");
});

test("M2-A8 room --json and doctor v2: reports one-way handoff, missing worktree, malformed v2 line, and open decision with exit code discipline", async () => {
  const { home, cleanup } = makeTempHome();
  try {
    // 1. Seed a valid v2 seat so doctor's seat/seats rows pass.
    writeFileSync(
      join(home, "seats", "madc-default.json"),
      JSON.stringify({
        id: "madc-default",
        version: 2,
        displayName: "Default",
        role: "builder",
        standingInstructions: "test",
        pinnedModel: "kimi-coding/kimi-for-coding",
        preferredBacking: "kimi-code",
        fallbacks: [],
        memory: { mode: "in-session" },
        tools: { deny: [] },
        policy: { headlessOk: true },
        handoffs: { enabled: false, targets: [] },
      }),
      { mode: 0o600 },
    );

    // 2. Write a malformed session file (FAIL integrity).
    writeFileSync(join(home, "sessions", "thr_bad_line.jsonl"), "{not-json\n", { mode: 0o600 });

    // 3. Write a clean v1 session file with a missing worktree under $MADC_HOME/worktrees (WARN only).
    const { echoAgent } = await import("../../engine/src/agent.ts");
    const { EngineConnection } = await import("../../engine/src/server.ts");
    const { PassThrough } = await import("node:stream");
    const runEngine = async (
      fn: (req: (m: string, p?: unknown) => Promise<Record<string, unknown>>) => Promise<void>,
    ) => {
      const input = new PassThrough();
      const out: Record<string, unknown>[] = [];
      const output = new Writable({
        write(chunk, _enc, cb) {
          for (const line of String(chunk).split("\n")) if (line) out.push(JSON.parse(line));
          cb();
        },
      });
      const conn = new EngineConnection({ input, output, home, agent: echoAgent, log: () => {} });
      const done = conn.run();
      let id = 1;
      const req = async (method: string, params: unknown = {}) => {
        const cur = id++;
        input.write(`${JSON.stringify({ id: cur, method, params })}\n`);
        for (;;) {
          const hit = out.find((m) => m.id === cur);
          if (hit) return hit;
          await new Promise((r) => setTimeout(r, 5));
        }
      };
      await req("initialize", { clientInfo: { name: "t", version: "0" } });
      await fn(req);
      input.end();
      await done;
    };

    let decThreadId = "";
    await runEngine(async (req) => {
      const s = await req("thread/start", { seatId: "madc-default" });
      decThreadId = (s.result as { thread: { id: string } }).thread.id;
      const t = await req("turn/start", {
        threadId: decThreadId,
        input: [{ type: "text", text: "SECRET_PROMPT_TEXT" }],
      });
      const turnId = (t.result as { turn: { id: string } }).turn.id;
      await new Promise((r) => setTimeout(r, 40));
      await req("decision/raise", {
        threadId: decThreadId,
        turnId,
        question: "Approve M2-A8?",
        recommendedDefault: "Yes",
        evidenceRefs: [
          { kind: "git", sha: "25096fffd1076d65c4a9ba148117a3cf77e919e0", remote: null },
        ],
      });
    });

    // 4. Create a one-way handoff target citing an existing source session that has no handoff.out/link.
    const { SessionWriter } = await import("../../engine/src/session-store.ts");
    const srcId = "thr_source_no_link";
    SessionWriter.create(
      join(home, "sessions", `${srcId}.jsonl`),
      srcId,
      "madc-default",
      {
        cwd: null,
        backing: "kimi-code",
        providerId: "kimi-code",
        pinnedModel: "kimi-coding/kimi-for-coding",
        worktree: null,
        handoff: null,
      },
      () => [],
      Date.now(),
      home,
      { holdsLock: () => true },
    ).append("session.close", { reason: "shutdown", worktree: null });

    const oneWayId = "thr_oneway_target";
    const oneWayWriter = SessionWriter.create(
      join(home, "sessions", `${oneWayId}.jsonl`),
      oneWayId,
      "madc-default",
      {
        cwd: null,
        backing: "kimi-code",
        providerId: "kimi-code",
        pinnedModel: "kimi-coding/kimi-for-coding",
        worktree: {
          topLevel: join(home, "worktrees", oneWayId),
          remote: null,
          head: "25096fffd1076d65c4a9ba148117a3cf77e919e0",
        },
        handoff: {
          sourceThreadId: srcId,
          sourceSeatId: "madc-default",
          handoffId: "ho_missing",
          sourceSeq: 1,
          sourceHash: "a".repeat(64),
        },
      },
      () => [],
      Date.now(),
      home,
      { holdsLock: () => true },
    );
    oneWayWriter.append("session.close", { reason: "shutdown", worktree: null });

    // `madc room --json` schema and findings check.
    const roomRes = await runMain(home, ["room", "--json"]);
    assert.equal(roomRes.code, 0);
    const parsed = JSON.parse(roomRes.stdout) as {
      ok: boolean;
      exitCode: number;
      room: RoomReport;
    };
    assert.equal(parsed.ok, true);
    assert.equal(parsed.room.counts.threads, 4);
    assert.equal(parsed.room.counts.openDecisions, 1);

    const byId = new Map(parsed.room.threads.map((t) => [t.threadId, t]));
    const badRow = byId.get("thr_bad_line");
    assert.equal(badRow?.level, "fail");
    assert.equal(badRow?.chain.ok, false);

    const oneWayRow = byId.get(oneWayId);
    assert.equal(oneWayRow?.level, "fail");
    assert.equal(oneWayRow?.handoff.oneWay, true);
    assert.equal(oneWayRow?.worktree.missing, true);

    const decRow = byId.get(decThreadId);
    assert.equal(decRow?.openDecisions.length, 1);
    assert.equal(decRow?.openDecisions[0]?.question, "Approve M2-A8?");
    assert.equal(roomRes.stdout.includes("SECRET_PROMPT_TEXT"), false);

    // `madc doctor --json` exits 1 when room has FAILs.
    const docFail = await runMain(home, ["doctor", "--json"]);
    assert.equal(docFail.code, 1);
    const docFailJson = JSON.parse(docFail.stdout) as {
      checks: Array<{ id: string; status: string }>;
    };
    assert.equal(docFailJson.checks.find((c) => c.id === "room")?.status, "fail");

    // Remove the FAILing threads, leaving only a WARN thread (`not-cleanly-closed` or missing worktree).
    rmSync(join(home, "sessions", "thr_bad_line.jsonl"));
    rmSync(join(home, "sessions", `${oneWayId}.jsonl`));

    // Add a clean-chain thread that was not cleanly closed (WARN only, no FAIL).
    const warnId = "thr_warn_only";
    SessionWriter.create(
      join(home, "sessions", `${warnId}.jsonl`),
      warnId,
      "madc-default",
      {
        cwd: null,
        backing: "kimi-code",
        providerId: "kimi-code",
        pinnedModel: "kimi-coding/kimi-for-coding",
        worktree: null,
        handoff: null,
      },
      () => [],
      Date.now(),
      home,
      { holdsLock: () => true },
    );

    const roomWarn = inspectRoom(home);
    assert.equal(roomWarn.counts.fail, 0);
    assert.ok(roomWarn.counts.warn >= 1);

    // `madc doctor --json` exits 0 with warnings only (note: policy/lanes/etc may warn/skip, no FAIL).
    const docWarn = await runMain(home, ["doctor", "--json"]);
    const docWarnJson = JSON.parse(docWarn.stdout) as {
      checks: Array<{ id: string; status: string }>;
    };
    assert.equal(docWarnJson.checks.find((c) => c.id === "room")?.status, "warn");
  } finally {
    cleanup();
  }
});
