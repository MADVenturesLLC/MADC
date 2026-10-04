/**
 * M0 Amendment 2 (docs/plan/PIN-madc-M0-amendment-2-session-integrity.md) acceptance §8:
 * a stale in-memory writer never survives a lock re-take (§3), every append re-checks lock
 * ownership and file position on the fd it writes through (§2), every append batch and every
 * session-file create is fsynced (§4), and the verifier tells a torn tail from an integrity
 * failure while the engine still fails closed (§5). Includes Argus's post-merge probe of PR #13
 * (`zz-review-fork.test.ts`) as a regression test and a real `unshare -Urpf` cross-namespace run.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import { type Agent, echoAgent } from "./agent.ts";
import { EngineClient, withoutUndefined } from "./client.ts";
import { inspectMadcHome } from "./inspect.ts";
import { acquireThreadLock, isPidAlive, readLock, reclaimIfUnchanged } from "./lock.ts";
import type { Turn } from "./protocol/types.ts";
import { seedDefaultSeat } from "./seat-store.ts";
import { EngineConnection } from "./server.ts";
import {
  SessionChainIndex,
  SessionWriter,
  setSessionFsyncForTests,
  unguardedSessionWriterForTests,
  verifySessionFile,
  verifySessionText,
} from "./session-store.ts";
import {
  ECHO_ENGINE,
  GATED_ENGINE,
  handshake,
  hermeticEnv,
  makeHome,
  startEngine,
} from "./testing/harness.ts";

type Wire = Record<string, unknown> & { params?: Record<string, unknown> };

function inProcess(home: string, agent: Agent = echoAgent) {
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
    const until = Date.now() + 5000;
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
  const init = () => request("initialize", { clientInfo: { name: "t", version: "0" } });
  const close = async () => {
    input.end();
    await done;
  };
  return { input, received, done, waitFor, request, init, close };
}

/** Agent whose agentMessage completes (the turn's next append) only when `open()` is called. */
function gatedAgent(): { agent: Agent; open: () => void } {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const agent: Agent = {
    name: "gated",
    async run(_ctx, sink) {
      const id = sink.newItemId();
      sink.startItem({ id, kind: "agentMessage", status: "inProgress", text: "" });
      await gate;
      sink.completeItem({ id, kind: "agentMessage", status: "completed", text: "gated" });
    },
  };
  return { agent, open: () => release() };
}

const text = (t: string) => [{ type: "text", text: t }];
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const sessionPath = (home: string, id: string) => join(home, "sessions", `${id}.jsonl`);
const lockPath = (home: string, id: string) => join(home, "sessions", `${id}.lock`);
const seqTypes = (path: string) =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => {
      const e = JSON.parse(l) as { seq: number; type: string };
      return `${e.seq} ${e.type}`;
    });

const agentMessageStarted = (m: Wire): boolean =>
  m.method === "item/started" &&
  (m.params?.item as { kind?: string } | undefined)?.kind === "agentMessage";

function describe(v: ReturnType<typeof verifySessionFile>): string {
  return v.ok ? "ok" : `${v.kind} line ${v.line}: ${v.reason}`;
}

function completedTurn(m: Wire): Turn {
  return (m.params as { turn: Turn }).turn;
}

/** A pid that is not alive here (kill(pid, 0) → ESRCH). */
function deadPid(): number {
  for (let pid = 4_194_000; pid > 1000; pid--) if (!isPidAlive(pid)) return pid;
  throw new Error("no dead pid found");
}

async function startThread(e: ReturnType<typeof inProcess>): Promise<string> {
  await e.init();
  const start = await e.request("thread/start", {});
  return (start.result as { thread: { id: string } }).thread.id;
}

// ------------------------------------------------------------------- §8 item 1 (§3)

