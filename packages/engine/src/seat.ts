/**
 * Seat schema (seat pin §2) and the built-in `madc-default` seat (seat pin §3, plan D4).
 * Pure: no I/O. File loading, confinement, and seeding live in `seat-store.ts`.
 *
 * M1-A3: backing validity is registry-driven per seat pin S1 (an entry exists, is `wired: true`
 * and is not `forbidden`) instead of the M0 closed three-id list. `SEAT_BACKINGS` remains as the
 * historical M0 list.
 *
 * M1-A7: the v2 FILE schema (seat pin S2) — `version: 2` adds `displayName` and persisted
 * `fallbacks`. A v1 file loads as v2 in memory (`fallbacks: []`) and is NEVER rewritten, so the
 * in-memory seat always carries `fallbacks` while `version` keeps the file's own number (that is
 * what makes "never rewritten" observable, and what `serializeSeat` round-trips). Key sets are
 * version-scoped: a v1 file is still the closed M0 schema, so `displayName` / `fallbacks` in a v1
 * file are unknown keys and fail load exactly as any other M0 unknown key did.
 */
import { posix } from "node:path";
import { getById } from "@madc/registry";
import { isValidId } from "./protocol/ids.ts";
import { DEFAULT_SEAT_ID } from "./protocol/types.ts";

/** The M0 wired three (historical list; backing validity is registry-driven since M1-A3, S1). */
export const SEAT_BACKINGS = Object.freeze(["kimi-code", "claude-code", "codex"] as const);
export type SeatBacking = (typeof SEAT_BACKINGS)[number];

export type SeatMemory =
  | { readonly mode: "file"; readonly path: string }
  | { readonly mode: "in-session" };

export type SeatToolsPolicy = {
  readonly deny: readonly string[];
  readonly allow?: readonly string[];
};

export type SeatHandoffsStub = { readonly enabled: false; readonly targets: readonly string[] };

/** One seat file, as validated. */
export type EngineSeat = {
  readonly id: string;
  /** The FILE's schema version. A v1 file keeps 1 here and in its bytes (never rewritten, S2). */
  readonly version: 1 | 2;
  readonly role: string;
  readonly standingInstructions: string;
  /** Required at `version: 2` (S2); absent on a v1 file, which the schema never carried it on. */
  readonly displayName?: string;
  /** `<pi-ai provider>/<model id>` for direct lanes; vendor model name for vendor-agent lanes. */
  readonly pinnedModel: string;
  /**
   * Registry provider id passed to `assertAllowed`. Validated against the registry (S1): the
   * entry must exist, be `wired: true` and not `forbidden`. The type stays a plain string so the
   * agent's registry check remains fail-closed for seats built in code.
   */
  readonly preferredBacking: string;
  /**
   * Ordered fallback candidates (seat pin §2 S2, D-M1-7), each validated like `preferredBacking`.
   * Persisted at `version: 2`; a v1 file loads with `[]` (S2's in-memory migration), so the field
   * is always present here and the turn-time walk never needs a default.
   */
  readonly fallbacks: readonly string[];
  readonly memory: SeatMemory;
  readonly tools: SeatToolsPolicy;
  readonly policy: { readonly headlessOk: boolean };
  readonly handoffs: SeatHandoffsStub;
};

/** Seat pin §3, key order included (the seed writer serializes this object). */
export const MADC_DEFAULT_SEAT: EngineSeat = Object.freeze({
  id: DEFAULT_SEAT_ID,
  version: 1,
  role: "general builder",
  standingInstructions:
    "You are madc-default, the built-in MAD seat. Prefer concrete edits and verified commands. Obey registry and tool deny rules. Record honest model identity.",
  pinnedModel: "kimi-coding/kimi-for-coding",
  preferredBacking: "kimi-code",
  // S2's in-memory migration for a v1 file: empty, and never serialized back into the v1 bytes.
  fallbacks: Object.freeze([]),
  memory: Object.freeze({ mode: "file", path: "memory/madc-default.md" }),
  tools: Object.freeze({ deny: Object.freeze([]) }),
  policy: Object.freeze({ headlessOk: true }),
  handoffs: Object.freeze({ enabled: false, targets: Object.freeze([]) }),
} as const);

