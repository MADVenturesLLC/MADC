/**
 * `@madc/engine/client` — what `packages/cli` may import (plan §6 import rules):
 * protocol types, error-code constants, id grammar, and the stdio client SDK. No engine loop,
 * no agents, no adapters.
 */
export {
  ENGINE_ENTRY,
  EngineClient,
  EngineRpcError,
  type Notification,
  type SpawnEngineOptions,
  spawnEngine,
  type WireMessage,
} from "./client.ts";
export * from "./protocol/errors.ts";
export { ID_PATTERN, isValidId } from "./protocol/ids.ts";
export * from "./protocol/types.ts";
