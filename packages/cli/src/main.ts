/**
 * `madc` entry logic (CLI pin §1). Talks to the engine only through `@madc/engine/client`
 * (spawned child, stdio JSONL). M0 surface: --version, --help, doctor, headless -p. No chat.
 */
import { statSync } from "node:fs";
import { MADC_VERSION } from "@madc/core";
import { PROTOCOL_VERSION, resolveMadcHome } from "@madc/engine/client";
import { CHAT_RESERVED, parseArgs, USAGE } from "./args.ts";
import { existsNoFollow, runDoctor } from "./doctor.ts";
import { EXIT } from "./exit-codes.ts";
import type { CliIO } from "./io.ts";
import { PROMPT_CAP_BYTES, readPromptFromStdin, runOneShot } from "./oneshot.ts";

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

async function oneShot(
  io: CliIO,
  promptArg: string,
  seatId: string | undefined,
  json: boolean,
): Promise<number> {
  // MADC_HOME is resolved once, by the engine's own resolver, before anything spawns.
  let home: string;
  try {
    home = resolveMadcHome(io.env as NodeJS.ProcessEnv);
  } catch (err) {
    return usageFailure(io, json, err instanceof Error ? err.message : String(err));
  }
  // An existing non-directory MADC_HOME is a config error too (same rule as doctor; Copilot
  // review 5321817948 "previously missed"): exit 2 before anything spawns.
  try {
    if (!statSync(home).isDirectory()) {
      return usageFailure(io, json, `MADC_HOME ${home} exists but is not a directory`);
    }
  } catch {
    // Absent: the engine creates and seeds it. A dangling symlink is not absent (Copilot
    // r4108213417): exit 2 before spawning.
    if (existsNoFollow(home)) {
      return usageFailure(io, json, `MADC_HOME ${home} is a dangling symlink`);
    }
  }
  let prompt: string | null;
  if (promptArg === "-") {
    prompt = await readPromptFromStdin(io);
    if (prompt === null) return usageFailure(io, json, "prompt on stdin exceeds 1 MiB");
  } else {
    prompt = promptArg;
    if (Buffer.byteLength(prompt, "utf8") > PROMPT_CAP_BYTES) {
      return usageFailure(io, json, "prompt exceeds 1 MiB");
    }
  }
  if (prompt.trim() === "") return usageFailure(io, json, "empty prompt");
  return runOneShot(io, { prompt, seatId, json, home });
}
