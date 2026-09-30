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
 *
 * Act M1-A2: adds `spawnAuthSet` — the CLI's way to run the one-shot `madc-engine auth-set
 * <providerId>` child (protocol pin §2: a separate process, NOT a JSONL session; stdio inherited
 * so the child owns the no-echo TTY prompt). The credential store itself stays host-side: the CLI
 * never reads, writes or sees a credential value.
 */

export { listCatalog, type ProviderEntry, type ProviderStatus } from "@madc/registry";
export {
  ENGINE_ENTRY,
  EngineClient,
  EngineExitedError,
  EngineProtocolError,
  EngineRpcError,
  type Notification,
  type SpawnAuthSetOptions,
  type SpawnEngineOptions,
  spawnAuthSet,
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
/**
 * Act M1-A4: the read-only `$MADC_HOME/policy.json` loader, so `madc doctor` can report rejected
 * allowlist entries (a path-only entry, an unparseable remote, a key that is not a registry id) and
 * an over-permissive file mode. Reading only — like every other re-export here it never writes,
 * creates or appends, and it never returns a credential.
 */
export {
  isRepoGated,
  loadRepoPolicy,
  POLICY_FILE_NAME,
  type PolicyFileIssue,
  REPO_GATED_PROVIDER_IDS,
  type RejectedPolicyEntry,
  type RepoDecision,
  type RepoPolicy,
  type RepoPolicyLoad,
} from "./policy/store.ts";
export * from "./protocol/errors.ts";
export { ID_PATTERN, isValidId } from "./protocol/ids.ts";
export * from "./protocol/types.ts";
export {
  type SessionFailureKind,
  type SessionVerifyResult,
  verifySessionFile,
} from "./session-store.ts";
