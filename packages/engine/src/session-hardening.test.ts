/**
 * M0-A4 session hardening (Copilot review 5317152678 on PR #13): a broken writer refuses turn/start
 * with -32009 before preflight; appends never follow a symlink without O_NOFOLLOW; rebuild checks
 * the session.open / servedModel backing enum. Copilot review 5317282838: a `sessions/` directory
 * swapped for a symlink is never appended to or read; item ids use the shared id grammar.
 * Network-free: in-process engines only.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import type { Agent } from "./agent.ts";
import { RpcError } from "./protocol/errors.ts";
import type { Turn } from "./protocol/types.ts";
import { EngineConnection } from "./server.ts";
import {
  GENESIS_HASH,
  rebuildSession,
  SessionWriter,
  sessionEventHash,
  setSessionAppendOpenForTests,
  verifySessionFile,
  verifySessionText,
} from "./session-store.ts";
import { makeHome } from "./testing/harness.ts";

const POSIX = process.platform !== "win32";

type Wire = Record<string, unknown> & { params?: Record<string, unknown> };

function inProcess(home: string, agent: Agent) {
  const input = new PassThrough();
  const received: Wire[] = [];
  const output = new Writable({
    write(chunk, _enc, cb) {
      for (const line of String(chunk).split("\n"))
        if (line !== "") received.push(JSON.parse(line));
      cb();
    },
  });
  const conn = new EngineConnection({ input, output, home, agent, log: () => {} });
  const done = conn.run();
  let nextId = 1;
  const waitFor = async (pred: (m: Wire) => boolean): Promise<Wire> => {
    const until = Date.now() + 3000;
    for (;;) {
      const hit = received.find(pred);
      if (hit !== undefined) return hit;
      if (Date.now() > until) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  const request = async (method: string, params: unknown = {}): Promise<Wire> => {
    const id = nextId++;
    input.write(`${JSON.stringify({ id, method, params })}\n`);
    return waitFor((m) => m.id === id);
  };
  return { input, received, done, waitFor, request };
}

type Line = { hash: string };

function readLines(path: string): Line[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as Line);
}

/** A short valid chain written by the engine's writer. */
function writeSampleSession(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "thr_sample.jsonl");
  const w = SessionWriter.create(
    path,
    "thr_sample",
    "madc-default",
    { cwd: null, backing: "kimi-code", providerId: "kimi-code", pinnedModel: "m" },
    () => [],
  );
  w.append("turn.start", { turnId: "turn_1", inputText: "hi" });
  w.append("item", {
    turnId: "turn_1",
    item: { id: "item_1", kind: "agentMessage", status: "completed", text: "hello" },
  });
  w.append("turn.end", { turnId: "turn_1", status: "completed", error: null });
  return path;
}

/** Hash-valid lines with arbitrary payloads (a forger who knows the algorithm). */
function forgeSession(threadId: string, events: Array<[string, Record<string, unknown>]>): string {
  let prev = GENESIS_HASH;
  return events
    .map(([type, payload], seq) => {
      const body = {
        v: 1 as const,
        seq,
        ts: 1000 + seq,
        type,
        threadId,
        seatId: "madc-default",
        payload,
      };
      const hash = sessionEventHash(prev, body as never);
      const line = JSON.stringify({ ...body, prevHash: prev, hash });
      prev = hash;
      return `${line}\n`;
    })
    .join("");
}

