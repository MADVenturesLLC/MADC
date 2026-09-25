/**
 * M0-A4 session hardening (Copilot review 5317152678 on PR #13): a broken writer refuses turn/start
 * with -32009 before preflight; appends never follow a symlink without O_NOFOLLOW; rebuild checks
 * the session.open / servedModel backing enum. Copilot review 5317282838: a `sessions/` directory
 * swapped for a symlink is never appended to or read; item ids use the shared id grammar.
 * Copilot review 5317426919 / Bugbot r4104324505: a writer never snapshots a real path outside the
 * home (create / resume), and the seat seed never writes through a swapped `seats/` directory.
 * Copilot review 5317584394: create's cleanup never deletes a file it did not create; a dangling
 * session symlink is refused (-32603), not reported as not found.
 * Copilot review 5317728570: a `toJSON` hook never smuggles an unredacted value into the JSONL; a
 * resume is bound to the file that was verified (dev + inode).
 * Copilot review 5317847622: a rebuilt turn error carries only {code, message}, even if the line
 * holds more.
 * Copilot review 5317965607: the seat seed's cleanup never unlinks a file it did not create, and a
 * home subdirectory's mode is tightened on the checked directory's fd, never by path.
 * Copilot review 5319307067 (r4105871146): the seed re-pins seats/ (dev + inode, real path) right
 * before its path-based open and link, so a swap before either creates or links nothing; a swap in
 * the remaining check-to-syscall gap is detected and the seed's own stray name removed. An existing
 * owner-unreadable (0300) home subdir no longer fails the seed.
 * Network-free: in-process engines only.
 */
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import type { Agent } from "./agent.ts";
import { RpcError } from "./protocol/errors.ts";
import type { Turn } from "./protocol/types.ts";
import { seedDefaultSeat, setSeedHooksForTests } from "./seat-store.ts";
import { EngineConnection } from "./server.ts";
import {
  GENESIS_HASH,
  rebuildSession,
  SessionWriter,
  sessionEventHash,
  setSessionAppendOpenForTests,
  setSessionWriteForTests,
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

test("R-snapshot-confined: a sessions/ swapped before the writer snapshots its real path is refused at create and resume", () => {
  if (!POSIX) return; // symlink creation needs privileges on Windows
  const { home, cleanup } = makeHome();
  const outside = join(home, "..", "outside-snapshot");
  const isWriteFailed = (seq: number) => (err: RpcError) =>
    err.code === -32009 && (err.data as { seq: number }).seq === seq;
  try {
    const sessions = join(home, "sessions");
    const path = writeSampleSession(sessions);
    const target = writeSampleSession(outside);
    const targetBytes = readFileSync(target, "utf8");
    renameSync(sessions, join(home, "sessions-moved"));
    symlinkSync(outside, sessions);
    // resume: the path now resolves outside the home, so no writer is built.
    assert.throws(
      () =>
        SessionWriter.resume(
          path,
          "thr_sample",
          "madc-default",
          4,
          readLines(target)[3]?.hash ?? "",
          () => [],
          home,
        ),
      isWriteFailed(4),
    );
    // create: the exclusive create lands outside, is detected before session.open is written,
    // and is never unlinked through the outside path.
    const created = join(sessions, "thr_new.jsonl");
    assert.throws(
      () =>
        SessionWriter.create(
          created,
          "thr_new",
          "madc-default",
          { cwd: null, backing: "kimi-code", providerId: "kimi-code", pinnedModel: "m" },
          () => [],
          1000,
          home,
        ),
      isWriteFailed(0),
    );
    assert.equal(
      readFileSync(join(outside, "thr_new.jsonl"), "utf8"),
      "",
      "session.open never written",
    );
    assert.equal(readFileSync(target, "utf8"), targetBytes, "nothing written outside the home");
  } finally {
    cleanup();
  }
});

test("R-seed-parent-swap: the seat seed never writes seed bytes through a seats/ swapped for a symlink", () => {
  if (!POSIX) return; // symlink creation needs privileges on Windows
  const { home, cleanup } = makeHome();
  const outside = join(home, "..", "outside-seats");
  const seats = join(home, "seats");
  const seatFile = join(seats, "madc-default.json");
  const swapTo = (dir: string) => () => {
    renameSync(seats, dir);
    symlinkSync(dir, seats);
  };
  const reset = () => {
    rmSync(seats, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    mkdirSync(seats, { mode: 0o700 });
  };
  try {
    seedDefaultSeat(home);
    // Swap before the temp file is opened: refused before a byte is written.
    reset();
    mkdirSync(outside);
    setSeedHooksForTests({
      beforeOpen: () => {
        rmSync(seats, { recursive: true });
        symlinkSync(outside, seats);
      },
    });
    assert.throws(() => seedDefaultSeat(home), /changed while the seed was being written/);
    for (const name of readdirSync(outside)) {
      assert.equal(statSync(join(outside, name)).size, 0, `${name} holds no seed bytes`);
    }
    assert.equal(existsSync(join(outside, "madc-default.json")), false);
    // Swap between the temp write and the link: the link is detected outside and the seed fails.
    rmSync(seats);
    reset();
    setSeedHooksForTests({ beforeLink: swapTo(outside) });
    assert.throws(() => seedDefaultSeat(home), /changed while the seed was being linked/);
    // A normal seed still works.
    rmSync(seats);
    reset();
    setSeedHooksForTests(null);
    assert.deepEqual(seedDefaultSeat(home), { path: seatFile, created: true });
  } finally {
    setSeedHooksForTests(null);
    cleanup();
  }
});

test("R-create-cleanup: a failed create never unlinks an unrelated file after a sessions/ swap", () => {
  if (!POSIX) return; // symlink creation needs privileges on Windows
  const { home, cleanup } = makeHome();
  const outside = join(home, "..", "outside-cleanup");
  const sessions = join(home, "sessions");
  try {
    mkdirSync(sessions, { recursive: true });
    mkdirSync(outside, { recursive: true });
    const unrelated = join(outside, "thr_new.jsonl");
    writeFileSync(unrelated, "operator data\n");
    // The first append (session.open) opens the file, and a swap after its lstat makes the open
    // land on the unrelated outside file: the append is refused and cleanup must leave it alone.
    setSessionAppendOpenForTests({
      noFollowFlag: false,
      afterLstat: () => {
        renameSync(sessions, join(home, "sessions-moved"));
        symlinkSync(outside, sessions);
      },
    });
    assert.throws(
      () =>
        SessionWriter.create(
          join(sessions, "thr_new.jsonl"),
          "thr_new",
          "madc-default",
          { cwd: null, backing: "kimi-code", providerId: "kimi-code", pinnedModel: "m" },
          () => [],
          1000,
          home,
        ),
      (err: RpcError) => err.code === -32009 && (err.data as { seq: number }).seq === 0,
    );
    assert.equal(readFileSync(unrelated, "utf8"), "operator data\n", "unrelated file kept");
    // Without a swap, a failed create still removes the file it created.
    setSessionAppendOpenForTests(null);
    rmSync(sessions);
    renameSync(join(home, "sessions-moved"), sessions);
    rmSync(join(sessions, "thr_new.jsonl"));
    setSessionWriteForTests(() => {
      throw new Error("disk full");
    });
    assert.throws(
      () =>
        SessionWriter.create(
          join(sessions, "thr_own.jsonl"),
          "thr_own",
          "madc-default",
          { cwd: null, backing: "kimi-code", providerId: "kimi-code", pinnedModel: "m" },
          () => [],
          1000,
          home,
        ),
      (err: RpcError) => err.code === -32009,
    );
    assert.equal(existsSync(join(sessions, "thr_own.jsonl")), false, "own file removed");
  } finally {
    setSessionAppendOpenForTests(null);
    setSessionWriteForTests(null);
    cleanup();
  }
});

test("R-dangling: a dangling sessions/<id>.jsonl symlink is refused (-32603), not reported as not found", async () => {
  if (!POSIX) return; // symlink creation needs privileges on Windows
  const { home, cleanup } = makeHome();
  const e = inProcess(home, { name: "idle", async run() {} });
  try {
    await e.request("initialize", { clientInfo: { name: "t", version: "0" } });
    symlinkSync(
      join(home, "..", "does-not-exist.jsonl"),
      join(home, "sessions", "thr_dangle.jsonl"),
    );
    const resume = await e.request("thread/resume", { threadId: "thr_dangle" });
    assert.equal((resume.error as { code: number }).code, -32603);
    const missing = await e.request("thread/resume", { threadId: "thr_absent" });
    assert.equal((missing.error as { code: number }).code, -32002);
  } finally {
    e.input.end();
    await e.done;
    cleanup();
  }
});

test("R-tojson: a toJSON hook in a payload never writes an unredacted secret", () => {
  const { home, cleanup } = makeHome();
  const secret = "super-secret-configured-value";
  try {
    const sessions = join(home, "sessions");
    mkdirSync(sessions, { recursive: true });
    const path = join(sessions, "thr_hook.jsonl");
    const w = SessionWriter.create(
      path,
      "thr_hook",
      "madc-default",
      { cwd: null, backing: "kimi-code", providerId: "kimi-code", pinnedModel: "m" },
      () => [secret],
      1000,
      home,
    );
    const hookFn = Object.assign(() => 0, { toJSON: () => secret });
    w.append("item", {
      turnId: "turn_1",
      item: {
        id: "item_1",
        kind: "agentMessage",
        status: "completed",
        text: "ok",
        nested: { toJSON: () => secret },
        list: [hookFn, { toJSON: () => `Bearer ${secret}` }],
        toJSON: () => ({ text: secret }),
      },
    } as never);
    const text = readFileSync(path, "utf8");
    assert.equal(text.includes(secret), false, "the secret never reaches the JSONL");
    const r = verifySessionFile(path, "thr_hook", {}, home);
    assert.equal(r.ok, true);
    const item = (r.ok ? r.events[1]?.payload : undefined) as { item: Record<string, unknown> };
    assert.equal(item.item.text, "ok");
    assert.deepEqual(item.item.nested, {});
    assert.deepEqual(item.item.list, [null, {}]);
  } finally {
    cleanup();
  }
});

test("R-resume-identity: resume refuses a different file swapped in after verification", () => {
  if (!POSIX) return; // directory rename semantics
  const { home, cleanup } = makeHome();
  try {
    const sessions = join(home, "sessions");
    const path = writeSampleSession(sessions);
    const verified = verifySessionFile(path, "thr_sample", {}, home);
    assert.equal(verified.ok, true);
    if (!verified.ok) return;
    assert.notEqual(verified.file, undefined);
    // The verified file still in place: resume works and the chain continues.
    const same = SessionWriter.resume(
      path,
      "thr_sample",
      "madc-default",
      verified.nextSeq,
      verified.lastHash,
      () => [],
      home,
      verified.file,
    );
    same.append("turn.start", { turnId: "turn_2", inputText: "a" });
    assert.equal(verifySessionFile(path, "thr_sample", {}, home).ok, true);
    // Swapped (inside the home) between verification and resume: refused, nothing appended.
    const again = verifySessionFile(path, "thr_sample", {}, home);
    assert.equal(again.ok, true);
    if (!again.ok) return;
    renameSync(sessions, join(home, "sessions-old"));
    const replacement = writeSampleSession(sessions);
    const replacementBytes = readFileSync(replacement, "utf8");
    assert.throws(
      () =>
        SessionWriter.resume(
          path,
          "thr_sample",
          "madc-default",
          again.nextSeq,
          again.lastHash,
          () => [],
          home,
          again.file,
        ),
      (err: RpcError) => err.code === -32009 && (err.data as { seq: number }).seq === again.nextSeq,
    );
    assert.equal(readFileSync(replacement, "utf8"), replacementBytes, "replacement untouched");
  } finally {
    cleanup();
  }
});

test("R-turn-error: a rebuilt turn error is {code, message} only, whatever extra fields the line holds", () => {
  const open = { cwd: null, backing: "kimi-code", providerId: "kimi-code", pinnedModel: "m" };
  const r = verifySessionText(
    forgeSession("thr_err", [
      ["session.open", open],
      ["turn.start", { turnId: "turn_1", inputText: "x" }],
      [
        "turn.end",
        {
          turnId: "turn_1",
          status: "failed",
          error: { code: -32009, message: "Session write failed", data: { path: "/secret" } },
        },
      ],
    ]),
  );
  assert.equal(r.ok, true);
  const rebuilt = rebuildSession(r.ok ? r.events : []);
  assert.deepEqual(rebuilt.turns[0]?.error, { code: -32009, message: "Session write failed" });
});

test("R-seed-cleanup-swap: the seed's cleanup never unlinks an unrelated file after a seats/ swap", () => {
  if (!POSIX) return; // symlink creation needs privileges on Windows
  const { home, cleanup } = makeHome();
  const outside = join(home, "..", "outside-seed-cleanup");
  const seats = join(home, "seats");
  const moved = join(home, "seats-moved");
  // Swap seats/ for a symlink to `outside`, where an unrelated file already has the temp's name.
  const swapWithDecoy = (name: string, bytes: string) => {
    renameSync(seats, moved);
    symlinkSync(outside, seats);
    writeFileSync(join(outside, name), bytes);
  };
  const reset = () => {
    rmSync(seats, { recursive: true, force: true });
    rmSync(moved, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    mkdirSync(seats, { recursive: true, mode: 0o700 });
    mkdirSync(outside);
  };
  try {
    // A write failure after a swap: the partial-file cleanup leaves the unrelated file alone.
    reset();
    let name = "";
    setSeedHooksForTests({
      beforeWrite: (path) => {
        name = basename(path);
        swapWithDecoy(name, "operator data\n");
        throw new Error("disk full");
      },
    });
    assert.throws(() => seedDefaultSeat(home), /disk full/);
    assert.equal(readFileSync(join(outside, name), "utf8"), "operator data\n", "unrelated kept");
    // Without a swap, a write failure still removes the seed's own partial temp file.
    reset();
    setSeedHooksForTests({
      beforeWrite: () => {
        throw new Error("disk full");
      },
    });
    assert.throws(() => seedDefaultSeat(home), /disk full/);
    assert.deepEqual(readdirSync(seats), [], "own partial temp file removed");
    // A swap before the link: the final temp cleanup leaves the unrelated file alone.
    reset();
    setSeedHooksForTests({
      beforeLink: (tmp) => {
        name = basename(tmp);
        swapWithDecoy(name, "operator data 2\n");
      },
    });
    assert.throws(() => seedDefaultSeat(home), /changed while the seed was being linked/);
    assert.equal(readFileSync(join(outside, name), "utf8"), "operator data 2\n", "unrelated kept");
    // A normal seed still leaves no temp file behind.
    reset();
    setSeedHooksForTests(null);
    assert.equal(seedDefaultSeat(home).created, true);
    assert.deepEqual(readdirSync(seats), ["madc-default.json"]);
  } finally {
    setSeedHooksForTests(null);
    cleanup();
  }
});

test("R-seed-dir-chmod: a home subdir swapped after its lstat check is never chmod'ed", () => {
  if (!POSIX) return; // symlinks and mode bits: POSIX only (Windows is a no-op, PR #10 waiver)
  const { home, cleanup } = makeHome();
  const memory = join(home, "memory");
  const outside = join(home, "..", "outside-memory");
  const mode = (p: string) => statSync(p).mode & 0o777;
  const reset = () => {
    for (const p of [memory, outside, join(home, "memory-moved")]) {
      rmSync(p, { recursive: true, force: true });
    }
    mkdirSync(memory, { recursive: true });
    chmodSync(memory, 0o755);
    mkdirSync(outside);
    chmodSync(outside, 0o755);
  };
  const onMemory = (swap: () => void) => (dir: string) => {
    if (dir !== memory) return;
    renameSync(memory, join(home, "memory-moved"));
    swap();
  };
  try {
    // Swapped for a symlink to an outside directory: refused, the outside mode is untouched.
    reset();
    setSeedHooksForTests({ afterDirCheck: onMemory(() => symlinkSync(outside, memory)) });
    assert.throws(() => seedDefaultSeat(home), /memory under MADC_HOME must be a real directory/);
    assert.equal(mode(outside), 0o755, "symlink target not chmod'ed");
    // Swapped for a different real directory: refused (dev + inode), its mode is untouched.
    reset();
    setSeedHooksForTests({ afterDirCheck: onMemory(() => renameSync(outside, memory)) });
    assert.throws(() => seedDefaultSeat(home), /memory under MADC_HOME must be a real directory/);
    assert.equal(mode(memory), 0o755, "replacement directory not chmod'ed");
    // No swap: a pre-existing 0755 subdir is tightened to 0700.
    reset();
    setSeedHooksForTests(null);
    assert.equal(seedDefaultSeat(home).created, true);
    assert.equal(mode(memory), 0o700);
    assert.equal(mode(outside), 0o755);
  } finally {
    setSeedHooksForTests(null);
    cleanup();
  }
});

test("R-seed-open-swap: the seed never leaves a file in a seats/ swapped around its temp open", () => {
  if (!POSIX) return; // symlink creation needs privileges on Windows
  const { home, cleanup } = makeHome();
  const outside = join(home, "..", "outside-seed-open");
  const seats = join(home, "seats");
  const moved = join(home, "seats-moved");
  const swap = () => {
    renameSync(seats, moved);
    symlinkSync(outside, seats);
  };
  const reset = () => {
    rmSync(seats, { recursive: true, force: true });
    rmSync(moved, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    mkdirSync(seats, { recursive: true, mode: 0o700 });
    mkdirSync(outside);
  };
  try {
    // Swapped before the pre-open re-pin: refused, the open is never attempted.
    reset();
    const steps: string[] = [];
    setSeedHooksForTests({ beforeOpen: swap, afterPinCheck: (step) => steps.push(step) });
    assert.throws(() => seedDefaultSeat(home), /changed while the seed was being written/);
    assert.deepEqual(steps, [], "no open through the swapped seats/");
    assert.deepEqual(readdirSync(outside), [], "nothing created outside");
    // Swapped in the re-pin-to-open gap: refused before a byte, its own empty file removed.
    reset();
    setSeedHooksForTests({ afterPinCheck: (step) => (step === "open" ? swap() : undefined) });
    assert.throws(() => seedDefaultSeat(home), /changed while the seed was being written/);
    assert.deepEqual(readdirSync(outside), [], "own stray temp file removed from outside");
  } finally {
    setSeedHooksForTests(null);
    cleanup();
  }
});

test("R-seed-link-swap: the seed never leaves a hard link in a seats/ swapped around its link", () => {
  if (!POSIX) return; // symlink creation needs privileges on Windows
  const { home, cleanup } = makeHome();
  const outside = join(home, "..", "outside-seed-link");
  const seats = join(home, "seats");
  const moved = join(home, "seats-moved");
  const stray = join(outside, "madc-default.json");
  let name = "";
  // Swap seats/ for a symlink to `outside`, where an unrelated file already has the temp's name.
  const swapWithDecoy = () => {
    renameSync(seats, moved);
    symlinkSync(outside, seats);
    writeFileSync(join(outside, name), "operator data\n");
  };
  const reset = () => {
    rmSync(seats, { recursive: true, force: true });
    rmSync(moved, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    mkdirSync(seats, { recursive: true, mode: 0o700 });
    mkdirSync(outside);
  };
  const decoyIntact = () => {
    assert.equal(readFileSync(join(outside, name), "utf8"), "operator data\n", "decoy unchanged");
    assert.equal(statSync(join(outside, name)).nlink, 1, "decoy has no extra hard link");
  };
  try {
    // Swapped before the pre-link re-pin: refused, the link is never attempted.
    reset();
    const steps: string[] = [];
    setSeedHooksForTests({
      beforeLink: (tmp) => {
        name = basename(tmp);
        swapWithDecoy();
      },
      afterPinCheck: (step) => steps.push(step),
    });
    assert.throws(() => seedDefaultSeat(home), /changed while the seed was being linked/);
    assert.deepEqual(steps, ["open"], "no link through the swapped seats/");
    assert.equal(existsSync(stray), false, "nothing linked outside");
    decoyIntact();
    // Swapped in the re-pin-to-link gap (Node has no linkat): the link lands outside, is detected,
    // and the name it created there is removed; the decoy keeps its only link.
    reset();
    setSeedHooksForTests({
      beforeLink: (tmp) => {
        name = basename(tmp);
      },
      afterPinCheck: (step) => (step === "link" ? swapWithDecoy() : undefined),
    });
    assert.throws(() => seedDefaultSeat(home), /changed while the seed was being linked/);
    assert.equal(existsSync(stray), false, "stray hard link removed from outside");
    decoyIntact();
    // A normal seed still works and leaves only the seat file.
    reset();
    setSeedHooksForTests(null);
    assert.equal(seedDefaultSeat(home).created, true);
    assert.deepEqual(readdirSync(seats), ["madc-default.json"]);
  } finally {
    setSeedHooksForTests(null);
    cleanup();
  }
});

test("R-seed-dir-0300: an existing owner-unreadable home subdir does not fail the seed", () => {
  // POSIX mode bits only; root ignores the missing read bit, so the case cannot arise there.
  if (!POSIX || process.getuid?.() === 0) return;
  const { home, cleanup } = makeHome();
  const memory = join(home, "memory");
  const mode = () => statSync(memory).mode & 0o777;
  try {
    mkdirSync(memory, { recursive: true });
    chmodSync(memory, 0o300);
    assert.equal(seedDefaultSeat(home).created, true);
    assert.equal(mode(), 0o300, "nothing to tighten: left as it was");
    // Group/other bits but no owner read: it cannot be fchmod'ed via a no-follow fd, so the seed
    // fails closed instead of falling back to a path-based chmod.
    chmodSync(memory, 0o310);
    assert.throws(() => seedDefaultSeat(home), { code: "EACCES" });
    assert.equal(mode(), 0o310, "never chmod'ed by path");
  } finally {
    chmodSync(memory, 0o700);
    cleanup();
  }
});
