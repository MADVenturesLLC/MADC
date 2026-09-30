/**
 * The engine's own view of its controlling terminal (M1-A5 presence check; M1 plan §7 M1-A5,
 * protocol pin §3.3 P3). The engine's stdin/stdout are the protocol pipe, so the terminal is reached
 * the only way that does not trust the client: the engine opens `/dev/tty` ITSELF. That open succeeds
 * only for a process that still has a controlling terminal — it fails (`ENXIO`) under cron, CI, a
 * detached daemon or a `setsid` spawn, which is exactly what fail-closed needs.
 *
 * Node builtins only, no native module:
 * - `probe()` opens `/dev/tty`, requires `isatty`, and reads the terminal's identity: Linux
 *   `/proc/self/stat` (session id + `tty_nr`), elsewhere `/bin/ps -o tdev=` (macOS prints the
 *   controlling terminal as `major/minor`; it hides session ids, so `session` is null there).
 *   `fstat` on the `/dev/tty` fd cannot be used: on macOS it reports `/dev/tty` itself (2/0), not the
 *   terminal behind it (measured while building this act).
 * - `confirm()` writes the prompt to the terminal and waits for a line typed THERE. The fd is opened
 *   `O_NONBLOCK` and polled, so a pending prompt never blocks the event loop: EOF on the protocol
 *   pipe and SIGINT/SIGTERM still shut the engine down (a blocking read would ignore them, and Bun
 *   keeps a destroyed `tty.ReadStream` alive). `O_NONBLOCK` is set on this open's own file
 *   description, so the shell's and the CLI's handles on the same terminal stay blocking.
 *
 * Residual risk, stated plainly (M1 plan §7 M1-A5, §8): a program running inside the person's own
 * terminal session can still type into it. This check stops detached automation; it does not stop
 * a hostile local process that already shares the terminal.
 */
import { spawnSync } from "node:child_process";
import { closeSync, constants, openSync, readFileSync, readSync, writeSync } from "node:fs";
import { isatty } from "node:tty";
import type { TerminalFacts } from "./policy.ts";

export type PresenceTerminal = {
  /**
   * Opens the controlling terminal, checks it is a live TTY and returns its identity. `null` when
   * there is none (or it cannot be identified: fail-closed). Never prompts, never reads input.
   */
  probe(): TerminalFacts | null;
  /**
   * Writes `prompt` to the controlling terminal and resolves `true` only when a person answers there
   * with Enter (or `y` / `yes`). `false` on any other answer, EOF, abort, or any failure.
   */
  confirm(prompt: string, signal: AbortSignal): Promise<boolean>;
};

export type SystemTerminalDeps = {
  /** Default `process.platform`. */
  readonly platform?: string;
  /** Default `process.pid`. */
  readonly pid?: number;
  /** Default `/dev/tty`. */
  readonly ttyPath?: string;
  /** Poll interval for the confirmation read. Default 50 ms. */
  readonly pollMs?: number;
};

/** Non-blocking, never becomes a controlling terminal (the engine is not a session leader anyway). */
const TTY_FLAGS = constants.O_RDWR | (constants.O_NOCTTY ?? 0) | (constants.O_NONBLOCK ?? 0);
/** A confirmation is one short line; anything longer is not a keypress. */
const MAX_ANSWER_BYTES = 1024;

/**
 * `/proc/<pid>/stat` → the controlling terminal. Fields after the parenthesized command name are
 * `state ppid pgrp session tty_nr …` (proc(5)); `tty_nr` 0 means no controlling terminal. The device
 * number is decoded to `major/minor` so both platforms report the same shape.
 */
export function parseProcStat(text: string): TerminalFacts | null {
  const close = text.lastIndexOf(")");
  if (close === -1) return null;
  const fields = text
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const session = Number(fields[3]);
  const ttyNr = Number(fields[4]);
  if (!Number.isSafeInteger(session) || !Number.isSafeInteger(ttyNr) || ttyNr <= 0) return null;
  const major = (ttyNr >> 8) & 0xfff;
  const minor = (ttyNr & 0xff) | ((ttyNr >> 12) & 0xfff00);
  return { device: `${major}/${minor}`, session: String(session) };
}

