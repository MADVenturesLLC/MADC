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
 *    claude-code / codex need their unmodified binary detected on PATH (else -32008
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
 * preflight and spawn) ends the turn `failed` per protocol pin §4.2.
 */
import {
  CLAUDE_CODE_PROVIDER_ID,
  CODEX_PROVIDER_ID,
  findClaudeBinary,
  findCodexBinary,
  KIMI_CODE_PROVIDER_ID,
  type KimiCredential,
  type PinnedModelResolution,
  ProviderCallError,
  type ProviderPort,
  type ProviderTurnResult,
  resolveClaudePinnedModel,
  resolveCodexPinnedModel,
  resolveKimiPinnedModel,
} from "@madc/adapters";
import {
  assertAllowed,
  type ConnectPreference,
  getById,
  type ProviderEntry,
  RegistryDeniedError,
} from "@madc/registry";
import type { Agent, AgentTurnContext, TurnPreflightContext, TurnSink } from "./agent.ts";
import {
  ErrorCode,
  internalError,
  type ProviderUnavailableData,
  providerRefusalError,
  RpcError,
  type SeatInvalidData,
} from "./protocol/errors.ts";
import type { Item, ServedModelItem } from "./protocol/types.ts";

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
  /** stderr logger (never receives secrets or upstream text). */
  readonly log?: (line: string) => void;
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
    };

/**
 * Engine turns are non-interactive provider calls until M1-A5 lands mode attestation: `headless`
 * is the fail-closed mode for every `assertAllowed` check and every receipt.
 */
const TURN_MODE = "headless" as const;

/** Intent `connect` per seat pin §2: from the registry entry; unknown ids fail closed as direct. */
function connectFor(entry: ProviderEntry | undefined): ConnectPreference {
  return entry?.connect === "vendor-agent" ? "vendor-agent" : "direct";
}

/** Billing class for the same-lane rule; forbidden entries carry none (seat pin §2 payload). */
function credentialClassOf(entry: ProviderEntry): string {
  return "credentialClass" in entry ? entry.credentialClass : "none";
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

export function createProviderAgent(options: ProviderAgentOptions): Agent {
  const detectClaudeBinary = options.detectClaudeBinary ?? (() => findClaudeBinary(process.env));
  const detectCodexBinary = options.detectCodexBinary ?? (() => findCodexBinary(process.env));

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
        mode: TURN_MODE,
        connect: connectFor(entry),
        requireLive: true,
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
      const fallbacks = seat.fallbacks ?? [];
      let nextIndex = 0;

      /**
       * The next fallback candidate worth a call, or null. Same-lane mismatches are rejected
       * BEFORE any call with the pinned event + error item (D-M1-7); denied lanes, missing
       * adapters/credentials/binaries and unresolvable pinned models are skipped with a log line
       * (a seat carries ONE pinnedModel; a candidate whose lane cannot resolve it is not usable —
       * per-seat fallback model locking lands with the A7 roster).
       */
      const nextCandidate = (): TurnPlan | null => {
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
          if (
            entry.status !== assigned.status ||
            credentialClassOf(entry) !== credentialClassOf(assigned)
          ) {
            const assignedLane = {
              status: assigned.status,
              credentialClass: credentialClassOf(assigned),
            };
            const candidateLane = {
              status: entry.status,
              credentialClass: credentialClassOf(entry),
            };
            // Pinned dual record (seat pin §2 / §4.2): the durable JSONL event first, then the
            // error-style item naming the seat, the candidate and both lanes.
            sink.fallbackRejected?.({
              turnId: ctx.turnId,
              candidate,
              assignedLane,
              candidateLane,
              reason: "fallback-lane-mismatch",
            });
            emitErrorItem(
              sink,
              `fallback ${candidate} rejected for seat ${seat.id}: fallback-lane-mismatch ` +
                `(assigned ${assignedLane.status}/${assignedLane.credentialClass}; ` +
                `candidate ${candidateLane.status}/${candidateLane.credentialClass})`,
            );
            options.log?.(`fallback ${candidate}: rejected fallback-lane-mismatch`);
            continue;
          }
          try {
            return planFor(candidate, ctx);
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
        return null;
      };

      let current: TurnPlan = primary;
      let fallbackFrom: string | null = null;
      for (;;) {
        const turnPort = portFor(current);
        const id = sink.newItemId();
        sink.startItem({ id, kind: "agentMessage", status: "inProgress", text: "" });
        let result: ProviderTurnResult;
        try {
          result = await turnPort.streamTurn({
            modelId: current.modelId,
            systemPrompt: seat.standingInstructions,
            messages: [{ role: "user", text: ctx.input.map((part) => part.text).join("\n") }],
            signal: sink.signal,
            onTextDelta: (delta) => sink.delta(id, delta),
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
            if (next === null) {
              // "If none is eligible, the turn fails with the primary's error."
              throw providerUnavailable(primary.providerId, "quota-or-unreachable");
            }
            current = next;
            continue;
          }
          if (err instanceof ProviderCallError) {
            options.log?.(`provider ${turnPort.providerId}: ${err.message}`);
            if (err.reason === "binary-missing") {
              throw providerUnavailable(turnPort.providerId, "binary-missing");
            }
            throw internalError(err.message);
          }
          options.log?.(`provider ${turnPort.providerId}: unexpected adapter failure`);
          throw internalError("Provider request failed");
        }
        if (sink.signal.aborted) return;
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
          mode: TURN_MODE,
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