test("A2 §8.1 Argus fork probe: lock lost while A is alive → B appends → A's turn/start reloads from disk; chain continuous", async () => {
  const { home, cleanup } = makeHome();
  const a = inProcess(home);
  try {
    const t = await startThread(a);
    const path = sessionPath(home, t);
    unlinkSync(lockPath(home, t)); // lock lost while A is alive
    const b = inProcess(home);
    await b.init();
    const r = await b.request("thread/resume", { threadId: t });
    assert.ok(r.result, JSON.stringify(r));
    const ts = await b.request("turn/start", { threadId: t, input: text("from b") });
    assert.ok(ts.result, JSON.stringify(ts));
    assert.equal(
      completedTurn(await b.waitFor((m) => m.method === "turn/completed")).status,
      "completed",
    );
    await b.close(); // B releases its lock
    assert.equal(verifySessionFile(path, t).ok, true, "chain fine after B");
    const linesAfterB = seqTypes(path).length;

    const ta = await a.request("turn/start", { threadId: t, input: text("from a") });
    assert.ok(ta.result, `A turn/start: ${JSON.stringify(ta.error)}`);
    const done = completedTurn(await a.waitFor((m) => m.method === "turn/completed"));
    assert.equal(done.status, "completed", JSON.stringify(done.error));
    const v = verifySessionFile(path, t);
    assert.equal(v.ok, true, `session chain must still verify: ${describe(v)}`);
    const lines = seqTypes(path);
    assert.deepEqual(
      lines.map((l) => Number(l.split(" ")[0])),
      lines.map((_, i) => i),
      "seq is continuous 0..n-1",
    );
    assert.equal(lines[linesAfterB], `${linesAfterB} turn.start`, "A continued from B's last seq");
    // Cold resume and thread/list still see the thread (the fork made it vanish before).
    const c = inProcess(home);
    await c.init();
    const list = await c.request("thread/list", {});
    assert.ok(
      (list.result as { data: Array<{ id: string }> }).data.some((d) => d.id === t),
      "thread/list keeps the thread",
    );
    await a.close();
    const cold = await c.request("thread/resume", { threadId: t });
    assert.ok(cold.result, `cold resume: ${JSON.stringify(cold.error)}`);
    await c.close();
  } finally {
    await a.close();
    cleanup();
  }
});

test("A2 §8.1 warm thread/resume after a lost lock reloads the thread from disk (B's turn is visible)", async () => {
  const { home, cleanup } = makeHome();
  const a = inProcess(home);
  try {
    const t = await startThread(a);
    unlinkSync(lockPath(home, t));
    const b = inProcess(home);
    await b.init();
    await b.request("thread/resume", { threadId: t });
    await b.request("turn/start", { threadId: t, input: text("from b") });
    await b.waitFor((m) => m.method === "turn/completed");
    await b.close();
    const r = await a.request("thread/resume", { threadId: t });
    const thread = (r.result as { thread: { preview: string } }).thread;
    assert.equal(thread.preview, "from b", "state came from disk, not the stale in-memory thread");
    assert.equal(readLock(lockPath(home, t)).state, "held", "A holds a fresh lock");
  } finally {
    await a.close();
    cleanup();
  }
});

test("A2 §8.1 a re-take whose reload fails verification answers -32603, releases the lock, leaves the file untouched", async () => {
  const { home, cleanup } = makeHome();
  const a = inProcess(home);
  try {
    const t = await startThread(a);
    await a.request("turn/start", { threadId: t, input: text("hello") });
    await a.waitFor((m) => m.method === "turn/completed");
    const path = sessionPath(home, t);
    unlinkSync(lockPath(home, t));
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace('"inputText":"hello"', '"inputText":"HELLO"'),
    );
    const before = sha256(path);
    const r = await a.request("turn/start", { threadId: t, input: text("again") });
    assert.equal((r.error as { code: number }).code, -32603);
    assert.equal(existsSync(lockPath(home, t)), false, "the re-taken lock was released");
    assert.equal(sha256(path), before, "file untouched");
    const again = await a.request("turn/start", { threadId: t, input: text("again") });
    assert.equal((again.error as { code: number }).code, -32002, "stale state was discarded");
  } finally {
    await a.close();
    cleanup();
  }
});

