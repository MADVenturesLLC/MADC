/**
 * M1-A4 repo-policy gate, end to end through the real `EngineConnection` (plan §7 M1-A4: "DeepSeek
 * denied unless the thread's repo is allowlisted (D-M1-8), giving `-32007 repo-not-allowed`";
 * normative text is M1 seat pin §5 and M1 protocol pin §4.2).
 *
 * Network-free and credential-free: the fixture agent never calls a provider, the repositories are
 * real temporary git checkouts, and every assertion is about the RESPONSE ERROR and the durable
 * `repo.decision` receipt. The M1-A9 cases at the end are the one exception: they run the real
 * DeepSeek adapter on its in-process fake transport (a `.invalid` host, a synthetic key) behind the
 * same gate, so an allowed turn is actually served and a denied one provably never reaches the wire.
 *
 * What this file proves that `policy/policy.test.ts` (the pure matrix) cannot:
 * - the gate runs INSIDE `turn/start`, before the agent's preflight and before any provider call, so
 *   a clean install denies with `-32007 repo-not-allowed` even though no DeepSeek credential exists
 *   anywhere (D-M1-8 must be observable, not masked by `-32008 no-credentials`);
 * - the decision is durable as the pinned `repo.decision` event, allow and deny alike;
 * - a NON-repo-gated backing writes no `repo.decision` at all (the file is ignored);
 * - the caller-supplied `cwd` string is never matched against an allowlist.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import {
  createDeepseekPort,
  ProviderCallError,
  type ProviderPort,
  resolveDeepseekPinnedModel,
  resolveKimiPinnedModel,
} from "@madc/adapters";
import { createFakeDeepSeekTransport } from "@madc/adapters/testing";
import type { Agent, AgentTurnContext, TurnSink } from "./agent.ts";
import { loadRepoPolicy, POLICY_FILE_NAME } from "./policy/store.ts";
import { ErrorCode, RpcError } from "./protocol/errors.ts";
import type { Item } from "./protocol/types.ts";
import { createProviderAgent, type DirectLane } from "./provider-agent.ts";
import { type EngineSeat, MADC_DEFAULT_SEAT } from "./seat.ts";
import { EngineConnection } from "./server.ts";
import {
  type RepoDecisionPayload,
  rebuildSession,
  type SessionEvent,
  verifySessionFile,
} from "./session-store.ts";
import { makeHome, seatFileBody, writeSeatFile } from "./testing/harness.ts";

const POSIX = process.platform !== "win32";
const DEEPSEEK = "deepseek-payg";
const ALLOWED_REMOTE = "github.com/owner/repo";

// --------------------------------------------------------------------- fixtures

function makeRoot(): string {
  return mkdtempSync(join(realpathSync(tmpdir()), "madc-a4-gate-"));
}

/**
 * `git init` with the target path passed EXPLICITLY rather than through the child's `cwd`, and one
 * bounded retry. Under the full parallel suite `git init` has been observed to exit 0 without
 * producing `.git`; the retry absorbs that transient, and a persistent failure still fails loudly
 * with diagnostics. That matters beyond test hygiene: the `git config` that follows would otherwise
 * resolve into whatever repository git could find instead, which is how a fixture value ended up
 * written into this repository's own shared config during this act.
 */
function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  for (let attempt = 1; ; attempt += 1) {
    execFileSync("git", ["init", "--quiet", "--", dir], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (existsSync(join(dir, ".git"))) return;
    if (attempt >= 2) {
      let gitDir = "(git rev-parse --absolute-git-dir failed)";
      try {
        gitDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"], {
          cwd: dir,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }).trim();
      } catch {
        // An unusable git-dir is itself part of the finding.
      }
      assert.fail(
        [
          `git init created no repository at ${dir} after ${attempt} attempts`,
          `git-dir resolves to: ${gitDir}`,
          `dir listing: ${JSON.stringify(readdirSync(dir))}`,
          `GIT_DIR=${process.env.GIT_DIR ?? "(unset)"}`,
          `GIT_WORK_TREE=${process.env.GIT_WORK_TREE ?? "(unset)"}`,
        ].join("\n"),
      );
    }
  }
}

