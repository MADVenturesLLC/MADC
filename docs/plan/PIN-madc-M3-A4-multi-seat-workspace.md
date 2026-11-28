# PIN: MADC M3-A4 Multi-Seat Side-by-Side Workspace (Direction A, Equal Columns)

- **Status:** **DRAFT**. Not binding until the Founder merges a PR naming this pin's exact head SHA.
- **Author:** Surface Architect
- **Date:** 2026-11-27 (r18; last edited 2026-11-28 early AM ET)
- **Revisions:** r1 10:49 PM ET; r2 10:58 PM ET (Copilot 3 High); r3 11:12 PM ET (Copilot 4 High + 1 Medium + self-review); r4 11:19 PM ET (Copilot 4 High, including the §4.3 read-back rows); r5 (same night): FDR-A4-1..4 ruled at 11:33 PM ET (D-723..D-727); FDR-A4-5 ruled at 11:50 PM ET (chips may wrap, never clip; with D-723, D-693 closes on merge); post-start `session/read` ruled at 11:51 PM ET (further narrows D-682); Iris cwd addendum and frame updates folded in; Argus r1 L1–L5 and Architect r1 M1–M2, L1–L7 answered. All times ET, 2026-11-27, relayed by MADC Architect. r7 (2026-11-28 early AM ET): Architect r2 / Argus r2 of `fba7b7f2` (quit hook builder default, §6.3 scoped to turn methods, D-728/D-729, `startedAt`, `{thread}` F2, Draft at epoch end). r6 (2026-11-28 12:08 AM ET, amendment 2 only): the `turn/start` result must have `status` exactly `"inProgress"`. r8 (same hour as r7): Copilot review of `216f9bf0` — `seat/list` result is F2-validated; `turn/start` applies the complete §3.2.1 (c) Turn shape; single-flight `session/read` coalesces a follow-up when a turn completes during the post-start read. r9 (2026-11-28 early AM ET): Architect r3 / Argus r3 of `e8cbda36` — `quit_dialog_shown` and a 3 s shown-ack bound (M-1); FDR-A4-6 (FOUNDER_DECISION_REQUIRED, default accept) for a hung-after-shown renderer. r10 (same hour): Copilot review of `bc4ece25` — request-correlated quit acks, `thread/start` idle/seat and `turn/start` threadId checks, `session/read` / `room/inspect` F2, F10 before the forwarding set, no state-word mutex across emit (r10 mechanism, **superseded by r13** L1: emit starts inside the single owner). r11 (same hour): Copilot review of `c1c1cb63` and an audit of every inbound engine payload — a complete closed `SessionEvent` union for `session/read`, a complete `RoomReport` / `WorktreeIdentity` for `room/inspect`, stated checks for `initialize`, `session/search` and `turn/interrupt`, and one coverage table (amendment 2 §3.2.1). r12 (same hour): Copilot review of `72b9d6b0` — `acceptQuitRequest` tracks the request id (stale `madc:quit-requested` ignored), and no `emit` starts after a desktop-initiated close (amendment 2 §2.4, §6.1); r13 (same hour): Copilot review of `b552b266` — amendment 2 §2.4, §4 and §6.1 rewritten as one connection-lifecycle state machine (invariants L1-L14): every published epoch ends with exactly one `madc/transport-closed`, the UI accepts it regardless of the `CONNECTED` gate (including during the connect handoff), and the 3 s quit bound settles its `requestId`, so a late `quit_dialog_shown` opens nothing; r14 (same hour): Architect r4 of `fea3a38b` (M-1R, M-2, L-1..L-5) and Argus r4 of the same head (L-2..L-4, I-A..I-H) — a failed quit emit is immediate expiry (fallback mark set), an `exit` terminal does not take the failure path, the quit-fallback mark expires after `QUIT_FALLBACK_TTL = 30 s` or on the next accepted shown-ack, and a shown quit dialog is dismissed on the terminal (amendment 2 §4.3, §6.1); r15 (same hour): Copilot review of `a0a70e7b` — the `servedModel` receipt row no longer treats an F2 `session/read` as a rendered `✗ FAILED`; r16 (same hour): Copilot review of `0f1ddd5d` — a terminal during an in-flight `quit_dialog_shown` settles the candidate (no dialog opens on a late `{ accepted: true }`); r17 (same hour): Copilot review of `64ddca19` — the `servedModel` `✓ VERIFIED` row requires a non-empty value; an empty-string read-back is `neutral`, never green. r18 (same hour): Architect r5 / Argus r5 of `90eb51b6` — the unreachable shown-ack-clear of the quit-fallback mark is deleted (`QUIT_FALLBACK_TTL` is the only expiry, counted on a monotonic clock); an empty or whitespace-only `servedModel` is `▲ UNVERIFIED` (D-718 / D-724 stay literal); the quit record uses `settled` only; A4 §8 and §11 mirror the 8 MiB accepted limit, the emit spike, and the 30 s TTL, and add Founder-visible items for the silent second close (while the mark is live) and the `disconnect`/`exit` terminal-reason contract.
- **Milestone / Act:** M3 / Act M3-A4 ("Multi-seat side-by-side workspace", `PLAN-madc-M3-build-plan.md:27`: "Live side-by-side seat panes, model/lane/worktree receipts (`servedModel`, `worktree.topLevel` + `head`), and interactive turn start / interrupt from the desktop window").
- **Gate:** the Founder approved this pin gate on 2026-11-27 at 7:36 PM ET (relayed by MADC Architect): Iris spec, then this Surface pin PR, then Argus review, then Founder merge. The builder (Gemini-4-Neon) builds M3-A4 **only after this pin and its companion amendment merge**.
- **Decisions addressed:** fulfills **D-189** (design spec pinned before UI build) for A4 (Clio **D-705** spec gate, **D-706** this pin); applies Founder rulings **FDR-1..FDR-8** (Clio **D-708..D-715**) and the A4 visual rulings **D-716..D-721**, plus **C53 / D-722** (keys vs D-680); preserves **D-626** (evidence-bound UI rule); narrows **D-682** (A3 Q4) per FDR-4(c) and further by the 11:51 PM ET post-start `session/read` ruling; folds in **D-660 / D-666** and **D-665** through amendment 2; folds in **D-693** (**FDR-A4-1** / **D-723** seat visible and folded below 1200px, plus **FDR-A4-5** chip wrap, both ruled; **D-693 closes on this merge**); carries **D-699** (Safari < 18 opaque fallback, which superseded D-694); keeps **D-654, D-661, D-663, D-664** open. Applies the 11:33 PM ET rulings **FDR-A4-1..FDR-A4-4** (Clio **D-723..D-727**, `needs-confirmation`), **FDR-A4-5 / D-728** (11:50 PM ET), and the 11:51 PM ET post-start read (**D-729**). All Clio ids D-705..D-729 are `needs-confirmation` (relayed by MADC Architect, not posted on GitHub).
- **Repo paths (this PR):**
  - Pin: `docs/plan/PIN-madc-M3-A4-multi-seat-workspace.md` (this file)
  - Companion protocol amendment: `docs/plan/PIN-madc-M3-desktop-protocol-amendment-2.md` ("amendment 2")
  - Verbatim Iris spec r1: `docs/plan/sources/DESIGN-SPEC-m3-a4-equal-columns.md` (cited below as "spec" where r1 is meant; never edited)
  - Verbatim Iris spec r2: `docs/plan/sources/DESIGN-SPEC-m3-a4-equal-columns-r2.md` (supersedes r1 for §6A and the 11:33 PM ET rulings; r1 is kept intact)
  - Verbatim Iris cwd addendum: `docs/plan/sources/DESIGN-SPEC-m3-a4-cwd-field-addendum.md` (adopted by §5.3)
  - Frames: recorded by sha256 below, not committed (A3 convention, A3 pin:25; spec §0: "Frames and reference files are box-only and not in the repo")
  - Pointer edits: one `Amended by` line under the status line of `PIN-madc-M3-desktop-protocol-amendment-1.md`; one under the existing pointer block of `PIN-madc-M3-desktop-protocol.md`; on the A3 design pin, one `Amended by` line under its status line, which also carries the D-680 / C53 supersession (the Q2 cell is not edited; §2.6); index rows in `docs/plan/README.md`.
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
- **Approved Iris design artifacts** (Michael Daley chose Direction A, Equal Columns, with the Panes/Table toggle on 2026-11-27, relayed 10:22 PM ET, D-716; spec r1 status line, preserved verbatim and never edited: "rulings approved by Mike 2026-11-27 (via MADC Architect); D-693 seat visibility pending". **This pin rules D-693 in full** (FDR-A4-1 / D-723 at 11:33 PM ET; FDR-A4-5 at 11:50 PM ET; closes on merge). Iris spec r2 and the cwd addendum are stored as additional source files; r1 is kept intact):
  - Spec r1 (preserved, never edited): `sources/DESIGN-SPEC-m3-a4-equal-columns.md`, sha256 **`545825360d535b7ec55114e7e16edeaf8f396ac1e66d3328d0d905bd8e429aea`** (repo blob `151e0a8fd683d09b368cc4bd10b918c4a0f8caa4`), 549 lines.
  - Spec r2 (supersedes r1 for §6A and the 11:33 PM ET rulings; r1 is kept intact): `sources/DESIGN-SPEC-m3-a4-equal-columns-r2.md`, sha256 **`b4c4e5ec8ff2223c1c4d15bb6af88f4fd8c2b2490b8d66f72775235989f07a1a`**, 730 lines, stored byte-identical to Iris's r2 handoff. Where r1 and r2 differ on §6A or the cwd frames, r2 and the addendum govern; this pin still wins over both (spec §1 / pin §0).
  - Cwd-field addendum (verbatim Iris §6A, byte-identical): `sources/DESIGN-SPEC-m3-a4-cwd-field-addendum.md`, sha256 **`1caa2a9e1b8497a0f0527580c9150be190139cd2c1d5697bc59be20a0378e00e`**. Cited below as "addendum".
  - Frames (visual source of truth; box-only at `/workspace/iris-madc-m3a4/`, sha256 re-computed at r5 from those files and equal to addendum / spec r2 §0):

    | Frame | Pixels (@2x) | sha256 |
    | --- | --- | --- |
    | `direction-a-final.png` (Panes, 1440×900; re-rendered r2) | 2976×2020 | `541103c9aef88ea6737c2444998aacd8ff25bbe86d245799bfc596d44eaa4580` |
    | `direction-a-final-1200.png` (Panes, 1200×800; re-rendered r2) | 2496×1820 | `e6eb788f6fdb6c74f884e907679bf9a222a335be61c393d630950e214afde0f4` |
    | `direction-a-final-960.png` (Panes, 960×640; re-rendered r2) | 2016×1500 | `22ab2adb0dba1dbc3fdaf77cf08543f8927b9b7f8075c5b358782d1cbf95dc02` |
    | `direction-a-final-table.png` (Table, 1200×800; unchanged in r2) | 2496×1820 | `e9958f514259faa51ddea3e91589da81670e2f565c00616c455b63adccb01a28` |
    | `direction-a-final-table-960.png` (Table, 960×640; unchanged in r2) | 2016×1500 | `8530abfda78cc144704a337e05d2fa89dc47ea777c176ee1c4750aa0c6e49e43` |
    | `quit-confirm.png` (quit dialog, 960×640; re-rendered r2) | 2016×1500 | `8e6b247868406ad3460d5ef70da94b50d3ca5b1448937fc0d1fb2ee1d97efe0b` |
    | `cwd-field-1440.png` (Panes cwd field, 1440×900; new) | 2976×2020 | `3d338e9ade257d4729922f4f74bf403b302391d4eb0ec6b57b4749c8ea1abd65` |
    | `cwd-field-960.png` (Panes cwd field, 960×640; new) | 2016×1500 | `57296131bef8fb1995fa7e91695ab377b62390e569aa579de174950ed4171ceb` |
    | `cwd-field-states.png` (six cwd field states; new) | 2162×1880 | `2b6d0567af12488297461292c3cd3c9c31e9c35f9a8f9fc1b82b74a24c4e5ba2` |

  - Reference CSS / markup (box-only, not in the repo, mock-up not shipping code; spec r2 §0): `base.css` `6a16377c9b04b4cd1ceb3f1f48edab886e7b9916c089618bb8098b1117e14e09` (unchanged), `final.css` `684b198e37919fea2e0359926443d959c232b5e47aed1b009f58a2898f496c07`, `build_final.py` `25eb178ed807168ec71669efde58cb1393adf2e543e16d8b5061c9fa6f08d2c3`.
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
| **V1 / D-716** (FDR-6(a)) | Layout | **ACCEPT** (10:22 PM ET) | Direction A, Equal Columns, with the Panes/Table toggle (spec §5). Seat visibility below 1200px is **FDR-A4-1** / **D-723** (ruled 11:33 PM ET). Chip wrap is **FDR-A4-5** (ruled 11:50 PM ET). D-693 closes on this merge. |
| **V2 / D-717** | Turn pills | **ACCEPT** (10:22 PM ET) | `RUNNING`, `COMPLETED` neutral `○`; `INTERRUPTED` **fail `✗`** (red, not warn). §4.2. Iris's earlier mock used warn; the ruling and the final spec agree on fail. |
| **V3 / D-718** | Unconfirmed vendor model | **ACCEPT** (10:22 PM ET) | `vendorReported: false` read back from `session/read` → `▲ UNVERIFIED`. §4.3. |
| **V4 / D-719** | Lane and path | **ACCEPT** (10:22 PM ET) | `lane` and `worktree.topLevel` are fields, no pill, note `field · not a receipt`. §4.3. |
| **V5 / D-720** | Worktree head | **ACCEPT** (10:22 PM ET) | `head@open` verified on a valid 40-hex SHA alone, no `chainOk` requirement. **Narrows FDR-4(b)'s** recommended "chain ok and 40-hex". §4.4. |
| **V6 / D-721** | Keys | **ACCEPT** (10:22 PM ET) | `Cmd/Ctrl+Enter` start turn; `Cmd/Ctrl+1–4` focus pane; Interrupt by button or palette only; reserved future key `Cmd/Ctrl+Shift+.` behind a confirm, never `Esc`; no `Ctrl/Cmd+F`. §5.6. |
| **C53 / D-722** | Keys vs D-680 | **RULED** (10:36 PM ET) | The V6 keys **supersede D-680 for those keys only**; D-680 (A3 pin Q2, "No other global shortcut is added") still governs every other shortcut. Recorded on the A3 pin's header `Amended by` pointer (the Q2 cell is not edited; §2.6). |
| **FDR-1 / D-708** | Desktop methods | **ACCEPT** (9:26 PM ET, "Accept all eight recommended defaults") | Allow `seat/list`, `thread/start`, `turn/start`, `turn/interrupt`; **defer `thread/resume`**. The spec asks for `thread/resume` (spec §1, §6.3, §7.2, §8.2, §14.1); **the ruling wins** (§1.3 D2). Amendment 2 §1. |
| **FDR-2 / D-709** | `cwd` source | **ACCEPT** | Typed absolute path field in A4. Surface ruled by **FDR-A4-4** / **D-727** (11:33 PM ET): a field in the pane header, not a palette field (§5.3 / addendum §6A; the r1 spec had no `cwd` surface, §1.3 D3). |
| **FDR-3 / D-710** | Presence-gated lanes | **ACCEPT** | MiniMax Token Plan, Alibaba Coding Plan and `ollama-cloud` (so the seeded `surface-architect` seat) are unreachable from the desktop; the pane shows the engine's refusal verbatim (spec §6.3 "Refused"). Amendment 2 §16.7. |
| **FDR-4 / D-711** | Live evidence | **ACCEPT** | (a) a streamed `servedModel` is verified only after `session/read` confirms it; until then it shows `▲ UNVERIFIED`, never green (**FDR-A4-2** / **D-724**, §4.3); (b) the head label is `head@open`, never "current" (verification narrowed by D-720); (c) one automatic `session/read` per completed turn on a visible pane, **narrowing D-682** (A3 Q4); **further narrowed** (11:51 PM ET, relayed by MADC Architect): exactly one automatic `session/read` after a successful `thread/start`, so `worktree.topLevel` and `head@open` show straight away (§4.5). |
| **FDR-5 / D-712** | Quit with running turns | **ACCEPT** | Quitting interrupts running turns and the quit flow says so (spec §10; amendment 2 §6.1). |
| **FDR-6(b) / D-713** | Safari < 18 | **ACCEPT** | The opaque fallback under the verbatim `@supports not (backdrop-filter: blur(1px))` block is accepted as-is (**D-699**). §5.2. |
| **FDR-7 / D-714** | Carried debt | **ACCEPT** | (a) Mike to confirm D-660, D-661, D-654 on GitHub; (b) the D-663 amendment stays a separate file. |
| **FDR-8 / D-715** | R4 blast radius | **ACCEPT** | R4 cleanup interrupts every pane's running turn; consequence recorded (amendment 2 §1.3; §6.4). |
| **FDR-A4-1** / **D-723** | D-693 seat visibility below 1200px | **RULED** (11:33 PM ET, relayed by MADC Architect) | Seat stays visible at every width; below 1200px it folds into the thread cell as a second line (`THREAD · SEAT`). Hide-seat is a rejected alternative (§11, §5.2). Chip wrap is **FDR-A4-5** (ruled 11:50 PM ET). Together these close **D-693 on this merge**. |
| **FDR-A4-2** / **D-724** | Tone of a streamed-only `servedModel` | **RULED** (11:33 PM ET, relayed by MADC Architect) | Streamed-only `servedModel` (before `session/read` confirms) shows `▲ UNVERIFIED` (warn), never green. Verified only after `session/read`. Reconciles FDR-4(a)'s earlier `○ NO RECEIPT` recommendation. §4.3. |
| **FDR-A4-3** / **D-725**, **D-726** | Iris additions not covered by an earlier ruling | **RULED** (11:33 PM ET, relayed by MADC Architect) | Accept (a) Dismiss pane, (c) hidden-pane tabs with summary chip, (d) reshown pane takes the rightmost slot, (e) Esc on the quit dialog = Keep running, (f) Table stale note instead of automatic `room/inspect` (**D-725**). Defer (b) Reopen pane (**D-726**, carried debt, depends on D-708 / `thread/resume`). §11. |
| **FDR-A4-4** / **D-727** | `cwd` entry surface | **RULED** (11:33 PM ET, relayed by MADC Architect) | Typed absolute `cwd` is entered in a field in the **pane header**, not a palette field. Specified in §5.3 and the cwd addendum. Iris's r2 frames now draw it (`cwd-field-1440.png`, `cwd-field-960.png`, `cwd-field-states.png`). |
| **FDR-A4-5** | Chip wrap (the §5.4 / D5 amendment) | **RULED** (11:50 PM ET, relayed by MADC Architect) | Amend §5.4 to "receipt chips may wrap onto further lines inside their track; they never clip." Together with D-723, **D-693 closes on this merge**. §5.2, §11. |

