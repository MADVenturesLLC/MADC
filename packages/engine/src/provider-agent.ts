/**
 * Live-provider agent (Acts M0-A3 / A5 / A6; M1-A3). The engine loads and validates the thread's
 * seat file at `thread/start` / `thread/resume` (A4) and hands it over in the turn context. Every
 * turn runs a synchronous preflight inside `turn/start` (protocol pin §4.2) before any model or
 * vendor call:
 *
 * 1. registry `assertAllowed` with `requireLive: true` (unwired → -32008, other denials → -32007);
 * 2. the backing has an adapter in this build (else -32008 `unwired`);
 * 3. `pinnedModel` resolves for that backing — the pinned pi-ai catalog for kimi-code, the live
 *    `/api/tags` list for ollama-cloud (shape-checked here, membership at call time), a non-empty
 *    vendor model name for claude-code (else -32006 with the seat file path);
 * 4. the backing can run: direct lanes need a usable credential (else -32008 `no-credentials`);
 *    claude-code / codex / grok-build need their unmodified binary detected on PATH (else -32008
 *    `binary-missing`).
 *
 * Preflight is side-effect free (no port, no child process; binary detection is a read-only PATH
 * lookup, never an execution). Only `run` builds ports and streams the current input: deltas →
 * one `agentMessage`, followed by a `servedModel` receipt (protocol pin §5, P2 fields since M1-A3).
 * Earlier turns are not replayed to the model in M0-A4 (Surface ruling on PR #12, item 12).
 *
 * M1-A3 fallback (plan §6, D-M1-7 same-lane rule): when a direct call records the
 * `quota-or-unreachable` signal (HTTP 429/502), the attempt is written up as an `error` item and
 * the seat's ordered `fallbacks` are considered. A candidate is eligible only if its registry
 * `status` AND `credentialClass` equal the assigned backing's lane; a mismatch is rejected BEFORE
 * any call with the pinned `fallback.rejected` session event plus an `error`-style item naming
 * both lanes. Eligible candidates must also pass `assertAllowed` for the turn's mode and have
 * credentials/binary present, else they are skipped with a log line (never into forbidden,
 * interactive-only or headless-denied lanes). Every served hop receipts `fallbackFrom` honestly.
 * If no candidate serves, the turn fails with the PRIMARY's error (-32008 `quota-or-unreachable`).
 * Non-quota failures keep the M0 path (no fallback): -32603, or -32008 for `binary-missing`.
 *
 * A `-32008` raised after `turn/start` has returned (e.g. the vendor binary vanishes between
 * preflight and spawn, or Grok Build reports no usable sign-in) ends the turn `failed` per protocol
 * pin §4.2.
 *
 * M1-A6 (Grok Build over the generic ACP client): the vendor agent's own tool activity becomes
 * `toolCall` / `toolResult` items — a `toolCall` opens at the first sight of a call and completes
 * with its final input when the call reaches a terminal status, immediately followed by its
 * `toolResult` (`callId` = the toolCall item id). A call still open when the vendor turn ends is
 * completed without a result, before the `agentMessage`, so the happy-path order stays
 * `userMessage` → tool items → `agentMessage` → `servedModel` (protocol pin §5).
 *
 * M1-A5: every `assertAllowed` check uses the turn's mode claim, except that a lane needing a person
 * (interactive-only, or direct with headless denied) is checked as `headless` unless the engine
 * verified presence for this turn — so it is refused with its own headless reason. The receipt's
 * `mode` is the claim (`headless` when absent). This agent never probes the terminal itself.
 */
import {
  CLAUDE_CODE_PROVIDER_ID,
  CODEX_PROVIDER_ID,
  findClaudeBinary,
  findCodexBinary,
  findGrokBinary,
  GROK_BUILD_PROVIDER_ID,
  KIMI_CODE_PROVIDER_ID,
  type KimiCredential,
  type PinnedModelResolution,
  ProviderCallError,
  type ProviderPort,
  type ProviderToolEvent,
  type ProviderTurnResult,
  resolveClaudePinnedModel,
  resolveCodexPinnedModel,
  resolveGrokPinnedModel,
  resolveKimiPinnedModel,
} from "@madc/adapters";
import {
  assertAllowed,
  type ConnectPreference,
  canServe,
  getById,
  type ProviderEntry,
  RegistryDeniedError,
} from "@madc/registry";
import type { Agent, AgentTurnContext, TurnPreflightContext, TurnSink } from "./agent.ts";
import { type RepoIdentityDeps, resolveRepoIdentity } from "./policy/identity.ts";
import { denyAllRepoPolicy, isRepoGated, type RepoPolicy } from "./policy/store.ts";
import { effectiveLaneMode } from "./presence/policy.ts";
import {
  ErrorCode,
  internalError,
  type ProviderUnavailableData,
  providerRefusalError,
  RpcError,
  type SeatInvalidData,
} from "./protocol/errors.ts";
import {
  DEFAULT_TURN_MODE,
  type Item,
  type ServedModelItem,
  type TurnMode,
} from "./protocol/types.ts";
import { laneMismatch } from "./seats/lane.ts";