/** A real git checkout with one `origin`. Returns its realpath'd top-level. */
function makeRepo(parent: string, name: string, originUrl: string): string {
  const dir = join(parent, name);
  initRepo(dir);
  execFileSync("git", ["config", "--local", "--replace-all", "remote.origin.url", originUrl], {
    cwd: dir,
    stdio: ["ignore", "ignore", "pipe"],
  });
  return realpathSync(dir);
}

function writePolicy(home: string, repoAllow: Record<string, unknown>): void {
  // `makeHome` only names the directory; the engine creates it at `run()`, but the policy has to
  // exist before the connection is constructed (that is where production loads it, in `main.ts`).
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(home, POLICY_FILE_NAME),
    `${JSON.stringify({ version: 1, repoAllow }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

function deepseekSeat(id: string): Record<string, unknown> {
  return seatFileBody({
    ...MADC_DEFAULT_SEAT,
    id,
    preferredBacking: DEEPSEEK,
    pinnedModel: "deepseek/deepseek-flash",
  });
}

type Wire = Record<string, unknown> & { params?: Record<string, unknown> };

/**
 * An in-process engine over PassThrough streams. `preflightCalls` records every backing the agent's
 * preflight saw, which is how these tests prove the gate ran BEFORE preflight (protocol pin §4.2) —
 * a denied turn must never reach the agent at all.
 */
function startEngine(
  home: string,
  agent: Agent,
): {
  request(method: string, params?: unknown): Promise<Wire>;
  notify(method: string, params?: unknown): void;
  close(): Promise<void>;
} {
  const input = new PassThrough();
  const received: Wire[] = [];
  const output = new Writable({
    write(chunk, _enc, cb) {
      for (const line of String(chunk).split("\n")) {
        if (line !== "") received.push(JSON.parse(line) as Wire);
      }
      cb();
    },
  });
  const conn = new EngineConnection({
    input,
    output,
    home,
    agent,
    // The production wiring loads this from `$MADC_HOME/policy.json` in `main.ts`; the test loads the
    // same file the same way so the decision path under test is the real one.
    repoPolicy: loadRepoPolicy(home).policy,
    log: () => {},
  });
  const done = conn.run();
  let nextId = 1;
  const waitFor = async (pred: (m: Wire) => boolean): Promise<Wire> => {
    const until = Date.now() + 5_000;
    for (;;) {
      const hit = received.find(pred);
      if (hit !== undefined) return hit;
      if (Date.now() > until) throw new Error("timed out waiting for a wire message");
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  return {
    async request(method, params = {}) {
      const id = nextId++;
      input.write(`${JSON.stringify({ id, method, params })}\n`);
      return waitFor((m) => m.id === id);
    },
    notify(method, params = {}) {
      // A notification carries no `id` and gets no reply (protocol pin §1).
      input.write(`${JSON.stringify({ method, params })}\n`);
    },
    async close() {
      input.end();
      await done;
    },
  };
}

function recordingAgent(preflightCalls: string[]): Agent {
  return {
    name: "repo-gate-fake",
    preflight(ctx) {
      preflightCalls.push(ctx.seat.preferredBacking);
    },
    async run() {
      // Emits nothing: these tests assert the gate, not the turn's items.
    },
  };
}

/** Every `repo.decision` event in the thread's session JSONL, in write order. */
function repoDecisions(home: string, threadId: string): RepoDecisionPayload[] {
  const path = join(home, "sessions", `${threadId}.jsonl`);
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as SessionEvent)
    .filter((event) => event.type === "repo.decision")
    .map((event) => event.payload as RepoDecisionPayload);
}

function sessionEventTypes(home: string, threadId: string): string[] {
  const path = join(home, "sessions", `${threadId}.jsonl`);
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => (JSON.parse(line) as SessionEvent).type);
}

async function handshake(e: ReturnType<typeof startEngine>): Promise<void> {
  const init = await e.request("initialize", {
    clientInfo: { name: "madc-a4-test", version: "0.0.0" },
  });
  assert.equal(init.error, undefined, `initialize failed: ${JSON.stringify(init.error)}`);
  e.notify("initialized", {});
}

async function startThread(
  e: ReturnType<typeof startEngine>,
  seatId: string,
  cwd: string | null,
): Promise<string> {
  const reply = await e.request("thread/start", cwd === null ? { seatId } : { seatId, cwd });
  assert.equal(reply.error, undefined, `thread/start failed: ${JSON.stringify(reply.error)}`);
  const result = reply.result as { thread: { id: string } };
  return result.thread.id;
}

// ------------------------------------------------------------------------ tests

test("A4 gate: a clean install denies every repo with -32007 repo-not-allowed, before preflight", async (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { home, cleanup } = makeHome();
  t.after(cleanup);
  const repo = makeRepo(root, "clean-install", `https://${ALLOWED_REMOTE}.git`);
  // No policy.json at all — the D-M1-8 clean-install default.
  writeSeatFile(home, deepseekSeat("ds-clean"));

  const preflights: string[] = [];
  const e = startEngine(home, recordingAgent(preflights));
  try {
    await handshake(e);
    const threadId = await startThread(e, "ds-clean", repo);
    const reply = await e.request("turn/start", {
      threadId,
      input: [{ type: "text", text: "hello" }],
    });
    const error = reply.error as { code: number; data: Record<string, unknown> } | undefined;
    assert.ok(error, "turn/start must be refused");
    assert.equal(error.code, ErrorCode.ProviderDenied);
    assert.equal(error.data?.reason, "repo-not-allowed");
    assert.equal(error.data?.providerId, DEEPSEEK);
    // The gate runs before preflight, so the agent never saw this turn — and no provider was called.
    assert.deepEqual(preflights, []);
    // And the refusal is still durably recorded, with the identity the engine resolved itself.
    const decisions = repoDecisions(home, threadId);
    assert.equal(decisions.length, 1);
    assert.deepEqual(decisions[0], {
      turnId: decisions[0]?.turnId,
      providerId: DEEPSEEK,
      remote: ALLOWED_REMOTE,
      topLevel: repo,
      decision: "deny",
      reason: "repo-not-allowed",
    });
    assert.ok(typeof decisions[0]?.turnId === "string");
  } finally {
    await e.close();
  }
});

