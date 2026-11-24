# PIN (proposed): M3 desktop protocol, amendment 1: who starts the socket listener (`madc-engine serve`), its lifetime, the stale-socket rule, and its exit codes

*Surface Architect · 2026-11-24 · Venue: `MADVenturesLLC/MADC` · Status: **proposed until the Founder merges this PR**. Additive amendment to `PIN-madc-M3-desktop-protocol.md` (§1) and to `PIN-madc-M1-protocol-messages.md` (§2 "Who starts engine" row, for M3 only). Answers Argus M1 on PR #73 at `6e20176`, and pins the rule behind Argus L2 and L5. Docs only. `protocolVersion` stays `madc-m1/1`; no method, param, result, notification or error code changes.*

*Base: `main` @ `bd037b41202a47eb650cac07407b9bcf81336854` (tree `08f0772f5385cfbb19995ea481b170e621f7ffb8`). Every `main` file cited below was read at that commit. Code cites marked `@6e20176` are PR #73's head `6e20176ebb175e99d5672c9755337a08fd423986`, not `main`. This PR adds one pointer line (plus a blank line) at line 5 of `PIN-madc-M3-desktop-protocol.md`, so its lines from 4 on move down by two, and one pointer at line 8 of `PIN-madc-M1-protocol-messages.md`, so its lines from 8 on move down by one; every line cite here uses the `bd037b4` numbers.*

**Authority:**

