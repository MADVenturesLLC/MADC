/**
 * Hand-rolled M0 argument parser (CLI pin §1). No dependency. Flags may come before or after the
 * subcommand; `--` ends flags. The grammar is complete for M0:
 *
 *   madc --version | -V
 *   madc --help    | -h
 *   madc doctor [--json] [--init]
 *   madc -p <prompt|-> [-s <seatId>] [--json]
 */

export type ParsedArgs =
  | { readonly kind: "version" }
  | { readonly kind: "help" }
  | { readonly kind: "doctor"; readonly json: boolean; readonly init: boolean }
  | {
      readonly kind: "oneshot";
      /** The prompt text, or "-" to read it from stdin. */
      readonly prompt: string;
      readonly seatId: string | undefined;
      readonly json: boolean;
    }
  /** Usage error: exit 2 with `message` (one line). */
  | { readonly kind: "usage"; readonly message: string };

export const USAGE = `usage:
  madc --version | -V                          print version and protocol
  madc --help    | -h                          this help
  madc doctor [--json] [--init]                health report (--init seeds MADC_HOME via the engine)
  madc -p <prompt|-> [-s <seatId>] [--json]    headless one-shot turn ("-" reads stdin)
`;

export const CHAT_RESERVED = 'interactive chat arrives in M1; use: madc -p "<text>"';

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let version = false;
  let help = false;
  let json = false;
  let init = false;
  let prompt: string | undefined;
  let seatId: string | undefined;
  const positionals: string[] = [];
  let flagsDone = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (flagsDone || arg === "-" || !arg.startsWith("-")) {
      positionals.push(arg);
      continue;
    }
    switch (arg) {
      case "--":
        flagsDone = true;
        break;
      case "--version":
      case "-V":
        version = true;
        break;
      case "--help":
      case "-h":
        help = true;
        break;
      case "--json":
        json = true;
        break;
      case "--init":
        init = true;
        break;
      case "-p":
      case "-s": {
        const value = argv[i + 1];
        if (value === undefined) return usage(`${arg} needs a value`);
        i++;
        if (arg === "-p") {
          if (prompt !== undefined) return usage("-p given twice");
          prompt = value;
        } else {
          if (seatId !== undefined) return usage("-s given twice");
          seatId = value;
        }
        break;
      }
      default:
        return usage(`unknown flag ${arg}`);
    }
  }
  if (help) return { kind: "help" };
  if (version) return { kind: "version" };
  const [first, ...rest] = positionals;
  if (first === "doctor" && prompt === undefined) {
    if (rest.length > 0) return usage(`unexpected argument ${rest[0] ?? ""}`);
    if (seatId !== undefined) return usage("-s is only valid with -p");
    return { kind: "doctor", json, init };
  }
  if (prompt !== undefined) {
    if (positionals.length > 0) return usage(`unexpected argument ${positionals[0] ?? ""}`);
    if (init) return usage("--init is only valid with doctor");
    return { kind: "oneshot", prompt, seatId, json };
  }
  if (first !== undefined) return usage(CHAT_RESERVED);
  if (seatId !== undefined) return usage("-s is only valid with -p");
  if (init) return usage("--init is only valid with doctor");
  return usage("no command given");
}

function usage(message: string): ParsedArgs {
  return { kind: "usage", message };
}