test("A4 gate: a denied turn leaves an orphan repo.decision that still verifies and resumes", async (t) => {
  // A refusal appends `repo.decision` with a turnId whose `turn.start` never exists — a session shape
  // M1-A4 introduces. `rebuildSession` must ignore it (no dangling turn, no failure) and the hash
  // chain must still verify, so a client can resume the thread after a repo denial.
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { home, cleanup } = makeHome();
  t.after(cleanup);
  const repo = makeRepo(root, "resume-after-deny", `https://${ALLOWED_REMOTE}.git`);
  writeSeatFile(home, deepseekSeat("ds-resume"));

  const preflights: string[] = [];
  const e = startEngine(home, recordingAgent(preflights));
  try {
    await handshake(e);
    const threadId = await startThread(e, "ds-resume", repo);
    const denied = await e.request("turn/start", {
      threadId,
      input: [{ type: "text", text: "hello" }],
    });
    assert.equal((denied.error as { code: number }).code, ErrorCode.ProviderDenied);

    const path = join(home, "sessions", `${threadId}.jsonl`);
    const types = sessionEventTypes(home, threadId);
    assert.ok(types.includes("repo.decision"), "the denial was recorded");
    assert.ok(!types.includes("turn.start"), "no turn was started");
    assert.ok(verifySessionFile(path, threadId, {}, home).ok, "the hash chain still verifies");

    const events = readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as SessionEvent);
    const rebuilt = rebuildSession(events);
    assert.deepEqual(rebuilt.turns, [], "an orphan repo.decision is not a turn");
    assert.deepEqual(rebuilt.danglingTurnIds, [], "and never a dangling turn");

    const resume = await e.request("thread/resume", { threadId });
    assert.equal(resume.error, undefined, `resume must succeed: ${JSON.stringify(resume.error)}`);
    const thread = (resume.result as { thread: { id: string } }).thread;
    assert.equal(thread.id, threadId);
  } finally {
    await e.close();
  }
});

