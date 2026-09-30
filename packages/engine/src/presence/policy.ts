/**
 * M1-A5 presence policy (M1 plan §7 M1-A5; protocol pin §3.3 P3; seat pin §4.2 S4). Pure: registry
 * reads only, no I/O. The terminal itself is `presence/terminal.ts`.
 *
 * The rule in one sentence: **a client's `mode: "interactive"` claim is necessary but never
 * sufficient** — any local program can send it. A lane whose serving depends on that claim serves a
 * turn only when the ENGINE has verified a person at the controlling terminal for that turn.
 *
 * "Depends on the claim" means the lane serves interactive turns but not headless ones. That is
 * every `interactive-only` lane (MiniMax Token Plan, Alibaba Coding Plan) and — deliberately — an
 * `allowed-direct` lane with `headless: "denied"` (`ollama-cloud`, D-M1-3). Before M1-A5 every turn
 * was headless, so D-M1-3 was enforced by refusing ollama-cloud outright; if the bare claim unlocked
 * it now, a detached program could send `mode: "interactive"` and reach the very lane the Founder
 * denied to automation (D-M1-4: surface-architect "is interactive-only while D-M1-3 denies headless").
 * Lanes that serve headless anyway (direct `headless: "allowed"`, vendor agents) gain nothing from the
 * claim, so they need no check.
 */
import { canServe, type ProviderEntry, type RunMode } from "@madc/registry";

/** The per-turn check result recorded on `turn.start` (seat pin §4.2 S4). */
export type Presence = "verified" | "absent";

/**
 * Identity of the controlling terminal a human confirmed on. `device` is the terminal's
 * `major/minor`; `session` is the session id where the OS exposes it (Linux), else `null` (macOS
 * hides it from `ps`). Neither is a secret.
 */
export type TerminalFacts = { readonly device: string; readonly session: string | null };

/** True when a lane would serve an interactive turn but not a headless one (see module docs). */
export function presenceRequired(entry: ProviderEntry | undefined): boolean {
  return entry !== undefined && canServe(entry, "interactive") && !canServe(entry, "headless");
}

/**
 * The mode a lane is asked to serve: the client's claim, except that a lane needing presence sees
 * `headless` unless presence was verified for this turn — so `assertAllowed` refuses it with the
 * lane's own headless reason (`interactive-only-headless` / `headless-not-permitted`).
 */
export function effectiveLaneMode(
  entry: ProviderEntry | undefined,
  claim: RunMode,
  presence: Presence,
): RunMode {
  return presenceRequired(entry) && presence !== "verified" ? "headless" : claim;
}

/** Same terminal = same device and same session id (a lost or changed terminal voids a confirmation). */
export function sameTerminal(a: TerminalFacts, b: TerminalFacts): boolean {
  return a.device === b.device && a.session === b.session;
}
