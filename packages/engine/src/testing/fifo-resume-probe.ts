/**
 * Test fixture (POSIX; Argus pre-check of 15d4d9c, L1): `SessionWriter.resume` with a FIFO at the
 * session path. Its K2 re-read must answer -32009 instead of blocking the process. Modes:
 * - `nofile`: `verifiedFile` omitted, the FIFO is already in place when resume runs;
 * - `race`: `verifiedFile` given, the file is swapped for a FIFO after resume's identity check and
 *   before its open (`setSessionResumeReadForTests({ beforeOpen })`);
 * - `race-lstat`: the no-O_NOFOLLOW path, swapped for a FIFO between `openNoFollow`'s lstat and
 *   open;
 * - `race-read`: `verifiedFile` given, the file is swapped for a FIFO after the fd checks and before
 *   the read (`beforeRead`): the read must use the checked fd, so it returns a writer at once;
 * - `empty`: an empty chain (`nextSeq` 0, `expectedSize` 0, `verifiedFile` omitted) with a FIFO in
 *   place. A FIFO with no writer reads as 0 bytes, so only the fd's regular-file check refuses it.
 * Writes `{ code, fifo }` to `<dir>/result.json` (never to stdout: engine sources keep stdout
 * protocol-only); `fifo` says the path is still a FIFO afterwards.
 */
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  GENESIS_HASH,
  SessionChainIndex,
  SessionWriter,
  setSessionResumeReadForTests,
  unguardedSessionWriterForTests,
  verifySessionFile,
} from "../session-store.ts";

const dir = process.argv[2] ?? "";
const mode = process.argv[3] ?? "";
mkdirSync(dir, { recursive: true });
const path = join(dir, "thr_fifo.jsonl");
const writer = unguardedSessionWriterForTests.create(
  path,
  "thr_fifo",
  "madc-default",
  { cwd: null, backing: "kimi-code", providerId: "kimi-code", pinnedModel: "m" },
  () => [],
);
writer.append("turn.start", { turnId: "turn_1", inputText: "x" });
const v = verifySessionFile(path, "thr_fifo");
if (!v.ok || v.size === undefined || v.file === undefined)
  throw new Error("fixture did not verify");
const toFifo = () => {
  rmSync(path);
  execFileSync("mkfifo", [path]);
};
if (mode === "nofile" || mode === "empty") toFifo();
else if (mode === "race") setSessionResumeReadForTests({ beforeOpen: toFifo });
else if (mode === "race-read") setSessionResumeReadForTests({ beforeRead: toFifo });
else if (mode === "race-lstat")
  setSessionResumeReadForTests({ noFollowFlag: false, afterLstat: toFifo });
else throw new Error(`unknown mode ${mode}`);
const empty = mode === "empty";
let code: unknown = null;
try {
  SessionWriter.resume(
    path,
    "thr_fifo",
    "madc-default",
    empty ? 0 : v.nextSeq,
    empty ? GENESIS_HASH : v.lastHash,
    () => [],
    dir,
    mode === "nofile" || empty ? undefined : v.file,
    { holdsLock: () => true, expectedSize: empty ? 0 : v.size },
    undefined,
    empty ? new SessionChainIndex() : SessionChainIndex.fromEvents(v.events),
  );
} catch (err) {
  code = (err as { code?: unknown }).code ?? String(err);
} finally {
  setSessionResumeReadForTests(null);
}
writeFileSync(join(dir, "result.json"), JSON.stringify({ code, fifo: lstatSync(path).isFIFO() }));
