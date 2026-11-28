# PIN: MADC M3-A4 Multi-Seat Side-by-Side Workspace (Direction A, Equal Columns)

- **Status:** **DRAFT**. Not binding until the Founder merges a PR naming this pin's exact head SHA.
- **Author:** Surface Architect
- **Date:** 2026-11-27 (r1)
- **Milestone / Act:** M3 / Act M3-A4 ("Multi-seat side-by-side workspace", `PLAN-madc-M3-build-plan.md:27`: "Live side-by-side seat panes, model/lane/worktree receipts (`servedModel`, `worktree.topLevel` + `head`), and interactive turn start / interrupt from the desktop window").
- **Gate:** the Founder approved this pin gate on 2026-11-27 at 7:36 PM ET (relayed by MADC Architect): Iris spec, then this Surface pin PR, then Argus review, then Founder merge. The builder (Gemini-4-Neon) builds M3-A4 **only after this pin and its companion amendment merge**.
- **Decisions addressed:** fulfills **D-189** (design spec pinned before UI build) for A4 (Clio **D-705** spec gate, **D-706** this pin); applies Founder rulings **FDR-1..FDR-8** (Clio **D-708..D-715**) and the A4 visual rulings **D-716..D-721**, plus **C53 / D-722** (keys vs D-680); preserves **D-626** (evidence-bound UI rule); narrows **D-682** (A3 Q4) per FDR-4(c); folds in **D-660 / D-666** and **D-665** through amendment 2; carries **D-693** (layout limits, closes only on a Founder ruling, §1.1 FDR-A4-1) and **D-699** (Safari < 18 opaque fallback, which superseded D-694); keeps **D-654, D-661, D-663, D-664** open. All Clio ids D-705..D-722 are `needs-confirmation` (relayed by MADC Architect, not posted on GitHub).
- **Repo paths (this PR):**
  - Pin: `docs/plan/PIN-madc-M3-A4-multi-seat-workspace.md` (this file)
  - Companion protocol amendment: `docs/plan/PIN-madc-M3-desktop-protocol-amendment-2.md` ("amendment 2")
  - Verbatim Iris spec: `docs/plan/sources/DESIGN-SPEC-m3-a4-equal-columns.md` (cited below as "spec"; never edited)
  - Frames: recorded by sha256 below, not committed (A3 convention, A3 pin:25; spec §0: "Frames and reference files are box-only and not in the repo")
  - Pointer edits: one `Amended by` line under the status line of `PIN-madc-M3-desktop-protocol-amendment-1.md`; one under the existing pointer block of `PIN-madc-M3-desktop-protocol.md`; on the A3 design pin, one `Amended by` line under its status line **and** an `Amended by` marker on the D-680 text (Q2 row) (§2.6); index rows in `docs/plan/README.md`.
  - **Docs only. No code, no `packages/**` change in this PR.** The builder's code scope is §2.4.

## Verified Base & Source Identities

