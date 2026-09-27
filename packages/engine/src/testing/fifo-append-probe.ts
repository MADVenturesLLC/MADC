/**
 * Test fixture (POSIX): a session file replaced by a FIFO with no reader. The append must fail
 * with -32009 instead of blocking the process. Writes `{ code, broken }` to `<dir>/result.json`
 * (never to stdout: engine sources keep stdout protocol-only).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { unguardedSessionWriterForTests } from "../session-store.ts";

const dir = process.argv[2] ?? "";
mkdirSync(dir, { recursive: true });
const path = join(dir, "thr_fifo.jsonl");
const writer = unguardedSessionWriterForTests.create(
  path,
  "thr_fifo",
  "madc-default",
  { cwd: null, backing: "kimi-code", providerId: "kimi-code", pinnedModel: "m" },
  () => [],
);
rmSync(path);
execFileSync("mkfifo", [path]);
try {
  writer.append("turn.start", { turnId: "turn_1", inputText: "x" });
  writeFileSync(join(dir, "result.json"), JSON.stringify({ code: null, broken: writer.broken }));
} catch (err) {
  const code = (err as { code?: unknown }).code;
  writeFileSync(
    join(dir, "result.json"),
    JSON.stringify({ code: code ?? null, broken: writer.broken }),
  );
}
