/**
 * `$MADC_HOME/policy.json` — the per-repo data policy (Act M1-A4; normative text is M1 seat pin §5
 * / amendment S5; Founder rulings D-M1-8 and D-M1-9).
 *
 * Repo-gated providers are denied for any repository not on their list, and a **missing or empty
 * entry means deny everywhere**. A clean install therefore denies every repo — that is the D-M1-8
 * default for DeepSeek, and wiring the adapter does not open the lane.
 *
 * Matching is **exact equality only** on the normalized remote and, when an entry pins one, on the
 * realpath'd top-level. No prefix, glob, substring or case-folded owner/repo matching (M1-A4
 * forbidden list). **A path alone never grants:** a path-only entry, an entry whose remote does not
 * normalize, and an entry under a key that is not a registry id are all rejected AT LOAD, grant
 * nothing, and are reported so `madc doctor` can warn.
 *
 * Fail-closed everywhere: an unreadable, symlinked, unparseable or wrong-version file yields an
 * empty policy (deny all repo-gated providers) plus a reported issue — never a permissive default
 * and never a throw.
 *
 * `policy.json` holds no secrets (repository remotes and paths only), and madc never writes it in
 * M1: it is operator-authored. The pinned `0600` permission is therefore REPORTED for doctor rather
 * than silently chmod'ed underneath the operator.
 */
