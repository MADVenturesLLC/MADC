#!/usr/bin/env node
import { runAuthSet } from "./credentials/auth-set.ts";
import { startStdioEngine } from "./main.ts";

// Spawned by the CLI (or tests) as a child with stdio ["pipe", "pipe", "inherit"].
// `madc-engine auth-set <providerId>` is intercepted BEFORE the JSONL server starts (protocol pin
// §2): a one-shot subcommand, a separate process and NOT a JSONL session — it reads the secret
// from its own no-echo TTY prompt (or, under the MADC_DEV_ENV_KEYS=1 development exception, from
// stdin) and writes it straight to the OS keychain, so no secret ever crosses the protocol stream
// or its -32700 parse-error path. Every other invocation starts the stdio engine.
const argv = process.argv.slice(2);
if (argv[0] === "auth-set") {
  process.exitCode = await runAuthSet(argv.slice(1));
} else {
  await startStdioEngine();
}
