#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { processIO } from "./io.ts";
import { main } from "./main.ts";

/** Run the CLI against the real process and exit once stdout has flushed. */
export async function runBin(engineEntry?: string): Promise<void> {
  const code = await main(process.argv.slice(2), processIO(engineEntry));
  process.exitCode = code;
  process.stdout.write("", () => process.exit(code));
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  await runBin();
}