export type SeatValidation =
  | { readonly ok: true; readonly seat: EngineSeat }
  | { readonly ok: false; readonly issues: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function unknownKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
  issues: string[],
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) issues.push(`${where}${key} is not a seat field`);
  }
}

const SEAT_KEYS = [
  "id",
  "version",
  "role",
  "standingInstructions",
  "pinnedModel",
  "preferredBacking",
  "memory",
  "tools",
  "policy",
  "handoffs",
] as const;

/** The v2 file schema (S2) is the closed M0 key set plus `displayName` and `fallbacks`. */
const SEAT_KEYS_V2 = [...SEAT_KEYS, "displayName", "fallbacks"] as const;

/**
 * `memory.path` (seat pin §2): relative, normalized, under `memory/`, ends `.md`, no `..`, not
 * absolute. Lexical only; `seat-store.ts` adds the real-path confinement check.
 */
export function memoryPathIssue(path: string): string | null {
  if (path === "" || path.includes("\0")) return "memory.path must be a non-empty path";
  if (path.includes("\\")) return "memory.path must use forward slashes";
  if (posix.isAbsolute(path) || /^[A-Za-z]:/.test(path)) return "memory.path must be relative";
  if (path.split("/").includes("..")) return 'memory.path must not contain ".."';
  if (posix.normalize(path) !== path) return "memory.path must be normalized";
  if (!path.startsWith("memory/") || path === "memory/") {
    return 'memory.path must be under "memory/"';
  }
  if (!path.endsWith(".md") || posix.basename(path) === ".md") {
    return 'memory.path must end in ".md"';
  }
  return null;
}

/**
 * Backing validity per seat pin S1 (registry-driven since M1-A3): the entry must exist, be
 * `wired: true` and not be `forbidden`. Pure — the registry is frozen catalog data. Adapter
 * availability is NOT checked here; a registry-wired backing without an adapter in this build
 * fails at turn preflight with -32008 `unwired` (provider-agent).
 *
 * `field` names the seat key the issue is reported against: S2 validates each `fallbacks` entry
 * exactly like `preferredBacking`, so the message must say which one failed.
 */
export function seatBackingIssue(backing: string, field = "preferredBacking"): string | null {
  const entry = getById(backing);
  if (entry === undefined) return `${field} "${backing}" is not a registry provider id`;
  if (entry.status === "forbidden") return `${field} "${backing}" is a forbidden lane`;
  if (!entry.wired) return `${field} "${backing}" is not wired in this build`;
  return null;
}

/**
 * Validate a parsed seat file against seat pin §2. Strict: unknown keys are rejected at every level
 * against the key set of the file's own `version` (v1 is the closed M0 schema; v2 adds
 * `displayName` and `fallbacks`, S2). `expectedId` is the filename stem.
 */
