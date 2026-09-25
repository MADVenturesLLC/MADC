/**
 * Built-in `madc-default` seat (seat pin §3, plan D4). A3 reads it in memory; A4 adds seat files,
 * auto-seeding, and schema validation, and must seed exactly this content.
 */
import { DEFAULT_SEAT_ID } from "./protocol/types.ts";

/** The seat fields A3 consumes. Full seat schema (memory/tools/handoffs) lands with A4. */
export type EngineSeat = {
  readonly id: string;
  readonly version: 1;
  readonly role: string;
  readonly standingInstructions: string;
  /** `<pi-ai provider>/<model id>` for kimi-code. */
  readonly pinnedModel: string;
  /** Registry provider id passed to `assertAllowed` (plain string: checked at runtime, fail-closed). */
  readonly preferredBacking: string;
  readonly policy: { readonly headlessOk: boolean };
};

export const MADC_DEFAULT_SEAT: EngineSeat = Object.freeze({
  id: DEFAULT_SEAT_ID,
  version: 1,
  role: "general builder",
  standingInstructions:
    "You are madc-default, the built-in MAD seat. Prefer concrete edits and verified commands. Obey registry and tool deny rules. Record honest model identity.",
  pinnedModel: "kimi-coding/kimi-for-coding",
  preferredBacking: "kimi-code",
  policy: Object.freeze({ headlessOk: true }),
});
