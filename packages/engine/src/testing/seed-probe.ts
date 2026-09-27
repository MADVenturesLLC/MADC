/**
 * Test fixture (Amendment 3 4e): two of these race `seedDefaultSeat` on one fresh home. A file
 * barrier releases both right before the link, so the loser's `EEXIST` proof sees the winner
 * mid-link or done. Writes `{ created }` or `{ error }` to `<dir>/result-<pid>.json` (never to
 * stdout: engine sources keep stdout protocol-only).
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { seedDefaultSeat, setSeedHooksForTests } from "../seat-store.ts";

const [dir, home, barrier] = process.argv.slice(2);
if (dir === undefined || home === undefined || barrier === undefined) {
  throw new Error("usage: seed-probe.ts <dir> <home> <barrier>");
}
setSeedHooksForTests({
  beforeLink: () => {
    writeFileSync(join(barrier, `ready-${process.pid}`), "");
    const deadline = Date.now() + 15_000;
    while (!existsSync(join(barrier, "release"))) {
      if (Date.now() > deadline) throw new Error("seed race barrier timed out");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  },
});
let result: { created?: boolean; error?: string };
try {
  result = { created: seedDefaultSeat(home).created };
} catch (err) {
  result = { error: err instanceof Error ? err.message : String(err) };
}
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, `result-${process.pid}.json`), JSON.stringify(result));
