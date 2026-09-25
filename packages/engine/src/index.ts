/**
 * @madc/engine — local protocol host (Act M0-A2), seat files + hash-chained sessions (M0-A4).
 * Contract: docs/plan/PIN-madc-M0-protocol-messages.md. stdio JSONL only.
 */

export { type AcpAdapter, createAcpAdapter, NotImplementedError } from "./acp/index.ts";
export {
  type Agent,
  type AgentTurnContext,
  echoAgent,
  type TurnPreflightContext,
  type TurnSink,
} from "./agent.ts";
export {
  ENGINE_ENTRY,
  EngineClient,
  EngineExitedError,
  EngineRpcError,
  type Notification,
  type SpawnEngineOptions,
  spawnEngine,
  type WireMessage,
} from "./client.ts";
export { confinedPath, type HomeSubdir, resolveMadcHome } from "./home.ts";
export {
  type HomeReport,
  inspectMadcHome,
  type SeatReport,
  type SessionReport,
} from "./inspect.ts";
export {
  type AcquireResult,
  acquireThreadLock,
  holdsThreadLock,
  isPidAlive,
  type LockHandle,
  type LockInfo,
  readLock,
  releaseThreadLock,
  threadLockPath,
} from "./lock.ts";
export { type AgentFactory, defaultAgentFactory, startStdioEngine } from "./main.ts";
export * from "./protocol/errors.ts";
export { ID_PATTERN, isValidId, newId } from "./protocol/ids.ts";
export * from "./protocol/types.ts";
export { encodeMessage, type Incoming, parseLine } from "./protocol/wire.ts";
export { createProviderAgent, type ProviderAgentOptions } from "./provider-agent.ts";
export {
  type EngineSeat,
  MADC_DEFAULT_SEAT,
  memoryPathIssue,
  SEAT_BACKINGS,
  type SeatBacking,
  type SeatHandoffsStub,
  type SeatMemory,
  type SeatToolsPolicy,
  type SeatValidation,
  validateSeat,
} from "./seat.ts";
export {
  type LoadedSeat,
  loadSeat,
  type SeedResult,
  seatFilePath,
  seedDefaultSeat,
  serializeSeat,
} from "./seat-store.ts";
export { ENGINE_VERSION, EngineConnection, type EngineOptions, runEngine } from "./server.ts";
export {
  createRedactor,
  GENESIS_HASH,
  REDACTED,
  type RebuiltSession,
  rebuildSession,
  SESSION_EVENT_TYPES,
  type SessionEvent,
  type SessionEventType,
  type SessionPayloads,
  type SessionVerifyResult,
  SessionWriter,
  sessionEventHash,
  sortedKeyJson,
  TOKEN_PATTERNS,
  verifySessionFile,
  verifySessionText,
} from "./session-store.ts";
