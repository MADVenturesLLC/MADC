/**
 * M1-A5 acceptance, engine side (M1 plan §7 M1-A5; protocol pin §3.3 P3; seat pin §4.2 S4):
 * the mode claim, the engine-owned presence check, the two interactive-only plan lanes, and the
 * credential-class rule (Founder ruling 12). Mock transports, synthetic keys and fake terminals
 * only — no live provider, no network, no real credential, no real keychain.
 *
 * Most cases drive the real `EngineConnection` + the production provider agent in-process, with the
 * real MiniMax / Alibaba adapter ports on in-process fake transports and a FAKE terminal injected
 * through `EngineOptions.terminal` (a unit test cannot own a controlling terminal). The one case
 * that must not be faked — a client claiming `interactive` from a process with no controlling
 * terminal — spawns a real engine detached (`setsid`) with the REAL system terminal. The real
 * terminal code itself is covered under a real pseudo-terminal in `presence/terminal.test.ts`.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import {
  ALIBABA_CODING_PLAN_PROVIDER_ID,
  createAlibabaCodingPlanPort,
  createKimiCodePort,
  createMinimaxTokenPlanPort,
  createOllamaCloudPort,
  honestUserAgent,
  MINIMAX_TOKEN_PLAN_PROVIDER_ID,
  resolveAlibabaCodingPlanPinnedModel,
  resolveKimiPinnedModel,
  resolveMinimaxPinnedModel,
  resolveOllamaPinnedModel,
} from "@madc/adapters";
import {
  createFakeDeepSeekTransport,
  createFakeKimiTransport,
  createFakeOllamaTransport,
} from "@madc/adapters/testing";
import type { Agent, TurnPreflightContext } from "./agent.ts";
import { EngineClient, withoutUndefined } from "./client.ts";
import { createCredentialStore } from "./credentials/store.ts";
import { defaultAgentFactory } from "./main.ts";
import type { GitRunner, RepoIdentityDeps } from "./policy/identity.ts";
import {
  denyAllRepoPolicy,
  loadRepoPolicy,
  POLICY_FILE_NAME,
  type RepoPolicy,
} from "./policy/store.ts";
import type { TerminalFacts } from "./presence/policy.ts";
import type { PresenceTerminal } from "./presence/terminal.ts";
import { ErrorCode, RpcError } from "./protocol/errors.ts";
import type { Item, ServedModelItem } from "./protocol/types.ts";
import { createProviderAgent } from "./provider-agent.ts";
import { type EngineSeat, MADC_DEFAULT_SEAT } from "./seat.ts";
import { EngineConnection } from "./server.ts";
import {
  createRedactor,
  REDACTED,
  rebuildSession,
  type SessionEvent,
  verifySessionFile,
} from "./session-store.ts";
import {
  handshake as clientHandshake,
  hermeticEnv,
  INTERACTIVE_FAKE_ENGINE,
  makeHome,
  seatFileBody,
  writeSeatFile,
} from "./testing/harness.ts";
import { keychainEnv, writeKeychainShims } from "./testing/keychain-shim.ts";

const POSIX = process.platform !== "win32";

/** Synthetic keys of the right class for each lane; never real credentials. */
const MINIMAX_KEY = "sk-cp-synthetic-token-plan-key-a5-0001";
const ALIBABA_KEY = "sk-sp-synthetic-coding-plan-key-a5-0001";
const KIMI_KEY = "synthetic-kimi-lane-key-a5-0001";
const OLLAMA_KEY = "synthetic-ollama-lane-key-a5-0001";

const FAKE = {
  minimax: "https://minimax-fake.invalid/anthropic",
  alibaba: "https://alibaba-fake.invalid/v1",
  kimi: "https://kimi-fake.invalid/coding",
  ollama: "https://ollama-fake.invalid/v1",
  ollamaTags: "https://ollama-fake.invalid/api/tags",
} as const;

const TERMINAL: TerminalFacts = Object.freeze({ device: "16/18", session: null });

// ------------------------------------------------------------------------------------- fixtures

function makeFakes() {
  // The Anthropic Messages fake serves MiniMax (pi-ai `minimax` speaks anthropic-messages); the
  // OpenAI chat-completions fake serves the Alibaba Coding Plan (openai-completions).
  const minimax = createFakeKimiTransport({
    type: "stream",
    chunks: ["Hi", " from", " MiniMax"],
    model: "MiniMax-M3-0601",
  });
  const alibaba = createFakeDeepSeekTransport({
    reply: { type: "stream", chunks: ["Hi", " from", " Qwen"], model: "qwen3-coder-plus-0928" },
  });
  const kimi = createFakeKimiTransport();
  const ollama = createFakeOllamaTransport();
  return {
    minimax,
    alibaba,
    kimi,
    ollama,
    total: () =>
      minimax.requests.length +
      alibaba.requests.length +
      kimi.requests.length +
      ollama.requests.length,
  };
}
type Fakes = ReturnType<typeof makeFakes>;

/** The production provider agent with every lane these tests touch, on fake transports. */
function laneAgent(fakes: Fakes, repoPolicy: RepoPolicy = denyAllRepoPolicy()): Agent {
  return createProviderAgent({
    directLanes: [
      {
        providerId: MINIMAX_TOKEN_PLAN_PROVIDER_ID,
        credential: MINIMAX_KEY,
        createPort: (apiKey) =>
          createMinimaxTokenPlanPort({ apiKey, baseUrl: FAKE.minimax, fetch: fakes.minimax.fetch }),
        resolvePinnedModel: resolveMinimaxPinnedModel,
      },
      {
        providerId: ALIBABA_CODING_PLAN_PROVIDER_ID,
        credential: ALIBABA_KEY,
        createPort: (apiKey) =>
          createAlibabaCodingPlanPort({
            apiKey,
            baseUrl: FAKE.alibaba,
            fetch: fakes.alibaba.fetch,
          }),
        resolvePinnedModel: resolveAlibabaCodingPlanPinnedModel,
      },
      {
        providerId: "kimi-code",
        credential: KIMI_KEY,
        createPort: (apiKey) =>
          createKimiCodePort({
            apiKey,
            userAgent: honestUserAgent("0.0.0"),
            baseUrl: FAKE.kimi,
            fetch: fakes.kimi.fetch,
          }),
        resolvePinnedModel: resolveKimiPinnedModel,
      },
      {
        providerId: "ollama-cloud",
        credential: OLLAMA_KEY,
        createPort: (apiKey) =>
          createOllamaCloudPort({
            apiKey,
            baseUrl: FAKE.ollama,
            tagsUrl: FAKE.ollamaTags,
            fetch: fakes.ollama.fetch,
          }),
        resolvePinnedModel: resolveOllamaPinnedModel,
      },
    ],
    repoPolicy,
    log: () => {},
  });
}

