# MADC CLI design spec: Tokyo Night chat with a git side panel

**Status:** Approved by Michael Daley 2026-10-05 (Omarchy git-panel). Ready for Surface to pin. Still not a pin until Surface merges a pin. Where it differs from a merged pin, the pin wins until a pin change is merged (same precedence rule as rev 6.2 §1).

**Decisions applied:** Michael Daley answered a set of open questions on 2026-10-04. On 2026-10-05 he approved this Omarchy git-panel look and accepted Iris's ruled answers for Q1 and Q10 without override; those are folded in below. Questions still open stay in §12 (Q13, Q16, Q17, Q18 are out of #54 scope per Surface). This is still not a pin until Surface merges a pin.

**What it replaces:** the visual system of `docs/plan/sources/DESIGN-SPEC-witness-rev6.2.md` ("rev 6.2"): the wordmark banner, the per-turn rail, cards, pills, the evidence pane, the key-hint bar and the big block-art verdicts (COMPLETED / FAILED / EXIT n). It keeps the rev 6.2 rules that are product constraints: protocol, exit codes, the TTY gates, NO_COLOR, piped output, `--json`, pinned strings, and the width minimum. §11 lists what is dropped.

**Visual source of truth:** the three approved frames, except where a 2026-10-04 decision changes a frame. Those decisions win. Each difference is noted in one sentence where it applies. Everywhere else, if this text and a frame disagree, the frame wins and the text is a bug.

| Frame | File | sha256 |
|---|---|---|
| Startup | `/workspace/madc-design/directions-tokyo/omarchy-git-panel/startup.png` | `f4737d433e84dc8a089c8607a6368c62e5eafe1e8eec73e5cdfe29a9553c5e89` |
| Verified turn | `/workspace/madc-design/directions-tokyo/omarchy-git-panel/verified.png` | `6a2f0e8b397820405a5cfc86e0d241ca0ba7a34878845085478fb4b313ffb955` |
| Chain failed | `/workspace/madc-design/directions-tokyo/omarchy-git-panel/failed.png` | `601536ffd79f071477ed37a09d303bae204900705087087265c14b7ac7cd91ad` |
| All three | `/workspace/madc-design/directions-tokyo/omarchy-git-panel/sheet.png` | `92c4e32ff9f7a6a80e55efc5cc1bd5450bab3375ce68f64ea1f144e83962dd7c` |

Frames regenerated 2026-10-05 on Iris's box; originals at iris-madc-directions/mix were not present. Character layout matches Appendix.

The frames were drawn by `/workspace/madc-design/directions-tokyo/omarchy-git-panel/render_mix.py` (sha256 `6c6c6272595e8cbab20dbe7f3eb8a0d5433a3e77256277395a6c3ee5c79f4654`) on a 100×36 cell grid. Column and row numbers in this spec are 0-based cells from that script. The character layout of each frame is in the Appendix.

**Sources read for this spec:**
- rev 6.2 (the previous spec), §2, §3, §4, §5, §6, §7, §9, §10, §11, §13.
- `docs/plan/PIN-madc-M0-cli.md` ("CLI"): §2 signals, §3 doctor, §4 exit codes.
- `docs/plan/PIN-madc-M1-protocol-messages.md`: `protocolVersion` `madc-m1/1` (P1).
- `docs/plan/PLAN-madc-M1-build-plan.md`: doctor lanes report and terms freshness (row H, M1-A8).
- `docs/runbook/M0.md` §7 (app keys, as built on the Witness branch).
- `/workspace/madc-design/directions-tokyo/omarchy-git-panel/refs/omarchy-colors.toml` (Omarchy Tokyo Night).

---

## 1. Scope

- **In scope:** the full-screen chat app (bare `madc`, `madc "<text>"` on a full TTY), its line-mode fallback, and its exit output.
- **CLI first.** The desktop app comes later and takes this look over unchanged (§10).
- **Not changed by this spec:** non-TTY bytes, `--json` bytes, exit codes, the receipt text, doctor row text, protocol messages. See §2.
- **`madc -p` and `madc doctor` on a TTY:** rev 6.2 gave them tier-W cards with block art. Block art is retired. Both use a one-line verdict, like the chat, instead of the old cards (decided 2026-10-04). Whether a launch doctor still runs, and how doctor rows are drawn inside the app, is still open (Q13).

---

## 2. Hard rules carried from rev 6.2

These are product rules. Nothing in the new look may break them.

