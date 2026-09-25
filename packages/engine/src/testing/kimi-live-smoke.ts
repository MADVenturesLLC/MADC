/**
 * MANUAL live smoke for the Founder — never run by CI or `npm test` (not a `*.test.ts` file).
 * Spawns the production engine, which reads `KIMI_API_KEY` from your local environment, runs one
 * turn on the built-in `madc-default` seat against the real Kimi Code endpoint, and prints the
 * items (agent text + servedModel receipt) on stderr (engine sources never write stdout). The key
 * is never printed.
 *
 *   read -rs KIMI_API_KEY && export KIMI_API_KEY && \
 *     node packages/engine/src/testing/kimi-live-smoke.ts "Reply with the word ok."
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnEngine } from "../client.ts";
import type { Turn } from "../protocol/types.ts";

const prompt = process.argv[2] ?? "Reply with the word ok.";
const root = mkdtempSync(join(tmpdir(), "madc-live-smoke-"));
const client = spawnEngine({ env: { MADC_HOME: join(root, "home") } });
try {
  await client.request("initialize", { clientInfo: { name: "madc-live-smoke", version: "0.0.0" } });
  client.notify("initialized", {});
  const { thread } = await client.request("thread/start", {});
  const { turn } = await client.request("turn/start", {
    threadId: thread.id,
    input: [{ type: "text", text: prompt }],
  });
  const done = await client.waitFor(
    (m) => m.method === "turn/completed" && (m.params as { turn: Turn }).turn.id === turn.id,
    120_000,
  );
  const final = (done.params as { turn: Turn }).turn;
  process.stderr.write(
    `${JSON.stringify({ status: final.status, error: final.error, items: final.items }, null, 2)}\n`,
  );
  process.exitCode = final.status === "completed" ? 0 : 1;
} catch (err) {
  process.stderr.write(`live smoke failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
} finally {
  await client.close();
  rmSync(root, { recursive: true, force: true });
}
