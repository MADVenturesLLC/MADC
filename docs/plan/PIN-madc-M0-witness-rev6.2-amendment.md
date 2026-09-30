# PIN (proposed): M0 Witness terminal app — DESIGN-SPEC rev 6.2 amendment

**Status: PROPOSED, pending review.** Drafted 2026-09-28 by the Witness builder act from the
preserved rev 6.2 design source and the architect's continuation plan. It is not an
impersonation of Surface, not a re-issuance of any unavailable historical pin, and it
backfills no approval: every historical ruling the design source reports as relay-only stays
recorded as unverified provenance (§5 below). Nothing here is merged; issuance and merge are
Founder acts.

**Amends (proposed):** `docs/plan/PIN-madc-M0-cli.md` (CLI), CLI Erratum 1 (incl. E17a),
`PLAN-madc-M0-build-plan.md` (M0PLAN), and the M0 runbook — additively, by the rows in §2.
Frozen pin text keeps standing until this amendment is accepted; where code on this branch
already implements a row, the row records that fact, it does not claim acceptance.

## Sources

| What | Where | Verification |
| --- | --- | --- |
| Design source (rev 6.2) | `docs/plan/sources/DESIGN-SPEC-witness-rev6.2.md` | SHA-256 `9b575b87502e5eb60ef61361a2b471815ba50ce917168b7936cd88afc2b462fd`; `cmp`-identical to the supplied file. The document self-describes as "proposal … **not a pin**" and gives pins precedence (its §1). |
| Continuation plan | `~/.codex/visualizations/2026/09/27/01a0e347-9508-7022-a81a-2f5a556c3073/MADC-WITNESS-REV6.2-CONTINUATION.md` | Architect (Codex) handoff under Michael's current direction; defects W-1/W-2/W-3 reproduced there and re-reproduced here as failing tests before their fixes. |
| Frozen contracts | M0 pins CLI/ERR1/PROTO/SEAT, Amendment 2, Amendment 3, E17a | Read on this branch (`87339c7` base). |

**Actual sequence (not the historical PL ordering):** branch
`builder/m0-witness-cli-rev-6-2`, base `87339c7` (M0 Amendment 3), four commits to
`fa163b18f64a8a28083b39b97b6142b44c76bf40`, pushed; draft PR #35 into `main` @ `2e5f068`
(5 commits past the base: M1-A0 #30, M1-A1 #31/#33). `git merge-tree` computes the merge
clean; the two sides touch disjoint files. This continuation's changes are staged for review,
not committed. The historical M-4 position ("new act after the A7 follow-up, before A8") is
superseded by what actually happened: M1 acts merged to `main` while the Witness branch was
in review.

**Scope (explicit):** the three-TTY M0 app is permitted by this work; its turns remain
headless; non-TTY and `--json` bytes are unchanged; the one-shot exit ladder (ERR1 §3d) is
unchanged and scoped to `-p` (E-e); the app's exit rule is rev 6.2 §5.11 with O-1…O-6; the
engine-client change is exactly M-1's narrow stderr allowance (default `inherit` preserved;
`-p` unchanged). Not in scope: new adapters, credential storage, seat switching, resume,
themes, new protocol fields, the desktop UI, and any change to Kimi's M1 work.

## 1. Defects fixed by this continuation (each red → green)

