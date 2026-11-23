# PIN (proposed): M2 seat worktree mode (`worktree?: boolean`) and vendor `cwd` placement

*Builder-drafted under M2-A5 · 2026-11-23 · Venue: `MADVenturesLLC/MADC` · Status: **proposed until the Founder merges this PR**. Proposed amendment P-M2-2 of the M2 build plan (`PLAN-madc-M2-build-plan.md`).*

**What this pin does.** Adds opt-in worktree isolation (`worktree?: boolean`, `D-M2-2`) to v2 seat files, defines the confined engine-created worktree root `$MADC_HOME/worktrees/<threadId>`, fixes the dirty-tree cleanup posture (`D-M2-4`), defines vendor adapter `cwd` placement (`claude-code`, `codex`, `acp-client`), and specifies `repoAllow` and doctor behavior for seat worktrees.

**What it does not do.** It does not change v1 seats, does not add a per-seat rate cap (Founder ruling 2026-11-23 on `D-M2-9`: `"No rate cap in M2"`), does not merge worktree branches back (`D-M2-6`), and does not claim to sandbox vendor agent file tools (criterion C is `cwd` placement only).

---

## 1. Seat schema (`worktree?: boolean`, v2 only)

- **v1 seat files** keep the closed M0 schema: `worktree` is an unknown key and fails seat load with `-32006`.
- **v2 seat files** may include optional `worktree?: boolean`:
  - Absent or `false`: no worktree is created; `thread/start` and `thread/handoff` behave as before.
  - `true`: worktree mode is enabled for threads opened on this seat.
  - Any non-boolean value fails seat validation (`-32006`).

## 2. Worktree creation and confinement

When a thread opens on a seat with `worktree: true`:

1. **Git `cwd` required.** The caller's `cwd` (or `record.thread.cwd` on `thread/handoff`) must be non-null and inside a git working tree (`git rev-parse --show-toplevel` succeeds). A non-git or null `cwd` refuses with `-32602` (`InvalidParams`) before any session file is created or appended.
2. **Confined root.** The target path is `$MADC_HOME/worktrees/<threadId>` (resolved under `realpath($MADC_HOME)/worktrees`, with `<threadId>` matching the valid id grammar). A path escaping that root is refused before any append.
3. **Primary tree never used.** The created worktree path must differ from the source repo's `topLevel`. The repo's primary working tree is never used as a seat worktree.
4. **Occupied path refused.** If `$MADC_HOME/worktrees/<threadId>` already exists or is already registered as a git worktree, the open is refused (`-32602`) before any append.
5. **Creation command.** The engine creates the tree via `git worktree add --detach <targetPath> HEAD` from the source repo's `topLevel`. Detached HEAD avoids creating or colliding on user branches and never touches `main`.
6. **Session identity.** `session.open.worktree` records the created worktree's own `topLevel`, normalized `origin` remote, and `head`. `session.close.worktree` re-reads `HEAD` at that recorded `topLevel`.

## 3. Cleanup posture (`D-M2-4`)

- On close, M2 leaves every seat worktree on disk (`D-M2-4`).
- Any engine helper that removes a seat worktree checks `git status --porcelain` first: a **dirty** tree (or one whose status cannot be read) is **never** removed, and the refusal names the dirty tree path.

## 4. Vendor `cwd` placement

- `ProviderTurnRequest` carries `cwd?: string | null`.
- `provider-agent.ts` forwards `ctx.cwd` when non-null.
- `claude-code`, `codex`, and `acp-client` (`grok-build`) spawn their child process with `{ cwd: request.cwd }` when `request.cwd` is set, and `acp-client` passes `cwd: request.cwd ?? process.cwd()` in `session/new`.
- This guarantees working-directory placement only; it is **not** a write sandbox around a vendor agent's file tools.

## 5. `repoAllow` inside a seat worktree

A seat worktree at `$MADC_HOME/worktrees/<threadId>` has its own `topLevel` (`$MADC_HOME/worktrees/<threadId>`), distinct from the primary checkout's `topLevel`, while its normalized `origin` remote matches the repo's `origin`. Therefore:

- **Remote-pinned** `repoAllow` entries match inside a seat worktree.
- **Path-pinned** `repoAllow` entries (exact equality on `realpath(topLevel)`) do **not** match `$MADC_HOME/worktrees/<threadId>` unless that worktree path itself is listed, and therefore deny `repo-not-allowed` as specified in seat pin §5.

## 6. Doctor (`inspectSessionV2`)

When `session.open.worktree` is non-null, `inspectSessionV2` checks that `openWorktree.topLevel` still exists and resolves via `git rev-parse --show-toplevel` to `openWorktree.topLevel`. If missing or moved, doctor emits a `WARN` (`worktree-head-unreadable`) naming the thread and path.
