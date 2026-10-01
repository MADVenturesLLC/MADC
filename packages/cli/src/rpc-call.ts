/**
 * One read-only request against a spawned engine (M1-A8): `initialize` (the pinned protocol
 * version or a violation), `initialized`, the one method, EOF. Shared by `madc providers ls`,
 * `madc seats ls` and doctor's `lanes` row so the three read the engine the same way. Every
 * failure comes back classed (CLI pin §4): an RPC error by its code, everything else — spawn
 * failure, early exit, a non-protocol stdout line, a malformed answer, the deadline — is the
 * engine class (exit 3). Nothing here prints; the caller renders.
 */
import { MADC_VERSION } from "@madc/core";
import {
  type EngineClient,
  EngineExitedError,
  EngineProtocolError,
  EngineRpcError,
  PROTOCOL_VERSION,
  spawnEngine,
} from "@madc/engine/client";
import { classifyCode, type ErrorClass, EXIT } from "./exit-codes.ts";
import { type CliIO, TimeoutError, withTimeout } from "./io.ts";

export type EngineCallFailure = {
  readonly ok: false;
  /** One line, engine text never included verbatim (callers sanitize what they print). */
  readonly reason: string;
  /** The engine's error code when the method answered an RPC error, else null. */
  readonly code: number | null;
  readonly exit: number;
  readonly class: ErrorClass;
};

export type EngineCallResult = { readonly ok: true; readonly result: unknown } | EngineCallFailure;

/** A caller-owned kill hook (signal handling): armed while the engine child is alive. */
export type EngineCallSignal = { kill: (() => void) | null };

export type EngineCallOptions = {
  /** Merged over `process.env` for the child (`undefined` removes a variable). */
  readonly env: Record<string, string | undefined>;
  readonly clientName: string;
  readonly method: "provider/list" | "seat/list";
  /** Hard deadline for the whole exchange (initialize + request + cleanup). */
  readonly budgetMs: number;
  readonly sig?: EngineCallSignal;
};

const engineFailure = (reason: string): EngineCallFailure => ({
  ok: false,
  reason,
  code: null,
  exit: EXIT.engine,
  class: "engine",
});

export async function callEngineOnce(
  io: CliIO,
  opts: EngineCallOptions,
): Promise<EngineCallResult> {
  let client: ReturnType<typeof spawnEngine>;
  try {
    client = spawnEngine({
      env: opts.env,
      ...(io.engineEntry !== undefined ? { entry: io.engineEntry } : {}),
    });
  } catch (err) {
    return engineFailure(
      `cannot spawn the engine (${err instanceof Error ? err.message : "error"})`,
    );
  }
  const c = client;
  if (opts.sig !== undefined) {
    opts.sig.kill = () => {
      try {
        c.child.kill("SIGKILL");
      } catch {
        // already gone
      }
    };
  }
  const t0 = Date.now();
  const left = (): number => Math.max(1, opts.budgetMs - (Date.now() - t0));
  let outcome: EngineCallResult;
  try {
    outcome = await exchange(c, opts, left);
  } finally {
    if (opts.sig !== undefined) opts.sig.kill = null;
    // Cleanup never extends the deadline: EOF, then a kill once the budget (at most 1 s more of
    // it) is spent — a timed-out or hung engine is killed at once.
    const grace = Math.min(1_000, Math.max(0, opts.budgetMs - (Date.now() - t0)));
    try {
      await c.close(grace);
      // The child's exit can land before the last of its stdout is read: drain it (same bound).
      await stdoutClosed(c, grace);
    } catch {
      // the result carries the failure
    }
  }
  // Decided only after cleanup (Copilot, 2ecc6fb review): a non-protocol stdout line the engine
  // writes after its answer — even while it shuts down — still fails the call.
  if (outcome.ok && c.protocolViolations.length > 0) {
    return engineFailure("protocol violation: non-JSON line on engine stdout");
  }
  return outcome;
}

/** `initialize` (pinned version), `initialized`, the one request; every failure classed. */
async function exchange(
  c: EngineClient,
  opts: EngineCallOptions,
  left: () => number,
): Promise<EngineCallResult> {
  let step: "initialize" | EngineCallOptions["method"] = "initialize";
  try {
    const init = (await withTimeout(
      c.request("initialize", { clientInfo: { name: opts.clientName, version: MADC_VERSION } }),
      left(),
    )) as { protocolVersion?: unknown } | null;
    if (init === null || typeof init !== "object" || init.protocolVersion !== PROTOCOL_VERSION) {
      return engineFailure("protocol violation: initialize returned an unexpected result");
    }
    c.notify("initialized", {});
    step = opts.method;
    const result = await withTimeout(c.request(opts.method, {}), left());
    return { ok: true, result };
  } catch (err) {
    if (err instanceof TimeoutError) return engineFailure(`timeout ${opts.budgetMs}ms`);
    if (err instanceof EngineRpcError) {
      if (step === "initialize") {
        return engineFailure(`protocol violation: initialize answered error ${err.code}`);
      }
      const cls = classifyCode(err.code, "request");
      return {
        ok: false,
        reason: `${opts.method} answered error ${err.code}`,
        code: err.code,
        exit: cls.exit,
        class: cls.class,
      };
    }
    if (err instanceof EngineProtocolError) return engineFailure("protocol violation");
    if (err instanceof EngineExitedError) {
      return engineFailure(`engine exited (${String(c.child.exitCode ?? c.child.signalCode)})`);
    }
    return engineFailure(err instanceof Error ? err.message : String(err));
  }
}

/** Resolves once the child's stdout has closed (every line read), or after `ms` at most. */
function stdoutClosed(c: EngineClient, ms: number): Promise<void> {
  const out = c.child.stdout;
  if (out === null || out.destroyed || out.readableEnded) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    out.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