test("R-broken-first: once a session append failed, turn/start is -32009 before preflight runs", async () => {
  const { home, cleanup } = makeHome();
  let preflights = 0;
  const agent: Agent = {
    name: "broken-then-refusing",
    preflight() {
      preflights++;
      // A later preflight would refuse differently; the broken writer must win first.
      if (preflights > 1) throw new RpcError(-32008, "backing unavailable");
    },
    async run(ctx, sink) {
      const path = join(home, "sessions", `${ctx.threadId}.jsonl`);
      rmSync(path);
      mkdirSync(path); // appends now fail (EISDIR)
      const id = sink.newItemId();
      sink.completeItem({ id, kind: "agentMessage", status: "completed", text: "lost" });
    },
  };
  const e = inProcess(home, agent);
  try {
    await e.request("initialize", { clientInfo: { name: "t", version: "0" } });
    const start = await e.request("thread/start", {});
    const threadId = (start.result as { thread: { id: string } }).thread.id;
    await e.request("turn/start", { threadId, input: [{ type: "text", text: "x" }] });
    const done = await e.waitFor((m) => m.method === "turn/completed");
    assert.equal((done.params as { turn: Turn }).turn.error?.code, -32009);
    assert.equal(preflights, 1);
    const next = await e.request("turn/start", { threadId, input: [{ type: "text", text: "y" }] });
    const err = next.error as { code: number; data: { threadId: string; path: string } };
    assert.equal(err.code, -32009);
    assert.equal(err.data.threadId, threadId);
    assert.equal(err.data.path, join(home, "sessions", `${threadId}.jsonl`));
    assert.equal(preflights, 1, "preflight never ran for the refused turn");
  } finally {
    e.input.end();
    await e.done;
    cleanup();
  }
});

test("R-append-nofollow: without O_NOFOLLOW an append never follows a symlink, even one swapped in after lstat", () => {
  if (!POSIX) return; // symlink creation needs privileges on Windows
  const { home, cleanup } = makeHome();
  const outside = join(home, "..", "outside-append");
  const resumeWriter = (path: string): SessionWriter =>
    SessionWriter.resume(
      path,
      "thr_sample",
      "madc-default",
      4,
      readLines(path)[3]?.hash ?? "",
      () => [],
    );
  try {
    const target = writeSampleSession(outside);
    const targetBytes = readFileSync(target, "utf8");
    const path = writeSampleSession(home);
    const original = readFileSync(path, "utf8");
    const isWriteFailed = (err: RpcError) =>
      err.code === -32009 && (err.data as { seq: number }).seq === 4;
    // A regular file appends normally through the fallback.
    setSessionAppendOpenForTests({ noFollowFlag: false });
    const ok = resumeWriter(path);
    ok.append("turn.start", { turnId: "turn_2", inputText: "a" });
    assert.equal(verifySessionFile(path, "thr_sample").ok, true);
    writeFileSync(path, original);
    // Swapped for a symlink between lstat and open: dev + inode differ, refused, nothing written.
    const swapped = resumeWriter(path);
    setSessionAppendOpenForTests({
      noFollowFlag: false,
      afterLstat: () => {
        rmSync(path);
        symlinkSync(target, path);
      },
    });
    assert.throws(
      () => swapped.append("turn.start", { turnId: "turn_2", inputText: "b" }),
      isWriteFailed,
    );
    assert.equal(swapped.broken, true);
    assert.equal(readFileSync(target, "utf8"), targetBytes, "the symlink target is never written");
    // A symlink already in place is refused before any open.
    setSessionAppendOpenForTests({ noFollowFlag: false });
    const linked = SessionWriter.resume(
      path,
      "thr_sample",
      "madc-default",
      4,
      readLines(target)[3]?.hash ?? "",
      () => [],
    );
    assert.throws(
      () => linked.append("turn.start", { turnId: "turn_2", inputText: "c" }),
      isWriteFailed,
    );
    assert.equal(readFileSync(target, "utf8"), targetBytes, "the symlink target is never written");
  } finally {
    setSessionAppendOpenForTests(null);
    cleanup();
  }
});

