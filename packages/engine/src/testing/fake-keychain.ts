/**
 * Test fixture (M1-A2): a FAKE OS keychain as a child process. Implements the two command shapes
 * the credential store drives —
 *
 *   security    add-generic-password -U -s madc -a <id> -w <secret>
 *               find-generic-password [-w] -s madc -a <id>        (exit 44 when absent)
 *               delete-generic-password -s madc -a <id>
 *   secret-tool store --label=<label> service madc provider <id>  (secret via stdin)
 *               lookup service madc provider <id>                 (exit 1 when absent)
 *               clear  service madc provider <id>
 *
 * backed by one 0600 file per account under `MADC_TEST_KEYCHAIN_DIR`. Tests execute it through
 * shim scripts (`exec <runtime> fake-keychain.ts <tool> "$@"`) with SYNTHETIC keys only; it never
 * touches a real keychain or a real credential.
 *
 * Like the OS tools it impersonates, this fixture's contract is to PRINT the stored value on
 * read paths (`security -w`, `secret-tool lookup`). It is a child-process double, never part of
 * the engine's protocol path, so it writes fd 1 directly (engine sources keep stdout protocol-only).
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.MADC_TEST_KEYCHAIN_DIR ?? "";
if (dir === "") {
  writeSync(2, "fake-keychain: MADC_TEST_KEYCHAIN_DIR is not set\n");
  process.exit(2);
}
mkdirSync(dir, { recursive: true });

const [tool, ...args] = process.argv.slice(2);
const fileFor = (account: string): string => join(dir, encodeURIComponent(account));

/** `<flag> <value>` lookup for the `security` flag style. */
function flagValue(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

/** Trailing `key value` attribute pairs for the `secret-tool` style (`--label=…` skipped). */
function attributeValue(name: string): string | undefined {
  const positional = args.slice(1).filter((a) => !a.startsWith("--"));
  for (let i = 0; i + 1 < positional.length; i += 2) {
    if (positional[i] === name) return positional[i + 1];
  }
  return undefined;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

let code = 2;
if (tool === "security") {
  const sub = args[0];
  const account = flagValue("-a");
  if (account !== undefined) {
    if (sub === "add-generic-password") {
      writeFileSync(fileFor(account), flagValue("-w") ?? "", { mode: 0o600 });
      code = 0;
    } else if (sub === "find-generic-password") {
      try {
        const value = readFileSync(fileFor(account), "utf8");
        if (args.includes("-w")) writeSync(1, `${value}\n`);
        code = 0;
      } catch {
        code = 44; // errSecItemNotFound
      }
    } else if (sub === "delete-generic-password") {
      try {
        rmSync(fileFor(account));
        code = 0;
      } catch {
        code = 44;
      }
    }
  }
} else if (tool === "secret-tool") {
  const sub = args[0];
  const account = attributeValue("provider");
  if (account !== undefined) {
    if (sub === "store") {
      writeFileSync(fileFor(account), await readStdin(), { mode: 0o600 });
      code = 0;
    } else if (sub === "lookup") {
      try {
        writeSync(1, readFileSync(fileFor(account), "utf8"));
        code = 0;
      } catch {
        code = 1;
      }
    } else if (sub === "clear") {
      try {
        rmSync(fileFor(account));
        code = 0;
      } catch {
        code = 1;
      }
    }
  }
} else {
  writeSync(2, `fake-keychain: unknown tool ${String(tool)}\n`);
}
process.exit(code);
