# CWD-FIELD addendum for PR #81 (M3-A4 pin revision)

**Status:** approved by Mike 2026-11-27 (via MADC Architect), 11:33 PM ET: the `cwd` is typed into a field in the pane header; a palette field was rejected.

**For:** Surface Architect, to replace the two-step palette `cwd` field in `docs/plan/PIN-madc-M3-A4-multi-seat-workspace.md` §5.3 (PR #81, head `fef26e6e7f4c322272f4a9e9378cf192472213e4`, lines 241–245), to reword acceptance item 25 (line 380), and to close FDR-A4-4 (lines 87, 415).

**What this file is.** Section 6A of `DESIGN-SPEC-m3-a4-equal-columns.md` (r2), copied verbatim and nothing else. Section references (§5.5, §6.2, §6.3, §6.4, §8.1, §11) are to that spec. The full spec r2 has sha256 `b4c4e5ec8ff2223c1c4d15bb6af88f4fd8c2b2490b8d66f72775235989f07a1a`. Spec r2 replaces the r1 spec PR #81 carries as `docs/plan/sources/DESIGN-SPEC-m3-a4-equal-columns.md` (sha256 `545825360d535b7ec55114e7e16edeaf8f396ac1e66d3328d0d905bd8e429aea`).

**Frames** (box-only, not in the repo; same convention as A3 and PR #81 pin):

| Frame | sha256 |
|---|---|
| `/workspace/iris-madc-m3a4/cwd-field-1440.png` | `3d338e9ade257d4729922f4f74bf403b302391d4eb0ec6b57b4749c8ea1abd65` |
| `/workspace/iris-madc-m3a4/cwd-field-960.png` | `57296131bef8fb1995fa7e91695ab377b62390e569aa579de174950ed4171ceb` |
| `/workspace/iris-madc-m3a4/cwd-field-states.png` | `2b6d0567af12488297461292c3cd3c9c31e9c35f9a8f9fc1b82b74a24c4e5ba2` |
| `/workspace/iris-madc-m3a4/direction-a-final.png` (1440), `-1200.png`, `-960.png` | `541103c9…`, `e6eb788f…`, `22ab2adb…` |

**Pin items this changes (for the PR #81 revision):** §5.3 replaced by §6A below; `cmd-pane-new:‹seatId›` creates a draft pane and sends nothing (spec §8.2); pane state table gains a **Draft** state before **Starting thread** (spec §6.3); the receipts well is replaced by a one-line note until `thread/start` returns (spec §6.2); `Dismiss pane` also applies to a draft pane (spec §5.5, §8.2); the composer target reason `no thread loaded` also covers a draft pane (spec §7.2).

---

## 6A. cwd field (pane header)

Approved by Mike 2026-11-27, 11:33 PM ET (via MADC Architect): the user types an absolute `cwd` into a **field in the pane header**. A palette field for the `cwd` was rejected, so there is no second palette step and no `cwd` palette command. This section replaces the two-step palette field in A4 pin §5.3 (PR #81 `docs/plan/PIN-madc-M3-A4-multi-seat-workspace.md:241-245`) and closes FDR-A4-4 (same file `:87`, `:415`). Frames: `cwd-field-1440.png`, `cwd-field-960.png`, `cwd-field-states.png`, and the pane headers in every `direction-a-final*.png`.

### 6A.1 What the `cwd` feeds into (evidence; real names only)

| Fact | Source |
|---|---|
| The only method that takes a `cwd` is `thread/start {seatId?, cwd?}`. `thread/resume` takes `{threadId}` and is deferred in A4. | M1 PIN lines 75–76; PR #81 pin `:102` (D2) and `:76` (FDR-1 / D-708) |
| In A4 the desktop sends `thread/start {seatId, cwd?}` with the `cwd` taken from this field. With no `cwd` the engine records `worktree: null`, so `worktree.topLevel` and `head@open` stay `—`. | PR #81 pin D3, `:103`; FDR-2 / D-709, `:77`, `:243-245` |
| Desktop shell check before the request is written: keys ⊆ `{seatId, cwd}`; `cwd`, if present, is a string of 1..=4096 bytes, has no NUL, and is **absolute** (`Path::is_absolute`). Syntactic only; existence is the engine's. A refusal is the R5 string `RPC params refused by desktop shell for thread/start: ‹reason›`, which never calls `disconnect_engine`. | PR #81 `docs/plan/PIN-madc-M3-desktop-protocol-amendment-2.md:81` (§1.2 table), `:67`, `:70-74` |
| The engine checks only that `cwd` is a string (`-32602`, `issues: ["cwd must be a string"]`). It does **not** check that the path is absolute, exists, or is a git work tree. | `packages/engine/src/server.ts:1357-1366` |
| The engine records `session.open.payload.cwd` and the engine-owned `worktree` identity `resolveWorktreeIdentity(cwd)`: `null` for a null or blank `cwd` or when no git work tree is found; otherwise `{topLevel, remote, head}`, where `topLevel` is the **realpath** of the git top level. A path that does not exist, or is not in a work tree, is **accepted** and yields `worktree: null`. No error is returned. | `server.ts:1451`; `packages/engine/src/worktree.ts:85-95`; `session-v2.ts:23-30` |
| `Thread.cwd` in the `thread/start` result echoes the `cwd` (or `null`). | `packages/engine/src/protocol/types.ts:23-31`; `server.ts:1481-1489` |
| **Exception, seats with `seat.worktree === true`:** the engine creates a detached worktree under `$MADC_HOME/worktrees/<threadId>` and uses that path as `Thread.cwd`. It refuses with `-32602`, `data.issues`, when the `cwd` is blank (`worktree mode requires a non-empty git cwd`) or not in a git repository (`worktree mode requires a git repository cwd`), or when `git worktree add` or confinement fails. These are the only path-related engine refusals on `thread/start`. No seeded seat sets `worktree` (`seats/roster.ts:26-110`); only user-authored seats do. | `server.ts:1437-1447`; `worktree.ts:165-209` |
| The `cwd` is also what the engine resolves a repo identity from at `turn/start` for repo-gated backings: `-32007` with reason `repo-not-allowed` or `repo-identity-ambiguous`. The typed string is never matched against an allowlist. So a wrong `cwd` can surface later, on the `turn/start` row, not on the field. | `server.ts:430-470`; M1 PIN line 153 |
| No allowlisted method changes a thread's `cwd` after `thread/start`. | M1 PIN §3 methods; PR #81 amendment 2 §1.1 (eight methods) |
| `worktree.topLevel` is read only from a `session/read` of the seq-0 `session.open` or from a user-run `Inspect room`. The typed `cwd` is **never** shown as `topLevel`. | PR #81 pin `:197`, `:203-209` (§4.4); A3 pin §4.3 |

### 6A.2 Placement (all widths: inside the pane header)

The pane header gains a **cwd block** under the top row (§6.2). Same markup at 960, 1200 and 1440; only the width of the input changes. All values below come from `final.css`.

- **Top row:** unchanged (position + seat + thread line at the left, turn pill at the right). Draft panes (no thread yet) show the thread line `no thread yet`.
- **cwd block**, `margin-top: 8px`:
  1. **Row 1**, height 28px, gap 8px: key `cwd` (mono 11, `--madc-fg`, 26px column) and the input (`flex: 1; min-width: 0`).
  2. **Row 2**, `margin-top: 6px`, min-height 26px: the field state (§6A.4) at the left, and the `START THREAD` button (`.btn.sm`: 26px high, padding `0 10px`, UI 11/600, tracking 0.06em, uppercase) at the right.
  3. **Row 3**, `margin-top: 4px`: the reason line (mono 11/15 muted, wraps). For `REFUSED`: a chips line (`margin-top: 6px`) first, then the issues lines.
- **Input:** tier-0 well (`--madc-darker`, 1px `--madc-border`, radius 3px, `--madc-well-inset`), padding `0 8px`, mono 12/500 `--madc-bright`. Placeholder `/absolute/path · optional` in `--madc-muted`. Focus: 2px `--madc-accent` outline, offset 1px (not status). Fail states: the border is `--madc-red`.
- **Started row** (§6A.3): `cwd` key | read-only value | `○ STARTED`, one row of 22px, `margin-top: 6px`.

| W | Pane width | Input width (about) | Characters at mono 12 (7.2px/char, inside padding) |
|---|---|---|---|
| 1440 | 335px | 277px | ≈ 36 |
| 1200 | 558px | 500px | ≈ 67 |
| 960 | 445px | 387px | ≈ 51 |

Only draft panes use rows 1–3 (about 100px). A started pane uses the 22px started row, so a started pane costs 28px more than before this section (the 1440 frame still fits: the receipts well is the only scroller, §5.6).

### 6A.3 When it is editable

| Pane state (§6.3) | Field | Editable | Start button |
|---|---|---|---|
| Draft (just created by `New pane on seat ‹seatId›`; no request sent) | input | **yes** | enabled unless `REJECTED` |
| Start failed (`thread/start` refused) | input | **yes** (the refused text stays; editing clears the refusal display) | enabled unless `REJECTED` |
| Starting thread (`thread/start` in flight) | input, `readonly`, 65% opacity | no | disabled |
| Started (thread loaded; any later state) | plain read-only value (no input chrome), selectable | **no** | absent |
| History (connection ended after start) | read-only value | no | absent |

- The `cwd` is fixed once the thread starts, because no engine method changes it (§6A.1). To use another path, open another pane. A started pane cannot be closed (§5.5), so the old pane stays; this is why the field is explicit about being a one-shot choice (the `START THREAD` label and the `STARTED` word).
- The started value is `Thread.cwd` from the `thread/start` result: `—` in muted when `null` (no `cwd` was sent). It is plain neutral text and carries no pill, because a path is not a receipt. `title` and the accessible name hold the full path.
- If `Thread.cwd` differs from the text that was sent (a `worktree: true` seat, §6A.1), the started row gets a second line (mono 11 muted): `engine path · typed ‹sent path›`. **[not framed]**
- **Where `worktree.topLevel` is shown.** It is shown in the pane's receipts well (§6.4), as the engine's realpath with the note `field · not a receipt`, directly under the header's started cwd. It is `—` with the note `not read yet` until the first `session/read` or `Inspect room` for that thread (PR #81 pin §4.4 sources). It is `—` with the note `no git work tree recorded` when a read shows `worktree: null`. It is never copied from the typed `cwd`.

### 6A.4 Field states: glyph, word, colour

The **field state** is a status text (glyph + word, mono 11/600, tracking 0.06em, uppercase), **not a pill**. Its six words are closed and are not in `ALLOWED_PILL_LABELS`. Implementation: one pure function `cwdFieldState(text, phase)`. Its tone is `neutral` or `fail` only: **it can never return `verified` or `warn`**. The glyph is `○` (neutral, `--madc-bright`, word in `--madc-fg`) or `✗` (fail, glyph and word in `--madc-red`, plus a red input border). The turn pill beside it stays `○ IDLE` in every draft state.

| # | State | Glyph + word | Tone | When | Reason line (verbatim) | Request |
|---|---|---|---|---|---|---|
| 1 | Empty | `○ NO CWD` | neutral | text is `""` | `optional · Enter starts without a cwd (worktree —)` | none |
| 2 | Typed, not yet checked | `○ UNCHECKED` | neutral | non-empty, passes the local check (§6A.5) | `syntax ok · engine not asked · Enter starts` | none |
| 3 | Client-side reject | `✗ REJECTED` | **fail** | non-empty and fails the local check | the reason from §6A.5, followed by `· nothing sent` | none |
| 4 | Engine reject | `✗ REFUSED` | **fail** | `thread/start` returned an error (or R5) | chips `code ‹n›` + one chip per scalar `data` key; each `data.issues` entry as a muted line, verbatim, sanitised per A3 §4.2 | already sent; none pending |
| 5 | Accepted, thread starting | `○ STARTING` | neutral | `thread/start` in flight | `field locked until thread/start returns` | `thread/start` pending |
| 6 | Started | `○ STARTED` | neutral | `thread/start` returned `{thread}` | none (the value row carries it) | none |

- **Accepted is neutral (Mike).** Nothing about a path ever goes green. `STARTED` means only that the engine returned a thread; it does not say the path exists or is a git work tree (§6A.1). The `worktree.topLevel` and `head@open` rows (§6.4) say what the engine recorded.
- **State 4** never disappears on its own: it clears when the text is edited or when the next `thread/start` on this pane succeeds. The same text is not re-sent automatically.
- **Codes that can appear on `thread/start`** (render whatever the engine or shell returns): `-32602` (`data.issues`), `-32005` SeatNotFound and `-32006` SeatInvalid (`data` has `seatId`, `path`, and for `-32006` `issues`), `-32009` SessionWriteFailed (`threadId`, `path`, `seq`), and `-32603`; M1 PIN §4 lines 133–155. The R5 string (§6A.1) is shown as the reason line verbatim with no chips, as a defect guard (A3 pin §6.4 R1 treatment): the connection stays `CONNECTED` and `disconnect_engine` is never called.
- **Connection lost before the result** (R2/R4, A3 pin §6.4): the pane returns to state 2 (or 1) with the reason `connection ended before thread/start returned`. Whether the engine created a thread is unknown to the window. **[ASSUMPTION: unpinned]** A late `thread/start` result from a past epoch changes nothing (A3 N5; PR #81 pin §6.1 rules).

### 6A.5 Local check (pure function; no I/O, no request, runs on every edit)

`cwdCheck(text)` returns `{ ok, reason }`. The text is **never trimmed or normalised**; the value sent is the exact typed string (PR #81 pin acceptance 25, `:380`).

| Input | Result |
|---|---|
| `""` | `ok`, state 1 |
| contains U+0000 | reject: `contains a NUL character` |
| UTF-8 length > 4096 bytes (bytes, not characters) | reject: `longer than 4096 bytes` |
| starts with `~` | reject: `~ is not expanded · type the full path` |
| does not start with `/` (POSIX; the Windows desktop is out of scope in A4, PR #81 pin `:347`) | reject: `not absolute · must start with /` |
| otherwise (including `/` alone, spaces inside, a trailing `/`, a path that does not exist) | `ok`, state 2 |

This matches the Rust check `Path::is_absolute` plus the 1..=4096 and NUL rules (PR #81 amendment 2 `:81`) on POSIX, so a text that passes here can only fail at the engine. `REJECTED` disables the button, and Enter sends nothing. R5 can then only be a defect, never a normal outcome.

### 6A.6 Keys

| Key (in the cwd input, no IME composition in progress) | Action |
|---|---|
| `Enter` (no Cmd, Ctrl, Alt or Shift) | **Start the thread.** States 1, 2, 4: send exactly one `thread/start` (§6A.7), only while the connection is `CONNECTED`. State 3: send nothing, keep focus, announce the reason (§6A.9). State 5: ignored (single-flight). |
| `Esc` | **Revert the edit** to the baseline text (the prefill at creation, or the last text sent with Enter) and recompute the state from it. If the text is already the baseline, move focus to the pane (its `region`) and do nothing else. `Esc` never dismisses the pane, never sends a request, never interrupts a turn. It stops propagation, so it cannot close the palette (the palette is not open while this field has focus) or the quit dialog. |
| `Cmd+Enter` / `Ctrl+Enter` | **Nothing** in this field. These keys start a turn only from the composer input (§8.1, R6). They never start a thread, and `Enter` in this field never starts a turn. |
| `Shift+Enter`, `Alt+Enter` | Nothing. |
| `Cmd/Ctrl+1`–`4` | Unchanged (§8.1): focus another pane. The edit is kept in that pane's draft. Focusing a draft pane puts focus in its cwd field. |
| `Cmd+K` / `Ctrl+K` | Unchanged: toggles the palette. The edit is kept. |
| `Tab` / `Shift+Tab` | Order inside a draft pane: `cwd` input → `START THREAD` → `DISMISS PANE`. |
| Text editing (`Cmd/Ctrl+A/C/V/X/Z`, arrows, `Home`, `End`) | The platform's own. They are not application shortcuts. |

- **No `Ctrl+F` / `Cmd+F`** anywhere (R6). No new global shortcut is added, so A3 Q2 / D-680 as superseded for the R6 keys only (C53 / D-722) is unchanged.
- **On creation** (`New pane on seat ‹seatId›`): the draft pane appears, takes the rightmost visible slot (§5.5), and the field takes focus with the prefill selected. The prefill is the last `cwd` sent in this window (none on first use; PR #81 pin `:243`), so typing replaces it and `Enter` starts with it. Nothing is sent until `Enter` or the button.

### 6A.7 Request

`thread/start` with exactly the keys `seatId` (the pane's seat) and, **only when the text is non-empty**, `cwd` (the text, unchanged). One request per Enter or click. Single-flight per pane (A4 pin §6.1 "Starting thread"). Result `{thread}`: the pane becomes Started with `Thread.cwd` and `Thread.id`; the engine also sends `thread/started` and `room/updated {reason: "thread"}` (`server.ts:1389-1392`), which the pane does not need for this transition.

### 6A.8 Long paths

- **Unfocused or read-only** (value longer than the box): the value truncates from the **start** with a leading `…` (`direction: rtl`, `text-align: left`, `text-overflow: ellipsis`, the text in `<bdi>`), so the last path components stay visible, as for `topLevel` chips (§6.4). Unfocused editable fields use a presentational overlay span (`aria-hidden`) over the real input; focus swaps to the input.
- **Focused:** the native input, scrolled to the caret (the tail is visible while typing). A 16px fade on its left edge (mask on an inner clip wrapper, so the focus outline is not masked) shows that text continues to the left. `Home` shows the start.
- **Always fully editable:** truncation is presentation only. The value is never altered, and the full text is in `title` and the accessible name. At 960 (about 51 characters of input) a 90-character path is edited with caret movement as in any text field.

### 6A.9 Accessibility

- `<label for>` `cwd`; `aria-describedby` points to the reason line; `aria-invalid="true"` in states 3 and 4; `aria-readonly="true"` in state 5; the started value is `role="textbox"`-free plain text with `aria-label="cwd ‹full path›"`.
- The state is not announced on every keystroke. The polite live region (§11) announces `‹seat›: cwd ‹WORD› ‹reason›` only when Enter is pressed in state 3, and for the results of `thread/start` (`REFUSED`, `STARTED`).
- Glyph + word carry the meaning in `forced-colors` (A3 §3.4, D8 selector pattern applies to `.fst .g`); the red border is redundant.
- `START THREAD` uses the A3 button focus ring.

### 6A.10 Acceptance checklist (CI-testable; fake DOM per A3 pin D6)

C1. `cwdCheck` table (§6A.5): `""` ok; `"/"` ok; `"/a b/"` ok (value unchanged); `"relative"`, `"./x"`, `"~/x"`, `" /x"` (leading space) reject, with the `~` reason only for `~`; a NUL rejects; 4096 bytes ok and 4097 bytes reject; a multi-byte path is measured in bytes; no trimming.
C2. `cwdFieldState` returns only the six words and only `neutral` or `fail`. Property test over text × phase: never `verified`, never `warn`. `STARTED` is `neutral`. No element in the cwd block has `data-tone="verified"`.
C3. Enter in state 3 sends **zero** `rpc_request`. Enter in states 1/2/4 sends exactly one `thread/start` whose params keys are exactly `{seatId, cwd}`, or exactly `{seatId}` when the text is empty, with `cwd` byte-identical to the typed text.
C4. A second Enter or click while state 5 sends nothing.
C5. `Esc` restores the baseline text and sends nothing; `Esc` on an unchanged field only moves focus; the pane is never dismissed by `Esc`.
C6. `Cmd+Enter` and `Ctrl+Enter` in the cwd input send neither `thread/start` nor `turn/start`. In the composer input they send only `turn/start`, and `Enter` in the cwd input never sends `turn/start`.
C7. The input is `readonly` in state 5 and absent (plain text) in state 6; editable in states 1–4.
C8. State 6 shows `Thread.cwd` from the result. Test with a result whose `cwd` ≠ the typed text: the header shows the result's value. The typed `cwd` string never appears in any `topLevel` chip; a `topLevel` chip appears only from a `session/read` or `room/inspect` value.
C9. `-32602` with `data.issues` renders `✗ REFUSED`, chip `code -32602`, each issue verbatim; the field stays editable; the connection stays `CONNECTED`; `disconnect_engine` is invoked zero times; a following Enter sends exactly one more `thread/start`.
C10. The R5 string renders `✗ REFUSED` with the reason verbatim and no chips; `disconnect_engine` is invoked zero times.
C11. `New pane on seat ‹seatId›` creates a draft pane and sends no `rpc_request`; its composer target reads `no thread loaded`; `Dismiss pane` on it sends nothing and removes it.
C12. No `keydown` handler reacts to `f` with Ctrl or Meta; no new global handler exists.
C13. Long-path static assertions: the unfocused value rule has `direction: rtl`, `text-overflow: ellipsis` and `<bdi>`; the stored value equals the typed text; `title` holds the full path.
C14. Static stylesheet assertion: no rule in `.cwd`, `.cwd-in` or `.fst` uses `--madc-green` or `--madc-yellow`.
C15. State 4 is cleared only by an edit or a successful start, never by a timer.

### 6A.11 Not bound to real evidence in this section

- The six field words, the `START THREAD` label, the reason strings, and the prefill selection are design text, not protocol.
- The prefill with the last `cwd` is from PR #81 pin `:243`; the select-on-create is mine.
- State 4 after a lost connection (§6A.4) and the `engine path · typed …` line are unframed assumptions.
- The refusal frames show a custom seat `reviewer` with `worktree: true`, because no seeded seat can produce a path-related `-32602`. The seat name is mock data.
