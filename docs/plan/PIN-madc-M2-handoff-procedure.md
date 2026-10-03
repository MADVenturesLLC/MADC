# PIN (proposed): M2 handoff procedure: `thread/handoff`, the evidence pin §2.1 order in-process

*Builder-drafted under the Founder's M2-A2 commission · 2026-10-03 · Venue: `MADVenturesLLC/MADC` · Status: **proposed until the Founder merges this PR**. It authorizes one new request, `thread/handoff`, and nothing else.*

*Base: `main` @ `ce10ca010ddd72c29513a117ba872168707b9046` (the M2-A1 squash, PR #47). Every file cited below was read at that commit. This pin opens no decision table: the evidence pin's rulings D-M2-A0-1 … D-M2-A0-6 bind as recorded there, and every rule below either restates a binding source or is fixed by the commission.*

**What this pin does.** It names the one protocol request that performs the M2 evidence pin §2.1 order inside one engine process: the source appends `handoff.out`, a new target thread opens citing it, the source appends `handoff.link` citing the target's genesis, or `handoff.aborted` when the target did not open. It fixes the params, the result, the refusals and their order, and what is on disk after each outcome.

**What it does not do.** It starts no turn on the target (the brief is stored; serving it is a later act). It creates no git worktree. It does not consult `handoffs.targets`, and it does not relax the seat gate: `handoffs.enabled: true` or a non-empty `targets` list still fails `-32006`. §6 lists the non-goals.

**Authority:**

- `docs/plan/PIN-madc-M2-evidence-schema-v2.md`, Founder-merged as M2-A0 (#46), SHA-256 `75d6eb47b3d441bed7f58d23806795fd8ee06821370e2401689e6fdad0e53ffa` at the base. **Frozen; not edited.** §2.1 (order, shapes, (a)/(b)/(c), the state table, the refusal table), §5 (`-32010 EvidenceInvalid`, `EvidenceRefusal`, where it surfaces), §7 (doctor), §9 rulings D-M2-A0-1 … D-M2-A0-6. §2.1 leaves "which engine process opens the target, and how the source learns G" to the M2 build plan; this pin answers it for the in-process case only.
- `docs/plan/PIN-madc-M1-protocol-messages.md` (frozen; not edited): §1 id grammar, §3.3 lock ownership, §4.1 codes `-32002`, `-32004`, `-32005`, `-32006`, `-32009`, `-32602`, §7 protocol version.
- `docs/plan/PIN-madc-M1-seat-format.md` (frozen): §2 seat gate (`handoffs.enabled` must be `false`, `handoffs.targets` must be `[]`), §4.2 redaction.
- `docs/plan/PIN-madc-M0-amendment-2-session-integrity.md`, `PIN-madc-M0-amendment-3.md` (frozen): every append below is an ordinary writer batch under them.
- Code at the base (M2-A1): `SessionWriter` and its write-time validator (`session-store.ts`, `session-v2.ts`), the shared redactor, the handoff gate and `checkHandoffTarget` (`handoff.ts`, `server.ts`), worktree identity (`worktree.ts`).

---

## 1. Ground rules

1. **No new event, field or code.** The lines written are the evidence pin's `handoff.out`, `session.open` with `handoff` and `worktree`, `handoff.link` and `handoff.aborted`, on the unchanged `v: 1` envelope (D-M2-A0-6). Every refusal uses a code already in the engine's table.
2. **One writer per file.** The source lines are appended by the source thread's writer, under the source lock this connection holds. The target's `session.open` is written by the target's own writer, under the target lock this procedure takes and releases. Every append is an ordinary batch (Amendment 2 §2/§4, Amendment 3 §1).
3. **Validity before bytes.** Each line passes the existing write-time validator before redaction, hashing and I/O (evidence pin rule 1.5). A refused line appends nothing and does not break the writer.
4. **Synchronous.** The procedure runs to completion inside one request; no other request on the connection interleaves with it.

---

## 2. The request

```ts
// Request
type ThreadHandoffParams = {
  threadId: string;         // the SOURCE thread: loaded on this connection, its lock held by it
  targetSeatId: string;     // id grammar; the seat the target thread opens under
  brief: string;            // the work handed over; non-empty after trim; redacted before it is written
  turnId: string | null;    // the source turn that raised the handoff; null between turns (key required)
};

// Result (success only)
type ThreadHandoffResult = {
  handoffId: string;          // engine-assigned, id grammar (`ho_` + 32 lowercase hex); a caller value is ignored
  targetThreadId: string;     // engine-assigned, id grammar (the same generator as `thread/start`)
  targetGenesisHash: string;  // G: the target file's seq-0 hash as read back from disk
};
```

- The method name joins the engine's request list and declared-params table. `protocolVersion` stays `madc-m1/1`: the commission authorizes one request and nothing else. An engine without this pin answers `-32601` for it (protocol pin §4.1).
- `brief` is free text like `turn/start`'s `input`. It is never echoed in an error's `data` or `issues` (evidence pin §5).
- No notification is sent for the target. It is not loaded on this connection.

---

## 3. Step 1: refusals before any append

Each refusal below appends nothing: the source file's size and sha256 and its writer's next seq are unchanged, no session file and no lock are created, and the writer is not broken. They run in this order.

| # | Check | Code | `data` |
| --- | --- | --- | --- |
| 1 | `params` not an object; `threadId` missing, not a string, or outside the id grammar | `-32602 InvalidParams` | `{ issues }` |
| 2 | the `handoff.out` fields: `targetSeatId`, `brief` or the `turnId` key missing → `field-missing`; a wrong type, an id outside the grammar, or `brief` empty after trim → `field-invalid` | `-32010 EvidenceInvalid` | `{ threadId, turnId, type: "handoff.out", reason, issues }` |
| 3 | the source writer was poisoned in this process | `-32009 SessionWriteFailed` | `{ threadId, path, seq }` |
| 4 | the source is not loaded on this connection, and a live process holds its lock | `-32004 TurnAlreadyActive` | `{ threadId, activeTurnId: null, lockHolderPid }` |
| 5 | the source is not loaded on this connection, and no live process holds its lock | `-32002 ThreadNotFound` | `{ threadId }` |
| 6 | the source is loaded but this connection no longer holds its lock (refused, never re-taken) | `-32004 TurnAlreadyActive` | `{ threadId, activeTurnId: null, lockHolderPid? }` |
| 7 | the source writer is broken | `-32009 SessionWriteFailed` | `{ threadId, path, seq }` |
| 8 | the source is itself a handoff target whose own link does not verify (the M2-A1 gate) | `-32010` `handoff-one-way` | `{ threadId, turnId: null, type: "session.open", … }` |
| 9 | the target seat does not load, or fails the seat schema including the seat gate | `-32005` / `-32006` | as `thread/start` |

Notes on the order:

- Row 1 keeps `threadId` where every method keeps it: it routes the request and is the envelope of the source file, not a field of `handoff.out`, and an id outside the grammar cannot name a thread for `-32010`'s `data.threadId`. The commission's "an id fails the grammar (`-32010 field-invalid`)" is applied to the ids of the record, rows 2 (`targetSeatId`, `turnId`); `handoffId` is engine-assigned.
- Row 2 runs before any lock, seat or path use, so `targetSeatId` is checked against the grammar before it is joined into `seats/<id>.json`. It is the writer's own rule (`checkV2Payload("handoff.out", …)`), so a request and a record cannot disagree on what is valid.
- Rows 4 to 6 are the commission's "the caller does not hold the source thread lock (`-32004`)". A thread this connection never loaded and nobody holds answers `-32002`, as `turn/start` does.
- Row 8 is the existing gate (`turn/start` runs the same one): an orphaned target hands nothing on. It can fire only on a source whose link held at resume and was broken afterwards.
- Row 9 is the seat load `thread/start` uses. `handoffs.targets` of either seat is not consulted (§6).

---

## 4. Steps 2 to 5: the procedure

**Step 2 (`handoff.out`, H).** The source writer appends `handoff.out` `{ handoffId, turnId, targetSeatId, brief }`. `brief` passes through the engine's shared redactor (exact secret values, then the seat pin §4.2 token shapes) before hashing, so `[REDACTED]` is what H covers. A refusal here (a duplicate id, or redaction that would rewrite a structural field) is `-32010` and a failed append is `-32009`; either way nothing was written and the handoff did not start.

**Step 3 (the target opens).** The target opens through the same session-open path `thread/start` uses, not through JSON-RPC `thread/start` on the connection: a fresh thread id, the `sessions/` permission check, the new thread's lock, the worktree identity resolved by the engine from the **source thread's recorded `cwd`**, and `SessionWriter.create` writing `session.open` (seq 0) with

```ts
handoff: { sourceThreadId: <source threadId>, sourceSeatId: <source envelope seatId>, handoffId, sourceSeq: s, sourceHash: H }
```

and `cwd` equal to the source's. The target seat's own memory path is materialized as `thread/start` does. No turn is started, no agent is called, and the target is not registered on the connection.

**Step 4 (G, then `handoff.link`).**

1. The target file is read back from disk and verified. Its seq-0 line must be the `session.open` just written: the same hash as the target writer holds, the target seat as its envelope `seatId`, and `handoff` equal to the link above (§2.1 (b)). Its hash is **G**.
2. The target lock is released (on every path once it was taken), before `handoff.link`. A release that fails is kept and released at shutdown, as everywhere in the engine.
3. The source writer appends `handoff.link` `{ handoffId, targetThreadId, targetSeatId, targetGenesisHash: G }`.
4. §2.1 (a), (b) and (c) are checked against the files as they now are, from the target's side (`checkHandoffTarget`, the check the gate runs before the target's first turn). Only then is the result returned.

**Step 5 (`handoff.aborted`).** After `handoff.out` exists:

| Failure | Source appends | `error` field | Answer |
| --- | --- | --- | --- |
| Step 3: the target open throws (lock taken by a live process, `sessions/` unusable, exclusive create refused, a `-32010` on the target's `session.open`, …) | `handoff.aborted` `target-open-failed` | the open's `{ code, message }` | that error (an unexpected throw is logged and answered `-32603`) |
| Step 4.1: G cannot be read back as written | `handoff.aborted` `target-genesis-unavailable` | `null` (there was no open error) | `-32010` `{ type: "handoff.link", reason: "field-missing", issues: ["targetGenesisHash is unavailable: …"] }` |
| Step 4.3: the writer refuses `handoff.link` (`-32010`) | `handoff.aborted` `target-genesis-unavailable` | `null` | that `-32010` |
| Step 4.3: the `handoff.link` append fails (`-32009`) | nothing more: the writer is broken | none | that `-32009`; doctor shows `handoff-incomplete` |
| Step 4.4: (a)–(c) do not hold after the link (only if the source file changed under the lock) | nothing more: the link is the terminal record | none | `-32010` `{ type: "handoff.link", reason: "handoff-one-way" }` |

`handoff.link` is never written after `handoff.aborted`, and a partial `handoff.link` is never written (evidence pin §2.1). If `handoff.aborted` itself is refused or cannot be appended, that is one stderr line (`session <threadId>: handoff.aborted refused (<issue>)` or the append failure) and never a second protocol error (evidence pin §5); the attempt stays `handoff-incomplete` in doctor.

**What a target looks like afterwards.**

- After success: one line, its `session.open`. It is not loaded, its lock is free, and it has no `session.close`: the procedure opens the target for its first turn and does not shut it down, so D-M2-A0-5's close-on-shutdown does not apply, and doctor's `not-cleanly-closed` WARN reports exactly that fact if it inspects the target. A later `thread/resume` passes the gate.
- After `handoff.aborted` with a target on disk: the target is orphaned (evidence pin §2.1 state table). `thread/resume`, the only way to load it, is refused `-32010 handoff-one-way` with nothing appended. Because it can never load, `turn/start` on it answers `-32002` before any gate and serves nothing.

---

## 5. Doctor

Nothing changes in doctor. After success both files report no handoff finding (§2.1 (a)–(c) hold from either side). After `handoff.aborted` the source reports nothing (a recorded failure is OK) and an orphaned target WARNs `handoff-incomplete`, as evidence pin §7 already says.

---

## 6. Non-goals of this act

- **Serving the brief.** No turn starts on the target inside the method; `turn/start` is not called and the agent is not invoked.
- **Git worktrees.** None created or managed. Product code only reads identity; a test fixture may run `git worktree add` in a temporary directory.
- **The handoff allowlist.** `handoffs.enabled` stays `false` and `handoffs.targets` stays `[]` (`-32006` otherwise). This method does not consult `targets`; the allowlist is a later seat pin.
- Also not here: a `founderDecision` method, an inbox, parallel seats, `memory.write`, `tool.call`, any envelope, hash or catalog change, any Z.ai change, a CLI subcommand, an npm publish, and any change to `protocolVersion`. `AGENTS.md`, `.cursor/` and `package-lock.json` are not edited.

---

## 7. Acceptance (this act, M2-A2)

`packages/engine/src/handoff-procedure.test.ts`, each test killing the named mutation:

| Commission row | Test | Mutation killed |
| --- | --- | --- |
| Success: out then link; target seq 0 cites H; link cites G; doctor clean; target lock free on return | "M2-A2 success: …" | answer success without `handoff.link`; keep the target lock |
| A turn started inside the method fails the test | "M2-A2 success: …" (spy agent, notifications, both files) | append `turn.start` to the target; start a turn on the source |
| Bad seat or empty brief: nothing appended | "M2-A2 refusals before any append: …" | load the target seat after `handoff.out`; accept an empty brief |
| Seat gate cases from M2-A1 still fail `-32006` | "M2-A2 refusals before any append: …" | let `handoffs.enabled: true` through |
| The source lock | "M2-A2 the caller must hold the source thread lock: …" | drop the lost-lock check; answer `-32002` for a live foreign holder |
| Open fails after out: aborted, no link | "M2-A2 the target open fails after handoff.out: …" and "M2-A2 the target exists but its genesis cannot be read back: …" | skip `handoff.aborted` |
| The orphaned target is refused `-32010 handoff-one-way` | "M2-A2 the target exists but its genesis cannot be read back: …" | let a one-way target load on resume |
| A secret-shaped brief is `[REDACTED]` and the chains verify | "M2-A2 redaction: …" | skip redaction for `handoff.out` |

The M2-A1 acceptance (`evidence-v2.test.ts`, `handoff-gate.test.ts`) still passes unchanged; `thread/start` now shares the session-open path with this method.

---

## 8. Sources read for this pin

All at `main` @ `ce10ca010ddd72c29513a117ba872168707b9046`: `docs/plan/README.md`, `PIN-madc-M2-evidence-schema-v2.md` (whole; hash above), `PIN-madc-M1-protocol-messages.md` (header, §3.3, §4, §7), `AGENTS.md`; `packages/engine/src/server.ts`, `session-store.ts`, `session-v2.ts`, `handoff.ts`, `worktree.ts`, `lock.ts`, `seat-store.ts` (`loadSeat`), `seat.ts` (seat gate), `inspect.ts`, `protocol/errors.ts`, `protocol/ids.ts`, `protocol/types.ts`, and the M2-A1 tests `handoff-gate.test.ts`, `evidence-v2.test.ts`. No live web source was fetched. No model, vendor or paid call was made.

*End of proposed M2 handoff procedure pin.*
