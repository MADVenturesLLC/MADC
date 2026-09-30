/**
 * The D-M1-7 same-lane rule as one pure predicate (M1 seat pin §2 "Same-lane fallback rule",
 * M1 plan §6). One source of truth for the two places the rule binds: the turn-time rejection
 * (`provider-agent.ts`, which writes the pinned `fallback.rejected` event) and the seat-load
 * warning for a fallback that can never be eligible (`seat-store.ts`, M1-A7).
 *
 * A candidate is eligible only if its registry `status` AND its `credentialClass` (billing) equal
 * those of the seat's assigned backing (`preferredBacking`). Both come from the frozen catalog, so
 * the answer is static per catalog: a mismatched cell can never become eligible without a registry
 * change — which is exactly what the load warning reports.
 *
 * Pure: catalog reads only, no I/O. Mode, credentials and repo policy are NOT decided here; they
 * are separate turn-time gates (`assertAllowed`, the credential store, M1-A4's repo identity).
 */
import { getById, type ProviderEntry, type ProviderStatus } from "@madc/registry";

/** One lane's identity for the same-lane rule: registry status AND billing class. */
export type Lane = {
  readonly status: ProviderStatus;
  readonly credentialClass: string;
};

/**
 * Billing class for the rule. A `forbidden` entry carries no `credentialClass` (registry types:
 * "there is no lane to class"), so it reports `"none"` — the shape the pinned `fallback.rejected`
 * payload carries (M1 seat pin §4.2).
 */
export function laneOf(entry: ProviderEntry): Lane {
  return {
    status: entry.status,
    credentialClass: "credentialClass" in entry ? entry.credentialClass : "none",
  };
}

/** The two lanes a rejection record must name (M1 seat pin §4.2 `fallback.rejected`). */
export type LaneMismatch = {
  readonly assignedLane: Lane;
  readonly candidateLane: Lane;
};

/**
 * `null` when the two entries are in the same lane (eligible on the lane axis); otherwise both
 * lanes, for the pinned rejection record. Unknown ids are the caller's business, not a mismatch:
 * seat load already refuses them (-32006) and the turn-time walk logs and skips them.
 */
export function laneMismatch(
  assigned: ProviderEntry,
  candidate: ProviderEntry,
): LaneMismatch | null {
  const assignedLane = laneOf(assigned);
  const candidateLane = laneOf(candidate);
  if (
    assignedLane.status === candidateLane.status &&
    assignedLane.credentialClass === candidateLane.credentialClass
  ) {
    return null;
  }
  return { assignedLane, candidateLane };
}

/** A listed fallback that can never be eligible, with both lanes the warning must name. */
export type NeverEligible = {
  readonly candidate: string;
  readonly assignedLane: Lane;
  readonly candidateLane: Lane;
};

/**
 * The listed fallbacks that can never be eligible under the same-lane rule, in list order
 * (M1 seat pin §2: "Seat load (M1-A7) and `madc doctor` warn on any listed fallback that can
 * never be eligible"). Ids the catalog does not know are not reported here: they are a hard seat
 * load failure (-32006), not a warning.
 */
export function neverEligibleFallbacks(
  preferredBacking: string,
  fallbacks: readonly string[],
): readonly NeverEligible[] {
  const assigned = getById(preferredBacking);
  if (assigned === undefined) return [];
  const never: NeverEligible[] = [];
  for (const candidate of fallbacks) {
    const entry = getById(candidate);
    if (entry === undefined) continue;
    const mismatch = laneMismatch(assigned, entry);
    if (mismatch !== null) never.push({ candidate, ...mismatch });
  }
  return never;
}

/** The one warning line a never-eligible fallback is logged and reported with. */
export function neverEligibleWarning(seatId: string, entry: NeverEligible): string {
  return (
    `seat ${seatId}: fallback ${entry.candidate} can never be eligible ` +
    `(fallback-lane-mismatch; assigned ${entry.assignedLane.status}/${entry.assignedLane.credentialClass}, ` +
    `candidate ${entry.candidateLane.status}/${entry.candidateLane.credentialClass})`
  );
}