test("A2 §3 a thread with a turn still running here is never re-taken (-32004 with activeTurnId); its next append fails -32009", async () => {
  const { home, cleanup } = makeHome();
  const g = gatedAgent();
  const a = inProcess(home, g.agent);
  try {
    const t = await startThread(a);
    const ts = await a.request("turn/start", { threadId: t, input: text("x") });
    const turnId = (ts.result as { turn: Turn }).turn.id;
    await a.waitFor(agentMessageStarted);
    unlinkSync(lockPath(home, t));
    const r = await a.request("thread/resume", { threadId: t });
    const err = r.error as { code: number; data: { activeTurnId: string | null } };
    assert.equal(err.code, -32004);
    assert.equal(err.data.activeTurnId, turnId);
    assert.equal(existsSync(lockPath(home, t)), false, "no re-take while the turn runs");
    const before = sha256(sessionPath(home, t));
    g.open();
    const done = completedTurn(await a.waitFor((m) => m.method === "turn/completed"));
    assert.equal(done.status, "failed");
    assert.equal(done.error?.code, -32009);
    assert.equal(sha256(sessionPath(home, t)), before, "nothing appended without the lock");
  } finally {
    await a.close();
    cleanup();
  }
});

// ------------------------------------------------------------------- §8 item 2 (§2 ownership)

test("A2 §8.2 foreign owner mid-turn: lock rewritten to a dead pid, B resumes and appends → A's next append -32009, no fork", async () => {
  const { home, cleanup } = makeHome();
  const g = gatedAgent();
  const a = inProcess(home, g.agent);
  try {
    const t = await startThread(a);
    await a.request("turn/start", { threadId: t, input: text("from a") });
    await a.waitFor(agentMessageStarted);
    // Same format as a real lock body, but the owner pid is dead here.
    const lp = lockPath(home, t);
    const body = JSON.parse(readFileSync(lp, "utf8")) as {
      pid: number;
      startedAt: number;
      token: string;
    };
    writeFileSync(lp, JSON.stringify({ ...body, pid: deadPid() }));
    const b = inProcess(home);
    await b.init();
    const r = await b.request("thread/resume", { threadId: t });
    assert.ok(r.result, JSON.stringify(r.error));
    await b.request("turn/start", { threadId: t, input: text("from b") });
    assert.equal(
      completedTurn(await b.waitFor((m) => m.method === "turn/completed")).status,
      "completed",
    );
    const path = sessionPath(home, t);
    const afterB = sha256(path);
    g.open();
    const done = completedTurn(await a.waitFor((m) => m.method === "turn/completed"));
    assert.equal(done.status, "failed");
    assert.equal(done.error?.code, -32009);
    assert.ok(
      done.items.some((i) => i.kind === "error" && i.code === -32009),
      "error item",
    );
    assert.equal(sha256(path), afterB, "A wrote nothing");
    assert.equal(verifySessionFile(path, t).ok, true, "no fork");
    await b.close();
  } finally {
    await a.close();
    cleanup();
  }
});

function unshareUnavailable(): string | null {
  if (process.platform !== "linux") return `platform ${process.platform} has no PID namespaces`;
  const probe = spawnSync("unshare", ["-Urpf", "true"], { stdio: "ignore" });
  if (probe.error !== undefined) return `unshare not runnable: ${probe.error.message}`;
  if (probe.status !== 0)
    return `unshare -Urpf exited ${String(probe.status)} (namespaces not permitted)`;
  return null;
}