type FakeTerminal = {
  readonly terminal: PresenceTerminal;
  /** Mutable between turns: `facts: null` models a lost terminal. */
  readonly state: { facts: TerminalFacts | null; answer: boolean | "hold" };
  readonly prompts: string[];
  probes(): number;
  aborted(): number;
  /** Answer the oldest held prompt (`answer: "hold"`), as a person at the terminal would. */
  release(answer: boolean): void;
};

function fakeTerminal(
  facts: TerminalFacts | null = TERMINAL,
  answer: boolean | "hold" = true,
  unsupported?: string,
) {
  const state = { facts, answer };
  const prompts: string[] = [];
  const held: Array<(answer: boolean) => void> = [];
  let probes = 0;
  let aborted = 0;
  const terminal: PresenceTerminal = {
    ...(unsupported === undefined ? {} : { unsupported }),
    probe: () => {
      probes += 1;
      return state.facts === null ? null : { ...state.facts };
    },
    confirm: (prompt, signal) => {
      prompts.push(prompt);
      if (state.answer !== "hold") return Promise.resolve(state.answer);
      return new Promise((resolve) => {
        held.push(resolve);
        signal.addEventListener(
          "abort",
          () => {
            aborted += 1;
            resolve(false);
          },
          { once: true },
        );
      });
    },
  };
  const fake: FakeTerminal = {
    terminal,
    state,
    prompts,
    probes: () => probes,
    aborted: () => aborted,
    release: (confirmed) => held.shift()?.(confirmed),
  };
  return fake;
}

type Wire = {
  id?: unknown;
  method?: string;
  params?: { turn?: { id: string; status: string; items: Item[]; error: unknown } };
  result?: { thread?: { id: string }; turn?: { id: string; status: string } };
  error?: { code: number; message: string; data?: Record<string, unknown> };
};

/** An in-process engine over PassThrough streams (the repo-gate test's pattern, plus a terminal). */
function startEngine(
  home: string,
  agent: Agent,
  terminal: PresenceTerminal,
  options: {
    repoPolicy?: RepoPolicy;
    repoIdentityDeps?: RepoIdentityDeps;
    log?: (line: string) => void;
  } = {},
) {
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
    terminal,
    log: options.log ?? (() => {}),
    ...(options.repoPolicy === undefined ? {} : { repoPolicy: options.repoPolicy }),
    ...(options.repoIdentityDeps === undefined
      ? {}
      : { repoIdentityDeps: options.repoIdentityDeps }),
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
  const send = (method: string, params: unknown): number => {
    const id = nextId++;
    input.write(`${JSON.stringify({ id, method, params })}\n`);
    return id;
  };
  return {
    received,
    done,
    send,
    reply: (id: number) => waitFor((m) => m.id === id),
    async request(method: string, params: unknown = {}): Promise<Wire> {
      const id = send(method, params);
      return waitFor((m) => m.id === id);
    },
    completed: (turnId: string) =>
      waitFor((m) => m.method === "turn/completed" && m.params?.turn?.id === turnId),
    async close() {
      input.end();
      await done;
    },
  };
}
type Engine = ReturnType<typeof startEngine>;

async function handshake(e: Engine): Promise<void> {
  const init = await e.request("initialize", {
    clientInfo: { name: "madc-a5-test", version: "0" },
  });
  assert.equal(init.error, undefined);
}

async function startThread(e: Engine, seatId: string, cwd?: string): Promise<string> {
  const reply = await e.request("thread/start", cwd === undefined ? { seatId } : { seatId, cwd });
  assert.equal(reply.error, undefined, `thread/start failed: ${JSON.stringify(reply.error)}`);
  const id = reply.result?.thread?.id;
  assert.ok(typeof id === "string");
  return id;
}

function turnParams(threadId: string, mode?: unknown): Record<string, unknown> {
  return {
    threadId,
    input: [{ type: "text", text: "hello" }],
    ...(mode === undefined ? {} : { mode }),
  };
}

/** A served turn: the start result, then its `turn/completed`. */
async function servedTurn(e: Engine, threadId: string, mode?: "interactive" | "headless") {
  const reply = await e.request("turn/start", turnParams(threadId, mode));
  assert.equal(reply.error, undefined, `turn/start refused: ${JSON.stringify(reply.error)}`);
  const turnId = reply.result?.turn?.id;
  assert.ok(typeof turnId === "string");
  const completed = await e.completed(turnId);
  const turn = completed.params?.turn;
  assert.ok(turn);
  return turn;
}

function events(home: string, threadId: string): SessionEvent[] {
  return readFileSync(join(home, "sessions", `${threadId}.jsonl`), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as SessionEvent);
}

function ofType(home: string, threadId: string, type: string): Array<Record<string, unknown>> {
  return events(home, threadId)
    .filter((e) => e.type === type)
    .map((e) => e.payload as Record<string, unknown>);
}

/** A v1 seat file on `backing`, `headlessOk: true` on purpose (it must never unlock anything). */
function seatBody(
  id: string,
  backing: string,
  pinnedModel: string,
  extra: Partial<EngineSeat> = {},
) {
  return seatFileBody({
    ...MADC_DEFAULT_SEAT,
    id,
    preferredBacking: backing,
    pinnedModel,
    memory: { mode: "in-session" },
    policy: { headlessOk: true },
    ...extra,
  });
}

const SEATS = {
  alibaba: () =>
    seatBody("coder", ALIBABA_CODING_PLAN_PROVIDER_ID, "alibaba-coding-plan/qwen3-coder-plus"),
  minimax: () => seatBody("mm", MINIMAX_TOKEN_PLAN_PROVIDER_ID, "minimax/MiniMax-M3"),
  ollama: () => seatBody("surface", "ollama-cloud", "ollama-cloud/gpt-oss-120b"),
} as const;