/**
 * One registry-driven direct-key lane (M1-A3): the credential resolved at engine start through the
 * M1-A2 store (null = absent), the port factory, and the lane's `pinnedModel` resolver.
 */
export type DirectLane = {
  readonly providerId: string;
  readonly credential: string | null;
  readonly createPort: (apiKey: string) => ProviderPort;
  readonly resolvePinnedModel: (pinnedModel: string) => PinnedModelResolution;
};

export type ProviderAgentOptions = {
  /**
   * M0 legacy kimi wiring (kept so M0 tests and fixtures pass unchanged): resolved once at engine
   * start; the key itself never leaves the adapter. Superseded by a `kimi-code` entry in
   * `directLanes` when both are present.
   */
  readonly credential?: KimiCredential;
  /** M0 legacy: builds the Kimi port for a validated credential (tests inject a fake transport). */
  readonly createPort?: (apiKey: string) => ProviderPort;
  /** M1-A3: registry-driven direct-key lanes (kimi-code, ollama-cloud; A4/A5 add more). */
  readonly directLanes?: readonly DirectLane[];
  /**
   * I1 (D-M1-6): the registry freshness clock for the turn-time preflight, as unix ms. The engine
   * supplies it on every real turn so a stale allow entry denies (reason `terms-stale`) BEFORE any
   * network call — the same rule doctor's lanes report already shows. Absent reads as the real
   * system clock; tests inject a fixed instant, and the test harness pins the seam so suites stay
   * deterministic past the catalog's freshness window.
   */
  readonly assertAllowedNow?: number;
  /**
   * A5: builds the Claude Code port for a detected binary path. Its presence means the claude-code
   * adapter is in this build (production always passes it; kimi-only fixtures omit it).
   */
  readonly createClaudePort?: (binaryPath: string) => ProviderPort;
  /**
   * A5: how the `claude` binary is detected. Default: read-only PATH lookup at preflight time.
   * Tests inject a fixed answer.
   */
  readonly detectClaudeBinary?: () => string | null;
  /**
   * A6: builds the Codex port for a detected binary path. Its presence means the codex adapter is
   * in this build (production always passes it; fixtures without it keep the -32008 `unwired`
   * path honest).
   */
  readonly createCodexPort?: (binaryPath: string) => ProviderPort;
  /**
   * A6: how the `codex` binary is detected. Default: read-only PATH lookup at preflight time.
   * Tests inject a fixed answer.
   */
  readonly detectCodexBinary?: () => string | null;
  /**
   * M1-A6: builds the Grok Build port (generic ACP client) for a detected binary path. Its presence
   * means the grok-build adapter is in this build (production always passes it; fixtures without
   * it keep the -32008 `unwired` path honest).
   */
  readonly createGrokPort?: (binaryPath: string) => ProviderPort;
  /**
   * M1-A6: how the `grok` binary is detected. Default: read-only PATH lookup at preflight time.
   * Tests inject a fixed answer.
   */
  readonly detectGrokBinary?: () => string | null;
  /** stderr logger (never receives secrets or upstream text). */
  readonly log?: (line: string) => void;
  /**
   * M1-A4: the loaded `$MADC_HOME/policy.json` repo allowlists (seat pin §5). Used here ONLY for
   * fallback candidates — the seat's assigned backing is gated by the engine inside `turn/start`
   * (protocol pin §4.2), and gating it twice would write two receipts for one decision. Default:
   * deny-everywhere, so "fallbacks never move into a repo-denied provider" holds even unwired.
   */
  readonly repoPolicy?: RepoPolicy;
  /** M1-A4 test seam: `realpath` / `git` injection for repo-identity resolution. */
  readonly repoIdentityDeps?: RepoIdentityDeps;
};

