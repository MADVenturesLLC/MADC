import type { Presence } from "./presence/policy.ts";
import type { Item, TurnMode, UserInput } from "./protocol/types.ts";
import type { EngineSeat } from "./seat.ts";
import type { EvidenceRef, FallbackRejectedPayload, RepoDecisionPayload } from "./session-store.ts";

/** What `preflight` sees: the turn has not been created yet. */
export type TurnPreflightContext = {
  readonly threadId: string;
  readonly seatId: string;
  /** The thread's seat, loaded and validated from `seats/<seatId>.json` at thread/start / resume. */
  readonly seat: EngineSeat;
  /** The seat file the seat came from (reported in -32006 data). */
  readonly seatPath: string;
  readonly input: readonly UserInput[];
  /**
   * The thread's `cwd` as the client supplied it (M1-A4). It is CONTEXT ONLY for a repo-gated
   * provider: the engine resolves the repository identity itself from this path (realpath'd git
   * top-level + normalized `origin`) and never matches this string against an allowlist — seat pin
   * §5, fixing Copilot r4101049517.
   */
  readonly cwd: string | null;
  /**
   * M1-A5 (protocol pin §3.3 P3): the turn's mode CLAIM. Absent reads as `headless` (fail-closed),
   * which keeps M0-era contexts valid. The claim alone never unlocks a lane that needs presence.
   */
  readonly mode?: TurnMode;
  /**
   * M1-A5: the engine's presence check for this turn. `verified` only when the engine confirmed a
   * person at its own controlling terminal; absent reads as `absent` (fail-closed).
   */
  readonly presence?: Presence;
};

/** What the engine hands an agent for one turn. */
export type AgentTurnContext = TurnPreflightContext & {
  readonly turnId: string;
};

/**
 * M2-A6 (`docs/plan/PIN-madc-M2-founder-decision-inbox.md` §4.1): typed input for an executing
 * seat to raise a `founderDecision` during an active turn. The engine binds the active `threadId`
 * and `turnId` and mints `dec_<32 lowercase hex>` when `decisionId` is omitted.
 */
export type TurnDecisionInput = {
  readonly decisionId?: string;
  readonly question: string;
  readonly recommendedDefault: string;
  readonly evidenceRefs: readonly EvidenceRef[];
};

/**
 * M2-A6: synchronous outcome of `TurnSink.raiseDecision`. On `-32010` (`EvidenceInvalid`),
 * nothing is appended to `founderDecision`, an `error` item (`code: -32010`) is recorded on the
 * active turn, and the turn continues.
 */
export type TurnDecisionOutcome =
  | {
      readonly ok: true;
      readonly decision: {
        readonly threadId: string;
        readonly turnId: string;
        readonly decisionId: string;
        readonly seq: number;
        readonly hash: string;
      };
    }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: number;
        readonly message: string;
        readonly data?: Record<string, unknown>;
      };
    };

/**
 * Item stream for one turn. The engine owns ids, ordering, and notifications; after the turn ends
 * (completed / interrupted / failed) every call is a no-op, so agents cannot write past an interrupt.
 */
export type TurnSink = {
  readonly signal: AbortSignal;
  newItemId(): string;
  /** Emits `item/started` (status forced to `inProgress`). */
  startItem(item: Item): void;
  /** Emits `item/agentMessage/delta` for an open agentMessage item and grows its text. */
  delta(itemId: string, delta: string): void;
  /** Emits `item/completed`; the item joins the turn snapshot. */
  completeItem(item: Item): void;
  /**
   * Durably records the pinned `fallback.rejected` session event (seat pin §4.2, same-lane rule
   * D-M1-7). Returns true only when the rejection was recorded. `false` means the session is
   * unusable — the server poisoned the writer and already finalized the turn failed — and the
   * fallback walk MUST stop immediately: no paired item, no further candidate built or called
   * (Copilot 4131965600). Optional so M0-era fake sinks stay valid; a sink without the method is
   * treated as "recorded". The agent pairs each RECORDED rejection with an `error`-style item
   * naming both lanes.
   */
  fallbackRejected?(payload: FallbackRejectedPayload): boolean;
  /**
   * Durably records the pinned `repo.decision` session event (seat pin §4.2 / §5, M1-A4) for a
   * repo-gated FALLBACK CANDIDATE. The seat's assigned backing is gated by the engine inside
   * `turn/start` (protocol pin §4.2: repo-policy checks run there, before any model call), so this
   * covers only the candidates the fallback walk considers — a fallback never moves into a
   * repo-denied provider.
   *
   * Returns true only when the decision was recorded. `false` means the session is unusable, so the
   * candidate MUST NOT be called: a decision that is not durable is not claimed. Optional so
   * pre-M1-A4 fake sinks stay valid; a sink without the method is treated as "recorded".
   */
  repoDecision?(payload: RepoDecisionPayload): boolean;
  /**
   * M2-A6 (`docs/plan/PIN-madc-M2-founder-decision-inbox.md` §4.1): engine-controlled capability
   * for an executing seat to raise a typed `founderDecision` during the active turn. Uses the
   * active thread and turn identity, validates through the thread's `SessionWriter`, emits a
   * `-32010` `error` item and permits the turn to continue on validation refusal, and never grants
   * `decision/resolve`.
   */
  raiseDecision?(input: TurnDecisionInput): TurnDecisionOutcome;
};

/**
 * Engine-side turn runner. The fake echo agent serves protocol tests; A3 adds the live provider
 * agent (`provider-agent.ts`) behind this seam.
 */
export type Agent = {
  readonly name: string;
  /**
   * Synchronous checks run inside `turn/start` before the turn exists (protocol pin §4.2: provider /
   * seat refusals are response errors, never a started turn). Throw an `RpcError` to refuse.
   */
  preflight?(ctx: TurnPreflightContext): void;
  /**
   * Exact secret values this agent holds in memory (e.g. a provider key). The engine redacts each
   * one from every session JSONL payload before hashing (seat pin §4.2).
   */
  readonly redactValues?: readonly string[];
  run(ctx: AgentTurnContext, sink: TurnSink): Promise<void>;
};

function nextTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Split into word-ish chunks (keeps whitespace) so deltas are exercised. */
function chunks(text: string): string[] {
  return text.match(/\S+\s*|\s+/g) ?? [];
}

/**
 * Fake agent for protocol tests: replies with the user's text verbatim as one agentMessage,
 * streamed as deltas. Emits no `servedModel` item — no model is invoked, so there is no honest
 * receipt to write.
 */
export const echoAgent: Agent = Object.freeze({
  name: "echo",
  async run(ctx: AgentTurnContext, sink: TurnSink): Promise<void> {
    const text = ctx.input.map((part) => part.text).join("\n");
    const id = sink.newItemId();
    sink.startItem({ id, kind: "agentMessage", status: "inProgress", text: "" });
    for (const piece of chunks(text)) {
      await nextTick();
      if (sink.signal.aborted) return;
      sink.delta(id, piece);
    }
    sink.completeItem({ id, kind: "agentMessage", status: "completed", text });
  },
});
