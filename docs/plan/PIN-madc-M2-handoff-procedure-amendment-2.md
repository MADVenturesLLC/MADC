# PIN (proposed): M2 handoff procedure amendment 2 (`thread/handoff` step 3 target worktree)

*Builder-drafted under M2-A5 · 2026-11-23 · Venue: `MADVenturesLLC/MADC` · Status: **proposed until the Founder merges this PR**. Proposed amendment P-M2-5 of the M2 build plan (`PLAN-madc-M2-build-plan.md`), amending `PIN-madc-M2-handoff-procedure.md` §4 step 3.*

**What this pin amends.** Under `PIN-madc-M2-handoff-procedure.md` §4 step 3, a handed-off target thread opened with `cwd` equal to `record.thread.cwd` (the source thread's `cwd`). When the **target** seat has `worktree: true` (per `PIN-madc-M2-seat-worktree.md`), opening the target in `record.thread.cwd` would place it in the source's working tree.

## Amendment to `PIN-madc-M2-handoff-procedure.md` §4 step 3

At `thread/handoff` §4 step 3, `#openThread` receives `record.thread.cwd` as the source repo context:

- If the target seat has `worktree: true`, `#openThread` creates the target's own engine-managed worktree at `$MADC_HOME/worktrees/<targetThreadId>` off the repository of `record.thread.cwd`, and binds the target thread's `cwd` and `session.open.worktree` to that new tree.
- If the target open fails (for example, `record.thread.cwd` is null or not a git repository), `thread/handoff` follows step 5 and appends `handoff.aborted` (`target-open-failed`) on the source thread.
- If the target seat does not have `worktree: true`, step 3 is unchanged (`target.thread.cwd === record.thread.cwd`).
