/**
 * @madc/registry — rules-aware provider catalog v2 + fail-closed assertAllowed.
 * Pure data + pure functions. No network, keychain, clock, or secret I/O.
 * Act M1-A1 (was M0-A1).
 */

export {
  assertAllowed,
  checkEntry,
  DEFAULT_STALE_DAYS,
  isStale,
} from "./assert.ts";
export {
  canServe,
  getById,
  lanesFor,
  listCatalog,
  PROVIDER_CATALOG,
} from "./catalog.ts";
export {
  type AllowedDirectEntry,
  type ClientIdentity,
  type ConnectMode,
  type ConnectPreference,
  type CredentialClass,
  type DenyReason,
  type ForbiddenEntry,
  type FounderOverride,
  type HeadlessPermission,
  type Intent,
  type InteractiveOnlyEntry,
  type ProviderEntry,
  type ProviderStatus,
  RegistryDeniedError,
  type RunMode,
  type VendorAgentEntry,
  type WireFormat,
} from "./types.ts";