test("A4 gate: an allowlisted repo passes the gate and the turn reaches preflight", async (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { home, cleanup } = makeHome();
  t.after(cleanup);
  const repo = makeRepo(root, "allowed", `git@github.com:owner/repo.git`);
  writePolicy(home, { [DEEPSEEK]: [ALLOWED_REMOTE] });
  writeSeatFile(home, deepseekSeat("ds-allowed"));

  const preflights: string[] = [];
  const e = startEngine(home, recordingAgent(preflights));
  try {
    await handshake(e);
    const threadId = await startThread(e, "ds-allowed", repo);
    const reply = await e.request("turn/start", {
      threadId,
      input: [{ type: "text", text: "hello" }],
    });
    // The gate allowed it; the fixture agent then has no DeepSeek lane, so the turn itself may fail
    // — this test is about the GATE, and the allow decision must be durably recorded.
    assert.equal(
      reply.error,
      undefined,
      `turn/start must not be refused: ${JSON.stringify(reply)}`,
    );
    assert.deepEqual(preflights, [DEEPSEEK], "preflight runs once, after the gate allowed");
    const decisions = repoDecisions(home, threadId);
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]?.decision, "allow");
    assert.equal(decisions[0]?.reason, "repo-allowed");
    assert.equal(decisions[0]?.remote, ALLOWED_REMOTE);
    assert.equal(decisions[0]?.topLevel, repo);
  } finally {
    await e.close();
  }
});

test("A4 gate: an unresolvable identity gives -32007 repo-identity-ambiguous", async (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { home, cleanup } = makeHome();
  t.after(cleanup);
  writePolicy(home, { [DEEPSEEK]: [ALLOWED_REMOTE] });
  writeSeatFile(home, deepseekSeat("ds-ambiguous"));
  const notGit = join(root, "not-a-repo");
  mkdirSync(notGit, { recursive: true });

  const preflights: string[] = [];
  const e = startEngine(home, recordingAgent(preflights));
  try {
    await handshake(e);
    const threadId = await startThread(e, "ds-ambiguous", notGit);
    const reply = await e.request("turn/start", {
      threadId,
      input: [{ type: "text", text: "hello" }],
    });
    const error = reply.error as { code: number; data: Record<string, unknown> } | undefined;
    assert.ok(error);
    assert.equal(error.code, ErrorCode.ProviderDenied);
    assert.equal(error.data?.reason, "repo-identity-ambiguous");
    assert.deepEqual(preflights, []);
    // Neither half of an unresolved identity is reported.
    const [decision] = repoDecisions(home, threadId);
    assert.equal(decision?.decision, "deny");
    assert.equal(decision?.reason, "repo-identity-ambiguous");
    assert.equal(decision?.remote, null);
    assert.equal(decision?.topLevel, null);
  } finally {
    await e.close();
  }
});

