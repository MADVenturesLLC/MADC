/**
 * Live-provider agent (Acts M0-A3 / A4). The engine loads and validates the thread's seat file at
 * `thread/start` / `thread/resume` (A4) and hands it over in the turn context. Every turn runs a
 * synchronous preflight inside `turn/start` (protocol pin §4.2) before any model call:
 *
 * 1. registry `assertAllowed` with `requireLive: true` (unwired → -32008, other denials → -32007);
 * 2. the backing has an adapter in this build (else -32008 `unwired`);
 * 3. `pinnedModel` resolves in the pinned pi-ai catalog for that backing (else -32006 with the
 *    seat file path);
 * 4. a usable credential is configured (else -32008 `no-credentials`).
 *
 * Preflight is side-effect free (no port, no I/O). Only `run` builds the port and streams the
 * current input: deltas → one `agentMessage`, followed by a `servedModel` receipt (protocol pin §5).
 * Earlier turns are not replayed to the model in M0-A4 (Surface ruling on PR #12, item 12).
 */
import {
  KIMI_CODE_PROVIDER_ID,
  type KimiCredential,
  ProviderCallError,
  type ProviderPort,
  type ProviderTurnResult,
  resolveKimiPinnedModel,
} from "@madc/adapters";
import {
  assertAllowed,
  type ConnectPreference,
  getById,
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
import type { ServedModelBacking, ServedModelItem } from "./protocol/types.ts";

export type ProviderAgentOptions = {
  /** Resolved once at engine start; the key itself never leaves the adapter. */
  readonly credential: KimiCredential;
  /** Builds the port for a validated credential (tests inject a fake transport). */
  readonly createPort: (apiKey: string) => ProviderPort;
  /** stderr logger (never receives secrets or upstream text). */
  readonly log?: (line: string) => void;
};

type TurnPlan = { readonly apiKey: string; readonly modelId: string };

/**
 * Intent `connect` per backing (seat pin §2 backing → registry table). Unknown backings use
 * `direct`; the registry then denies them fail-closed (`unknown-provider` / `forbidden` / …).
 */
const BACKING_CONNECT: Readonly<Record<string, ConnectPreference>> = Object.freeze({
  "kimi-code": "direct",
  "claude-code": "vendor-agent",
  codex: "vendor-agent",
});

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
  const { credential } = options;
  let port: ProviderPort | undefined;

  const plan = (ctx: TurnPreflightContext): TurnPlan => {
    const { seat } = ctx;
    const providerId = seat.preferredBacking;
    try {
      // M0 engine turns are non-interactive provider calls: `headless` is the fail-closed mode.
      assertAllowed({
        providerId,
        mode: "headless",
        connect: BACKING_CONNECT[providerId] ?? "direct",
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

    // Registry-allowed but no adapter in this build (claude-code / codex land in A5 / A6).
    if (providerId !== KIMI_CODE_PROVIDER_ID) throw providerUnavailable(providerId, "unwired");

    const model = resolveKimiPinnedModel(seat.pinnedModel);
    if (!model.ok) {
      throw new RpcError(ErrorCode.SeatInvalid, "Seat invalid", {
        seatId: seat.id,
        path: ctx.seatPath,
        issues: [model.issue],
      } satisfies SeatInvalidData);
    }

    if (!credential.ok) throw providerUnavailable(providerId, "no-credentials");
    return { apiKey: credential.apiKey, modelId: model.modelId };
  };

  return Object.freeze({
    name: "provider",
    // The configured key is redacted from session JSONL by exact value (seat pin §4.2).
    redactValues: Object.freeze(credential.ok ? [credential.apiKey] : []),
    preflight(ctx: TurnPreflightContext): void {
      plan(ctx);
    },
    async run(ctx: AgentTurnContext, sink: TurnSink): Promise<void> {
      const { apiKey, modelId } = plan(ctx);
      port ??= options.createPort(apiKey);
      const turnPort = port;
      const { seat } = ctx;
      const id = sink.newItemId();
      sink.startItem({ id, kind: "agentMessage", status: "inProgress", text: "" });
      let result: ProviderTurnResult;
      try {
        result = await turnPort.streamTurn({
          modelId,
          systemPrompt: seat.standingInstructions,
          messages: [{ role: "user", text: ctx.input.map((part) => part.text).join("\n") }],
          signal: sink.signal,
          onTextDelta: (delta) => sink.delta(id, delta),
        });
      } catch (err) {
        if (sink.signal.aborted) return;
        if (err instanceof ProviderCallError) {
          options.log?.(`provider ${turnPort.providerId}: ${err.message}`);
          throw internalError(err.message);
        }
        options.log?.(`provider ${turnPort.providerId}: unexpected adapter failure`);
        throw internalError("Provider request failed");
      }
      if (sink.signal.aborted) return;
      sink.completeItem({ id, kind: "agentMessage", status: "completed", text: result.text });
      const receipt: ServedModelItem = {
        id: sink.newItemId(),
        kind: "servedModel",
        status: "completed",
        requestedModel: seat.pinnedModel,
        servedModel: result.servedModel,
        backing: turnPort.providerId as ServedModelBacking,
        providerId: turnPort.providerId,
      };
      sink.startItem(receipt);
      sink.completeItem(receipt);
    },
  });
}