1. **Non-TTY output is byte-stable.** When stdout is not a TTY: agent text only, no ANSI codes, plain receipt (CLI:64, CLI:233). The app does not start unless stdin, stdout **and** stderr are all TTYs. Otherwise bare `madc` and `madc "<text>"` keep today's bytes and exit 2 with zero SGR (rev 6.2 §5.0).
2. **`--json` is untouched.** It prints exactly one JSON object and nothing else, with no colour or chrome in any mode (CLI:65, 86–107).
3. **Exit codes are untouched.** The CLI §4 table stands: 0 ok, 1 turn failure, 2 usage/config, 3 engine, 4 provider, 5 session, 130/143 signals. The app's worst-code rule is rev 6.2 §5.11, restated in §6.3. Styling never changes an exit, and no new code is invented.
4. **Protocol is untouched.** This spec adds no field, method or notification.
5. **The stdout/stderr split is untouched** for `-p` and doctor. The app draws on the alternate screen it owns, never writes to stdout while it owns the screen, and writes the exit receipt to stderr after it restores the terminal (rev 6.2 §5.0, §5.12).
6. **Honesty.** Green and `✓` appear **only** on verified evidence: `chain VERIFIED` (CLI:80), or a doctor PASS with evidence (CLI:140–141). A turn that ended UNVERIFIED is never shown as success (CLI:81). `ready` is not a verdict, so it is accent, never green.
7. **Failure is never quieter than success.** In the new look the verdict is one line. The failed line has the same row count, column, position and weight as the verified line, and it is red where the verified line is green. On failure the status bar also turns red (`chain failed`). On success it does not turn green (`ready`, accent). So failure is louder than success, never quieter.
8. **Meaning is never carried by colour alone.** Every state has a word and a glyph of a different shape (`✓` vs `✗` vs `▲`). Under NO_COLOR the words still say VERIFIED or FAILED.
9. **No emoji, no spinners, no progress bars** (CLI:142). Glyphs are text presentation and are never followed by U+FE0F. Elapsed times are numbers that update at most 5 times a second. No blinking, no animation.
10. **Pinned strings are rendered verbatim.** The app never re-wraps, truncates or edits a pinned line. The terminal soft-wraps a pinned line that is too long.
11. **Engine text is sanitised** with ERR1 E11 before it is drawn: every C0 control except TAB and LF, plus DEL and C1, becomes U+FFFD. This covers agent text, tool names and arguments, and error messages.
12. **Terminal restore** on every catchable exit path (rev 6.2 §5.0): cursor on, leave the alternate screen, cooked mode, then the receipt, then the exit. The runbook's `reset` line covers SIGKILL.

---

## 3. Layout

### 3.1 Regions

The screen has exactly four regions. No other chrome exists.

| Region | Where | Contains |
|---|---|---|
| **Conversation** (center) | Rows 1 to H−3, columns 2 to the panel gap. Takes most of the width. | Startup block before the first turn, then the transcript. |
| **Git panel** (side) | Top of the right side, rows 1–7, fixed. | Title `git`, branch, a two-commit graph, ahead/behind. If the folder is not a git repo, the panel stays and says the folder isn't a repo. Nothing else. |
| **Status bar** | Row H−2, full width, `lighter` background. | Seat on the left, state in the center, time and model on the right. Nothing else. |
| **Composer** | Row H−1 (last row). | A single `❯` prompt line. |

Row 0 is blank. Columns 0–1 are a left margin.

### 3.2 Geometry (terminal W columns × H rows, W ≥ 80, H ≥ 24)

Taken from the frames (W = 100) and generalised so the panel stays the same and the center absorbs the width.

| Element | Rule | At W = 100 (frames) | At W = 80 |
|---|---|---|---|
| Glyph column (`❯`, `◇`, `✓`, `✗`, `───`) | col 2 | 2 | 2 |
| Text column (user, agent, verdict text after the glyph) | col 4 | 4 | 4 |
| Tool line | bar `│` at col 6, text at col 8 | 6 / 8 | 6 / 8 |
| Conversation right edge (exclusive) | W − 22 | 78 | 58 |
| Agent text wrap width | W − 26, word boundaries | 74 | 54 |
| Gap between conversation and panel | 2 columns | 78–79 | 58–59 |
| Git panel box | 16 columns wide (`┌` + 14 + `┐`), starts at W − 20 | 80–95 | 60–75 |
| Right margin | 4 columns | 96–99 | 76–79 |
| Startup `madc` box | cols 2–33 (32 wide, inner 30, content 28) | 2–33 | 2–33 |
| Status bar right block | model ends at col W − 3; time 2 columns left of model | model 87–97 | model 67–77 |

- The wrap width is the same on every row, including rows below the panel. The transcript does not widen under the panel.
- The panel does not scroll with the transcript.
- Above 100 columns the conversation keeps widening and the panel keeps 16 columns at the right. There is no line-length cap (decided 2026-10-04).

### 3.3 Startup (frame `startup.png`)

Before the first turn the conversation region shows, top to bottom:

1. **`madc` info box** at row 1, cols 2–33. Thin box (`┌┐└┘─│`), title ` madc ` centred in the top rule. Five key/value rows, keys padded to 8 and then 2 spaces:

   | key | value | value colour |
   |---|---|---|
   | `version` | `madc 0.0.0` | bright |
   | `protocol` | `madc-m1/1` | accent |
   | `seat` | `madc-default` | bright |
   | `model` | `moonshot-v1` | bright |
   | `cwd` | `~/projects/madc` | bright |

   Keys are muted. A cwd longer than 28 columns uses the rev 6.2 §9 path rule: `$HOME` becomes `~`, then a middle ellipsis.
2. **Blank row** (row 8).
3. **Tools** at row 9: `◆ Tools` (glyph and word accent). One tool per row at col 4, muted: `read_file`, `doctor`.
4. **Skills** right after the last tool: `◇ Skills` (glyph and word muted). In the frame the list is empty, so nothing is listed under it.
5. **Empty space** down to the status bar. The emptiness is intentional. Do not fill it with tips, logos, a wordmark, a doctor summary or recent sessions.

Tools and Skills lists come from the seat when it starts (decided 2026-10-04).

The git panel, status bar (`ready`) and composer are present at startup.

