/**
 * Witness app state model and the app exit ladder (DESIGN-SPEC rev 6.2 §5.3, §5.11–§5.12).
 * Pure helpers only: the live state machine lives in `app.ts`, and every frame renderer reads
 * these types without touching I/O, which is what keeps the tests deterministic.
 */

/** Result of one read-only `verifySessionFile` run (engine sdk re-export). */
export type ChainVerify =
  | { readonly kind: "verified"; readonly seq: number; readonly headHash: string }
  | {
      readonly kind: "failed";
      readonly line: number;
      readonly reason: string;
      readonly failureKind: "torn-tail" | "integrity";
    }
  /** The verify never finished (deadline, abandoned by a signal). Never evidence. */
  | { readonly kind: "interrupted" };

/** How a recorded turn ended, from the client's own observation plus the final verify. */
export type TurnRecord = {
  /** Client-side placeholder until turn/start answers; the engine id lands in `realTurnId`. */
  readonly turnId: string;
  /** The engine-assigned turn id once turn/start answered; undefined while pending. */
  realTurnId?: string;
  /** The prompt the client sent for this turn (the `▌ you` band renders from it). */
  userText?: string;
  /** Accumulated display-only deltas (§5.3 R-d); replaced by the item/completed text. */
  deltaText?: string;
  /** The turn's items as observed from the wire (completed notifications replace by id). */
  items: import("@madc/engine/client").Item[];
  status: "running" | "completed" | "failed" | "interrupted" | "unknown";
  /** The exit code this turn ended with (§5.11: usually 0; 1 turn failure, 4 provider, 2 seat). */
  exitCode: number;
  /** True when the user interrupted this turn in-app (Ctrl-C answered + verified): counts 0 (O-5). */
  inAppInterrupted: boolean;
  /** The turn's remembered seq range, learned from a passing verify (R-b). */
  seqStart: number | null;
  seqEnd: number | null;
  verify: ChainVerify | null;
  /** Why the rail stays dotted when the turn ended without a passing verify naming it (§5.3). */
  unverified: string | null;
  /** True when this turn's range contains or follows a chain-FAILED line (R-b revocation). */
  revoked: boolean;
  startTime: number;
  endTime: number | null;
};

/** Session-level codes recorded without a turn (§5.11 table: seat 2, -32009 5, engine 3). */
export type SessionCode = { readonly code: number; readonly reason: string };

/** One §5.11 ladder position; 130/143 sit between 5 and 4 (M-2 d). */
const RANK: Readonly<Record<number, number>> = {
  3: 60,
  2: 50,
  5: 40,
  130: 30,
  143: 30,
  4: 20,
  1: 10,
  0: 0,
};

export function rankCode(code: number): number {
  return RANK[code] ?? 0;
}

export type WorstCodeInput = {
  readonly turns: readonly TurnRecord[];
  readonly sessionCodes: readonly SessionCode[];
  /** The signal that ended the process, when the quit is by signal (M-2 d). */
  readonly signal: "SIGINT" | "SIGTERM" | "SIGHUP" | null;
  /** True when the final verify FAILED after the signal arrived (§17.1 O-3): exit 5. */
  readonly finalVerifyFailedAfterSignal: boolean;
};

export type WorstCodeResult = {
  readonly code: number;
  /** The turn whose code decides the exit, when one does (§5.12 receipt rule). */
  readonly worstTurn: TurnRecord | null;
};

/**
 * The app's exit: the worst code recorded anywhere in the session, on the one-shot ranking
 * without its signal tier: 3 > 2 > 5 > 4 > 1 > 0 (ERR1 §3d L245; ledger D-196). A signal
 * (130/143) sits between 5 and 4: it never replaces a recorded 2, 3 or 5 (M-2 d), and a final
 * verify that failed after the signal records 5 (O-3). An in-app interrupted turn counts 0 for
 * that turn (O-5). A no-turn session: 0 if the final check passed, 5 if it failed (M-2 c); with
 * no thread at all, 0 (O-6).
 */
export function worstExit(input: WorstCodeInput): WorstCodeResult {
  // A final-verify failure after the signal records class 5, which outranks the signal code.
  if (input.finalVerifyFailedAfterSignal) {
    return { code: 5, worstTurn: null };
  }
  let worst = { code: 0, rank: 0, turn: null as TurnRecord | null };
  const consider = (code: number, turn: TurnRecord | null): void => {
    const rank = rankCode(code);
    // On a tie the later turn decides (§5.12); sessions are sequential, so a later turn arrives
    // after an earlier one in `turns` order.
    if (rank >= worst.rank) worst = { code, rank, turn };
  };
  for (const turn of input.turns) {
    if (turn.status === "unknown") continue; // no recorded outcome of its own
    const code = turn.inAppInterrupted ? 0 : turn.exitCode;
    consider(code, turn);
  }
  for (const sc of input.sessionCodes) consider(sc.code, null);
  if (input.signal !== null) {
    const signalCode = input.signal === "SIGINT" ? 130 : 143;
    const signalRank = RANK[signalCode] ?? 0;
    // A signal replaces only 0, 1 or 4 (never 2, 3 or 5): it wins exactly when the recorded
    // worst is below the signal's rank.
    if (rankCode(worst.code) < signalRank) {
      worst = { code: signalCode, rank: signalRank, turn: worst.turn };
    }
  }
  return { code: worst.code, worstTurn: worst.turn };
}

/** Rail state of one turn, derived only from recorded evidence (§5.3; R-f: never solid by default). */
export function railOf(turn: TurnRecord): "dotted" | "solid" | "break" {
  if (turn.revoked || turn.verify?.kind === "failed") return "break";
  if (turn.status !== "running" && turn.verify?.kind === "verified" && turn.unverified === null) {
    return "solid";
  }
  return "dotted";
}
