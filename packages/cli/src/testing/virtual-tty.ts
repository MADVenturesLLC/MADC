/**
 * Test virtual terminal for the Witness app: records every write, answers dimension queries
 * from captured values, and lets tests push decoded keys and resizes. No real TTY anywhere.
 */
import type { AppTty, KeyValue } from "../app/app.ts";

export class VirtualTty implements AppTty {
  readonly chunks: string[] = [];
  cols: number;
  rowcount: number;
  raw = false;
  #keyCb: ((key: KeyValue) => void) | null = null;
  #resizeCb: (() => void) | null = null;

  constructor(cols = 110, rowcount = 32) {
    this.cols = cols;
    this.rowcount = rowcount;
  }

  write(s: string): void {
    this.chunks.push(s);
  }

  columns(): number {
    return this.cols;
  }

  rows(): number {
    return this.rowcount;
  }

  setRawMode(on: boolean): void {
    this.raw = on;
  }

  onKey(cb: (key: KeyValue) => void): void {
    this.#keyCb = cb;
  }

  onResize(cb: () => void): void {
    this.#resizeCb = cb;
  }

  key(k: KeyValue): void {
    this.#keyCb?.(k);
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rowcount = rows;
    this.#resizeCb?.();
  }

  /** The last painted frame, split into lines with SGR stripped (deterministic assertions). */
  lastFrame(): string[] {
    const last = this.chunks[this.chunks.length - 1] ?? "";
    return (
      last
        // biome-ignore lint/suspicious/noControlCharactersInRegex: the virtual screen strips ANSI.
        .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
        .split("\n")
        .map((l) => l.replace(/\s+$/, ""))
    );
  }

  /** Everything ever written, SGR-stripped, as one string. */
  text(): string {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the virtual screen strips ANSI.
    return this.chunks.join("").replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
  }
}

/** Recording stderr for receipt/§5.13 assertions. */
export class RecordingOut {
  readonly chunks: string[] = [];
  write(chunk: string): void {
    this.chunks.push(chunk);
  }
  text(): string {
    return this.chunks.join("");
  }
  /** Text with all SGR spans stripped (the §5.12 test checks bytes with SGR stripped). */
  plain(): string {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the virtual screen strips ANSI.
    return this.text().replace(/\u001b\[[0-9;]*m/g, "");
  }
}