On the first turn the startup block leaves the conversation region and the transcript starts at row 1 (frames `verified.png`, `failed.png`). There is no collapsed header line in its place. The startup box can be brought back after the first turn. Ctrl-B brings it back (decided 2026-10-04).

### 3.4 Transcript (frames `verified.png`, `failed.png`)

One turn, top to bottom:

| Line | Glyph (col 2) | Text (col 4) | Colours |
|---|---|---|---|
| User | `❯` | the user text | glyph accent, text fg |
| blank | | | |
| Agent | `◇` on the first line only | agent text, wrapped, continuation lines at col 4 | glyph muted, text fg |
| Tool | none | `│ ` at col 6, then `<tool> <argument>` at col 8, directly under the agent text | bar and text foreground `#a9b1d6`; red when the call is `isError` |
| blank | | | |
| Turn rule | `───` (3 columns) at col 2 | | muted |

- The **turn rule** separates one turn from the next. There is no rule before the first turn.
- The **chain verdict line** comes after the last agent line of that turn, with one blank row before it (§6.1). Each turn keeps its own verdict line, not only the latest turn (decided 2026-10-04). The frames show a verdict on the latest turn only; that decision wins over the frames.
- There are no boxes, cards, bands, backgrounds or edges around messages. Messages are plain lines.
- A tool line is one line per tool call. It uses foreground `#a9b1d6`, not muted, and it is never green, because a tool result is not verified evidence. A failed tool call (`isError`) turns that tool line red (decided 2026-10-04).
- How a revoked earlier turn is redrawn is still open (Q4).
- The transcript scrolls in the conversation region. Older lines leave the top. The panel, status bar and composer never scroll.

### 3.5 Git panel

Box `┌──── git ─────┐` (title accent, border `#414868`), 14 inner columns, content at 12 columns:

```
┌──── git ─────┐
│ branch  main │   key muted, value bright
│ * c4e1a9     │   * accent, short hash foreground
│ │            │   graph line muted
│ * 8b20df     │
│ ↑1 ↓0        │   muted
└──────────────┘
```

- Hashes here are **git commit hashes** (short form). They are never the session chain head. The chain head appears only in the verdict line, as 12 hex. Hash text is foreground `#a9b1d6`, not muted.
- Two commits only. The panel is not a log.
- The panel is **never** in the transcript and **never** in the status bar.
- The panel gets its data by running git in the folder (decided 2026-10-04). Refresh once at startup and once at each turn end (after the verdict line). Never on paint, never mid-stream, no keypress refresh in this look (decided 2026-10-05).
- If the folder is not a git repo, the git panel stays visible and says the folder isn't a repo (decided 2026-10-04). Detached HEAD, no upstream, a single commit, and a long branch name are still open (Q2).

### 3.6 Status bar

One row, full width, background `lighter` `#24283b`.

| Slot | Content | Colours |
|---|---|---|
| Left, col 2 | `seat`, 2 spaces, seat name (`madc-default`) | label muted, name fg |
| Center, centred on the full width | state word. Words that stay: `ready`, `chain failed`, `streaming`, `verifying…`, `engine stopped`, `session start failed`. Other states: §6.2. | `ready` accent; `chain failed` red; see §6.2 |
| Right | `<elapsed> / <total>` (e.g. `4.2s / 12.4s`), 2 spaces, model (`moonshot-v1`) | time foreground `#a9b1d6`, model fg |

- Times have one decimal place and a trailing `s`, updated at most 5 times a second (rev 6.2 §10, W-3). The first number is this turn. The second is time since launch (decided 2026-10-04).
- The status bar may contain **only** these three slots. It never contains the branch, a commit, ahead/behind, key hints, a thread id, a token or context bar, a spinner, or a progress bar.
- Before a served-model receipt, the model slot shows the requested model, labeled as requested. After a receipt, it shows the served model (decided 2026-10-04). It must not claim a served model without a `servedModel` receipt (CLI:78). The startup frame shows `moonshot-v1` in the status bar with no requested label; that decision wins over the frame.
- Status bar center words that stay: `ready`, `chain failed`, `streaming`, `verifying…`, `engine stopped`, `session start failed` (decided 2026-10-04). On a failed turn the status bar must not say `ready` (§6.2).

### 3.7 Composer

- Row H−1: `❯` at col 2 in accent, typed text from col 4 in fg. No box, no placeholder text, no key hints.
- Input rules from rev 6.2 §5.8 (IQW-9) stand:
  - empty input after `trim()` is not sent;
  - input over 1 MiB is not sent, and the composer shows `▲ prompt exceeds 1 MiB; not sent` in yellow with the text kept;
  - an unknown `/word` shows a muted `unknown command /<word> · /help` and is not sent;
  - `//` sends a literal `/…`.
- During a turn and during a verify the composer stays editable, but `Enter` and `/words` do nothing (rev 6.2 IQW4-3).

### 3.8 Never appears

- No center stamp: no COMPLETED, FAILED, EXIT n or verdict block anywhere, in any size, on success or failure.
- No block-art wordmark, logo, caduceus, mascot or gold skin. No Hermes branding and no Alchemy blue.
- No git in the status bar and no git in the transcript.
- No dashboard: no tiles, no gauges, no metrics grid, no second side panel.
- No cards, pills, tints, rails, evidence pane or key-hint bar.
- No green anywhere except on verified evidence.

---

## 4. Colour

### 4.1 Tokens (Omarchy Tokyo Night)

