#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { processIO } from "./io.ts";
import { main } from "./main.ts";

/** Resolves once everything written to `stream` so far has been flushed. */
function flushed(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    if (stream.writableLength === 0 && !stream.writableNeedDrain) {
      stream.write("", () => resolve());
    } else {
      stream.once("drain", () => stream.write("", () => resolve()));
    }
  });
}

/**
 * Run the CLI against the real process and exit once BOTH stdout (text / JSON) and stderr (the
 * receipt) have flushed (Copilot r4107601166: never exit with the receipt still buffered).
 */
export async function runBin(engineEntry?: string): Promise<void> {
  const code = await main(process.argv.slice(2), processIO(engineEntry));
  process.exitCode = code;
  await Promise.all([flushed(process.stdout), flushed(process.stderr)]);
  process.exit(code);
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