### 1.2 Text-over-Frame Precedence

Spec §0's five text-over-frame points are adopted unchanged (A3 points still hold; OS-drawn title bar; the Table frames omit `#output` and `#connect-btn` for space; the 960 Panes receipts well is scrolled, not clipped; mock values are illustrative). This pin adds three, forced by rulings:

6. The 1440 Panes frame shows a `prometheus · read-only` composer target and spec §6.3 describes a read-only pane. **Not built in A4** (it is reached only through `thread/resume`, deferred by FDR-1; §1.3 D2).
7. The frames show a streamed-only `servedModel` row as `▲ UNVERIFIED` (daedalus pane, 1440 frame). **The pin matches the frames** (FDR-A4-2 / D-724): streamed-only is `▲ UNVERIFIED`, never green. The `vendorReported: false` read-back row (hephaestus pane) is `▲ UNVERIFIED` as drawn (D-718).
8. The r1 frames showed no `cwd` entry. The r2 / addendum frames (`cwd-field-1440.png`, `cwd-field-960.png`, `cwd-field-states.png`, and the pane headers in the re-rendered `direction-a-final*.png`) draw the header field. §5.3 adopts addendum §6A; the pin wins where they differ.

### 1.3 Pin deviations from the approved spec (closed list)

| # | Spec text | Pin value | Why (evidence) |
| --- | --- | --- | --- |
| D1 | Spec §6.1 "No other word exists" with A3's closed vocabulary extended by `RUNNING`, `COMPLETED`, `INTERRUPTED` | Adopted; this pin is the A3 pin §4.2 amendment that re-closes the list (§4.2) | D-717; A3 pin §4.2 calls the list closed |
| D2 | `thread/resume` throughout: spec §1 ("the window only sends `thread/start`, `thread/resume`, …"), §6.3 starting-thread banner variant, "Read-only (loaded by another client)" state, "Disconnected → `Reopen pane` (sends `thread/resume`)", §6.6 and §6.2 method-error rows for `thread/resume`, §7.2 `read-only` target reason, §8.2 `Open selected thread in pane` (`cmd-pane-open-thread`), §12.2 item 9, §14.1 | **None of these is built in A4.** The window sends only `seat/list`, `thread/start`, `turn/start`, `turn/interrupt` plus the A3 reads. No read-only pane, no `Reopen pane`, no `cmd-pane-open-thread`, no `thread/resume` row. A pane whose connection ended is history only (amendment 2 §4.4): footer `connection ended · history only`, composer target disabled `not connected` | FDR-1 / D-708 defers `thread/resume`. A thread loaded by another client cannot be loaded or interrupted from the desktop (`server.ts:2171-2172`) |
| D3 | Spec §8.2 `New pane on seat ‹seatId›` → `thread/start {seatId}` (no `cwd`) | `thread/start {seatId, cwd?}` with `cwd` from the §5.3 field | FDR-2 / D-709. Without `cwd` the engine records `worktree: null`, so `worktree.topLevel` and `head@open` would always be `—` |
| D5 | A3 spec §5.4 960–1199 row: "chips never wrap or clip" (A3 spec line 292; A3 pin D9) | **Amended (§5.2):** receipt chips **may wrap** onto further lines inside their track; they **never clip** | D-693; D-716 (Layout A with the wrap fix). The seat-visibility half is FDR-A4-1 |
| D6 | A3 pin §5.5 / spec §7.3 closed nine-command list; A3 §9 "no command IDs outside §7.3" | Re-closed at A3's nine plus §5.5 below (spec §8.2 minus `cmd-pane-open-thread`, D2) | spec §8.2; A3 pin:222-241 |
| D7 | Spec §9: deltas not rendered | Adopted; amendment 2 §3.2 additionally discards `item/started` and `item/agentMessage/delta` in Rust (no WebView buffer) | spec §9, §14.2 |

