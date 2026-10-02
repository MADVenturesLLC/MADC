/**
 * Engine-owned repository identity (Act M1-A4; normative text is M1 seat pin §5, Founder ruling
 * 2026-09-25, fixing Copilot r4101049517 on PR #9).
 *
 * The identity of a thread's repository is **(a)** the realpath of the git top-level of `cwd` and
 * **(b)** the normalized URL of its `origin` remote. The engine computes both itself: the
 * caller-supplied `cwd` string is NEVER matched against an allowlist directly, so a client cannot
 * widen access by naming a path.
 *
 * Fail-closed. Anything that cannot be resolved unambiguously answers `ok: false`, which the
 * caller turns into `-32007` with reason `repo-identity-ambiguous`:
 * - `cwd` absent, not a directory, or not inside a git repository;
 * - no `origin` remote at all (no remotes, or only non-`origin` remotes);
 * - `origin` endpoints that disagree — every `remote.origin.url` AND every `remote.origin.pushurl`
 *   value must normalize to the SAME remote (seat pin §5 "Origin agreement");
 * - an unparseable remote URL;
 * - a failed `realpath`.
 *
 * Symlinks are resolved by `realpath`; bind mounts are NOT collapsed by `realpath`, so a
 * bind-mounted checkout is a distinct path (that distinction only matters for a path-pinned entry —
 * a remote-only entry decides identically, because the remote still matches).
 *
 * Synchronous on purpose: the repo gate runs inside `turn/start` before any model or vendor call
 * (M1 protocol pin §4.2), and request handling in `server.ts` is synchronous. `git` is spawned
 * without a shell and with fixed literal arguments only — no part of `cwd` or of any config value
 * reaches a shell.
 */
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { normalizeRemote } from "@madc/registry";

/** The resolved identity a repo-gated decision matches on. Both halves are required. */
export type RepoIdentity = {
  /** Normalized `origin` remote, `host/owner/repo` (registry `normalizeRemote`). */
  readonly remote: string;
  /** realpath of the git top-level — symlinks resolved, bind mounts NOT collapsed. */
  readonly topLevel: string;
};

export type RepoIdentityResolution =
  | { readonly ok: true; readonly identity: RepoIdentity }
  | { readonly ok: false; readonly issue: string };

export type GitCommandResult = { readonly code: number | null; readonly stdout: string };

/** Injectable so tests can drive a failed `git` without needing a broken repository. */
export type GitRunner = (args: readonly string[], cwd: string) => GitCommandResult;

/** Injectable so tests can model a `realpath` failure or a path `realpath` does not collapse. */
export type Realpath = (path: string) => string;

export type RepoIdentityDeps = {
  readonly realpath?: Realpath;
  readonly runGit?: GitRunner;
};

/** Upper bound on one `git` invocation; a hung git fails closed instead of stalling the turn. */
const GIT_TIMEOUT_MS = 5_000;

/**
 * Git environment variables that retarget `rev-parse` / `config` at a different repository or
 * config scope than `cwd`. Inherited values must not authorize a gate decision (Copilot
 * r4143721202 on PR #38).
 */
const GIT_REPO_OVERRIDE_KEYS: ReadonlySet<string> = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_INDEX_FILE",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_NOSYSTEM",
]);

/**
 * `git` child environment. `GIT_TERMINAL_PROMPT=0` stops git from blocking on a credential prompt
 * (which would otherwise burn the whole timeout); `GIT_OPTIONAL_LOCKS=0` stops opportunistic
 * background maintenance from taking locks in a repository madc is only reading identity from.
 * Repository/config override variables from the parent process are stripped so the gate always
 * inspects `cwd`'s checkout, never an ambient `GIT_DIR` / `GIT_CONFIG_*` pointed elsewhere.
 */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
  };
  for (const key of Object.keys(env)) {
    if (GIT_REPO_OVERRIDE_KEYS.has(key) || key.startsWith("GIT_CONFIG_")) {
      delete env[key];
    }
  }
  return env;
}

/**
 * The engine's own `git` runner: no shell, fixed literal arguments, repository-override variables
 * stripped, 5 s timeout. Exported (M2-A1) so the worktree identity (`worktree.ts`) and doctor's
 * evidence-ref resolution run `git` under exactly the rules the repo gate does.
 */
export function defaultGitRunner(args: readonly string[], cwd: string): GitCommandResult {
  return defaultRunGit(args, cwd);
}

