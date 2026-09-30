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

/**
 * A minimal terminal emulator for SCREEN-STATE assertions: feed it everything a VirtualTty
 * recorded and read back the visible grid, cell by cell. This catches the remnant class of
 * repaint bugs that string-level frame comparisons hide — a shorter line painted over a longer
 * one keeps the old tail on the same row, and a frame taller than the screen scrolls, so stale
 * cells can survive anywhere the new frame does not fully overwrite.
 *
 * Supports exactly what the app writes — `\u001b[H`, `\u001b[2J`, `\u001b[J`, `\u001b[K`, the
 * 1049/25 private modes (the alt-screen swap is modelled as a clear so state never leaks across
 * start/exit), SGR (ignored for content), `\r`, `\n` — plus width wrap with bottom scroll.
 * Wrap is immediate (a real terminal defers the wrap by one cell); the app's lines stay under
 * the terminal width, so the approximation never fires in practice.
 */
export class ScreenModel {
  readonly #cols: number;
  #lines: string[];
  #cx = 0;
  #cy = 0;

  constructor(cols: number, rows: number) {
    this.#cols = cols;
    this.#lines = Array.from({ length: rows }, () => "");
  }

  /** Apply a recorded write stream to the grid. */
  feed(text: string): void {
    let i = 0;
    while (i < text.length) {
      const ch = text[i] ?? "";
      if (ch === "\u001b") {
        const rest = text.slice(i);
        // biome-ignore lint/suspicious/noControlCharactersInRegex: matching the app's own CSI bytes.
        const m = rest.match(/^\u001b\[[?]?[0-9;]*[A-Za-z]/);
        if (m !== null) {
          this.#control(m[0] ?? "");
          i += m[0].length;
          continue;
        }
        i++; // a lone ESC: no cell effect
        continue;
      }
      if (ch === "\r") {
        this.#cx = 0;
        i++;
        continue;
      }
      if (ch === "\n") {
        // The app's stdout goes through a PTY with the default ONLCR output mode, so `\n`
        // reaches the terminal as CRLF: next row, column 0.
        this.#cx = 0;
        this.#newline();
        i++;
        continue;
      }
      this.#put(ch);
      i++;
    }
  }

  /** The visible screen: rows with trailing blanks trimmed, empty tail rows dropped. */
  lines(): string[] {
    const trimmed = this.#lines.map((l) => l.replace(/[ \t]+$/, ""));
    while (trimmed.length > 0 && trimmed[trimmed.length - 1] === "") trimmed.pop();
    return trimmed;
  }

  /** The whole visible screen as one string. */
  text(): string {
    return this.lines().join("\n");
  }

  #control(seq: string): void {
    const body = seq.slice(2, -1);
    const fin = seq[seq.length - 1] ?? "";
    if (fin === "H") {
      this.#cx = 0;
      this.#cy = 0;
      return;
    }
    if (fin === "J") {
      const n = body === "" || body === "0" ? "0" : body;
      if (n === "0") {
        // Erase from cursor to end of screen (rest of this row + every row below).
        this.#setRow(this.#cy, this.#row(this.#cy).slice(0, this.#cx));
        for (let y = this.#cy + 1; y < this.#lines.length; y++) this.#setRow(y, "");
      } else if (n === "2") {
        for (let y = 0; y < this.#lines.length; y++) this.#setRow(y, "");
      }
      return;
    }
    if (fin === "K") {
      const n = body === "" || body === "0" ? "0" : body;
      if (n === "0") this.#setRow(this.#cy, this.#row(this.#cy).slice(0, this.#cx));
      else if (n === "2") this.#setRow(this.#cy, "");
      return;
    }
    if (fin === "h" || fin === "l") {
      // 1049 (alt screen) and 25 (cursor visibility): the swap clears, the rest are no-ops.
      if (body.includes("1049")) {
        for (let y = 0; y < this.#lines.length; y++) this.#setRow(y, "");
        this.#cx = 0;
        this.#cy = 0;
      }
      return;
    }
    if (fin === "m") return; // SGR: content unaffected
    // Cursor moves and everything else the app never writes: ignored.
  }

  #row(y: number): string {
    return this.#lines[y] ?? "";
  }

  #setRow(y: number, content: string): void {
    this.#lines[y] = content;
  }

  #put(ch: string): void {
    const row = this.#row(this.#cy).padEnd(this.#cx, " ");
    this.#setRow(this.#cy, row.slice(0, this.#cx) + ch + row.slice(this.#cx + ch.length));
    this.#cx += ch.length;
    if (this.#cx >= this.#cols) {
      this.#cx = 0;
      this.#newline();
    }
  }

  #newline(): void {
    if (this.#cy + 1 >= this.#lines.length) {
      this.#lines.shift();
      this.#lines.push("");
      this.#cy = this.#lines.length - 1;
    } else {
      this.#cy++;
    }
  }
}
