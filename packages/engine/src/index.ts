/**
 * @madc/engine — local protocol host (Act M0-A2).
 * Contract: docs/plan/PIN-madc-M0-protocol-messages.md. stdio JSONL only.
 */

export { type AcpAdapter, createAcpAdapter, NotImplementedError } from "./acp/index.ts";
export { type Agent, type AgentTurnContext, echoAgent, type TurnSink } from "./agent.ts";
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
export { startStdioEngine } from "./main.ts";
export * from "./protocol/errors.ts";
export { ID_PATTERN, isValidId, newId } from "./protocol/ids.ts";
export * from "./protocol/types.ts";
export { encodeMessage, type Incoming, parseLine } from "./protocol/wire.ts";
export { ENGINE_VERSION, EngineConnection, type EngineOptions, runEngine } from "./server.ts";
