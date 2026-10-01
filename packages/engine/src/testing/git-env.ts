/**
 * Test-only: the environment for FIXTURE `git` children — the temporary repositories the repo-gate
 * and policy tests build. Every `GIT_*` variable of the test runner is dropped.
 *
 * Why: a git hook exports them, and the repo's own pre-push hook runs these suites. From a linked
 * worktree it exports an ABSOLUTE `GIT_DIR` (the worktree's git dir), and an inherited `GIT_DIR`
 * makes `git init -- <tmpdir>` re-initialize THAT repository instead of creating the fixture. M1-A9
 * hit it: the shared repository's config gained `core.bare = true` and the main checkout stopped
 * working; M1-A4 lost `remote.origin.url` the same way. The engine's own repo-identity resolver
 * already strips the repository-override variables (`policy/identity.ts`); fixtures strip them all.
 */
export function fixtureGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith("GIT_")) env[name] = value;
  }
  return env;
}
