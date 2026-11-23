/**
 * M2-A8 (`PLAN-madc-M2-build-plan.md` §7): `madc room [--json]` and `madc doctor` v2 room table.
 * Imports ONLY `@madc/engine/client` (no `../../engine/src/*` — plan §6 import rules).
 */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { inspectRoom, type RoomReport, spawnEngine } from "@madc/engine/client";
import { parseArgs } from "./args.ts";
import type { CliIO } from "./io.ts";
import { main } from "./main.ts";

const ECHO_ENGINE = fileURLToPath(
  new URL("../../engine/src/testing/echo-engine.ts", import.meta.url),
);

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

test("M2-A8 room --json and doctor v2: reports one-way handoff, malformed v2 line, and open decision with exit code discipline", async () => {
  const { home, cleanup } = makeTempHome();
  try {
    // 1. Seed a valid v2 seat allowing self-handoff so we can create a real handoff via spawnEngine.
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
        handoffs: { enabled: true, targets: ["madc-default"] },
      }),
      { mode: 0o600 },
    );

    // 2. Spawn the real engine via `@madc/engine/client` to create:
    //    - `decThreadId` with an open founderDecision
    //    - `srcId` -> `oneWayId` via `thread/handoff`
    const client = spawnEngine({ entry: ECHO_ENGINE, env: { ...process.env, MADC_HOME: home } });
    let decThreadId = "";
    let srcId = "";
    let oneWayId = "";
    try {
      await client.request("initialize", { clientInfo: { name: "room-test", version: "0" } });

      const sDec = (await client.request("thread/start", { seatId: "madc-default" })) as {
        thread: { id: string };
      };
      decThreadId = sDec.thread.id;
      const tDec = (await client.request("turn/start", {
        threadId: decThreadId,
        input: [{ type: "text", text: "SECRET_PROMPT_TEXT" }],
      })) as { turn: { id: string } };
      await new Promise((r) => setTimeout(r, 80));
      await client.request("decision/raise", {
        threadId: decThreadId,
        turnId: tDec.turn.id,
        question: "Approve M2-A8?",
        recommendedDefault: "Yes",
        evidenceRefs: [
          { kind: "git", sha: "25096fffd1076d65c4a9ba148117a3cf77e919e0", remote: null },
        ],
      });

      const sSrc = (await client.request("thread/start", { seatId: "madc-default" })) as {
        thread: { id: string };
      };
      srcId = sSrc.thread.id;
      const ho = (await client.request("thread/handoff", {
        threadId: srcId,
        targetSeatId: "madc-default",
        brief: "SECRET_BRIEF_TEXT",
        turnId: null,
      })) as { targetThreadId: string };
      oneWayId = ho.targetThreadId;
    } finally {
      await client.close();
    }

    // 3. Truncate `srcId` to its first line (losing handoff.out + handoff.link) so `oneWayId`
    //    becomes a genuine one-way handoff (`fail handoff-mismatch`), and `srcId` is `warn not-cleanly-closed`.
    const srcPath = join(home, "sessions", `${srcId}.jsonl`);
    const firstLine = readFileSync(srcPath, "utf8").split("\n")[0];
    writeFileSync(srcPath, `${firstLine}\n`);

    // 4. Write a malformed session file (FAIL integrity).
    writeFileSync(join(home, "sessions", "thr_bad_line.jsonl"), "{not-json\n", { mode: 0o600 });

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

    const decRow = byId.get(decThreadId);
    assert.equal(decRow?.openDecisions.length, 1);
    assert.equal(decRow?.openDecisions[0]?.question, "Approve M2-A8?");
    assert.equal(roomRes.stdout.includes("SECRET_BRIEF_TEXT"), false);

    // `madc doctor --json` exits 1 when room has FAILs.
    const docFail = await runMain(home, ["doctor", "--json"]);
    assert.equal(docFail.code, 1);
    const docFailJson = JSON.parse(docFail.stdout) as {
      checks: Array<{ id: string; status: string }>;
    };
    assert.equal(docFailJson.checks.find((c) => c.id === "room")?.status, "fail");

    // Remove the FAILing threads (`thr_bad_line` and `oneWayId`), leaving `srcId` (WARN only).
    rmSync(join(home, "sessions", "thr_bad_line.jsonl"));
    rmSync(join(home, "sessions", `${oneWayId}.jsonl`));

    const roomWarn = inspectRoom(home);
    assert.equal(roomWarn.counts.fail, 0);
    assert.ok(roomWarn.counts.warn >= 1);

    // `madc doctor --json` reports `room` as `warn` (and exits 0 when only warnings exist).
    const docWarn = await runMain(home, ["doctor", "--json"]);
    const docWarnJson = JSON.parse(docWarn.stdout) as {
      checks: Array<{ id: string; status: string }>;
    };
    assert.equal(docWarnJson.checks.find((c) => c.id === "room")?.status, "warn");
  } finally {
    cleanup();
  }
});
