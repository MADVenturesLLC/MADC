/** Process surface the CLI runs against (swappable in tests; production uses `processIO()`). */
import type { Readable } from "node:stream";

export type Out = { write(chunk: string): unknown };

export type CliIO = {
  readonly stdout: Out;
  readonly stderr: Out;
  readonly stdin: Readable;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdoutIsTTY: boolean;
  readonly stderrIsTTY: boolean;
  /**
   * M1-A5: stdin is a TTY (one of the facts behind the turn mode claim, `mode.ts`). Optional so
   * existing IO fixtures keep working; absent reads as `false`, which can only claim `headless`.
   */
  readonly stdinIsTTY?: boolean;
  readonly cwd: string;
  /**
   * Engine entry script. Undefined = the real engine (`@madc/engine/client` default). Only the
   * test launcher (`testing/cli-launcher.ts`) sets it, to point at a fixture engine.
   */
  readonly engineEntry?: string | undefined;
};

export function processIO(engineEntry?: string): CliIO {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    env: process.env,
    stdoutIsTTY: process.stdout.isTTY === true,
    stderrIsTTY: process.stderr.isTTY === true,
    stdinIsTTY: process.stdin.isTTY === true,
    // §3e E16 F-130: read lazily — only the one-shot needs cwd, and a deleted current directory
    // must not break `--version`, `--help`, usage errors or doctor.
    get cwd() {
      return process.cwd();
    },
    engineEntry,
  };
}

/** Colour only on a TTY, never when `NO_COLOR` is set (any value), CLI pin §3. */
export function colorEnabled(io: CliIO): boolean {
  return io.stdoutIsTTY && io.env.NO_COLOR === undefined;
}

export function paint(on: boolean, code: string, text: string): string {
  return on ? `\u001b[${code}m${text}\u001b[0m` : text;
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });

export class TimeoutError extends Error {
  readonly ms: number;
  constructor(ms: number) {
    super(`timeout ${ms}ms`);
    this.name = "TimeoutError";
    this.ms = ms;
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