| # | Defect (rev 6.2 clause) | Fix | Regression tests |
| --- | --- | --- | --- |
| W-1 | Banner box capped at 102 cols with a fixed 46-col left column and an untruncated right column overflows its own border at ≥110 cols; the §5.1 `home` field printed only its label, never the path (§§5.1, 9, 14) | `renderBanner` (frames.ts) composes responsively: box fills its region, two columns only when the measured right column fits beside the 46-col left column, stacking otherwise (always below 110); home path + source label with §9 middle-ellipsis; title row closes on the same column as every row | frames.test.ts "W-1 responsive banner geometry" (5 tests: border-fit at 80–200, home path, full v2 policy row, two-column-vs-stacked, §9 order) + ASCII glyph-set geometry test |
| W-2 | Launch doctor kept only counts: PASS/SKIP rows were dropped, FAIL rows never printed under the banner, the pane showed ≤8 WARN/FAIL lines (§§5.1, 5.7) | `DoctorSummary` now retains every row once (`allRows`); `summarizeDoctor` derives counts, banner WARN/FAIL detail and `failAtLaunch` from it; the pane's DOCTOR AT LAUNCH lists all rows; a FAIL force-expands the banner and its detail stays visible pre-acknowledgement | app.test.ts "W-2 launch doctor evidence retention" (banner full rows + pane all rows; 24-row-terminal FAIL visibility + Enter ack) |
| W-3 | Idle/total elapsed values were recomputed on every event paint, so keystrokes could advance a displayed elapsed value faster than 5 Hz (§§5.5, 10) | Both displayed values read one tick-latched sample (`#elapsedSample`), advanced only inside the existing 200 ms interval; streaming seconds were already latched | app.test.ts "W-3 displayed elapsed values respect the 5 Hz ceiling" (rapid-keypress cap, streaming transition, tick stops on dispose) |
| A-1 | `MADC_UI=inline` selected the legacy inline mode in production, contradicting §5.0/IQW-12 (only `lines` recognized; §5.10 keeps inline as recorded contingency) | `runWitnessApp` no longer selects inline; unrecognised values count as unset and produce the fixed pane note `MADC_UI: not recognised (only "lines")` (never echoing the value); `inline.ts` stays as fixture coverage | bin-launch.test.ts (tier-W app + note via the real bin path), app.test.ts `uiNoteFor` unit |
| A-2 | Evidence pane showed rail-state words, not the §5.7 numeric per-turn ranges, and no servedModel event seq | `#evidenceLines` renders `n:<seqStart>-<seqEnd>` per turn and appends `· seq N` to served from the passing verify's events; unknown values show `—`; the fixture engine now persists `item`/`servedModel` events like the real engine (§0.2) | app.test.ts "§5.7 evidence values derived from disk verification" |

### 1.1 Correction round (2026-09-28, second)

The first continuation's claims "§5.3 rail: verified" and "§5.7 pane: verified" were
overstated for multi-turn sessions; these defects were reproduced as failing tests and fixed:

| # | Defect | Fix | Regression tests |
| --- | --- | --- | --- |
| W-4 | Historical notification replay: `EngineClient.waitFor` matched its full message history, so a second turn on the same engine re-validated and consumed the first turn's messages — tier W violated on them or resolved on the stale completion; Level A and inline re-printed the old reply; an interrupt grace was answered instantly by an old completion. A second replay shape: line-mode and inline advanced the violation poll's cursor into the wait's history cutoff, so a completion that arrived during the poll was skipped and the wait hung | `waitFor`/`waitForNotification` accept a `since` message index (earlier history is ignored, never re-validated); the turn-wait completions in tier W, Level A and inline are bound to thread + turn id, and a live foreign/malformed completion remains an E-d violation; the interrupt-acknowledgement wait is turn-bound and history-free; Level A and inline keep an immutable `waitSince` snapshot separate from the poll cursor. The waiter timer is now unref'd and the unanswered-interrupt path cancels waiters (both additive engine-client changes under the demonstrated-defect latitude, the same class as `cancelWaiters`) | app.test.ts "W-4 …" (tier W two turns with distinct replies and receipts; Level A second reply on both runtimes; interrupt not answered by history) |
| W-5 | Evidence binding: ranges derived from the file's FIRST `turn.start` (a second turn showed `1-8`), and the served seq was the file's last servedModel regardless of which turn was displayed — one turn's served model could pair with another's sequence | Ranges derive per turn (its own `turn.start` by id, the `turn.end` that temporally bounds it); the served seq comes only from within the verified turn's range and is cleared while the served display is unverified; a failed verify learns no range (`—`) | app.test.ts "W-5 …" (second turn 5–8; failed-verify pairing guard `1:1-4 2:—`) |
| W-6 | §5.3 R-b revoked **every** turn on any chain failure | Revocation is by remembered range against line N−1: a verified turn ending before seq N−1 keeps its solid rail; a turn with no learned range stays revoked (fail-closed) | app.test.ts "W-6 …" (intact verified first turn + later failure; fixture `corrupt-last`) |
| W-7 | The transient oversize-prompt warning overwrote the launch note slot, removing the unrecognised-`MADC_UI` note from the pane | The launch note owns a persistent slot (`#launchNote`, banner + pane); `uiNote` stays transient | app.test.ts "W-7 …" |