test("A4 gate: the caller-supplied cwd string is never matched against the allowlist", async (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { home, cleanup } = makeHome();
  t.after(cleanup);
  const repo = makeRepo(root, "string-match", `https://${ALLOWED_REMOTE}.git`);
  // An operator (or an attacker who can write policy.json) puts the PATH in the allowlist. It does
  // not normalize as a remote, so it is rejected at load and grants nothing — the repo's own remote
  // is still not listed, and the turn is still denied.
  writePolicy(home, { [DEEPSEEK]: [repo, ALLOWED_REMOTE.toUpperCase()] });
  writeSeatFile(home, deepseekSeat("ds-string"));

  const preflights: string[] = [];
  const e = startEngine(home, recordingAgent(preflights));
  try {
    await handshake(e);
    const threadId = await startThread(e, "ds-string", repo);
    const reply = await e.request("turn/start", {
      threadId,
      input: [{ type: "text", text: "hello" }],
    });
    const error = reply.error as { code: number; data: Record<string, unknown> } | undefined;
    assert.ok(error, "a path entry and a case-folded remote must not grant access");
    assert.equal(error.code, ErrorCode.ProviderDenied);
    assert.equal(error.data?.reason, "repo-not-allowed");
    assert.deepEqual(preflights, []);
  } finally {
    await e.close();
  }
});

test("A4 gate: a symlinked cwd is decided by its realpath'd identity, not the symlink path", async (t) => {
  if (!POSIX) return;
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { home, cleanup } = makeHome();
  t.after(cleanup);
  const repo = makeRepo(root, "symlink-target", `https://${ALLOWED_REMOTE}.git`);
  const link = join(root, "symlink-cwd");
  symlinkSync(repo, link);
  writePolicy(home, { [DEEPSEEK]: [ALLOWED_REMOTE] });
  writeSeatFile(home, deepseekSeat("ds-symlink"));

  const preflights: string[] = [];
  const e = startEngine(home, recordingAgent(preflights));
  try {
    await handshake(e);
    const threadId = await startThread(e, "ds-symlink", link);
    const reply = await e.request("turn/start", {
      threadId,
      input: [{ type: "text", text: "hello" }],
    });
    assert.equal(reply.error, undefined, JSON.stringify(reply.error));
    const [decision] = repoDecisions(home, threadId);
    assert.equal(decision?.decision, "allow");
    // The receipt names the realpath'd top-level, never the symlink the client supplied.
    assert.equal(decision?.topLevel, repo);
    assert.notEqual(decision?.topLevel, link);
  } finally {
    await e.close();
  }
});

test("A4 gate: a non-repo-gated backing writes no repo.decision and is never gated", async (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { home, cleanup } = makeHome();
  t.after(cleanup);
  // An EMPTY allowlist for a gated provider must not affect an ungated lane.
  writePolicy(home, { [DEEPSEEK]: [] });
  const notGit = join(root, "plain-dir");
  mkdirSync(notGit, { recursive: true });
  writeSeatFile(home, seatFileBody({ ...MADC_DEFAULT_SEAT, id: "kimi-seat" }));

  const preflights: string[] = [];
  const e = startEngine(home, recordingAgent(preflights));
  try {
    await handshake(e);
    // cwd is not even a git repository: an ungated lane never resolves an identity.
    const threadId = await startThread(e, "kimi-seat", notGit);
    const reply = await e.request("turn/start", {
      threadId,
      input: [{ type: "text", text: "hello" }],
    });
    assert.equal(reply.error, undefined, JSON.stringify(reply.error));
    assert.deepEqual(preflights, ["kimi-code"]);
    assert.deepEqual(repoDecisions(home, threadId), []);
    assert.ok(
      !sessionEventTypes(home, threadId).includes("repo.decision"),
      "an ungated lane must not write repo.decision",
    );
  } finally {
    await e.close();
  }
});

// ------------------------------------------------------- fallback-candidate gate
//
// The seat's ASSIGNED backing is gated inside `turn/start` (above). These cases cover the other half
// of "fallbacks never move into a repo-denied provider" (plan §6): a repo-gated CANDIDATE the walk
// reaches during a turn, decided by the agent and recorded through the sink.

type FakePort = { readonly port: ProviderPort; readonly calls: () => number };