type TurnPlan =
  | {
      readonly kind: "direct";
      readonly providerId: string;
      readonly lane: DirectLane;
      readonly modelId: string;
    }
  | {
      readonly kind: "vendor";
      readonly providerId: typeof CLAUDE_CODE_PROVIDER_ID;
      readonly binaryPath: string;
      readonly modelId: string;
    }
  | {
      readonly kind: "vendor";
      readonly providerId: typeof CODEX_PROVIDER_ID;
      readonly binaryPath: string;
      readonly modelId: string;
    }
  | {
      readonly kind: "vendor";
      readonly providerId: typeof GROK_BUILD_PROVIDER_ID;
      readonly binaryPath: string;
      readonly modelId: string;
    };

/**
 * Outcome of considering the seat's fallback list (Copilot 4131965600): `attempt` carries the
 * next candidate worth a call; `none` means the list is exhausted (the primary's error stands);
 * `halt` means a `fallback.rejected` record failed to persist — the session is poisoned and the
 * turn is already finalized, so the walk stops without emitting, building or calling anything.
 */
type Walk =
  | { readonly kind: "attempt"; readonly plan: TurnPlan }
  | { readonly kind: "none" }
  | { readonly kind: "halt" };

const NONE: Walk = Object.freeze({ kind: "none" });
const HALT: Walk = Object.freeze({ kind: "halt" });

/** The turn's mode claim (P3): absent → `headless`, fail-closed (M0-era contexts carry none). */
function turnMode(ctx: TurnPreflightContext): TurnMode {
  return ctx.mode ?? DEFAULT_TURN_MODE;
}

/**
 * M1-A5: the mode a lane is asked to serve on this turn — the claim, except that a lane needing a
 * person sees `headless` unless the ENGINE verified presence for this turn (`presence/policy.ts`).
 * One rule for the primary, every fallback candidate and the fallback repo gate, so a claim alone
 * can never move a turn into an interactive-only or headless-denied lane.
 */
function laneMode(entry: ProviderEntry | undefined, ctx: TurnPreflightContext): TurnMode {
  return effectiveLaneMode(entry, turnMode(ctx), ctx.presence ?? "absent");
}

/** Intent `connect` per seat pin §2: from the registry entry; unknown ids fail closed as direct. */
function connectFor(entry: ProviderEntry | undefined): ConnectPreference {
  return entry?.connect === "vendor-agent" ? "vendor-agent" : "direct";
}

function providerUnavailable(
  providerId: string,
  reason: ProviderUnavailableData["reason"],
): RpcError {
  return new RpcError(ErrorCode.ProviderUnavailable, "Provider unavailable", {
    providerId,
    reason,
  } satisfies ProviderUnavailableData);
}

/**
 * I1: the test-only freshness clock pin (unix ms), or undefined. Valid iff a non-negative safe
 * integer — anything else is IGNORED, never trusted: a malformed pin must not widen a lane, and
 * the real clock denies a stale entry exactly as a valid pin would have.
 */
