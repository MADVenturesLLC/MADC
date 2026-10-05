# PIN: M0 design — Omarchy Tokyo Night git-panel (interactive TTY look for #54)

*Surface Architect · 2026-10-05 · Venue: `MADVenturesLLC/MADC` · Status: **PROPOSED / pending Argus pre-check** (Surface draft). Docs only until Founder merge. Binding only from Founder merge by exact head SHA. Not a build authorization for code until accepted.*

**Read at:** `main` @ **`2b44e6bb9d6ee281a4d5795f768c36806db93431`** (PR #53 merge tip at fetch). Every `file:line` below is at that SHA unless marked otherwise.

**Short names:**
- `SPEC` = `docs/plan/sources/DESIGN-SPEC-omarchy-git-panel.md` (Iris Omarchy draft, approved 2026-10-05; not a pin until this file is accepted). Cited as `SPEC §n` / `SPEC:line`.
- `WITNESS` = `docs/plan/sources/DESIGN-SPEC-witness-rev6.2.md` (sha256 `9b575b87502e5eb60ef61361a2b471815ba50ce917168b7936cd88afc2b462fd`).
- `WAM` = `docs/plan/PIN-madc-M0-witness-rev6.2-amendment.md` (still PROPOSED on main).
- `CLI` / `ERR1` / `README` = the usual plan pins at the read SHA.
- `HANDOFF` = `/workspace/madc-design/directions-tokyo/omarchy-git-panel/HANDOFF.md` (Iris → Surface, 2026-10-05; not in-repo).
- Ledger ids **D-485**, **D-486**, **D-502**, **D-503** from `/workspace/madc-ledger/LEDGER.md` (box sha256 `bb9af695ff0312098cf93c6aae0b6a5a839a08124cff15ad40f6f7e582a7016e` at pin draft time).

**Authority:**

- Founder approval of the Omarchy git-panel look: Michael Daley, Clio 1:1, 2026-10-05 ~5:19 AM ET, own words **"Approve Omarchy git-panel draft."** (ledger **D-486**; path ruling **D-485**).
- Iris rulings Q1 and Q10, folded into SPEC with no Founder override on approval (**D-502**, **D-503**; HANDOFF; SPEC header and §3.5 / §6.2).
- **Pins win over design drafts** (WITNESS:129 / SPEC header L3: where a merged pin differs from this source, the pin wins until a pin change merges). This file is that pin once accepted; until then SPEC remains a research copy only.
- Base frozen contracts at `2b44e6b`: CLI, ERR1, E17a, PROTO/SEAT (M0 and M1), A2, A3. Product hard rules carried from rev 6.2 are restated in SPEC §2 and adopted here in §1.5–§1.6 — this pin does not invent new protocol, exit codes, or non-TTY bytes.

**Vehicle:** new design pin file. It does **not** edit the Witness source copy (verbatim research copy; README). It does **not** rewrite WAM in place. On acceptance it **supersedes the Witness rev 6.2 look for the interactive full-TTY app**; WAM remains the historical record of what shipped under Witness until #54 rebuilds the chrome.

---

## Sources

| What | Where | Verification |
| --- | --- | --- |
| Iris Omarchy draft (approved) | `docs/plan/sources/DESIGN-SPEC-omarchy-git-panel.md` | SHA-256 `4756f4777646fbf5fe9deb65fe4ad8705347ec529f325f073c25a3f2b6234ad5`; `cmp`-identical to `/workspace/madc-design/drafts/tokyo-night-omarchy-git-panel-draft-2026-10-05.md`. Self-describes as approved look, **not a pin** until Surface merges a pin (SPEC:3). |
| Iris HANDOFF | `/workspace/madc-design/directions-tokyo/omarchy-git-panel/HANDOFF.md` (box-only) | Draft sha256 match; Q1/Q10 fold text; frames + sha256 table; open Q13/Q16–Q18 out of #54; Q2/Q4/Q5 still open in draft. Not committed. |
| Frames (not in-repo) | `/workspace/madc-design/directions-tokyo/omarchy-git-panel/{startup,verified,failed,sheet}.png` + `render_mix.py` | sha256s (HANDOFF / SPEC table): startup `f4737d433e84dc8a089c8607a6368c62e5eafe1e8eec73e5cdfe29a9553c5e89`; verified `6a2f0e8b397820405a5cfc86e0d241ca0ba7a34878845085478fb4b313ffb955`; failed `601536ffd79f071477ed37a09d303bae204900705087087265c14b7ac7cd91ad`; sheet `92c4e32ff9f7a6a80e55efc5cc1bd5450bab3375ce68f64ea1f144e83962dd7c`; renderer `6c6c6272595e8cbab20dbe7f3eb8a0d5433a3e77256277395a6c3ee5c79f4654`. Same pattern as Witness: frames stayed under `/workspace/madc-design/`, not under `docs/plan/sources/`. |
| Pre-approval draft (ledger cite only) | box path in D-502/D-503 rows | sha256 `3a03cb90e366122e89596060b38222ecfd4405a8bceab1b933a8a432305f743d` (HANDOFF: prior draft before Q1/Q10 fold). Approved text is `4756f477…`. |
| `main` read | this worktree | Full SHA `2b44e6bb9d6ee281a4d5795f768c36806db93431`. |
| Ledger | `/workspace/madc-ledger/LEDGER.md` | **D-485**, **D-486**, **D-502**, **D-503** (Clio-cleared 2026-10-05). |
| Precedence pattern | WITNESS:129 | "**Pins win.** Where this spec differs from a pin, §12 lists the change it needs…" |

---

## 1. What this pin adopts for #54

Normative look for the **full-screen interactive app** (bare `madc`, `madc "<text>"` when stdin/stdout/stderr are all TTYs and the terminal meets the width/height gate). Carried from SPEC §1–§11 unless a row below scopes it out.

### 1.1 Layout (SPEC §3)

| Region | Rule (abridged; SPEC wins on detail) |
| --- | --- |
| Conversation (center) | Rows 1…H−3; transcript / startup block; no cards, rails, pills, evidence pane, or key-hint bar. |
| Git panel (side) | Fixed top-right box titled `git`; branch, two-commit graph, ahead/behind; stays visible if the folder is not a repo (SPEC §3.5). |
| Status bar | Row H−2; seat left, state center, elapsed/total + model right; background `lighter` when colour depth paints fills. |
| Composer | Row H−1; `❯` prompt; rev 6.2 input rules (SPEC §3.7). |

Geometry: W ≥ 80, H ≥ 24; panel 16 columns at W−20; below 80×24 → line mode, **git panel dropped** (SPEC §5).

### 1.2 Palette (SPEC §4.1)

Omarchy Tokyo Night single palette (no light variant, no theme switch in this pin): `background` `#1a1b26`, `lighter` `#24283b`, `foreground` `#a9b1d6`, `bright` `#c0caf5`, `muted` `#565f89`, `border` `#414868`, `accent` `#7aa2f7`, `green` `#9ece6a`, `red` `#f7768e`, `yellow` `#e0af68`. Depth / `NO_COLOR` / `TERM=dumb` gates: SPEC §4.2 (rev 6.2 §3.3 with palette swapped).

### 1.3 Git refresh — Q1 / D-502 (SPEC §3.5; HANDOFF)

Refresh git **once at startup** and **once at each turn end** (after the verdict line). **Never** on paint, **never** mid-stream, **no** keypress refresh in this look.

### 1.4 Status words and turn-end copy — Q10 / D-503 (SPEC §6.2; HANDOFF)

Status-bar center for undrawn / non-`chain failed` failure states:

| Case | Status bar center | Colour |
| --- | --- | --- |
| UNVERIFIED / torn tail / verify-timeout | `unverified` | yellow |
| Answered interrupt | `interrupted` | yellow |
| Seat / protocol / `error` items; any failed turn that is not `chain failed` | `error` | red |

- Interrupt glyph in the verdict slot: **`▲ interrupted`** (yellow).
- Turn-end line copy stays **rev 6.2** as in SPEC §6.2 table (not reinvented here).
- `NOT STARTED` / `UNKNOWN` / `INPROGRESS` stay **verbatim in the exit receipt only**; status uses `error` / `streaming` as in SPEC §6.2.

Verified / chain-failed verdict lines and status (`ready` accent / `chain failed` red): SPEC §6.1.

### 1.5 Honesty / failure (SPEC §2 rules 6–7; CLI honesty)

- Green and `✓` appear **only** on verified evidence (`chain VERIFIED`, or doctor PASS with evidence). Never green by default, timeout, or bare `completed`.
- Failed turns are never soft: same slot/weight as verified; red (or yellow for warn states); status must not say `ready` on a failed turn.
- Meaning is never colour-alone; `NO_COLOR` keeps words/glyphs (SPEC §2 rule 8, §4.2).

### 1.6 Unchanged machine surfaces

- **Non-TTY** and **`--json`** bytes unchanged (SPEC §2 rules 1–2).
- **Exit codes** and app worst-code ladder unchanged (SPEC §2 rule 3, §6.3).
- **Protocol** untouched (SPEC §2 rule 4).
- One-shot **`madc -p`** and **`madc doctor`** machine/plain paths stay plain for non-TTY; on a TTY they use a **one-line verdict** instead of Witness block-art cards (SPEC §1, §6.4) — visual only; receipt/exit bytes for those commands otherwise follow existing pins unless a later pin amends them.
- **Line mode** (narrow / `TERM=dumb` / etc.): no panel, no status bar chrome (SPEC §5).

---

## 2. Explicit supersession

| Surface | After this pin is accepted |
| --- | --- |
| Interactive full-TTY app look | **Omarchy** (this pin + SPEC) is the M0 TTY look. Witness rev 6.2 chrome (wordmark banner, per-turn rail, cards, pills, evidence pane, key-hint bar, block-art verdicts, Witness violet/cyan palette) is **retired for that surface** (SPEC §11). |
| Witness rev 6.2 source + WAM | Remain historical: what was designed/shipped under Witness. WAM stays PROPOSED as the Witness conformance amendment until separately accepted or superseded by #54 implementation notes; it does **not** stay the interactive look target once this pin is accepted. |
| One-shot `-p` / doctor machine bytes | Stay plain / existing pin contracts. TTY one-line verdict is the look change only (SPEC §1). |
| Shipping code on `main` today | Continues to show Witness until #54 (or a follow-on build PR) implements this pin. This pin alone changes no runtime bytes. |

---

## 3. Scope IN for #54 vs OUT

### 3.1 IN (Hephaestus #54 under this pin)

- Chat + git side panel layout, Omarchy palette, glyphs, status bar, composer, startup block, transcript rules, verdict lines §6.1–§6.2 as adopted.
- Q1 git refresh rule; Q10 status words / interrupt glyph / receipt-only turn words.
- Honesty / `NO_COLOR` / non-TTY / `--json` / exit-code non-regression.
- Drop Witness chrome listed in SPEC §11 for the interactive app.

### 3.2 OUT of #54 (stay open; must not be closed by this pin)

Per HANDOFF and SPEC §12 (and D-486):

| Id | Topic | Disposition |
| --- | --- | --- |
| **Q13** | Doctor inside the app (launch doctor; how doctor rows draw in-app) | Out of #54; stay open. |
| **Q16** | `/help` / `/receipt` destination | Out of #54; stay open. |
| **Q17** | Desktop status colours / ROAD:92 | Out of #54; stay open. |
| **Q18** | Engine stderr after evidence pane retired | Out of #54; stay open. |
| **Q2** | Git edge cases (detached HEAD, no upstream, single commit, long branch name) | Still open in SPEC §12; **deferred** — not blocking the look pin; #54 may use a minimal honest fallback without inventing pinned chrome. |
| **Q4** | How a revoked earlier turn is redrawn | Deferred; open. |
| **Q5** | Confirm `seq` / `head` source for the new verdict line | Deferred; open (SPEC: use passing verify's last `turn.end` seq and 12-hex head as rev 6.2 did, pending confirm). |

---

## 4. Pointer updates

| File | Edit in this PR? | Note |
| --- | --- | --- |
| `docs/plan/README.md` | **Yes** (minimal) | Index rows for this pin and the Omarchy source copy (same pattern as Witness source + WAM rows). |
| `docs/plan/sources/DESIGN-SPEC-omarchy-git-panel.md` | **Yes** (add file) | Verbatim research copy; never edit after merge (README edit rule for verbatim copies). |
| `docs/plan/PIN-madc-M0-cli.md` | **No** in this draft | Frozen; Omarchy does not change CLI pin rows here. A later amendment may add an `Amended by` pointer if #54 needs pin-text changes to card/`-p` wording. |
| `docs/plan/PIN-madc-M0-witness-rev6.2-amendment.md` | **No** in this draft | Stays PROPOSED historical Witness record; supersession is stated in §2 of this pin, not by rewriting WAM. |
| `AGENTS.md` | **List only** | After acceptance, Workspace Facts should note Omarchy replaces Witness as the interactive M0 TTY look target; leave unchanged until Founder merge so agents do not treat an unmerged pin as shipping fact. |
| `docs/runbook/M0.md` §7 | **List only** | Runbook still describes Witness; update when #54 implements or when Founder asks a docs follow-up. |

---

## 5. Failure / honesty acceptance (docs bar for Argus)

Argus pre-check should fail this pin if any of the following are missing or contradicted:

1. Sources table lists draft sha256 `4756f477…ad5`, main SHA `2b44e6bb…3431`, and ledger **D-485 / D-486 / D-502 / D-503**.
2. Q1 text matches Iris: startup + turn-end only; never paint/mid-stream/keypress.
3. Q10 status words and `▲ interrupted` match Iris; receipt-only for `NOT STARTED`/`UNKNOWN`/`INPROGRESS`.
4. Green only on verified evidence; failed turns never soft / never `ready`.
5. Q13, Q16, Q17, Q18 explicitly out of #54; Q2/Q4/Q5 marked deferred/open.
6. No claim that this pin already changed runtime code on `main`.
7. Frames cited with sha256 and marked not in-repo (or present with matching hashes if later added).

---

## 6. Open questions (non-blocking for look pin; blocking only if Argus requires closure)

None of Q2/Q4/Q5/Q13/Q16–Q18 block **adopting** the approved look. They block only claiming those behaviours are pinned. If Argus requires every SPEC §12 id to be either IN or explicitly deferred with owner, §3.2 is that table.

**HANDOFF note (historical):** HANDOFF warned D-485 still needed Michael's own words for Clio. Ledger **D-485** / **D-486** now record Clio 1:1 confirmation (2026-10-05 ~5:19 AM ET). This pin treats D-485 as cleared on that ledger text.

---

## 7. Verification record (this draft)

```sh
# main tip fetched
git -C /workspace/MADC rev-parse origin/main
# → 2b44e6bb9d6ee281a4d5795f768c36806db93431

sha256sum docs/plan/sources/DESIGN-SPEC-omarchy-git-panel.md
# → 4756f4777646fbf5fe9deb65fe4ad8705347ec529f325f073c25a3f2b6234ad5

cmp /workspace/madc-design/drafts/tokyo-night-omarchy-git-panel-draft-2026-10-05.md \
    docs/plan/sources/DESIGN-SPEC-omarchy-git-panel.md
# → identical
```

Docs only. No code, CI, package, protocol, JSONL, exit-code, or `--json` change in this commit.

Role-Id: surface-architect
Actor-Id: surface
Execution-Surface: box worktree `surface/m0-design-omarchy-git-panel`