/** A port whose every call raises the recorded quota signal, so the walk moves to a fallback. */
function quotaPort(providerId: string): FakePort {
  let calls = 0;
  return {
    calls: () => calls,
    port: {
      providerId,
      streamTurn: async () => {
        calls += 1;
        throw new ProviderCallError(
          "failed",
          429,
          `${providerId} request failed (HTTP 429)`,
          "quota-or-unreachable",
        );
      },
    },
  };
}

/** A port that would happily serve — so any call to it is a gate failure, not a provider failure. */
function servingPort(providerId: string): FakePort {
  let calls = 0;
  return {
    calls: () => calls,
    port: {
      providerId,
      streamTurn: async (request) => {
        calls += 1;
        request.onTextDelta("served");
        return {
          text: "served",
          requestedModelId: request.modelId,
          servedModel: request.modelId,
        };
      },
    },
  };
}

type Captured = { items: Item[]; repoDecisions: RepoDecisionPayload[] };

function captureSink(repoDecisionRecorded = true): TurnSink & { captured: Captured } {
  const captured: Captured = { items: [], repoDecisions: [] };
  let n = 0;
  return {
    captured,
    signal: new AbortController().signal,
    newItemId: () => {
      n += 1;
      return `item_${n}`;
    },
    startItem: () => {},
    delta: () => {},
    completeItem: (item) => {
      captured.items.push({ ...item, status: "completed" } as Item);
    },
    repoDecision: (payload) => {
      captured.repoDecisions.push(payload);
      return repoDecisionRecorded;
    },
  };
}

function lane(providerId: string, port: ProviderPort): DirectLane {
  return {
    providerId,
    credential: `sentinel-${providerId}`,
    createPort: () => port,
    resolvePinnedModel:
      providerId === DEEPSEEK ? resolveDeepseekPinnedModel : resolveKimiPinnedModel,
  };
}

function fallbackCtx(seat: EngineSeat, cwd: string | null): AgentTurnContext {
  return {
    threadId: "thr_rg",
    seatId: seat.id,
    seat,
    seatPath: join(tmpdir(), `${seat.id}.json`),
    input: [{ type: "text", text: "hi" }],
    cwd,
    turnId: "turn_rg",
  };
}

test("A4 gate: a fallback never moves into a repo-denied provider, and the decision is recorded", async (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { home, cleanup } = makeHome();
  t.after(cleanup);
  const repo = makeRepo(root, "fb-denied", `https://${ALLOWED_REMOTE}.git`);
  // Empty allowlist: the D-M1-8 default. kimi-code is not repo-gated, deepseek-payg is.
  writePolicy(home, { [DEEPSEEK]: [] });

  const kimi = quotaPort("kimi-code");
  const deepseek = servingPort(DEEPSEEK);
  const agent = createProviderAgent({
    directLanes: [lane("kimi-code", kimi.port), lane(DEEPSEEK, deepseek.port)],
    repoPolicy: loadRepoPolicy(home).policy,
  });
  // Both lanes are allowed-direct/payg, so the same-lane rule (D-M1-7) does NOT stop this fallback:
  // the repo gate is what must.
  const seat: EngineSeat = { ...MADC_DEFAULT_SEAT, fallbacks: [DEEPSEEK] };
  const sink = captureSink();

  const err = await agent.run(fallbackCtx(seat, repo), sink).then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err instanceof RpcError, "the primary's quota signal still fails the turn");
  assert.equal(err.code, ErrorCode.ProviderUnavailable);
  assert.equal(kimi.calls(), 1, "the primary was attempted");
  assert.equal(deepseek.calls(), 0, "a repo-denied candidate is never called");
  assert.deepEqual(sink.captured.repoDecisions, [
    {
      turnId: "turn_rg",
      providerId: DEEPSEEK,
      remote: ALLOWED_REMOTE,
      topLevel: repo,
      decision: "deny",
      reason: "repo-not-allowed",
    },
  ]);
});

