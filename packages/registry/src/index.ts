/**
 * @madc/registry — rules-aware provider catalog + fail-closed assertAllowed.
 * Pure data + pure functions. No network, keychain, or secret I/O.
 * Act M0-A1.
 */

export { assertAllowed } from "./assert.ts";
export {
  getById,
  listCatalog,
  PROVIDER_CATALOG,
} from "./catalog.ts";
export {
  type ClientIdentity,
  type ConnectMode,
  type ConnectPreference,
  type DenyReason,
  type Intent,
  type ProviderEntry,
  type ProviderStatus,
  RegistryDeniedError,
  type RunMode,
  type WireFormat,
} from "./types.ts";
