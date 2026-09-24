#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { MADC_VERSION } from "@madc/core";

export function runCli(write: (s: string) => void = (s) => process.stdout.write(s)): number {
  write(`${MADC_VERSION}\n`);
  return 0;
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
  process.exit(runCli());
}