One palette. There is no second palette, no light variant, and no theme switch in this spec. Hex values are from the owner's brief, cross-checked against `refs/omarchy-colors.toml`. The 256 column is the nearest xterm-256 index (computed). Contrast is WCAG against `background` and against `lighter`.

| Token | Hex | Omarchy key | Role in the frames | 256 | 16-colour SGR | vs bg | vs lighter |
|---|---|---|---|---|---|---|---|
| background | `#1a1b26` | `background` | screen background | 234 | default (`49`, not painted) | — | — |
| darker | `#0e0e14` | `darker_background` | not used in the CLI; used later behind the desktop window | 233 | default | — | — |
| lighter | `#24283b` | `lighter_background` | status bar background | 236 | none (no fill) | — | — |
| foreground | `#a9b1d6` | `foreground` | user and agent text, seat name, model, tool line, elapsed times, git hashes | 146 | default (`39`) | 8.10 | 6.90 |
| bright | `#c0caf5` | `bright_foreground` | values in the info box and git panel | 153 | `97` | 10.59 | 9.02 |
| muted | `#565f89` | `dark_foreground` | agent `◇`, turn rule, keys and labels, git graph, Skills | 60 | `90` | 2.76 | 2.35 |
| border | `#414868` | `muted` | box lines (`┌─┐│└┘`) only | 239 | `90` | 1.91 | 1.63 |
| accent | `#7aa2f7` | `accent` / `blue` | `❯`, `◆ Tools`, box titles, `protocol` value, git `*`, `ready` | 111 | `34` | 6.79 | 5.78 |
| green | `#9ece6a` | `green` | verified verdict line only | 149 | `32` | 9.35 | 7.97 |
| red | `#f7768e` | `red` | failed verdict line, `chain failed`, every failure line | 210 | `31` | 6.46 | 5.51 |
| yellow | `#e0af68` | `yellow` | warn: UNVERIFIED, torn tail, NO RECEIPT, the 1 MiB warning (roles from rev 6.2 `warn`); not in the frames | 179 | `33` | 8.55 | 7.28 |

- Weight: every token is regular weight. No bold anywhere, so the verified and failed lines are always the same weight.
- `border` is chrome only and never carries information.
- `muted` is 2.76:1 on the background, which is below 4.5:1. It stays on the roles in this table. Tool lines, elapsed times, and git hashes use foreground `#a9b1d6`, not muted (decided 2026-10-04). The frames draw those three in muted; that decision wins over the frames.
- In Omarchy the terminal's ANSI 16 palette uses the same hexes (`blue` = accent, `green`, `red`, `yellow`), so the 16-colour mode lands on the same colours there.

### 4.2 Depth detection and fallbacks

This is rev 6.2 §3.3, with the palette swapped. The first match wins.

| # | Condition | Result |
|---|---|---|
| 1 | `--json` | no SGR, no chrome |
| 2 | TTY gate fails. App: stdin, stdout and stderr must all be TTYs or the app does not start. Human stderr lines: stdout and stderr both TTYs. Doctor stdout: stdout is a TTY. | **Piped / non-TTY:** plain bytes exactly as pinned, zero SGR |
| 3 | `NO_COLOR` present (any value, including empty) | **zero SGR**, bold and reverse included. Layout, glyphs and words stay. |
| 4 | `TERM` exactly `dumb` | zero SGR; the app runs in line mode with ASCII glyphs |
| 5 | `FORCE_COLOR` | not honoured; never overrides 1–4 |
| 6 | `COLORTERM` is `truecolor` or `24bit` | **truecolor:** hex column; background and status bar painted |
| 7 | `TERM` contains `256color` | **256-colour:** 256 column; background 234 and status bar 236 painted |
| 8 | otherwise | **16-colour:** SGR column; nothing painted; text colours only |

**Per-mode look:**

| Mode | Background | Status bar | Verified line | Failed line | `ready` / `chain failed` |
|---|---|---|---|---|---|
| truecolor | `#1a1b26` | `#24283b` fill | `#9ece6a` | `#f7768e` | `#7aa2f7` / `#f7768e` |
| 256 | 234 | 236 fill | 149 | 210 | 111 / 210 |
| 16 | terminal default | no fill; position only | `32` | `31` | `34` / `31` |
| NO_COLOR | terminal default | no fill; position only | no SGR; words carry it | no SGR; words carry it | words only |
| piped / non-TTY | the app does not run | — | — | — | — |

- Under NO_COLOR and in 16-colour mode the status bar has no fill. It is still the row above the composer with the same three slots. No rule, border or brackets are added to make up for the missing fill.
- Under NO_COLOR, `chain VERIFIED` vs `chain FAILED` and `✓` vs `✗` carry the meaning. They are the same length class and in the same position.
- The exit receipt written after the restore uses the rev 6.2 §6.2 SGR spans (`32`, `31`, `1;31`, `33`, `36`) under the both-TTY gate, and zero SGR under NO_COLOR. Those are basic ANSI codes, so a Tokyo Night terminal shows them in this palette. Their bytes are not changed by this spec.

---

## 5. Width and height

