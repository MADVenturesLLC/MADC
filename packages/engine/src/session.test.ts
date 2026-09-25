/**
 * M0-A4 session JSONL + hash chain (seat pin §4, §6 items 3–6, 8; protocol pin §3.3 token rule).
 * Network-free: the Kimi fixture engine (fake transport, `.invalid` host) and in-process engines.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import type { FakeKimiReply, FakeKimiRequest } from "@madc/adapters/testing";
import type { Agent } from "./agent.ts";
import type { EngineClient } from "./client.ts";
import { inspectMadcHome } from "./inspect.ts";
import { RpcError } from "./protocol/errors.ts";
import type { Item, ServedModelItem, Turn } from "./protocol/types.ts";
import { EngineConnection } from "./server.ts";
import {
  createRedactor,
  GENESIS_HASH,
  REDACTED,
  rebuildSession,
  SessionWriter,
  sessionEventHash,
  setSessionWriteForTests,
  sortedKeyJson,
  verifySessionFile,
  verifySessionText,
} from "./session-store.ts";
import {
  expectRpcError,
  HANG_ENGINE,
  handshake,
  KIMI_FAKE_ENGINE,
  makeHome,
  startEngine,
  startEngineCapturingStderr,
} from "./testing/harness.ts";

const KEY = "test-sentinel-key-4b7e";
const GHP = `ghp_${"A1b2C3d4E5".repeat(4)}`;
const POSIX = process.platform !== "win32";

type Line = {
  v: number;
  seq: number;
  ts: number;
  type: string;
  threadId: string;
  seatId: string;
  prevHash: string;
  hash: string;
  payload: Record<string, unknown>;
};

function sessionPath(home: string, threadId: string): string {
  return join(home, "sessions", `${threadId}.jsonl`);
}

function readLines(path: string): Line[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as Line);
}

/** Pin §4.3 written independently of the engine: deep key sort, then sha256(prev + "\n" + json). */
function independentCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(independentCanonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
        .map((k) => [k, independentCanonical((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

function independentVerify(path: string): void {
  let prev = "0".repeat(64);
  readLines(path).forEach((line, i) => {
    assert.equal(line.seq, i);
    assert.equal(line.prevHash, prev, `line ${i + 1} prevHash`);
    const { v, seq, ts, type, threadId, seatId, payload } = line;
    const canonical = JSON.stringify(
      independentCanonical({ v, seq, ts, type, threadId, seatId, payload }),
    );
    const expected = createHash("sha256").update(`${prev}\n${canonical}`, "utf8").digest("hex");
    assert.equal(line.hash, expected, `line ${i + 1} hash`);
    prev = line.hash;
  });
}

type KimiRun = {
  client: EngineClient;
  home: string;
  stderr: () => string;
  wire: () => FakeKimiRequest[];
};

function kimiEngine(
  home: string,
  opts: { reply?: FakeKimiReply; toolOutput?: string; wireLog?: string } = {},
): KimiRun {
  const wireLog = opts.wireLog ?? join(home, "..", "wire.jsonl");
  const extra: Record<string, string | undefined> = {
    KIMI_API_KEY: KEY,
    MADC_TEST_WIRE_LOG: wireLog,
  };
  if (opts.reply !== undefined) extra.MADC_TEST_KIMI_REPLY = JSON.stringify(opts.reply);
  if (opts.toolOutput !== undefined) extra.MADC_TEST_TOOL_OUTPUT = opts.toolOutput;
  const { client, stderr } = startEngineCapturingStderr(home, KIMI_FAKE_ENGINE, extra);
  const wire = () =>
    existsSync(wireLog)
      ? readFileSync(wireLog, "utf8")
          .split("\n")
          .filter((l) => l !== "")
          .map((l) => JSON.parse(l) as FakeKimiRequest)
      : [];
  return { client, home, stderr, wire };
}

async function runTurn(client: EngineClient, threadId: string, text: string): Promise<Turn> {
  const { turn } = await client.request("turn/start", {
    threadId,
    input: [{ type: "text", text }],
  });
  const done = await client.waitForNotification("turn/completed", (p) => p.turn.id === turn.id);
  return done.turn;
}

function wireMessages(request: FakeKimiRequest | undefined): Array<{ role: string; text: string }> {
  const body = JSON.parse(request?.body ?? "{}") as {
    messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>;
  };
  return body.messages.map((m) => ({
    role: m.role,
    text:
      typeof m.content === "string" ? m.content : m.content.map((part) => part.text ?? "").join(""),
  }));
}

test("§6.3 / §6.4: a seat run writes session.open → turn.start → items → servedModel → turn.end; receipt == protocol item", async () => {
  const { home, cleanup } = makeHome();
  const run = kimiEngine(home, {
    reply: { type: "stream", chunks: ["Hi", " there"], model: "kimi-for-coding-2026-09" },
  });
  try {
    await handshake(run.client);
    const { thread } = await run.client.request("thread/start", { cwd: "/tmp/proj" });
    const turn = await runTurn(run.client, thread.id, "say hi");
    assert.equal(turn.status, "completed");
    const path = sessionPath(home, thread.id);
    const lines = readLines(path);
    assert.deepEqual(
      lines.map((l) => (l.type === "item" ? `item:${(l.payload.item as Item).kind}` : l.type)),
      [
        "session.open",
        "turn.start",
        "item:userMessage",
        "item:agentMessage",
        "item:servedModel",
        "servedModel",
        "turn.end",
      ],
    );
    for (const line of lines) {
      // Line key order is stable (payload last), including for multi-event appends.
      assert.deepEqual(Object.keys(line), [
        "v",
        "seq",
        "ts",
        "type",
        "threadId",
        "seatId",
        "prevHash",
        "hash",
        "payload",
      ]);
      // Envelope is exactly the seat pin §4 line (v:1): no fields beyond the M0 pin.
      assert.deepEqual(Object.keys(line).sort(), [
        "hash",
        "payload",
        "prevHash",
        "seatId",
        "seq",
        "threadId",
        "ts",
        "type",
        "v",
      ]);
      assert.equal(line.v, 1);
      assert.equal(line.threadId, thread.id);
      assert.equal(line.seatId, "madc-default");
    }
    assert.equal(lines[0]?.prevHash, GENESIS_HASH);
    assert.deepEqual(lines[0]?.payload, {
      cwd: "/tmp/proj",
      backing: "kimi-code",
      providerId: "kimi-code",
      pinnedModel: "kimi-coding/kimi-for-coding",
    });
    assert.deepEqual(lines[1]?.payload, { turnId: turn.id, inputText: "say hi" });
    assert.deepEqual(lines[6]?.payload, { turnId: turn.id, status: "completed", error: null });
    // Items on disk are the item/completed items, in order.
    assert.deepEqual(
      lines.filter((l) => l.type === "item").map((l) => l.payload.item),
      turn.items,
    );
    // §6.4 dual write: the JSONL servedModel event equals the protocol servedModel item.
    const item = turn.items.find((i) => i.kind === "servedModel") as ServedModelItem;
    const event = lines.find((l) => l.type === "servedModel")?.payload;
    assert.deepEqual(event, {
      turnId: turn.id,
      requestedModel: item.requestedModel,
      servedModel: item.servedModel,
      backing: item.backing,
      providerId: item.providerId,
    });
    assert.equal(item.servedModel, "kimi-for-coding-2026-09");
    // §6.5: chain verifies (engine verifier and an independent implementation of pin §4.3).
    assert.equal(verifySessionFile(path, thread.id).ok, true);
    independentVerify(path);
    if (POSIX) assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally {
    await run.client.close();
    cleanup();
  }
});

test("sortedKeyJson: recursive key sort, array order kept, undefined keys omitted, no whitespace", () => {
  assert.equal(
    sortedKeyJson({ b: 1, a: { d: [{ z: 1, y: 2 }, 3], c: undefined }, é: "x", B: null }),
    '{"B":null,"a":{"d":[{"y":2,"z":1},3]},"b":1,"é":"x"}',
  );
});

/** A short valid chain written by the engine's writer (used by tamper tests). */
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

test("honesty §6.5: editing any single line (or dropping / reordering / truncating) fails verification", () => {
  const { home, cleanup } = makeHome();
  try {
    const path = writeSampleSession(home);
    const text = readFileSync(path, "utf8");
    assert.equal(verifySessionText(text).ok, true);
    const lines = text.slice(0, -1).split("\n");
    const edits: Array<[string, (l: Line) => void]> = [
      ["payload", (l) => (l.payload.tampered = true)],
      ["ts", (l) => (l.ts += 1)],
      ["type", (l) => (l.type = l.type === "item" ? "servedModel" : "item")],
      ["seatId", (l) => (l.seatId = "other-seat")],
      ["hash", (l) => (l.hash = l.hash.replace(/^./, (c) => (c === "0" ? "1" : "0")))],
    ];
    for (let i = 0; i < lines.length; i++) {
      for (const [what, edit] of edits) {
        const copy = [...lines];
        const line = JSON.parse(copy[i] ?? "") as Line;
        edit(line);
        copy[i] = JSON.stringify(line);
        const result = verifySessionText(`${copy.join("\n")}\n`);
        assert.equal(result.ok, false, `line ${i + 1} ${what}`);
        if (!result.ok) assert.equal(result.line, i + 1, `line ${i + 1} ${what}: first bad line`);
      }
      // A one-character edit inside the raw line text.
      const raw = [...lines];
      raw[i] = (raw[i] ?? "").replace(/"seq":(\d+)/, (_m, n) => `"seq":${Number(n) + 10}`);
      assert.equal(verifySessionText(`${raw.join("\n")}\n`).ok, false, `raw line ${i + 1}`);
    }
    // Re-hashing an edited middle line still breaks the next line's prevHash.
    const forged = JSON.parse(lines[1] ?? "") as Line;
    forged.payload.inputText = "forged";
    const { prevHash: _p, hash: _h, ...body } = forged;
    forged.hash = createHash("sha256")
      .update(`${forged.prevHash}\n${sortedKeyJson(body)}`)
      .digest("hex");
    const withForged = [...lines];
    withForged[1] = JSON.stringify(forged);
    const r = verifySessionText(`${withForged.join("\n")}\n`);
    assert.deepEqual(r.ok ? null : [r.line, r.reason], [
      3,
      "prevHash does not match the previous hash",
    ]);
    const dropped = lines.filter((_l, i) => i !== 2);
    const gap = verifySessionText(`${dropped.join("\n")}\n`);
    assert.deepEqual(gap.ok ? null : [gap.line, gap.reason], [3, "seq 3 where 2 expected"]);
    const swapped = [lines[0], lines[2], lines[1], lines[3]];
    const reordered = verifySessionText(`${swapped.join("\n")}\n`);
    assert.deepEqual(reordered.ok ? null : [reordered.line, reordered.reason], [
      2,
      "seq 2 where 1 expected",
    ]);
    assert.equal(verifySessionText(text.slice(0, -1)).ok, false, "unterminated last line");
    assert.equal(verifySessionText(`${text}{}\n`).ok, false, "junk line appended");
    assert.equal(verifySessionText(text, "thr_other").ok, false, "wrong thread");
  } finally {
    cleanup();
  }
});

test("honesty §6.5: thread/resume of a tampered session → -32603, lock released, file untouched", async () => {
  const { home, cleanup } = makeHome();
  const a = startEngine(home);
  try {
    await handshake(a);
    const { thread } = await a.request("thread/start", {});
    await runTurn(a, thread.id, "hello");
    await a.close();
    const path = sessionPath(home, thread.id);
    const tampered = readFileSync(path, "utf8").replace(
      '"inputText":"hello"',
      '"inputText":"HELLO"',
    );
    writeFileSync(path, tampered);
    const b = startEngineCapturingStderr(home);
    try {
      await handshake(b.client);
      const err = await expectRpcError(b.client.request("thread/resume", { threadId: thread.id }));
      assert.equal(err.code, -32603);
      assert.equal(existsSync(join(home, "sessions", `${thread.id}.lock`)), false);
      assert.equal(readFileSync(path, "utf8"), tampered, "nothing appended to a broken chain");
      const list = await b.client.request("thread/list", {});
      assert.deepEqual(list.data, [], "an unverifiable session is not listed");
      const report = inspectMadcHome(home);
      assert.deepEqual(report.lastSession?.chain, {
        ok: false,
        line: 2,
        reason: "hash mismatch",
      });
    } finally {
      await b.client.close();
    }
  } finally {
    await a.close();
    cleanup();
  }
});

test("honesty §6.6: a configured key and ghp_ token in tool output and agent text never reach the JSONL; chain verifies", async () => {
  const { home, cleanup } = makeHome();
  const hostile = `key=${KEY} token=${GHP} Bearer abcdefghijklmnop123 AKIAABCDEFGHIJKLMNOP`;
  const run = kimiEngine(home, {
    reply: { type: "stream", chunks: ["leak ", KEY, " and ", GHP], model: "kimi-for-coding" },
    toolOutput: hostile,
  });
  try {
    await handshake(run.client);
    const { thread } = await run.client.request("thread/start", {});
    const lockPath = join(home, "sessions", `${thread.id}.lock`);
    const token: string = JSON.parse(readFileSync(lockPath, "utf8")).token;
    const turn = await runTurn(run.client, thread.id, `user pasted ${GHP}`);
    assert.equal(turn.status, "completed");
    // The live stream carries what the agent/tool produced (sanity: the secrets were injected).
    const agentText = (turn.items.find((i) => i.kind === "agentMessage") as { text: string }).text;
    assert.ok(agentText.includes(KEY) && agentText.includes(GHP));
    const toolResult = turn.items.find((i) => i.kind === "toolResult") as { output: string };
    assert.equal(toolResult.output, hostile);

    const path = sessionPath(home, thread.id);
    const text = readFileSync(path, "utf8");
    for (const secret of [KEY, GHP, "abcdefghijklmnop123", "AKIAABCDEFGHIJKLMNOP", token]) {
      assert.equal(text.includes(secret), false, `secret persisted: ${secret.slice(0, 6)}…`);
    }
    const items = readLines(path)
      .filter((l) => l.type === "item")
      .map((l) => l.payload.item as Item);
    assert.equal(
      (items.find((i) => i.kind === "agentMessage") as { text: string }).text,
      `leak ${REDACTED} and ${REDACTED}`,
    );
    assert.equal(
      (items.find((i) => i.kind === "toolResult") as { output: string }).output,
      `key=${REDACTED} token=${REDACTED} ${REDACTED} ${REDACTED}`,
    );
    assert.equal(readLines(path)[1]?.payload.inputText, `user pasted ${REDACTED}`);
    assert.equal(verifySessionFile(path, thread.id).ok, true, "chain covers the redacted lines");
    independentVerify(path);
  } finally {
    await run.client.close();
    cleanup();
  }
});

test("redactor units: every pinned token shape and exact secrets (longest first), keys included", () => {
  const redact = createRedactor(["s3cret-value", "s3cret-value-longer", ""]);
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----";
  const input = {
    a: "x s3cret-value-longer y s3cret-value z",
    b: [`sk-${"a".repeat(20)}`, `gho_${"b".repeat(30)}`, `xoxb-${"1".repeat(12)}`],
    c: { nested: `AKIA${"Q".repeat(16)} Bearer ${"t".repeat(24)}`, pem },
    [`k-${GHP}`]: 1,
    n: 5,
    t: true,
    z: null,
  };
  assert.deepEqual(redact(input), {
    a: `x ${REDACTED} y ${REDACTED} z`,
    b: [REDACTED, REDACTED, REDACTED],
    c: { nested: `${REDACTED} ${REDACTED}`, pem: REDACTED },
    [`k-${REDACTED}`]: 1,
    n: 5,
    t: true,
    z: null,
  });
  assert.equal(redact("plain text sk-short madc-default"), "plain text sk-short madc-default");
});

test("§8.9 upgrade: session JSONL exists, verifies, and never contains the lock token (resume + re-lock)", async () => {
  const { home, cleanup } = makeHome();
  const a = startEngine(home);
  try {
    await handshake(a);
    const { thread } = await a.request("thread/start", {});
    const lockPath = join(home, "sessions", `${thread.id}.lock`);
    const tokens = [JSON.parse(readFileSync(lockPath, "utf8")).token as string];
    await runTurn(a, thread.id, "one");
    await a.close();
    const b = startEngine(home);
    try {
      await handshake(b);
      await b.request("thread/resume", { threadId: thread.id });
      tokens.push(JSON.parse(readFileSync(lockPath, "utf8")).token as string);
      await runTurn(b, thread.id, "two");
    } finally {
      await b.close();
    }
    const path = sessionPath(home, thread.id);
    const text = readFileSync(path, "utf8");
    assert.equal(readLines(path).filter((l) => l.type === "turn.end").length, 2);
    for (const token of tokens) {
      assert.match(token, /^[0-9a-f]{32}$/);
      assert.equal(text.includes(token), false);
    }
    assert.equal(verifySessionFile(path, thread.id).ok, true);
  } finally {
    await a.close();
    cleanup();
  }
});

test("A4 resume: a second engine cold-resumes from JSONL and continues the chain (no history replay)", async () => {
  const { home, cleanup } = makeHome();
  const wireLog = join(home, "..", "wire-resume.jsonl");
  const a = kimiEngine(home, { wireLog });
  try {
    await handshake(a.client);
    const { thread } = await a.client.request("thread/start", { cwd: "/w" });
    await runTurn(a.client, thread.id, "first question");
    await runTurn(a.client, thread.id, "second question");
    // Ruling item 12: turn context stays current-input-only in A4 (replay deferred to a pin).
    assert.deepEqual(wireMessages(a.wire()[1]), [{ role: "user", text: "second question" }]);
    await a.client.close();

    const b = kimiEngine(home, { wireLog });
    try {
      await handshake(b.client);
      // Listed from disk before it is resumed.
      const listed = await b.client.request("thread/list", {});
      assert.deepEqual(
        listed.data.map((t) => [t.id, t.seatId, t.preview, t.status]),
        [[thread.id, "madc-default", "first question", "idle"]],
      );
      const { thread: resumed } = await b.client.request("thread/resume", { threadId: thread.id });
      assert.deepEqual(
        { ...resumed, updatedAt: 0 },
        { ...thread, preview: "first question", updatedAt: 0 },
      );
      const started = await b.client.waitForNotification("thread/started");
      assert.equal(started.thread.id, thread.id);
      await runTurn(b.client, thread.id, "third question");
      assert.deepEqual(wireMessages(b.wire()[2]), [{ role: "user", text: "third question" }]);
      const path = sessionPath(home, thread.id);
      const lines = readLines(path);
      assert.deepEqual(
        lines.map((l) => l.seq),
        lines.map((_l, i) => i),
      );
      assert.equal(lines.filter((l) => l.type === "session.open").length, 1);
      assert.equal(lines.filter((l) => l.type === "turn.end").length, 3);
      assert.equal(verifySessionFile(path, thread.id).ok, true);
      independentVerify(path);
      // A turn id from the previous engine is known (finished): interrupt is a no-op.
      const oldTurnId = lines[1]?.payload.turnId as string;
      assert.deepEqual(
        await b.client.request("turn/interrupt", { threadId: thread.id, turnId: oldTurnId }),
        {},
      );
    } finally {
      await b.client.close();
    }
  } finally {
    await a.client.close();
    cleanup();
  }
});

test("A4: a failed turn is recorded with turn.end.error = {code, message} only; resume continues", async () => {
  const { home, cleanup } = makeHome();
  const wireLog = join(home, "..", "wire-fail.jsonl");
  const a = kimiEngine(home, { wireLog, reply: { type: "status", status: 500, body: "{}" } });
  try {
    await handshake(a.client);
    const { thread } = await a.client.request("thread/start", {});
    const failed = await runTurn(a.client, thread.id, "doomed");
    assert.equal(failed.status, "failed");
    await a.client.close();
    const lines = readLines(sessionPath(home, thread.id));
    assert.deepEqual(lines.at(-1)?.payload, {
      turnId: failed.id,
      status: "failed",
      error: { code: -32603, message: "kimi-code request failed (HTTP 500)" },
    });
    // Ruling item 6: no receipt for a failed invocation (neither item nor event).
    assert.equal(lines.filter((l) => l.type === "servedModel").length, 0);
    assert.ok(!lines.some((l) => (l.payload.item as Item | undefined)?.kind === "servedModel"));
    const b = kimiEngine(home, { wireLog });
    try {
      await handshake(b.client);
      await b.client.request("thread/resume", { threadId: thread.id });
      const retry = await runTurn(b.client, thread.id, "retry");
      assert.equal(retry.status, "completed");
      assert.equal(verifySessionFile(sessionPath(home, thread.id), thread.id).ok, true);
    } finally {
      await b.client.close();
    }
  } finally {
    await a.client.close();
    cleanup();
  }
});

test("A4 resume: an engine killed mid-turn leaves turn.start without turn.end; resume closes it as interrupted", async () => {
  if (!POSIX) return; // SIGKILL semantics
  const { home, cleanup } = makeHome();
  const a = startEngine(home, HANG_ENGINE);
  try {
    await handshake(a);
    const { thread } = await a.request("thread/start", {});
    await a.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "x" }] });
    await a.waitForNotification("item/completed");
    const path = sessionPath(home, thread.id);
    // item/completed is emitted before its append: wait for the durable line, then kill.
    const deadline = Date.now() + 3000;
    while (!readLines(path).some((l) => l.type === "item") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const killed = new Promise((r) => a.child.once("exit", r));
    a.child.kill("SIGKILL");
    await killed;
    const before = readLines(path);
    assert.equal(before.at(-1)?.type, "item");
    assert.equal(before.filter((l) => l.type === "turn.end").length, 0);

    const b = startEngine(home);
    try {
      await handshake(b);
      const { thread: resumed } = await b.request("thread/resume", { threadId: thread.id });
      const after = readLines(path);
      assert.deepEqual(after.at(-1)?.payload, {
        turnId: before[1]?.payload.turnId,
        status: "interrupted",
        error: null,
      });
      // The close that resume just appended is reflected in updatedAt (resume and list).
      assert.equal(resumed.updatedAt, after.at(-1)?.ts);
      const listed = await b.request("thread/list", {});
      assert.equal(listed.data[0]?.updatedAt, after.at(-1)?.ts);
      assert.equal(verifySessionFile(path, thread.id).ok, true);
    } finally {
      await b.close();
    }
  } finally {
    await a.close();
    cleanup();
  }
});

test("A4 resume: session file missing → -32002 and the probe lock is released", async () => {
  const { home, cleanup } = makeHome();
  const client = startEngine(home);
  try {
    await handshake(client);
    const err = await expectRpcError(client.request("thread/resume", { threadId: "thr_gone" }));
    assert.equal(err.code, -32002);
    assert.deepEqual(err.data, { threadId: "thr_gone" });
    assert.equal(existsSync(join(home, "sessions", "thr_gone.lock")), false);
  } finally {
    await client.close();
    cleanup();
  }
});

// ------------------------------------------------------------ -32009 paths

type Wire = Record<string, unknown> & { params?: Record<string, unknown> };

function inProcess(home: string, agent: Agent, newThreadId?: () => string) {
  const input = new PassThrough();
  const received: Wire[] = [];
  const output = new Writable({
    write(chunk, _enc, cb) {
      for (const line of String(chunk).split("\n"))
        if (line !== "") received.push(JSON.parse(line));
      cb();
    },
  });
  const conn = new EngineConnection({
    input,
    output,
    home,
    agent,
    log: () => {},
    ...(newThreadId === undefined ? {} : { newThreadId }),
  });
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

const replyAgent: Agent = {
  name: "reply",
  async run(_ctx, sink) {
    const id = sink.newItemId();
    sink.startItem({ id, kind: "agentMessage", status: "inProgress", text: "" });
    sink.completeItem({ id, kind: "agentMessage", status: "completed", text: "ok" });
  },
};

test("-32009 at thread/start: session file cannot be created → {threadId, path, seq: 0}; lock released", async () => {
  const { home, cleanup } = makeHome();
  const e = inProcess(home, replyAgent, () => "thr_fixed");
  try {
    await e.request("initialize", { clientInfo: { name: "t", version: "0" } });
    mkdirSync(join(home, "sessions", "thr_fixed.jsonl"), { recursive: true });
    const res = await e.request("thread/start", {});
    const error = res.error as { code: number; data: Record<string, unknown> };
    assert.equal(error.code, -32009);
    assert.deepEqual(error.data, {
      threadId: "thr_fixed",
      path: join(home, "sessions", "thr_fixed.jsonl"),
      seq: 0,
    });
    assert.equal(existsSync(join(home, "sessions", "thr_fixed.lock")), false);
    assert.ok(!e.received.some((m) => m.method === "thread/started"));
  } finally {
    e.input.end();
    await e.done;
    cleanup();
  }
});

test("-32009 mid-turn: an append failure ends the turn failed with -32009 and stops recording", async () => {
  const { home, cleanup } = makeHome();
  let calls = 0;
  const breaking: Agent = {
    name: "breaking",
    async run(ctx, sink) {
      calls++;
      const path = join(home, "sessions", `${ctx.threadId}.jsonl`);
      rmSync(path);
      mkdirSync(path); // appends now fail (EISDIR)
      const id = sink.newItemId();
      sink.startItem({ id, kind: "agentMessage", status: "inProgress", text: "" });
      sink.completeItem({ id, kind: "agentMessage", status: "completed", text: "lost" });
      // The turn failed on that append: the sink is closed, so nothing after it is streamed.
      const late = sink.newItemId();
      sink.startItem({ id: late, kind: "agentMessage", status: "inProgress", text: "" });
      sink.completeItem({ id: late, kind: "agentMessage", status: "completed", text: "late" });
    },
  };
  const e = inProcess(home, breaking);
  try {
    await e.request("initialize", { clientInfo: { name: "t", version: "0" } });
    const start = await e.request("thread/start", {});
    const threadId = (start.result as { thread: { id: string } }).thread.id;
    await e.request("turn/start", { threadId, input: [{ type: "text", text: "x" }] });
    const done = await e.waitFor((m) => m.method === "turn/completed");
    const turn = (done.params as { turn: Turn }).turn;
    assert.equal(turn.status, "failed");
    assert.equal(turn.error?.code, -32009);
    assert.deepEqual(turn.error?.data, {
      threadId,
      path: join(home, "sessions", `${threadId}.jsonl`),
      seq: 3,
    });
    assert.deepEqual(
      turn.items.map((i) => i.kind),
      ["userMessage", "agentMessage", "error"],
    );
    assert.ok(!JSON.stringify(e.received).includes('"late"'), "no item streamed after the failure");
    // The writer is broken: the next turn is refused with -32009 before it starts.
    const next = await e.request("turn/start", { threadId, input: [{ type: "text", text: "y" }] });
    assert.equal((next.error as { code: number }).code, -32009);
    assert.equal(calls, 1);
  } finally {
    e.input.end();
    await e.done;
    cleanup();
  }
});

test("item 8: turn.end.error on disk is {code, message} only, even when the protocol error has data", async () => {
  const { home, cleanup } = makeHome();
  const failing: Agent = {
    name: "failing-with-data",
    async run() {
      throw new RpcError(-32008, "Provider unavailable", {
        providerId: "claude-code",
        reason: "binary-missing",
      });
    },
  };
  const e = inProcess(home, failing);
  try {
    await e.request("initialize", { clientInfo: { name: "t", version: "0" } });
    const start = await e.request("thread/start", {});
    const threadId = (start.result as { thread: { id: string } }).thread.id;
    await e.request("turn/start", { threadId, input: [{ type: "text", text: "x" }] });
    const done = await e.waitFor((m) => m.method === "turn/completed");
    const turn = (done.params as { turn: Turn }).turn;
    assert.deepEqual(turn.error?.data, { providerId: "claude-code", reason: "binary-missing" });
    const end = readLines(sessionPath(home, threadId)).at(-1);
    assert.equal(end?.type, "turn.end");
    assert.deepEqual(end?.payload.error, { code: -32008, message: "Provider unavailable" });
  } finally {
    e.input.end();
    await e.done;
    cleanup();
  }
});

test("§6.8 A4 helper: inspectMadcHome reports seat id, last session path, and chain OK", async () => {
  const { home, cleanup } = makeHome();
  const client = startEngine(home);
  try {
    await handshake(client);
    const { thread: older } = await client.request("thread/start", {});
    await new Promise((r) => setTimeout(r, 20));
    const { thread } = await client.request("thread/start", {});
    await runTurn(client, thread.id, "hi");
    const report = inspectMadcHome(home);
    assert.deepEqual(report, {
      home,
      seat: { id: "madc-default", path: join(home, "seats", "madc-default.json"), ok: true },
      lastSession: {
        threadId: thread.id,
        path: sessionPath(home, thread.id),
        seatId: "madc-default",
        events: 5,
        chain: { ok: true },
      },
    });
    assert.notEqual(older.id, thread.id);
    // Read-only: it never creates anything in an empty home.
    const { home: empty, cleanup: cleanupEmpty } = makeHome();
    try {
      const r = inspectMadcHome(empty);
      assert.equal(r.lastSession, null);
      assert.equal(r.seat.ok, false);
      assert.equal(existsSync(empty), false);
    } finally {
      cleanupEmpty();
    }
  } finally {
    await client.close();
    cleanup();
  }
});

test("no-secrets guard: session payloads never copy env (a hermetic engine env value is absent)", async () => {
  const { home, cleanup } = makeHome();
  const run = kimiEngine(home);
  try {
    await handshake(run.client);
    const { thread } = await run.client.request("thread/start", {});
    await runTurn(run.client, thread.id, "x");
    const text = readFileSync(sessionPath(home, thread.id), "utf8");
    assert.equal(text.includes(KEY), false);
    assert.equal(text.includes("MADC_TEST_WIRE_LOG"), false);
    assert.equal(text.includes("kimi-fake.invalid"), false, "no request URL / headers");
    assert.equal(text.includes("user-agent"), false);
  } finally {
    await run.client.close();
    cleanup();
  }
});

// ------------------------------------------------------- Copilot review (PR #13) regressions

test("R-proto: a __proto__ payload key is canonicalized, hashed, and redacted as a key", () => {
  assert.equal(
    sortedKeyJson(JSON.parse('{"b":1,"__proto__":{"z":1,"a":2}}')),
    '{"__proto__":{"a":2,"z":1},"b":1}',
  );
  const redacted = createRedactor([])(JSON.parse('{"__proto__":"x"}')) as Record<string, unknown>;
  assert.equal(Object.hasOwn(redacted, "__proto__"), true);
  const { home, cleanup } = makeHome();
  try {
    mkdirSync(home, { recursive: true });
    const path = join(home, "thr_proto.jsonl");
    const w = SessionWriter.create(
      path,
      "thr_proto",
      "madc-default",
      { cwd: null, backing: "kimi-code", providerId: "kimi-code", pinnedModel: "m" },
      () => [],
    );
    w.append("turn.start", { turnId: "turn_1", inputText: "hi" });
    w.append("item", {
      turnId: "turn_1",
      item: {
        id: "item_1",
        kind: "toolCall",
        status: "completed",
        name: "t",
        arguments: JSON.parse('{"__proto__":"original"}'),
      },
    });
    const text = readFileSync(path, "utf8");
    assert.ok(text.includes('"__proto__":"original"'), "the key is persisted");
    assert.equal(verifySessionText(text).ok, true);
    const edited = text.replace('"__proto__":"original"', '"__proto__":"edited"');
    const r = verifySessionText(edited);
    assert.deepEqual(r.ok ? null : [r.line, r.reason], [3, "hash mismatch"]);
  } finally {
    cleanup();
  }
});

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

test("R-shape: a hash-valid line with a malformed M0 payload is never loaded and never breaks thread/list", async () => {
  const open = { cwd: null, backing: "kimi-code", providerId: "kimi-code", pinnedModel: "m" };
  const bad: Array<[string, Array<[string, Record<string, unknown>]>]> = [
    [
      "item-no-item",
      [
        ["session.open", open],
        ["turn.start", { turnId: "turn_1", inputText: "x" }],
        ["item", { turnId: "turn_1" }],
      ],
    ],
    [
      "user-no-content",
      [
        ["session.open", open],
        ["item", { turnId: "turn_1", item: { id: "i", kind: "userMessage" } }],
      ],
    ],
    ["open-no-cwd", [["session.open", { backing: "kimi-code" }]]],
    [
      "end-bad-status",
      [
        ["session.open", open],
        ["turn.end", { turnId: "turn_1", status: "done", error: null }],
      ],
    ],
    [
      "end-error-data",
      [
        ["session.open", open],
        ["turn.end", { turnId: "turn_1", status: "failed", error: { code: "x" } }],
      ],
    ],
    [
      "start-bad-turn",
      [
        ["session.open", open],
        ["turn.start", { turnId: "../x", inputText: "x" }],
      ],
    ],
    ...(
      [
        ["item-agent-no-text", { id: "i", kind: "agentMessage", status: "completed" }],
        ["item-unknown-kind", { id: "i", kind: "futureKind", status: "completed", text: "x" }],
        ["item-no-status", { id: "i", kind: "agentMessage", text: "x" }],
        [
          "item-tool-result-no-flag",
          { id: "i", kind: "toolResult", status: "completed", callId: "c", name: "t", output: "o" },
        ],
        ["item-tool-call-no-args", { id: "i", kind: "toolCall", status: "completed", name: "t" }],
        ["item-error-no-message", { id: "i", kind: "error", status: "completed" }],
        [
          "item-served-bad-backing",
          {
            id: "i",
            kind: "servedModel",
            status: "completed",
            requestedModel: "a",
            servedModel: "b",
            backing: "ollama-cloud",
            providerId: "p",
          },
        ],
        [
          "item-user-part-type",
          {
            id: "i",
            kind: "userMessage",
            status: "completed",
            content: [{ type: "image", text: "x" }],
          },
        ],
      ] as Array<[string, Record<string, unknown>]>
    ).map(([name, item]): [string, Array<[string, Record<string, unknown>]>] => [
      name,
      [
        ["session.open", open],
        ["item", { turnId: "turn_1", item }],
      ],
    ]),
  ];
  for (const [name, events] of bad) {
    // The chain itself is intact (the verifier checks envelope, seq and hashes only) ...
    const r = verifySessionText(forgeSession("thr_bad", events));
    assert.equal(r.ok, true, name);
    // ... but the M0 payload shape is checked before any state is rebuilt from it.
    assert.throws(
      () => rebuildSession(r.ok ? r.events : []),
      (err: Error) => /^line \d+: malformed /.test(err.message),
      name,
    );
  }
  const { home, cleanup } = makeHome();
  const e = inProcess(home, replyAgent);
  try {
    await e.request("initialize", { clientInfo: { name: "t", version: "0" } });
    mkdirSync(join(home, "sessions"), { recursive: true });
    writeFileSync(
      join(home, "sessions", "thr_bad.jsonl"),
      forgeSession("thr_bad", bad[0]?.[1] ?? []),
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

test("R-shape: every M0 item variant with its required fields rebuilds", () => {
  const open = { cwd: null, backing: "kimi-code", providerId: "kimi-code", pinnedModel: "m" };
  const items: Item[] = [
    { id: "i1", kind: "userMessage", status: "completed", content: [{ type: "text", text: "q" }] },
    { id: "i2", kind: "agentMessage", status: "completed", text: "a" },
    { id: "i3", kind: "toolCall", status: "completed", name: "t", arguments: null },
    {
      id: "i4",
      kind: "toolResult",
      status: "failed",
      callId: "i3",
      name: "t",
      output: "",
      isError: true,
    },
    { id: "i5", kind: "error", status: "completed", message: "m", code: -32603 },
    { id: "i6", kind: "error", status: "completed", message: "m" },
    {
      id: "i7",
      kind: "servedModel",
      status: "completed",
      requestedModel: "a",
      servedModel: "b",
      backing: "codex",
      providerId: "codex",
    },
  ];
  const r = verifySessionText(
    forgeSession("thr_items", [
      ["session.open", open],
      ["turn.start", { turnId: "turn_1", inputText: "q" }],
      ...items.map((item): [string, Record<string, unknown>] => [
        "item",
        { turnId: "turn_1", item },
      ]),
      ["turn.end", { turnId: "turn_1", status: "completed", error: null }],
    ]),
  );
  assert.equal(r.ok, true);
  const rebuilt = rebuildSession(r.ok ? r.events : []);
  assert.deepEqual(rebuilt.turns[0]?.items, items);
});

test("R-fifo: a session file swapped for a FIFO fails the append with -32009 (never blocks, never writes)", () => {
  if (!POSIX) return; // FIFOs
  const { home, cleanup } = makeHome();
  try {
    const path = writeSampleSession(home);
    const lines = readLines(path);
    const w = SessionWriter.resume(
      path,
      "thr_sample",
      "madc-default",
      4,
      lines[3]?.hash ?? "",
      () => [],
    );
    rmSync(path);
    execFileSync("mkfifo", [path]);
    // A reader is attached, so even a blocking open would succeed: the fstat check refuses it.
    const reader = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      assert.throws(
        () => w.append("turn.start", { turnId: "turn_2", inputText: "x" }),
        (err: RpcError) => err.code === -32009 && (err.data as { seq: number }).seq === 4,
      );
      const buf = Buffer.alloc(64);
      let got = 0;
      try {
        got = readSync(reader, buf, 0, 64, null);
      } catch {
        got = 0; // EAGAIN: nothing was written
      }
      assert.equal(got, 0, "nothing written into the FIFO");
    } finally {
      closeSync(reader);
    }
    assert.equal(w.broken, true);
    // No reader: the open itself must not block (O_NONBLOCK); run in a child with a timeout.
    const probe = join(import.meta.dirname, "testing", "fifo-append-probe.ts");
    const args =
      process.versions.bun !== undefined
        ? [probe, join(home, "probe")]
        : ["--disable-warning=ExperimentalWarning", probe, join(home, "probe")];
    const res = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 10_000 });
    assert.equal(res.signal, null, "the append blocked on a FIFO with no reader");
    assert.deepEqual(JSON.parse(readFileSync(join(home, "probe", "result.json"), "utf8")), {
      code: -32009,
      broken: true,
    });
  } finally {
    cleanup();
  }
});

test("R-symlink: a sessions/<id>.jsonl symlink to a valid chain outside MADC_HOME is never read", async () => {
  if (!POSIX) return; // symlink creation needs privileges on Windows
  const { home, cleanup } = makeHome();
  const outside = join(home, "..", "outside-sessions");
  const e = inProcess(home, replyAgent);
  try {
    await e.request("initialize", { clientInfo: { name: "t", version: "0" } });
    const target = writeSampleSession(outside);
    assert.equal(verifySessionFile(target, "thr_sample").ok, true, "the outside chain is valid");
    mkdirSync(join(home, "sessions"), { recursive: true });
    const link = join(home, "sessions", "thr_sample.jsonl");
    symlinkSync(target, link);
    assert.deepEqual(verifySessionFile(link, "thr_sample"), {
      ok: false,
      line: 0,
      reason: "session file is not a regular file",
    });
    const list = await e.request("thread/list", {});
    assert.deepEqual(list.result, { data: [], nextCursor: null });
    const resume = await e.request("thread/resume", { threadId: "thr_sample" });
    assert.equal((resume.error as { code: number }).code, -32603);
    assert.equal(existsSync(join(home, "sessions", "thr_sample.lock")), false, "lock released");
    assert.equal(inspectMadcHome(home).lastSession, null, "home report skips the link");
    // sessions/ itself symlinked outside: the home report ignores it.
    const { home: home2, cleanup: cleanup2 } = makeHome();
    try {
      mkdirSync(home2, { recursive: true });
      symlinkSync(outside, join(home2, "sessions"));
      assert.equal(inspectMadcHome(home2).lastSession, null);
    } finally {
      cleanup2();
    }
  } finally {
    e.input.end();
    await e.done;
    cleanup();
  }
});

test("R-terminal: a turn.end append failure is never acknowledged as completed (-32009 + error item)", async () => {
  const { home, cleanup } = makeHome();
  const breakAfterItems: Agent = {
    name: "break-after-items",
    async run(ctx, sink) {
      const id = sink.newItemId();
      sink.startItem({ id, kind: "agentMessage", status: "inProgress", text: "" });
      sink.completeItem({ id, kind: "agentMessage", status: "completed", text: "done" });
      const path = join(home, "sessions", `${ctx.threadId}.jsonl`);
      rmSync(path);
      mkdirSync(path); // only the terminal turn.end append fails (EISDIR)
    },
  };
  const e = inProcess(home, breakAfterItems);
  try {
    await e.request("initialize", { clientInfo: { name: "t", version: "0" } });
    const start = await e.request("thread/start", {});
    const threadId = (start.result as { thread: { id: string } }).thread.id;
    await e.request("turn/start", { threadId, input: [{ type: "text", text: "x" }] });
    const done = await e.waitFor((m) => m.method === "turn/completed");
    const turn = (done.params as { turn: Turn }).turn;
    assert.equal(turn.status, "failed");
    assert.equal(turn.error?.code, -32009);
    assert.deepEqual(
      turn.items.map((i) => i.kind),
      ["userMessage", "agentMessage", "error"],
    );
  } finally {
    e.input.end();
    await e.done;
    cleanup();
  }
});

test("forward compat: unknown event types and extra payload fields verify, list, resume, and the chain continues", async () => {
  const open = {
    cwd: null,
    backing: "kimi-code",
    providerId: "kimi-code",
    pinnedModel: "kimi-coding/kimi-for-coding",
    futureField: { nested: true },
  };
  const text = forgeSession("thr_future", [
    ["session.open", open],
    ["turn.start", { turnId: "turn_1", inputText: "hello", futureField: 1 }],
    [
      "item",
      {
        turnId: "turn_1",
        item: {
          id: "item_1",
          kind: "userMessage",
          status: "completed",
          content: [{ type: "text", text: "hello" }],
          futureField: true,
        },
      },
    ],
    ["future.event", { anything: ["goes"] }],
    ["turn.end", { turnId: "turn_1", status: "completed", error: null, futureField: "x" }],
  ]);
  const r = verifySessionText(text, "thr_future");
  assert.equal(r.ok, true);
  const { home, cleanup } = makeHome();
  const e = inProcess(home, replyAgent);
  try {
    await e.request("initialize", { clientInfo: { name: "t", version: "0" } });
    mkdirSync(join(home, "sessions"), { recursive: true });
    const path = join(home, "sessions", "thr_future.jsonl");
    writeFileSync(path, text);
    const list = await e.request("thread/list", {});
    assert.deepEqual(
      (list.result as { data: Array<{ id: string; preview: string }> }).data.map((t) => [
        t.id,
        t.preview,
      ]),
      [["thr_future", "hello"]],
    );
    const resume = await e.request("thread/resume", { threadId: "thr_future" });
    assert.equal(resume.error, undefined);
    await e.request("turn/start", { threadId: "thr_future", input: [{ type: "text", text: "y" }] });
    await e.waitFor((m) => m.method === "turn/completed");
    const lines = readLines(path);
    assert.equal(lines[3]?.type, "future.event", "unknown lines are kept, never rewritten");
    assert.equal(lines.at(-1)?.type, "turn.end");
    assert.equal(verifySessionFile(path, "thr_future").ok, true);
    independentVerify(path);
  } finally {
    e.input.end();
    await e.done;
    cleanup();
  }
});

// ------------------------------------------------------- Copilot re-review (PR #13) regressions

/** Write seam: the first write of a buffer containing `marker` lands half its bytes, then throws. */
function failHalfwayOn(marker: string): void {
  let armed = false;
  setSessionWriteForTests((fd, buf, off, len) => {
    if (!armed && buf.toString("utf8").includes(marker)) {
      armed = true;
      const half = Math.max(1, Math.floor(len / 2));
      writeSync(fd, buf, off, half);
      return half;
    }
    if (armed && buf.toString("utf8").includes(marker)) throw new Error("ENOSPC (test)");
    return writeSync(fd, buf, off, len);
  });
}

test("R-dual: the receipt pair is one append; a failed receipt append leaves neither line and is never completed", async () => {
  const { home, cleanup } = makeHome();
  const receiptAgent: Agent = {
    name: "receipt",
    async run(_ctx, sink) {
      const id = sink.newItemId();
      const receipt = {
        id,
        kind: "servedModel" as const,
        requestedModel: "kimi-coding/kimi-for-coding",
        servedModel: "kimi-for-coding",
        backing: "kimi-code" as const,
        providerId: "kimi-code",
      };
      sink.startItem({ ...receipt, status: "inProgress" });
      sink.completeItem({ ...receipt, status: "completed" });
    },
  };
  const e = inProcess(home, receiptAgent);
  try {
    await e.request("initialize", { clientInfo: { name: "t", version: "0" } });
    const start = await e.request("thread/start", {});
    const threadId = (start.result as { thread: { id: string } }).thread.id;
    failHalfwayOn('"type":"servedModel"');
    await e.request("turn/start", { threadId, input: [{ type: "text", text: "x" }] });
    const done = await e.waitFor((m) => m.method === "turn/completed");
    const turn = (done.params as { turn: Turn }).turn;
    assert.equal(turn.status, "failed");
    assert.equal(turn.error?.code, -32009);
    assert.deepEqual(turn.error?.data, {
      threadId,
      path: sessionPath(home, threadId),
      seq: 3,
    });
    // Never exposed as a completed receipt: closed as failed by the terminal transition.
    const completedReceipts = e.received.filter(
      (m) =>
        m.method === "item/completed" &&
        (m.params?.item as Item | undefined)?.kind === "servedModel" &&
        (m.params?.item as Item | undefined)?.status === "completed",
    );
    assert.deepEqual(completedReceipts, []);
    assert.deepEqual(
      turn.items.map((i) => `${i.kind}:${i.status}`),
      ["userMessage:completed", "servedModel:failed", "error:completed"],
    );
    // On disk: neither half of the pair (the half-written bytes were rolled back).
    const path = sessionPath(home, threadId);
    assert.deepEqual(
      readLines(path).map((l) => l.type),
      ["session.open", "turn.start", "item"],
    );
    assert.equal(verifySessionFile(path, threadId).ok, true);
  } finally {
    setSessionWriteForTests(null);
    e.input.end();
    await e.done;
    cleanup();
  }
});

test("appendAll: a failed write is rolled back to the previous size and breaks the writer", () => {
  const { home, cleanup } = makeHome();
  try {
    const path = writeSampleSession(home);
    const before = readFileSync(path, "utf8");
    const w = SessionWriter.resume(
      path,
      "thr_sample",
      "madc-default",
      4,
      readLines(path)[3]?.hash ?? "",
      () => [],
    );
    failHalfwayOn('"turn_2"');
    assert.throws(
      () =>
        w.appendAll([
          { type: "turn.start", payload: { turnId: "turn_2", inputText: "a" } },
          { type: "turn.end", payload: { turnId: "turn_2", status: "completed", error: null } },
        ]),
      (err: RpcError) => err.code === -32009 && (err.data as { seq: number }).seq === 4,
    );
    setSessionWriteForTests(null);
    assert.equal(readFileSync(path, "utf8"), before, "no torn or partial tail");
    assert.equal(w.broken, true);
    assert.throws(
      () => w.append("turn.start", { turnId: "turn_3", inputText: "b" }),
      (err: RpcError) => err.code === -32009,
    );
    assert.equal(readFileSync(path, "utf8"), before);
    // A successful batch: consecutive seqs, chained, one unit.
    const ok = SessionWriter.resume(
      path,
      "thr_sample",
      "madc-default",
      4,
      readLines(path)[3]?.hash ?? "",
      () => [],
    );
    const events = ok.appendAll([
      { type: "turn.start", payload: { turnId: "turn_2", inputText: "a" } },
      { type: "turn.end", payload: { turnId: "turn_2", status: "completed", error: null } },
    ]);
    assert.deepEqual(
      events.map((ev) => ev.seq),
      [4, 5],
    );
    assert.equal(events[1]?.prevHash, events[0]?.hash);
    assert.equal(ok.nextSeq, 6);
    assert.equal(verifySessionFile(path, "thr_sample").ok, true);
  } finally {
    setSessionWriteForTests(null);
    cleanup();
  }
});

test("R-nofollow fallback: without O_NOFOLLOW a symlink, or a swap to one after lstat, is never read", () => {
  if (!POSIX) return; // symlink creation needs privileges on Windows
  const { home, cleanup } = makeHome();
  const outside = join(home, "..", "outside-fallback");
  try {
    const target = writeSampleSession(outside);
    mkdirSync(join(home, "sessions"), { recursive: true });
    const path = join(home, "sessions", "thr_sample.jsonl");
    const notRegular = { ok: false, line: 0, reason: "session file is not a regular file" };
    // A plain regular file verifies through the fallback path.
    writeFileSync(path, readFileSync(target));
    assert.equal(verifySessionFile(path, "thr_sample", { noFollowFlag: false }).ok, true);
    // Swapped for a symlink between lstat and open: dev + inode differ, refused.
    assert.deepEqual(
      verifySessionFile(path, "thr_sample", {
        noFollowFlag: false,
        afterLstat: () => {
          rmSync(path);
          symlinkSync(target, path);
        },
      }),
      notRegular,
    );
    // A symlink already in place is refused before any open.
    assert.deepEqual(verifySessionFile(path, "thr_sample", { noFollowFlag: false }), notRegular);
    assert.equal(verifySessionFile(target, "thr_sample", { noFollowFlag: false }).ok, true);
  } finally {
    cleanup();
  }
});