- `docs/plan/PIN-madc-M3-desktop-protocol.md` (M3-A0, PR #71, merged by the Founder as `b0db17b` on 2026-11-24 at 10:39:46 AM ET), SHA-256 `8a5fbaaf54b4e25343eba7da4c1397c0e1c53067a76b0097300b47ac3b5a0fb2` at the base. Its status line (line 3) reads "proposed until the Founder merges this PR"; that PR has merged, so the pin is in force (Clio ledger D-624, D-625) and, like `PIN-madc-M2-handoff-procedure.md` (same status wording, amended after merge only by new files and pointers at its lines 5-9), it changes only by a new file plus one `Amended by` pointer under its status line (`docs/plan/README.md` lines 5-11). No other line of it changes.
- `docs/plan/PIN-madc-M1-protocol-messages.md` (build pin, M1-A0), SHA-256 `9a32b890178599d54c01f5e71e4e5fa221014875491be999f80089abbfbab147` at the base. **Frozen.** Gains one `Amended by` pointer at the end of its pointer block (lines 5-7); no other line changes.
- `docs/plan/PLAN-madc-M3-build-plan.md` (accepted, D-619): §2 rows M3-A1 (line 24, listener "beside stdio") and M3-A2 (line 25, desktop "connect over `engine.sock`"); §1 non-goal "No agent loop, tools, or credentials inside the desktop shell" (line 14). Not edited.
- Founder rulings (Clio ledger): **D-620** "Unix socket" (2026-11-24 10:37 AM ET, answers D-M3-2 / D-616); **D-621** "yes" (M3-A0/A1 may start before D-R6, answers D-617); **D-619** "I accept The plan" (10:36 AM ET); **D-633** "Tauri v2 is my option" (11:51 AM ET, msg t23u, answers D-R6 / D-064).
- Argus review of PR #73 at `6e20176` (`/workspace/madc-reviews/pr73-review-6e20176.md`, outside this repo): M1 (lines 104-111), L2 (lines 121-134), L5 (lines 169-173), Info I1 (line 192), I4 (line 195), I5 (line 196, the D-627 stale text).

---

## 0. Corrections to the base pin's stale lines (superseded here, not edited in place)

| Base line | Text at `bd037b4` | Reads, from this amendment |
| --- | --- | --- |
| `PIN-madc-M3-desktop-protocol.md:3` | "Status: **proposed until the Founder merges this PR**" | In force since the Founder merged PR #71 (`b0db17b`, 2026-11-24 10:39:46 AM ET; D-624, D-625). |
| `PIN-madc-M3-desktop-protocol.md:5` | "`$MADC_HOME/engine.sock`, pending `D-M3-2`" | Ruled: Unix domain socket, `$MADC_HOME/engine.sock` `0600` on POSIX, named pipe on Windows (Founder, "Unix socket", D-620, answering D-M3-2 at `PLAN-madc-M3-build-plan.md:39`). |
| `PIN-madc-M3-desktop-protocol.md:5` | "stack per `D-R6`, still open" | Ruled: Tauri v2 (Founder, "Tauri v2 is my option", D-633, answering D-R6 at `PLAN-madc-M3-build-plan.md:38`). |
| `PIN-madc-M1-protocol-messages.md:46` | "M1: **CLI spawns child** … No daemon, no WS listener, no Unix-socket control plane (§6)." | Unchanged for the CLI. For M3 only, the desktop app also starts the engine, as `madc-engine serve` (§1 below). Still no daemon and no WS listener. |

These close the pin half of Clio's D-627 (stale text after #71). The plan, README and `AGENTS.md` halves of D-627 are not touched here.

## 1. Launcher: `madc-engine serve`

1. **Subcommand.** `madc-engine serve` is intercepted in `packages/engine/src/bin.ts` **before** the stdio engine starts, exactly as `auth-set` is today (`bin.ts:11-16` @ `bd037b4`: `argv[0] === "auth-set"` runs `runAuthSet` and sets `process.exitCode`; every other invocation calls `startStdioEngine()`). `serve` takes no further arguments.
2. **Socket only.** `serve` starts **only** the local-socket listener (`startSocketServer`, `socket.ts:48` @ `6e20176`). It runs **no** JSONL session on its own stdin/stdout: it never reads protocol from stdin and never writes protocol to stdout. stderr carries logs only (M1 pin §1, line 33).
3. **Who launches it in M3.** The desktop app (`packages/desktop`, M3-A2 onward) is the **only** launcher. It spawns `madc-engine serve` as a child process with stdin a pipe it holds open, and stderr a pipe it reads (§5). `serve` writes nothing to stdout.
4. **The CLI is unchanged.** It still spawns a stdio child per M1 pin §2 (line 45, `stdio: ["pipe","pipe","inherit"]`, and line 46) and does not use the socket in M3.
5. **No daemon.** No launchd or systemd unit, no login auto-start, no detach or double-fork, no `setsid`, and no TCP, WebSocket or HTTP listener. The base pin's "does not add remote/TCP access" (line 7) and M1 pin §6 "daemon; remote attach" (line 300) stand.
6. **No new method.** Nothing on the socket can stop `serve`; there is no shutdown request. A client only ends its own connection.

## 2. One listener per `$MADC_HOME`

Before spawning, the launcher probes `engine.sock` (path from `engineSocketPath(home)`, `socket.ts:22-28` @ `6e20176`):

- If a listener accepts the connection **and** answers `initialize` with `protocolVersion: "madc-m1/1"` within **1 s** (connect plus reply), the launcher uses that connection and does not spawn.
- Otherwise it spawns `serve`. `serve` runs its own §4 checks and refuses (exit 10 or 11) if the path is owned or unsafe; the launcher then follows §5.

A launcher that reuses another launcher's listener does not own it: that `serve` ends when **its** launcher ends (§3).

## 3. Lifetime

`serve` runs until the **first** of:

- **(a) EOF on its stdin.** Because the launcher holds the stdin pipe open, the engine ends when its launcher exits or crashes and never orphans. A `serve` started with stdin already at EOF (for example `</dev/null`) shuts down at once.
- **(b) SIGTERM or SIGINT.**
- **(c) A fatal listener error** after listening started (the server emits `error`): shut down as below, exit 12.

**Shutdown sequence** (the same for every trigger):

1. Stop accepting connections.
2. Every connection's in-flight turn ends `interrupted`, as M1 pin §2 lifecycle step 5 (line 55) and `EngineConnection.shutdown()` (`server.ts:512` @ `bd037b4`) already do; locks are released.
3. Each client socket is **ended** (`end()`, so queued `turn/completed` frames are written), then **destroyed** (`destroy()`) without waiting for the peer. `server.close()` must never wait on a client socket (the hang fixed in `6e20176`; `socket.ts:117-124` @ `6e20176`).
4. The server closes.
5. `engine.sock` is unlinked **only if** `lstat` still shows a socket with the same `dev`+`ino` this process bound (so a successor's socket is never removed).

**Deadline.** Shutdown has a **5 s** deadline from the first trigger. When it expires, `serve` writes one stderr line and exits anyway (§6). A second trigger during shutdown changes nothing.

A connected client that is not the launcher does **not** keep `serve` alive, and its disconnect does not stop it.

## 4. Stale-socket rule (POSIX; narrows base §1 line 16)

In this order, before `listen`:

1. **`lstat($MADC_HOME/engine.sock)`.**
2. **Not present** (`ENOENT`): bind.
3. **Present and not a socket** (a symlink, regular file, directory, FIFO, device, or anything for which `isSocket()` is false): **refuse, never unlink.** Exit 11.
4. **A socket:** probe `connect()` with a **1 s** timeout.
   - The probe connects (a listener answers): **refuse, don't unlink.** Exit 10.
   - The probe times out: **refuse, don't unlink.** Exit 11.
   - The probe fails with `ECONNREFUSED`, **or** with `ENOENT` on the path step 1 verified as a socket: **stale.** Re-`lstat`; if it is still a socket with the same `dev`+`ino`, unlink it and bind. If it changed, refuse without unlinking (exit 11). The `ENOENT` case exists because Bun 1.3.11 reports a stale Unix socket as `ENOENT`, not `ECONNREFUSED` (Argus review of #73 at `6e20176`, line 129: "Bun 1.3.11 gave `ENOENT`; Bun 1.4.2 and Node gave `ECONNREFUSED`"). CI runs Bun 1.3.11.
   - Any other probe error: refuse, don't unlink. Exit 11.
5. **After `listen`:** `chmod` the socket to `0600`, then `lstat` it: it must be a socket, mode `0600`, owned by the process uid. If the `chmod` or that check fails: **close the server, unlink the socket this process bound, and refuse.** Exit 11 (fail closed; Argus L5). An implementation may also narrow the umask around `listen`; that is allowed, not required.

**Windows (named pipe, base line 14).** Steps 1-5 do not apply: there is no file to `lstat` or unlink. A pipe name already in use is exit 10. Nothing on Windows runs in CI, so the Windows branch is **unverified** (Argus Info I1, review line 192).

## 5. Launcher waits

After spawning, the launcher waits up to **5 s** for `initialize` to succeed over the socket (it may retry `connect()` until then). If the deadline passes, or the child exits first:

- it kills the child: SIGTERM, then SIGKILL if still running after **2 s**;
- it shows the failure with the child's stderr (and the exit code, when the child exited);
- it does **not** retry automatically.

## 6. Exit codes for `madc-engine serve`

**Existing codes, reused.** The engine process already uses: `2` for a bad `$MADC_HOME` (`main.ts:222-227` @ `bd037b4`, and the CLI pin's "non-absolute `MADC_HOME` (also engine exit 2)", `PIN-madc-M0-cli.md:194`) and for `auth-set` usage errors (`auth-set.ts:112-117`, `:120`); `130` for SIGINT and `143` for SIGTERM (`main.ts:254-259`, pairs at `:255` and `:256`; `auth-set.ts:154` uses 130 for an interrupt); `1` and `4` for `auth-set` store and lane failures (`auth-set.ts:175-178`; `:134`, `:137-141`). The CLI's own table is 0-5 (`PIN-madc-M0-cli.md:188-197`). The new codes below (10-13) collide with none of these, and `serve` does not use 1, 3, 4 or 5, so a `serve` exit is never mistaken for an `auth-set` or CLI class.

| Code | Meaning | When |
| --- | --- | --- |
| 0 | Clean shutdown, stdin EOF | §3 (a), shutdown finished within 5 s |
| 130 | Clean shutdown, SIGINT | §3 (b), finished within 5 s (reuses `main.ts:255`) |
| 143 | Clean shutdown, SIGTERM | §3 (b), finished within 5 s (reuses `main.ts:256`); also what the launcher sees after its own §5 SIGTERM |
| 2 | Usage or home | Any argument after `serve`; `MADC_HOME` set but not absolute; `$MADC_HOME` cannot be created `0700` or made private (`socket.ts:49-50` @ `6e20176`) |
| 10 | A live listener already owns `engine.sock` | §4 step 4 probe connected; Windows pipe name in use |
| 11 | Unsafe path | §4 step 3 (symlink, file, directory, other non-socket); step 4 probe timeout, other probe error, or socket changed before unlink; step 5 `chmod`/mode/owner failure |
| 12 | Unexpected bind or listen error | `listen` fails for any other reason (`EADDRINUSE` from a race, `EACCES`, a path over the 104/108-byte socket limit, Argus I4, review line 195, or anything else); or a fatal server `error` after listening (§3 c) |
| 13 | Shutdown deadline exceeded | A clean trigger (EOF, SIGINT, SIGTERM) whose shutdown did not finish within 5 s |

**Precedence (every combination).** Startup checks run in the order args → home → §4 steps 1-5 → listening, and the **first** failure decides the code. After listening, the **first** trigger decides: 12 (fatal listener error) keeps 12 even if the deadline also expires; a clean trigger keeps 0/130/143 unless the deadline expires, which gives 13. EOF or a signal that arrives **during startup** aborts it: any socket this process already bound is closed and unlinked (§3 step 5 rule), and the exit is that trigger's 0/130/143. A later trigger never changes the code of a shutdown already under way.

**stderr.** Every non-zero exit writes exactly one line, `madc-engine serve: <reason>: <path>`, naming the reason and the socket path (or `$MADC_HOME` for code 2), in the `auth-set` prefix style (`auth-set.ts:108`). No secrets, no environment dump, no stack trace. Code 2 for a bad `MADC_HOME` does not echo the rejected value beyond what `resolveMadcHome` already prints (`home.ts:26`).

## 7. Malformed input on the socket

Unchanged from stdio: a line that is not JSON gets `-32700`, valid JSON that is not a request gets `-32600`, both with `id: null` (M1 pin §4, lines 134 and 140-141; `wire.ts:22-40` and `server.ts:672-678` @ `bd037b4`), and the connection carries on. Each socket has its own `EngineConnection` (`socket.ts:83-98` @ `6e20176`), so one bad client, one client socket error (for example `ECONNRESET`) or one client disconnect ends only that connection; the listener and the other connections keep running. The stdio path has no line-length cap and this amendment adds none.

## 8. Keep what exists (base §1 and PR #73's `socket.ts`)

Kept unchanged:

- Base §1 line 13: path `$MADC_HOME/engine.sock` under `0700` `$MADC_HOME`, socket `0600` owner-only, `lstat` refusing symlinks (now one case of §4 step 3).
- Base §1 line 14: the Windows pipe name.
- Base §1 line 15: framing identical to stdio; `initialize` first on every connection.
- Base §1 line 17: single-writer locking; concurrent readers; one writer per thread `.lock`.
- Base line 7: no credentials over the socket, no remote/TCP access, no change to M0/M1/M2 methods.
- `socket.ts` @ `6e20176`, in order: `mkdir` `0700` (`:49`), `enforcePrivateDir` (`:50`), `engineSocketPath` (`:51`, `:22-28`), the POSIX-only branch (`:53`), `lstat` (`:56-62`), symlink refusal (`:63-65`), live-listener refusal (`:67-70`), one `EngineConnection` per socket with room broadcast (`:83-98`), `listen` then `chmod 0600` (`:100-113`), and in `close()` connection shutdown, socket destroy, `server.close()` and the symlink-safe unlink (`:117-133`).

Narrowed:

- **Stale rule** (base line 16, "Only if `connect()` fails with `ECONNREFUSED` … may it unlink"). Now: unlink only an `lstat`-verified socket whose bounded probe failed with `ECONNREFUSED` or `ENOENT`, re-checked by `dev`+`ino` before unlink. **Why:** `socket.ts:30-42,66-72` @ `6e20176` treats any probe error as stale and has no timeout, so it deletes a regular file and throws a raw `EISDIR` on a directory (Argus L2, review lines 123-129); the `ENOENT` case keeps stale recovery working on CI's Bun 1.3.11.
- **`chmod` failure** (`socket.ts:104-110` @ `6e20176` swallows it). Now fatal: close, unlink, exit 11. **Why:** Argus L5 (review lines 169-173); a socket left at umask mode breaks base line 13's `0600`.
- **Shutdown unlink** (`socket.ts:125-131` @ `6e20176` unlinks anything not a symlink). Now only the socket this process bound (`dev`+`ino`). **Why:** never remove a successor listener's socket.
- **Socket teardown** (`socket.ts:118-121` @ `6e20176` destroys without `end()`). Now `end()` then `destroy()`. **Why:** queued `turn/completed` frames are written before teardown (COPILOT-PATTERNS #10), while `destroy()` still keeps `server.close()` from hanging.

## 9. Out of scope

- §3 `room/updated` stays exactly as written. Argus H1 on #73 is a build gap against it, not a pin change.
- §4 is unchanged. It still cites no Iris design spec (the evidence-bound rule is D-626; the Iris citation gap is D-618). Out of scope here.
- Who reconnects after a reused listener's launcher exits, and the desktop's reconnect UX, are M3-A2 build questions; this pin requires only that the launcher does not auto-retry a failed spawn (§5).
- Whether `serve` is built in PR #73 (M3-A1) or as the first step of M3-A2 is the Founder's call; this pin does not decide it.
