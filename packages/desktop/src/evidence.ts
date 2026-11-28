/**
 * M3-A2 (`docs/plan/PIN-madc-M3-desktop-protocol.md` §4): evidence-bound UI rule.
 *
 * No widget in `packages/desktop` may render a green/verified status unless backed by a verified
 * engine-returned receipt (`chainOk` + 64-hex `hash`, 40-hex `sha`, or `vendorReported` +
 * non-empty `servedModel`). Unverified or missing evidence renders `neutral`, `warn`, or `fail`
 * — never `verified`, and never accepts a caller-supplied `verified` boolean.
 *
 * Runtime implementation lives in `../ui/shell.js` so `ui/index.html` runs the exact tested code.
 */

export type EvidenceReceipt =
  | { readonly kind: "hash"; readonly chainOk: boolean; readonly hash: string }
  | { readonly kind: "sha"; readonly sha: string }
  | {
      readonly kind: "servedModel";
      readonly servedModel: string;
      readonly vendorReported: boolean;
    };

export type EvidenceTone = "verified" | "neutral" | "warn" | "fail";

export type PillLabel =
  | "VERIFIED"
  | "NO RECEIPT"
  | "IDLE"
  | "CONNECTING"
  | "CONNECTED"
  | "DISCONNECTED"
  | "RUNNING"
  | "COMPLETED"
  | "UNVERIFIED"
  | "STOPPED"
  | "FAILED"
  | "INTERRUPTED";

export { evidenceTone, isVerifiedReceipt } from "../ui/shell.js";
