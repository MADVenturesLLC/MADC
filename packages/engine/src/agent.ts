import type { Item, UserInput } from "./protocol/types.ts";
import type { EngineSeat } from "./seat.ts";

/** What `preflight` sees: the turn has not been created yet. */
export type TurnPreflightContext = {
  readonly threadId: string;
  readonly seatId: string;
  /** The thread's seat, loaded and validated from `seats/<seatId>.json` at thread/start / resume. */
  readonly seat: EngineSeat;
  /** The seat file the seat came from (reported in -32006 data). */
  readonly seatPath: string;
  readonly input: readonly UserInput[];
};

/** What the engine hands an agent for one turn. */
export type AgentTurnContext = TurnPreflightContext & {
  readonly turnId: string;
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
