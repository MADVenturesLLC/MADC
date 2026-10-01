/**
 * The M1 seat roster (M1-A7): the five seeds of M1 seat pin §3 / M1 plan §6 (Founder-accepted
 * 2026-09-25, D-M1-4), and the one writer that lands them.
 *
 * One source of seed content: engine start and `madc doctor --init` both call `seedRosterSeats`,
 * which calls the same per-file writer as `seedDefaultSeat` (M0 Amendment 3 item 4's `created:false`
 * proof contract is that writer's, unchanged and per file). A seat is written only when its
 * `seats/<id>.json` is missing; an existing file is never overwritten.
 *
 * `pinnedModel` values are locked here by act M1-A7 (seat pin §3: "not pinned here"), each against
 * the pinned pi-ai catalog or a model id already named in this repo — see the per-seat notes below.
 * Registry ids (`kimi-code`) and pi-ai provider ids (`kimi-coding`) differ on purpose.
 *
 * `tools.deny` encoding: no matcher consumes `tools.deny` in this build (tool gating is a later
 * act), and the pinned pattern comment (`"bash"`, `"write:*"`) has no form for a negatively scoped
 * rule such as §6's "writes outside `docs/**`". Rather than approximate a Founder-ruled cell with a
 * glob that a future matcher would silently misread, each entry records its §6 clause verbatim; the
 * same text reaches the model through `standingInstructions`, which the turn does deliver. The act
 * that lands tool gating owns the grammar and can migrate these strings.
 */
import { type EngineSeat, MADC_DEFAULT_SEAT } from "../seat.ts";
import { type SeedResult, seedSeatFile } from "../seat-store.ts";

/** M1 plan §6 / seat pin §3, in the pin's table order. `madc-default` is the unchanged M0 v1 seed. */
export const DAEDALUS_SEAT: EngineSeat = Object.freeze({
  id: "daedalus",
  version: 2,
  role: "architect",
  standingInstructions:
    "You are daedalus, the MAD architect seat. Research first, then plan: write docs, plans and D-tables, not code. Writes outside docs/** are denied, and git push to main is denied. Obey registry and tool deny rules. Record honest model identity.",
  displayName: "Daedalus",
  // M0 runbook §4 names `claude-sonnet-4-5` as the vendor model name for a claude-code seat; the
  // vendor binary is the authority (M1 seat pin §2: "vendor model name for vendor-agent lanes").
  pinnedModel: "claude-sonnet-4-5",
  preferredBacking: "claude-code",
  // Seeded as §6 writes it. This hop crosses allowed-via-vendor-agent/vendor-session into
  // allowed-direct/payg, so the same-lane rule (D-M1-7) rejects it on every turn and seat load
  // warns; it is never replaced or "fixed" here (M1 plan §6: "until the Founder changes that cell").
  fallbacks: Object.freeze(["kimi-code"]),
  memory: Object.freeze({ mode: "file", path: "memory/daedalus.md" }),
  tools: Object.freeze({ deny: Object.freeze(["writes outside docs/**", "git push to main"]) }),
  policy: Object.freeze({ headlessOk: true }),
  handoffs: Object.freeze({ enabled: false, targets: Object.freeze([]) }),
} as const);

export const HEPHAESTUS_SEAT: EngineSeat = Object.freeze({
  id: "hephaestus",
  version: 2,
  role: "builder",
  standingInstructions:
    "You are hephaestus, the MAD builder seat. Land acts with tests and pull requests; never merge. git push to main is denied, and branch-protection APIs are denied. Obey registry and tool deny rules. Record honest model identity.",
  displayName: "Hephaestus",
  // M0 runbook §5 names `gpt-5.1-codex` as the vendor model name for a codex seat.
  pinnedModel: "gpt-5.1-codex",
  preferredBacking: "codex",
  // Same lane as the assigned backing (allowed-via-vendor-agent + vendor-session), so this hop is
  // eligible under D-M1-7 whenever the codex attempt records quota-or-unreachable.
  fallbacks: Object.freeze(["claude-code"]),
  memory: Object.freeze({ mode: "file", path: "memory/hephaestus.md" }),
  tools: Object.freeze({ deny: Object.freeze(["git push to main", "branch-protection APIs"]) }),
  policy: Object.freeze({ headlessOk: true }),
  handoffs: Object.freeze({ enabled: false, targets: Object.freeze([]) }),
} as const);

