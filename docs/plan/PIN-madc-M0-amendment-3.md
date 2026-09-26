# PIN: M0 Amendment 3: rollback durability and broken-writer recovery, crash-residue classification, writer guard, seed `created:false`, `sessions/` permissions

*Surface Architect · 2026-09-25 (rev. 2026-09-26) · Venue: `MADVenturesLLC/MADC` · Status: **Accepted** build pin amendment (additive), binding from Founder merge; item 3: Option A (note 6 rejected). Docs only.*

*How this amendment takes effect: the Founder ticks exactly one item 3 box and, **in the same edit**, the status line above changes to **Accepted**. That edit is two lines (this status line and the item 3 decision line), committed on the PR branch before the final Copilot/Bugbot review of the head that is merged. The amendment binds from that merge. Until then it binds nothing.*

**Authority and base files** (all read at `main` @ `c55e4ba710700d12059a1023ca804e2999a59c66`, PR #17 merge):

- `docs/plan/PIN-madc-M0-amendment-2-session-integrity.md` (M0 Amendment 2, merged via PR #16): §2 (lines 27-39), §3 (lines 41-49), §4 (lines 51-57), §5 (lines 59-74). Items 1–3 and 5 amend it.
- `docs/plan/PIN-madc-M0-seat-format.md` (frozen): §1 "Seed" and "Permissions" rows (lines 33-34). Item 4 amends the seed's result contract.
- `docs/plan/README.md` status-keyed edit rule (lines 3-10).
- `docs/policy/CODE-ADVISORIES.md` (High findings need a fix, a same-act follow-up or a Founder-named waiver).
- Evidence: Argus post-merge reviews `/workspace/madc-reviews/pr-15.md` (F1, F3), `pr-16.md` (findings 2 and 3) and `pr-17.md` (F1, F2, F3, F4, F6, Founder notes table), with probes PROBE-A, PROBE-B, PROBE-D and PROBE-H at `c55e4ba`; Argus review of this PR `pr-20.md` (M1–M5, L1–L4); Copilot r4110040586 and review 5324399824 on PR #20.

**Scope.** This amendment tightens five behaviours. It changes **no** protocol method, notification, error code, lock body (`{ pid, startedAt, token }`), seat field, JSONL event type or on-disk format. Item 2 **narrows** Amendment 2 §5's `integrity` class: some files that are `integrity` today become `torn-tail`. Where this file and a base file disagree, this file wins for the items it names. Everything else in the base files stands.

---

## 1. Amendment 2 §4 and §3: rollback durability and broken-writer recovery

**Rule.**

1. A batch that the writer refused with `-32009` **MUST never reappear as session history** after a process crash, an OS crash or power loss, provided the storage honours fsync, **except** for the named residual R-1 below.
2. When **any write or the fsync** of a batch fails after bytes may have been written (including a short or partial write, for example `ENOSPC` partway through a multi-line batch), the writer **MUST** `ftruncate` the file back to the **pre-batch offset** (the size checked in Amendment 2 §2) **and then `fsync` the file** before it returns `-32009`. (Answers Copilot r4110040586.)
3. **Poisoned writer.** If that truncate or that second `fsync` fails, the thread's writer is **poisoned**: it **MUST** refuse every later append (writing nothing, `-32009`) **for the life of the engine process**. Neither `thread/resume` nor a lock re-take nor any other reload may clear it (rule 5). The engine **MUST** log once to stderr `session <threadId>: rollback failed; refused seq <first>..<last> may persist on disk` (no payload bytes). The engine keeps the thread lock until it exits, so no other engine resumes the file while the refused lines may be on it; the lock is released at shutdown as usual. Recovery requires an engine restart.
4. The existing rules stand: the writer is broken after any failed append (Amendment 2 §4 line 55), and the turn ends `failed` with `-32009` (Amendment 2 §2 line 37).
5. **Which request clears a broken writer.** A broken writer is cleared only by a reload from disk through the Amendment 2 §3 cold-resume path (verify, rebuild, close dangling turns, new writer), and only by the request named here:

| Cause of the break | File state | Cleared by | Until then |
| --- | --- | --- | --- |
| **(a) Failed append, rollback durable** (a §2 position check failure, or a write/fsync failure whose truncate + fsync succeeded) | Nothing from the refused batch (pre-batch bytes; after a position failure, whatever the other writer left) | **`thread/resume`** on that thread. It **MUST** reload from disk even while this engine still holds the lock (the lock is kept, not released). `turn/start` does **not** reload | `turn/start` → `-32009` |
| **(b) Rollback failed** (rule 3: poisoned) | May still hold the refused lines | **Nothing in this process.** Only an engine restart (then residual R-1 applies) | `turn/start` → `-32009`; `thread/resume` → `-32009` (no reload, no re-take; a lock taken for the attempt is released) |
| **(c) Lock lost** (the §2 ownership check failed, or `holdsThreadLock` is false at the next request) | Untouched by this writer | **`turn/start`** (Amendment 2 §3 MUST re-take, line 43) and **`thread/resume`**: both re-take the lock and reload | A foreign live holder → `-32004`; a failed reload → `-32603` (Amendment 2 §3) |

Precedence when causes combine: (b) beats (c) beats (a). A poisoned thread is never re-taken; a lost lock is re-taken even if the old writer was also broken by (a).

**Main today and the code change this requires** (at `c55e4ba`):

- `thread/resume` for a thread known in this process calls `#ensureLock`, which returns the in-memory record unchanged while the lock is held (`packages/engine/src/server.ts:384-389`, `:578`). So a (a)-broken writer is never reloaded while the lock is held.
- `#turnStart` treats every broken writer as permanent: `if (session.broken) throw sessionWriteFailed(...)` (`server.ts:607-609`) runs **before** `#ensureLock` (`:613`). So a lost lock (c) is never re-taken (Argus PR #17 F4, PROBE-D).
- The rollback swallows a truncate failure (`session-store.ts:538-542`) and never fsyncs the truncate, so (b) is indistinguishable from (a).

Required change (named so test 1b has one target):

- **C1.** `SessionWriter.append` (`session-store.ts:532-544`): the catch covers the write loop and the fsync, truncates to `sizeBefore`, then fsyncs. If either of those throws, set `writer.poisoned = true` in addition to `broken`.
- **C2.** The server keeps a process-lifetime `#poisoned: Set<threadId>`, filled when an append leaves its writer poisoned. It survives `#threads.delete` in `#ensureLock` (`server.ts:583`).
- **C3.** `#turnStart` (`server.ts:607-613`): first `#poisoned.has(threadId)` → `-32009`; then, if `holdsThreadLock(record.lock)` is false, `#ensureLock` (re-take + reload); only then `session.broken` → `-32009`. Preflight order is otherwise unchanged (preflight runs again after a reload, as at `:614-619`).
- **C4.** `#threadResume` (`server.ts:384-389` and the cold branch `:392-405`): poisoned → `-32009` without acquiring or reloading. Otherwise, a known record whose writer is broken is reloaded from disk through `#loadColdThread` under the lock it already holds, replacing the record. An active turn still → `-32004`.

**Residual R-1 (named, not closed).** If the truncate itself did not reach disk, the refused lines can still be on disk when the engine restarts (rule 3 only protects the running process). A restart verifies and rebuilds them as history: complete, chained lines verify (PROBE-H, `{ ok: true, nextSeq: 2 }`), and a partial last line is a torn tail and fails closed (item 2). Reload cannot refuse such a file reliably: nothing on disk marks the refused offset, and adding a marker (a sidecar file or an in-file event) would be a new on-disk format, which this amendment excludes (Scope). The stderr line in rule 3 is the operator's only signal. Repair and a persistent refusal marker are deferred to M1-A0 (Amendment 2 §7).

**Rationale.** Today the rollback is `ftruncateSync(fd, sizeBefore)` with no fsync after it (`packages/engine/src/session-store.ts:537-543`; the data write and fsync are at `:534-536`). If the machine crashes before the truncate reaches disk, the failed batch's complete, newline-terminated and correctly chained lines can persist. After restart `rebuildSession` accepts them, so an event the client was told failed comes back as history (for example, a turn as `interrupted` or a user message). Amendment 2 §4 says what "durable before it counts" means. It says nothing about the reverse case, "refused, so it must not count".

**Finding answered.**

- Argus PR #17 **F1 (Medium)**, `session-store.ts:534-543`.
- The PR #17 disposition of Copilot review 5321358571's rollback theme ("leftover bytes fail verification (torn-tail or integrity)") is **false as tested**. In Argus PROBE-H, the bytes captured at fsync-failure time verify `{ ok: true, nextSeq: 2 }`.
- Also Argus PR #16 finding 2 (the §4 part).
- Argus PR #20 M1 (truncate failure brought the refused batch back through the pinned reload), M2 / Copilot r4110040586 (write failure not covered), M3 (recovery per cause unstated).

**Residual R-2 (stated, not closed).** After an I/O error, Linux may report a later fsync as successful without persisting earlier dirty pages. So even truncate-then-fsync is not a full cure once the device has failed. Rule 3 keeps the process from building on a state it cannot trust. A restart re-reads whatever the kernel persisted.

**Not "refused".** A crash *during* a batch, before any response, leaves an unacknowledged batch (Amendment 2 §4 Definition). Its complete lines may persist and count. Rule 1 covers only batches answered `-32009`.

**Acceptance (Hephaestus must add).**

- **1a.** Inject a failure into the batch fsync (the existing test seam). Assert that the file is truncated to the prior size, that a **second fsync** runs after the truncate (fsync call count 2 for that batch), that the response is `-32009`, and that the file's bytes equal the pre-batch bytes.
- **1a-w.** Partial write: a three-event batch (for example the dangling-turn close batch, or a test batch), with a `writeChunk` seam that writes the first line and then throws `ENOSPC`. Assert truncate to the pre-batch offset, then an fsync after the truncate, `-32009`, and file bytes equal the pre-batch bytes.
- **1b.** Recovery per cause (rule 5), one engine process each:
  - (a) batch fsync fails, rollback succeeds → `turn/start` answers `-32009` and writes nothing; `thread/resume` (lock still held) reloads; the next `turn/start` appends and the chain verifies.
  - (b) batch fsync fails **and** the rollback fsync fails → poisoned: the next append, `turn/start` and `thread/resume` all answer `-32009` and write nothing (size and sha256 unchanged); after the lock is stolen and released, `thread/resume` and `turn/start` still answer `-32009` (no re-take). The rule 3 stderr line appears once. A **new engine process** then resumes and appends, and the chain verifies.
  - (c) the lock is stolen and released after an append → the next `turn/start` re-takes, reloads and appends (Argus PROBE-D).
- **1b-t.** Residual R-1 is real: inject a failure into the rollback **truncate** after a two-line batch whose bytes were fully written. The engine is poisoned and logs the seq range. A new engine process resumes with `nextSeq` past the refused lines (this asserts the documented residual; a future M1 fix flips it).
- **1c.** Mutation: remove the rollback fsync. It must be killed by 1a and by 1a-w. Mutation: roll back only on fsync failure, not on write failure. It must be killed by 1a-w.
- **1d.** Mutations, each killed by 1b: let `thread/resume` clear a poisoned thread; keep the `session.broken` check before `#ensureLock` in `turn/start` (kills row (c)); make `thread/resume` return the in-memory record while the lock is held (kills row (a)).

## 2. Amendment 2 §5: crash-residue classification

**Rule.** This replaces the classification paragraph at Amendment 2 §5 lines 61-64. The verifier **MUST** classify a failure as **torn tail (crash residue)** when either of these holds:

- **(a)** the session file is **0 bytes**; or
- **(b)** the file splits into a prefix `P` and a non-empty remainder `R` such that every line in `P` is complete (`\n`-terminated) and verifies (`P` may be empty), and either:
  - **(i)** `R` contains no `\n` (the existing unterminated-fragment case, including NUL fragments), or
  - **(ii)** `R` consists **only of NUL bytes (`0x00`) and ASCII whitespace** (space, tab, CR, LF), with or without a trailing `\n`.

Every other failure is **integrity**: a complete line that does not parse, fails the envelope or schema checks, breaks `seq` or the hash chain, or names the wrong thread.

This is a deterministic rule, not a promise that every crash artefact is torn-tail. For example, NUL bytes followed by a newline-terminated non-NUL fragment (`valid\n` + `\0\0\0{"v":1,"se\n`) is ordinary crash residue but stays **integrity**, because `R` contains a `\n` and non-whitespace. Conversely a trailing blank line (`valid\n` + `\n`), which is integrity ("not valid JSON") today, becomes **torn-tail** under (b)(ii).

The rest of Amendment 2 §5 stands:

- the engine fails closed (`thread/resume` → `-32603`; `thread/list` skips the thread);
- the engine never modifies, truncates, renames or deletes the file;
- doctor reports torn tail as crash residue, not tampering (CLI pin §3 `session` row).

**No repair in M0.** Repair stays deferred to M1-A0 (Amendment 2 §7).

**Supersedes D-163 (empty-file half).** PR #17 Founder note 4 (ledger D-163: "Empty (0-byte) session file = `integrity`") followed the letter of Amendment 2 §5. When this amendment merges, a 0-byte file is `torn-tail`. The fragment-only half of D-163 is unchanged; it is case (b)(i) with `P` empty. (For the ledger: D-163 is superseded in its empty-file half only.)

**Rationale.** A crash after the directory fsync but before the first data fsync leaves an empty file. Out-of-order page writeback of an unacknowledged batch can leave NUL-filled lines that end in `\n`. Both are ordinary crash artefacts, and today doctor prints them as `integrity: … may be tampering` (`packages/engine/src/session-store.ts:612` for the empty file, `:613-628` for the tail rule).

**Finding answered.**

- Argus PR #17 **F6 (Low, pin gap)**, PROBE-A: empty → integrity; good + `\0\0\0\n` → integrity; good + NULs with no `\n` → torn. Mutation 17-M (empty → torn) survived, so the choice was not pinned by any test.
- Argus PR #16 finding 2 (the §5 part).

**Acceptance (Hephaestus must add).**

- **2a.** Each of these classifies as `torn-tail`, `thread/resume` stays `-32603`, and the file's sha256 is unchanged:
  - a 0-byte file;
  - valid lines + `\0\0\0` (no `\n`);
  - valid lines + `\0\0\0\n`;
  - valid lines + a whitespace-only tail;
  - valid lines + several NUL-only lines;
  - valid lines + one trailing blank line (`\n`);
  - a file that is only NULs.
- **2b.** Each of these stays `integrity`:
  - a mid-file edit;
  - a complete non-JSON line at the end (for example `garbage\n`);
  - a complete, well-formed line with a wrong hash;
  - a NUL-only line **followed by** a valid-looking complete line;
  - valid lines + a NUL run followed by a newline-terminated non-NUL fragment.
- **2c.** Doctor prints the torn-tail row text (CLI pin §3 `session` row) for every 2a case.
- **2d.** Mutations: "empty → integrity" (17-M reversed), "NUL/whitespace-only terminated tail → integrity" (killed by the trailing-blank-line case among others), and "any NUL in `R` → torn" (killed by the last 2b case). All must be killed.

## 3. Amendment 2 §2: where the writer guard lives (Founder decision required: accept or reject #17 Founder note 6, ledger D-184)

**Background.**

- Amendment 2 §2 (line 29) says "the session writer MUST check two things", ownership and position, before each batch.
- PR #17 Founder note 6 reads: "**Direct `SessionWriter` callers** (unit tests, the FIFO fixture) get no lock guard and a resume size read at resume time by default; the engine always passes both guards."
- On `main`:
  - the defaults are `guards.holdsLock ?? (() => true)` (`packages/engine/src/session-store.ts:391`, `:456`) and an `lstat` size fallback at resume (`:428-435`);
  - `SessionWriter` is exported from the package entry (`packages/engine/src/index.ts:80`);
  - the engine binds both guards at `packages/engine/src/server.ts:331` and `:452`.
- Argus calls note 6 a **reinterpretation** that moves the MUST from the writer to its caller (pr-17.md, Founder notes table, row 6).

**Acceptance under both options (unconditional).** These apply when this amendment merges, whichever box is ticked, and even if item 3 itself does not take effect. They kill Argus's surviving mutations 17-D and 17-E (pr-17.md F2), which matter under A and under B.

- **3a.** A resumed writer loses its lock, with no foreign append yet → the next append answers `-32009` and writes nothing. This is Argus PROBE-G, and it must kill 17-E.
- **3b.** A test kills 17-D: a test seam appends externally between chain verification and `SessionWriter.resume`, and the resumed writer's first append must answer `-32009` and write nothing.

**Surface RECOMMENDS Option A.** Both options are given equal space below.

**Option A: accept this item, reject note 6 (guard stays in the writer).**

- `create` and `resume` **MUST** require a `holdsLock` guard (and `resume` **MUST** require `expectedSize`, the verified size), with no default. This prevents an unguarded writer **by omission**; a caller can still pass `() => true` explicitly, and Option A does not claim otherwise.
- Any unguarded mode (for unit tests and fixtures) **MUST** be an explicit opt-in with a name that says so, for example `SessionWriter.unguardedForTests(...)`, and **MUST NOT** be exported from the package entry (`packages/engine/src/index.ts`) or from `@madc/engine/client`. `testing/fifo-append-probe.ts` imports `../session-store.ts` directly (line 9), so it can still reach the opt-in.
- The engine's behaviour does not change.
- **Cost:** 22 test call sites of `SessionWriter.create`/`resume` (`session-hardening.test.ts` 11, `session-integrity.test.ts` 6, `session.test.ts` 5) plus the FIFO fixture must pass guards or switch to the opt-in.

**Rationale for A.** §2 is a property of the writer. A public constructor that silently produces a writer without it makes "every append re-checks ownership" depend on each caller remembering. Argus showed the engine's resume-path wiring could be deleted with no test failing (17-D and 17-E survived, pr-17.md F2); with A, deleting it is also a type error.

**Option B: accept note 6 as a Founder-named deviation.**

- The §2 MUST binds the engine's use of the writer. The direct `SessionWriter` API may default to no lock guard and to reading the size at resume.
- The Founder names this deviation in the merge: the tick plus a merge-commit message that names **D-184**. The ledger records it.
- Third-party callers of the public export get no §2 protection unless they pass both guards. The type docs **MUST** say so.

**Rationale for B.** It matches the code as built and reviewed in #17, so nothing churns (no test call site or fixture changes). The engine is the only production caller and binds both guards (`server.ts:331`, `:452`); the unconditional tests 3a and 3b now pin that wiring, which closes the gap Argus found without changing the API. In M0 the engine package has no third-party callers, and the public SDK surface is an M1 design question, where the guard's location can be revisited with real callers in view.

**Founder decision (item 3):** ☑ Option A (reject note 6) · ☐ Option B (accept note 6)

Tick exactly one box, in the same edit as the status-line change to Accepted (see the header). If neither box is ticked at merge, the Option A / Option B rules do not take effect and note 6 stays an unconfirmed interpretation; 3a and 3b still apply.

**Finding answered.** #17 Founder note 6 (ledger D-184); Argus PR #17 F2 (Medium, test gap) with its note for Surface item 3; Argus PR #20 M5 (3a/3b were conditional), L1 (status line), and the fairness notes in pr-20.md §D.

**Additional acceptance (Option A only).**

- **3c.** Calling `create` or `resume` without `holdsLock` (and `resume` without `expectedSize`) fails at the type level and throws at run time.
- **3d.** An export-surface test asserts that no unguarded factory is reachable from `packages/engine/src/index.ts` or `@madc/engine/client`.
- **3e.** Mutation: restore the `() => true` default. It must be killed by 3c.

## 4. Seat pin §1 "Seed": meaning of `created:false`

**Rule.**

1. **Meaning.** `seedDefaultSeat` returning `{ created: false }` **MUST mean**: the seat file already existed at the confined path, and this call neither wrote nor changed it. The seed **MUST** return `created:false` **only when** the existing file passes every opened-file check in rule 2; in every other case, including an `EEXIST` from the link or the exclusive create, it **MUST** return an error.
2. **Proof on the opened fd.** Before returning `created:false`, the seed **MUST** open the existing file without following symlinks and without blocking (`O_RDONLY|O_NOFOLLOW|O_NONBLOCK`, or the `openNoFollow` fallback), and **MUST** verify all of the following on that fd:
   - `fstat` dev and inode equal `lstat(path)` dev and inode;
   - it is a regular file;
   - **`nlink == 1`**;
   - `path` resolves strictly under realpath(`$MADC_HOME`), inside the pinned `seats/`.
3. **Failure is an error.** Any failed or impossible check (symlink, directory, FIFO, a hard-linked file, a path that has vanished after `EEXIST`, a `seats/` that is no longer pinned) **MUST** return an error, **never** `created:false`.
4. **Same checks on the write path.** Before writing any seed byte, the seed **MUST** check `nlink == 1` on the opened temp fd, in addition to the existing dev/inode check. The temp fd **MUST stay open through the link and the temp unlink** (today it is closed right after the fsync, `seat-store.ts:131-133`). After the link, `fstat` **on that fd** **MUST** show `nlink == 2` and `lstat(path)` the same dev/inode; after the temp unlink, `fstat` on the fd **MUST** show `nlink == 1`. The counts are read from the fd, not the path, because a path can be swapped. Any mismatch is an error, and the seed's own names are removed best effort (as today).
5. **Consequence: benign states become a logged, non-fatal seed failure.** `nlink == 1` turns two states that are not attacks into seed errors: two concurrent first seeds on a fresh home (two engines, or an engine and `madc doctor --init`: while seeder A's temp and final names both exist, seeder B's `EEXIST` proof sees `nlink == 2`), and an operator's hard link to `madc-default.json`. On engine start the seed error is only logged (`seed failed: …`) and the engine continues (`server.ts:164-173`, the doc comment at `:166` says so); `thread/start` then loads the seat normally, because `loadSeat` does not check `nlink`. `doctor --init` reports the seed error on its init row. No retry is required in M0.

**Rationale.**

- The early exit returns `created:false` after a bare `lstatSync(path)` (`packages/engine/src/seat-store.ts:244-246`), so a symlink, directory or FIFO at the path counts as "already seeded".
- Both `EEXIST` branches return `created:false` after only a pin re-check, never checking that `path` exists in the pinned `seats/` (`:302-305`, `:312-317`).
- `isAt` (`:272-276`) compares `lstat(path)` with the fd, which proves which inode the path names, not how the fd was reached. After a check-to-open swap, an inode created outside the home can be hard-linked in at the temp name before `isAt` runs (`:116`). The seed then writes through the fd into an inode that also has an outside name.
- `nlink == 1` on the opened fd detects that shared inode before any byte is written.

**Finding answered.**

- Copilot **High** [r4107279105](https://github.com/MADVenturesLLC/MADC/pull/15#discussion_r4107279105) on PR #15 (ledger D-181; `isAt` checks the path, not the opened file; Argus PR #15 F1), posted 5 minutes after the merge and never dispositioned. **This item closes r4107279105 for every case the fd can observe.** The cases it cannot observe are named below as residuals R-4a and R-4b.
- Copilot Medium [r4107279162](https://github.com/MADVenturesLLC/MADC/pull/15#discussion_r4107279162) (ledger D-182; `EEXIST` during a swap returned `{ created: false }` with no seat file; Argus PR #15 F3) is closed by rules 1–3: an `EEXIST` is never itself proof of an existing seat.

**Not closed: the D-156 residual (ledger scope).** D-156 is the r4105871146 open/link gap: Node has no `openat`, `linkat` or `unlinkat`, so the transient outside link between the pre-link re-pin and `link()`, and a name the path-based undo can miss after a second swap, remain (Argus PR #15 F2). This item does not close or change D-156. That residual is covered only by the Founder's by-name waiver of D-156; this amendment neither grants nor records that waiver. (The ledger shows D-156 as "pending waiver", and no named waiver is on GitHub.)

**Residuals of r4107279105 (named, not closed, and not part of D-156).** Two cases are invisible to any check on the fd:

- **R-4a.** A hard link to the seat or temp inode added **after** the `nlink` check.
- **R-4b.** An outside holder with an **open fd** to an inode created outside the home and linked in, whose outside name was removed before the check (`nlink` is back to 1; an open fd is not counted).

Under CODE-ADVISORIES a High finding's residual needs a fix, a follow-up or a Founder-named waiver. These are left for the Founder to waive **by name** (r4107279105 R-4a/R-4b), separately from D-156.

**Acceptance (Hephaestus must add).**

- **4a.** A pre-existing regular `madc-default.json` → `created:false`, with bytes and mtime unchanged.
- **4b.** Each of these at the path → an error, not `created:false`:
  - a symlink;
  - a directory;
  - a FIFO (no hang);
  - a regular file with a second hard link (`nlink 2`).
- **4c.** A test seam makes the link answer `EEXIST` while `path` is absent from the pinned `seats/` (r4107279162, D-182) → an error, never `created:false`.
- **4d.** A seam between the temp open and the check adds a second hard link to the temp inode (r4107279105, D-181) → an error, no seed byte written into that inode, and the seed's own temp name removed.
- **4e.** Two seeders: two processes seed the same fresh home at once (a barrier seam releases both before the link). Exactly one returns `created:true`; the other returns `created:false` or an error, never `created:true`. The final `madc-default.json` has the default bytes and `nlink == 1`, no temp file is left, and an engine started over the result logs at most `seed failed` and serves `thread/start`.
- **4f.** Post-link counts are read from the still-open temp fd: a seam swaps the path for another file with `nlink == 2` between link and check → an error.
- **4g.** Mutations: drop the `nlink` check on the temp fd (killed by 4d); return `created:false` on `EEXIST` without the fd proof (killed by 4c); restore the bare-`lstat` early exit (killed by 4b); read the post-link `nlink` from the path instead of the fd (killed by 4f); make a seed error fatal to engine start (killed by 4e).

## 5. Amendment 2 §4: `sessions/` permissions (0300 unsupported in M0)

**Rule.**

1. In M0 the `sessions/` directory **MUST** grant its owner read, write and search. The engine creates it `0700`, and M0 assumes `0700`.
2. A `sessions/` directory that lacks **owner read** (for example `0300`) is **unsupported in M0** on POSIX. The Amendment 2 §4 directory fsync after file creation **stays** (it needs owner read: `open(dir, O_RDONLY|O_DIRECTORY)` fails `EACCES`, and `O_PATH` + `fsync` fails `EBADF`, Argus pr-20.md M4).
3. `thread/start` on such a directory **MUST** fail with `-32009` (`data` as pinned: `{ threadId, path, seq }`) **before creating the session file**, with a `message` that names the cause, for example `sessions/ is not readable by its owner (mode 0300 is unsupported in M0; use 0700)`. No 0-byte file is left behind.
4. `madc doctor` **MUST** WARN on such a directory: `sessions/ mode 0300: unsupported in M0 (needs owner read for directory fsync)`.
5. On Windows the directory fsync is a best-effort no-op (Amendment 2 §4) and this item does not apply.

**D-158 stands.** `home.ts` `enforcePrivateDirAt` classifies an unchanged `0300` directory as **private** (PR #15). That is about privacy. It does not make `0300` usable for session writes.

**Defect reframed (Argus PR #17 F3, PROBE-B).** On `main`, `thread/start` on a `0300` `sessions/` already answers `-32009`, but only after the file is created, from the directory fsync (`packages/engine/src/session-store.ts:243`), with a message that does not name the cause. The follow-up PR after #19 **MUST** make it fail before creating the file with the clear message (rule 3), and doctor **MUST** warn (rule 4).

**Finding answered.** Argus PR #20 M4 (the earlier non-normative "0300 is supported" note contradicted the Amendment 2 §4 directory fsync); Argus PR #17 F3.

**Acceptance (Hephaestus must add).**

- **5a.** `sessions/` chmod `0300` (POSIX; skipped with a logged reason on Windows and when running as root) → `thread/start` answers `-32009`, the message names mode `0300`, and `sessions/` gains no file.
- **5b.** Doctor on the same home WARNs with the rule 4 text and changes nothing.
- **5c.** Mutations: create the file before the permission check (killed by 5a: a file appears); drop the doctor warning (killed by 5b).

---

## Note (non-normative): existing requirements, not changed here

Amendment 2 §3 (line 43) already says that `turn/start` after `holdsThreadLock` returned false MUST re-take the lock and reload from disk. So after a lock loss, `turn/start` must re-take and recover rather than keep answering `-32009`. On `main` it does not: the `session.broken` check (`packages/engine/src/server.ts:609`) runs before `#ensureLock` (`:613`), so every later `turn/start` in that engine answers `-32009` even when the lock is free (Argus PR #17 F4, PROBE-D). That is a **defect for the follow-up PR after #19**, not a new rule. Item 1 rule 5 row (c) and change C3 restate the same requirement and name the code change; a poisoned thread (row (b)) is the only exception.

*End of Amendment 3.*
