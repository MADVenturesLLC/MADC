import { getById } from "./catalog.ts";
import { type Intent, type ProviderEntry, RegistryDeniedError } from "./types.ts";

/**
 * Fail-closed enforcement: unknown / forbidden / interactive-only+headless /
 * connect mismatch / unwired-when-live-required all throw RegistryDeniedError.
 * Pure — no network, keychain, or filesystem I/O.
 */
export function assertAllowed(intent: Intent): ProviderEntry {
  const entry = getById(intent.providerId);
  if (entry === undefined) {
    throw new RegistryDeniedError(
      "unknown-provider",
      intent.providerId,
      `Unknown provider "${intent.providerId}" — deny (fail-closed).`,
    );
  }

  if (entry.status === "forbidden") {
    throw new RegistryDeniedError(
      "forbidden",
      entry.id,
      `Provider "${entry.id}" is forbidden: ${entry.sourceQuote}`,
    );
  }

  if (entry.status === "interactive-only" && intent.mode === "headless") {
    throw new RegistryDeniedError(
      "interactive-only-headless",
      entry.id,
      `Provider "${entry.id}" is interactive-only; headless mode denied.`,
    );
  }

  if (entry.status === "allowed-direct" && intent.connect !== "direct") {
    throw new RegistryDeniedError(
      "connect-mismatch",
      entry.id,
      `Provider "${entry.id}" requires connect=direct; got ${intent.connect}.`,
    );
  }

  if (entry.status === "allowed-via-vendor-agent" && intent.connect !== "vendor-agent") {
    throw new RegistryDeniedError(
      "connect-mismatch",
      entry.id,
      `Provider "${entry.id}" requires connect=vendor-agent; got ${intent.connect}.`,
    );
  }

  if (
    entry.status === "interactive-only" &&
    entry.connect !== "none" &&
    intent.connect !== entry.connect
  ) {
    throw new RegistryDeniedError(
      "connect-mismatch",
      entry.id,
      `Provider "${entry.id}" requires connect=${entry.connect}; got ${intent.connect}.`,
    );
  }

  if (intent.requireLive === true && entry.wired !== true) {
    throw new RegistryDeniedError(
      "unwired",
      entry.id,
      `Provider "${entry.id}" is not wired for live use (stub only).`,
    );
  }

  return entry;
}