- **Minimum: 80 columns × 24 rows.** This is the rev 6.2 product minimum (hard rule 11; §3.4). The frames do not state a minimum.
- **The side panel fits at 80.** At W = 80 the panel sits at cols 60–75, the conversation wraps at 54 columns, the startup box (cols 2–33) fits, and the status bar fits: left ends at col 19, `chain failed` at 34–45, right block at 53–77. So the minimum is kept.
- **Height at 24:** the startup block uses rows 1–12 and the panel rows 1–7, plus the status bar and composer. It fits.
- **Below 80×24 at launch:** the app runs in **line mode** (rev 6.2 tier A): no alternate screen, no panel, no status bar. The git panel is **dropped**, not stacked, and it never moves into the transcript or the status bar. Line mode also applies when `TERM` is unset, `MADC_UI=lines`, or on Windows without VT (rev 6.2 §3.4).
- **Line mode lines** (rev 6.2 §6.3): one identity line `madc <version> · <protocol> · <seatId> · line mode (<why>)`, a `> ` prompt, agent text on stdout, and the pinned receipt on stderr after each turn. No colour except the §6.2 receipt spans.
- **Resized below 80×24 mid-session:** drawing pauses and one centred line shows `terminal too small · need 80×24 · now <c>×<r>`. State is kept and drawing resumes when the terminal is large enough. The app does not switch to line mode mid-session (rev 6.2 §3.4).
- **Truncation (chrome only, rev 6.2 §9):** chain head is always 12 hex; paths use `~` then a middle ellipsis. Pinned lines are never truncated.

---

## 6. Verdicts, failures and exit codes

### 6.1 The chain verdict line (required)

The verdict is one line at the end of a turn: glyph at col 2, text at col 4, one blank row above it.

| Result | Line (exact) | Colour | Status bar center |
|---|---|---|---|
| **Verified** | `✓ seq 4 · head a1b2c3d4e5f6 · chain VERIFIED` | green, whole line | `ready` (accent) |
| **Failed** | `✗ chain FAILED` then ` line N: <reason>` | red, whole line | `chain failed` (red) |

- Template for verified: `✓ seq <S> · head <12 hex> · chain VERIFIED`. It appears only when the read-only verify passed **and** the last `turn.end` names this turn (CLI:80; rev 6.2 §5.3 R-a). Never by default, never on a timeout, and never because the turn status was `completed` (R-f).
- Template for failed: `✗ chain FAILED` then ` line N: <reason>` (the pinned detail). Same visual weight as the green verified line. The line stays red and regular weight. Rev 6.2 hard rule 10 lets the terminal soft-wrap it. The failed frame draws `✗ chain FAILED` with no line number or reason; that decision wins over the frame.
- **Same weight:** both lines use the same slot, regular weight, a one-cell glyph plus words. Neither is bold, boxed, filled, enlarged or centred.
- Each turn keeps its own verdict line (decided 2026-10-04; §3.4). A later verify failure revokes earlier VERIFIED turns whose seq range contains or follows line N (rev 6.2 R-b). How a revoked earlier turn is redrawn was not decided (Q4).
- After chain FAILED, input stays disabled until `/new` (rev 6.2 §5.8, Q5 there).

### 6.2 Every other documented state

States and words are from rev 6.2 §5.3, §5.8 and §7. Only the two rows in §6.1 were drawn and approved. Each line below uses the same verdict-line slot and weight. Copy marked *(rev 6.2)* is quoted from rev 6.2. Status bar center words that stay, decided 2026-10-04: `ready`, `chain failed`, `streaming`, `verifying…`, `engine stopped`, `session start failed`. Status words for the other states, decided 2026-10-05 (Iris ruling, Michael accepted): `unverified` (yellow) for UNVERIFIED / torn tail / verify-timeout; `interrupted` (yellow) for answered interrupt; `error` (red) for seat / protocol / `error` items and any failed turn that is not `chain failed`. Turn-end lines keep the rev 6.2 copy in this table; the interrupt glyph is `▲ interrupted` (yellow, same slot). `NOT STARTED` / `UNKNOWN` / `INPROGRESS` stay verbatim in the exit receipt only; the status bar uses `error` / `streaming` as below.

