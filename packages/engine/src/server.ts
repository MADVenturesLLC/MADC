import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface, type Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import {
  canServe,
  checkEntry,
  getById,
  type ProviderEntry,
  RegistryDeniedError,
  type RunMode,
} from "@madc/registry";
import type { Agent, AgentTurnContext, TurnSink } from "./agent.ts";
import { type CredentialStore, createCredentialStore } from "./credentials/store.ts";
import { checkHandoffTarget } from "./handoff.ts";
import { confinedPath, sessionsOwnerReadUnsupported } from "./home.ts";
import { acquireThreadLock, holdsThreadLock, type LockHandle, releaseThreadLock } from "./lock.ts";
import { type RepoIdentityDeps, resolveRepoIdentity } from "./policy/identity.ts";
import { denyAllRepoPolicy, isRepoGated, type RepoPolicy } from "./policy/store.ts";
import {
  type Presence,
  presenceRequired,
  sameTerminal,
  type TerminalFacts,
} from "./presence/policy.ts";
import { createSystemTerminal, type PresenceTerminal } from "./presence/terminal.ts";
import {
  alreadyInitialized,
  ErrorCode,
  evidenceInvalid,
  internalError,
  invalidParams,
  invalidRequest,
  methodNotFound,
  notInitialized,
  providerRefusalError,
  RpcError,
  type SessionWriteFailedData,
  threadNotFound,
  turnAlreadyActive,
  turnNotFound,
} from "./protocol/errors.ts";
import { isValidId, newId } from "./protocol/ids.ts";
import {
  type AuthStatusResult,
  DEFAULT_SEAT_ID,
  DEFAULT_TURN_MODE,
  type InitializeResult,
  type Item,
  PROTOCOL_VERSION,
  type ProviderListResult,
  type RequestId,
  type RpcErrorBody,
  SERVER_NAME,
  type SeatListResult,
  type ServerNotifications,
  type Thread,
  type ThreadListResult,
  type Turn,
  type TurnMode,
  type TurnStatus,
  type UserInput,
} from "./protocol/types.ts";
import { encodeMessage, isPlainObject, parseLine } from "./protocol/wire.ts";
import {
  defaultBinaryPresence,
  listProviderSummaries,
  type ProviderPresence,
} from "./providers/list.ts";
import { type LoadedSeat, loadSeat } from "./seat-store.ts";
import { listSeatSummaries } from "./seats/list.ts";
import { ensureSeatMemoryFile } from "./seats/memory.ts";
import { seedRosterSeats } from "./seats/roster.ts";
import {
  type RebuiltSession,
  rebuildSession,
  SessionChainIndex,
  type SessionEvent,
  type SessionEventType,
  type SessionOpenHandoffLink,
  type SessionPayloads,
  SessionWriter,
  sessionWriteFailed,
  type TurnStartTty,
  verifySessionFile,
  type WorktreeIdentity,
} from "./session-store.ts";
import { rereadWorktreeIdentity, resolveWorktreeIdentity } from "./worktree.ts";

export const ENGINE_VERSION = "0.0.0";

export type EngineOptions = {
  input: Readable;
  output: Writable;
  /** Resolved `$MADC_HOME`. */
  home: string;
  agent: Agent;
  /** stderr logger — never protocol. */
  log?: (message: string) => void;
  /** Test seam: thread id generator for `thread/start` (default `newId("thr")`). */
  newThreadId?: () => string;
  /**
   * M1-A2: engine-owned credential store backing `auth/status` and `auth/remove`. Default: the
   * real OS keychain via `createCredentialStore()` (created on first auth call). Tests inject a
   * store backed by a fake keychain.
   */
  credentials?: CredentialStore;
  /**
   * M1-A4: the loaded `$MADC_HOME/policy.json` repo allowlists (seat pin §5). Default: the
   * deny-everywhere policy, which is also what a clean install resolves to (D-M1-8) — so an engine
   * that never loads the file cannot widen access. Production wiring in `main.ts` always passes the
   * loaded policy.
   */
  repoPolicy?: RepoPolicy;
  /** M1-A4 test seam: `realpath` / `git` injection for repo-identity resolution. */
  repoIdentityDeps?: RepoIdentityDeps;
  /**
   * M2-A1 test seam: `realpath` / `git` injection for the worktree identity recorded on
   * `session.open` and `session.close` (M2 pin §2.2). Separate from `repoIdentityDeps` so a test
   * can fake a repo-gate identity without faking `HEAD`, and vice versa. Default: real `git`.
   */
  worktreeDeps?: RepoIdentityDeps;
  /**
   * M1-A5: the engine's access to its own controlling terminal for the presence check (protocol pin
   * §3.3 P3). Default: the real `/dev/tty` (`presence/terminal.ts`), created on first need, so an
   * engine that never serves a presence-gated turn never touches the terminal. Tests inject fakes.
   */
  terminal?: PresenceTerminal;
  /**
   * M1-A8: how `provider/list` learns credential and binary presence. Default: the engine's own
   * credential store (`status`, presence only) and the turn preflight's read-only PATH lookups.
   * Tests inject fakes.
   */
  providerPresence?: ProviderPresence;
  /** M1-A8 test seam: the clock `provider/list` judges terms freshness by (default `Date.now`). */
  now?: () => number;
};

type TurnRecord = {
  turn: Turn;
  controller: AbortController;
  open: Map<string, Item>;
  /** Set before the terminal transition starts (and before abort listeners run): sink is closed. */
  finalizing: boolean;
};

type ThreadRecord = {
  thread: Thread;
  lock: LockHandle;
  turns: Map<string, TurnRecord>;
  activeTurnId: string | null;
  seat: LoadedSeat;
  session: SessionWriter;
  /**
   * M1-A5: the terminal a person confirmed presence on for THIS thread in THIS process (never
   * persisted, never carried to another thread or engine). Cleared the moment the terminal is gone
   * or changed, so the next presence-gated turn needs a fresh keypress.
   */
  confirmedTerminal: TerminalFacts | null;
  /** M1-A5: a `turn/start` on this thread is waiting for the presence keypress. */
  confirming: boolean;
  /** M2: what this thread's `session.open` recorded (schema v2). */
  open: SessionOpenFacts;
  /**
   * M2 pin §2.1: the two-way link of a handoff TARGET was verified against the source file since
   * this record was loaded. Checked on every `thread/resume` and before the first `turn/start`
   * after a load (then cached for the later turns of the same load); never for a non-target.
   */
  handoffVerified: boolean;
};

/** M2 pin §2.1 / §2.2: the `session.open` facts a loaded thread keeps. */
type SessionOpenFacts = {
  /** The file's seq-0 hash (G for a handoff target). */
  readonly genesisHash: string;
  /** The source link when this thread is a handoff target; null otherwise (and for a v1 open). */
  readonly handoff: SessionOpenHandoffLink | null;
  /** The identity recorded at open; null for a non-git cwd and for a v1 open. */
  readonly worktree: WorktreeIdentity | null;
};

/**
 * M1-A5 presence phase of one `turn/start` (see `#presencePhase`). `not-required`: the lane serves
 * this claim without a person present. `verified`: the confirmed terminal is still the live one.
 * `pending`: a live terminal nobody has confirmed on yet (a keypress is needed). `absent`: refused.
 */
type PresencePhase =
  | { readonly kind: "not-required" }
  | { readonly kind: "verified"; readonly facts: TerminalFacts }
  | { readonly kind: "pending"; readonly facts: TerminalFacts }
  | { readonly kind: "absent"; readonly why: string };

/** The presence outcome `#beginTurn` records on `turn.start` (seat pin §4.2 S4). */
type TurnPresence = { readonly presence: Presence; readonly tty?: TurnStartTty };

const THREAD_LIST_DEFAULT_LIMIT = 50;
const THREAD_LIST_MAX_LIMIT = 200;

/** P3: `mode` is optional and fail-closed; any value other than the two modes is -32602. */
function parseModeClaim(value: unknown, issues: string[]): TurnMode {
  if (value === undefined) return DEFAULT_TURN_MODE;
  if (value === "interactive" || value === "headless") return value;
  issues.push('mode must be "interactive" or "headless"');
  return DEFAULT_TURN_MODE;
}

/**
 * The prompt the engine writes to its own controlling terminal. Carries only the seat id (protocol
 * id grammar) and the registry id — never input text or a credential.
 */