function withHome(t: { after(fn: () => void): void }): string {
  const { home, cleanup } = makeHome();
  t.after(cleanup);
  return home;
}

// -------------------------------------------------------------------------- headless refusals

test("A5: a headless turn on an interactive-only seat is -32007 interactive-only-headless before any network call", async (t) => {
  const home = withHome(t);
  writeSeatFile(home, SEATS.alibaba());
  writeSeatFile(home, SEATS.minimax());
  const fakes = makeFakes();
  const term = fakeTerminal();
  const e = startEngine(home, laneAgent(fakes), term.terminal);
  try {
    await handshake(e);
    for (const [seatId, providerId] of [
      ["coder", ALIBABA_CODING_PLAN_PROVIDER_ID],
      ["mm", MINIMAX_TOKEN_PLAN_PROVIDER_ID],
    ] as const) {
      const threadId = await startThread(e, seatId, "/work/repo");
      // Explicit headless, and the fixture with `mode` absent (P3: treated as headless).
      for (const mode of ["headless", undefined] as const) {
        const reply = await e.request("turn/start", turnParams(threadId, mode));
        assert.equal(reply.error?.code, ErrorCode.ProviderDenied, `${seatId} ${String(mode)}`);
        assert.deepEqual(reply.error?.data, {
          providerId,
          status: "interactive-only",
          reason: "interactive-only-headless",
        });
      }
      const types = events(home, threadId).map((ev) => ev.type);
      assert.ok(!types.includes("turn.start"), "a refused turn never starts");
      // The mode denial is not pre-empted by MiniMax's repo gate: no repo decision was taken.
      assert.ok(!types.includes("repo.decision"), `${seatId}: no repo.decision on a mode denial`);
    }
    // The seats carried headlessOk: true — it overrode nothing. No request, no terminal access.
    assert.equal(fakes.total(), 0, "no provider request of any kind");
    assert.equal(term.probes(), 0, "a headless claim never even opens the terminal");
    assert.deepEqual(term.prompts, []);
  } finally {
    await e.close();
  }
});

test("A5: a mode: interactive claim with no controlling terminal is refused before any network call", async (t) => {
  const home = withHome(t);
  writeSeatFile(home, SEATS.alibaba());
  writeSeatFile(home, SEATS.minimax());
  const fakes = makeFakes();
  const term = fakeTerminal(null);
  const e = startEngine(home, laneAgent(fakes), term.terminal);
  try {
    await handshake(e);
    for (const [seatId, providerId] of [
      ["coder", ALIBABA_CODING_PLAN_PROVIDER_ID],
      ["mm", MINIMAX_TOKEN_PLAN_PROVIDER_ID],
    ] as const) {
      const threadId = await startThread(e, seatId, "/work/repo");
      const reply = await e.request("turn/start", turnParams(threadId, "interactive"));
      assert.equal(reply.error?.code, ErrorCode.ProviderDenied);
      assert.deepEqual(reply.error?.data, {
        providerId,
        status: "interactive-only",
        reason: "interactive-only-headless",
      });
      assert.ok(!events(home, threadId).some((ev) => ev.type === "turn.start"));
    }
    assert.equal(fakes.total(), 0);
    assert.ok(term.probes() >= 2, "the engine checked its own terminal for each claim");
    assert.deepEqual(term.prompts, [], "nobody was asked: there is no terminal to ask on");
  } finally {
    await e.close();
  }
});

test("A5: an invalid mode claim is -32602 before anything else", async (t) => {
  const home = withHome(t);
  writeSeatFile(home, SEATS.alibaba());
  const fakes = makeFakes();
  const term = fakeTerminal();
  const e = startEngine(home, laneAgent(fakes), term.terminal);
  try {
    await handshake(e);
    const threadId = await startThread(e, "coder");
    for (const mode of ["yes", null, 1, "INTERACTIVE"]) {
      const reply = await e.request("turn/start", turnParams(threadId, mode));
      assert.equal(reply.error?.code, ErrorCode.InvalidParams, JSON.stringify(mode));
      assert.deepEqual(reply.error?.data, { issues: ['mode must be "interactive" or "headless"'] });
    }
    assert.equal(term.probes(), 0);
    assert.equal(fakes.total(), 0);
  } finally {
    await e.close();
  }
});

// ----------------------------------------------------------------------------- served turns

test("A5: an interactive turn succeeds against the mock; JSONL shows mode, presence and TTY facts", async (t) => {
  const home = withHome(t);
  writeSeatFile(home, SEATS.alibaba());
  const fakes = makeFakes();
  const term = fakeTerminal();
  const e = startEngine(home, laneAgent(fakes), term.terminal);
  try {
    await handshake(e);
    const threadId = await startThread(e, "coder");

    const first = await servedTurn(e, threadId, "interactive");
    assert.equal(first.status, "completed");
    assert.equal(term.prompts.length, 1, "the first gated turn asked for a keypress");
    assert.match(term.prompts[0] ?? "", /seat coder wants lane alibaba-coding-plan/);
    assert.ok(!(term.prompts[0] ?? "").includes("hello"), "the prompt never carries input text");
    const agentText = first.items.find((i) => i.kind === "agentMessage");
    assert.equal(agentText?.kind === "agentMessage" ? agentText.text : null, "Hi from Qwen");
    const receipt = first.items.find((i): i is ServedModelItem => i.kind === "servedModel");
    assert.deepEqual(receipt && { ...receipt, id: "x" }, {
      id: "x",
      kind: "servedModel",
      status: "completed",
      requestedModel: "alibaba-coding-plan/qwen3-coder-plus",
      servedModel: "qwen3-coder-plus-0928",
      backing: ALIBABA_CODING_PLAN_PROVIDER_ID,
      providerId: ALIBABA_CODING_PLAN_PROVIDER_ID,
      lane: "interactive-only",
      mode: "interactive",
      fallbackFrom: null,
      vendorReported: true,
    });
    // The wire: the Coding Plan chat endpoint (fake host), the plan key as Bearer, the id as-is.
    const request = fakes.alibaba.requests[0];
    assert.equal(request?.url, `${FAKE.alibaba}/chat/completions`);
    assert.equal(request?.headers.authorization, `Bearer ${ALIBABA_KEY}`);
    assert.equal(
      (JSON.parse(request?.body ?? "{}") as { model?: string }).model,
      "qwen3-coder-plus",
    );
    assert.ok(
      !("store" in (JSON.parse(request?.body ?? "{}") as object)),
      "no store field to DashScope",
    );

    const second = await servedTurn(e, threadId, "interactive");
    assert.equal(second.status, "completed");
    assert.equal(
      term.prompts.length,
      1,
      "the confirmation carries while the terminal is unchanged",
    );

    const starts = ofType(home, threadId, "turn.start");
    assert.deepEqual(starts, [
      {
        turnId: starts[0]?.turnId,
        inputText: "hello",
        mode: "interactive",
        presence: "verified",
        tty: { device: "16/18", session: null, confirmation: "keypress" },
      },
      {
        turnId: starts[1]?.turnId,
        inputText: "hello",
        mode: "interactive",
        presence: "verified",
        tty: { device: "16/18", session: null, confirmation: "carried" },
      },
    ]);
    const receipts = ofType(home, threadId, "servedModel");
    assert.equal(receipts.length, 2);
    for (const r of receipts) {
      assert.equal(r.mode, "interactive");
      assert.equal(r.lane, "interactive-only");
    }
    const path = join(home, "sessions", `${threadId}.jsonl`);
    const verified = verifySessionFile(path, threadId, {}, home);
    assert.ok(verified.ok, "the chain still verifies");
    if (verified.ok) assert.equal(rebuildSession(verified.events).turns.length, 2);
    // The key never reached the session record.
    assert.ok(!readFileSync(path, "utf8").includes(ALIBABA_KEY));
  } finally {
    await e.close();
  }
});

