# PIN: M0 CLI pin, Erratum 1 (`locks` row start-time rule, pointer placement, interpretations for Founder confirmation, one-shot close exit, unknown notifications, exit precedence, turn idle deadline)

*Surface Architect · 2026-09-25 (rev. 2026-09-26) · Venue: `MADVenturesLLC/MADC` · Status: **build pin erratum** to `PIN-madc-M0-cli.md` (Act M0-A7). Docs only. §1, §1a, §2 and §3a–§3d take effect when the Founder merges this file; §3 takes effect row by row as the Founder marks it. §3b and §3c need a CLI code act (the A7 follow-up); §3a and §3d record main's behaviour and add tests.*

**Authority:**

- `docs/plan/PIN-madc-M0-cli.md` (build pin for Act M0-A7, merged via PR #16), read at `main` @ `343da29124f0aea74cbef120fd254f214e64ab00` (PR #19 merge; its head `b6ff3f5` has the same tree). `CLI:n` below means that file at `343da29`.
- `docs/plan/PIN-madc-M0-protocol-messages.md` (`PROTO:n`), `docs/plan/PIN-madc-M0-seat-format.md` (frozen) and `docs/plan/PIN-madc-M0-amendment-2-session-integrity.md` (M0 Amendment 2), read at the same commit. No docs changed on `main` between `c55e4ba` and `343da29`.
- Code citations (`oneshot.ts:n` etc.) are `packages/cli/src/*` and `packages/engine/src/*` at `343da29`.
- `docs/plan/README.md` status-keyed edit rule (PR #16): accepted and frozen docs change only by one `Amended by <file>` pointer line directly under the status line; errata are new files.
- Findings: Copilot Medium [r4107161992](https://github.com/MADVenturesLLC/MADC/pull/16#discussion_r4107161992) and Copilot Low [r4107162048](https://github.com/MADVenturesLLC/MADC/pull/16#discussion_r4107162048) on PR #16, both merged with no reply (ledger D-154, D-155); Argus post-merge review of PR #19 (`/workspace/madc-reviews/pr-19.md`, F4, F5); Argus pre-check of this erratum at `0950b0c` (`/workspace/madc-reviews/precheck-cli-erratum-1-0950b0c.md`, H1–H3, M1–M10, L1–L10, I1–I5).

**Scope.** This erratum:

- corrects the CLI pin's `locks` row (§1 start-time rule, §1a orphan-name redaction);
- fixes pointer placement (§2);
- lists builder interpretations for the Founder to accept or reject (§3);
- rules on the one-shot (CLI §2) and exit codes (CLI §4) in §3a–§3d.

It adds **no** protocol method, notification, error code, lock body field, seat field, JSONL event type, doctor row or exit code. It **adds** one environment variable, `MADC_TURN_IDLE_MS` (§3c), read only by the one-shot, and new exit-3 conditions inside the existing exit-3 class (CLI:189). Where this file and `PIN-madc-M0-cli.md` disagree, this file wins for the `locks` row (§1, §1a), for the one-shot flow and output in CLI §2 (§3a–§3d), and for exit-code precedence in CLI §4 (§3a, §3d). Everything else in the CLI pin stands.

**Who decided what.**

| Section | Decided by |
| --- | --- |
| §1, §1a, §2 | Surface correction (D-154, D-155; §1 matches the Founder correction recorded as D-185) |
| §3 rows | Founder, row by row (column blank on purpose) |
| §3a | Founder: Option A (as relayed by the planner on 2026-09-26; ledger id pending (Clio)) |
| §3b | Surface ruling |
| §3c | Surface ruling; the 600 000 ms default is the Founder's choice (PR Issues room, 2026-09-26 5:09 AM Nassau; ledger id pending (Clio)) |
| §3d | Surface clarification of main's existing ladder (Argus pr-19.md F5; ledger D-187 for the 5-over-4 part) |

---

## 1. `locks` row: start-time rule (D-154, fixes r4107161992)

**What was wrong.** The CLI pin §3 `locks` row (CLI:130) says a lock passes when "its `/proc/<pid>/stat` start time is not later than the lock's `startedAt` + 2 s". Field 22 of `/proc/<pid>/stat` (`starttime`) is clock ticks since boot. The lock's `startedAt` is Unix milliseconds (`Date.now()`). Comparing them directly is meaningless.

**Corrected rule (Linux only; everywhere else the row uses liveness alone):**

1. **Read `starttime`.** Take field 22 of `/proc/<pid>/stat`, counting fields after the **last** `)` so a `comm` that contains spaces or parentheses cannot shift the count. It is clock ticks since boot.
2. **Read boot time.** Take `btime` (Unix seconds) from the `btime` line of `/proc/stat`.
3. **Convert.** `startMs = btime * 1000 + ticks * 1000 / USER_HZ`, with **`USER_HZ` assumed to be 100** (D-172, D-185). Node has no `sysconf(_SC_CLK_TCK)`; 100 is the Linux userspace ABI value on the supported platforms.
4. **Compare.** WARN `pid <n> started after the lock: pid reused or foreign` **only if `startMs > startedAt + 2000`**. The 2 s slack absorbs `btime` rounding and tick granularity.
5. **Skip, never FAIL.** If `/proc/<pid>/stat` or `/proc/stat` is unreadable, or `starttime` or `btime` does not parse as a non-negative decimal integer, or the lock's `startedAt` is not a number, the reuse check is **skipped** and the row reports liveness only. A skipped check never produces FAIL and never on its own produces WARN. ("A number" matches main: `lock.ts:140-141` accepts any finite number, `doctor.ts:654` any number; JSON cannot carry a non-finite one. This is not a tightening.)

Everything else in the `locks` row is unchanged: it is a read-only survey, it never reclaims, deletes or opens a lock for writing, it never prints the token, and the `not visible` and `orphaned` WARNs stand as written.

Main at `343da29` already implements this: `doctor.ts:57-58` (`USER_HZ = 100`, `LOCK_START_SLACK_MS = 2_000`), `procStartMs` `doctor.ts:519-527` (last `)` at :520, field 22 at :523, `btime` at :524, digit-only parse at :525, the formula at :526) and `startedAfterLock` `doctor.ts:533-537` (strict `>`).

**Acceptance addition (CLI pin §7 item 3a):** a pure-function unit test on fixed `/proc` fixtures covers the conversion, the exact 2 s boundary (`startedAt + 2000` passes, `startedAt + 2001` warns), a `comm` with spaces and parentheses, parse failures and every skip case. A mutation that compares ticks as milliseconds, and one that drops the 2 s slack, must each be killed. (Argus pr-19.md F3: the existing e2e test does not guard the tick conversion.)

### 1a. Orphan file names are printed redacted (found while drafting; Founder may strike)

The same row says WARN `orphaned <file>` for each `*.lock.reclaim-*` / `*.lock.tmp-*`. Those suffixes are lock tokens (PROTO:86: `sessions/<threadId>.lock.reclaim-<reclaimer token>`), so printing `<file>` verbatim contradicts "never prints the token" in the same row and CLI:219. Corrected: print `<threadId>.lock.reclaim-<redacted>` / `<threadId>.lock.tmp-<redacted>` in human and `--json` output alike. The WARN itself is unchanged. (Copilot [r4107601226](https://github.com/MADVenturesLLC/MADC/pull/18#discussion_r4107601226) raised this against the PR #18 code; main already redacts: `doctor.ts:558-560`, used at `:611-612`.)

## 2. Pointer placement (D-155, fixes r4107162048)

The README rule puts the `Amended by` pointer **directly under the status line**. This erratum's PR:

- moves the Amendment 2 pointer in `PIN-madc-M0-protocol-messages.md` (PROTO:7) from below the Amendment 1 line (PROTO:5) to directly under the status line (the Amendment 1 line, which predates the rule, now follows it). Text unchanged; only its position.
- leaves `PIN-madc-M0-seat-format.md` unchanged: its pointer is already directly under the status line.
- adds one pointer to this file directly under the status line of `PIN-madc-M0-cli.md`.

No other byte of those three files changes.

## 3. Interpretations for Founder confirmation

Each row is a builder interpretation adopted by merge and never explicitly confirmed. "Surface reading" says whether it matches the pins on `main` @ `343da29` and cites the section. The Founder column is blank on purpose: write **accept** or **reject** (with a note) per row. A rejected row needs a follow-up pin change or code act; an accepted row becomes pinned behaviour.

Wording is the ledger's (`/workspace/madc-ledger/LEDGER.md`), which follows the PR descriptions.

**D-168..D-174 were re-verified on 2026-09-26 against PR #19's merged head `b6ff3f5`** (read at `main` `343da29`, whose tree is identical: `git diff b6ff3f5 343da29` is empty). They were first written in PR #18 (merged into a dead branch) and carried by PR #19 as its "Founder notes" 1–7. The ledger marks D-168–D-171 and D-173 resolved by PR #19 and D-172 superseded by D-185; the Founder column still records an explicit accept or reject.

| ID | Source | Interpretation (ledger wording) | Surface reading vs pins on `main` | Founder (accept / reject) |
| --- | --- | --- | --- | --- |
| D-160 | [PR #17](https://github.com/MADVenturesLLC/MADC/pull/17) Founder notes 1 | Amendment 2 follow-up: `#ensureLock` answers `-32004` (activeTurnId = the running turn) instead of re-taking when this process still has a turn in progress on the thread; that turn's next append fails `-32009` (§2). Only reachable via warm `thread/resume` mid-turn. | **Matches.** Protocol pin §3.3 and §4.1 define `-32004 TurnAlreadyActive` for a thread with an `inProgress` turn, with `activeTurnId`. Amendment 2 §3 requires a reload before any append after a re-take; refusing the re-take while the process's own turn runs avoids discarding a live writer mid-turn, and Amendment 2 §2 still stops that turn's next stale append. No new code or shape. | |
| D-161 | [PR #17](https://github.com/MADVenturesLLC/MADC/pull/17) Founder notes 2 | After a re-take whose reload fails, the thread is no longer loaded in this process, so a later `turn/start` answers `-32002` (a `thread/resume` goes through the normal cold path). The pin says "discard"; this is that, observable. | **Matches.** Amendment 2 §3 steps 1–2 (discard, then fail exactly as a cold resume: `-32603`, lock released). Protocol pin §4.1 gives `-32002 ThreadNotFound` for `turn/start` on a thread the engine does not have. | |
| D-162 | [PR #17](https://github.com/MADVenturesLLC/MADC/pull/17) Founder notes 3 | Preflight re-runs after a reload (`turn/start`), against the seat the reload loaded from disk. | **Matches.** Amendment 2 §3 step 2 reloads through the cold-resume path, which re-loads the seat (A4 interpretation 7, D-111); protocol pin §4.2 runs preflight inside `turn/start`. Note for the Founder: an edited seat file therefore takes effect at a re-take, not only at `thread/start` / cold `thread/resume` (refines D-108). | |
| D-163 | [PR #17](https://github.com/MADVenturesLLC/MADC/pull/17) Founder notes 4 | Empty (0-byte) session file = `integrity`: §5 requires non-empty bytes after the last `\n` for torn tail. A fragment-only file (no complete line) is `torn-tail`. | **Matches the text** of Amendment 2 §5 (torn tail needs non-empty bytes after the last `\n`; zero complete lines verify vacuously) and seat pin §4.1 (`session.open` must be line 1). Note for the Founder: a crash between the exclusive create and the first append can leave a 0-byte file, which is crash residue but reports as `integrity`. **Superseded in its empty-file half by Amendment 3 item 2** (`PIN-madc-M0-amendment-3.md` §2, PR #20, Proposed): a 0-byte file and a NUL/whitespace-only tail become `torn-tail`; the fragment-only half of this row is unchanged. If Amendment 3 merges, mark this row rejected (empty-file half) and accepted (fragment-only half). | |
| D-164 | [PR #17](https://github.com/MADVenturesLLC/MADC/pull/17) Founder notes 5 | Directory fsync happens right after the O_EXCL create, before `session.open` is appended (and fsynced); both precede the `thread/start` response. | **Matches.** Amendment 2 §4 ("after creating a session file, `fsync` the `sessions/` directory"; every append fsynced before it counts or is exposed). The pin does not order the two further; this order is the stricter one. | |
| D-168 | [PR #18](https://github.com/MADVenturesLLC/MADC/pull/18) / [PR #19](https://github.com/MADVenturesLLC/MADC/pull/19) Founder notes 1 | A turn that ends `failed` with a known code the pin leaves unclassed (e.g. `-32603` agent failure) exits **1** (turn failure). Unknown codes always exit 3. | **Matches; verified at `b6ff3f5`.** `classifyCode(code, "turn")` returns the turn class (exit 1) for known unclassed codes (`exit-codes.ts:37`, `:39-48`; `-32602` at the turn site too, `:50`) and the engine class (exit 3) for unknown codes (`:59-60`); used at `oneshot.ts:485-489`. CLI:187 ("non-classed error" → 1), CLI:189 ("any other engine error code, including unknown codes" → 3). | |
| D-169 | PR #18 / PR #19 Founder notes 2 | A session file that is missing or unreadable after the turn is reported as `chain FAILED` (exit 5), not "unverified". | **Consistent (stricter); verified at `b6ff3f5`, with the precedence §3d records.** `verifyThread` returns `chain: "failed"` whenever `verifySessionFile` fails, a missing file included (`oneshot.ts:605-609`). That becomes exit 5 **only when the exit so far is 0, 1 or 4** (`:532-543`, D-187); a 2 or 3 is kept, and a signal wins (`:545-553`). The receipt always prints the `chain FAILED line N: <reason>` line (`:656-657`). CLI:79 allows `chain FAILED` (exit 5) or `UNVERIFIED`; it is silent on a missing file, and fail-closed is the better reading. | |
| D-170 | PR #18 / PR #19 Founder notes 3 | If `turn/start` is refused, the receipt prints the turn as `NOT STARTED`, and `session.chain` is `unverified` with reason `no turn was started`. `session.reason` also appears for `unverified` in `--json`. | **Consistent, one additive key; verified at `b6ff3f5`.** Receipt `NOT STARTED` at `oneshot.ts:642-643`; `unverified` with reason `no turn was started` at `:616-617`, carried into `--json` `session` (`:576`). A file that fails verification still reports `failed` first (`:608-609`). CLI:65 prints the receipt at every exit after `thread/start`; `NOT STARTED` is a display word, not a `TurnStatus`. `session.reason` on `unverified` is a key the CLI:102 JSON shape lists only for `failed`; accepting this row pins it. | |
| D-171 | PR #18 / PR #19 Founder notes 4 | The engine's stderr is `inherit` (per pin), so engine logs can appear on stderr even in `--json` mode. stdout carries only the JSON object. | **Pin is internally inconsistent; the builder followed the stricter line; verified at `b6ff3f5`.** `spawnEngine` uses stdio `["pipe","pipe","inherit"]` (`client.ts:229`, as CLI:46 pins). In `--json` mode the CLI writes one object to stdout and returns without writing to stderr (`oneshot.ts:562-580`). CLI:63 says `--json` stderr carries "nothing but fatal diagnostics"; Surface reads that as covering the CLI's own writes. Accepting this row records that reading. | |
| D-172 | PR #18 Founder notes 5 (PR #19 note 5: superseded) | The reused-pid check reads `/proc/<pid>/stat` start time assuming USER_HZ = 100, with 2 s slack (Linux only; elsewhere liveness alone). | **Superseded by §1 of this erratum (ledger D-185); verified at `b6ff3f5`:** `procStartMs` and `startedAfterLock` implement §1 exactly (`doctor.ts:57-58`, `:519-527`, `:533-537`). Accepting this erratum resolves the row. | |
| D-173 | PR #18 / PR #19 Founder notes 6 | No `@madc/engine` dependency was added to `packages/cli/package.json` (no dependency changes). It resolves via the npm workspace, as the existing `@madc/core` import does. | **Matches; verified at `b6ff3f5`.** `packages/cli/package.json` lists only `"@madc/core": "*"`. CLI:199 fixes the import boundary and asks for no manifest change; CLI:31 says the parser adds no dependency. | |
| D-174 | PR #18 / PR #19 Founder notes 7 | Invalid `MADC_HOME` (relative, an existing non-directory, or a dangling symlink; a symlink to a directory is fine) → exit 2 before anything spawns (doctor's `engine` row SKIPs). | **Extends the pin; needs a decision; behaviour verified at `b6ff3f5`.** One-shot: `main.ts:64-83` (resolver error, non-directory at :74-75, dangling symlink at :80-81) → `usageFailure`, exit 2, nothing spawned. Doctor: `doctor.ts:253-277` classifies the same three as `invalid`; the `engine` row SKIPs (`:872`) and doctor exits 2 (`:883`). CLI:39 and CLI:188 pin exit 2 only for "set but not absolute"; the two extra cases are additive and fail-closed. The `engine` row SKIP is not one of that row's outcomes in CLI §3. | |

## 3a. Exit code when a turn outcome is followed by a non-zero engine exit at close (Founder: Option A; ledger id pending (Clio))

**Source.** Copilot [r4107601276](https://github.com/MADVenturesLLC/MADC/pull/18#discussion_r4107601276) on PR #18 and its fix `b0cedc2` in PR #19 (mutation M108). CLI §4 names the classes but gives no precedence for this case. **Ruling (records main at `343da29`):**

1. **Base exit.** The turn outcome is authoritative once `turn/completed` for this turn id has arrived (CLI:55, "Authority of data"). It sets the base exit (`oneshot.ts:480-499`): `completed` → 0; `failed` → `classifyCode(code, "turn")` (2 for `-32005`/`-32006`, 4 for `-32007`/`-32008`, 5 for `-32009`, 1 for a known unclassed code or no code, 3 for an unknown code); `interrupted` → 1; any other status → 3. An error before or instead of a turn outcome (an RPC error, an early engine exit, a timeout, a protocol violation) sets the base first, and the turn mapping is then skipped (`:482`).
2. **Close.** A non-zero engine exit after the CLI's EOF (CLI:51, step 6) is not the exit-3 source "unexpected engine exit" (that covers the engine dying before the terminal response). It changes **only a base of 0** to 3, and only when no signal was received (`oneshot.ts:502`): an exit code `n` gives the message `engine exited with code <n> after the turn` (`:508`); an engine that had to be killed at close gives `engine did not exit after stdin closed (killed)` (`:506-507`). A base of 1, 2, 3, 4 or 5 is kept, and nothing about the close is printed for them.
3. **Evidence.** The engine's exit code at close is printed only in the base-0 case above (the message becomes the receipt's `error` line). No extra line is required in M0 (CLI:16, "every status the CLI prints is bound to evidence").
4. **Chain verify.** A post-turn chain verify `failed` then gives 5, outranking 1 and 4 (`oneshot.ts:532-543`, D-187). §3d writes down the full ladder.

**Tests.** Existing at `343da29` (stays): a completed turn followed by a non-zero engine exit at close gives exit 3, class `engine`, turn status printed verbatim (`cli.test.ts:1036-1058`, fake scenario `exit-nonzero`). New in the code act (Argus pre-check I5 confirms these expectations match `oneshot.ts:482-510`; no test covers them yet): (a) a failed turn with `-32603` followed by engine exit 1 at close gives exit 1; (b) a failed turn with `-32008` `no-credentials` followed by engine exit 1 at close gives exit 4; (c) a completed turn whose engine must be killed at close gives exit 3 with the `:506-507` message. Mutation checks: applying the close rule to every base breaks (a) and (b); dropping the kill branch breaks (c).

## 3b. Notifications, responses and shape checks while the one-shot runs (Surface ruling)

**Source.** The engine-side mirror is A2 interpretation 5 (D-035: the engine ignores unknown notifications). The CLI-side question has no GitHub or ledger source; ledger id pending (Clio).

**Listed notifications** are exactly the six the protocol pin defines: `thread/started` (PROTO:68), `turn/started` and `turn/completed` (PROTO:78-79), `item/started`, `item/completed` and `item/agentMessage/delta` (PROTO:94-96). "Valid JSON-RPC" means the PROTO:25 shapes: a response `{ id, result }` or `{ id, error }`, or a notification `{ method, params }` with no `id` (the `jsonrpc` field is optional, PROTO:26).

**Ruling.**

1. **Unknown notification.** A notification (`method` string, no `id`) whose method is not one of the six **MUST be ignored**: no exit, no stdout output, and no change to any state the CLI tracks. The engine client's own message log (`client.ts:122`, scanned by `waitFor` at `:166`) is exempt; recording a message there is not a state change. Ignoring it **MUST NOT** extend or reset any timeout: the request timeout keeps its original deadline, and the §3c idle clock is neither reset nor extended.
2. **Every protocol-violation check in the CLI at `343da29` stays exit 3.** Non-exhaustive list: a non-JSON line and a JSON line that is not an object (`client.ts:111-119`, polled at `oneshot.ts:266-273`, overriding at `:513-519`); `protocolVersion` mismatch (`oneshot.ts:297-299`, CLI:47); `thread/start` id grammar (`:313-318`); `turn/start` result shape and "just started" (`:389-403`); malformed or foreign-thread/turn deltas and items (`:328-346`, `:352-363`, `:406-412`, `:446`); `turn/completed` must be this turn (`:436`, `:445`); duplicate or disagreeing `servedModel` (`:441-444`).
3. **NEW exit-3 checks** (main does not do these today; each needs the CLI code act, a test and a killed mutation, below):
   - **(N1) Unmatched response: not an exit-3 check in M0 (residual).** A message with an `id` and no `method` whose `id` is not a request this CLI sent and still awaits. The CLI cannot tell this today: the pending-id map is private to the engine client (`packages/engine/src/client.ts:67`, matched at `:123-129`), and CLI:201-204 allows no change in `packages/engine` beyond the read-only `sdk.ts` re-exports. So in M0 an unmatched response **MUST be ignored** exactly as in rule 1: no exit, no stdout, and it **MUST NOT** reset or extend the request timeout or the §3c idle clock. It therefore cannot cause a hang; the wait it sits in still ends on its own deadline (exit 3). Detecting it needs a read-only engine-client accessor, which is a separate Founder allowance and is recorded as a follow-up, not built here.
   - **(N2) Message with both an `id` and a `method`.** The protocol has no server-to-client requests, so any such object is a violation. The CLI detects it by scanning the client's public message log (`client.ts:61`, pushed at `:122`) the way it already polls `protocolViolations` (`oneshot.ts:266-273`); no engine change.
   - **(N3) No method, no id.** An object with neither a `method` string nor an `id`.
   - **(N4) Other non-JSON-RPC objects.** Any other object that is not one of the PROTO:25 shapes (for example `method` present but not a string, or both `result` and `error`).
   - **(N5) Shape checks on `thread/started`, `turn/started` and `item/started`** (main never inspects them; it checks only deltas, `item/completed` and `turn/completed`, `oneshot.ts:323-375`):
     - `thread/started`: `params.thread` is an object whose `id` equals this connection's thread id.
     - `turn/started`: `params.turn` passes the existing `isTurnShape` (`oneshot.ts:125`) with `threadId` equal to this thread; its `id` is bound to this turn's id when that is known, and checked when `turn/start` answers if it arrived first (as items are at `:406-412`).
     - `item/started`: the same envelope and item checks as `item/completed` (`:352-363`), bound to this turn the same way.
   - **(N6) D-188 fix.** The item shape check (`isItemShape`, `oneshot.ts:95-116`) requires a `servedModel` item's `backing` to be one of PROTO:220's three values, `"kimi-code" | "claude-code" | "codex"` (main accepts any string, `:111`). This applies to `item/started`, `item/completed` and the `turn/completed` snapshot. **This is the fix for D-188 (Copilot High r4110012309), carried by the A7 follow-up**; it is not a waiver.
4. **Where.** These checks live in `packages/cli` (CLI:199-206 allows no engine behaviour change). N2–N6 need only the public message log and the CLI's own state. Each ends the wait at once as a protocol violation (exit 3), the way `violate()` does today (`oneshot.ts:178-192`), never a later hang.

**Tests** (each kills the mutation named):

- One unknown notification between `turn/started` and `turn/completed`: exit code and stdout equal those of the same run without it. *Mutation:* treat an unknown method as exit 3.
- Only unknown notifications while `initialize`, `thread/start` or `turn/start` is pending: the request timeout fires on its original deadline (with an injected short timeout, §3c rule 6). *Mutation:* reset the timeout on any inbound message.
- N1: while `turn/start` is pending (injected short request timeout), a response with an id the CLI never used arrives every 100 ms; the request timeout still fires on its original deadline and exits 3. During the turn, the same stream does not delay the §3c idle deadline. *Mutation:* treat any inbound message as activity.
- N2: `{ id: 99, method: "server/ask" }` → exit 3. *Mutation:* ignore messages with an id and a method.
- N3: `{ params: {} }` → exit 3. *Mutation:* ignore objects with no method and no id.
- N4: `{ method: 7 }` and `{ id: 1, result: {}, error: {…} }` → exit 3. *Mutation:* accept any object with a `method` key.
- N5: one malformed `thread/started`, one `turn/started` for another thread, one `item/started` with item id `../x` → exit 3 each. *Mutation:* remove each shape check (three mutations).
- N6: a `servedModel` item with `backing: "ollama-cloud"` in `item/completed` and in the snapshot → exit 3. *Mutation:* accept any string for `backing`.

## 3c. The turn wait gets an idle deadline (Surface ruling; default 600 000 ms, Founder choice)

**Gap.** CLI §2 gives the turn wait no limit (CLI:50, CLI:107-111), and CLI §4 (CLI:189, exit 3 covers "timeouts") names none. Main waits up to `NO_TIMEOUT_MS = 2 147 483 647` ms (about 24.8 days, `oneshot.ts:37`, used at `:375`), then goes down the generic exit-3 path. An engine that stays alive and sends nothing, or sends only unknown notifications (§3b), keeps a non-interactive CLI waiting that long. COPILOT-PATTERNS pattern 1 (a wait needs a timeout or a terminal state; `/workspace/madc-reviews/COPILOT-PATTERNS.md`) applies, so this pins a limit. It is an idle deadline, not a total one, because a legitimate turn can run for many minutes.

**Rule.**

1. **Clock.** A monotonic clock (for example a timer re-armed on activity, or `performance.now()`), never `Date.now()`.
2. **Start, reset, stop.** The idle clock starts when the `turn/start` response has passed its checks (after `oneshot.ts:389-403`, where `turnId` is set at `:404`). Before that only the request timeout (rule 6) applies, so the deadline can never fire before the turn id is known. The clock resets on each **listed** notification (§3b) that passes its shape check, `item/agentMessage/delta` and `item/started` included. It stops when `turn/completed` arrives, when the deadline fires, or when a Ctrl-C grace begins. A listed notification that fails its shape check is a protocol violation (exit 3), not activity. Unknown notifications, stderr output and invalid messages never reset it. The `turn/interrupt` response does not count, because the clock has already stopped.
3. **Default and override.** 600 000 ms. `MADC_TURN_IDLE_MS` overrides it (rule 7).
4. **When the deadline fires,** the CLI records the timeout as the run's error (`{ code: null, message: "timeout: no engine message for <ms> ms", class: "engine" }`, where `<ms>` is the configured value, not the measured one) and then reuses main's first-Ctrl-C path step by step:
   1. send `turn/interrupt` fire-and-forget (`oneshot.ts:423`);
   2. race up to 2 s (`INTERRUPT_GRACE_MS`, `:34`) for `turn/completed`; an engine that exits during the grace is swallowed to "no completed turn" (`:424-429`);
   3. in `finally`, close stdin and kill the engine if it is still running after `KILL_AFTER_MS = 1 000` (`:35`, `:474`);
   4. turn-outcome mapping, the close rule and the protocol overrides (`:480-526`), which do not replace the recorded timeout (§3d tier 2);
   5. re-read and verify the session after the engine has exited (`:528-544`, as CLI:77 requires); the receipt's `session` line prints as usual, `chain FAILED` included;
   6. JSON or text output, then the receipt (`:562-596`).

   Nothing is dropped. **The only step whose behaviour changes is 3:** the condition at `:474` becomes "a signal was received **or** the idle deadline fired", so the timeout path also kills after 1 s instead of `CLOSE_TIMEOUT_MS = 5 000` (`:36`). The other change is the "first recorded cause wins" guard in tier 2 of §3d, so that a later `fail()` (the catch at `:448-466`, the overrides at `:513-526`) does not replace the timeout's message.
5. **Exit and output.** The exit is **3** (§3d tier 2), whatever the turn reports during the grace (`interrupted`, `failed` or `completed`).
   - It outranks chain FAILED 5, and the `chain FAILED` line still prints.
   - A protocol violation or an engine exit during the grace keeps 3 and the timeout's message.
   - A SIGINT or SIGTERM during the timeout grace counts as the **second** signal: immediate force, exit 130 / 143 (the implementation marks the soft interrupt as used when the deadline fires, `:215-230`). If a signal and the deadline land at the same moment, the signal wins.
   - Deltas already streamed stay on stdout. The final text and the receipt follow main's interrupt path unchanged (`:555-596`: a non-TTY run prints the final text if a `turn/completed` arrived during the grace), except that the exit is 3.
   - **`--json`:** one object with `ok: false`, `exitCode: 3`, `turn` as last known with its status verbatim, `session` as verified, and `error` = `{ "code": null, "message": "timeout: no engine message for <ms> ms", "class": "engine" }`. This is main's existing exit-3 error shape (`oneshot.ts:238-241`, `:461-462`, `:562-579`). Nothing is written to stderr: CLI:63 would allow a fatal diagnostic, but the message is already in `error`.
   - **Human mode:** the message appears once on stderr, as the receipt's `error` line (` error    engine: timeout: no engine message for <ms> ms`, `:668-671`). It replaces that line rather than adding a second one.
   - The timeout path returns through `runOneShot`, so `bin.ts:22-27` flushes stdout and stderr before `process.exit` (pattern 10). It never exits from a timer.
6. **Request timeout.** The existing `RESPONSE_TIMEOUT_MS = 30 000` ms (`oneshot.ts:33`) covers `initialize`, `thread/start` and `turn/start` (`:291-296`, `:302-310`, `:383-388`) and is unchanged. It **MUST** become injectable for tests (a test seam in `runOneShot`'s options, not an env var or flag). The idle clock does not run while it applies.
7. **`MADC_TURN_IDLE_MS`.**
   - Read only by the one-shot (`madc -p`). `doctor`, `--version` and `--help` ignore it.
   - Unset or `""` (empty) means the default, matching `MADC_HOME` at `doctor.ts:255`.
   - Otherwise it must match `^[1-9][0-9]*$` and be at most `86400000`. Anything else (`0`, `-5`, `+5`, `0500`, ` 500`, `500 `, `1e3`, `500.0`, `0x10`, `abc`, `86400001`) is a usage error, **exit 2 before anything spawns**. It is checked right after the `MADC_HOME` checks (`main.ts:64-83`) and before the prompt is read (`:84-94`), so an invalid `MADC_HOME` is reported first.
   - Message (human, stderr): `madc: MADC_TURN_IDLE_MS must be an integer from 1 to 86400000 (milliseconds)`. The value itself is never echoed (CLI:105: no env values on stderr or in JSON).
   - `--json`: `usageFailure`'s shape (`main.ts:35-55`): `{ "ok": false, "exitCode": 2, "madcVersion": …, "protocolVersion": "madc-m0/1", "seatId": null, "threadId": null, "turn": null, "text": "", "servedModel": null, "session": null, "error": { "code": null, "message": "MADC_TURN_IDLE_MS must be an integer from 1 to 86400000 (milliseconds)", "class": "usage" } }`.

**Tests** (fake engines as in `packages/cli/src/testing/`; each kills the mutation named):

1. `MADC_TURN_IDLE_MS=500`; the fake sends `turn/started` and then nothing → exit 3, message `timeout: no engine message for 500 ms` once on stderr (receipt `error` line), **no exit before 500 ms** (lower bound) and exit within 500 + 2 000 + 1 000 ms plus 1 s slack. *Mutations:* remove the deadline (hang, killed by the harness cap); fire immediately or measure from spawn (killed by the lower bound); exit 130 instead of 3.
2. The same, with only unknown notifications every 100 ms → exit 3 on the original deadline. *Mutation:* count unknown notifications as activity.
3. A listed delta every 300 ms for 2 s, then `turn/completed` `completed` → exit 0. *Mutation:* measure from turn start instead of the last activity.
4. `item/started` every 300 ms (no deltas) for 2 s, then `turn/completed` → exit 0. *Mutation:* only deltas count.
5. A shape-failing listed notification (for example an `item/started` for another turn) followed by silence → exit 3 with the protocol-violation message, promptly and not on the idle deadline. *Mutation:* treat a shape-failing notification as activity (or ignore it).
6. **Turn outcome must not win:** on `turn/interrupt` the fake answers `turn/completed` `completed` during the grace → exit 3; the same with `failed` `-32008` → exit 3. *Mutation:* map the grace outcome as for a user interrupt (exit 0 / 4).
7. **Interrupt sent:** the fake records that it received `turn/interrupt` after the deadline. *Mutation:* skip the interrupt.
8. **Engine ignores the interrupt and never exits:** it is killed after 1 s; total time is at most deadline + 2 000 + 1 000 ms + 1 s slack. *Mutations:* no kill; the 5 s close timeout (condition at `:474` unchanged).
9. **SIGINT / SIGTERM during the timeout grace** → 130 / 143 immediately. *Mutation:* the first SIGINT after the deadline starts a new soft interrupt.
10. **`--json` on timeout** → exactly one object with `exitCode: 3`, `ok: false` and the `error` object above, and nothing on stderr from the CLI. *Mutation:* print the timeout line to stderr in `--json` mode.
11. **3 beats 5 on timeout:** a timeout run whose session file is removed → exit 3, `chain FAILED` printed. *Mutation:* let chain FAILED upgrade 3.
12. **Idle clock not before `turn/start` answers:** `MADC_TURN_IDLE_MS=1`, and the fake delays the `turn/start` response by 300 ms, then streams and completes → exit 0. *Mutation:* start the clock before the `turn/start` response.
13. **Env forms:** `86400000` accepted (with the idle clock injected so the test is fast); `86400001`, `0`, `-5`, `+5`, `0500`, ` 500`, `500 `, `1e3`, `500.0`, `0x10`, `abc` → exit 2, nothing spawned, the exact message, and the `--json` shape above; `""` behaves as unset (the default applies); `doctor` and `--version` with `MADC_TURN_IDLE_MS=abc` exit as without it. *Mutations:* `Number(v) > 0` instead of the regex; `<` instead of `≤` 86 400 000; validate in `doctor`.
14. **Default:** with the variable unset, the configured deadline is 600 000 ms (asserted through the test seam, not by waiting). *Mutation:* a different default.
15. **Request timeout injectable:** with the seam set to 200 ms, a fake that never answers `thread/start` → exit 3 (`timeout 200ms`, `io.ts:51`). *Mutation:* ignore the seam (fixed 30 000 ms).

## 3d. Exit precedence (clarification of CLI §4, CLI:189; records main)

CLI §4 (CLI:184-195) gives classes but no precedence when two apply. Main applies them in this order (`oneshot.ts`, in source order: turn outcome `:480-499`; close rule `:502-510`; protocol-violation overrides `:513-526`; chain verify `:532-543`, which upgrades only 0, 1 or 4 to 5 at `:534-537`; signal `:545-553`). The effective ladder, highest first:

1. **Signal:** 130 (SIGINT) / 143 (SIGTERM).
2. **3 (engine / protocol).** Within this tier the §3c idle timeout comes first: once recorded, its message is kept even if another exit-3 cause follows (a protocol violation, an engine exit, a kill at close). Other exit-3 causes (spawn failure, unexpected engine exit, `protocolVersion` mismatch, protocol violations, request timeouts, unknown codes, a non-zero exit at close after a completed turn) follow.
3. **5 (session):** `-32009` as a turn error, or a post-turn chain verify `failed`.
4. **4 (provider):** `-32007` / `-32008`.
5. **1 (turn failure):** a known unclassed code, a failed turn with no code, or `interrupted`.
6. **0 (ok).**

In one line: **signal (130/143) > 3 > 5 > 4 > 1 > 0**, with the idle timeout first inside tier 3.

A turn-level **2** (`-32005`/`-32006` as `turn.error.code`) is left as 2: a chain FAILED does not replace it (`:536`). In main, 4 and 1 never compete in one run; "4 before 1" means a provider code in a failed turn gives 4, never 1 (`exit-codes.ts:54-56`). 3 beating 5 comes from `:534-537` not upgrading 3. Argus pr-19.md F5 found no test for it.

**Tests:** (a) **3 beats 5:** a turn whose run has a protocol violation (a non-JSON line) and whose session file is then removed → exit 3, `chain FAILED` still printed. *Mutation:* add `EXIT.engine` to the upgrade set at `:536`. (b) **4 beats 1:** a failed turn with `-32008` → 4, not 1. *Mutation:* classify turn-site provider codes as the turn class. (c) 5 beats 4 (existing: `cli.test.ts:1000-1023`, M153). (d) Turn-level 2 plus a removed session file → 2. *Mutation:* add `EXIT.usage` to the upgrade set. (e) **Signal beats 3:** SIGINT during a run that has already recorded a protocol violation → 130, class `interrupted`. *Mutation:* move the signal block (`:545-553`) above the protocol overrides. Existing §4 signal tests (`cli.test.ts:~756`) cover a signal alone, not this pairing.

## 4. Not changed here

- The check-then-write window in Amendment 2 §2/§6 (Copilot High [r4107161928](https://github.com/MADVenturesLLC/MADC/pull/16#discussion_r4107161928), ledger D-153) still needs a fix or a Founder-named waiver under `docs/policy/CODE-ADVISORIES.md`. This erratum does not waive it.
- Lease/heartbeat liveness and torn-tail repair stay deferred to M1-A0 (Amendment 2 §7).
- Argus pr-19.md F4 (three `turn/start` shape sub-checks with no killing test) is for the A7 follow-up; §3b rule 2 keeps those checks at exit 3.

*End of Erratum 1.*