| State | Turn-end line (col 2) | Colour | Status bar center |
|---|---|---|---|
| Turn running | none yet | — | `streaming` *(rev 6.2 activity word)*, accent |
| Ended, verify running | `▲ seq ? · UNVERIFIED yet` *(rev 6.2)*, replaced in place by the result | yellow | `verifying…` *(rev 6.2 input text)*, muted |
| Ended UNVERIFIED (verify passed, last `turn.end` not this turn, or verify could not run) | `▲ seq <S> · head <12> · UNVERIFIED: <why>` *(rev 6.2)* | yellow; never green | `unverified` (yellow) |
| Verify hit the 30 000 ms bound | `▲ UNVERIFIED: verify did not finish in 30000 ms` (per turn; rev 6.2 proposed text) / `▲ UNVERIFIED: verify interrupted` (final verify; rev 6.2 O-1 ruled) | yellow | `unverified` (yellow) |
| Torn tail | `▲ torn tail at line <N>: crash residue, not tamper` *(CLI:131 wording)* | yellow (rev 6.2 R-c: warn, not err); exit class 5 | `unverified` (yellow) |
| Engine exited mid-turn | `✗ engine exited · turn not recorded as ended` *(rev 6.2)* | red | `engine stopped` *(rev 6.2 state name)*, red |
| Idle timeout | `✗ timeout: no engine message for <ms> ms` *(ERR1 L172)* | red | `engine stopped`, red |
| Interrupt not answered in grace | `✗ interrupt not answered in 2 s · engine stopped` *(rev 6.2)* | red | `engine stopped`, red |
| Interrupt answered | `▲ interrupted` (yellow, same slot); never success. Turn-end keeps the rev 6.2 `interrupted` word with the warn glyph (decided 2026-10-05) | yellow | `interrupted` (yellow) |
| Protocol violation (ERR1 §3b, E-d) | engine stops; same as "engine exited" | red | `error` (red) |
| `error` item (PROTO:209–213), e.g. provider `-32007`/`-32008`, session `-32009` in a turn | `✗ error <code> <message>` (rev 6.2 §5.4 shape, NO_COLOR form `[x error -32009] <message>`), in the transcript where it arrives. A failed turn shows only this red error line: no green chain-verified line on that turn | red | `error` (red) |
| Seat error on `thread/start` (`-32005`, `-32006`, `-32602`) | `✗ error <code> <message>`; no thread; input re-enabled and the next send retries (rev 6.2 IQW-18) | red | `error` (red) |
| Session start failed: `-32009` on `thread/start` (A3 L254) | `✗ error -32009 <message>`; no turn, no verdict line; input disabled; quit keys only | red | `session start failed` *(rev 6.2 state name)*, red |
| `NOT STARTED`, `UNKNOWN`, `INPROGRESS` turn words | Not drawn as turn-end words in the app. They stay verbatim in the exit receipt only (decided 2026-10-05) | — (receipt: red / yellow per rev 6.2 §6.2) | `INPROGRESS` → `streaming` (accent); `NOT STARTED` / `UNKNOWN` → `error` (red) |
| NO RECEIPT (no `servedModel`) | model slot shows the requested model, labeled as requested (§3.6). No other NO RECEIPT wording was decided | — | — |

- **A failed turn.** A failed turn shows only the red error line. No green chain-verified line on a failed turn. The status bar must not say `ready` on that turn (decided 2026-10-04). When the word is not `chain failed`, the status bar center is `error` (red) (decided 2026-10-05).
- Every failure line is red or yellow, the same size as the verified line, and never quieter.

### 6.3 Exit codes (unchanged; rev 6.2 §5.11, CLI §4)

The app exits with the **worst** code recorded in the session, by code: `3 > 2 > 5 > 130/143 > 4 > 1 > 0`.

| Event | Exit |
|---|---|
| Every turn `completed`, nothing above 0 recorded, final verify did not fail | 0 |
| A turn ended UNVERIFIED | its turn's exit, usually 0; never shown as success |
| In-app interrupt answered and verified, then a normal quit | 0 for that turn; shown as interrupted |
| No turns and no thread | 0 |
| No turns; final check passes / fails | 0 / 5 |
| Turn `failed`, non-classed | 1 |
| Seat error on `thread/start`, even if a retry later succeeded | 2 |
| Engine lost (exit, violation, idle timeout, unanswered interrupt, request timeout), even if restarted; unclassified app error | 3 |
| Provider `-32007` / `-32008` | 4 |
| `-32009` (in a turn or on `thread/start`), final verify FAILED, torn tail; replaces only 0, 1 or 4 | 5 |
| Quit by SIGINT or `Ctrl-C` | 130, unless 2, 3 or 5 was recorded |
| Quit by SIGTERM | 143, unless 2, 3 or 5 was recorded |
| Final verify fails after a signal | 5 |
| SIGHUP | re-raised; the OS reports it (shells show 129); the app never calls `exit(129)` |

**How an exit looks.** Exit codes are not drawn inside the app. There is no EXIT n stamp. After the terminal is restored, stderr gets:
- the pinned receipt block(s) of rev 6.2 §5.12 (the last turn, plus the worst turn if it was a different one), with §6.2 SGR spans: exit digits `1;31` when not 0, `32` for 0 with chain VERIFIED, uncoloured otherwise;
- on a signal, the rev 6.2 §5.13 line `madc: interrupted (<SIGINT|SIGTERM|SIGHUP>)` then `exit <n>` (SIGHUP: first line only), with `33` on the first line and `1;31` digits;
- nothing if no `turn/start` was sent, except the §5.13 line.

Pre-app failures (bad flags, config, non-TTY) print exactly as today, before any screen is drawn (rev 6.2 §6.2, §7).

### 6.4 Doctor states

Doctor vocabulary is unchanged (CLI §3): `PASS` (with evidence only), `WARN`, `FAIL`, `SKIP`, plus `INIT` for `--init`. The RESULT line is `RESULT  <f> FAIL · <w> WARN · <s> SKIP · <ms> ms   exit <code>`. Doctor exits 0 with no FAIL, 1 with any FAIL, and 2 for usage or `MADC_HOME`. The "all good" banner ban (CLI:142) holds. In the app, doctor appears as a tool (startup Tools list) and its result reaches the user through agent text, as in the approved transcript. `madc doctor` and `madc -p` use a one-line verdict, like the chat, instead of the old cards (decided 2026-10-04). Whether a launch doctor still runs, and how doctor rows are drawn inside the app, is still open (Q13).

---

## 7. Glyphs

ASCII is used when `TERM` is exactly `dumb`, when the locale (`LC_ALL`, then `LC_CTYPE`, then `LANG`) does not name UTF-8, or when `MADC_ASCII=1` (rev 6.2 §4). NO_COLOR with a UTF-8 locale keeps the UTF-8 glyphs: NO_COLOR removes colour, not characters. Pinned bytes such as `·`, `─`, `→` and `…` stay as pinned in every mode (rev 6.2 §4), so the verdict line keeps `·`.