test("A5: a mode-absent fixture is headless on a lane that needs no presence; an interactive claim there is recorded, never probed", async (t) => {
  const home = withHome(t);
  const fakes = makeFakes();
  const term = fakeTerminal();
  const e = startEngine(home, laneAgent(fakes), term.terminal);
  try {
    await handshake(e);
    // The seeded madc-default seat (kimi-code, headless allowed).
    const threadId = await startThread(e, "madc-default");
    const headless = await servedTurn(e, threadId);
    const interactive = await servedTurn(e, threadId, "interactive");
    const modeOf = (turn: typeof headless) =>
      turn.items.find((i): i is ServedModelItem => i.kind === "servedModel")?.mode;
    assert.equal(modeOf(headless), "headless", "P3: absent mode is headless (fail-closed)");
    assert.equal(modeOf(interactive), "interactive");
    const starts = ofType(home, threadId, "turn.start");
    assert.deepEqual(
      starts.map(({ mode, presence, tty }) => ({ mode, presence, tty })),
      [
        { mode: "headless", presence: "absent", tty: undefined },
        { mode: "interactive", presence: "absent", tty: undefined },
      ],
    );
    assert.equal(term.probes(), 0, "a lane that serves headless anyway is never gated");
  } finally {
    await e.close();
  }
});

// ------------------------------------------------------------------ lost / changed / declined

test("A5: detach-after-confirm — a session that lost its terminal is refused on the very next gated turn", async (t) => {
  const home = withHome(t);
  writeSeatFile(home, SEATS.alibaba());
  const fakes = makeFakes();
  const term = fakeTerminal();
  const e = startEngine(home, laneAgent(fakes), term.terminal);
  try {
    await handshake(e);
    const threadId = await startThread(e, "coder");
    assert.equal((await servedTurn(e, threadId, "interactive")).status, "completed");
    assert.equal(fakes.alibaba.requests.length, 1);

    term.state.facts = null; // the terminal is gone (hang-up, detached, revoked)
    const refused = await e.request("turn/start", turnParams(threadId, "interactive"));
    assert.equal(refused.error?.code, ErrorCode.ProviderDenied);
    assert.equal(refused.error?.data?.reason, "interactive-only-headless");
    assert.equal(fakes.alibaba.requests.length, 1, "no request after the terminal was lost");

    term.state.facts = TERMINAL; // a live terminal again: the old confirmation is void
    assert.equal((await servedTurn(e, threadId, "interactive")).status, "completed");
    assert.equal(term.prompts.length, 2, "the next turn needed a fresh keypress");
    const starts = ofType(home, threadId, "turn.start");
    assert.equal(starts.length, 2, "the refused turn left no turn.start");
    const tty = starts[1]?.tty as { confirmation?: string } | undefined;
    assert.equal(tty?.confirmation, "keypress");
  } finally {
    await e.close();
  }
});

test("A5: a changed terminal (device or session id) voids the confirmation: refused, then a fresh keypress", async (t) => {
  const home = withHome(t);
  writeSeatFile(home, SEATS.alibaba());
  const fakes = makeFakes();
  const term = fakeTerminal({ device: "136/3", session: "4241" });
  const e = startEngine(home, laneAgent(fakes), term.terminal);
  try {
    await handshake(e);
    const threadId = await startThread(e, "coder");
    await servedTurn(e, threadId, "interactive");
    assert.equal(term.prompts.length, 1);
    // Each step changes ONE fact of the confirmed terminal: that turn is refused, and the next turn
    // on the (now unchanged) terminal needs a fresh keypress.
    for (const changed of [
      { device: "136/4", session: "4241" },
      { device: "136/4", session: "4242" },
    ]) {
      term.state.facts = changed;
      const prompts: number = term.prompts.length;
      const refused = await e.request("turn/start", turnParams(threadId, "interactive"));
      assert.equal(
        refused.error?.data?.reason,
        "interactive-only-headless",
        JSON.stringify(changed),
      );
      assert.equal(term.prompts.length, prompts, "a changed terminal is refused, not re-prompted");
      await servedTurn(e, threadId, "interactive");
      assert.equal(term.prompts.length, prompts + 1, "the next turn needed a fresh keypress");
    }
    assert.equal(
      fakes.alibaba.requests.length,
      3,
      "only the three confirmed turns reached the lane",
    );
  } finally {
    await e.close();
  }
});