D4 (a streamed-only `servedModel` shown as `○ NO RECEIPT`) was **withdrawn in r5**: FDR-A4-2 / D-724 picked the spec's form, so the pin matches spec §6.4 and the D4 number is kept unused so D5–D7 cites stay stable. Nothing else in this pin deviates from the spec.

---

## 2. Supersession & Continuity

### 2.1 Superseded for M3 desktop only (by this pin and amendment 2)

- A3 pin §6.5 / pin:315-317 (engine death detected only at the next RPC) → amendment 2 §3.3 (`madc/transport-closed`).
- A3 pin §6.4 R1 "UI only ever sends `room/inspect` and `session/read`" (pin:310) → amendment 2 §1.1; new R5 (amendment 2 §1.2).
- A3 pin §6.1 `disconnect_engine` waits behind in-flight RPCs (pin:263) → amendment 2 §6 item 4.
- A3 Q4 / D-682 "never automatically" (pin:53, 211-216) → **narrowed** by §4.5 (FDR-4(c), and further by the 11:51 PM ET post-start `session/read`); selection-triggered reads and D7's "no Read command" stand.
- A3 pin §7 deferrals (pin:321-326) for `ALLOWED_RPC_METHODS`, `launcher.rs` / `main.rs` edits, live `room/updated`, multi-seat composer → this pin and amendment 2.
- A3 pin §5.5 / spec §7.3 closed nine-command list (pin:222-241) → §5.5 below.
- A3 pin §4.2 closed pill vocabulary → §4.2 below (D-717).
- A3 spec §5.4 "chips never wrap or clip" (A3 spec line 292) and A3 pin D9's deferral of the two clipping limits → §5.2 below (D5).
- A3 pin Q2 / D-680 "No other global shortcut is added" (pin:51) → superseded **for the V6 keys only** (C53 / D-722, §2.6, §5.6).
- A3 pin D5 "`src/ipc.ts` stays unchanged" → `connectionEpoch` and typed A4 methods (amendment 2 §4.1).

### 2.2 Unchanged and still binding