function presencePrompt(seatId: string, providerId: string): string {
  return (
    `\r\nmadc: seat ${seatId} wants lane ${providerId}, which serves only a person at this terminal.` +
    "\r\nmadc: press Enter to confirm you are here (type n then Enter to refuse): "
  );
}

/** One dispatched request's response value plus an optional post-response hook. */
type DispatchResult = { value: unknown; after?: () => void };

function paramsObject(params: unknown): Record<string, unknown> {
  if (params === undefined) return {};
  if (!isPlainObject(params)) throw invalidParams(["params must be an object"]);
  return params;
}

function requireId(p: Record<string, unknown>, key: string, issues: string[]): string {
  const value = p[key];
  if (value === undefined) {
    issues.push(`${key} is required`);
    return "";
  }
  if (!isValidId(value)) {
    issues.push(`${key} must match ^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`);
    return "";
  }
  return value;
}

function throwIfIssues(issues: string[]): void {
  if (issues.length > 0) throw invalidParams(issues);
}

/**
 * `auth/*` providerId (M1-A2): the protocol id grammar first, then a known registry catalog id —
 * anything else is `-32602 InvalidParams` (there is no provider lookup on these methods).
 */
function authProviderId(params: unknown): string {
  const p = paramsObject(params);
  const issues: string[] = [];
  const providerId = requireId(p, "providerId", issues);
  if (issues.length === 0 && getById(providerId) === undefined) {
    issues.push("providerId is not a registry catalog id");
  }
  throwIfIssues(issues);
  return providerId;
}

function parseUserInput(value: unknown, issues: string[]): UserInput[] {
  if (!Array.isArray(value)) {
    issues.push("input must be an array");
    return [];
  }
  if (value.length === 0) {
    issues.push("input must not be empty");
    return [];
  }
  const out: UserInput[] = [];
  value.forEach((part: unknown, i: number) => {
    if (!isPlainObject(part) || part.type !== "text") {
      issues.push(`input[${i}].type must be "text"`);
    } else if (typeof part.text !== "string") {
      issues.push(`input[${i}].text must be a string`);
    } else {
      out.push({ type: "text", text: part.text });
    }
  });
  return out;
}

/**
 * One stdio connection = one engine process (protocol pin §2). The CLI spawns this; there is no
 * other listener. Resolves when stdin reaches EOF and cleanup (interrupt in-flight turns, release
 * thread locks) is done.
 */
export class EngineConnection {
  readonly #opts: EngineOptions;
  #initialized = false;
  #closed = false;
  #shutDown = false;
  #rl: Interface | null = null;
  readonly #threads = new Map<string, ThreadRecord>();
  /** Locks this process still holds without a thread record (probe locks whose release failed). */
  readonly #strayLocks: LockHandle[] = [];
  /**
   * Amendment 3 item 1 rule 3 / C2: threads whose writer's rollback failed, for the life of this
   * process. `path` is the session file and `seq` the FIRST seq of the refused batch (the seq the
   * failed append's own -32009 carried). Survives `#threads.delete`; every -32009 C3 step 1 or C4
   * answers for a poisoned thread carries this entry's `path` and `seq`.
   */
  readonly #poisoned = new Map<string, { path: string; seq: number }>();
  /** M1-A2 credential store, created on the first `auth/*` call (never at construction). */
  #credentials: CredentialStore | null = null;
  /** M1-A4 repo allowlists (seat pin §5); deny-everywhere unless a loaded policy was supplied. */
  readonly #repoPolicy: RepoPolicy;
  /** M1-A5 controlling-terminal access, created on the first presence-gated turn. */
  #terminal: PresenceTerminal | null = null;
  /** M1-A5 presence prompts still waiting for a keypress; shutdown aborts every one. */
  readonly #pendingConfirmations = new Set<AbortController>();
  /**
   * M1-A5: the tail of the engine-wide confirmation queue. Every thread shares ONE controlling
   * terminal, so prompts run one at a time: a keypress can only answer the prompt it was typed
   * for, never another thread's seat or lane (Copilot r4145107307). Only ever resolves.
   */
  #confirmationTail: Promise<void> = Promise.resolve();

  constructor(opts: EngineOptions) {
    this.#opts = opts;
    this.#repoPolicy = opts.repoPolicy ?? denyAllRepoPolicy();
  }

  /**
   * M1-A4 repo-policy gate for the seat's assigned backing (protocol pin §4.2: repo-policy checks
   * run in `turn/start` before any model or vendor call; protocol pin §2: repo identity resolution
   * is ENGINE-owned, so the caller-supplied `cwd` string is never matched against an allowlist).
   *
   * Runs BEFORE the agent's preflight, because D-M1-8 must be observable on a clean install: an
   * empty allowlist denies every repo with `-32007 repo-not-allowed`, including when no DeepSeek
   * credential is configured. It is skipped for a lane that could not serve this turn's mode anyway,
   * so it never pre-empts a `forbidden` / `interactive-only-headless` / `headless-not-permitted`
   * denial that `assertAllowed` owns (M1-A5's acceptance depends on that ordering).
   *
   * The decision is durable BEFORE it is acted on: the pinned `repo.decision` event (seat pin §4.2)
   * is appended first, and an append failure poisons the writer and surfaces as `-32009` — a
   * decision that is not recorded is not claimed. `turnId` is therefore minted before preflight; it
   * is a pure local id, so C3's "append `turn.start` only after preflight" ordering is unchanged.
   * A denial leaves a `repo.decision` line with no `turn.start`, which `rebuildSession` ignores.
   *
   * M1-A5: `mode` is the mode the lane is asked to serve. A presence-gated lane only reaches this
   * gate once presence is verified or pending (an absent presence is refused before it), so the
   * gate runs for an attested interactive MiniMax turn and stays out of the way of every mode denial.
   */
  #repoGate(record: ThreadRecord, turnId: string, mode: RunMode): void {
    const providerId = record.seat.seat.preferredBacking;
    if (!isRepoGated(providerId)) return;
    const entry = getById(providerId);
    if (entry === undefined || !canServe(entry, mode)) return;

    const resolution = resolveRepoIdentity(record.thread.cwd, this.#opts.repoIdentityDeps ?? {});
    const decision = this.#repoPolicy.decide(providerId, resolution);
    try {
      record.session.append("repo.decision", {
        turnId,
        providerId,
        remote: decision.remote,
        topLevel: decision.topLevel,
        decision: decision.decision,
        reason: decision.reason,
      });
    } catch (err) {
      if (!(err instanceof RpcError)) throw err;
      this.#notePoisoned(record.thread.id, record.session);
      throw err;
    }
    this.#log(`repo gate ${providerId}: ${decision.decision} (${decision.reason})`);
    if (decision.decision === "deny") {
      throw providerRefusalError({
        providerId,
        reason: decision.reason,
        status: entry.status,
      });
    }
  }

