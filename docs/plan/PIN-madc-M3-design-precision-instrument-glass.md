# PIN: MADC M3-A3 Design System & Evidence-Bound Primitives (Precision Instrument Glass)

- **Status:** **DRAFT**. Not binding until the Founder merges a PR naming this pin's exact head SHA.
- *Amended by `PIN-madc-M3-A4-multi-seat-workspace.md` (2026-11-27, Surface Architect, M3-A4; in-place pointer edit permitted by `docs/plan/README.md` lines 8-9 because this pin's status is DRAFT): re-closes the §4.2 pill vocabulary (adds `RUNNING`, `COMPLETED` neutral and `INTERRUPTED` fail, D-717) and the §5.5 command list; amends the spec §5.4 "chips never wrap or clip" rule to "chips may wrap, never clip" (FDR-A4-5 / D-728, ruled 2026-11-27 11:50 PM ET, `needs-confirmation`; together with FDR-A4-1 / D-723, D-693 closes on merge of that pin); narrows Q4 (D-682) to allow one automatic `session/read` per completed turn on a visible pane (FDR-4(c)) and, further, exactly one automatic `session/read` after a successful `thread/start` (D-729, ruled 2026-11-27 11:51 PM ET, `needs-confirmation`); supersedes §6.4 R1's method list, §6.5, the §6.1 disconnect-wait sentence and the §7 `launcher.rs`/`main.rs` deferral as stated in that pin's §2.1; supersedes the Q2 "No other global shortcut is added" text (D-680) for the M3-A4 keys only (C53, D-722; the Q2 cell itself is not edited).*
- **Author:** Surface Architect
- **Date:** 2026-11-26 (r2: revised the same day to answer Argus r1 on PR #78 at `1fd6e78e` and Copilot's 10:29 AM ET review; r3: answers Argus r2 at `cb77272a` (N1–N4) and Copilot's 11:22 AM ET review; dispositions in §10; r4: 2026-11-27 amendment after PR #79 merged at `12682017e3ee29132199dc8694e78f6768ae454e` (squashed from `066d620b1aedeea2fb0f19d123e695d2c752335c`), closing Argus r1 `M1` and Clio items `D-691`, `D-692`, `D-695`, `C52`, documenting `D-693` and `D-694`, and aligning §6.4 R2 for `D-686`)
- **Milestone / Act:** M3 / Act M3-A3 ("Visual system & evidence-bound primitives")
- **Decisions addressed:** Closes **D-618** (M3 §4 Iris citation gap), fulfills **D-189** (design spec pinned before UI build) and **D-672** (M3-A3 gate), preserves **D-626** (evidence-bound UI rule), and closes **M0 Q17** (M3 status-color / toolbar supersession).
- **Repo paths (this PR):**
  - Pin: `docs/plan/PIN-madc-M3-design-precision-instrument-glass.md`
  - Verbatim approved spec: `docs/plan/sources/DESIGN-SPEC-m3-a3-precision-instrument-glass.md` (cited below as "spec"; never edited)
  - Pointer edits: one `Amended by PIN-madc-M3-design-precision-instrument-glass.md` line under the status block of `docs/plan/PIN-madc-M3-desktop-protocol.md` (closing D-618 on §4) and two index rows in `docs/plan/README.md` (this pin and the verbatim spec).

## Verified Base & Source Identities

- **Repository base:** `MADVenturesLLC/MADC` `main` @ `9333fe9812a1d983aa92f2e4e89794bf9ef9d231` (PR #76, M3-A2 merged). Re-checked at `main` @ `60686b56e69233f3d853fbaf1be5d44c0da46d04` (PR #77): `9333fe98..60686b56` touches no file under `docs/plan/`, `packages/desktop/` or `packages/engine/`, so every blob identity and every code line cited below holds at both commits.
- **Referenced repo blob SHAs at `9333fe98`:**
  - `docs/plan/PIN-madc-M3-desktop-protocol.md`: `8e6a59f1127582029445cc3574751bf20fac3b5b`
  - `docs/plan/PIN-madc-M3-desktop-protocol-amendment-1.md`: `3047bf3f59c68329f838bfc63fe32f3f4aa3a266`
  - `docs/plan/PIN-madc-M0-design-omarchy-git-panel.md`: `c05b5464128d9b212fb3639b3ea88af0c518a131`
  - `docs/plan/sources/DESIGN-SPEC-omarchy-git-panel.md`: `1fd8819c07233a34f7bfcfc1833daee2ba928fc4`
  - `docs/plan/PLAN-madc-M3-build-plan.md`: `f58d10cf23a64b3658951f6f97ef72f149559dab`
  - `docs/plan/ROADMAP-madc-post-M0.md`: `71dfb31a1779b9d37a2dea9876907eac8d777099`
- **Approved Iris design artifacts (Michael Daley approved Direction C 2026-11-25 and the spec 2026-11-26 with the recommended Q1/Q2/Q3/Q6 rulings):**
  - Spec: `DESIGN-SPEC-m3-a3-precision-instrument-glass.md`, sha256 `98be29ad778a7d8f136dc103b2defc63082d14159b6b544ed25ffb3a5e4fa37d` (repo blob `040bfcccb2b87142692e71476aa5de853ec2aa37`)
  - Visual source of truth: `direction-c.png` (2880×1800 / 1440×900 @2x), sha256 `56260fa81215747062b5d4776f376108f852e0b389818d09a611d77ad5619e29`
  - Reference CSS (`c.css`): sha256 `a05c4683bec254a4702d8d33e1ff798e0aa0c76f3c9ac201f55d2b080a7ed56c`
  - Reference CSS (`base.css`): sha256 `90a20150bc4565ee01af513254def9f3163404e3ae4f51dcc11f136792836e00`
  - Reference mock markup (`body.html`): sha256 `4f849a2497a355d82d5f8ff75e2d458451b34088decfb85cc264131f0e746371`

---

## 0. How this pin relates to the spec (binding)

1. **The spec is adopted in full.** Every rule, token, size, file assignment, command and state in spec §1–§8 binds M3-A3 exactly as written, except for the items listed in §1.3 below.
2. **This pin adds only three kinds of text:**
   - the rulings on spec §9 Q1–Q6 (§1.1);
   - the deviations from the spec in §1.3, each forced by live M3-A2 code or by a contradiction inside the spec, none of them a visual-direction change;
   - implementation contracts where the spec is silent or can't be built against live code as written (§4.3 row mapping, §6 connection and failure mapping, §9 acceptance tests).
3. **Where this pin is silent, the spec governs.** Restated spec values in §3–§5 are there for convenience. If a restatement here differs from the spec and the item is not in §1.3, the restatement is a drafting error and the spec wins.
4. Spec precedence (spec §1: merged pins > spec > frame > reference CSS) and the five text-over-frame points (§1.2) are unchanged.

---

## 1. Rulings, Text-over-Frame Precedence, and Deviations

### 1.1 Rulings Table (spec §9)

| Item | Topic | Disposition | Ruling & Authority |
| --- | --- | --- | --- |
| **Q1** | M3 status colors & focus bar vs. `ROADMAP-madc-post-M0.md:92` and M0 `DESIGN-SPEC-omarchy-git-panel.md` §10 | **ACCEPT** (Founder approved 2026-11-26) | M3 evidence-bound status colors (strictly gated through `evidenceTone`) and the M3-A2 focus bar (`role="toolbar"`) supersede `ROADMAP:92` ("no status colors") and M0 SPEC §10 ("no toolbar") for M3 desktop surfaces. Closes **M0 Q17**. |
| **Q2** | Command palette shortcut (`Cmd+K` / `Ctrl+K`) | **ACCEPT** (Founder approved 2026-11-26) | `Cmd+K` on macOS (`metaKey && !ctrlKey`) and `Ctrl+K` on Linux/Windows (`ctrlKey && !metaKey`), case-insensitive `'k'`, opens the palette from anywhere in the window and closes it if already open (spec §7.1). **While the palette is closed**, `Tab` / `Shift+Tab` keep standard focus order and the M3-A2 focus-bar keys are unchanged (spec §7.1 last bullet). **While the palette is open**, `Tab` / `Shift+Tab` are trapped inside it per spec §7.1 (the input is the only tab stop). `Esc` closes the palette and restores focus to the element focused before opening; otherwise `Esc` keeps its existing role. No other global shortcut is added. |
| **Q3** | `#0e0e14` (`--madc-darker`) inside the window | **ACCEPT** (Founder approved 2026-11-26) | `#0e0e14` is permitted inside the window for the title bar (if app-drawn) and recessed wells (Room table well, Receipts well, `#output` well), as well as the backdrop behind the window (spec §3.1). |
| **Q4** | Room table from `room/inspect` + on-demand `session/read` for a `hash` receipt | **ACCEPT, narrowed** (Surface Architect ruling, Founder-approved 2026-11-26) | M3-A3 renders the Room table from `room/inspect` (`RoomReport.threads`). `RoomThreadRow` (`packages/engine/src/inspect.ts:136-154`) carries neither `hash` nor an event count, so every row starts without a hash receipt and renders `—` in the `events` column. `session/read` (allowlisted at `packages/desktop/src-tauri/src/launcher.rs:35-40`; typed client method `DesktopEngineClient.sessionRead` at `packages/desktop/src/ipc.ts:211-216`) is invoked **only when the user explicitly selects one row** (click, or `Enter` on the focused row). It is never called in a poll loop, never automatically on connect or after `Inspect room`, and never in bulk across rows (bulk verification and the replay inspector stay in M3-A7). The narrowing from the spec's "explicit command or focus action" is §1.3 item D7: M3-A3 adds **no** palette command for it, so the spec §7.3 command list stays closed. |
| **Q5** | `minWidth: 960, minHeight: 640` in `packages/desktop/src-tauri/tauri.conf.json` | **ACCEPT** (Surface Architect ruling, Founder-approved 2026-11-26) | Permitted in M3-A3 as a narrow edit to `app.windows[0]`. `title`, `width: 1200`, `height: 800`, `resizable: true`, `bundle.active: false`, and the CSP stay unchanged (see §8.1 for the font CSP check). |
| **Q6** | Local vendoring of IBM Plex Sans + JetBrains Mono woff2 | **ACCEPT** (Founder approved 2026-11-26) | Vendor per spec §8.4 (the "Preferred" path): `IBMPlexSans-{Regular,Medium,SemiBold}.woff2` and `JetBrainsMono-{Regular,Medium,SemiBold}.woff2` (SIL OFL 1.1) plus their license texts under `packages/desktop/ui/fonts/`. No external font CDNs and no runtime network requests. |

### 1.2 Text-over-Frame Precedence (spec §0, binding, unchanged)

Where `direction-c.png` differs from the spec text, the spec text wins on these five points. Everywhere else the frame wins (subject to spec §1 precedence):
1. Monospace face is **JetBrains Mono** (the frame rendered IBM Plex Mono).
2. Status pill border width is **`1px`** (the frame drew `1.5px`).
3. Command palette filter prompt glyph is **`>`** (the frame drew `❯`).
4. Command palette shortcut is **`Cmd+K`** (macOS) / **`Ctrl+K`** (Linux/Windows) (the frame hint shows `Ctrl K`).
5. The `"repo head"` and `"engine.lock"` receipt rows in the frame are illustrative mock rows, **not** required M3-A3 screens (spec §6.6).

### 1.3 Pin deviations from the approved spec (closed list)

None of these changes Direction C's look (tokens, glass, radii, type, layout and pill geometry are the spec's, except the `960–1199px` band layout in D9). Each one is forced by live M3-A2/engine code or resolves a contradiction inside the spec. No Founder visual ruling is needed for them; they are listed so the Founder sees them at merge.

| # | Spec text | Pin value | Why (evidence) |
| --- | --- | --- | --- |
| D1 | §6.4 chip table: `torn tail` chip "shown with tone **warn**" | A torn-tail row is **`fail`** (`✗ FAILED`) before and after `session/read`; the `torn tail` chip and its `crash residue, not tamper` note stay and are what tells it apart from an `integrity` failure (§4.3). | Spec §6.2 says "`chain.ok: false` → `hint "fail"`". `inspectRoom` gives every unverified chain, torn tail included, `level: "fail"` and counts it in `counts.fail` (`packages/engine/src/inspect.ts:208-235`). `session/read` returns `chainOk: false, events: []` for it (`packages/engine/src/search.ts:166-171`). A warn pill next to a "fail" count, flipping to fail on read, would contradict the engine. |
| D2 | §6.5: `stopped` chip `signal <SIG>` (a signal name) | Chip value `signal <N>`, the integer signal number exactly as the launcher reports it (e.g. `signal 9`). No name mapping. | `connect_engine` reports the signal as a Rust `Option<i32>` Debug value (`signal=Some(9)`, `launcher.rs:681`); no name is available to the UI. |
| D3 | §6.5: `stopped` "(signal, **or Windows launcher kill**)" → chip `1 launcher kill` | Kept in the classifier for parity with `classifyServeExit`, but **unreachable in M3-A3**; no test may require it to render from `connect_engine`. | On non-unix `connect_engine` always rejects with `Windows named-pipe desktop transport is unverified in M3-A2` (`packages/desktop/src-tauri/src/main.rs:41-45`), and the launcher calls `classify_exit(code, signal, false)` (`launcher.rs:648`). |
| D4 | §7.3: palette `Connect to @madc/engine` enabled when "not connected / connecting" (Copilot on spec:475) | Enabled **only** in `IDLE`, `DISCONNECTED`, `STOPPED` and `FAILED`, and only while no `disconnect_engine` is pending (§6.1). **Disabled while `CONNECTING`** (`aria-disabled="true"`, metadata `connecting`), exactly like `#connect-btn` (spec §6.5 "Connecting … disabled"). Hidden/disabled while `CONNECTED` (spec §6.5). Plus a single-flight guard (§6.1). | Prevents a second `connect_engine` while one is in flight (spec §6.5 and AM1 §5: one manual trigger, no automatic retry). |
| D5 | §8.1 `src/ipc.ts` row: "The UI consumes … `classifyServeExit`, `parseLockOwnerGuidance` … as they are" | `src/ipc.ts` stays **unchanged** (as the spec says), but the shipped UI consumes **behaviour-identical plain-JS ports** of the two helpers in `ui/shell.js`, plus a pinned parser for the exact `connect_engine` / `rpc_request` rejection strings (§6.2, §6.4). Parity is enforced by tests against the `ipc.ts` originals (§9 item 7). | The shipped UI is plain JS (`ui/app.js` imports only `./shell.js`), `@madc/desktop` has no build step (`packages/desktop/package.json`), and `connect_engine` rejects with a free-form `String` (`main.rs:21`, `launcher.rs:671-682`, `:711-714`), not a structured exit. So the TS helpers can't be called from the WebView. Changing the Rust error contract (option b in Argus M1) would edit M3-A2 files (`main.rs`, `launcher.rs`) that Q5 does not open, so M3-A3 does not do it. |
| D6 | §8.5: "computed-style snapshot shows equal height…"; "no element … resolves any colour property to `#9ece6a`" | Realised as **static stylesheet assertions** over `ui/styles.css` plus pure-helper/fake-DOM tests (§9 items 2-3). No headless browser is added. | CI runs `node --test` and `bun test` with no DOM (no `jsdom`/`happy-dom` in `package-lock.json`; `desktop.test.ts:140-202` uses a hand-rolled fake document). |
| D7 | §9 Q4 recommendation: fetch `session/read` "on an explicit command or focus action" | Row selection only (click / `Enter` on the focused row). No palette command is added; the spec §7.3 list stays closed (§5.5). | Keeps the closed command list and spec §8.5's "no command IDs outside §7.3" test true (Copilot on pin:201; Argus H1.10). |

| D8 | §3.4 forced-colors block: `.pill .glyph { background: none; color: CanvasText; }` | The selector is **`.pill .pill-glyph`**; the rest of the declaration is unchanged. | The spec's required pill markup names the glyph element `.pill-glyph` (spec §6.3 example, §8.2 `.pill > .pill-glyph[aria-hidden] + .pill-label`). There is no `.glyph` element, so the verbatim selector would never match and the filled tone block would survive forced colours (Copilot on spec:180; Argus r2 N2). |

| D9 | Spec §5.4 / pin §5.2: at 960–1199px the right column shrinks to `minmax(360px, 440px)`, "chips never wrap or clip"; §3.4 unprefixed `backdrop-filter` plus the verbatim `@supports not (backdrop-filter: blur(1px))` fallback | In the `960–1199px` band only (leaving `≥1200px` byte-identical): `#main-content` right column uses `clamp(360px, 37.5vw, 440px)` (resolving `520 + 360` at `960×640`); Room table uses `140px minmax(50px, 1fr) minmax(0, 1.08fr) 48px minmax(168px, 1.94fr)` with `8px` gap so the receipt track never collapses below `168px` (fitting the 12-hex `hash` chip) and `THREAD` header fits (`50px` floor); empty-state row selector uses `.room-row.room-row--empty`; sub-960 guard explicitly restates the `12px` gap. `-webkit-backdrop-filter` is paired alongside `backdrop-filter` on `.glass`, `.palette.glass`, and the `prefers-reduced-transparency: reduce` fallback, while keeping `@supports not (backdrop-filter: blur(1px))` verbatim per spec §3.4. Safari < 18 opaque fallback under the verbatim `@supports` block is accepted as-is (Tauri on current macOS runs WebKit 27.2+; no spec §3.4 amendment needed; closes `D-694` upon Founder merge). Deferred post-M3-A3 §5.4 layout follow-ups (explicitly carried as `D-693`, not M3-A3 blockers): (a) multi-chip receipt clipping below ~1266px (including default `1200×800`, where `hash` + `chainOk true` need `259.83px`), to be resolved by hiding `seat` below `1200px` and allowing receipt chips to wrap onto a second line; (b) `exit-20` Receipts-well `pid` chip clip / 0px note at `960px` (`561px` in `518px`). | PR #79 (`a1dea5c7`, head `066d620b`, merged as `12682017`) measured the pre-fix `960×640` grid collapsing the receipt track to 0px when the right column sat at its 440px maximum (`440 + 440`). The `clamp` plus receipt/`THREAD` floors keep a 12-hex `hash` chip visible without disturbing the pinned `1200×800` frame. The `-webkit-` pairing targets current WebKit; the verbatim `@supports` block is retained per spec §3.4 (Argus r1 `M1`; Clio `D-691`, `D-692`, `D-693`, `D-694`, `D-695`, `C52`). |

Nothing else in this pin deviates from the spec.

---

## 2. Supersession & Continuity

- **Superseded for M3 desktop only:**
  - `docs/plan/ROADMAP-madc-post-M0.md:92` ("I would keep it read-only, with no status colors"), superseded by Q1. M3 desktop uses evidence-bound semantic tones strictly via `evidenceTone`.
  - `docs/plan/sources/DESIGN-SPEC-omarchy-git-panel.md` §10 ("no toolbar"), superseded by Q1 for M3 desktop. The M3-A2 focus bar (`nav#focus-bar[role="toolbar"]`) is kept and styled.
- **Unchanged and still binding:**
  - `docs/plan/PIN-madc-M0-design-omarchy-git-panel.md` for M0/M1/M2 CLI surfaces (stays frozen).
  - `docs/plan/PIN-madc-M3-desktop-protocol.md` §1–§3 and Amendment 1 (socket, `madc-engine serve`, `engine.lock`, allowlist, no auto-retry, exit codes).
  - `docs/plan/PIN-madc-M3-desktop-protocol.md` §4 evidence-bound rule (**D-626**), now backed by this pin (closing **D-618**).
  - The M3-A2 launcher and Tauri commands: `packages/desktop/src-tauri/src/launcher.rs` and `main.rs` are **not edited** in M3-A3. The only `src-tauri` edit is Q5's `tauri.conf.json` window minimum (and the §8.1 fail-closed `font-src` escape, if needed).
- **M3-A2 test continuity:** existing tests in `packages/desktop/src/desktop.test.ts` keep passing. **Every existing assertion stays byte-for-byte, except** the two `statusEl.className` assertions (`desktop.test.ts:254` `"status-neutral"`, `:262` `"status-fail"`), which become `statusEl.getAttribute("data-tone")` assertions (`"neutral"`, `"fail"`), because spec §8.1 removes `.status-*` in favour of `data-tone`. The focus-bar key assertions, the `["connect_engine", "rpc_request"]` invocation sequence, the `/neutral/` status text match, and the "no automatic retry" count are unchanged. New assertions and new tests may be added freely.
- **Permitted fake-DOM harness extensions (Argus r2 N1).** Today the harness is minimal: `ShellDocument` has only `getElementById` (`packages/desktop/ui/shell.d.ts:39-41`), `ShellElement` has only `className`, `textContent`, `tabIndex`, `setAttribute`, `getAttribute`, `focus`, `addEventListener` and `querySelectorAll` (`shell.d.ts:28-37`), the fake `FakeEl`/`makeEl` sits at `desktop.test.ts:141-179`, and `doc` (`:196-202`) throws on an unknown ID (`:199`). The M3-A3 UI needs node creation and state attributes, so these harness edits are allowed:
  1. **`shell.d.ts` types:** `ShellDocument` and `ShellElement` may gain members, but only **standard DOM names with standard DOM semantics**, so the real `document` and real elements still satisfy them. Examples: `ShellDocument.createElement(tagName)`, `ShellDocument.activeElement`; `ShellElement.appendChild(child)`, `replaceChildren(...nodes)`, `removeAttribute(name)`, `hasAttribute(name)`, `children`, `hidden`, `disabled`, `inert`, `title`. Existing members keep their current signatures.
  2. **Fake element and document:** `FakeEl`/`makeEl` and `doc` gain matching in-memory implementations of exactly the members added in item 1 (e.g. `createElement` returns a new `makeEl()`; `appendChild` and `replaceChildren` maintain a `children` array; `removeAttribute` deletes from `attrs`; `hidden`, `disabled` and `inert` are plain properties). The behaviour of the existing members (`setAttribute`, `getAttribute`, `focus` counting, `addEventListener`/`emit`, `querySelectorAll`) does not change.
  3. **`byId` map** (`desktop.test.ts:190-195`) gains one fake element for each new ID that `bindDesktopShell` looks up in `ui/index.html`. `doc.getElementById` keeps throwing on an unknown ID, so the binder may look up only IDs that `index.html` defines.
  4. **No other harness changes.** Specifically, the `invokeFn` fake (`:206-216`) and the controller calls stay as they are; extra fakes go in new tests.
- **Rendering rule (pairs with N1):** `ui/shell.js` builds every M3-A3 node with `createElement` + `textContent` + `setAttribute`. It never uses `innerHTML`, `outerHTML`, `insertAdjacentHTML` or `document.write` (engine strings such as `reason`, `manualFix` and stderr must never be parsed as HTML). Test §9.1 asserts none of those four names appears in `ui/*.js`.

---

## 3. Visual Token & Typography Contract (spec §3, §4, §8.4, adopted verbatim)

- **One token file:** all tokens live once in `packages/desktop/ui/styles.css` under `:root` (spec §3, §8.1). There is **no** `tokens.css`. No other file may hard-code a hex value. Every colour is one of the 11 Omarchy Tokyo Night hexes below, optionally with alpha.

### 3.1 Colour tokens (Tokyo Night, exact hex; spec §3.1)

| Token | Value | Role (spec §3.1, abbreviated) |
| --- | --- | --- |
| `--madc-darker` | `#0e0e14` | Backdrop behind the window, title bar, recessed wells (Room table, Receipts, `#output`), glyph colour inside filled glyph blocks (Q3) |
| `--madc-bg` | `#1a1b26` | Main window canvas, active focus-bar tab fill, keycap fill |
| `--madc-lighter` | `#24283b` | Base of every elevated glass surface, receipt-chip key segment, status strip, table header tint (35% alpha) |
| `--madc-fg` | `#a9b1d6` | Body text, labels, micro-labels, notes, seat names, palette rows |
| `--madc-bright` | `#c0caf5` | Headings, thread IDs, chip values, active tab text, selected palette row, keycap text |
| `--madc-muted` | `#565f89` | Non-essential only (title-bar meta, palette metadata, `·` separators, empty-value `—`, neutral pill border) |
| `--madc-border` | `#414868` | Hairlines, chip and well borders, neutral glyph-block fill |
| `--madc-accent` | `#7aa2f7` | Focus ring, active-tab underline, palette selection bar, filter-match highlight, `protocol` value, `#connect-btn` border. Never a status |
| `--madc-green` | `#9ece6a` | `verified` tone only |
| `--madc-red` | `#f7768e` | `fail` tone only |
| `--madc-yellow` | `#e0af68` | `warn` tone only |

### 3.2 Glass, fill, border, radius and shadow tokens (spec §3.2, §3.4, §5.1)

- All spec §3.2 tokens are defined with the spec's exact values, including `--madc-glass-blur: blur(14px)`, `--madc-glass-blur-strong: blur(18px) saturate(120%)`, `--madc-glass-edge`, the `--madc-tone-fill-*` tints, `--madc-select-*`, and the shadows.
- **Glass is required on tier 2 and only there** (spec §5.1): the focus bar, the status strip `#connection-status` and the command palette use `.glass` with `backdrop-filter` from the blur tokens. Wells never blur. The spec §3.4 fallbacks are mandatory: `prefers-reduced-transparency: reduce` makes glass opaque with no blur, and `@supports not (backdrop-filter: blur(1px))` falls back to `--madc-lighter`. The same goes for the `prefers-reduced-motion` and `forced-colors` blocks; in the latter the glyph rule's selector is `.pill .pill-glyph` (D8).
- **Radii (spec §3.2):** `--madc-radius-sm: 3px` (pills, chips, keycaps, palette rows), `--madc-radius-md: 4px` (wells, focus-bar group, buttons), `--madc-radius-lg: 6px` (palette). Nothing is pill-shaped or fully rounded.
- No neon glow, no decorative gradients, no pure `#000000` / `#ffffff` text or surfaces (the spec's `rgb(0 0 0 / …)` shadow tokens are allowed exactly as specified).

### 3.3 Typography & vendored fonts (spec §4, §8.4; Q6)

- Families (spec §4.1): `--madc-font-ui` (`"IBM Plex Sans", system-ui, -apple-system, "Segoe UI", "Noto Sans", sans-serif`), `--madc-font-mono` (`"JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace`), `--madc-font-glyph` (`"JetBrains Mono", "DejaVu Sans Mono", monospace`).
- Scale, weights (400/500/600 only, all four pill tones 600), tracking, case, `tabular-nums`, verbatim engine strings (sanitised per ERR1 E11) and the truncation rules come from spec §4.2.
- `@font-face` per spec §8.4: `src: url("./fonts/<file>.woff2") format("woff2"); font-display: block;`, with the six files `IBMPlexSans-Regular/Medium/SemiBold.woff2` and `JetBrainsMono-Regular/Medium/SemiBold.woff2`. The two OFL 1.1 license texts are checked in beside them as `packages/desktop/ui/fonts/LICENSE-IBM-PLEX.txt` and `packages/desktop/ui/fonts/LICENSE-JETBRAINS-MONO.txt` (the spec does not name these files; the names are pinned here for the test).
- If a vendored font fails to load, the browser falls back to the system stack after the `block` period (spec §8.4: fixed-height boxes, `min-width` widths, no layout dependence on exact metrics). Never an external request.
- Zero remote URLs (`http://`, `https://`, protocol-relative `//`, remote `@import`) anywhere in `packages/desktop/ui/`.

---

## 4. Evidence-Bound Primitives & `evidenceTone` Invariant (spec §6)

### 4.1 Hard gate (D-626; spec §6.1–§6.2)

- The only tone source is `evidenceTone(receipt, hint)` in `packages/desktop/ui/shell.js:97-102` (re-exported by `packages/desktop/src/evidence.ts`). Order (unchanged): `hint === "fail"` → `fail`; `hint === "warn"` → `warn`; `isVerifiedReceipt(receipt)` (`shell.js:71-91`) → `verified`; otherwise `neutral`. A caller can never pass a "verified" boolean.
- **Rendering:** every pill and every tone-bearing element carries `data-tone="<EvidenceTone>"`. CSS colours **only** by `[data-tone]`. No `.status-*`, `.tone-*`, `.green`, `.ok` or `.success` classes and no inline colour (spec §6.1, §8.1-§8.2). The binder sets the attribute with `setAttribute("data-tone", tone)` (same DOM effect as spec §8.1's `statusEl.dataset.tone = tone`, and it works with the existing fake `ShellElement`).
- **No decorative green:** `#9ece6a`, `--madc-green`, `--madc-tone-fill-verified` and `✓` appear only where `evidenceTone()` returned `verified`. `CONNECTED` renders `○ CONNECTED` `neutral` (spec §6.2).

### 4.2 Pill & chip primitives (spec §6.3–§6.4, adopted verbatim)

- Identical geometry for all four tones (26px; `.pill--sm` 22px in the Engine-card header), solid glyph block, `1px` tone border, radius 3px, label mono 12/600/0.06em UPPER.
- Closed pill vocabulary (spec §6.3): `verified` → `VERIFIED`; `neutral` → `NO RECEIPT`, `IDLE`, `CONNECTING`, `CONNECTED`, `DISCONNECTED`; `warn` → `UNVERIFIED`, `STOPPED`; `fail` → `FAILED`.
- Receipt chips (spec §6.4): boxed key–value, the key is the verbatim field name, and chips never carry tone colour. Chip keys used in M3-A3: `hash`, `chainOk`, `torn tail`, `chain`, `line`, `serve exit`, `raw`, `protocol`, `pid` (spec §6.4–§6.5). `sha` and `servedModel` chips render only if such a receipt is ever returned, and no M3-A3 allowlisted method returns one.

### 4.3 `RoomThreadRow` → tone & receipt mapping (exact; consistent with `inspectRoom` and `session/read`)

Inputs: a `RoomThreadRow` from `room/inspect` (`packages/engine/src/inspect.ts:136-154`; `chain` is `{ ok: true }` or `{ ok: false, line, reason, kind }` with `kind: SessionFailureKind = "torn-tail" | "integrity"`, `packages/engine/src/session-store.ts:1129`), and optionally the cached result of a user-triggered `session/read` for that `threadId` (`SessionReadResult { threadId, events, chainOk }`, `packages/desktop/src/ipc.ts:48-52`; engine `readSessionEvents`, `packages/engine/src/search.ts:158-172`, returns `events: []` whenever `chainOk` is `false`).

**Counts line:** `<threads> threads · <pass> pass · <warn> warn · <fail> fail · <openDecisions> open decisions`, rendered verbatim from `RoomReport.counts` (`inspect.ts:156-166`). Every unverified chain, torn tail included, is counted in `fail` (`inspect.ts:208-209`), and its row renders `fail` below, so the counts line and the rows always agree. Counts are never green (spec §6.2).

**A. Before any `session/read` for the row** (`events` cell renders `—`, never `0` or a guess):

| Row condition (evaluated in this order) | Hint → tone | Pill | Chips / note |
| --- | --- | --- | --- |
| `chain.ok === false && chain.kind === "torn-tail"` | `fail` → `fail` | `✗ FAILED` | chip `torn tail` `line <chain.line>`, note `crash residue, not tamper` |
| `chain.ok === false` (`chain.kind === "integrity"`) | `fail` → `fail` | `✗ FAILED` | chip `chain` `FAILED`, chip `line` `<chain.line>`, note `<chain.reason>` verbatim |
| `chain.ok === true && level === "fail"` (schema-v2 finding) | `fail` → `fail` | `✗ FAILED` | note: first `findings[]` entry with `level === "fail"`, as `<code>: <detail>` verbatim |
| `level === "warn"` | `warn` → `warn` | `▲ UNVERIFIED` | note: first `findings[]` entry with `level === "warn"`, as `<code>: <detail>` verbatim |
| otherwise (`level === "pass"`, `chain.ok === true`) | `evidenceTone(null, "neutral")` → `neutral` | `○ NO RECEIPT` | chip `hash` `—` (muted) |

**B. After a user-triggered `session/read({ threadId })` resolves for the row:**

- If `res.chainOk !== true`: hint `fail` → `✗ FAILED`. The `events` cell **stays `—`** (the engine returns `events: []` for an unverified chain, which is not a count). Keep the section-A chips for the row and add chip `chainOk` `false`. This covers every torn-tail and integrity row, and a chain that broke after `room/inspect`.
- If `res.chainOk === true`:
  - `events` cell renders `String(res.events.length)` (`tabular-nums`).
  - `tailHash = res.events.length > 0 ? res.events[res.events.length - 1].hash : null` (`SessionEvent.hash`, `session-store.ts:210`).
  - `receipt = typeof tailHash === "string" ? { kind: "hash", chainOk: true, hash: tailHash } : null`.
  - `hint = row.level === "fail" ? "fail" : row.level === "warn" ? "warn" : "ok"`; tone `= evidenceTone(receipt, hint)`.
  - `verified` → `✓ VERIFIED`, chips `hash` `<tailHash.slice(0, 12)>` (full 64 hex in `title` and the accessible name) and `chainOk` `true`.
  - `neutral` (malformed or absent tail hash, `isVerifiedReceipt` false) → `○ NO RECEIPT`, chip `hash` `—`.
  - `warn` / `fail` (row had findings) → section-A pill and note for that level. No `hash` chip, because spec §6.4 shows `hash` only with verified or neutral.
- If `session/read` **rejects** (§6.4): the row renders `✗ FAILED`, `events` `—`, note `session/read: <code> <message>` for an engine RPC error (e.g. `-32002` ThreadNotFound when the file vanished after `room/inspect`; `ErrorCode.ThreadNotFound`, `packages/engine/src/protocol/errors.ts:12`) or the verbatim transport message otherwise. Any cached read for that row is discarded, so a stale `verified` can never survive a failed re-read.
- `Inspect room` (and the one `room/inspect` after connect) rebuilds every row from the fresh report and **discards all cached `session/read` results**.
- In-flight dedupe: while a `session/read` for a `threadId` is pending, selecting that row again does nothing. A result that arrives after disconnect, or after a newer `room/inspect`, is dropped.

---

## 5. Surface, Layout & Palette Contract (spec §5, §7, §8.1-§8.3, adopted verbatim)

### 5.1 Regions (spec §5.3)

- **Title bar:** OS-drawn. `tauri.conf.json` sets no `decorations` key (default `true`), so M3-A3 draws no title bar of its own.
- **Focus bar `#focus-bar`** (52px, tier-2 glass, `class="glass"`): the four M3-A2 buttons (`data-focus-id` `connection`/`room`/`decisions`/`search`, `shell.js:16-21`) as one segmented group. Active tab `bg` fill, bright text, `inset 0 -2px 0 accent`. Keycap hints on the right (`Tab ← →  move`, `⌘K` / `Ctrl K  commands`). M3-A2 keyboard behaviour (roving `tabIndex`, `aria-pressed`, `ArrowRight`/`ArrowLeft`/`Home`/`End`) is unchanged.
- **Main** (`<main>`, tier 1): two-column grid `minmax(0,1fr) 440px`.
  - Left: section head (`ROOM/INSPECT`, h1 "Room", counts line), then the Room table well (columns evidence 148 · thread 100 · seat 108 · events 48 · receipt 1fr), then the Receipts well (label 112 · pill 160 · chips · note).
  - Right: the Engine card (micro-label `ENGINE` plus the connection pill `.pill--sm`; key/value list `socket` = `socketPath`, `protocol` = `protocolVersion` (accent), `server` = `serverName serverVersion`, `cold start` = `coldStartMs ms`, `reused` = `reusedExisting`, all from `DesktopConnectionInfo`, `ipc.ts:54-61`; note "Connection alone is not evidence."), then the `#output` well (`OUTPUT` / `room/inspect · read-only`), then `#connect-btn`.
- **Status strip `#connection-status`** (34px, tier-2 glass, `class="glass"`, `data-tone`): left `engine` + socket name; centre the state word in tone colour (§6.1); right `cold start <n> ms` and the model slot. No allowlisted M3-A3 method yields a requested or served model, so the model slot shows `model —` (muted empty-value dash) until a verified `servedModel` receipt exists (spec §5.3 model rule).

### 5.2 Window size & scroll (spec §5.4; Q5)

- ≥ 1200 × 800 (default `tauri.conf.json` size): full two-column layout as in the frame.
- 960–1199 wide: still **two columns**; the right column shrinks via `clamp(360px, 37.5vw, 440px)` (D9). Room table track floors in that band, and the deferred §5.4 multi-chip / `exit-20` clipping follow-up, are in D9.
- 960 × 640: minimum usable size, enforced by `minWidth: 960, minHeight: 640` (Q5).
- 800–959 wide: single column, but only if the OS allows a window below the pinned minimum (spec §5.4 row kept as a guard; not reachable with Q5 in force).
- < 640 high: only `<main>` scrolls (vertical); focus bar and status strip stay fixed. `#output` is the only element allowed a horizontal scrollbar.

### 5.3 Room table well & on-demand `session/read` (Q4)

- Recessed well (tier 0: `--madc-darker`, 1px `--madc-border`, `--madc-well-inset`, radius 4px). Rows 60px high (spec §5.2).
- Rows are focusable (`tabindex="0"`, focus ring per spec §8.3). Click, or `Enter` on the focused row, selects that one row (`--madc-select-fill` + `--madc-select-edge`, never green) and invokes `rpc_request` with `{ method: "session/read", params: { threadId } }` once, deduped while in flight (§4.3 B).
- Empty room (`threads` empty or not an array): one neutral empty-state row, `No threads in $MADC_HOME/sessions`. The counts line still renders `RoomReport.counts`; a missing count field renders `—`.

### 5.4 Engine card & Receipts well (spec §6.5-§6.6)

- The Engine-card pill and the status-strip centre carry the same state word (§6.1).
- **Receipts well:** only receipts the engine actually returned in this session (spec §6.6): a `serve exit` row for each classified `connect_engine` exit (§6.3), and a `servedModel` / `sha` row only if one is ever returned. Thread `hash` receipts stay on their Room-table rows. Empty → no rows. Never fabricated `servedModel`, `repo head` or `engine.lock` rows.

### 5.5 Command palette (spec §7, adopted verbatim except D4)

- **Files (spec §8.1):** pure, testable palette helpers `createPaletteState`, `filterCommands`, `stepPalette` live in `packages/desktop/ui/shell.js` beside the focus-bar functions, typed in `packages/desktop/ui/shell.d.ts` (`PaletteCommand`, `PaletteState`, plus the `renderPill` input type). `ui/app.js` changes only to wire the `Cmd/Ctrl+K` keydown listener on `document`. There is **no** `ui/palette.js` and **no** `src/palette.ts`.
- **Keys (spec §7.1):** `Cmd+K` / `Ctrl+K` toggles; `Esc` closes and restores focus to the element focused before opening; `Enter` runs the selected enabled command, then closes (the command decides focus, otherwise prior focus is restored); `↑` / `↓` move, skipping group labels and disabled rows, wrapping; `Home` / `End` (in the list) jump to the first / last enabled row; `Tab` / `Shift+Tab` stay trapped in the palette (the input is the only tab stop). DOM focus stays on the input; selection moves via `aria-activedescendant`; background content gets `inert` while open (spec §7.4).
- **Filter (spec §7.2):** prompt `>`; **case-insensitive subsequence match on the command name only**; groups with no matches are hidden; fixed order within groups (no re-ranking); matched characters in accent (no bold); empty state `No matching command` (non-selectable; `Enter` does nothing; announced via a polite live region).
- **Closed command list (spec §7.3, exactly these nine):**

| Group | Command | Enabled when | Action |
| --- | --- | --- | --- |
| Engine | Connect to @madc/engine | state ∈ {`IDLE`, `DISCONNECTED`, `STOPPED`, `FAILED`} and no `disconnect_engine` pending; **disabled while `CONNECTING`**, while `CONNECTED`, and while cleanup is pending (D4, §6.1) | same as `#connect-btn` (§6.1) |
| Engine | Inspect room | `CONNECTED` | `rpc_request` `room/inspect` → `#output` and Room table |
| Engine | Disconnect | `CONNECTED` and no `disconnect_engine` pending | `disconnect_engine` → `○ DISCONNECTED` when it settles (§6.1 cleanup rule) |
| Focus | Focus Engine | always | `focusBarSelect("connection")` |
| Focus | Focus Room | always | `focusBarSelect("room")` |
| Focus | Focus Decisions | always | `focusBarSelect("decisions")` (focus only, spec §5.5) |
| Focus | Focus Search | always | `focusBarSelect("search")` (focus only) |
| Evidence | Copy chain head | a `hash` value is displayed for the selected or most recent thread | copies the full 64 hex |
| Evidence | Copy served model | a `servedModel` receipt is present (never in M3-A3 practice; renders disabled with metadata `no servedModel receipt`) | copies the string |

  Metadata and keycap hints per spec §7.3. Copy uses `navigator.clipboard.writeText`; if it is unavailable the row is disabled with metadata `clipboard unavailable`; a successful copy shows no toast and no green. Disabled rows: fg at 50%, `aria-disabled="true"`, skipped by arrows, metadata says why (e.g. `not connected`, `connecting`). No other command exists (no `Read selected thread`; see D7).

---

## 6. Connection State Machine & Failure Mapping (spec §6.5 adopted in full, plus the rows it omits)

Spec §6.5's two tables (connection states and `serve` exits) bind **in full**, adjusted only by D2–D4. This section adds what the spec leaves open: how the plain-JS UI gets each state from what `connect_engine` and `rpc_request` actually return.

### 6.1 States, the Connect affordance, and single-flight

| State | Pill (Engine card) | Status-strip centre (`#connection-status`, same tone) | `#connect-btn` / palette Connect |
| --- | --- | --- | --- |
| `IDLE` (startup) | `○ IDLE` | `idle · no receipt` | enabled |
| `CONNECTING` | `○ CONNECTING` | `connecting over engine.sock…` (static, no spinner) | **disabled** (both) |
| `CONNECTED` | `○ CONNECTED` | `connected · neutral` | `#connect-btn` hidden; palette Connect disabled; palette offers Disconnect |
| `DISCONNECTED` (user Disconnect, clean serve exit, or `not connected` reply) | `○ DISCONNECTED` | `disconnected` | enabled |
| `STOPPED` (serve killed by a signal before `initialize`) | `▲ STOPPED` | `stopped` | enabled |
| `FAILED` (any other failure) | `✗ FAILED` | `engine connection failed (no automatic retry)` (spec §6.5 text; M3-A2 `shell.js:172` currently writes it with a capital `E`, and the spec's lower-case form binds) | enabled (manual retry only) |

- **Single-flight:** the binder's `connect()` (the M3-A2 `connectHandler`, `shell.js:159-175`) sets `CONNECTING` before invoking `connect_engine`. While a call is in flight, any further `connect()` (button, palette, programmatic) returns the pending promise **without** invoking `connect_engine` again. `connect()` invoked programmatically in any other state proceeds (the M3-A2 test at `desktop.test.ts:249-263` calls it twice in sequence). If Rust already holds a client, `connect_engine` returns the cached `ConnectionInfo` (`main.rs:29-31`).
- **`disconnect_engine` is single-flight and non-blocking (Argus r2 N3).** This applies to every call: user Disconnect, protocol-mismatch release (below), and R4 cleanup (§6.4).
  - The binder holds one `disconnectPending` promise. While it is pending, every other `disconnect_engine` request returns that promise; no second call is issued. `#connect-btn` is `disabled`, and the palette `Connect` and `Disconnect` commands are `aria-disabled="true"` (metadata `disconnecting`). The UI stays responsive: focus bar, palette and Focus commands keep working, and no spinner is shown.
  - The call can take up to the 7 s `INITIALIZED_KILL_GRACE` (`launcher.rs:28`; `SocketClient::disconnect` → `SpawnedServe::stop`, `launcher.rs:556-560`). It also waits on the shared engine-state mutex behind any in-flight `rpc_request` (`main.rs:90-93`, up to the 10 s RPC deadline each). Keeping Connect disabled until it settles stops a Connect click from winning the mutex first, getting the stale cached `ConnectionInfo` (`main.rs:29-31`), and then having the pending disconnect drop that client.
  - **On resolve:** user Disconnect → `○ DISCONNECTED`. Protocol-mismatch release and R4 cleanup → the state stays `✗ FAILED`. Connect is re-enabled either way.
  - **On reject** (`engine state lock poisoned`, `main.rs:93`; `disconnect task failed: …`, `main.rs:100`): write the verbatim text to `#output`, go to (or stay in) `✗ FAILED`, re-enable Connect, and **do not retry `disconnect_engine`**. If the Rust side still holds the client, a later manual Connect may return its cached `ConnectionInfo` (`main.rs:29-31`). The next RPC on a dead client then fails as R4 again, which triggers one new cleanup. That is still one call per user-triggered failure, never a loop.
  - **Connection epoch:** the binder keeps an integer epoch. It increments when `connect_engine` resolves and when any `disconnect_engine` starts. A `rpc_request` result or rejection whose request was issued in an earlier epoch is rendered only on its own row or well (or dropped, per §4.3 B). It **never** changes the connection state. So a queued request that rejects R2 `not connected` after an R4 cleanup cannot flip `FAILED` to `DISCONNECTED`.
- **On success:** if `info.protocolVersion !== "madc-m1/1"` (the UI's `EXPECTED_PROTOCOL_VERSION` constant in `shell.js`; a test asserts it equals `PROTOCOL_VERSION` from `@madc/engine/client`), apply spec §6.5's protocol-mismatch row: `✗ FAILED`, chip `protocol` `expected madc-m1/1 · got <v>`, invoke `disconnect_engine` once to release the Rust-held client, and skip `room/inspect`. This is defence in depth that mirrors `DesktopEngineClient.connect` (`ipc.ts:182-191`). The launcher already refuses a mismatching listener (`launcher.rs:448-451`), and because the probe and start loops discard that error (`launcher.rs:588-593`, `:657-665`, `:690-700`), a mismatching listener in practice shows up as an exit-20 row or a start-window timeout (§6.2). Otherwise go to `CONNECTED`, render the Engine card, then invoke **one** `rpc_request` `room/inspect` (the M3-A2 sequence `["connect_engine", "rpc_request"]`). That single call is not a poll.
- **Never** auto-retry `connect_engine` or `rpc_request`, never respawn, never `setTimeout` a retry (AM1 §5, spec §8.1).

### 6.2 `connect_engine` rejection contract (M1; realizable against live M3-A2)

`connect_engine` rejects with a plain `String` (`main.rs:21`), delivered to the WebView as the rejection value of `invoke`. M3-A3 adds one pure helper to `packages/desktop/ui/shell.js`, `classifyConnectError(message, platform = "darwin")`, typed in `shell.d.ts`. `message` is the rejection value when it is a string (Tauri `invoke` rejects with the command's `Err(String)`), otherwise `String(err?.message ?? err)`. It splits `message` at the first `"\nstderr:\n"` into `head` and `stderr` (`stderr` is `""` if absent) and matches `head` against these exact grammars, which are produced by the live launcher and are the only ones M3-A3 recognises:

- **G1 / G2: exit 20** (`launcher.rs:671-673` with guidance, `:675-677` without): `head` starts with `madc-engine serve exited 20 (`. → `exit = serveExitFromCode(20, null)` → `{ kind: "owned", code: 20 }`; `guidance = lockOwnerGuidanceFromStderr(stderr, platform)`.
- **G3: exited before `initialize`** (`launcher.rs:680-682`): `head` matches `^madc-engine serve exited before initialize \(code=(None|Some\((-?\d+)\)), signal=(None|Some\((\d+)\)), class=` → `exit = serveExitFromCode(code, signal)`, where `None` → `null`, `code` is the parsed integer, and `signal` is the decimal string of the parsed integer (e.g. `"9"`, matching `classifyServeExit`'s `signal: string | null`). The Rust `class=` Debug text is ignored and the class is recomputed from code and signal.
- **G4: start-window timeout** (`launcher.rs:711-714`; 5 s `START_WINDOW`, `:26`): `head` matches `^madc-engine serve did not complete initialize within (\d+) ms \(exit code=(None|Some\((-?\d+)\)), signal=(None|Some\((\d+)\))\)` → `{ phase: "start-timeout", startWindowMs }`. The exit status here comes from the launcher's own SIGTERM/SIGKILL (AM1 §5), so it is **not** classified as a `serve` exit.
- **G5: Windows transport refusal** (`main.rs:44`): `head === "Windows named-pipe desktop transport is unverified in M3-A2"` → `{ phase: "unverified-transport" }`.
- **G6: anything else** → `{ phase: "other" }`. Examples: `failed to spawn madc-engine serve: …` (`launcher.rs:605`), `MADC_HOME must be an absolute path` (`:159`), `cannot resolve HOME directory` (`:166`), `engine state lock poisoned` (`main.rs:28`), `connect task failed: …` (`main.rs:39`), `Tauri IPC bridge unavailable outside desktop shell` (`shell.js:107`), or a non-string rejection.

`serveExitFromCode(code, signal)` and `lockOwnerGuidanceFromStderr(stderr, platform)` are plain-JS ports in `shell.js` that are **behaviour-identical** to `classifyServeExit` (`ipc.ts:90-123`, with `launcherKilled` absent) and `parseLockOwnerGuidance` (`ipc.ts:125-164`, same `LOCK_OWNER_LINE` regex and `manualFix` text). Their return types reuse `ServeExitClassification` and `LockOwnerGuidance` via type-only imports from `../src/ipc.ts` in `shell.d.ts`. `src/ipc.ts` is not edited (spec §8.1). Parity is a test (§9 item 7).

Every rejection also writes the full rejection string (sanitised per spec §4.2) into `#output` (spec §6.5 "error text in `#output`").

### 6.3 Rendering each `connect_engine` outcome (spec §6.5 tables; AM1 §6 kinds)

| Outcome | State / pill | Chips (Receipts well `serve exit` row + Engine card) | Detail |
| --- | --- | --- | --- |
| G3 `clean` (0 / 130 / 143) | `DISCONNECTED` `○` neutral | `serve exit` `0` / `130` / `143` | none (a clean stop is neither failure nor success) |
| G3 `stopped` (code `None`, signal `Some(n)`) | `STOPPED` `▲` warn | `serve exit` `signal <n>` (D2) | none |
| G3 `usage-or-home` (2) | `FAILED` `✗` | `serve exit` `2 usage-or-home` | none |
| G1 `owned` (20) with guidance | `FAILED` `✗` | `serve exit` `20 owned`, `pid` `<guidance.pid>` | `guidance.manualFix` verbatim, e.g. "(i) Run \`ps -p 4182 -o command=\` to confirm no \`madc-engine serve\` process with PID 4182 is running; (ii) if none is running, manually remove \<lockPath\>." |
| G2 `owned` (20) with no parseable guidance line | `FAILED` `✗` | `serve exit` `20 owned` (no `pid` chip) | `home owned by another process` only |
| G3 `unsafe-path` (21) | `FAILED` `✗` | `serve exit` `21 unsafe-path` | none |
| G3 `listen-error` (22) | `FAILED` `✗` | `serve exit` `22 listen-error` | none |
| G3 `shutdown-deadline` (23) | `FAILED` `✗` | `serve exit` `23 shutdown-deadline` | none |
| G3 `internal-fault` (24, or any unlisted code such as `1` on unix) | `FAILED` `✗` | `serve exit` `24 internal-fault`; if `rawCode !== 24`, add chip `raw` `<rawCode>` (or `null`) | none |
| G4 start-window timeout | `FAILED` `✗` (spec §6.5 "Connect/IPC error" row) | none | error text in `#output` (includes the 5000 ms window, exit status and drained stderr) |
| G5 Windows transport unverified | `FAILED` `✗` (Connect/IPC error row) | none | error text in `#output` |
| G6 other | `FAILED` `✗` (Connect/IPC error row) | none | error text in `#output` |
| Protocol mismatch (§6.1, defensive) | `FAILED` `✗` | `protocol` `expected madc-m1/1 · got <v>` | none |

- `stopped` from a Windows launcher kill (`1 launcher kill`) is unreachable in M3-A3 (D3).
- Every `fail` outcome uses the full 26px pill in the Receipts well (`.pill--sm` in the Engine-card header) and turns the status-strip centre red with its word. It is never only a red text line (spec §6.5).
- **`engine.lock` is never deleted by the UI.** No button, palette command or code path deletes, renames or rewrites `engine.lock` (spec §6.5 `owned` row; `ipc.ts:135`; `launcher.rs:128`). Recovery is the manual instruction text only.

### 6.4 `rpc_request` rejection contract (`room/inspect`, `session/read`)

`rpc_request` rejects with a plain `String` (`main.rs:64-83`). M3-A3 adds `classifyRpcError(message)` to `shell.js` (typed in `shell.d.ts`):

- **R1: allowlist refusal**, `RPC method not allowed by M3-A2 desktop shell: <method>` (`launcher.rs:46`; checked before the connection check, `main.rs:54`, `:79`). The UI only ever sends `room/inspect` and `session/read`, so this is a defect guard: the action renders `✗ FAILED` with the message in `#output`, and the connection state is unchanged.
- **R2: not connected**, `not connected to @madc/engine` (`main.rs:60`). Go to `DISCONNECTED`; the action renders `✗ FAILED`; Connect is enabled. A stale-epoch R2 rejection does not flip the current connection state (N5 connection-epoch guard in §6.1).
- **R3: engine RPC error**, `engine RPC error: <json>` (`launcher.rs:550`; `<json>` is the compact JSON of the JSON-RPC `error` object). `JSON.parse` the remainder to `{ code, message, data }`. The engine answered, so the connection stays `CONNECTED`. For `session/read` the row renders per §4.3 B (rejected), e.g. `-32002` ThreadNotFound or `-32602` InvalidParams (`packages/engine/src/server.ts:925-934`). For `room/inspect` the Room well shows one `✗ FAILED` row `room/inspect: <code> <message>`, the counts line shows `—`, and cached reads are discarded. If the remainder doesn't parse, treat it as R4.
- **R4: transport loss, timeout, or anything else.** This covers `RPC <method> timed out before write` (`launcher.rs:509`), `RPC <method> timed out waiting for reply` (`:524`; `INTERACTIVE_RPC_TIMEOUT` 10 s, `:31`, `:487`), `set_write_timeout failed: …` (`:513`), `socket write failed: …` (`:516`), `socket flush failed: …` (`:519`), `set_read_timeout failed: …` (`:529`), `socket read failed: …` (`:535`), `engine socket closed before response` (`:537`), `invalid JSON from engine: …` (`:544`), `rpc task failed: …` (`main.rs:75`), `engine state lock poisoned` (`main.rs:57`), and any unmatched string. → `FAILED` with the verbatim message in `#output`; the action's row or well renders `✗ FAILED`; the UI invokes `disconnect_engine` **once** to drop the dead client, so the next manual Connect re-probes instead of getting the cached `ConnectionInfo` from `main.rs:29-31`. The call follows the §6.1 cleanup rule: Connect stays disabled until it settles, then is re-enabled; a rejection is written to `#output`, leaves `FAILED`, and is not retried; requests from earlier epochs can't change the state. This is cleanup, not a retry: no `connect_engine` is issued. **Consequence (stated on purpose):** when the client is one the desktop spawned, `disconnect_engine` stops that `serve` (stdin EOF first, SIGKILL only after the 7 s grace, AM1 §5; `launcher.rs:556-560`). This holds even when the R4 was a 10 s timeout on a live but slow engine. A client attached to a reused listener only drops its socket. The next manual Connect re-probes and, if needed, spawns a fresh `serve`. The UI does not try to tell a 10 s timeout apart from a dead socket, because the per-read socket timeout (`launcher.rs:526-529`) can surface as `socket read failed: …` before the `timed out waiting for reply` check (`:523-524`).

### 6.5 Engine dying while connected

M3-A2 gives the UI no exit notification for a connected `serve`. `room/updated` is out of scope (§7), and the Rust side never reports a connected child's exit code. So an engine that dies while `CONNECTED` is detected **only at the next user-triggered RPC**, which fails as R4 (typically `engine socket closed before response` or `socket write failed: …`) and is rendered per §6.4. Until then the UI keeps showing `○ CONNECTED` (neutral, never green, so nothing it shows overstates evidence). No background liveness polling is added.

---

## 7. Out of Scope (Deferred to M3-A4..A9)

- Live `room/updated` push subscription UI updates, Decisions resolution UI, Search results view, Transcript/replay inspector, bulk thread verification, and multi-seat composer (M3-A4..A8).
- Packaging / code signing (`bundle.active: false` stays unchanged; M3-A9).
- Changing `ALLOWED_RPC_METHODS` in `launcher.rs` (already `initialize`, `room/inspect`, `session/search`, `session/read`, `launcher.rs:35-40`), or any other edit to `launcher.rs` / `main.rs` (including a structured Rust error payload).
- Mock `"repo head"`, `"engine.lock"` or `"servedModel"` screens without real engine RPC backing.

---

## 8. Unverified Items (Fail-Closed)

1. **`UNVERIFIED`: Tauri v2 WebView `@font-face` under the current CSP.** `packages/desktop/src-tauri/tauri.conf.json` sets `"csp": "default-src 'self'; script-src 'self'; style-src 'self'"`. Under CSP Level 3, `font-src` falls back to `default-src 'self'`, which should allow local `./fonts/*.woff2`, but this hasn't been tested inside Tauri v2's WebKit/WebView2 asset protocol (`tauri://localhost` / `http://tauri.localhost`). **Fail-closed rule:** keep the CSP unchanged first. If the WebView blocks local woff2 in the smoke check, add only `font-src 'self'` (never `'unsafe-inline'`, never a remote origin) and record it in the PR body.
2. **`UNVERIFIED`: vendored woff2 byte footprint.** Iris estimates about 0.5 MB for the six Latin-subset files. **Fail-closed rule:** the builder verifies that `packages/desktop/ui/fonts/` totals ≤ 1 MB and contains both OFL 1.1 license files before PR review.
3. **`UNVERIFIED`: glass rendering.** `backdrop-filter` support in each platform WebView hasn't been checked. The spec §3.4 `@supports not (backdrop-filter: blur(1px))` fallback to opaque `--madc-lighter` covers any WebView without it. The builder records in the PR body which platforms were smoke-checked.

---

## 9. CI-Testable Acceptance Criteria

All checks run headless in the repo's `npm run check` (tsc, Biome, `node --test`, `bun test`), with tests in `packages/desktop/src/desktop.test.ts`, using **zero network, zero keychain, zero real TTY and zero live engine spawn** (injected fake `invokeFn` and the fake `ShellDocument` harness). `cargo test` is unaffected, because M3-A3 makes no Rust change.

1. **Tokens, files & zero network (static):** `ui/styles.css` `:root` defines the 11 spec §3.1 colour tokens with the exact hexes in §3.1 and the spec §3.2 tokens with their exact values (`--madc-radius-sm: 3px`, `--madc-radius-md: 4px`, `--madc-radius-lg: 6px`, both blur tokens). No colour hex literal appears in `ui/styles.css` outside `:root`, or anywhere in `ui/index.html`, `ui/*.js`. `ui/tokens.css`, `ui/palette.js` and `src/palette.ts` do not exist. No `http://` or `https://` appears anywhere in `ui/**/*.{html,css,js}` (comments included; spec §8.5 "grep `http`"). No protocol-relative URL appears where a URL is loaded: a `//` at the start of a CSS `url(…)` or `@import` argument, or of an HTML `src=`/`href=` attribute value. JS `//` line comments are **not** matched; the existing `packages/desktop/ui/shell.js:165` comment (`// M3 pin §4: no verified hash/sha/servedModel receipt yet -> tone stays neutral (no green).`) must pass. None of `innerHTML`, `outerHTML`, `insertAdjacentHTML` or `document.write` appears in `ui/*.js` (§2). Every `@font-face` uses `./fonts/` + `format("woff2")` + `font-display: block`, every referenced `.woff2` exists, and both license files exist.
2. **No decorative green (static + fake DOM):** in `ui/styles.css`, `#9ece6a`, `158 206 106`, `--madc-green` and `--madc-tone-fill-verified` occur only inside `:root` or in rules whose selector contains `[data-tone="verified"]`. No `.status-`, `.tone-`, `.green`, `.ok` or `.success` selector exists. With the fake harness, connecting via fake `connect_engine` + `room/inspect` with passing threads yields no element with `data-tone="verified"` and `#connection-status` `data-tone="neutral"`.
3. **Glass & pill geometry (static):** `backdrop-filter` occurs only in `.glass` rules and the spec §3.4 fallback blocks, never in a `.well` rule. Rules selecting `.pill[data-tone=…]` set only colour properties (`color`, `background`, `background-color`, `border-color`), so the four tones share one geometry (D6). The `@media (forced-colors: active)` block contains a rule whose selector is `.pill .pill-glyph`, and no rule anywhere selects `.glyph` (D8).
4. **Room table initial state (§4.3 A):** a fake `room/inspect` with four threads (`pass`; `warn`; `chain { ok:false, kind:"torn-tail", line:7 }`, `level:"fail"`; `chain { ok:false, kind:"integrity", line:11, reason:"prev hash mismatch" }`, `level:"fail"`) and `counts { threads:4, pass:1, warn:1, fail:2, openDecisions:0 }` renders `○ NO RECEIPT` (`neutral`), `▲ UNVERIFIED` (`warn`), `✗ FAILED` (`fail`, chip `torn tail` `line 7`, note `crash residue, not tamper`), and `✗ FAILED` (`fail`, chips `chain` `FAILED` + `line` `11`, note `prev hash mismatch`). The counts line reads `4 threads · 1 pass · 1 warn · 2 fail · 0 open decisions`, every `events` cell is `—`, and no `session/read` is invoked.
5. **On-demand `session/read` (Q4, §4.3 B):** selecting the `pass` row invokes `rpc_request` `{ method: "session/read", params: { threadId } }` exactly once (a second selection while pending does nothing). With `chainOk: true` and a 64-hex tail `hash`, only that row becomes `✓ VERIFIED` with `events` = `String(events.length)`. Selecting the torn-tail row with fake `{ chainOk: false, events: [] }` keeps `✗ FAILED`, keeps `events` `—` (never `0`), and adds chip `chainOk` `false`. A tail `hash: "short"` or `events: []` with `chainOk: true` renders `neutral`. A rejection `engine RPC error: {"code":-32002,…}` renders `✗ FAILED` with note `session/read: -32002 …` and leaves the connection `CONNECTED`. A following `Inspect room` discards all cached reads.
6. **`connect_engine` failure rendering (§6.2–§6.3):** fake `connect_engine` rejections using the exact launcher strings render as pinned. That means G1 (`madc-engine serve exited 20 (Owned { code: 20 }). Home lock held by PID 4182 (/h/engine.lock). Manual recovery: …\nstderr:\nmadc-engine serve: home owned by pid 4182: /h/engine.lock`) → `✗ FAILED`, chips `serve exit` `20 owned` + `pid` `4182`, `manualFix` text. G2 → `home owned by another process`, no `pid` chip. G3 with `code=Some(0)`, `Some(130)`, `Some(143)` → `○ DISCONNECTED`. G3 with `code=None, signal=Some(9)` → `▲ STOPPED`, `signal 9`. G3 with codes 2/21/22/23/24 → `✗ FAILED` with `<code> <kind>` (23 is `shutdown-deadline`). G3 with `Some(1)` → `24 internal-fault` + `raw` `1`. G4, G5 and G6 → `✗ FAILED`, raw text in `#output`. In every case `connect_engine` is invoked exactly once (no retry), and no code path touches `engine.lock`.
7. **Helper parity:** for every code in {0, 1, 2, 20, 21, 22, 23, 24, 99, 130, 143, `null`} and `null` + signal, `serveExitFromCode` deep-equals `classifyServeExit({ code, signal })` from `src/ipc.ts`. For fixed stderr samples (matching line, no line, malformed pid, multiple lines), `lockOwnerGuidanceFromStderr` deep-equals `parseLockOwnerGuidance`. `EXPECTED_PROTOCOL_VERSION === PROTOCOL_VERSION` (`@madc/engine/client`).
8. **Connect single-flight & state (D4, §6.1):** while a fake `connect_engine` is pending, `#connect-btn` is disabled, the palette `Connect` command is `aria-disabled="true"`, and a second `connect()` does not invoke `connect_engine` again. A protocol-mismatch `ConnectionInfo` renders the `protocol` chip, invokes `disconnect_engine` once and skips `room/inspect`.
9. **`rpc_request` failures (§6.4):** R2 → `○ DISCONNECTED`. R3 → stays `CONNECTED`. R4 (`engine socket closed before response`, `RPC room/inspect timed out waiting for reply`, `socket read failed: x`) → `✗ FAILED` and exactly one `disconnect_engine`, with zero further `connect_engine` / `rpc_request` calls. While that fake `disconnect_engine` is pending, `#connect-btn` is `disabled`, the palette `Connect` is `aria-disabled="true"`, and a second R4 or a user Disconnect issues no second call. After it resolves, Connect is enabled and the state is still `FAILED`. If it rejects (`engine state lock poisoned`), the text lands in `#output`, the state is `FAILED`, Connect is enabled, and `disconnect_engine` was invoked exactly once. A request from the previous epoch that rejects `not connected to @madc/engine` after the cleanup leaves the state `FAILED`.
10. **Palette (spec §7, §8.5):** `Cmd+K` (macOS) / `Ctrl+K` (non-macOS) toggles. `Esc` closes and restores the prior focus. `↑`/`↓` wrap and skip disabled rows. `Home`/`End` reach the first and last enabled rows. Filtering is a case-insensitive subsequence over command names only (e.g. `insrm` matches "Inspect room"; the group name `evidence` matches no command). The empty state works. Command IDs equal exactly the nine spec §7.3 commands.
11. **Focus bar continuity (Q1, Q2):** the M3-A2 shipped-UI test (`desktop.test.ts:125-263`) passes with its existing assertions unchanged except the `className` → `data-tone` edits, using only the harness extensions permitted in §2.
12. **Window minimum (Q5):** `tauri.conf.json` has `app.windows[0].minWidth === 960`, `minHeight === 640`, `width === 1200`, `height === 800`, `resizable === true`, `bundle.active === false`, and a CSP equal to the current string (or that string plus only `font-src 'self'`, per §8.1).
13. **Receipts well honesty:** with no receipts and no errors, the Receipts well has no rows and contains no `servedModel`, `repo head` or `engine.lock` text.

---

## 10. Review Dispositions (r2)

Argus r1 (`/workspace/madc-reviews/m3-a3-design-pin-argus/r1/ARGUS-r1-m3-a3-design-pin-1fd6e78e.md`) and Copilot review `6076775854` (2026-11-26 10:29 AM ET), both at `1fd6e78e`. The verbatim spec is untouched; every fix is in this pin or the pointer files.

| Finding | Disposition |
| --- | --- |
| H1.1 `backdrop-filter` ban | Removed. Glass is required on tier 2 with the spec fallbacks (§3.2); test §9.3. |
| H1.2 colour token diffs | Replaced with the spec's 11 tokens and hexes (§3.1); `--madc-bg-elev`, `--madc-border-hi` and the renamed tone tokens are gone. |
| H1.3 2px radius | `--madc-radius-sm: 3px`, plus `md` 4px and `lg` 6px (§3.2). |
| H1.4 `tokens.css` | Tokens live in `ui/styles.css` only (§3); test §9.1 asserts there is no `tokens.css`. |
| H1.5 `.tone-verified` / `.status-*` | `[data-tone]` only (§4.1); `.status-*` removed; M3-A2 test assertions migrate (§2). |
| H1.6 `font-display: swap` | `block` (§3.3). |
| H1.7 320–360px / single column at 960–1079px | Spec §5.3–§5.4: `minmax(0,1fr) 440px`, `minmax(360px,440px)` at 960–1199px, two columns down to the 960px minimum (§5.1–§5.2). |
| H1.8 `palette.js` / `palette.ts` | Helpers in `ui/shell.js` / `shell.d.ts`; `app.js` only wires the key (§5.5). |
| H1.9 substring filter | Subsequence on the command name only (§5.5). |
| H1.10 command list diff | Exactly the spec §7.3 list: `Read selected thread` removed, `Copy served model` restored (§5.5; D7). |
| H1.11 `#connection-status` placement | It is the glass status strip with `data-tone`; the Engine card has its own pill (§5.1, §6.1). |
| M1 `connect_engine` classification | Option (a): pinned string grammars G1–G6 against live `launcher.rs`/`main.rs` text, plus parity-tested JS ports of `classifyServeExit`/`parseLockOwnerGuidance` in `shell.js`; no Rust or `ipc.ts` change (§6.2; D5; tests §9.6–§9.7). |
| M2 failure mapping | Spec §6.5 adopted in full (§6). Added exit 2, clean 0/130/143, signal `stopped`, 5 s start timeout (G4), exit 20 without guidance (G2), protocol mismatch, Windows refusal (G5), allowlist refusal (R1), `not connected` (R2), `-32002`/`-32602` (R3), 10 s timeout / transport loss (R4), engine death while connected (§6.5). Exit 23 is `shutdown-deadline`. Chip is `<code> <kind>`. "UI never deletes `engine.lock`" is restated (§6.3). Connect is disabled while connecting (§6.1; D4). |
| M3 torn-tail contradiction | Torn tail is `fail` before and after a read, matching `inspectRoom` and the counts line; `events` stays `—` whenever `chainOk` is false; no unreachable branch (§4.3; D1; test §9.4–§9.5). |
| L1 `ipc.ts:192-197` cite | Now `DesktopEngineClient.sessionRead` at `ipc.ts:211-216` (§1.1 Q4). |
| L2 `chain.kind "io"` | Removed; the union is `"torn-tail" \| "integrity"` (`session-store.ts:1129`) (§4.3). |
| L3 Q2 Tab vs palette trap | Q2 now says "while the palette is closed" / "while open … trapped" (§1.1). |
| L4 README row for the spec | Added `sources/DESIGN-SPEC-m3-a3-precision-instrument-glass.md` index row in `docs/plan/README.md`. |
| Info: `Amended by` Q1–Q6 nit | Protocol-pin pointer now says Q1/Q2/Q3/Q6 Founder-approved and Q4/Q5 Surface Architect rulings approved by the Founder. |
| Info: stale "on Founder go-ahead" / acceptance named only `bun test`/`cargo test` | Header now says "Repo paths (this PR)"; §9 names `npm run check` (incl. `node --test`). |
| Copilot spec:475 Connect while connecting | Fixed in the pin (spec is verbatim): disabled while `CONNECTING` + single-flight (§6.1; D4). |
| Copilot pin:69 `tokens.css` | = H1.4. |
| Copilot pin:90 `backdrop-filter` | = H1.1. |
| Copilot pin:172 breakpoints | = H1.7. |
| Copilot pin:190 palette files | = H1.8. |
| Copilot pin:192 filter | = H1.9. |
| Copilot pin:201 `Read selected thread` | = H1.10; Q4 reads are triggered by row selection only (D7). |
| Copilot pin:71 "Tokyo Night Night" | Heading now reads "Tokyo Night" (§3.1). |

**r3 (Argus r2 at `cb77272a`, report `/workspace/madc-reviews/m3-a3-design-pin-argus/r2/ARGUS-r2-pr78-cb77272a.md`; Copilot review `6077475089`, 11:22 AM ET).** All r1 findings were closed in r2; r3 changes only this pin.

| Finding | Disposition |
| --- | --- |
| N1 (Medium): the two-edit allowance couldn't support the pinned UI on the fake harness | §2 now keeps every existing assertion byte-for-byte except the `className` → `data-tone` edits. It permits standard-DOM-named extensions to `ShellDocument`/`ShellElement` in `shell.d.ts` and matching fakes in `desktop.test.ts` (`createElement`, `appendChild`, `replaceChildren`, `removeAttribute`, `hasAttribute`, `children`, `hidden`, `disabled`, `inert`, `title`, `activeElement`), new `byId` IDs, and nothing else. It also pins `createElement` + `textContent` rendering, with no `innerHTML`, and §9.1 tests that. §9.11 is updated to match. |
| N2 (Low): forced-colors `.pill .glyph` doesn't match `.pill-glyph` markup (Copilot spec:180) | New deviation D8 (§1.3) uses `.pill .pill-glyph`. §3.2 points to it. §9.3 asserts the selector and that no `.glyph` rule exists. The verbatim spec is untouched. |
| N3 (Low): R4 `disconnect_engine` sequencing | New §6.1 cleanup rule: `disconnect_engine` is single-flight and non-blocking; Connect/Disconnect stay disabled while it is pending; resolve → state per cause; reject → `#output`, `FAILED`, no retry; a connection epoch stops stale R2 rejections from flipping the state. §6.4 R4 states that cleanup stops a desktop-spawned `serve`, even after a 10 s timeout on a slow engine. D4, the §5.5 table and test §9.9 are updated. |
| N4 (Low): the `//` ban would trip on `shell.js:165` | §9.1 now bans `http://`/`https://` everywhere plus protocol-relative URLs only in CSS `url(`/`@import` and HTML `src=`/`href=`. JS `//` comments are explicitly not matched, and the `shell.js:165` comment must pass. |
| Copilot spec:475 thread (still open on GitHub) | Already fixed in r2 by D4 and §6.1; r3 tightens it with the cleanup rule. The thread needs a reply and a resolve on GitHub, because the comment is anchored on the verbatim spec. |

**r4 (2026-11-27; Argus r1 `M1` on PR #79 at `066d620b1aedeea2fb0f19d123e695d2c752335c`, merged as `12682017e3ee29132199dc8694e78f6768ae454e`).** Docs-only pin amendment; the verbatim spec is untouched.

| Finding | Disposition |
| --- | --- |
| Argus r1 `M1` (Medium, contract; PR #79 @ `066d620b`, merged as `12682017`) | New deviation D9 (§1.3) records the shipped `960–1199px` band layout, `-webkit-backdrop-filter` pairing, and the deferred §5.4 clipping follow-ups. §5.2 points to D9. Closes `D-691`, `D-695`, and conflict `C52` on Founder merge of this amendment. |
| Clio `D-692` | Records the Founder's accepted ruling to defer multi-chip receipt clipping and the `exit-20` Receipts-well `pid` clip to a post-M3-A3 §5.4 follow-up (D9). |
| Clio `D-693` | Documented in D9 as a carried post-M3-A3 §5.4 layout follow-up (not an M3-A3 blocker): multi-chip clipping below ~1266px (including default `1200×800`) and the `exit-20` `pid` chip clip / 0px note at `960px`. |
| Clio `D-694` | Documented in D9: Safari < 18 opaque fallback under the verbatim `@supports not (backdrop-filter: blur(1px))` block is accepted as-is (Tauri on current macOS runs WebKit 27.2+; no spec §3.4 amendment). Closes on Founder merge of this amendment. |
| Clio `D-686` (Argus r3 N5) | §6.4 R2 now states that a stale-epoch R2 rejection does not flip the current connection state (N5 connection-epoch guard in §6.1). |

