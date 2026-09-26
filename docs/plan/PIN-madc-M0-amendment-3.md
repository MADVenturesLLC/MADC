# PIN: M0 Amendment 3: rollback durability, crash-residue classification, writer guard, seed `created:false`

*Surface Architect · 2026-09-25 · Venue: `MADVenturesLLC/MADC` · Status: **Proposed** build pin amendment. It takes effect only when the Founder merges it; until then it binds nothing. Item 3 also needs an explicit Founder decision (accept or reject #17 Founder note 6). Docs only.*

**Authority and base files** (all read at `main` @ `c55e4ba710700d12059a1023ca804e2999a59c66`, PR #17 merge):

- `docs/plan/PIN-madc-M0-amendment-2-session-integrity.md` (M0 Amendment 2, merged via PR #16): §2 (lines 27-39), §4 (lines 51-57), §5 (lines 59-74). Items 1–3 amend it.
- `docs/plan/PIN-madc-M0-seat-format.md` (frozen): §1 "Seed" and "Permissions" rows (lines 33-34). Item 4 amends the seed's result contract.
- `docs/plan/README.md` status-keyed edit rule (lines 3-10).
- `docs/policy/CODE-ADVISORIES.md` (High findings need a fix, a same-act follow-up or a Founder-named waiver).
- Evidence: Argus post-merge reviews `/workspace/madc-reviews/pr-15.md` (F1, F3), `pr-16.md` (findings 2 and 3) and `pr-17.md` (F1, F2, F3, F6, Founder notes table), with probes PROBE-A, PROBE-B and PROBE-H at `c55e4ba`.

**Scope.** This amendment tightens four behaviours. It changes **no** protocol method, notification, error code, lock body (`{ pid, startedAt, token }`), seat field, JSONL event type or on-disk format. Item 2 **narrows** Amendment 2 §5's `integrity` class: some files that are `integrity` today become `torn-tail`. Where this file and a base file disagree, this file wins for the items it names. Everything else in the base files stands.

---

## 1. Amendment 2 §4: rollback durability

**Rule.**

1. A batch that the writer refused with `-32009` **MUST never reappear as session history** after a process crash, an OS crash or power loss, provided the storage honours fsync.
2. When the append's `fsync` fails, the writer **MUST** `ftruncate` the file back to the size before the batch **and then `fsync` the file** before it returns `-32009`.
3. If that truncate or the second `fsync` fails, the writer **MUST** be marked broken and **MUST refuse every later append** (writing nothing, `-32009`) until the thread is reloaded from disk through the Amendment 2 §3 cold-resume path (a new engine or a `thread/resume` re-take).
4. The existing rules stand: the writer is broken after any failed append (Amendment 2 §4 line 55), and the turn ends `failed` with `-32009` (Amendment 2 §2 line 37).

**Rationale.** Today the rollback is `ftruncateSync(fd, sizeBefore)` with no fsync after it (`packages/engine/src/session-store.ts:537-543`; the data write and fsync are at `:534-536`). If the machine crashes before the truncate reaches disk, the failed batch's complete, newline-terminated and correctly chained lines can persist. After restart `rebuildSession` accepts them, so an event the client was told failed comes back as history (for example, a turn as `interrupted` or a user message). Amendment 2 §4 says what "durable before it counts" means. It says nothing about the reverse case, "refused, so it must not count".

**Finding answered.**

- Argus PR #17 **F1 (Medium)**, `session-store.ts:534-543`.
- The PR #17 disposition of Copilot review 5321358571's rollback theme ("leftover bytes fail verification (torn-tail or integrity)") is **false as tested**. In Argus PROBE-H, the bytes captured at fsync-failure time verify `{ ok: true, nextSeq: 2 }`.
- Also Argus PR #16 finding 2 (the §4 part).

**Residual (stated, not closed).** After an I/O error, Linux may report a later fsync as successful without persisting earlier dirty pages. So even truncate-then-fsync is not a full cure once the device has failed. Rule 3 keeps the process from building on a state it cannot trust. A reload re-reads whatever the kernel persisted.

**Acceptance (Hephaestus must add).**

- **1a.** Inject a failure into the batch fsync (the existing test seam). Assert that the file is truncated to the prior size, that a **second fsync** runs after the truncate (fsync call count 2 for that batch), that the response is `-32009`, and that the file's bytes equal the pre-batch bytes.
- **1b.** Inject failures into the batch fsync **and** the rollback fsync. Assert that the writer is broken and the next append on that writer answers `-32009` and writes nothing (size and sha256 unchanged). After a `thread/resume` re-take (reload from disk), appends work again and the chain verifies.
- **1c.** Mutation: remove the rollback fsync. It must be killed by 1a.
- **1d.** Mutation: let a writer whose rollback fsync failed accept a later append without a reload. It must be killed by 1b.

## 2. Amendment 2 §5: crash-residue classification

**Rule.** This replaces the classification paragraph at Amendment 2 §5 lines 61-64. The verifier **MUST** classify a failure as **torn tail (crash residue)** when either of these holds:

- **(a)** the session file is **0 bytes**; or
- **(b)** the file splits into a prefix `P` and a non-empty remainder `R` such that every line in `P` is complete (`\n`-terminated) and verifies (`P` may be empty), and either:
  - **(i)** `R` contains no `\n` (the existing unterminated-fragment case, including NUL fragments), or
  - **(ii)** `R` consists **only of NUL bytes (`0x00`) and ASCII whitespace** (space, tab, CR, LF), with or without a trailing `\n`.

Every other failure is **integrity**: a complete line that does not parse, fails the envelope or schema checks, breaks `seq` or the hash chain, or names the wrong thread. **Integrity is reserved for content that is actually there and wrong.**

The rest of Amendment 2 §5 stands:

- the engine fails closed (`thread/resume` → `-32603`; `thread/list` skips the thread);
- the engine never modifies, truncates, renames or deletes the file;
- doctor reports torn tail as crash residue, not tampering (CLI pin §3 `session` row).

**No repair in M0.** Repair stays deferred to M1-A0 (Amendment 2 §7).

**Supersedes D-163.** PR #17 Founder note 4 (ledger D-163: "Empty (0-byte) session file = `integrity`") followed the letter of Amendment 2 §5. When this amendment merges, a 0-byte file is `torn-tail`. The fragment-only rule in D-163 is unchanged; it is case (b)(i) with `P` empty.

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
  - a file that is only NULs.
- **2b.** Each of these stays `integrity`:
  - a mid-file edit;
  - a complete non-JSON line at the end (for example `garbage\n`);
  - a complete, well-formed line with a wrong hash;
  - a NUL-only line **followed by** a valid-looking complete line.
- **2c.** Doctor prints the torn-tail row text (CLI pin §3 `session` row) for every 2a case.
- **2d.** Mutations: "empty → integrity" (17-M reversed), and "NUL/whitespace-only terminated tail → integrity". Both must be killed.

## 3. Amendment 2 §2: where the writer guard lives (Founder decision required: accept or reject #17 Founder note 6, ledger D-184)

**Background.**

- Amendment 2 §2 (line 29) says "the session writer MUST check two things", ownership and position, before each batch.
- PR #17 Founder note 6 reads: "**Direct `SessionWriter` callers** (unit tests, the FIFO fixture) get no lock guard and a resume size read at resume time by default; the engine always passes both guards."
- On `main`:
  - the defaults are `guards.holdsLock ?? (() => true)` (`packages/engine/src/session-store.ts:391`, `:456`) and an `lstat` size fallback at resume (`:428-435`);
  - `SessionWriter` is exported from the package entry (`packages/engine/src/index.ts:80`);
  - the engine binds both guards at `packages/engine/src/server.ts:331` and `:452`.
- Argus calls note 6 a **reinterpretation** that moves the MUST from the writer to its caller (pr-17.md, Founder notes table, row 6).

**Surface RECOMMENDS Option A.**

**Option A: accept this item, reject note 6 (guard stays in the writer).**

- The exported `SessionWriter` **MUST refuse every append unless it is bound to the current lock token**. `create` and `resume` **MUST** require `holdsLock` (and `resume` **MUST** require `expectedSize`, the verified size), with no default, so a writer cannot exist in an unguarded state by omission.
- Any unguarded mode (for unit tests and fixtures) **MUST** be an explicit opt-in with a name that says so, for example `SessionWriter.unguardedForTests(...)`, and **MUST NOT** be exported from the package entry (`packages/engine/src/index.ts`) or from `@madc/engine/client`.
- The engine's behaviour does not change.

**Option B: accept note 6 as a Founder-named deviation.**

- The §2 MUST binds the engine's use of the writer. The direct `SessionWriter` API may default to no lock guard and to reading the size at resume.
- The Founder names this deviation in the merge of this amendment, and a ledger entry records it.
- Third-party callers of the public export get no §2 protection unless they pass both guards. The type docs **MUST** say so.

**Founder decision:** ☐ Option A (reject note 6) ☐ Option B (accept note 6). If neither box is ticked at merge, this item does not take effect, and note 6 stays an unconfirmed interpretation.

**Rationale for A.**

- §2 is a property of the writer. A public constructor that silently produces a writer without it makes "every append re-checks ownership" depend on each caller remembering.
- Argus shows the engine's resume-path wiring can be deleted without any test failing: mutations 17-D (drop `expectedSize` at resume) and 17-E (resumed writer not lock-bound) both survive (pr-17.md F2).

**Finding answered.** #17 Founder note 6 (ledger D-184), and Argus PR #17 F2 (Medium, test gap) with its note for Surface item 3.

**Acceptance (both options).**

- **3a.** A resumed writer loses its lock, with no foreign append yet → the next append answers `-32009` and writes nothing. This is Argus PROBE-G, and it must kill 17-E.
- **3b.** A test kills 17-D: a test seam appends externally between chain verification and `SessionWriter.resume`, and the resumed writer's first append must answer `-32009` and write nothing.

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
4. **Same checks on the write path.** Before writing any seed byte, the seed **MUST** check `nlink == 1` on the opened temp fd, in addition to the existing dev/inode check. After the link it **MUST** check that the final name and the temp name are the same inode with `nlink == 2`, and after the temp unlink, `nlink == 1`. Any mismatch is an error, and the seed's own names are removed best effort (as today).

**Rationale.**

- The early exit returns `created:false` after a bare `lstatSync(path)` (`packages/engine/src/seat-store.ts:244-246`), so a symlink, directory or FIFO at the path counts as "already seeded".
- Both `EEXIST` branches return `created:false` after only a pin re-check, never checking that `path` exists in the pinned `seats/` (`:302-305`, `:312-317`).
- `isAt` (`:272-276`) compares `lstat(path)` with the fd, which proves which inode the path names, not how the fd was reached. After a check-to-open swap, an inode created outside the home can be hard-linked in at the temp name before `isAt` runs (`:116`). The seed then writes through the fd into an inode that also has an outside name.
- `nlink == 1` on the opened fd detects that shared inode before any byte is written.

**Finding answered.**

- Copilot **High** [r4107279105](https://github.com/MADVenturesLLC/MADC/pull/15#discussion_r4107279105) on PR #15 (ledger D-181; `isAt` checks the path, not the opened file; Argus PR #15 F1), posted 5 minutes after the merge and never dispositioned. **This item closes r4107279105** for every case the fd can observe.
- Copilot Medium [r4107279162](https://github.com/MADVenturesLLC/MADC/pull/15#discussion_r4107279162) (ledger D-182; `EEXIST` during a swap returned `{ created: false }` with no seat file; Argus PR #15 F3) is closed by rules 1–3: an `EEXIST` is never itself proof of an existing seat.

**Not closed: the D-156 residual.** Node has no `openat`, `linkat` or `unlinkat`. So the transient outside link between the pre-link re-pin and `link()`, and a name the path-based undo can miss after a second swap, remain (Argus PR #15 F2). A hard link planted **after** the `nlink` check is the same class. This item does not close or change D-156. That residual is covered only by the Founder's by-name waiver of D-156; this amendment neither grants nor records that waiver. (The ledger shows D-156 as "pending waiver", and no named waiver is on GitHub.)

**Acceptance (Hephaestus must add).**

- **4a.** A pre-existing regular `madc-default.json` → `created:false`, with bytes and mtime unchanged.
- **4b.** Each of these at the path → an error, not `created:false`:
  - a symlink;
  - a directory;
  - a FIFO (no hang);
  - a regular file with a second hard link (`nlink 2`).
- **4c.** A test seam makes the link answer `EEXIST` while `path` is absent from the pinned `seats/` (r4107279162, D-182) → an error, never `created:false`.
- **4d.** A seam between the temp open and the check adds a second hard link to the temp inode (r4107279105, D-181) → an error, no seed byte written into that inode, and the seed's own temp name removed.
- **4e.** Mutations: drop the `nlink` check on the temp fd (killed by 4d); return `created:false` on `EEXIST` without the fd proof (killed by 4c); restore the bare-`lstat` early exit (killed by 4b).

---

## Note (non-normative): `sessions/` permissions

A `sessions/` directory with mode `0300` (owner write and search, no owner read) **is supported**. This is consistent with D-158: in PR #15, `home.ts` `enforcePrivateDirAt` treats an unchanged, already-private `0300` directory as private.

On `main`, `thread/start` answers `-32009` on a `0300` `sessions/` (Argus PR #17 F3, PROBE-B). The Amendment 2 §4 directory fsync opens the directory `O_RDONLY|O_DIRECTORY` (`packages/engine/src/session-store.ts:243`), which needs owner read. That is a **defect against the supported behaviour**, not a pin change. It is to be fixed, with a test, in the follow-up PR after #19. This note adds no rule.

## Note (non-normative): existing requirements, not changed here

Amendment 2 §3 (line 43) already says that `turn/start` after `holdsThreadLock` returned false MUST re-take the lock and reload from disk. So after a lock loss, `turn/start` must re-take and recover rather than keep answering `-32009`. On `main` it does not: the `session.broken` check (`packages/engine/src/server.ts:609`) runs before `#ensureLock` (`:613`), so every later `turn/start` in that engine answers `-32009` even when the lock is free (Argus PR #17 F4, PROBE-D). That is a **defect for the follow-up PR after #19**, not a new rule.

*End of Amendment 3.*