test("A4 gate: an allowlisted repo lets the fallback past the repo gate", async (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { home, cleanup } = makeHome();
  t.after(cleanup);
  const repo = makeRepo(root, "fb-allowed", `https://${ALLOWED_REMOTE}.git`);
  writePolicy(home, { [DEEPSEEK]: [ALLOWED_REMOTE] });

  const kimi = quotaPort("kimi-code");
  const deepseek = servingPort(DEEPSEEK);
  const agent = createProviderAgent({
    directLanes: [lane("kimi-code", kimi.port), lane(DEEPSEEK, deepseek.port)],
    repoPolicy: loadRepoPolicy(home).policy,
  });
  const seat: EngineSeat = { ...MADC_DEFAULT_SEAT, fallbacks: [DEEPSEEK] };
  const sink = captureSink();

  await agent.run(fallbackCtx(seat, repo), sink).then(
    () => null,
    () => null,
  );
  assert.equal(sink.captured.repoDecisions.length, 1);
  assert.equal(sink.captured.repoDecisions[0]?.decision, "allow");
  assert.equal(sink.captured.repoDecisions[0]?.reason, "repo-allowed");
  // The repo gate allowed it, so whatever stopped the candidate next was NOT repo policy. A seat
  // carries ONE pinnedModel and this one is kimi-shaped, so `resolveDeepseekPinnedModel` refuses it
  // — the documented M1 constraint that a candidate whose lane cannot resolve the seat's pinnedModel
  // is not usable. Asserting the gate's own answer is the point of this case.
  assert.equal(deepseek.calls(), 0);
});

test("A4 gate: a repo decision that cannot be recorded stops the walk before any call", async (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { home, cleanup } = makeHome();
  t.after(cleanup);
  const repo = makeRepo(root, "fb-unrecordable", `https://${ALLOWED_REMOTE}.git`);
  // Allowlisted, so the gate would let the candidate through — but the receipt cannot be persisted.
  writePolicy(home, { [DEEPSEEK]: [ALLOWED_REMOTE] });

  const kimi = quotaPort("kimi-code");
  const deepseek = servingPort(DEEPSEEK);
  const agent = createProviderAgent({
    directLanes: [lane("kimi-code", kimi.port), lane(DEEPSEEK, deepseek.port)],
    repoPolicy: loadRepoPolicy(home).policy,
  });
  const seat: EngineSeat = { ...MADC_DEFAULT_SEAT, fallbacks: [DEEPSEEK] };
  const sink = captureSink(false);

  await agent.run(fallbackCtx(seat, repo), sink).then(
    () => null,
    () => null,
  );
  assert.equal(sink.captured.repoDecisions.length, 1, "the decision was offered to the sink");
  assert.equal(deepseek.calls(), 0, "an unrecorded decision never authorizes a call");
});

// ------------------------------------------- M1-A9: the real DeepSeek lane behind the gate
//
// Plan §2 B: "DeepSeek passing mock conformance against a test allowlist, and denying every repo
// on a clean install". The cases above prove the gate with a fixture agent that serves nothing;
// these two put the PRODUCTION provider agent with the REAL DeepSeek adapter (on its in-process
// fake transport, a `.invalid` host) behind the same in-process connection, so the allowed turn is
// actually served and receipted, and the denied one provably never reaches the wire.

/** The production agent with only the DeepSeek lane, on the fake transport. */
function deepseekAgent(fetch: typeof globalThis.fetch): Agent {
  return createProviderAgent({
    directLanes: [
      {
        providerId: DEEPSEEK,
        credential: "test-sentinel-key-a9-deepseek",
        createPort: (apiKey) =>
          createDeepseekPort({ apiKey, baseUrl: "https://deepseek-fake.invalid", fetch }),
        resolvePinnedModel: resolveDeepseekPinnedModel,
      },
    ],
  });
}

function sessionEvents(home: string, threadId: string): SessionEvent[] {
  return readFileSync(join(home, "sessions", `${threadId}.jsonl`), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as SessionEvent);
}