### 1.2 Correction round (2026-09-29, third) — two independently reproduced blockers

| # | Defect | Fix | Regression tests |
| --- | --- | --- | --- |
| B-1 | Cutoff race: line-mode and inline captured the `waitSince` history cutoff AFTER awaiting `turn/start`, so an engine that batched the response and the turn's notifications into one stdout write landed them all before the cutoff — the wait discarded the batch (completion included) as history and never settled. This is the deterministic core of the earlier intermittent "delivery loss" on both runtimes | The snapshot is taken BEFORE the request in both consumers (tier W already snapshotted pre-request); the violation poll keeps its own advancing cursor | Fixture kind `ok-batched` (one write: response + items + completion); deterministic tests on Node AND Bun, no retry, no skip; a tier-W batched control; the round-2 Level A replay test now runs plainly on both runtimes |
| B-2 | The unanswered-interrupt branch cancelled waiters and returned, but the engine child stayed alive under an app that settled in idle | The specified stop now runs: stdin closed, SIGKILL after `KILL_AFTER_MS` (1 s), the exit awaited (`client.close`); class 3 and the "interrupt not answered in 2 s" reason are preserved (the post-turn verify no longer clobbers an existing reason), and the app settles in **engine-stopped** (Enter restarts) unless the verify widens to a chain-failure state; the stop flag resets on restart | app.test.ts "B-2 …": the OWNED engine's pid is read losslessly from the app's thread id (the fixture's `fixtureThreadId` — full decimal pid, seven-digit pids covered, no modulo; round-5 red→green) and probed in-process with signal 0 (positive-integer pids only, no fallback value; ONLY ESRCH reads as absent, EPERM/unexpected errors propagate); it is proven exited while an unrelated decoy fixture, alive under its own `MADC_HOME` beside the scenario, survives untouched; the settled screen shows `engine stopped` + `Enter restart engine`, and Enter restarts with a distinct live engine whose next turn completes and verifies |

## 2. §12 reconciliation

### 2.1 CLI pin rows (P-1…P-19)

| Row | Frozen text (abridged quote) | Disposition on this branch |
| --- | --- | --- |
| P-1 | "…`-s <seatId>`, `seats ls`, … stay reserved and unbuilt here." | Implemented in code: the M0 app (bare `madc`, `madc "<text>"`) sends headless turns only; reservations kept. Pin text change proposed as rev 6.2 §12.1 P-1 wording. |
| P-2 | "## 1. Command grammar (M0, complete)" | Implemented: full-TTY bare `madc`/`madc "<text>"` open the app (tier W) or line mode (tier A); otherwise today's bytes (bin-launch regression test). Grammar-row text proposed per P-2. |
| P-3 | "Bare `madc "<text>"` … Reserved for M1 interactive chat." | Implemented: full TTY sends `<text>` as the first turn; non-TTY bytes unchanged (app.test, erratum1). |
| P-4 | "Bare `madc` \| Prints the usage and exits 2." | Implemented: full TTY opens the app; otherwise unchanged. |
| P-5 | "The CLI claims no interactive mode in M0…" | Holds as-is: the app is a UI; every turn stays headless (no `mode` field sent). Proposed rewording "no interactive **turn** mode" per P-5. |
| P-6 | "`spawnEngine` … with stdio `["pipe","pipe","inherit"]`." | Implemented under M-1 (ruled): additive `stderr: "pipe"` option, default `inherit`, `-p` unchanged, no protocol/engine change (`engine/src/client.ts`). PROTO:39 rewording proposed per P-6. |
| P-7 | status line "…`<seatId>` · `<s>s`" | Implemented: same text/cadence as a filled pill in tier W; plain elsewhere (oneshot tests). |
| P-8 | "Receipt block (stderr, printed at every exit…)" | Implemented: rows byte-exact inside tier-W chrome; byte-identity tests assert equality with the one-shot receipt source. |
| P-9 | "The `session` line comes from re-reading and verifying … after the engine exits" | Implemented: per-turn read-only verify R-a…R-g in a worker with the 30 000 ms bound (O-1), final verify on every exit incl. quit-during-verify (verify.test, signals tests). |
| P-10 | "Rows print as each check finishes…" | Implemented: tier-W doctor card rows, pending rows replaced in place, hanging indent 23, RESULT tint never okbg (oneshot-card/doctor tests). |
| P-11 | "Words come first. Colour is optional…" | Implemented: green only on verified evidence (§2 rule 6); §3.1 palette + gates; NO_COLOR = zero SGR (frames/tiers tests). |
| P-12 | "No emoji, spinners-as-status, progress bars, or 'all good' banners." | Holds; evidence banner + one earned verdict per turn are the recorded carve-outs. No spinner/progress bar exists; elapsed ≤5 Hz (W-3). |
| P-13 | "Interactive chat / REPL / TUI." (out-of-bounds list) | Proposed: scope to "Act M0-A7 only" per the rev 6.1 IQW6-1 reading; this act's app is the new act's deliverable. Pin-wording change only. |
| P-14 | "Colour themes." | Holds: one fixed palette at three depths is not a theme; light variant stays M1. |
| P-15 | "## 4. Exit codes (both commands)" | Implemented: app exit ladder is §5.11/O-1…O-6 in `state.ts` (`worstExit`), reusing only pinned codes; state.test covers the rows incl. O-3/O-5. Retitle proposed per P-15. |
| P-16 | "6. Non-TTY stdout has no ANSI codes…" | Holds; acceptance tests exist (tier selection, zero SGR under NO_COLOR/`TERM=dumb`, byte-stability, terminal restore). |
| P-17 | "`packages/cli` imports only `node:*`, relative paths, `@madc/core`, `@madc/engine/client`…" | **No change needed**: the app is hand-rolled on `node:*` (readline/tty/worker_threads); no new dependency was added. |
| P-18 | "Doctor needs three read-only things… Founder allowance (D-A7-2)" | Implemented: doctor and the app use the same read-only re-exports; no new exports. Proposed rewording "Doctor **and the app**…". |
| P-19 | status-line existence gate (stdout TTY) | Implemented: gate is stdout **and** stderr TTYs, no `--json`, matching the code and RQ-1. |

### 2.2 Erratum/plan/ledger rows (E-a…E-e, PL-1…PL-4, L-1/L-2)

| Row | Frozen text (abridged quote) | Disposition |
| --- | --- | --- |
| E-a (ERR1 L321, E11) | "…in human mode … replaced with U+FFFD…" | Implemented: E11 applied to every engine string the app draws, all three modes (app tests carry ESC/BEL/C1 through RPC errors and served fields). |
| E-b (ERR1 §3c) | idle deadline "600 000 ms", `MADC_TURN_IDLE_MS`, "Read only by the one-shot" | Implemented: same deadline/env in the app (main.ts parses once, passes `turnIdleMs`; app uses it for the per-turn idle). Proposed L197 rewording "read by the one-shot and the app". |
| E-c (ERR1 L148; allowance A1) | "No other engine-client change is allowed by this." | Implemented under the separate M-1 allowance only (see P-6); A1 not stretched. |
| E-d (ERR1 §3b rules 5–8) | "All of this lives in `packages/cli`" | Implemented: the app's connection runs the ERR1 §3b violation set live + per-turn re-check (wire.ts validators; app tests for malformed responses). |
| E-e (ERR1 §3d) | "**Signal**, over everything" | Implemented: §3d scoped to `-p`; the app's ladder is §5.11 (E-e's proposed text, matching M-2 (d)). |
| PL-1 (M0PLAN:73) | "…do not gold-plate TUI chrome." | Proposed replacement: "the Witness terminal layout (design source rev 6.2, preserved at `docs/plan/sources/…`) is an M0 deliverable". Not edited here — M0PLAN is frozen pending acceptance of this amendment. |
| PL-2/PL-3 (M0PLAN:240/259) | act order and blast radius | Superseded by the actual sequence (header above): the app act landed as the Witness branch after A7's follow-up, in parallel with M1. Recorded, not rewritten. |
| PL-4 (M0PLAN:248) | runbook row | Implemented additively: the M0 runbook now carries the Witness app section including the `reset` recovery line (docs/runbook/M0.md). |
| L-1 (LEDGER D-147) | bare `madc "<text>"` reserved for M1 | Superseded on a full TTY by the implemented app; non-TTY bytes kept. Recorded here; ledger edit is not this repo's to make. |
| L-2 (LEDGER D-189) | Founder ruling relayed, no GitHub source | **Provenance gap, open:** Clio's decisions comment on a design-pin PR does not exist (no such pin/PR on the remote — verified). No backfill attempted (DEC-20260718-04). |