/** `ps -o tdev=` output → `major/minor`, or null (`??`, empty, anything unexpected). */
export function parsePsTdev(text: string): string | null {
  const value = text.trim();
  return /^\d+\/\d+$/.test(value) ? value : null;
}

/** The person's answer: Enter alone, `y` or `yes` (any case) confirms; anything else refuses. */
export function isConfirmation(line: string): boolean {
  return /^(?:y|yes)?$/i.test(line.trim());
}

function controllingTerminal(platform: string, pid: number): TerminalFacts | null {
  if (platform === "linux") {
    return parseProcStat(readFileSync(`/proc/${pid}/stat`, "utf8"));
  }
  // Absolute path: a `ps` earlier on PATH must not be able to name the terminal.
  const ps = spawnSync("/bin/ps", ["-o", "tdev=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 2_000,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (ps.status !== 0 || typeof ps.stdout !== "string") return null;
  const device = parsePsTdev(ps.stdout);
  return device === null ? null : { device, session: null };
}

function isWouldBlock(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === "EAGAIN" || code === "EWOULDBLOCK";
}

/** Discard complete lines typed BEFORE the prompt: the confirmation must answer the prompt. */
function drainTypeAhead(fd: number): void {
  const scratch = Buffer.alloc(256);
  for (let i = 0; i < 64; i++) {
    try {
      if (readSync(fd, scratch, 0, scratch.length, null) === 0) return;
    } catch (err) {
      if (isWouldBlock(err)) return;
      throw err;
    }
  }
}

export function createSystemTerminal(deps: SystemTerminalDeps = {}): PresenceTerminal {
  const platform = deps.platform ?? process.platform;
  const pid = deps.pid ?? process.pid;
  const ttyPath = deps.ttyPath ?? "/dev/tty";
  const pollMs = deps.pollMs ?? 50;

  return Object.freeze({
    probe(): TerminalFacts | null {
      let fd: number;
      try {
        fd = openSync(ttyPath, TTY_FLAGS);
      } catch {
        return null; // no controlling terminal (ENXIO), or no /dev/tty on this platform
      }
      try {
        return isatty(fd) ? controllingTerminal(platform, pid) : null;
      } catch {
        return null;
      } finally {
        try {
          closeSync(fd);
        } catch {
          // nothing to release
        }
      }
    },

    confirm(prompt: string, signal: AbortSignal): Promise<boolean> {
      return new Promise((resolve) => {
        if (signal.aborted) {
          resolve(false);
          return;
        }
        let fd: number;
        try {
          fd = openSync(ttyPath, TTY_FLAGS);
        } catch {
          resolve(false);
          return;
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        let settled = false;
        let answer = "";
        const finish = (confirmed: boolean, note?: string): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          try {
            if (note !== undefined) writeSync(fd, note);
          } catch {
            // the outcome stands whether or not the note was shown
          }
          try {
            closeSync(fd);
          } catch {
            // nothing to release
          }
          resolve(confirmed);
        };
        const onAbort = (): void => finish(false);
        signal.addEventListener("abort", onAbort, { once: true });
        try {
          if (!isatty(fd)) {
            finish(false);
            return;
          }
          drainTypeAhead(fd);
          writeSync(fd, prompt);
        } catch {
          finish(false);
          return;
        }
        const chunk = Buffer.alloc(256);
        const poll = (): void => {
          if (settled) return;
          try {
            const n = readSync(fd, chunk, 0, chunk.length, null);
            if (n === 0) {
              finish(false, "\r\nmadc: not confirmed.\r\n"); // EOF (Ctrl-D) refuses
              return;
            }
            answer += chunk.subarray(0, n).toString("utf8");
            const end = answer.search(/[\r\n]/);
            if (end !== -1) {
              const confirmed = isConfirmation(answer.slice(0, end));
              finish(
                confirmed,
                confirmed ? "madc: presence confirmed.\r\n" : "madc: not confirmed.\r\n",
              );
              return;
            }
            if (answer.length > MAX_ANSWER_BYTES) {
              finish(false, "\r\nmadc: not confirmed.\r\n");
              return;
            }
          } catch (err) {
            if (!isWouldBlock(err)) {
              finish(false);
              return;
            }
          }
          timer = setTimeout(poll, pollMs);
        };
        poll();
      });
    },
  });
}
