# PIN: M0 Amendment 2: session integrity (single writer, durability, torn tail)

*Surface Architect · 2026-09-25 · Venue: `MADVenturesLLC/MADC` · Status: **build pin amendment** (additive), Founder-authorized 2026-09-25. It gates the Hephaestus A4 follow-up act "session integrity", which must merge before Act M0-A7. Docs only.*

*Amended by `PIN-madc-M0-amendment-3.md` (2026-09-25): §4 rollback durability and `sessions/` permissions, §3 broken-writer recovery, §5 crash-residue classification, §2 writer guard.*

**Authority:**

- `docs/plan/PIN-madc-M0-protocol-messages.md` (frozen, including Amendment 1 from PR #8) and `docs/plan/PIN-madc-M0-seat-format.md` (frozen). Both are read at `main` @ `00e1698595926a64fd858ed7abcaa0941504296c`, with blobs `f3a545c1` and `91f61a7f`.
- `docs/plan/PLAN-madc-M0-build-plan.md` §9 (session record with hash chain). Founder-accepted; on `main` via PR #2, merge commit `9c71afd5c99d44443eecce2a0b4678e90dea6cb0`.
- Evidence:
  - Argus post-merge review of PR #13 (F1 chain fork after lock loss; F2 no fsync) and of PR #8 (three-engine reclaim race).
  - Surface probes on 2026-09-25: two real engine processes, one in its own PID namespace (`unshare -Urpf`), sharing one `MADC_HOME`. The second engine reclaimed the first engine's **live** lock, and the chain forked while both turns reported `completed`. Cold resume then answered `-32603`.

**Scope: additive only.** This amendment adds requirements. It changes **no** protocol method, notification, error code, lock body (`{ pid, startedAt, token }`), seat field or JSONL event type. Where this file and a base pin seem to disagree, this file adds a requirement; it never removes one.

---

## 1. Operating envelope (M0 rule)

One `$MADC_HOME` is served by engines in **one PID namespace on one host and one kernel boot**. The following are **unsupported in M0**:

- engines in different containers, VMs, PID namespaces or hosts sharing one `MADC_HOME`, for example through a bind mount, a network filesystem or a synced folder.

The reason is that lock liveness is `kill(pid, 0)` (`packages/engine/src/lock.ts:165-174`), which cannot see a process in another PID namespace. A live holder there looks dead and its lock is reclaimed.

`madc doctor` warns when a lock owner is not visible (`docs/plan/PIN-madc-M0-cli.md`, `locks` row). Namespace-proof liveness is deferred to M1-A0 (§7).

## 2. Every append re-checks ownership and position

Before writing each append batch, the session writer MUST check two things on the same open fd it is about to write through:

1. **Ownership.** The lock at `sessions/<threadId>.lock` still carries this acquisition's `token`, and the lock path still names that file (the protocol pin §3.3 (a) check, `holdsThreadLock`).
2. **Position.** `fstat(fd).size` equals the writer's expected end offset. That offset is the size after the writer's own last successful write, or the verified file size at `thread/start` or resume.

If either check fails, the writer writes nothing and becomes broken:

- at `thread/start`, the request fails with **`-32009 SessionWriteFailed`**;
- mid-turn, the turn ends `failed` with `error.code = -32009` and an `error` item (protocol pin §4.2).

An engine never appends with a `seq` or `prevHash` that was not derived from the bytes currently on disk.

## 3. Lock re-take reloads from disk

When an engine re-acquires the lock for a thread it already holds in memory (warm `thread/resume`, or `turn/start` after `holdsThreadLock` returned false), it MUST:

1. discard the in-memory session writer and thread state;
2. **reload from disk under the new lock** through the cold-resume path: verify the chain, rebuild, and close dangling turns as `interrupted`;
3. only then append.

If verification fails, the request fails exactly as a cold resume does: `-32603`, the lock is released, and the file is untouched. Keeping a stale in-memory writer across a re-take is forbidden.

## 4. Durability: fsync

- **On every append.** Each append batch is followed by `fsync` of the session fd (`fdatasync` is acceptable) before the append counts as successful. That is also before any response or notification that the pins require to be "durable before exposed".
- **On file creation.** After creating a session file, `fsync` the `sessions/` directory. This applies on POSIX only; on Windows it is a best-effort no-op.
- **Failure.** A failed fsync is a failed append: roll back to the prior size (as today), mark the writer broken, and answer `-32009`.

**Definition:** in the M0 pins, *durable* means an acknowledged append survives a process crash, an OS crash and power loss, provided the storage honors fsync. A crash during an unacknowledged write may still leave a torn tail (§5).

## 5. Torn tail: detect and report distinctly, never auto-repair

**Classification.** The verifier classifies a failure as one of two kinds:

- **torn tail:** every complete (`\n`-terminated) line verifies, and the bytes after the last `\n` are non-empty. Those bytes are an unterminated fragment and/or NUL bytes. Today's verifier reason for this is "unterminated last line".
- **integrity failure:** any other failure, such as a hash or seq mismatch, a malformed complete line, or a wrong thread. This may be tampering.

**Engine behavior is unchanged: fail closed.**

- `thread/resume` answers `-32603`.
- `thread/list` skips the thread.
- The engine never modifies, truncates, renames or deletes the file.

**Reporting.** Doctor reports a torn tail as crash residue, not tampering, separately from integrity failures (CLI pin, `session` row).

Repair is deferred to M1-A0 (§7).

## 6. Correction to Amendment 1

Protocol pin §3.3 (a) states: "the remaining window is closed by (b), which never reclaims a lock whose pid is live". That holds only inside the §1 envelope and outside the race below. The documented residuals are:

- **Cross-namespace reclaim.** See §1.
- **Three-engine reclaim race** (`packages/engine/src/lock.ts:205-237`, `reclaimIfUnchanged`). The sequence:
  1. R1 reclaims a dead lock and creates its own live lock.
  2. R2 judged the same dead lock earlier. Its rename now moves **R1's live lock** aside.
  3. R3 creates a new lock at the path before R2 links the moved file back.
  4. R2's link-back fails with `EEXIST`, so R1's lock is left at `sessions/<threadId>.lock.reclaim-<token>`.
  5. R1 and R3 both believe they hold the thread.

  Under §2, R1's next append fails `-32009`, because its token is no longer at the lock path, so the chain does not fork. A window remains between the §2 check and the write, because POSIX has no compare-and-append.
- **Doctor duty.** Doctor reports orphaned `*.lock.reclaim-*` and `*.lock.tmp-*` files (WARN). Nothing ever deletes them automatically.

## 7. Deferred to M1-A0 (new `PIN-madc-M1-*` files)

- **Namespace-proof lock liveness.** A lease or heartbeat, and host, boot id and PID-namespace fields in a lock body v2.
- **Torn-tail repair.** An explicit operator command, never automatic. The torn bytes are quarantined with their sha256, and a chained recovery event is appended (a new JSONL type).
- **`ThreadStatus "closed"`.** It is **reserved** and M0 engines never produce it; M1 pins its semantics. Clients print any status string verbatim and do not branch on `closed`.
- **Size bound** on session verification reads.

## 8. Acceptance: Hephaestus A4 follow-up "session integrity" (Node 22.19 and Bun)

1. **Stale-writer re-take.** Lock file unlinked while engine A is alive → engine B resumes and appends → A's next `turn/start` reloads from disk (§3). The chain verifies with continuous `seq`, and A's turn completes.
2. **Foreign owner mid-turn.** A's turn is in progress; the lock body is rewritten to a dead pid with its format preserved; B resumes and appends. A's next append fails `-32009`, the turn ends `failed`, and the file still verifies with no fork. Also run a real `unshare -Urpf` variant where the platform allows it; otherwise skip it with a logged reason.
3. **Position.** An external append between two of A's appends → A's next append fails `-32009` and writes nothing.
4. **fsync.** A test seam proves one fsync per append batch and one `sessions/` directory fsync on create. An injected fsync failure gives `-32009` and a rollback to the prior size.
5. **Torn tail.** A half-written last line and a NUL-filled tail each classify as torn tail; a mid-file edit classifies as an integrity failure. Resume stays `-32603`, and the file's sha256 is unchanged.
6. **Three-engine race.** A test seam reproduces the orphaned `.lock.reclaim-*`. The displaced holder's next append fails `-32009`, and the chain verifies.
7. **Mutations.** Every new check has a mutation that the tests kill.
8. **No contract change.** No change to the lock body, protocol, error codes or JSONL types. The PR description references this pin; any deviation needs a Founder note.

*End of Amendment 2.*