test("A5: a declined keypress refuses the turn before any network call; the next turn asks again", async (t) => {
  const home = withHome(t);
  writeSeatFile(home, SEATS.alibaba());
  const fakes = makeFakes();
  const term = fakeTerminal(TERMINAL, false);
  const e = startEngine(home, laneAgent(fakes), term.terminal);
  try {
    await handshake(e);
    const threadId = await startThread(e, "coder");
    const refused = await e.request("turn/start", turnParams(threadId, "interactive"));
    assert.equal(refused.error?.code, ErrorCode.ProviderDenied);
    assert.equal(refused.error?.data?.reason, "interactive-only-headless");
    assert.equal(fakes.total(), 0);
    assert.ok(!events(home, threadId).some((ev) => ev.type === "turn.start"));
    term.state.answer = true;
    assert.equal((await servedTurn(e, threadId, "interactive")).status, "completed");
    assert.equal(term.prompts.length, 2);
  } finally {
    await e.close();
  }
});

test("A5: while a keypress is pending the thread takes no other turn/start, and EOF cancels the prompt", async (t) => {
  const home = withHome(t);
  writeSeatFile(home, SEATS.alibaba());
  const fakes = makeFakes();
  const term = fakeTerminal(TERMINAL, "hold");
  const e = startEngine(home, laneAgent(fakes), term.terminal);
  await handshake(e);
  const threadId = await startThread(e, "coder");
  const pendingId = e.send("turn/start", turnParams(threadId, "interactive"));
  const until = Date.now() + 5_000;
  while (term.prompts.length === 0 && Date.now() < until)
    await new Promise((r) => setTimeout(r, 5));
  assert.equal(term.prompts.length, 1, "the engine is waiting for the keypress");

  const second = await e.request("turn/start", turnParams(threadId, "interactive"));
  assert.equal(second.error?.code, ErrorCode.TurnAlreadyActive);
  assert.deepEqual(second.error?.data, { threadId, activeTurnId: null });

  await e.close(); // EOF on the protocol pipe
  assert.equal(term.aborted(), 1, "shutdown cancelled the pending prompt");
  assert.equal(
    e.received.find((m) => m.id === pendingId),
    undefined,
    "the cancelled turn/start is never answered as started",
  );
  assert.ok(!events(home, threadId).some((ev) => ev.type === "turn.start"));
  assert.equal(fakes.total(), 0);
});

test("A5 (Copilot r4145107307): confirmations are serialized engine-wide — one prompt on the terminal at a time, each answered for its own seat", async (t) => {
  const home = withHome(t);
  writeSeatFile(home, SEATS.alibaba());
  writeSeatFile(
    home,
    seatBody("coder2", ALIBABA_CODING_PLAN_PROVIDER_ID, "alibaba-coding-plan/qwen3-coder-plus"),
  );
  const fakes = makeFakes();
  const term = fakeTerminal(TERMINAL, "hold");
  const e = startEngine(home, laneAgent(fakes), term.terminal);
  try {
    await handshake(e);
    const first = await startThread(e, "coder");
    const second = await startThread(e, "coder2");
    const idA = e.send("turn/start", turnParams(first, "interactive"));
    const idB = e.send("turn/start", turnParams(second, "interactive"));
    const until = Date.now() + 5_000;
    while (term.prompts.length === 0 && Date.now() < until)
      await new Promise((r) => setTimeout(r, 5));
    // Let the second request reach the engine and wait in the queue.
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(term.prompts.length, 1, "the second thread's prompt waits for the first");
    assert.match(term.prompts[0] ?? "", /seat coder wants lane/);

    term.release(true); // the person answers the prompt on screen: thread one's
    const replyA = await e.reply(idA);
    assert.equal(replyA.error, undefined);
    while (term.prompts.length < 2 && Date.now() < until)
      await new Promise((r) => setTimeout(r, 5));
    assert.equal(term.prompts.length, 2, "only now is the second prompt shown");
    assert.match(term.prompts[1] ?? "", /seat coder2 wants lane/);

    term.release(false); // and refuses the second one
    const replyB = await e.reply(idB);
    assert.equal(replyB.error?.data?.reason, "interactive-only-headless");
    const turnA = replyA.result?.turn?.id;
    assert.ok(typeof turnA === "string");
    assert.equal((await e.completed(turnA)).params?.turn?.status, "completed");
    assert.equal(fakes.alibaba.requests.length, 1, "only the confirmed thread reached the lane");
  } finally {
    await e.close();
  }
});

test("A5 (Copilot r4145107223): on a platform without a presence check the refusal names the limitation", async (t) => {
  const home = withHome(t);
  writeSeatFile(home, SEATS.alibaba());
  const fakes = makeFakes();
  const reason = "the presence check is unsupported on win32 (M1 supports macOS and Linux)";
  const term = fakeTerminal(null, true, reason);
  const logs: string[] = [];
  const e = startEngine(home, laneAgent(fakes), term.terminal, { log: (line) => logs.push(line) });
  try {
    await handshake(e);
    const threadId = await startThread(e, "coder");
    const reply = await e.request("turn/start", turnParams(threadId, "interactive"));
    assert.equal(reply.error?.data?.reason, "interactive-only-headless");
    assert.ok(
      logs.includes(`presence alibaba-coding-plan: absent (${reason}); turn refused`),
      logs.join("\n"),
    );
    assert.deepEqual(term.prompts, []);
    assert.equal(fakes.total(), 0);
  } finally {
    await e.close();
  }
});

// --------------------------------------------------------------------- MiniMax repo gate (D-M1-9)

const ALLOWED_REMOTE = "github.com/owner/repo";
/** Injected `git`: the engine's repo identity comes from here, never from the cwd string. */
const runGit: GitRunner = (args) =>
  args[0] === "rev-parse"
    ? { code: 0, stdout: "/work/repo\n" }
    : { code: 0, stdout: `remote.origin.url https://${ALLOWED_REMOTE}.git\n` };
const repoIdentityDeps: RepoIdentityDeps = { runGit, realpath: (path) => path };

