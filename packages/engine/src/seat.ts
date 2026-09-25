/**
 * Seat schema (seat pin §2) and the built-in `madc-default` seat (seat pin §3, plan D4).
 * Pure: no I/O. File loading, confinement, and seeding live in `seat-store.ts`.
 */
import { posix } from "node:path";
import { isValidId } from "./protocol/ids.ts";
import { DEFAULT_SEAT_ID } from "./protocol/types.ts";

/** Exactly the three registry entries with `wired: true` (seat pin §2). */
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
  readonly version: 1;
  readonly role: string;
  readonly standingInstructions: string;
  /** `<pi-ai provider>/<model id>` for kimi-code; vendor model name for claude-code / codex. */
  readonly pinnedModel: string;
  /**
   * Registry provider id passed to `assertAllowed`. A validated seat file only ever carries a
   * `SeatBacking`; the type stays a plain string so the agent's registry check remains fail-closed
   * for seats built in code.
   */
  readonly preferredBacking: string;
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
 * Validate a parsed seat file against seat pin §2. Strict: unknown keys are rejected at every level
 * (schema `version: 1` is closed). `expectedId` is the filename stem.
 */
export function validateSeat(raw: unknown, expectedId: string): SeatValidation {
  const issues: string[] = [];
  if (!isRecord(raw)) return { ok: false, issues: ["seat file must be a JSON object"] };
  unknownKeys(raw, SEAT_KEYS, "", issues);

  if (typeof raw.id !== "string" || !isValidId(raw.id)) {
    issues.push("id must match ^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$");
  } else if (raw.id !== expectedId) {
    issues.push(`id "${raw.id}" must equal the filename stem "${expectedId}"`);
  }
  if (raw.version !== 1) issues.push("version must be 1");
  if (typeof raw.role !== "string" || raw.role.trim() === "") {
    issues.push("role must be a non-empty string");
  }
  if (typeof raw.standingInstructions !== "string") {
    issues.push("standingInstructions must be a string");
  }
  if (typeof raw.pinnedModel !== "string" || raw.pinnedModel.trim() === "") {
    issues.push("pinnedModel must be a non-empty string");
  }
  if (
    typeof raw.preferredBacking !== "string" ||
    !(SEAT_BACKINGS as readonly string[]).includes(raw.preferredBacking)
  ) {
    issues.push(`preferredBacking must be one of ${SEAT_BACKINGS.join(", ")}`);
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
  // A clean, frozen copy of exactly the validated fields.
  const seat: EngineSeat = Object.freeze({
    id: raw.id as string,
    version: 1,
    role: raw.role as string,
    standingInstructions: raw.standingInstructions as string,
    pinnedModel: raw.pinnedModel as string,
    preferredBacking: raw.preferredBacking as string,
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
