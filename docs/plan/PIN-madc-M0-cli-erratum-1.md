# PIN: M0 CLI pin, Erratum 1 (`locks` row start-time rule, pointer placement, interpretations for Founder confirmation)

*Surface Architect · 2026-09-25 · Venue: `MADVenturesLLC/MADC` · Status: **build pin erratum** to `PIN-madc-M0-cli.md` (Act M0-A7). Docs only. Takes effect when the Founder merges it; §3 takes effect row by row as the Founder marks it.*

**Authority:**

- `docs/plan/PIN-madc-M0-cli.md` (build pin for Act M0-A7, merged via PR #16), read at `main` @ `c55e4ba` (PR #17 merge).
- `docs/plan/PIN-madc-M0-amendment-2-session-integrity.md` (M0 Amendment 2) and `docs/plan/PIN-madc-M0-protocol-messages.md` / `docs/plan/PIN-madc-M0-seat-format.md` (frozen), read at the same commit.
- `docs/plan/README.md` status-keyed edit rule (PR #16): accepted and frozen docs change only by one `Amended by <file>` pointer line directly under the status line; errata are new files.
- Findings: Copilot Medium [r4107161992](https://github.com/MADVenturesLLC/MADC/pull/16#discussion_r4107161992) and Copilot Low [r4107162048](https://github.com/MADVenturesLLC/MADC/pull/16#discussion_r4107162048) on PR #16, both merged with no reply (ledger D-154, D-155).

**Scope.** This erratum corrects the CLI pin's `locks` row (§1 start-time rule, §1a orphan-name redaction), fixes pointer placement (§2) and lists builder interpretations for the Founder to accept or reject (§3). It adds **no** protocol method, notification, error code, lock body field, seat field, JSONL event type, doctor row or exit code. Where this file and `PIN-madc-M0-cli.md` disagree on the `locks` row, this file wins; everything else in the CLI pin stands.

---

## 1. `locks` row: start-time rule (D-154, fixes r4107161992)

**What was wrong.** The CLI pin §3 `locks` row says a lock passes when "its `/proc/<pid>/stat` start time is not later than the lock's `startedAt` + 2 s". Field 22 of `/proc/<pid>/stat` (`starttime`) is clock ticks since boot. The lock's `startedAt` is Unix milliseconds (`Date.now()`). Comparing them directly is meaningless.

**Corrected rule (Linux only; everywhere else the row uses liveness alone):**

1. **Read `starttime`.** Take field 22 of `/proc/<pid>/stat`, counting fields after the **last** `)` so a `comm` that contains spaces or parentheses cannot shift the count. It is clock ticks since boot.
2. **Read boot time.** Take `btime` (Unix seconds) from the `btime` line of `/proc/stat`.
3. **Convert.** `startMs = btime * 1000 + ticks * 1000 / USER_HZ`, with **`USER_HZ` assumed to be 100** (D-172). Node has no `sysconf(_SC_CLK_TCK)`; 100 is the Linux userspace ABI value on the supported platforms.
4. **Compare.** WARN `pid <n> started after the lock: pid reused or foreign` **only if `startMs > startedAt + 2000`**. The 2 s slack absorbs `btime` rounding and tick granularity.
5. **Skip, never FAIL.** If `/proc/<pid>/stat` or `/proc/stat` is unreadable, or any value does not parse as a non-negative integer, or the lock's `startedAt` is not a finite non-negative integer, the reuse check is **skipped** and the row reports liveness only. A skipped check never produces FAIL and never on its own produces WARN.

Everything else in the `locks` row is unchanged: it is a read-only survey, it never reclaims, deletes or opens a lock for writing, it never prints the token, and the `not visible` and `orphaned` WARNs stand as written.

**Acceptance addition (CLI pin §7 item 3a):** a pure-function unit test on fixed `/proc` fixtures covers the conversion, the exact 2 s boundary (`startedAt + 2000` passes, `startedAt + 2001` warns), a `comm` with spaces and parentheses, parse failures and every skip case. A mutation that compares ticks as milliseconds, and one that drops the 2 s slack, must each be killed.

### 1a. Orphan file names are printed redacted (found while drafting; Founder may strike)

The same row says WARN `orphaned <file>` for each `*.lock.reclaim-*` / `*.lock.tmp-*`. Those suffixes are lock tokens (protocol pin §3.3 (b): `sessions/<threadId>.lock.reclaim-<reclaimer token>`), so printing `<file>` verbatim contradicts "never prints the token" in the same row and CLI pin §6. Corrected: print `<threadId>.lock.reclaim-<redacted>` / `<threadId>.lock.tmp-<redacted>` in human and `--json` output alike. The WARN itself is unchanged. (Copilot [r4107601226](https://github.com/MADVenturesLLC/MADC/pull/18#discussion_r4107601226) raised this against the PR #18 code; PR #19 already redacts.)

## 2. Pointer placement (D-155, fixes r4107162048)

The README rule puts the `Amended by` pointer **directly under the status line**. This erratum's PR:

- moves the Amendment 2 pointer in `PIN-madc-M0-protocol-messages.md` from below the Amendment 1 line to directly under the status line (the Amendment 1 line, which predates the rule, now follows it). Text unchanged; only its position.
- leaves `PIN-madc-M0-seat-format.md` unchanged: its pointer is already directly under the status line.
- adds one pointer to this file directly under the status line of `PIN-madc-M0-cli.md`.

No other byte of those three files changes.

## 3. Interpretations for Founder confirmation

Each row is a builder interpretation adopted by merge (or proposed in an open PR) and never explicitly confirmed. "Surface reading" says whether it matches the pins on `main` @ `c55e4ba` and cites the section. The Founder column is blank on purpose: write **accept** or **reject** (with a note) per row. A rejected row needs a follow-up pin change or code act; an accepted row becomes pinned behaviour.

Wording is the ledger's (`/workspace/madc-ledger/LEDGER.md`), which follows the PR descriptions.

**D-168..D-174 come from the A7 CLI and must be re-verified against PR #19's final head before the Founder marks them.** They were first written in PR #18, which merged into a dead branch and never reached `main`. PR #19 (head `81e6424` when this was drafted) carries them as its "Founder notes" 1–7, and its note 5 is marked superseded by §1 above.

| ID | Source | Interpretation (ledger wording) | Surface reading vs pins on `main` | Founder (accept / reject) |
| --- | --- | --- | --- | --- |
| D-160 | [PR #17](https://github.com/MADVenturesLLC/MADC/pull/17) Founder notes 1 | Amendment 2 follow-up: `#ensureLock` answers `-32004` (activeTurnId = the running turn) instead of re-taking when this process still has a turn in progress on the thread; that turn's next append fails `-32009` (§2). Only reachable via warm `thread/resume` mid-turn. | **Matches.** Protocol pin §3.3 and §4.1 define `-32004 TurnAlreadyActive` for a thread with an `inProgress` turn, with `activeTurnId`. Amendment 2 §3 requires a reload before any append after a re-take; refusing the re-take while the process's own turn runs avoids discarding a live writer mid-turn, and Amendment 2 §2 still stops that turn's next stale append. No new code or shape. | |
| D-161 | [PR #17](https://github.com/MADVenturesLLC/MADC/pull/17) Founder notes 2 | After a re-take whose reload fails, the thread is no longer loaded in this process, so a later `turn/start` answers `-32002` (a `thread/resume` goes through the normal cold path). The pin says "discard"; this is that, observable. | **Matches.** Amendment 2 §3 steps 1–2 (discard, then fail exactly as a cold resume: `-32603`, lock released). Protocol pin §4.1 gives `-32002 ThreadNotFound` for `turn/start` on a thread the engine does not have. | |
| D-162 | [PR #17](https://github.com/MADVenturesLLC/MADC/pull/17) Founder notes 3 | Preflight re-runs after a reload (`turn/start`), against the seat the reload loaded from disk. | **Matches.** Amendment 2 §3 step 2 reloads through the cold-resume path, which re-loads the seat (A4 interpretation 7, D-111); protocol pin §4.2 runs preflight inside `turn/start`. Note for the Founder: an edited seat file therefore takes effect at a re-take, not only at `thread/start` / cold `thread/resume` (refines D-108). | |
| D-163 | [PR #17](https://github.com/MADVenturesLLC/MADC/pull/17) Founder notes 4 | Empty (0-byte) session file = `integrity`: §5 requires non-empty bytes after the last `\n` for torn tail. A fragment-only file (no complete line) is `torn-tail`. | **Matches the text** of Amendment 2 §5 (torn tail needs non-empty bytes after the last `\n`; zero complete lines verify vacuously) and seat pin §4.1 (`session.open` must be line 1). Note for the Founder: a crash between the exclusive create and the first append can leave a 0-byte file, which is crash residue but reports as `integrity`. **Superseded by Amendment 3 item 2** (`PIN-madc-M0-amendment-3.md` §2, Proposed): a 0-byte file and a NUL/whitespace-only tail become `torn-tail`; the fragment-only half of this row is unchanged. If Amendment 3 merges, mark this row rejected (empty-file half) and accepted (fragment-only half). | |
| D-164 | [PR #17](https://github.com/MADVenturesLLC/MADC/pull/17) Founder notes 5 | Directory fsync happens right after the O_EXCL create, before `session.open` is appended (and fsynced); both precede the `thread/start` response. | **Matches.** Amendment 2 §4 ("after creating a session file, `fsync` the `sessions/` directory"; every append fsynced before it counts or is exposed). The pin does not order the two further; this order is the stricter one. | |
| D-168 | [PR #18](https://github.com/MADVenturesLLC/MADC/pull/18) / [PR #19](https://github.com/MADVenturesLLC/MADC/pull/19) Founder notes 1 | A turn that ends `failed` with a known code the pin leaves unclassed (e.g. `-32603` agent failure) exits **1** (turn failure). Unknown codes always exit 3. | **Matches.** CLI pin §4: exit 1 = "Turn `failed` with a non-classed error"; exit 3 = "any other engine error code, including unknown codes". Re-verify at #19's final head. | |
| D-169 | PR #18 / PR #19 Founder notes 2 | A session file that is missing or unreadable after the turn is reported as `chain FAILED` (exit 5), not "unverified". | **Consistent (stricter).** CLI pin §2 allows `chain FAILED` (exit 5) or `UNVERIFIED: <why>` and gives "file belongs to another thread" as the `UNVERIFIED` example; it is silent on a missing file. After a turn the engine reported as durable, a missing file is a failed verify (CLI pin §4 exit 5), so fail-closed is the better reading. Re-verify at #19's final head. | |
| D-170 | PR #18 / PR #19 Founder notes 3 | If `turn/start` is refused, the receipt prints the turn as `NOT STARTED`, and `session.chain` is `unverified` with reason `no turn was started`. `session.reason` also appears for `unverified` in `--json`. | **Consistent, one additive key.** CLI pin §2 prints the receipt at every exit after `thread/start` succeeds and allows `unverified`. `NOT STARTED` is a display word, not a `TurnStatus`. `session.reason` on `unverified` is a key the §2 JSON shape does not list (it lists `line` and `reason` only for `failed`); accepting this row pins it. Re-verify at #19's final head. | |
| D-171 | PR #18 / PR #19 Founder notes 4 | The engine's stderr is `inherit` (per pin), so engine logs can appear on stderr even in `--json` mode. stdout carries only the JSON object. | **Pin is internally inconsistent; the builder followed the stricter line.** CLI pin §2 step 1 pins stdio `["pipe","pipe","inherit"]`; the §2 output table says `--json` stderr carries "nothing but fatal diagnostics". Surface reads the table as covering the CLI's own writes. Accepting this row records that reading. Re-verify at #19's final head. | |
| D-172 | PR #18 Founder notes 5 (PR #19 note 5: superseded) | The reused-pid check reads `/proc/<pid>/stat` start time assuming USER_HZ = 100, with 2 s slack (Linux only; elsewhere liveness alone). | **Superseded by §1 of this erratum**, which pins the conversion, the USER_HZ = 100 assumption and the skip rules. Accepting this erratum resolves the row. Re-verify #19's `procStartMs` / `startedAfterLock` against §1 at its final head. | |
| D-173 | PR #18 / PR #19 Founder notes 6 | No `@madc/engine` dependency was added to `packages/cli/package.json` (no dependency changes). It resolves via the npm workspace, as the existing `@madc/core` import does. | **Matches.** CLI pin §5 fixes the import boundary (`@madc/engine/client` plus type-only `@madc/engine`) and does not ask for a manifest change; §1 says the parser adds no new dependency. Re-verify at #19's final head. | |
| D-174 | PR #18 / PR #19 Founder notes 7 | Invalid `MADC_HOME` (relative, an existing non-directory, or a dangling symlink; a symlink to a directory is fine) → exit 2 before anything spawns (doctor's `engine` row SKIPs). | **Extends the pin; needs a decision.** CLI pin §1 and §3 (`home` row) pin exit 2 only for "set but not absolute". Adding "existing non-directory" and "dangling symlink" to the exit-2 class is additive and fail-closed. The `engine` row SKIP is not one of that row's outcomes in CLI pin §3 (PASS or FAIL; it uses a throwaway temp home, so it could still run). Re-verify at #19's final head. | |

## 3a. Exit code when a failed turn is followed by a non-zero engine exit (D-TBD, asked by Hephaestus on #19)

CLI pin §4 names the classes but gives no precedence for this case. The ruling for it:

1. Once `turn/completed` for this turn id has arrived, the turn's terminal outcome is authoritative (CLI pin §2, "Authority of data"). It sets the base exit: 0, 1 (non-classed failure) or the class of `turn.error.code` (4 provider, 5 session).
2. A non-zero engine exit after the CLI's EOF (§2 step 6) is **not** the exit-3 source "unexpected engine exit". That source covers the engine dying before the terminal response. A non-zero exit at close changes only a base of **0** to **3**. A base of 1, 4 or 5 is kept.
3. The engine's exit code at close is evidence (CLI pin §0) and SHOULD appear on stderr (`engine exited <n> at close`). If #19 already prints it, nothing changes. Otherwise the line is additive and does not block M0.
4. The rows above rule only on the close case. Exit 130/143 (interrupted) still takes precedence as CLI pin §2 describes. How a post-turn `chain FAILED` (5) ranks against a failed turn (1/4) is not ruled here. #19's final-head behaviour is recorded as-is, and any change goes into a later amendment.

Test: a failed turn (-32603, and -32008 `no-credentials`) followed by engine exit 1 at close gives exit 1 and 4 respectively. A completed turn followed by engine exit 1 at close gives exit 3.

## 3b. Notifications the pin does not list (asked by Hephaestus on the A7 follow-up)

**Ruling.** A server notification whose `method` is not listed in CLI pin §3 **MUST be ignored**: no exit, no stdout output, and no change to any state the CLI tracks. This keeps an older CLI working when the engine adds a notification.

- Ignoring it **MUST NOT** extend or reset any timeout; the request timeout keeps its original deadline. The turn wait has no timeout by design (it ends on `turn/completed`, engine exit, a protocol violation or a signal), and unknown notifications do not add a terminal condition to it or remove one from it.
- This applies only to an unknown **method name**. A listed notification (for example `thread/started`, `turn/started`, `item/started`, `turn/completed`) that fails its protocol-pin shape check stays a protocol violation (exit 3), as does a message that is not valid JSON-RPC, a response whose `id` matches no pending request, and a notification without a `method` string.
- Test: send one unknown notification between `turn/started` and `turn/completed`. The exit code and stdout are unchanged from the same run without it. Send only unknown notifications while an `initialize` or `turn/start` request is pending: the request timeout fires on its original deadline. Mutations: treat an unknown method as exit 3; reset the timeout on any inbound message. Both must be killed.

## 4. Not changed here

- The check-then-write window in Amendment 2 §2/§6 (Copilot High [r4107161928](https://github.com/MADVenturesLLC/MADC/pull/16#discussion_r4107161928), ledger D-153) still needs a fix or a Founder-named waiver under `docs/policy/CODE-ADVISORIES.md`. This erratum does not waive it.
- Lease/heartbeat liveness and torn-tail repair stay deferred to M1-A0 (Amendment 2 §7).

*End of Erratum 1.*