test("A2 §8.2 real unshare -Urpf: an engine in another PID namespace loses its reclaimed lock → its next append -32009, no fork", async () => {
  const why = unshareUnavailable();
  if (why !== null) {
    console.log(`SKIP A2 §8.2 unshare variant: ${why}`);
    return;
  }
  const { home, cleanup } = makeHome();
  const gate = join(home, "..", "gate");
  const runtimeArgs =
    process.versions.bun !== undefined
      ? [GATED_ENGINE]
      : ["--disable-warning=ExperimentalWarning", GATED_ENGINE];
  // `/bin/true` first so the engine is not pid 1 in the new namespace (pid 1 is always live here).
  const script = `/bin/true; "$0" "$@"; exit $?`;
  const child = spawn("unshare", ["-Urpf", "sh", "-c", script, process.execPath, ...runtimeArgs], {
    stdio: ["pipe", "pipe", "inherit"],
    env: withoutUndefined({
      ...process.env,
      ...hermeticEnv({ MADC_HOME: home, MADC_TEST_GATE: gate }),
    }),
  });
  const a = new EngineClient(child);
  try {
    await handshake(a);
    const { thread } = await a.request("thread/start", {});
    await a.request("turn/start", {
      threadId: thread.id,
      input: [{ type: "text", text: "from a" }],
    });
    await a.waitForNotification("item/started", (p) => p.item.kind === "agentMessage");
    const held = readLock(lockPath(home, thread.id));
    assert.equal(held.state, "held");
    const nsPid = held.state === "held" ? held.pid : 0;
    if (isPidAlive(nsPid)) {
      console.log(`SKIP A2 §8.2 unshare variant: namespace pid ${nsPid} is also a live pid here`);
      return;
    }
    const b = startEngine(home, ECHO_ENGINE);
    try {
      await handshake(b);
      // The M0 residual (Amendment 2 §1): B cannot see A's pid, so it reclaims A's live lock.
      await b.request("thread/resume", { threadId: thread.id });
      await b.request("turn/start", {
        threadId: thread.id,
        input: [{ type: "text", text: "from b" }],
      });
      const bDone = await b.waitForNotification("turn/completed");
      assert.equal(bDone.turn.status, "completed");
    } finally {
      await b.close();
    }
    const path = sessionPath(home, thread.id);
    const afterB = sha256(path);
    writeFileSync(gate, "");
    const done = await a.waitForNotification("turn/completed");
    assert.equal(done.turn.status, "failed");
    assert.equal(done.turn.error?.code, -32009);
    assert.equal(sha256(path), afterB, "the namespaced engine wrote nothing after losing its lock");
    const v = verifySessionFile(path, thread.id);
    assert.equal(v.ok, true, `no fork: ${describe(v)}`);
  } finally {
    await a.close();
    cleanup();
  }
});

// ------------------------------------------------------------------- §8 item 3 (§2 position)

test("A2 §8.3 position: an external append between two of A's appends → A's next append -32009, writes nothing", async () => {
  const { home, cleanup } = makeHome();
  const g = gatedAgent();
  const a = inProcess(home, g.agent);
  try {
    const t = await startThread(a);
    await a.request("turn/start", { threadId: t, input: text("x") });
    await a.waitFor(agentMessageStarted);
    const path = sessionPath(home, t);
    appendFileSync(path, '{"external":true}\n');
    const before = readFileSync(path);
    g.open();
    const done = completedTurn(await a.waitFor((m) => m.method === "turn/completed"));
    assert.equal(done.status, "failed");
    assert.equal(done.error?.code, -32009);
    assert.deepEqual(readFileSync(path), before, "A wrote nothing after the external bytes");
    assert.equal(readLock(lockPath(home, t)).state, "held", "A still holds its lock");
  } finally {
    await a.close();
    cleanup();
  }
});

test("A2 §8.3 writer unit: size drift on the fd fails the batch with -32009, nothing written, writer broken", () => {
  const { home, cleanup } = makeHome();
  try {
    mkdirSync(join(home, "sessions"), { recursive: true });
    const path = join(home, "sessions", "thr_pos.jsonl");
    const w = unguardedSessionWriterForTests.create(
      path,
      "thr_pos",
      "madc-default",
      { cwd: null, backing: "kimi-code", providerId: "kimi-code", pinnedModel: "m" },
      () => [],
    );
    w.append("turn.start", { turnId: "turn_1", inputText: "a" });
    appendFileSync(path, "x");
    const before = readFileSync(path);
    assert.throws(
      () => w.append("turn.end", { turnId: "turn_1", status: "completed", error: null }),
      (err: { code?: number }) => err.code === -32009,
    );
    assert.deepEqual(readFileSync(path), before);
    assert.equal(w.broken, true);
  } finally {
    cleanup();
  }
});