import { closeSync, fstatSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { getById, normalizeRemote } from "@madc/registry";
import { isStrictlyUnder } from "../home.ts";
import { openNoFollow } from "../lock.ts";
import type { RepoIdentityResolution } from "./identity.ts";

export const POLICY_FILE_NAME = "policy.json";
export const POLICY_VERSION = 1;

/**
 * The providers a repo allowlist governs (seat pin §5, named exactly: `deepseek-payg` — the id in
 * today's catalog — plus `minimax-token-plan` and `minimax-payg`). Providers that are not
 * repo-gated ignore this file entirely.
 */
export const REPO_GATED_PROVIDER_IDS: readonly string[] = Object.freeze([
  "deepseek-payg",
  "minimax-token-plan",
  "minimax-payg",
]);

const REPO_GATED: ReadonlySet<string> = new Set(REPO_GATED_PROVIDER_IDS);

export function isRepoGated(providerId: string): boolean {
  return REPO_GATED.has(providerId);
}

/** One accepted allowlist entry. `path` is already realpath'd; null means "remote only". */
export type RepoAllowEntry = {
  readonly remote: string;
  readonly path: string | null;
};

/**
 * A load-time rejection. `index` is null when the whole provider key was rejected (not a registry
 * id, or its value was not an array). The remote/value is NEVER echoed: an entry could carry a
 * credentialed URL, and these strings reach doctor output and engine logs. Unknown keys that are
 * not registry-shaped are redacted to `<non-registry-key>` before they leave this module.
 */
export type RejectedPolicyEntry = {
  readonly providerId: string;
  readonly index: number | null;
  readonly issue: string;
};

/** Why a whole file was not usable (also reported to doctor; never echoes file content). */
export type PolicyFileIssue = { readonly issue: string };

export type RepoDecisionReason =
  | "repo-allowed"
  | "repo-not-allowed"
  | "repo-identity-ambiguous"
  | "not-repo-gated";

/**
 * One decision, shaped for the pinned `repo.decision` session event (seat pin §4.2). A
 * discriminated union so a `deny` narrows to exactly the two `-32007` `DenyReason` values the
 * protocol pin lists for it — the refusal can be built without a cast.
 */
export type RepoDecision =
  | {
      readonly decision: "allow";
      readonly reason: "repo-allowed" | "not-repo-gated";
      readonly remote: string | null;
      readonly topLevel: string | null;
    }
  | {
      readonly decision: "deny";
      readonly reason: "repo-not-allowed" | "repo-identity-ambiguous";
      readonly remote: string | null;
      readonly topLevel: string | null;
    };

export type RepoPolicy = {
  /** Accepted entries per repo-gated registry id. Absent key = no entries = deny everywhere. */
  readonly allow: ReadonlyMap<string, readonly RepoAllowEntry[]>;
  decide(providerId: string, resolution: RepoIdentityResolution): RepoDecision;
};

export type RepoPolicyLoad = {
  readonly policy: RepoPolicy;
  /** Entry-level rejections (path-only, unparseable remote, unknown provider id, bad shape). */
  readonly rejected: readonly RejectedPolicyEntry[];
  /** File-level issues (unreadable, symlink, not JSON, wrong version). Empty when the file is absent. */
  readonly fileIssues: readonly PolicyFileIssue[];
  /** True when `policy.json` exists and was read. */
  readonly present: boolean;
  /** Four-digit octal mode when the file exists and its group/other bits are set; else null. */
  readonly permissiveMode: string | null;
};

/**
 * Unknown `repoAllow` keys may be attacker-controlled JSON (including credentialed URLs). Safe
 * registry-shaped ids (`deepseek`, a typo for `deepseek-payg`) stay readable for doctor; anything
 * else is replaced with a fixed placeholder so doctor/logs never echo secrets (Copilot r4143721345).
 */
const SAFE_UNKNOWN_PROVIDER_KEY = /^[a-z][a-z0-9-]*$/u;

function redactUnknownProviderKey(key: string): string {
  return SAFE_UNKNOWN_PROVIDER_KEY.test(key) ? key : "<non-registry-key>";
}

/**
 * A Map that cannot be widened after load. `Object.freeze(new Map(...))` still allows `.set` /
 * `.delete` / `.clear` at runtime; `decide` and the exported `allow` must share a sealed view
 * (Copilot r4143721405 on PR #38).
 */
function sealedAllowMap(
  entries: Iterable<readonly [string, readonly RepoAllowEntry[]]>,
): ReadonlyMap<string, readonly RepoAllowEntry[]> {
  const inner = new Map(entries);
  const view: ReadonlyMap<string, readonly RepoAllowEntry[]> = {
    get size() {
      return inner.size;
    },
    get: (key) => inner.get(key),
    has: (key) => inner.has(key),
    keys: () => inner.keys(),
    values: () => inner.values(),
    entries: () => inner.entries(),
    forEach: (callback, thisArg) => {
      inner.forEach(callback, thisArg);
    },
    [Symbol.iterator]: () => inner.entries(),
  };
  return Object.freeze(view);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Deny-everything policy: what a clean install (no file) and every unreadable file resolve to. */
function emptyPolicy(): RepoPolicy {
  const allow = sealedAllowMap([]);
  return Object.freeze({
    allow,
    decide: (providerId, resolution) => decideWith(providerId, resolution, allow),
  });
}

/**
 * The fail-closed default an engine uses when no policy was loaded (M1-A4). Denies every repo-gated
 * provider everywhere — identical to a clean install's empty allowlist (D-M1-8), so a missing
 * wire-up can never widen access.
 */
export function denyAllRepoPolicy(): RepoPolicy {
  return emptyPolicy();
}

function decideWith(
  providerId: string,
  resolution: RepoIdentityResolution,
  allow: ReadonlyMap<string, readonly RepoAllowEntry[]>,
): RepoDecision {
  if (!isRepoGated(providerId)) {
    // Not gated → this file does not apply. Callers guard on isRepoGated first, so this branch is
    // the total-function fallback rather than a reachable policy decision.
    const identity = resolution.ok ? resolution.identity : null;
    return {
      decision: "allow",
      reason: "not-repo-gated",
      remote: identity?.remote ?? null,
      topLevel: identity?.topLevel ?? null,
    };
  }
  if (!resolution.ok) {
    // No half of the identity is trustworthy, so neither is reported (seat pin §5 fail-closed).
    return { decision: "deny", reason: "repo-identity-ambiguous", remote: null, topLevel: null };
  }
  const { remote, topLevel } = resolution.identity;
  for (const entry of allow.get(providerId) ?? []) {
    if (entry.remote !== remote) continue;
    if (entry.path !== null && entry.path !== topLevel) continue;
    return { decision: "allow", reason: "repo-allowed", remote, topLevel };
  }
  // A resolved identity that is not listed — including the empty/absent list case.
  return { decision: "deny", reason: "repo-not-allowed", remote, topLevel };
}

/**
 * Normalize one entry at load. Returns the accepted entry, or the issue that rejects it. The issue
 * never echoes the entry's own text (a remote may carry `https://user:token@…`).
 */
function loadEntry(
  raw: unknown,
  realpath: (path: string) => string,
): { entry: RepoAllowEntry } | { issue: string } {
  if (typeof raw === "string") {
    const normalized = normalizeRemote(raw);
    if (!normalized.ok) return { issue: "entry remote does not normalize" };
    return { entry: { remote: normalized.remote, path: null } };
  }
  if (!isRecord(raw)) return { issue: "entry is not a string remote or a { remote, path } object" };

  const keys = Object.keys(raw).sort();
  if (keys.length !== 2 || keys[0] !== "path" || keys[1] !== "remote") {
    // Covers the path-only entry, which the seat pin rejects explicitly: "A path alone never
    // grants". Also rejects unknown keys rather than ignoring them.
    return {
      issue:
        raw.remote === undefined
          ? "a path-only entry grants nothing (a remote is required)"
          : "entry object must have exactly the keys { remote, path }",
    };
  }
  const remote = raw.remote;
  const path = raw.path;
  if (typeof remote !== "string" || typeof path !== "string") {
    return { issue: "entry remote and path must both be strings" };
  }
  const normalized = normalizeRemote(remote);
  if (!normalized.ok) return { issue: "entry remote does not normalize" };
  if (!isAbsolute(path)) return { issue: "entry path must be absolute" };
  let realPath: string;
  try {
    realPath = realpath(path);
  } catch {
    return { issue: "entry path could not be realpath'd" };
  }
  return { entry: { remote: normalized.remote, path: realPath } };
}

export type LoadRepoPolicyOptions = {
  /** Injectable for tests (a failed realpath, or a path realpath does not collapse). */
  readonly realpath?: (path: string) => string;
};

/**
 * Read and validate `$MADC_HOME/policy.json`. Total: never throws. An absent file is normal (a
 * clean install) and yields an empty, deny-everywhere policy with no issues reported.
 */
export function loadRepoPolicy(home: string, options: LoadRepoPolicyOptions = {}): RepoPolicyLoad {
  const realpath = options.realpath ?? ((path: string) => realpathSync(path));
  const path = join(home, POLICY_FILE_NAME);
  const rejected: RejectedPolicyEntry[] = [];
  const fileIssues: PolicyFileIssue[] = [];

  const refuse = (issue: string): RepoPolicyLoad => ({
    policy: emptyPolicy(),
    rejected,
    fileIssues: [...fileIssues, { issue }],
    present: true,
    permissiveMode: null,
  });

  let realHome: string;
  try {
    realHome = realpath(home);
  } catch {
    // No readable home → no policy file to trust. Deny everything, and report it as absent rather
    // than as a broken file: doctor already reports an unusable MADC_HOME.
    return {
      policy: emptyPolicy(),
      rejected: [],
      fileIssues: [],
      present: false,
      permissiveMode: null,
    };
  }

  // Confinement (seat pin §1/§5): the file madc reads must really be inside the real MADC_HOME.
  let realPath: string;
  try {
    realPath = realpath(path);
  } catch {
    // Distinguish a clean-install absence from an existing-but-unresolvable path (dangling
    // symlink, etc.): the latter is a broken file doctor must report (Copilot r4143721567).
    try {
      lstatSync(path);
    } catch {
      return {
        policy: emptyPolicy(),
        rejected: [],
        fileIssues: [],
        present: false,
        permissiveMode: null,
      };
    }
    return refuse("policy.json path could not be resolved");
  }
  if (!isStrictlyUnder(realPath, realHome)) return refuse("policy.json is not inside MADC_HOME");

  // Never follow a symlink for the final component, matching the sessions-file rule.
  // openNoFollow throws for errors other than ENOENT/ELOOP (e.g. EACCES); those must become a
  // reported unreadable issue, never an engine-startup throw (Copilot r4143721617).
  let fd: number | null | "symlink";
  try {
    fd = openNoFollow(path);
  } catch {
    return refuse("policy.json is unreadable");
  }
  if (fd === null) {
    return {
      policy: emptyPolicy(),
      rejected: [],
      fileIssues: [],
      present: false,
      permissiveMode: null,
    };
  }
  if (fd === "symlink") return refuse("policy.json is a symlink");

  let text: string;
  let permissiveMode: string | null = null;
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return refuse("policy.json is not a regular file");
    if (process.platform !== "win32" && (st.mode & 0o077) !== 0) {
      permissiveMode = (st.mode & 0o7777).toString(8).padStart(4, "0");
    }
    text = readFileSync(fd, "utf8");
  } catch {
    return refuse("policy.json is unreadable");
  } finally {
    // readFileSync(fd) does not own the descriptor; openNoFollow opened it, so close it here.
    try {
      closeSync(fd);
    } catch {
      // A failed close cannot change the decision already made.
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ...refuse("policy.json is not valid JSON"), permissiveMode };
  }
  if (!isRecord(parsed)) return { ...refuse("policy.json is not a JSON object"), permissiveMode };
  if (parsed.version !== POLICY_VERSION) {
    return { ...refuse(`policy.json version must be ${POLICY_VERSION}`), permissiveMode };
  }

  const rawAllow = parsed.repoAllow;
  if (rawAllow === undefined) {
    // `{ "version": 1 }` is a valid, empty policy: deny every repo-gated provider everywhere.
    return { policy: emptyPolicy(), rejected, fileIssues, present: true, permissiveMode };
  }
  if (!isRecord(rawAllow)) {
    return { ...refuse("policy.json repoAllow must be an object"), permissiveMode };
  }

  const allow = new Map<string, readonly RepoAllowEntry[]>();
  for (const [providerId, rawEntries] of Object.entries(rawAllow)) {
    // Keys are registry ids EXACTLY (seat pin §5). An unknown id grants nothing and is reported.
    if (getById(providerId) === undefined) {
      rejected.push({
        providerId: redactUnknownProviderKey(providerId),
        index: null,
        issue: "not a registry provider id",
      });
      continue;
    }
    if (!Array.isArray(rawEntries)) {
      rejected.push({ providerId, index: null, issue: "allowlist must be an array" });
      continue;
    }
    const entries: RepoAllowEntry[] = [];
    rawEntries.forEach((raw, index) => {
      const result = loadEntry(raw, realpath);
      if ("issue" in result) {
        rejected.push({ providerId, index, issue: result.issue });
        return;
      }
      entries.push(result.entry);
    });
    // An all-rejected list is stored as empty, which denies everywhere — the fail-closed default.
    allow.set(providerId, Object.freeze(entries));
  }

  const sealed = sealedAllowMap(allow);
  return {
    policy: Object.freeze({
      allow: sealed,
      decide: (providerId: string, resolution: RepoIdentityResolution) =>
        decideWith(providerId, resolution, sealed),
    }),
    rejected,
    fileIssues,
    present: true,
    permissiveMode,
  };
}
