/**
 * M3-A2 (`docs/plan/PIN-madc-M3-desktop-protocol.md` §4): evidence-bound UI rule.
 *
 * No widget in `packages/desktop` may render a green/verified status unless backed by a verified
 * `hash`, `sha`, or `servedModel` receipt from `@madc/engine`. Unverified or missing evidence
 * renders `neutral`, `warn`, or `fail` — never `verified`.
 */

const SHA256_HEX = /^[0-9a-f]{64}$/;
const GIT_SHA_HEX = /^[0-9a-f]{40}$/;

export type EvidenceReceipt =
  | { readonly kind: "hash"; readonly hash: string; readonly verified: boolean }
  | { readonly kind: "sha"; readonly sha: string; readonly verified: boolean }
  | {
      readonly kind: "servedModel";
      readonly servedModel: string;
      readonly verified: boolean;
    };

export type EvidenceTone = "verified" | "neutral" | "warn" | "fail";

/**
 * Determine whether a receipt earns the `verified` (green-eligible) state per M3 pin §4.
 * Fails closed: malformed hashes/SHAs, blank model strings, or `verified !== true` never earn
 * `verified`.
 */
export function isVerifiedReceipt(receipt: EvidenceReceipt | null | undefined): boolean {
  if (receipt === null || receipt === undefined || receipt.verified !== true) return false;
  switch (receipt.kind) {
    case "hash":
      return SHA256_HEX.test(receipt.hash);
    case "sha":
      return GIT_SHA_HEX.test(receipt.sha);
    case "servedModel":
      return receipt.servedModel.trim().length > 0;
  }
}

/**
 * Map a receipt and explicit status hint to an evidence-bound UI tone.
 * Even if `hint === "ok"`, `verified` is returned ONLY when `isVerifiedReceipt(receipt)` is true.
 */
export function evidenceTone(
  receipt: EvidenceReceipt | null | undefined,
  hint: "ok" | "neutral" | "warn" | "fail" = "neutral",
): EvidenceTone {
  if (hint === "fail") return "fail";
  if (hint === "warn") return "warn";
  if (isVerifiedReceipt(receipt)) return "verified";
  return "neutral";
}
