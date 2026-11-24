/**
 * M2-A5 (`PIN-madc-M2-seat-worktree.md` & `PIN-madc-M2-handoff-procedure-amendment-2.md`):
 * parallel seats in engine-created worktrees, handoff target worktree, occupied/non-git/confinement
 * refusals, dirty-tree never-remove posture, post-commit HEAD at close, doctor missing-worktree
 * warning, and `repoAllow` behavior inside a seat worktree.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import type { Agent } from "./agent.ts";
import { inspectSessionV2 } from "./handoff.ts";
import { resolveRepoIdentity } from "./policy/identity.ts";
import { loadRepoPolicy } from "./policy/store.ts";
import { validateSeat } from "./seat.ts";
import { EngineConnection } from "./server.ts";
import { verifySessionFile } from "./session-store.ts";
import { fixtureGitEnv } from "./testing/git-env.ts";
import { createSeatWorktree, removeSeatWorktree } from "./worktree.ts";

function makeTempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  chmodSync(dir, 0o700);
  return dir;
}

function makeHome(): { home: string; cleanup: () => void } {
  const home = makeTempDir("madc-m2a5-home-");
  mkdirSync(join(home, "seats"), { mode: 0o700 });
  mkdirSync(join(home, "sessions"), { mode: 0o700 });
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...fixtureGitEnv(),
      GIT_AUTHOR_NAME: "MADC Test",
      GIT_AUTHOR_EMAIL: "test@madc.invalid",
      GIT_COMMITTER_NAME: "MADC Test",
      GIT_COMMITTER_EMAIL: "test@madc.invalid",
    },
  }).trim();
}

function initRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-b", "main");
  git(dir, "remote", "add", "origin", "https://github.com/MADVenturesLLC/MADC.git");
  writeFileSync(join(dir, "README.md"), "# base\n");
  git(dir, "add", "README.md");
  git(dir, "commit", "-m", "init");
  return git(dir, "rev-parse", "HEAD");
}

function writeV2Seat(
  home: string,
  id: string,
  opts: { worktree?: boolean; targets?: string[] } = {},
): void {
  const seat = {
    id,
    version: 2,
    displayName: id,
    role: "builder",
    standingInstructions: "test seat",
    pinnedModel: "kimi-coding/kimi-for-coding",
    preferredBacking: "kimi-code",
    fallbacks: [],
    memory: { mode: "in-session" },
    tools: { deny: [] },
    policy: { headlessOk: true },
    handoffs:
      opts.targets && opts.targets.length > 0
        ? { enabled: true, targets: opts.targets }
        : { enabled: false, targets: [] },
    ...(opts.worktree === undefined ? {} : { worktree: opts.worktree }),
  };
  writeFileSync(join(home, "seats", `${id}.json`), JSON.stringify(seat, null, 2), { mode: 0o600 });
}

type Wire = Record<string, unknown>;

function startInProcess(home: string, newThreadId?: () => string) {
  const input = new PassThrough();
  const received: Wire[] = [];
  const output = new Writable({
    write(chunk, _enc, cb) {
      for (const line of String(chunk).split("\n")) {
        if (line !== "") received.push(JSON.parse(line));
      }
      cb();
    },
  });
  const replyAgent: Agent = {
    name: "reply",
    async run(_ctx, sink) {
      const id = sink.newItemId();
      sink.startItem({ id, kind: "agentMessage", status: "inProgress", text: "" });
      sink.completeItem({ id, kind: "agentMessage", status: "completed", text: "ok" });
    },
  };
  const conn = new EngineConnection({
    input,
    output,
    home,
    agent: replyAgent,
    log: () => {},
    ...(newThreadId === undefined ? {} : { newThreadId }),
  });
  const done = conn.run();
  let nextId = 1;
  const request = async (method: string, params: unknown = {}): Promise<Wire> => {
    const id = nextId++;
    input.write(`${JSON.stringify({ id, method, params })}\n`);
    const until = Date.now() + 3000;
    for (;;) {
      const hit = received.find((m) => m.id === id);
      if (hit !== undefined) return hit;
      if (Date.now() > until) throw new Error(`timed out waiting for ${method}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  const close = async () => {
    input.end();
    await done;
  };
  return { request, close };
}

test("M2-A5 seat schema: v2 accepts boolean worktree, rejects non-boolean; v1 rejects worktree", () => {
  const baseV2 = {
    id: "wt-seat",
    version: 2,
    displayName: "WT Seat",
    role: "builder",
    standingInstructions: "hi",
    pinnedModel: "kimi-coding/kimi-for-coding",
    preferredBacking: "kimi-code",
    fallbacks: [],
    memory: { mode: "in-session" },
    tools: { deny: [] },
    policy: { headlessOk: true },
    handoffs: { enabled: false, targets: [] },
  };
  const okTrue = validateSeat({ ...baseV2, worktree: true }, "wt-seat");
  assert.equal(okTrue.ok, true);
  if (okTrue.ok) assert.equal(okTrue.seat.worktree, true);

  const badType = validateSeat({ ...baseV2, worktree: "yes" }, "wt-seat");
  assert.equal(badType.ok, false);

  const baseV1 = {
    id: "v1-seat",
    version: 1,
    role: "builder",
    standingInstructions: "hi",
    pinnedModel: "kimi-coding/kimi-for-coding",
    preferredBacking: "kimi-code",
    memory: { mode: "in-session" },
    tools: { deny: [] },
    policy: { headlessOk: true },
    handoffs: { enabled: false, targets: [] },
    worktree: true,
  };
  const badV1 = validateSeat(baseV1, "v1-seat");
  assert.equal(badV1.ok, false);
});

test("M2-A5 parallel seats: two worktree-mode threads get distinct confined trees off one repo, post-commit HEAD at close, and doctor warns if removed", async () => {
  const { home, cleanup } = makeHome();
  const repo = makeTempDir("madc-m2a5-repo-");
  try {
    const baseHead = initRepo(repo);
    writeV2Seat(home, "seat-a", { worktree: true });
    writeV2Seat(home, "seat-b", { worktree: true });

    const eng = startInProcess(home);
    await eng.request("initialize", { clientInfo: { name: "t", version: "0" } });

    const r1 = await eng.request("thread/start", { seatId: "seat-a", cwd: repo });
    const r2 = await eng.request("thread/start", { seatId: "seat-b", cwd: repo });
    const t1 = (r1.result as { thread: { id: string; cwd: string } }).thread;
    const t2 = (r2.result as { thread: { id: string; cwd: string } }).thread;

    assert.equal(t1.cwd, join(home, "worktrees", t1.id));
    assert.equal(t2.cwd, join(home, "worktrees", t2.id));
    assert.notEqual(t1.cwd, t2.cwd);
    assert.notEqual(t1.cwd, repo);

    // Writing a file in t1 does not appear in t2 or in the primary repo.
    writeFileSync(join(t1.cwd, "only-a.txt"), "a\n");
    assert.equal(existsSync(join(t2.cwd, "only-a.txt")), false);
    assert.equal(existsSync(join(repo, "only-a.txt")), false);

    // Commit in t1 and close: session.close.worktree.head must equal the post-commit HEAD.
    git(t1.cwd, "add", "only-a.txt");
    git(t1.cwd, "commit", "-m", "seat-a commit");
    const newHead = git(t1.cwd, "rev-parse", "HEAD");
    assert.notEqual(newHead, baseHead);

    await eng.close();

    const v1 = verifySessionFile(join(home, "sessions", `${t1.id}.jsonl`), t1.id, {}, home);
    assert.equal(v1.ok, true);
    if (v1.ok) {
      const closeEv = v1.events.at(-1);
      assert.ok(closeEv);
      assert.equal(closeEv.type, "session.close");
      assert.equal((closeEv.payload as { worktree: { head: string } }).worktree.head, newHead);
      assert.deepEqual(inspectSessionV2(home, v1.events), []);
    }

    // Dirty tree is never removed; clean tree can be removed, after which doctor warns.
    writeFileSync(join(t2.cwd, "dirty.txt"), "dirty\n");
    const dirtyRes = removeSeatWorktree(home, t2.cwd);
    assert.equal(dirtyRes.ok, false);
    if (!dirtyRes.ok) {
      assert.equal(dirtyRes.reason, "dirty-worktree");
      assert.ok(dirtyRes.message.includes(t2.cwd));
    }
    assert.equal(existsSync(t2.cwd), true);

    rmSync(join(t2.cwd, "dirty.txt"));
    const cleanRes = removeSeatWorktree(home, t2.cwd);
    assert.equal(cleanRes.ok, true);

    const v2 = verifySessionFile(join(home, "sessions", `${t2.id}.jsonl`), t2.id, {}, home);
    assert.equal(v2.ok, true);
    if (v2.ok) {
      assert.deepEqual(
        inspectSessionV2(home, v2.events).map((f) => `${f.level} ${f.code}`),
        ["warn worktree-head-unreadable"],
      );
    }
  } finally {
    cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("M2-A5 handoff target in worktree mode opens in its own tree, not the source's", async () => {
  const { home, cleanup } = makeHome();
  const repo = makeTempDir("madc-m2a5-handoff-");
  try {
    initRepo(repo);
    writeV2Seat(home, "src-seat", { worktree: true, targets: ["dst-seat"] });
    writeV2Seat(home, "dst-seat", { worktree: true });

    const eng = startInProcess(home);
    await eng.request("initialize", { clientInfo: { name: "t", version: "0" } });
    const start = await eng.request("thread/start", { seatId: "src-seat", cwd: repo });
    const src = (start.result as { thread: { id: string; cwd: string } }).thread;

    const ho = await eng.request("thread/handoff", {
      threadId: src.id,
      targetSeatId: "dst-seat",
      brief: "take over",
      turnId: null,
    });
    const targetThreadId = (ho.result as { targetThreadId: string }).targetThreadId;
    await eng.close();

    const expectedTargetTree = join(home, "worktrees", targetThreadId);
    assert.equal(existsSync(expectedTargetTree), true);
    assert.notEqual(expectedTargetTree, src.cwd);

    const vTarget = verifySessionFile(
      join(home, "sessions", `${targetThreadId}.jsonl`),
      targetThreadId,
      {},
      home,
    );
    assert.equal(vTarget.ok, true);
    if (vTarget.ok) {
      const openPayload = vTarget.events[0]?.payload as {
        cwd: string;
        worktree: { topLevel: string };
      };
      assert.equal(openPayload.cwd, expectedTargetTree);
      assert.equal(openPayload.worktree.topLevel, expectedTargetTree);
    }
  } finally {
    cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("M2-A5 refusals: non-git cwd, occupied worktree path, and confined root escape refuse before any append", async () => {
  const { home, cleanup } = makeHome();
  const nonGit = makeTempDir("madc-m2a5-nongit-");
  const repo = makeTempDir("madc-m2a5-occ-");
  try {
    initRepo(repo);
    writeV2Seat(home, "wt-seat", { worktree: true });

    let nextId = "thr_first";
    const eng = startInProcess(home, () => nextId);
    await eng.request("initialize", { clientInfo: { name: "t", version: "0" } });

    // Non-git cwd refuses -32602 and writes no session file.
    const badNonGit = await eng.request("thread/start", { seatId: "wt-seat", cwd: nonGit });
    assert.equal((badNonGit.error as { code: number }).code, -32602);
    assert.equal(existsSync(join(home, "sessions", "thr_first.jsonl")), false);

    // Occupied worktree path refuses -32602 before any append.
    nextId = "thr_occupied";
    mkdirSync(join(home, "worktrees", "thr_occupied"), { recursive: true });
    const badOccupied = await eng.request("thread/start", { seatId: "wt-seat", cwd: repo });
    assert.equal((badOccupied.error as { code: number }).code, -32602);
    assert.equal(existsSync(join(home, "sessions", "thr_occupied.jsonl")), false);

    // Escape outside confined root refuses.
    const escapeRes = createSeatWorktree(home, "../escape", repo);
    assert.equal(escapeRes.ok, false);

    await eng.close();
  } finally {
    cleanup();
    rmSync(nonGit, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("M2-A5 repoAllow inside a seat worktree: remote-pinned allows, path-pinned primary topLevel denies repo-not-allowed", () => {
  const { home, cleanup } = makeHome();
  const repo = makeTempDir("madc-m2a5-repoallow-");
  try {
    initRepo(repo);
    const created = createSeatWorktree(home, "thr_repoallow", repo);
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const wtRes = resolveRepoIdentity(created.path);
    assert.equal(wtRes.ok, true);
    if (!wtRes.ok) return;
    assert.equal(wtRes.identity.topLevel, created.path);
    assert.equal(wtRes.identity.remote, "github.com/MADVenturesLLC/MADC");

    writeFileSync(
      join(home, "policy.json"),
      JSON.stringify({
        version: 1,
        repoAllow: { "deepseek-payg": ["github.com/MADVenturesLLC/MADC"] },
      }),
      { mode: 0o600 },
    );
    const remotePolicy = loadRepoPolicy(home);
    assert.deepEqual(remotePolicy.fileIssues, []);
    assert.deepEqual(remotePolicy.rejected, []);
    assert.equal(remotePolicy.policy.decide("deepseek-payg", wtRes).decision, "allow");

    writeFileSync(
      join(home, "policy.json"),
      JSON.stringify({
        version: 1,
        repoAllow: {
          "deepseek-payg": [{ remote: "github.com/MADVenturesLLC/MADC", path: repo }],
        },
      }),
      { mode: 0o600 },
    );
    const pathPolicy = loadRepoPolicy(home);
    assert.deepEqual(pathPolicy.fileIssues, []);
    assert.deepEqual(pathPolicy.rejected, []);
    const denied = pathPolicy.policy.decide("deepseek-payg", wtRes);
    assert.equal(denied.decision, "deny");
    assert.equal(denied.reason, "repo-not-allowed");
  } finally {
    cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});