| Meaning | UTF-8 | ASCII | ASCII source |
|---|---|---|---|
| prompt (user line, composer) | `❯` U+276F | `>` | rev 6.2 |
| agent line | `◇` U+25C7 | `*` | proposed (rev 6.2 maps the agent `◆` to `*`) |
| section mark, Tools | `◆` U+25C6 | `*` | rev 6.2 |
| section mark, Skills | `◇` U+25C7 | `*` | proposed, same as agent |
| tool bar | `│` U+2502 | `\|` | rev 6.2 |
| verified | `✓` U+2713 | `v` | rev 6.2 |
| failed | `✗` U+2717 (as drawn; rev 6.2 used `✕`) | `x` | rev 6.2 |
| warn / unverified | `▲` U+25B2 | `!` | rev 6.2 |
| turn rule | `───` | `---` | rev 6.2 (`─` → `-`) |
| box corners and lines | `┌ ┐ └ ┘ ─ │` | `+ + + + - \|` | rev 6.2 |
| git commit | `*` | `*` | already ASCII |
| git graph line | `│` | `\|` | rev 6.2 |
| ahead / behind | `↑1 ↓0` | `↑1 ↓0` | arrows stay on a plain terminal; no ASCII `+`/`-` (decided 2026-10-04) |

In ASCII mode the verdict lines are `v seq 4 · head a1b2c3d4e5f6 · chain VERIFIED` and `x chain FAILED` then ` line N: <reason>`: the same weight, the same position. Git ahead/behind keeps `↑` and `↓` even on a plain terminal. No ASCII `+`/`-`.

---

## 8. Keys

Only keys confirmed in rev 6.2 §5.8 and `docs/runbook/M0.md` §7 are listed. No key is added.

| Key | Behaviour | Applies to the new look |
|---|---|---|
| `Enter` | idle: send. Engine stopped: restart the engine (new engine, new thread). During a turn or verify: nothing. | yes |
| `Ctrl-C` (and external SIGINT) | during a turn: `turn/interrupt` with a 2 s grace; a second one during the grace forces the stop and quits. Otherwise: quit by interrupt (130 unless 2, 3 or 5 was recorded). Every quit runs the bounded final verify. | yes |
| `Ctrl-D` | quit normally (not during a turn or verify) | yes |
| `/help` | list the keys | yes; where the list is drawn is Q16 |
| `/receipt` | the last turn's pinned rows | yes; where they are drawn is Q16 |
| `/new` | new thread; the only way out of chain FAILED | yes |
| `/doctor` | re-run doctor read-only; starts only when `/` is the first character typed in the chat | yes (decided 2026-10-04) |
| `Tab` | stays as it is | yes (decided 2026-10-04) |
| `Ctrl-B` | brings the startup box back | yes (decided 2026-10-04) |
| `Esc` | stays as it is | yes (decided 2026-10-04) |

- **No key-hint bar.** The frames draw none, and the status bar may not hold hints (§3.6).
- `/seat` is not available (no `seat/list` in M0; rev 6.2 §5.8).
- Where `/help` and `/receipt` output go was not decided (Q16).

---

## 9. Copy rules

- **Version:** `madc 0.0.0`. **Protocol:** `madc-m1/1` (M1 protocol pin P1). **Seat:** `madc-default`. **Model:** `moonshot-v1`, a placeholder. At run time each comes from its real source; the placeholder is never hard-coded.
- **Backing is a named seat, not a brand.** The seat name is the identity. No vendor logo, product mark, mascot or brand colour.
- **Approved sample transcript.** Use these lines verbatim in mock-ups and tests. Do not write new sample copy.
  - user: `read the receipt format and tell me if exit 0 is enough`
  - agent: `Exit 0 is not enough on its own. The receipt still has to show the chain verified, the served model, and the session head.`
  - tool: `read_file docs/plan/PIN-madc-M0-cli.md`
  - user: `show me the doctor rows`
  - agent: `11 PASS · 1 WARN · 0 FAIL. The warn is the lanes terms row. Everything else passed.`
  - verdicts: `✓ seq 4 · head a1b2c3d4e5f6 · chain VERIFIED`, and `✗ chain FAILED` then ` line N: <reason>`
  - status: `seat  madc-default`, `ready`, `chain failed`, `4.2s / 12.4s`, `moonshot-v1`
  - startup: Tools `read_file`, `doctor`; Skills empty; cwd `~/projects/madc`; git `main`, `c4e1a9`, `8b20df`, `↑1 ↓0`
- **Words:** `chain VERIFIED` and `chain FAILED` use the pinned upper-case words. State words in the status bar are lower case (`ready`, `chain failed`).
- **No new commands.** This spec adds none.
- No reassurance copy ("all good", "looks great"), no tips, no onboarding text.

---

## 10. Desktop carry-over (later; CLI first)