test("A2 §8.3 resume is bound to the verified size: bytes appended after verification fail the first append (-32009)", () => {
  const { home, cleanup } = makeHome();
  try {
    mkdirSync(join(home, "sessions"), { recursive: true });
    const path = join(home, "sessions", "thr_gap.jsonl");
    unguardedSessionWriterForTests.create(
      path,
      "thr_gap",
      "madc-default",
      { cwd: null, backing: "kimi-code", providerId: "kimi-code", pinnedModel: "m" },
      () => [],
    );
    const v = verifySessionFile(path, "thr_gap", {}, home);
    assert.ok(v.ok);
    if (!v.ok) return;
    assert.equal(v.size, readFileSync(path).length, "verifier reports the verified byte size");
    if (v.size === undefined) throw new Error("verifier reports the byte size");
    const expectedSize = v.size;
    appendFileSync(path, "late\n"); // lands between verification and resume
    const before = readFileSync(path);
    const w = SessionWriter.resume(
      path,
      "thr_gap",
      "madc-default",
      v.nextSeq,
      v.lastHash,
      () => [],
      home,
      v.file,
      {
        holdsLock: () => true,
        expectedSize,
      },
      undefined,
      // Argus P11: resume now requires the verified chain's index.
      SessionChainIndex.fromEvents(v.events),
    );
    assert.throws(
      () => w.append("turn.start", { turnId: "turn_1", inputText: "a" }),
      (err: { code?: number }) => err.code === -32009,
    );
    assert.deepEqual(readFileSync(path), before);
  } finally {
    cleanup();
  }
});

// ------------------------------------------------------------------- §8 item 4 (§4 fsync)

test("A2 §8.4 fsync: one file fsync per append batch, one sessions/ fsync on create; a failed fsync rolls back and answers -32009", () => {
  const { home, cleanup } = makeHome();
  const files: number[] = [];
  const dirs: string[] = [];
  let failNext = false;
  setSessionFsyncForTests({
    file: (fd) => {
      files.push(fd);
      if (failNext) throw new Error("EIO (injected)");
    },
    dir: (dir) => {
      dirs.push(dir);
    },
  });
  try {
    const sessions = join(home, "sessions");
    mkdirSync(sessions, { recursive: true });
    const path = join(sessions, "thr_sync.jsonl");
    const w = unguardedSessionWriterForTests.create(
      path,
      "thr_sync",
      "madc-default",
      { cwd: null, backing: "kimi-code", providerId: "kimi-code", pinnedModel: "m" },
      () => [],
    );
    assert.deepEqual(dirs, [realpathSync(sessions)], "one directory fsync of sessions/ on create");
    assert.equal(files.length, 1, "session.open batch fsynced");
    w.append("turn.start", { turnId: "turn_1", inputText: "a" });
    assert.equal(files.length, 2);
    w.appendAll([
      {
        type: "servedModel",
        payload: {
          turnId: "turn_1",
          requestedModel: "m",
          servedModel: "m",
          backing: "kimi-code",
          providerId: "kimi-code",
          lane: "allowed-direct",
          mode: "headless",
          fallbackFrom: null,
          vendorReported: false,
        },
      },
      { type: "turn.end", payload: { turnId: "turn_1", status: "completed", error: null } },
    ]);
    assert.equal(files.length, 3, "a two-event batch is one fsync");
    assert.equal(dirs.length, 1, "appends never fsync the directory");
    const before = readFileSync(path);
    failNext = true;
    assert.throws(
      () => w.append("turn.start", { turnId: "turn_2", inputText: "b" }),
      (err: { code?: number }) => err.code === -32009,
    );
    assert.deepEqual(readFileSync(path), before, "rolled back to the prior size");
    assert.equal(w.broken, true);
    assert.equal(verifySessionFile(path, "thr_sync").ok, true);
  } finally {
    setSessionFsyncForTests(null);
    cleanup();
  }
});

test("A2 §8.4 a failed sessions/ directory fsync fails thread/start with -32009 and leaves no session file", async () => {
  const { home, cleanup } = makeHome();
  setSessionFsyncForTests({
    dir: () => {
      throw new Error("EIO (injected)");
    },
  });
  const e = inProcess(home);
  try {
    await e.init();
    const r = await e.request("thread/start", {});
    assert.equal((r.error as { code: number }).code, -32009);
    const left = readdirSync(join(home, "sessions"));
    assert.deepEqual(left, [], "no session file and no lock left behind");
  } finally {
    setSessionFsyncForTests(null);
    await e.close();
    cleanup();
  }
});

// ------------------------------------------------------------------- §8 item 5 (§5)

