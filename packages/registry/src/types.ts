/** Subscription status enforced by the router (ADR-0003 / M1 plan §9 S1). */
export type ProviderStatus =
  | "allowed-direct"
  | "allowed-via-vendor-agent"
  | "interactive-only"
  | "forbidden";

export type ConnectMode = "direct" | "vendor-agent" | "none";

export type WireFormat = "openai-compat" | "anthropic-compat" | "native" | "vendor-cli";

export type ClientIdentity = "honest-ua-required" | "default";

/**
 * Credential class (billing) — Founder ruling 12 (planning record Appendix R:
 * "plan keys interactive, pay-as-you-go headless/CI, never mixed").
 * - `plan-interactive`: a plan key restricted to interactive use (MiniMax / Alibaba plans).
 * - `payg`: an API key usable for headless/CI (direct-key lanes).
 * - `vendor-session`: the vendor agent owns the login (Claude Code / Codex / Grok Build).
 * Forbidden entries carry no credential class: there is no lane to class.
 */
export type CredentialClass = "plan-interactive" | "payg" | "vendor-session";

/**
 * Per-entry Founder override for a stale allow entry (D-M1-6). Presence lets a
 * stale entry through the `terms-stale` denial; `forbidden` never relaxes.
 */
export type FounderOverride = Readonly<{
  by: string;
  date: string;
  note: string;
}>;

/**
 * Recorded Founder permission to flip an entry to `headless: "allowed"` (D-M1-3).
 * Required on `ollama-cloud` before it may ship `headless: "allowed"`; there is no
 * user-writable file or env override — the flip is a reviewed catalog change.
 */
export type HeadlessPermission = Readonly<{
  by: string;
  date: string;
  note: string;
  sourceUrl: string;
}>;

/** Fields every catalog entry carries. No secrets, no I/O — quotes cite docs/plan sources. */
type EntryBase = Readonly<{
  id: string;
  /** Verbatim terms quote. For rows covered by roadmap §3 it equals the text quoted there. */
  sourceQuote: string;
  /** In-repo citation anchor for the quote. */
  sourceUrl: string;
  /** Live terms page. Empty string when no terms page is pinned (UNVERIFIED). */
  termsUrl: string;
  /** ISO date the terms were last read on the live page. Empty string = never verified (stale). */
  verifiedAt: string;
  /** True only when the lane is actually wired in this build. */
  wired: boolean;
  wire?: WireFormat;
  clientIdentity?: ClientIdentity;
  founderOverride?: FounderOverride;
}>;

/** Direct-key lane. `headless` is required and has no default (M1-A1): allowed-direct never implies a headless allow. */
export type AllowedDirectEntry = EntryBase &
  Readonly<{
    status: "allowed-direct";
    connect: "direct";
    credentialClass: "payg";
    headless: "allowed" | "denied";
    headlessPermission?: HeadlessPermission;
  }>;

/** Vendor-agent lane; the vendor binary owns the login. Serves both modes. */
export type VendorAgentEntry = EntryBase &
  Readonly<{
    status: "allowed-via-vendor-agent";
    connect: "vendor-agent";
    credentialClass: "vendor-session";
  }>;

/** Interactive-only lane: headless is always denied by status (no `headless` field). */
export type InteractiveOnlyEntry = EntryBase &
  Readonly<{
    status: "interactive-only";
    connect: ConnectMode;
    credentialClass: "plan-interactive";
  }>;

/** No lane. `forbidden` never relaxes, including on staleness (D-M1-6). */
export type ForbiddenEntry = EntryBase &
  Readonly<{
    status: "forbidden";
    connect: "none";
  }>;

/**
 * Pure config entry for one subscription / access path.
 * Discriminated on `status`; readonly so typed callers cannot mutate fail-closed policy fields.
 */
export type ProviderEntry =
  | AllowedDirectEntry
  | VendorAgentEntry
  | InteractiveOnlyEntry
  | ForbiddenEntry;

/** Caller intent presented to assertAllowed (fail-closed). */
export type RunMode = "headless" | "interactive";

export type ConnectPreference = "direct" | "vendor-agent";

export type Intent = {
  providerId: string;
  mode: RunMode;
  connect: ConnectPreference;
  /** When true, entry.wired must be true (live wire demanded). */
  requireLive?: boolean;
  /**
   * unix ms. When present, a stale allow entry (isStale) without `founderOverride`
   * denies with `terms-stale`. When absent, freshness is not enforced at this layer
   * (callers without a clock get M0 behavior; doctor / provider-list compute staleness
   * explicitly via isStale).
   */
  now?: number;
};

export type DenyReason =
  | "unknown-provider"
  | "forbidden"
  | "interactive-only-headless"
  | "connect-mismatch"
  | "unwired"
  | "repo-not-allowed"
  | "repo-identity-ambiguous"
  | "terms-stale"
  | "headless-not-permitted";

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