function defaultRunGit(args: readonly string[], cwd: string): GitCommandResult {
  let result: SpawnSyncReturns<string>;
  try {
    result = spawnSync("git", [...args], {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      env: gitEnv(),
      // Never a shell: args are fixed literals, and cwd/config values must not be re-parsed.
      shell: false,
    });
  } catch {
    return { code: null, stdout: "" };
  }
  // A spawn failure (ENOENT: no git; ENOENT/EACCES: unusable cwd) is indistinguishable from "not a
  // repository" for policy purposes: both fail closed.
  if (result.error !== undefined) return { code: null, stdout: "" };
  return { code: result.status, stdout: result.stdout ?? "" };
}

function fail(issue: string): RepoIdentityResolution {
  return { ok: false, issue };
}

/**
 * One `git config --get-regexp` line: `key value`, where the value may itself contain spaces. A key
 * with no value at all yields no space; the value is then the empty string, which normalization
 * rejects (so an empty `remote.origin.url` is ambiguous, never an identity).
 */
function parseConfigLines(stdout: string): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    const space = line.indexOf(" ");
    if (space === -1) {
      out.push({ key: line.trim(), value: "" });
      continue;
    }
    out.push({ key: line.slice(0, space), value: line.slice(space + 1) });
  }
  return out;
}

/**
 * Resolve the repository identity of `cwd`. Total: every input answers either an identity or an
 * issue, never a throw.
 */
export function resolveRepoIdentity(
  cwd: string | null,
  deps: RepoIdentityDeps = {},
): RepoIdentityResolution {
  const realpath = deps.realpath ?? ((path: string) => realpathSync(path));
  const runGit = deps.runGit ?? defaultRunGit;

  if (cwd === null || cwd.trim() === "") {
    return fail("thread has no cwd");
  }

  // (a) The git top-level of cwd. A non-git cwd, a missing directory, an unreadable one, or a
  // repository git refuses for dubious ownership all exit non-zero → ambiguous.
  const topLevelResult = runGit(["rev-parse", "--show-toplevel"], cwd);
  if (topLevelResult.code !== 0) {
    return fail("cwd is not inside a usable git repository");
  }
  const reportedTopLevel = topLevelResult.stdout
    .split("\n")
    .filter((l) => l.trim() !== "")
    .at(-1);
  if (reportedTopLevel === undefined || reportedTopLevel === "") {
    return fail("git reported no top-level directory");
  }

  let topLevel: string;
  try {
    topLevel = realpath(reportedTopLevel);
  } catch {
    return fail("realpath resolution of the git top-level failed");
  }
  if (topLevel === "") return fail("realpath resolution of the git top-level failed");

  // (b) The normalized `origin` remote, with the seat pin §5 agreement rule.
  const origin = resolveOriginRemote(runGit, cwd);
  if (!origin.ok) return fail(origin.issue);

  return { ok: true, identity: { remote: origin.remote, topLevel } };
}

export type OriginRemoteResolution =
  | { readonly ok: true; readonly remote: string }
  | { readonly ok: false; readonly issue: string };

/**
 * Every configured `origin` endpoint, fetch and push alike — repository-LOCAL only (`--local`),
 * so a checkout with no local origin cannot inherit an operator/global `remote.origin.*` and look
 * allowlisted (Copilot r4143721284 on PR #38). Exits 1 when nothing matches, which is the "no
 * origin remote" case. Origin agreement (seat pin §5): every endpoint must normalize to the SAME
 * remote; a fetch URL on the allowlist with a different push URL — or two fetch URLs — is
 * ambiguous, not allowed. Shared by the repo gate and the M2 worktree identity (`worktree.ts`).
 */
export function resolveOriginRemote(runGit: GitRunner, cwd: string): OriginRemoteResolution {
  const configResult = runGit(["config", "--local", "--get-regexp", "^remote\\.origin\\."], cwd);
  if (configResult.code !== 0) return { ok: false, issue: "no origin remote is configured" };

  const endpoints: string[] = [];
  for (const { key, value } of parseConfigLines(configResult.stdout)) {
    const lower = key.toLowerCase();
    if (lower === "remote.origin.url" || lower === "remote.origin.pushurl") {
      endpoints.push(value);
    }
  }
  if (endpoints.length === 0) return { ok: false, issue: "no origin remote is configured" };

  let remote: string | null = null;
  for (const endpoint of endpoints) {
    const normalized = normalizeRemote(endpoint);
    if (!normalized.ok) {
      return { ok: false, issue: "origin remote is not a parseable git remote" };
    }
    if (remote === null) {
      remote = normalized.remote;
      continue;
    }
    if (remote !== normalized.remote) {
      return { ok: false, issue: "origin fetch and push endpoints disagree" };
    }
  }
  if (remote === null) return { ok: false, issue: "no origin remote is configured" };
  return { ok: true, remote };
}
