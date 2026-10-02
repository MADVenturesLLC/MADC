/**
 * @madc/engine — local protocol host (Act M0-A2), seat files + hash-chained sessions (M0-A4),
 * engine-owned credential store + `auth/*` presence methods (M1-A2).
 * Contract: docs/plan/PIN-madc-M1-protocol-messages.md (supersedes the M0 pin for M1 work).
 * stdio JSONL only.
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
export { runAuthSet } from "./credentials/auth-set.ts";
export {
  type CredentialSource,
  type CredentialStore,
  type CredentialStoreDeps,
  createCredentialStore,
  credentialEnvVar,
  KEYCHAIN_SERVICE,
  MADC_DEV_ENV_KEYS,
  type RunCommand,
  type RunCommandResult,
  type RunCommandSpec,
} from "./credentials/store.ts";
export {
  checkHandoffTarget,
  type HandoffTargetCheck,
  type HandoffTargetFacts,
  type InspectSessionDeps,
  inspectSessionV2,
  type SessionFinding,
  type SessionFindingCode,
  type SessionFindingLevel,
} from "./handoff.ts";
export {
  confinedPath,
  type HomeSubdir,
  resolveMadcHome,
  sessionsOwnerReadUnsupported,
} from "./home.ts";
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
export {
  type AgentFactory,
  defaultAgentFactory,
  type StdioEngineOptions,
  startStdioEngine,
} from "./main.ts";
export {
  defaultGitRunner,
  type GitCommandResult,
  type GitRunner,
  type OriginRemoteResolution,
  type Realpath,
  type RepoIdentity,
  type RepoIdentityDeps,
  type RepoIdentityResolution,
  resolveOriginRemote,
  resolveRepoIdentity,
} from "./policy/identity.ts";
export {
  denyAllRepoPolicy,
  isRepoGated,
  type LoadRepoPolicyOptions,
  loadRepoPolicy,
  POLICY_FILE_NAME,
  POLICY_VERSION,
  type PolicyFileIssue,
  REPO_GATED_PROVIDER_IDS,
  type RejectedPolicyEntry,
  type RepoAllowEntry,
  type RepoDecision,
  type RepoDecisionReason,
  type RepoPolicy,
  type RepoPolicyLoad,
} from "./policy/store.ts";
export {
  effectiveLaneMode,
  type Presence,
  presenceRequired,
  sameTerminal,
  type TerminalFacts,
} from "./presence/policy.ts";
export {
  createSystemTerminal,
  type PresenceTerminal,
  type SystemTerminalDeps,
} from "./presence/terminal.ts";
export * from "./protocol/errors.ts";
export { ID_PATTERN, isValidId, newId } from "./protocol/ids.ts";
export * from "./protocol/types.ts";
export { encodeMessage, type Incoming, parseLine } from "./protocol/wire.ts";
export {
  createProviderAgent,
  type DirectLane,
  type ProviderAgentOptions,
} from "./provider-agent.ts";
export {
  defaultBinaryPresence,
  listProviderSummaries,
  type ProviderPresence,
} from "./providers/list.ts";
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
  seatBackingIssue,
  validateSeat,
} from "./seat.ts";
export {
  type LoadedSeat,
  loadSeat,
  type SeedResult,
  seatFilePath,
  seedDefaultSeat,
  seedSeatFile,
  serializeSeat,
} from "./seat-store.ts";
export {
  type Lane,
  type LaneMismatch,
  laneMismatch,
  laneOf,
  type NeverEligible,
  neverEligibleFallbacks,
  neverEligibleWarning,
} from "./seats/lane.ts";
export { listSeatSummaries, seatSummary } from "./seats/list.ts";
export { ensureSeatMemoryFile, type SeatMemoryFile } from "./seats/memory.ts";
export {
  DAEDALUS_SEAT,
  HEPHAESTUS_SEAT,
  PROMETHEUS_SEAT,
  ROSTER_SEATS,
  type RosterSeedFailure,
  type RosterSeedReport,
  SURFACE_ARCHITECT_SEAT,
  seedRosterSeats,
} from "./seats/roster.ts";
export { ENGINE_VERSION, EngineConnection, type EngineOptions, runEngine } from "./server.ts";
export {
  createRedactor,
  type EvidenceRef,
  type FallbackLane,
  type FallbackRejectedPayload,
  type FounderDecisionPayload,
  GENESIS_HASH,
  type HandoffAbortedPayload,
  type HandoffAbortReason,
  type HandoffLinkPayload,
  type HandoffOutPayload,
  type MemoryWritePayload,
  REDACTED,
  RESERVED_EVENT_TYPES,
  type RebuiltSession,
  type RepoDecisionPayload,
  type ReservedEventType,
  rebuildSession,
  SESSION_EVENT_TYPES,
  type ServedModelPayload,
  SessionChainIndex,
  type SessionClosePayload,
  type SessionEvent,
  type SessionEventType,
  type SessionOpenHandoffLink,
  type SessionOpenPayload,
  type SessionPayloads,
  type SessionVerifyResult,
  SessionWriter,
  sessionEventHash,
  sortedKeyJson,
  TOKEN_PATTERNS,
  type ToolCallReceiptPayload,
  type TurnStartPayload,
  type TurnStartTty,
  verifySessionFile,
  verifySessionText,
  type WorktreeIdentity,
} from "./session-store.ts";
export {
  checkEvidenceRef,
  checkHandoffLink,
  checkV2Payload,
  checkWorktreeIdentity,
  HANDOFF_ABORT_REASONS,
  redactionRefusal,
  type ShapeIssue,
  sessionRefPath,
  structuralView,
  V2_EVENT_TYPES,
  type V2EventType,
  validateForWrite,
  type WriteRefusal,
} from "./session-v2.ts";
export { rereadWorktreeIdentity, resolveWorktreeIdentity } from "./worktree.ts";