test("A5: MiniMax on a clean install is -32007 repo-not-allowed even with presence available — and nobody is prompted", async (t) => {
  const home = withHome(t);
  writeSeatFile(home, SEATS.minimax());
  const fakes = makeFakes();
  const term = fakeTerminal();
  const e = startEngine(home, laneAgent(fakes), term.terminal, { repoIdentityDeps });
  try {
    await handshake(e);
    const threadId = await startThread(e, "mm", "/work/repo");
    const reply = await e.request("turn/start", turnParams(threadId, "interactive"));
    assert.equal(reply.error?.code, ErrorCode.ProviderDenied);
    assert.deepEqual(reply.error?.data, {
      providerId: MINIMAX_TOKEN_PLAN_PROVIDER_ID,
      status: "interactive-only",
      reason: "repo-not-allowed",
    });
    assert.deepEqual(
      term.prompts,
      [],
      "a repo denial is answered before any keypress is asked for",
    );
    assert.equal(fakes.total(), 0);
    const decisions = ofType(home, threadId, "repo.decision");
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]?.decision, "deny");
    assert.equal(decisions[0]?.remote, ALLOWED_REMOTE);
  } finally {
    await e.close();
  }
});

test("A5: MiniMax with its repo allowlisted serves an attested interactive turn (same engine-owned identity as M1-A4)", async (t) => {
  const home = withHome(t);
  writeSeatFile(home, SEATS.minimax());
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(home, POLICY_FILE_NAME),
    `${JSON.stringify({ version: 1, repoAllow: { [MINIMAX_TOKEN_PLAN_PROVIDER_ID]: [ALLOWED_REMOTE] } })}\n`,
    { mode: 0o600 },
  );
  const repoPolicy = loadRepoPolicy(home).policy;
  const fakes = makeFakes();
  const term = fakeTerminal();
  const e = startEngine(home, laneAgent(fakes, repoPolicy), term.terminal, {
    repoPolicy,
    repoIdentityDeps,
  });
  try {
    await handshake(e);
    const threadId = await startThread(e, "mm", "/work/repo");
    const turn = await servedTurn(e, threadId, "interactive");
    assert.equal(turn.status, "completed");
    const receipt = turn.items.find((i): i is ServedModelItem => i.kind === "servedModel");
    assert.equal(receipt?.providerId, MINIMAX_TOKEN_PLAN_PROVIDER_ID);
    assert.equal(receipt?.lane, "interactive-only");
    assert.equal(receipt?.mode, "interactive");
    assert.equal(receipt?.servedModel, "MiniMax-M3-0601");
    const request = fakes.minimax.requests[0];
    // pi-ai's Anthropic SDK path adds `?beta=true`; the endpoint is origin + path.
    const url = new URL(request?.url ?? "about:blank");
    assert.equal(`${url.origin}${url.pathname}`, `${FAKE.minimax}/v1/messages`);
    assert.equal(request?.headers["x-api-key"], MINIMAX_KEY);
    const decisions = ofType(home, threadId, "repo.decision");
    assert.deepEqual(
      decisions.map(({ decision, reason }) => ({ decision, reason })),
      [{ decision: "allow", reason: decisions[0]?.reason }],
    );
    assert.equal(term.prompts.length, 1);
  } finally {
    await e.close();
  }
});

// ---------------------------------------------------------------- D-M1-3 lane, fallbacks (D-M1-7)

test("A5: ollama-cloud (headless denied, D-M1-3) needs verified presence too — the claim alone never unlocks it", async (t) => {
  const home = withHome(t);
  writeSeatFile(home, SEATS.ollama());
  const fakes = makeFakes();
  const term = fakeTerminal(null);
  const e = startEngine(home, laneAgent(fakes), term.terminal);
  try {
    await handshake(e);
    const threadId = await startThread(e, "surface");
    const refused = await e.request("turn/start", turnParams(threadId, "interactive"));
    assert.equal(refused.error?.code, ErrorCode.ProviderDenied);
    assert.deepEqual(refused.error?.data, {
      providerId: "ollama-cloud",
      status: "allowed-direct",
      reason: "headless-not-permitted",
    });
    assert.equal(fakes.total(), 0);

    term.state.facts = TERMINAL; // a person at a terminal: D-M1-4's interactive-only surface seat
    const turn = await servedTurn(e, threadId, "interactive");
    assert.equal(turn.status, "completed");
    const receipt = turn.items.find((i): i is ServedModelItem => i.kind === "servedModel");
    assert.equal(receipt?.lane, "allowed-direct");
    assert.equal(receipt?.mode, "interactive");
    assert.equal(term.prompts.length, 1);
  } finally {
    await e.close();
  }
});

test("A5: an interactive-only turn never falls back onto a pay-as-you-go lane (D-M1-7), and a denied one never reaches the walk", async (t) => {
  const home = withHome(t);
  writeSeatFile(
    home,
    seatBody("coder-fb", ALIBABA_CODING_PLAN_PROVIDER_ID, "alibaba-coding-plan/qwen3-coder-plus", {
      version: 2,
      displayName: "Coder with a PAYG fallback",
      fallbacks: ["kimi-code"],
    }),
  );
  const fakes = makeFakes();
  fakes.alibaba.queueReply({ type: "status", status: 429, body: '{"error":"rate"}' });
  const term = fakeTerminal();
  const e = startEngine(home, laneAgent(fakes), term.terminal);
  try {
    await handshake(e);
    const threadId = await startThread(e, "coder-fb");

    // A headless turn is refused as a response error: no turn, so no fallback walk at all.
    const headless = await e.request("turn/start", turnParams(threadId, "headless"));
    assert.equal(headless.error?.data?.reason, "interactive-only-headless");
    assert.deepEqual(ofType(home, threadId, "fallback.rejected"), []);

    // An attested interactive turn whose plan answers 429: the PAYG candidate is rejected by the
    // same-lane rule before any call, and the turn fails with the primary's error.
    const turn = await servedTurn(e, threadId, "interactive");
    assert.equal(turn.status, "failed");
    assert.deepEqual(turn.error, {
      code: ErrorCode.ProviderUnavailable,
      message: "Provider unavailable",
      data: { providerId: ALIBABA_CODING_PLAN_PROVIDER_ID, reason: "quota-or-unreachable" },
    });
    const rejected = ofType(home, threadId, "fallback.rejected");
    assert.deepEqual(rejected, [
      {
        turnId: turn.id,
        candidate: "kimi-code",
        assignedLane: { status: "interactive-only", credentialClass: "plan-interactive" },
        candidateLane: { status: "allowed-direct", credentialClass: "payg" },
        reason: "fallback-lane-mismatch",
      },
    ]);
    assert.equal(fakes.kimi.requests.length, 0, "the PAYG lane was never called");
    assert.deepEqual(ofType(home, threadId, "servedModel"), [], "nothing was served");
  } finally {
    await e.close();
  }
});

