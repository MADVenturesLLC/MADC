/**
 * Hand-rolled argument parser (CLI pin §1; `auth` added by M1-A2). No dependency. Flags may come
 * before or after the subcommand; `--` ends flags. The grammar is complete for the M0 surface plus
 * the M1-A2 credential commands:
 *
 *   madc --version | -V
 *   madc --help    | -h
 *   madc doctor [--json] [--init]
 *   madc auth set|rm|status <providerId>
 *   madc -p <prompt|-> [-s <seatId>] [--json]
 */

export type AuthSub = "set" | "rm" | "status";

export type ParsedArgs =
  | { readonly kind: "version" }
  | { readonly kind: "help" }
  | { readonly kind: "doctor"; readonly json: boolean; readonly init: boolean }
  | { readonly kind: "auth"; readonly sub: AuthSub; readonly providerId: string }
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
  madc auth set <providerId>                   store a credential (no-echo TTY prompt; never an argument)
  madc auth rm <providerId>                    remove the stored credential
  madc auth status <providerId>                credential presence (never a value)
  madc -p <prompt|-> [-s <seatId>] [--json]    headless one-shot turn ("-" reads stdin)
`;

export const CHAT_RESERVED = 'interactive chat arrives in M1; use: madc -p "<text>"';

/**
 * §3e E8: true when `--json` appears in argv as a flag token, scanned with the parser's own
 * rules: not after `--`, and never consumed as the value of `-p` or `-s`. Used to give every
 * parse-level usage failure the JSON shape when the operator asked for JSON anywhere in argv.
 */
export function hasJsonFlag(argv: readonly string[]): boolean {
  let flagsDone = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (flagsDone || arg === "-" || !arg.startsWith("-")) continue;
    if (arg === "--") {
      flagsDone = true;
      continue;
    }
    if (arg === "-p" || arg === "-s") {
      i++; // the value is consumed even when it looks like a flag
      continue;
    }
    if (arg === "--json") return true;
  }
  return false;
}

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
  if (first === "auth") {
    if (prompt !== undefined) return usage("-p is only valid as the headless one-shot");
    if (seatId !== undefined) return usage("-s is only valid with -p");
    if (init) return usage("--init is only valid with doctor");
    if (json) return usage("--json is only valid with doctor or -p");
    const [sub, providerId, ...extra] = rest;
    // An unrecognized subcommand is NEVER echoed: `madc auth <credential>` must not print the
    // credential back to stderr (M1-A2: a credential on the command line is rejected, not shown).
    if (sub !== "set" && sub !== "rm" && sub !== "status") {
      return usage(
        sub === undefined
          ? "auth needs a subcommand: set | rm | status <providerId>"
          : "unknown auth subcommand (expected set, rm or status)",
      );
    }
    if (providerId === undefined) return usage(`auth ${sub} needs a <providerId>`);
    // Same no-echo rule for anything after the provider id (the classic `auth set <id> <key>`).
    if (extra.length > 0) {
      return usage(
        `unexpected argument after auth ${sub} <providerId> (a credential on the command line is never accepted; use the prompt or stdin)`,
      );
    }
    return { kind: "auth", sub, providerId };
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
