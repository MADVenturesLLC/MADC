import type { RpcErrorBody } from "./types.ts";

/** §4.1 error-code table. `code` and `data` are the contract; `message` is not. */
export const ErrorCode = Object.freeze({
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  NotInitialized: -32000,
  AlreadyInitialized: -32001,
  ThreadNotFound: -32002,
  TurnNotFound: -32003,
  TurnAlreadyActive: -32004,
  SeatNotFound: -32005,
  SeatInvalid: -32006,
  ProviderDenied: -32007,
  ProviderUnavailable: -32008,
  SessionWriteFailed: -32009,
  /**
   * M2 evidence schema v2 pin §5 (D-M2-A0-1, ruled 2026-10-01): a schema-v2 line would be written
   * with a required field missing or invalid, a `founderDecision` has no evidence ref or a malformed
   * or mismatched one, a handoff target is asked to serve while its link is one-way, or a reserved
   * (M4) type is requested. Nothing is appended. Not in the frozen M1 protocol pin; the M2 pin §5
   * is the table.
   */
  EvidenceInvalid: -32010,
} as const);

export type ErrorCodeName = keyof typeof ErrorCode;
export type ErrorCodeValue = (typeof ErrorCode)[ErrorCodeName];

// --- `data` payloads per code (§4.1) ---------------------------------------
export type MethodNotFoundData = { method: string };
export type InvalidParamsData = { issues: string[] };
export type NotInitializedData = { method: string };
export type ThreadNotFoundData = { threadId: string };
export type TurnNotFoundData = { threadId: string; turnId: string };
export type TurnAlreadyActiveData = {
  threadId: string;
  activeTurnId: string | null;
  lockHolderPid?: number;
};
export type SeatNotFoundData = { seatId: string; path: string };
export type SeatInvalidData = { seatId: string; path: string; issues: string[] };
/**
 * `status` / `reason` carry `@madc/registry` `ProviderStatus` / `DenyReason` values.
 * Kept structural here so A2 does not add a package dependency; A3 wires `assertAllowed`.
 */
export type ProviderDeniedData = { providerId: string; status: string | null; reason: string };
export type ProviderUnavailableData = {
  providerId: string;
  /** P5 (M1 protocol pin §4.1): `quota-or-unreachable` joins in M1-A3 (429/502-style signals). */
  reason: "unwired" | "binary-missing" | "no-credentials" | "quota-or-unreachable";
};
export type SessionWriteFailedData = { threadId: string; path: string; seq: number };
/** M2 pin §5: the one enum doctor and M3 bind to. `issues` are human-readable, not a contract. */
export type EvidenceRefusal =
  | "field-missing"
  | "field-invalid"
  | "evidence-ref-missing"
  | "evidence-ref-invalid"
  | "handoff-one-way"
  | "reserved";
export const EVIDENCE_REFUSALS: readonly EvidenceRefusal[] = Object.freeze([
  "field-missing",
  "field-invalid",
  "evidence-ref-missing",
  "evidence-ref-invalid",
  "handoff-one-way",
  "reserved",
]);
/**
 * M2 pin §5 `data` for -32010. `type` is the event whose record was refused or questioned.
 * Never carries secrets, env, the `brief` or the `question` text: `issues` name fields, not values.
 */
export type EvidenceInvalidData = {
  threadId: string;
  turnId: string | null;
  type: string;
  reason: EvidenceRefusal;
  issues: string[];
};

/** Throwable protocol error. Never put secrets, env, or stacks in `data`. */
export class RpcError extends Error {
  readonly code: number;
  readonly data: Record<string, unknown> | undefined;

  constructor(code: number, message: string, data?: Record<string, unknown>) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }

  toBody(): RpcErrorBody {
    return this.data === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, data: this.data };
  }
}

export function parseError(): RpcError {
  return new RpcError(ErrorCode.ParseError, "Parse error: line is not valid JSON");
}

export function invalidRequest(message = "Invalid request"): RpcError {
  return new RpcError(ErrorCode.InvalidRequest, message);
}

export function methodNotFound(method: string): RpcError {
  return new RpcError(ErrorCode.MethodNotFound, `Method not found: ${method}`, {
    method,
  } satisfies MethodNotFoundData);
}

export function invalidParams(issues: string[]): RpcError {
  return new RpcError(ErrorCode.InvalidParams, "Invalid params", {
    issues,
  } satisfies InvalidParamsData);
}

export function internalError(message = "Internal error"): RpcError {
  return new RpcError(ErrorCode.InternalError, message);
}

export function notInitialized(method: string): RpcError {
  return new RpcError(ErrorCode.NotInitialized, "Not initialized", {
    method,
  } satisfies NotInitializedData);
}

export function alreadyInitialized(): RpcError {
  return new RpcError(ErrorCode.AlreadyInitialized, "Already initialized");
}

export function threadNotFound(threadId: string): RpcError {
  return new RpcError(ErrorCode.ThreadNotFound, "Thread not found", {
    threadId,
  } satisfies ThreadNotFoundData);
}

export function turnNotFound(threadId: string, turnId: string): RpcError {
  return new RpcError(ErrorCode.TurnNotFound, "Turn not found", {
    threadId,
    turnId,
  } satisfies TurnNotFoundData);
}

export function turnAlreadyActive(
  threadId: string,
  activeTurnId: string | null,
  lockHolderPid?: number,
): RpcError {
  const data: TurnAlreadyActiveData =
    lockHolderPid === undefined
      ? { threadId, activeTurnId }
      : { threadId, activeTurnId, lockHolderPid };
  return new RpcError(
    ErrorCode.TurnAlreadyActive,
    activeTurnId === null ? "Thread is locked by another engine process" : "Turn already active",
    data,
  );
}

/** M2 pin §5: -32010 `EvidenceInvalid`. The writer appended nothing. */
export function evidenceInvalid(data: EvidenceInvalidData): RpcError {
  return new RpcError(ErrorCode.EvidenceInvalid, `Evidence invalid (${data.reason})`, {
    threadId: data.threadId,
    turnId: data.turnId,
    type: data.type,
    reason: data.reason,
    issues: [...data.issues],
  } satisfies EvidenceInvalidData);
}

/**
 * Registry refusal → protocol error (§4.1 rows -32007 / -32008).
 * `reason: "unwired"` → -32008 ProviderUnavailable; every other deny reason → -32007 ProviderDenied.
 * Structurally compatible with `RegistryDeniedError` from `@madc/registry`.
 */
export function providerRefusalError(denial: {
  providerId: string;
  reason: string;
  status: string | null;
}): RpcError {
  if (denial.reason === "unwired") {
    return new RpcError(ErrorCode.ProviderUnavailable, "Provider unavailable", {
      providerId: denial.providerId,
      reason: "unwired",
    } satisfies ProviderUnavailableData);
  }
  return new RpcError(ErrorCode.ProviderDenied, "Provider denied by registry", {
    providerId: denial.providerId,
    status: denial.reason === "unknown-provider" ? null : denial.status,
    reason: denial.reason,
  } satisfies ProviderDeniedData);
}
