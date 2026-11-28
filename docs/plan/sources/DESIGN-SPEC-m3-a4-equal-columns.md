# MADC M3-A4 design spec: Multi-seat workspace, Direction A "Equal Columns"

**Status:** rulings approved by Mike 2026-11-27 (via MADC Architect); D-693 seat visibility pending.

**Direction:** Michael Daley chose Direction A, "Equal Columns", with the Panes/Table toggle, on 2026-11-27 (relayed by MADC Architect at 10:22 PM ET). It stays inside the pinned Direction C visual system ("Precision Instrument Glass").

**Base:** `MADVenturesLLC/MADC` `main` @ `870c1f7ec3aeca13190f306b23c5d91810675e09` (PR #80, M3-A3 design pin amendment for M1, after PR #79 M3-A3 implementation). Every file and line cited below was read at that commit.

**What this spec is.** It is the Iris design spec for M3-A4 ("Multi-seat side-by-side workspace", PLAN §2 line 27). It extends the M3-A3 spec as shipped (`docs/plan/sources/DESIGN-SPEC-m3-a3-precision-instrument-glass.md`, "A3 spec") together with the pinned deviations D1–D9 of `docs/plan/PIN-madc-M3-design-precision-instrument-glass.md` §1.3 ("A3 pin"). It is not a pin. Surface Architect pins it. Where a merged pin differs from this text, the pin wins.

**Assumption marker.** Anything marked **[ASSUMPTION: unpinned]** relies on protocol or shell behaviour that does not exist at `870c1f7e`. Each one is listed again in §14 for the pin.

---

## 0. Source of truth

| What | Path | sha256 |
|---|---|---|
| Frame, Panes view, 1440×900 (app content; canvas 1488×1010 @2x) | `/workspace/iris-madc-m3a4/direction-a-final.png` | `4003282132432a197f2fbd967dc26496f315b638966d879241a10c96877a1105` |
| Frame, Panes view, 1200×800 | `/workspace/iris-madc-m3a4/direction-a-final-1200.png` | `8de9a0397801d7a216dda75915a2f859fc5c3d2b7e3cc030fbac2c036366e46c` |
| Frame, Panes view, 960×640 | `/workspace/iris-madc-m3a4/direction-a-final-960.png` | `ff94e5922d606a401e973d6bf99ece919b5b1d59a2bfb1ba9a111f159a4a9c73` |
| Frame, Table view, 1200×800 | `/workspace/iris-madc-m3a4/direction-a-final-table.png` | `e9958f514259faa51ddea3e91589da81670e2f565c00616c455b63adccb01a28` |
| Frame, Table view, 960×640 | `/workspace/iris-madc-m3a4/direction-a-final-table-960.png` | `8530abfda78cc144704a337e05d2fa89dc47ea777c176ee1c4750aa0c6e49e43` |
| Frame, quit confirmation, 960×640 | `/workspace/iris-madc-m3a4/quit-confirm.png` | `b757a19b9ee8bcabc0e4732d9162de50c85dcc036861ecead352d6d037617811` |
| Reference CSS, shared primitives | `/workspace/iris-madc-m3a4/src/base.css` | `6a16377c9b04b4cd1ceb3f1f48edab886e7b9916c089618bb8098b1117e14e09` |
| Reference CSS, M3-A4 layout | `/workspace/iris-madc-m3a4/src/final.css` | `cfd19eb0fbd1f96586dd7e7121d88bec793a030315f164e6f689c3836d0ccf6e` |
| Reference markup generator (mock data) | `/workspace/iris-madc-m3a4/src/build_final.py` | `07729346ec0bc92bee8f227fab65f0c67d183e40ae45aebc56b2d62de081841a` |

Frames and reference files are box-only and not in the repo. The reference CSS is a mock-up, not shipping code. The builder re-implements it against the tokens in `packages/desktop/ui/styles.css`. Mock seat ids are the real seeded roster (`madc-default`, `daedalus`, `hephaestus`, `prometheus`, `surface-architect`; `packages/engine/src/seats/roster.ts:26-98`); thread ids, turn ids, hashes and SHAs are mock values in the real formats.

**Text wins over the frames on these points. Everywhere else the frames win.**
1. All A3 text-over-frame points (A3 spec §0; A3 pin §1.2) still hold. In particular, the palette prompt is `>` and the palette shortcut is `Cmd+K` / `Ctrl+K`. The focus-bar hint draws `Ctrl K` as in A3.
2. The frames draw an app title bar for context. The real title bar is OS-drawn (A3 pin §5.1).
3. The Table-view frames omit the `#output` well and `#connect-btn` under the Engine card for space. The Table view keeps them exactly as A3 ships them (§5.3).
4. The 960 Panes frame shows the receipts well scrolled to the top, with its scrollbar visible. That is the specified scroll behaviour (§5.6), not clipping.
5. Mock hash, SHA, pid and time values are illustrative.

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
- D7: `session/read` only on explicit selection, plus the per-turn read in §9 (a Q4/D7 extension; see §14).
- D8: the `.pill .pill-glyph` forced-colours selector.
- D9: the 960–1199px band layout and the `-webkit-backdrop-filter` pairing. This spec resolves D9's deferred (a) and (b) in §6.5.

**Hard non-goals (PLAN §1 lines 13–17; any of these is a spec violation):**
- Not an IDE or code editor. No file tree, no LSP, no terminal emulator, no editable code view, no diff viewer.
- No agent loop, tools or credentials in the desktop shell. The window only sends `thread/start`, `thread/resume`, `turn/start` and `turn/interrupt` and reads engine results. It never calls a provider and never holds a secret.
- No decorative green. Green appears only where `evidenceTone()` returned `verified` (A3 pin §4.1).
- No M3-A5+ surfaces: no handoff graph, no Founder Decision Inbox content, no session search UI, no replay inspector, and no bulk verification (M3-A7).
- No emoji, spinners, progress bars, animated loaders, blinking, vendor logos or mascots. Nothing animates. A running turn is a static `○ RUNNING` pill plus a timestamp.
- No M4/M5 scope.

---

## 2. Design principles (binding; A3 §2 plus four)

1–4. A3 §2 unchanged: evidence decides colour; fail is at least as loud as verified; every status has three channels (glyph, word, colour); the look is an instrument, not a dashboard.

5. **A seat is always visible.** Every pane names its seat in its header. Every Room row names its seat at every width (§6.5).
6. **Live is not verified.** A turn that is running, interrupted or completed, a streamed item, and a connected socket are never receipts. Only `session/read` (hash, servedModel) and `room/inspect` (head@open) supply receipts.
7. **The engine's refusal is the state.** When the engine refuses (`-32004`, `-32007` and so on), the pane shows the code and data verbatim in fail tone. It never shows a softened, disabled-looking or green substitute.
8. **No silent automation.** Nothing starts, interrupts, retries or polls without an explicit user action. The one exception is the single automatic `session/read` after a completed turn on a visible pane (§9). That read never changes engine state.

---

## 3. Tokens and inheritance

- **No new tokens and no new hues.** All values come from `packages/desktop/ui/styles.css` `:root` (lines 52–107 at `870c1f7e`; A3 spec §3.1–§3.2). Pane, composer and dialog surfaces use existing tiers:
  - **Pane:** tier 1 (`.card` look): `--madc-bg` fill, 1px `--madc-border`, `--madc-radius-md`.
  - **Receipts well inside a pane, composer input, dialog list:** tier 0 (`.well`): `--madc-darker` (`#0e0e14`), 1px border, `--madc-well-inset`.
  - **Quit dialog:** tier 2 strong glass, identical to the palette: `--madc-glass-fill-strong`, `--madc-glass-blur-strong`, 1px `--madc-muted` border, `--madc-radius-lg`, `--madc-glass-edge` + `--madc-shadow-overlay`.
  - **Read-only and starting-thread banners:** `--madc-lighter` fill, 1px `--madc-border`, radius 4px, text `--madc-bright`. No tone colour. A banner is not a status.
- **Accent stays non-status.** `--madc-accent` marks the focused pane (`inset 0 2px 0 var(--madc-accent)`), selected composer targets (`1px` accent border + `--madc-select-fill`), the primary button border, the active toggle segment underline, and focus rings. It never means "verified".
- **Scrollbar (receipts wells only):** 8px wide; track `--madc-darker`; thumb `--madc-border` with a 2px `--madc-darker` inset border and radius 3px.
- **Safari < 18 / no `backdrop-filter`:** unchanged. The verbatim `@supports not (backdrop-filter: blur(1px))` block falls back to opaque `--madc-lighter` (A3 spec §3.4; A3 pin D9, D-694). The quit dialog reuses the `.palette.glass`-style rule, so it gets the same opaque fallback, the same `-webkit-backdrop-filter` pairing, and the same `prefers-reduced-transparency` block.

---

## 4. Typography (A3 spec §4 unchanged; new roles only)

| Role | Family | Size / line | Weight | Colour |
|---|---|---|---|---|
| Pane seat name | UI | 15 / 20 | 600 | bright |
| Pane position number (`1`–`4`) | mono | 10.5 | 400 | muted |
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
- **Starting-thread pane that fails `thread/start`:** it holds no thread. It is the only pane that can be removed, via `Dismiss pane ‹seat›` (§8), because there is nothing loaded to keep.

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

1. **Header** (padding `10px 12px 8px`). Left column, `min-width: 0`:
   - position number + seat name (`seatId`), from `Thread.seatId` (`protocol/types.ts:23-31`), or the requested `seatId` while starting;
   - thread line `threadId · turnId` (current or last turn), or `thread/start · hh:mm:ss ET` while starting.

   Right: the **turn pill** (§6.3). The focused pane gets `box-shadow: inset 0 2px 0 var(--madc-accent)`.
2. **Banner** (optional, margin `0 10px 8px`, padding `7px 10px`): the read-only banner or the starting-thread banner (§6.3).
3. **Receipts well** (margin `0 10px`; rows separated by 1px `--madc-row-rule`). Rows in this fixed order:
   1. **method-error rows**, if any (`thread/start`, `thread/resume`, `turn/start`, `turn/interrupt`, or a `turn.end` failure);
   2. `servedModel`;
   3. `lane`;
   4. `worktree.topLevel`;
   5. `head@open`;
   6. `hash`.
4. **Footer** (padding `8px 10px 8px 12px`, 1px `--madc-row-rule` top, `margin-top: auto`): the reason text (mono 11 muted, ellipsis) on the left and the `Interrupt turn` button on the right (§7.3).

**Row forms:**
- **Narrow** (pane < 520px):
  - Tone rows are two lines. Grid `minmax(0,1fr) auto`, padding `6px 10px`, row-gap 5px. Line 1 is the key with the pill `justify-self: end`. Line 2 is the chips (`grid-column: 1 / -1`, wrapping, gap 6px).
  - Field rows are also two lines. Line 1 is the key with the field note `field · not a receipt` at the right. Line 2 is the chip.
- **Wide** (pane ≥ 520px): grid `118px 140px minmax(0,1fr)`, column-gap 10px:
  - tone rows: key | pill | chips (wrapping);
  - field rows: key | field note | chip.

### 6.3 Pane states and their evidence sources

"Own connection" means the desktop's socket connection loaded the thread with `thread/start` or `thread/resume`.

| State | Turn pill | Banner / extra row | Bound to (field, file:line at `870c1f7e`) |
|---|---|---|---|
| **Starting thread** | `○ IDLE` | Banner: **"Starting thread."** + `thread/start {"seatId":"‹id›"}` (or `thread/resume {"threadId":"‹id›"}`) `pending. No turn can start until it returns.` All rows show `—`. Composer target disabled: `starting thread`. | Request in flight: `thread/start {seatId?, cwd?}` / `thread/resume {threadId}` (M1 PIN lines 75–76). Ends at the `{thread: Thread}` result or a `thread/started` notification (M1 PIN line 78; `server.ts:1391`, `:1841`, `:1857`, `:1884`). **[ASSUMPTION: unpinned]** these methods need adding to the desktop allowlist (§14.1). |
| **Start failed** | `○ IDLE` | Row `thread/start` (or `thread/resume`) `✗ FAILED` with chips `code` + each `data` key verbatim. Footer: `no thread loaded`. | RPC error body `{code, message, data}` (M1 PIN §4, line 133ff). |
| **Idle (loaded, no turn yet)** | `○ IDLE` | none | `Thread.status === "idle"` (`protocol/types.ts:21`); no `turn.start` in the last `session/read`. |
| **Running** | `○ RUNNING` | Footer: `sends turn/interrupt once · never automatic`; Interrupt enabled (own connection only). `hash` and `events` reset to `—` with the note `chain head moved · read after turn/completed`. | `turn/start` result `{turn}` with `status: "inProgress"` (M1 PIN line 86), or a `turn/started` notification (M1 PIN line 88; `server.ts:2316`). **[ASSUMPTION: unpinned]** notification forwarding (§14.2). |
| **Completed** | `○ COMPLETED` | none | `turn/completed` notification `{turn}` with `status: "completed"` (M1 PIN line 89; `server.ts:2851`), then confirmed by the `turn.end` JSONL event `payload.status` from the one automatic `session/read` (seat pin line 168; `session-store.ts:119-123`). |
| **Interrupted** | `✗ INTERRUPTED` (fail, red) | Footer: `turn ended · interrupted` | `turn.end.payload.status === "interrupted"` (`session-store.ts:121`; written by `turn/interrupt`, `server.ts:2459-2471`, by shutdown, `server.ts:531-541`, or on resume of a dangling turn, `server.ts:2030-2036`). |
| **Failed (turn)** | `✗ FAILED` | Row `turn.end` `✗ FAILED`, chip `code` = `error.code`, note = `error.message` verbatim (sanitised per A3 §4.2). | `turn.end.payload.error` (`session-store.ts:122`); `Turn.error` set iff `failed` (`protocol/types.ts:42-50`). |
| **Refused (presence-gated seat)** | `○ IDLE` (no turn was created) | Row `turn/start` `✗ FAILED`, chips `code -32007` and `reason ‹reason›`; `data.providerId` and `data.status` go in the row `title` and accessible name. Footer: `refused before any network call`. Composer target disabled: `refused -32007`. | `turn/start` error `-32007 ProviderDenied`, `data: {providerId, status, reason}` (M1 PIN line 153). The refusal is thrown inside `turn/start` before a turn exists (`server.ts:2210`, `:2216`, `#presenceRefusal` `:2373-2405`). For the seeded `surface-architect` seat (`roster.ts:87-109`, `preferredBacking: "ollama-cloud"`, `policy.headlessOk: false`), the lane is `allowed-direct` with `headless: "denied"` (`registry/src/catalog.ts:79-90`), so the reason is **`headless-not-permitted`** (`registry/src/assert.ts:58`). Interactive-only lanes give `interactive-only-headless` (`assert.ts:45`). Render whichever reason the engine returns, verbatim. |
| **Read-only (loaded by another client)** | From the last `session/read`: `○ COMPLETED`, `○ RUNNING`, `✗ INTERRUPTED`, `✗ FAILED`, or `○ IDLE` | Banner: **"Read-only."** `Loaded by another client (pid ‹lockHolderPid›). No streaming, no interrupt from this window.` Row `thread/resume` `✗ FAILED`, chips `code -32004` and `lockHolderPid ‹pid›` (only when present). Interrupt disabled: `read-only · another client holds the lock`. Composer target disabled: `read-only`. | `thread/resume` error `-32004 TurnAlreadyActive`, `data: {threadId, activeTurnId, lockHolderPid?}` (M1 PIN line 150; M0 Amendment 1 (d), M1 PIN line 99). Receipts come from `session/read` (allowlisted; `launcher.rs:35-40`) and `room/inspect`. |
| **Disconnected** | `○ DISCONNECTED` on every pane | Every receipt row resets to its `—` / `○ NO RECEIPT` form (cached reads are discarded, as A3 pin §4.3 does on a new `room/inspect`). Composer disabled: `not connected`. Footer action `Reopen pane` (sends `thread/resume` once on click; never automatic, AM1 §5 "no automatic retry"). | A3 pin §6.1 / §6.4 connection state (`DISCONNECTED`, or R4 on the next RPC, A3 pin §6.5). When the connection ends, the engine releases this connection's locks (`socket.ts:352-357`). |

### 6.4 Receipt rows (exact mapping)

| Row key | Pill | Chips | Source (file:line) | Rule |
|---|---|---|---|---|
| `servedModel` | `✓ VERIFIED` / `▲ UNVERIFIED` / `○ NO RECEIPT` | `servedModel ‹value›`, `vendorReported ‹bool›`; plus `fallbackFrom ‹id›` when non-null | JSONL event `type: "servedModel"`, `payload` = `ServedModelPayload` (`session-store.ts:94-108`) from `session/read`, choosing the **last** `servedModel` event whose `payload.turnId` is the latest turn. Live: `item/completed` with `item.kind === "servedModel"` (`ServedModelItem`, `protocol/types.ts:129-142`; M1 PIN line 113; `server.ts:2579-2588`). | **From `session/read`:** receipt `{kind:"servedModel", servedModel, vendorReported}`. `vendorReported === true` → `verified` (`shell.js:175-180`). `vendorReported === false` → hint `"warn"` → `▲ UNVERIFIED` (Mike ruling 3). **Streamed only** (before the post-turn read): hint `"warn"` → `▲ UNVERIFIED`, note `streamed · confirmed by session/read after turn/completed`, whatever `vendorReported` says (Mike FDR ruling). **None:** `○ NO RECEIPT`, chip `servedModel —`. |
| `lane` | none; field note `field · not a receipt` | `lane ‹value›` or `lane —` | `ServedModelPayload.lane` (`session-store.ts:101`), one of `allowed-direct`, `allowed-via-vendor-agent`, `interactive-only`, `forbidden` (`session-v2.ts:187-192`), taken from the same event as the `servedModel` row | Never toned (Mike ruling 4). |
| `worktree.topLevel` | none; field note | `topLevel ‹path›` or `topLevel —` | `RoomThreadRow.worktree.open.topLevel` (`inspect.ts:147-151`; `WorktreeIdentity`, `session-v2.ts:23-30`); also `session.open` `payload.worktree` from `session/read`. `open: null` → `—`. | Never toned. The path value truncates at the **start** (`direction: rtl` on the value, `<bdi>` inside) so `…/worktrees/th_xxxx` stays visible. Full path in `title`. |
| `head@open` | `✓ VERIFIED` / `○ NO RECEIPT` | `sha ‹first 12 hex›` (full 40 in `title` and accessible name) or `sha —` | `RoomThreadRow.worktree.open.head` (`inspect.ts:147-151`); `WorktreeIdentity.head` is "40 lowercase hex; null only for an unborn branch" (`session-v2.ts:28-29`). | Receipt `{kind:"sha", sha: head}`. Verified iff `/^[0-9a-f]{40}$/` (`shell.js:15`, `:173-174`). **No `chainOk` requirement** (Mike ruling 5). The label is always `head@open`, never "head" or "current" (Mike FDR). When `worktree.missing === true` (`inspect.ts:150`), add the note `worktree missing on disk`; the pill stays bound to the recorded SHA. |
| `hash` | `✓ VERIFIED` / `○ NO RECEIPT` / `✗ FAILED` | `hash ‹12 hex›`, `chainOk true`, `events ‹n›` (verified); `hash —`, `events —` (neutral) | `session/read` result `{threadId, events, chainOk}` (M3 PIN lines 36–38; `ipc.ts:48-52`) | Exactly A3 pin §4.3 B, plus the `events` chip (`events.length`, tabular). Reset to `—` on `turn/started` for that thread. A rejection or `chainOk !== true` → `✗ FAILED` per A3 pin §4.3 B. |
| method-error rows | `✗ FAILED` | `code ‹n›` + each `data` key verbatim (`reason`, `lockHolderPid`, `activeTurnId`, `threadId`, `turnId`) | RPC error body (M1 PIN §4) | Never retried automatically. Cleared only by the next successful call of the same method on that pane. |

### 6.5 Receipt chips and the D-693 fix (A3 pin D9 (a), (b)): recommended

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

The alternative, hiding `seat` below 1200px (A3 pin D9's proposal), is §15's open question.

### 6.6 Receipts well (Table view)

This is A3 pin §5.4, plus one row kind: each engine **method refusal** returned in this session (`turn/start`, `thread/start`, `thread/resume`, `turn/interrupt`) is appended as a row labelled with the method, pill `✗ FAILED`, chips `code`, the verbatim `data` keys, and `seat ‹seatId›`. The same refusal also shows on its pane (§6.3). Rows are only what the engine returned. Nothing is fabricated.

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
| `starting thread` | `thread/start` / `thread/resume` is in flight. |
| `read-only` | `thread/resume` returned `-32004` (§6.3). |
| `refused -32007` | `turn/start` on this pane returned `-32007` in this connection. The full `reason` is in `title`. |
| `no thread loaded` | `thread/start` failed. |
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
| `Cmd+1`–`Cmd+4` / `Ctrl+1`–`Ctrl+4` | anywhere, palette closed | Switch to the Panes view if needed, then focus the visible pane at that position. No-op if the slot is empty. |
| `Tab` / `Shift+Tab` | unchanged | Standard focus order: focus bar → toggle → hidden strip → panes (header, rows, footer button) → composer. |
| `Esc` | unchanged | Closes the palette (A3). Also closes the quit dialog as **Keep running** (§10). Never interrupts anything. |
| `←` / `→` | toggle, focus bar | Unchanged roving behaviour. |
| `Space` | composer target chip | Toggle target. |

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
| Panes | **New pane on seat ‹seatId›** (`cmd-pane-new:‹seatId›`), one row per `seat/list` entry | `CONNECTED` and `SeatSummary.ok === true`; else disabled with metadata `seat load failed ‹code›` | `thread/start {seatId}` → starting-thread pane | — |
| Panes | **Open selected thread in pane** (`cmd-pane-open-thread`) | Table view, a selected row whose thread has no pane, `CONNECTED` | `thread/resume {threadId}` → starting-thread pane | — |
| Panes | **Show pane ‹seat›** (`cmd-pane-show:‹paneId›`), one per hidden pane | always | §5.5 | — |
| Panes | **Hide pane ‹seat›** (`cmd-pane-hide`) | the focused pane is visible and more than one pane exists | moves it to hidden; nothing is unloaded | — |
| Panes | **Dismiss pane ‹seat›** (`cmd-pane-dismiss`) | the focused pane has no loaded thread (start failed) | removes that pane | — |
| Turn | **Start turn** (`cmd-turn-start`) | §7.3 | §7.3 | `⌘↵` / `Ctrl ↵` |
| Turn | **Interrupt turn on ‹seat›** (`cmd-turn-interrupt:‹paneId›`), one per own-connection pane with an `inProgress` turn | §7.4 | §7.4 | **none** |
| Turn | **Toggle target ‹seat›** (`cmd-target-toggle:‹paneId›`) | the target is enabled | §7.2 | — |

- **Dynamic rows** (`‹seatId›`, `‹paneId›`) are the only generated entries. Their id prefixes are closed.
- Filter, keys and ARIA are A3 §7 unchanged. Disabled rows show the reason as metadata (e.g. `turn active`, `read-only`, `not connected`).
- D7 stands: there is still **no** "Read thread" command. The only automatic `session/read` is §9's.

---

## 9. Live updates

- **Subscription:** unchanged. The desktop already initializes with `capabilities.subscribeRoom: true` (`launcher.rs:438`). The engine broadcasts `room/updated {reason, threadId}`, with `reason` one of `"thread" | "turn" | "handoff" | "decision"` (M3 PIN line 43; `socket.ts:338-343`).
  - It fires on a turn start (`server.ts:2318`) and on every turn end, including an interrupt at shutdown (`server.ts:2853`).
  - It fires on thread open and close (`server.ts:1392`, `:558`, `:1842`, `:1858`, `:1885`).
  - **[ASSUMPTION: unpinned]** At `870c1f7e` the launcher drops every notification while waiting for a response (`launcher.rs:545-547`). M3-A4 needs a forwarding path to the WebView (§14.2).
- **Own-connection panes** use their connection's notifications:
  - `turn/started` → `○ RUNNING`;
  - `item/completed` → the streamed `servedModel` (stays `▲ UNVERIFIED`);
  - `turn/completed` → the turn pill from `turn.status`.

  **Then exactly one automatic `session/read {threadId}`** confirms `turn.end`, `servedModel`, `lane`, `hash` and `events` (Mike FDR ruling). Deltas (`item/agentMessage/delta`) are not rendered; this is not a transcript view.
- **Read-only panes** (no notifications from the owning connection) use `room/updated`:
  - **Last read showed an open turn** (a `turn.start` with no matching `turn.end`): the next `room/updated {reason: "turn"}` for that `threadId` is its completion, because the engine allows one active turn per thread (M1 PIN line 95). It triggers **exactly one** `session/read`.
  - **Last read showed no open turn:** the event is a start. The pane shows `○ RUNNING` with footer `turn started elsewhere · read after completion`, and does not read.
- **Hidden panes** never read automatically. If a turn completed while hidden, the one read happens when the pane is shown, and it counts as that turn's read.
- **Room table (Table view):** `room/updated` never triggers `room/inspect`. The section head shows the neutral note `room changed · Inspect room to refresh` (mono 11 muted) until the next `Inspect room`. That keeps A3 pin §6.5: no polling.
- **Never:** a poll loop, bulk reads, a read on `reason: "thread"`, `"handoff"` or `"decision"`, or more than one read per completed turn. In-flight dedupe and stale-result dropping are A3 pin §4.3 B.

---

## 10. Quit flow

- **Engine fact:** closing the desktop's socket ends its `EngineConnection`. `run()` finishes and `releaseLocks()` runs (`socket.ts:345-358`), and `shutdown()` ends every in-flight turn on that connection as `interrupted` before releasing locks (`server.ts:531-541`). A desktop-spawned `serve` is also stopped by `disconnect_engine` (`main.rs:86`; A3 pin §6.4 R4). Quitting therefore interrupts every running turn on the desktop's connection, including turns in hidden panes. Read-only panes' turns belong to other clients and are unaffected.
- **[ASSUMPTION: unpinned]** Intercepting the window close needs a Tauri close-request hook. `main.rs:109-120` registers none at `870c1f7e` (§14.6).
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
- **Status changes** (`RUNNING`, `COMPLETED`, `INTERRUPTED`, `FAILED`, refusals) are announced once through one polite live region per window, as `‹seat›: turn ‹word›` or `‹seat›: turn/start refused -32007 ‹reason›`.
- `forced-colors`, `prefers-reduced-motion` and `prefers-reduced-transparency`: A3 §3.4 and D8 unchanged. They cover the new pills, panes and the quit dialog.
- **Safari < 18:** the opaque fallback under the verbatim `@supports not (backdrop-filter: blur(1px))` block is unchanged (A3 pin D9, D-694). It now covers the quit dialog too. No new frame is needed.

---

## 12. Integration contract and acceptance checklist

### 12.1 Files (no build step; plain JS UI per A3 pin D5)

- `packages/desktop/ui/styles.css`:
  - pane, composer, toggle, hidden-strip and dialog rules;
  - the D-693 rules (§6.5);
  - extended tokens use only. No new hex.
- `packages/desktop/ui/shell.js` / `shell.d.ts`:
  - pure helpers `paneStateFromSession(events)`, `receiptRowsForPane(...)`, `composerTargets(...)`, `paneColumns(width)`;
  - quit-list builder;
  - the amended `ALLOWED_PILL_LABELS` and `PALETTE_COMMANDS`.
- `packages/desktop/ui/index.html`: Panes view container, composer, dialog template.
- `packages/desktop/ui/app.js`: key wiring for §8.1.
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
9. `-32004` on `thread/resume` renders the read-only banner, a `✗ FAILED` `thread/resume` row with `lockHolderPid` when present, a disabled Interrupt and a disabled target with reason `read-only`.

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
15. No running own-connection turns → no dialog. Running → dialog lists exactly those turns, hidden panes included and read-only panes excluded. Default focus is Keep running; `Esc` keeps running. Confirming sends zero `turn/interrupt` and calls `disconnect_engine` once.

**Keys and palette**
16. No `keydown` handler reacts to `f` with Ctrl or Meta. `Cmd/Ctrl+1–4` only focus. `Cmd/Ctrl+Enter` only starts from the composer input.
17. Palette ids are exactly A3's nine plus §8.2's. No id outside that set. No "Read thread" command.

**Carried over**
18. No-decorative-green guard (A3 pin §9) still passes over the new rules.
19. No external URLs (A3 pin §3.3).

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

**Engine facts designed in (from Surface Architect):**
- a real starting-thread state;
- read-only panes for threads another client holds;
- honest presence refusals;
- no close for hidden panes;
- quit interrupts running turns and must say so.

These are in §5.5, §6.3 and §10.

---

## 14. Open items for the pin (Surface Architect; not visual)

1. **`launcher.rs` allowlist additions.** `ALLOWED_RPC_METHODS` (`launcher.rs:35-40`) is `initialize`, `room/inspect`, `session/search`, `session/read`. M3-A4 needs:
   - `thread/start` and `thread/resume` (to load a pane);
   - `turn/start` and `turn/interrupt`;
   - `seat/list` (for `New pane on seat ‹seatId›`).

   `thread/list`, `provider/list`, `auth/*`, `decision/*` and `thread/handoff` stay out. The A3 pin §7 bar on editing `launcher.rs` / `main.rs` needs lifting for M3-A4.
2. **Notification forwarding.** The launcher skips any line whose `id` does not match the pending request (`launcher.rs:545-547`), so `room/updated`, `thread/started`, `turn/started`, `turn/completed` and `item/*` never reach the UI. The pin must define a forwarding channel (e.g. a Tauri event per JSON-RPC notification) and say which notifications are forwarded. This spec needs `room/updated`, `thread/started`, `turn/started`, `turn/completed` and `item/completed`; it does not need `item/agentMessage/delta`.
3. **Per-turn `session/read` vs A3 Q4/D7.** A3 pin Q4/D7 allows `session/read` only on explicit row selection, "never automatically on connect". §9 adds exactly one automatic read per completed turn on a visible pane, plus one when a hidden pane with a completed turn is shown. The pin must record this as a narrow extension of Q4/D7, not a poll, and keep D7's "no Read command".
4. **Thread lock from `thread/resume`/`thread/start`.** A load takes `sessions/<threadId>.lock` and holds it until the connection ends (M1 PIN line 99). So:
   - (a) the desktop locks out the CLI for every pane, visible or hidden;
   - (b) a thread another client holds returns `-32004` with `lockHolderPid`. That is the read-only state in §6.3.
   - (c) Another connection inside the same `serve` process may report the serve's own pid. The pin should state whether that case is distinguishable.
   - (d) There is no unload method, which is why §5.5 has no close.
5. **`seat/list` projection.** `SeatSummary` at `870c1f7e` is the locked union in `protocol/types.ts:294-321` (`ok: true` with `id`, `version`, `displayName`, `role`, `pinnedModel`, `preferredBacking`, `fallbacks`, `memory`, `tools`, `policy.headlessOk`, `warnings`; or `ok: false` with `code`, `issues`). The M1 PIN line 128 still calls the projection "locked by act M1-A7". The pin should confirm this union for the desktop, and whether the UI may pre-label `policy.headlessOk: false`. This spec does **not** pre-label: it shows only the engine's refusal (§6.3).
6. **Quit hook.** A Tauri window close-request handler in `main.rs` (none at `:109-120`) that asks the WebView for the running-turn list before closing.
7. **Desktop presence.** The spec assumes a desktop-spawned `serve` has no controlling terminal, so presence-gated lanes are refused with `-32007` (`server.ts:2210`). If `serve` inherits a terminal (desktop launched from a shell), the engine's keypress prompt (`server.ts:2216`) would appear in that terminal while `turn/start` is pending. The pin should state whether the desktop must spawn `serve` detached from any controlling terminal.

---

## 15. Open question for Mike

| # | Question | Recommendation | Alternative |
|---|---|---|---|
| **D-693 seat visibility** | Below 1200px, how does the Room table fit `seat` alongside wrapped receipt chips? | **Keep the seat visible**: below 1200px, fold the seat into the thread cell as a second line (`THREAD · SEAT`: thread id over seat name), with tracks `140px minmax(96px, 0.62fr) 48px minmax(168px, 1.9fr)`, and let receipt chips wrap at every width (§6.5). Surface Architect prefers this because the product is seat-centric. | Hide the `seat` column below 1200px (A3 pin D9's proposal) and wrap chips. That's simpler CSS, but the Room table at 960–1199 loses the seat. |

Not open (decided here unless the pin overrules): the closed pill list in §6.1, the no-close rule for panes, no red quit button, no scrim, no animation, and that turn pills are never green.