function sampleSession(home: string): string {
  mkdirSync(join(home, "sessions"), { recursive: true });
  const path = sessionPath(home, "thr_torn");
  const w = unguardedSessionWriterForTests.create(
    path,
    "thr_torn",
    "madc-default",
    {
      cwd: null,
      backing: "kimi-code",
      providerId: "kimi-code",
      pinnedModel: "kimi-coding/kimi-for-coding",
    },
    () => [],
  );
  w.append("turn.start", { turnId: "turn_1", inputText: "hi" });
  w.append("turn.end", { turnId: "turn_1", status: "completed", error: null });
  return path;
}

test("A2 §8.5 torn tail vs integrity: half line and NUL tail are torn-tail, a mid-file edit is integrity; resume -32603, file unchanged", async () => {
  const { home, cleanup } = makeHome();
  try {
    const path = sampleSession(home);
    const good = readFileSync(path, "utf8");
    const lines = good.slice(0, -1).split("\n");
    const cases: Array<[string, string, "torn-tail" | "integrity", number]> = [
      ["half-written last line", `${good}${(lines[1] ?? "").slice(0, 40)}`, "torn-tail", 4],
      ["NUL-filled tail", `${good}${"\0".repeat(64)}`, "torn-tail", 4],
      ["mid-file edit", good.replace('"inputText":"hi"', '"inputText":"HI"'), "integrity", 2],
      [
        "mid-file edit plus a torn tail",
        `${good.replace('"inputText":"hi"', '"inputText":"HI"')}{"v":1`,
        "integrity",
        2,
      ],
      ["only a fragment", `${(lines[0] ?? "").slice(0, 30)}`, "torn-tail", 1],
    ];
    for (const [name, content, kind, line] of cases) {
      const r = verifySessionText(content, "thr_torn");
      assert.equal(r.ok, false, name);
      if (r.ok) continue;
      assert.equal(r.kind, kind, `${name}: ${r.reason}`);
      assert.equal(r.line, line, name);
      writeFileSync(path, content);
      const f = verifySessionFile(path, "thr_torn", {}, home);
      assert.equal(f.ok ? null : f.kind, kind, `${name} (file)`);
      const before = sha256(path);
      const e = inProcess(home);
      await e.init();
      const res = await e.request("thread/resume", { threadId: "thr_torn" });
      assert.equal((res.error as { code: number }).code, -32603, `${name}: fail closed`);
      const list = await e.request("thread/list", {});
      assert.deepEqual((list.result as { data: unknown[] }).data, [], `${name}: list skips it`);
      await e.close();
      assert.equal(sha256(path), before, `${name}: file never modified`);
      assert.equal(existsSync(lockPath(home, "thr_torn")), false, `${name}: lock released`);
    }
    assert.equal(verifySessionText(good, "thr_torn").ok, true);
  } finally {
    cleanup();
  }
});

test("A2 §5 inspectMadcHome carries the torn-tail / integrity kind (Copilot r4107434941)", () => {
  const { home, cleanup } = makeHome();
  try {
    const path = sampleSession(home);
    const good = readFileSync(path, "utf8");
    writeFileSync(path, `${good}{"v":1`);
    const torn = inspectMadcHome(home).lastSession?.chain;
    assert.deepEqual(torn, {
      ok: false,
      line: 4,
      reason: "unterminated last line",
      kind: "torn-tail",
    });
    writeFileSync(path, good.replace('"inputText":"hi"', '"inputText":"HI"'));
    const edited = inspectMadcHome(home).lastSession?.chain;
    assert.equal(edited?.ok === false ? edited.kind : null, "integrity");
  } finally {
    cleanup();
  }
});