test("A5: a presence-gated fallback candidate is skipped when this turn's presence was never verified", async (t) => {
  const home = withHome(t);
  writeSeatFile(
    home,
    seatBody("kimi-fb", "kimi-code", "kimi-coding/kimi-for-coding", {
      version: 2,
      displayName: "Kimi with an Ollama fallback",
      fallbacks: ["ollama-cloud"],
    }),
  );
  const fakes = makeFakes();
  fakes.kimi.queueReply({ type: "status", status: 429, body: "{}" });
  const term = fakeTerminal();
  const e = startEngine(home, laneAgent(fakes), term.terminal);
  try {
    await handshake(e);
    const threadId = await startThread(e, "kimi-fb");
    // kimi-code needs no presence, so none is checked — and ollama-cloud (same lane, eligible on
    // the D-M1-7 axis) must then NOT serve on the bare claim.
    const turn = await servedTurn(e, threadId, "interactive");
    assert.equal(turn.status, "failed");
    assert.deepEqual((turn.error as { data?: unknown }).data, {
      providerId: "kimi-code",
      reason: "quota-or-unreachable",
    });
    assert.equal(fakes.ollama.requests.length, 0, "the headless-denied candidate never ran");
    assert.equal(term.probes(), 0);
  } finally {
    await e.close();
  }
});

// ------------------------------------------------------------- credential class (ruling 12)

async function withKeychain(
  accounts: Record<string, string>,
  fn: (
    env: Record<string, string>,
    store: ReturnType<typeof createCredentialStore>,
  ) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "madc-a5-keys-"));
  const saved: Record<string, string | undefined> = {};
  try {
    const shims = writeKeychainShims(join(root, "bin"));
    const dir = join(root, "accounts");
    mkdirSync(dir, { recursive: true });
    for (const [account, secret] of Object.entries(accounts)) {
      writeFileSync(join(dir, encodeURIComponent(account)), secret, { mode: 0o600 });
    }
    const env = keychainEnv(shims, dir, "darwin");
    for (const [name, value] of Object.entries(env)) {
      saved[name] = process.env[name];
      process.env[name] = value;
    }
    await fn(env, createCredentialStore({ env }));
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

function preflightCtx(seatId: string, backing: string, pinnedModel: string): TurnPreflightContext {
  return {
    threadId: "thr_a5ctx",
    seatId,
    seat: { ...MADC_DEFAULT_SEAT, id: seatId, preferredBacking: backing, pinnedModel },
    seatPath: `/seats/${seatId}.json`,
    input: [{ type: "text", text: "x" }],
    cwd: null,
    mode: "interactive",
    presence: "verified",
  };
}

function preflightError(agent: Agent, ctx: TurnPreflightContext): RpcError | null {
  try {
    agent.preflight?.(ctx);
    return null;
  } catch (err) {
    if (err instanceof RpcError) return err;
    throw err;
  }
}

async function captureStderr<T>(fn: () => Promise<T>): Promise<{ value: T; text: string }> {
  const original = process.stderr.write.bind(process.stderr);
  let text = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    text += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    return { value: await fn(), text };
  } finally {
    process.stderr.write = original;
  }
}

const ALIBABA_CTX = preflightCtx(
  "coder",
  ALIBABA_CODING_PLAN_PROVIDER_ID,
  "alibaba-coding-plan/qwen3-coder-plus",
);
const MINIMAX_CTX = preflightCtx("mm", MINIMAX_TOKEN_PLAN_PROVIDER_ID, "minimax/MiniMax-M3");

test("A5: a plan key is never readable through a PAYG id, and a PAYG key never through a plan id", async () => {
  const paygKey = "sk-paygsynthetic-model-studio-a5-0002";
  await withKeychain(
    { [MINIMAX_TOKEN_PLAN_PROVIDER_ID]: MINIMAX_KEY, "alibaba-model-studio-payg": paygKey },
    async (_env, store) => {
      // The store: one keychain account per registry id, so ids never share a credential.
      assert.equal(await store.get(MINIMAX_TOKEN_PLAN_PROVIDER_ID), MINIMAX_KEY);
      assert.equal(await store.get("minimax-payg"), null, "plan key not readable via the PAYG id");
      assert.equal(await store.status("minimax-payg"), false);
      assert.equal(await store.get("alibaba-model-studio-payg"), paygKey);
      assert.equal(
        await store.get(ALIBABA_CODING_PLAN_PROVIDER_ID),
        null,
        "PAYG key not via plan id",
      );

      // The production agent resolves each lane from its own id only.
      const agent = await defaultAgentFactory({ home: "/unused", repoPolicy: denyAllRepoPolicy() });
      assert.equal(preflightError(agent, MINIMAX_CTX), null, "the plan lane has its plan key");
      assert.deepEqual(preflightError(agent, ALIBABA_CTX)?.toBody().data, {
        providerId: ALIBABA_CODING_PLAN_PROVIDER_ID,
        reason: "no-credentials",
      });
      assert.ok(
        (agent.redactValues ?? []).includes(MINIMAX_KEY),
        "the redactor learns the plan key",
      );
      assert.ok(!(agent.redactValues ?? []).includes(paygKey), "an unwired PAYG id is never read");
    },
  );
});

test("A5: a key of the wrong class under the right plan id is refused at preflight (-32008), never sent, never echoed", async () => {
  const paygUnderPlan = "sk-paygshaped-under-the-plan-id-a5-0003";
  const notSubscription = "eyJpYXlnLXNoYXBlZCBrZXkgYTUtMDAwNA";
  await withKeychain(
    {
      [ALIBABA_CODING_PLAN_PROVIDER_ID]: paygUnderPlan,
      [MINIMAX_TOKEN_PLAN_PROVIDER_ID]: notSubscription,
    },
    async () => {
      const { value: agent, text } = await captureStderr(async () =>
        defaultAgentFactory({ home: "/unused", repoPolicy: denyAllRepoPolicy() }),
      );
      for (const [ctx, providerId] of [
        [ALIBABA_CTX, ALIBABA_CODING_PLAN_PROVIDER_ID],
        [MINIMAX_CTX, MINIMAX_TOKEN_PLAN_PROVIDER_ID],
      ] as const) {
        assert.deepEqual(preflightError(agent, ctx)?.toBody().data, {
          providerId,
          reason: "no-credentials",
        });
      }
      assert.match(text, /alibaba-coding-plan: credential is a pay-as-you-go key/);
      assert.match(text, /minimax-token-plan: credential is not a Token Plan Subscription Key/);
      assert.ok(!text.includes(paygUnderPlan) && !text.includes(notSubscription), "never echoed");
      const learned = agent.redactValues ?? [];
      assert.ok(!learned.includes(paygUnderPlan) && !learned.includes(notSubscription));
    },
  );
});

