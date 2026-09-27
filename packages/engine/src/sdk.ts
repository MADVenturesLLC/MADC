/**
 * `@madc/engine/client` — what `packages/cli` may import (plan §6 import rules):
 * protocol types, error-code constants, id grammar, and the stdio client SDK. No engine loop,
 * no agents, no adapters.
 *
 * Act M0-A7 (CLI pin §5, Founder allowance D-A7-2): additive, read-only re-exports for
 * `madc doctor` and the one-shot receipt — the engine's own `MADC_HOME` resolver, the read-only
 * home report, the read-only session chain verifier (with the Amendment 2 §5 torn-tail /
 * integrity classification), the read-only lock reader and pid probe (`kill(pid, 0)` sends no
 * signal), and the pure registry catalog. Nothing here acquires, reclaims, releases, seeds or
 * appends; `seedDefaultSeat` is deliberately not exported (`doctor --init` goes through the engine).
 */

export { listCatalog, type ProviderEntry, type ProviderStatus } from "@madc/registry";
export {
  ENGINE_ENTRY,
  EngineClient,
  EngineExitedError,
  EngineProtocolError,
  EngineRpcError,
  type Notification,
  type SpawnEngineOptions,
  spawnEngine,
  type WireMessage,
} from "./client.ts";
export { resolveMadcHome, sessionsOwnerReadUnsupported } from "./home.ts";
export {
  type HomeReport,
  inspectMadcHome,
  type SeatReport,
  type SessionReport,
} from "./inspect.ts";
export { isPidAlive, type LockState, readLock } from "./lock.ts";
export * from "./protocol/errors.ts";
export { ID_PATTERN, isValidId } from "./protocol/ids.ts";
export * from "./protocol/types.ts";
export {
  type SessionFailureKind,
  type SessionVerifyResult,
  verifySessionFile,
} from "./session-store.ts";
