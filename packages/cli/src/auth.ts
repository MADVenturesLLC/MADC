/**
 * `madc auth set|rm|status <providerId>` (M1-A2, plan §7; protocol pin §2 and §3.5).
 *
 * - `set` NEVER travels over the JSONL protocol: it spawns the one-shot `madc-engine auth-set
 *   <providerId>` child (stdio inherited, a separate process — not a JSONL session). The child
 *   reads the secret from its own no-echo TTY prompt — or, only under the pinned
 *   `MADC_DEV_ENV_KEYS=1` development exception (D-M1-5), from stdin — and writes it straight to
 *   the OS keychain. The CLI passes the provider id ONLY: a credential on the command line is
 *   rejected by the parser (args.ts, without echoing it) and again by the child (arity check).
 * - `status` / `rm` are ordinary JSONL requests on a spawned engine session. `auth/status`
 *   answers the exact pinned presence shape `{ providerId, present }` (protocol pin §3.5) and
 *   this command prints only that presence — never a value, length, prefix or hash.
 *
 * Signal discipline mirrors the one-shot and doctor (§3e E6/E7): the early-signal record is taken
 * before anything spawns, and SIGINT/SIGTERM during the run exit 130/143.
 */
import type { ChildProcess } from "node:child_process";
import { MADC_VERSION } from "@madc/core";
import {
  type AuthStatusResult,
  EngineExitedError,
  EngineRpcError,
  ErrorCode,
  spawnAuthSet,
  spawnEngine,
} from "@madc/engine/client";
import type { AuthSub } from "./args.ts";
import { takeEarlySignal } from "./early-signal.ts";
import { classifyCode, EXIT } from "./exit-codes.ts";
import { type CliIO, TimeoutError, withTimeout } from "./io.ts";

/** One keychain child invocation is capped at 10 s engine-side; initialize + request must fit. */
const AUTH_REQUEST_MS = 15_000;

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** §3e E6/E7-shaped signal state: the recorded exit and the child kill hook. */
type AuthSignal = { exit: number | null; kill: (() => void) | null };

function installSignalHandlers(): { sig: AuthSignal; remove: () => void } {
  const sig: AuthSignal = { exit: null, kill: null };
  const onSigint = (): void => {
    sig.exit = sig.exit ?? EXIT.sigint;
    sig.kill?.();
  };
  const onSigterm = (): void => {
    sig.exit = EXIT.sigterm;
    sig.kill?.();
  };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  return {
    sig,
    remove: () => {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
    },
  };
}

export async function runAuth(io: CliIO, sub: AuthSub, providerId: string): Promise<number> {
  // A signal recorded by the bin.ts backstop during module load applies before anything spawns.
  const earlySignal = takeEarlySignal();
  if (earlySignal !== null) {
    io.stderr.write("madc: interrupted by signal\n");
    return earlySignal;
  }
  return sub === "set" ? runAuthSetChild(io, providerId) : runAuthRequest(io, sub, providerId);
}

/**
 * `madc auth set`: hand the terminal to the one-shot engine child and pass its exit code through
 * (0 stored · 1 keychain failure · 2 usage / no-TTY-without-the-flag · 4 policy refusal ·
 * 130 interrupted at the prompt). The secret is prompt- or stdin-only, so nothing secret can
 * reach this process's own streams; the child's confirmation goes to stderr, stdout stays empty.
 */
function runAuthSetChild(io: CliIO, providerId: string): Promise<number> {
  const { sig, remove } = installSignalHandlers();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      sig.kill = null;
      remove();
      resolve(code);
    };
    let child: ChildProcess;
    try {
      child = spawnAuthSet(providerId, {
        ...(io.engineEntry !== undefined ? { entry: io.engineEntry } : {}),
      });
    } catch (err) {
      io.stderr.write(`madc: cannot spawn the engine auth-set process (${errText(err)})\n`);
      finish(EXIT.engine);
      return;
    }
    sig.kill = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone
      }
    };
    child.on("error", (err: unknown) => {
      io.stderr.write(
        `madc: cannot run the engine auth-set process (${(err as NodeJS.ErrnoException).code ?? "error"})\n`,
      );
      finish(EXIT.engine);
    });
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (sig.exit !== null) finish(sig.exit);
      else if (code !== null) finish(code);
      else finish(signal === "SIGTERM" ? EXIT.sigterm : EXIT.sigint);
    });
  });
}

/** `madc auth status` / `madc auth rm`: one JSONL session against a spawned engine child. */
async function runAuthRequest(
  io: CliIO,
  sub: "rm" | "status",
  providerId: string,
): Promise<number> {
  const { sig, remove } = installSignalHandlers();
  const client = spawnEngine({
    ...(io.engineEntry !== undefined ? { entry: io.engineEntry } : {}),
  });
  sig.kill = () => {
    try {
      client.child.kill("SIGKILL");
    } catch {
      // already gone
    }
  };
  try {
    await withTimeout(
      client.request("initialize", {
        clientInfo: { name: "madc-auth", version: MADC_VERSION },
      }),
      AUTH_REQUEST_MS,
    );
    client.notify("initialized", {});
    if (sub === "status") {
      const res = (await withTimeout(
        client.request("auth/status", { providerId }),
        AUTH_REQUEST_MS,
      )) as AuthStatusResult | null;
      if (
        client.protocolViolations.length > 0 ||
        res === null ||
        typeof res !== "object" ||
        typeof res.present !== "boolean"
      ) {
        io.stderr.write("madc: engine answered auth/status with a malformed payload\n");
        return EXIT.engine;
      }
      // Presence only (pin §3.5). The pinned payload carries nothing else that could be printed.
      io.stdout.write(`${providerId}: ${res.present ? "present" : "absent"}\n`);
      return EXIT.ok;
    }
    await withTimeout(client.request("auth/remove", { providerId }), AUTH_REQUEST_MS);
    if (client.protocolViolations.length > 0) {
      io.stderr.write("madc: engine sent a non-protocol line during auth/rm\n");
      return EXIT.engine;
    }
    io.stdout.write(`${providerId}: removed\n`);
    return EXIT.ok;
  } catch (err) {
    if (sig.exit !== null) {
      io.stderr.write("madc: interrupted by signal\n");
      return sig.exit;
    }
    if (err instanceof TimeoutError) {
      io.stderr.write(`madc: engine timed out answering auth/${sub}\n`);
      try {
        client.child.kill("SIGKILL");
      } catch {
        // already gone
      }
      return EXIT.engine;
    }
    if (err instanceof EngineRpcError) {
      io.stderr.write(`madc: auth/${sub} failed: ${err.code} ${err.message}\n`);
      // -32602 on `auth/*` is the caller's own providerId — a usage error. (The one-shot's
      // classifyCode maps -32602 to usage only for thread/start; auth/* is new M1 surface.)
      return err.code === ErrorCode.InvalidParams
        ? EXIT.usage
        : classifyCode(err.code, "request").exit;
    }
    if (err instanceof EngineExitedError) {
      io.stderr.write(`madc: ${err.message}\n`);
      return EXIT.engine;
    }
    io.stderr.write(`madc: auth/${sub} failed (${errText(err)})\n`);
    return EXIT.engine;
  } finally {
    sig.kill = null;
    remove();
    try {
      await client.close(1_000);
    } catch {
      // the exit path above already reported the failure
    }
  }
}