- **Same four regions:** conversation center, git side panel at the top of the right side, status bar, composer at the bottom. Same order, same proportions: the conversation takes most of the width and the panel stays narrow.
- **Same tokens:** §4.1 hexes and roles. No new colours. Window chrome uses `background`. `darker` `#0e0e14` is not used in the CLI. It is used later behind the desktop window (decided 2026-10-04).
- **Same verdict rule:** each turn keeps its own line, `✓ … chain VERIFIED` green or `✗ chain FAILED` then ` line N: <reason>` red, same size and weight. No stamp, modal, toast or banner for a verdict. No green chain-verified line on a failed turn.
- **Same copy and glyphs** (§7, §9). Monospace for the transcript.
- **No new chrome:** no sidebar of sessions, no tabs, no toolbar, no logo, no dashboard.
- **Not decided here:** the desktop stack is open and a desktop needs a socket transport, which is a protocol amendment (rev 6.2 §11, citing ROAD:50–56). ROAD:92 says "no status colors", which conflicts with green and red verdicts (rev 6.2 R16; Q17).

---

## 11. Retired from rev 6.2

Dropped: the ANSI-Shadow `MADC` wordmark and banner; the banner collapse and header line; the per-turn rail (`┆ ┃ ╳ ┗━ ╵`); tool, agent and error cards; status pills; the `Tab` evidence pane; the key-hint bar; big verdict art and `#### WORD ####`; card tints; the Witness violet/cyan palette and its light variant; the `/doctor` overlay box; the 110-column docked pane breakpoint.

Kept: everything in §2, the tier conditions and line mode (§4.2, §5), the 80×24 minimum, the exit rule (§6.3), the input rules (§3.7), and the keys in §8 that still have a target.

---

## 12. Open questions

Answered on 2026-10-04 and removed from this list: Q3, Q6, Q7, Q8, Q9, Q11, Q12, Q14, Q15, Q19, plus the answered parts of Q4, Q13 and Q16. Answered on 2026-10-05 (Iris rulings; Michael accepted by approving without override) and removed: **Q1**, **Q10**. What is left under Q4, Q13 and Q16 is only what he did not answer. **Q13, Q16, Q17, Q18 are out of #54 scope per Surface** and stay open here for later.

- **Q2. Git edge cases.** The look for: detached HEAD, no upstream (ahead/behind unknown), a single commit, and a branch name longer than 6 columns in the 12-column panel. Not in a repo is decided: the panel stays visible and says the folder isn't a repo.
- **Q4. Revoked earlier turns.** Each turn keeps its own verdict line. How a revoked earlier turn (R-b) is redrawn was not decided.
- **Q5. `seq` and `head` source.** The verified line uses the passing verify's last `turn.end` seq and the 12-hex head, as rev 6.2 did. This needs confirming for the new line; there is no `turn <n>` suffix as rev 6.2 had.
- **Q13. Doctor inside the app.** (Out of #54 scope.) `madc doctor` and `madc -p` use a one-line verdict, like the chat, instead of the old cards. Still open: whether a launch doctor still runs, and how doctor rows are drawn inside the app.
- **Q16. `/help` and `/receipt`.** (Out of #54 scope.) Tab stays as it is. Esc stays as it is. Ctrl-B brings the startup box back. `/doctor` starts only when `/` is the first character typed in the chat. Still open: where `/help` and `/receipt` output go.
- **Q17. Desktop status colours.** (Out of #54 scope.) Resolve ROAD:92 vs the green/red verdict before desktop work.
- **Q18. Engine stderr.** (Out of #54 scope.) Rev 6.2 showed piped engine stderr in the evidence pane (M-1 allowance). The pane is retired, so where do those lines go? They must never draw over the screen.

---

## Appendix: frame character layouts (100×36; generated from `render_mix.py`)

Trailing spaces trimmed. Row 34 is the status bar (`lighter` fill), row 35 is the composer.

**Startup**

```

  ┌──────────── madc ────────────┐                                              ┌──── git ─────┐
  │ version   madc 0.0.0         │                                              │ branch  main │
  │ protocol  madc-m1/1          │                                              │ * c4e1a9     │
  │ seat      madc-default       │                                              │ │            │
  │ model     moonshot-v1        │                                              │ * 8b20df     │
  │ cwd       ~/projects/madc    │                                              │ ↑1 ↓0        │
  └──────────────────────────────┘                                              └──────────────┘

  ◆ Tools
    read_file
    doctor
  ◇ Skills

  … rows 13–33 empty …

  seat  madc-default                           ready                     4.2s / 12.4s  moonshot-v1
  ❯
```

**Verified turn**

```

  ❯ read the receipt format and tell me if exit 0 is enough                     ┌──── git ─────┐
                                                                                │ branch  main │
  ◇ Exit 0 is not enough on its own. The receipt still has to show the chain    │ * c4e1a9     │
    verified, the served model, and the session head.                           │ │            │
      │ read_file docs/plan/PIN-madc-M0-cli.md                                  │ * 8b20df     │
                                                                                │ ↑1 ↓0        │
  ───                                                                           └──────────────┘
  ❯ show me the doctor rows

  ◇ 11 PASS · 1 WARN · 0 FAIL. The warn is the lanes terms row. Everything
    else passed.

  ✓ seq 4 · head a1b2c3d4e5f6 · chain VERIFIED

  … rows 14–33 empty …

  seat  madc-default                           ready                     4.2s / 12.4s  moonshot-v1
  ❯
```

**Chain failed**: identical to Verified except row 13 and the status center:

```
  ✗ chain FAILED
  …
  seat  madc-default                        chain failed                 4.2s / 12.4s  moonshot-v1
  ❯
```