export function validateSeat(raw: unknown, expectedId: string): SeatValidation {
  const issues: string[] = [];
  if (!isRecord(raw)) return { ok: false, issues: ["seat file must be a JSON object"] };
  // The version decides the key set, so it is read before the unknown-key pass. Anything that is
  // not exactly 1 or 2 falls back to the closed M0 set and is reported below.
  const version = raw.version === 2 ? 2 : raw.version === 1 ? 1 : null;
  unknownKeys(raw, version === 2 ? SEAT_KEYS_V2 : SEAT_KEYS, "", issues);

  if (typeof raw.id !== "string" || !isValidId(raw.id)) {
    issues.push("id must match ^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$");
  } else if (raw.id !== expectedId) {
    issues.push(`id "${raw.id}" must equal the filename stem "${expectedId}"`);
  }
  if (version === null) issues.push("version must be 1 or 2");
  if (typeof raw.role !== "string" || raw.role.trim() === "") {
    issues.push("role must be a non-empty string");
  }
  if (typeof raw.standingInstructions !== "string") {
    issues.push("standingInstructions must be a string");
  }
  // S2: `displayName` is required at version 2 and is not a v1 field at all.
  if (version === 2) {
    if (typeof raw.displayName !== "string" || raw.displayName.trim() === "") {
      issues.push("displayName must be a non-empty string at version 2");
    }
  }
  if (typeof raw.pinnedModel !== "string" || raw.pinnedModel.trim() === "") {
    issues.push("pinnedModel must be a non-empty string");
  }
  // Backing validity is registry-driven (seat pin S1, M1-A3): exists, wired, not forbidden.
  if (typeof raw.preferredBacking !== "string") {
    issues.push("preferredBacking must be a registry provider id");
  } else {
    const backingIssue = seatBackingIssue(raw.preferredBacking);
    if (backingIssue !== null) issues.push(backingIssue);
  }
  // S2: each `fallbacks` entry is validated like `preferredBacking`; order is preserved.
  if (version === 2) {
    if (!isStringArray(raw.fallbacks)) {
      issues.push("fallbacks must be an array of registry provider ids at version 2");
    } else {
      (raw.fallbacks as string[]).forEach((candidate, i) => {
        const issue = seatBackingIssue(candidate, `fallbacks[${i}]`);
        if (issue !== null) issues.push(issue);
      });
    }
  }

  const memory = raw.memory;
  if (!isRecord(memory)) {
    issues.push("memory must be an object");
  } else if (memory.mode === "file") {
    if (typeof memory.path !== "string") {
      issues.push('memory.path is required when memory.mode is "file"');
    } else {
      const issue = memoryPathIssue(memory.path);
      if (issue !== null) issues.push(issue);
    }
  } else if (memory.mode === "in-session") {
    if (Object.hasOwn(memory, "path")) {
      issues.push('memory.path is not allowed when memory.mode is "in-session"');
    }
  } else {
    issues.push('memory.mode must be "file" or "in-session"');
  }
  // Unknown keys are rejected at every depth, whatever the mode (issue names the full key path).
  if (isRecord(memory)) unknownKeys(memory, ["mode", "path"], "memory.", issues);

  const tools = raw.tools;
  if (!isRecord(tools)) {
    issues.push("tools must be an object");
  } else {
    unknownKeys(tools, ["deny", "allow"], "tools.", issues);
    if (!isStringArray(tools.deny)) issues.push("tools.deny must be an array of strings");
    if (tools.allow !== undefined && !isStringArray(tools.allow)) {
      issues.push("tools.allow must be an array of strings");
    }
  }

  const policy = raw.policy;
  if (!isRecord(policy)) {
    issues.push("policy must be an object");
  } else {
    unknownKeys(policy, ["headlessOk"], "policy.", issues);
    if (typeof policy.headlessOk !== "boolean") issues.push("policy.headlessOk must be a boolean");
  }

  const handoffs = raw.handoffs;
  if (!isRecord(handoffs)) {
    issues.push("handoffs must be an object");
  } else {
    unknownKeys(handoffs, ["enabled", "targets"], "handoffs.", issues);
    if (handoffs.enabled !== false) issues.push("handoffs.enabled must be false in M0");
    if (!Array.isArray(handoffs.targets) || handoffs.targets.length !== 0) {
      issues.push("handoffs.targets must be [] in M0");
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  const m = memory as Record<string, unknown>;
  const t = tools as Record<string, unknown>;
  // A clean, frozen copy of exactly the validated fields. `version` is the file's own (S2: a v1
  // file is never rewritten); `fallbacks` is always present in memory — `[]` for a v1 file, the
  // validated ordered list for v2; `displayName` only exists on a v2 file.
  const seat: EngineSeat = Object.freeze({
    id: raw.id as string,
    version: version === 2 ? 2 : 1,
    role: raw.role as string,
    standingInstructions: raw.standingInstructions as string,
    ...(version === 2 ? { displayName: raw.displayName as string } : {}),
    pinnedModel: raw.pinnedModel as string,
    preferredBacking: raw.preferredBacking as string,
    fallbacks: Object.freeze(version === 2 ? [...(raw.fallbacks as string[])] : []),
    memory: Object.freeze(
      m.mode === "file"
        ? { mode: "file" as const, path: m.path as string }
        : { mode: "in-session" as const },
    ),
    tools: Object.freeze({
      deny: Object.freeze([...(t.deny as string[])]),
      ...(t.allow === undefined ? {} : { allow: Object.freeze([...(t.allow as string[])]) }),
    }),
    policy: Object.freeze({
      headlessOk: (policy as Record<string, unknown>).headlessOk as boolean,
    }),
    handoffs: Object.freeze({ enabled: false as const, targets: Object.freeze([]) }),
  });
  return { ok: true, seat };
}
