# PIN: M2 room reporting and doctor v2 (`madc room [--json]` and `doctor` `room` row)

*Builder-drafted (retroactive pin for `P-M2-4` / `D-596`; Founder accepted M2-A8 as built on 2026-11-23: `"I accept M2-A8 and M2-A9 as built without commissions."`) · Venue: `MADVenturesLLC/MADC`.*

*Amends `PIN-madc-M0-cli.md` §3 (appends the `room` row after `lanes` in `madc doctor`) and resolves the `P-M2-4` deferral noted in `PIN-madc-M2-brief-delivery.md`.*

**What this pin documents.** Records the `P-M2-4` contract shipped in M2-A8 (`#68`, merge commit `5d9a333`):

1. **`thread/list` stays unchanged.** `thread/list` continues to return the M0/M1 thread list without handoff or worktree state.
2. **`inspectRoom(home)` and `madc room [--json]`**:
   - Read-only aggregation across `$MADC_HOME/sessions/*.jsonl` (no writes, no locks, no payload text).
   - `RoomReport`: `{ home, threads: RoomThreadRow[], counts: { threads, pass, warn, fail, openDecisions } }`.
   - `RoomThreadRow`: `{ threadId, path, seatId, level ("pass" | "warn" | "fail"), chain, handoff: { inbound, outboundCount, oneWay }, worktree: { open, close, missing }, openDecisions: OpenDecisionSummary[], findings: SessionFinding[] }`.
3. **`madc doctor` `room` row**:
   - Appended as the last row after `lanes` (preserving M0 and M1 row order).
   - Status is `skip` when `threads === 0`, `fail` when `counts.fail > 0` (exits `1`), `warn` when `counts.warn > 0` with `counts.fail === 0` (exits `0` if no other row fails), and `pass` otherwise.
   - Indented room table (`roomTableLines`) prints under the `room` row in human output.
