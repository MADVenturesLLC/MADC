/**
 * One-shot `madc-engine auth-set <providerId>` (Act M1-A2; protocol pin §2 and §3.5 "No `auth/set`
 * over JSONL"): a SEPARATE PROCESS, not a JSONL session. It reads the secret from its own no-echo
 * TTY prompt and writes it straight to the OS keychain through the engine's credential store, so
 * no secret ever crosses the protocol stream or its `-32700` parse-error path.
 *
 * Rules:
 * - Exactly one argument. Anything more (for example a key passed on the command line) is
 *   rejected — the secret comes only from the prompt or, under the dev exception, stdin.
 * - The provider must be a known registry catalog id on a lane that takes direct keys
 *   (`allowed-direct` or `interactive-only`). `forbidden` ids and `allowed-via-vendor-agent` ids
 *   are refused: vendor agents own their own login and madc never stores consumer-login tokens
 *   (ChatGPT / Claude.ai / Grok).
 * - TTY (`process.stdin.isTTY`): prompt with echo disabled (raw-mode char read, Node builtins
 *   only). Empty input is an error.
 * - No TTY: refused unless `MADC_DEV_ENV_KEYS=1` (D-M1-5 development exception), in which case the
 *   secret is read from stdin — safe here because this is not the JSONL session's stdin.
 * - The secret is never printed, logged, or persisted anywhere but the keychain; the confirmation
 *   is presence-style only and goes to stderr (stdout stays empty — engine stdout is protocol).
 *
 * Exit codes: 0 stored · 1 keychain write failed · 2 usage (arity, id grammar, unknown id, no
 * TTY without the flag, empty input) · 4 policy refusal (`forbidden` / vendor-agent lane) ·
 * 130 interrupted at the prompt.
 */
import { getById } from "@madc/registry";
import { isValidId } from "../protocol/ids.ts";
import { type CredentialStore, createCredentialStore, MADC_DEV_ENV_KEYS } from "./store.ts";

export type AuthSetDeps = {
  readonly stdin?: NodeJS.ReadableStream;
  readonly stderr?: { write(chunk: string): unknown };
  /** Default: `process.stdin.isTTY === true` (only when stdin is the real one). */
  readonly stdinIsTTY?: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Test seam: inject a store backed by a fake keychain. */
  readonly store?: CredentialStore;
};

/** Cap on the stdin secret read (API keys are far smaller). */
const STDIN_CAP_BYTES = 64 * 1024;

class Interrupted extends Error {}

/**
 * No-echo read of one secret line from a TTY: raw mode disables the terminal's echo, characters
 * accumulate until CR/LF, Backspace edits, Ctrl-C (no SIGINT in raw mode) aborts. Node builtins
 * only — no dependency.
 */
function promptSecretNoEcho(
  stdin: NodeJS.ReadStream,
  stderr: { write(chunk: string): unknown },
  prompt: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    stderr.write(prompt);
    const wasRaw = stdin.isRaw === true;
    let buf = "";
    const cleanup = () => {
      stdin.setRawMode(wasRaw);
      stdin.pause();
      stdin.removeListener("data", onData);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          cleanup();
          stderr.write("\n");
          resolve(buf);
          return;
        }
        if (ch === "\u0003") {
          cleanup();
          stderr.write("\n");
          reject(new Interrupted());
          return;
        }
        if (ch === "\u007F") {
          buf = buf.slice(0, -1);
        } else if (ch >= " ") {
          buf += ch;
        }
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
  });
}

/** Read the secret from stdin until EOF (UTF-8), capped; null when over the cap. */
async function readSecretFromStdin(stdin: NodeJS.ReadableStream): Promise<string | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stdin) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : (chunk as Buffer);
    total += buf.length;
    if (total > STDIN_CAP_BYTES) return null;
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function runAuthSet(argv: readonly string[], deps: AuthSetDeps = {}): Promise<number> {
  const stderr = deps.stderr ?? process.stderr;
  const env = deps.env ?? process.env;
  const fail = (code: number, message: string): number => {
    stderr.write(`madc-engine auth-set: ${message}\n`);
    return code;
  };

  if (argv.length !== 1) {
    return fail(
      2,
      "usage: madc-engine auth-set <providerId> — exactly one argument; a credential on the command line is never accepted (prompt or stdin only)",
    );
  }
  const providerId = argv[0] ?? "";
  if (!isValidId(providerId)) {
    return fail(2, `providerId must match ^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`);
  }
  const entry = getById(providerId);
  if (entry === undefined) {
    return fail(2, `unknown provider id "${providerId}" (not in the registry catalog)`);
  }
  if (entry.status === "forbidden") {
    return fail(4, `${providerId} is a forbidden lane: madc never stores its credentials`);
  }
  if (entry.status === "allowed-via-vendor-agent") {
    return fail(
      4,
      `${providerId} is a vendor-agent lane: the vendor binary owns its login; madc never stores consumer-login tokens`,
    );
  }

  const stdin = deps.stdin ?? process.stdin;
  const isTTY = deps.stdinIsTTY ?? (stdin === process.stdin && process.stdin.isTTY === true);
  let secret: string;
  if (isTTY) {
    try {
      secret = await promptSecretNoEcho(
        stdin as NodeJS.ReadStream,
        stderr,
        `Enter credential for ${providerId}: `,
      );
    } catch (err) {
      if (err instanceof Interrupted) return fail(130, "interrupted");
      throw err;
    }
  } else {
    if (env[MADC_DEV_ENV_KEYS] !== "1") {
      return fail(
        2,
        `refusing to read a credential without a TTY: auth-set prompts on the TTY with echo disabled; the ${MADC_DEV_ENV_KEYS}=1 development exception (D-M1-5) reads the secret from stdin instead`,
      );
    }
    const raw = await readSecretFromStdin(stdin);
    if (raw === null) return fail(2, `credential on stdin exceeds ${STDIN_CAP_BYTES} bytes`);
    secret = raw;
  }
  const trimmed = secret.trim();
  if (trimmed === "") return fail(2, "empty credential");

  const store = deps.store ?? createCredentialStore({ env });
  try {
    await store.set(providerId, trimmed);
  } catch (err) {
    return fail(
      1,
      `could not store the credential (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  stderr.write(`madc-engine auth-set: credential stored for ${providerId} (keychain)\n`);
  return 0;
}
