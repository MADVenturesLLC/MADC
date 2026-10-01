/**
 * The CLI's turn mode CLAIM (M1-A5; M1 plan §7 M1-A5, protocol pin §3.3 P3).
 *
 * `interactive` only when stdin AND stdout are TTYs and the run is not the `-p` print one-shot;
 * otherwise `headless`. This is a claim and nothing more: any local program can send
 * `mode: "interactive"`, so the engine never trusts it alone. A lane that serves only a person at
 * the terminal is unlocked solely by the ENGINE's own presence check on its controlling terminal.
 *
 * Surfaces (I2): the witnessed entries (`madc` bare / with text / `-s <seatId>`, tier W or A)
 * claim through this rule with `print: false`. The `-p` one-shot still sends an explicit
 * `mode: claimMode({…, print: true})` headless claim (M1-A5) — never interactive.
 */
import type { TurnMode } from "@madc/engine/client";

export type ModeFacts = {
  readonly stdinIsTTY: boolean;
  readonly stdoutIsTTY: boolean;
  /** True for `madc -p …` (the print / one-shot mode). */
  readonly print: boolean;
};

export function claimMode(facts: ModeFacts): TurnMode {
  return facts.stdinIsTTY && facts.stdoutIsTTY && !facts.print ? "interactive" : "headless";
}