async function waitForTurnEnd(home: string, threadId: string): Promise<SessionEvent> {
  const until = Date.now() + 5_000;
  for (;;) {
    const end = sessionEvents(home, threadId).find((event) => event.type === "turn.end");
    if (end !== undefined) return end;
    if (Date.now() > until) throw new Error("timed out waiting for turn.end");
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("A9 L1 DeepSeek: an allowlisted repo is served end to end by the real lane, receipted and chained", async (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { home, cleanup } = makeHome();
  t.after(cleanup);
  const repo = makeRepo(root, "a9-allowed", `git@github.com:owner/repo.git`);
  // A TEST allowlist naming the temporary repo only; the shipped default stays empty (D-M1-8).
  writePolicy(home, { [DEEPSEEK]: [ALLOWED_REMOTE] });
  writeSeatFile(home, deepseekSeat("ds-a9"));
  const fake = createFakeDeepSeekTransport({
    reply: { type: "stream", chunks: ["served ", "by deepseek"], model: "deepseek-flash-0408" },
  });

  const e = startEngine(home, deepseekAgent(fake.fetch));
  try {
    await handshake(e);
    const threadId = await startThread(e, "ds-a9", repo);
    const reply = await e.request("turn/start", {
      threadId,
      input: [{ type: "text", text: "hello deepseek" }],
    });
    assert.equal(reply.error, undefined, JSON.stringify(reply.error));
    const end = await waitForTurnEnd(home, threadId);
    assert.deepEqual(end.payload, {
      turnId: (end.payload as { turnId: string }).turnId,
      status: "completed",
      error: null,
    });
    assert.equal(fake.requests.length, 1, "exactly one request reached the (fake) DeepSeek wire");

    const events = sessionEvents(home, threadId);
    const decision = events.find((event) => event.type === "repo.decision");
    assert.ok(decision, "the gate's decision is recorded");
    assert.equal((decision.payload as RepoDecisionPayload).decision, "allow");
    assert.ok(
      events.indexOf(decision) < events.findIndex((event) => event.type === "turn.start"),
      "the gate decided before the turn started",
    );
    const served = events.find((event) => event.type === "servedModel");
    assert.deepEqual(served?.payload, {
      turnId: (end.payload as { turnId: string }).turnId,
      requestedModel: "deepseek/deepseek-flash",
      servedModel: "deepseek-flash-0408",
      backing: DEEPSEEK,
      providerId: DEEPSEEK,
      lane: "allowed-direct",
      mode: "headless",
      fallbackFrom: null,
      vendorReported: true,
    });
    const path = join(home, "sessions", `${threadId}.jsonl`);
    assert.ok(verifySessionFile(path, threadId, {}, home).ok, "the hash chain verifies");
  } finally {
    await e.close();
  }
});

test("A9 L1 DeepSeek: on a clean install the real lane is refused before any request exists", async (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { home, cleanup } = makeHome();
  t.after(cleanup);
  const repo = makeRepo(root, "a9-clean", `https://${ALLOWED_REMOTE}.git`);
  // No policy.json: the clean-install default (D-M1-8). A credential IS present for the lane.
  writeSeatFile(home, deepseekSeat("ds-a9-clean"));
  const fake = createFakeDeepSeekTransport();

  const e = startEngine(home, deepseekAgent(fake.fetch));
  try {
    await handshake(e);
    const threadId = await startThread(e, "ds-a9-clean", repo);
    const reply = await e.request("turn/start", {
      threadId,
      input: [{ type: "text", text: "hello deepseek" }],
    });
    const error = reply.error as { code: number; data: Record<string, unknown> } | undefined;
    assert.equal(error?.code, ErrorCode.ProviderDenied);
    assert.equal(error?.data?.reason, "repo-not-allowed");
    assert.deepEqual(fake.requests, [], "nothing reached the wire");
    assert.ok(
      !sessionEvents(home, threadId).some((event) => event.type === "servedModel"),
      "no receipt for a refused turn",
    );
  } finally {
    await e.close();
  }
});
