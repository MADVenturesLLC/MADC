# PIN (proposed): M3 desktop protocol, amendment 1: who starts the socket listener (`madc-engine serve`), its lifetime, one listener per home, the stale-socket rule, and its exit codes

*Surface Architect · 2026-11-24 · Venue: `MADVenturesLLC/MADC` · Status: **proposed**. This file's status follows the `docs/plan/README.md` edit rule (lines 3-11): while proposed it is a draft (lines 8-9); once the Founder merges it, it is frozen and changes only by `Amended by` pointer lines and new files (lines 5-7, 10). Additive amendment to `PIN-madc-M3-desktop-protocol.md` (§1) and to `PIN-madc-M1-protocol-messages.md` (§2 "Who starts engine" row, for M3 only). Answers Argus M1 on PR #73 at `6e20176`, and pins the rule behind Argus L2 and L5. Docs only. `protocolVersion` stays `madc-m1/1`; no method, param, result, notification or error code changes.*

*Base: `main` @ `bd037b41202a47eb650cac07407b9bcf81336854` (tree `08f0772f5385cfbb19995ea481b170e621f7ffb8`). Every `main` file cited below was read at that commit. Code cites marked `@6e20176` are PR #73's head `6e20176ebb175e99d5672c9755337a08fd423986`, not `main`. This PR adds one pointer line (plus a blank line) after line 4 of `PIN-madc-M3-desktop-protocol.md`, so its lines from 5 on move down by two (old line 5 becomes line 7), and one pointer at line 8 of `PIN-madc-M1-protocol-messages.md`, so its lines from 8 on move down by one; every line cite here uses the `bd037b4` numbers.*

**Authority:**

