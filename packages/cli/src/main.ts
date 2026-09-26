/**
 * `madc` entry logic (CLI pin §1). Talks to the engine only through `@madc/engine/client`
 * (spawned child, stdio JSONL). M0 surface: --version, --help, doctor, headless -p. No chat.
 */
import { MADC_VERSION } from "@madc/core";
import { PROTOCOL_VERSION, resolveMadcHome } from "@madc/engine/client";
import { CHAT_RESERVED, hasJsonFlag, parseArgs, USAGE } from "./args.ts";
import { classifyHomePath, runDoctor } from "./doctor.ts";
import { EXIT } from "./exit-codes.ts";
import type { CliIO } from "./io.ts";
import { PROMPT_CAP_BYTES, readPromptFromStdin, runOneShot } from "./oneshot.ts";

const DEFAULT_SEAT = "madc-default";

export async function main(argv: readonly string[], io: CliIO): Promise<number> {
  const parsed = parseArgs(argv);
  switch (parsed.kind) {
    case "version":
      io.stdout.write(`madc ${MADC_VERSION} (protocol ${PROTOCOL_VERSION})\n`);
      return EXIT.ok;
    case "help":
      io.stdout.write(USAGE);
      return EXIT.ok;
    case "usage":
      // §3e E8: with `--json` anywhere as a flag token, every parse-level usage failure prints
      // one JSON object and nothing on stderr.
      if (hasJsonFlag(argv)) return usageFailure(io, true, parsed.message);
      if (parsed.message === "no command given") io.stderr.write(USAGE);
      else if (parsed.message === CHAT_RESERVED) io.stderr.write(`${CHAT_RESERVED}\n`);
      else io.stderr.write(`madc: ${parsed.message} (see madc --help)\n`);
      return EXIT.usage;
    case "doctor":
      return runDoctor(io, { json: parsed.json, init: parsed.init });
    case "oneshot":
      return oneShot(io, parsed.prompt, parsed.seatId, parsed.json);
  }
}

function usageFailure(io: CliIO, json: boolean, message: string): number {
  if (json) {
    io.stdout.write(
      `${JSON.stringify({
        ok: false,
        exitCode: EXIT.usage,
        madcVersion: MADC_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        seatId: null,
        threadId: null,
        turn: null,
        text: "",
        servedModel: null,
        session: null,
        error: { code: null, message, class: "usage" },
      })}\n`,
    );
  } else {
    io.stderr.write(`madc: ${message}\n`);
  }
  return EXIT.usage;
}

/** §3c rules 3 and 7: the turn idle deadline default and its env override bounds. */
export const DEFAULT_TURN_IDLE_MS = 600_000;
export const MAX_TURN_IDLE_MS = 86_400_000;
const TURN_IDLE_PATTERN = /^[1-9][0-9]*$/;
const TURN_IDLE_MESSAGE = "MADC_TURN_IDLE_MS must be an integer from 1 to 86400000 (milliseconds)";

export type TurnIdleMs =
  | { readonly ok: true; readonly ms: number }
  | { readonly ok: false; readonly message: string };

/**
 * §3c rule 8: pure parse of `MADC_TURN_IDLE_MS` (read only by the one-shot). Unset or `""` is the
 * default; otherwise the value must match `^[1-9][0-9]*$` and be at most 86 400 000. The value
 * itself is never echoed (CLI:105).
 */
export function parseTurnIdleMs(env: Readonly<Record<string, string | undefined>>): TurnIdleMs {
  const v = env.MADC_TURN_IDLE_MS;
  if (v === undefined || v === "") return { ok: true, ms: DEFAULT_TURN_IDLE_MS };
  if (!TURN_IDLE_PATTERN.test(v) || Number(v) > MAX_TURN_IDLE_MS) {
    return { ok: false, message: TURN_IDLE_MESSAGE };
  }
  return { ok: true, ms: Number(v) };
}

/** The `<code>` of an fs/stream error for a pinned usage message. */
function errCode(err: unknown): string {
  return (err as NodeJS.ErrnoException | null)?.code ?? "error";
}

