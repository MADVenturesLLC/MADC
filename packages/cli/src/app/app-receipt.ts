/**
 * Bridge between the app's turn records and the pinned receipt shape (CLI pin §2 rows): the
 * §5.12 exit receipt and the §6.1/§7 verdict cards all render through `buildReceiptData`, so
 * the bytes stay identical to the one-shot's receipt everywhere.
 */
import type { ErrorOut, ReceiptData, ServedModel, SessionOut } from "./receipt.ts";
import type { TurnRecord } from "./state.ts";

export function turnWordOf(turn: TurnRecord): string {
  switch (turn.status) {
    case "completed":
      return "COMPLETED";
    case "failed":
      return "FAILED";
    case "interrupted":
      return "INTERRUPTED";
    case "unknown":
      return "UNKNOWN";
    default:
      return "INPROGRESS";
  }
}

export function buildReceiptData(args: {
  readonly turn: TurnRecord;
  readonly served: ServedModel | null;
  readonly session: SessionOut | null;
  readonly error: ErrorOut | null;
  readonly exit: number;
}): ReceiptData {
  const turn = args.turn;
  const ended = turn.endTime ?? turn.startTime;
  return {
    turn:
      turn.realTurnId === undefined
        ? null
        : {
            status: turn.status,
            id: turn.realTurnId,
            durationMs: Math.max(0, ended - turn.startTime),
          },
    turnWord: turnWordOf(turn),
    served: args.served,
    session: args.session,
    error: args.error,
    exit: args.exit,
  };
}