- **Repository base:** `MADVenturesLLC/MADC` `main` @ `870c1f7ec3aeca13190f306b23c5d91810675e09` (PR #80). Re-checked at PR time: `main` has not moved. Root tree `cf62b988e1c196ad16fab1322df2a90a06741469`; `docs` `ceab5f6c0467b0edb84e316ffbc568197eeb0d12`; `packages` `ce7d377b91445e69824437340b6a8879910a670c`. Every `path:line` below is at that commit; this PR's pointer insertions shift later lines of the three edited pins, and cites into them use the `870c1f7e` numbers.
- **Referenced repo blob SHAs at `870c1f7e`:**
  - `docs/plan/PIN-madc-M3-desktop-protocol.md`: `2c022f3301d5220b78194037b1837eb14f81744e`
  - `docs/plan/PIN-madc-M3-desktop-protocol-amendment-1.md`: `3047bf3f59c68329f838bfc63fe32f3f4aa3a266`
  - `docs/plan/PIN-madc-M3-design-precision-instrument-glass.md` ("A3 pin"): `4f5dd042c2bc9724a1ccee02f1edb8aa02520c5c`
  - `docs/plan/sources/DESIGN-SPEC-m3-a3-precision-instrument-glass.md` ("A3 spec"): `040bfcccb2b87142692e71476aa5de853ec2aa37`
  - `docs/plan/PLAN-madc-M3-build-plan.md`: `f58d10cf23a64b3658951f6f97ef72f149559dab`
  - `docs/plan/README.md`: `6de8a9ca8fc83a8361ffa5b77b8fb3b7be88313b`
  - `packages/desktop/src-tauri/src/launcher.rs`: `cb011b02b808200e239058d3009c9e81c70f443e`
  - `packages/desktop/src-tauri/src/main.rs`: `b7aed570d45232e0742750feb161582e03dc1f48`
  - `packages/desktop/ui/shell.js`: `73ee40413349fc10e32ac774709a2dced19901aa`
  - `packages/desktop/src/ipc.ts`: `deadc25f7f9943f6248f5040044db10ce146feb0`
  - `packages/desktop/src/evidence.ts`: `3ae16638010b2c5fdaafdbf7ba6cbd51d5cc19c8`
  - `packages/engine/src/server.ts`: `9f43d5ee13a67db11f167d8600bf2969acb7e125`
  - `packages/engine/src/protocol/types.ts`: `eb233ca7dc39dd58d18f8ae5b0330ce84199dd69`
- **Approved Iris design artifacts** (Michael Daley chose Direction A, Equal Columns, with the Panes/Table toggle on 2026-11-27, relayed 10:22 PM ET, D-716; spec status line: "rulings approved by Mike 2026-11-27 (via MADC Architect); D-693 seat visibility pending"):
  - Spec: `sources/DESIGN-SPEC-m3-a4-equal-columns.md`, sha256 **`545825360d535b7ec55114e7e16edeaf8f396ac1e66d3328d0d905bd8e429aea`** (repo blob `151e0a8fd683d09b368cc4bd10b918c4a0f8caa4`), 549 lines, stored byte-identical to Iris's handoff file.
  - Frames (visual source of truth; box-only at `/workspace/iris-madc-m3a4/`, sha256 re-computed at PR time and equal to spec §0):

    | Frame | Pixels (@2x) | sha256 |
    | --- | --- | --- |
    | `direction-a-final.png` (Panes, 1440×900) | 2976×2020 | `4003282132432a197f2fbd967dc26496f315b638966d879241a10c96877a1105` |
    | `direction-a-final-1200.png` (Panes, 1200×800) | 2496×1820 | `8de9a0397801d7a216dda75915a2f859fc5c3d2b7e3cc030fbac2c036366e46c` |
    | `direction-a-final-960.png` (Panes, 960×640) | 2016×1500 | `ff94e5922d606a401e973d6bf99ece919b5b1d59a2bfb1ba9a111f159a4a9c73` |
    | `direction-a-final-table.png` (Table, 1200×800) | 2496×1820 | `e9958f514259faa51ddea3e91589da81670e2f565c00616c455b63adccb01a28` |
    | `direction-a-final-table-960.png` (Table, 960×640) | 2016×1500 | `8530abfda78cc144704a337e05d2fa89dc47ea777c176ee1c4750aa0c6e49e43` |
    | `quit-confirm.png` (quit dialog, 960×640) | 2016×1500 | `b757a19b9ee8bcabc0e4732d9162de50c85dcc036861ecead352d6d037617811` |

  - Reference CSS / markup (box-only, not in the repo, mock-up not shipping code; spec §0): `base.css` `6a16377c9b04b4cd1ceb3f1f48edab886e7b9916c089618bb8098b1117e14e09`, `final.css` `cfd19eb0fbd1f96586dd7e7121d88bec793a030315f164e6f689c3836d0ccf6e`, `build_final.py` `07729346ec0bc92bee8f227fab65f0c67d183e40ae45aebc56b2d62de081841a`.
  - Frames convention: as for A3 (A3 pin:25), the frames are pinned by sha256 and pixel size, not committed. A reviewer verifies a frame by hashing the copy Iris hands over.

---

## 0. How this pin relates to the spec (binding)

1. **The spec is adopted in full** except for the rulings in §1.1 and the closed deviation list in §1.3.
2. **This pin adds only:** the Founder rulings (§1.1); deviations forced by rulings, by live code, or by contradictions inside the spec (§1.3); and implementation contracts where the spec is silent: evidence mapping (§4), pane/connection state machines (§6), acceptance tests (§9).
3. **Precedence:** merged pins (including this pin and amendment 2 once merged) > spec > frames > reference CSS (spec §1). Where this pin is silent, the spec governs. A3's tokens and typography (A3 pin §3) carry over; the spec adds no token and no hue (spec §3).
4. **Protocol is not restated here.** The desktop method set, reader thread, event forwarding, epochs, fail-closed rules, the bounded exit path and the close-request hook are **amendment 2**. If this pin and amendment 2 differ on protocol, amendment 2 wins.

---

## 1. Rulings, Text-over-Frame Precedence, and Deviations

### 1.1 Rulings table

All rulings below are Mike's, made on 2026-11-27 and relayed by MADC Architect; Clio records each as `needs-confirmation` (not on GitHub). The Founder's merge of this PR is the on-record act for the pinned text.

| Item | Topic | Disposition | Ruling & where pinned |
| --- | --- | --- | --- |
| **R1 / D-716** (FDR-6(a)) | Layout | **ACCEPT** (10:22 PM ET) | Direction A, Equal Columns, with the Panes/Table toggle (spec §5). Seat visibility below 1200px is **FDR-A4-1** (open). |
| **R2 / D-717** | Turn pills | **ACCEPT** (10:22 PM ET) | `RUNNING`, `COMPLETED` neutral `○`; `INTERRUPTED` **fail `✗`** (red, not warn). §4.2. Iris's earlier mock used warn; the ruling and the final spec agree on fail. |
| **R3 / D-718** | Unconfirmed vendor model | **ACCEPT** (10:22 PM ET) | `vendorReported: false` read back from `session/read` → `▲ UNVERIFIED`. §4.3. |
| **R4 / D-719** | Lane and path | **ACCEPT** (10:22 PM ET) | `lane` and `worktree.topLevel` are fields, no pill, note `field · not a receipt`. §4.3. |
| **R5 / D-720** | Worktree head | **ACCEPT** (10:22 PM ET) | `head@open` verified on a valid 40-hex SHA alone, no `chainOk` requirement. **Narrows FDR-4(b)'s** recommended "chain ok and 40-hex". §4.4. |
| **R6 / D-721** | Keys | **ACCEPT** (10:22 PM ET) | `Cmd/Ctrl+Enter` start turn; `Cmd/Ctrl+1–4` focus pane; Interrupt by button or palette only; reserved future key `Cmd/Ctrl+Shift+.` behind a confirm, never `Esc`; no `Ctrl/Cmd+F`. §5.6. |
| **C53 / D-722** | Keys vs D-680 | **RULED** (10:36 PM ET) | The R6 keys **supersede D-680 for those keys only**; D-680 (A3 pin Q2, "No other global shortcut is added") still governs every other shortcut. Recorded by an `Amended by` marker on the D-680 text (§2.6). |
| **FDR-1 / D-708** | Desktop methods | **ACCEPT** (9:26 PM ET, "Accept all eight recommended defaults") | Allow `seat/list`, `thread/start`, `turn/start`, `turn/interrupt`; **defer `thread/resume`**. The spec asks for `thread/resume` (spec §1, §6.3, §7.2, §8.2, §14.1); **the ruling wins** (§1.3 D2). Amendment 2 §1. |
| **FDR-2 / D-709** | `cwd` source | **ACCEPT** | Typed absolute path field in A4 (§5.3; the spec has no `cwd` surface, §1.3 D3). |
| **FDR-3 / D-710** | Presence-gated lanes | **ACCEPT** | MiniMax Token Plan, Alibaba Coding Plan and `ollama-cloud` (so the seeded `surface-architect` seat) are unreachable from the desktop; the pane shows the engine's refusal verbatim (spec §6.3 "Refused"). Amendment 2 §16.7. |
| **FDR-4 / D-711** | Live evidence | **ACCEPT** | (a) a streamed `servedModel` is verified only after `session/read` confirms it (§4.3; tone conflict with the spec is **FDR-A4-2**); (b) the head label is `head@open`, never "current" (verification narrowed by D-720); (c) one automatic `session/read` per completed turn on a visible pane, **narrowing D-682** (A3 Q4) and nothing else (§4.5). |
| **FDR-5 / D-712** | Quit with running turns | **ACCEPT** | Quitting interrupts running turns and the quit flow says so (spec §10; amendment 2 §6.1). |
| **FDR-6(b) / D-713** | Safari < 18 | **ACCEPT** | The opaque fallback under the verbatim `@supports not (backdrop-filter: blur(1px))` block is accepted as-is (**D-699**). §5.2. |
| **FDR-7 / D-714** | Carried debt | **ACCEPT** | (a) Mike to confirm D-660, D-661, D-654 on GitHub; (b) the D-663 amendment stays a separate file. |
| **FDR-8 / D-715** | R4 blast radius | **ACCEPT** | R4 cleanup interrupts every pane's running turn; consequence recorded (amendment 2 §1.3; §6.4). |
| **FDR-A4-1** | D-693 seat visibility below 1200px | **FOUNDER_DECISION_REQUIRED** | Default (spec §15 recommendation): seat visible at every width (§5.2). Alternative: hide `seat` below 1200px. |
| **FDR-A4-2** | Tone of a streamed-only `servedModel` | **FOUNDER_DECISION_REQUIRED** | Default (FDR-4(a)'s accepted text): `○ NO RECEIPT` (neutral) until read back. The spec and frames show `▲ UNVERIFIED`. §4.3. |
| **FDR-A4-3** | Iris additions not covered by a ruling | **FOUNDER_DECISION_REQUIRED** (six yes/no items) | §11. Defaults: accept (a), (c), (d), (e), (f); defer (b) "Reopen pane" with `thread/resume`. |
| **FDR-A4-4** | `cwd` entry surface | **FOUNDER_DECISION_REQUIRED** (visual only) | Default: the two-step palette field in §5.3 (Iris may restyle without a new ruling). |

### 1.2 Text-over-Frame Precedence

Spec §0's five text-over-frame points are adopted unchanged (A3 points still hold; OS-drawn title bar; the Table frames omit `#output` and `#connect-btn` for space; the 960 Panes receipts well is scrolled, not clipped; mock values are illustrative). This pin adds three, forced by rulings:

6. The 1440 Panes frame shows a `prometheus · read-only` composer target and spec §6.3 describes a read-only pane. **Not built in A4** (it is reached only through `thread/resume`, deferred by FDR-1; §1.3 D2).
7. The frames show a streamed-only `servedModel` row as `▲ UNVERIFIED` (daedalus pane, 1440 frame). Under the default of FDR-A4-2 it renders `○ NO RECEIPT` with the same note. The `vendorReported: false` read-back row (hephaestus pane) is `▲ UNVERIFIED` as drawn (D-718).
8. The frames show no `cwd` entry. §5.3 adds one (FDR-2).

### 1.3 Pin deviations from the approved spec (closed list)

| # | Spec text | Pin value | Why (evidence) |
| --- | --- | --- | --- |
| D1 | Spec §6.1 "No other word exists" with A3's closed vocabulary extended by `RUNNING`, `COMPLETED`, `INTERRUPTED` | Adopted; this pin is the A3 pin §4.2 amendment that re-closes the list (§4.2) | D-717; A3 pin §4.2 calls the list closed |
| D2 | `thread/resume` throughout: spec §1 ("the window only sends `thread/start`, `thread/resume`, …"), §6.3 starting-thread banner variant, "Read-only (loaded by another client)" state, "Disconnected → `Reopen pane` (sends `thread/resume`)", §6.6 and §6.2 method-error rows for `thread/resume`, §7.2 `read-only` target reason, §8.2 `Open selected thread in pane` (`cmd-pane-open-thread`), §12.2 item 9, §14.1 | **None of these is built in A4.** The window sends only `seat/list`, `thread/start`, `turn/start`, `turn/interrupt` plus the A3 reads. No read-only pane, no `Reopen pane`, no `cmd-pane-open-thread`, no `thread/resume` row. A pane whose connection ended is history only (amendment 2 §4.4): footer `connection ended · history only`, composer target disabled `not connected` | FDR-1 / D-708 defers `thread/resume`. A thread loaded by another client cannot be loaded or interrupted from the desktop (`server.ts:2171-2172`) |
| D3 | Spec §8.2 `New pane on seat ‹seatId›` → `thread/start {seatId}` (no `cwd`) | `thread/start {seatId, cwd?}` with `cwd` from the §5.3 field | FDR-2 / D-709. Without `cwd` the engine records `worktree: null`, so `worktree.topLevel` and `head@open` would always be `—` |
| D4 | Spec §6.4 / §9 / §12.2 item 5: a streamed-only `servedModel` → hint `"warn"` → `▲ UNVERIFIED` | `○ NO RECEIPT` (neutral) with note `streamed · confirmed by session/read after turn/completed` (**FDR-A4-2** default) | FDR-4(a)'s accepted recommendation reads "stays `neutral`/`NO RECEIPT` until a `session/read` returns `chainOk:true` containing that `servedModel` event". If the Founder picks the spec's form, D4 is dropped and spec §6.4 applies |
| D5 | A3 spec §5.4 960–1199 row: "chips never wrap or clip" (A3 spec line 292; A3 pin D9) | **Amended (§5.2):** receipt chips **may wrap** onto further lines inside their track; they **never clip** | D-693; D-716 (Layout A with the wrap fix). The seat-visibility half is FDR-A4-1 |
| D6 | A3 pin §5.5 / spec §7.3 closed nine-command list; A3 §9 "no command IDs outside §7.3" | Re-closed at A3's nine plus §5.5 below (spec §8.2 minus `cmd-pane-open-thread`, D2) | spec §8.2; A3 pin:222-241 |
| D7 | Spec §9: deltas not rendered | Adopted; amendment 2 §3.2 additionally discards `item/started` and `item/agentMessage/delta` in Rust (no WebView buffer) | spec §9, §14.2 |

Nothing else in this pin deviates from the spec.

---

## 2. Supersession & Continuity

### 2.1 Superseded for M3 desktop only (by this pin and amendment 2)

- A3 pin §6.5 / pin:315-317 (engine death detected only at the next RPC) → amendment 2 §3.3 (`madc/transport-closed`).
- A3 pin §6.4 R1 "UI only ever sends `room/inspect` and `session/read`" (pin:310) → amendment 2 §1.1; new R5 (amendment 2 §1.2).
- A3 pin §6.1 `disconnect_engine` waits behind in-flight RPCs (pin:263) → amendment 2 §6 item 4.
- A3 Q4 / D-682 "never automatically" (pin:53, 211-216) → **narrowed** by §4.5 (FDR-4(c)); selection-triggered reads and D7's "no Read command" stand.
- A3 pin §7 deferrals (pin:321-326) for `ALLOWED_RPC_METHODS`, `launcher.rs` / `main.rs` edits, live `room/updated`, multi-seat composer → this pin and amendment 2.
- A3 pin §5.5 / spec §7.3 closed nine-command list (pin:222-241) → §5.5 below.
- A3 pin §4.2 closed pill vocabulary → §4.2 below (D-717).
- A3 spec §5.4 "chips never wrap or clip" (A3 spec line 292) and A3 pin D9's deferral of the two clipping limits → §5.2 below (D5).
- A3 pin Q2 / D-680 "No other global shortcut is added" (pin:51) → superseded **for the R6 keys only** (C53 / D-722, §2.6, §5.6).
- A3 pin D5 "`src/ipc.ts` stays unchanged" → `connectionEpoch` and typed A4 methods (amendment 2 §4.1).

### 2.2 Unchanged and still binding

- Base protocol pin §1-§4 and amendment 1 (socket, `serve`, `engine.lock`, no auto-retry, exit codes), as amended by amendment 2 where it says so.
- A3 pin §3 tokens/typography, §4.1 evidence gate, §4.3 Room-row mapping, §6.1-§6.4 (except as superseded), D1-D9 (D9's 960–1199 right-column clamp and 140px evidence track stay; its Room tracks are replaced by spec §6.5 (a)3 under FDR-A4-1's default).
- `evidenceTone` stays the only tone source; no caller passes a "verified" boolean.
- `chore/desktop-webview-harness` (D-688) is independent; it must not block, or be blocked by, A4.

### 2.3 M3-A3 test continuity

Every existing `desktop.test.ts` assertion keeps passing **except**: (1) the A3 §9 "command IDs equal exactly the nine" assertion (becomes the §5.5 list); (2) the `ALLOWED_PILL_LABELS` equality (becomes §4.2); (3) the `main.rs` N7 test's denied example, which is `turn/start` at `main.rs:143` (replace with a still-denied method such as `thread/handoff`), and the `launcher.rs` denied array at `:733-747` (drop only `turn/start` / `thread/start` at `:734-735`; keep `thread/resume`; extend with `thread/list`, `decision/list`, `auth/status`), per amendment 2 §13; (4) the A3 §9 `tauri.conf.json` equality only if amendment 2 §3.5 (A) is chosen. New tests are §9 and amendment 2 §13.

**Permitted fake-DOM harness extensions:** A3 pin §2's rule applies unchanged (standard DOM names with standard semantics only). A4 may add, under that rule: `HTMLInputElement.value`, `HTMLTextAreaElement.value`, `scrollTop`, `inert`, `addEventListener`/`removeEventListener` with a fake `keydown`, and one fake listener for the amendment 2 §3.1 event channel. No other harness change.

### 2.4 Code scope (files the builder may touch in M3-A4)

`packages/desktop/src-tauri/src/launcher.rs`, `main.rs` (and their `#[cfg(test)]` modules); `capabilities/default.json` / `tauri.conf.json` only per amendment 2 §3.5; `ui/shell.js`, `ui/shell.d.ts`, `ui/index.html`, `ui/styles.css`, `ui/app.js` (key wiring and the event listener only); `src/ipc.ts`, `src/evidence.ts` (`PillLabel`), `src/index.ts` exports; `src/desktop.test.ts`. **Not** `packages/engine/**`; no new Tauri plugin or `Cargo.toml` feature.

### 2.5 Rendering rule (unchanged from A3 pin §2)

`ui/shell.js` builds every node with `createElement` + `textContent` + `setAttribute`; never `innerHTML`, `outerHTML`, `insertAdjacentHTML` or `document.write`. Engine and vendor strings (error `message`, `reason`, `servedModel`, `issues`, the composer echo) are untrusted and go through `sanitizeEngineText` (`shell.js:200`) and `textContent` only. A4 renders no agent transcript (D7).

### 2.6 Pointer edits this PR makes (README edit rule, `docs/plan/README.md:3-11`)

- **A3 design pin** (status line says DRAFT, so README lines 8-9 permit an in-place edit by a Founder-merged PR that says so; this PR says so):
  - one `Amended by` line directly under its status line (pin:3);
  - an `Amended by` marker appended to the D-680 text in the Q2 row (pin:51), reading in substance: the M3-A4 keys `Cmd/Ctrl+Enter`, `Cmd/Ctrl+1`–`4`, and the reserved `Cmd/Ctrl+Shift+.` (behind a confirm, never `Esc`) supersede "No other global shortcut is added" **for those keys only** (C53, D-722, ruled 2026-11-27 10:36 PM ET); D-680 still governs every other shortcut. No other word of the A3 pin changes.
- **Amendment 1:** one `Amended by` line under its status line (amendment 2 §10).
- **Base protocol pin:** one `Amended by` line after the existing two (amendment 2 §10).
- **README:** index rows for this pin, amendment 2 and the spec.

---

## 3. Visual Token & Typography Contract

A3 pin §3 carries over unchanged. The spec adds **no token and no hue** (spec §3); new surfaces use existing tiers (pane tier 1, receipts well / composer input / dialog list tier 0, quit dialog tier-2 strong glass like the palette, banners `--madc-lighter`). New text roles are spec §4's table, adopted verbatim. A3 pin §9's "no colour hex literal outside `:root`" and "no decorative green" rules apply to every new rule.

---

## 4. Evidence-Bound Primitives & `evidenceTone` Invariant

### 4.1 Hard gate (D-626; unchanged)

The only tone source is `evidenceTone(receipt, hint)` (`shell.js:190-195`): `fail` hint → `fail`; `warn` hint → `warn`; `isVerifiedReceipt` → `verified`; else `neutral`. `isVerifiedReceipt` kinds: `hash` (`chainOk===true` + 64-hex), `sha` (40-hex), `servedModel` (`vendorReported===true` + non-empty) (`shell.js:164-184`). **Turn state is not evidence:** turn pills are `evidenceTone(null, hint)` with hint `"fail"` for `interrupted` and `failed`, `"neutral"` otherwise (spec §6.1), so a turn pill can never be green.

### 4.2 Closed pill vocabulary (amends A3 pin §4.2; D-717)

| Tone | Glyph | Words |
| --- | --- | --- |
| `verified` | `✓` | `VERIFIED` |
| `neutral` | `○` | `NO RECEIPT`, `IDLE`, `CONNECTING`, `CONNECTED`, `DISCONNECTED`, **`RUNNING`**, **`COMPLETED`** |
| `warn` | `▲` | `UNVERIFIED`, `STOPPED` |
| `fail` | `✗` | `FAILED`, **`INTERRUPTED`** |

`ALLOWED_PILL_LABELS` (`shell.js:109-113`) and `PillLabel` (`src/evidence.ts`) equal this table exactly. Geometry is A3's (spec §6.1). Chips never carry tone colour (A3 pin §4.2). Chip keys added in A4: `servedModel`, `vendorReported`, `fallbackFrom`, `lane`, `topLevel`, `sha`, `events`, `code`, and the verbatim `data` keys of a method error (`reason`, `activeTurnId`, `threadId`, `turnId`, `providerId`, `status`, `issues`).

### 4.3 Pane receipt rows (spec §6.4 adopted, with D4)

Rows in spec §6.2's fixed order: method-error rows, `servedModel`, `lane`, `worktree.topLevel`, `head@open`, `hash`.

**`servedModel` row.** Source: the **last** `servedModel` event in `session/read` `events[]` whose `payload.turnId` is the pane's latest turn (`session-store.ts:94-108`; `search.ts:158-172`); live: `item/completed` with `item.kind === "servedModel"` (`types.ts:129-143`; persisted before it is notified, `server.ts:2572-2584`).

| Condition (in order) | Hint → tone | Pill | Chips / note |
| --- | --- | --- | --- |
| No turn yet, or the turn ended without a `servedModel` item (e.g. refused `-32007`) | `neutral` | `○ NO RECEIPT` | `servedModel —` |
| Streamed item seen, no read-back yet | `neutral` (**FDR-A4-2** default; spec: `warn`) | `○ NO RECEIPT` (spec: `▲ UNVERIFIED`) | `servedModel ‹value›`, `vendorReported ‹bool›`; note `streamed · confirmed by session/read after turn/completed` |
| Read-back `chainOk === true`, matching event, `vendorReported === true`, and equal to any streamed item | `evidenceTone({kind:"servedModel", servedModel, vendorReported}, …)` → `verified` | `✓ VERIFIED` | `servedModel`, `vendorReported true`, `fallbackFrom` when non-null |
| Same, `vendorReported === false` | `warn` (D-718) | `▲ UNVERIFIED` | as above with `vendorReported false` |
| Read-back `chainOk !== true` after a streamed item, or streamed value ≠ chain value, or `session/read` rejected | `fail` | `✗ FAILED` | note `live value not confirmed by chain` / `live value differs from chain` / `session/read: ‹code› ‹message›`; cached read discarded (A3 pin §4.3 B) |

**`lane` and `worktree.topLevel` rows (D-719).** Field rows: no pill, note `field · not a receipt`. `lane` from the same `servedModel` event (`ServedModelPayload.lane`). `topLevel` from `worktree.open.topLevel` (§4.4 sources); start-truncated with the full path in `title` (spec §6.4). The typed `cwd` is **never** shown as `topLevel`: `topLevel` is the engine's realpath.

**`hash` row.** Exactly A3 pin §4.3 B plus the `events` chip; reset to `—` with note `chain head moved · read after turn/completed` on `turn/started` for that thread (spec §6.3).

**Method-error rows.** `✗ FAILED`, chips `code ‹n›` plus each `data` key verbatim; never retried automatically; cleared by the next successful call of the same method on that pane (spec §6.4).

### 4.4 `head@open` row (D-720; narrows FDR-4(b))

Source, in this order within the current epoch: the seq-0 `session.open` `payload.worktree` from the pane's last `session/read` (`session-store.ts:56-68`), or `RoomThreadRow.worktree.open` from a user-run `Inspect room` (`inspect.ts:147-151,246-249`). Both are the same recorded value. The engine emits **no live HEAD** (`inspect.ts` has no `git` call; `session.close` re-reads HEAD only at clean shutdown, `server.ts:567-599`).

| Condition | Tone | Pill | Chips / note |
| --- | --- | --- | --- |
| `worktree` null (no `cwd`, or a v1 session) or `head` null (unborn branch) | `neutral` | `○ NO RECEIPT` | `sha —` |
| `head` matches `/^[0-9a-f]{40}$/` | `evidenceTone({kind:"sha", sha: head})` → `verified` | `✓ VERIFIED` | `sha ‹12 hex›` (full 40 in `title` and accessible name) |
| Same, `worktree.missing === true` | as above (bound to the recorded SHA) | `✓ VERIFIED` | adds note `worktree missing on disk` (spec §6.4) |

No `chainOk` requirement (D-720). The label is always the literal `head@open`; never "head" or "current" (FDR-4(b)).

### 4.5 Automatic `session/read` (FDR-4(c); narrows D-682)

Exactly one `session/read {threadId}` per `turn/completed` for an own-connection pane that is visible, single-flight per thread, A3 pin §4.3 B dedupe and stale-drop. A turn that completed while its pane was hidden gets that same single read when the pane is shown. Never on `room/updated`, never on a timer, never bulk, never on connect. Selection reads (A3 Q4) are unchanged. There is still no "Read thread" command (D7).

### 4.6 Status strip model slot and copy commands

- The status strip's model slot keeps `model —` (spec §5.1; A3 pin §5.1): each pane carries its own model.
- `Copy served model`: enabled iff the focused pane's `servedModel` row is `✓ VERIFIED`. `Copy chain head`: a verified `hash` on the focused pane or selected row. **`Copy head@open`** (new): enabled iff the focused pane's `head@open` is `✓ VERIFIED`; copies 40 hex.

---

## 5. Surface, Layout & Palette Contract (spec §5, §7, §8 adopted, as amended here)

### 5.1 Regions and views

Spec §5.1-§5.3 adopted: focus bar (52px) → `<main>` → status strip (34px); the Panes/Table segmented toggle (`role="radiogroup"`, roving tabindex); default view Panes when a pane exists, else Table; `Focus Engine` switches to Table; switching views sends no request and discards nothing. The Table view is the A3 Room screen as shipped plus the toggle, the §5.2 layout fix and the stale note (§11 FDR-A4-3(f)).

### 5.2 Panes grid, D-693 and D-699

- **Panes grid:** spec §5.4 adopted: `paneColumns(W)` = 4 at W ≥ 1440, 2 at 960–1439; equal columns `repeat(N, minmax(0,1fr))`, gap 14px, `<main>` padding `20px 28px`; wide row form iff pane width ≥ 520px. Below 960×640 the A3 guard rows apply (Q5 `minWidth`/`minHeight` unchanged).
- **Hidden panes:** spec §5.5 adopted (hidden, never closed; a hidden pane keeps its thread and lock, amendment 2 §16.4). The tab form at ≥ 1440, the rightmost-slot rule and `Dismiss pane` are FDR-A4-3 items.
- **Scroll:** spec §5.6 adopted (Panes: `<main>` does not scroll; each pane's receipts well is its only scroll region. Table: A3 rules).
- **§5.4 amendment (D5; D-693):** A3 spec §5.4's "chips never wrap or clip" is amended for the M3 desktop to **"receipt chips may wrap onto further lines inside their track; they never clip."** `.cell-receipt` and `.receipt-chips` get `flex-wrap: wrap; row-gap: 6px`; rows grow to fit; notes wrap on their own line; no rule may hide overflow in a way that cuts a chip; full values stay in `title`. Below 1200px the Receipts-well row becomes two lines (`112px minmax(0,1fr)`), so the `exit 20` `pid` chip and the `manualFix` note fit at 960 (spec §6.5 (b); frame `direction-a-final-table-960.png`).
- **Seat visibility below 1200px: FOUNDER_DECISION_REQUIRED (FDR-A4-1).** **Default, the spec §15 recommendation:** the seat stays visible at every width. At ≥ 1200px A3's five Room tracks stay; at 960–1199px the seat folds into the thread cell as a second line (`THREAD · SEAT`), tracks `140px minmax(96px, 0.62fr) 48px minmax(168px, 1.9fr)`, gap 8px, replacing D9's Room tracks while D9's right-column `clamp(360px, 37.5vw, 440px)` stays (spec §6.5 (a)). **Alternative:** hide the `seat` column below 1200px and wrap chips (A3 pin D9's proposal). **D-693 closes only when the Founder rules FDR-A4-1 and this PR merges**; until then it stays open, and the builder implements the default.
- **D-699 (FDR-6(b) confirmed):** Safari < 18 paints the glass opaque under the verbatim `@supports not (backdrop-filter: blur(1px))` block and that is accepted as-is (no A3 spec §3.4 amendment, no prefix-aware `@supports`). The quit dialog shares the palette's rule and fallback (spec §3, §11). Pane bodies are tier 1/tier 0 (no `backdrop-filter`); no element depends on glass for legibility.

### 5.3 Starting a pane, and the `cwd` field (FDR-2; D3; FDR-A4-4)

- `New pane on seat ‹seatId›` (one palette row per `seat/list` entry; `ok:false` rows disabled with `seat load failed ‹code›`) opens a **second palette step**: the palette input is replaced by one text field labelled `cwd` (micro-label `CWD · absolute path · optional`), prefilled with the last `cwd` used in this window (none on first use). `Enter` confirms; `Esc` returns to the command list (A3 Q2 `Esc` role unchanged).
- Empty → `thread/start {seatId}` (engine records `worktree: null`; `topLevel` and `head@open` stay `—`). Non-empty → must be absolute; the UI checks `startsWith("/")` and Rust enforces amendment 2 §1.2 (absolute, ≤ 4096 bytes, no NUL); a refusal is R5 (defect guard, never `disconnect_engine`). Existence and repo resolution are the engine's (`-32602` / worktree identity).
- On confirm a starting-thread pane appears (spec §6.3 "Starting thread", `thread/start` variant only). The visual of the `cwd` step is FDR-A4-4 (Iris may restyle it within A3 palette tokens without a new ruling).

### 5.4 Composer, start and interrupt

Spec §7 adopted, minus the `read-only` target reason (D2):
- Targets: one chip per pane (visible and hidden, in pane order); default only the focused pane's; toggled by click, `Space` or `Toggle target ‹seat›`. Disabled reasons, verbatim: `turn active`, `starting thread`, `refused -32007`, `no thread loaded`, `not connected`.
- Start: button, `Cmd/Ctrl+Enter` in the composer input, or `Start turn`. One `turn/start {threadId, input: [{type:"text", text}]}` per selected enabled target, **`mode` omitted** (headless; Rust refuses `"interactive"`, amendment 2 §1.2). Independent requests; the input clears only if every request returned `{turn}`. No retry, no queue, no auto-start.
- Interrupt: `INTERRUPT TURN` button in the pane footer or `Interrupt turn on ‹seat›`; enabled only for an own-connection pane with a known `inProgress` turn and no pending interrupt; exactly one `turn/interrupt {threadId, turnId}`; the pane changes only on `turn/completed` (→ `✗ INTERRUPTED`) or the `turn.end` read; an `{}` for an already-finished turn changes nothing. Never automatic; no "stop all"; no key bound.

### 5.5 Command palette (re-closed list; D6)

A3's nine commands (A3 pin §5.5, D4 rules unchanged; `Focus Engine` also switches to Table) **plus exactly these**, ids and enabled-when rules as spec §8.2:

| Group | Command (id) |
| --- | --- |
| Evidence | `Copy head@open` (`cmd-copy-head-open`) |
| Panes | `Show Panes view` (`cmd-view-panes`), `Show Table view` (`cmd-view-table`) |
| Panes | `Focus pane 1–4` (`cmd-pane-focus-1` … `cmd-pane-focus-4`) |
| Panes | `New pane on seat ‹seatId›` (`cmd-pane-new:‹seatId›`), opens the §5.3 `cwd` step |
| Panes | `Show pane ‹seat›` (`cmd-pane-show:‹paneId›`) |
| Panes | `Hide pane ‹seat›` (`cmd-pane-hide`) |
| Panes | `Dismiss pane ‹seat›` (`cmd-pane-dismiss`), only for a pane whose `thread/start` failed (FDR-A4-3(a)) |
| Turn | `Start turn` (`cmd-turn-start`) |
| Turn | `Interrupt turn on ‹seat›` (`cmd-turn-interrupt:‹paneId›`), no key hint |
| Turn | `Toggle target ‹seat›` (`cmd-target-toggle:‹paneId›`) |

**Not in A4:** `Open selected thread in pane` (`cmd-pane-open-thread`, needs `thread/resume`, D2). The only generated rows are the `‹seatId›` / `‹paneId›` rows, with closed id prefixes. Mutating commands are disabled outside `CONNECTED` and while `disconnectPending`. No "Read thread" command.

### 5.6 Keys (D-721; C53 / D-722)

Spec §8.1 adopted:

| Key | Scope | Action |
| --- | --- | --- |
| `Cmd+K` / `Ctrl+K` | anywhere | palette toggle (A3, unchanged) |
| `Cmd+Enter` / `Ctrl+Enter` | composer input focused | Start turn |
| `Cmd+1`–`4` / `Ctrl+1`–`4` | anywhere, palette closed | switch to Panes if needed, focus the visible pane at that slot; no-op if empty |
| `Tab` / `Shift+Tab`, `←` / `→`, `Space` | as spec §8.1 | unchanged roving / focus order; `Space` toggles a target chip |
| `Esc` | palette; quit dialog | closes the palette (A3); closes the quit dialog as **Keep running** (FDR-A4-3(e)); **never interrupts anything** |

- Interrupt has **no key** in A4. `Cmd/Ctrl+Shift+.` is **reserved** for a future interrupt key **behind a confirm**, and is never `Esc`; A4 does not bind it.
- Modifier detection is A3 Q2's (`metaKey && !ctrlKey` on macOS, `ctrlKey && !metaKey` elsewhere). No `Ctrl+F` / `Cmd+F`.
- **D-680 supersession, for these keys only (C53, D-722, ruled 2026-11-27 10:36 PM ET):** `Cmd/Ctrl+Enter`, `Cmd/Ctrl+1–4` and the reserved `Cmd/Ctrl+Shift+.` supersede A3 pin Q2's "No other global shortcut is added" (D-680). D-680 still governs every other shortcut; adding any other key needs a new ruling. The A3 pin carries the `Amended by` marker on that text (§2.6).

### 5.7 Quit flow (FDR-5)

Spec §10 adopted, with amendment 2 §6.1 as the mechanism: no running own-connection turns → quit immediately; one or more → the `role="alertdialog"` dialog (frame `quit-confirm.png`), body text verbatim, the list of running own-connection turns (hidden panes included, suffix `(hidden)`), `KEEP RUNNING` default focus, `QUIT AND INTERRUPT ‹n› TURN(S)` neutral (no red button), `Tab` trapped, `Esc` = Keep running (FDR-A4-3(e)). Confirming sends **zero** `turn/interrupt`; it invokes `confirm_quit`, and the engine records the interruptions.

### 5.8 Accessibility

Spec §11 adopted (pane `region` names, turn pill accessible names, full values in `title`/accessible names, one polite live region per window announcing status changes once, `forced-colors` / `prefers-reduced-motion` / `prefers-reduced-transparency` per A3 §3.4 and D8). Nothing animates.

---

## 6. Connection State Machine & Failure Mapping

A3 pin §6 binds unchanged (states, single-flight, `connect_engine` grammars G1-G6, R2-R4, no auto-retry), plus amendment 2 (§3.3 `madc/transport-closed`, §4 epochs, §5 fail-closed rows, §6 exit bound, §6.1 quit hook). This section adds the per-pane machine.

### 6.1 Pane states (spec §6.3, minus the read-only state, D2)

| State | Entered when | Turn pill | Send target | Interrupt |
| --- | --- | --- | --- | --- |
| Starting thread | `thread/start` in flight (single-flight per pane) | `○ IDLE` | disabled `starting thread` | disabled |
| Start failed | `thread/start` rejected (R3 / R5) | `○ IDLE` | disabled `no thread loaded` | disabled; `Dismiss pane` allowed |
| Idle | `thread/start` resolved, no turn yet | `○ IDLE` | enabled | disabled |
| Running | `turn/start` resolved `inProgress`, or `turn/started` | `○ RUNNING` | disabled `turn active` | enabled (own connection) |
| Interrupt pending | `turn/interrupt` sent, no `turn/completed` yet | `○ RUNNING` | disabled `turn active` | disabled, footer `turn/interrupt sent` |
| Completed | `turn/completed` `completed`, confirmed by the §4.5 read | `○ COMPLETED` | enabled | disabled |
| Interrupted | `turn/completed` `interrupted` / `turn.end` `interrupted` | `✗ INTERRUPTED` | enabled | disabled |
| Failed | `turn/completed` `failed` / `turn.end` error | `✗ FAILED` | enabled | disabled |
| Refused | `turn/start` rejected `-32007` (e.g. `surface-architect`, reason `headless-not-permitted`) | `○ IDLE` (no turn exists) | disabled `refused -32007` | disabled |
| History (connection ended) | the pane's epoch ended (amendment 2 §4.4) | `○ DISCONNECTED` | disabled `not connected` | disabled; footer `connection ended · history only` |

Rules: the machine is driven only by current-epoch `rpc_request` results and accepted events (amendment 2 §4.2). A stale result or event changes nothing (A3 N5, extended). `turn/completed` for a turn the pane did not start is ignored. A `turn/start` result that arrives after the epoch changed creates or advances no pane.

### 6.2 `rpc_request` rejection mapping (extends A3 pin §6.4)

| Class | Source | Rendering |
| --- | --- | --- |
| R1 | allowlist refusal, string unchanged (`launcher.rs:46`) | defect guard on the action; state unchanged; no `disconnect_engine` |
| **R5** (new) | `RPC params refused by desktop shell for ‹method›: ‹reason›` (amendment 2 §1.2) | as R1; **never** `disconnect_engine` (killed-mutation tests, amendment 2 §13 items 2b and 10) |
| R3 | `engine RPC error: ‹json›` | pane-scoped method-error row; connection stays `CONNECTED` |
| R2 / R4 | unchanged | unchanged; R4 = one `disconnect_engine`, which ends every pane's running turn (FDR-8, §6.4) |

### 6.3 Engine errors rendered in a pane (R3; text verbatim, sanitised)

`-32005` / `-32006` (`thread/start`, seat missing/invalid) → Start failed, seat shown unavailable; `-32602` (invalid params, `data.issues`) → method-error row; `-32002` (`turn/start` / `turn/interrupt` on a thread not loaded here) → method-error row, target `no thread loaded`; `-32003` (`turn/interrupt`, unknown turn) → row only; `-32004` (`turn/start`, a turn already active; `data.activeTurnId`) → row, target `turn active`; `-32007` (`data.providerId`, `reason`, `status`) → Refused, `code` and `reason` chips, `providerId`/`status` in `title` and accessible name (spec §6.3); `-32008` (provider unavailable) → row with `reason`; `-32009` (session write failed) → `✗ FAILED` row, the thread may be poisoned for the process (`server.ts:405`); `-32010` (evidence refusal) → row with `issues`.

### 6.4 Concurrency and lifetime facts the UI must reflect

- Different panes can run turns at the same time; one active turn per thread (`server.ts:2173-2175`).
- A pane's thread stays loaded, lock held, until the connection ends, even when hidden; there is no unload method (amendment 2 §16.4).
- Quit, `disconnect_engine`, R4 cleanup or a desktop crash interrupts every running own-connection turn (`server.ts:532-565`); on the next connection those panes are history (FDR-5, FDR-8).
- `lockHolderPid` names a **process**, so a second connection inside the same `serve` would report the `serve` pid, and the desktop cannot tell that apart (`ConnectionInfo` has no `serve` pid, `launcher.rs:66-73`). This matters only once `thread/resume` lands (amendment 2 §16.4(c)).

---

## 7. Out of Scope (Deferred)

- A5 handoff chain view; A6 Founder Decision Inbox (`decision/*`); A7 session search UI and replay inspector; A8 conformance/runbook.
- `thread/resume` and everything that depends on it (read-only panes, `Reopen pane`, `Open selected thread in pane`), `thread/list`, `thread/handoff`, `provider/list`, `auth/*` (FDR-1); any desktop presence/TTY mechanism (FDR-3); live worktree HEAD; `thread/close` (does not exist); an agent transcript, deltas, Markdown/HTML rendering of agent output; attachments; tool/MCP UI; code editing (PLAN §1 non-goals).
- An interrupt key (reserved only, §5.6); a folder-picker plugin for `cwd` (FDR-2 option b).
- Windows (D-648, D-670), packaging/signing, the D-654 boot-time rule (D-663 separate per FDR-7(b), D-664), D-688's live font/glass smoke.
- Any `packages/engine` change.

---

## 8. Unverified Items (Fail-Closed)

1. **Tauri event delivery in the no-bundler WebView and the `core:default` event permission** (amendment 2 §3.5, §12.1). The builder smoke-tests in a real window; otherwise no live-pane claim and Surface re-pins (fallback C).
2. **Close/exit interception** under Tauri 2.12.7, including macOS `Cmd+Q` via `RunEvent::ExitRequested` (amendment 2 §6.1, §12.5).
3. **`thread/start` / `turn/start` latency vs the 10 s RPC deadline** (git work inside the engine). Keep 10 s; the builder reports observed latency on a large repo.
4. **Glass with several panes on screen** (D-688(3)). No pane body uses `backdrop-filter`; the builder records which platforms were smoke-checked.
5. **Ordering of one connection's `room/updated` vs another connection's items** (asserted only for the originating connection, `socket-search.test.ts:1130-1160`). Irrelevant to A4's own panes, which use their own stream.
6. **8 MiB frame cap and 4096-event queue** are proposals, not measurements (amendment 2 §12.3).
7. **Spec frames are mock renders** of `final.css`, not the shipped WebView; live font rendering under CSP stays with D-688.

---

## 9. CI-Testable Acceptance Criteria

All checks run headless in `npm run check` (tsc, Biome, `node --test`, `bun test`) and `cargo test`, with **zero network, zero keychain, zero real TTY, zero real model, zero live engine spawn** in the JS tests (fake `invokeFn`, fake event listener, the A3 fake-DOM harness plus §2.3's extensions); Rust tests use fake socket peers. Protocol tests are amendment 2 §13.

Spec §12.2 items 1-4, 6-8, 10-19 are adopted as written, with these edits:
- **Item 5 (servedModel row):** under FDR-A4-2's default, streamed-only → `neutral` `○ NO RECEIPT` with the note, even with `vendorReported: true`; read-back `vendorReported: true` → `verified`; read-back `false` → `warn` `▲ UNVERIFIED`; none → `neutral`. If the Founder picks the spec's form, the spec's item 5 applies unchanged.
- **Item 9 (read-only via `thread/resume`):** **dropped** (D2). Replaced by: no code path sends `thread/resume`; the palette has no `cmd-pane-open-thread`; no pane renders a `read-only` banner or target reason.
- **Item 14 (static CSS):** the "no `display: none` on seat text below 1200px" and 960–1199 track assertions follow FDR-A4-1's default; if the Founder picks the alternative, they become "the seat column is hidden below 1200px and chips wrap".
- **Item 17 (palette ids):** exactly A3's nine plus §5.5's list.

Added by this pin:
20. **No decorative green over a full pane run:** fake events drive a pane Idle → Running → Completed / Interrupted / Failed; no element resolves `data-tone="verified"` except a §4.3/§4.4 row whose receipt verifies; `RUNNING` / `COMPLETED` are `neutral`; `INTERRUPTED` / `FAILED` are `fail`.
21. **`head@open` (D-720):** 40-hex → `verified` with or without `chainOk`; null → `neutral`; `missing: true` keeps `verified` and adds the note; the label string is exactly `head@open`.
22. **Pane machine (§6.1):** table-driven over every transition; a second Start while Running sends nothing; an `{}` interrupt reply for a finished turn changes nothing; a stale-epoch result or event changes no pane, receipt or connection state; a `turn/start` result after `disconnect_engine` creates no pane.
23. **Presence honesty:** no `turn/start` carries a `mode` key; a fake `-32007` with `reason: "headless-not-permitted"` renders `code` and `reason` chips verbatim, the pane stays `○ IDLE`, the connection stays `CONNECTED`, and `disconnect_engine` is invoked zero times.
24. **R5 / R1 killed mutation (UI):** with a Running pane and `CONNECTED` state, an R5 or R1 rejection invokes `disconnect_engine` **zero** times and the pane stays Running.
25. **`cwd` step (§5.3):** empty sends `thread/start {seatId}` without `cwd`; a relative path is refused before any `rpc_request`; an absolute path is sent unchanged; the typed `cwd` never appears as a `topLevel` chip.
26. **Keys (C53):** the only new global handlers are `Cmd/Ctrl+Enter` (composer input only) and `Cmd/Ctrl+1–4`; `Cmd/Ctrl+Shift+.` and `Esc` never send `turn/interrupt`.
27. **Engine untouched:** the diff touches no file under `packages/engine/`.

---

## 10. Ledger handling (for Clio, on Founder merge)

| Item | Disposition on merge |
| --- | --- |
| D-660, D-666 | **Folded in** via amendment 2 §6 (9 s total exit bound pinned; code fix lands in the A4 build). D-660 stays `needs-confirmation` until Mike's ruling is on GitHub (FDR-7(a)) |
| D-665 | **Folded in** by amendment 2 §7 (stdin error → exit 0 text for amendment 1 §3(a)) |
| D-693 | **Folded in, pending ruling:** §5.2's §5.4 amendment lands; the item **closes only on the Founder's FDR-A4-1 ruling plus this merge** |
| D-699 | **Folded in:** Safari < 18 opaque fallback confirmed (FDR-6(b)) and pinned in §5.2. Cited instead of D-694, which it superseded |
| D-682 (A3 Q4) | **Narrowed** by §4.5 (FDR-4(c)); statement otherwise unchanged |
| D-680 (A3 Q2) | **Superseded for the R6 keys only** (C53 / D-722); otherwise unchanged |
| D-654, D-661, D-663, D-664 | **Stay open**, untouched (D-663 stays a separate amendment, FDR-7(b) / D-714) |
| D-688, D-648, D-670, D-676 | Carried unchanged |
| D-705, D-706 | Spec gate and this pin: satisfied by this PR at Founder merge |
| D-707, D-708..D-715, D-716..D-721, D-722 | Relayed rulings, applied in §1.1 and amendment 2 §14; **`needs-confirmation`** (Clio ids, not on GitHub) |
| FDR-A4-1..FDR-A4-4 | New open Founder decisions (§11) |

---

## 11. FOUNDER_DECISION_REQUIRED (open; each has a default the builder implements unless the Founder rules otherwise)

- **FDR-A4-1: D-693 seat visibility below 1200px.** *Default (spec §15 recommendation):* keep the seat visible at every width; fold it into the thread cell below 1200px; chips wrap at every width; two-line Receipts row below 1200px. *Alternative:* hide the `seat` column below 1200px. D-693 closes only on this ruling plus merge.
- **FDR-A4-2: tone of a streamed-only `servedModel`.** *Default (FDR-4(a)'s accepted text):* `○ NO RECEIPT` (neutral) with the note `streamed · confirmed by session/read after turn/completed`. *Alternative (spec §6.4, frames):* `▲ UNVERIFIED` (warn). Neither is ever green.
- **FDR-A4-3: Iris additions not covered by a ruling** (spec: "my additions, not Mike's rulings"):
  - (a) `Dismiss pane ‹seat›`, only for a pane whose `thread/start` failed (spec §5.5, §8.2). *Recommend:* accept.
  - (b) `Reopen pane` on a disconnected pane, one `thread/resume` on click (spec §6.3). *Recommend:* **defer with `thread/resume`**; it cannot be built in A4 under FDR-1. In A4 the pane shows `connection ended · history only`.
  - (c) Hidden-pane tabs at ≥ 1440 (seat plus `.pill--sm`, extending A3's `.pill--sm` use) and the `N hidden · names` summary chip below 1440 (spec §5.5). *Recommend:* accept.
  - (d) A shown hidden pane takes the rightmost visible slot and the pane there becomes hidden (spec §5.5). *Recommend:* accept.
  - (e) `Esc` on the quit dialog means **Keep running** (spec §8.1, §10). *Recommend:* accept.
  - (f) The Table-view stale note `room changed · Inspect room to refresh` instead of any automatic `room/inspect` on `room/updated` (spec §9; amendment 2 §3.4 item 2). *Recommend:* accept.
- **FDR-A4-4: `cwd` entry surface** (FDR-2 ruled the field; the spec draws none). *Default:* the two-step palette field in §5.3. Visual only; Iris may restyle within A3 palette tokens.
