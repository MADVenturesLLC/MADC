/**
 * `provider/list` (M1-A8; protocol pin §3.5 P4, §5 `ProviderSummary`). Read-only: one summary per
 * registry catalog entry — wired, unwired and `forbidden` stubs alike — in catalog order, so
 * `madc providers ls` and `madc doctor` report every lane from this one source.
 *
 * Presence is the only thing probed, and it is a boolean:
 *
 * - a `direct` lane asks the engine's credential store for presence (`status`, the same answer
 *   `auth/status` gives; the store's probe never reads the secret, M1-A2);
 * - a `vendor-agent` lane whose adapter is in this build gets a read-only PATH lookup for its binary
 *   (the same finder the turn preflight uses; nothing is executed);
 * - everything else carries no presence field rather than a guess.
 *
 * Never a credential value, length, prefix or hash: the store answers presence only, and a binary
 * lookup's path is reduced to found / not found before it leaves this module.
 */
import {
  CLAUDE_CODE_PROVIDER_ID,
  CODEX_PROVIDER_ID,
  findClaudeBinary,
  findCodexBinary,
  findGrokBinary,
  GROK_BUILD_PROVIDER_ID,
} from "@madc/adapters";
import { isStale, listCatalog } from "@madc/registry";
import type { ProviderSummary } from "../protocol/types.ts";

/** How `provider/list` learns presence (production defaults below; tests inject fakes). */
export type ProviderPresence = {
  /** Credential presence for a `direct` lane. Presence only — never a value. */
  readonly credentials: (providerId: string) => Promise<boolean>;
  /**
   * Binary presence for a `vendor-agent` lane: `true` / `false` for a lane whose binary this build
   * looks for, `null` when this build has no adapter (and so no binary name) for the lane.
   */
  readonly binary: (providerId: string) => boolean | null;
};

/** The vendor-agent lanes this build has an adapter for, and the finder each one uses. */
const BINARY_FINDERS: ReadonlyMap<
  string,
  (env: Readonly<Record<string, string | undefined>>) => string | null
> = new Map([
  [CLAUDE_CODE_PROVIDER_ID, (env) => findClaudeBinary(env)],
  [CODEX_PROVIDER_ID, (env) => findCodexBinary(env)],
  [GROK_BUILD_PROVIDER_ID, (env) => findGrokBinary(env)],
]);

/** Production binary presence: the turn preflight's own PATH lookups, reduced to a boolean. */
export function defaultBinaryPresence(
  env: Readonly<Record<string, string | undefined>> = process.env,
): (providerId: string) => boolean | null {
  return (providerId) => {
    const find = BINARY_FINDERS.get(providerId);
    return find === undefined ? null : find(env) !== null;
  };
}

/**
 * Every catalog entry as a `ProviderSummary`. Credential probes run concurrently (each is one
 * keychain child capped by the store's own timeout); a probe that throws reports absent, because a
 * credential the engine cannot confirm is not one a turn could use.
 */
export async function listProviderSummaries(
  presence: ProviderPresence,
  now: number,
): Promise<ProviderSummary[]> {
  return Promise.all(
    listCatalog().map(async (entry): Promise<ProviderSummary> => {
      const base = {
        id: entry.id,
        status: entry.status,
        wired: entry.wired,
        verifiedAt: entry.verifiedAt,
        stale: isStale(entry, now),
      };
      if (entry.connect === "direct") {
        let present: boolean;
        try {
          present = (await presence.credentials(entry.id)) === true;
        } catch {
          present = false;
        }
        return { ...base, credentialsPresent: present };
      }
      if (entry.connect === "vendor-agent") {
        const found = presence.binary(entry.id);
        return found === null ? base : { ...base, binaryPresent: found };
      }
      return base;
    }),
  );
}
