/**
 * Generic ACP client (Act M1-A6): one `ProviderPort` for every ACP-speaking vendor agent. A new
 * agent is an `AcpAgentSpec` plus a registry entry (see `../grok-build.ts`).
 */
export {
  type AcpAgentSpec,
  type AcpPortOptions,
  type AcpSpawn,
  createAcpPort,
  findAgentBinary,
} from "./client.ts";
export {
  ACP_ANSWERED_STOP_REASONS,
  ACP_AUTH_REQUIRED,
  ACP_CLIENT_CAPABILITIES,
  ACP_PROTOCOL_VERSION,
  type AcpAuthChoice,
  type AcpAuthMethod,
  type AcpStopReason,
  type AcpUpdate,
  authMethodsOf,
  createToolTracker,
  parseSessionUpdate,
  permissionOutcome,
  reportedModelOf,
  toolOutputText,
} from "./wire.ts";