export const PROMETHEUS_SEAT: EngineSeat = Object.freeze({
  id: "prometheus",
  version: 2,
  role: "idea and research",
  standingInstructions:
    "You are prometheus, the MAD idea and research seat. Gather sources, keep ledgers and return verdicts with their citations. Writes outside docs/** and scratch are denied. Obey registry and tool deny rules. Record honest model identity.",
  displayName: "Prometheus",
  // The M0-A3 lock, unchanged (seat pin §3): pi-ai provider `kimi-coding`, model `kimi-for-coding`.
  pinnedModel: "kimi-coding/kimi-for-coding",
  preferredBacking: "kimi-code",
  // Empty (I3 Option B, Founder default). A seat carries one lane-namespaced `pinnedModel`;
  // `kimi-coding/kimi-for-coding` cannot resolve in another direct lane's namespace (e.g.
  // `ollama-cloud`), so a same-lane hop here was never honest. Citation: Founder 2026-09-30
  // pin-the-subscription-surface. Do not invent a second model id to fill the cell.
  fallbacks: Object.freeze([]),
  memory: Object.freeze({ mode: "file", path: "memory/prometheus.md" }),
  tools: Object.freeze({ deny: Object.freeze(["writes outside docs/** and scratch"]) }),
  policy: Object.freeze({ headlessOk: true }),
  handoffs: Object.freeze({ enabled: false, targets: Object.freeze([]) }),
} as const);

export const SURFACE_ARCHITECT_SEAT: EngineSeat = Object.freeze({
  id: "surface-architect",
  version: 2,
  role: "contracts and pins",
  standingInstructions:
    "You are surface-architect, the MAD contracts and pins seat: protocol, seat format and the UX system. Writes outside docs/plan/PIN-* and docs/** are denied. This seat serves interactive turns only while D-M1-3 denies Ollama headless use. Obey registry and tool deny rules. Record honest model identity.",
  displayName: "Surface Architect",
  // Locked against the repo's own verified record of the live Ollama list, not invented:
  // planning record OLL-19 (VERIFIED, live ollama.com/api/tags 2026-09-24) lists `gpt-oss:120b`,
  // and OLL-17 (VERIFIED) quotes the rule for this lane — "For API requests to ollama.com, use the
  // name returned by this list". The `/api/tags` name is model truth at call time (M1-A3).
  pinnedModel: "ollama-cloud/gpt-oss:120b",
  preferredBacking: "ollama-cloud",
  // Empty (I3 Option B, Founder default). `ollama-cloud/gpt-oss:120b` cannot resolve in
  // `kimi-code`'s namespace — a seat's single `pinnedModel` is lane-namespaced (Founder
  // 2026-09-30 pin-the-subscription-surface). Same-lane on the D-M1-7 axis is not enough.
  fallbacks: Object.freeze([]),
  memory: Object.freeze({ mode: "file", path: "memory/surface-architect.md" }),
  tools: Object.freeze({
    deny: Object.freeze(["writes outside docs/plan/PIN-* and docs/**"]),
  }),
  // D-M1-3 / D-M1-4: headless stays denied until the Founder records Ollama headless permission.
  policy: Object.freeze({ headlessOk: false }),
  handoffs: Object.freeze({ enabled: false, targets: Object.freeze([]) }),
} as const);

/** The five seeds, in seat pin §3 order. `madc-default` is the M0 v1 seat object, unchanged. */
export const ROSTER_SEATS: readonly EngineSeat[] = Object.freeze([
  DAEDALUS_SEAT,
  HEPHAESTUS_SEAT,
  PROMETHEUS_SEAT,
  SURFACE_ARCHITECT_SEAT,
  MADC_DEFAULT_SEAT,
]);

/** A seat whose write failed. Seeding is per-seat atomic, so the others still land. */
export type RosterSeedFailure = {
  readonly seatId: string;
  readonly message: string;
};

export type RosterSeedReport = {
  /** One entry per roster seat that landed or already existed, in `ROSTER_SEATS` order. */
  readonly seats: readonly SeedResult[];
  /** Seats whose write was refused. Never reported as `created: false` (Amendment 3 item 4). */
  readonly failures: readonly RosterSeedFailure[];
};

/**
 * Seed the roster (seat pin §3 S3): every seat whose `seats/<id>.json` is missing, through the one
 * per-file writer, never overwriting an existing file. Creates `$MADC_HOME` with `seats/`,
 * `sessions/` and `memory/` (0700) exactly as the M0 default seed does.
 *
 * A refusal on one seat (a symlink, directory, FIFO or hard-linked file at its path, or a `seats/`
 * that stopped being the pinned directory) is collected, never swallowed into `created: false`, and
 * never stops the remaining seats: each file is written atomically, so a partial roster is still a
 * consistent one. The caller logs every failure loudly — a seat that did not seed answers -32005
 * when it is used.
 */
export function seedRosterSeats(home: string): RosterSeedReport {
  const seats: SeedResult[] = [];
  const failures: RosterSeedFailure[] = [];
  for (const seat of ROSTER_SEATS) {
    try {
      seats.push(seedSeatFile(home, seat));
    } catch (err) {
      failures.push({
        seatId: seat.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { seats, failures };
}