// ------------------------------------------------------------------ session record (S4, S6)

function sessionOpen(): SessionEvent {
  return {
    v: 1,
    seq: 0,
    ts: 1,
    type: "session.open",
    threadId: "thr_a5",
    seatId: "coder",
    prevHash: "0".repeat(64),
    hash: "0".repeat(64),
    payload: { cwd: null, backing: "kimi-code", providerId: "kimi-code", pinnedModel: "m" },
  };
}

function turnStart(payload: Record<string, unknown>): SessionEvent {
  return { ...sessionOpen(), seq: 1, ts: 2, type: "turn.start", payload } as SessionEvent;
}

test("A5: turn.start mode/presence/tty are validated when present; a pre-A5 line (no mode) still rebuilds", () => {
  const ok = [
    { turnId: "turn_1", inputText: "legacy line, no mode" },
    { turnId: "turn_1", inputText: "x", mode: "headless", presence: "absent" },
    { turnId: "turn_1", inputText: "x", mode: "interactive", presence: "absent" },
    {
      turnId: "turn_1",
      inputText: "x",
      mode: "interactive",
      presence: "verified",
      tty: { device: "16/18", session: null, confirmation: "keypress" },
    },
  ];
  for (const payload of ok) {
    assert.equal(rebuildSession([sessionOpen(), turnStart(payload)]).turns.length, 1);
  }
  const bad = [
    { turnId: "turn_1", inputText: "x", mode: "sideways", presence: "absent" },
    { turnId: "turn_1", inputText: "x", mode: "headless", presence: "maybe" },
    // `mode` and `presence` travel together: half an A5 record is malformed, not a weaker claim.
    { turnId: "turn_1", inputText: "x", mode: "headless" },
    { turnId: "turn_1", inputText: "x", presence: "absent" },
    // Verified presence always carries its TTY evidence.
    { turnId: "turn_1", inputText: "x", mode: "interactive", presence: "verified" },
    // TTY facts only ever accompany a verified presence.
    {
      turnId: "turn_1",
      inputText: "x",
      mode: "interactive",
      presence: "absent",
      tty: { device: "1/1", session: null, confirmation: "keypress" },
    },
    {
      turnId: "turn_1",
      inputText: "x",
      mode: "interactive",
      presence: "verified",
      tty: { device: "1/1", session: null, confirmation: "guess" },
    },
    {
      turnId: "turn_1",
      inputText: "x",
      mode: "interactive",
      presence: "verified",
      tty: { device: 7, session: null, confirmation: "carried" },
    },
  ];
  for (const payload of bad) {
    assert.throws(
      () => rebuildSession([sessionOpen(), turnStart(payload)]),
      /malformed turn\.start/,
    );
  }
});

test("A5 S6: the MiniMax Subscription Key shape is redacted by pattern, like the Alibaba plan shape", () => {
  const redact = createRedactor([]);
  assert.equal(redact("key sk-cp-abcd1234 end"), `key ${REDACTED} end`);
  assert.equal(redact("key sk-sp-abcd1234 end"), `key ${REDACTED} end`);
});

// -------------------------------------------------------- real process, no controlling terminal

test("A5: a real engine spawned detached (setsid, no controlling terminal) refuses a mode: interactive claim before any network call", async (t) => {
  if (!POSIX) {
    console.log("SKIP A5 detached spawn: POSIX sessions only");
    return;
  }
  const home = withHome(t);
  const wireLog = join(home, "..", "wire.jsonl");
  writeSeatFile(home, SEATS.alibaba());
  writeSeatFile(home, SEATS.minimax());
  const args =
    process.versions.bun !== undefined
      ? [INTERACTIVE_FAKE_ENGINE]
      : ["--disable-warning=ExperimentalWarning", INTERACTIVE_FAKE_ENGINE];
  const child = spawn(process.execPath, args, {
    // detached: the child calls setsid(), so it is a new session with NO controlling terminal —
    // cron, CI and daemons look exactly like this. The engine uses its REAL terminal probe.
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: withoutUndefined({
      ...process.env,
      ...hermeticEnv({
        MADC_HOME: home,
        MADC_TEST_WIRE_LOG: wireLog,
        MADC_API_KEY_ALIBABA_CODING_PLAN: ALIBABA_KEY,
        MADC_API_KEY_MINIMAX_TOKEN_PLAN: MINIMAX_KEY,
      }),
    }),
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const client = new EngineClient(child);
  try {
    await clientHandshake(client);
    for (const [seatId, providerId] of [
      ["coder", ALIBABA_CODING_PLAN_PROVIDER_ID],
      ["mm", MINIMAX_TOKEN_PLAN_PROVIDER_ID],
    ] as const) {
      const { thread } = await client.request("thread/start", { seatId, cwd: home });
      let refusal: { code?: number; data?: unknown } | null = null;
      try {
        await client.request("turn/start", {
          threadId: thread.id,
          input: [{ type: "text", text: "hello" }],
          mode: "interactive",
        });
      } catch (err) {
        refusal = err as { code?: number; data?: unknown };
      }
      assert.equal(refusal?.code, ErrorCode.ProviderDenied, seatId);
      assert.deepEqual(refusal?.data, {
        providerId,
        status: "interactive-only",
        reason: "interactive-only-headless",
      });
    }
    assert.equal(existsSync(wireLog), false, "no provider request was ever attempted");
  } finally {
    await client.close();
  }
  assert.match(stderr, /presence alibaba-coding-plan: absent \(no controlling terminal\)/);
});
