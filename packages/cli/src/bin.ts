#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { installEarlySignal, takeEarlySignal } from "./early-signal.ts";

// §3e E6/E7: the backstop must be live BEFORE the rest of the module tree is evaluated. This
// module's static graph is deliberately tiny (node builtins + early-signal.ts); `io.ts` and
// `main.ts` (which pulls in doctor, the one-shot and the engine client) are imported dynamically
// inside `runBin`, under the backstop. Type stripping loads the whole static graph before any of
// it runs, so a static first-import cannot arm the backstop early enough.
installEarlySignal();

/**
 * §3e E12: a write error (EPIPE included) on the CLI's own stdout or stderr stops further writes
 * to that stream and is never printed; the process exits with the run's exit code as computed
 * (the exit code reports the run, not delivery). Without a listener Node would die with an
 * unhandled `error` event (exit 1 with a stack) after the receipt already said `exit 0`.
 */
function guardStream(stream: NodeJS.WriteStream): {
  out: { write(chunk: string): unknown };
  dead: () => boolean;
} {
  let dead = false;
  stream.on("error", () => {
    dead = true;
  });
  return {
    out: {
      write(chunk: string) {
        if (dead) return false;
        try {
          return stream.write(chunk);
        } catch {
          dead = true;
          return false;
        }
      },
    },
    dead: () => dead,
  };
}

/**
 * Resolves once everything written to `stream` so far has been flushed: `end()` flushes every
 * queued write on Node and on Bun. (§3e E13, ledger D-016: on Bun the callback of a later write
 * can fire while a large earlier write is still buffered, so the old empty-write-callback flush
 * truncated piped stdout at 64 KiB.) A stream that has errored resolves at once (E12).
 */
function flushed(stream: NodeJS.WriteStream, dead: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    if (dead()) {
      resolve();
      return;
    }
    stream.once("error", () => resolve());
    try {
      stream.end(() => resolve());
    } catch {
      resolve();
    }
  });
}

/**
 * Run the CLI against the real process and exit once BOTH stdout (text / JSON) and stderr (the
 * receipt) have flushed (Copilot r4107601166: never exit with the receipt still buffered).
 */
export async function runBin(engineEntry?: string): Promise<void> {
  const [{ processIO, wrapProcessIO }, { main }] = await Promise.all([
    import("./io.ts"),
    import("./main.ts"),
  ]);
  const stdout = guardStream(process.stdout);
  const stderr = guardStream(process.stderr);
  const io = wrapProcessIO(processIO(engineEntry), stdout.out, stderr.out);
  const code = await main(process.argv.slice(2), io);
  // A command that installs no listeners of its own (--version, --help, usage failures) never
  // takes the backstop: drop it here so a signal during the flush keeps default handling (F-102).
  takeEarlySignal();
  process.exitCode = code;
  await Promise.all([flushed(process.stdout, stdout.dead), flushed(process.stderr, stderr.dead)]);
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
