# PIN: MADC M3-A3 Design System & Evidence-Bound Primitives (Precision Instrument Glass)

- **Status:** **DRAFT** — not binding until the Founder merges a PR naming this pin's exact head SHA.
- **Author:** Surface Architect
- **Date:** 2026-11-26
- **Milestone / Act:** M3 / Act M3-A3 ("Visual system & evidence-bound primitives")
- **Decisions addressed:** Closes **D-618** (M3 §4 Iris citation gap), fulfills **D-189** (design spec pinned before UI build) and **D-672** (M3-A3 gate), preserves **D-626** (evidence-bound UI rule), and closes **M0 Q17** (M3 status-color / toolbar supersession).
- **Proposed repo paths (on Founder go-ahead):**
  - Pin: `docs/plan/PIN-madc-M3-design-precision-instrument-glass.md`
  - Verbatim approved spec: `docs/plan/sources/DESIGN-SPEC-m3-a3-precision-instrument-glass.md`
  - Pointer edits: one `Amended by PIN-madc-M3-design-precision-instrument-glass.md` line under the status block of `docs/plan/PIN-madc-M3-desktop-protocol.md` (closing D-618 on §4) and one index row in `docs/plan/README.md`.

## Verified Base & Source Identities

- **Repository base:** `MADVenturesLLC/MADC` `main` @ `9333fe9812a1d983aa92f2e4e89794bf9ef9d231` (PR #76, M3-A2 merged).
- **Referenced repo blob SHAs at `9333fe98`:**
  - `docs/plan/PIN-madc-M3-desktop-protocol.md`: `8e6a59f1127582029445cc3574751bf20fac3b5b`
  - `docs/plan/PIN-madc-M3-desktop-protocol-amendment-1.md`: `3047bf3f59c68329f838bfc63fe32f3f4aa3a266`
  - `docs/plan/PIN-madc-M0-design-omarchy-git-panel.md`: `c05b5464128d9b212fb3639b3ea88af0c518a131`
  - `docs/plan/sources/DESIGN-SPEC-omarchy-git-panel.md`: `1fd8819c07233a34f7bfcfc1833daee2ba928fc4`
  - `docs/plan/PLAN-madc-M3-build-plan.md`: `f58d10cf23a64b3658951f6f97ef72f149559dab`
  - `docs/plan/ROADMAP-madc-post-M0.md`: `71dfb31a1779b9d37a2dea9876907eac8d777099`
- **Approved Iris design artifacts (Michael Daley approved 2026-11-26 with all recommended rulings):**
  - Spec: `DESIGN-SPEC-m3-a3-precision-instrument-glass.md` — sha256 `98be29ad778a7d8f136dc103b2defc63082d14159b6b544ed25ffb3a5e4fa37d`
  - Visual source of truth: `direction-c.png` (2880×1800 / 1440×900 @2x) — sha256 `56260fa81215747062b5d4776f376108f852e0b389818d09a611d77ad5619e29`
  - Reference CSS (`c.css`): sha256 `a05c4683bec254a4702d8d33e1ff798e0aa0c76f3c9ac201f55d2b080a7ed56c`
  - Reference CSS (`base.css`): sha256 `90a20150bc4565ee01af513254def9f3163404e3ae4f51dcc11f136792836e00`
  - Reference mock markup (`body.html`): sha256 `4f849a2497a355d82d5f8ff75e2d458451b34088decfb85cc264131f0e746371`

---

## 1. Rulings Table (Iris §9 Questions & §0 Text-over-Frame Precedence)

| Item | Topic | Disposition | Ruling & Authority |
| --- | --- | --- | --- |
| **Q1** | M3 status colors & focus bar vs. `ROADMAP-madc-post-M0.md:92` and M0 `DESIGN-SPEC-omarchy-git-panel.md` §10 | **ACCEPT** (Founder approved 2026-11-26) | M3 evidence-bound status colors (strictly gated through `evidenceTone`) and the M3-A2 focus bar (`role="toolbar"`) supersede `ROADMAP:92` ("no status colors") and M0 SPEC §10 ("no toolbar") for M3 desktop surfaces. Closes **M0 Q17**. |
| **Q2** | Command palette shortcut (`Cmd+K` / `Ctrl+K`) | **ACCEPT** (Founder approved 2026-11-26) | `Cmd+K` on macOS (`metaKey && !ctrlKey`) and `Ctrl+K` on Linux/Windows (`ctrlKey && !metaKey`), case-insensitive `'k'`, toggles/opens the desktop command palette. `Tab` / `Shift+Tab` keep standard focus order; `Esc` closes the palette when open and restores focus to the trigger element (otherwise keeps existing role). |
| **Q3** | `#0e0e14` (`--madc-darker`) inside the window | **ACCEPT** (Founder approved 2026-11-26) | `#0e0e14` is permitted inside the window for the title bar and recessed data wells (Room table well, Receipts well) as well as the backdrop behind the window. |
| **Q4** | Room table from `room/inspect` + on-demand `session/read` for `hash` receipt | **MODIFY (ACCEPT WITH SCOPE CONSTRAINT)** (Surface Architect ruling) | M3-A3 renders the Room table from `room/inspect` (`RoomReport.threads`). Because `RoomThreadRow` (`packages/engine/src/inspect.ts:136-154`) carries neither `hash` nor an `events` count, every row starts without a hash receipt (`○ NO RECEIPT`, `▲ UNVERIFIED`, or `✗ FAILED`) and renders `—` in the `events` column. `session/read` (already allowlisted in `launcher.rs:35-40` and wired in `ipc.ts:192-197`) is invoked **only on explicit user selection of a single thread** (click/Enter on row or palette command) to populate `events.length` and attempt a `{ kind: "hash", chainOk, hash }` receipt. **Never** call `session/read` in a poll loop, automatically on connect, or in bulk across all rows (bulk verification and replay inspector remain M3-A7). |
| **Q5** | `minWidth: 960, minHeight: 640` in `packages/desktop/src-tauri/tauri.conf.json` | **ACCEPT** (Surface Architect ruling) | Permitted in M3-A3 as a narrow edit to `app.windows[0]` in `packages/desktop/src-tauri/tauri.conf.json`. `width: 1200`, `height: 800`, `resizable: true`, `bundle.active: false`, and CSP remain unchanged (see §8 for font CSP verification). |
| **Q6** | Local vendoring of IBM Plex Sans + JetBrains Mono woff2 | **ACCEPT** (Founder approved 2026-11-26) | Vendor IBM Plex Sans (400/500/600) and JetBrains Mono (400/500/600) woff2 files (SIL OFL 1.1) plus their license texts under `packages/desktop/ui/fonts/`. Zero external font CDNs, zero runtime network requests. |

### Text-over-Frame Precedence (Iris §0, Binding)

Where `direction-c.png` differs from the spec text, the spec text wins on these five points:
1. Monospace face is **JetBrains Mono** (the reference frame rendered IBM Plex Mono).
2. Status pill border width is **`1px`** (the reference frame drew `1.5px`).
3. Command palette filter prompt glyph is **`>`** (the reference frame drew `❯`).
4. Command palette shortcut is **`Cmd+K`** (macOS) / **`Ctrl+K`** (Linux/Windows) (the reference frame hint shows `Ctrl K`).
5. The `"repo head"` and `"engine.lock"` receipt rows in `direction-c.png` are illustrative mock rows, **not** required M3-A3 screens; M3-A3 binds only to real engine data (`connect_engine`, `room/inspect`, on-demand `session/read`, and real launcher error output).

---

## 2. Supersession & Continuity

- **Superseded for M3 desktop only:**
  - `docs/plan/ROADMAP-madc-post-M0.md:92` ("I would keep it read-only, with no status colors") — superseded by Q1; M3 desktop uses evidence-bound semantic tones strictly via `evidenceTone`.
  - `docs/plan/sources/DESIGN-SPEC-omarchy-git-panel.md` §10 ("no toolbar") — superseded by Q1 for M3 desktop; the M3-A2 focus bar (`nav#focus-bar[role="toolbar"]`) is retained and styled.
- **Unchanged and still binding:**
  - `docs/plan/PIN-madc-M0-design-omarchy-git-panel.md` for M0/M1/M2 CLI surfaces (stays frozen).
  - `docs/plan/PIN-madc-M3-desktop-protocol.md` §1–§3 and Amendment 1 (socket, `madc-engine serve`, `engine.lock`, allowlist, no auto-retry, exit codes).
  - `docs/plan/PIN-madc-M3-desktop-protocol.md` §4 evidence-bound rule (**D-626**), now backed by this pin (closing **D-618**).
  - M3-A2 exported JS/TS symbols and DOM hooks (`packages/desktop/src/evidence.ts`, `packages/desktop/src/focus-bar.ts`, `packages/desktop/ui/shell.js`) must remain backward-compatible for existing M3-A2 tests unless explicitly extended below.

---

## 3. Visual Token Contract

All visual tokens live in `packages/desktop/ui/tokens.css` (imported by `packages/desktop/ui/styles.css` or linked ahead of it in `packages/desktop/ui/index.html`). No hardcoded color hexes in component rules outside `tokens.css`.

### 3.1 Color Tokens (Tokyo Night Night, Exact Hex)

| Token | Value | Role |
| --- | --- | --- |
| `--madc-darker` | `#0e0e14` | Backdrop, title bar, recessed data wells (Room table, Receipts well) (Q3) |
| `--madc-bg` | `#1a1b26` | Window canvas, card surface, palette surface |
| `--madc-bg-elev` | `#1e202e` | Hover / elevated row, focus-bar strip, status strip |
| `--madc-surface` | `#24283b` | Recessed chip/badge fill, focused/selected row fill, active tab fill |
| `--madc-border` | `#292e42` | 1px structural hairlines (cards, wells, dividers, inactive pills) |
| `--madc-border-hi` | `#3b4261` | Focused borders, active keycaps, hover borders, palette frame |
| `--madc-fg` | `#c0caf5` | Primary ink (body, values, headings) |
| `--madc-muted` | `#565f89` | Secondary labels, uppercase section headers, inactive icons/hints |
| `--madc-dim` | `#414868` | Tertiary metadata, separator dots, placeholders |
| `--madc-accent` | `#7aa2f7` | Focus rings, active focus-bar underline, active palette highlight |
| `--madc-verified` | `#9ece6a` | **Gated:** `evidenceTone === "verified"` ONLY |
| `--madc-warn` | `#e0af68` | **Gated:** `evidenceTone === "warn"` ONLY |
| `--madc-fail` | `#f7768e` | **Gated:** `evidenceTone === "fail"` ONLY |

Hard bans:
- No `backdrop-filter: blur(...)`, no neon glow (`box-shadow` with colored spread), no decorative gradients, no pure `#000000` or `#ffffff`.
- Radius scale: `--madc-radius-sm: 2px` (keycaps, receipt chips, pills), `--madc-radius-md: 4px` (cards, wells, buttons, palette). No pill-shaped (`9999px`) badges.

### 3.2 Typography & Vendored Fonts (Q6)

Vendor woff2 files and SIL OFL 1.1 license files under `packages/desktop/ui/fonts/`:
- `IBM Plex Sans`: weights `400`, `500`, `600` (`--madc-font-sans: "IBM Plex Sans", system-ui, -apple-system, sans-serif`).
- `JetBrains Mono`: weights `400`, `500`, `600` (`--madc-font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace`).
- `LICENSE-IBM-PLEX.txt` and `LICENSE-JETBRAINS-MONO.txt` checked in beside the woff2 files.
- `@font-face` declarations use `url("./fonts/<file>.woff2") format("woff2")` and `font-display: swap`.
- Numeric columns (`events`, `line`, `exit`, `coldStartMs`, counts) MUST use `font-variant-numeric: tabular-nums`.
- Zero remote URLs (`http://`, `https://`, `data:` external font loaders) anywhere in `packages/desktop/ui/`.

---

## 4. Evidence-Bound Primitives & `evidenceTone` Invariant

### 4.1 Hard Gate (D-626)

Every status badge, pill, dot, or colored indicator in `packages/desktop/ui/` MUST derive its visual tone from `evidenceTone(receipt, hint)` in `packages/desktop/ui/shell.js` (re-exported by `packages/desktop/src/evidence.ts`).

- `evidenceTone` returns one of four tones: `"verified" | "neutral" | "warn" | "fail"`.
- `"verified"` is reachable **if and only if** `hint` is neither `"warn"` nor `"fail"` AND `isVerifiedReceipt(receipt)` returns `true`:
  - `{ kind: "hash", chainOk: true, hash: /^[0-9a-f]{64}$/ }`
  - `{ kind: "sha", sha: /^[0-9a-f]{40}$/ }`
  - `{ kind: "servedModel", vendorReported: true, servedModel: <non-empty trimmed string> }`
- **No decorative green:** CSS classes `.tone-verified` / `.status-verified` (and `--madc-verified`) may ONLY be applied when `evidenceTone(...) === "verified"`. Connected engine status (`connect_engine`) without a verified receipt MUST stay `"neutral"` (never green).
- **Never accept a caller-supplied `verified: boolean`** in any UI helper or component API.

### 4.2 Evidence Pill Primitive

Every Evidence Pill renders:
1. A fixed-width icon glyph slot (`✓` for `verified`, `○` for `neutral`, `▲` for `warn`, `✗` for `fail`) — tone is never communicated by color alone.
2. An uppercase monospace label:
   - `verified` → `VERIFIED`
   - `neutral` → `NO RECEIPT` (or `CONNECTED` / `IDLE` on the Engine panel chip, always styled with `neutral` ink/border — never green)
   - `warn` → `UNVERIFIED`
   - `fail` → `FAILED`
3. A `1px` solid border (`--madc-border` for `neutral`, semantic tone color for `verified`/`warn`/`fail`) and recessed fill (`--madc-surface` or subtle semantic tint at ≤12% opacity over `--madc-darker`).

### 4.3 `RoomThreadRow` → Tone & Receipt Mapping (Exact)

Given a `RoomThreadRow` from `room/inspect` (`packages/engine/src/inspect.ts:136-154`) and an optional cached `session/read` result `{ threadId, events, chainOk }` for that `threadId`:

1. **Before `session/read` for a row:**
   - `events` cell renders `—` (never `0` or a guessed count).
   - If `row.chain.ok === false` and `row.chain.kind === "torn-tail"`:
     - `hint = "warn"` → tone `"warn"` (`▲ UNVERIFIED`), receipt chip `torn tail` + `line <row.chain.line>` + `"crash residue, not tamper"`.
   - Else if `row.chain.ok === false` (e.g. `row.chain.kind === "integrity"` or `"io"`) or `row.level === "fail"`:
     - `hint = "fail"` → tone `"fail"` (`✗ FAILED`), receipt chip `chain` + `FAILED` + optional `line <row.chain.line>` + verbatim reason.
   - Else if `row.level === "warn"`:
     - `hint = "warn"` → tone `"warn"` (`▲ UNVERIFIED`), receipt chip `session/read not run` (plus finding summary if present).
   - Else (`row.level === "pass"` and `row.chain.ok === true`, no hash yet):
     - `evidenceTone(null, "neutral")` → tone `"neutral"` (`○ NO RECEIPT`), receipt chip `hash —` + `session/read not run`.

2. **After user-triggered `session/read({ threadId })` succeeds for that row:**
   - `events` cell renders `String(res.events.length)` (`tabular-nums`).
   - Extract `tailHash = res.events.length > 0 ? res.events[res.events.length - 1]?.hash : null`.
   - Build candidate receipt `res.chainOk === true && typeof tailHash === "string" ? { kind: "hash", chainOk: true, hash: tailHash } : null`.
   - Compute `rowHint`:
     - `"fail"` if `res.chainOk === false` or `row.level === "fail"` or (`row.chain.ok === false && row.chain.kind !== "torn-tail"`),
     - `"warn"` if `row.level === "warn"` or (`row.chain.ok === false && row.chain.kind === "torn-tail"`),
     - `"ok"` otherwise.
   - Tone is `evidenceTone(receipt, rowHint)`:
     - If `"verified"`: renders `✓ VERIFIED` with receipt chips `hash <tailHash.slice(0, 12)>` (full 64-hex in `title` / copy action) and `chainOk true`.
     - If `res.events.length === 0` or `tailHash` fails `/^[0-9a-f]{64}$/`: `isVerifiedReceipt` returns `false`, so tone fails closed to `"neutral"` (`○ NO RECEIPT`, chip `hash —`) or `"fail"` if `res.chainOk === false`.
   - If `session/read` rejects (RPC error or transport error): row does NOT turn green; render inline error detail and keep `hint = "fail"` or prior failed state.

---

## 5. Surface Primitives & Layout Contract

### 5.1 Shell Chrome & Focus Bar

- **Title bar / header strip (`--madc-darker`):** app title `MADC DESKTOP` and active socket path indicator (e.g. `~/.madc/engine.sock` or actual `info.socketPath` returned by `connect_engine`, `—` before connect).
- **Focus bar (`nav#focus-bar[role="toolbar"]`):** preserves M3-A2 `data-focus-id` values (`"connection"`, `"room"`, `"decisions"`, `"search"`), roving `tabIndex` (`0` on active, `-1` on inactive), `aria-pressed`, and keyboard handling (`ArrowRight`, `ArrowLeft`, `Home`, `End`, `Tab`, `Shift+Tab`). Active item has a `2px` bottom `--madc-accent` rule.
- **Shortcut hints (right side of focus bar):** keycap chips (`Tab`, `←`, `→` move; `Cmd K` on macOS or `Ctrl K` on Linux/Windows commands).

### 5.2 Workspace Grid & Responsive Breakpoint

- Desktop default (`≥ 1080px`): two-column grid — primary left pane (`minmax(0, 1fr)`, Room table well + Receipts well) and right Engine side panel (`320px–360px` fixed).
- Compact (`960px–1079px`): single-column stack (Engine panel stacks cleanly below or above primary pane without horizontal overflow).
- Window minimum: `minWidth: 960, minHeight: 640` in `packages/desktop/src-tauri/tauri.conf.json` (Q5).
- Status strip (bottom bar, `--madc-bg-elev`, `1px` top `--madc-border`): engine socket label, neutral/fail connection state text, and `coldStartMs` when connected.

### 5.3 Room Table Well & On-Demand `session/read` (Q4)

- Recessed well (`--madc-darker`, `1px` `--madc-border`, `4px` radius).
- Header summary: `room/inspect` counts (`<N> threads · <P> pass · <W> warn · <F> fail · <D> open decisions`) sourced directly from `RoomReport.counts`.
- Columns: `EVIDENCE` (`148px`), `THREAD` (`100px+`), `SEAT` (`108px`), `EVENTS` (`48px`, right-aligned `tabular-nums`, `—` until `session/read`), `RECEIPT` (`1fr`).
- Selecting a row (click or `Enter` when focused) highlights the row (`--madc-surface`) and invokes `rpc_request("session/read", { threadId })` once for that thread (deduped while in-flight). Never polls and never fans out across all rows.
- Empty room (`threads.length === 0`): renders a neutral empty-state row (`No threads in $MADC_HOME/sessions`).

### 5.4 Engine Panel & Receipts Well

- **Engine panel:** preserves `#connection-status` and `#connect-btn` (plus a Disconnect button calling `disconnect_engine` when connected), displays `socketPath`, `protocolVersion`, `coldStartMs`, and neutral `CONNECTED` / `IDLE` chip (`neutral` tone, never green).
- **Receipts well:** renders only real receipts currently held in memory (e.g., verified `hash` receipts earned via on-demand `session/read`, or launcher exit-code failure rows when `connect_engine` fails). When no receipts have been earned yet, renders a neutral empty state (`No verified receipts yet — select a thread to run session/read`). Does **not** fabricate `servedModel`, `repo head`, or `engine.lock` rows.

### 5.5 Command Palette (`Cmd+K` / `Ctrl+K`, Q2)

- Pure state controller in `packages/desktop/ui/palette.js` (typed re-export in `packages/desktop/src/palette.ts`) so it is CI-testable without a WebView.
- **Open/Toggle:** `Cmd+K` (macOS) or `Ctrl+K` (Linux/Windows). Records `previouslyFocusedElement` on open.
- **Filter input:** monospace prompt `>` (not `❯`), case-insensitive substring match against command label, group, and keywords; live-filters visible items and resets active index to `0`.
- **Keyboard navigation inside palette:**
  - `ArrowDown` / `ArrowUp`: move selection (wraps cleanly).
  - `Enter`: execute selected command and close palette (restoring focus unless the command intentionally moves focus, e.g. Focus Room/Engine/Decisions/Search).
  - `Esc`: close palette without executing and restore focus to `previouslyFocusedElement`.
  - `Tab` / `Shift+Tab`: kept trapped within palette dialog while open (`role="dialog"`, `aria-modal="true"`), never leaking to background controls.
- **M3-A3 command set (all wired to real M3-A2/A3 capabilities only):**
  - Engine group: `Connect to @madc/engine` (manual, no retry), `Inspect room` (`room/inspect`, disabled when disconnected), `Disconnect` (`disconnect_engine`, disabled when disconnected).
  - Focus group: `Focus Engine`, `Focus Room`, `Focus Decisions`, `Focus Search`.
  - Evidence group: `Read selected thread` (`session/read` on selected row, disabled if none selected or disconnected), `Copy chain head` (copies full 64-hex hash of selected verified thread, disabled if selected thread has no verified hash).
- Disabled commands are visibly muted (`aria-disabled="true"`) and skipped or no-op on `Enter`.

---

## 6. Failure & Refusal Mapping

- **Engine connect / launcher failure (`connect_engine` rejects):**
  - Classify exit code using existing `classifyServeExit` and `parseLockOwnerGuidance` (`packages/desktop/src/ipc.ts` / shared helper):
    - Exit `20` (owned/live lock): `✗ FAILED` pill (`fail`), chip `serve exit 20 owned`, display parsed PID/home recovery text and `"no automatic retry"`.
    - Exit `21` (unsafe socket/lock path), `22` (listen/path-length failed), `23`/`24` (internal fault): `✗ FAILED` pill (`fail`), chip `serve exit <code>`, verbatim reason line, `"no automatic retry"`.
  - Never auto-retry `connect_engine` or `rpc_request`.
- **`room/inspect` or `session/read` RPC failure:**
  - Surface `-32602` / transport error text in the status/error area with `fail` tone; never leave a stale `verified` badge on a thread whose re-read failed.
- **Font load failure:**
  - Falls back cleanly to `system-ui` / `ui-monospace` via `font-display: swap`; never makes an external network request.

---

## 7. Out of Scope (Deferred to M3-A4..A9)

- Live `room/updated` push subscription UI updates, Decisions resolution UI, Search results view, Transcript/replay inspector, bulk thread verification, and multi-seat composer (M3-A4..A8).
- Packaging / code signing (`bundle.active: false` stays unchanged; M3-A9).
- Changing `ALLOWED_RPC_METHODS` in `launcher.rs` (already contains `initialize`, `room/inspect`, `session/search`, `session/read`).
- Adding mock `"repo head"` or `"servedModel"` screens without real engine RPC backing.

---

## 8. Unverified Items (Fail-Closed)

1. **`UNVERIFIED` — Tauri v2 WebView `@font-face` under current CSP:** `packages/desktop/src-tauri/tauri.conf.json` currently sets `"csp": "default-src 'self'; script-src 'self'; style-src 'self'"`. Per CSP Level 3, `font-src` falls back to `default-src 'self'`, which should allow local `./fonts/*.woff2`, but this has not yet been tested inside Tauri v2's WebKit/WebView2 asset protocol (`tauri://localhost` / `http://tauri.localhost`). **Fail-closed rule:** keep CSP unchanged first; if Tauri WebView blocks local woff2 in smoke verification, add only `font-src 'self'` (never `'unsafe-inline'`, never remote origins) and record it in the PR body.
2. **`UNVERIFIED` — Exact vendored woff2 byte footprint:** Iris estimates ~0.5 MB for IBM Plex Sans (400/500/600) + JetBrains Mono (400/500/600) Latin subsets. **Fail-closed rule:** builder must verify total `packages/desktop/ui/fonts/` size is ≤ 1 MB and contains both OFL 1.1 license files before PR review.

---

## 9. CI-Testable Acceptance Criteria

All checks run headless in CI (`bun test` / `cargo test`) with **zero network, zero keychain, zero real TTY, and zero live engine spawn** (using injected fake `invokeFn` and DOM/pure-state harnesses):

1. **Token & zero-network audit:** Static test verifies `packages/desktop/ui/tokens.css` defines all 13 exact hex tokens from §3.1, no `http://` or `https://` URLs appear in `packages/desktop/ui/**/*.{html,css,js}`, no `backdrop-filter` appears in `packages/desktop/ui/**/*.css`, and all vendored `.woff2` files referenced by `@font-face` exist under `packages/desktop/ui/fonts/` alongside `LICENSE-IBM-PLEX.txt` and `LICENSE-JETBRAINS-MONO.txt`.
2. **No decorative green invariant:** Unit + DOM test asserts that connecting via fake `invokeFn("connect_engine")` and rendering a `room/inspect` response with passing threads produces **zero** elements with `.tone-verified` or `.status-verified` until a verified receipt is present; connection status stays `neutral`.
3. **Room table initial state (`room/inspect` without `session/read`):** Fake `room/inspect` containing four threads (`pass`, `warn`, `torn-tail`, `integrity` fail) renders: `○ NO RECEIPT` (`neutral`), `▲ UNVERIFIED` (`warn`), `▲ UNVERIFIED` (`warn`, `torn tail` + `line N`), and `✗ FAILED` (`fail`, `chain FAILED` + `line N`), with `events` displaying `—` on every row and zero automatic `session/read` calls.
4. **On-demand `session/read` verification (Q4):** Selecting the passing thread invokes `rpc_request` with `{ method: "session/read", params: { threadId } }` exactly once, updates `events` to `events.length`, and promotes ONLY that row to `✓ VERIFIED` (`verified`) when `chainOk === true` and tail `hash` matches `/^[0-9a-f]{64}$/`.
5. **Fail-closed on bad/empty `session/read`:** Fake `session/read` returning `chainOk: false`, empty `events: []`, or malformed `hash: "short"` never produces `verified` (`chainOk: false` → `fail`; empty/malformed hash → `neutral`).
6. **Palette shortcut & keyboard state machine (Q2):** Unit + DOM tests on `palette.js` verify `Cmd+K` (macOS) / `Ctrl+K` (non-macOS) opens palette with `>` prompt, typing filters commands, `ArrowDown`/`ArrowUp` wraps, `Enter` runs enabled command and skips/no-ops disabled commands, and `Esc` closes and restores focus to the exact previously focused element.
7. **Focus bar continuity (Q1):** Existing M3-A2 focus bar tests (`Tab`, `Shift+Tab`, `ArrowRight`, `ArrowLeft`, `Home`, `End`, `aria-pressed`, roving `tabIndex`) continue to pass unchanged.
8. **Launcher exit-code failure rendering:** Fake `connect_engine` rejecting with exit `20` lock-owner stderr renders `✗ FAILED` (`fail`), exit `20` chip, parsed lock-owner guidance, `"no automatic retry"`, and does not re-invoke `connect_engine`.
9. **Window minimum config (Q5):** Config test asserts `packages/desktop/src-tauri/tauri.conf.json` has `app.windows[0].minWidth === 960`, `minHeight === 640`, `bundle.active === false`, and no remote origins in `app.security.csp`.
10. **Receipts well honesty:** With no verified receipts earned and no errors, Receipts well renders its neutral empty state and contains no fabricated `servedModel`, `repo head`, or `engine.lock` text.
