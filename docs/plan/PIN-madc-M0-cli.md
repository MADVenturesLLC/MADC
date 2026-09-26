# PIN: M0 thin CLI surface (`madc doctor` + headless one-shot)

*Surface Architect · 2026-09-25 · Venue: `MADVenturesLLC/MADC` · Status: **build pin** for Hephaestus Act M0-A7. Docs only.*

*Amended by `PIN-madc-M0-cli-erratum-1.md` (2026-09-25, rev. 2026-09-26): `locks` row start-time rule; interpretations for Founder confirmation; §3a–§3d one-shot close exit, engine-message and shape checks, turn idle deadline (`MADC_TURN_IDLE_MS`), and exit precedence for CLI §4; §3e–§3f pin or triage the A7 failure inventory (`343da29`).*

**Authority:**

- `docs/plan/PLAN-madc-M0-build-plan.md` §10 Act M0-A7, Criterion B, and §6 import rule. The plan was Founder-accepted and merged via PR #2 (head `bdf45f42b0b27ee07dcdc30fbc24485de2219417`).
- `docs/plan/PIN-madc-M0-protocol-messages.md` (frozen, including Amendment 1 from PR #8): stdio JSONL, `madc-m0/1`, method list, and error codes.
- `docs/plan/PIN-madc-M0-seat-format.md` (frozen): `$MADC_HOME`, `madc doctor --init` uses the same seed writer, and §6.8 doctor reports the seat, the last session and chain status.
- `docs/policy/CODE-ADVISORIES.md`.
- `docs/plan/PIN-madc-M0-amendment-2-session-integrity.md` (M0 Amendment 2): §1 one PID namespace per `MADC_HOME`, §5 torn-tail vs integrity classification, §6 orphaned reclaim files, §7 `ThreadStatus "closed"` reserved.
- The code was read on `main` @ `00e1698595926a64fd858ed7abcaa0941504296c` (PR #14 merge, 2026-09-25 11:20 EDT).

**Additive only.** This pin adds **no** protocol method, notification, error code, seat field or JSONL event type. Where it seems to touch a frozen pin, the frozen pin wins. It also must not contradict M1: `madc -s <seat>`, `seats ls`, `providers ls`, `auth …` and the TTY-gated interactive mode (M1 plan) all stay reserved and unbuilt here.

**Steal:** the headless contract from `claude -p` and `codex exec` (prompt in, final result out, exit code). This pins the mechanism only; no flags or output shapes are copied. **MAD evolution:** every status the CLI prints is bound to evidence the operator can re-check, such as a sha256, a session path plus seq plus chain-head hash, a pid or exit code, or a measured duration. A status word with no evidence is not allowed.

---

## 1. Command grammar (M0, complete)

```
madc --version | -V                     print "madc <MADC_VERSION> (protocol madc-m0/1)"; exit 0
madc --help    | -h                     usage; exit 0
madc doctor [--json] [--init]           health report (§3)
madc -p <prompt|-> [-s <seatId>] [--json]   headless one-shot (§2)
```

| Rule | Decision |
| --- | --- |
| Parser | Hand-rolled in `packages/cli`, with no new dependency. Flags may come before or after the subcommand. `--` ends flags. Unknown flag or subcommand → exit 2 with a one-line hint. |
| `-p -` | Read the prompt from stdin until EOF, UTF-8, capped at 1 MiB. Over the cap → exit 2. |
| Empty prompt | Exit 2. The CLI never sends an empty `turn/start`. |
| `-s <seatId>` | Passed through as `thread/start.seatId`. The default is `madc-default`. The CLI does **not** validate the grammar itself: the engine returns `-32602`, `-32005` or `-32006` and the CLI maps them (§4). |
| Bare `madc "<text>"` (no `-p`) | **Reserved for M1 interactive chat.** In M0 it exits 2 with the message `interactive chat arrives in M1; use: madc -p "<text>"`. |
| Bare `madc` | Prints the usage and exits 2. |
| `cwd` | The one-shot sends `process.cwd()` wherever the protocol pin carries `cwd`. There is no `--cwd` flag in M0. |
| Mode | The CLI claims no interactive mode in M0, so every turn is headless. The M1 TTY-gated `mode: interactive` rule is not built here. |
| `MADC_HOME` | Resolved once via the engine's own resolver (§5) and passed unchanged in the engine's env. If it is set but not absolute → exit 2 before anything spawns. |
| Invocation | `node packages/cli/src/bin.ts …` or `bun packages/cli/src/bin.ts …`, per the M0 runbook. No npm publish, no `npm link` requirement, no global install. Windows is CLI-first: paths print in native form. |

## 2. Headless one-shot (`-p`)

**Flow:**

1. `spawnEngine` from `@madc/engine/client`, with stdio `["pipe","pipe","inherit"]`.
2. `initialize`. Assert `protocolVersion === "madc-m0/1"`; otherwise exit 3.
3. `thread/start {seatId, cwd}`.
4. `turn/start` with the prompt as the single text input.
5. Consume the `item/*` notifications until `turn/completed` arrives for that turn id.
6. Close with EOF and wait for the engine to exit.

The CLI contains no loop, tool or provider code. The engine owns everything.

**Authority of data:** the items in `turn/completed` and the final `item/completed` payloads are authoritative. Deltas are only used for display.

**Output modes:**

| stdout is… | `--json` | stdout | stderr |
| --- | --- | --- | --- |
| TTY | no | agent text, streamed as deltas arrive | a live one-line status while waiting (`… kimi-code · 1.2s`), then the **receipt block** |
| not TTY | no | the final agent text only, no ANSI codes, trailing newline | the receipt block, plain text |
| any | yes | **exactly one** JSON object (below) plus a newline, and nothing else | nothing but fatal diagnostics |

**Receipt block** (stderr, printed at every exit after `thread/start` succeeds):

```
─ receipt ─────────────────────────────────────────────
 turn     COMPLETED            turn_…          4.8s
 model    kimi-coding/kimi-for-coding → kimi-for-coding   (kimi-code)
 session  /home/mike/.madc/sessions/thr_….jsonl
          seq 5 · head bbcc12ab34cd · chain VERIFIED
 exit     0
```

- The `model` line comes from the `servedModel` item as `requested → served (backing)`. If no `servedModel` item arrived, it prints `model    NO RECEIPT`. It never guesses from the seat.
- The `session` line comes from **re-reading and verifying** the thread's JSONL after the engine exits, via the read-only verifier (§5).
  - Prints `chain VERIFIED` only if verify passes **and** the chain's last `turn.end` names this turn id.
  - Otherwise prints `chain FAILED line N: <reason>` (exit 5), or `UNVERIFIED: <why>`, for example when the file belongs to another thread. `UNVERIFIED` does not change a success exit, but it is never shown as success.
- The hash prints as the first 12 hex digits. `--json` carries the full 64.

**`--json` object** (camelCase, stable keys, and additive-only after M0):

```json
{
  "ok": true,
  "exitCode": 0,
  "madcVersion": "0.0.0",
  "protocolVersion": "madc-m0/1",
  "seatId": "madc-default",
  "threadId": "thr_…",
  "turn": { "id": "turn_…", "status": "completed", "error": null, "durationMs": 4812 },
  "text": "final agent message text",
  "servedModel": { "requestedModel": "…", "servedModel": "…", "backing": "kimi-code", "providerId": "kimi-code" },
  "session": { "path": "…/sessions/thr_….jsonl", "seq": 5, "headHash": "<64 hex>", "chain": "verified" },
  "error": null
}
```

- `ok` is true iff `exitCode === 0`.
- `servedModel` is `null` if no item arrived.
- `session.chain` ∈ `"verified" | "failed" | "unverified"`, and `"failed"` also carries `line` and `reason`.
- `error` is `{ "code": <engine code or null>, "message": "…", "class": "usage|engine|provider|session|turn|interrupted" }` or `null`.
- Before `thread/start` succeeds, `threadId`, `turn` and `session` are `null`.
- The CLI never puts env values, headers or credentials in the JSON object or on stderr.

**Interrupt:**

- First SIGINT (Ctrl-C) → send `turn/interrupt`, wait up to 2 s for `turn/completed` (`interrupted`), print the receipt, EOF, then exit **130**.
- A second SIGINT, or the grace period running out → close stdin, kill the engine child if it is still running after 1 s, then exit 130.
- SIGTERM → the same as a second SIGINT, but exit 143.

## 3. `madc doctor`

**Principles:**

- Plain `doctor` is **read-only** against the real `$MADC_HOME`. It never creates, seeds, locks or appends.
- Rows print **as each check finishes**, so the first row appears with no wait on the engine.
- Every check has a hard timeout. The engine probe gets 5 s; on timeout the row is FAIL with `timeout 5000ms`.

**Rows** (stable ids, fixed order):

| id | PASS requires (and prints) this evidence | Otherwise |
| --- | --- | --- |
| `runtime` | `node <ver>` or `bun <ver>` meets the root `engines` floor (node ≥22.19, bun ≥1.2). Evidence: `process.versions` | FAIL (below the floor) |
| `engine` | Spawn the engine with a **throwaway temp `MADC_HOME`** (never the real one). `initialize` returns `madc-m0/1`. EOF, then the child exits 0. Evidence: `madc-m0/1 · <ms> ms · exit 0`. Remove the temp dir afterwards. | FAIL: `version <x>`, `exit <n>`, `timeout`, or `protocol violation` |
| `home` | The resolved path is absolute and exists. Evidence: the path plus the source (`MADC_HOME` or the default) | WARN `not initialized: run madc doctor --init` if it is missing. FAIL (exit 2 class) if `MADC_HOME` is set but not absolute |
| `seat` | `inspectMadcHome` reports `madc-default` as OK. Evidence: the path plus `sha256:<first 12 hex>` of the file bytes | WARN if missing (`not initialized`). FAIL `<code> <issues>` if invalid (-32006) |
| `session` | The last session chain verifies. Evidence: `<threadId> · <events> events · head <first 12 hex>` | SKIP `no sessions yet`. FAIL `torn tail at line N: crash residue, not tamper (file untouched; repair lands in M1)` when the verifier classifies it `torn-tail` (Amendment 2 §5). FAIL `integrity: line N: <reason>` for anything else |
| `locks` | Read-only survey of `sessions/*.lock`. It never reclaims, deletes or opens a lock for writing, and it **never prints the token**. PASS `no locks`, or every lock owner pid is alive here and (Linux) its `/proc/<pid>/stat` start time is not later than the lock's `startedAt` + 2 s. Evidence per lock: `<threadId> · pid <n> · age <s>` | WARN `pid <n> not visible in this PID namespace: dead here, or live in another container. M0 supports one PID namespace per MADC_HOME (Amendment 2 §1); do not resume this thread from two places`. WARN `pid <n> started after the lock: pid reused or foreign`. WARN `orphaned <file>` for each `*.lock.reclaim-*` / `*.lock.tmp-*` (Amendment 2 §6), never deleted. Unreadable, symlink or non-file lock → WARN with the reason |
| `registry` | Read-only catalog summary. Evidence: `<n> entries · wired: <ids>`, with counts by status, derived at run time and never hard-coded | FAIL if the catalog fails to load |
| `cred.kimi-code` | Only presence of `KIMI_API_KEY` in the CLI's env. Evidence: `KIMI_API_KEY set`. **Never** the value, length, prefix or a hash. | WARN `KIMI_API_KEY not set: turns answer -32008 no-credentials` |
| `bin.claude` | PATH lookup only (with PATHEXT on Windows). **No exec, no `--version`.** | Always **SKIP**: `found <path>` or `not on PATH`, plus `adapter not built (A5)` |
| `bin.codex` | Same as `bin.claude` | Always SKIP: `… adapter not built (A6)` |

**Status vocabulary:**

- `PASS` is allowed only with the evidence in the table. There is also `WARN`, `FAIL` and `SKIP`.
- Words come first. Colour is optional: only on a TTY, never when `NO_COLOR` is set, and PASS may be green only because its row already carries evidence.
- No emoji, spinners-as-status, progress bars, or "all good" banners.

**Summary line and exit code:**

- The last line is `RESULT  <f> FAIL · <w> WARN · <s> SKIP · <ms> ms   exit <code>`.
- Exit **0** iff there is no FAIL. WARN and SKIP never fail doctor, so a healthy scaffold with no key and no vendor CLIs exits 0 (plan accept line).
- Exit **1** if any FAIL, or exit **2** for the usage or `MADC_HOME` class.

**Example:**

```
madc doctor · madc 0.0.0 · protocol madc-m0/1
PASS  runtime        node 22.19.0 (floor 22.19)
PASS  engine         madc-m0/1 · 141 ms · exit 0
PASS  home           /home/mike/.madc (default)
PASS  seat           madc-default · sha256:3f2a9c01d4e7
PASS  session        thr_… · 6 events · head bbcc12ab34cd
PASS  locks          no locks
PASS  registry       12 entries · wired: kimi-code, claude-code, codex
WARN  cred.kimi-code KIMI_API_KEY not set: turns answer -32008 no-credentials
SKIP  bin.claude     found /usr/local/bin/claude · adapter not built (A5)
SKIP  bin.codex      not on PATH · adapter not built (A6)
RESULT  0 FAIL · 1 WARN · 2 SKIP · 214 ms   exit 0
```

(The registry count is illustrative. The real value is derived at run time.)

**`--init`:**

- Seeds through the **same writer** the engine uses (seat pin §1). The route is to spawn the engine against the real `$MADC_HOME` (it auto-seeds on start), `initialize`, EOF, and wait for exit 0. The CLI never writes seat bytes itself.
- Then it runs the normal read-only doctor and adds a first row: `INIT  seeded <path>` or `INIT  already present (unchanged, sha256:<12>)`. It never overwrites.

**`--json`:** one object:

```json
{"ok":true,"exitCode":0,"madcVersion":"…","protocolVersion":"madc-m0/1","durationMs":212,
 "checks":[{"id":"runtime","status":"pass","summary":"node 22.19.0 (floor 22.19)","evidence":{"runtime":"node","version":"22.19.0"}}, …],
 "counts":{"pass":7,"warn":1,"fail":0,"skip":2}}
```

- Check ids are stable. M1 may add rows (for example lanes) but may not rename or remove them.

## 4. Exit codes (both commands)

| Exit | Class | Sources |
| --- | --- | --- |
| 0 | ok | Turn `completed`; doctor has no FAIL |
| 1 | turn / doctor failure | Turn `failed` with a non-classed error; doctor has ≥1 FAIL |
| 2 | usage / config | Bad flags, empty or oversize prompt, bare `madc`, non-absolute `MADC_HOME` (also engine exit 2), `-32602` on `thread/start` (bad seat id), `-32005` SeatNotFound, `-32006` SeatInvalid |
| 3 | engine | Spawn failure, unexpected engine exit (`EngineExitedError`), `protocolVersion` mismatch, protocol violations, timeouts, and **any other** engine error code, including unknown codes |
| 4 | provider | `-32007` ProviderDenied, `-32008` ProviderUnavailable (including `no-credentials`), as an RPC error or as `turn.error.code` |
| 5 | session | `-32009` SessionWriteFailed, or a post-turn chain verify `failed` |
| 130 / 143 | interrupted | SIGINT / SIGTERM (§2) |

- Every code in the protocol pin's error table must appear in one explicit `switch` case in the CLI, with a test per class.
- A turn `failed` with `error.code` in a class above uses that class's exit.

## 5. Import boundary (plan §6) and the one engine touch

- `packages/cli` imports only `node:*`, relative paths, `@madc/core`, `@madc/engine/client`, and type-only `@madc/engine`. The honesty test stays unchanged and green.
- Doctor needs three read-only things that `@madc/engine/client` does not export today. **Founder allowance (D-A7-2):** add **additive, read-only re-exports** to `packages/engine/src/sdk.ts`, and nothing else in `packages/engine`:
  - `resolveMadcHome`: the same resolver the engine uses.
  - `inspectMadcHome`: already read-only.
  - A read-only chain verifier for a given session path or thread id, if one already exists in the engine (re-export only), including the `torn-tail` / `integrity` classification added by Amendment 2 §5 (the A4 follow-up "session integrity"). If only `inspectMadcHome` exists, the one-shot uses it and requires `lastSession.threadId === threadId`, or else it reports `UNVERIFIED`.
  - `readLock` and `isPidAlive` from `lock.ts` (read-only; `kill(pid, 0)` sends no signal) for the `locks` row. The CLI lists `sessions/` and reads `/proc` itself via `node:fs`. It never calls acquire, reclaim or release.
  - A pure registry summary: re-export `listCatalog` (or a pure `summarizeCatalog()` derived from it) from `@madc/registry` via the sdk.
- No new protocol method (the M0 method list is frozen). No engine behaviour change. `seedDefaultSeat` is **not** re-exported: `--init` goes through the engine process.

## 6. Out of bounds for A7

- Interactive chat / REPL / TUI.
- `-s` shorthand without `-p`.
- `seats ls`, `providers ls`, `auth …` and any lanes table (all M1).
- Config files.
- Colour themes.
- npm publish or packaging.
- Daemons, sockets or any network or listener code.
- Tool, loop or provider logic in `cli`.
- Exec'ing vendor binaries.
- Reading or printing any credential value, or any lock `token`.
- Reclaiming, deleting or repairing anything (locks, torn tails): doctor only reports. Repair is M1.
- Rendering logic that depends on `ThreadStatus "closed"` (reserved in M0; print any status string verbatim).

## 7. Acceptance for Hephaestus A7 (in addition to plan §10)

1. `madc doctor` exits 0 against a healthy temp `$MADC_HOME` seeded by the engine, with no `KIMI_API_KEY` and no vendor binaries on PATH. Rows match §3 ids and order, and every PASS row carries its evidence field.
2. `doctor` on an empty temp home creates nothing. Assert the directory listing is unchanged. It WARNs `not initialized` and exits 0. `doctor --init` seeds via the engine, a second `--init` leaves the seat byte-identical (same sha256), and the real `~/.madc` is never touched by tests.
3. A tampered session line makes `doctor` FAIL on `session` as `integrity` (exit 1), and makes one-shot report `chain FAILED` (exit 5). A half-written or NUL-filled tail makes `doctor` FAIL as `torn tail … crash residue`. In both cases the file's sha256 is unchanged after doctor.
3a. `locks` row: a lock whose pid is dead (or rewritten to a non-existent pid) → WARN `not visible`. A planted `*.lock.reclaim-*` → WARN `orphaned`. The token never appears in any output. Doctor changes no lock file (directory listing and sha256 identical before and after).
4. `madc -p "hi" --json` against the fake Kimi engine (`packages/engine/src/testing/kimi-fake-engine.ts`) or the echo engine prints one JSON object matching §2. `servedModel` equals the JSONL `servedModel` event, `session.chain === "verified"`, and exit is 0.
5. Exit-code table: one test per class (2, 3, 4 via `no-credentials`, 5, 130), including an unknown engine error code → 3.
6. Non-TTY stdout has no ANSI codes. `NO_COLOR` is honoured. The `--json` stdout parses as exactly one JSON value.
7. There is no credential value in any stdout or stderr capture. Inject a fake key and assert it is absent.
8. The honesty or import-rule test is unchanged and green. `npm run check` is green on Node 22.19 and Bun.

*End of CLI pin.*