- `docs/plan/PIN-madc-M3-desktop-protocol.md` (M3-A0, PR #71, merged by the Founder as `b0db17b` on 2026-11-24 at 10:39:46 AM ET), SHA-256 `8a5fbaaf54b4e25343eba7da4c1397c0e1c53067a76b0097300b47ac3b5a0fb2` at the base. Its status line (line 3) reads "proposed until the Founder merges this PR". That PR has merged, so the pin is in force (Clio ledger D-624, D-625). README lines 8-9 key the edit rule to the status line, which literally still says "proposed"; this amendment takes the conservative reading and treats the pin as frozen, as was done for `PIN-madc-M2-handoff-procedure.md` (same status wording, amended after merge only by new files and pointers at its lines 5-9). It therefore changes only by a new file plus one `Amended by` pointer under its status line (README lines 5-7, 10). No other line of it changes.
- `docs/plan/PIN-madc-M1-protocol-messages.md` (build pin, M1-A0), SHA-256 `9a32b890178599d54c01f5e71e4e5fa221014875491be999f80089abbfbab147` at the base. **Frozen.** Gains one `Amended by` pointer at the end of its pointer block (lines 5-7); no other line changes.
- M0 Amendment 1 lock scheme ("Cross-process ownership"): frozen M0 pin `PIN-madc-M0-protocol-messages.md:83` (record line `:7`), carried forward unchanged by `PIN-madc-M1-protocol-messages.md:11` and quoted at `:98-103`; its envelope and residuals in `PIN-madc-M0-amendment-2-session-integrity.md` §1 (lines 19-27) and §6 (lines 78-91). Implemented by `packages/engine/src/lock.ts` @ `bd037b4`. Reused unchanged by §2a.
- `docs/plan/PLAN-madc-M3-build-plan.md` (accepted, D-619): §2 rows M3-A1 (line 24, listener "beside stdio") and M3-A2 (line 25, desktop "connect over `engine.sock`"); §1 non-goal "No agent loop, tools, or credentials inside the desktop shell" (line 14). Not edited.
- Founder rulings (Clio ledger): **D-620** "Unix socket" (2026-11-24 10:37 AM ET, answers D-M3-2 / D-616); **D-621** "yes" (M3-A0/A1 may start before D-R6, answers D-617); **D-619** "I accept The plan" (10:36 AM ET); **D-633** "Tauri v2 is my option" (11:51 AM ET, msg t23u, answers D-R6 / D-064).
- Argus review of PR #73 at `6e20176` (`/workspace/madc-reviews/pr73-review-6e20176.md`, outside this repo): M1 (lines 104-111), L2 (lines 121-134), L5 (lines 169-173), Info I1 (line 192), I4 (line 195), I5 (line 196, the D-627 stale text).
- Argus pre-check of this amendment at `4290e89` (`/workspace/madc-reviews/madc-m3-pin-amend1-precheck-4290e89.md`, outside this repo): M1, M2, L1-L12 and Info I1-I7, all answered here.

---

## 0. Corrections to the base pins' stale lines (superseded here, not edited in place)

| Base line | Text at `bd037b4` | Reads, from this amendment |
| --- | --- | --- |
| `PIN-madc-M3-desktop-protocol.md:3` | "Status: **proposed until the Founder merges this PR**" | In force since the Founder merged PR #71 (`b0db17b`, 2026-11-24 10:39:46 AM ET; D-624, D-625). |
| `PIN-madc-M3-desktop-protocol.md:5` | "`$MADC_HOME/engine.sock`, pending `D-M3-2`" | Ruled: Unix domain socket, `$MADC_HOME/engine.sock` `0600` on POSIX, named pipe on Windows (Founder, "Unix socket", D-620, answering D-M3-2 at `PLAN-madc-M3-build-plan.md:39`). |
| `PIN-madc-M3-desktop-protocol.md:5` | "stack per `D-R6`, still open" | Ruled: Tauri v2 (Founder, "Tauri v2 is my option", D-633, answering D-R6 at `PLAN-madc-M3-build-plan.md:38`). |
| `PIN-madc-M3-desktop-protocol.md:14` | "`\\.\pipe\madc-<sha256(MADC_HOME).slice(0,16)>`" | The hash input is `realpath(MADC_HOME)`, not the raw string (§4, Windows). |
| `PIN-madc-M1-protocol-messages.md:46` | "M1: **CLI spawns child** … No daemon, no WS listener, no Unix-socket control plane (§6)." | "CLI spawns child" is unchanged for the CLI. **"No Unix-socket control plane" is superseded for M3** (the M3 pin already added the socket, pointer at M1 line 7; this amendment adds who starts it): the desktop app also starts the engine, as `madc-engine serve` (§1). "No daemon, no WS listener" stand. |

These close the pin half of Clio's D-627 (stale text after #71). The plan, README and `AGENTS.md` halves of D-627 are not touched here.

## 1. Launcher: `madc-engine serve`

1. **Subcommand.** `madc-engine serve` is intercepted in `packages/engine/src/bin.ts` **before** the stdio engine starts, exactly as `auth-set` is today (`bin.ts:11-16` @ `bd037b4`: `argv[0] === "auth-set"` runs `runAuthSet` and sets `process.exitCode`; every other invocation calls `startStdioEngine()`). `serve` takes no further arguments.
2. **Socket only.** `serve` starts **only** the local-socket listener (`startSocketServer`, `socket.ts:48` @ `6e20176`). It runs **no** JSONL session on its own stdin/stdout: it never parses protocol from stdin and never writes to stdout. stderr carries logs only (M1 pin §1, line 33).
3. **Its stdio.** `serve` **reads and discards** everything on stdin and only watches for EOF (§3 a). The launcher spawns it with stdin a pipe the launcher holds open, stdout `"ignore"`, and stderr a pipe the launcher **drains for the whole life of `serve`, until it exits** (so `serve` never blocks on a full stderr pipe), keeping it for §5.
4. **Who launches it in M3.** The desktop app (`packages/desktop`, M3-A2 onward) is the **only** launcher.
5. **The CLI is unchanged.** It still spawns a stdio child per M1 pin §2 (line 45, `stdio: ["pipe","pipe","inherit"]`, and line 46) and does not use the socket in M3.
6. **No daemon.** No launchd or systemd unit, no login auto-start, no detach or double-fork, no `setsid`, and no TCP, WebSocket or HTTP listener. The base pin's "does not add remote/TCP access" (line 7) and M1 pin §6 "daemon; remote attach" (line 300) stand.
7. **No new method.** Nothing on the socket can stop `serve`; there is no shutdown request. A client only ends its own connection.

## 2. One listener per `$MADC_HOME`

**Enforced** by `engine.lock` (§2a), inside the M0 Amendment 2 §1 envelope (one PID namespace, one host, one kernel boot; lines 19-27).

Before spawning, the launcher probes `engine.sock` (path from `engineSocketPath(home)`, `socket.ts:22-28` @ `6e20176`, with the §4 Windows hash change):

- If a listener accepts the connection **and** answers `initialize` with `protocolVersion: "madc-m1/1"` within **1 s** (connect plus reply), the launcher uses that connection and does not spawn.
- Otherwise it spawns `serve`, which takes `engine.lock` and runs its §4 checks, refusing with exit 10 or 11 if the home is owned or the path unsafe.
- **On child exit 10** (a live `engine.lock` holder, a live listener, or `EADDRINUSE`), the launcher **re-runs the §2 probe once** and, if a listener answers, connects to it. That is not a respawn. If the re-probe fails, it reports the failure (§5).

A launcher that reuses another launcher's listener does not own it: that `serve` ends when **its** launcher ends (§3).

## 2a. `$MADC_HOME/engine.lock` (lifetime lock)

`serve` takes an exclusive lifetime lock at `$MADC_HOME/engine.lock` **after** the home checks and **before** §4 step 1, and holds it until **after** the final `engine.sock` unlink (§3 step 5). It uses the M0 Amendment 1 scheme and `lock.ts`'s rules **unchanged**; only the path differs:

- **Body and token:** exactly `{ pid, startedAt, token }`, `token` 128 random bits as 32 lowercase hex, fresh on every acquisition, kept in memory, never logged, never on the wire (M1 pin lines 98 and 103 (d); `lock.ts:16-23`, `:54-56`).
- **Create:** exclusive create through a private temp file hard-linked into place (`createExclusive`, `lock.ts:181-195`), up to five attempts (`lock.ts:259`).
- **Live holder:** a holder whose pid is alive, whatever its token, means the home is owned (M1 pin line 102 (c); `lock.ts:263-269`, `isPidAlive` `:166-174`). **`serve` exits 10.** So does running out of attempts (`lock.ts:275`).
- **Stale holder and reclaim:** a dead pid or a corrupt body is reclaimed by rename-aside, re-read, and delete only if byte-for-byte unchanged, else restored (M1 pin line 101 (b); `reclaimIfUnchanged`, `lock.ts:219-245`). A symlink at the path is corrupt and never followed (`lock.ts:156`); any other non-regular file is refused (`LockPathNotAFileError`, `lock.ts:153-163`): **exit 11**, as is any other I/O error taking the lock.
- **Release:** only if the on-disk token is this holder's, and only if the path still names the file whose body was checked (M1 pin line 100 (a); `releaseThreadLock`, `lock.ts:323-338`).
- **Envelope and residuals unchanged:** cross-namespace reclaim and the three-engine reclaim race (M0 Amendment 2 §1, §6 lines 78-91) apply to `engine.lock` as they do to thread locks.

`acquireThreadLock` builds its path from a thread id (`threadLockPath`, `lock.ts:50-52`, `:257`). Taking `engine.lock` with the same steps on a different path is an implementation detail; it must not change any rule above.

**Why the lock.** Without it, two `serve`s on one stale socket can both pass the §4 checks, and the second unlinks the first's new socket by path (Argus pre-check M2). With `engine.lock` held, no other `serve` on the same home can be between §4's check and its unlink at the same time, which is what closes the check-then-unlink gap (COPILOT-PATTERNS #4) for `serve` against `serve`. A non-`serve` actor that swaps the path inside that window is not excluded: POSIX has no compare-and-unlink, so that residual stays, narrowed by the `dev`+`ino` re-check.

## 3. Lifetime

`serve` runs until the **first** of:

- **(a) EOF on its stdin.** Because the launcher holds the stdin pipe open, the engine ends when its launcher exits or crashes and does not orphan. A `serve` started with stdin already at EOF (for example `</dev/null`) shuts down at once.
- **(b) SIGTERM or SIGINT.**
- **(c) A fatal listener error** after listening started (the server emits `error`): exit 12.
- **(d) An unexpected internal fault:** `serve` installs `uncaughtException` and `unhandledRejection` handlers that write one reason line, attempt this shutdown, and exit 14. `serve` never exits with the runtime's default 1.

**Shutdown sequence** (the same for every trigger):

1. Call `server.close()` (stop accepting connections); its callback is awaited at step 4.
2. Each connection runs `EngineConnection.shutdown()` **unchanged** (`server.ts:512-533` @ `bd037b4`), keeping every step it has: the once-only guard (`:513-514`); abort of pending presence prompts (`:516-517`); in-flight turns end `interrupted` (`:518-522`, as M1 pin §2 lifecycle step 5, line 55); `session.close` written for each loaded thread under the lock this process still holds, **before** the thread locks are released, with release in a `finally` (`:523-530`; D-M2-A0-5, `PIN-madc-M2-evidence-schema-v2.md` line 161 and row line 379); marking the connection closed (`:531`); and closing its readline (`:532`).
3. Each client socket is **ended** (`end()`), then **destroyed** (`destroy()`) on that socket's `finish` event or when a **per-socket 2 s grace** runs out, whichever comes first, all inside the 5 s deadline. This matches the stdio engine's 2 s flush bound (`main.ts:301` @ `bd037b4`, flush detected by write callback at `:304`). `destroy()` straight after `end()` is not allowed: it discards unflushed writes (Argus pre-check M1, `logs/amend1/run.log`: 219264 of 4194332 bytes received; COPILOT-PATTERNS #10).
4. Await the `server.close()` callback from step 1. It cannot hang, because step 3 destroys every socket within its grace (the hang fixed in `6e20176`; `socket.ts:117-124` @ `6e20176`).
5. `engine.sock` is unlinked **only if** `lstat` still shows a socket with the same `dev`+`ino` this process bound. Because `engine.lock` is still held, no successor `serve` (inside the envelope) can have bound there.
6. Release `engine.lock` (§2a).

**Locks on every exit path.** As the stdio engine does (`process.once("exit", () => conn.releaseLocks())`, `main.ts:253` @ `bd037b4`), `serve` registers a process-exit handler that releases every thread lock still held and `engine.lock`. It runs on every exit, including 13 and 14. Only SIGKILL skips it; the next start then reclaims the dead holder's locks under §2a.

**A failing shutdown step** writes one stderr log line and the sequence continues with the next step. The exit keeps the trigger's code, or 13 if the deadline passes (§6).

**Deadline.** Shutdown has a **5 s** deadline from the first trigger. When it expires, `serve` writes its final reason line and exits anyway (§6). A second trigger during shutdown changes nothing.

A connected client that is not the launcher does **not** keep `serve` alive, and its disconnect does not stop it.

## 4. Stale-socket rule (POSIX; narrows base §1 line 16)

With `engine.lock` held (§2a), in this order:

1. **`lstat($MADC_HOME/engine.sock)`.**
2. **`ENOENT`:** go to `listen`. **Any other `lstat` error** (`EACCES`, `ENOTDIR`, `ELOOP`, `EIO`, …): **refuse.** Exit 11.
3. **Present and not a socket** (a symlink, regular file, directory, FIFO, device, or anything for which `isSocket()` is false): **refuse, do not unlink.** Exit 11.
4. **A socket:** probe `connect()` with a **1 s** timeout.
   - The probe connects (a listener answers): **refuse, do not unlink.** Exit 10.
   - The probe times out: **refuse, do not unlink.** Exit 11.
   - The probe fails with `ECONNREFUSED`, **or** with `ENOENT` on the path step 1 verified as a socket: **stale.** Re-`lstat`; if it is still a socket with the same `dev`+`ino`, unlink it and go to `listen`; if it is gone (`ENOENT`), go to `listen`; if it changed or the re-`lstat` fails otherwise, refuse without unlinking (exit 11). The `ENOENT` case exists because Bun 1.3.11 reports a stale Unix socket as `ENOENT`, not `ECONNREFUSED` (Argus review of #73 at `6e20176`, line 129: "Bun 1.3.11 gave `ENOENT`; Bun 1.4.2 and Node gave `ECONNREFUSED`"). CI runs Bun 1.3.11.
   - Any other probe error: refuse, do not unlink. Exit 11.

**Listen (between steps 4 and 5), under umask `0o177`.** On POSIX, `serve` sets `process.umask(0o177)` immediately before `listen()` and restores the previous umask straight after the bind, in `listen`'s callback or its `error` handler, before anything else is created. A `listen` that fails with `EADDRINUSE` is exit 10; any other `listen` failure is exit 12.

5. **After `listen`:** `chmod` the socket to `0600`, then `lstat` it: it must be a socket, mode `0600`, owned by the process uid. If the `chmod` or that check fails: **close the server, unlink the socket this process bound, and refuse.** Exit 11 (fail closed; Argus L5). The umask keeps the socket from ever existing at a wider mode; the `chmod` plus `lstat` check stays as the verification.

**Windows (named pipe).** Steps 1-5's `lstat`, unlink and `chmod`, and the listen rule's umask, do not apply. The pipe name is `\\.\pipe\madc-<sha256(realpath(MADC_HOME)).slice(0,16)>`, hashing the **real path** so two spellings of one home name one pipe (`socket.ts:23-26` @ `6e20176` hashes the raw string; Argus I1, review line 192). `engine.lock` (§2a) applies. `EADDRINUSE` on the pipe is exit 10. Windows termination is a hard kill: no shutdown sequence runs and 143 is not observable, so on Windows the launcher always closes `serve`'s stdin first (EOF, exit 0) before any kill (§5). The owner-only pipe ACL is not pinned (§9). Nothing on Windows runs in CI: the Windows branch is **unverified**.

## 5. Launcher waits

- **Start.** After spawning, the launcher waits up to **5 s** for `initialize` to succeed over the socket (it may retry `connect()` until then).
- **Child exited 10 before `initialize`:** re-probe once per §2 and connect if a listener answers; otherwise report the failure as below.
- **Deadline passed, child still running and never completed `initialize`:** SIGTERM, then SIGKILL **2 s** later if still running.
- **Stopping a child that did complete `initialize`:** close its stdin (EOF). If the launcher must signal it, SIGTERM, then wait **7 s** (the 5 s shutdown deadline plus a 2 s margin) before SIGKILL. On Windows, the stdin close always comes first, before any kill (§4).
- **Any failure:** show it with the child's stderr (drained per §1.3) and its exit code when it exited. **No automatic retry or respawn.**

## 6. Exit codes for `madc-engine serve`

**Existing codes, reused.** The engine process already uses `2` for a bad `$MADC_HOME` (`main.ts:222-227` @ `bd037b4`, and the CLI pin's "non-absolute `MADC_HOME` (also engine exit 2)", `PIN-madc-M0-cli.md:194`) and for `auth-set` usage errors (`auth-set.ts:112-117`, `:120`); `130` for SIGINT and `143` for SIGTERM (`main.ts:254-259`, pairs at `:255` and `:256`; `auth-set.ts:154` uses 130 for an interrupt); `1` and `4` for `auth-set` store and lane failures (`auth-set.ts:175-178`; `:134`, `:137-141`). The CLI's own table is 0-5 plus 130/143 (`PIN-madc-M0-cli.md:188-198`; `packages/cli/src/exit-codes.ts:6-15`). The new codes 10-14 appear nowhere in the engine or CLI source at `bd037b4`, and `serve` does not use 1, 3, 4 or 5, so a `serve` exit is never mistaken for an `auth-set` or CLI class.

| Code | Meaning | When |
| --- | --- | --- |
| 0 | Clean shutdown, stdin EOF | §3 (a), finished within 5 s |
| 130 | Clean shutdown, SIGINT | §3 (b), finished within 5 s (reuses `main.ts:255`) |
| 143 | Clean shutdown, SIGTERM | §3 (b), finished within 5 s (reuses `main.ts:256`); POSIX only (§4 Windows) |
| 2 | Usage or home | Any argument after `serve`; `MADC_HOME` set but not absolute; `$MADC_HOME` cannot be created `0700` or made private (`socket.ts:49-50` @ `6e20176`) |
| 10 | The home is already owned | Live `engine.lock` holder or acquire attempts exhausted (§2a); §4 step 4 probe connected; `listen` `EADDRINUSE` (POSIX socket or Windows pipe) |
| 11 | Unsafe path | `engine.lock` path not a regular file or other I/O error taking it (§2a); §4 step 2 `lstat` error other than `ENOENT`; step 3 non-socket; step 4 probe timeout, other probe error, or socket changed before unlink; step 5 `chmod`/mode/owner failure |
| 12 | Unexpected bind or listen error | `listen` fails other than `EADDRINUSE` (`EACCES`, a path over the 104/108-byte socket limit, Argus I4, review line 195, or anything else); or a fatal server `error` after listening (§3 c) |
| 13 | Shutdown deadline exceeded | A clean trigger (EOF, SIGINT, SIGTERM) whose shutdown did not finish within 5 s |
| 14 | Unexpected internal fault | An `uncaughtException` or `unhandledRejection` outside a shutdown already under way (§3 d) |

**Precedence (every combination):**

| Situation | Exit |
| --- | --- |
| Startup check fails, in the order args → home → `engine.lock` → §4 steps 1-4 → `listen` → step 5 | The **first** failing check's code (2, 10, 11 or 12) |
| Unexpected fault during startup, not one of those checks | 14 |
| EOF or signal during startup, before any check has failed | Startup is aborted, anything bound is closed and unlinked (§3 step 5 rule), locks released; 0 / 130 / 143 |
| Running; first trigger EOF / SIGINT / SIGTERM; shutdown finishes within 5 s (with or without a failing shutdown step) | 0 / 130 / 143 |
| Running; first trigger EOF / SIGINT / SIGTERM; deadline passes | 13 |
| Running; first trigger a fatal listener error | 12, whether or not the deadline passes |
| Running; first trigger an unexpected fault | 14, whether or not the deadline passes |
| Fault, listener error or step failure **during** a shutdown already under way | Treated as a failing shutdown step: the trigger's code, or 13 if a clean trigger's deadline passes |
| Second EOF or signal during shutdown | No change |
| SIGKILL | No code from `serve` (killed by signal 9); its locks are reclaimed at the next start (§2a) |

**stderr.** Every non-zero exit writes **one final reason line**, `madc-engine serve: <reason>: <path>`, naming the reason and the socket or lock path (or `$MADC_HOME` for code 2), in the `auth-set` prefix style (`auth-set.ts:108`). Earlier stderr lines are logs. No secrets, no lock token, no environment dump, no stack trace. Code 2 for a bad `MADC_HOME` does not echo the rejected value beyond what `resolveMadcHome` already prints (`home.ts:26`).

## 7. Malformed input on the socket

Unchanged from stdio: a line that is not JSON gets `-32700`, valid JSON that is not a request gets `-32600`, both with `id: null` (M1 pin §4, lines 134 and 140-141; `wire.ts:22-40` and `server.ts:672-678` @ `bd037b4`), and the connection carries on. Each socket has its own `EngineConnection` (`socket.ts:83-98` @ `6e20176`), so one bad client, one client socket error (for example `ECONNRESET`) or one client disconnect ends only that connection; the listener and the other connections keep running. The stdio path has no line-length cap and this amendment adds none.

## 8. Keep what exists (base §1, PR #73's `socket.ts`, and the engine code `serve` reuses)

Kept unchanged:

- Base §1 line 13: path `$MADC_HOME/engine.sock` under `0700` `$MADC_HOME`, socket `0600` owner-only, `lstat` refusing symlinks (now one case of §4 step 3).
- Base §1 line 14: the Windows pipe name's shape (`madc-` plus 16 hex chars of a SHA-256).
- Base §1 line 15: framing identical to stdio; `initialize` first on every connection.
- Base §1 line 17: single-writer locking; concurrent readers; one writer per thread `.lock`.
- Base line 7: no credentials over the socket, no remote/TCP access, no change to M0/M1/M2 methods.
- `socket.ts` @ `6e20176`, in order: `mkdir` `0700` (`:49`), `enforcePrivateDir` (`:50`), `engineSocketPath` (`:51`, `:22-28`), the POSIX-only branch (`:53`), `lstat` (`:56-62`), symlink refusal (`:63-65`), live-listener refusal (`:67-70`), one `EngineConnection` per socket with room broadcast (`:83-98`), `listen` then `chmod 0600` (`:100-113`), and in `close()` connection shutdown, socket destroy, `server.close()` and the symlink-safe unlink (`:117-133`).
- `EngineConnection.shutdown()` (`server.ts:512-533` @ `bd037b4`), every step (§3 step 2).
- The stdio engine's exit-time lock release (`main.ts:253`) and its 2 s flush bound (`main.ts:301`, `:304`), now also used by `serve`.
- The M0 Amendment 1 lock scheme and `lock.ts` (create, live holder, reclaim, release, token rules), applied unchanged to `engine.lock` (§2a), with M0 Amendment 2 §1 and §6 unchanged.
- The `auth-set` interception shape in `bin.ts:11-16` and its stderr prefix style (`auth-set.ts:108`).

Narrowed:

- **Stale rule** (base line 16, "Only if `connect()` fails with `ECONNREFUSED` … may it unlink"). Now: unlink only an `lstat`-verified socket whose bounded probe failed with `ECONNREFUSED` or `ENOENT`, re-checked by `dev`+`ino` before unlink, with `engine.lock` held. **Why:** `socket.ts:30-42,66-72` @ `6e20176` treats any probe error as stale and has no timeout, so it deletes a regular file and throws a raw `EISDIR` on a directory (Argus L2, review lines 123-129); the `ENOENT` case keeps stale recovery working on CI's Bun 1.3.11; the lock stops two `serve`s racing the unlink (pre-check M2).
- **`lstat` errors** (`socket.ts:56-62` @ `6e20176` treats every error as "absent" and binds). Now only `ENOENT` means absent; any other error is exit 11. **Why:** pre-check L2.
- **`chmod` failure** (`socket.ts:104-110` @ `6e20176` swallows it). Now fatal: close, unlink, exit 11; and `listen` runs under umask `0o177`. **Why:** Argus L5 (review lines 169-173) and pre-check L7; a socket at umask mode breaks base line 13's `0600`.
- **Shutdown unlink** (`socket.ts:125-131` @ `6e20176` unlinks anything not a symlink). Now only the socket this process bound (`dev`+`ino`), before `engine.lock` is released. **Why:** do not remove a successor listener's socket.
- **Socket teardown** (`socket.ts:118-121` @ `6e20176` destroys without `end()`). Now `end()`, then `destroy()` on `finish` or after a 2 s per-socket grace. **Why:** queued `turn/completed` frames are flushed (pre-check M1, COPILOT-PATTERNS #10), and `server.close()` still cannot hang.
- **Windows pipe name** (base line 14, `socket.ts:23-26` @ `6e20176`, hash of the raw `MADC_HOME`). Now the hash of `realpath(MADC_HOME)`. **Why:** two spellings of one home must not give two listeners (Argus I1).

## 9. Out of scope

- §3 `room/updated` stays exactly as written. Argus H1 on #73 is a build gap against it, not a pin change.
- §4 is unchanged. It still cites no Iris design spec (the evidence-bound rule is D-626; the Iris citation gap is D-618). Out of scope here.
- **Windows owner-only pipe ACL: an M3 gap, carried and unverified.** The pipe gets no owner-only ACL today (Argus I1, review line 192), and this amendment does not pin an API for one. It must be pinned before Windows is claimed as supported.
- **Doctor does not see `engine.lock` residue.** `madc doctor`'s lock check lists `sessions/` only (`packages/cli/src/doctor.ts:748-751` @ `bd037b4`), so an orphaned `engine.lock.reclaim-*` or `engine.lock.tmp-*` in `$MADC_HOME` (M0 Amendment 2 §6 residuals) is not reported. Carried; a CLI-pin change, not made here.
- Who reconnects after a reused listener's launcher exits, and the desktop's reconnect UX, are M3-A2 build questions; this pin requires only that the launcher does not auto-retry or respawn (§5).
- Whether `serve` is built in PR #73 (M3-A1) or as the first step of M3-A2 is the Founder's call; this pin does not decide it.
