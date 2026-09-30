/**
 * Worker entry for the bounded session verify (see `verify.ts`). Reads { path, threadId, home }
 * from workerData, runs the engine's synchronous read-only verifier once, and posts the result.
 * Never appends, never repairs, never touches the seat store.
 */
import { parentPort, workerData } from "node:worker_threads";
import { verifySessionFile } from "@madc/engine/client";

if (parentPort === null) {
  process.exit(1);
}
const { path, threadId, home } = workerData as { path: string; threadId: string; home: string };
const result = verifySessionFile(path, threadId, {}, home);
parentPort.postMessage(result);
