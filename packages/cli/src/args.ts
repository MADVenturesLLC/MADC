/**
 * Hand-rolled argument parser (CLI pin §1; `auth` added by M1-A2; `providers ls`, `seats ls` and
 * `-s` on the interactive entry added by M1-A8). No dependency. Flags may come before or after the
 * subcommand; `--` ends flags. The grammar is complete for the M0 surface plus the M1 commands:
 *
 *   madc --version | -V
 *   madc --help    | -h
 *   madc doctor [--json] [--init]
 *   madc auth set|rm|status <providerId>
 *   madc providers ls [--json]
 *   madc seats ls [--json]
 *   madc -p <prompt|-> [-s <seatId>] [--json]
 *   madc [-s <seatId>] ["<text>"]           interactive chat (Witness) on a full TTY
 */
import { isValidId } from "@madc/engine/client";

export type AuthSub = "set" | "rm" | "status";

export type ParsedArgs =
  | { readonly kind: "version" }
  | { readonly kind: "help" }
  | { readonly kind: "doctor"; readonly json: boolean; readonly init: boolean }
  | { readonly kind: "auth"; readonly sub: AuthSub; readonly providerId: string }
  /** M1-A8: `madc providers ls [--json]` (engine `provider/list`). */
  | { readonly kind: "providers-ls"; readonly json: boolean }
  /** M1-A8: `madc seats ls [--json]` (engine `seat/list`). */
  | { readonly kind: "seats-ls"; readonly json: boolean }
  | {
      readonly kind: "oneshot";
      /** The prompt text, or "-" to read it from stdin. */
      readonly prompt: string;
      readonly seatId: string | undefined;
      readonly json: boolean;
    }
  /**
   * Usage error: exit 2 with `message` (one line). The interactive entry still arrives here (rev
   * 6.2: `main.ts` opens the Witness app for the chat-reserved messages when every stream is a
   * TTY, and prints today's bytes otherwise); `seatId` carries `-s` to that entry (M1-A8).
   */
  | { readonly kind: "usage"; readonly message: string; readonly seatId?: string };

export const USAGE = `usage:
  madc --version | -V                          print version and protocol
  madc --help    | -h                          this help
  madc doctor [--json] [--init]                health report (--init seeds MADC_HOME via the engine)
  madc auth set <providerId>                   store a credential (no-echo TTY prompt; never an argument)
  madc auth rm <providerId>                    remove the stored credential
  madc auth status <providerId>                credential presence (never a value)
  madc providers ls [--json]                   every registry lane: wired, presence, terms freshness
  madc seats ls [--json]                       every seat in MADC_HOME (broken seats are listed)
  madc -p <prompt|-> [-s <seatId>] [--json]    headless one-shot turn ("-" reads stdin)
  madc [-s <seatId>] ["<text>"]                interactive chat on a terminal (-s picks the seat)
`;

export const CHAT_RESERVED = 'interactive chat arrives in M1; use: madc -p "<text>"';

/**
 * M1-A8: `madc -s <seatId>` without `-p` and without text. On a full TTY it opens the Witness app
 * on that seat (main.ts); anywhere else this is the one-line usage error it prints.
 */
export const SEAT_CHAT_NEEDS_TTY =
  'interactive chat (-s without -p) needs a terminal; headless: madc -p "<text>" -s <seatId>';

/** The parse-level refusal for `-s` with an id the engine could never accept (never echoed). */
export const SEAT_ID_INVALID = "-s needs a seat id matching ^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$";

const SEAT_FLAG_ONLY = "-s is only valid with -p or interactive chat";

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

/**
 * The pinned credential shapes (seat pin §4.2 / S6: generic `sk-…`, plan `sk-sp-…`, `xai-…`),
 * used ONLY to decide whether a diagnostic may echo a `-`-leading token (M1-A2 fix, Copilot
 * 4126239496): `madc auth set kimi-code -sk-…` must be rejected WITHOUT printing the argument.
 * Deliberately local — the CLI may not import engine redaction code (plan §6 import rules); the
 * shapes themselves are pin-frozen.
 */
const CREDENTIAL_SHAPED = /^(?:sk-(?:sp-)?|xai-)/i;

/**
 * The unknown-flag diagnostic. Ordinary typos keep the M0-pinned message (`unknown flag --nope`,
 * erratum1 §3e); inside an `auth` command, or when the token itself is credential-shaped, the raw
 * argument is never interpolated — it may be a credential pasted on the command line.
 */
function unknownFlagMessage(arg: string, inAuthCommand: boolean): string {
  if (inAuthCommand || CREDENTIAL_SHAPED.test(arg.replace(/^-+/, ""))) {
    return "unknown flag (token not echoed: a credential on the command line is never accepted)";
  }
  return `unknown flag ${arg}`;
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
        // positionals seen SO FAR decide the auth context: `madc auth set <id> -sk-…` has
        // positionals[0] === "auth" by the time the flag token is reached (Copilot 4126239496).
        return usage(unknownFlagMessage(arg, positionals[0] === "auth"));
    }
  }
  if (help) return { kind: "help" };
  if (version) return { kind: "version" };
  const [first, ...rest] = positionals;
  if (first === "doctor" && prompt === undefined) {
    if (rest.length > 0) return usage(`unexpected argument ${rest[0] ?? ""}`);
    if (seatId !== undefined) return usage(SEAT_FLAG_ONLY);
    return { kind: "doctor", json, init };
  }
  if ((first === "providers" || first === "seats") && prompt === undefined) {
    if (seatId !== undefined) return usage(SEAT_FLAG_ONLY);
    if (init) return usage("--init is only valid with doctor");
    const [sub, ...extra] = rest;
    // The unrecognized subcommand is not echoed (the same rule as `auth`).
    if (sub !== "ls") {
      return usage(
        sub === undefined
          ? `${first} needs a subcommand: ls`
          : `unknown ${first} subcommand (expected ls)`,
      );
    }
    if (extra.length > 0) return usage(`unexpected argument ${extra[0] ?? ""}`);
    return { kind: first === "providers" ? "providers-ls" : "seats-ls", json };
  }
  if (first === "auth") {
    if (prompt !== undefined) return usage("-p is only valid as the headless one-shot");
    if (seatId !== undefined) return usage(SEAT_FLAG_ONLY);
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
  // The interactive entry (rev 6.2 routes these messages to the Witness app on a full TTY).
  // M1-A8: `-s <seatId>` selects its seat. An id the engine could never accept is refused here,
  // before anything spawns or takes over the terminal; whether that seat exists stays the
  // engine's answer (-32005 / -32006 at thread/start), exactly as for the one-shot.
  if (seatId !== undefined && !isValidId(seatId)) return usage(SEAT_ID_INVALID);
  if (first !== undefined) return usage(CHAT_RESERVED, seatId);
  if (seatId !== undefined) {
    if (init) return usage("--init is only valid with doctor");
    return usage(SEAT_CHAT_NEEDS_TTY, seatId);
  }
  if (init) return usage("--init is only valid with doctor");
  return usage("no command given");
}

function usage(message: string, seatId?: string): ParsedArgs {
  return seatId === undefined ? { kind: "usage", message } : { kind: "usage", message, seatId };
}