test("R-shape backing: a hash-valid session.open or servedModel event with a non-SeatBacking backing is never loaded", async () => {
  const open = { cwd: null, backing: "kimi-code", providerId: "kimi-code", pinnedModel: "m" };
  const served = { turnId: "turn_1", requestedModel: "a", servedModel: "b", providerId: "p" };
  const cases: Array<[string, Array<[string, Record<string, unknown>]>]> = [
    ["open-bad-backing", [["session.open", { ...open, backing: "ollama-cloud" }]]],
    ["open-no-backing", [["session.open", { cwd: null, providerId: "p", pinnedModel: "m" }]]],
    [
      "served-event-bad-backing",
      [
        ["session.open", open],
        ["servedModel", { ...served, backing: "ollama-cloud" }],
      ],
    ],
  ];
  for (const [name, events] of cases) {
    const r = verifySessionText(forgeSession("thr_bad", events));
    assert.equal(r.ok, true, name);
    assert.throws(
      () => rebuildSession(r.ok ? r.events : []),
      (err: Error) => /^line \d+: malformed /.test(err.message),
      name,
    );
  }
  // Every SeatBacking value still rebuilds, in both places.
  for (const backing of ["kimi-code", "claude-code", "codex"]) {
    const r = verifySessionText(
      forgeSession("thr_ok", [
        ["session.open", { ...open, backing }],
        ["servedModel", { ...served, backing }],
      ]),
    );
    assert.equal(r.ok, true, backing);
    assert.doesNotThrow(() => rebuildSession(r.ok ? r.events : []), backing);
  }
  const { home, cleanup } = makeHome();
  const e = inProcess(home, { name: "idle", async run() {} });
  try {
    await e.request("initialize", { clientInfo: { name: "t", version: "0" } });
    mkdirSync(join(home, "sessions"), { recursive: true });
    writeFileSync(
      join(home, "sessions", "thr_bad.jsonl"),
      forgeSession("thr_bad", cases[0]?.[1] ?? []),
    );
    const list = await e.request("thread/list", {});
    assert.deepEqual(list.result, { data: [], nextCursor: null });
    const resume = await e.request("thread/resume", { threadId: "thr_bad" });
    assert.equal((resume.error as { code: number }).code, -32603);
  } finally {
    e.input.end();
    await e.done;
    cleanup();
  }
});

test("R-parent-swap: a sessions/ directory swapped for a symlink after confinement is never appended to or read", () => {
  if (!POSIX) return; // symlink creation needs privileges on Windows
  const { home, cleanup } = makeHome();
  const outside = join(home, "..", "outside-parent");
  try {
    const sessions = join(home, "sessions");
    const path = writeSampleSession(sessions);
    const target = writeSampleSession(outside);
    const targetBytes = readFileSync(target, "utf8");
    const insideBytes = readFileSync(path, "utf8");
    const w = SessionWriter.resume(
      path,
      "thr_sample",
      "madc-default",
      4,
      readLines(path)[3]?.hash ?? "",
      () => [],
    );
    assert.equal(verifySessionFile(path, "thr_sample", {}, home).ok, true);
    // The confined sessions/ directory is replaced by a symlink to a directory outside the home.
    renameSync(sessions, join(home, "sessions-moved"));
    symlinkSync(outside, sessions);
    assert.throws(
      () => w.append("turn.start", { turnId: "turn_2", inputText: "x" }),
      (err: RpcError) => err.code === -32009 && (err.data as { seq: number }).seq === 4,
    );
    assert.equal(w.broken, true);
    assert.equal(readFileSync(target, "utf8"), targetBytes, "nothing written outside the home");
    assert.equal(
      readFileSync(join(home, "sessions-moved", "thr_sample.jsonl"), "utf8"),
      insideBytes,
    );
    assert.deepEqual(verifySessionFile(path, "thr_sample", {}, home), {
      ok: false,
      line: 0,
      reason: "session file resolves outside MADC_HOME",
    });
  } finally {
    cleanup();
  }
});

test("R-shape item id: a hash-valid item whose id breaks the shared id grammar is never loaded", () => {
  const open = { cwd: null, backing: "kimi-code", providerId: "kimi-code", pinnedModel: "m" };
  for (const id of ["", "../x", "a b", 7]) {
    const r = verifySessionText(
      forgeSession("thr_bad", [
        ["session.open", open],
        [
          "item",
          { turnId: "turn_1", item: { id, kind: "agentMessage", status: "completed", text: "x" } },
        ],
      ]),
    );
    assert.equal(r.ok, true, String(id));
    assert.throws(
      () => rebuildSession(r.ok ? r.events : []),
      (err: Error) => /^line 2: malformed item payload$/.test(err.message),
      String(id),
    );
  }
});