## 3. Clause-to-code-to-test matrix (mandatory requirements)

Statuses: **verified** (behavior test on this branch), **wired** (implemented, covered
indirectly), **limitation** (documented below). Suite evidence: the round-3 full-suite
results in §5 are **historical** (they ran on the round-3 staged bytes, before the round-4/5
test-and-evidence corrections and before the round-6/7 and round-8/9 correction rounds); the current
verification of the final staged bytes is the focused app-test run in §5, which exercises
every matrix row's named test in this file's app suite. Two defects corrected in round 6
(post-settlement waiter/timer cleanup; delta validation in Level A/inline) were introduced
by the round-1 staged fixes themselves and are not pre-existing on the base — see §5.

| Clause | Code | Test | Status |
| --- | --- | --- | --- |
| §2.1–2 (non-TTY/`--json` bytes) | main.ts/oneshot.ts unchanged paths | erratum1 byte tests; app.test piped card tiers | verified |
| §2.3 (exit codes untouched for `-p`/doctor) | exit-codes.ts unchanged | erratum1/oneshot suites | verified |
| §2.6 (green only on verified evidence) | verdict gating `#earnedVerdict` | app.test COMPLETED-only-after-verify | verified |
| §2.7 (failure never quieter) | verdict card sizes equal | frames/app EXIT-card tests | verified |
| §2.12 (E11 sanitisation) | sanitize.ts at all boundaries | app.test E11-through-RPC tests | verified |
| §3.1 palette | style.ts roles/depths | frames/tiers depth tests (contrast values themselves are static design data — limitation L-3) | verified (render), L-3 |
| §3.3/§3.4 gates + tiers | tiers.ts | tiers.test incl. win32 (d) | verified |
| §4 glyphs + ASCII fallback | style.ts/glyphsFor | frames ASCII/NO_COLOR tests + W-1 ASCII geometry | verified |
| §5.0 entry gates/line mode/restore | launch.ts, bin.ts, app.ts `#restore` | bin-launch tests; signals restore tests | verified |
| §5.1 banner | frames.ts `renderBanner` | frames.test W-1 + app.test live counts | verified (W-1) |
| §5.2 header collapse | `renderHeader` | frames.test §5.2 | verified |
| §5.3 rail rules R-a…R-g | app.ts verify flow, state.ts | app.test verified/late-end/corrupt/engine-gone | verified (multi-turn ranges and R-b corrected in round 2: W-5/W-6) |
| §5.4 items/cards (+ honest M0 note) | frames.ts toolPairs | app.test tool fixture test | verified |
| §5.5 streaming ≤5 Hz, no spinner | app.ts tick latch | W-3 tests | verified (W-3) |
| §5.6 pills | renderPills | frames.test §5.6 | verified |
| §5.7 evidence pane | app.ts `#evidenceLines` | app.test §5.7 describes + A-2 test | verified (per-turn binding corrected in round 2: W-5; long summaries ellipsize in the 36-col pane — L-4) |
| §5.8 key table | app.ts onKey/#onEnter | app.test key/state tests | verified (interrupt acknowledgement made history-free in round 2: W-4) |
| §5.8.1 quit-by-interrupt ladder | app.ts quit flow | signals.test (child processes, SIGHUP, 130/143, F-102) | verified |
| §5.9 overlays | doctor-view.ts | app.test /doctor rerun | verified |
| §5.10 stderr (M-1) | engine client `stderr:"pipe"`, app stderrRows | bin-launch (inline not selected); pane stderr-row rendering itself untested — L-5 | wired, L-5 |
| §5.11 exit ladder | state.ts `worstExit` | state.test (incl. O-3, O-5) | verified |
| §5.12 exit receipt | app-receipt.ts | receipt byte-identity tests | verified |
| §5.13 signal line | app exit writes | signals.test | verified |
| §6.1 `-p` tier-W card | oneshot.ts card path | oneshot-card.test | verified |
| §6.2 tier-A SGR | line-mode/oneshot paths | erratum1/app.test §6.2 | verified |
| §6.3 line-mode identity | line-mode.ts | app.test line-mode describes | verified |
| §7 failure rows (incl. -32009 startup) | app.ts session-start-failed | app.test EXIT-5 card test | verified |
| §8 doctor card | doctor-view.ts | oneshot-card §8 test | verified |
| §9 widths | frames.ts responsive banner | W-1 tests | verified (W-1) |
| §10 a11y/motion | tiers WT_SESSION (Q8 open), ≤5 Hz | tiers.test; W-3 | verified; Q8 = L-1 |
| §14 text-over-image | banner from text only | W-1 (montage not asserted) | verified |
| O-1 30 s verify bound | verify.ts `VERIFY_DEADLINE_MS` | verify.test deadline path | verified |
| O-2 signal in final verify | app.ts F-102 window | signals.test second-signal case | verified |
| O-3 verify-fails-after-signal → 5 | state.ts | state.test | verified |
| O-4 SIGHUP re-raise | app/bin exit path | signals.test SIGHUP death | verified |
| O-5 in-app interrupt → 0 | state.ts | state.test | verified |
| O-6 no turns/no thread → 0 | state.ts | state.test | verified |