  /**
   * C2: an append that left its writer poisoned puts the thread on the process-lifetime list and
   * logs rule 3's line once (never the payload bytes). No-op for an ordinary broken writer.
   */
  #notePoisoned(threadId: string, session: SessionWriter): void {
    const range = session.poisonedSeq;
    if (range === null || this.#poisoned.has(threadId)) return;
    this.#poisoned.set(threadId, { path: session.path, seq: range.first });
    this.#log(
      `session ${threadId}: rollback failed; refused seq ${range.first}..${range.last} may persist on disk`,
    );
  }

  run(): Promise<void> {
    const { input, output } = this.#opts;
    this.#seedHome();
    // A dead stdout ends the connection exactly like EOF (interrupt turns, release locks).
    output.on("error", () => this.#onOutputFailure());
    const rl = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
    this.#rl = rl;
    rl.on("line", (line) => this.handleLine(line));
    return new Promise((resolve) => {
      rl.once("close", () => {
        this.shutdown();
        resolve();
      });
    });
  }

  /**
   * Seat pin §1 / §3 (S3): on engine start, seed the five roster seats — each only when its own
   * `seats/<id>.json` is missing, never overwriting an existing file. A failure is logged, not
   * fatal: `thread/start` then reports that seat's error itself (-32005 for a seat that never
   * landed). Every refused seat is named in the log — Amendment 3 item 4 forbids passing a refusal
   * off as "already seeded".
   */
  #seedHome(): void {
    try {
      const report = seedRosterSeats(this.#opts.home);
      for (const failure of report.failures) {
        this.#log(`seed failed for seat ${failure.seatId}: ${failure.message}`);
      }
    } catch (err) {
      this.#log(`seed failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** EOF / output failure / signal: in-flight turns end `interrupted`; locks are released. */
  shutdown(): void {
    if (this.#shutDown) return;
    this.#shutDown = true;
    // M1-A5: a presence prompt still waiting for a keypress is cancelled; its turn never starts.
    for (const controller of this.#pendingConfirmations) controller.abort();
    this.#pendingConfirmations.clear();
    for (const record of this.#threads.values()) {
      const active =
        record.activeTurnId === null ? undefined : record.turns.get(record.activeTurnId);
      if (active !== undefined) this.#finishTurn(record, active, "interrupted");
    }
    // M2 pin §2.2 (D-M2-A0-5): every clean shutdown writes `session.close`, under the lock this
    // process still holds, before that lock is released.
    this.#closeSessions();
    this.releaseLocks();
    this.#closed = true;
    this.#rl?.close();
  }

  /**
   * M2 pin §2.2 "At close" (D-M2-A0-5): one `session.close` per loaded thread whose writer is
   * usable and whose lock this process still holds, with `worktree.head` re-read at the RECORDED
   * top-level (null when it can no longer be read; doctor WARNs `worktree-head-unreadable`). A
   * refused record (-32010) or a failed append (-32009) is one stderr line and never a protocol
   * error: the operation that needed the line has already answered (pin §5 "Where it surfaces").
   */
  #closeSessions(): void {
    for (const record of this.#threads.values()) {
      const threadId = record.thread.id;
      if (record.session.broken || this.#poisoned.has(threadId)) {
        this.#log(`session ${threadId}: not closed (writer unusable)`);
        continue;
      }
      if (!holdsThreadLock(record.lock)) {
        this.#log(`session ${threadId}: not closed (thread lock no longer held)`);
        continue;
      }
      const worktree =
        record.open.worktree === null
          ? null
          : rereadWorktreeIdentity(record.open.worktree, this.#opts.worktreeDeps ?? {});
      try {
        record.session.append("session.close", { reason: "shutdown", worktree });
      } catch (err) {
        if (!(err instanceof RpcError)) throw err;
        if (err.code === ErrorCode.EvidenceInvalid) {
          const issues = Array.isArray(err.data?.issues) ? err.data.issues.join("; ") : "";
          this.#log(`session ${threadId}: close record refused (${issues})`);
          continue;
        }
        this.#notePoisoned(threadId, record.session);
        this.#log(`session append failed (session.close): ${err.message}`);
      }
    }
  }

  /**
   * M2 pin §2.1: a handoff TARGET serves only while §2.1 (b) and (c) hold against the source file,
   * checked on every `thread/resume` (`force`) and before the first `turn/start` after a load.
   * Anything less — no `handoff.link` yet, a recorded `handoff.aborted`, a line that differs, or a
   * source file that cannot be read (Copilot 4160774858: unverifiable is NOT a pass for the target)
   * — is `-32010 handoff-one-way`, and nothing is appended. A thread that is not a target returns
   * at once.
   */
  #handoffGate(record: ThreadRecord, force = false): void {
    const link = record.open.handoff;
    if (link === null) return;
    if (record.handoffVerified && !force) return;
    const threadId = record.thread.id;
    const check = checkHandoffTarget(this.#opts.home, {
      threadId,
      seatId: record.thread.seatId,
      genesisHash: record.open.genesisHash,
      link,
    });
    if (!check.ok) {
      record.handoffVerified = false;
      this.#log(`handoff gate ${threadId}: refused (${check.kind}): ${check.issues.join("; ")}`);
      throw evidenceInvalid({
        threadId,
        turnId: null,
        type: "session.open",
        reason: "handoff-one-way",
        issues: check.issues,
      });
    }
    record.handoffVerified = true;
  }

  /** stdout is gone: nothing can be answered any more, so stop and clean up (same path as EOF). */
  #onOutputFailure(): void {
    this.#closed = true;
    // Closing readline emits "close", which runs shutdown(); before run() there is none.
    if (this.#rl === null) this.shutdown();
    else this.#rl.close();
  }

  releaseLocks(): void {
    const handles = [...[...this.#threads.values()].map((r) => r.lock), ...this.#strayLocks];
    for (const handle of handles) {
      try {
        releaseThreadLock(handle);
      } catch {
        // best effort; a dead-pid lock is reclaimed by the next engine
      }
    }
  }

  handleLine(line: string): void {
    if (this.#closed) return; // no dispatch after shutdown / output failure
    const msg = parseLine(line);
    if (msg === null) return;
    if (msg.kind === "invalid") {
      this.#send({ id: msg.id, error: msg.error.toBody() });
      return;
    }
    if (msg.kind === "notification") {
      // Only `initialized` is defined client → server; unknown notifications are ignored (no id to answer).
      return;
    }
    let result: DispatchResult | Promise<DispatchResult>;
    try {
      result = this.#dispatch(msg.method, msg.params);
    } catch (err) {
      this.#sendError(msg.id, err);
      return;
    }
    if (result instanceof Promise) {
      // auth/* are the only async methods (keychain child processes). JSON-RPC imposes no
      // response order, so a slow probe never blocks the lines behind it.
      result.then(
        (r) => this.#answer(msg.id, r),
        (err: unknown) => this.#sendError(msg.id, err),
      );
      return;
    }
    this.#answer(msg.id, result);
  }

  #answer(id: RequestId, result: DispatchResult): void {
    this.#send({ id, result: result.value });
    try {
      result.after?.();
    } catch (err) {
      // The response is already on the wire; never answer the same id twice.
      this.#log(`post-response error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  #sendError(id: RequestId, err: unknown): void {
    if (err instanceof RpcError) {
      this.#send({ id, error: err.toBody() });
      return;
    }
    this.#log(`internal error: ${err instanceof Error ? err.message : String(err)}`);
    this.#send({ id, error: internalError().toBody() });
  }

  #dispatch(method: string, params: unknown): DispatchResult | Promise<DispatchResult> {
    if (method === "initialize") return { value: this.#initialize(params) };
    if (method === "initialized") throw invalidRequest("initialized is a notification");
    if (!this.#initialized) throw notInitialized(method);
    switch (method) {
      case "thread/start":
        return this.#threadStart(params);
      case "thread/resume":
        return this.#threadResume(params);
      case "thread/list":
        return { value: this.#threadList(params) };
      case "turn/start":
        return this.#turnStart(params);
      case "turn/interrupt":
        return this.#turnInterrupt(params);
      case "seat/list":
        return { value: this.#seatList(params) };
      case "provider/list":
        return this.#providerList(params);
      case "auth/status":
        return this.#authStatus(params);
      case "auth/remove":
        return this.#authRemove(params);
      default:
        throw methodNotFound(method);
    }
  }

  // -------------------------------------------------------------------- seats

  /**
   * M1-A7 (protocol pin §3.5 P4): `{ data: SeatSummary[] }`, the projection this act locks
   * (`SeatSummary`, protocol types). Read-only. Params are pinned as `{}`, so any field at all is
   * -32602 — the method takes nothing and can therefore never be handed a secret value.
   */
  #seatList(params: unknown): SeatListResult {
    const p = paramsObject(params);
    const unexpected = Object.keys(p);
    if (unexpected.length > 0) {
      throw invalidParams([`seat/list takes no params (got ${unexpected.join(", ")})`]);
    }
    return { data: listSeatSummaries(this.#opts.home) };
  }

  // ---------------------------------------------------------------- providers

  /**
   * M1-A8 (protocol pin §3.5 P4, §5): `{ data: ProviderSummary[] }`, one summary per registry
   * catalog entry. Read-only, presence only. Params are pinned as `{}`, so any field at all is
   * -32602 — like `seat/list`, the method takes nothing and can therefore never be handed a secret.
   */
  async #providerList(params: unknown): Promise<{ value: ProviderListResult }> {
    const p = paramsObject(params);
    const unexpected = Object.keys(p);
    if (unexpected.length > 0) {
      throw invalidParams([`provider/list takes no params (got ${unexpected.join(", ")})`]);
    }
    const presence: ProviderPresence = this.#opts.providerPresence ?? {
      credentials: (providerId) => this.#credentialStore().status(providerId),
      binary: defaultBinaryPresence(),
    };
    const now = this.#opts.now?.() ?? Date.now();
    return { value: { data: await listProviderSummaries(presence, now) } };
  }

  /**
   * Seat-load warnings (seat pin §2, D-M1-7): a listed fallback that can never be eligible under
   * the same-lane rule is warned about at load, on stderr — never silently dropped, and never a
   * load failure (the seat file is valid; that one hop just can never serve). `seat/list` reports
   * the same warnings and `madc doctor` surfaces them in M1-A8.
   */
  #noteSeatWarnings(seat: LoadedSeat): void {
    for (const warning of seat.warnings) this.#log(warning);
  }

  /**
   * Create the seat's own memory file if it is missing (seat pin §1 `memory/<seatId>.md`). Never
   * overwrites, never appends, never follows a symlink; a refusal is logged and the thread still
   * serves — memory notes are optional in M1 and no act commissions their content format.
   */
  #materializeSeatMemory(seat: LoadedSeat): void {
    try {
      ensureSeatMemoryFile(this.#opts.home, seat.seat);
    } catch (err) {
      this.#log(
        `seat ${seat.seat.id}: memory path unavailable (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }

  // -------------------------------------------------------------------- auth

  /** Lazily created so an engine that never serves an auth call never touches the keychain. */
  #credentialStore(): CredentialStore {
    this.#credentials ??= this.#opts.credentials ?? createCredentialStore();
    return this.#credentials;
  }

  /**
   * M1-A2 (protocol pin §3.5): the exact pinned shape `{ providerId, present }` — presence only,
   * NEVER a value. Where the credential resolves from (keychain vs the `MADC_DEV_ENV_KEYS=1` env
   * fallback, D-M1-5) stays engine-internal; `madc doctor` discloses the fallback from its own env.
   */
  async #authStatus(params: unknown): Promise<{ value: AuthStatusResult }> {
    const providerId = authProviderId(params);
    const present = await this.#credentialStore().status(providerId);
    return { value: { providerId, present } };
  }

  /** M1-A2: removes through the store (idempotent). There is no `auth/set` over JSONL (§3.5). */
  async #authRemove(params: unknown): Promise<{ value: Record<string, never> }> {
    const providerId = authProviderId(params);
    await this.#credentialStore().remove(providerId);
    return { value: {} };
  }

  // ---------------------------------------------------------------- handshake

  #initialize(params: unknown): InitializeResult {
    if (this.#initialized) throw alreadyInitialized();
    const p = paramsObject(params);
    const issues: string[] = [];
    const info = p.clientInfo;
    if (!isPlainObject(info)) {
      issues.push("clientInfo is required");
    } else {
      if (typeof info.name !== "string" || info.name === "")
        issues.push("clientInfo.name must be a non-empty string");
      if (typeof info.version !== "string") issues.push("clientInfo.version must be a string");
      if (info.title !== undefined && typeof info.title !== "string")
        issues.push("clientInfo.title must be a string");
    }
    throwIfIssues(issues);
    this.#initialized = true;
    return {
      serverInfo: { name: SERVER_NAME, version: ENGINE_VERSION },
      protocolVersion: PROTOCOL_VERSION,
    };
  }

  // ------------------------------------------------------------------ threads

  #threadStart(params: unknown): { value: { thread: Thread }; after: () => void } {
    const p = paramsObject(params);
    const issues: string[] = [];
    let seatId: string = DEFAULT_SEAT_ID;
    if (p.seatId !== undefined) {
      if (isValidId(p.seatId)) seatId = p.seatId;
      else issues.push("seatId must match ^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$");
    }
    if (p.cwd !== undefined && typeof p.cwd !== "string") issues.push("cwd must be a string");
    throwIfIssues(issues);

    // Seat load happens in thread/start (protocol pin §4.2): -32005 / -32006 before any lock.
    const seat = loadSeat(this.#opts.home, seatId);
    this.#noteSeatWarnings(seat);

    const id = this.#opts.newThreadId?.() ?? newId("thr");
    if (!isValidId(id)) throw internalError("Generated thread id is invalid");
    // Amendment 3 item 5 rule 3: an owner-unreadable sessions/ fails -32009 BEFORE any lock or
    // session file is created, with a message that names the cause (POSIX; mode bits, so the
    // answer is the same as root). Detection is the lstat mode bits (rule 5), which never depends
    // on realpath/open/readdir succeeding (Bun's realpathSync refuses EACCES where Node's does
    // not), so it runs on the lexical path before confinement; a symlinked sessions/ passes the
    // mode check (0777) and is still rejected by confinement below.
    const sessionsMode = sessionsOwnerReadUnsupported(join(this.#opts.home, "sessions"));
    if (sessionsMode !== null) {
      throw new RpcError(
        ErrorCode.SessionWriteFailed,
        `sessions/ is not readable by its owner (mode ${sessionsMode} is unsupported in M0; use 0700)`,
        {
          threadId: id,
          path: join(this.#opts.home, "sessions", `${id}.jsonl`),
          seq: 0,
        } satisfies SessionWriteFailedData,
      );
    }
    const path = confinedPath(this.#opts.home, "sessions", id, ".jsonl");
    const lock = acquireThreadLock(this.#opts.home, id);
    if (!lock.ok) throw turnAlreadyActive(id, null, lock.holderPid ?? undefined);
    const handle = lock.handle;

    const now = Date.now();
    const cwd = typeof p.cwd === "string" ? p.cwd : null;
    // M2 pin §2.2: engine-owned worktree identity (realpath'd top-level, normalized origin, HEAD),
    // resolved from `cwd` the way the repo gate resolves repo identity; null outside a work tree.
    // `handoff` is null: no protocol surface of this act opens a handoff target (the typed
    // mechanism is the M2 build plan's to commission); the writer still validates the field.
    const worktree = resolveWorktreeIdentity(cwd, this.#opts.worktreeDeps ?? {});
    let session: SessionWriter;
    try {
      session = SessionWriter.create(
        path,
        id,
        seatId,
        {
          cwd,
          backing: seat.seat.preferredBacking,
          providerId: seat.seat.preferredBacking,
          pinnedModel: seat.seat.pinnedModel,
          worktree,
          handoff: null,
        },
        () => this.#secrets(this.#threads.get(id)?.lock ?? handle),
        now, // session.open ts == thread.createdAt
        this.#opts.home,
        // Amendment 2 §2: every append re-checks that this acquisition still owns the lock.
        { holdsLock: () => holdsThreadLock(handle) },
        {
          // Amendment 3 rule 4: a close that fails after a durable batch is logged, not fatal.
          onCloseFailed: (code) =>
            this.#log(`session ${id}: close failed after a durable append (${code})`),
        },
      );
    } catch (err) {
      this.#releaseOrKeep(handle);
      throw err;
    }
    const thread: Thread = {
      id,
      seatId,
      cwd,
      createdAt: now,
      updatedAt: now,
      status: "idle",
      preview: "",
    };
    // M1-A7 (seat pin §1, §8 item 4): a thread on a seat materializes THAT seat's own memory path
    // — never another seat's, never a shared one (plan A7 forbidden: "shared memory between
    // seats"). It runs here, not at turn time, so a seat whose turns this build refuses still owns
    // its memory path: `surface-architect` cannot pass turn preflight until the Founder records
    // Ollama headless permission (D-M1-3/D-M1-4) or M1-A5 lands interactive attestation, and
    // neither gate is relaxed by creating an empty 0600 note file. Best effort and never fatal:
    // memory notes are optional in M1 and no act commissions their content format, so a refusal
    // here must not fail a thread that could otherwise serve.
    this.#materializeSeatMemory(seat);
    this.#threads.set(id, {
      thread,
      lock: handle,
      turns: new Map(),
      activeTurnId: null,
      seat,
      session,
      confirmedTerminal: null,
      confirming: false,
      open: { genesisHash: session.genesisHash ?? "", handoff: null, worktree },
      handoffVerified: false,
    });
    return { value: { thread }, after: () => this.#notify("thread/started", { thread }) };
  }

  /** Exact values redacted from every session append: the agent's secrets and our lock token. */
  #secrets(lock: LockHandle): string[] {
    return [...(this.#opts.agent.redactValues ?? []), lock.token];
  }

  /** Release a lock we took; if that fails while we still hold it, keep it for shutdown. */
  #releaseOrKeep(handle: LockHandle): void {
    let released = false;
    try {
      released = releaseThreadLock(handle);
    } catch {
      released = false;
    }
    try {
      if (!released && holdsThreadLock(handle)) this.#strayLocks.push(handle);
    } catch {
      // unreadable lock: nothing more we can do; a dead-pid lock is reclaimed later
    }
  }

  #threadResume(params: unknown): { value: { thread: Thread }; after: () => void } {
    const p = paramsObject(params);
    const issues: string[] = [];
    const threadId = requireId(p, "threadId", issues);
    throwIfIssues(issues);

    // C4 / rule 6 row (b): a poisoned thread answers -32009 first, without acquiring, releasing
    // or reloading (the poisoned check runs before any lock step).
    const poisoned = this.#poisoned.get(threadId);
    if (poisoned !== undefined) throw sessionWriteFailed(threadId, poisoned.path, poisoned.seq);

    const known = this.#threads.get(threadId);
    if (known !== undefined) {
      if (known.session.broken && holdsThreadLock(known.lock)) {
        // Rule 6 row (a): a broken writer is cleared only by a reload from disk through the §3
        // cold-resume path, under the lock this engine already holds (kept, not released). An
        // active turn — or a turn/start still waiting for its presence keypress (M1-A5) — still
        // answers -32004.
        if (known.activeTurnId !== null) throw turnAlreadyActive(threadId, known.activeTurnId);
        if (known.confirming) throw turnAlreadyActive(threadId, null);
        let fresh: ThreadRecord;
        try {
          fresh = this.#loadColdThread(threadId, known.lock);
        } catch (err) {
          // Reload failure: the record is dropped and the lock released (or kept for shutdown);
          // poisoned inside the reload keeps the lock until exit (rule 3) and passes -32009.
          this.#threads.delete(threadId);
          if (this.#poisoned.has(threadId)) this.#strayLocks.push(known.lock);
          else this.#releaseOrKeep(known.lock);
          throw err;
        }
        this.#threads.set(threadId, fresh);
        const thread = fresh.thread;
        return { value: { thread }, after: () => this.#notify("thread/started", { thread }) };
      }
      // Known in this process: still verify we own the on-disk lock before resuming (§3.3); a
      // re-take reloads the thread from disk (Amendment 2 §3 — row (c): a lost lock is re-taken
      // even when the old writer was also broken).
      const current = this.#ensureLock(known);
      // M2 pin §2.1: a handoff target re-checks its link on EVERY thread/resume (a reload already
      // checked it inside #loadColdThread; a warm resume checks it here, against the files now).
      this.#handoffGate(current, true);
      const thread = current.thread;
      return { value: { thread }, after: () => this.#notify("thread/started", { thread }) };
    }

    // Lock first, then load under the lock (§3.3). A live foreign holder wins → -32004.
    const lock = acquireThreadLock(this.#opts.home, threadId);
    if (!lock.ok) throw turnAlreadyActive(threadId, null, lock.holderPid ?? undefined);

    const handle = lock.handle;
    let record: ThreadRecord;
    try {
      record = this.#loadColdThread(threadId, handle);
    } catch (err) {
      // Not found / unverifiable / seat error: release the lock we just took (or keep it for
      // shutdown if it cannot be released now — never orphan our own lock). Poisoned inside the
      // reload keeps the lock until exit (rule 3).
      if (this.#poisoned.has(threadId)) this.#strayLocks.push(handle);
      else this.#releaseOrKeep(handle);
      throw err;
    }
    this.#threads.set(threadId, record);
    const thread = record.thread;
    return { value: { thread }, after: () => this.#notify("thread/started", { thread }) };
  }

  /**
   * Cold resume under the thread lock (seat pin §4): verify `sessions/<threadId>.jsonl`, rebuild
   * thread + turns (engine state only; no model history replay), load the seat it was opened with,
   * and continue the chain. A turn whose `turn.end` is missing (engine died mid-turn) is closed as
   * `interrupted` by appending a `turn.end` event.
   */
  #loadColdThread(threadId: string, handle: LockHandle): ThreadRecord {
    const path = confinedPath(this.#opts.home, "sessions", threadId, ".jsonl");
    // lstat, not existsSync: a dangling symlink is not "not found"; verification refuses it (-32603).
    try {
      lstatSync(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") throw threadNotFound(threadId);
    }
    const verified = verifySessionFile(path, threadId, {}, this.#opts.home);
    if (!verified.ok) {
      this.#log(
        `session ${threadId} failed verification at line ${verified.line}: ${verified.reason}`,
      );
      throw internalError("Session record failed verification");
    }
    let rebuilt: RebuiltSession;
    try {
      rebuilt = rebuildSession(verified.events);
    } catch (err) {
      this.#log(
        `session ${threadId} could not be rebuilt: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw internalError("Session record failed verification");
    }
    const seat = loadSeat(this.#opts.home, rebuilt.thread.seatId);
    this.#noteSeatWarnings(seat);
    // verifySessionFile always reports the verified byte size; it is the §2 position bound.
    const verifiedSize = verified.size;
    if (verifiedSize === undefined) throw internalError("Session record failed verification");
    // M2: the `session.open` facts (rebuildSession checked their shape; a v1 open has neither key).
    const genesis = verified.events[0] as SessionEvent;
    const openPayload = genesis.payload as Record<string, unknown>;
    const open: SessionOpenFacts = {
      genesisHash: genesis.hash,
      handoff: (openPayload.handoff ?? null) as SessionOpenHandoffLink | null,
      worktree: (openPayload.worktree ?? null) as WorktreeIdentity | null,
    };
    // M2 pin §2.1: a handoff target's link is checked BEFORE any append of this load (the dangling
    // turn closes below included): a one-way target answers -32010 with nothing appended.
    if (open.handoff !== null) {
      const check = checkHandoffTarget(this.#opts.home, {
        threadId,
        seatId: rebuilt.thread.seatId,
        genesisHash: open.genesisHash,
        link: open.handoff,
      });
      if (!check.ok) {
        this.#log(`handoff gate ${threadId}: refused (${check.kind}): ${check.issues.join("; ")}`);
        throw evidenceInvalid({
          threadId,
          turnId: null,
          type: "session.open",
          reason: "handoff-one-way",
          issues: check.issues,
        });
      }
    }
    const session = SessionWriter.resume(
      path,
      threadId,
      rebuilt.thread.seatId,
      verified.nextSeq,
      verified.lastHash,
      () => this.#secrets(this.#threads.get(threadId)?.lock ?? handle),
      this.#opts.home,
      verified.file,
      // Amendment 2 §2: bound to this acquisition and to the verified byte size.
      { holdsLock: () => holdsThreadLock(handle), expectedSize: verifiedSize },
      {
        // Amendment 3 rule 4: a close that fails after a durable batch is logged, not fatal.
        onCloseFailed: (code) =>
          this.#log(`session ${threadId}: close failed after a durable append (${code})`),
      },
      // M2 (D-M2-A0-4): the writer holds the verified file as an index.
      SessionChainIndex.fromEvents(verified.events),
    );
    if (rebuilt.danglingTurnIds.length > 0) {
      // All dangling turns close in ONE append batch (Copilot r4107434889): either every
      // `turn.end` is durable or none is (rolled back), so a failed reload / resume never leaves a
      // partially recovered file. rebuildSession gives every dangling turn the same completedAt;
      // that is the batch ts, and the thread's updatedAt covers the close.
      const closedAt =
        rebuilt.turns.find((t) => t.id === rebuilt.danglingTurnIds[0])?.completedAt ?? Date.now();
      let events: SessionEvent[];
      try {
        events = session.appendAll(
          rebuilt.danglingTurnIds.map((turnId) => ({
            type: "turn.end" as const,
            payload: { turnId, status: "interrupted" as const, error: null },
          })),
          closedAt,
        );
      } catch (err) {
        // Amendment 3 item 1 "Poisoned inside a reload": if the rollback of this close batch
        // failed, C2 adds the thread to #poisoned and rule 3's line is logged once. The request
        // then answers the append's own -32009; the caller keeps the lock until exit (rule 3)
        // instead of releasing it, and no record is kept.
        this.#notePoisoned(threadId, session);
        throw err;
      }
      for (const event of events) {
        rebuilt.thread.updatedAt = Math.max(rebuilt.thread.updatedAt, event.ts);
      }
    }
    const turns = new Map<string, TurnRecord>();
    for (const turn of rebuilt.turns) {
      turns.set(turn.id, {
        turn,
        controller: new AbortController(),
        open: new Map(),
        finalizing: true,
      });
    }
    return {
      thread: rebuilt.thread,
      lock: handle,
      turns,
      activeTurnId: null,
      seat,
      session,
      // M1-A5: a presence confirmation never survives a reload; the next gated turn asks again.
      confirmedTerminal: null,
      confirming: false,
      open,
      // The link was checked above for this load; the first turn/start checks it again (§2.1).
      handoffVerified: false,
    };
  }

  #threadList(params: unknown): ThreadListResult {
    const p = paramsObject(params);
    const issues: string[] = [];
    let limit = THREAD_LIST_DEFAULT_LIMIT;
    if (p.limit !== undefined) {
      if (typeof p.limit !== "number" || !Number.isInteger(p.limit) || p.limit < 1) {
        issues.push("limit must be a positive integer");
      } else {
        limit = Math.min(p.limit, THREAD_LIST_MAX_LIMIT);
      }
    }
    if (p.cursor !== undefined && !isValidId(p.cursor)) issues.push("cursor is invalid");
    throwIfIssues(issues);

    const all = [...[...this.#threads.values()].map((r) => r.thread), ...this.#diskThreads()].sort(
      (a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
    );
    let start = 0;
    if (typeof p.cursor === "string") {
      const idx = all.findIndex((t) => t.id === p.cursor);
      if (idx === -1) throw invalidParams(["cursor is invalid"]);
      start = idx + 1;
    }
    const page = all.slice(start, start + limit);
    const last = page.at(-1);
    return {
      data: page.map(({ id, seatId, createdAt, updatedAt, preview, status }) => ({
        id,
        seatId,
        createdAt,
        updatedAt,
        preview,
        status,
      })),
      nextCursor: start + limit < all.length && last !== undefined ? last.id : null,
    };
  }

  /**
   * Threads recorded on disk but not loaded in this process (durable store, seat pin §4). Read-only:
   * no lock is taken. A file that does not verify is skipped (and logged), never listed.
   */
  #diskThreads(): Thread[] {
    let names: string[];
    try {
      names = readdirSync(join(this.#opts.home, "sessions"));
    } catch {
      return [];
    }
    const out: Thread[] = [];
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const threadId = name.slice(0, -".jsonl".length);
      if (!isValidId(threadId) || this.#threads.has(threadId)) continue;
      let path: string;
      try {
        path = confinedPath(this.#opts.home, "sessions", threadId, ".jsonl");
      } catch {
        continue;
      }
      const verified = verifySessionFile(path, threadId, {}, this.#opts.home);
      if (!verified.ok) {
        this.#log(`thread/list: skipping ${threadId} (session failed verification)`);
        continue;
      }
      try {
        out.push(rebuildSession(verified.events).thread);
      } catch {
        this.#log(`thread/list: skipping ${threadId} (session could not be rebuilt)`);
      }
    }
    return out;
  }

  /**
   * Verify this process still owns the thread's lock file; re-take it or yield (-32004). Returns
   * the record to use from now on.
   *
   * Amendment 2 §3: after a re-take the in-memory writer and thread state are stale (another engine
   * may have appended while we did not hold the lock), so they are discarded and the thread is
   * reloaded from disk under the new lock through the cold-resume path (verify, rebuild, close
   * dangling turns as `interrupted`). If that fails, the request fails exactly as a cold resume
   * (-32002 / -32603), the new lock is released, the file is untouched, and the thread is no longer
   * loaded here. A thread with a turn still running in this process is never re-taken (-32004):
   * that turn's own appends fail -32009 on the lost lock.
   */
  #ensureLock(record: ThreadRecord): ThreadRecord {
    if (holdsThreadLock(record.lock)) return record;
    const threadId = record.thread.id;
    if (record.activeTurnId !== null) throw turnAlreadyActive(threadId, record.activeTurnId);
    // M1-A5: a turn/start waiting for its presence keypress holds this record; never swap it out.
    if (record.confirming) throw turnAlreadyActive(threadId, null);
    const lock = acquireThreadLock(this.#opts.home, threadId);
    if (!lock.ok) throw turnAlreadyActive(threadId, null, lock.holderPid ?? undefined);
    this.#threads.delete(threadId);
    let fresh: ThreadRecord;
    try {
      fresh = this.#loadColdThread(threadId, lock.handle);
    } catch (err) {
      // Poisoned inside the reload: the lock is kept until exit (rule 3), never released here.
      if (this.#poisoned.has(threadId)) this.#strayLocks.push(lock.handle);
      else this.#releaseOrKeep(lock.handle);
      throw err;
    }
    this.#threads.set(threadId, fresh);
    return fresh;
  }

  // -------------------------------------------------------------------- turns

  #turnStart(params: unknown): DispatchResult | Promise<DispatchResult> {
    const p = paramsObject(params);
    const issues: string[] = [];
    const threadId = requireId(p, "threadId", issues);
    const input = parseUserInput(p.input, issues);
    // M1-A5 (P3): the client's mode claim; absent → headless (fail-closed).
    const claim = parseModeClaim(p.mode, issues);
    throwIfIssues(issues);

    // Parameter validation, -32002 and -32004 stay first and unchanged (Amendment 3 C3).
    let record = this.#threads.get(threadId);
    if (record === undefined) throw threadNotFound(threadId);
    if (record.activeTurnId !== null) throw turnAlreadyActive(threadId, record.activeTurnId);
    // M1-A5: one turn/start per thread at a time, including one still waiting for its keypress.
    if (record.confirming) throw turnAlreadyActive(threadId, null);
    // C3 step 1: a poisoned thread answers -32009 with the C2 entry's path and first refused seq.
    const poisoned = this.#poisoned.get(threadId);
    if (poisoned !== undefined) throw sessionWriteFailed(threadId, poisoned.path, poisoned.seq);
    // C3 step 2: a lost lock is re-taken and the thread reloaded from disk BEFORE anything else
    // (rule 6 row (c); re-take errors now come before preflight refusals, and the re-take and
    // reload run even when preflight would then refuse). A failed reload follows "Reload failure".
    if (!holdsThreadLock(record.lock)) {
      record = this.#ensureLock(record);
    }
    // C3 step 3: a broken writer answers -32009 (rule 6 rows (a)/(b): only thread/resume reloads
    // it, or nothing in this process does). This runs before preflight even after a re-take.
    if (record.session.broken) {
      throw sessionWriteFailed(threadId, record.session.path, record.session.nextSeq);
    }
    // M2 pin §2.1 (between C3 steps 3 and 4): a handoff target serves only on a verified two-way
    // link, checked here before the first turn of this load — before the presence phase, the repo
    // gate (whose `repo.decision` would be an append) and preflight. Nothing is appended on refusal.
    this.#handoffGate(record);
    const ctx = this.#turnContext(record, input);
    // M1-A4: the repo-policy gate runs before preflight (D-M1-8 must be observable on a clean
    // install), and its pinned receipt names the turn it gated — so the turn id is minted here.
    // Minting an id is pure, so Amendment 3 C3's ordering (preflight at step 4, the `turn.start`
    // append at step 5) is unchanged.
    const turnId = newId("turn");

    // M1-A5 presence phase (M1 plan §7 M1-A5; protocol pin §3.3 P3). It runs before the repo gate
    // and before preflight, so a lane that needs a person is refused before any provider call and
    // before any repo decision when there is no terminal to check.
    const backing = getById(record.seat.seat.preferredBacking);
    const phase = this.#presencePhase(record, claim, backing);
    if (phase.kind === "absent") throw this.#presenceRefusal(record, backing, phase.why);
    // The lane serves the claim from here on: presence is verified, pending, or not needed.
    this.#repoGate(record, turnId, claim);
    if (phase.kind === "pending") {
      const pendingRecord = record;
      return this.#awaitPresence(pendingRecord, phase.facts).then((confirmed) => {
        if (!confirmed) throw this.#presenceRefusal(pendingRecord, backing, "not confirmed");
        return this.#beginTurn(pendingRecord, ctx, turnId, input, claim, {
          presence: "verified",
          tty: { ...phase.facts, confirmation: "keypress" },
        });
      });
    }
    return this.#beginTurn(
      record,
      ctx,
      turnId,
      input,
      claim,
      phase.kind === "verified"
        ? { presence: "verified", tty: { ...phase.facts, confirmation: "carried" } }
        : { presence: "absent" },
    );
  }

  /**
   * C3 steps 4–5 and the turn itself, once every gate before preflight has passed: preflight exactly
   * once against the record that will append, then the durable `turn.start` (now with the claim,
   * the presence result and — when verified — the TTY facts, seat pin §4.2 S4), then the turn.
   */
  #beginTurn(
    record: ThreadRecord,
    ctx: Omit<AgentTurnContext, "turnId">,
    turnId: string,
    input: UserInput[],
    claim: TurnMode,
    presence: TurnPresence,
  ): DispatchResult {
    const threadId = record.thread.id;
    const turnCtx: Omit<AgentTurnContext, "turnId"> = {
      ...ctx,
      mode: claim,
      presence: presence.presence,
    };
    // C3 step 4: seat / registry / credential preflight, exactly once, against the record that
    // will append (the reloaded record after a re-take; D-162). A refusal after a re-take leaves
    // the re-taken lock held by this process, as any refused turn/start does.
    this.#opts.agent.preflight?.(turnCtx);

    const now = Date.now();
    // turn.start is durable before the turn exists: an append failure is a -32009 response error.
    try {
      // C3 step 5: only after preflight, append turn.start.
      record.session.append(
        "turn.start",
        {
          turnId,
          inputText: input.map((part) => part.text).join("\n"),
          mode: claim,
          presence: presence.presence,
          ...(presence.tty === undefined ? {} : { tty: presence.tty }),
        },
        now, // == turn.startedAt
      );
    } catch (err) {
      this.#notePoisoned(threadId, record.session);
      throw err;
    }
    const turn: Turn = {
      id: turnId,
      threadId,
      status: "inProgress",
      items: [],
      error: null,
      startedAt: now,
      completedAt: null,
    };
    const turnRecord: TurnRecord = {
      turn,
      controller: new AbortController(),
      open: new Map(),
      finalizing: false,
    };
    record.turns.set(turn.id, turnRecord);
    record.activeTurnId = turn.id;
    record.thread.status = "active";
    record.thread.updatedAt = now;
    if (record.thread.preview === "") record.thread.preview = input[0]?.text ?? "";

    const snapshot = structuredClone(turn);
    return {
      value: { turn: snapshot },
      after: () => {
        this.#notify("turn/started", { turn: structuredClone(turn) });
        this.#runTurn(record, turnRecord, { ...turnCtx, turnId: turn.id });
      },
    };
  }

  // ----------------------------------------------------------------- presence

  /** Lazily created so an engine that never gates a turn on presence never opens `/dev/tty`. */
  #terminalAccess(): PresenceTerminal {
    this.#terminal ??= this.#opts.terminal ?? createSystemTerminal();
    return this.#terminal;
  }

  /**
   * M1-A5: decide the presence phase of one turn on the seat's assigned backing. Only a lane that
   * needs a person (`presence/policy.ts`) is checked, and it is checked on EVERY such turn: the
   * engine opens its own controlling terminal, never trusting the client's claim. A terminal that
   * is gone or differs from the confirmed one voids the confirmation — this turn is refused and the
   * next one needs a fresh keypress on a live terminal.
   */
  #presencePhase(
    record: ThreadRecord,
    claim: TurnMode,
    backing: ProviderEntry | undefined,
  ): PresencePhase {
    if (!presenceRequired(backing)) return { kind: "not-required" };
    if (claim !== "interactive") return { kind: "absent", why: "the turn is headless" };
    const terminal = this.#terminalAccess();
    const facts = terminal.probe();
    if (facts === null) {
      record.confirmedTerminal = null;
      return { kind: "absent", why: terminal.unsupported ?? "no controlling terminal" };
    }
    const confirmed = record.confirmedTerminal;
    if (confirmed === null) return { kind: "pending", facts };
    if (!sameTerminal(confirmed, facts)) {
      record.confirmedTerminal = null;
      return { kind: "absent", why: "the controlling terminal changed since confirmation" };
    }
    return { kind: "verified", facts };
  }

  /**
   * The refusal for a presence-gated lane without verified presence: the lane's OWN headless denial
   * from the registry (`interactive-only-headless` for the interactive-only plans,
   * `headless-not-permitted` for a headless-denied direct lane), as -32007 before any network call.
   */
  #presenceRefusal(
    record: ThreadRecord,
    backing: ProviderEntry | undefined,
    why: string,
  ): RpcError {
    const providerId = record.seat.seat.preferredBacking;
    this.#log(`presence ${providerId}: absent (${why}); turn refused`);
    if (backing !== undefined) {
      try {
        checkEntry(backing, {
          providerId,
          mode: "headless",
          connect: backing.connect === "vendor-agent" ? "vendor-agent" : "direct",
        });
      } catch (err) {
        if (err instanceof RegistryDeniedError) {
          return providerRefusalError({
            providerId: err.providerId,
            reason: err.reason,
            status: backing.status,
          });
        }
        throw err;
      }
    }
    // Unreachable for a presence-gated lane (it never serves headless); fail closed regardless.
    return providerRefusalError({
      providerId,
      reason: "interactive-only-headless",
      status: backing?.status ?? null,
    });
  }

  /**
   * M1-A5: the first presence-gated turn on a thread asks for a keypress on the engine's own
   * controlling terminal (never over the protocol pipe). Prompts are queued engine-wide, so only one
   * is ever on the terminal. While it waits, the thread accepts no other turn/start and cannot be
   * reloaded; EOF or a signal aborts the wait (queued or prompting). Resolves true only when the
   * person confirmed AND the terminal is still the one the prompt was written to — the confirmation
   * then binds to that terminal for later turns on this thread in this process.
   */
  async #awaitPresence(record: ThreadRecord, facts: TerminalFacts): Promise<boolean> {
    const threadId = record.thread.id;
    const controller = new AbortController();
    record.confirming = true;
    this.#pendingConfirmations.add(controller);
    const previous = this.#confirmationTail;
    let release = (): void => {};
    this.#confirmationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    let confirmed: boolean;
    try {
      await previous; // one prompt on the terminal at a time
      confirmed = controller.signal.aborted
        ? false
        : await this.#terminalAccess().confirm(
            presencePrompt(record.seat.seat.id, record.seat.seat.preferredBacking),
            controller.signal,
          );
    } catch {
      confirmed = false;
    } finally {
      release();
      record.confirming = false;
      this.#pendingConfirmations.delete(controller);
    }
    // The world may have moved while the person was reading the prompt.
    if (this.#shutDown) throw internalError("Engine is shutting down");
    if (this.#threads.get(threadId) !== record || !holdsThreadLock(record.lock)) {
      throw turnAlreadyActive(threadId, null);
    }
    if (!confirmed) {
      record.confirmedTerminal = null;
      return false;
    }
    // The keypress binds to the terminal it was typed on: re-probe after it.
    const after = this.#terminalAccess().probe();
    if (after === null || !sameTerminal(after, facts)) {
      record.confirmedTerminal = null;
      return false;
    }
    record.confirmedTerminal = facts;
    return true;
  }

  #turnInterrupt(params: unknown): { value: Record<string, never>; after?: () => void } {
    const p = paramsObject(params);
    const issues: string[] = [];
    const threadId = requireId(p, "threadId", issues);
    const turnId = requireId(p, "turnId", issues);
    throwIfIssues(issues);

    const record = this.#threads.get(threadId);
    if (record === undefined) throw threadNotFound(threadId);
    const turnRecord = record.turns.get(turnId);
    if (turnRecord === undefined) throw turnNotFound(threadId, turnId);
    if (turnRecord.turn.status !== "inProgress") return { value: {} };
    return { value: {}, after: () => this.#finishTurn(record, turnRecord, "interrupted") };
  }

  #turnContext(record: ThreadRecord, input: UserInput[]): Omit<AgentTurnContext, "turnId"> {
    return {
      threadId: record.thread.id,
      seatId: record.thread.seatId,
      seat: record.seat.seat,
      seatPath: record.seat.path,
      input,
      // M1-A4: context only. A repo-gated provider's identity is resolved by the engine from this
      // path (seat pin §5); the string itself is never matched against an allowlist.
      cwd: record.thread.cwd,
    };
  }

  /**
   * Durable record of one completed item (seat pin §4.2): an `item` event, plus the dedicated
   * `servedModel` event for a receipt (dual write). The receipt pair is one append (`appendAll`):
   * both lines are durable or neither is. Returns false after a -32009 failure, which fails the
   * turn.
   */
  #persistItem(record: ThreadRecord, tr: TurnRecord, item: Item): boolean {
    const turnId = tr.turn.id;
    try {
      if (item.kind === "servedModel") {
        record.session.appendAll([
          { type: "item", payload: { turnId, item } },
          {
            type: "servedModel",
            payload: {
              turnId,
              requestedModel: item.requestedModel,
              servedModel: item.servedModel,
              backing: item.backing,
              providerId: item.providerId,
              lane: item.lane,
              mode: item.mode,
              fallbackFrom: item.fallbackFrom,
              vendorReported: item.vendorReported,
            },
          },
        ]);
      } else {
        record.session.append("item", { turnId, item });
      }
      return true;
    } catch (err) {
      if (!(err instanceof RpcError)) throw err;
      this.#notePoisoned(record.thread.id, record.session);
      this.#finishTurn(record, tr, "failed", err.toBody());
      return false;
    }
  }

  /** Append during the terminal transition; the turn is already ending, so failures are logged. */
  #appendFinal<T extends SessionEventType>(
    record: ThreadRecord,
    type: T,
    payload: SessionPayloads[T],
    ts?: number,
  ): SessionPayloads[T] | null {
    try {
      return record.session.append(type, payload, ts).payload;
    } catch (err) {
      this.#notePoisoned(record.thread.id, record.session);
      this.#log(
        `session append failed (${type}): ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  #runTurn(record: ThreadRecord, tr: TurnRecord, ctx: AgentTurnContext): void {
    const { input } = ctx;
    const { turn } = tr;
    const live = () => turn.status === "inProgress" && !tr.finalizing;
    const sink: TurnSink = {
      signal: tr.controller.signal,
      newItemId: () => newId("item"),
      startItem: (item) => {
        if (!live() || !isValidId(item.id) || tr.open.has(item.id)) return;
        const started = { ...item, status: "inProgress" } as Item;
        tr.open.set(item.id, started);
        this.#notify("item/started", { threadId: turn.threadId, turnId: turn.id, item: started });
      },
      delta: (itemId, delta) => {
        const open = tr.open.get(itemId);
        if (!live() || open === undefined || open.kind !== "agentMessage") return;
        open.text += delta;
        this.#notify("item/agentMessage/delta", {
          threadId: turn.threadId,
          turnId: turn.id,
          itemId,
          delta,
        });
      },
      completeItem: (item) => {
        if (!live() || !tr.open.has(item.id)) return;
        // The engine owns the lifecycle: a completed item is `completed`, whatever the agent sent.
        const completed = { ...item, status: "completed" } as Item;
        if (completed.kind === "servedModel") {
          // A receipt is durable (item + servedModel event) before it is exposed. If that append
          // fails, the turn fails and the still-open receipt is closed as `failed`, never
          // `completed`, and nothing of it is on disk.
          if (!this.#persistItem(record, tr, completed)) return;
          tr.open.delete(item.id);
          turn.items.push(completed);
          this.#notify("item/completed", {
            threadId: turn.threadId,
            turnId: turn.id,
            item: completed,
          });
          return;
        }
        tr.open.delete(item.id);
        turn.items.push(completed);
        this.#notify("item/completed", {
          threadId: turn.threadId,
          turnId: turn.id,
          item: completed,
        });
        this.#persistItem(record, tr, completed);
      },
      fallbackRejected: (payload) => {
        // Durable same-lane rejection (seat pin §4.2) — recorded before the paired error item so
        // the JSONL order is event-then-item. A failed append poisons and fails the turn, exactly
        // like #persistItem: a rejection that is not durable is not claimed. The `false` returns
        // halt the agent's fallback walk immediately (Copilot 4131965600): the turn is finalized,
        // so no further candidate may be built or called and no further item may be emitted.
        if (!live()) return false;
        try {
          record.session.append("fallback.rejected", payload);
          return true;
        } catch (err) {
          if (!(err instanceof RpcError)) throw err;
          this.#notePoisoned(record.thread.id, record.session);
          this.#finishTurn(record, tr, "failed", err.toBody());
          return false;
        }
      },
      repoDecision: (payload) => {
        // M1-A4: the durable `repo.decision` receipt for a repo-gated FALLBACK CANDIDATE (the
        // assigned backing is gated inside `turn/start`). Same durability rule as
        // `fallbackRejected`: a failed append poisons and fails the turn, and the `false` return
        // stops the agent from building or calling that candidate.
        if (!live()) return false;
        try {
          record.session.append("repo.decision", payload);
          return true;
        } catch (err) {
          if (!(err instanceof RpcError)) throw err;
          this.#notePoisoned(record.thread.id, record.session);
          this.#finishTurn(record, tr, "failed", err.toBody());
          return false;
        }
      },
    };

    const userItem: Item = {
      id: newId("item"),
      kind: "userMessage",
      status: "completed",
      content: input.map((part) => ({ type: "text", text: part.text })),
    };
    sink.startItem(userItem);
    sink.completeItem(userItem);
    if (!live()) return; // the user item could not be recorded (-32009): never call the agent

    Promise.resolve()
      .then(() => this.#opts.agent.run(ctx, sink))
      .then(
        () => {
          if (live()) this.#finishTurn(record, tr, "completed");
        },
        (err: unknown) => {
          if (!live()) return;
          const body: RpcErrorBody =
            err instanceof RpcError
              ? err.toBody()
              : { code: ErrorCode.InternalError, message: "Agent failed" };
          if (!(err instanceof RpcError)) {
            this.#log(`agent error: ${err instanceof Error ? err.message : String(err)}`);
          }
          this.#finishTurn(record, tr, "failed", body);
        },
      );
  }

  /** Terminal transition. Open items close as `failed`; a failed turn also gets an `error` item. */
  #finishTurn(
    record: ThreadRecord,
    tr: TurnRecord,
    status: Exclude<TurnStatus, "inProgress">,
    error: RpcErrorBody | null = null,
  ): void {
    const { turn } = tr;
    if (turn.status !== "inProgress" || tr.finalizing) return;
    // Close the sink BEFORE abort: abort listeners run synchronously and must not emit or mutate.
    tr.finalizing = true;
    tr.controller.abort();
    const ref = { threadId: turn.threadId, turnId: turn.id };
    for (const item of tr.open.values()) {
      const closed = { ...item, status: "failed" } as Item;
      turn.items.push(closed);
      this.#notify("item/completed", { ...ref, item: closed });
      this.#appendFinal(record, "item", { turnId: turn.id, item: closed });
    }
    tr.open.clear();
    if (status === "failed" && error !== null) {
      const errItem: Item = {
        id: newId("item"),
        kind: "error",
        status: "completed",
        message: error.message,
        code: error.code,
      };
      this.#notify("item/started", { ...ref, item: { ...errItem, status: "inProgress" } as Item });
      turn.items.push(errItem);
      this.#notify("item/completed", { ...ref, item: errItem });
      this.#appendFinal(record, "item", { turnId: turn.id, item: errItem });
    }
    const now = Date.now();
    let finalStatus = status;
    let finalError = status === "failed" ? error : null;
    try {
      record.session.append(
        "turn.end",
        {
          turnId: turn.id,
          status,
          error:
            finalError === null ? null : { code: finalError.code, message: finalError.message },
        },
        now, // == turn.completedAt
      );
    } catch (err) {
      this.#notePoisoned(record.thread.id, record.session);
      this.#log(
        `session append failed (turn.end): ${err instanceof Error ? err.message : String(err)}`,
      );
      // Never acknowledge a completion that is not durable: the record would say the turn never
      // ended. Interrupted / failed turns already match what cold resume rebuilds (dangling →
      // interrupted) or report an error, so only `completed` is downgraded.
      if (status === "completed" && err instanceof RpcError) {
        finalStatus = "failed";
        finalError = err.toBody();
        const errItem: Item = {
          id: newId("item"),
          kind: "error",
          status: "completed",
          message: finalError.message,
          code: finalError.code,
        };
        this.#notify("item/started", {
          ...ref,
          item: { ...errItem, status: "inProgress" } as Item,
        });
        turn.items.push(errItem);
        this.#notify("item/completed", { ...ref, item: errItem });
      }
    }
    turn.status = finalStatus;
    turn.error = finalError;
    turn.completedAt = now;
    record.activeTurnId = null;
    record.thread.status = "idle";
    record.thread.updatedAt = now;
    this.#notify("turn/completed", { turn: structuredClone(turn) });
  }

  // ------------------------------------------------------------------ output

  #notify<M extends keyof ServerNotifications>(method: M, params: ServerNotifications[M]): void {
    this.#send({ method, params });
  }

  #send(message: Parameters<typeof encodeMessage>[0]): void {
    if (this.#closed) return;
    try {
      this.#opts.output.write(encodeMessage(message));
    } catch {
      this.#onOutputFailure();
    }
  }

  #log(message: string): void {
    (this.#opts.log ?? ((m: string) => process.stderr.write(`[madc-engine] ${m}\n`)))(message);
  }
}

export function runEngine(opts: EngineOptions): Promise<void> {
  return new EngineConnection(opts).run();
}