function parseRegistryTestNow(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export function createProviderAgent(options: ProviderAgentOptions): Agent {
  // I1: freshness clock for the turn-time preflight. Explicit option wins; a test process (or a
  // spawned test engine) pins the clock through MADC_TEST_REGISTRY_NOW (unix ms — never set
  // outside tests, the same escape-hatch pattern as MADC_DEV_ENV_KEYS); production reads the real
  // clock. Pinned by the engine test harness so suites stay deterministic past the catalog's
  // freshness window (verifiedAt + 30 days) instead of failing en masse on the real clock.
  const assertAllowedNow =
    options.assertAllowedNow ??
    parseRegistryTestNow(process.env.MADC_TEST_REGISTRY_NOW) ??
    Date.now();
  const detectClaudeBinary = options.detectClaudeBinary ?? (() => findClaudeBinary(process.env));
  const detectCodexBinary = options.detectCodexBinary ?? (() => findCodexBinary(process.env));
  const detectGrokBinary = options.detectGrokBinary ?? (() => findGrokBinary(process.env));

  // Effective direct lanes: the M0 legacy kimi options synthesize a kimi lane (so M0 fixtures and
  // tests behave identically); explicit directLanes entries win over the synthesis.
  const lanes = new Map<string, DirectLane>();
  const legacyCreatePort = options.createPort;
  if (legacyCreatePort !== undefined) {
    const credential = options.credential ?? { ok: false, reason: "missing" as const };
    lanes.set(KIMI_CODE_PROVIDER_ID, {
      providerId: KIMI_CODE_PROVIDER_ID,
      credential: credential.ok ? credential.apiKey : null,
      createPort: legacyCreatePort,
      resolvePinnedModel: resolveKimiPinnedModel,
    });
  }
  for (const lane of options.directLanes ?? []) lanes.set(lane.providerId, lane);

  const directPorts = new Map<string, ProviderPort>();
  let claudePort: { readonly binaryPath: string; readonly port: ProviderPort } | undefined;
  let codexPort: { readonly binaryPath: string; readonly port: ProviderPort } | undefined;
  let grokPort: { readonly binaryPath: string; readonly port: ProviderPort } | undefined;

  const seatInvalid = (ctx: TurnPreflightContext, issue: string): RpcError =>
    new RpcError(ErrorCode.SeatInvalid, "Seat invalid", {
      seatId: ctx.seat.id,
      path: ctx.seatPath,
      issues: [issue],
    } satisfies SeatInvalidData);

  const planFor = (providerId: string, ctx: TurnPreflightContext): TurnPlan => {
    const entry = getById(providerId);
    try {
      assertAllowed({
        providerId,
        mode: laneMode(entry, ctx),
        connect: connectFor(entry),
        requireLive: true,
        // I1 (D-M1-6): the engine's freshness clock — a stale allow entry denies here (reason
        // `terms-stale`) before any lane, port or network is touched, so turn time and the
        // doctor / providers-ls lanes report can no longer disagree.
        now: assertAllowedNow,
      });
    } catch (err) {
      if (err instanceof RegistryDeniedError) {
        throw providerRefusalError({
          providerId: err.providerId,
          reason: err.reason,
          status: getById(err.providerId)?.status ?? null,
        });
      }
      throw err;
    }

    const lane = lanes.get(providerId);
    if (lane !== undefined) {
      const model = lane.resolvePinnedModel(ctx.seat.pinnedModel);
      if (!model.ok) throw seatInvalid(ctx, model.issue);
      if (lane.credential === null) throw providerUnavailable(providerId, "no-credentials");
      return { kind: "direct", providerId, lane, modelId: model.modelId };
    }

    if (providerId === CLAUDE_CODE_PROVIDER_ID) {
      // Registry-allowed but no adapter in this build (kimi-only test fixtures).
      if (options.createClaudePort === undefined) throw providerUnavailable(providerId, "unwired");
      const model = resolveClaudePinnedModel(ctx.seat.pinnedModel);
      if (!model.ok) throw seatInvalid(ctx, model.issue);
      const binaryPath = detectClaudeBinary();
      if (binaryPath === null) throw providerUnavailable(providerId, "binary-missing");
      return {
        kind: "vendor",
        providerId: CLAUDE_CODE_PROVIDER_ID,
        binaryPath,
        modelId: model.modelId,
      };
    }

    if (providerId === CODEX_PROVIDER_ID) {
      // Registry-allowed but no adapter in this build (fixtures that omit the codex adapter).
      if (options.createCodexPort === undefined) throw providerUnavailable(providerId, "unwired");
      const model = resolveCodexPinnedModel(ctx.seat.pinnedModel);
      if (!model.ok) throw seatInvalid(ctx, model.issue);
      const binaryPath = detectCodexBinary();
      if (binaryPath === null) throw providerUnavailable(providerId, "binary-missing");
      return { kind: "vendor", providerId: CODEX_PROVIDER_ID, binaryPath, modelId: model.modelId };
    }

    if (providerId === GROK_BUILD_PROVIDER_ID) {
      // Registry-allowed but no adapter in this build (fixtures that omit the grok-build adapter).
      if (options.createGrokPort === undefined) throw providerUnavailable(providerId, "unwired");
      const model = resolveGrokPinnedModel(ctx.seat.pinnedModel);
      if (!model.ok) throw seatInvalid(ctx, model.issue);
      const binaryPath = detectGrokBinary();
      if (binaryPath === null) throw providerUnavailable(providerId, "binary-missing");
      return {
        kind: "vendor",
        providerId: GROK_BUILD_PROVIDER_ID,
        binaryPath,
        modelId: model.modelId,
      };
    }

    // Registry-allowed but no adapter in this build.
    throw providerUnavailable(providerId, "unwired");
  };

  const portFor = (planned: TurnPlan): ProviderPort => {
    if (planned.kind === "direct") {
      const cached = directPorts.get(planned.providerId);
      if (cached !== undefined) return cached;
      // planFor refused a lane without a credential; guard again for the type.
      const apiKey = planned.lane.credential;
      if (apiKey === null) throw providerUnavailable(planned.providerId, "no-credentials");
      const port = planned.lane.createPort(apiKey);
      directPorts.set(planned.providerId, port);
      return port;
    }
    if (planned.providerId === CLAUDE_CODE_PROVIDER_ID) {
      const createClaudePort = options.createClaudePort;
      if (createClaudePort === undefined) throw providerUnavailable(planned.providerId, "unwired");
      // Detection re-runs every turn; the port is rebuilt only when the binary path changed.
      if (claudePort?.binaryPath !== planned.binaryPath) {
        claudePort = { binaryPath: planned.binaryPath, port: createClaudePort(planned.binaryPath) };
      }
      return claudePort.port;
    }
    if (planned.providerId === GROK_BUILD_PROVIDER_ID) {
      const createGrokPort = options.createGrokPort;
      if (createGrokPort === undefined) throw providerUnavailable(planned.providerId, "unwired");
      if (grokPort?.binaryPath !== planned.binaryPath) {
        grokPort = { binaryPath: planned.binaryPath, port: createGrokPort(planned.binaryPath) };
      }
      return grokPort.port;
    }
    const createCodexPort = options.createCodexPort;
    if (createCodexPort === undefined) throw providerUnavailable(planned.providerId, "unwired");
    if (codexPort?.binaryPath !== planned.binaryPath) {
      codexPort = { binaryPath: planned.binaryPath, port: createCodexPort(planned.binaryPath) };
    }
    return codexPort.port;
  };

  const emitErrorItem = (sink: TurnSink, message: string, code?: number): void => {
    const item: Item = {
      id: sink.newItemId(),
      kind: "error",
      status: "completed",
      message,
      ...(code === undefined ? {} : { code }),
    };
    sink.startItem(item);
    sink.completeItem(item);
  };

  /**
   * M1-A6: maps one attempt's vendor tool events onto `toolCall` / `toolResult` items. `callId`s
   * are adapter-scoped; the engine mints its own item ids. `closeOpen` completes every call that
   * never reached a result (no `toolResult` is invented for it).
   */
  const toolItemsFor = (sink: TurnSink) => {
    const calls = new Map<
      string,
      { readonly itemId: string; name: string; arguments: unknown; done: boolean }
    >();
    const completeCall = (call: { itemId: string; name: string; arguments: unknown }): void => {
      sink.completeItem({
        id: call.itemId,
        kind: "toolCall",
        status: "completed",
        name: call.name,
        arguments: call.arguments,
      });
    };
    return {
      onToolEvent(event: ProviderToolEvent): void {
        let call = calls.get(event.callId);
        if (call === undefined) {
          call = {
            itemId: sink.newItemId(),
            name: event.name,
            arguments: event.arguments,
            done: false,
          };
          calls.set(event.callId, call);
          sink.startItem({
            id: call.itemId,
            kind: "toolCall",
            status: "inProgress",
            name: call.name,
            arguments: call.arguments,
          });
        }
        if (event.kind !== "result" || call.done) return;
        call.done = true;
        call.name = event.name;
        call.arguments = event.arguments;
        completeCall(call);
        const result: Item = {
          id: sink.newItemId(),
          kind: "toolResult",
          status: "completed",
          callId: call.itemId,
          name: event.name,
          output: event.output,
          isError: event.isError,
        };
        sink.startItem(result);
        sink.completeItem(result);
      },
      closeOpen(): void {
        for (const call of calls.values()) {
          if (call.done) continue;
          call.done = true;
          completeCall(call);
        }
      },
    };
  };

  // M1-A4: deny-everywhere when nothing was loaded, so an unwired policy can never widen a lane.
  const repoPolicy = options.repoPolicy ?? denyAllRepoPolicy();

  return Object.freeze({
    name: "provider",
    // Every resolved direct-lane key is redacted from session JSONL by exact value (seat pin
    // §4.2). Vendor lanes hold no MAD-read credential: the vendor child carries its own auth.
    redactValues: Object.freeze([
      ...new Set(
        [...lanes.values()].map((lane) => lane.credential).filter((c): c is string => c !== null),
      ),
    ]),
    preflight(ctx: TurnPreflightContext): void {
      planFor(ctx.seat.preferredBacking, ctx);
    },
    async run(ctx: AgentTurnContext, sink: TurnSink): Promise<void> {
      const { seat } = ctx;
      const primary = planFor(seat.preferredBacking, ctx);
      const fallbacks = seat.fallbacks;
      let nextIndex = 0;

      /**
       * M1-A4: a fallback never moves into a repo-denied provider (plan §6; seat pin §2). Resolved
       * lazily, only for a repo-gated candidate the walk actually reaches, and recorded durably
       * through the sink as the pinned `repo.decision` event. A denial skips the candidate with a
       * log line, like every other ineligible candidate; `halt` means the receipt could not be
       * persisted, so the session is poisoned and the turn already finalized — nothing further may
       * be built or called.
       *
       * A lane that cannot serve this turn's mode at all is left to `planFor`'s own refusal, which
       * keeps this gate from pre-empting a mode denial (M1-A5's `interactive-only-headless`).
       */
      const repoGateFor = (candidate: string): "proceed" | "skip" | "halt" => {
        if (!isRepoGated(candidate)) return "proceed";
        const entry = getById(candidate);
        if (entry === undefined || !canServe(entry, laneMode(entry, ctx))) return "proceed";
        const decision = repoPolicy.decide(
          candidate,
          resolveRepoIdentity(ctx.cwd, options.repoIdentityDeps ?? {}),
        );
        const recorded =
          sink.repoDecision?.({
            turnId: ctx.turnId,
            providerId: candidate,
            remote: decision.remote,
            topLevel: decision.topLevel,
            decision: decision.decision,
            reason: decision.reason,
          }) ?? true;
        if (!recorded) return "halt";
        if (decision.decision === "deny") {
          options.log?.(`fallback ${candidate}: repo-denied (${decision.reason}); skipped`);
          return "skip";
        }
        return "proceed";
      };

      /**
       * The next fallback candidate worth a call. Same-lane mismatches are rejected BEFORE any
       * call with the pinned event + error item (D-M1-7, decided by `seats/lane.ts` — the one
       * predicate seat load's never-eligible warning uses too); denied lanes, missing
       * adapters/credentials/binaries and unresolvable pinned models are skipped with a log line
       * (a seat carries ONE pinnedModel; a candidate whose lane cannot resolve it is not usable).
       * `halt` stops the walk at once (Copilot 4131965600): the rejection record failed to persist,
       * the session is poisoned and the turn is already finalized — nothing further may be emitted,
       * built or called.
       */
      const nextCandidate = (): Walk => {
        const assigned = getById(seat.preferredBacking);
        while (nextIndex < fallbacks.length) {
          const candidate = fallbacks[nextIndex];
          nextIndex += 1;
          if (candidate === undefined) continue;
          const entry = getById(candidate);
          if (entry === undefined || assigned === undefined) {
            options.log?.(`fallback ${candidate}: not a registry provider id; skipped`);
            continue;
          }
          const mismatch = laneMismatch(assigned, entry);
          if (mismatch !== null) {
            const { assignedLane, candidateLane } = mismatch;
            // Pinned dual record (seat pin §2 / §4.2): the durable JSONL event first, then the
            // error-style item naming the seat, the candidate and both lanes. If the event is not
            // durable, the turn is already failed server-side: stop before the paired item and
            // before any further candidate (a missing sink method counts as recorded — M0 sinks).
            const recorded =
              sink.fallbackRejected?.({
                turnId: ctx.turnId,
                candidate,
                assignedLane,
                candidateLane,
                reason: "fallback-lane-mismatch",
              }) ?? true;
            if (!recorded) return HALT;
            emitErrorItem(
              sink,
              `fallback ${candidate} rejected for seat ${seat.id}: fallback-lane-mismatch ` +
                `(assigned ${assignedLane.status}/${assignedLane.credentialClass}; ` +
                `candidate ${candidateLane.status}/${candidateLane.credentialClass})`,
            );
            options.log?.(`fallback ${candidate}: rejected fallback-lane-mismatch`);
            continue;
          }
          // M1-A4: never fall back into a repo-denied provider. Checked after the same-lane rule
          // (a lane mismatch is the cheaper, purely static refusal) and before any call is planned.
          const gate = repoGateFor(candidate);
          if (gate === "halt") return HALT;
          if (gate === "skip") continue;
          try {
            return { kind: "attempt", plan: planFor(candidate, ctx) };
          } catch (err) {
            // -32007/-32008/-32006 on a candidate mean "cannot serve this turn": skip, never
            // fall into a denied lane, and let the primary's error stand if nobody serves.
            if (err instanceof RpcError) {
              options.log?.(
                `fallback ${candidate}: unavailable (${err.toBody().code} ${err.message}); skipped`,
              );
              continue;
            }
            throw err;
          }
        }
        return NONE;
      };

      let current: TurnPlan = primary;
      let fallbackFrom: string | null = null;
      for (;;) {
        const turnPort = portFor(current);
        const id = sink.newItemId();
        sink.startItem({ id, kind: "agentMessage", status: "inProgress", text: "" });
        const toolItems = toolItemsFor(sink);
        let result: ProviderTurnResult;
        try {
          result = await turnPort.streamTurn({
            modelId: current.modelId,
            systemPrompt: seat.standingInstructions,
            messages: [{ role: "user", text: ctx.input.map((part) => part.text).join("\n") }],
            signal: sink.signal,
            onTextDelta: (delta) => sink.delta(id, delta),
            onToolEvent: toolItems.onToolEvent,
          });
        } catch (err) {
          if (sink.signal.aborted) return;
          if (err instanceof ProviderCallError && err.reason === "quota-or-unreachable") {
            // The recorded signal (plan M1-A3, pin P5): an error item + log now; the fallback
            // logic consumes it. The failed attempt's open agentMessage closes as `failed` when
            // the turn ends — nothing partial is presented as completed.
            options.log?.(
              `provider ${current.providerId}: quota-or-unreachable recorded (HTTP ${err.status}); considering fallbacks`,
            );
            emitErrorItem(
              sink,
              `provider ${current.providerId}: ${err.message} — quota-or-unreachable`,
              ErrorCode.ProviderUnavailable,
            );
            fallbackFrom = current.providerId;
            const next = nextCandidate();
            if (next.kind === "halt") {
              // Copilot 4131965600: the fallback.rejected append failed — the server poisoned the
              // session and already finalized the turn failed. Stop at once: no paired item, no
              // further candidate planned, built or called. run() resolves quietly; the server's
              // completion handler sees the finalized turn and does nothing.
              return;
            }
            if (next.kind === "none") {
              // "If none is eligible, the turn fails with the primary's error."
              throw providerUnavailable(primary.providerId, "quota-or-unreachable");
            }
            current = next.plan;
            continue;
          }
          if (err instanceof ProviderCallError) {
            options.log?.(`provider ${turnPort.providerId}: ${err.message}`);
            if (err.reason === "binary-missing" || err.reason === "no-credentials") {
              throw providerUnavailable(turnPort.providerId, err.reason);
            }
            throw internalError(err.message);
          }
          options.log?.(`provider ${turnPort.providerId}: unexpected adapter failure`);
          throw internalError("Provider request failed");
        }
        if (sink.signal.aborted) return;
        toolItems.closeOpen();
        sink.completeItem({ id, kind: "agentMessage", status: "completed", text: result.text });
        const servingEntry = getById(current.providerId);
        const receipt: ServedModelItem = {
          id: sink.newItemId(),
          kind: "servedModel",
          status: "completed",
          requestedModel: seat.pinnedModel,
          servedModel: result.servedModel,
          backing: current.providerId,
          providerId: current.providerId,
          // planFor passed assertAllowed for this id, so the entry exists; "forbidden" is the
          // fail-closed default for the impossible case.
          lane: servingEntry?.status ?? "forbidden",
          // P2: the turn's mode. A lane that needs presence only serves with presence verified, so
          // for every served turn this is also the mode the lane was asked to serve.
          mode: turnMode(ctx),
          fallbackFrom,
          // P2 honesty rule: adapters set vendorReported when they KNOW the vendor reported an
          // identity (OpenAI-compat lanes); elsewhere pi-ai sets responseModel only when it
          // differs, so servedModel !== requestedModelId is the vendor-reported case.
          vendorReported: result.vendorReported ?? result.servedModel !== result.requestedModelId,
        };
        sink.startItem(receipt);
        sink.completeItem(receipt);
        return;
      }
    },
  });
}