## 4. Documented limitations and open questions

- **L-1 (Q8, open in the spec):** win32 VT detection is `WT_SESSION`-only (§3.4(d)'s stated
  signal). Trying to enable VT mode is a spec-side open question; no native dependency added.
- **L-2 (provenance):** the rev 6.2 source's §18 lists the 07:24 ruling, D-189, the M-1…M-5
  relays and the rev 6.1 approval as relay-only with no GitHub record; the Clio decisions
  comment does not exist. This amendment records, never backfills.
- **L-3:** §3.1 contrast ratios are design-time computed values; no runtime assertion exists.
- **L-4:** the docked pane is 36 columns; long doctor summaries ellipsize there. Full wording
  prints under the banner (WARN/FAIL) and in the `/doctor` overlay (≤96 cols).
- **L-5:** piped engine stderr rows render in the pane (app.ts), but no test drives a live
  stderr line into the pane; only non-selection of inline mode is tested.
- **L-6:** the in-app interrupt grace path is exercised via the fixture engine's answered and
  unanswered interrupt scenarios; real-vendor timing is not simulated.
- **L-7:** `Ctrl-C` in the narrow window after `turn/start` is sent but before its
  acknowledgement arrives takes the interrupt flow's early return (no turn id yet): the turn
  records `interrupted` immediately and the per-turn verify then corrects it to UNVERIFIED
  from disk. The E17a-style pending state is not separately rendered in M0.
