# MADC CLI design spec: Witness with a per-turn chain rail — the full layout is the M0 target

**Status:** proposal by Iris (design) for Surface. It is not a pin. **Revision 6.2.**
- Rev 3 was approved by Michael, and Surface pinned it locally as `docs/plan/PIN-madc-M0-design-witness.md` (branch `surface/m0-design-witness` @ `5f451b4`).
- Surface re-pinned rev 4 @ `9217b20` (parent `5f451b4`). Neither commit is pushed.
- Rev 5 applies Surface's notes on rev 4 and answers IQW4-1…IQW4-4 (§16). Michael approved rev 5 (08:28 Nassau, relayed).
- Surface rebased the branch onto `677332c` and re-pinned rev 5 @ `e4b27e1` in the local worktree `/workspace/madc-rulings/docs-drafts/m0-design-witness` (`677332c` → `76f08ce` rev 3 → `a312ab7` rev 4 → `e4b27e1` rev 5).
- Rev 6 answers Surface's DQ5-1…DQ5-4 on that pin (§16, IQW5-1…IQW5-4) and fixes two citations.
- Rev 6 then applies Michael's rulings on §17 M-1…M-5 (Michael, 2026-09-26 08:54 Nassau, relayed by Surface Architect; his words to Surface Architect: "Rule it"). Every place that deferred to §17 now states the ruled result. Six items stay **open** and are listed in §17 as O-1…O-6 (ruled later, in rev 6.2).
- Michael approved rev 6 (2026-09-26 10:25 Nassau, in Iris's chat: "I approve"). O-1…O-6 in §17.1 stay open for Michael; the approval does not decide them. (They were ruled later, in rev 6.2.)
- Rev 6.1 (2026-09-26 10:40 Nassau) answers Surface's DQ6-1…DQ6-3 on his local rev 6 pin `7997ff2` (§16, IQW6-1…IQW6-3) and fixes the citations he listed (§18, "Rev 6.1 citation base"). It changes no design, no look, no exit code and no mock-up. The only new §12 row, E-e, writes down the scope of Michael's M-2 ruling; it decides nothing new.
- Michael approved rev 6.1, including the §12.2 E-e row and Surface's P-13 wording (2026-09-26 10:50 Nassau, relayed by Surface Architect: "I approve rev 6.1: E-e and your P-13 wording"). This reached me only as a relay (§18 unverified 14).
- Rev 6.2 (2026-09-26, Nassau) applies Michael's rulings on §17.1 O-1…O-6 (Michael, 2026-09-26 10:51 Nassau, in Iris's chat: "Rule O-1 to O-6"). No look or mock-up changes.
- The body is rev 3 with the rev 4, rev 5, rev 6, rev 6.1 and rev 6.2 changes folded in.

Rev 3 applied Michael's ruling of 2026-09-26 07:24 Nassau (relayed): **the FULL Witness layout is the M0 deliverable**, even if it needs pin changes and makes M0 take longer. Level A survives only as the fallback for limited terminals (§3.4).

**Direction:** Witness (r3), with Chainline's dotted-to-solid rail merged in.

