# MADC M3-A4 design spec: Multi-seat workspace, Direction A "Equal Columns"

**Status:** approved by Mike 2026-11-27 (via MADC Architect), incl. D-693 and cwd field rulings.

**Revision:** r2, 2026-11-27 11:34 PM ET. Folds in the rulings relayed at 11:33 PM ET: D-693 closed (§15), stream-only `servedModel` confirmed, the five Iris extras accepted with `Reopen pane` deferred (§16), and the new cwd field in the pane header (§6A). r1 (sha256 `545825360d535b7ec55114e7e16edeaf8f396ac1e66d3328d0d905bd8e429aea`) is the text PR #81 carries as `docs/plan/sources/DESIGN-SPEC-m3-a4-equal-columns.md`; this revision supersedes it.

**Direction:** Michael Daley chose Direction A, "Equal Columns", with the Panes/Table toggle, on 2026-11-27 (relayed by MADC Architect at 10:22 PM ET). It stays inside the pinned Direction C visual system ("Precision Instrument Glass").

**Base:** `MADVenturesLLC/MADC` `main` @ `870c1f7ec3aeca13190f306b23c5d91810675e09` (PR #80, M3-A3 design pin amendment for M1, after PR #79 M3-A3 implementation). Every file and line cited below was read at that commit.

**What this spec is.** It is the Iris design spec for M3-A4 ("Multi-seat side-by-side workspace", PLAN §2 line 27). It extends the M3-A3 spec as shipped (`docs/plan/sources/DESIGN-SPEC-m3-a3-precision-instrument-glass.md`, "A3 spec") together with the pinned deviations D1–D9 of `docs/plan/PIN-madc-M3-design-precision-instrument-glass.md` §1.3 ("A3 pin"). It is not a pin. Surface Architect pins it. Where a merged pin differs from this text, the pin wins.

**Assumption marker.** Anything marked **[ASSUMPTION: unpinned]** relies on protocol or shell behaviour that does not exist at `870c1f7e`. Each one is listed again in §14 for the pin or in §6A.11.

---

## 0. Source of truth

| What | Path | sha256 |
|---|---|---|
| Frame, Panes view, 1440×900 (app content; canvas 1488×1010 @2x) | `/workspace/iris-madc-m3a4/direction-a-final.png` | `541103c9aef88ea6737c2444998aacd8ff25bbe86d245799bfc596d44eaa4580` |
| Frame, Panes view, 1200×800 | `/workspace/iris-madc-m3a4/direction-a-final-1200.png` | `e6eb788f6fdb6c74f884e907679bf9a222a335be61c393d630950e214afde0f4` |
| Frame, Panes view, 960×640 | `/workspace/iris-madc-m3a4/direction-a-final-960.png` | `22ab2adb0dba1dbc3fdaf77cf08543f8927b9b7f8075c5b358782d1cbf95dc02` |
| Frame, Table view, 1200×800 (unchanged in r2) | `/workspace/iris-madc-m3a4/direction-a-final-table.png` | `e9958f514259faa51ddea3e91589da81670e2f565c00616c455b63adccb01a28` |
| Frame, Table view, 960×640 (unchanged in r2) | `/workspace/iris-madc-m3a4/direction-a-final-table-960.png` | `8530abfda78cc144704a337e05d2fa89dc47ea777c176ee1c4750aa0c6e49e43` |
| Frame, quit confirmation, 960×640 | `/workspace/iris-madc-m3a4/quit-confirm.png` | `8e6b247868406ad3460d5ef70da94b50d3ca5b1448937fc0d1fb2ee1d97efe0b` |
| **Frame, cwd field, Panes view, 1440×900** (new, §6A) | `/workspace/iris-madc-m3a4/cwd-field-1440.png` | `3d338e9ade257d4729922f4f74bf403b302391d4eb0ec6b57b4749c8ea1abd65` |
| **Frame, cwd field, Panes view, 960×640** (new, §6A) | `/workspace/iris-madc-m3a4/cwd-field-960.png` | `57296131bef8fb1995fa7e91695ab377b62390e569aa579de174950ed4171ceb` |
| **Sheet, the six cwd field states at pane width 335** (new, §6A.4) | `/workspace/iris-madc-m3a4/cwd-field-states.png` | `2b6d0567af12488297461292c3cd3c9c31e9c35f9a8f9fc1b82b74a24c4e5ba2` |
| Reference CSS, shared primitives | `/workspace/iris-madc-m3a4/src/base.css` | `6a16377c9b04b4cd1ceb3f1f48edab886e7b9916c089618bb8098b1117e14e09` |
| Reference CSS, M3-A4 layout and cwd field | `/workspace/iris-madc-m3a4/src/final.css` | `684b198e37919fea2e0359926443d959c232b5e47aed1b009f58a2898f496c07` |
| Reference markup generator (mock data) | `/workspace/iris-madc-m3a4/src/build_final.py` | `25eb178ed807168ec71669efde58cb1393adf2e543e16d8b5061c9fa6f08d2c3` |

Frames and reference files are box-only and not in the repo. The reference CSS is a mock-up, not shipping code. The builder re-implements it against the tokens in `packages/desktop/ui/styles.css`. The 1200×800 frame shows `prometheus` as a draft pane. The cwd frames show a custom seat `reviewer` with `worktree: true` (mock; §6A.1). Mock seat ids are the real seeded roster (`madc-default`, `daedalus`, `hephaestus`, `prometheus`, `surface-architect`; `packages/engine/src/seats/roster.ts:26-98`); thread ids, turn ids, hashes and SHAs are mock values in the real formats.

**Text wins over the frames on these points. Everywhere else the frames win.**
1. All A3 text-over-frame points (A3 spec §0; A3 pin §1.2) still hold. In particular, the palette prompt is `>` and the palette shortcut is `Cmd+K` / `Ctrl+K`. The focus-bar hint draws `Ctrl K` as in A3.
2. The frames draw an app title bar for context. The real title bar is OS-drawn (A3 pin §5.1).
3. The Table-view frames omit the `#output` well and `#connect-btn` under the Engine card for space. The Table view keeps them exactly as A3 ships them (§5.3).
4. The 960 Panes frame shows the receipts well scrolled to the top, with its scrollbar visible. That is the specified scroll behaviour (§5.6), not clipping.
5. Mock hash, SHA, pid, path and time values are illustrative. The mock `cwd` and `topLevel` are `/Users/mike/...` paths; `topLevel` is the git top level of the `cwd`.
6. Frames r1 drew a read-only pane and a `thread/resume` banner; r2 frames do not (deferred, §16). The 1440 hidden-pane tab shows `prometheus` as an own-connection pane.

**Read for r2 (PR #81, `MADVenturesLLC/MADC`, head `fef26e6e7f4c322272f4a9e9378cf192472213e4`, read 2026-11-27 ~11:40 PM ET through the GitHub connector, because `gh` is not authenticated on the box):** `docs/plan/PIN-madc-M3-A4-multi-seat-workspace.md` (blob `f559ff71448c8980a4e166b2129b09903380699f`, "PR #81 pin"; line numbers below are that file's) and `docs/plan/PIN-madc-M3-desktop-protocol-amendment-2.md` ("amendment 2"). PR #81 is a DRAFT under review and may move; cites are to that head. Working copies: `/workspace/iris-madc-m3a4/pr81/`.

**Repo files read at `870c1f7e`:**

| File | sha256 |
|---|---|
| `docs/plan/PLAN-madc-M3-build-plan.md` (PLAN) | `4c43b11f8787b70e80bb8546bda00c5693cd3edd4be325e6b99c41b671f3f9cc` |
| `docs/plan/PIN-madc-M3-design-precision-instrument-glass.md` (A3 pin) | `66966dfaa0df895efcac343136fe66cee9183f1ca4ca1f7b60f3955a64e19103` |
| `docs/plan/sources/DESIGN-SPEC-m3-a3-precision-instrument-glass.md` (A3 spec) | `98be29ad778a7d8f136dc103b2defc63082d14159b6b544ed25ffb3a5e4fa37d` |
| `docs/plan/PIN-madc-M3-desktop-protocol.md` (M3 PIN) | `5df2f14d3c916dcdff600d893e4f75a94435443c12d542f8ad4ebcfd33902f9d` |
| `docs/plan/PIN-madc-M3-desktop-protocol-amendment-1.md` (AM1) | `c7463d40f0ca4cecbb97c938c550eaf65a052c4cc9b6c6af34ab40543d98a860` |
| `docs/plan/PIN-madc-M1-protocol-messages.md` (M1 PIN) | `350a713b0436f4f1039344c2bdbc97b11c0b1f291c834e7d53772a921e750bb4` |
| `docs/plan/PIN-madc-M1-seat-format.md` (seat pin) | `723b328e391d13a9d8d7da6f2c0722f6b6d16ac9ced2949a1ae9cdbdc1fff67f` |
| `docs/plan/PIN-madc-M2-seat-worktree.md` (worktree pin) | `332ee6b0b778fc817c48b59f6c42c1e3dd602945e4fb6edc642b8988b8e619a6` |
| `packages/desktop/ui/styles.css` | `a14b3ee694be3e681e8f93637d9a46883a790ab8ada24d0ca0b7885944855dfc` |
| `packages/desktop/ui/shell.js` | `29b676ce2c8c53e13d4be3bd89550f5ef2bc6287e8793049ed0b0fe24b7638f8` |
| `packages/desktop/ui/index.html` | `b78b52fb0e12f7c6f03b4fb6db3ce6cb4680b47f19122f6ffb6de4480ada5591` |
| `packages/desktop/src/ipc.ts` | `a0f3b5224ccc355756e2df8abaf4c5c40d6de10b6053854b24a2d19115efd0d3` |
| `packages/desktop/src/evidence.ts` | `f6273e2f2892f37318ab6989695861060ee3416ada318b696c33f3b6343ac73c` |
| `packages/desktop/src-tauri/src/launcher.rs` | `4f8a61b25d89bc5294662aacbcd5169d7f39c9ad5e461e91163e811c71db0065` |
| `packages/engine/src/inspect.ts` | `fea43da8d51aa6bed618154192e4cbae4abd8a59712f5646bdc98f93fa98253b` |
| `packages/engine/src/server.ts` | `864e803cc9658309790f8cb1a627a0b01ff29937c2e774c6173dc7dd18071098` |
| `packages/engine/src/socket.ts` | `1c655fca01d6b75582bc59b045fdcdab74877f813801d11ec7278b97e49698ee` |
| `packages/engine/src/session-store.ts` | `9fa5624e2e43b8a583211c82c291bdbebbbb3be60e010da0c25f135d3883a32c` |
| `packages/engine/src/session-v2.ts` | `12225989d3bae8e4be0ce2fc4722ce1350c9ffbc10b792a64cf3a2021dd6743e` |
| `packages/engine/src/protocol/types.ts` | `7d210f3b2ff969ee12962840878b69dddabddcfbe3b8581314bf65cc45a1869e` |
| `packages/engine/src/seats/roster.ts` | `ccd483533380b4a7abb899a2b4b11b2a03c5d5f7e16c55e9915b2c10df602122` |
| `packages/registry/src/catalog.ts` | `77e23f5bbf8f7c6d9ab2e35425922d2a8058742897c04c5178a460c0591a254c` |
| `packages/registry/src/assert.ts` | `649a4507b5eb4e53f74090193f8055716b7904f41ef417322afa2d73b2e28ae3` |

---

## 1. Scope, precedence and non-goals

**In scope (PLAN §2 line 27):** live side-by-side seat panes; model, lane and worktree receipts (`servedModel`, `worktree.topLevel`, head); interactive turn start and interrupt from the desktop window. Also in scope here: the Panes/Table toggle, hidden panes, the multi-seat composer, the quit flow, and the D-693 follow-up (A3 pin D9 (a) and (b)).

**Precedence:**
1. Merged pins: M3 PIN §4 (evidence-bound UI rule, line 47), AM1, the A3 pin including D1–D9, and the M1 protocol pin.
2. The A3 spec, for everything this spec does not change.
3. This spec.
4. The frames in §0.
5. The reference CSS.

Where this spec changes an A3 rule, it says so and names the A3 section.

**Inherited unchanged.** A3 pin D1–D9 stay in force as shipped deviations:
- D1: a torn tail is `fail`.
- D2: the signal is shown as a number.
- D3: the Windows launcher-kill row is unreachable.
- D4: Connect is disabled while `CONNECTING`.
- D5: JS ports of the `ipc.ts` helpers.
- D6: static stylesheet assertions instead of a headless browser.
- D7: `session/read` only on explicit selection, plus the per-turn read in §9 (narrowing D-682 / A3 Q4 per FDR-4(c); PR #81 pin §4.5).
- D8: the `.pill .pill-glyph` forced-colours selector.
- D9: the 960–1199px band layout and the `-webkit-backdrop-filter` pairing. This spec resolves D9's deferred (a) and (b) in §6.5.

**Hard non-goals (PLAN §1 lines 13–17; any of these is a spec violation):**
- Not an IDE or code editor. No file tree, no LSP, no terminal emulator, no editable code view, no diff viewer.
- No agent loop, tools or credentials in the desktop shell. The window only sends `seat/list`, `thread/start`, `turn/start` and `turn/interrupt` and reads engine results (A4 sends no `thread/resume`; §16). It never calls a provider and never holds a secret.
- No decorative green. Green appears only where `evidenceTone()` returned `verified` (A3 pin §4.1).
- No M3-A5+ surfaces: no handoff graph, no Founder Decision Inbox content, no session search UI, no replay inspector, and no bulk verification (M3-A7).
- No emoji, spinners, progress bars, animated loaders, blinking, vendor logos or mascots. Nothing animates. A running turn is a static `○ RUNNING` pill plus a timestamp.
- No filesystem access from the window: no folder picker, no path autocomplete, no "does this path exist" probe (PR #81 pin `:346` defers a folder-picker plugin). The `cwd` is typed text (§6A).
- No M4/M5 scope.

---

## 2. Design principles (binding; A3 §2 plus five)

1–4. A3 §2 unchanged: evidence decides colour; fail is at least as loud as verified; every status has three channels (glyph, word, colour); the look is an instrument, not a dashboard.

5. **A seat is always visible.** Every pane names its seat in its header. Every Room row names its seat at every width (§6.5).
6. **Live is not verified.** A turn that is running, interrupted or completed, a streamed item, and a connected socket are never receipts. Only `session/read` (hash, servedModel) and `room/inspect` (head@open) supply receipts.
7. **The engine's refusal is the state.** When the engine refuses (`-32004`, `-32007` and so on), the pane shows the code and data verbatim in fail tone. It never shows a softened, disabled-looking or green substitute.
8. **No silent automation.** Nothing starts, interrupts, retries or polls without an explicit user action. The one exception is the single automatic `session/read` after a completed turn on a visible pane (§9). That read never changes engine state.
9. **A path is not a receipt.** The typed `cwd` and the started `cwd` are plain neutral text. Nothing about a path is ever green, and nothing about a path claims it exists (§6A).

---

## 3. Tokens and inheritance

- **No new tokens and no new hues.** All values come from `packages/desktop/ui/styles.css` `:root` (lines 52–107 at `870c1f7e`; A3 spec §3.1–§3.2). Pane, composer and dialog surfaces use existing tiers:
  - **Pane:** tier 1 (`.card` look): `--madc-bg` fill, 1px `--madc-border`, `--madc-radius-md`.
  - **Receipts well inside a pane, composer input, dialog list:** tier 0 (`.well`): `--madc-darker` (`#0e0e14`), 1px border, `--madc-well-inset`.
  - **Quit dialog:** tier 2 strong glass, identical to the palette: `--madc-glass-fill-strong`, `--madc-glass-blur-strong`, 1px `--madc-muted` border, `--madc-radius-lg`, `--madc-glass-edge` + `--madc-shadow-overlay`.
  - **cwd input:** tier-0 well; a fail state recolours only its 1px border to `--madc-red`; focus is the accent outline (§6A.2).
  - **Starting-thread banner:** `--madc-lighter` fill, 1px `--madc-border`, radius 4px, text `--madc-bright`. No tone colour. A banner is not a status.
- **Accent stays non-status.** `--madc-accent` marks the focused pane (`inset 0 2px 0 var(--madc-accent)`), selected composer targets (`1px` accent border + `--madc-select-fill`), the primary button border, the active toggle segment underline, and focus rings. It never means "verified".
- **Scrollbar (receipts wells only):** 8px wide; track `--madc-darker`; thumb `--madc-border` with a 2px `--madc-darker` inset border and radius 3px.
- **Safari < 18 / no `backdrop-filter`:** unchanged. The verbatim `@supports not (backdrop-filter: blur(1px))` block falls back to opaque `--madc-lighter` (A3 spec §3.4; A3 pin D9; D-699 supersedes D-694 per PR #81 pin). The quit dialog reuses the `.palette.glass`-style rule, so it gets the same opaque fallback, the same `-webkit-backdrop-filter` pairing, and the same `prefers-reduced-transparency` block.

---

## 4. Typography (A3 spec §4 unchanged; new roles only)

| Role | Family | Size / line | Weight | Colour |
|---|---|---|---|---|
| Pane seat name | UI | 15 / 20 | 600 | bright |
| Pane position number (`1`–`4`) | mono | 10.5 | 400 | muted |
| cwd key `cwd` | mono | 11 | 400 | fg |
| cwd input and started value | mono | 12 / 28 (box) | 500 | bright; placeholder muted |
| cwd field state (glyph + word) | mono | 11 / 26 (row) | 600, tracking 0.06em, uppercase | fg (neutral), red (fail) |
| cwd reason and issue lines | mono | 11 / 15 | 400 | muted |
| Pane thread line (`threadId · turnId`) | mono | 12 / 16 | 400 | fg, ellipsis at end |
| Receipt row key (`servedModel`, `lane`, `worktree.topLevel`, `head@open`, `hash`, method names) | mono | 11.5 / 16 | 400 | fg |
| Field note `field · not a receipt` | mono | 11 / 14 | 400 | muted |
| Pane footer reason | mono | 11 / 14 | 400 | muted, ellipsis |
| Banner | UI | 12 / 16 | 400, lead word 600 | bright; inline mono 11 muted for method text |
| Composer target | mono | 12 / 28 (box) | 400 | fg; bright when selected |
| Composer input | UI | 13 / 34 (box) | 400 | bright |
| Hidden-strip seat | UI | 12.5 | 600 | bright |
| Dialog title | UI | 18 / 24 | 600 | bright |
| Dialog body | UI | 13 / 19 | 400 | fg; `<b>` 500 bright |

Pills, chips, keycaps, micro-labels, h1 and the counts line are exactly A3.

---

## 5. Layout

### 5.1 Regions (top to bottom; both views)

Focus bar (52px, tier 2, unchanged) → `<main>` → status strip `#connection-status` (34px, tier 2, unchanged). The status strip's model slot keeps showing `model —`, because each pane carries its own model (A3 pin §5.1 model rule).

### 5.2 Panes/Table toggle

- **Control:** a segmented control at the right of the section head, beside the hidden strip. It has two segments, `PANES` and `TABLE`: 26px high, UI 11/600, tracking 0.08em, uppercase, 1px `--madc-border`, radius 4px. The active segment has a `--madc-lighter` fill, bright text and `inset 0 -2px 0 var(--madc-accent)`. It uses `role="radiogroup"` with two `role="radio"` children, roving tabindex, and `←`/`→` to switch (the same idiom as the focus bar).
- **Default view:** Panes when at least one pane exists, otherwise Table.
- **Focus bar:** `Room` stays the active focus target in both views. `Focus Room` (palette) restores the last view. `Focus Engine` switches to the Table view and focuses the Engine card, which exists only in the Table view.
- Switching views never sends a request and never discards pane state or cached reads.

### 5.3 Table view

The Table view is the A3 Room screen exactly as shipped:
- two-column `#main-content` (`minmax(0,1fr) 440px` at ≥1200; `clamp(360px, 37.5vw, 440px)` at 960–1199, D9);
- Room table well and Receipts well on the left; Engine card, `#output` well and `#connect-btn` on the right;
- 22px × 28px padding.

There are two changes:
- the section head gains the Panes/Table toggle;
- the D-693 fix in §6.5 applies.

Selecting a row keeps A3 Q4/D7 behaviour: one `session/read`, deduped. The palette command `Open selected thread in pane` (§8) opens a pane on the selected row's thread.

### 5.4 Panes view: grid by width (W = app content width)

`<main>` padding is `20px 28px` and the gap between sections is `12px`. That is the Panes view only; the Table view keeps A3's 22px.

| W | Max visible columns (N) | Pane width = (W − 56 − (N−1)·14) / N | Receipt row form | Section-head hidden strip | Composer row 1 meta |
|---|---|---|---|---|---|
| ≥ 1440 | 4 | 1440 → **335px** | narrow (§6.2) | tabs: seat + `.pill--sm` | shown |
| 1200 – 1439 | 2 | 1200 → **558px** | wide (§6.2) | summary chip `N hidden · names` | hidden |
| 960 – 1199 | 2 | 960 → **445px** | narrow | summary chip | hidden |

- **Grid:** `grid-template-columns: repeat(N, minmax(0, 1fr)); gap: 14px;` and the pane row fills the remaining height (`flex: 1; min-height: 0`). Columns are always equal. With fewer panes than N, the grid uses that count of equal columns.
- **Wide vs narrow is decided by pane width:** wide when the pane is ≥ 520px, narrow otherwise. The table above shows the result at the reference widths.
- **Vertical budget at the reference sizes**, with section head 70px (micro 14 + h1 32 + counts 16 + 2×4 gaps) and a two-row composer (98px at 1440; up to 132px when targets wrap):
  - 1440×900: panes 578px;
  - 1200×800: 478px;
  - 960×640: ≈ 244–278px. The receipts well scrolls (§5.6).
- Below 960×640 the A3 pin §5.2 guard rows apply unchanged; Q5's `minWidth`/`minHeight` keeps the window at or above 960×640.

### 5.5 Hidden panes

- Panes beyond N are **hidden**, not closed. **There is no close for a pane.** A hidden pane keeps its thread loaded on the desktop's connection (engine fact: a loaded thread holds its lock until the connection ends; M1 PIN line 99, M0 Amendment 1 carried forward).
- **Order:** panes keep creation order. Visible panes are positions 1..N. Showing a hidden pane (click its tab or summary chip, or the palette `Show pane ‹seat›`) puts it in the rightmost visible slot. The pane that was there becomes hidden. Nothing is unloaded.
- **≥1440:** each hidden pane is a tab in the section head: 30px high, 1px `--madc-border`, radius 4px, `--madc-bg` fill, seat name (UI 12.5/600 bright) plus the pane's header pill at `.pill--sm` size. This extends A3's `.pill--sm` use (Engine-card header only) to hidden tabs; tone and words follow §6.1 unchanged.
- **<1440:** one summary chip with `N hidden` (UI 12.5/600 bright) followed by `·`-separated seat names (mono 11 muted, max 230px at 960, 300px otherwise, ellipsis). Activating it opens the palette pre-filtered to `Show pane`.
- **A pane with no thread** (a draft pane that was never started, or one whose `thread/start` failed; §6A.3) holds nothing. It is the only kind of pane that can be removed, via `Dismiss pane ‹seat›` (§8), because there is nothing loaded to keep. It can also be hidden and shown like any pane. A new draft pane (`New pane on seat ‹seatId›`) takes the rightmost visible slot, and the pane that was there becomes hidden, as when a hidden pane is shown.

### 5.6 Scroll

- `<main>` does not scroll in the Panes view. Each pane's header, banner and footer are fixed. **The pane's receipts well is its only scroll region** (`overflow-y: auto`, scrollbar per §3). It scrolls only when the rows do not fit (the 960×640 frame).
- The composer is fixed under the pane grid. Its target row wraps (§7.1).
- The Table view keeps A3 scroll rules (`<main>` scrolls; only `#output` may scroll horizontally).

---

## 6. Evidence-bound primitives

### 6.1 Closed pill vocabulary (A3 pin §4.2, amended; Mike, 2026-11-27)

| Tone | Glyph | Words |
|---|---|---|
| `verified` | `✓` | `VERIFIED` |
| `neutral` | `○` | `NO RECEIPT`, `IDLE`, `CONNECTING`, `CONNECTED`, `DISCONNECTED`, **`RUNNING`**, **`COMPLETED`** |
| `warn` | `▲` | `UNVERIFIED`, `STOPPED` |
| `fail` | `✗` | `FAILED`, **`INTERRUPTED`** |

- **New words:** `RUNNING` and `COMPLETED` (neutral), and `INTERRUPTED` (fail, red; not warn). Implementation: extend `ALLOWED_PILL_LABELS` (`packages/desktop/ui/shell.js:109-113`) and the `PillLabel` type (`packages/desktop/src/evidence.ts`). No other word exists.
- **Geometry is unchanged:** 26px; 140px min-width (`INTERRUPTED` fits in about 133px); 1px tone border; filled glyph block; mono 12/600/0.06em uppercase. `.pill--sm` is 22px.
- **Turn-state pills never call for a receipt.** They are produced as `evidenceTone(null, hint)`, with hint `"fail"` for `interrupted` and `failed` and `"neutral"` otherwise. So a turn pill can never be green.

### 6.2 Pane anatomy (top to bottom; px from `final.css`)

1. **Header** (padding `10px 12px 8px`):
   - **Top row**, left column, `min-width: 0`: position number + seat name (`seatId`), from `Thread.seatId` (`protocol/types.ts:23-31`) or the requested `seatId` before the thread exists; thread line `threadId · turnId` (current or last turn), `thread/start · hh:mm:ss ET` while starting, or `no thread yet` for a draft pane. Right: the **turn pill** (§6.3). The focused pane gets `box-shadow: inset 0 2px 0 var(--madc-accent)`.
   - **cwd block** under the top row: the editable field with its state, or the started read-only value (§6A.2, §6A.3).
2. **Banner** (optional, margin `0 10px 8px`, padding `7px 10px`): the starting-thread banner (§6.3).
3. **Receipts well** (margin `0 10px`; rows separated by 1px `--madc-row-rule`). **Before `thread/start` returns** (draft, starting, start failed) the well is replaced by one muted line, `No thread yet. Receipts appear after thread/start returns.` (mono 11, tier 0). Once a thread exists, rows in this fixed order:
   1. **method-error rows**, if any (`turn/start`, `turn/interrupt`, or a `turn.end` failure; a `thread/start` refusal shows in the cwd block, §6A.4);
   2. `servedModel`;
   3. `lane`;
   4. `worktree.topLevel`;
   5. `head@open`;
   6. `hash`.
4. **Footer** (padding `8px 10px 8px 12px`, 1px `--madc-row-rule` top, `margin-top: auto`): the reason text (mono 11 muted, ellipsis) on the left and the `Interrupt turn` button on the right (§7.3). **For a pane with no thread** the right-hand button is `DISMISS PANE` (enabled, except while the thread is starting) and the reason reads `no thread loaded` (or `thread/start pending`).

**Row forms:**
- **Narrow** (pane < 520px):
  - Tone rows are two lines. Grid `minmax(0,1fr) auto`, padding `6px 10px`, row-gap 5px. Line 1 is the key with the pill `justify-self: end`. Line 2 is the chips (`grid-column: 1 / -1`, wrapping, gap 6px).
  - Field rows are also two lines. Line 1 is the key with the field note `field · not a receipt` at the right. Line 2 is the chip.
- **Wide** (pane ≥ 520px): grid `118px 140px minmax(0,1fr)`, column-gap 10px:
  - tone rows: key | pill | chips (wrapping);
  - field rows: key | field note | chip.

### 6.3 Pane states and their evidence sources

"Own connection" means the desktop's socket connection loaded the thread with `thread/start`. A4 has no other way to load a thread (`thread/resume` is deferred, §16). A pane exists only after `New pane on seat ‹seatId›` created it, and every pane starts as a draft.

| State | Turn pill | cwd block (§6A) | Banner / extra row | Bound to (field, file:line at `870c1f7e`) |
|---|---|---|---|---|
| **Draft** (created, nothing sent) | `○ IDLE` | editable; `NO CWD`, `UNCHECKED` or `REJECTED` (§6A.4 states 1–3) | none. Receipts well replaced by the one-line note (§6.2). Composer target disabled `no thread loaded`. Footer `no thread loaded`, button `DISMISS PANE`. | No request exists yet. Created by the palette `New pane on seat ‹seatId›`, which sends nothing. |
| **Starting thread** | `○ IDLE` | `○ STARTING`, input `readonly` | Banner: **"Starting thread."** + `thread/start` `pending. No turn can start until it returns.` Composer target disabled `starting thread`. | Request in flight: `thread/start {seatId, cwd?}` (M1 PIN line 75; `server.ts:1357-1395`). Ends at the `{thread: Thread}` result; the engine also notifies `thread/started` (M1 PIN line 78; `server.ts:1391`). |
| **Start failed** | `○ IDLE` | `✗ REFUSED` with chips and issues; input editable (§6A.4 state 4) | none. Footer `no thread loaded`, button `DISMISS PANE`. | RPC error `{code, message, data}` (M1 PIN §4, line 133ff); or the R5 string (§6A.1). |
| **Idle (loaded, no turn yet)** | `○ IDLE` | `○ STARTED`, read-only value | none | `Thread.status === "idle"` (`protocol/types.ts:21`); the `thread/start` result. |
| **Running** | `○ RUNNING` | started | Footer: `manual · sent once`; Interrupt enabled. `hash` and `events` reset to `—` with the note `chain head moved · read after turn/completed`. | `turn/start` result `{turn}` with `status: "inProgress"` (M1 PIN line 86), or a `turn/started` notification (M1 PIN line 88; `server.ts:2316`). Notification forwarding: PR #81 amendment 2 §3. |
| **Completed** | `○ COMPLETED` | started | none | `turn/completed` notification `{turn}` with `status: "completed"` (M1 PIN line 89; `server.ts:2851`), then confirmed by the `turn.end` JSONL event `payload.status` from the one automatic `session/read` (seat pin line 168; `session-store.ts:119-123`). |
| **Interrupted** | `✗ INTERRUPTED` (fail, red) | started | Footer: `turn ended · interrupted` | `turn.end.payload.status === "interrupted"` (`session-store.ts:121`; written by `turn/interrupt`, `server.ts:2459-2471`, or by shutdown, `server.ts:531-541`). |
| **Failed (turn)** | `✗ FAILED` | started | Row `turn.end` `✗ FAILED`, chip `code` = `error.code`, note = `error.message` verbatim (sanitised per A3 §4.2). | `turn.end.payload.error` (`session-store.ts:122`); `Turn.error` set iff `failed` (`protocol/types.ts:42-50`). |
| **Refused (presence-gated seat)** | `○ IDLE` (no turn was created) | started | Row `turn/start` `✗ FAILED`, chips `code -32007` and `reason ‹reason›`; `data.providerId` and `data.status` go in the row `title` and accessible name. Footer: `refused · no network`. Composer target disabled: `refused -32007`. | `turn/start` error `-32007 ProviderDenied`, `data: {providerId, status, reason}` (M1 PIN line 153). Thrown inside `turn/start` before a turn exists (`server.ts:2210`, `:2216`, `#presenceRefusal` `:2373-2405`). For the seeded `surface-architect` seat (`roster.ts:87-109`, `preferredBacking: "ollama-cloud"`, `policy.headlessOk: false`) the lane is `allowed-direct` with `headless: "denied"` (`registry/src/catalog.ts:79-90`), so the reason is **`headless-not-permitted`** (`registry/src/assert.ts:58`). Interactive-only lanes give `interactive-only-headless` (`assert.ts:45`). Render whichever reason the engine returns, verbatim. A `-32007` with `repo-not-allowed` or `repo-identity-ambiguous` comes from the thread's `cwd` (`server.ts:430-470`; §6A.1) and renders the same way. |
| **History (connection ended)** | `○ DISCONNECTED` | read-only value | Footer `connection ended · history only`. Every receipt row resets to its `—` / `○ NO RECEIPT` form (cached reads are discarded, as A3 pin §4.3 does on a new `room/inspect`). Composer target disabled `not connected`. **No `Reopen pane`** (deferred, §16). | A3 pin §6.1 / §6.4 connection state (`DISCONNECTED`, or R4 on the next RPC, A3 pin §6.5); PR #81 pin §6.1 "History" row (`:314`; table `:305-314`); when the connection ends the engine releases its locks (`socket.ts:352-357`). A draft pane holds no engine state and keeps its text. |

### 6.4 Receipt rows (exact mapping)

| Row key | Pill | Chips | Source (file:line) | Rule |
|---|---|---|---|---|
| `servedModel` | `✓ VERIFIED` / `▲ UNVERIFIED` / `○ NO RECEIPT` | `servedModel ‹value›`, `vendorReported ‹bool›`; plus `fallbackFrom ‹id›` when non-null | JSONL event `type: "servedModel"`, `payload` = `ServedModelPayload` (`session-store.ts:94-108`) from `session/read`, choosing the **last** `servedModel` event whose `payload.turnId` is the latest turn. Live: `item/completed` with `item.kind === "servedModel"` (`ServedModelItem`, `protocol/types.ts:129-142`; M1 PIN line 113; `server.ts:2579-2588`). | **From `session/read`:** receipt `{kind:"servedModel", servedModel, vendorReported}`. `vendorReported === true` → `verified` (`shell.js:175-180`). `vendorReported === false` → hint `"warn"` → `▲ UNVERIFIED` (Mike ruling 3). **Streamed only** (before the post-turn read): hint `"warn"` → `▲ UNVERIFIED`, note `streamed · confirmed by session/read after turn/completed`, whatever `vendorReported` says (Mike FDR ruling). **None:** `○ NO RECEIPT`, chip `servedModel —`. |
| `lane` | none; field note `field · not a receipt` | `lane ‹value›` or `lane —` | `ServedModelPayload.lane` (`session-store.ts:101`), one of `allowed-direct`, `allowed-via-vendor-agent`, `interactive-only`, `forbidden` (`session-v2.ts:187-192`), taken from the same event as the `servedModel` row | Never toned (Mike ruling 4). |
| `worktree.topLevel` | none; field note | `topLevel ‹path›` or `topLevel —` | `RoomThreadRow.worktree.open.topLevel` (`inspect.ts:147-151`; `WorktreeIdentity`, `session-v2.ts:23-30`); also `session.open` `payload.worktree` from `session/read`. `open: null` → `—`. | Never toned, and **never the typed `cwd`** (PR #81 pin `:197`): it is the engine's realpath of the git top level, which can differ from the `cwd` (§6A.1). Before any read of that thread the chip is `—` with the note `not read yet`; when a read shows `worktree: null` the note is `no git work tree recorded`. The path value truncates at the **start** (`direction: rtl` on the value, `<bdi>` inside) so `…/worktrees/th_xxxx` stays visible. Full path in `title`. |
| `head@open` | `✓ VERIFIED` / `○ NO RECEIPT` | `sha ‹first 12 hex›` (full 40 in `title` and accessible name) or `sha —` | `RoomThreadRow.worktree.open.head` (`inspect.ts:147-151`); `WorktreeIdentity.head` is "40 lowercase hex; null only for an unborn branch" (`session-v2.ts:28-29`). | Receipt `{kind:"sha", sha: head}`. Verified iff `/^[0-9a-f]{40}$/` (`shell.js:15`, `:173-174`). **No `chainOk` requirement** (Mike ruling 5). The label is always `head@open`, never "head" or "current" (Mike FDR). When `worktree.missing === true` (`inspect.ts:150`), add the note `worktree missing on disk`; the pill stays bound to the recorded SHA. |
| `hash` | `✓ VERIFIED` / `○ NO RECEIPT` / `✗ FAILED` | `hash ‹12 hex›`, `chainOk true`, `events ‹n›` (verified); `hash —`, `events —` (neutral) | `session/read` result `{threadId, events, chainOk}` (M3 PIN lines 36–38; `ipc.ts:48-52`) | Exactly A3 pin §4.3 B, plus the `events` chip (`events.length`, tabular). Reset to `—` on `turn/started` for that thread. A rejection or `chainOk !== true` → `✗ FAILED` per A3 pin §4.3 B. |
| method-error rows | `✗ FAILED` | `code ‹n›` + each `data` key verbatim (`reason`, `activeTurnId`, `threadId`, `turnId`) | RPC error body (M1 PIN §4) | Never retried automatically. Cleared only by the next successful call of the same method on that pane. |

### 6.5 Receipt chips and the D-693 fix (A3 pin D9 (a), (b)): approved

Chips are A3 spec §6.4 unchanged: 24px, boxed key–value, never tone-coloured.

**(a) Multi-chip clipping in the Room table (below about 1266px, including 1200×800).** The recommended fix keeps the seat visible at every width:
1. **All widths:** `.cell-receipt` gets `flex-wrap: wrap; row-gap: 6px`. Chips wrap onto a second line inside the receipt track instead of clipping. `.room-row` keeps `min-height: 60px` and grows to fit (`padding-block: 9px`). The `row-note` wraps (`white-space: normal`) on its own line (`flex-basis: 100%`).
2. **≥ 1200px:** A3's five tracks are unchanged (`148px 100px 108px 48px minmax(0,1fr)`, gap 12px). The seat keeps its own column. At 1200×800 the receipt track is 194px, so `hash` + `chainOk` wrap onto two lines (frame `direction-a-final-table.png`).
3. **960–1199px:** the separate seat track is removed and the seat **moves into the thread cell**. The cell becomes a stacked `THREAD · SEAT` cell: thread id (mono 13/500 bright) over seat name (UI 12/16 fg, ellipsis). Tracks are `140px minmax(96px, 0.62fr) 48px minmax(168px, 1.9fr)` with an 8px gap. The header reads `EVIDENCE · THREAD · SEAT · EVENTS · RECEIPT`.
   - At 960×640 (left column 520px, inner 486px), the receipt track is ≥ 168px, so D9's floor still holds the 12-hex `hash` chip. The `thread · seat` cell is ≥ 96px.
   - This replaces D9's 960–1199 `room-row` track rule (`@media (max-width: 1199px)` block, `styles.css:904`ff) and its 50px thread floor. The `clamp(360px, 37.5vw, 440px)` right column and the 140px evidence track stay.

**(b) `exit-20` `pid` chip clip in the Receipts well at 960px.**
- **All widths:** `.receipt-chips` wraps (`flex-wrap: wrap; row-gap: 6px`). The note wraps.
- **< 1200px** (and in any right-column placement): `.receipt-row` becomes two lines with grid `112px minmax(0,1fr)`:
  - line 1 is the label, with the pill `justify-self: end`;
  - line 2 is the chips (`grid-column: 1 / -1`) — `serve exit 20 owned`, `pid ‹pid›` — and then the verbatim `parseLockOwnerGuidance().manualFix` note, which wraps.
- Nothing clips at 960×640 (frame `direction-a-final-table-960.png`).

**(c) Pane receipt wells** use the same wrapping chips (§6.2), and seat visibility there is structural (the pane header).

**Ruled (Mike, 2026-11-27, 11:33 PM ET): the seat stays folded into the thread cell below 1200px.** The alternative, hiding `seat` below 1200px (A3 pin D9's proposal), is rejected (§15).

### 6.6 Receipts well (Table view)

This is A3 pin §5.4, plus one row kind: each engine **method refusal** returned in this session (`turn/start`, `thread/start`, `turn/interrupt`) is appended as a row labelled with the method, pill `✗ FAILED`, chips `code`, the verbatim `data` keys, and `seat ‹seatId›`. The same refusal also shows on its pane (§6.3). Rows are only what the engine returned. Nothing is fabricated.

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

---

## 7. Composer, start and interrupt

### 7.1 Anatomy (tier-1 card under the pane grid; padding `10px 14px`; row gap 8px)

- **Row 1, targets:**
  - micro-label `COMPOSE`, then one target chip per pane (visible and hidden, in pane order);
  - each chip is 28px high, padding `0 10px`, 1px `--madc-border`, radius 3px, mono 12, with a box glyph `■` (selected, accent) or `□` (not selected, muted);
  - selected: 1px accent border + `--madc-select-fill` + bright text;
  - at ≥1440, the right side shows `turn/start · one request per thread` (mono 11 muted);
  - the row wraps (`flex-wrap: wrap; row-gap: 6px`).
- **Row 2:** the input (34px, tier 0 well, UI 13 bright, `min-width: 240px`, flex 1) and the primary button `START TURN · ‹n› seat(s)` (32px, 1px accent border, `--madc-lighter`).

### 7.2 Targeting

- **Default:** only the focused pane's target is selected, if it is enabled.
- **Toggle:** click or `Space` on a target chip, or the palette `Toggle target ‹seat›`.
- **Disabled targets** (`aria-disabled="true"`, 50% opacity, never selected) show their reason inline, verbatim:

| Reason shown | Condition (evidence) |
|---|---|
| `turn active` | The pane's thread has an `inProgress` turn (`turn/start` result or `turn/started`). The engine would answer `-32004` (M1 PIN line 95). |
| `starting thread` | `thread/start` is in flight. |
| `refused -32007` | `turn/start` on this pane returned `-32007` in this connection. The full `reason` is in `title`. |
| `no thread loaded` | The pane is a draft (nothing sent yet) or `thread/start` failed (§6A). |
| `not connected` | The connection state is not `CONNECTED`. |

### 7.3 Start

- **Triggers:** the button, or `Cmd+Enter` (macOS) / `Ctrl+Enter` (Linux, Windows) while the composer input has focus, or the palette `Start turn`.
- **Enabled when:** `CONNECTED`, the trimmed input is non-empty, and at least one enabled target is selected.
- **Action:** one `turn/start {threadId, input: [{type: "text", text}]}` per selected enabled target (M1 PIN line 86; `UserInput` text only, line 91).
  - `mode` is **omitted**, so the engine uses `headless` (M1 PIN P3, line 93, fail-closed). The desktop has no terminal to claim presence with.
  - Requests are independent, and each result binds only to its own pane.
  - The input clears only if every request returned a `{turn}`. Otherwise the text stays and each refused pane shows its row.
- **No retry, no queue, no auto-start.**

### 7.4 Interrupt

- **Where:** a labelled button `INTERRUPT TURN` in the pane footer (plus the palette `Interrupt turn on ‹seat›`). No key is bound. A future key would be `Cmd/Ctrl+Shift+.` behind a confirmation, and never `Esc` (Mike ruling 6). It is reserved, not implemented.
- **Enabled only when** the pane is own-connection, the turn is `inProgress` (turn id known from the `turn/start` result or `turn/started`), and no interrupt is pending.
- **Action:** exactly one `turn/interrupt {threadId, turnId}` (M1 PIN line 87; `server.ts:2459-2471`). While it is pending the button is disabled with the footer text `turn/interrupt sent`. The result `{}` is not a state; the pane changes only on `turn/completed`, or on the `turn.end` read, to `✗ INTERRUPTED`. An `{}` for an already-finished turn changes nothing.
- **Never automatic:** no timeout, no "stop all", no interrupt on view switch, hide or blur. Quit is the only path that ends turns without a per-turn click, and it asks first (§10).

---

## 8. Keys and palette (A3 pin §1.1 Q2 and §5.5, amended closed list)

### 8.1 Keys

| Key | Scope | Action |
|---|---|---|
| `Cmd+K` / `Ctrl+K` | anywhere | palette toggle (unchanged) |
| `Cmd+Enter` / `Ctrl+Enter` | composer input focused | Start turn (§7.3) |
| `Cmd+1`–`Cmd+4` / `Ctrl+1`–`Ctrl+4` | anywhere, palette closed | Switch to the Panes view if needed, then focus the visible pane at that position (a draft pane puts focus in its cwd field). No-op if the slot is empty. |
| `Tab` / `Shift+Tab` | unchanged | Standard focus order: focus bar → toggle → hidden strip → panes (header, rows, footer button) → composer. |
| `Esc` | unchanged | Closes the palette (A3). Also closes the quit dialog as **Keep running** (§10). Never interrupts anything. |
| `←` / `→` | toggle, focus bar | Unchanged roving behaviour. |
| `Space` | composer target chip | Toggle target. |
| `Enter` | cwd input (§6A.6) | Start the thread (`thread/start`). Never a turn. |
| `Esc` | cwd input (§6A.6) | Revert the edit to its baseline; on an unchanged field only move focus to the pane. Never dismisses, sends or interrupts. |
| `Cmd/Ctrl+Enter` | cwd input | Nothing (§6A.6). Starts a turn only from the composer input. |

- Modifier detection is exactly A3 Q2: `metaKey && !ctrlKey` on macOS, `ctrlKey && !metaKey` elsewhere.
- **No `Ctrl+F` or `Cmd+F`** anywhere. No other global shortcut is added.

### 8.2 Closed command list (A3's nine, plus these; nothing else)

| Group | Command (id) | Enabled when | Action | Key hint |
|---|---|---|---|---|
| Engine | *(unchanged)* Connect to @madc/engine, Inspect room, Disconnect | A3 pin §5.5 | A3 | A3 |
| Focus | *(unchanged)* Focus Engine (`Focus Engine` also switches to Table, §5.2), Focus Room, Focus Decisions, Focus Search | A3 | A3 | A3 |
| Evidence | Copy chain head (`cmd-copy-chain-head`) | a verified `hash` on the focused pane or selected row | copies the full 64 hex | — |
| Evidence | Copy served model (`cmd-copy-served-model`) | the focused pane's `servedModel` row is `verified` | copies the string | — |
| Evidence | **Copy head@open** (`cmd-copy-head-open`) | the focused pane's `head@open` is `verified` | copies the 40 hex | — |
| Panes | **Show Panes view** (`cmd-view-panes`) / **Show Table view** (`cmd-view-table`) | the other view is active | §5.2 | — |
| Panes | **Focus pane 1–4** (`cmd-pane-focus-1` … `-4`) | a visible pane at that slot | §8.1 | `⌘1`–`⌘4` / `Ctrl 1`–`Ctrl 4` |
| Panes | **New pane on seat ‹seatId›** (`cmd-pane-new:‹seatId›`), one row per `seat/list` entry | `CONNECTED` and `SeatSummary.ok === true`; else disabled with metadata `seat load failed ‹code›` | Creates a **draft pane** (§6A.3) in the rightmost visible slot and focuses its cwd field. Sends nothing. `thread/start` is sent by `Enter` or `START THREAD` in that field (§6A.6). There is no second palette step and no cwd palette command. | — |
| Panes | **Show pane ‹seat›** (`cmd-pane-show:‹paneId›`), one per hidden pane | always | §5.5 | — |
| Panes | **Hide pane ‹seat›** (`cmd-pane-hide`) | the focused pane is visible and more than one pane exists | moves it to hidden; nothing is unloaded | — |
| Panes | **Dismiss pane ‹seat›** (`cmd-pane-dismiss`) | the focused pane has no loaded thread (draft, or start failed) and is not starting | removes that pane; sends nothing; the typed text is discarded | — |
| Turn | **Start turn** (`cmd-turn-start`) | §7.3 | §7.3 | `⌘↵` / `Ctrl ↵` |
| Turn | **Interrupt turn on ‹seat›** (`cmd-turn-interrupt:‹paneId›`), one per own-connection pane with an `inProgress` turn | §7.4 | §7.4 | **none** |
| Turn | **Toggle target ‹seat›** (`cmd-target-toggle:‹paneId›`) | the target is enabled | §7.2 | — |

- **Dynamic rows** (`‹seatId›`, `‹paneId›`) are the only generated entries. Their id prefixes are closed.
- Filter, keys and ARIA are A3 §7 unchanged. Disabled rows show the reason as metadata (e.g. `turn active`, `not connected`).
- D7 stands: there is still **no** "Read thread" command. The only automatic `session/read` is §9's.

---

## 9. Live updates

- **Subscription:** unchanged. The desktop already initializes with `capabilities.subscribeRoom: true` (`launcher.rs:438`). The engine broadcasts `room/updated {reason, threadId}`, with `reason` one of `"thread" | "turn" | "handoff" | "decision"` (M3 PIN line 43; `socket.ts:338-343`).
  - It fires on a turn start (`server.ts:2318`) and on every turn end, including an interrupt at shutdown (`server.ts:2853`).
  - It fires on thread open and close (`server.ts:1392`, `:558`, `:1842`, `:1858`, `:1885`).
  - At `870c1f7e` the launcher drops every notification while waiting for a response (`launcher.rs:545-547`). PR #81 amendment 2 §3 adds the forwarding path.
- **Own-connection panes** use their connection's notifications:
  - `turn/started` → `○ RUNNING`;
  - `item/completed` → the streamed `servedModel` (stays `▲ UNVERIFIED`, confirmed by Mike 2026-11-27 11:33 PM ET);
  - `turn/completed` → the turn pill from `turn.status`.

  **Then exactly one automatic `session/read {threadId}`** confirms `turn.end`, `servedModel`, `lane`, `hash` and `events` (Mike FDR ruling). Deltas (`item/agentMessage/delta`) are not rendered; this is not a transcript view.
- **Read-only panes** (a thread another client holds) are not built in A4 (§16), so `room/updated` drives no pane. It drives only the Table stale note below.
- **Hidden panes** never read automatically. If a turn completed while hidden, the one read happens when the pane is shown, and it counts as that turn's read.
- **Room table (Table view):** `room/updated` never triggers `room/inspect`. The section head shows the neutral note `room changed · Inspect room to refresh` (mono 11 muted) until the next `Inspect room`. That keeps A3 pin §6.5: no polling.
- **Never:** a poll loop, bulk reads, a read on `reason: "thread"`, `"handoff"` or `"decision"`, or more than one read per completed turn. In-flight dedupe and stale-result dropping are A3 pin §4.3 B.

---

## 10. Quit flow

- **Engine fact:** closing the desktop's socket ends its `EngineConnection`. `run()` finishes and `releaseLocks()` runs (`socket.ts:345-358`), and `shutdown()` ends every in-flight turn on that connection as `interrupted` before releasing locks (`server.ts:531-541`). A desktop-spawned `serve` is also stopped by `disconnect_engine` (`main.rs:86`; A3 pin §6.4 R4). Quitting therefore interrupts every running turn on the desktop's connection, including turns in hidden panes.
- Intercepting the window close needs a Tauri close-request hook; `main.rs:109-120` registers none at `870c1f7e`. PR #81 amendment 2 §6.1 adds it.
- **No running own-connection turns:** quit immediately, with no dialog.
- **One or more running:** show the dialog (frame `quit-confirm.png`):
  - **Panel:** `role="alertdialog"`, `aria-modal="true"`, 560px wide, centred, tier-2 strong glass (§3). No full-window scrim (A3 §9 "not open"). The background gets `inert`.
  - **Micro-label `QUIT`.** Title: `Quit MADC Desktop with ‹n› turn(s) running?`
  - **Body (verbatim):** "Quitting closes this window's engine connection. The engine then ends every running turn on it as **interrupted** (`turn.end` status `interrupted`), including turns in hidden panes. Threads other clients hold are not affected."
  - **List** (tier-0 well): one row per running own-connection turn. Grid `140px minmax(0,1fr) auto`. Each row has the seat (UI 13/600 bright, `(hidden)` suffix for hidden panes), `threadId · turnId · started hh:mm:ss ET` (mono 12 fg, ellipsis), and `○ RUNNING`.
  - **Footer:** `KEEP RUNNING` (primary, accent border, **default focus**) and `QUIT AND INTERRUPT ‹n› TURN(S)` (neutral button). No red button: red is the fail tone only.
  - **Keys:** `Enter` activates the focused button. `Esc` = Keep running. `Tab` is trapped in the dialog.
- **Quit and interrupt:** the UI sends **no** `turn/interrupt` calls. It closes the connection (`disconnect_engine`) and the window. The engine records the interruptions.

---

## 11. Accessibility and fallbacks

- A3 spec §3.3 contrast tables apply unchanged. The new text roles use only `fg` and `bright` for essential text and `muted` for non-essential text (field note, footer reason, position number, hidden-strip names, which are also in the accessible name).
- Every pane is a `region` named `‹seat› pane, ‹threadId›`. The turn pill's accessible name is `turn ‹WORD›`. Chips expose full values (64-hex hash, 40-hex SHA, full path) in `title` and in the accessible name.
- **Status changes** (`RUNNING`, `COMPLETED`, `INTERRUPTED`, `FAILED`, refusals) are announced once through one polite live region per window, as `‹seat›: turn ‹word›` or `‹seat›: turn/start refused -32007 ‹reason›`. cwd field announcements are in §6A.9.
- `forced-colors`, `prefers-reduced-motion` and `prefers-reduced-transparency`: A3 §3.4 and D8 unchanged. They cover the new pills, panes and the quit dialog.
- **Safari < 18:** the opaque fallback under the verbatim `@supports not (backdrop-filter: blur(1px))` block is unchanged (A3 pin D9; D-699, which superseded D-694). It now covers the quit dialog too. No new frame is needed.

---

## 12. Integration contract and acceptance checklist

### 12.1 Files (no build step; plain JS UI per A3 pin D5)

- `packages/desktop/ui/styles.css`:
  - pane, composer, toggle, hidden-strip and dialog rules;
  - the D-693 rules (§6.5);
  - extended tokens use only. No new hex.
- `packages/desktop/ui/shell.js` / `shell.d.ts`:
  - pure helpers `cwdCheck(text)` and `cwdFieldState(text, phase)` (§6A.4, §6A.5), `paneStateFromSession(events)`, `receiptRowsForPane(...)`, `composerTargets(...)`, `paneColumns(width)`;
  - quit-list builder;
  - the amended `ALLOWED_PILL_LABELS` and `PALETTE_COMMANDS`.
- `packages/desktop/ui/index.html`: Panes view container, composer, dialog template.
- `packages/desktop/ui/app.js`: key wiring for §8.1 and §6A.6.
- `packages/desktop/src/evidence.ts`: `PillLabel` gains `RUNNING`, `COMPLETED`, `INTERRUPTED`.
- **Rust (`launcher.rs`, `main.rs`):** only as the pin allows (§14).

### 12.2 Acceptance checklist (CI-testable; mock-only, fake DOM per A3 pin D6)

**Pills and receipts**
1. Turn pills never resolve to `verified`, for every `TurnStatus` × hint combination.
2. `INTERRUPTED` renders `data-tone="fail"` with glyph `✗`.
3. `RUNNING` and `COMPLETED` render `neutral` `○`.
4. `ALLOWED_PILL_LABELS` equals the §6.1 table exactly.
5. `servedModel` row: `vendorReported:true` from `session/read` → `verified`; `vendorReported:false` → `warn` `▲ UNVERIFIED`; streamed `item/completed` only → `warn`, even with `vendorReported:true`; none → `neutral`.
6. `head@open` is `verified` for any 40-lowercase-hex SHA without `chainOk`, `neutral` for null or a missing worktree. The label string is exactly `head@open`.
7. `lane` and `worktree.topLevel` rows contain no `.pill` and contain the text `field · not a receipt`.
8. `-32007` on `turn/start` renders a `✗ FAILED` row with `code` and `reason` chips verbatim (`headless-not-permitted` and `interactive-only-headless` cases). The pane's turn pill stays `○ IDLE`. No element in that pane has `data-tone="verified"` from the refusal.
9. `thread/start` refusals render in the cwd block, not as a receipt row: see C9 and C10 (§6A.10). Read-only panes and `thread/resume` are deferred (§16); the desktop sends no `thread/resume` (the allowlist test of PR #81 amendment 2 §13 covers the method list).

**Composer and interrupt**
10. A busy target is disabled with `turn active`. A start sends exactly one `turn/start` per selected enabled target, with no `mode` key.
11. Interrupt sends exactly one `turn/interrupt {threadId, turnId}` per click, is disabled while pending, and is never sent by any timer, view switch, hide, blur or quit.

**Live updates**
12. Exactly one automatic `session/read` per completed turn on a visible pane, and none for hidden panes until shown. `room/updated` with `reason` ≠ `"turn"` never reads. No `room/inspect` is triggered by `room/updated`.

**Layout and D-693**
13. Panes grid: `paneColumns(1440) = 4`, `paneColumns(1200) = 2`, `paneColumns(960) = 2`. Wide row form iff pane width ≥ 520.
14. Static CSS assertions:
    - `.cell-receipt` and `.receipt-chips` have `flex-wrap: wrap`;
    - below 1200px no rule sets `display: none` on the seat text (with §6.5 recommended);
    - the 960–1199 Room tracks are `140px minmax(96px, 0.62fr) 48px minmax(168px, 1.9fr)`;
    - below 1200px the Receipts row grid is `112px minmax(0,1fr)`.

**Quit**
15. No running own-connection turns → no dialog. Running → dialog lists exactly those turns, hidden panes included. Default focus is Keep running; `Esc` keeps running. Confirming sends zero `turn/interrupt` and calls `disconnect_engine` once.

**Keys and palette**
16. No `keydown` handler reacts to `f` with Ctrl or Meta. `Cmd/Ctrl+1–4` only focus. `Cmd/Ctrl+Enter` only starts from the composer input.
17. Palette ids are exactly A3's nine plus §8.2's. No id outside that set. No "Read thread" command.

**Carried over**
18. No-decorative-green guard (A3 pin §9) still passes over the new rules.
19. No external URLs (A3 pin §3.3).
20. **cwd field:** all of §6A.10 (C1–C15) passes.
21. No `Reopen pane` command, button or palette row exists, and no `cmd-pane-open-thread` id (§16).

---

## 13. Rulings (approved by Michael Daley, 2026-11-27, via MADC Architect)

| # | Ruling | Where |
|---|---|---|
| R1 | Layout: Direction A, Equal Columns, with the Panes/Table toggle. | §5 |
| R2 | New pills: `RUNNING` and `COMPLETED` (neutral `○`); `INTERRUPTED` (fail `✗`, red, not warn). | §6.1 |
| R3 | A servedModel without vendor confirmation shows `▲ UNVERIFIED`. | §6.4 |
| R4 | `lane` and `worktree.topLevel` show the value, no pill, and the note "field · not a receipt". | §6.4 |
| R5 | The worktree head is verified by a valid 40-hex SHA only, with no `chainOk` requirement. | §6.4 |
| R6 | Keys: `Cmd/Ctrl+Enter` starts a turn. Interrupt is a button or palette command only; any future key is `Cmd/Ctrl+Shift+.` behind a confirm, never `Esc`. `Cmd/Ctrl+1–4` focuses a pane. No `Ctrl+F`. | §7, §8 |
| R7a (FDR) | The head label is `head@open`, never "current". | §6.4 |
| R7b (FDR) | A streamed servedModel becomes verified only after `session/read` confirms it, so it stays unconfirmed while the turn streams. | §6.4, §9 |
| R7c (FDR) | Each completed turn on a visible pane gets exactly one automatic `session/read`. No polling, no bulk. | §9 |

**Rulings relayed 2026-11-27, 11:33 PM ET (MADC Architect), approved by Mike:**

| # | Ruling | Where |
|---|---|---|
| R8 | D-693: below 1200px the seat stays folded into the thread cell (`THREAD · SEAT`), the recommended option. §15 is closed; nothing is pending. | §6.5, §15 |
| R9 | A stream-only served model shows `▲ UNVERIFIED`. Already drawn; confirmed. (PR #81 pin FDR-A4-2's default `○ NO RECEIPT` is overruled.) | §6.4, §9 |
| R10 | The five Iris extras are accepted: Dismiss pane, hidden-pane tabs (and the summary chip), a shown hidden pane takes the rightmost slot, `Esc` on the quit dialog means Keep running, and the Table stale note. **`Reopen pane` is deferred** and removed from scope. | §5.5, §8.2, §10, §9, §16 |
| R11 | The user types an absolute `cwd` into a **field in the pane header**. A palette field for the `cwd` was rejected. | §6A |

**Engine facts designed in (from Surface Architect):**
- a real starting-thread state (and, with the cwd field, a draft state before it, §6A);
- honest presence refusals;
- no close for hidden panes;
- quit interrupts running turns and must say so.

These are in §5.5, §6.3 and §10. The engine fact that a thread loaded by another client is read-only is deferred with `thread/resume` (§16).

---

## 14. Notes for the pin (Surface Architect; not visual)

The r1 list of open items is now answered by PR #81 (draft). What remains is where PR #81 and the approved rulings differ, and the cwd-field items. Nothing here is a question for Mike.

**Where PR #81 (head `fef26e6e`) needs to change to match the rulings**

1. **cwd entry surface.** PR #81 pin §5.3 (`:241-245`) specifies a two-step palette field; acceptance 25 (`:380`) and FDR-A4-4 (`:87`, `:415`) refer to it. Mike ruled a field in the pane header (R11). Replace §5.3 with §6A (the addendum `CWD-FIELD-addendum.md` is §6A alone), reword acceptance 25 to C1–C15, and close FDR-A4-4. `cmd-pane-new:‹seatId›` then creates a draft pane and sends nothing.
2. **Stream-only `servedModel`.** Drop pin D4 and FDR-A4-2's default (`○ NO RECEIPT`); Mike ruled `▲ UNVERIFIED` (R9, spec §6.4).
3. **FDR-A4-1 and FDR-A4-3 are closed** by R8 and R10: accept the seat fold, and accept (a), (c), (d), (e), (f); (b) `Reopen pane` stays deferred.
4. **thread/resume.** Spec r2 no longer asks for `thread/resume`, read-only panes, `Open selected thread in pane` or `Reopen pane`, so pin D2 can shrink to a citation of FDR-1 (§16).
5. **Source file.** PR #81 carries spec r1 verbatim (sha256 `545825360d…`). Replace it with this revision.

**cwd field items**

6. **Client check parity.** The window's `cwdCheck` (§6A.5) equals the shell's `validate_rpc_params` check (amendment 2 `:81`) on POSIX: absolute, 1..=4096 bytes, no NUL. The Windows desktop is out of scope in A4 (pin `:347`).
7. **Receipts after start.** The pin's sources for `worktree.topLevel` and `head@open` are a `session/read` or a user-run `Inspect room` (pin `:203-209`), and the automatic read is per completed turn (`:215-217`). So a started pane shows `topLevel —` / `head@open ○ NO RECEIPT` with the note `not read yet` until the first turn completes or the user inspects the room. **Recommendation, outside any ruling:** one automatic `session/read` right after `thread/start` resolves would show `topLevel` and `head@open` at start. That would further narrow D-682 (A3 Q4), so the spec does **not** assume it.
8. **`Thread.cwd` is not always the typed text.** For a `worktree: true` seat the engine returns its own worktree path (`server.ts:1437-1447`). The window shows `Thread.cwd`, never the typed text (§6A.3).
9. **Prefill.** The pin prefills the last `cwd` used in this window (`:243`); the spec keeps it and selects the prefill on creation (§6A.6).
10. **No cwd change and no pane close after start.** A wrong `cwd` on a started pane is fixed only by a new pane, and the started pane stays (§5.5, §6A.3). Both follow from the engine having no unload or cwd-change method, and from FDR-1.

**Covered by PR #81, no spec action:** the eight-method allowlist (amendment 2 §1.1), notification forwarding (§3), the per-turn read (pin §4.5), the quit close-request hook (§6.1), the `seat/list` projection, and presence-gated lanes (§16.7).

---

## 15. Closed: D-693 seat visibility (approved 2026-11-27, 11:33 PM ET)

Mike ruled the recommended option: **below 1200px the seat stays folded into the thread cell** (`THREAD · SEAT`: thread id over seat name), with tracks `140px minmax(96px, 0.62fr) 48px minmax(168px, 1.9fr)`, gap 8px, and receipt chips wrapping at every width (§6.5). Hiding the `seat` column below 1200px (A3 pin D9's proposal) is rejected. D-693 closes when the pin PR that carries this ruling merges. No question is open.

---

## 16. Deferred in A4 (not built; not in scope)

| Item | Why deferred | Where it was |
|---|---|---|
| **`Reopen pane`** (sends one `thread/resume` on a disconnected pane) | Ruled deferred (R10), and it needs `thread/resume`. In A4 a pane whose connection ended is history only: footer `connection ended · history only`. | r1 §6.3 "Disconnected" |
| Read-only panes (a thread another client holds), the `thread/resume` method-error row, the `read-only` composer target reason, the `read-only` interrupt reason | `thread/resume` is deferred by FDR-1 / D-708 (PR #81 pin D2, `:102`; `:76`). A thread another client holds cannot be loaded or interrupted from the desktop (`server.ts:2171-2172`, per PR #81 pin D2). | r1 §6.3, §7.2, §9, §12.2 item 9 |
| `Open selected thread in pane` (`cmd-pane-open-thread`) | Needs `thread/resume`. | r1 §8.2 |
| An interrupt key | Reserved only: `Cmd/Ctrl+Shift+.` behind a confirm, never `Esc` (R6). | §7.4 |
| Folder-picker plugin for the `cwd` | Not ruled; the field is typed text (R11; PR #81 pin `:346`). | §1, §6A |
| Windows | D-648, D-670 (PR #81 pin `:347`). | §6A.5 |