- **L-8 (resolved, round 3):** the earlier "fixture/IPC starvation" attribution was wrong.
  The confirmed defect was a **cutoff race**: line-mode and inline captured their
  `waitSince` message-index snapshot **after** awaiting `turn/start`, so an engine that
  batched the response and the turn's notifications into one stdout write landed them all
  before the snapshot — the wait then discarded the batch, completion included, as
  "history" and hung. This reproduced deterministically (fixture kind `ok-batched`, one
  write for response + items + completion) on Node and Bun, and it explains the earlier
  intermittent losses under load (load makes batched delivery likelier). The snapshot now
  precedes the request in both consumers (the app's tier-W flow already snapshotted
  pre-request); the violation poll keeps its own advancing cursor. The retry and the
  Node-only skip previously carried by the Level A replay test are removed — it runs
  plainly on both runtimes. The 30 s test-side idle deadlines stay as hygiene.
- **L-9 (round 5, test-only):** the fixture exports `fixtureThreadId` (its thread-id
  encoder, now lossless — full decimal pid, no modulo) and skips its readline wiring when
  `MADC_TEST_FIXTURE_HELPERS_ONLY=1`, so the test process can import the encoder for the
  seven-digit contract test without side effects; spawned child engines never set the
  variable. `app.test.ts` also carries the ownership/probe contract: `probePid` rejects
  non-positive/non-integer pids (no fallback value anywhere) and routes `process.kill(pid,
  0)` failures as ESRCH-only absence with EPERM/unexpected errors propagating.
