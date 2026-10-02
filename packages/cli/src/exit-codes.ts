/**
 * CLI pin §4 exit codes. Every code in the protocol pin §4.1 table has one explicit case below.
 */
import { ErrorCode } from "@madc/engine/client";

export const EXIT = Object.freeze({
  ok: 0,
  failure: 1,
  usage: 2,
  engine: 3,
  provider: 4,
  session: 5,
  sigint: 130,
  sigterm: 143,
} as const);

export type ErrorClass = "usage" | "engine" | "provider" | "session" | "turn" | "interrupted";

export type Classified = { readonly exit: number; readonly class: ErrorClass };

const USAGE: Classified = { exit: EXIT.usage, class: "usage" };
const ENGINE: Classified = { exit: EXIT.engine, class: "engine" };
const PROVIDER: Classified = { exit: EXIT.provider, class: "provider" };
const SESSION: Classified = { exit: EXIT.session, class: "session" };
const TURN: Classified = { exit: EXIT.failure, class: "turn" };

/** Where an engine error code was seen. */
export type ErrorSite = "thread/start" | "request" | "turn";

/**
 * Map an engine error code to an exit class. `site` matters for two rows of the pin table:
 * `-32602` is a usage error only on `thread/start` (bad seat id), and a turn that ended `failed`
 * with a known but unclassed code (e.g. `-32603` agent failure) is a turn failure (exit 1).
 * Unknown codes are always the engine class (exit 3).
 */
export function classifyCode(code: number, site: ErrorSite): Classified {
  const unclassed = site === "turn" ? TURN : ENGINE;
  switch (code) {
    case ErrorCode.ParseError:
    case ErrorCode.InvalidRequest:
    case ErrorCode.MethodNotFound:
    case ErrorCode.NotInitialized:
    case ErrorCode.AlreadyInitialized:
    case ErrorCode.ThreadNotFound:
    case ErrorCode.TurnNotFound:
    case ErrorCode.TurnAlreadyActive:
    case ErrorCode.InternalError:
      return unclassed;
    case ErrorCode.InvalidParams:
      return site === "thread/start" ? USAGE : unclassed;
    case ErrorCode.SeatNotFound:
    case ErrorCode.SeatInvalid:
      return USAGE;
    case ErrorCode.ProviderDenied:
    case ErrorCode.ProviderUnavailable:
      return PROVIDER;
    case ErrorCode.SessionWriteFailed:
      return SESSION;
    // M2 evidence schema v2 pin §5: `-32010 EvidenceInvalid` is a refused session RECORD (a
    // schema-v2 line that would be invalid, or a handoff target whose link is one-way), the
    // sibling of -32009 — so it takes the session class. The CLI pin is not amended by M2-A1;
    // this is the nearest existing class, and the one-shot never opens a handoff target itself.
    case ErrorCode.EvidenceInvalid:
      return SESSION;
    default:
      return ENGINE;
  }
}