**Commit read:** `MADVenturesLLC/MADC` `main` = **`677332c24f832527db61d9caa5898e856e522745`** (PR #20 merge, Amendment 3).
- `git ls-remote origin refs/heads/main` returned `677332c`.
- GitHub API, PR #20: `merged: true`, `merged_at 2026-09-26T12:03:23Z` (**08:03:23 Nassau**), `merge_commit_sha 677332c…`, head `2b653a6`, base `343da29`.
- The previous main was `df2e22d`: PR #21, `merged_at 2026-09-26T10:24:39Z` (06:24:39 Nassau), head `8ba515b`, whose tree is identical to df2e22d's for the erratum.
- `git diff --stat df2e22d 677332c` shows docs only:
  - new `PIN-madc-M0-amendment-3.md` (A3);
  - `+2` lines in A2 (an `Amended by` pointer at line 5);
  - `+2` lines in SEAT (a pointer at line 7);
  - one README row.
- `git diff --quiet df2e22d 677332c -- packages` exits 0, so **`packages/` is unchanged since df2e22d**, and so since 343da29.
- **Re-cited at 677332c:**
  - every **A2** line ≥ 5 is **+2** (for example A2:59–74 → A2:61–76, A2:96 → A2:98);
  - every **SEAT** line ≥ 7 is **+2** (for example SEAT:10 → SEAT:12, SEAT:122–131 → SEAT:124–133).
  - CLI, ERR1, PROTO, M0PLAN, M1PLAN and ROAD are byte-identical at df2e22d and 677332c, so their cites stand. The CLI lines from 5 on are still +2 from the rev 2 numbering.
  - The changelog rows keep the numbering of their own revision.
- **Code** is cited as read with `git show df2e22d:<path>`, which is byte-identical at 677332c.
- Everything was read-only: a local clone, `git show`, and the GitHub API (read). I edited, posted and messaged nothing.

**Short names used below:**

| Name | File (at 677332c) |
|---|---|
| CLI | `docs/plan/PIN-madc-M0-cli.md` |
| ERR1 | `docs/plan/PIN-madc-M0-cli-erratum-1.md` (CLI Erratum 1, **merged**) |
| PROTO | `docs/plan/PIN-madc-M0-protocol-messages.md` |
| SEAT | `docs/plan/PIN-madc-M0-seat-format.md` |
| A2 | `docs/plan/PIN-madc-M0-amendment-2-session-integrity.md` |
| A3 | `docs/plan/PIN-madc-M0-amendment-3.md` (M0 Amendment 3, **Accepted**, merged in PR #20) |
| M0PLAN | `docs/plan/PLAN-madc-M0-build-plan.md` |
| M1PLAN | `docs/plan/PLAN-madc-M1-build-plan.md` |
| ROAD | `docs/plan/ROADMAP-madc-post-M0.md` |
| LEDGER | Clio's `/workspace/madc-ledger/LEDGER.md` (file mtime 2026-09-26 08:11:03 −04:00; not in the repo). Ledger cites give the D-id and the line in that file. |

Code paths are under `packages/`.
**Mock-ups:** `spec/` (§14). Overview: `spec/overview-sheet.png`. The rev 2 images, script and text are kept unchanged in `spec/rev2-archive/`.

## Changelog

| Basis (`main` read) | Rev | Change |
|---|---|---|
| `903610f` (main not re-read for rev 6.2) | **6.2** | **Michael's rulings on §17.1 O-1…O-6 applied** (Michael, 2026-09-26 10:51 Nassau, in Iris's chat: "Rule O-1 to O-6"; he ruled Iris's recommendations sent at 10:51). No look or mock-up changes.<br>- **O-1 RULED:** the final verify R-g is bounded at 30 000 ms (30 s). On timeout the turn shows `UNVERIFIED: verify interrupted`, never solid or green. P-9 carries the bound. §5.3 R-a, R-g, §5.8.1, §12.1 P-9.<br>- **O-2 RULED:** a second signal during the final verify matches the one-shot for M0: restore, re-raise, no receipt and no §5.13 line. This is the known gap F-102 (LEDGER D-203), owned by the M1 CLI act. §5.3 R-g, §5.8.1, §5.12, §7.<br>- **O-3 RULED:** a final verify that fails after a signal was received exits 5, not 130/143. The §5.13 line is then `madc: interrupted (<SIGINT|SIGTERM>)` / `exit 5`. This deliberately differs from the one-shot (ERR1 L233; `oneshot.ts:545–553`), like M-2 (d). §5.8.1, §5.11, §5.13, §7.<br>- **O-4 RULED:** after the best-effort restore and engine stop, the app re-raises SIGHUP so the OS reports it (shells show 129). No new exit code is pinned, and the app never calls `exit(129)`. The receipt and the §5.13 line are best effort. §5.0, §5.8.1, §5.11, §5.13, §7.<br>- **O-5 RULED:** an in-app interrupted turn (user `Ctrl-C`, answered, verified) followed by a normal quit counts as 0 for that turn. It is still shown INTERRUPTED, never as success. §5.11, §7.<br>- **O-6 RULED:** a session with no turns and no thread exits 0. The chain pill stays `○ chain: nothing yet`, never green. §5.11.<br>- Also updated to match: §12.1 P-15, §13 Q12, §16 IQW-10, IQW-11, IQW4-2, IQW5-1, IQW5-4, §17 M-2, §18.<br>- Header: Michael's approval of rev 6.1 (2026-09-26 10:50 Nassau, relayed by Surface Architect) is recorded; it is unverified (§18).<br>**Mock-ups:** none changed. |
| `903610f` (Surface pinned rev 6 @ `7997ff2`, local) | **6.1** | **Surface's DQ6-1…DQ6-3 answered (§16 IQW6-1…3) and his citation fixes applied (§18 "Rev 6.1 citation base").** No design, look, exit code or mock-up changes.<br>- DQ6-1: P-13's form is pin wording and Surface's call; the look is the same either way.<br>- DQ6-2: new §12.2 row E-e scopes ERR1 §3d to the one-shot, recording Michael's M-2 ruling.<br>- DQ6-3: the act's name and blast radius are a plan amendment, not design; §12.4 option 4 now lists E-c and E-e.<br>- Citations: ERR1 is +2 from L5 at `903610f`; E17a cited in §7; LEDGER lines re-read at 10:33; the D-169 248/249 mismatch is superseded; the §14 mock-up note now matches §18. |
| `677332c` (rulings; main unchanged) | **6 (rulings)** | **Michael's rulings on §17 applied** (Michael, 2026-09-26 08:54 Nassau, relayed by Surface Architect; his words: "Rule it"). Each cite added was re-read with `git show origin/main:<path>` at `677332c` and in the LEDGER file (§18).<br>- **M-1 RULED:** a narrow engine-stderr allowance for the new app act only, passed through the engine client; no new protocol method, no engine behaviour change. Inline mode is kept for the record, not as the M0 path. §5.10, §12.1 P-6, §12.2 E-c, §13 Q13, §16 IQW-15.<br>- **M-2 RULED:** worst code on the one-shot ranking (`3 > 2 > 5 > 4 > 1 > 0`, ERR1 L245); a 5 replaces only 0, 1 or 4 (ledger D-196, LEDGER line 268; ERR1 §3d L245; `oneshot.ts:532–553`). Worst is by exit code, not by the screen. (a) UNVERIFIED counts with its turn's exit, usually 0 (CLI:81), and is never shown as success; this supersedes IQW-2's "UNVERIFIED never exits 0". (c) no turns: 0 if the final check passes, 5 if it fails. (d) SIGINT 130, SIGTERM 143 (CLI:111–113, CLI:194), never replacing a recorded 2, 3 or 5: a deliberate difference from the one-shot. §5.0, §5.8.1, §5.11 (rewritten), §5.12, §5.13, §7, §12.1 P-15, §13 Q12, §16 IQW-2, -4, -10, -11, IQW4-2, IQW4-4, IQW5-1, -2, -4.<br>- **M-3 RULED:** same 10-minute per-turn idle deadline and `MADC_TURN_IDLE_MS` in the app. §12.2 E-b, §16 IQW-3.<br>- **M-4 RULED:** a new act after the A7 follow-up and before A8. §12.2 PL-2, PL-3, §12.4.<br>- **M-5 RULED:** Clio posts the decisions comment on the design pin's PR. §12.2 L-2.<br>- **Design reading (not a ruling):** a second `Ctrl-C` during the grace forces the stop but records no class of its own, as in the one-shot (ERR1 L228), so that quit exits 130 unless a 2, 3 or 5 was already recorded. §5.8, §16 IQW5-4. On a tie for the worst code, §5.12 prints the later turn's block (proposed).<br>- **Left open, Michael's call (new §17.1):** O-1 the 30 s bound on the final verify (P-9); O-2 a second signal during the final verify copies the F-102 gap (D-203); O-3 a final verify that fails after a signal (not settled by the ruling); O-4 SIGHUP; O-5 the old M-2 (b), which the relay does not name; O-6 a no-turn session with no thread, where no final check runs.<br>**Mock-ups:** `build_spec.py`'s overview title now reads rev 6, and `overview-sheet.png` is regenerated. Every frame image `01`–`12` was rewritten by the same run (mtime 09:00 Nassau) and is byte-identical to rev 5 (sha256). |
| `677332c` (Surface re-pinned rev 5 @ `e4b27e1`) | **6** | **Main is unchanged** at `677332c`. Every new cite was checked there: the eight `spec/src677/` copies are byte-identical to `git show 677332c:docs/plan/<file>`, and code was read with `git show 677332c:<path>`.<br>**Surface's DQ5-1…DQ5-4 answered (§16 IQW5-1…4), each folded into its section:**<br>- DQ5-1: quitting during a verify is not an exception to the final verify R-g. The first `Ctrl-C` or SIGINT during a verify abandons it, and one final bounded verify runs after the engine stops. A signal during the final verify gets the one-shot's F-102 behaviour (ERR1 L427). §5.3, §5.8, §5.8.1, §5.12, §5.13, §7, §12.1 P-9.<br>- DQ5-2: `-32009` on `thread/start` (A3 L254) is a session-level startup failure. It gets no rail and no turn, an err card in the `05` style, input disabled, quit keys only, and exit 5 (CLI:193). New §5.8 column and after-error rule, and a new §7 row. The `-p` column for this case is the pre-thread lines, not an `EXIT 5` card (`oneshot.ts:589–595`).<br>- DQ5-3: `<N>` in R-c is the verifier's `line` value, a 1-based line number (CLI:131; `session-store.ts:582`). It is `1` for a 0-byte file. §5.3 R-c.<br>- DQ5-4: a second `Ctrl-C` or SIGINT during a turn's interrupt grace quits by interrupt, with the final verify, the receipt and the §5.13 line. §5.8, §5.8.1, §5.11, §5.13, §7.<br>**Citation fixes:**<br>- §13 Q12: "three open cases" → four (§17 M-2 (a)–(d)).<br>- Ledger lines, re-read in the LEDGER file with mtime 2026-09-26 08:11:03 −04:00: D-147 line 232 → **230**; D-189 line 85 → **78** (it is also listed at lines 32 and 403). D-194 and D-195 now carry their lines, **265** and **266**. New cites: D-203 (line 84), D-210 (line 272), D-214 (line 274), D-216 (line 91).<br>**Where Iris's intent met a pin (the pin stands; reported to Iris):**<br>- No pin gives any verify a time limit, so the final verify keeps the §5.3 **proposed** 30 000 ms.<br>- A failed final verify after a signal records class 5, but the exit is §17 M-2 (d). The one-shot's pinned ladder puts the signal first (ERR1 L245).<br>- The pins do not require the verify when a second signal arrives during it. The one-shot gives such a signal default handling (ERR1 L427), so the §5.8.1 line is rewritten to match, not dropped.<br>- `<N>` is a line number, not a byte count (CLI:131).<br>**Mock-ups:** none changed. Every PNG is byte-identical to rev 5 (sha256), and `build_spec.py` is unchanged. Rev 5 is archived in `spec/rev5-archive/`. |
| `677332c` | 5 | **Main moved** to `677332c` (PR #20, Amendment 3). `packages/` is unchanged since df2e22d. A2 and SEAT cites are +2; everything else stands.<br>**Surface's fixes, each re-checked, all applied (none disputed):**<br>- §5.0: "no env values" is **CLI:107**; CLI:105 is the `error` shape.<br>- §12.2 PL-2: A7 is **PR #19**, merged as `343da29` (`merged_at 2026-09-26T08:45:03Z` = **04:45:03 Nassau**). PR #16 is the CLI pin plus Amendment 2 (merged `2026-09-25T17:55:36Z` = 13:55:36 Nassau, `f8b295d`).<br>- §7 and IQW-7: ERR1 rule 3 (L134) makes N1, an unmatched response, "ignored … not a protocol violation". Fixed through IQW4-1.<br>- PL-1 no longer names rev 3.<br>- Every wall-clock time for when checks ran is removed. This column now names the commit read, and the ledger cite uses its file mtime.<br>**New §16 lines IQW4-1…4:** the violation set (E-d rewritten), signal exit codes moved to §17 M-2, key-bar truth, and external SIGINT in every state.<br>**A3 folded in:** 0-byte and NUL/whitespace-only tails are torn-tail (A3 §2, L102–149), and a `sessions/` without owner read gives `-32009` on `thread/start` (A3 L254) and a `locks` WARN (A3 L255).<br>**Mock-ups:** `02` and `08` are regenerated, because their key bars showed keys that do nothing during a turn. `overview-sheet.png` is regenerated. The rest are unchanged. Rev 4 is archived in `spec/rev4-archive/`. |
| `df2e22d` (Surface re-pinned it @ `9217b20`) | 4 | **Surface's factual fixes, each re-checked at df2e22d, all applied (none disputed):**<br>- §12.2 PL-2: A7's blast radius **is** `packages/cli` (M0PLAN:240), so "no M0 act" was wrong. It now reads "no act after A7".<br>- §5.0: CLI:40 → **CLI:38** (bare `madc`); CLI:39 → **CLI:37** (`CHAT_RESERVED`).<br>- Labels: §2 rule 3 and §5.11 → **P-15** (was P-17); §3.2 → **P-14** (was P-15).<br>- E-c: the A1 text is at ERR1 **L452** (L450 is the heading).<br>- §12.4 option 1: M0PLAN:247–248 name CI, the runbook, a README pointer and "registry forbid/allow tests + M0 happy-path test", not CLI tests. The wording is fixed.<br>- §5.4: `turn/started` is a notification (PROTO:78), so it moves out of the Item table. A render row is added for the `error` Item (PROTO:209–213, PROTO:133).<br>**Found while checking:** the `05` app frame showed `NOT STARTED` / `UNVERIFIED: no turn was started` for a violation while `turn/start` was pending. Under merged ERR1 E17 (L361–367) that is `UNKNOWN` / `UNVERIFIED: turn unknown (turn/start sent, no answer)`. `05` is regenerated.<br>**New §16:** one decision per IQW-1…IQW-18 from the pin's §16.2, each folded into its section (§3.3, §5.0, §5.1, §5.3, §5.4, §5.6, §5.8, §5.10–§5.13, §7, §12, §14).<br>**New §17:** 5 items for Michael. **New rows:** P-19 (CLI:63 status-line gate), E-d (§3b checks in the app), PL-4 (runbook recovery line).<br>**Mock-ups:** `05` regenerated; new `12` (inline fallback if the stderr allowance is denied); `overview-sheet.png` regenerated. The rest are unchanged. Rev 3 is archived in `spec/rev3-archive/`.<br>The old §16 verification log is now §18. |
| `df2e22d` (Surface pinned it @ `5f451b4`) | 3 | **Re-scope (Michael's ruling, 07:24):** the full Witness layout is the **M0 target**. That covers the Hermes-style banner (MADC wordmark plus seat, backing, served, registry and doctor), its collapse to a one-line header on the first turn, oh-my-pi-style tool cards, the per-turn dotted-to-solid rail, status pills, the `Tab` evidence pane, the key-hint bar, and earned big verdicts (COMPLETED / FAILED / EXIT n). It is delivered as the **M0 app** (bare `madc`, `madc "<text>"`) and as tier-W chrome for `madc -p` and `madc doctor`.<br>**Level A** is now only the limited-terminal fallback. Its exact conditions are in §3.4 (tiers W / A / P).<br>**Every "NOT proposed for M0" label is removed.**<br>**New §12 "Pin changes the full M0 layout needs":** 26 rows (P-1…P-18, E-a…E-c, PL-1…PL-3, L-1, L-2). Each row gives the file:line at df2e22d, the current text and the change needed.<br>**New §12.4:** candidate acts, given as options, not a decision.<br>**New §16:** verification log and the list of unverified items.<br>**Surface items, each verified before applying:**<br>- **PR #21 merged** at 06:24:39 Nassau as `df2e22d`. The Timeout row is now unconditional, and "open, not merged" is gone from §7 and §12. ERR1 and CLI are re-cited at df2e22d (CLI +2 from line 5). `packages/` is unchanged, which I confirmed.<br>- **RQ-1:** one both-TTY gate for every human-readable stderr line, including `madc doctor x` parse errors. §3.3 now matches §6 and Q10.<br>- **RQ-2:** an error row that carries `chain FAILED line N: …` (`oneshot.ts:541`) uses the same in-span form as the session value.<br>- **RQ-3:** a stderr line with no spec row prints uncoloured, and any new failure or warning line needs a row first. The F-130 row is proposed, cited to ERR1 L354 and the local A7 follow-up code.<br>**IQ answers restated for the full layout:** IQ-1, 12, 13, 14, 15, 16, 17, 20 and 21 (§15). The 5 rev 2 citation fixes are kept, re-cited to df2e22d.<br>**New findings:**<br>- the engine's inherited stderr would draw over the app screen (P-6; this needs a Founder allowance);<br>- `seat/list` and `provider/list` are not M0 methods, so `/seat` stays M1;<br>- no M0 act's blast radius includes `packages/cli` (§12.4) [rev 4: wrong; A7's does (M0PLAN:240); no act **after** A7 does].<br>**Mock-ups:** all regenerated at full Witness fidelity (`01`–`11` plus the overview). |
| `343da29` | 2 | **Citation fixes** from Surface, each re-checked at 343da29:<br>- doctor RESULT is `doctor.ts:898–900` (was 895–897);<br>- the JSONL envelope is SEAT:122–131 only (A2:17–25, the Operating envelope, was dropped);<br>- the default seat is SEAT:10 and SEAT:93, with the rule at PROTO:70 (SEAT:23, the seats path row, was dropped);<br>- the bad-flag messages are `main.ts:24–26` and `main.ts:53` (was `oneshot.ts:594` in the §7 usage row);<br>- Erratum 1 became PR #21 (then open, head `8ba515b`), and the timeout row showed `UNKNOWN` / `UNVERIFIED: turn unknown (turn/start sent, no answer)`.<br>**Also in rev 2:** new §15 (IQ-1…IQ-21); receipt colour only when stdout **and** stderr are TTYs; the whole error row red; `chain FAILED` bold inside a red value; turn words not in the table are 33; `ESC[0m` before every `\n`; doctor `exit 0` is 33 with WARNs; `TERM` must be exactly `dumb`; zero SGR under NO_COLOR; overlay indent 23. |
| not recorded in this file | 1 | First version; the Founder approved it and it went to Surface Architect. |

---

## 0. STEP 0: what the rail can honestly know

*Unchanged from rev 2. `packages/` is identical at 343da29 and df2e22d, so every code line below holds at df2e22d. PROTO lines ≥ 9 and SEAT and A2 are unchanged.*

**Question:** can a client know each recorded item's session `seq`, and when verification passes for each turn?

### 0.1 What exists

| Surface | Fields | Cite |
|---|---|---|
| Item notifications | `item/started` and `item/completed` carry `{ threadId, turnId, item }`. A delta carries `{ threadId, turnId, itemId, delta }`. **No seq, no hash.** | PROTO:94–96 |
| Authority | "`item/completed` is authoritative. Deltas are optional TUI convenience." | PROTO:98; CLI:57 |
| Item / Turn / Thread types | No session seq or hash field on any of them. | PROTO:143–230 |
| Only seq on the wire | `-32009 SessionWriteFailed` data `{ threadId, path, seq }`, which appears on failure only. | PROTO:124 |
| Turn order | `userMessage → (toolCall/toolResult)* → agentMessage → servedModel → turn/completed` | PROTO:234 |
| JSONL envelope | `v, seq (0-based), ts, type, threadId, seatId, prevHash, hash, payload` | SEAT:124–133 |
| JSONL events | `session.open`; `turn.start` ("`turn/start` accepted"); `item` ("After each `item/completed`"); `servedModel`; `turn.end` ("With `turn/completed`") | SEAT:139–146 |
| Chain | `hash = sha256_hex(prevHash + "\n" + canonicalPayload)`. Verify recomputes forward from seq 0; a mismatch or gap fails. | SEAT:156–165 |
| Verifier | `verifySessionFile` is re-exported read-only through the sdk. On success it returns `{ok, events (each with seq), nextSeq, lastHash}`. On failure it returns `{ok:false, line, reason, kind:"torn-tail"\|"integrity"}` with **no events**. `line = i + 1`, so line N is seq N−1. | `engine/src/sdk.ts:36–40`; `engine/src/session-store.ts:567–585, 767` |
| Torn tail | Reported distinctly and never auto-repaired. | A2:61–76 |
| One-shot today | Verifies after the engine exits. `chain VERIFIED` requires the verify to pass **and** the last `turn.end` to name this turn. Otherwise it prints `chain FAILED line N: <reason>` (exit 5) or `UNVERIFIED: <why>`, which is "never shown as success". | CLI:79–81; `cli/src/oneshot.ts:604–629, 528–544` |

### 0.2 Engine write order (`engine/src/server.ts`)

| Step | Order | Cite |
|---|---|---|
| `turn.start` | Durable before the turn exists | `server.ts:620–625` |
| `servedModel` item | Persisted **before** it is notified | `server.ts:763–771` |
| every other item | **Notified before it is persisted**: `#notify("item/completed")` at :780, then `#persistItem` at :785 | `server.ts:780–785` |
| `turn.end` | Appended before `#notify("turn/completed")` | `server.ts:855–858` then `:897` |

### 0.3 Verdict

- **Per-item seq is not exposed.** It cannot safely be derived mid-turn, for three reasons:
  1. When a client sees most `item/completed` notifications, the item may not be on disk yet (`server.ts:780–785`).
  2. Reading the file mid-append can look like a torn tail (A2:61–76).
  3. The size bound is deferred (A2:98), so re-reading the whole file is unbounded.
- **Per-turn verification is available.**
  - `turn.end` is durable before `turn/completed` (`server.ts:855–897`).
  - After `turn/completed` the client runs the read-only `verifySessionFile` (sdk.ts:36–40), which passes or fails for the whole file.
  - The client reads the last `turn.end`'s turnId and seq from `events`. This is the same test the one-shot uses (CLI:80).
- **So the rail is per turn:**
  - **dotted `┆`** while the turn is running, or after it ended but before a verify passed;
  - **solid `┃`** only for turns covered by a passing verify whose last `turn.end` names that turn;
  - a **red break `╳`** at the turn whose remembered seq range contains line N of `chain FAILED line N`.
- The client remembers each turn's seq range from its own passing verifies. On a failure there are no events (session-store.ts:567–585). So a turn whose range the client never learned is shown as "break at or after the last verified seq".

**What would enable a per-item rail (R9–R10, post-M0; not needed for the M0 target):**
1. **Persist before notify for every item.** Only `servedModel` does this today (`server.ts:763–771` vs `:780–785`).
2. Add **`session: { seq, hash }`** to `item/completed` and `turn/completed`, emitted only after a durable append. A lighter alternative is a `session/appended` notification.
3. Even then, the rail turns solid only after a verify covers that seq.

---

## 1. Purpose, scope, precedence

- **Purpose.** Give Surface one document that can be split into pins for the MADC terminal look. The direction is Witness (evidence-first cards and pills) with Chainline's rail. It covers **M0 (full layout)**, what stays for M1, and the M3 desktop tokens.
- **Precedence.** **Pins win.** Where this spec differs from a pin, §12 lists the change it needs. Until a change is merged, the pinned bytes stand and nothing here may ship.
- **Split (rev 3):**

| Milestone | Gets | Does not get |
|---|---|---|
| **M0: the M0 target** | **The full Witness layout.** In the **M0 app** (bare `madc`, `madc "<text>"`, §5): banner → header collapse, per-turn rail, tool cards, streaming row, status pills, `Tab` evidence pane, key-hint bar, `/doctor` overlay, and earned big verdicts. **`madc -p`** on a tier-W terminal gets the streaming status pill plus the verdict card around the pinned receipt rows (§6.1). **`madc doctor`** on a tier-W terminal gets the doctor card (§8). **Level A** only on limited terminals (§3.4). Plain bytes (tier P) everywhere output is not a TTY. | `/seat` switching (needs `seat/list`, M1PLAN:203); resume history (R12); `mode: "interactive"` turns and the `/dev/tty` hand-off (M1-A5, M1PLAN:146); the light theme (R6); a context bar (§12.3). |
| **M1** | The rest of the M1 plan. From this spec: `/seat` (P4), the resume display, the light variant, the `/dev/tty` hand-off (R15), and the per-item rail if R9–R10 land. | — |
| **M3** (desktop) | Token mapping and a component sketch, marked **early** | Anything pinned. The M3 stack is open (ROAD:50–56). |

The M0 app sends **headless** turns. The M0 protocol has no `mode` field; P3 in M1PLAN:202 adds it in M1. So the engine never opens `/dev/tty` in M0, and interactive-only lanes stay refused (`-32007 interactive-only-headless`, PROTO:122). "Interactive" in M0 describes the UI only.

---

## 2. Hard rules

1. **Non-TTY output is byte-stable.**
   - When stdout is not a TTY, it is "the final agent text only, no ANSI codes" and the receipt is "plain text" (CLI:64). "Non-TTY stdout has no ANSI codes" (CLI:233).
   - Nothing in this spec adds or changes a byte in non-TTY mode. That includes bare `madc` and `madc "<text>"`, which keep today's usage bytes and exit 2 when not on a TTY (§5.0).
2. **`--json` is untouched.** It produces "exactly one JSON object … and nothing else" (CLI:65, 86–107). No colour, no chrome, no status line, in every tier.
3. **Exit codes for `-p` and `doctor` are untouched.** The table at CLI:184–197 and the constants at `cli/src/exit-codes.ts:6–15` stand, and styling never changes an exit. The app's own exit rule is new (§5.11, P-15). It reuses the same classes and invents no code.
4. **Protocol output is untouched.** The CLI↔engine JSONL (PROTO:24–28) gains no field, method or notification from this spec.
5. **The stdout/stderr split is untouched for `-p` and `doctor`.** Agent text goes to stdout; status and receipt go to stderr (CLI:63); doctor goes to stdout. The app draws on the terminal it owns (alternate screen), and its line mode keeps the same split (§5.0).
6. **Honesty.** Green, `✓`, a solid rail, and the word or card `COMPLETED` appear **only** on verified evidence: `chain VERIFIED` per CLI:80, or a doctor PASS with evidence per CLI:140–141.
   - Completed tool cards and agent rows use accent2 `◆`, **not** green.
   - A turn that completed with `UNVERIFIED` is shown in warn, never as success (CLI:81).
7. **Failure is never quieter than success.**
   - FAILED, chain FAILED, an EXIT ≠ 0 verdict and NO RECEIPT get at least the weight the success state would have had: the same card height, the same big-art size, bold, and a red or warn rail, plus the word.
   - This holds in every tier: in tier A (error row `31`, exit `1;31`), in NO_COLOR (both use block art or both use the `####` word form) and in ASCII.
8. **Meaning is never carried by colour alone.**
   - Every state has a word plus a glyph that differs in shape: `✓ ▲ ✕ ○ ● ◆ ┆ ┃ ╳`.
   - The rail differs in shape: dotted, solid, broken.
   - NO_COLOR renders keep all meaning (`09`).
9. **No emoji, no spinners-as-status, no progress bars** (CLI:142 stays for these three).
   - Elapsed time is a number, and the streaming indicator is a word plus a static `●`.
   - The glyphs above are text-presentation symbols. They are **never** followed by U+FE0F, so they never render as emoji.
   - There is no context or token bar (§12.3).
10. **Pinned strings are rendered verbatim.** Chrome wraps them and never edits their text. That includes `· ─ → …` and `ThreadStatus`, printed verbatim (CLI:223; A2:97).
    - A pinned line longer than the terminal is **soft-wrapped by the terminal** at the edge. The app never re-wraps or truncates it (`05` bottom, `10`).
11. **80 columns is the design minimum.** Tier W is fully specified at 80×24. Below that, the output falls to tier A (§3.4).
12. **Engine text is sanitised.** Every engine-supplied string the app or a card draws (agent text, deltas, tool names and arguments, tool results, and error messages) gets ERR1 E11's rule (L321). Every C0 control except TAB and LF, plus DEL and C1, becomes U+FFFD. Chrome never passes an engine byte through raw.

---

## 3. Colour tokens

### 3.1 Dark (default), Witness

Contrast is the WCAG ratio vs bg `#0d0e14` and vs pill bg `#222638`. I recomputed it on 2026-09-26 with the r3 `contrast.py` formula.

| Role | Use | Hex | 256 | 16-colour SGR | vs bg | vs pill |
|---|---|---|---|---|---|---|
| bg | terminal default (assumed, not painted) | `#0d0e14` | 233 | default | — | — |
| surface | cards | `#161925` | 234 | (none) | — | — |
| pill | pill bg, `you` band | `#222638` | 235 | (none; `7` reverse for filled pills) | — | — |
| fg | body text | `#eef0f8` | 255 | 39 (default) | 16.93 | 13.16 |
| dim | labels, meta | `#a5abbf` | 145 | 37 | 8.42 | 6.54 |
| faint | chrome only (never info) | `#646b82` | 60 | 90 | 3.64 | 2.83 |
| border | chrome only | `#3b4058` | 238 | 90 | 1.89 | 1.47 |
| accent | brand, `you`, seat, focus | `#b69cff` | 147 | 95 | 8.43 | 6.55 |
| accent2 | ids, hashes, tool/agent `◆` | `#7df9ff` | 123 | 96 | 15.47 | 12.03 |
| ok | **verified only** | `#5ee8a0` | 79 | 92 | 12.41 | 9.65 |
| warn | unverified, NO RECEIPT, WARN, dotted rail | `#ffcc66` | 221 | 93 | 12.92 | 10.04 |
| err | FAIL, chain FAILED, EXIT ≠ 0 | `#ff6b7d` | 204 | 91 | 7.02 | 5.46 |

- The 256-palette versions keep AA: ok (79) 10.55 and err (204) 6.46 vs 233.
- **Filled pills** (bg-coloured text on a role fill): accent 8.43, ok 12.41, warn 12.92, err 7.02, dim 8.42.
- **Card tints** are truecolor only: okbg `#10231b`, errbg `#2c1520`, warnbg `#2a2415`, runbg `#1c1d35`.
  - fg on a tint is 13.55–14.94; err on a tint is 5.62–6.19; warn on errbg is 11.40.
  - In 256-colour mode the tints collapse to 234/235, and in 16-colour mode to none. The rail and glyph carry the state, so the tint is never the only signal.
- The **wordmark gradient** and the verdict-art shadow strokes are decoration. The solid blocks carry the letterforms.

### 3.2 Light variant (M1 opt-in; R6)

Unchanged from rev 2 and **not part of M0**: shipping it in M0 would need a CLI:216 ("Colour themes.") change beyond P-14.

| Role | Hex | 256 | vs bg `#fbfbfd` | vs pill `#e6e8ef` |
|---|---|---|---|---|
| fg | `#16181f` | 234 | 17.15 | 14.48 |
| dim | `#4f5566` | 240 | 7.20 | 6.07 |
| faint (chrome) | `#9aa0b0` | 248 | 2.53 | — |
| border (chrome) | `#c9cdd8` | 252 | — | — |
| accent | `#6b3fd4` | 62 | 6.18 | 5.22 |
| accent2 | `#006b7a` | 24 | 6.00 | 5.07 |
| ok | `#11703f` | 23 | 5.95 | 5.03 |
| warn | `#8a5a00` | 94 | 5.73 | 4.84 |
| err | `#c0203a` | 125 | 5.79 | 4.89 |

- Tints: okbg `#e6f5ec`, errbg `#fbe8eb`, warnbg `#fbf1dc`, runbg `#eeeafb`. All text on them is ≥5.02.
- Detection: none is reliable, so the light variant is never auto-selected. It is opt-in with `MADC_THEME=light` (proposal, M1).

### 3.3 Colour detection and the TTY gates (proposed precedence; the first match wins)

**Today:** colour is on iff `stdoutIsTTY && NO_COLOR === undefined` (`cli/src/io.ts:35–37`), and only doctor uses it (`cli/src/doctor.ts:854`).

| # | Condition | Result |
|---|---|---|
| 1 | `--json` | no SGR, no chrome (CLI:65) |
| 2 | **The TTY gate fails for this output.** A check that fails or is unclear counts as not a TTY (`io.ts:27–28` use `isTTY === true`). Gates:<br>(a) **every human-readable line the CLI writes to stderr**, whichever command wrote it: stdout **and** stderr are both TTYs (RQ-1, Q10);<br>(b) doctor's rows on stdout: stdout is a TTY;<br>(c) the app: stdin, stdout **and** stderr are all TTYs, or the app does not start at all (§5.0, IQW-1). | tier P for that output: no SGR (CLI:64–65, 233; IQ-1, IQ-19, RQ-1) |
| 3 | `NO_COLOR` present (any value, including empty) | **zero SGR** in every tier, bold and reverse included. The layout, glyphs and words stay (CLI:141; io.ts:36; IQ-16) |
| 4 | `TERM` is exactly `dumb` (case-sensitive) | zero SGR; tier P for `-p` and doctor; the app runs in line mode with zero SGR (IQ-13) |
| 5 | `FORCE_COLOR` | **not honoured** (proposal, Q1). It never overrides 1–4. |
| 6 | `COLORTERM` is `truecolor` or `24bit` | truecolor hex (tier W) |
| 7 | `TERM` contains `256color` | 256 index (tier W) |
| 8 | otherwise | the 16-colour SGR column of §3.1 (tier W); the §6.2 table (tier A) |

**Gate rule (settled, RQ-1).** Every human-readable stderr line the CLI prints is coloured only when stdout **and** stderr are both TTYs. This covers:
- the one-shot receipt and its verdict card;
- the one-shot status line;
- the pre-thread error lines (`oneshot.ts:593–595`);
- `usageFailure` messages (`main.ts:53`), including the ERR1 messages that go through it (F-110, F-130, E18);
- the parse-error and CHAT_RESERVED lines at `main.ts:24–26`, **for every command**. For example, `madc doctor x` prints `madc: unexpected argument x (see madc --help)` (`args.ts:89` → `main.ts:26`). That line takes the both-TTY gate, **not** doctor's stdout gate;
- the app's line-mode lines and its exit receipt (§5.0, §5.12).

Doctor's **stdout** rows keep the stdout gate (`io.ts:35–37`). The status clear `\r\x1b[K` (`oneshot.ts:249`) is not colour: it stays exactly as today, whatever `NO_COLOR` and `TERM` are (IQ-14).

### 3.4 Render tiers: W (Witness), A (Level A fallback), P (plain)

Each output is placed in one tier at startup. The first matching row wins.

| Tier | When (all conditions for that output) | What it draws |
|---|---|---|
| **P (plain)** | Rule 1 or rule 2 of §3.3 applies, or `TERM` is exactly `dumb` | Today's bytes exactly: CLI:63–76, CLI:152–165 and the ERR1 message texts. No SGR, no chrome. The app in line mode writes no SGR (§5.0). |
| **A (Level A fallback)** | The gate passes, `TERM` ≠ `dumb`, and **at least one** of:<br>(a) the terminal is below **80 columns or 24 rows** (`columns`/`rows` of the stream; undefined counts as below);<br>(b) `TERM` is unset or empty (no evidence of cursor addressing or an alternate screen);<br>(c) `MADC_UI=lines` (proposal: the user opts out of the full-screen layout, and it also serves screen readers, Q7);<br>(d) `process.platform === "win32"` and the console is not known to support VT sequences (Q8; `WT_SESSION` set counts as known) | Pinned lines plus the §6.2 SGR spans only. The app runs in **line mode** (§5.0). Under `NO_COLOR` it is the same with zero SGR. |
| **W (Witness)** | Everything else: the gate passes, the terminal is ≥80×24, `TERM` is set and not `dumb`, not opted out, and not win32 without VT | The full layout: §5 (app), §6.1 (`-p`), §8 (doctor card). Colour depth per §3.3 rows 6–8; under `NO_COLOR`, the layout with zero SGR. |

- **Mid-session resize (app).** Tiers are chosen at startup. If a tier-W app is resized below 80×24, it pauses drawing and shows one centred line on its own screen, `terminal too small · need 80×24 · now <c>×<r>`. It keeps all state and resumes when the terminal is large enough again. It does not drop to line mode mid-session.
- **Why Level A still exists:** it is the least-risk rendering for terminals that cannot be proven to support the full layout. It is **not** the M0 target, and `10` is labelled so.

---

## 4. Glyphs and borders

**The ASCII fallback triggers when:**
- `TERM` is exactly `dumb` (only the app's line mode draws any glyph then: the prompt `>`); or
- the effective locale (`LC_ALL`, then `LC_CTYPE`, then `LANG`) does not name UTF-8 (`UTF-8`/`utf8`, case-insensitive); or
- `MADC_ASCII=1` (proposal, R14).

**The fallback applies to chrome glyphs only.** Pinned bytes stay exactly as pinned in every mode:
- `·` `─` `→` `…`, as in the receipt rule `─ receipt ` + 45 `─` (`oneshot.ts:631`), the ` · ` separators (CLI:74), `→` (CLI:72), and `…` in the status line (`oneshot.ts:379`).

| Meaning | UTF-8 | ASCII |
|---|---|---|
| verified / PASS | `✓` | `v` |
| warn / unverified / NO RECEIPT | `▲` | `!` |
| fail / error | `✕` | `x` |
| idle / skip / not yet | `○` | `-` |
| running / streaming | `●` | `*` |
| tool / agent item (completed, not verified) | `◆` | `*` |
| rail dotted (unverified) | `┆` | `:` |
| rail solid (verified) | `┃` | `\|` |
| rail break | `╳` | `X` |
| rail end, verified | `┗━` | `` `= `` |
| rail end, unverified | `╵` | `'` |
| band / card edge | `▌` `▎` | `\|` |
| box corners and lines (banner, overlay) | `╭╮╰╯─│` `╔╗╚╝═║` | `+ + + + - \|` `+ + + + = \|` |
| key cap | reverse video (dim fill) | `[Enter]` (also under NO_COLOR) |
| prompt | `❯` | `>` |
| MADC wordmark | ANSI-Shadow block art, violet→cyan gradient | figlet-standard ASCII `MADC` |
| big verdict | ANSI-Shadow block art (6 rows; COMPLETED is 77 columns wide) | `#### COMPLETED ####`, `#### FAILED ####`, `#### EXIT 3 ####`: the same form for success and failure |

Under **NO_COLOR with a UTF-8 locale**, the block art stays: it is characters, not colour. Pills and key caps become `[words]` (`09`).

---
## 5. The M0 app (tier W): layout and behaviour

### 5.0 Entry, gates and line mode

| Invocation | stdin, stdout TTY | stderr TTY | Tier (§3.4) | Behaviour |
|---|---|---|---|---|
| `madc` | yes | yes | W | full-screen app, banner expanded (`01`) |
| `madc "<text>"` | yes | yes | W | app opens and sends `<text>` as the first turn; the banner collapses at once |
| either | yes | yes | A (limited) | **line mode** (`10`): one plain identity line (§6.3), a `> ` prompt, agent text to stdout, the §6.2 receipt after each turn to stderr, no alternate screen, no cursor addressing |
| either | yes | **no** | P | **No app (IQW-1).** Today's bytes exactly as pinned: `madc` → `USAGE`, `madc "<text>"` → `CHAT_RESERVED`, exit 2, **zero SGR**. This matches the both-TTY gate (§3.3) and P-2. |
| `madc` | not both | any | P | today's bytes: `USAGE`, exit 2 (`main.ts:24`; CLI:38) |
| `madc "<text>"` | not both | any | P | today's bytes: `CHAT_RESERVED`, exit 2 (`main.ts:25`, `args.ts:32`; CLI:37). The text now sounds stale (it says chat "arrives in M1"), but the bytes are kept (Q11). |
| any, `TERM` exactly `dumb` | yes | yes | P for colour | line mode, zero SGR, ASCII prompt `>` |

- The app uses the **alternate screen** (`ESC[?1049h` … `ESC[?1049l`) and raw input mode. **Restore (IQW-11)** writes `ESC[?25h` (cursor on), `ESC[?1049l` (leave the alternate screen) and puts the tty back in cooked mode, **on every path the process can catch**:
  - normal quit and `Ctrl-D`;
  - SIGINT and SIGTERM;
  - engine exit;
  - a thrown error or an unhandled rejection;
  - `process.on("exit")`, using a synchronous write to the tty;
  - SIGHUP: restore (it may fail silently if the terminal is gone) and stop the engine (stdin closed, kill after 1 s). **Then the app re-raises SIGHUP, so the OS reports death by SIGHUP (shells show 129) (§17.1 O-4, RULED).** No pin gives SIGHUP a code and there is no generic 128+n rule (§5.11), so no new exit code is pinned, and the app itself never calls `exit(129)`. The receipt and the §5.13 line are written best effort before the re-raise and may fail.
  - **Restore behaviour is independent of the exit code.** Whatever the §5.11 code is, the restore steps above run first, then the §5.12 receipt, then the exit.

  **What cannot be caught:** SIGKILL, and a runtime abort (out of memory, native crash). After either, the terminal can stay in the alternate screen and raw mode. The spec does not claim otherwise. The documented recovery is `reset` (or `stty sane; tput rmcup`), as one line in the M0 runbook (PL-4, M0PLAN:248).
- Flag and config errors are found **before** the app starts, and they print as today on stderr (§6.2, both-TTY gate).
- The app never writes to stdout while it owns the screen. When it leaves, it writes the exit receipt to stderr (§5.12, a required rule).
- **Env values (IQW-12):**
  - `MADC_UI` selects line mode only when it is exactly `lines`. Unset, `""` or any other value counts as unset.
  - `MADC_ASCII` turns on ASCII only when it is exactly `1`. Any other value, `0` and `""` included, counts as off.
  - Neither variable can cause an exit or a new stderr line, so `-p` and doctor bytes and exits cannot change.
  - The app's evidence pane shows `MADC_UI: not recognised (only "lines")` for an unrecognised value. It never echoes the value (CLI:107: "The CLI never puts env values, headers or credentials in the JSON object or on stderr.").

### 5.1 Pre-conversation banner (`01`)

The banner is a single rounded box titled `madc <version>`. On the left: the MADC wordmark and identity lines. On the right: three sections.

| Field | Shown as | Source (M0) |
|---|---|---|
| version | `madc 0.0.0 · protocol madc-m0/1` | `madc --version` shape (CLI:25); `initialize` → `protocolVersion` (PROTO:58) |
| seat id | `madc-default` | Thread `seatId`; default `madc-default` (SEAT:12, SEAT:95; rule PROTO:70) |
| seat sha | `sha256:<12 hex>` of the seat file bytes | doctor `seat` evidence (CLI:130), run read-only at launch |
| backing | `kimi-code · allowed-direct` | seat `preferredBacking` (SEAT:71). The lane comes from the registry re-export used by doctor (CLI:207). There is **no** `provider/list` in M0 (M1PLAN:203). |
| requested | `kimi-coding/kimi-for-coding` | seat `pinnedModel` (SEAT:70) |
| served | `○ awaiting servedModel receipt` until the first receipt | `servedModel` item (PROTO:234). It never guesses from the seat (CLI:78). |
| home | `/home/mike/.madc (MADC_HOME)` or `(default)` | doctor `home` evidence (CLI:129; SEAT:33) |
| cwd | `~/code/madc` | `process.cwd()` (CLI:39) |
| thread | `none yet · starts on send` | `thread/start` is lazy |
| doctor | `✓ 7 PASS · ▲ 1 WARN · 0 FAIL · ○ 2 SKIP` plus `/doctor for rows` | read-only doctor at launch (CLI:119; CLI:202 needs "and the app", P-18) |
| registry | `16 entries`, wired ids, adapters built, counts by policy | doctor `registry` evidence (CLI:133). Counts are derived at run time. |

- Every doctor WARN or FAIL row prints in full under the banner, in its pinned wording (for example `locks`, CLI:132).
- The **"all good" ban** (CLI:142) still holds. The banner states counts and evidence, not a reassurance, and it never shows a green summary line. P-12 records this carve-out.
- **Collapse rule.** The banner collapses to the one-line header:
  - on the first `turn/start`;
  - at launch when the terminal has fewer than 30 rows;
  - on `Ctrl-B`, which toggles it.
- A FAIL at launch keeps the banner expanded and disables input until the user acknowledges it (`Enter`).
- **Launch doctor still running (IQW-6):**
  - The input is editable, but **`Enter` does not send** until every launch row has finished. Each row is bounded by its own check timeout (the engine probe's is 5 s, CLI:121).
  - The input shows `doctor running…` meanwhile, and the typed text is kept.
- **`/doctor` during a turn or a verify does nothing** (IQW4-3: slash commands don't act in those states, and no line is printed). A read of the session mid-append can look like a torn tail (§0.3; A2:61–76), so doctor never reads this thread's file while it is being appended.

### 5.2 Header line (after collapse)

- Left: `MADC  <seat> · <backing> · madc-m0/1 · <cwd> · thread <thr_ed00…8cc4>`.
- Right: `▸ banner Ctrl-B`.
- At 80 columns the header drops cwd.

### 5.3 Transcript rail: the per-turn rule (M0)

Each turn is one rail segment in column 2, with its items indented beside it (`02`–`05`).

| State | Rail | Colour | End line (dim label) | When |
|---|---|---|---|---|
| running | `┆` | warn | none | `turn/started` … `turn/completed` |
| ended, not yet verified | `┆` | warn | `╵ seq ? · UNVERIFIED yet` | after `turn/completed`, before the verify returns |
| verified | `┃` | ok | `┗━ seq <S> · head <12 hex> · chain VERIFIED · turn <n>` | a read-only verify passed **and** the last `turn.end` names this turn (CLI:80, applied per turn) |
| ended, UNVERIFIED | `┆` | warn | `╵ seq <S> · head <12> · UNVERIFIED: <why>` | the verify passed, but the last `turn.end` is not this turn, or the verify could not run |
| chain FAILED | `┃` err from the break down; `╳` at the break | err | `╳ chain FAILED line <N>: <reason>` | the verify failed |
| engine gone mid-turn | `┆` err; `╳` at the end | err | `╳ engine exited · turn not recorded as ended` | `EngineExitedError` (CLI:191) |
| idle timeout (ERR1 §3c) | `┆` err; `╳` at the end | err | `╳ timeout: no engine message for <ms> ms` | ERR1 L171–172 applied to the app (E-b) |

**Rules:**
- **R-a.** After every `turn/completed`, and **before accepting the next input**, the client runs `verifySessionFile` read-only (sdk.ts:36–40) while the engine stays alive. It then remembers `{turnId → [turn.start seq, turn.end seq]}` from `events`.
  - This is a new rule (P-9). Today's pin verifies "after the engine exits" (CLI:79).
  - The read is safe because `turn.end` is durable before `turn/completed` (§0.2), and one-active-turn-per-thread (PROTO:82) stops a new append from starting until the next input.
  - **Deadline (IQW-5).** `verifySessionFile` is synchronous (`readFileSync`, `engine/src/session-store.ts:767, 795`), so in-process it would freeze the screen and could never be timed out.
    - The app runs it in a `node:worker_threads` worker, which is a `node:*` import and so allowed by CLI:201.
    - Deadline: **30 000 ms (proposed).** It reuses the value of `RESPONSE_TIMEOUT_MS`, `oneshot.ts:33`, ERR1 L195.
    - **No pin gives a verify a time limit** (IQW5-1). CLI:79–81 names none. ERR1 L195's 30 000 ms covers only `initialize`, `thread/start` and `turn/start`. The one-shot's verify is a plain synchronous call with no bound (`oneshot.ts:605–607`). So this deadline, and the same bound on the final verify R-g, need P-9. **The final verify is bounded at 30 000 ms (§17.1 O-1, RULED).** On that timeout the turn shows `UNVERIFIED: verify interrupted`, never solid or green.
    - On the deadline, the worker is terminated. The turn ends **UNVERIFIED** with `╵ UNVERIFIED: verify did not finish in 30000 ms` (proposed text), the rail stays dotted warn and the chain pill shows `▲`. Never solid.
    - Input is then re-enabled, and the next turn's verify tries again.
  - **No size bound** is added in M0. A2:98 defers it, and pinning a byte limit is an amendment matter; the deadline bounds the wait instead.
  - The one-shot's post-exit verify (CLI:79) is unchanged.
- **R-b.** Solid means that range was covered by a passing verify.
  - **A later verify failure revokes solid** for every turn whose range contains or follows line N (seq N−1). Those turns turn err.
  - Turns that end before seq N−1 stay solid.
- **R-c.** A torn tail (`kind:"torn-tail"`, A2:61–76; since A3 §2 (L102–149) this also covers a 0-byte file and a tail of only NUL bytes or ASCII whitespace; LEDGER D-210, line 272) shows `╳ torn tail at line N: crash residue, not tamper` in warn, not err. The wording comes from CLI:131. Input stays disabled (repair is M1, CLI:222).
  - **`<N>` (IQW5-3)** is the verifier's `line` value, printed verbatim. It is a 1-based line number (`line: number`, `engine/src/session-store.ts:582`; line N is seq N−1, §0.1). It is never a byte count and never 0. CLI:131 prints the same `line N`. The app never computes it.
  - A3 §2 changes only the kind, and it names no line number (L104–111). At `677332c` the verifier already reports `line: 1` for a 0-byte file (`session-store.ts:612`, still kind `integrity` until the A3 code act). For an unterminated fragment it reports the fragment's own line, which is the number of complete lines plus 1 (`:623`).
  - In A3's own terms (a prefix `P` of complete, verifying lines and a non-empty remainder `R`, L107):
    - (a) a 0-byte file: `line 1`;
    - (b)(i) an unterminated fragment: the line of `R`, that is, the lines in `P` plus 1;
    - (b)(ii) a remainder of only NUL bytes and ASCII whitespace: the first line of `R`, again the lines in `P` plus 1. For example, 6 valid lines followed by `\0\0\0\n` gives `line 7`;
    - a file that is only NULs (A3 L141): `line 1`.
  - These values follow what the code at `677332c` reports for (a) and (b)(i). No pin fixes them. If the A3 code act returns another `line`, the app prints that value.
- **R-d.** Deltas render only on the running turn's dotted rail, and they are display-only (CLI:57). The final text is replaced by the `item/completed` payload (PROTO:98).
- **R-e.** There is no resume in the M0 app (R12 stays M1). Each app launch starts a new thread on its first send.
- **R-f.** Never solid by default, by timeout, or because of a `turn/completed` status. `completed` is a turn status, not evidence.
- **R-g.** When the app exits, one final verify runs after the engine exits (CLI:79, unchanged). Its result is the one the exit receipt and the exit code use (§5.11).
  - **Every exit runs it (IQW5-1).** That includes every quit by a signal, and a quit that arrives while a verify is running (§5.8.1). It is bounded by the R-a deadline.
  - With no thread there is no file, so no verify runs. The one-shot does the same (`oneshot.ts:530`). The case in M0 is `-32009` on `thread/start` (IQW5-2).
  - A signal that arrives while R-g runs is covered by §5.8.1, "A signal during the final verify" (§17.1 O-2, RULED: restore, re-raise, no receipt and no §5.13 line, as in the one-shot).

### 5.4 Items and cards (oh-my-pi style)

| Item (PROTO:143–230) | Render |
|---|---|
| `userMessage` | a `▌ you  <text>` band on the pill background, with an accent edge |
| `toolCall` / `toolResult` | A card on the surface colour, accent2 edge.<br>Title `◆ <tool> <arg>`; right side `<dur> · <item id 8>`.<br>Body `toolCall → toolResult · isError=<b>` plus up to 2 summary lines.<br>`isError=true` switches to an err edge and `✕`.<br>**Never green:** a tool result is not verified evidence. |
| `agentMessage` | `◆ <seat> · agentMessage · item/completed`, then the text wrapped at the rail column |
| `servedModel` | Folded into the end line and the pills. The receipt line is `requested → served (backing)` (CLI:72, 78). |
| `error` (`ErrorItem`: `kind: "error"`, `message`, optional `code`; PROTO:209–213) | An err-edge card: `✕ error` plus ` <code>` when `code` is present (verbatim integer, e.g. `-32009`), then the message after E11 sanitising. Right side: `<item id 8>`. **Never green, and never a verdict by itself.** It arrives alongside a `failed` turn (PROTO:133), and the turn's verdict still comes from `turn/completed` plus the verify. NO_COLOR: `[x error -32009] <message>`. |

**Notification rows (not Items):** `turn/started` (PROTO:78, a notification carrying `{ turn: Turn }`) renders as `○ turn/started turn_… · requested <model>` (dim).

**Honest M0 note.**
- The M0 kimi loop emits no tool items. PROTO:245 maps vendor events to `toolCall`/`toolResult`, and the vendor adapters are A5/A6 (M0PLAN:224–233).
- So the tool card is **specified and built in M0 but illustrative in the mock-ups** until an adapter emits tool items. It must render whatever `toolCall`/`toolResult` arrive, and it must not fake any.

### 5.5 Streaming row

- `● streaming <s>s` in a filled accent pill. `<s>` has one decimal place and updates at ≤5 Hz. There is no spinner (CLI:142).
- The delta text appears on the dotted rail with a static block cursor, and the authoritative `item/completed` text replaces it.

### 5.6 Status pills (bottom row)

| Pill | Source | States: truecolor look → NO_COLOR |
|---|---|---|
| activity | turn lifecycle | `● streaming 2.6s` (filled accent) → `[* streaming 2.6s]`<br>`○ idle · 4.8s` (pill bg) → `[- idle · 4.8s]`<br>`✕ exit 3 · engine` (filled err) → `[x exit 3 · engine]` |
| seat | Thread `seatId` | `madc-default` (filled accent before the first send, pill bg after) → `[madc-default]` |
| served | last `servedModel` item this turn | `○ served: awaiting receipt` (dim) → `[- served: awaiting receipt]`<br>`▲ served: NO RECEIPT yet` (filled warn) → `[! served: NO RECEIPT yet]`<br>`served: kimi-for-coding` (accent2) → `[served: kimi-for-coding]` |
| thread | Thread `id`; `status` verbatim (CLI:223) | `thr_ed00…8cc4` (accent2) → `[thr_ed00…8cc4]`; `○ thread: none yet` |
| chain | last verify result | `○ chain: nothing yet`<br>`seq 6 · ✓ chain VERIFIED` (filled ok) → `[seq 6 · v chain VERIFIED]`<br>`turn 2 ▲ UNVERIFIED yet` (warn on warnbg) → `[turn 2 ! UNVERIFIED yet]` (IQW-14: the turn number is kept)<br>`✕ chain FAILED line 4` (filled err) → `[x chain FAILED line 4]` |
| clock | wall time since launch | dim digits |

Under NO_COLOR, pills become `[text]` with **zero SGR**, bold included (rev 3 aligns the app with IQ-16).

### 5.7 Evidence pane (`02`)

- `Tab` toggles it. It docks on the right at ≥110 columns (width 34), and at 80–109 columns it opens as an overlay.
- **Sections:**
  - SEAT: seat, sha256, backing, requested, served (plus the seq of the servedModel event once verified);
  - THREAD: id, status verbatim, file path;
  - CHAIN: last verify (ok or line N), seq, head (12 hex), per-turn ranges;
  - DOCTOR AT LAUNCH: the rows.
- Every value is either copied from a pinned source or shown as `—`.

### 5.8 Input and key hints

- Input: `❯` with an accent block cursor. Key hints are dim-fill caps (reverse video in 16-colour mode, `[Enter]` in NO_COLOR and ASCII).
- **Keys (M0), normative (IQW-13, IQW4-3, IQW4-4, IQW5-1, IQW5-2, IQW5-4).** In this table, "—" means the key does nothing and shows no line. Every quit in this table runs the final verify R-g, bounded (IQW5-1), except the session-start-failed column, which has no thread to verify.

| Key | idle | turn running | verifying | after chain FAILED | engine stopped | session start failed (`-32009` on `thread/start`, IQW5-2) |
|---|---|---|---|---|---|---|
| `Enter` | send (see input rules) | — | — | — | restart the engine (new engine, new thread) | — |
| `/help` | list these keys | — | — | list | list | — |
| `/doctor` | overlay (§5.9) | — | — | overlay | overlay | — |
| `/receipt` | the last turn's pinned rows | — | — | rows | rows | — |
| `/new` | new thread | — | — | new thread | — | — |
| `Tab` | evidence pane | pane | pane | pane | pane | — |
| `Ctrl-B` | toggle banner | toggle | toggle | toggle | toggle | — |
| `Ctrl-C` key **or external SIGINT** (same behaviour) | quit by interrupt (§5.8.1) | `turn/interrupt` (IQW-4). A second one during the grace forces the stop, then quit by interrupt (IQW5-4) | abandon the verify, then quit by interrupt; the final verify still runs (§5.8.1) | quit by interrupt | quit by interrupt | quit by interrupt (§5.8.1; no verify, no thread) |
| external SIGTERM / SIGHUP | quit by terminate / hang-up (§5.0, §5.13) | the same, after forcing the turn stop (CLI:113 timings) | abandon the verify, then the same; the final verify still runs | the same | the same | the same (no verify) |
| `Ctrl-D` | quit (§5.11) | — | — | quit | quit | quit (§5.11) |
| `Esc` | close overlay or pane | same | same | same | same | — |

- **During a turn and during a verify** (IQW4-3), the input stays **editable**, but `Enter` and every `/word` do nothing and print nothing. The text is kept and can be sent once the state is idle.
- While the launch doctor is still running (IQW-6), `Enter` does nothing; the other keys work as idle.
- **The key-hint bar shows only keys that act in the current state** (IQW4-3). A key whose cell is "—" is never shown.
  - Mock-ups `02` and `08` are corrected: during a turn the bar shows `Ctrl-C interrupt`, `Tab`, `Ctrl-B` (and `Esc` when a pane is open).

#### 5.8.1 Quit by interrupt (IQW4-4, IQW5-1, IQW5-4)

External SIGINT behaves **exactly** like the `Ctrl-C` key in the same state.

**Every quit by interrupt runs the final verify R-g (IQW5-1).** CLI:79–81 put the `session` line after the engine exits, and ERR1 E2 (L276) keeps that order on every signal path of the one-shot: stop the engine, "then re-read and verify the session, then print the receipt". Quitting during a verify is not an exception.
- **Idle, after chain FAILED, engine stopped, and a second `Ctrl-C` or SIGINT during a turn's interrupt grace (IQW5-4):**
  1. If the engine is alive: close its stdin, and kill it if it is still running 1 s later (CLI:112 timings).
  2. Run the final verify R-g, bounded by the §5.3 deadline. In the session-start-failed state (§5.8 column) there is no thread, so no verify runs (R-g).
  3. Restore the terminal (§5.0).
  4. Write the required exit receipt (§5.12) and the §5.13 line.
  5. Exit with the §5.11 code (§17 M-2 (d), RULED): **130** for SIGINT or the `Ctrl-C` key, **143** for SIGTERM, unless the session already recorded a 2, 3 or 5, which stays. In the session-start-failed state the recorded 5 stays, so the exit is 5. If the final verify itself fails after the signal, the exit is **5** (§17.1 O-3, RULED). SIGHUP does not exit with a code: the app re-raises it (§5.0; §17.1 O-4, RULED).
- **Verifying** (the first `Ctrl-C` or SIGINT arrives while the per-turn verify R-a runs):
  1. Abandon the in-progress verify: terminate its worker. Its result is never used.
  2. Stop the engine as above.
  3. Run **one** final verify R-g, bounded at 30 000 ms (§17.1 O-1, RULED; no pin gives a verify a time limit, so P-9 carries it, §5.3 R-a).
  4. Draw the turn from that result:
     - **It passes and the last `turn.end` names the turn** (CLI:80): that is verified evidence. The turn's segment may turn solid `┃`, with its `┗━ … chain VERIFIED` end line, before the restore. The receipt's `session` line reads `chain VERIFIED`. No COMPLETED verdict is shown, because the exit is not 0 (§6.2: the turn word `COMPLETED` is green only with exit 0).
     - **It passes, but the last `turn.end` is not this turn:** `UNVERIFIED: <why>`, dotted warn, as in the §5.3 table.
     - **It fails:** the rail breaks red at line N (R-b), and the receipt shows `chain FAILED line N: <reason>`. Class 5 is recorded (CLI:193). **The exit is that 5, not 130/143 (§17.1 O-3, RULED).** The broken chain must not be hidden behind "interrupted", which is consistent with M-2 (d): a signal never replaces a recorded 5. The §5.13 line is `madc: interrupted (<SIGINT|SIGTERM>)` / `exit 5`. This deliberately differs from the one-shot, whose pinned ladder puts the signal first (ERR1 L233, L245; `oneshot.ts:545–553`).
     - **It times out or does not finish:** the 30 000 ms bound (§17.1 O-1, RULED) ends it, the turn shows `╵ UNVERIFIED: verify interrupted` (proposed text), and so does the receipt's `session` line. It is never drawn solid or green.
     - **A torn tail:** R-c.
  5. Restore, write the receipt and the §5.13 line, and exit with the §5.11 code: 130 (143 for SIGTERM) unless a 2, 3 or 5 was recorded before the signal (§17 M-2 (d), RULED). If step 4 found the failure, the exit is 5 (§17.1 O-3, RULED).
- **A signal during the final verify** (while R-g runs or the exit output is written). **RULED (§17.1 O-2):** for M0 this path deliberately copies the one-shot's F-102 gap (LEDGER D-203, line 84), so the app and `-p` behave the same. This covers a second `Ctrl-C` or SIGINT after a quit by interrupt has started, a SIGTERM or SIGHUP, and a first `Ctrl-C` or SIGINT after `Ctrl-D`. The app does what the one-shot does in the same window.
  - The one-shot removes its signal listeners before its final verify (`oneshot.ts:476–477`). A signal after that "gets default handling", and "The window is the session verify plus the output writes" (ERR1 L427, F-102; LEDGER D-203, line 84). The signal is not held or ignored, and the verify does not finish.
  - The app:
    1. restores the terminal synchronously (§5.0). The one-shot owns no screen, so it has no such step;
    2. removes its own handler for that signal and re-raises it, so the process ends by the signal's default action, as the one-shot's does.
  - No receipt, no §5.13 line and no app-chosen exit code follow. The shell reports death by that signal.
  - F-102 is a named residual owned by the M1 CLI act (ERR1 L46, L427). If that act changes the one-shot, this path follows it.
- **The exit code is never better than the worst recorded code on the §5.11 ranking** (by exit code, not by what the screen shows). It is never 0 after a signal, a signal never replaces a recorded 2, 3 or 5, and the receipt includes the worst turn (§5.12).

  `/seat` is **not** in M0 (no `seat/list`, M1PLAN:203).
- **Input rules (IQW-9):**
  - **Empty:** input that is empty after `trim()` (the one-shot's test, `main.ts:94`) is not sent. `Enter` does nothing, and no `turn/start` is ever sent empty (CLI:35).
  - **Over 1 MiB:** input over 1 MiB of UTF-8 (CLI:34; `main.ts:91` "prompt exceeds 1 MiB") is not sent. The input line shows a warn `▲ prompt exceeds 1 MiB; not sent`, and the text is kept for editing.
  - **Unknown `/word`:** shows a dim `unknown command /<word> · /help` and is not sent to the engine. A line starting `//` sends a literal `/…` with one slash removed.
- **Interrupt (IQW-4)** reuses the one-shot's pinned timings (CLI:111–112; `INTERRUPT_GRACE_MS = 2 s`, `KILL_AFTER_MS = 1 s`, `oneshot.ts:34–35`):
  - `Ctrl-C` during a turn, or an external SIGINT, sends `turn/interrupt` (PROTO:77) and waits up to 2 s for `turn/completed`. If it arrives, the segment ends `╵ interrupted`, the verify runs, and the app stays open.
  - If the grace runs out: close the engine's stdin, and kill it if it is still running 1 s later. The segment ends `╳ interrupt not answered in 2 s · engine stopped`, and the state becomes **engine stopped**, recorded as class 3 ("timeouts", CLI:191). The session is verified after the engine exits (like CLI:79).
  - A **second** `Ctrl-C` or SIGINT during the grace (IQW5-4) forces the same stop (CLI:112: close stdin, kill after 1 s), then the app quits by interrupt (§5.8.1). The `Ctrl-C` key counts as SIGINT here, as everywhere.
    - The forced stop records no class of its own; it is not the class-3 "grace runs out" case above. This matches the one-shot, where "A forced signal records nothing" (ERR1 L228).
    - The final verify R-g runs after the engine exits. The one-shot does the same after a second SIGINT (ERR1 L276; `oneshot.ts:528–544` runs whenever a thread exists).
    - Then the restore, the §5.12 receipt, and the §5.13 line `madc: interrupted (SIGINT)` / `exit <n>`.
    - `<n>` is **130**, unless the session already recorded a 2, 3 or 5, which stays (§5.11; §17 M-2 (d), RULED, Michael, 2026-09-26 08:54 Nassau, relayed by Surface Architect). It is never 0. If the final verify fails after the signal, `<n>` is 5 (§17.1 O-3, RULED).
    - SIGTERM does the same and quits by terminate: **143**, under the same rule (CLI:111–113, CLI:194; §17 M-2 (d), RULED). SIGHUP is re-raised after the restore and the engine stop, so the OS reports it; the app picks no code (§17.1 O-4, RULED).
- **After an error (IQW-18):**
  - **Seat error on `thread/start`** (err card, no thread): input is re-enabled, and the next send retries `thread/start` on the same engine (the user may have fixed the seat, e.g. `madc doctor --init` elsewhere). The error still counts for the exit (§5.11).
  - **Provider error** (FAILED card; the turn is recorded `failed`): input is re-enabled, and the next send **reuses the same thread**. Turns are sequential (PROTO:82).
  - **Chain FAILED or torn tail:** disabled until `/new` (Q5).
  - **Engine stopped** (exit, violation, idle timeout, unanswered interrupt): `Enter` restarts the engine with a new thread, and `Ctrl-D` quits.
  - **Session start failed: `-32009` on `thread/start`** (IQW5-2; A3 L254, for example a `sessions/` without owner read; LEDGER D-214, line 274). This is a session-level startup failure, not a turn failure. There is no thread, no turn and no session file: A3 L254 has the error come "before creating the session file".
    - Rule: **input is disabled for the rest of the session, and only the quit keys act** (`Ctrl-D`, `Ctrl-C` or SIGINT, SIGTERM, SIGHUP; see the §5.8 column).
    - Unlike a seat error, it is not retried: no later send is taken.
    - The key-hint bar shows `Ctrl-D quit` and `Ctrl-C quit`.
    - What is drawn: §7, row "Session `-32009` on `thread/start`".
- While a verify runs, the input shows `verifying…` (bounded, §5.3 R-a).

### 5.9 Overlays

- **`/doctor`** (`06`): a centred box, at most 96 columns wide. It re-runs doctor read-only and streams rows as they finish (CLI:120). The format is §8, and `Esc` closes it.
- **Terminal too small**: see §3.4.
- There is no `/seat` overlay in M0.

### 5.10 Engine text and engine stderr

- **Sanitising:** all engine-supplied text drawn by the app goes through ERR1 E11 (L319–321). That includes agent text, deltas, tool fields and error messages. E-a extends E11's scope from the one-shot to the app.
- **Engine stderr (blocker, P-6).**
  - `spawnEngine` hardcodes `stdio: ["pipe","pipe","inherit"]` (`engine/src/client.ts:212, 229`; CLI:48; PROTO:39). So anything the engine or a vendor child writes to stderr lands on the app's alternate screen and corrupts the layout.
  - PROTO:27 says engine stderr is "logs only", but it does not say how often they appear (unverified).
  - The fix is an additive client option (for example `stderr: "pipe"`), with the app showing stderr lines in the evidence pane as dim `engine stderr:` rows.
  - That is an engine-client change, which CLI:208 and ERR1 L148 (allowance A1) forbid outside E1. So it needs a **Founder allowance** (P-6).
  - **Granted (§17 M-1, RULED, Michael, 2026-09-26 08:54 Nassau, relayed by Surface Architect; pin W-1):** a narrow stderr allowance **for the new app act only** (§12.4 option 4). Engine stderr is passed through the engine client (the additive option above). There is no new protocol method and no engine behaviour change.
  - Inline mode below was specified for a denial. The allowance was granted, so **inline mode is not the M0 path**. Its text and mock-up `12` are kept for the record only.
  - **If the allowance had been denied (IQW-15): inline mode.** The app still runs, with the Witness look, but it is **append-only on the normal screen**:
    - no alternate screen, no cursor movement above the current line, no fixed bottom bar, no in-place status repaint (`\r` redraw), and no screen clear;
    - the banner prints once;
    - items print as they complete: cards, `◆` rows, and the dotted `┆` rail prefix;
    - deltas append on the current line;
    - after the verify, the segment's end line (`┗━ … chain VERIFIED` or `╳ …`) and the verdict card print below;
    - the pills print as **one status line after each turn**, not as a fixed bar;
    - the prompt is a plain `❯ ` line;
    - `Tab` prints the evidence block, and `/doctor` prints the rows.
    - Because inherited engine stderr goes straight to the terminal, it lands in the scrollback wherever it is written. The app **never draws over, clears or hides it**.
    - **Honest limit:** inherited bytes cannot be detected, so the app cannot label them. Before the first turn, the banner prints one dim line: `engine stderr is shown as-is, unlabelled, between app lines`.
    - The rail is never repainted in inline mode. Dotted rows stay dotted in the scrollback, and only the end line carries the verified state. That is never a false solid.
    - Line mode (tier A) stays available via `MADC_UI=lines`. Mock-up: `12`.

### 5.11 App exit codes (P-15; IQW-2; ruled by §17 M-2)

**Rule (IQW-2, ruled by §17 M-2, Michael, 2026-09-26 08:54 Nassau, relayed by Surface Architect): the app exits with the worst code recorded in the session, ranked the way the one-shot ranks them.**
- Only the pinned codes are used: CLI:188–194 (0 ok, 1 turn failure, 2 usage/config, 3 engine, 4 provider, 5 session, 130/143 signals) and `exit-codes.ts:6–15`. **No new code is invented** (IQW4-2): no 129, and no code for SIGHUP. SIGHUP is re-raised after the restore and the engine stop, so the OS reports it (shells show 129); the app itself never calls `exit(129)` (§17.1 O-4, RULED).
- **Worst means by exit code, not by what the screen shows.** The ranking is the one-shot's, ERR1 §3d (L235–245), without its signal tier: `3 > 2 > 5 > 4 > 1 > 0`, over **every** event in the session, not just the last turn.
  - In particular, a 5 replaces only 0, 1 or 4, and an existing 2 or 3 stays (ERR1 L232; ERR1 §3d L245; ledger D-196 (LEDGER line 268); `oneshot.ts:532–543` at `677332c`).
- **UNVERIFIED (M-2 (a)).** An UNVERIFIED turn counts with the exit its turn ended with, usually 0. CLI:81: "`UNVERIFIED` does not change a success exit, but it is never shown as success." It is still **never shown as success**: dotted warn rail, warn card with no art, no `COMPLETED` (§5.3, §7).
- **Signals (M-2 (d)).** A quit by SIGINT (including the `Ctrl-C` key outside a turn, and a second `Ctrl-C` or SIGINT during a turn's interrupt grace, IQW5-4) exits **130**. A quit by SIGTERM exits **143** (CLI:111–113, CLI:194; `exit-codes.ts:13–14`).
  - **A signal never replaces a recorded 2, 3 or 5.** It does replace a recorded 0, 1 or 4. So the exit is never 0 after a signal, and the §5.12 receipt always includes the worst turn.
  - This **deliberately differs from the one-shot**, where the signal wins over everything (ERR1 §3d L233, L237, L245; ledger D-196, LEDGER line 268; `oneshot.ts:545–553`). Michael ruled the difference on purpose.
  - The app's effective ladder is therefore `3 > 2 > 5 > 130/143 > 4 > 1 > 0`.
  - **A final verify that fails after the signal arrived** exits **5**, not 130/143 (§17.1 O-3, RULED). The §5.13 line is then `madc: interrupted (<SIGINT|SIGTERM>)` / `exit 5`. Like the rest of M-2 (d), this deliberately differs from the one-shot (ERR1 L233; `oneshot.ts:545–553`).
  - **SIGHUP** gets no app code: after the best-effort restore and engine stop, the app re-raises SIGHUP so the OS reports it (§17.1 O-4, RULED). No new code is pinned, and the app never calls `exit(129)`. A 2, 3 or 5 recorded earlier is not reflected in the exit status on SIGHUP; this follows from the ruling (the process ends by the signal). The receipt, if it can be written, still shows the failure.
- **In-app interrupt (§17.1 O-5, RULED).** A turn the user interrupted in-app (`Ctrl-C`, answered, verified), followed by a normal quit, counts as **0** for that turn. No signal ended the process: 130 would say it was killed, and 1 is for an interrupt the CLI did not ask for (ERR1 E4 L285). The turn is still shown INTERRUPTED, never as success. Other turns' codes still rank normally.
- **No turns (M-2 (c)).** A session with no turns exits **0** if the final chain check at close passes, and **5** if it fails.
  - A session-level code recorded without a turn ranks like any other event (IQW-2, above). The case in M0 is `-32009` on `thread/start` (IQW5-2), which records 5, so it exits 5. A seat error on `thread/start` records 2.
  - With no thread, no final check runs (R-g; `oneshot.ts:530`). Such a session exits **0**: nothing was written, and there is nothing to verify (§17.1 O-6, RULED). The chain pill stays `○ chain: nothing yet`, never green. A no-turn session with a recorded code still follows the ranking (`-32009` gives 5, a seat error gives 2).

| Event (any time in the session) | Code | Pinned source |
|---|---|---|
| A turn ended `failed` with a non-classed error | 1 | CLI:189 |
| A turn failed with `-32007`/`-32008` (FAILED card) | 4 | CLI:192; `exit-codes.ts` `classifyCode` |
| Seat error on `thread/start` (`-32005`, `-32006`, `-32602`), even if a later retry succeeded | 2 | CLI:190 |
| Engine lost: exit, protocol violation (E-d), idle timeout (§7), unanswered interrupt (§5.8), request timeout, even if restarted | 3 | CLI:191; ERR1 L172, L195 |
| A thrown, unclassified error inside the app | 3 | the one-shot's catch-all maps it to `engine` (`oneshot.ts:463–464`) |
| `-32009`, or the final verify (R-g) FAILED, or a torn tail. This includes `-32009` on `thread/start` (IQW5-2). It replaces only 0, 1 or 4 | 5 | CLI:193; `exit-codes.ts:57–58` (class 5 at every site); ERR1 L232, L240; ERR1 §3d (L245); ledger D-196 (LEDGER line 268) |
| A turn that ended **UNVERIFIED** | the exit its turn ended with (usually 0); never shown as success | CLI:81; §17 M-2 (a), RULED |
| A turn the user interrupted in-app (`Ctrl-C`, answered, verified), then a normal quit | 0 for that turn; shown INTERRUPTED, never as success | ERR1 E4 L285 (1 is for an interrupt the CLI did not ask for); §17.1 O-5, RULED |
| Quit by SIGINT (or the `Ctrl-C` key when not in a turn, or a second `Ctrl-C` or SIGINT during a turn's interrupt grace, IQW5-4) | **130**, unless a 2, 3 or 5 was recorded, which stays | CLI:111–112, CLI:194; `exit-codes.ts:13–14`; §17 M-2 (d), RULED |
| Quit by SIGTERM | **143**, unless a 2, 3 or 5 was recorded, which stays | CLI:113, CLI:194; §17 M-2 (d), RULED |
| The final verify (R-g) fails after a signal was received | **5** (not 130/143) | CLI:193; §17 M-2 (d); §17.1 O-3, RULED (differs from the one-shot, ERR1 L233) |
| Quit by SIGHUP | 129 via re-raise (OS-reported; not a pinned app code; §17.1 O-4 RULED) | No pin names SIGHUP, and none defines signal exits generically (no 128+n); the app never calls `exit(129)` |
| No turns, and the final chain check at close passes / fails | 0 / 5 | §17 M-2 (c), RULED |
| No turns and no thread (no final check runs) | 0; the chain pill stays `○ chain: nothing yet` | `oneshot.ts:530`; §17.1 O-6, RULED |
| Every turn ended `completed` (UNVERIFIED allowed, CLI:81), nothing above 0 was recorded, and the final verify did not fail | 0 | CLI:188, CLI:80–81 |

**Ruled in rev 6.2 (§17.1; Michael, 2026-09-26 10:51 Nassau):** the four cases that rev 6 left open in this section now have rows above:
- a turn the user interrupted in-app, then a normal quit: 0 for that turn (the old M-2 (b); §17.1 O-5);
- a final verify that fails after a signal was received: 5 (§17.1 O-3);
- SIGHUP: re-raised, so the OS reports it; no app code (§17.1 O-4);
- a session with no turns and no thread: 0 (§17.1 O-6).

P-15 can pin every row now. T26-style tests for these four rows are still to be written.

### 5.12 Exit receipt (required; IQW-17)

**Rule (IQW-17, required, testable):**
- When the app has restored the terminal (§5.0) and **at least one `turn/start` was sent**, it writes to stderr, **in one write**:
  1. the receipt block of the **last** turn;
  2. if the session's worst code (§5.11, by exit code, not by what the screen shows) belongs to a different turn, that turn's receipt block as well, after the last one. On a tie, the later turn's block (proposed). This also applies when a signal decides the code (IQW4-4). An UNVERIFIED turn that ended 0 is not the worst turn on that ground alone (§17 M-2 (a)).
- **Bytes:**
  - Each block uses the one-shot receipt bytes (`oneshot.ts:631–675`; CLI:67–82).
  - The `session` line comes from the final verify (R-g).
  - The `exit` line carries the app's exit code.
  - SGR follows §6.2 under the both-TTY gate (always met, because the app needs three TTYs, IQW-1).
  - Tier W adds no card here. The scrollback gets plain Level A rows.
- **If no `turn/start` was sent,** it writes nothing, except for the §5.13 line. That includes a session that ends after `-32009` on `thread/start` (IQW5-2): the pinned receipt prints only "after `thread/start` succeeds" (CLI:67).
- **One exception to "required":** a signal while the final verify or this write runs ends the process by the signal's default action (§5.8.1, ERR1 L427). No receipt is guaranteed on that path. Michael ruled that the app keeps this path for M0 (§17.1 O-2, RULED); it is the known gap F-102 (LEDGER D-203), owned by the M1 CLI act.
- **Test:** for each §5.11 row, the captured stderr after restore equals the expected receipt block(s) byte-for-byte (SGR stripped when checking text).

### 5.13 Signal exit line (IQW-10)

- When the app exits on a signal (SIGINT or the `Ctrl-C` key outside a turn, a second `Ctrl-C` or SIGINT during a turn's interrupt grace (IQW5-4), SIGTERM, SIGHUP), after the restore and after the §5.12 receipt(s), it writes: `madc: interrupted (<SIGINT|SIGTERM|SIGHUP>)` + `\n` + `exit <n>`, where `<n>` is the §5.11 code (§17 M-2 (d), RULED): 130 for SIGINT or the `Ctrl-C` key, 143 for SIGTERM, or the recorded 2, 3 or 5 that a signal never replaces (so `madc: interrupted (SIGINT)` / `exit 5` is a valid pair). If the final verify failed after the signal, `<n>` is 5 (§17.1 O-3, RULED), so `madc: interrupted (SIGTERM)` / `exit 5` is also a valid pair. For SIGHUP the app writes only the first line, `madc: interrupted (SIGHUP)`, with no `exit <n>` line, because the app picks no code (rev 6.2 design reading of §17.1 O-4). The write is best effort and may fail silently. Then the app re-raises SIGHUP, so the OS reports the signal (§17.1 O-4, RULED). A 2, 3 or 5 recorded earlier is not carried in the exit status on this path, which follows from the ruling; the §5.12 receipt, when it can be written, still shows that failure in full and is never softened. This is the same two-line shape as the pre-thread lines (`oneshot.ts:594`).
- **Row (RQ-3), both-TTY gate:** `madc: interrupted (…)` is `33` (the INTERRUPTED role, §6.2). On the `exit` line, the label is uncoloured and the digits are `1;31` (IQ-4).
- The `Ctrl-C` key prints `(SIGINT)`, because it behaves as SIGINT (§5.8.1).
- The line is **not** written on the §5.8.1 path "A signal during the final verify", which ends by the signal's default action (ERR1 L427).
- NO_COLOR: zero SGR.

---

## 6. `madc -p` and `madc doctor` in M0

**Unchanged in every tier:**
- non-TTY and `--json` bytes (CLI:64–65, 86–107, 233);
- exit codes (CLI:184–197);
- the **text** of the status line `… <seatId> · <s>s` (`oneshot.ts:379`; IQ-18);
- the status clear `\r\x1b[K` (`oneshot.ts:249`; IQ-14);
- the receipt text (`oneshot.ts:631–675`);
- the pre-thread lines (`oneshot.ts:593–595`);
- the parse-error and usage lines (`main.ts:24–26, 53`);
- the doctor row text (CLI:152–165).

### 6.1 Tier W: `madc -p` (`07`, `05` bottom)

- **Streaming status:** the same text and cadence (`oneshot.ts:377–380`: 200 ms, gate `stream && stderrIsTTY`, with `stream = stdoutIsTTY && !json` at `:203`), drawn as a filled accent pill. **Existence gate (IQW-16):** the status line exists only when stdout **and** stderr are TTYs and there is no `--json`, as main already does. CLI:63's row says only "stdout TTY", so **P-19** amends CLI:63's condition to match the code and RQ-1. The pin text changes; no byte changes.
  - It adds only SGR around the unchanged text. The clear is unchanged.
  - The status-line colour is new in M0 (P-7), and Q2 is closed by the ruling.
- **Verdict card** (stderr, one write, printed where today's receipt prints). Top to bottom:
  1. **Title row:** `▌ ✓ chain VERIFIED · exit 0`, or `▌ ✕ <class/cause> · exit <n>`, or `▌ ▲ UNVERIFIED · exit 0`.
  2. **Big verdict** (6-row ANSI-Shadow art; `#### WORD ####` in ASCII):
     - `COMPLETED` only if chain VERIFIED **and** exit 0;
     - `FAILED` for a failed turn or chain FAILED;
     - `EXIT <n>` for any other exit ≠ 0, including 130/143;
     - an UNVERIFIED exit 0 gets **no** big art; the card is titled `UNVERIFIED` in warn.
  3. **The pinned receipt rows, verbatim.** Each row is prefixed with `▌` in the card's role colour on the tint, and the §6.2 spans become the §3.1 roles.
- **Pinned rows are never re-wrapped.** A row wider than the terminal is soft-wrapped by the terminal at column 0, with no edge and no added bytes (`05`).
- **Failure cards** are the same height and art size as COMPLETED (hard rule 7).
- The **80-column** card fits the COMPLETED art (77 columns) plus the edge.

### 6.2 Tier A (Level A fallback; normative): `madc -p`, line-mode app, pre-app lines

*Rev 2 §6 unchanged in substance. It now applies only to tier A. The gates follow §3.3, which is RQ-1.*

**Byte rules:**
- Only `ESC[<code>m … ESC[0m` spans are added around the tokens below (plus the in-span `ESC[0;31m` for chain FAILED). **No other byte changes.**
- Padding is computed on the plain text. The SGR wraps the word, and pad spaces go outside it.
- **`ESC[0m` always comes before the `\n`** that ends a line (IQ-7).
- Each coloured span is written in the **same single write** as the rest of its line: the receipt is one write (`oneshot.ts:590`), the pre-thread lines are one write (`:593–595`), and each doctor row is one write (`doctor.ts:858`) (IQ-19).

**Receipt tokens:**

| Token (receipt line) | Condition | SGR |
|---|---|---|
| turn word `COMPLETED` | chain VERIFIED **and** exit 0 | `1;32` |
| turn word `COMPLETED` | anything else | `33` |
| turn word `FAILED` | — | `1;31` |
| turn word `INTERRUPTED` | — | `33` |
| turn word `NOT STARTED` | — | `31` |
| **any other turn word**: `INPROGRESS` (`oneshot.ts:646`; ERR1 E16 L345), `UNKNOWN` (ERR1 E17 L367), any verbatim non-terminal status | — | `33`, never green (IQ-8) |
| `NO RECEIPT` | — | `1;33` |
| `chain VERIFIED` | — | `32` |
| session value `chain FAILED line N: <reason>` | whole value red; the words `chain FAILED` bold | `ESC[1;31m` `chain FAILED` `ESC[0;31m` ` line N: <reason>` `ESC[0m` (IQ-3) |
| `UNVERIFIED: <why>` (any `seq … · head … · ` prefix uncoloured) | — | `33`, never green (IQ-8) |
| **the whole error row** ` error    <class> <code>: <msg>`, including the `error` label | — | `31` (IQ-2) |
| **error row carrying a chain failure** ` error    session: chain FAILED line N: <reason>` (`oneshot.ts:538–542`: `fail(…, "session", null, \`chain FAILED line ${line}: ${reason}\`)` at :541) | **RQ-2:** the same in-span form as the session value | `ESC[31m` ` error    session: ` `ESC[1;31m` `chain FAILED` `ESC[0;31m` ` line N: <reason>` `ESC[0m` |
| exit digits | `0` with chain VERIFIED | `32` |
| exit digits | `0` otherwise | none |
| exit digits | ≠0, including the whole `130` or `143` | `1;31`, never green (IQ-4) |
| head hash (12 hex) | only when chain VERIFIED, or UNVERIFIED with a seq | `36` |
| rule `─ receipt ─…`; labels `turn`/`model`/`session`/`exit`; turn id; duration; model line; session path | — | none |

**RQ-2 in tier W:** the same structure applies. In the error row and the session value, `chain FAILED` is err+bold and the rest of the value is err, so a chain failure looks the same wherever it appears (`04`) and is never softer than the rest of its row.

**Other stderr lines** (all take the both-TTY gate, RQ-1):

| Line | SGR |
|---|---|
| Pre-thread message line `madc: <class> error <code>: <msg>` (`oneshot.ts:594`) | whole line `31` (IQ-5) |
| Pre-thread `exit <n>` line (`oneshot.ts:594`) | label uncoloured; digits `1;31` (IQ-5) |
| Parse-error lines `madc: <message> (see madc --help)` for **any** command, including `madc doctor x` → `madc: unexpected argument x (see madc --help)` (`args.ts:89` → `main.ts:26`) | `31`, not bold (IQ-6, RQ-1) |
| `CHAT_RESERVED` (`main.ts:25`), printed only in tier P for `madc "<text>"` (§5.0) | `31`, not bold, when the gate passes (it cannot pass on the tier-P path, so in practice it prints plain) |
| `madc: <message>` via `usageFailure` (`main.ts:53`) | `31`, not bold (IQ-6) |
| Usage or help text (`USAGE` at `main.ts:24`; `--help` at `main.ts:21`) | none (IQ-6) |

### 6.3 Line-mode app lines (tier A and zero-SGR line mode)

| Line | Text (proposal) | SGR |
|---|---|---|
| identity (once) | `madc <version> · <protocol> · <seatId> · line mode (<why>)`, where `<why>` is `72×20 < 80×24`, `TERM unset`, `MADC_UI=lines` or `no VT` | none |
| prompt | `> ` | none |
| agent text | stdout, verbatim after E11 sanitising | none |
| per-turn receipt | the §6.2 receipt bytes and spans (stderr) | §6.2 |
| doctor at launch | only WARN/FAIL rows, in doctor.ts bytes, on stderr | §6.2 doctor rules |

### 6.4 Rows for ERR1 messages that go through `usageFailure` (proposed; RQ-3)

All of these print `madc: <message>` via `usageFailure` (`main.ts:53`), exit 2, and take the both-TTY gate. SGR is `31`, not bold, like the rest of the `main.ts:53` family.

| Message | Where it is pinned | Where it is coded | Row |
|---|---|---|---|
| `madc: current directory is not accessible (<code>)` (**F-130**) | ERR1 L354 @df2e22d (E16 table): "one-shot exits 2 with `madc: current directory is not accessible (<code>)`" | **Local, unpushed** A7 follow-up branch `hephaestus/m0-a7-followup-validation` @ `71b40f0` (`/workspace/madc/p0`): `packages/cli/src/main.ts:146–155`, `usageFailure(io, json, "current directory is not accessible (<code>)")`; test `cli.test.ts:2214, 2249`. **Not on the remote** (`git ls-remote` shows no such branch), so the code cite is unverified against GitHub. | whole line `31`, not bold; no receipt; the app shows it before starting (plain in tier P) |
| `madc: cannot read prompt from stdin (<code>)` (F-110) | ERR1 L350 | not checked in code | same |
| `MADC_HOME … is a symlink loop` / `… cannot be read (<code>)` (E18) | ERR1 L375–383 | not checked in code | same |

### 6.5 General rule for stderr lines with no row (RQ-3)

- **A stderr line with no row in this spec prints uncoloured by default**, in every tier.
- **Any new line that reports a failure or a warning needs a spec row before it ships.** If it shipped uncoloured, it would be quieter than success (hard rule 7).
- Surface sends such lines to Iris, and Iris adds the row. Lines that are purely informational (help, usage) stay uncoloured and need no row.

### 6.6 Tier W: `madc doctor` → §8. Tier A: doctor Level A

*Unchanged from rev 2.*
- Status word colours: PASS 32, WARN 33, FAIL 31, SKIP 2, INIT 36, word only, not bold (`doctor.ts:837–849`).
- RESULT line (`doctor.ts:898–900`, CLI:146):
  - `<f> FAIL` is `1;31` when f>0;
  - `<w> WARN` is `33` when w>0;
  - `exit <code>` is `1;31` when ≠0, `32` only when it is 0 with 0 FAIL and 0 WARN, and `33` when it is 0 with WARNs (IQ-10).
- Long rows soft-wrap at column 0, with no bytes added.

---

## 7. Failures and exit codes

**Verdict rules (W cards and app):**
- the big word is `COMPLETED` only on chain VERIFIED **and** exit 0;
- otherwise `FAILED` or `EXIT <n>`;
- UNVERIFIED with exit 0 gets a warn card and no art;
- every card lists the pinned rows verbatim.

The tier A column is §6.2.

| Case | Exit | `-p` tier W | `-p` tier A (§6.2) | M0 app |
|---|---|---|---|---|
| Completed, chain VERIFIED | 0 (CLI:188) | ok card, `COMPLETED` art (`07`) | COMPLETED `1;32` | rail solid, COMPLETED card (`03`) |
| Completed, UNVERIFIED | 0 (CLI:81) | warn card `UNVERIFIED`, no art | COMPLETED `33`; UNVERIFIED `33` | dotted rail with warn `╵`; chain pill `▲`. The turn counts with its own exit, usually 0, and is never shown as success (§5.11; §17 M-2 (a), RULED) |
| Turn failed | 1 (CLI:189) | err card `FAILED` | FAILED `1;31`; error row `31` | FAILED card. The rail follows the chain: it may be solid, because the failure was recorded and verified. |
| Usage: bad flags (any command, including `madc doctor x`) | 2 (CLI:190) | plain `madc: <message> (see madc --help)` in `31` (both-TTY gate) (`main.ts:24–26`) | same | printed before the app starts |
| `madc "<text>"` or `madc` when not a full TTY | 2 | today's `CHAT_RESERVED` / `USAGE` bytes (`main.ts:24–25`) | same | — (the app does not start) |
| Config before spawn (`MADC_HOME`, prompt size, F-110, F-130, E18) | 2 (CLI:190) | `madc: <message>` `31` (`main.ts:53`; §6.4) | same | printed before the app starts |
| Seat errors on `thread/start` (`-32005`, `-32006`, `-32602`) | 2 | pre-thread lines, message `31`, digits `1;31` (`oneshot.ts:593–595`) | same | err card, no thread; input re-enabled, the next send retries `thread/start` (IQW-18); class 2 counts |
| Engine spawn, exit, protocol mismatch or violation | 3 (CLI:191) | `EXIT 3` card, error row err | error row `31`; exit `1;31` | engine-gone `╳`; `EXIT 3` card (`05`). **Violations in the app (IQW-7, IQW4-1)** are exactly the checks ERR1 §3b itself calls violations:<br>- **rule 2** (L133): every check in the CLI at `343da29` stays exit 3 (non-JSON or non-object line, `protocolVersion`, `thread/start` id grammar, `turn/start` result shape, malformed or foreign deltas and items, `turn/completed` for this turn, the `servedModel` disagreement);<br>- **rule 4 N2–N7** (L135–144): N2 id and method, N3 neither, N4 other malformed, N5 `thread/started`/`turn/started`/`item/started` shapes, N6 `servedModel` backing, N7 handshake and `thread/start` result;<br>- **rule 7** (L147): an id-carrying `turn/completed` is N2, never the end of a turn.<br>These are checked live on arrival (rule 5, L145) and re-checked at each turn's end before the verify (rule 6, L146), bound to the app's current connection, thread and turn.<br>**Not violations, and ignored exactly as ERR1 says:**<br>- **N1**, a well-formed unmatched response (rule 3, L134: "ignored in M0 (residual; not a protocol violation)"; tests L154–155 expect exit 0);<br>- an unknown notification (rule 1, L132).<br>Neither changes the screen or the exit class, and neither resets or extends the request timeout or the idle clock.<br>A violation stops the engine (stdin closed, kill after 1 s) → engine stopped. This needs E-d. |
| Provider `-32007`/`-32008` | 4 (CLI:192) | FAILED card with the reason | error row `31` | FAILED card; `no-credentials` hint (CLI:134); input re-enabled on the same thread (IQW-18); class 4 counts |
| Session `-32009` during a turn (data `{ threadId, path, seq }`, PROTO:124) | 5 (CLI:193) | `EXIT 5` card | error row `31` | err rail from `data.seq` (PROTO:124) |
| Session `-32009` on `thread/start` (A3 L254: a `sessions/` without owner read fails `-32009` before the file is created; doctor WARNs on `locks`, A3 L255; LEDGER D-214, line 274) | 5 (CLI:193; `exit-codes.ts:57–58`; ERR1 L240) | pre-thread lines `madc: session error -32009: <message>` / `exit 5`, message `31`, digits `1;31` (`oneshot.ts:589–595`: no thread, so no receipt and no verify, `:530`) | same | **A session-level startup failure, not a turn failure (IQW5-2).** No rail segment and no turn. The banner stays expanded, because no `turn/start` was sent (§5.1).<br>A full-width err card in the frame `05` style: the err role, a `▌` edge on the errbg tint, and the glyph `✕` (ASCII `x`). Top to bottom:<br>1. the title `✕ session error -32009 · exit class 5`;<br>2. a big `EXIT 5`, the same size as COMPLETED (hard rule 7; `#### EXIT 5 ####` in ASCII);<br>3. the engine's `message`, verbatim after E11 sanitising. A3 L254 requires the message to name the cause; its example, `sessions/ is not readable by its owner (mode 0300 is unsupported in M0; use 0700)`, is not pinned bytes;<br>4. one plain reason line (proposed): `the session file could not be created, so nothing was recorded`;<br>5. a hint (proposed): `run madc doctor: its locks row shows the sessions/ mode`. The WARN text is A3 L255: `sessions/ mode <mode>: unsupported in M0 (needs owner read for directory fsync)`. Once the A3 code act is built, the launch doctor already prints that row under the banner (§5.1). The CLI pin has no pointer to that text yet (LEDGER D-216, line 91).<br>There are no receipt rows, because the receipt prints only after `thread/start` succeeds (CLI:67).<br>The activity pill shows `✕ exit 5 · session` (filled err). The thread pill stays `○ thread: none yet`, and the chain pill stays `○ chain: nothing yet`. Nothing about the session or a turn is drawn solid or green.<br>After-error rule "Session start failed" (§5.8): input disabled, quit keys only. No final verify runs (no thread, R-g). On quit there is no receipt (§5.12). `Ctrl-D` exits 5 (the recorded 5 ranks, §5.11; §17 M-2 (c), RULED). A signal quit also exits 5, because a signal never replaces a recorded 5 (§17 M-2 (d), RULED). No final verify runs here, so §17.1 O-3 does not arise; the §5.13 line reads `madc: interrupted (SIGINT)` / `exit 5` (SIGHUP: a best-effort line, then the app re-raises SIGHUP, §17.1 O-4, RULED).<br>NO_COLOR: the same card with zero SGR, and the pill reads `[x exit 5 · session]`.<br>Line mode (tier A): the message line `madc: session error -32009: <message>` in `31` (the §6.2 pre-thread message row, in the `oneshot.ts:594` shape), then the hint uncoloured, and no prompt. |
| Post-turn chain FAILED | 5 (CLI:193; `oneshot.ts:528–544`) | FAILED card; session value **and** error row use the RQ-2 in-span form | same bytes (§6.2 RQ-2 row) | red break at line N (`04`), input disabled, `/new` |
| Torn tail | 5 | FAILED card (the verifier's reason) | same | warn break (R-c) |
| NO RECEIPT | any | `NO RECEIPT` warn bold in the card | `1;33` | served pill `▲ NO RECEIPT` |
| NOT STARTED | ≠0 | `NOT STARTED` err (`oneshot.ts:643`); only for a **refused** `turn/start` (ERR1 E17 L367), meaning a well-formed `turn/start` error reply; an N2 or N4 reply stays pending and shows `UNKNOWN` (E17a, `PIN-madc-M0-cli-erratum-1-E17a.md`, merged in `903610f`; ERR1 L5 at `903610f`). Frame `05` already shows this. | `31` | no turn segment; err card |
| Turn word not in the table (`INPROGRESS`, `UNKNOWN`, …) | 3 (ERR1 E16 L345) | warn word inside the err EXIT card | `33` | dotted warn rail, `╵ <status verbatim>` |
| SIGINT | 130 (CLI:111–112) | `EXIT 130` card | INTERRUPTED `33`; `130` `1;31` | during a turn: as `Ctrl-C` (segment ends `╵ interrupted`, the verify still runs); a second one during the grace forces the stop and quits by interrupt (IQW5-4). Idle, verifying, after chain FAILED or engine stopped: quit by interrupt (§5.8.1). **Every quit by interrupt runs the final verify** (IQW5-1). A signal during the final verify ends by default action (§5.8.1; ERR1 L427; §17.1 O-2, RULED). App code: **130**, unless a 2, 3 or 5 was recorded, which stays (§5.11; §17 M-2 (d), RULED). A final verify that fails after the signal exits **5** (§17.1 O-3, RULED). An in-app interrupt that is answered and verified, then a normal quit, counts as 0 for that turn, which is still shown INTERRUPTED (§17.1 O-5, RULED) |
| SIGTERM | 143 (CLI:113) | `EXIT 143` card | `143` `1;31` | the app restores the terminal, writes the §5.12 receipt(s), then the §5.13 line `madc: interrupted (SIGTERM)` / `exit <n>`: **143**, unless a 2, 3 or 5 was recorded, which stays (§17 M-2 (d), RULED); **5** if the final verify fails after the signal (§17.1 O-3, RULED) |
| SIGHUP | app: 129 via re-raise (OS-reported; not a pinned app code; §17.1 O-4 RULED). `-p`: not pinned | — | — | restore (best effort), stop the engine, receipt (may fail), §5.13 line (may fail), then re-raise SIGHUP so the OS reports it; the app never calls `exit(129)` (§17.1 O-4, RULED) |
| **Timeout** (ERR1 §3c, merged at df2e22d) | 3 | `EXIT 3` card (`05` bottom) | **Idle:** ` error    engine: timeout: no engine message for <ms> ms` (L172, L192–193); default 600 000 ms; `MADC_TURN_IDLE_MS` (L171, L202). **Request:** `timeout 30000ms` (L195). **After a `turn/start` timeout:** `turn     UNKNOWN` and `UNVERIFIED: turn unknown (turn/start sent, no answer)` (L195, L367). SGR: error row `31`, `UNKNOWN` `33`, UNVERIFIED `33`, exit `1;31`. | the same idle deadline per turn (E-b). **When it fires (IQW-3),** the app runs the one-shot's pinned path (ERR1 L172 rule 4):<br>1. send `turn/interrupt`;<br>2. wait a 2 s grace;<br>3. close stdin and kill after `KILL_AFTER_MS` 1 s (ERR1 L186 (a));<br>4. verify after the engine exits.<br>The segment ends `╳ timeout: no engine message for <ms> ms` and the `EXIT 3` card follows. The state becomes **engine stopped**: `Enter` restarts (new thread), `Ctrl-D` quits. Class 3 counts in §5.11. The app does **not** exit by itself. |

**Code status:** `main` at df2e22d does **not** yet implement ERR1. `NO_TIMEOUT_MS = 2_147_483_647` is still at `oneshot.ts:37`. ERR1 §3b, §3c and §3e need the A7 follow-up code act (ERR1 L3), so the Timeout row is pinned but not built yet. The spec renders the pinned words once they exist.

---

## 8. Doctor

- **Tier W card** (`06` top, `08`):
  - a header band `▌ madc doctor · madc <v> · protocol <p>` (the pinned first line, CLI:153);
  - rows as `<glyph> <WORD 4>  <id padded 14> <summary>`, with glyph `✓/▲/✕/○`, streamed as each check finishes (CLI:120). Rows not finished yet show `○ ···· <id> running` (dim) in fixed order and are replaced in place;
  - the RESULT line verbatim (CLI:146) on a tint: errbg if FAIL, warnbg if WARN, otherwise surface. **Never okbg:** the "all good" ban (CLI:142) holds.
  - This changes stdout doctor bytes on a TTY (P-10). Non-TTY bytes are unchanged.
- **Row states (W):** PASS (ok, only with evidence, CLI:140–141), WARN (warn), FAIL (err, bold), SKIP (dim), INIT (accent2, `--init` only). IQ-17 is restated: these now apply to M0 W.
- **Hanging indent (W):** a wrapped summary continues at indent **23** = glyph 1 + space 1 + WORD 4 + 2 + id 14 + 1. The app re-wraps only the summary *chrome*. The summary text is unchanged and never truncated.
- **`/doctor` overlay** (app): the same rows inside a box.
- **Tier A:** today's bytes plus the §6.6 SGR. `doctor.ts:837–843` is unchanged (FAIL 31, not bold; INIT 36). Rows soft-wrap at column 0.
- **Tier P:** today's bytes.

---

## 9. Widths

- **≥110 columns:** evidence pane docked.
- **80–109:** the pane is an overlay, and card right-meta stays.
- **80 columns** (`08`):
  - the header drops cwd;
  - pills shorten (`● 2.6s`, `▲ NO RECEIPT yet`, `seq 4 ▲ UNVERIFIED`);
  - card right-meta keeps only the duration;
  - the banner stacks its right column under the wordmark.
- **<80 or <24 rows at launch:** tier A (§3.4). A resize mid-session shows the "too small" notice.
- **Pinned lines** (receipt, doctor rows) are never re-wrapped or truncated by the app. The terminal soft-wraps them.
- **Truncation (chrome only):**
  - Hashes are always 12 hex (CLI:82).
  - Ids show head 8 + `…` + tail 4.
  - Paths: `$HOME` → `~`, then a middle ellipsis.
  - The receipt `session` path is always in full (CLI:73).
- **Wrapping:** agent text wraps at word boundaries to the rail column. Code blocks are clipped with `…` and viewable in full with `/receipt`.

---

## 10. Accessibility, NO_COLOR, ASCII

- Every state is a word plus a glyph of distinct shape (§4). The rail shape alone tells dotted, solid or broken (`: | X` in ASCII).
- **Contrast:** every information role is ≥5.4:1 on bg, pill and tints in dark mode (§3.1). faint and border are chrome only.
- **NO_COLOR:** zero SGR everywhere in M0, bold and reverse included (IQ-16). The W layout stays, block art stays in UTF-8, pills and caps become `[words]`, and ASCII verdicts use `#### WORD ####` (`09`).
- **`TERM` exactly `dumb`:** tier P for `-p` and doctor; line mode with zero SGR and ASCII for the app (IQ-13).
- **Windows:** without VT support the tier is A (§3.4 d). How to detect VT (`WT_SESSION`, or trying to enable VT) is open (Q8, IQ-20).
- **Motion:** no blinking and no animation. Elapsed time updates at ≤5 Hz.
- **Screen readers:** `MADC_UI=lines` gives line mode (Q7).

---

## 11. M3 desktop carry-over (early, unpinned)

*Unchanged from rev 2.* Mock-up: `11`. The stack is open (ROAD:50–56), and a desktop needs a socket transport, which requires a protocol amendment (ROAD:56).

- **Tokens:** §3 roles. Tints become card fills, with a 1 px role border (3 px for the rail).
- **Type:** UI 13/15/16 px; mono 12.5/13 px; verdict 28 px bold.
- **Spacing:** 4-pt grid; cards 12/14 padding; 8 between items; 16 between turns.
- **Components:** header strip with a `▸ banner` disclosure; a 3 px rail per turn (dashed warn / solid ok / err `╳`) with a `┗━` footer; cards; rounded pills; evidence column; verdict card. Every widget carries an `evidenceRef` (ROAD:139).
- **Motion:** dotted → solid over 180 ms only when the verify arrives; solid → err is instant; respect reduced-motion.
- **Conflict:** ROAD:92 ("no status colors"); see R16.

---
## 12. Pin changes the full M0 layout needs

**How to read this.**
- Every line cite is at `main` @ **df2e22d**. CLI lines are +2 from rev 2 numbering because of the CLI:5 erratum pointer.
- "Current text" is quoted exactly (sometimes cut with `…`).
- None of these changes is made by this spec. Each needs a Surface pin, an amendment or a Founder allowance. **Until then, the pinned bytes stand.**

### 12.1 CLI pin (`docs/plan/PIN-madc-M0-cli.md`)

| # | Line | Current text | Change needed |
|---|---|---|---|
| P-1 | CLI:16 | "…`madc -s <seat>`, `seats ls`, `providers ls`, `auth …` and the TTY-gated interactive mode (M1 plan) all stay reserved and unbuilt here." | Keep the reservation for `-s`, `seats ls`, `providers ls`, `auth` and the M1 `mode: interactive` claim. Add: "The M0 app (bare `madc`, `madc "<text>"`; DESIGN-SPEC §5) is built in M0. It sends headless turns only." |
| P-2 | CLI:22–28 | "## 1. Command grammar (M0, complete)" plus the 4 grammar lines (25–28) | Add `madc` and `madc "<text>"`: "full-screen app when stdin, stdout and stderr are TTYs (tier W) or line mode (tier A); otherwise as today (usage / CHAT_RESERVED, exit 2)". |
| P-3 | CLI:37 | "Bare `madc "<text>"` (no `-p`) \| **Reserved for M1 interactive chat.** In M0 it exits 2 with the message `interactive chat arrives in M1; use: madc -p "<text>"`." | On a full TTY: open the app and send `<text>` as the first turn. Otherwise the bytes are unchanged (hard rule 1), and the stale wording is Q11. |
| P-4 | CLI:38 | "Bare `madc` \| Prints the usage and exits 2." | On a full TTY: open the app. Otherwise unchanged. |
| P-5 | CLI:40 | "The CLI claims no interactive mode in M0, so every turn is headless. The M1 TTY-gated `mode: interactive` rule is not built here." | Reword to "no interactive **turn** mode". The app is a UI, and its turns stay headless. The second sentence stays. |
| P-6 | CLI:48 (+ PROTO:39; `engine/src/client.ts:212, 229`) | "`spawnEngine` from `@madc/engine/client`, with stdio `["pipe","pipe","inherit"]`." | The app needs engine stderr **not** inherited onto its alternate screen (§5.10). That needs an additive `spawnEngine` option (for example `stderr: "pipe"`); `-p` keeps `inherit`. **It conflicts with CLI:208 ("No engine behaviour change.") and ERR1 L148 ("No other engine-client change is allowed by this"), so it needs a new Founder allowance.** **Granted (§17 M-1, RULED, Michael, 2026-09-26 08:54 Nassau, relayed by Surface Architect):** narrow, for the new app act only; engine stderr passes through the engine client; no new protocol method and no engine behaviour change. PROTO:39 would read "…`inherit` (one-shot) or `pipe` (app)". |
| P-7 | CLI:63 | "a live one-line status while waiting (`… kimi-code · 1.2s`), then the **receipt block**" | Text `… <seatId> · <s>s`, one decimal place, to match `oneshot.ts:379` (rev 2 R1). In tier W, the same text is drawn as a filled pill (SGR only) and the receipt is framed as the §6.1 card. |
| P-8 | CLI:67–76 | "**Receipt block** (stderr, printed at every exit after `thread/start` succeeds):" plus the pinned block | Keep the rows byte-exact. In tier W, allow the §6.1 chrome around them: `▌` edge, title row, earned big verdict, tint. Tier A gets §6.2 SGR only (rev 2 R3). Non-TTY is unchanged. |
| P-9 | CLI:79–81 | "The `session` line comes from **re-reading and verifying** the thread's JSONL after the engine exits…" | Add for the app: a read-only verify after each `turn/completed` while the engine is alive (R-a…R-g), with the final verify still after the engine exits, **on every exit, including a quit while a verify runs** (IQW5-1). No pin names a verify time limit, so P-9 must carry the 30 000 ms bound: proposed for the per-turn verify (§5.3 R-a), and **ruled for the final verify (§17.1 O-1, RULED)**. On a final-verify timeout the turn shows `UNVERIFIED: verify interrupted`, never solid or green. The one-shot is unchanged. |
| P-10 | CLI:120, 146, 152–165 | "Rows print **as each check finishes**…" / "The last line is `RESULT …`" / the example block | Tier W doctor rows: `<glyph> <WORD 4>  <id 14> <summary>`, pending rows replaced in place, indent 23, header band, RESULT tint (§8). The row text is kept. Tiers A and P are unchanged. |
| P-11 | CLI:141 | "Words come first. Colour is optional: only on a TTY, never when `NO_COLOR` is set, and PASS may be green only because its row already carries evidence." | Extend "green only on evidence" to `chain VERIFIED`, the solid rail and `COMPLETED` (chain VERIFIED + exit 0). Allow the §3.1 palette, tints and pills in tier W. State the gates of §3.3 (both-TTY for all human stderr lines, RQ-1), NO_COLOR = zero SGR, `TERM` = `dumb` exactly, and `FORCE_COLOR` ignored. |
| P-12 | CLI:142 | "No emoji, spinners-as-status, progress bars, or "all good" banners." | Keep the emoji, spinner and progress-bar bans. Carve out: (a) the evidence banner (§5.1), which states counts and never gives a reassurance line; (b) **one earned verdict per turn** (COMPLETED only on chain VERIFIED + exit 0, and failure verdicts equally large). Add: glyphs are text presentation and never followed by U+FE0F. |
| P-13 | CLI:212 | "Interactive chat / REPL / TUI." | Remove it from this pin's out-of-bounds list, or scope it to "Act M0-A7 only". The new act's pin (§12.4) owns the app. **Rev 6.1 (IQW6-1):** the look is the same under either form, so the form is pin wording and Surface's call. The design needs only this: the new act (§17 M-4) is allowed to build the interactive app. |
| P-14 | CLI:216 | "Colour themes." | Keep it. One fixed palette with 16/256/truecolor depth is not a theme. Add a note to say so. The light variant stays M1 (R6). |
| P-15 | CLI:184, 190 | "## 4. Exit codes (both commands)"; the exit-2 row lists "…bare `madc`…" | Retitle to cover the app. Exit 2 for bare `madc` applies **only when not a full TTY**. Add the app exit rule (§5.11, ruled by §17 M-2 and §17.1 O-3…O-6, RULED in rev 6.2) or a pointer to the app pin. |
| P-16 | CLI:233 | "6. Non-TTY stdout has no ANSI codes. `NO_COLOR` is honoured. …" | Keep it. Add acceptance tests: tier selection (§3.4) with fake TTYs and sizes; zero SGR under NO_COLOR and `TERM=dumb`; the `-p`/doctor W chrome leaves the pinned rows byte-exact once SGR and chrome are stripped; the terminal is restored on every exit path; `madc doctor x` stderr takes the both-TTY gate (RQ-1). |
| P-17 | CLI:201 | "`packages/cli` imports only `node:*`, relative paths, `@madc/core`, `@madc/engine/client`, and type-only `@madc/engine`." | **No change if the app is hand-rolled** with `node:readline`/`node:tty` and ANSI. A TUI library (Ink or similar) would need this line changed, plus M0PLAN:107 and M1PLAN:65 ("No new packages. Import rules from M0 §6 stand"). The spec needs none (proposal: hand-rolled). |
| P-18 | CLI:202 | "Doctor needs three read-only things that `@madc/engine/client` does not export today. **Founder allowance (D-A7-2):** …" | Change to "Doctor **and the app** use these read-only re-exports". The banner uses the same seat, session and registry data. There are no new exports. |
| P-19 | CLI:63 | "\| TTY \| no \| agent text, streamed as deltas arrive \| a live one-line status while waiting …" (the row's condition is stdout TTY, no `--json`) | State the status line's existence gate as stdout **and** stderr TTYs, no `--json`, matching `oneshot.ts:203, 377` and RQ-1 (IQW-16). This changes pin text only, not bytes. |

### 12.2 Erratum 1, plans, ledger

| # | Line | Current text | Change needed |
|---|---|---|---|
| E-a | ERR1 L321 (E11) | "…in human mode … engine-supplied fields in the receipt and the one-line error… replaced with U+FFFD… the CLI's own status line and colours … are unchanged" | Extend E11 to every engine string the app draws (§5.10). The status line gains SGR in tier W, so "unchanged" becomes "text unchanged". |
| E-b | ERR1 §3c L163–L172; L197 | idle deadline, "600 000 ms" default, `MADC_TURN_IDLE_MS`, message `timeout: no engine message for <ms> ms`; L197 "Read only by the one-shot (`madc -p`)." | Apply the same per-turn idle deadline, value, env var and fired path (rule 4) in the app (§5.3, §7; IQW-3). L197 becomes "read by the one-shot and the app". The 600 000 ms default was a Founder choice for the one-shot (LEDGER D-194, line 265; D-195, line 266; pin K-7), so extending it is §17 M-3. **RULED (Michael, 2026-09-26 08:54 Nassau, relayed by Surface Architect):** the app gets the same 10-minute (600 000 ms) per-turn idle deadline and the same `MADC_TURN_IDLE_MS` override. |
| E-c | ERR1 L148; allowance A1 (L452; heading L450) | "No other engine-client change is allowed by this." | Conflicts with P-6. A new Founder allowance is needed for the stderr option; A1 cannot be stretched to cover it. **Granted as a separate, narrow allowance for the new app act only (§17 M-1, RULED).** |
| E-d | ERR1 §3b (L117–161), rules 5–8 (L145–148: "All of this lives in `packages/cli`") | §3b is scoped to the one-shot's wait | Apply §3b unchanged to the app's connection (IQW-7, IQW4-1): rule 2's existing checks, rule 4 N2–N7, rule 5's live detection, rule 6's re-check at each turn end, and rule 7 are violations (class 3). Rule 1 (unknown notification) and rule 3 (N1, an unmatched response) stay **ignored and not violations**, with no timeout reset. It is still `packages/cli` only, with no engine change. |
| E-e | ERR1 §3d (L224–245 at `677332c`; L226–247 at `903610f`); ledger D-196 | "## 3d. Exit precedence (clarification of CLI §4, CLI:184-195)"; "**Signal**, over everything"; "signal (130/143) > 3 > 2 > 5 > 4 > 1 > 0" | **Rev 6.1 (IQW6-2).** Scope ERR1 §3d to the one-shot (`madc -p`). The app's exit precedence is §5.11, which Michael ruled to differ on purpose (§17 M-2 (d): a signal never replaces a recorded 2, 3 or 5). The one-shot's ladder and code are unchanged. Without this row, ERR1 §3d, read as clarifying CLI §4 "(both commands)" (CLI:184), would contradict the ruling for the app. |
| PL-1 | M0PLAN:73 | "…Commodity loop/tools get minimum viable; do not gold-plate TUI chrome." | Amend to match the ruling: "the Witness terminal layout (`docs/plan/PIN-madc-M0-design-witness.md`, which carries this spec's current revision) is an M0 deliverable". LEDGER D-189 (line 78) records a relayed Founder ruling to this effect, but it has **no GitHub source** (unverified). The 07:24 ruling reached me only as a relay. |
| PL-2 | M0PLAN:240 (A7); 226, 233, 247, 254 | A5/A6 "**Blast radius:** `packages/adapters` vendor."; A8 "CI, `docs/runbook/M0.md` …, README pointer."; A9 "docs completion report in PR description." | **Only A7's blast radius includes `packages/cli`** (M0PLAN:240: "**Blast radius:** `packages/cli`."). A7 was merged as **PR #19** (`343da29`, GitHub `merged_at 2026-09-26T08:45:03Z` = 04:45:03 Nassau; PR #16 is the CLI pin plus Amendment 2). Its follow-up is fixed in scope by ERR1 L3 and allowance A1 (L452). **No act after A7** (A5, A6, A8, A9) includes `packages/cli`. The app needs one; see §12.4. **RULED (§17 M-4):** a new act after the A7 follow-up and before A8. |
| PL-3 | M0PLAN:259 | "A0 → A1 → A2 → A3 → A4 → A7 (doctor early) → A5 → A6 → A8 → A9" | Insert the app act in the order after the A7 follow-up and before A8 (§17 M-4, RULED). |
| PL-4 | M0PLAN:248 (A8 runbook) | "runbook: install, doctor, kimi mock/live, …, where session files live" | Add one line: "If `madc` is killed (SIGKILL) or crashes and the terminal stays blank or raw, run `reset` (or `stty sane; tput rmcup`)." (IQW-11) |
| L-1 | LEDGER D-147 (line 230) | bare `madc "<text>"` reserved for M1, exits 2 in M0 (PR #16) | Superseded on a full TTY by the ruling; record it. The non-TTY bytes stay. |
| L-2 | LEDGER D-189 (line 78; also listed at lines 32 and 403) | Founder ruling relayed; "M0 (A5, A6, A8, A9)" | Needs a GitHub source (PR or issue comment) before a pin cites it. **RULED (§17 M-5):** Clio posts the decisions comment on the design pin's PR; that comment is the GitHub source. Until it exists, this stays unverified. |

### 12.3 Rev 2 R-rows, re-targeted

| Rev 2 row | Rev 3 status |
|---|---|
| R1 (status-line text) | M0; folded into P-7 |
| R2 (gates) | M0; the §3.3 gate rule (RQ-1), no pin change for CLI:64 |
| R3 (Level A tables) | M0, tier A only (§6.2); folded into P-8 and P-11 |
| R4 (verdict vs "all good") | **M0** → P-12 |
| R5 (M1 app pin) | **M0** → P-1…P-5, P-13 |
| R6 (light theme) | stays M1 |
| R7 (env precedence) | M0 → P-11 (§3.3) |
| R8 (Level B around the receipt) | **M0 tier W** → P-8 |
| R9, R10 (per-item seq) | stay post-M0; not needed |
| R11 (per-turn verify) | **M0** → P-9 |
| R12 (resume display) | stays M1 (no resume in the M0 app) |
| R13 (doctor overlay rows, indent 23) | **M0 tier W** → P-10 |
| R14 (ASCII) | M0 (§4) → P-11 |
| R15 (`/dev/tty` hand-off) | stays M1-A5 |
| R16 (desktop colours) | stays M3 |
| — context bar | **not proposed.** There is no protocol evidence for context use (PROTO has no token counts), and CLI:142 bans progress bars. |

### 12.4 Candidate acts (ruled: option 4, §17 M-4, Michael, 2026-09-26 08:54 Nassau, relayed by Surface Architect)

| Option | Fit | Notes |
|---|---|---|
| **1. A8 widened** | fair | A8's blast radius is CI, the runbook and a README pointer (M0PLAN:247), and its build is "registry forbid/allow tests + M0 happy-path test" plus the runbook (M0PLAN:248). It names no CLI code or CLI tests. Its blast radius would need to add `packages/cli`, and a matrix-and-runbook act would become a large UI build. |
| **2. A9** | poor | A9 is the freeze. Its blast radius is docs only (M0PLAN:254), and a freeze is the wrong place for new UI. |
| **3. A5 / A6** | no | Adapters only (M0PLAN:226, 233). They matter because they are what will emit `toolCall`/`toolResult` for the tool cards. |
| **4. New act** (for example "M0-A7b" or "M0-A10: Witness app") | good | A plan amendment (PL-1…PL-4) plus a Surface pin carrying P-1…P-19 and E-a…E-e (E-c is the stderr allowance granted by §17 M-1; E-e is added in rev 6.1). It would sit after the A7 follow-up and before A8, so that A8's matrix tests cover it. **Chosen (§17 M-4, RULED).** |
| **5. Split** | good | (a) W cards for `-p` and doctor first (P-7, P-8, P-10, P-11, P-12, P-16: small and cli-only); (b) the app later, before A9 (P-1…P-6, P-9, P-13, P-15, P-17, P-18, P-19, E-d). P-6 (engine stderr) gates only (b). |

The A7 follow-up is **not** an option. Its scope is fixed by ERR1 allowance A1 and the CLI:5 pointer.

---

## 13. Open questions

- **Q1.** Honour `FORCE_COLOR`? The proposal is to ignore it (§3.3).
- **Q2.** Closed by the ruling: the status line gets pill colour in tier W, and it stays plain in tier A.
- **Q3.** Closed: W chrome reaches `madc -p` (§6.1).
- **Q4.** Is `MADC_THEME` the right switch for the light variant (M1)?
- **Q5.** After chain FAILED, should input be disabled until `/new`, or allowed with a persistent err banner? The proposal is disabled.
- **Q6.** Resume stays M1.
- **Q7.** Is `MADC_UI=lines` enough for screen readers?
- **Q8.** Windows VT detection: `WT_SESSION` only, or try to enable VT mode (IQ-20)?
- **Q9.** Closed (IQ-9).
- **Q10.** Closed and extended (RQ-1): one both-TTY gate for every human-readable stderr line, whatever the command, including `madc doctor` parse errors.
- **Q11.** On a non-TTY, `madc "<text>"` still prints `interactive chat arrives in M1; use: madc -p "<text>"`, which is now misleading. Keep it byte-stable (proposal), or change the text through a pin (it is a non-TTY stderr byte change; stdout is untouched)?
- **Q12.** Closed by IQW-2 and §17 M-2, RULED (§5.11: worst code on the one-shot ranking wins; engine loss plus restart still exits 3). The cases rev 6 left open, §17.1 O-3…O-6, were ruled in rev 6.2.
- **Q13.** Engine stderr (P-6): pipe it into the evidence pane if the allowance is granted; inline mode if it is denied (§5.10, IQW-15). The allowance is granted (§17 M-1, RULED), so the pane is the M0 path.
- **Q14.** Tier W requires `TERM` set and not `dumb`. Should it also require terminfo capabilities (`smcup`), or stay heuristic?

---

## 14. Illustrative vs real

**The text of this spec is normative, and the mock-ups are illustrations.** Where an image and the text differ, the text wins (IQ-11, IQ-21). Every image was regenerated in rev 3 with `spec/build_spec.py` and checked by reading the PNG. In rev 4 only `05`, `12` (new) and `overview-sheet.png` changed. They were regenerated and read. In rev 5 only `02` and `08` (key bars, IQW4-3) and `overview-sheet.png` changed. They were regenerated and read. Image captions still say "pins at main @ df2e22d". The pins those images quote (CLI, ERR1, PROTO) are byte-identical at 677332c. In rev 6 no image changed: every PNG is byte-identical to rev 5 (sha256), and `build_spec.py` is unchanged. The `-32009` startup card (IQW5-2) is specified in text only (§7). It reuses the `05` card style, so no new frame is needed to make it unambiguous. `overview-sheet.png` was regenerated in the rulings run, and its title says rev 6 (changelog; §18). Frames `01`–`12` are byte-identical to rev 5.

**Normative in rev 4 (IQW-13):** the §5.8 key table, including `Enter` = restart engine when stopped, `/new`, `/receipt` and `Esc`. The key hints in the mock-ups are illustrative only in their layout.

**Real** (pinned text or code at df2e22d):
- receipt rows and rule (`oneshot.ts:631–675`; CLI:67–82);
- the status-line text (`oneshot.ts:379`);
- the pre-thread line (`oneshot.ts:594`);
- `madc: unexpected argument x (see madc --help)` (`args.ts:89`, `main.ts:26`);
- doctor ids, wording and RESULT (CLI:123–165; `doctor.ts:898–900`);
- the exit codes (CLI:184–197);
- `madc-m0/1`, `madc-default`, `kimi-code`, `kimi-coding/kimi-for-coding`;
- the ERR1 timeout message (L172);
- `NO RECEIPT`, `chain VERIFIED/FAILED line N`, `UNVERIFIED`, `NOT STARTED`;
- ThreadStatus / TurnStatus words.

**Illustrative:**
- the tool card (`read_file`, 235 lines; M0 kimi emits no tools, §5.4);
- agent text;
- the doctor mix and timings;
- registry counts;
- seq values and heads;
- ids;
- the composite exit-3 message in `05` (top);
- the chain-FAILED location;
- the `INPROGRESS` turn word in the timeout card;
- the UNVERIFIED reason texts;
- the line-mode identity line;
- all of `11`;
- the ANSI-Shadow art.

**Mock-ups** (`/workspace/madc-design/spec/`):

| File | Shows |
|---|---|
| `overview-sheet.png` | all frames, labelled "M0 = full Witness; Level A only as fallback" |
| `01-M0-app-pre-conversation-110x32.png` | banner, doctor summary, pills, key hints |
| `02-M0-app-midstream-toolcard-evidence-110.png` | header, dotted rail, tool card, streaming pill, docked evidence pane |
| `03-M0-app-turn-done-COMPLETED-110.png` | solid rail `┗━`, COMPLETED verdict card |
| `04-M0-app-chain-FAILED-110.png` | red break `╳`, FAILED card, RQ-2 in-span error row |
| `05-M0-protocol-error-EXIT3.png` | app engine-gone `EXIT 3` (110; rev 4: `UNKNOWN` / `UNVERIFIED: turn unknown (turn/start sent, no answer)` per ERR1 E17) + `madc -p` idle-timeout `EXIT 3` card at 80 with terminal soft-wrap |
| `06-M0-doctor-card-and-overlay.png` | W doctor card + `/doctor` overlay, indent 23 |
| `07-M0-oneshot-receipt-card-80.png` | `-p` streaming pill + COMPLETED card |
| `08-M0-80col.png` | the app at 80 columns, evidence overlay |
| `09-M0-plain-piped-and-NO_COLOR.png` | tier P bytes (piped, `--json`, doctor, parse error) + NO_COLOR UTF-8 and ASCII |
| `10-M0-LevelA-fallback-limited-terminal-72.png` | tier A line mode and `-p` at 72 columns |
| `11-M3-desktop.png` | M3 early sketch (unchanged in substance) |
| `12-M0-inline-fallback-no-stderr-allowance-80.png` | rev 4, IQW-15: inline (append-only) app if P-6 is denied; an unlabelled engine stderr line sits in the scrollback and nothing draws over it |

The rev 2 images and text are in `spec/rev2-archive/`.

---

## 15. Answers to Surface's pin questions (IQ-1 to IQ-21, restated for rev 3) and RQ-1 to RQ-3

IQ answers are the Founder's decisions as relayed in rev 2. Rev 3 restates each one where the full layout touches it.

1. **IQ-1:** CLI:64 is not amended. Receipt colour and chrome need stdout **and** stderr TTYs. Rev 3 extends the same gate to the W card and to every human stderr line (RQ-1). [§3.3]
2. **IQ-2:** the whole error row is `31` (err in W). [§6.2]
3. **IQ-3:** the session value is `ESC[1;31m` `chain FAILED` `ESC[0;31m` ` line N: <reason>` `ESC[0m`. The error row uses the same in-span form (RQ-2). [§6.2]
4. **IQ-4:** `130`/`143` in full `1;31`; the W card is `EXIT 130/143`. [§6.2, §7]
5. **IQ-5:** pre-thread message `31`; exit digits `1;31`. [§6.2]
6. **IQ-6:** parse and usage messages `31`, not bold; usage and help text uncoloured. [§6.2]
7. **IQ-7:** `ESC[0m` before every `\n`. [§6.2]
8. **IQ-8:** unlisted turn words `33` (warn), never green. [§6.2, §7]
9. **IQ-9 (now unconditional):** ERR1 was merged at df2e22d (PR #21, 06:24:39 Nassau). After a `turn/start` timeout the receipt shows `turn     UNKNOWN` and `UNVERIFIED: turn unknown (turn/start sent, no answer)` (ERR1 L195, L367). The idle timeout error row is ` error    engine: timeout: no engine message for <ms> ms` (L193). The row is pinned. The code is not built yet (A7 follow-up). [§7]
10. **IQ-10:** doctor `exit 0` is `32` only with 0 FAIL and 0 WARN, otherwise `33`. In W, the RESULT tint is never okbg. [§6.6, §8]
11. **IQ-11:** text wins over the mock-ups; `07` is regenerated. [§14]
12. **IQ-12 (restated):** tier A soft-wraps at column 0 with no bytes added. Tier W uses indent 23 for doctor summaries. Pinned receipt rows are never re-wrapped in any tier. [§8]
13. **IQ-13:** `TERM` must be exactly `dumb`. Rev 3: that means tier P for `-p` and doctor, and a zero-SGR line-mode app. [§3.3, §3.4]
14. **IQ-14:** `\r\x1b[K` is unchanged in every tier. [§3.3, §6]
15. **IQ-15 (restated):** truecolor, 256 and 16-colour roles are now **M0 tier W**. Tier A uses only the §6.2 table. [§3.3]
16. **IQ-16:** zero SGR under NO_COLOR, `TERM=dumb` or no TTY, bold included, **now also for the app and W chrome**. [§3.3, §10]
17. **IQ-17 (restated):** the §8 row states (FAIL err+bold, INIT accent2) apply to tier W in M0. Tier A keeps `doctor.ts:837–843`. [§8]
18. **IQ-18:** `<s>` has one decimal place. [§6]
19. **IQ-19:** a failing or unclear TTY check means not a TTY. Each line is written in one write, and the W card is one write. [§3.3, §6.2]
20. **IQ-20 (restated):** Windows without VT gives tier A. Detection is Q8. [§3.4, §10]
21. **IQ-21:** text is normative, and every PNG was regenerated and read. [§14]

**Surface's rev 3 questions (decided, relayed by the parent agent):**
- **RQ-1, closed.** One settled rule, not "my reading": every human-readable stderr line the CLI prints is coloured only when stdout **and** stderr are both TTYs. That includes parse errors from `main.ts:24–26` for `madc doctor …` (for example `unexpected argument x`, `args.ts:89`). Those take the both-TTY gate, **not** doctor's stdout gate. Doctor's stdout rows keep the stdout gate. [§3.3, §6.2, Q10]
- **RQ-2, closed.** When the error row carries `chain FAILED line N: …` (`oneshot.ts:541`, `fail(…, "session", null, …)`, which prints ` error    session: chain FAILED line N: …`), it uses the same in-span form as the session value: `ESC[31m error    session: ESC[1;31mchain FAILEDESC[0;31m line N: <reason>ESC[0m`. The same structure applies in W. [§6.2, §7]
- **RQ-3, closed.** A stderr line with no row prints uncoloured by default. Any new failure or warning line needs a spec row before it ships, and Surface sends those lines to Iris. The F-130 row is proposed in §6.4, citing ERR1 L354 @df2e22d and the local, unpushed A7 follow-up code (`main.ts:146–155` @ 71b40f0). [§6.4, §6.5]

---

## 16. Answers to the Witness pin's IQW-1 to IQW-18 (pin §16.2, `5f451b4`)

Each answer is a design decision, folded into the section in brackets. They were checked against the hard rules: exit codes, `--json` and non-TTY bytes stay byte-stable; no success without verified evidence; failure at least as loud as success; contrast kept; meaning never carried by colour alone; NO_COLOR fully readable. Where a decision needs a Founder ruling, it points to §17.

1. **IQW-1:** stdin and stdout TTYs but stderr not a TTY means **no app**. Today's bytes are printed exactly as pinned (`USAGE` / `CHAT_RESERVED`), exit 2, zero SGR. This matches the both-TTY gate. §5.0 and P-2 now agree. [§3.3, §5.0]
2. **IQW-2:** the app exits with the worst class seen anywhere in the session, on the ERR1 ladder, using only the pinned codes (CLI:188–194): failed turn 1, provider 4, seat 2, engine/timeout/violation/thrown error 3, final chain FAILED 5; the app's signal codes are §17 M-2 (d) (IQW4-2). UNVERIFIED turns, in-app interrupted turns and no-turn sessions have no pinned class, so they go to Michael (§17 M-2), with the constraint that UNVERIFIED never exits 0. Labels are fixed to P-15. [rev 6 rulings: §17 M-2 RULED. The worst code on the one-shot ranking wins. An UNVERIFIED turn counts with its own exit, usually 0 (CLI:81), which supersedes "UNVERIFIED never exits 0"; it is still never shown as success. Signals: 130/143, never replacing a recorded 2, 3 or 5. No turns: 0 or 5 by the final check.] [§5.11, §7]
3. **IQW-3:** when the app's idle deadline fires, it runs ERR1 rule 4's pinned path: `turn/interrupt`, 2 s grace, stdin closed, kill after 1 s, verify after exit. It then shows `╳ timeout …` with an `EXIT 3` card and enters **engine stopped** (`Enter` restarts, `Ctrl-D` quits). Class 3 counts, and the app does not exit by itself. It reuses 600 000 ms and `MADC_TURN_IDLE_MS` (extending them to the app is §17 M-3) [rev 6 rulings: M-3 RULED, extended]. [§7, E-b]
4. **IQW-4:** an unanswered `turn/interrupt` gets the one-shot's 2 s grace and then stdin close with a kill 1 s later (CLI:111–112; `oneshot.ts:34–35`). The result is `╳ interrupt not answered in 2 s · engine stopped`, class 3. A second Ctrl-C or SIGINT during the grace forces the stop and quits; the app's signal codes are §17 M-2 (d) (IQW4-2). [rev 6: the quit runs the final verify and writes the §5.13 line, IQW5-4. Rulings: the code is 130, unless a 2, 3 or 5 was recorded (§17 M-2 (d)).] [§5.8]
5. **IQW-5:** the per-turn verify runs in a `node:worker_threads` worker with a **30 000 ms deadline (proposed)**, because `verifySessionFile` is synchronous and would freeze the screen. On the deadline, the turn ends `UNVERIFIED: verify did not finish in 30000 ms` (proposed text), dotted warn and never solid. No size bound is added (A2:98 defers it). [§5.3 R-a]
6. **IQW-6:** input is editable while the launch doctor runs, but `Enter` waits for every row (each bounded by its check timeout, CLI:121). `/doctor` does nothing during a turn or a verify (IQW4-3), so it never reads a file mid-append. [§5.1, §5.8]
7. **IQW-7** (corrected by IQW4-1): a violation in the app is exactly what ERR1 §3b calls a violation (rule 2, N2–N7, rule 7; live per rule 5, re-checked per rule 6). N1 and unknown notifications are ignored. A hit stops the engine, class 3. This needs E-d. [§7, §12.2 E-d]
8. **IQW-8:** the `error` Item renders as an err-edge card `✕ error <code>` plus the sanitised message. It is never green and never a verdict by itself; the turn's verdict still comes from `turn/completed` plus the verify. NO_COLOR form: `[x error <code>]`. [§5.4]
9. **IQW-9:** input that is empty after trim is never sent (CLI:35; `main.ts:94`). Input over 1 MiB of UTF-8 is not sent, with a warn line and the text kept (CLI:34). An unknown `/word` shows `unknown command /<word> · /help`, and `//` escapes a literal slash. [§5.8]
10. **IQW-10:** the signal exit line is `madc: interrupted (<signal>)` then `exit <n>` (`<n>` per §17 M-2 (d), IQW4-2; rev 6 rulings: 130 / 143, or the recorded 2, 3 or 5; SIGHUP re-raised so the OS reports it, §17.1 O-4, RULED in rev 6.2), printed after the restore and the exit receipt. The message is `33`, and on the exit line the label is uncoloured with the digits `1;31`. Both-TTY gate. [§5.13, §7]
11. **IQW-11:** the terminal is restored on every catchable path (quit, Ctrl-D, SIGINT, SIGTERM, engine exit, thrown error or rejection, `exit` handler; SIGHUP restores and stops the engine; then re-raises SIGHUP so the OS reports it, with no app code, §17.1 O-4, RULED in rev 6.2). SIGKILL and runtime aborts cannot be caught, and the spec does not claim otherwise. The documented recovery is `reset` in the runbook (PL-4). [§5.0, §12.2 PL-4]
12. **IQW-12:** `MADC_UI` counts only when exactly `lines`, and `MADC_ASCII` only when exactly `1`. Any other value counts as unset, never exits, and never prints to stderr. The app's evidence pane notes an unrecognised `MADC_UI` without echoing the value. [§5.0]
13. **IQW-13:** the §5.8 key table (per state) is **normative**. §14 no longer calls the keys illustrative. [§5.8, §14]
14. **IQW-14:** the NO_COLOR chain pill keeps the turn number: `[turn 2 ! UNVERIFIED yet]`. The mock-ups already show `turn 2` in the pill, and no NO_COLOR frame shows that pill, so no image changed for this item. [§5.6]
15. **IQW-15:** if the stderr allowance is denied, the app runs in **inline mode**. It is append-only on the normal screen, with no alternate screen, no cursor-up, no fixed bar, no `\r` repaint and no clear. Engine stderr lands in the scrollback where it is written, and the app never draws over or hides it. The app cannot label inherited bytes (an honest limit); instead it prints one note line up front. The allowance itself is Michael's ruling (§17 M-1). Mock-up `12`. [rev 6 rulings: M-1 granted the allowance for the new act only, so inline mode is not the M0 path.] [§5.10]
16. **IQW-16:** the status line exists only when stdout **and** stderr are TTYs and there is no `--json`, as the code already does. New **P-19** amends CLI:63's condition (pin text only, no byte change). [§6.1, §12.1]
17. **IQW-17:** the exit receipt is **required**. After the restore, if any `turn/start` was sent, the app writes the last turn's receipt block to stderr in one write, plus the exit-deciding turn's block if that is a different turn, using one-shot bytes, §6.2 SGR, the final verify and the app's exit code. With no `turn/start`, it writes nothing. Testable byte-for-byte. [§5.12]
18. **IQW-18:** after a seat error, input is re-enabled and the next send retries `thread/start`. After a provider FAILED card, input is re-enabled on the **same** thread. After chain FAILED or a torn tail, input is disabled until `/new`. After engine stopped, `Enter` restarts with a new thread. Each error's class still counts toward the exit. [§5.8, §7]

**Rev 5: Surface's IQW4-1 to IQW4-4 (on the rev 4 pin, `9217b20`):**

- **IQW4-1:** the app's violation set is exactly what ERR1 §3b calls a violation:
  - rule 2's existing checks (L133);
  - rule 4 N2–N7 (L135–144);
  - rule 7's id-carrying `turn/completed` (L147);
  - checked live per rule 5 (L145) and re-checked per rule 6 (L146).
  N1, a well-formed unmatched response (rule 3, L134, "not a protocol violation"; tests L154–155), and unknown notifications (rule 1, L132) are **ignored** exactly as ERR1 says, with no timeout reset. E-d and IQW-7 are rewritten. [§7, §12.2 E-d]
- **IQW4-2:** "no new code is invented" wins.
  - CLI:194 pins 130/143 **for SIGINT/SIGTERM by name** (with CLI:111–113, `exit-codes.ts:13–14` and ERR1 L245/L286). No pin states a generic 128+n rule, and none gives SIGHUP a code, so 129 does not follow from anything pinned.
  - The 130/143 in rev 4's IQW-4/10 came from those one-shot rows. Whether they carry over to the app is not pinned either.
  - So **every app signal exit code (SIGINT, SIGTERM, SIGHUP) is moved to §17 M-2 (d)**. The restore behaviour is specified separately and does not depend on the code.
  - [rev 6 rulings: M-2 (d) RULED: SIGINT 130, SIGTERM 143, never replacing a recorded 2, 3 or 5. SIGHUP stays open (§17 O-4). Still no 129.] [rev 6.2: SIGHUP is re-raised so the OS reports it; no app code is pinned, and the app never calls `exit(129)` (§17.1 O-4, RULED).]
  [§5.0, §5.8, §5.11, §5.13, §7]
- **IQW4-3:** `/help` and `/doctor` are removed from the in-turn and verifying columns.
  - In those states the input stays editable, but `Enter` and slash commands do nothing and print nothing.
  - The key-hint bar shows only keys that act in the current state. `02` and `08` are regenerated to match.
  [§5.1, §5.8]
- **IQW4-4:** external SIGINT behaves exactly like the `Ctrl-C` key in the same state.
  - **Idle, after chain FAILED, engine stopped:** stop the engine, run the final verify (bounded), restore, write the required receipt and the §5.13 line, and exit with the M-2 (d) code [rev 6 rulings: 130, unless a 2, 3 or 5 was recorded].
  - **Verifying:** abort the verify. That turn ends `UNVERIFIED: verify interrupted`, never solid or green. Then restore, write the receipt, and exit. [rev 6: superseded by IQW5-1. The final verify R-g still runs after the engine stops.]
  - A signal never makes the exit better than the session's worst state: never 0, and the receipt includes the worst turn.
  - The §5.8 table now has a cell for every state.
  [§5.8, §5.8.1, §5.12]

**Rev 6: Surface's DQ5-1 to DQ5-4 (on the rev 5 pin, `e4b27e1`), recorded as IQW5-1 to IQW5-4:**

- **IQW5-1 (DQ5-1):** the pinned final verify wins, and quitting during a verify is not an exception to it (CLI:79–81; ERR1 L276).
  - On the first `Ctrl-C` or SIGINT during a verify, the app abandons that verify, stops the engine and runs one final verify, bounded by the §5.3 deadline.
  - **No pin gives a verify a time limit.** CLI:79–81 names none, ERR1 L195's 30 000 ms covers only three requests, and the one-shot's verify has no bound (`oneshot.ts:605–607`). So the bound stays the **proposed** 30 000 ms, carried by P-9.
  - If it passes and the last `turn.end` names the turn (CLI:80), the turn may be drawn solid, and the receipt reads `chain VERIFIED`. If it fails, the rail breaks red and class 5 is recorded; the exit is §17 M-2 (d), because the one-shot's ladder puts the signal first (ERR1 L245) [rev 6.2 rulings: the exit is 5 (§17.1 O-3, RULED), and the final verify is bounded at 30 000 ms (§17.1 O-1, RULED)]. If it times out or does not finish, the turn shows `UNVERIFIED: verify interrupted`, never solid or green.
  - **A signal during the final verify** is matched to the one-shot. Its listeners are gone by then (`oneshot.ts:476–477`), and the signal "gets default handling" (ERR1 L427, F-102). The pins do not require the verify in that window, so the rev 5 line is rewritten, not dropped: the app restores the terminal, then re-raises the signal. No receipt and no §5.13 line follow. [rev 6.2 rulings: kept for M0 (§17.1 O-2, RULED).]
  - The SIGTERM and SIGHUP cells for the verifying state, R-g, P-9 and IQW4-4 are fixed to match.
  [§5.3 R-a, R-g; §5.8; §5.8.1; §5.12; §5.13; §7; §12.1 P-9]
- **IQW5-2 (DQ5-2):** `-32009` on `thread/start` (A3 L254) is a **session-level startup failure**, not a turn failure.
  - The app draws no rail segment and no turn. It shows a full-width err card in the `05` style (err role, `✕` / `x`) with the engine's message (A3 L254 requires it to name the cause; the example text is not pinned), a one-line reason and a `madc doctor` hint. The `locks` WARN text is A3 L255.
  - The activity pill shows `✕ exit 5 · session`. Nothing about the session is drawn solid or green.
  - New after-error rule "Session start failed": input disabled, quit keys only, no retry, no final verify (no thread), no receipt (CLI:67).
  - The exit is **5**: CLI:193, `exit-codes.ts:57–58`, ERR1 L240. So nothing is added to M-2. Its interaction with M-2 (c) is noted in §5.11 [rev 6 rulings: the recorded 5 ranks, and a signal never replaces it, so every quit here exits 5].
  - Found while checking: `-p` gives the pre-thread lines here, not an `EXIT 5` card (`oneshot.ts:589–595`), so §7 splits the `-32009` row.
  - Surface's premise needs one correction: A3 L254 keeps the pinned `data` `{ threadId, path, seq }`, so the error does carry a `seq`. There is just no file and no turn to place it on.
  [§5.8, §5.11, §5.12, §7]
- **IQW5-3 (DQ5-3):** `<N>` is what R-c and CLI:131 already make it: the verifier's `line`, a 1-based line number (`session-store.ts:582`), never a byte count. A3 defines no number (L104–111). It is `line 1` for a 0-byte file (the value the code at `677332c` already reports, `session-store.ts:612`). For a NUL- or whitespace-only remainder `R` it is the first line of `R`, that is, the lines in `P` plus 1. The app prints whatever the verifier returns. [§5.3 R-c]
- **IQW5-4 (DQ5-4):** yes. A second `Ctrl-C` or SIGINT during a turn's interrupt grace forces the stop (CLI:112) and escalates to quit by interrupt (§5.8.1).
  - The final verify runs after the engine exits (ERR1 L276), then the restore, the §5.12 receipt and the §5.13 line `madc: interrupted (SIGINT)` (the key counts as SIGINT).
  - The exit is §17 M-2 (d). It is never 0 and never better than the session's worst state.
  - [rev 6 rulings: the exit is **130**, unless a 2, 3 or 5 was already recorded, which stays. The forced stop records no class of its own (ERR1 L228). If the final verify fails after the signal, the exit is 5 (§17.1 O-3, RULED in rev 6.2).]
  [§5.8, §5.8.1, §5.11, §5.13, §7]

- **IQW6-1 (DQ6-1, P-13).** Not a design question. The look is the same whichever form CLI:212 takes, so the form is pin wording and Surface's call. The design needs only that the new act (§17 M-4) may build the interactive app. [§12.1 P-13]
- **IQW6-2 (DQ6-2, ERR1 §3d).** Yes. New row E-e scopes ERR1 §3d to the one-shot and points the app at §5.11. This records the scope of Michael's M-2 ruling, which already says the app differs from the one-shot on purpose. It changes no code, no ladder and no look. [§12.2 E-e, §5.11]
- **IQW6-3 (DQ6-3, the new act).** The act's name and blast radius are a plan amendment for Surface and Michael, not a design call; the design works under any name. Two facts from the spec for that amendment: the app lives in `packages/cli` (§5), and M-1's stderr allowance adds an option in `packages/engine/src/client.ts` (and `sdk.ts` if it re-exports it), which E-c already names. Option 4 in §12.4 now lists E-c (and E-e); leaving E-c out was a spec error. [§12.4, §12.2 E-c]

---

## 17. Items for Michael (Founder rulings, not design calls)

**Source of every RULED item in M-1…M-5 below: Michael, 2026-09-26 08:54 Nassau, relayed by Surface Architect.** §17.1 has its own source. His words to Surface Architect were "Rule it". The ruling reached me only as a relay (§18 unverified 13).

- **M-1. The engine-stderr allowance** (P-6, E-c; pin W-1, K-1). **RULED, as recommended.** A narrow stderr allowance **for the new app act only** (M-4): engine stderr is passed through the engine client (an additive `spawnEngine` option, for example `stderr: "pipe"`; `-p` keeps `inherit`). No new protocol method and no engine behaviour change. It sits against CLI:48, CLI:202, CLI:208, PROTO:39 and ERR1 L148/L452 as a separate allowance; A1 is not stretched. Inline mode (IQW-15) is not the M0 path (§5.10).
- **M-2. App exit codes** (IQW-2, §5.11). **RULED:** the app exits with the worst turn's code, ranked the way the one-shot ranks them.
  - **Ranking:** ERR1 §3d, `3 > 2 > 5 > 4 > 1 > 0` (L245). Per ledger D-196 (LEDGER line 268; ERR1 §3d, L245; `oneshot.ts:532–553` at `677332c`), a 5 replaces only 0, 1 or 4, and an existing 2 or 3 stays. **Worst means by exit code, not by what the screen shows.**
  - **(a) UNVERIFIED — RULED.** CLI:81 says `UNVERIFIED` "does not change a success exit". So an UNVERIFIED turn counts with the exit its turn ended with (usually 0), and it is still never shown as success.
  - **(b) An in-app interrupted turn, then a normal quit.** The relayed ruling does not name this case. It was ruled in rev 6.2: 0 for that turn (§17.1 O-5).
  - **(c) A session with no turns — RULED.** It exits 0 if the final chain check at close passes, and 5 if it fails. The no-thread case exits 0 (§17.1 O-6, RULED in rev 6.2).
  - **(d) Signal exits — RULED (SIGHUP ruled in rev 6.2, §17.1 O-4).** SIGINT (external, the `Ctrl-C` key outside a turn, or a second one during a turn's interrupt grace) exits **130**, and SIGTERM exits **143** (CLI:111–113, CLI:194). **A signal never replaces a recorded 2, 3 or 5.** This deliberately differs from the one-shot, where a signal wins over everything (ledger D-196, LEDGER line 268; ERR1 §3d L245; `oneshot.ts:545–553`; ERR1 L233, L245). Michael ruled the difference on purpose. SIGHUP was left open here and ruled in rev 6.2: the app re-raises it (§17.1 O-4).
  - Related pinned fact for (b): ERR1 E4 (L285–286) gives exit 1, class `interrupted`, for an `interrupted` turn the CLI **did not** ask for, and 130/143 only when the CLI itself received the signal.
- **M-3. The idle deadline in the app** (E-b; pin K-7). **RULED, as recommended.** The app uses the same 10-minute (600 000 ms) per-turn idle deadline (LEDGER D-194/D-195, lines 265–266) and the same `MADC_TURN_IDLE_MS` override.
- **M-4. Which act builds the layout** (§12.4; pin W-2, K-2). **RULED, as recommended:** a new act (§12.4 option 4) after the A7 follow-up and before A8 (PL-2, PL-3).
- **M-5. Provenance** (pin K-5; L-2). **RULED, as recommended:** Clio posts the decisions comment on the design pin's PR. The 07:24 ruling, the rev 3 approval, LEDGER D-189 (line 78) and these 08:54 rulings get their GitHub record there. Until that comment exists, they stay unverified (§18). This spec posts nothing.

### 17.1 Ruled in rev 6.2 (formerly open)

**Source of every item below: Michael, 2026-09-26 10:51 Nassau, in Iris's chat: "Rule O-1 to O-6".** He was ruling Iris's recommendations, sent to him at 10:51. The ruling reached me directly in my chat, not as a relay (§18).

- **O-1. A time limit on the final verify. RULED:** the final verify R-g is bounded at **30 000 ms** (30 s). On timeout the turn shows `UNVERIFIED: verify interrupted`, never solid or green. P-9 carries the bound. Reasoning kept: 30 000 ms is the `RESPONSE_TIMEOUT_MS` value, and no pin sets any verify time limit (CLI:79–81; ERR1 L195 covers only three requests; the one-shot's verify is unbounded, `oneshot.ts:605–607`). [§5.3 R-a, R-g; §5.8.1; §12.1 P-9]
- **O-2. A second signal during the final verify. RULED:** it matches the one-shot for M0: restore the terminal, re-raise the signal, no receipt and no §5.13 line (§5.8.1). This is the known gap F-102 (ERR1 L427; LEDGER D-203), owned by the M1 CLI act. The app keeps it for M0 so the app and `-p` behave the same. [§5.3 R-g; §5.8.1; §5.12; §5.13; §7]
- **O-3. A final verify that FAILS after a signal was received. RULED:** the exit is **5**, not 130/143. The broken chain must not be hidden behind "interrupted", which is consistent with M-2 (d): "a signal never replaces a recorded 5". The §5.13 line is then `madc: interrupted (<SIGINT|SIGTERM>)` / `exit 5`. Reasoning kept: on every signal quit the final verify runs **after** the signal arrives (IQW5-1, ERR1 L276), so the order was ambiguous. This deliberately differs from the one-shot, which gives the signal code (ERR1 L233; `oneshot.ts:545–553`), like M-2 (d). A 5 recorded **before** the signal was already settled by M-2 (d): it stays. [§5.8.1; §5.11; §5.13; §7]
- **O-4. SIGHUP's exit status. RULED:** after the best-effort restore and engine stop, the app re-raises SIGHUP so the OS reports it (shells show 129). No new exit code is pinned, and the app itself never calls `exit(129)`. The receipt and the §5.13 line are best effort and may fail. Reasoning kept: no pin gives SIGHUP a code and there is no 128+n rule, and restore behaviour does not depend on the code (§5.0). [§5.0; §5.8.1; §5.11; §5.13; §7]
- **O-5. The old M-2 (b). RULED:** a turn the user interrupted in-app (`Ctrl-C`, answered, verified), followed by a normal quit, counts as **0** for that turn in the worst-code ranking. No signal ended the process: 130 would say it was killed, and 1 is for interrupts the CLI did not ask for (ERR1 L229, E4 L285). The turn is still shown INTERRUPTED, never as success. Other turns' codes still rank normally. [§5.11; §7]
- **O-6. A session with no turns and no thread. RULED:** it exits **0**: nothing was written, and there is nothing to verify. The chain pill stays `○ chain: nothing yet`, never green. Reasoning kept: `thread/start` is lazy (§5.1), so a session closed before any send has no thread, and no final check runs (R-g; `oneshot.ts:530`). A no-turn session with a recorded code (for example `-32009` gives 5, a seat error gives 2) still follows the ranking (IQW-2). [§5.11]

---

## 18. Verification log and unverified items

**Rev 6.2 rulings (Iris, 2026-09-26, read-only):**
- Source: Michael, 2026-09-26 10:51 Nassau, in Iris's chat, his words: "Rule O-1 to O-6". He was ruling Iris's recommendations on §17.1 O-1…O-6, sent at 10:51. The ruling reached me directly in my chat; it was not relayed. It has no GitHub record until a decisions comment exists (M-5).
- Every O-1…O-6 cite in the body now states the ruled result. The historical changelog rows for rev 5, rev 6 and rev 6.1 are left as they were.
- No new pin or code cites were added for rev 6.2; the cites kept in §17.1 are the ones already checked for rev 6 and rev 6.1. Main was not re-read for rev 6.2.
- Mock-ups: none changed.
- Rev 6.1 approval: Michael, 2026-09-26 10:50 Nassau, relayed by Surface Architect ("I approve rev 6.1: E-e and your P-13 wording"). Relayed only; see unverified 14.

**Rev 6 rulings checks (against main `677332c` via `git show origin/main:<path>` in `/workspace/madc/p0`, where `origin/main` = `677332c24f83…`; read-only):**
- CLI:81 ("`UNVERIFIED` does not change a success exit, but it is never shown as success"); CLI:111–113 (130, 130, 143); CLI:188–194, including CLI:194 "130 / 143 | interrupted | SIGINT / SIGTERM (§2)".
- ERR1 L99 (row D-169: exit 5 "only when the exit so far is 0, 1 or 4 (`:532-543`, D-187); a 2 or 3 is kept, and a signal wins (`:545-553`)"); L228 ("A forced signal records nothing here"); L229; L232–233; L235–245; L276; L285–286; L427.
- `oneshot.ts:528–553` at `677332c`: chain `failed` upgrades only `EXIT.ok`, `EXIT.failure`, `EXIT.provider` (`:534–537`); `signalExit` overrides at `:545–553`; the verify runs only `if (threadId !== null)` (`:530`).
- Citation fix (Surface Architect, 2026-09-26 10:09 Nassau; checked against LEDGER line 268 and ERR1 L245): the one-shot exit ranking is ledger **D-196** (ERR1 §3d, "signal (130/143) > 3 > 2 > 5 > 4 > 1 > 0"), not D-169. D-169 (LEDGER line 241 at 10:33; this spec earlier gave both 248 and 249 for 08:11, and both are superseded) is only the missing-session-file reading, and D-187 (LEDGER line 263) is chain FAILED outranking exit 4. The rulings are unchanged.
- LEDGER (mtime 2026-09-26 08:11:03 −04:00): D-169 line 248, superseded: line 241 at 10:33, see "Rev 6.1 citation base" (ledger row; the erratum's own D-169 row is ERR1 L99); D-194 line 265; D-195 line 266; D-203 line 84; D-189 line 78.
- Mock-ups: only `overview-sheet.png`'s title changed (rev 5 → rev 6); see the changelog.

**Rev 6.1 citation base (Iris, 2026-09-26, read-only):**
- Every ERR1 line number in this spec was read at `677332c`. Live main is now `903610f` (#22, E17a), which inserts two lines at ERR1 L5 and changes nothing else in ERR1 (`git diff -U0 677332c 903610f -- docs/plan/PIN-madc-M0-cli-erratum-1.md`). So at `903610f`, every ERR1 cite of L5 or later here is 2 higher: for example, ERR1 L245 is L247 and §3d L224–245 is L226–247. The text at each cite is unchanged.
- E17a is `docs/plan/PIN-madc-M0-cli-erratum-1-E17a.md` at `903610f`, pointed to from ERR1 L5. It is now cited in §7 (NOT STARTED row). §7 and frame `05` already matched it, so nothing about the look changes.
- LEDGER line numbers moved. Re-read at mtime 2026-09-26 10:33:51 −04:00, sha256 `7f0a9e41d65f…`: D-147 line 223; D-169 line 241; D-187 line 256; D-189 line 73 (also lines 31 and 401); D-194 line 259; D-195 line 260; D-196 line 261; D-203 line 79; D-210 line 269; D-214 line 271; D-216 line 83; D-222 line 276; D-223 line 85. Earlier line numbers in this spec are for the 08:11 ledger and are superseded by these. Cite by D-id first.

**Rev 6 checks (against main `677332c` and Surface's `e4b27e1`, read-only):**
- The eight `spec/src677/` copies are byte-identical to `git show 677332c:docs/plan/<file>` (compared with `cmp`) in the worktree `/workspace/madc-rulings/docs-drafts/m0-design-witness`.
- The branch there reads `677332c` → `76f08ce` → `a312ab7` → `e4b27e1`. `e4b27e1`'s pin §16.3.2 holds DQ5-1…DQ5-4.
- Re-read at `677332c`: CLI:67, :79–81, :111–113, :131, :193–194; ERR1 L21, L46, L181, L190, L195, L224–245 (§3d), L276 (E2), L285–286 (E4), L427 (F-102); A3 L102–149 (§2), L254–255; PROTO:124.
- Code via `git show 677332c:`: `exit-codes.ts:6–15, 57–58`; `oneshot.ts:219–236, 469–478, 528–553, 589–595, 605–607`; `bin.ts:22–27`; `session-store.ts:567–585, 611–629`.
- LEDGER (mtime 2026-09-26 08:11:03 −04:00): D-147 line 230; D-189 lines 78, 32 and 403; D-194 line 265; D-195 line 266; D-203 line 84; D-210 line 272; D-214 line 274; D-216 line 91.
- Every PNG and `build_spec.py` compared by sha256 with `spec/rev5-archive/`: identical.

**Rev 5 checks (against main `677332c`, Surface's `9217b20`, read-only):**
- `git ls-remote` → `677332c`.
- PR #20, #19 and #16 were read through the GitHub API; the merge times above are its `merged_at` values converted to Nassau.
- `git diff --stat df2e22d 677332c` and `git diff --quiet … -- packages` as in the header.
- A2 and SEAT +2 confirmed line by line at the cited rows (for example SEAT:12 D4 `madc-default`, SEAT:124–133 envelope, A2:61 §5, A2:98 size bound).
- ERR1 L117–161 (§3b) and CLI:103–107, :111–113, :194 re-read.


**Verified for rev 3 (against main `df2e22d`, read-only):**
- `main` = df2e22d (`git ls-remote`). PR #21 merged at 06:24:39 Nassau (API `merged_at 10:24:39Z`), head 8ba515b.
- The trees are identical for the erratum (`git diff 8ba515b df2e22d` empty).
- `packages/` is unchanged from 343da29 (`git diff --quiet … -- packages`, exit 0).
- The CLI +2 shift at line 5 is confirmed by diff. PROTO lines 5–8 were reordered only.
- (rev 5) PR #20 (Amendment 3) is **merged** at 677332c. Its torn-tail widening is folded into R-c, and its `-32009`/`locks` WARN into §7.
- Contrast was recomputed (§3.1).
- Every PNG was read after generation.
- Local refs only: `git fetch origin main refs/pull/21/head` in `/workspace/madc-reviews/work-r6`. Nothing was pushed.

**Unverified:**
1. The 07:24 ruling (reached me only as a relay).
2. LEDGER D-189, line 78 (no GitHub source).
3. The F-130 code: local, unpushed branch `hephaestus/m0-a7-followup-validation` @ 71b40f0. The text is verified only in ERR1 L354.
4. How often the engine and vendor children write to stderr (P-6).
5. The terminfo and alternate-screen heuristics (Q14).
6. Windows VT behaviour (Q8).
7. Surface's draft Level A pin (784b332), which I have not read. If it differs from §6.2, §6.2 is my proposal.
8. Every illustrative value in §14.
9. (rev 4) That `node:worker_threads` works the same under Node and Bun for the verify worker (IQW-5). I have not tested it.
10. (rev 4, revised in rev 5 and rev 6) SIGHUP: the restore is a design and has not been checked on each platform. Its exit status was ruled in rev 6.2 (re-raise, §17.1 O-4); the re-raise after restore is not tested on Node or Bun either.
11. (rev 6) The `line` value the A3 code act will return for a 0-byte file and for a NUL- or whitespace-only tail (R-c). §5.3 gives the value the code at `677332c` implies, and the app prints whatever the verifier returns.
12. (rev 6) Restore-then-re-raise on a signal during the final verify (§5.8.1) is not tested on Node or Bun.
13. (rev 6) Michael's rulings on §17 M-1…M-5 (Michael, 2026-09-26 08:54 Nassau, relayed by Surface Architect). They reached me only as a relay and have no GitHub record until Clio's decisions comment (M-5).
14. (rev 6.2) Michael's approval of rev 6.1, including the §12.2 E-e row and Surface's P-13 wording (Michael, 2026-09-26 10:50 Nassau, relayed by Surface Architect: "I approve rev 6.1: E-e and your P-13 wording"). It reached me only as a relay and has no GitHub record.

**Rev 4 checks (against main `df2e22d` and Surface's `5f451b4`, read-only):**
- Surface's worktree `/workspace/madc-rulings/docs-drafts/m0-design-witness` @ `5f451b4` (parent df2e22d), pin §13–§19 read.
- Each §A fix was re-checked in the df2e22d copies (`spec/srcdf2/`): M0PLAN:240, 247–248; CLI:37–40; ERR1 L450/L452, L117–161, L163–203, L358–370; PROTO:74–79, 133, 209–213; `oneshot.ts:34–36, 203, 207–232, 448–468`; `exit-codes.ts:6–15`; `main.ts:87–94`; `session-store.ts:767, 795` (via `git show df2e22d:`).
