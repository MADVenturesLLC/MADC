import { getById } from "./catalog.ts";
import { type Intent, type ProviderEntry, RegistryDeniedError } from "./types.ts";

/** Default freshness window (M1-A1 / D-M1-6): an allow entry older than this denies. */
export const DEFAULT_STALE_DAYS = 30;

/**
 * Pure freshness check: `verifiedAt` older than `days` (default 30) means stale.
 * An invalid or future `verifiedAt`, clock, or freshness window is stale (fail-closed).
 * Exactly `days` old is not stale ("more than 30 days old" denies).
 */
export function isStale(
  entry: ProviderEntry,
  now: number,
  days: number = DEFAULT_STALE_DAYS,
): boolean {
  if (!Number.isFinite(now) || !Number.isFinite(days) || days < 0) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.verifiedAt)) return true;
  const verified = Date.parse(entry.verifiedAt);
  if (
    !Number.isFinite(verified) ||
    new Date(verified).toISOString().slice(0, 10) !== entry.verifiedAt
  )
    return true;
  return verified > now || (now - verified) / 86_400_000 > days;
}

/**
 * Fail-closed evaluation of one entry: forbidden / interactive-only+headless /
 * headless-denied+headless / connect mismatch / stale-without-override / unwired-when-live-required
 * all throw RegistryDeniedError. Pure — no network, keychain, clock, or filesystem I/O:
 * freshness is evaluated only when `intent.now` is supplied by the caller.
 */
export function checkEntry(entry: ProviderEntry, intent: Intent): ProviderEntry {
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

  // M1-A1 / D-M1-3: allowed-direct alone never implies a headless allow.
  if (
    entry.status === "allowed-direct" &&
    entry.headless === "denied" &&
    intent.mode === "headless"
  ) {
    throw new RegistryDeniedError(
      "headless-not-permitted",
      entry.id,
      `Provider "${entry.id}" denies headless use until the Founder records permission (D-M1-3).`,
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

  // D-M1-6: a stale allow entry denies; a per-entry Founder override lets it through.
  // `forbidden` never relaxes on staleness (handled above, before any freshness read).
  if (
    intent.now !== undefined &&
    entry.founderOverride === undefined &&
    isStale(entry, intent.now)
  ) {
    throw new RegistryDeniedError(
      "terms-stale",
      entry.id,
      `Provider "${entry.id}" terms were last verified ${entry.verifiedAt || "never"}; re-verify or record a Founder override.`,
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

/**
 * Fail-closed enforcement by registry id: unknown id denies, otherwise checkEntry.
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

  return checkEntry(entry, intent);
}