async function oneShot(
  io: CliIO,
  promptArg: string,
  seatId: string | undefined,
  json: boolean,
): Promise<number> {
  // §3e E6: the one-shot installs its signal listeners before the MADC_HOME checks, the
  // MADC_TURN_IDLE_MS check and the prompt read. A signal before the engine is spawned: nothing
  // is spawned, the stdin read is abandoned at once, exit 130/143. `runOneShot` installs its own
  // listeners for the run itself; these stay as a harmless pre-spawn backstop until it returns.
  let preSignal: number | null = null;
  let signalNow: () => void = () => {};
  const signaled = new Promise<void>((resolve) => {
    signalNow = resolve;
  });
  const onSigint = () => {
    preSignal = preSignal ?? EXIT.sigint;
    signalNow();
  };
  const onSigterm = () => {
    preSignal = EXIT.sigterm;
    signalNow();
  };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  try {
    const interrupted = (): number => {
      const code = preSignal ?? EXIT.sigint;
      if (json) {
        // usageFailure's shape, but the signal's exit code, class and the requested seat (F-129).
        io.stdout.write(
          `${JSON.stringify({
            ok: false,
            exitCode: code,
            madcVersion: MADC_VERSION,
            protocolVersion: PROTOCOL_VERSION,
            seatId: seatId ?? DEFAULT_SEAT,
            threadId: null,
            turn: null,
            text: "",
            servedModel: null,
            session: null,
            error: { code: null, message: "interrupted by signal", class: "interrupted" },
          })}\n`,
        );
      } else {
        io.stderr.write("madc: interrupted by signal\n");
      }
      return code;
    };
    // MADC_HOME is resolved once, by the engine's own resolver, before anything spawns.
    let home: string;
    try {
      home = resolveMadcHome(io.env as NodeJS.ProcessEnv);
    } catch (err) {
      return usageFailure(io, json, err instanceof Error ? err.message : String(err));
    }
    // §3e E18: one classifier over the stat error code (shared with doctor). An existing
    // non-directory is a config error too (Copilot review 5321817948); a dangling symlink
    // (Copilot r4108213417), a symlink loop or an unreadable home: exit 2 before spawning.
    const homeState = classifyHomePath(home);
    if (homeState.kind === "not-directory") {
      return usageFailure(io, json, `MADC_HOME ${home} exists but is not a directory`);
    }
    if (homeState.kind === "invalid") {
      return usageFailure(io, json, homeState.message);
    }
    // Absent: the engine creates and seeds it.
    // §3c rule 7: MADC_TURN_IDLE_MS is checked right after the MADC_HOME checks and before the
    // prompt is read, so an invalid MADC_HOME is reported first.
    const idle = parseTurnIdleMs(io.env);
    if (!idle.ok) return usageFailure(io, json, idle.message);
    // §3e E16 F-130: a deleted current directory is a usage error for the one-shot only.
    let cwd: string;
    try {
      cwd = io.cwd;
    } catch (err) {
      return usageFailure(io, json, `current directory is not accessible (${errCode(err)})`);
    }
    if (preSignal !== null) return interrupted();
    let prompt: string | null;
    if (promptArg === "-") {
      let raced:
        | { readonly kind: "prompt"; readonly value: string | null }
        | {
            readonly kind: "signal";
          };
      try {
        raced = await Promise.race([
          readPromptFromStdin(io).then((value) => ({ kind: "prompt" as const, value })),
          signaled.then(() => ({ kind: "signal" as const })),
        ]);
      } catch (err) {
        // §3e E16 F-110: a read error on the `-p -` stdin is a usage failure, never a stack.
        return usageFailure(io, json, `cannot read prompt from stdin (${errCode(err)})`);
      }
      if (raced.kind === "signal") return interrupted();
      prompt = raced.value;
      if (prompt === null) return usageFailure(io, json, "prompt on stdin exceeds 1 MiB");
    } else {
      prompt = promptArg;
      if (Buffer.byteLength(prompt, "utf8") > PROMPT_CAP_BYTES) {
        return usageFailure(io, json, "prompt exceeds 1 MiB");
      }
    }
    if (prompt.trim() === "") return usageFailure(io, json, "empty prompt");
    if (preSignal !== null) return interrupted();
    // The cwd was read once above (F-130); the run gets it as a plain value.
    const runIo: CliIO = {
      stdout: io.stdout,
      stderr: io.stderr,
      stdin: io.stdin,
      env: io.env,
      stdoutIsTTY: io.stdoutIsTTY,
      stderrIsTTY: io.stderrIsTTY,
      cwd,
      ...(io.engineEntry !== undefined ? { engineEntry: io.engineEntry } : {}),
    };
    return await runOneShot(runIo, { prompt, seatId, json, home, turnIdleMs: idle.ms });
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }
}