test("A2 §3 dangling turns close in one batch: a failed close leaves the file untouched (Copilot r4107434889)", async () => {
  const { home, cleanup } = makeHome();
  try {
    mkdirSync(join(home, "sessions"), { recursive: true });
    seedDefaultSeat(home);
    const path = sessionPath(home, "thr_dangle");
    const w = unguardedSessionWriterForTests.create(
      path,
      "thr_dangle",
      "madc-default",
      {
        cwd: null,
        backing: "kimi-code",
        providerId: "kimi-code",
        pinnedModel: "kimi-coding/kimi-for-coding",
      },
      () => [],
    );
    w.append("turn.start", { turnId: "turn_a", inputText: "a" });
    w.append("turn.start", { turnId: "turn_b", inputText: "b" });
    const before = sha256(path);
    let syncs = 0;
    // Amendment 3 rule 2: fail the close batch's fsync; the rollback fsync that follows succeeds,
    // so the recovery is a durable rollback (row (a)), not a poisoning. The failed batch costs two
    // file fsyncs: its own and the rollback's.
    setSessionFsyncForTests({
      file: () => {
        syncs++;
        if (syncs === 1) throw new Error("EIO (injected)");
      },
    });
    const e = inProcess(home);
    try {
      await e.init();
      const r = await e.request("thread/resume", { threadId: "thr_dangle" });
      assert.equal((r.error as { code: number }).code, -32009);
      assert.equal(syncs, 2, "both turn.end events were one batch (batch fsync + rollback fsync)");
      assert.equal(sha256(path), before, "nothing of the recovery persisted");
      assert.equal(existsSync(lockPath(home, "thr_dangle")), false, "lock released");
    } finally {
      setSessionFsyncForTests(null);
    }
    let okSyncs = 0;
    setSessionFsyncForTests({ file: () => void okSyncs++ });
    let ok: Awaited<ReturnType<typeof e.request>>;
    try {
      ok = await e.request("thread/resume", { threadId: "thr_dangle" });
    } finally {
      setSessionFsyncForTests(null);
    }
    assert.equal(okSyncs, 1, "two dangling turns → one durable batch (one fsync)");
    assert.ok(ok.result, JSON.stringify(ok.error));
    const tail = seqTypes(path).slice(-2);
    assert.deepEqual(tail, ["3 turn.end", "4 turn.end"]);
    assert.equal(verifySessionFile(path, "thr_dangle").ok, true);
    await e.close();
  } finally {
    cleanup();
  }
});

// ------------------------------------------------------------------- §8 item 6 (§6)

test("A2 §8.6 three-engine race: A's live lock is left at .lock.reclaim-*, another lock takes the path → A's next append -32009", async () => {
  const { home, cleanup } = makeHome();
  const g = gatedAgent();
  const a = inProcess(home, g.agent);
  try {
    const t = await startThread(a);
    await a.request("turn/start", { threadId: t, input: text("x") });
    await a.waitFor(agentMessageStarted);
    const lp = lockPath(home, t);
    // R2 judged an earlier dead body; its rename moves A's live lock aside, and R3 creates a new
    // lock at the path before R2's link-back (which then fails with EEXIST).
    const staleFingerprint = `file:${JSON.stringify({ pid: deadPid(), startedAt: 1, token: "0".repeat(32) })}`;
    let r3Token = "";
    const outcome = reclaimIfUnchanged(lp, staleFingerprint, "f".repeat(32), {
      afterRename: () => {
        const r3 = acquireThreadLock(home, t);
        assert.ok(r3.ok);
        if (r3.ok) r3Token = r3.handle.token;
      },
    });
    assert.equal(outcome.outcome, "restored");
    const orphan = `${t}.lock.reclaim-${"f".repeat(32)}`;
    assert.ok(readdirSync(join(home, "sessions")).includes(orphan), "A's lock is orphaned aside");
    const now = readLock(lp);
    assert.equal(now.state === "held" ? now.token : null, r3Token, "R3 holds the path");
    const path = sessionPath(home, t);
    const before = sha256(path);
    g.open();
    const done = completedTurn(await a.waitFor((m) => m.method === "turn/completed"));
    assert.equal(done.status, "failed");
    assert.equal(done.error?.code, -32009);
    assert.equal(sha256(path), before, "the displaced holder wrote nothing");
    assert.equal(verifySessionFile(path, t).ok, true);
  } finally {
    await a.close();
    cleanup();
  }
});

// ------------------------------------------------------------------- §8 item 8

test("A2 §8.8 no contract change: lock body is still exactly { pid, startedAt, token }", async () => {
  const { home, cleanup } = makeHome();
  const a = inProcess(home);
  try {
    const t = await startThread(a);
    const body = JSON.parse(readFileSync(lockPath(home, t), "utf8")) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ["pid", "startedAt", "token"]);
  } finally {
    await a.close();
    cleanup();
  }
});