- **Genuinely undecided (one question):** none blocking. Q8 remains the spec's own open item.

## 5. Verification record

**Historical — round-3 staged bytes (2026-09-29; superseded by the round-4/5 test and
evidence corrections, so NOT a result on the final staged bytes):**

```sh
npm run typecheck            # exit 0
npm run lint                 # exit 0 (biome)
TMPDIR=/private/tmp/madc-tmp npm run test:node   # 519 tests: 516 pass / 0 fail / 0 cancelled / 3 skip
TMPDIR=/private/tmp/madc-tmp npm run test:bun    # 519 tests: 516 pass / 0 fail / 3 skip
git diff --check             # clean
git diff --cached --check    # clean (after staging)
```

**Current — focused verification on the final staged bytes after the round-9 correction
round (fixture-only; no adapter smoke, no live provider):** the full `app.test.ts` suite on
both runtimes, the real-child signal tests (tier W AND Level A through the production
entry), the bin-launch regression and the oneshot-card suite, plus typecheck, scoped biome
lint and the diff checks:

```sh
cd /Users/michaeldaley/MADVenturesOPs/madc-witness
TMPDIR=/private/tmp/madc-tmp node --test packages/cli/src/app/app.test.ts
  # 86 tests: 86 pass / 0 fail / 0 cancelled / 0 skipped
TMPDIR=/private/tmp/madc-tmp bun test packages/cli/src/app/app.test.ts
  # 86 pass / 0 fail / 0 skip
TMPDIR=/private/tmp/madc-tmp node --test packages/cli/src/app/signals.test.ts
  # 6 tests: 6 pass / 0 fail — DRIVER-BASED coverage (the testing/signal-driver.ts harness):
  # tier W (SIGHUP O-4, SIGINT 130, SIGTERM 143, F-102) plus the round-8 Level A signal
  # settlement tests driven through the same driver. This file is NOT the production-entry
  # path — the actual runBin → main → launch entry coverage is bin-launch.test.ts below.
TMPDIR=/private/tmp/madc-tmp bun test packages/cli/src/app/signals.test.ts
  # 6 pass / 0 fail
TMPDIR=/private/tmp/madc-tmp bun test packages/cli/src/app/bin-launch.test.ts
  # 7 pass / 0 fail — THE production-entry coverage: runBin → main → launch, real children
  # with a file-based TTY prelude (tier-W launch regression + the 5 round-9 Level A tests)
TMPDIR=/private/tmp/madc-tmp node --test packages/cli/src/app/frames.test.ts
  # 41 tests: 41 pass / 0 fail (includes the round-9 banner-glyph rows, ASCII + Unicode)
TMPDIR=/private/tmp/madc-tmp node --test packages/cli/src/app/bin-launch.test.ts
  # 7 tests: 7 pass / 0 fail (2 tier-W + 5 round-9 Level A entry tests: selection, SIGINT,
  # SIGTERM, SIGHUP, recorded-3 ranking — all through runBin → main → launch with a real
  # file-based TTY prelude; an `-e` prelude breaks the verify worker and is not used)
TMPDIR=/private/tmp/madc-tmp node --test packages/cli/src/app/oneshot-card.test.ts
  # 15 tests: 15 pass / 0 fail (includes the round-8 ASCII-glyph and statusPill regressions)
TMPDIR=/private/tmp/madc-tmp bun test packages/cli/src/app/oneshot-card.test.ts
  # 15 pass / 0 fail
TMPDIR=/private/tmp/madc-tmp node --test packages/cli/src/app/oneshot-card.test.ts
  # 15 tests: 15 pass / 0 fail (includes the round-8 ASCII-glyph and statusPill regressions)
# AGGREGATE, five files per runtime (app 86 + frames 41 + signals 6 + bin-launch 7 +
# oneshot-card 15): Node 155/155 pass / 0 fail; Bun 155/155 pass / 0 fail.
npm run typecheck           # exit 0
biome check <ALL 20 staged TypeScript files>  # exit 0, zero diagnostics
git diff --check            # clean
git diff --cached --check   # clean (after staging)
```

