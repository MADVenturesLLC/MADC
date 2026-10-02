/**
 * M2 pin §2.2: worktree identity — `HEAD` at open and at close. Engine-owned, never
 * caller-supplied: `topLevel` is resolved from `cwd` the way the repo gate resolves repo identity
 * (seat pin §5: realpath of the git top-level, symlinks resolved; a linked worktree resolves to
 * its own top-level, not the main checkout's), `remote` follows the same normalization and
 * agreement rules (disagreement or absence records null, never a guess), and `head` is the commit
 * `HEAD` resolves to at that moment (null only for an unborn branch).
 *
 * No worktree is created or managed here (pin §6): recording identity is the whole scope.
 * Synchronous on purpose, like the repo gate: it runs inside `thread/start` and at shutdown.
 */
import { realpathSync } from "node:fs";
import {
  defaultGitRunner,
  type GitRunner,
  type Realpath,
  type RepoIdentityDeps,
  resolveOriginRemote,
} from "./policy/identity.ts";
import type { WorktreeIdentity } from "./session-v2.ts";

export type { WorktreeIdentity } from "./session-v2.ts";

const SHA40 = /^[0-9a-f]{40}$/;

/** realpath of `git rev-parse --show-toplevel` run in `cwd`; null when `cwd` is not in a work tree. */
function topLevelOf(cwd: string, runGit: GitRunner, realpath: Realpath): string | null {
  const result = runGit(["rev-parse", "--show-toplevel"], cwd);
  if (result.code !== 0) return null;
  const reported = result.stdout
    .split("\n")
    .filter((l) => l.trim() !== "")
    .at(-1);
  if (reported === undefined || reported === "") return null;
  try {
    const top = realpath(reported);
    return top === "" ? null : top;
  } catch {
    return null;
  }
}

/**
 * `HEAD` at `topLevel`: 40 lowercase hex, or null for an unborn branch. A failed `git` (gone
 * directory, timeout, not a repository any more) is `ok: false`, never a false "unborn".
 */
function headOf(
  topLevel: string,
  runGit: GitRunner,
): { ok: true; head: string | null } | { ok: false } {
  const head = runGit(["rev-parse", "--verify", "--quiet", "HEAD"], topLevel);
  if (head.code === 0) {
    const sha = head.stdout.trim();
    return SHA40.test(sha) ? { ok: true, head: sha } : { ok: false };
  }
  // No commit to resolve: only an unborn branch inside a readable work tree reads as null.
  const inside = runGit(["rev-parse", "--is-inside-work-tree"], topLevel);
  return inside.code === 0 && inside.stdout.trim() === "true"
    ? { ok: true, head: null }
    : { ok: false };
}

function identityAt(topLevel: string, runGit: GitRunner): WorktreeIdentity | null {
  const head = headOf(topLevel, runGit);
  if (!head.ok) return null;
  const origin = resolveOriginRemote(runGit, topLevel);
  return { topLevel, remote: origin.ok ? origin.remote : null, head: head.head };
}

/**
 * The identity recorded on `session.open` (pin §2.2 "At open"): null when `cwd` is null or not
 * inside a git work tree. `deps` are the repo gate's test seams (`realpath`, `runGit`).
 */
export function resolveWorktreeIdentity(
  cwd: string | null,
  deps: RepoIdentityDeps = {},
): WorktreeIdentity | null {
  if (cwd === null || cwd.trim() === "") return null;
  const runGit = deps.runGit ?? defaultGitRunner;
  const realpath = deps.realpath ?? ((path: string) => realpathSync(path));
  const topLevel = topLevelOf(cwd, runGit, realpath);
  if (topLevel === null) return null;
  return identityAt(topLevel, runGit);
}

/**
 * The identity recorded on `session.close` (pin §2.2 "At close", D-M2-A0-5): `HEAD` re-read at
 * the RECORDED `topLevel`, not at the current `cwd`. Null when that top-level can no longer be
 * read as the same work tree (gone, or `git` now reports another top-level there), which doctor
 * reports as `worktree-head-unreadable`.
 */
export function rereadWorktreeIdentity(
  recorded: WorktreeIdentity,
  deps: RepoIdentityDeps = {},
): WorktreeIdentity | null {
  const runGit = deps.runGit ?? defaultGitRunner;
  const realpath = deps.realpath ?? ((path: string) => realpathSync(path));
  const topLevel = topLevelOf(recorded.topLevel, runGit, realpath);
  if (topLevel === null || topLevel !== recorded.topLevel) return null;
  return identityAt(topLevel, runGit);
}
