/** Subscription status enforced by the router (ADR-0003 / PLAN §8). */
export type ProviderStatus =
  | "allowed-direct"
  | "allowed-via-vendor-agent"
  | "interactive-only"
  | "forbidden";

export type ConnectMode = "direct" | "vendor-agent" | "none";

export type WireFormat = "openai-compat" | "anthropic-compat" | "native" | "vendor-cli";

export type ClientIdentity = "honest-ua-required" | "default";

/**
 * Pure config entry for one subscription / access path.
 * No secrets, no I/O — quotes cite docs/plan sources.
 */
export type ProviderEntry = {
  id: string;
  status: ProviderStatus;
  sourceQuote: string;
  sourceUrl: string;
  connect: ConnectMode;
  wired: boolean;
  wire?: WireFormat;
  clientIdentity?: ClientIdentity;
};

/** Caller intent presented to assertAllowed (fail-closed). */
export type RunMode = "headless" | "interactive";

export type ConnectPreference = "direct" | "vendor-agent";

export type Intent = {
  providerId: string;
  mode: RunMode;
  connect: ConnectPreference;
  /** When true, entry.wired must be true (live wire demanded). */
  requireLive?: boolean;
};

export type DenyReason =
  | "unknown-provider"
  | "forbidden"
  | "interactive-only-headless"
  | "connect-mismatch"
  | "unwired";

export class RegistryDeniedError extends Error {
  readonly code = "REGISTRY_DENIED" as const;
  readonly reason: DenyReason;
  readonly providerId: string;

  constructor(reason: DenyReason, providerId: string, message: string) {
    super(message);
    this.name = "RegistryDeniedError";
    this.reason = reason;
    this.providerId = providerId;
  }
}