Round-9 scope and classification: (1) §5.13/IQW-10 — the interrupted/exit lines now emit
CONTIGUOUSLY as the final stderr block after the final verification settles and the receipt
is written (a held-verifier regression proves recorded-5-outranks-130: SIGINT mid-verify,
the verify then fails, the run returns 5 with `madc: interrupted (SIGINT)\nexit 5\n` as the
last stderr bytes; ordinary 130 coverage retained through the entry tests). SIGHUP keeps
its distinct one-line + re-raise behaviour. (2) The banner's status chrome (doctor counts,
awaiting-receipt, warn detail) comes from the SELECTED glyph set — ASCII renders `v PASS` /
`!` / `x FAIL` / `- `, Unicode unchanged; asserted by row content in both modes, not
geometry. (3) Level A coverage now runs through the REAL production entry
(runBin → main → launch → runLineModeApp) with a file-based TTY prelude: selection,
SIGINT 130 (contiguous, one exit line), SIGTERM 143, SIGHUP death-by-signal (never
exit(129)), and the recorded-class-3-outranks-130 ranking. signals.test.ts remains DRIVER-BASED
coverage (tier W and the round-8 Level A settlement tests both run through
testing/signal-driver.ts); bin-launch.test.ts is the actual runBin → main → launch entry
coverage and complements — never replaces — the driver tests. Two pre-existing harness defects were
found and fixed en route: bin-launch.test.ts's APP_ENGINE pointed at a nonexistent path
(`app/app-engine.ts` instead of `testing/app-engine.ts`), and a signal delivered with no
settle tick could land inside the verify worker. All round-9 corrections fix defects
present in the staged round-1..8 bytes (stale lint suppressions included). Earlier
full-suite results remain HISTORICAL. Focused-suite passing does not by itself prove the
absence of regressions in other packages. F-4 (exit-verify revocation scope) and the Level
A/inline input-size guard remain open, unchanged.

Earlier notes (superseded by the round-3 cutoff fix, retained for the record): a
2026-09-29 re-measure on a heavily loaded machine showed 1–2 roaming full-suite failures —
the line-mode/E11 family losses were the L-8 cutoff race (load makes batched delivery
likelier; fixed); the `erratum1 §3b` deadline-held timing window remains genuinely
load-sensitive (pre-existing, unrelated to this branch).

Round-2 baseline (before its fixes): the seven correction tests failed as written (replayed
replies, `1-8` ranges, all-turns R-b revocation, note overwrite, instant interrupt answer).
Round-3 baseline (before its fixes): the batched-delivery tests failed deterministically on
both runtimes (line-mode and inline), and the unanswered interrupt settled in idle over a
live child. After each round's fixes both suites are green as above. Node skips: 2
Windows-only PATHEXT + 1 gated live codex smoke. Bun skips: the same three.

Skips are the 2 Windows-only PATHEXT tests and the 1 gated live codex smoke (its gate also
requires `MADC_TEST_CODEX_LIVE_MODEL`, unset here). **Live-call reconciliation:** the
inherited A5 PATH-gated smoke "live: the real unmodified claude binary answers one headless
turn" (`claude-code.test.ts`) is REGISTERED, not skipped, on this machine —
`findClaudeBinary(process.env)` resolves `/Users/michaeldaley/.local/bin/claude` — so every
full-suite run in this record **included one real headless Claude turn**, and it passed.
The earlier claim "no paid/live call was made" was wrong and is withdrawn. What remains
true: this branch's own tests are fixture-only (no keys, no network), no live call was
initiated outside the suites, and the Kimi 403 (exhausted weekly quota) was never probed.
Whether the Claude smoke consumed paid quota, and its cost, is **UNPROVEN** (not
investigated). One additional live execution occurred during round-4 evidence collection
(name-filtered run to confirm the test's registration executed it — a process error,
disclosed in the round-4 report). The
four known macOS `/var` vs `/private/var` session-test failures do not appear under the
physical TMPDIR; they pre-exist on `main` and are unrelated. Hosted PR #35 checks (run
36503630647) predate these staged changes; new local results supersede them for review.

Registry-v2 compatibility: the banner/summary code is count-agnostic and fixture-tested at
v2 magnitudes (21 entries: 10/4/2/5 — `origin/main` @ `2e5f068` actuals); `git merge-tree`
against that `main` is clean; no merge or rebase was performed.

Role-Id: builder
Actor-Id: glm
Execution-Surface: zcode
