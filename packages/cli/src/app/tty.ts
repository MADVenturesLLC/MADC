/**
 * Production terminal adapter for the Witness app (DESIGN-SPEC §5.0): raw mode on stdin, decoded
 * keys, resize events, and the alternate-screen enter/restore already handled by the app. The
 * SIGHUP handler removes itself and re-raises, so the OS reports death by SIGHUP (§17.1 O-4).
 */

import type { CliIO, Out } from "../io.ts";
import { type AppTty, decodeKeys, type KeyValue, type WitnessApp } from "./app.ts";

export class ProcessTty implements AppTty {
  readonly #stdin: NodeJS.ReadStream;
  readonly #stdout: NodeJS.WriteStream;
  readonly #dims: { readonly columns?: number; readonly rows?: number } | null;
  #keyCb: ((key: KeyValue) => void) | null = null;
  #resizeCb: (() => void) | null = null;
  readonly #onData: (chunk: Buffer | string) => void;
  readonly #onResize: () => void;

  constructor(
    stdin: NodeJS.ReadStream,
    stdout: NodeJS.WriteStream,
    dims?: { readonly columns?: number; readonly rows?: number },
  ) {
    this.#stdin = stdin;
    this.#stdout = stdout;
    this.#dims = dims ?? null;
    this.#onData = (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (const key of decodeKeys(text)) this.#keyCb?.(key);
    };
    this.#onResize = () => this.#resizeCb?.();
  }

  write(s: string): void {
    this.#stdout.write(s);
  }

  columns(): number {
    return this.#dims?.columns ?? this.#stdout.columns ?? 80;
  }

  rows(): number {
    return this.#dims?.rows ?? this.#stdout.rows ?? 24;
  }

  setRawMode(on: boolean): void {
    if (this.#stdin.isTTY === true) this.#stdin.setRawMode(on);
    if (on) {
      this.#stdin.on("data", this.#onData);
      this.#stdin.resume();
      this.#stdout.on("resize", this.#onResize);
    } else {
      this.#stdin.removeListener("data", this.#onData);
      this.#stdout.removeListener("resize", this.#onResize);
    }
  }

  onKey(cb: (key: KeyValue) => void): void {
    this.#keyCb = cb;
  }

  onResize(cb: () => void): void {
    this.#resizeCb = cb;
  }
}

export type AppEnv = {
  readonly app: WitnessApp;
  readonly dispose: () => void;
};

/** Build the app against the real process streams and install the process signal handlers. */
export function attachProcessApp(
  io: CliIO,
  makeApp: (tty: AppTty, stderr: Out) => WitnessApp,
): AppEnv {
  const stdin = process.stdin as NodeJS.ReadStream;
  const stdout = process.stdout as NodeJS.WriteStream;
  const tty = new ProcessTty(stdin, stdout);
  const app = makeApp(tty, io.stderr);
  const onSigint = (): void => app.onSigint();
  const onSigterm = (): void => app.onSigterm();
  const onSighup = (): void => app.onSighup();
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  process.on("SIGHUP", onSighup);
  return {
    app,
    dispose: () => {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
      // O-4: restore default handling for SIGHUP, then re-raise so the OS reports 129.
      process.removeListener("SIGHUP", onSighup);
      process.kill(process.pid, "SIGHUP");
    },
  };
}