- Base protocol pin §1-§4 and amendment 1 (socket, `serve`, `engine.lock`, no auto-retry, exit codes), as amended by amendment 2 where it says so.
- A3 pin §3 tokens/typography, §4.1 evidence gate, §4.3 Room-row mapping, §6.1-§6.4 (except as superseded), D1-D9 (D9's 960–1199 right-column clamp and 140px evidence track stay; its Room tracks are replaced by spec §6.5 (a)3 under FDR-A4-1 / D-723).
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

- **A3 design pin** (status line is left as **DRAFT**, for the Founder; this PR does not change it):
  - one `Amended by` line directly under its status line (pin:3). That pointer also carries the D-680 / C53 supersession: the M3-A4 keys `Cmd/Ctrl+Enter`, `Cmd/Ctrl+1`–`4`, and the reserved `Cmd/Ctrl+Shift+.` (behind a confirm, never `Esc`) supersede "No other global shortcut is added" **for those keys only** (C53, D-722, ruled 2026-11-27 10:36 PM ET); D-680 still governs every other shortcut. The Q2 cell itself is **not** edited (Architect r1 L6).
- **Amendment 1:** one `Amended by` line under its status line (amendment 2 §10).
- **Base protocol pin:** one `Amended by` line after the existing two (amendment 2 §10).
- **README:** index rows for this pin, amendment 2, spec r1 (preserved), spec r2, and the cwd addendum.

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

### 4.3 Pane receipt rows (spec §6.4 adopted)

Rows in spec §6.2's fixed order: method-error rows, `servedModel`, `lane`, `worktree.topLevel`, `head@open`, `hash`.

**`servedModel` row.** Source: the **last** `servedModel` event in `session/read` `events[]` whose `payload.turnId` is the pane's latest turn (`session-store.ts:94-108`; `search.ts:158-172`); live: `item/completed` with `item.kind === "servedModel"` (`types.ts:129-143`; persisted before it is notified, `server.ts:2572-2584`). **The read-back is the only source that can verify; the streamed item is optional.** A streamed item, when one was seen, is used only (1) to show the interim `▲ UNVERIFIED` row (FDR-A4-2 / D-724; never green) and (2) as a consistency check against the read-back. A missed, dropped or never-sent live notification (including a connection that ended and a later user-run read) does **not** block verification: the read-back alone resolves the row, and the "equal to a streamed item" comparison is skipped when no streamed item exists.

| Condition (in order) | Hint → tone | Pill | Chips / note |
| --- | --- | --- | --- |
| No turn yet, or the turn ended without a `servedModel` item (e.g. refused `-32007`) | `neutral` | `○ NO RECEIPT` | `servedModel —` |
| Streamed item seen, no read-back yet | `warn` (FDR-A4-2 / D-724) | `▲ UNVERIFIED` | `servedModel ‹value›`, `vendorReported ‹bool›`; note `streamed · confirmed by session/read after turn/completed`. Never green, even if `vendorReported === true`. |
| Read-back `chainOk === true`, a matching event, a **non-empty** `servedModel` (`trim().length > 0`, `isVerifiedReceipt`, `shell.js:164-184`), `vendorReported === true`, and (**only if a streamed item was seen**) equal to it | `evidenceTone({kind:"servedModel", servedModel, vendorReported}, …)` → `verified` | `✓ VERIFIED` | `servedModel`, `vendorReported true`, `fallbackFrom` when non-null |
| Read-back `chainOk === true`, a matching event, and either `vendorReported === false`, or the matching `servedModel` is empty or whitespace-only (`trim().length === 0`); streamed item optional as above (if one was seen and the read-back is empty, it is also empty and equal) | `evidenceTone({kind:"servedModel", servedModel, vendorReported}, …)` → `warn` (D-718 when `vendorReported === false`; D-718 / D-724 stay literal when the value is empty — there is no `servedModel` evidence that can turn green, so this is `▲ UNVERIFIED`, never `○`, never green) | `▲ UNVERIFIED` | `servedModel` (empty shown as empty), `vendorReported ‹bool›`; note `servedModel empty` when `trim().length === 0`, otherwise as the VERIFIED row with `vendorReported false`. Never green |
| Read-back is a **valid** amendment 2 §3.2.1 (f) result with `chainOk === false` (with or without a streamed item), or a streamed item was seen and its value ≠ the chain value, or `session/read` failed as an engine RPC error (R3) | `fail` | `✗ FAILED` | note `chain not confirmed` (no stream) / `live value not confirmed by chain` / `live value differs from chain` / `session/read: ‹code› ‹message›`; cached read discarded (A3 pin §4.3 B) |

A `session/read` that fails amendment 2 §3.2.1 (f) is **F2**, not a row in this table: the result is not applied, no receipt is rendered from it, and the connection ends (amendment 2 F2, §4.3 ended-connection path).

**`lane` and `worktree.topLevel` rows (D-719).** Field rows: no pill, note `field · not a receipt`. `lane` from the same `servedModel` event (`ServedModelPayload.lane`). `topLevel` from `worktree.open.topLevel` (§4.4 sources); start-truncated with the full path in `title` (spec §6.4). The typed `cwd` is **never** shown as `topLevel`: `topLevel` is the engine's realpath. After a successful `thread/start` and **until the post-start `session/read` (§4.5) or a user-run `Inspect room` returns**, `topLevel` is `—` with the note `not read yet`. After a read with `worktree: null`, it is `—` with the note `no git work tree recorded`.

**`hash` row.** Exactly A3 pin §4.3 B plus the `events` chip; reset to `—` with note `chain head moved · read after turn/completed` on `turn/started` for that thread (spec §6.3).

**Method-error rows.** `✗ FAILED`, chips `code ‹n›` plus each `data` key verbatim; never retried automatically; cleared by the next successful call of the same method on that pane (spec §6.4).

### 4.4 `head@open` row (D-720; narrows FDR-4(b))

Source, in this order within the current epoch: the seq-0 `session.open` `payload.worktree` from the pane's last `session/read` (`session-store.ts:56-68`), or `RoomThreadRow.worktree.open` from a user-run `Inspect room` (`inspect.ts:147-151,246-249`). Both are the same recorded value. The engine exposes **no live HEAD** on the row: `RoomThreadRow.worktree` is the recorded `open`/`close` only (`inspect.ts:147-151`). `inspectRoom` does call `inspectSessionV2` (`inspect.ts:236`); for a seat worktree under `$MADC_HOME/worktrees` that path calls `rereadWorktreeIdentity` (`handoff.ts:636-638`), which runs `git` (`worktree.ts:139-152`) and can set `worktree.missing` (`inspect.ts:290`). That live `missing` probe applies **only** to seat worktrees under `$MADC_HOME/worktrees`; a typed `cwd` elsewhere never reports missing. `session.close` re-reads `worktree.head` only at clean shutdown (`server.ts:567-599`).

| Condition | Tone | Pill | Chips / note |
| --- | --- | --- | --- |
| After a successful `thread/start`, before the post-start `session/read` (§4.5) or a user-run `Inspect room` has returned | `neutral` | `○ NO RECEIPT` | `sha —`; note `not read yet` |
| `worktree` null (no `cwd`, or a v1 session) or `head` null (unborn branch), once a read has returned | `neutral` | `○ NO RECEIPT` | `sha —` |
| `head` matches `/^[0-9a-f]{40}$/` | `evidenceTone({kind:"sha", sha: head})` → `verified` | `✓ VERIFIED` | `sha ‹12 hex›` (full 40 in `title` and accessible name) |
| Same, `worktree.missing === true` | as above (bound to the recorded SHA) | `✓ VERIFIED` | adds note `worktree missing on disk` (spec §6.4). This `missing` flag is a live probe **only** for seat worktrees under `$MADC_HOME/worktrees` (see sources above); a typed `cwd` elsewhere never reports missing. |

Both sources are applied only after the amendment 2 closed checks pass: §3.2.1 (f) for a `session/read` result (the seq-0 `session.open` payload and its `worktree`) and §3.2.1 (g) for a `room/inspect` row (`worktree.open`, `worktree.close`, `worktree.missing`); a failure is F2 and nothing is rendered from that result.

No `chainOk` requirement (D-720). The label is always the literal `head@open`; never "head" or "current" (FDR-4(b)).

### 4.5 Automatic `session/read` (FDR-4(c), further narrowed 11:51 PM ET)

Two automatic reads, both single-flight per thread, A3 pin §4.3 B dedupe and stale-drop. **Single-flight means coalesce, not drop:** if a `turn/completed` trigger fires while a post-start, earlier-completion, or in-flight user selection (A3 Q4) `session/read` for that thread is still in flight, the desktop enqueues **exactly one follow-up** `session/read` for that thread, issued after the in-flight call returns (success or failure). Several completions during one flight collapse to that one follow-up. The follow-up is **suppressed** if, while the first read is in flight, the epoch ends or the pane is dismissed. A hidden pane still defers until it is shown. A user-run `Inspect room` does not itself enqueue a follow-up (**D-682**; D-729 keeps this ban). Named test: amendment 2 §13 (15). Neither is a poll, a timer, a bulk read, a connect-time read, a read after a user-run `Inspect room` (**D-682**; D-729 keeps this ban), or a `room/updated` trigger. Selection reads (A3 Q4) are unchanged. There is still no "Read thread" command (D7).

1. **After a successful `thread/start`** (ruled 2026-11-27 11:51 PM ET, relayed by MADC Architect; a further narrowing of D-682 on top of FDR-4(c)): exactly **one** `session/read {threadId}` once the `{thread}` result is accepted, so `worktree.topLevel` and `head@open` can show straight away. **None** is sent before `thread/start` succeeds, **none** after a failed start (R3 / R5 / F2), and **none** as a consequence of a user-run `Inspect room` (**D-682**; D-729 keeps this ban). The note `not read yet` applies only during the gap between a successful start and this read returning (or a user-run `Inspect room` arriving first). A late or stale-epoch result changes nothing (§6.1).
2. **After `turn/completed`** (FDR-4(c) / D-711): **at most one** `session/read {threadId}` for an own-connection pane that is visible (exactly one when no `session/read` for that thread is already in flight; otherwise the coalesced follow-up above). A turn that completed while its pane was hidden gets that same single read when the pane is shown. A completion that arrives while the post-start, earlier-completion, or user-selection read is still in flight is not dropped: it schedules the follow-up above, unless the epoch ended or the pane was dismissed mid-flight.

### 4.6 Status strip model slot and copy commands

- The status strip's model slot keeps `model —` (spec §5.1; A3 pin §5.1): each pane carries its own model.
- `Copy served model`: enabled iff the focused pane's `servedModel` row is `✓ VERIFIED`. `Copy chain head`: a verified `hash` on the focused pane or selected row. **`Copy head@open`** (new): enabled iff the focused pane's `head@open` is `✓ VERIFIED`; copies 40 hex.

---

## 5. Surface, Layout & Palette Contract (spec §5, §7, §8 adopted, as amended here)

### 5.1 Regions and views

Spec §5.1-§5.3 adopted: focus bar (52px) → `<main>` → status strip (34px); the Panes/Table segmented toggle (`role="radiogroup"`, roving tabindex); default view Panes when a pane exists, else Table; `Focus Engine` switches to Table; switching views sends no request and discards nothing. The Table view is the A3 Room screen as shipped plus the toggle, the §5.2 layout fix and the stale note (FDR-A4-3(f) / D-725).

### 5.2 Panes grid, D-693 and D-699

- **Panes grid:** spec §5.4 adopted: `paneColumns(W)` = 4 at W ≥ 1440, 2 at 960–1439; equal columns `repeat(N, minmax(0,1fr))`, gap 14px, `<main>` padding `20px 28px`; wide row form iff pane width ≥ 520px. Below 960×640 the A3 guard rows apply (Q5 `minWidth`/`minHeight` unchanged).
- **Hidden panes (FDR-A4-3 / D-725, ruled 11:33 PM ET):** spec §5.5 adopted (hidden, never closed; a hidden pane that holds a thread keeps its thread and lock, amendment 2 §16.4). At ≥ 1440 each hidden pane is a tab (seat plus the pane's header pill at `.pill--sm`); below 1440 one summary chip `N hidden · names` (activating it opens the palette pre-filtered to `Show pane`). Showing a hidden pane puts it in the rightmost visible slot; the pane that was there becomes hidden. `Dismiss pane` removes only a pane that holds no thread (Draft, or Start failed). Reopen pane is deferred (FDR-A4-3(b) / D-726; needs `thread/resume`).
- **Scroll:** spec §5.6 adopted (Panes: `<main>` does not scroll; each pane's receipts well is its only scroll region. Table: A3 rules).
- **§5.4 amendment (D5; FDR-A4-5, ruled 2026-11-27 11:50 PM ET, relayed by MADC Architect):** A3 spec §5.4's "chips never wrap or clip" is amended for the M3 desktop to **"receipt chips may wrap onto further lines inside their track; they never clip."** `.cell-receipt` and `.receipt-chips` get `flex-wrap: wrap; row-gap: 6px`; rows grow to fit; notes wrap on their own line; no rule may hide overflow in a way that cuts a chip; full values stay in `title`. Below 1200px the Receipts-well row becomes two lines (`112px minmax(0,1fr)`), so the `exit 20` `pid` chip and the `manualFix` note fit at 960 (spec §6.5 (b); frame `direction-a-final-table-960.png`). Together with D-723, **D-693 closes on this merge.**
- **Seat visibility below 1200px (FDR-A4-1 / D-723, ruled 2026-11-27 11:33 PM ET, relayed by MADC Architect):** the seat stays visible at every width. At ≥ 1200px A3's five Room tracks stay; at 960–1199px the seat folds into the thread cell as a second line (`THREAD · SEAT`), tracks `140px minmax(96px, 0.62fr) 48px minmax(168px, 1.9fr)`, gap 8px, replacing D9's Room tracks while D9's right-column `clamp(360px, 37.5vw, 440px)` stays (spec §6.5 (a)). **Rejected alternative:** hide the `seat` column below 1200px (A3 pin D9's proposal).
- **D-699 (FDR-6(b) confirmed):** Safari < 18 paints the glass opaque under the verbatim `@supports not (backdrop-filter: blur(1px))` block and that is accepted as-is (no A3 spec §3.4 amendment, no prefix-aware `@supports`). The quit dialog shares the palette's rule and fallback (spec §3, §11). Pane bodies are tier 1/tier 0 (no `backdrop-filter`); no element depends on glass for legibility.

### 5.3 Starting a pane, and the `cwd` field (FDR-2; D3; FDR-A4-4 / D-727)

This section **adopts addendum §6A** (`sources/DESIGN-SPEC-m3-a4-cwd-field-addendum.md`, sha256 `1caa2a9e…378e00e`; also Iris spec r2 §6A). The addendum is the visual and interaction source of truth for placement, typography, keys, the local check and accessibility. The contracts below are binding; where this pin and the addendum differ, this pin wins.

- `New pane on seat ‹seatId›` (one palette row per `seat/list` entry; `ok:false` rows disabled with `seat load failed ‹code›`) creates a **Draft** pane immediately, closes the palette, takes the rightmost visible slot if N visible panes already exist, and focuses the header `cwd` field with the prefill selected. **Nothing is sent** until `Enter` or `START THREAD`. There is **no palette cwd step** (rejected alternative, §11). No new palette command is added.
- **Where the field sits (addendum §6A.2).** In the pane header, as a cwd block under the top row (position + seat + thread line `no thread yet` at the left; turn pill `○ IDLE` at the right). The block is: row 1, key `cwd` and the input; row 2, the field state at the left and a `START THREAD` button at the right; row 3, the reason line (and, for `REFUSED`, chips then issues). Same markup at 960, 1200 and 1440; only the input width changes. Input is a tier-0 well, placeholder `/absolute/path · optional`. Fail states use a `--madc-red` border. A started pane replaces rows 1–3 with a 22px started row: `cwd` key | read-only value | `○ STARTED`. Until `thread/start` returns, the receipts well is replaced by one muted line, `No thread yet. Receipts appear after thread/start returns.` (spec r2 §6.2).
- **When it is editable (addendum §6A.3).** Editable only before a successful start, including after a failed start (Draft and Start failed). It locks (`readonly`, 65% opacity) while Starting thread, and is a plain read-only value (no input chrome) after a successful start, including after the connection ends. To use another path, open another pane. The started value is `Thread.cwd` from the result (`—` muted when `null`); if that differs from the typed text (a `worktree: true` seat), a second line reads `engine path · typed ‹sent path›`. The typed `cwd` is **never** shown as `topLevel`.
- **Six field states (addendum §6A.4).** The field state is status text (glyph + word), **not a pill**, and is not in `ALLOWED_PILL_LABELS`. Tone is only `neutral` or `fail`; it can never be `verified` or `warn`. Nothing about a path ever goes green. `STARTED` means only that the engine returned a thread.

  | # | State | Glyph + word | When | Request |
  | --- | --- | --- | --- | --- |
  | 1 | Empty | `○ NO CWD` | text is `""` | none |
  | 2 | Typed, not yet checked | `○ UNCHECKED` | non-empty, passes `cwdCheck` | none |
  | 3 | Client-side reject | `✗ REJECTED` | non-empty, fails `cwdCheck` | none (Enter sends nothing) |
  | 4 | Engine reject | `✗ REFUSED` | `thread/start` returned an error or R5 | already sent; not re-sent automatically |
  | 5 | Thread starting | `○ STARTING` | `thread/start` in flight | pending, single-flight |
  | 6 | Started | `○ STARTED` | `{thread}` returned | none |

  State 4 clears only when the text is edited or the next `thread/start` on this pane succeeds, never by a timer (C15).
- **Local check (addendum §6A.5).** `cwdCheck(text)` is a pure function, no I/O. The text is **never trimmed or normalised**; the value sent is the exact typed string. `""` is ok (state 1). Reject (state 3) if the text contains NUL, is longer than 4096 UTF-8 bytes, starts with `~`, or does not start with `/` (POSIX; Windows is out of scope). `/` alone, internal spaces and a trailing `/` are ok. `REJECTED` disables `START THREAD`. This matches amendment 2 §1.2 on POSIX, so a passing text can only fail at the engine. An R5 is then a defect guard: reason verbatim, no chips, connection stays `CONNECTED`, `disconnect_engine` is never called.
- **Keys (addendum §6A.6).** `Enter` in the field (no modifiers) starts the thread in states 1, 2 and 4, only while `CONNECTED`; in state 3 it sends nothing; in state 5 it is ignored. `Esc` **reverts** to the baseline text (the prefill at creation, or the last text sent) and does not dismiss the pane, send a request, or interrupt; if the text is already the baseline, focus moves to the pane. `Cmd/Ctrl+Enter` in this field starts neither a thread nor a turn (those keys start a turn only from the composer). Prefill is the last `cwd` sent in this window (none on first use).
- **Request (addendum §6A.7).** Exactly the keys `seatId` and, only when the text is non-empty, `cwd` (unchanged). One request per Enter or click. Empty → `thread/start {seatId}` (engine records `worktree: null`). Existence and repo resolution are the engine's. After a successful start, exactly one automatic `session/read` runs (§4.5); none before success and none on a failed start. During the gap before that read returns, `topLevel` and `head@open` show `not read yet`.
- **Long paths (addendum §6A.8).** Unfocused or read-only values truncate from the **start** with a leading `…` (`direction: rtl`, `text-align: left`, `text-overflow: ellipsis`, text in `<bdi>`). Truncation is presentation only; the stored value is unaltered; the full path is in `title` and the accessible name.
- **Frames.** `cwd-field-1440.png`, `cwd-field-960.png`, `cwd-field-states.png`, and the pane headers in the re-rendered `direction-a-final*.png` (hashes in the artifacts table).

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
| Panes | `New pane on seat ‹seatId›` (`cmd-pane-new:‹seatId›`), creates the pane and focuses the header `cwd` field (§5.3) |
| Panes | `Show pane ‹seat›` (`cmd-pane-show:‹paneId›`) |
| Panes | `Hide pane ‹seat›` (`cmd-pane-hide`) |
| Panes | `Dismiss pane ‹seat›` (`cmd-pane-dismiss`), only for a pane that holds no thread: Draft, or `thread/start` failed (FDR-A4-3(a) / D-725) |
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
| `Esc` | palette; quit dialog | closes the palette (A3); closes the quit dialog as **Keep running**, which invokes `ack_quit` (FDR-A4-3(e) / D-725; amendment 2 §6.1); **never interrupts anything** |

- Interrupt has **no key** in A4. `Cmd/Ctrl+Shift+.` is **reserved** for a future interrupt key **behind a confirm**, and is never `Esc`; A4 does not bind it.
- Modifier detection is A3 Q2's (`metaKey && !ctrlKey` on macOS, `ctrlKey && !metaKey` elsewhere). No `Ctrl+F` / `Cmd+F`.
- **D-680 supersession, for these keys only (C53, D-722, ruled 2026-11-27 10:36 PM ET):** `Cmd/Ctrl+Enter`, `Cmd/Ctrl+1–4` and the reserved `Cmd/Ctrl+Shift+.` supersede A3 pin Q2's "No other global shortcut is added" (D-680). D-680 still governs every other shortcut; adding any other key needs a new ruling. The A3 pin records the supersession on its header `Amended by` pointer, not in the Q2 cell (§2.6).

### 5.7 Quit flow (FDR-5)

Spec §10 adopted, with amendment 2 §6.1 as the mechanism: no running own-connection turns → quit immediately; one or more → the `role="alertdialog"` dialog (frame `quit-confirm.png`), body text verbatim, the list of running own-connection turns (hidden panes included, suffix `(hidden)`), `KEEP RUNNING` default focus, `QUIT AND INTERRUPT ‹n› TURN(S)` neutral (no red button), `Tab` trapped, `Esc` = Keep running (FDR-A4-3(e) / D-725). Before the dialog renders, the UI invokes `quit_dialog_shown` once with the `{ epoch, requestId }` from `madc:quit-requested`, and opens the dialog only if it returns `accepted: true` **and** the epoch is still the current `connectionEpoch`, the state is still `CONNECTED`, and that `requestId` is still the active candidate (amendment 2 §4.3, §6.1). A terminal for that epoch during the wait settles the candidate and marks it dead: no dialog opens. A delayed `madc:quit-requested` for an older or already-acknowledged `requestId` is ignored (amendment 2 §6.1 `acceptQuitRequest`). **Keep running** (button or `Esc`) invokes `ack_quit`, which re-arms the quit guard (amendment 2 §6.1); it does not exit. Confirming sends **zero** `turn/interrupt` and **zero** `disconnect_engine`; it invokes `confirm_quit` once, and the engine records the interruptions.

**Builder default (amendment 2 §6.1):** if none of `quit_dialog_shown`, `ack_quit`, or `confirm_quit` arrives within 3 s of the `madc:quit-requested` emit, **or the emit hand-off itself fails**, Rust settles that `requestId` (a late command returns `accepted: false` and opens or refocuses nothing) and sets the quit-fallback mark. The next close while the mark is live (within `QUIT_FALLBACK_TTL = 30 s`, amendment 2 §6.1) runs the amendment 2 §6 9 s exit path (the engine interrupts the turns). The mark expires only after `QUIT_FALLBACK_TTL` (counted on a monotonic clock); after it expires, a later close shows the dialog again. Once the dialog has been shown-acked, a second close only refocuses the existing dialog: no second dialog, no exit, no `turn/interrupt`. **FDR-A4-6** (FOUNDER_DECISION_REQUIRED, default accept): a renderer that hangs after `quit_dialog_shown` can be escaped only by an OS force quit, OS kill or crash.

### 5.8 Accessibility

Spec §11 adopted (pane `region` names, turn pill accessible names, full values in `title`/accessible names, one polite live region per window announcing status changes once, `forced-colors` / `prefers-reduced-motion` / `prefers-reduced-transparency` per A3 §3.4 and D8). Nothing animates.

---

## 6. Connection State Machine & Failure Mapping

A3 pin §6 binds unchanged (states, single-flight, `connect_engine` grammars G1-G6, R2-R4, no auto-retry), plus amendment 2 (§2.4 lifecycle invariants L1-L14, §3.3 `madc/transport-closed`, §4 epochs and §4.3 `acceptTerminal`, §5 fail-closed rows, §6 exit bound, §6.1 quit hook). This section adds the per-pane machine.

### 6.1 Pane states (spec §6.3, minus the read-only state, D2)

| State | Entered when | Turn pill | Send target | Interrupt |
| --- | --- | --- | --- | --- |
| Draft | `New pane on seat` created the pane; no `thread/start` sent yet (FDR-A4-4 / D-727; addendum §6A) | `○ IDLE` | disabled `no thread loaded` | disabled; `cwd` field editable; `START THREAD` in the header cwd block; receipts well is the one-line `No thread yet` note; `Dismiss pane` allowed |
| Starting thread | `thread/start` in flight (single-flight per pane) | `○ IDLE` | disabled `starting thread` | disabled; `cwd` field locked (`readonly`, state `○ STARTING`); no automatic `session/read` yet |
| Start failed | `thread/start` rejected by an RPC error (R3) or an R5 string; **not** F2 | `○ IDLE` | disabled `no thread loaded` | disabled; `cwd` field stays editable (state `✗ REFUSED`); header `START THREAD` retries; **no** automatic `session/read`; connection stays `CONNECTED`; `Dismiss pane` allowed |
| Idle | `thread/start` resolved, no turn yet | `○ IDLE` | enabled | disabled; `cwd` field read-only (`○ STARTED`, `Thread.cwd`); exactly one automatic `session/read` is issued on entry (§4.5); until it (or a user `Inspect room`) returns, `topLevel` and `head@open` show `not read yet` |
| Running | `turn/start` resolved `inProgress`, or `turn/started` | `○ RUNNING` | disabled `turn active` | enabled (own connection) |
| Interrupt pending | `turn/interrupt` sent, no `turn/completed` yet | `○ RUNNING` | disabled `turn active` | disabled, footer `turn/interrupt sent` |
| Completed | `turn/completed` `completed`, confirmed by the §4.5 read | `○ COMPLETED` | enabled | disabled |
| Interrupted | `turn/completed` `interrupted` / `turn.end` `interrupted` | `✗ INTERRUPTED` | enabled | disabled |
| Failed | `turn/completed` `failed` / `turn.end` error | `✗ FAILED` | enabled | disabled |
| Refused | `turn/start` rejected `-32007` (e.g. `surface-architect`, reason `headless-not-permitted`) | `○ IDLE` (no turn exists) | disabled `refused -32007` | disabled |
| History (connection ended) | a **started** pane's epoch ended (amendment 2 §4.4) | `○ DISCONNECTED` | disabled `not connected` | disabled; footer `connection ended · history only`; `cwd` remains the started read-only value |

Rules: the machine is driven only by current-epoch `rpc_request` results and accepted events (amendment 2 §4.2). A stale result or event changes nothing (A3 N5, extended). `turn/completed` for a turn the pane did not start is ignored. A `turn/start` result that arrives after the epoch changed creates or advances no pane.

**Draft, Starting thread, and Start failed when the epoch ends (builder default).** These panes hold no thread, so they do not become History. The typed `cwd` is kept, nothing is sent (a Starting `thread/start` is abandoned with the connection; no automatic retry), and the field stays editable. A Starting pane returns to state 1 or 2 (addendum §6A.4: reason `connection ended before thread/start returned`). That includes an F2 on the `{thread}` result (invalid-frame): F2 ends the connection (`Open → Terminated`), so it is this return-to-Draft path, **not** Start failed. A Start-failed pane keeps `✗ REFUSED` until the text is edited or a later start succeeds (C15). After a later reconnect, the pane is rebound to the new epoch, stays a Draft (or Start failed, still editable), and still sends nothing until Enter or `START THREAD`. `Dismiss pane` remains allowed.

### 6.2 `rpc_request` rejection mapping (extends A3 pin §6.4)

| Class | Source | Rendering |
| --- | --- | --- |
| R1 | allowlist refusal, string unchanged (`launcher.rs:46`) | defect guard on the action; state unchanged; no `disconnect_engine` |
| **R5** (new) | `RPC params refused by desktop shell for ‹method›: ‹reason›` (amendment 2 §1.2) | as R1; **never** `disconnect_engine` (killed-mutation tests, amendment 2 §13 items 2b and 10) |
| R3 | `engine RPC error: ‹json›` | pane-scoped method-error row; connection stays `CONNECTED` |
| R2 / R4 | unchanged | unchanged; R4 = one `disconnect_engine`, which ends every pane's running turn (FDR-8, §6.4) |

### 6.3 Engine errors rendered in a pane (R3; text verbatim, sanitised)

This section's method-error / receipt rows apply to **`turn/start` and `turn/interrupt` only**: `-32002` (thread not loaded here) → method-error row, target `no thread loaded`; `-32003` (`turn/interrupt`, unknown turn) → row only; `-32004` (`turn/start`, a turn already active; `data.activeTurnId`) → row, target `turn active`; `-32007` (`data.providerId`, `reason`, `status`) → Refused, `code` and `reason` chips, `providerId`/`status` in `title` and accessible name (spec §6.3); `-32008` (provider unavailable) → row with `reason`; `-32010` (evidence refusal) → row with `issues`.

Every `thread/start` **RPC error** (R3), including `-32602` (`data.issues`) and `-32009` (session write failed), and also `-32005` / `-32006` (seat missing or invalid) and an R5 string, goes to the §5.3 state 4 `✗ REFUSED` / Start failed path, with the real code (C9/C10/C16/C17). `-32005` / `-32006` also mark the seat unavailable. These are **not** also rendered as a method-error row or as a `✗ FAILED` receipts-well row. An F2 on the `{thread}` result is **not** this path: it ends the connection and the Starting pane returns to Draft as in §6.1 (epoch end).

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
6. **8 MiB line cap** is an accepted known limit (unmeasured) for `session/read` and `room/inspect` (amendment 2 §12.3). A result over the cap is F2 (`oversize-frame`) and ends the connection; FDR-8 then interrupts every pane's turn. The 4096-event queue bound remains a proposal, not a measurement.
7. **Spec frames are mock renders** of `final.css`, not the shipped WebView; live font rendering under CSP stays with D-688.
8. **Tauri `emit` spike** (amendment 2 §12 item 8): the builder verifies in a real window, **before implementing the owner**, that `emit` is a non-blocking hand-off. If an `emit` can block, stop and file a Surface amendment. L1 and L5 depend on this.
9. **`shutdown(Both)` wake** (amendment 2 §12 item 6): a blocked reader must become runnable when the write half calls `shutdown(Both)`, so L7's cancellation is not stuck behind L8 (no read timeout). The builder verifies this before implementing the owner.
10. **`QUIT_FALLBACK_TTL = 30 s`** (amendment 2 §6.1, §12 item 3): a builder default, pending Founder confirmation. The TTL is counted on a **monotonic** clock from when the mark was set. While the mark is live, a second close silently exits and interrupts turns, with no dialog. After the TTL, a later close shows the dialog again.

---

## 9. CI-Testable Acceptance Criteria

All checks run headless in `npm run check` (tsc, Biome, `node --test`, `bun test`) and `cargo test`, with **zero network, zero keychain, zero real TTY, zero real model, zero live engine spawn** in the JS tests (fake `invokeFn`, fake event listener, the A3 fake-DOM harness plus §2.3's extensions); Rust tests use fake socket peers. Protocol tests are amendment 2 §13.

Spec §12.2 items 1-8, 10-11, 13, 16-19 are adopted as written, with these edits:
- **Item 5 (servedModel row):** applies **as written** (FDR-A4-2 / D-724): streamed-only → hint `"warn"` → `▲ UNVERIFIED`, even with `vendorReported: true`; never green until `session/read` confirms. After a valid read-back: a **non-empty** `servedModel` (`trim().length > 0`) with `vendorReported: true` → `verified` / `✓ VERIFIED`; `vendorReported: false`, or an empty or whitespace-only `servedModel`, → hint `"warn"` / `▲ UNVERIFIED` (D-718 / D-724 stay literal; never green). No `servedModel` item at all remains `neutral` / `○ NO RECEIPT`. Never a bare `○`.
- **Item 9 (read-only via `thread/resume`):** **dropped** (D2). Replaced by: no code path sends `thread/resume`; the palette has no `cmd-pane-open-thread`; no pane renders a `read-only` banner or target reason.
- **Item 12 (live updates):** restated to match amendment 2 §3.4 item 2 and §13 (11) and (14): exactly one automatic `session/read` after a successful `thread/start` (**D-729**, 11:51 PM ET narrowing of D-682), plus **at most one** automatic `session/read` per completed turn on a visible pane (completions during a flight coalesce; §4.5), and none for a hidden pane until it is shown; **zero** automatic reads before `thread/start` succeeds, after a failed start, or as a consequence of a user-run `Inspect room` (**D-682**; D-729 keeps this ban); `room/updated` **never** triggers a `room/inspect` or a `session/read`, for any `reason`. The spec's "`reason` ≠ `"turn"` never reads" is weaker than the pin and is not adopted.
- **Item 14 (static CSS):** the "no `display: none` on seat text below 1200px" and 960–1199 track assertions apply (FDR-A4-1 / D-723; hide-seat is rejected). The wrap assertions (`.cell-receipt` / `.receipt-chips` have `flex-wrap: wrap`; two-line Receipts row below 1200px) apply (FDR-A4-5, ruled 11:50 PM ET).
- **Item 15 (quit):** no running own-connection turns → no dialog. Running → dialog lists exactly those turns, hidden panes included (there are no read-only panes in A4, D2). Default focus is Keep running; `Esc` keeps running and invokes `ack_quit`. The UI invokes `quit_dialog_shown` once, with `{ epoch, requestId }`, and renders the dialog only on `accepted: true` when the connection is still `CONNECTED` and that request is still the active candidate. A terminal during that wait opens nothing. A delayed event for an older or acknowledged `requestId` neither reopens nor refocuses a dialog. Confirming invokes `confirm_quit` once, `disconnect_engine` zero times, `turn/interrupt` zero times. The following `madc/transport-closed { reason: "exit" }` is handled with no `FAILED` and no `disconnect_engine` (amendment 2 §4.3); a shown quit dialog is dismissed. If none of `quit_dialog_shown`, `ack_quit`, or `confirm_quit` arrives within 3 s of the emit, **or the emit hand-off itself fails**, that `requestId` is settled, the quit-fallback mark is set (late commands are refused, nothing opens), and the next close while the mark is live runs the amendment 2 §6 9 s exit path. The mark expires only after `QUIT_FALLBACK_TTL = 30 s` (counted on a monotonic clock); after it expires, a later close shows the dialog again. Once shown-acked, a second close only refocuses the existing dialog (no second dialog, no exit). After `quit_dialog_shown`, a hung renderer is escaped only by an OS force quit (FDR-A4-6, default accept).
- **Item 17 (palette ids):** exactly A3's nine plus §5.5's list.

**Numbering vs spec r2 §12.2.** This pin's added items 20–27 are A4 additions and are **not** spec r2 §12.2 items 20–21. Spec r2 item 20 (the `cwd` field) is pin item 25 (C1–C17). Spec r2 item 21 (no Reopen / no `thread/resume`) is the pin's item 9 replacement (dropped, D2).

Added by this pin:
20. **No decorative green over a full pane run:** fake events drive a pane Idle → Running → Completed / Interrupted / Failed; no element resolves `data-tone="verified"` except a §4.3/§4.4 row whose receipt verifies; `RUNNING` / `COMPLETED` are `neutral`; `INTERRUPTED` / `FAILED` are `fail`.
21. **`head@open` (D-720):** 40-hex → `verified` with or without `chainOk`; null → `neutral`; `missing: true` keeps `verified` and adds the note; the label string is exactly `head@open`.
22. **Pane machine (§6.1):** table-driven over every transition; a second Start while Running sends nothing; an `{}` interrupt reply for a finished turn changes nothing; a stale-epoch result or event changes no pane, receipt or connection state; a `turn/start` result after `disconnect_engine` creates no pane. A Draft, Starting, or Start-failed pane whose epoch ends keeps its typed `cwd`, sends nothing, and stays editable after reconnect (it does not become History).
23. **Presence honesty:** no `turn/start` carries a `mode` key; a fake `-32007` with `reason: "headless-not-permitted"` renders `code` and `reason` chips verbatim, the pane stays `○ IDLE`, the connection stays `CONNECTED`, and `disconnect_engine` is invoked zero times.
24. **R5 / R1 killed mutation (UI):** with a Running pane and `CONNECTED` state, an R5 or R1 rejection invokes `disconnect_engine` **zero** times and the pane stays Running.
25. **`cwd` field (§5.3 / addendum §6A.10), C1–C17:**
    - C1. `cwdCheck` table: `""` and `"/"` and `"/a b/"` ok (value unchanged); `"relative"`, `"./x"`, `"~/x"`, `" /x"` (leading space) reject, with the `~` reason only for `~`; a NUL rejects; 4096 bytes ok, 4097 rejects. Text is never trimmed.
    - C2. Field state returns only the six words and only `neutral` or `fail`; never `verified` or `warn`. No element in the cwd block has a verified/warn pill.
    - C3. Enter in state 3 sends zero `rpc_request`. Enter in states 1/2/4 sends exactly one `thread/start` whose params keys are exactly `{seatId, cwd}`, or exactly `{seatId}` when the text is empty.
    - C4. A second Enter or click while state 5 sends nothing.
    - C5. `Esc` restores the baseline text and sends nothing; `Esc` on an unchanged field only moves focus; the pane is never dismissed by `Esc`.
    - C6. `Cmd/Ctrl+Enter` in the cwd input sends neither `thread/start` nor `turn/start`. Those keys start a turn only from the composer.
    - C7. The input is `readonly` in state 5 and absent (plain text) in state 6; editable in states 1–4, including after a failed start.
    - C8. State 6 shows `Thread.cwd` from the result (tested with a result whose `cwd` ≠ the typed text). The typed `cwd` never appears in any `topLevel` chip.
    - C9. `-32602` with `data.issues` renders `✗ REFUSED`, chip `code -32602`, each issue verbatim; field stays editable; connection stays `CONNECTED`; `disconnect_engine` is invoked zero times.
    - C10. An R5 string renders `✗ REFUSED` with the reason verbatim and no chips; `disconnect_engine` is invoked zero times.
    - C16. `-32009` on `thread/start` renders `✗ REFUSED`, chip `code -32009`; field stays editable; connection stays `CONNECTED`; `disconnect_engine` is invoked zero times; no `✗ FAILED` receipts-well row.
    - C17. `-32005` and `-32006` on `thread/start` (one fixture each) render `✗ REFUSED` with the real code and mark the seat unavailable; field stays editable; connection stays `CONNECTED`; `disconnect_engine` is invoked zero times.
    - C11. `New pane on seat ‹seatId›` creates a Draft pane and sends no `rpc_request`; composer target reads `no thread loaded`; `Dismiss pane` on it sends nothing and removes it.
    - C12. No `keydown` handler reacts to `f` with Ctrl or Meta; no new global handler exists.
    - C13. Long-path static assertions: unfocused value rule has `direction: rtl`, `text-overflow: ellipsis` and `<bdi>`; stored value equals the typed text; `title` holds the full path.
    - C14. No rule in `.cwd`, `.cwd-in` or `.fst` uses `--madc-green` or `--madc-yellow`.
    - C15. State 4 is cleared only by an edit or a successful start, never by a timer.
26. **Keys (C53):** the only new global handlers are `Cmd/Ctrl+Enter` (composer input only) and `Cmd/Ctrl+1–4`; `Cmd/Ctrl+Shift+.` and `Esc` never send `turn/interrupt`.
27. **Engine untouched:** the diff touches no file under `packages/engine/`.

---

## 10. Ledger handling (for Clio, on Founder merge)

| Item | Disposition on merge |
| --- | --- |
| D-660, D-666 | **Folded in** via amendment 2 §6 (9 s total exit bound pinned; code fix lands in the A4 build). D-660 stays `needs-confirmation` until Mike's ruling is on GitHub (FDR-7(a)) |
| D-665 | **Folded in** by amendment 2 §7 (stdin error → exit 0 text for amendment 1 §3(a)) |
| D-693 | **Closes on this merge.** Seat visibility (FDR-A4-1 / D-723, 11:33 PM ET) and chip wrap (FDR-A4-5, 11:50 PM ET) are both ruled. |
| D-699 | **Folded in:** Safari < 18 opaque fallback confirmed (FDR-6(b)) and pinned in §5.2. Cited instead of D-694, which it superseded |
| D-682 (A3 Q4) | **Narrowed** by §4.5: FDR-4(c) (**at most one** automatic read per completed turn on a visible pane; completions during a flight coalesce) and further by the 11:51 PM ET ruling (exactly one automatic read after a successful `thread/start`). The ban on a read after a user-run `Inspect room` is this item and **stands** (D-729 does not repeal it). Selection-triggered reads and D7's "no Read command" stand. |
| D-680 (A3 Q2) | **Superseded for the V6 keys only** (C53 / D-722); otherwise unchanged |
| D-654, D-661, D-663, D-664 | **Stay open**, untouched (D-663 stays a separate amendment, FDR-7(b) / D-714) |
| D-688, D-648, D-670, D-676 | Carried unchanged |
| D-705, D-706 | Spec gate and this pin: satisfied by this PR at Founder merge |
| D-707, D-708..D-715, D-716..D-721, D-722, D-723..D-729 | Relayed rulings, applied in §1.1, §11 and amendment 2 §14; **`needs-confirmation`** (Clio ids, not on GitHub) |
| FDR-A4-1 / D-723 | **RULED** 11:33 PM ET (relayed by MADC Architect): seat stays visible, folded into the thread cell below 1200px; hide-seat rejected |
| FDR-A4-2 / D-724 | **RULED** 11:33 PM ET: streamed-only `servedModel` is `▲ UNVERIFIED`, never green; verified only after `session/read` |
| FDR-A4-3 (a),(c)–(f) / D-725 | **RULED** 11:33 PM ET: Dismiss pane, hidden-pane tabs with summary chip, rightmost-slot reshow, Esc = Keep running, Table stale note |
| FDR-A4-3(b) / D-726 | **RULED** deferred 11:33 PM ET: Reopen pane is carried debt; depends on D-708 (`thread/resume`) |
| FDR-A4-4 / D-727 | **RULED** 11:33 PM ET: typed absolute `cwd` is a field in the pane header, not a palette field |
| FDR-A4-5 / D-728 | **RULED** 11:50 PM ET (relayed by MADC Architect, `needs-confirmation`): chips may wrap, never clip. Together with D-723, D-693 closes on this merge. |
| D-729 | **RULED** 11:51 PM ET (relayed by MADC Architect, `needs-confirmation`): exactly one automatic `session/read` after a successful `thread/start`; none before it or on a failed start; no polling. Further narrowing of D-682. D-682's ban on a read after a user-run `Inspect room` stands (D-729 keeps it). |
| FDR-A4-6 | **FOUNDER_DECISION_REQUIRED**, default **accept**: a renderer that hangs after `quit_dialog_shown` is escaped only by an OS force quit. The 3 s bound does not apply after the shown-ack. No Clio id yet; the Founder is being asked in parallel. |

---

## 11. A4 Founder rulings (FDR-A4-1..FDR-A4-6)

FDR-A4-1..FDR-A4-4 were **RULED** on 2026-11-27 at 11:33 PM ET, relayed by MADC Architect; Clio **D-723..D-727**, `needs-confirmation` (not posted on GitHub). FDR-A4-5 / **D-728** was **RULED** at 11:50 PM ET, same relay, `needs-confirmation`. The post-start `session/read` (**D-729**, a further narrowing of D-682 on top of FDR-4(c)) was **RULED** at 11:51 PM ET, same relay, `needs-confirmation`. **FDR-A4-6** is **FOUNDER_DECISION_REQUIRED** (default accept; no Clio id yet; the Founder is being asked in parallel). The Founder's merge of this PR is the on-record act for the ruled items.

- **FDR-A4-1 / D-723: D-693 seat visibility below 1200px.** **RULED.** The seat stays visible at every width; below 1200px it folds into the thread cell as a second line (`THREAD · SEAT`); two-line Receipts row below 1200px. **Rejected alternative:** hide the `seat` column below 1200px. Chip wrap is a separate ruling (FDR-A4-5, 11:50 PM ET). Together they close **D-693 on this merge**. §5.2.
- **FDR-A4-2 / D-724: tone of a streamed-only `servedModel`.** **RULED.** Streamed-only (before `session/read` confirms) shows `▲ UNVERIFIED` (warn), never green. Verified only after `session/read` confirms a **non-empty** value (`trim().length > 0`) with `vendorReported: true`. An empty or whitespace-only `servedModel` is `▲ UNVERIFIED`, never `○`, never green (D-718 / D-724 stay literal). This reconciles FDR-4(a)'s earlier `○ NO RECEIPT` recommendation to the spec and frames. `○ NO RECEIPT` remains only when there is no `servedModel` item, and for empty `head@open`. §4.3.
- **FDR-A4-3: Iris additions not covered by an earlier ruling** (spec: "my additions, not Mike's rulings"):
  - (a) `Dismiss pane ‹seat›`, for a pane that holds no thread (Draft, or whose `thread/start` failed) (spec §5.5, §8.2). **RULED: accept** (D-725).
  - (b) `Reopen pane` on a disconnected pane, one `thread/resume` on click (spec §6.3). **RULED: defer** with `thread/resume` (**D-726**, carried debt, depends on D-708). It cannot be built in A4 under FDR-1. In A4 the pane shows `connection ended · history only`.
  - (c) Hidden-pane tabs at ≥ 1440 (seat plus `.pill--sm`, extending A3's `.pill--sm` use) and the `N hidden · names` summary chip below 1440 (spec §5.5). **RULED: accept** (D-725).
  - (d) A shown hidden pane takes the rightmost visible slot and the pane there becomes hidden (spec §5.5). **RULED: accept** (D-725).
  - (e) `Esc` on the quit dialog means **Keep running** (spec §8.1, §10), which invokes `ack_quit` (amendment 2 §6.1). **RULED: accept** (D-725).
  - (f) The Table-view stale note `room changed · Inspect room to refresh` instead of any automatic `room/inspect` on `room/updated` (spec §9; amendment 2 §3.4 item 2). **RULED: accept** (D-725).
- **FDR-A4-4 / D-727: `cwd` entry surface** (FDR-2 ruled the field; the r1 frames drew none). **RULED.** Typed absolute `cwd` is entered in a field in the **pane header**, not a palette field. Specified in §5.3, which adopts addendum §6A (Draft pane; six field states; `cwdCheck` never trims; `START THREAD` in the header cwd block; Enter starts, Esc reverts; C1–C15). **Rejected alternative:** the two-step palette field. Iris's r2 / addendum frames now draw the field.
- **FDR-A4-5 / D-728: chip wrap (the §5.4 / D5 amendment).** **RULED** 2026-11-27 11:50 PM ET, relayed by MADC Architect, `needs-confirmation`. Amend §5.4 to "receipt chips may wrap onto further lines inside their track; they never clip." Together with D-723, **D-693 closes on this merge.** §5.2.

- **Post-start `session/read` (D-729; further narrowing of D-682 on top of FDR-4(c)).** **RULED** 2026-11-27 11:51 PM ET, relayed by MADC Architect, `needs-confirmation`. After `thread/start` succeeds, the desktop makes exactly one automatic `session/read` so `worktree.topLevel` and `head@open` show straight away. A single read, no polling; none before `thread/start` succeeds, none after a failed start, and none after a user-run `Inspect room`. The note `not read yet` applies only during the gap before that read returns. Named test and killed mutation: amendment 2 §13 (14). §4.5. D-682's ban on a read after a user-run `Inspect room` stands (D-729 keeps it).

- **FDR-A4-6: hung-after-shown quit renderer.** **FOUNDER_DECISION_REQUIRED**, default **accept**. A renderer that hangs after `quit_dialog_shown` can be escaped only by an OS force quit, OS kill or crash. The 3 s shown-ack bound (amendment 2 §6.1, builder default) applies only when the dialog never renders; it does not run after a shown-ack. Folded into this card as a builder default, pending Founder confirmation: within `QUIT_FALLBACK_TTL = 30 s` after a dialog that never rendered (or after a failed emit), a second close silently exits and interrupts turns, with no dialog. After the TTL, a later close shows the dialog again. No Clio id yet; the Founder is being asked in parallel. §5.7, item 15.

### Founder-visible (builder defaults and contract notes; pending confirmation where marked)

| Item | Status |
| --- | --- |
| `QUIT_FALLBACK_TTL = 30 s` | Builder default, pending Founder confirmation. Counted on a **monotonic** clock from when the mark was set. **While the mark is live** (within the TTL after a dialog that never rendered, or after a failed emit), a second close silently exits and interrupts turns, with no dialog. After the TTL expires, a later close shows the dialog again. |
| Desktop-close terminal reason | r13 contract change: a desktop-initiated close emits `madc/transport-closed` with reason `disconnect` or `exit`. A published epoch always ends with exactly one terminal. |
| 8 MiB line cap | Accepted known limit, unmeasured. A `session/read` or `room/inspect` result over the cap is F2 (`oversize-frame`) and ends the connection; FDR-8 then interrupts every pane's turn. |
| Tauri `emit` spike | Amendment 2 §12 item 8: the builder spike-tests `emit` in a real window before implementing the owner. If an `emit` can block, stop and file a Surface amendment. L1 and L5 depend on this. |
