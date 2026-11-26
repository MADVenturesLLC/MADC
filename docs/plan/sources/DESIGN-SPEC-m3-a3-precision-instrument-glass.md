# MADC M3-A3 design spec: Precision Instrument Glass

**Status:** Approved by Michael Daley on 2026-11-26 (with recommended rulings on Q1, Q2, Q3, and Q6 accepted) for Surface Architect to pin for M3-A3 implementation. **Not a pin yet** until Surface Architect merges the M3-A3 pin; that pin closes **D-618** (PIN-madc-M3-desktop-protocol §4 cites no Iris design spec) and fulfils **D-189** (carry MADC's terminal visual language into the desktop app). Where a merged pin differs from this text, the pin wins until a pin change merges (same precedence rule as the M0 Omarchy spec).

**Direction:** Michael chose Direction C, "Precision Instrument Glass", on 2026-11-25.

**Base:** `MADVenturesLLC/MADC` `main` @ `9333fe9812a1d983aa92f2e4e89794bf9ef9d231` (PR #76, M3-A2 merged).

## 0. Source of truth

| What | Path | sha256 |
|---|---|---|
| Visual source of truth (frame) | `/workspace/iris-madc-m3a3/direction-c.png` (2880×1800, 1440×900 @2x) | `56260fa81215747062b5d4776f376108f852e0b389818d09a611d77ad5619e29` |
| Reference CSS, Direction C | `/workspace/iris-madc-m3a3/src/c.css` | `a05c4683bec254a4702d8d33e1ff798e0aa0c76f3c9ac201f55d2b080a7ed56c` |
| Reference CSS, shared layout | `/workspace/iris-madc-m3a3/src/base.css` | `90a20150bc4565ee01af513254def9f3163404e3ae4f51dcc11f136792836e00` |
| Reference markup (mock data) | `/workspace/iris-madc-m3a3/src/body.html` | `4f849a2497a355d82d5f8ff75e2d458451b34088decfb85cc264131f0e746371` |

The frame and reference CSS are box-only. They are not in the repo. The reference CSS is a mock-up, not shipping code. The builder re-implements it against the tokens in §3.

**Text wins over the frame on these five points. Everywhere else, the frame wins.**
1. Monospace face is JetBrains Mono. The frame used IBM Plex Mono.
2. The pill border is 1px. The frame drew 1.5px.
3. The palette filter prompt is `>`. The frame drew `❯`.
4. The palette shortcut is `Cmd+K` / `Ctrl+K`. The frame's hint reads `Ctrl K`.
5. The frame's "repo head" and "engine.lock" receipt rows are mock data, not required screens (§6.6).

**Repo files read at `9333fe98`:**

| File | sha256 |
|---|---|
| `docs/plan/sources/DESIGN-SPEC-omarchy-git-panel.md` (M0 SPEC) | `4756f4777646fbf5fe9deb65fe4ad8705347ec529f325f073c25a3f2b6234ad5` |
| `docs/plan/PIN-madc-M0-design-omarchy-git-panel.md` | `73346b12ea0dc4794a0a7102fe68bd875d516d97437b285f613f4da70f943b75` |
| `docs/plan/PLAN-madc-M3-build-plan.md` (PLAN) | `4c43b11f8787b70e80bb8546bda00c5693cd3edd4be325e6b99c41b671f3f9cc` |
| `docs/plan/PIN-madc-M3-desktop-protocol.md` (PIN) | `7af64d80196b21dbcf1acc60a4ef373523d36328a5cd0f6177fd018911fa79d8` |
| `docs/plan/PIN-madc-M3-desktop-protocol-amendment-1.md` (AM1, §4 note only) | `c7463d40f0ca4cecbb97c938c550eaf65a052c4cc9b6c6af34ab40543d98a860` |
| `docs/plan/ROADMAP-madc-post-M0.md` (line 92 only) | — |
| `packages/desktop/ui/index.html` | `51e13e5bba9c2d4fabf0c3a8c17ad6049146b540eb79324d6878a93771c1b5de` |
| `packages/desktop/ui/styles.css` | `3d8a0db26c0d7b3799baa23ecdd94d60caf26d979817b857ed32240e08cdf7bc` |
| `packages/desktop/ui/shell.js` | `78784ac9a834e86677f127c3ac395f74b5bc738679ac3381a931f76c987d304d` |
| `packages/desktop/ui/shell.d.ts` | `04d96a4da7f56f919bf16ea95ed838563083cb46fce416e1b41d906454cee23c` |
| `packages/desktop/ui/app.js` | `fc60f32cd5a440b57bf38673cd5069ee6d0912cef6d6415465d5c83a8a053f7e` |
| `packages/desktop/src/evidence.ts` | `875a24f40c06077924b801bf835e80470d5e2f1cac51728a9170d609eb3f945e` |
| `packages/desktop/src/focus-bar.ts` | `0c39b8f0aed142da3cd90846e23598e40d4a13d1a1c109eb3f6afc292e2a9e71` |
| `packages/desktop/src/ipc.ts` | `a0f3b5224ccc355756e2df8abaf4c5c40d6de10b6053854b24a2d19115efd0d3` |
| `packages/desktop/src/index.ts` | `346f9018d9142a74d94ef80d6b3f9001799f18fa75aa19085072aea274123c4e` |
| `packages/desktop/src/desktop.test.ts` | `f243de09c9f53c8ac5d15306b69ba0202b5035a2691542db10d5ceae5a940951` |
| `packages/desktop/src-tauri/tauri.conf.json` (window size, CSP) | — |
| `packages/engine/src/inspect.ts` (`RoomReport`, `RoomThreadRow` shapes) | — |

---

## 1. Scope, precedence and non-goals

**In scope (PLAN §2, row M3-A3):** dark-glass design tokens, typography, the keyboard command palette, and evidence-bound status pills with receipt chips. These are applied to the M3-A2 shell as it stands: focus bar, `#connection-status`, `#connect-btn`, `#output`, plus the Engine card and Room summary described in §5.

**Precedence:**
1. Merged pins: PIN §4, AM1, and the M0 design pin for palette and honesty rules.
2. This spec.
3. The frame.
4. The reference CSS.

The M0 SPEC §2 hard rules 6–9 carry over unchanged: honesty, failure never quieter than success, meaning never carried by colour alone, and no emoji, spinners or progress bars.

**Hard non-goals (PLAN §1; any of these is a spec violation):**
- Not an IDE or code editor. No file tree, no LSP, no terminal emulator, no editable code view.
- No agent loop, tools or credentials in the desktop shell. All authority stays in `@madc/engine`. The UI reads engine results; it never computes verification itself beyond `isVerifiedReceipt` shape checks.
- No decorative green. No green except on a verified receipt (§6.2).
- No M3-A4+ surfaces:
  - no seat panes or side-by-side workspace;
  - no turn start or interrupt;
  - no handoff graph;
  - no Founder Decision Inbox content;
  - no session search UI or replay inspector.
  The `Decisions` and `Search` focus-bar targets stay as focus targets only (§5.5).
- No M4/M5 scope.
- No emoji, spinners, progress bars, animated loaders, blinking, vendor logos or mascots, and no light theme or theme switch.

---

## 2. Design principles (binding)

1. **Evidence decides colour.** Only the tone from `evidenceTone()` picks green, yellow or red. No component chooses a status colour by itself.
2. **Fail is at least as loud as verified.** All four tones share identical pill geometry, weight and size. Red is never reduced in size, opacity or weight relative to green.
3. **Three channels, always.** Every status shows a glyph (distinct shape), a word, and a colour. Removing colour (forced-colors, greyscale) still leaves the state readable.
4. **Instrument, not dashboard.** The look has no gauges, charts, tiles or metrics grid. It uses structured rows, boxed key–value chips, and recessed wells.

---

## 3. Dark-glass design tokens

All tokens live once in `packages/desktop/ui/styles.css` under `:root`. No other file may hard-code a hex value. There are no new hues: every colour is one of the 11 Omarchy Tokyo Night hexes, optionally with alpha.

### 3.1 Colour tokens

| Token | Value | Role |
|---|---|---|
| `--madc-darker` | `#0e0e14` | (a) Desktop backdrop **behind** the window (Michael's 2026-10-04 decision), (b) title bar, (c) **recessed wells inside the window** (tables, receipts, `#output`), (d) glyph colour inside filled glyph blocks. **Direction C deliberately uses `#0e0e14` both as the window backdrop and for recessed wells inside the window.** See Q3. |
| `--madc-bg` | `#1a1b26` | Main window canvas. Active focus-bar tab fill. Keycap fill. |
| `--madc-lighter` | `#24283b` | Base of every elevated glass surface. Receipt-chip key segment. Status strip. Table header tint (35% alpha). |
| `--madc-fg` | `#a9b1d6` | Body text, labels, micro-labels, notes, seat names, palette rows. |
| `--madc-bright` | `#c0caf5` | Headings, thread IDs, chip values, active tab text, selected palette row, keycap text. |
| `--madc-muted` | `#565f89` | **Non-essential only:** title-bar meta, palette per-row metadata, `·` separators, empty-value dash `—`, neutral pill border. Never the only carrier of a state or value. |
| `--madc-border` | `#414868` | Hairlines, chip and well borders. Neutral glyph-block fill. Never carries meaning on its own. |
| `--madc-accent` | `#7aa2f7` | Focus ring, active-tab underline, palette selection bar, filter-match highlight, `protocol` value, `#connect-btn` border. Never a status. |
| `--madc-green` | `#9ece6a` | `verified` tone only. |
| `--madc-red` | `#f7768e` | `fail` tone only. |
| `--madc-yellow` | `#e0af68` | `warn` tone only. |

### 3.2 Glass, fill, border, radius and shadow tokens

| Token | Value |
|---|---|
| `--madc-glass-fill` | `rgb(36 40 59 / 0.80)` (lighter @ 80%; resolves to about `#222537` over bg) |
| `--madc-glass-fill-strong` | `rgb(36 40 59 / 0.86)` (palette panel) |
| `--madc-glass-blur` | `blur(14px)` (focus bar, status strip) |
| `--madc-glass-blur-strong` | `blur(18px) saturate(120%)` (command palette) |
| `--madc-glass-edge` | `inset 0 1px 0 rgb(192 202 245 / 0.14)` (luminous 1px top edge on elevated glass) |
| `--madc-well-fill` | `var(--madc-darker)` |
| `--madc-well-inset` | `inset 0 2px 6px rgb(0 0 0 / 0.55)` |
| `--madc-thead-fill` | `rgb(36 40 59 / 0.35)` |
| `--madc-row-rule` | `rgb(65 72 104 / 0.60)` (row separators inside wells) |
| `--madc-tone-fill-verified` | `rgb(158 206 106 / 0.10)` |
| `--madc-tone-fill-warn` | `rgb(224 175 104 / 0.10)` |
| `--madc-tone-fill-fail` | `rgb(247 118 142 / 0.10)` |
| `--madc-tone-fill-neutral` | `rgb(169 177 214 / 0.06)` |
| `--madc-select-fill` | `rgb(122 162 247 / 0.16)` |
| `--madc-select-edge` | `inset 3px 0 0 var(--madc-accent), inset 0 0 0 1px rgb(122 162 247 / 0.40)` |
| `--madc-border-w` | `1px` |
| `--madc-radius-sm` | `3px` (pills, chips, keycaps, palette rows) |
| `--madc-radius-md` | `4px` (wells, focus-bar group, buttons) |
| `--madc-radius-lg` | `6px` (palette); window corners are OS-drawn |
| `--madc-shadow-elevated` | `0 6px 16px rgb(0 0 0 / 0.35)` (focus bar) |
| `--madc-shadow-overlay` | `0 30px 80px rgb(0 0 0 / 0.65), 0 0 0 1px rgb(14 14 20 / 0.80)` (palette) |
| `--madc-focus-ring` | `2px solid var(--madc-accent)`, offset `2px` |

Radii are 2–4px everywhere except the palette (6px). Nothing is pill-shaped or fully rounded.

### 3.3 Contrast (WCAG 2.x, against the actual backgrounds)

| Foreground | on darker `#0e0e14` (wells) | on bg `#1a1b26` (canvas) | on lighter `#24283b` | on glass ≈`#222537` |
|---|---|---|---|---|
| fg `#a9b1d6` | 9.11 | 8.10 | 6.90 | 7.17 |
| bright `#c0caf5` | 11.92 | 10.59 | 9.02 | 9.37 |
| accent `#7aa2f7` | 7.64 | 6.79 | 5.78 | 6.01 |
| green `#9ece6a` | 10.53 | 9.35 | 7.97 | 8.28 |
| yellow `#e0af68` | 9.62 | 8.55 | 7.28 | 7.57 |
| red `#f7768e` | 7.27 | 6.46 | 5.51 | 5.72 |
| muted `#565f89` | 3.11 | 2.76 | 2.35 | 2.45 |
| border `#414868` | 2.15 | 1.91 | 1.63 | 1.69 |

| Pill element | Ratio |
|---|---|
| verified label on its tint over a well (`#1c211d`) | 8.94 |
| warn label on tint (`#231e1c`) | 8.24 |
| fail label on tint (`#251820`) | 6.45 |
| neutral label (fg) on tint (`#171820`) | 8.37 |
| darker glyph on green / yellow / red block | 10.53 / 9.62 / 7.27 |
| bright glyph on neutral (border) block | 5.53 |
| bright text on palette selection (`#303956`) | 7.05 |
| accent match highlight on selection | 4.52 |

**Rules:**
- All text tokens except `muted` pass AA (4.5:1) on every surface.
- `muted` fails AA, so it is restricted to the non-essential roles in §3.1.
- `border` is non-text chrome.
- Red has a lower luminance contrast than green by nature of the hues. Equal *weight* is enforced through identical geometry and a filled glyph block (§6.3), not through luminance.

### 3.4 Accessibility fallbacks

```css
@media (prefers-reduced-transparency: reduce) {
  /* every glass surface becomes opaque; no blur */
  :root { --madc-glass-fill: var(--madc-lighter); --madc-glass-fill-strong: var(--madc-lighter); }
  .glass { backdrop-filter: none; }
}
@supports not (backdrop-filter: blur(1px)) { .glass { background: var(--madc-lighter); } }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
@media (forced-colors: active) {
  .pill, .chip, .well, .palette, [role="toolbar"] { border: 1px solid CanvasText; forced-color-adjust: auto; }
  .pill .glyph { background: none; color: CanvasText; }  /* glyph shape + word carry meaning */
  :focus-visible { outline: 2px solid Highlight; }
}
```

- **Motion:** M3-A3 has no animation at all.
  - The palette opens and closes instantly; no fades, slides, or caret blink.
  - The text caret is the system caret.
  - `prefers-reduced-motion` is therefore a guard, not a behaviour change.
- **Forced colours:** the pill becomes a bordered box with glyph and word. `✓ VERIFIED` vs `✗ FAILED` remain distinguishable by shape and word.

---

## 4. Typography

### 4.1 Families (local only, see §8.4)

| Token | Stack | Used for |
|---|---|---|
| `--madc-font-ui` | `"IBM Plex Sans", system-ui, -apple-system, "Segoe UI", "Noto Sans", sans-serif` | Headings, uppercase micro-labels, focus-bar tabs, palette command names, notes, button text |
| `--madc-font-mono` | `"JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace` | Hashes, SHAs, `servedModel`, socket paths, thread IDs, event counts, seq/line numbers, receipt-chip keys and values, pill labels, keycaps, `#output`, palette filter input and metadata, status-strip values |
| `--madc-font-glyph` | `"JetBrains Mono", "DejaVu Sans Mono", monospace` | The four tone glyphs `✓ ○ ▲ ✗`. Text presentation, never followed by U+FE0F. |

### 4.2 Scale (px; desktop UI never scales with viewport width)

| Role | Family | Size / line height | Weight | Tracking | Case | Colour |
|---|---|---|---|---|---|---|
| Section heading (h1, e.g. "Room") | ui | 26 / 32 | 600 | −0.005em | Title | bright |
| Card/section micro-label (`ENGINE`, `RECEIPTS`, `ROOM/INSPECT`) | ui | 10.5 / 14 | 600 | 0.14em | UPPER | fg |
| Table header | ui | 10.5 / 14 | 600 | 0.12em | UPPER | fg |
| Focus-bar tab | ui | 11.5 / 32 (box) | 500 | 0.08em | UPPER | fg; active bright |
| Body / notes / seat | ui | 13 / 18 | 400 | 0 | as-is | fg |
| Thread ID, values | mono | 13 / 18 | 500 | 0 | as-is | bright |
| Counts line | mono | 12 / 16 | 400 | 0 | as-is | bright, `·` muted |
| **Pill label** | mono | 12 / 26 (box) | **600 for all four tones** | 0.06em | UPPER | tone colour |
| Receipt-chip key | mono | 11 / 24 (box) | 400 | 0 | **verbatim field name** (`chainOk`, `servedModel`; never upper-cased) | fg on lighter |
| Receipt-chip value | mono | 12 / 24 (box) | 500 | 0 | verbatim | bright |
| Keycap | mono | 11 / 20 (box) | 500 | 0 | as-is | bright |
| Palette filter input | mono | 15 / 50 (box) | 400 | 0 | as-is | bright |
| Palette row | ui | 13 / 34 (box) | 500 | 0 | as-is | fg; selected bright |
| Palette group label | ui | 10.5 / 14 | 600 | 0.14em | UPPER | fg |
| Palette metadata | mono | 11 | 400 | 0 | as-is | muted |
| `#output` | mono | 11.5 / 18.4 (1.6) | 400 | 0 | verbatim | fg; JSON keys accent, strings bright, braces muted |
| Status strip | mono 12 (values) / ui 12 (labels) | 12 / 34 (box) | 400 | 0 | as-is | values fg/bright, labels fg |

- **Numbers:** `font-variant-numeric: tabular-nums` on every element that shows numbers (counts, events, seq/line, ms, exit codes, pid, keycaps).
- **Weight rule:** weights are 400 / 500 / 600 only. No 700+ anywhere. All four pill tones use the same weight (600). A tone may never change weight, size, letter spacing or case.
- **Pinned and engine strings render verbatim**, sanitised per ERR1 E11 (C0 except TAB/LF, DEL and C1 become U+FFFD). They are never re-cased: `chain FAILED`, `madc-m1/1`, the `manualFix` text, and the serve stderr line.
- **Truncation (chrome only):**
  - Hashes show the first 12 hex characters in chips. The full value goes in `title` and in the accessible name.
  - SHAs show 12 characters in chips, with the full 40 in `title`.
  - Paths use `~` then a middle ellipsis.
  - Copy commands always copy the full value.

---

## 5. Layout, surface hierarchy and viewport

### 5.1 Surface tiers

| Tier | Fill | Edge | Elements |
|---|---|---|---|
| **0 Backdrop / recessed** | `--madc-darker` | 1px `--madc-border` + `--madc-well-inset` | Window backdrop, title bar (no inset), Room table well, Receipts well, `#output` well |
| **1 Canvas** | `--madc-bg` | — | `<main>` content area, Engine card (flat `bg` + 1px border, no inset, no glass) |
| **2 Elevated glass** (`.glass`) | `--madc-glass-fill` + `--madc-glass-blur` + `--madc-glass-edge` | 1px border | Focus bar (`--madc-shadow-elevated`), status strip, command palette (`-strong` fill/blur, `--madc-shadow-overlay`, border `--madc-muted`) |

Glass exists only on tier 2. Wells never use blur.

### 5.2 Spacing scale

The scale is 4px-based: `--madc-space-1..8` = 4, 8, 12, 16, 20, 24, 28, 32.

| Element | Spacing |
|---|---|
| Content padding | 22px top/bottom (`space-5` + 2), 28px sides (`space-7`) |
| Column gap | 24 |
| Vertical stack gap | 14 |
| Table rows | 60px high, 16px side padding, 12px column gap |
| Receipt rows | 52px high |
| Card padding | 16 × 18 |
| Pill | 26px high; 10px label padding |
| Chips | 24px high; 7px key padding, 8px value padding; 6–8px gap between chips |

### 5.3 Regions (top to bottom; frame order)

1. **Title bar** (38px, tier 0). This is the OS-drawn title "MADC Desktop" on Linux and macOS where the system draws it. If the app draws it, it is centred UPPER micro-label, with `~/.madc/engine.sock` meta right in muted. No logo.
2. **Focus bar** `#focus-bar` (52px, tier 2):
   - Left side: a segmented group of the four M3-A2 buttons, Engine / Room / Decisions / Search. The group has a 1px border and 4px radius, with 1px dividers between tabs.
   - The active tab has a `bg` fill, bright text, and `inset 0 -2px 0 accent`.
   - Right side: two keycap hints, `Tab ← →  move` and `⌘K` / `Ctrl K  commands`.
3. **Main** (`<main>`, tier 1), a two-column grid `minmax(0,1fr) 440px`:
   - **Left:**
     - Section head: micro-label `ROOM/INSPECT`, h1 "Room", and the counts line.
     - **Room table well:** columns evidence (148) · thread (100) · seat (108) · events (48) · receipt (1fr).
     - **Receipts well:** columns label (112) · pill (160, pill left-aligned) · chips · note.
   - **Right:**
     - **Engine card:** micro-label `ENGINE` plus the connection pill at right. Below it, a key/value list: `socket`, `protocol` (accent), `server`, `cold start`, `reused` (keys fg, values bright mono). Then the one-line note "Connection alone is not evidence."
     - **`#output` well:** header `OUTPUT` / `room/inspect · read-only`.
     - **`#connect-btn`:** a `lighter` fill, 1px accent border, UPPER label.
4. **Status strip** `#connection-status` (34px, tier 2).
   - Three slots:
     - left: `engine` + socket name;
     - centre: connection state word plus tone;
     - right: `cold start <n> ms` and `model <name>`.
   - Model slot rule from M0 SPEC §3.6: show the requested model labelled `requested` until a `servedModel` receipt verifies. Only then show the served name unlabelled.
   - Never key hints, git, thread IDs or progress.

### 5.4 Window size and scroll

| Window | Behaviour |
|---|---|
| ≥ 1200 × 800 | Default Tauri size (`tauri.conf.json`). Full two-column layout as in the frame. |
| 960–1199 wide | Right column shrinks to `minmax(360px, 440px)`. Receipt notes ellipsize (`text-overflow: ellipsis`); chips never wrap or clip. |
| **960 × 640** | **Minimum usable size.** Set `minWidth: 960, minHeight: 640` in `tauri.conf.json` (see Q5). |
| 800–959 wide (if the OS allows smaller, or before the min is pinned) | Single column: the right column stacks below the left. Room table drops the `seat` column into a second line under thread ID. No horizontal scroll, no clipped pill or chip. |
| < 640 high | Content area scrolls vertically. Focus bar and status strip stay fixed. |

- Only `<main>` scrolls (vertical only).
- `#output` scrolls on its own: vertical, plus horizontal for long JSON, `white-space: pre`. It is the only element allowed a horizontal scrollbar.
- The palette never scrolls the page. Its list scrolls internally, capped at 9 visible rows.
- Pills, chips and glyph blocks never shrink, wrap or ellipsize. Notes ellipsize first, then chip values truncate to the 12-hex rule, never below it.

### 5.5 Focus targets without M3-A3 content

`Decisions` and `Search` remain M3-A2 focus targets. Selecting them changes only the focus-bar state. M3-A3 adds no inbox, search box or result list (M3-A6/M3-A7). Main keeps showing the Engine/Room view. No placeholder art and no "coming soon" copy.

---

## 6. Evidence-bound primitives

### 6.1 Binding

- **Tone source:** the only source of tone is `evidenceTone(receipt, hint)` from `packages/desktop/ui/shell.js`, re-exported by `src/evidence.ts` as `EvidenceTone = "verified" | "neutral" | "warn" | "fail"`.
- **Rendering:** every pill and every tone-coloured element renders `data-tone="<EvidenceTone>"`. CSS colours **only** by `[data-tone]`. There is no `.green`, `.ok`, or `.success` class and no inline colour.
- **Order (unchanged from M3-A2):** `hint === "fail"` → `fail`; `hint === "warn"` → `warn`; `isVerifiedReceipt(receipt)` → `verified`; otherwise `neutral`. A caller can never pass a "verified" boolean.
- **`isVerifiedReceipt` (fail-closed, unchanged):**
  - `{kind:"hash"}` needs `chainOk === true` and `hash` matching `/^[0-9a-f]{64}$/`.
  - `{kind:"sha"}` needs `sha` matching `/^[0-9a-f]{40}$/`.
  - `{kind:"servedModel"}` needs `vendorReported === true` and `servedModel.trim().length > 0`.
  - Anything else is `false`.

### 6.2 PIN §4 invariant (hard)

Green `#9ece6a` and `✓` appear **only** when `evidenceTone()` returned `verified`, which means a verified `hash`, `sha` or `servedModel` receipt from `@madc/engine` backs that exact widget. Consequences:

- **`CONNECTED` renders `neutral`** (`○ CONNECTED`). A live socket, protocol match or cold-start time is not evidence. This matches `shell.js` `evidenceTone(null, "ok")` → `neutral`.
- **`room/inspect` `level: "pass"` or `chain.ok: true` without a receipt renders `neutral`** (`○ NO RECEIPT`). `RoomThreadRow` carries no hash. A thread row earns `verified` only after a `{kind:"hash", chainOk, hash}` receipt for that thread passes `isVerifiedReceipt` (see Q4 for whether M3-A3 fetches it).
- `room/inspect` `level: "warn"` → `hint "warn"`. `level: "fail"` or `chain.ok: false` → `hint "fail"`.
- The model name before a verified `servedModel` receipt is `neutral` and labelled `requested`.
- **Never green:**
  - the focus ring, selection, `#connect-btn` or palette;
  - counts such as "1 pass";
  - a tool or command success;
  - a completed copy;
  - window chrome.
- Accent blue is never used as a stand-in for success.
- Tests must assert that no element without `data-tone="verified"` computes `color`, `background-color` or `border-color` containing `158, 206, 106` (§8.5).

### 6.3 Status pill: identical geometry for all four tones

```html
<span class="pill" data-tone="fail" role="status" aria-label="chain failed, line 11: prev hash mismatch">
  <span class="pill-glyph" aria-hidden="true">✗</span><span class="pill-label">FAILED</span>
</span>
```

| Property | Value (same for every tone) |
|---|---|
| Height | 26px (`.pill--sm` 22px for the Engine-card header; also identical across tones) |
| Min width | 140px (`--sm`: auto, but equal for tones in the same slot) |
| Border | `1px solid <tone colour>`, radius 3px, `overflow: hidden` |
| Glyph block | Left, 26×26 (`--sm` 22×22), **solid fill**, glyph centred, glyph weight 600 |
| Label | 10px side padding, mono 12px / 600 / 0.06em / UPPER |
| Container fill | `--madc-tone-fill-<tone>` |

| Tone | Glyph | Glyph-block fill / glyph colour | Border & label colour | Allowed labels |
|---|---|---|---|---|
| `verified` | `✓` U+2713 | green / darker | green | `VERIFIED` only |
| `neutral` | `○` U+25CB | border `#414868` / bright | border `muted`, label fg | `NO RECEIPT`, `IDLE`, `CONNECTING`, `CONNECTED`, `DISCONNECTED` |
| `warn` | `▲` U+25B2 | yellow / darker | yellow | `UNVERIFIED`, `STOPPED` |
| `fail` | `✗` U+2717 | red / darker | red | `FAILED` |

- The filled glyph block makes `✗ FAILED` at least as loud as `✓ VERIFIED`.
- No tone may use a different size, weight, opacity, or a hollow block.
- The label vocabulary is closed. A new label needs a spec change.
- **ASCII fallback:** the desktop has no `MADC_ASCII` switch. If the font stack lacks a glyph, render `v`, `o`, `!`, `x` (M0 SPEC §7) in the same block. With vendored fonts (Q6) this never happens.
- **Accessible name:** "`<tone word>`, `<context>`", e.g. "verified, hash a1b2c3d4e5f6…". Live updates use `role="status"`, or `role="alert"` for `fail` only on transition.

### 6.4 Receipt chips (boxed key–value)

```html
<span class="chip"><span class="chip-k">hash</span><span class="chip-v" title="<64 hex>">a1b2c3d4e5f6</span></span>
```

- Height 24px, 1px `border`, radius 3px, `overflow: hidden`.
- Key segment: `lighter` fill, mono 11 fg, the **verbatim field name**.
- Value segment: transparent, mono 12 / 500 bright.
- Chips never carry tone colour. The pill beside them does. Exception: none.

| Chip key | Value | Shown with tone |
|---|---|---|
| `hash` | 12 hex (full in title) / `—` (muted) if absent | verified or neutral |
| `chainOk` | `true` / `false` verbatim | verified (`true`), fail (`false`) |
| `sha` | 12 of 40 hex | verified |
| `servedModel` | verbatim model string | verified |
| `torn tail` | `line <N>` + note `crash residue, not tamper` (CLI:131 wording) | warn |
| `chain` | `FAILED` + chip `line` `<N>` + note `<reason>` verbatim | fail |
| `serve exit` | `<code> <kind>` (§6.5) | per §6.5 |
| `protocol` | `expected madc-m1/1 · got <v>` | fail |
| `pid` | integer | fail (exit 20) |

Notes after chips are ui 13 fg, one line, ellipsize.

### 6.5 Engine connection and `classifyServeExit` states

Connect is **manual only**. Nothing auto-connects, auto-retries or respawns (AM1 §5). `#connect-btn` is the only trigger, along with its palette command.

| State | Pill | Status strip centre | `#connect-btn` | Detail |
|---|---|---|---|---|
| Idle (startup) | `○ IDLE` neutral | `idle · no receipt` | enabled: "Connect to @madc/engine" | — |
| Connecting | `○ CONNECTING` neutral | `connecting over engine.sock…` (static text; no spinner) | disabled | — |
| Connected | `○ CONNECTED` neutral | `connected · neutral` | hidden; palette offers Disconnect | Engine card kv list from `DesktopConnectionInfo` |
| Disconnected by user | `○ DISCONNECTED` neutral | `disconnected` | enabled | — |
| Protocol mismatch (`connect()` throws) | `✗ FAILED` | `engine connection failed` | enabled (manual retry only) | chip `protocol` |
| Connect/IPC error | `✗ FAILED` | `engine connection failed (no automatic retry)` (verbatim from `shell.js`) | enabled | error text in `#output` |

`serve` exit, from `classifyServeExit()` (AM1 §6):

| `kind` (code) | Pill | Chip | Detail line |
|---|---|---|---|
| `clean` (0 / 130 / 143) | `○ DISCONNECTED` neutral | `serve exit` `0` / `130` / `143` | — (a clean stop is not a failure, and not success) |
| `stopped` (signal, or Windows launcher kill) | `▲ STOPPED` warn | `serve exit` `signal <SIG>` (or `1 launcher kill`) | — |
| `usage-or-home` (2) | `✗ FAILED` | `serve exit` `2 usage-or-home` | — |
| `owned` (20) | `✗ FAILED` | `serve exit` `20 owned` + `pid` `<pid>` | `parseLockOwnerGuidance().manualFix` verbatim, e.g. "(i) Run \`ps -p 4182 -o command=\` …; (ii) if none is running, manually remove \<lockPath\>." There is **no button or command that deletes `engine.lock`**, and the UI never deletes it. If guidance is `null`, show `home owned by another process` only. |
| `unsafe-path` (21) | `✗ FAILED` | `serve exit` `21 unsafe-path` | — |
| `listen-error` (22) | `✗ FAILED` | `serve exit` `22 listen-error` | — |
| `shutdown-deadline` (23) | `✗ FAILED` | `serve exit` `23 shutdown-deadline` | — |
| `internal-fault` (24) | `✗ FAILED` | `serve exit` `24 internal-fault`; if `rawCode !== 24`, add chip `raw` `<rawCode>` (or `null`) | — |

- Every `fail` row uses the full 26px pill in the Receipts/Engine area and turns the status-strip centre red with its word. It is never only a red text line.
- A clean exit is the only exit that is not `fail` or `warn`.

### 6.6 Where pills appear in M3-A3

| Place | Content |
|---|---|
| Engine card header | Connection state (§6.5) |
| Room table well | One row per `RoomThreadRow`, tone per §6.2 |
| Receipts well | Only receipts the engine actually returned in this session (`servedModel`, `sha`, serve exit). Empty → no rows (no fake rows). |
| Status strip centre | State word plus tone colour. It carries the same word as the Engine pill (no glyph block; strip text uses tone colour and the word). |

The frame's "repo head / sha" and "engine.lock" rows illustrate chip shapes and are **not** required screens.

---

## 7. Keyboard command palette

### 7.1 Open, close and focus

| Key | Action |
|---|---|
| `Cmd+K` (macOS) / `Ctrl+K` (Linux, Windows) | Open from anywhere in the window. If already open, it closes. |
| `Esc` | Close. **Restore focus to the element focused before opening.** |
| `Enter` | Run the selected command, then close. The command decides where focus goes; otherwise the prior focus is restored. |
| `↑` / `↓` | Move the selection, skipping group labels and disabled rows. It wraps around. |
| `Home` / `End` (in the list) | First / last enabled row |
| `Tab` / `Shift+Tab` | Kept **inside** the palette (focus trap). The input is the only tab stop; `Tab` does nothing visible. |

- All M3-A2 focus-bar keys are unchanged while the palette is closed: `Tab`, `Shift+Tab`, `←` / `→`, `Home`, `End` (`stepFocusBar`).
- No other global shortcut is added in M3-A3.

### 7.2 Anatomy (frame, right column)

- **Panel:**
  - Anchored to the top of `<main>`, 96px below the focus bar, right-aligned to the right column (8px from the window edge).
  - Width 476px (min 360, max `calc(100vw − 48px)`).
  - Tier-2 glass strong: fill `--madc-glass-fill-strong`, `--madc-glass-blur-strong`, 1px `muted` border, radius 6, `--madc-glass-edge` and `--madc-shadow-overlay`.
  - There is no full-window scrim; the content behind stays visible through the blur.
- **Filter row (50px):**
  - `darker` @45% fill, bottom 1px border.
  - Prompt `>` in accent mono 15, then the input (mono 15 bright, system caret, no placeholder text beyond `Type a command`), then an `Esc` keycap on the right.
- **List** (8px inset):
  - Group labels `ENGINE`, `FOCUS`, `EVIDENCE` (§4.2).
  - Rows are 34px: command name (ui 13/500), right-aligned metadata (mono 11 muted), and a keycap column 64px right-aligned.
  - Matched filter characters show in accent (no bold).
- **Selected row:** `--madc-select-fill` plus `--madc-select-edge` (3px accent left bar), text bright. Never green.
- **Disabled row:** fg at 50% opacity, `aria-disabled="true"`, skipped by arrows, with metadata explaining why (e.g. `not connected`).
- **Footer (36px):** `darker` @35%, top 1px border. Legend: `↑` `↓` move · `Enter` run · `Esc` close.
- **Empty state:** a single non-selectable row, `No matching command`, ui 13 fg. The footer stays. `Enter` does nothing.
- **Filter:** case-insensitive subsequence match on the command name. Groups with no matches are hidden. Order within groups is fixed (not re-ranked).

### 7.3 Commands (closed list; M3-A2/M3-A3 only)

| Group | Command | Metadata | Keycap hint | Enabled when | Action |
|---|---|---|---|---|---|
| Engine | Connect to @madc/engine | `manual · no retry` | — | not connected / connecting | same as `#connect-btn` |
| Engine | Inspect room | `room/inspect` | — | connected | `roomInspect()` → `#output` and Room table |
| Engine | Disconnect | — | — | connected | `DesktopEngineClient.disconnect()` |
| Focus | Focus Engine | — | `Home` | always | `focusBarSelect("connection")` |
| Focus | Focus Room | — | — | always | `focusBarSelect("room")` |
| Focus | Focus Decisions | — | — | always | `focusBarSelect("decisions")` (focus only, §5.5) |
| Focus | Focus Search | — | `End` | always | `focusBarSelect("search")` (focus only) |
| Evidence | Copy chain head | 12-hex preview | — | a `hash` value is displayed for the selected or most recent thread | copies the full 64 hex |
| Evidence | Copy served model | model preview | — | a `servedModel` receipt is present | copies the string |

- **No M3-A4+ commands:** no start or interrupt turn, no seat, handoff, decision resolve, session search, or replay.
- Copy uses `navigator.clipboard.writeText`. If that is unavailable, the row is disabled with metadata `clipboard unavailable`.
- A successful copy shows no toast and no green. The status strip is untouched.
- The frame showed the `Tab` hint on "Focus Room". It is omitted here because `Tab` steps focus rather than jumping to Room.

### 7.4 ARIA

```html
<div id="palette" class="palette glass" role="dialog" aria-modal="true" aria-label="Command palette" hidden>
  <div class="pal-filter">
    <span class="pal-prompt" aria-hidden="true">&gt;</span>
    <input id="palette-input" role="combobox" aria-expanded="true" aria-controls="palette-list"
           aria-autocomplete="list" aria-activedescendant="cmd-inspect-room" autocomplete="off" spellcheck="false">
    <kbd>Esc</kbd>
  </div>
  <ul id="palette-list" role="listbox" aria-label="Commands">
    <li role="presentation" class="pal-group" id="grp-engine">Engine</li>
    <li role="option" id="cmd-inspect-room" aria-selected="true" aria-describedby="grp-engine">Inspect room …</li>
  </ul>
  <div class="pal-foot" aria-hidden="true">…</div>
</div>
```

- DOM focus stays on the input. Selection moves via `aria-activedescendant`.
- Background content gets `inert` while the palette is open.
- The empty state is announced via a polite live region: "No matching command".

---

## 8. M3-A2 scaffold integration contract

### 8.1 Files

| File | Change |
|---|---|
| `ui/styles.css` | **Replace the whole placeholder:** `#141417`, `#d8dae0`, `#2c2e36`, `#1d1f26`, `#353844`, `#8fa3bf`, `#b4b8c4`, `#e06c75`, and the global monospace `:root` font. It becomes the token block (§3), `@font-face` (§8.4), surfaces (§5), pill, chip and palette components, and media queries (§3.4). Keep the header comment that cites PIN §4. `.status-neutral` / `.status-fail` are removed in favour of `[data-tone]`. |
| `ui/index.html` | Keep `#focus-bar` (`role="toolbar"`, the same four `data-focus-id` buttons and labels), `#connection-status`, `#connect-btn`, and `#output`; their IDs are tested. Add `class="glass"` to `#focus-bar` and `#connection-status`. Add `data-tone` to `#connection-status`. Add the Engine card, Room table well, Receipts well and palette markup (§7.4). No external `<link>`, `<script>` or `<style>` (CSP `default-src 'self'; style-src 'self'`). |
| `ui/shell.js` | **`isVerifiedReceipt`, `evidenceTone` and the focus-bar functions do not change behaviour.** The binder sets `statusEl.dataset.tone = tone` instead of `className = "status-" + tone`, and renders pills via one `renderPill(tone, label, context)` helper. Add palette state helpers (`createPaletteState`, `filterCommands`, `stepPalette`) as pure, testable functions beside the focus-bar ones. No `setTimeout` retry, no auto-connect. |
| `ui/shell.d.ts` | Add typings for the new pure helpers (`renderPill` input type, `PaletteCommand`, `PaletteState`). |
| `ui/app.js` | Unchanged except wiring the `Cmd/Ctrl+K` keydown listener on `document`. |
| `src/evidence.ts` | Types unchanged. Optionally add `export type PillLabel` (the closed vocabulary in §6.3). |
| `src/focus-bar.ts` | Unchanged. Its header comment ("without introducing M3-A3 design tokens, command palette…") may be updated to point at this spec. |
| `src/ipc.ts` | Unchanged. The UI consumes `DesktopConnectionInfo`, `classifyServeExit`, `parseLockOwnerGuidance` and `RoomReport` as they are. |
| `src-tauri/tauri.conf.json` | Add `minWidth: 960, minHeight: 640` to the window (Q5). CSP unchanged. |

### 8.2 Required classes and attributes

- `data-tone="verified|neutral|warn|fail"` on every tone-bearing element: `.pill`, `#connection-status`, and Room/Receipt rows (`.row[data-tone]` for the accessible summary only; rows are not tinted).
- `.pill > .pill-glyph[aria-hidden] + .pill-label`; `.pill--sm`.
- `.chip > .chip-k + .chip-v[title]`.
- `.glass`: tier 2. `.well`: tier 0 recessed. `.card`: tier 1.
- `[aria-pressed="true"]` on the active focus-bar button (existing), styled per §5.3.
- `kbd` for every keycap: 20px high, `bg` fill, 1px border, 2px bottom border, radius 3, mono 11 bright.

### 8.3 Focus-visible

- Every interactive element (focus-bar buttons, `#connect-btn`, palette input, focusable rows in future) gets `outline: 2px solid var(--madc-accent); outline-offset: 2px` on `:focus-visible` only.
- The M3-A2 rule that draws the outline on `[aria-pressed="true"]` is replaced. Pressed state uses the underline (§5.3), and focus uses the ring, so the two never look alike.
- Never remove an outline without a replacement. The ring is never green, red or yellow.

### 8.4 Fonts: no network

- No Google Fonts, no CDN, no `@import url(http…)`. The CSP already blocks them, and the app must work fully offline.
- **Preferred:** vendor `IBMPlexSans-{Regular,Medium,SemiBold}.woff2` and `JetBrainsMono-{Regular,Medium,SemiBold}.woff2` (both SIL OFL 1.1) under `packages/desktop/ui/fonts/` with `@font-face { src: url("./fonts/…") format("woff2"); font-display: block; }`, and include the OFL license files.
- **If vendoring is not approved (Q6):** the system stacks in §4.1 are the fallback, and the layout must not depend on exact glyph metrics. All boxes have fixed heights, and widths use `min-width`.

### 8.5 Tests to add (`desktop.test.ts`; mock-only)

- `evidenceTone` matrix unchanged, plus: `CONNECTED` is rendered `neutral`, and a `room/inspect` row with `level:"pass"` and no receipt is rendered `neutral`.
- Pill geometry equality: the four tones produce the same class set except `data-tone`. A computed-style snapshot shows equal height, font-size, font-weight and padding.
- No-decorative-green guard: no element lacking `data-tone="verified"` resolves any colour property to `#9ece6a`.
- `classifyServeExit` → pill/label/chip mapping table (§6.5), including the `rawCode` chip and the `owned` guidance with no delete affordance.
- Palette: open/close keys, focus restore on `Esc`, arrow wrap skipping disabled rows, filter + empty state, closed command list (no command IDs outside §7.3).
- No external URLs in `ui/` (grep `http`).

---

## 9. Open questions / rulings needed

| # | Question | Recommended ruling | Who |
|---|---|---|---|
| **Q1 (Approved 2026-11-26)** | ROAD:92 says a desktop viewer would have "no status colors", and M0 SPEC §10 says the desktop gets "no toolbar". PLAN M3 (accepted) and PIN §4 allow evidence-bound green, yellow and red, and M3-A2 already ships `role="toolbar"`. Also M0 SPEC Q17. | PLAN M3 + PIN §4 supersede ROAD:92 for M3: colour allowed **only** via `evidenceTone`. The M3-A2 focus bar is the sanctioned exception to M0 §10 "no toolbar". Close M0 Q17 with this spec. | Michael, then Surface |
| **Q2 (Approved 2026-11-26)** | Palette shortcut `Cmd+K` (macOS) / `Ctrl+K` (Linux, Windows). M0 SPEC §8 says "no key is added" for the CLI. | Accept for desktop only. Tab and Esc keep their existing roles; Esc additionally closes the palette. | Michael |
| **Q3 (Approved 2026-11-26)** | Michael ruled `#0e0e14` sits *behind* the desktop window. Direction C also uses it for the title bar and recessed wells *inside* the window. | Accept as an extension of that ruling (it is what Michael picked in the frame). | Michael |
| **Q4** | Should M3-A3 render `room/inspect` as the Room table and call `session/read` per thread to earn a `hash` receipt? Without that call, every thread row stays `○ NO RECEIPT`. | Render the table in M3-A3. Fetch `session/read` only for the selected thread, on an explicit command or focus action, never in a poll loop. Bulk verification is left to M3-A7. | Surface (scope) |
| **Q5** | Window minimum 960×640 needs `minWidth/minHeight` in `src-tauri/tauri.conf.json` (an M3-A2 file). | Allow it as part of M3-A3. | Surface |
| **Q6 (Approved 2026-11-26)** | Vendor IBM Plex Sans + JetBrains Mono woff2 (OFL) into `packages/desktop/ui/fonts/`, or rely on system fonts. | Vendor them (offline, consistent metrics). Adds roughly 0.5 MB. | Michael |

Not open (decided here unless the pin overrules): the closed pill vocabulary, equal pill geometry, no full-window scrim, no animation, no toast on copy, and that a clean `serve` exit is neutral.
