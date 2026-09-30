/**
 * Bounded read-only session verification (DESIGN-SPEC §5.3 R-a/R-g, §17.1 O-1): `verifySessionFile`
 * is synchronous (engine/src/session-store.ts:767), so in-process it would freeze the screen and
 * could never be timed out. The app runs it in a node:worker_threads worker — a node:* import, so
 * it stays inside the CLI pin's import allow-list — with a 30 000 ms deadline (the same value as
 * the one-shot's RESPONSE_TIMEOUT_MS, oneshot.ts:33). On the deadline the worker is terminated
 * and the caller shows UNVERIFIED: verify interrupted (O-1), never solid or green.
 */
import { Worker } from "node:worker_threads";
import type { SessionVerifyResult } from "@madc/engine/client";

export const VERIFY_DEADLINE_MS = 30_000;

export type VerifyOutcome =
  | { readonly kind: "result"; readonly result: SessionVerifyResult }
  | { readonly kind: "deadline" };

/** The worker entry: runs the synchronous verifier once and posts the result. */
const WORKER_URL = new URL("./verify-worker.ts", import.meta.url);

export type VerifyRequest = {
  readonly path: string;
  readonly threadId: string;
  readonly home: string;
  readonly deadlineMs: number;
};

/**
 * Run one bounded verify. `inProcess` is a test seam (deterministic unit tests): when set, the
 * verifier runs in this process under the same deadline race instead of a worker.
 */
export function runVerifyBounded(
  req: VerifyRequest,
  inProcess?: () => SessionVerifyResult,
): Promise<VerifyOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: VerifyOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        worker?.terminate();
      } catch {
        // already gone
      }
      resolve(outcome);
    };
    const timer = setTimeout(() => finish({ kind: "deadline" }), req.deadlineMs);
    let worker: Worker | null = null;
    if (inProcess !== undefined) {
      try {
        finish({ kind: "result", result: inProcess() });
      } catch (err) {
        finish({
          kind: "result",
          result: { ok: false, line: 1, reason: String(err), kind: "integrity" },
        });
      }
      return;
    }
    try {
      worker = new Worker(WORKER_URL, {
        workerData: { path: req.path, threadId: req.threadId, home: req.home },
      });
      worker.on("message", (m: unknown) => {
        finish({ kind: "result", result: m as SessionVerifyResult });
      });
      worker.on("error", () => {
        finish({
          kind: "result",
          result: { ok: false, line: 1, reason: "verify worker failed", kind: "integrity" },
        });
      });
      worker.on("exit", () => {
        // No message: the deadline terminated us, or the worker died silently.
        if (!settled) finish({ kind: "deadline" });
      });
    } catch {
      worker = null;
      finish({ kind: "deadline" });
    }
  });
}
