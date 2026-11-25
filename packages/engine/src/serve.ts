/**
 * M3-A2 (`docs/plan/PIN-madc-M3-desktop-protocol-amendment-1.md` §1–§6):
 * `madc-engine serve` — socket-only listener with `$MADC_HOME/engine.lock` lifetime ownership,
 * stdin-EOF / signal / error shutdown sequence, 5 s shutdown deadline, and explicit `process.exit`
 * from the stderr write callback (or bounded grace) on every exit path.
 */
import { mkdirSync } from "node:fs";
import type { Writable } from "node:stream";
import type { Agent } from "./agent.ts";
import { enforcePrivateDir, resolveMadcHome } from "./home.ts";
import {
  acquireLockAt,
  engineLockPath,
  holdsThreadLock,
  type LockHandle,
  LockPathNotAFileError,
  releaseThreadLock,
} from "./lock.ts";
import { type AgentFactory, defaultAgentFactory } from "./main.ts";
import { loadRepoPolicy } from "./policy/store.ts";
import {
  engineSocketPath,
  type SocketServerDeps,
  type SocketServerHandle,
  SocketStartError,
  startSocketServer,
} from "./socket.ts";

/** Amendment 1 §6 exit codes for `madc-engine serve`. */
export const SERVE_EXIT = {
  OK: 0,
  USAGE_OR_HOME: 2,
  OWNED: 20,
  UNSAFE_PATH: 21,
  LISTEN_ERROR: 22,
  SHUTDOWN_DEADLINE: 23,
  INTERNAL_FAULT: 24,
  SIGINT: 130,
  SIGTERM: 143,
} as const;

export type ServeExitCode = (typeof SERVE_EXIT)[keyof typeof SERVE_EXIT];

/** Amendment 1 §3: shutdown deadline from first lifetime-ending trigger. */
export const SERVE_SHUTDOWN_DEADLINE_MS = 5_000;

/** Amendment 1 §3: max grace waiting for final stderr reason line callback. */
export const SERVE_EXIT_WRITE_GRACE_MS = 2_000;

/** Amendment 1 §3: total upper bound from first lifetime trigger until `process.exit`. */
export const SERVE_TOTAL_EXIT_BOUND_MS = 6_000;

export class LockLostError extends Error {
  readonly lockPath: string;
  constructor(lockPath: string) {
    super(`engine.lock token lost: ${lockPath}`);
    this.name = "LockLostError";
    this.lockPath = lockPath;
  }
}

export type ServeDeps = {
  readonly env?: NodeJS.ProcessEnv;
  readonly stdin?: NodeJS.ReadableStream;
  readonly stderr?: Writable;
  readonly exit?: (code: number) => void;
  readonly agent?: Agent | AgentFactory;
  readonly pid?: number;
  readonly shutdownDeadlineMs?: number;
  readonly exitWriteGraceMs?: number;
  readonly totalExitBoundMs?: number;
  readonly socketDeps?: SocketServerDeps;
  readonly installProcessHandlers?: boolean;
  readonly onListening?: (info: { readonly socketPath: string; readonly lockPath: string }) => void;
  /** Test seam: runs immediately before the §4 step 4 stale-unlink `holdsThreadLock` check. */
  readonly beforeStaleUnlinkCheck?: () => void;
  /** Test seam: runs immediately before the §4 Listen post-listen `holdsThreadLock` check. */
  readonly afterListenCheck?: () => void;
  /** Test seam: runs inside shutdown before `handle.close()` (e.g. to exercise the 5 s deadline). */
  readonly beforeClose?: () => Promise<void>;
};

function errCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

function mapSocketStartError(err: SocketStartError): { code: ServeExitCode; reason: string } {
  if (err.kind === "live") {
    return {
      code: SERVE_EXIT.OWNED,
      reason: `live listener already running: ${err.socketPath}`,
    };
  }
  if (err.kind === "listen-failed") {
    if (err.code === "EADDRINUSE") {
      return {
        code: SERVE_EXIT.OWNED,
        reason: `socket address already in use: ${err.socketPath}`,
      };
    }
    if (err.message.includes("socket path too long")) {
      return {
        code: SERVE_EXIT.LISTEN_ERROR,
        reason: `socket path too long: ${err.socketPath}`,
      };
    }
    return {
      code: SERVE_EXIT.LISTEN_ERROR,
      reason: `listen failed (${err.code ?? "error"}): ${err.socketPath}`,
    };
  }
  return {
    code: SERVE_EXIT.UNSAFE_PATH,
    reason: `${err.kind}: ${err.socketPath}`,
  };
}

/**
 * Entry point for `madc-engine serve` (amendment 1 §1–§6).
 * Intercepted in `bin.ts` before `startStdioEngine`. Never writes to stdout.
 */
export async function runServe(
  argv: readonly string[],
  deps: ServeDeps = {},
): Promise<ServeExitCode> {
  const env = deps.env ?? process.env;
  const stdin = deps.stdin ?? process.stdin;
  const stderr = deps.stderr ?? process.stderr;
  const exitFn = deps.exit ?? ((code: number) => process.exit(code));
  const installProcessHandlers = deps.installProcessHandlers ?? deps.exit === undefined;
  const shutdownDeadlineMs = deps.shutdownDeadlineMs ?? SERVE_SHUTDOWN_DEADLINE_MS;
  const exitWriteGraceMs = deps.exitWriteGraceMs ?? SERVE_EXIT_WRITE_GRACE_MS;
  const totalExitBoundMs = deps.totalExitBoundMs ?? SERVE_TOTAL_EXIT_BOUND_MS;

  const log = (line: string): void => {
    try {
      stderr.write(`[madc-engine] ${line}\n`);
    } catch {
      // Ignore stderr write errors during logging; final reason line uses its own write callback.
    }
  };

  let homePath: string | null = null;
  let lockPath: string | null = null;
  let activeSocketPath: string | null = null;
  let engineLock: LockHandle | null = null;
  let handle: SocketServerHandle | null = null;

  let startupCheckFailed = false;
  let shuttingDown = false;
  let exitStarted = false;
  let firstTriggerAtMs: number | null = null;
  type PendingTrigger = {
    readonly code: ServeExitCode;
    readonly reason: string | null;
    readonly kind: "clean" | "fatal";
  };
  const startupState: { trigger: PendingTrigger | null } = { trigger: null };

  let resolveDone!: (code: ServeExitCode) => void;
  const donePromise = new Promise<ServeExitCode>((resolve) => {
    resolveDone = resolve;
  });

  const releaseAllLocks = (): void => {
    try {
      handle?.releaseLocks();
    } catch {
      // Best-effort process-exit cleanup.
    }
    if (engineLock !== null) {
      const lk = engineLock;
      engineLock = null;
      try {
        releaseThreadLock(lk);
      } catch {
        // Best-effort process-exit cleanup.
      }
    }
  };

  // Closed stderr (EPIPE) must never surface as an uncaught exception (exit 24).
  const onStderrError = (): void => {};
  stderr.on("error", onStderrError);

  const onStdinData = (): void => {};
  const onStdinError = (): void => {
    onTrigger(SERVE_EXIT.OK, null, "clean");
  };
  const onStdinEnd = (): void => {
    onTrigger(SERVE_EXIT.OK, null, "clean");
  };
  const onSigint = (): void => {
    onTrigger(
      SERVE_EXIT.SIGINT,
      `interrupted (SIGINT): ${activeSocketPath ?? lockPath ?? homePath ?? "$MADC_HOME"}`,
      "clean",
    );
  };
  const onSigterm = (): void => {
    onTrigger(
      SERVE_EXIT.SIGTERM,
      `terminated (SIGTERM): ${activeSocketPath ?? lockPath ?? homePath ?? "$MADC_HOME"}`,
      "clean",
    );
  };
  const onFatalFault = (): void => {
    onTrigger(
      SERVE_EXIT.INTERNAL_FAULT,
      `unexpected internal fault: ${activeSocketPath ?? lockPath ?? homePath ?? "$MADC_HOME"}`,
      "fatal",
    );
  };

  const detachHandlers = (): void => {
    stdin.removeListener("data", onStdinData);
    stdin.removeListener("end", onStdinEnd);
    stdin.removeListener("error", onStdinError);
    if (installProcessHandlers) {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
      process.removeListener("uncaughtException", onFatalFault);
      process.removeListener("unhandledRejection", onFatalFault);
      process.removeListener("exit", releaseAllLocks);
    }
  };

  let shutdownTimer: ReturnType<typeof setTimeout> | null = null;

  const armShutdownDeadline = (
    code: ServeExitCode,
    reason: string | null,
    kind: "clean" | "fatal",
  ): void => {
    if (shutdownTimer !== null || exitStarted) return;
    const elapsed = firstTriggerAtMs !== null ? Date.now() - firstTriggerAtMs : 0;
    const remainingMs = Math.max(0, shutdownDeadlineMs - elapsed);
    shutdownTimer = setTimeout(() => {
      shutdownTimer = null;
      if (kind === "clean") {
        void exitServe(
          SERVE_EXIT.SHUTDOWN_DEADLINE,
          `shutdown deadline exceeded: ${activeSocketPath ?? lockPath ?? homePath ?? "$MADC_HOME"}`,
        );
      } else {
        void exitServe(code, reason);
      }
    }, remainingMs);
  };

  /**
   * Amendment 1 §3 "Explicit exit on every path": release locks, write final reason line (for
   * non-zero exits) with a write callback, and exit from that callback or when the bounded grace
   * expires — whichever comes first.
   */
  const exitServe = (code: ServeExitCode, reason: string | null): Promise<ServeExitCode> => {
    if (exitStarted) return donePromise;
    exitStarted = true;
    if (shutdownTimer !== null) {
      clearTimeout(shutdownTimer);
      shutdownTimer = null;
    }
    detachHandlers();
    releaseAllLocks();

    const graceMs =
      firstTriggerAtMs !== null
        ? Math.max(
            0,
            Math.min(exitWriteGraceMs, totalExitBoundMs - (Date.now() - firstTriggerAtMs)),
          )
        : exitWriteGraceMs;

    let exited = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (): void => {
      if (exited) return;
      exited = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      stderr.removeListener("error", onStderrError);
      resolveDone(code);
      exitFn(code);
    };

    if (code !== SERVE_EXIT.OK && reason !== null) {
      timer = setTimeout(finish, graceMs);
      try {
        stderr.write(`madc-engine serve: ${reason}\n`, () => finish());
      } catch {
        finish();
      }
    } else {
      finish();
    }
    return donePromise;
  };

  const beginShutdown = (
    code: ServeExitCode,
    reason: string | null,
    kind: "clean" | "fatal",
  ): void => {
    if (exitStarted || startupCheckFailed) return;
    if (shuttingDown) {
      if (kind === "fatal") {
        log(`fault during shutdown: ${reason ?? "unexpected fault"}`);
      }
      return;
    }
    shuttingDown = true;
    if (firstTriggerAtMs === null) firstTriggerAtMs = Date.now();
    armShutdownDeadline(code, reason, kind);

    void (async () => {
      if (deps.beforeClose !== undefined) {
        try {
          await deps.beforeClose();
        } catch (err) {
          log(`shutdown hook failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (handle !== null) {
        const h = handle;
        handle = null;
        try {
          await h.close();
        } catch (err) {
          log(`socket close failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (engineLock !== null) {
        const lk = engineLock;
        engineLock = null;
        try {
          releaseThreadLock(lk);
        } catch (err) {
          log(`engine.lock release failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (shutdownTimer !== null) {
        clearTimeout(shutdownTimer);
        shutdownTimer = null;
      }
      void exitServe(code, reason);
    })();
  };

  let startupComplete = false;

  function onTrigger(code: ServeExitCode, reason: string | null, kind: "clean" | "fatal"): void {
    if (exitStarted || startupCheckFailed) return;
    if (shuttingDown) {
      if (kind === "fatal") {
        log(`fault during shutdown: ${reason ?? "unexpected fault"}`);
      }
      return;
    }
    if (firstTriggerAtMs === null) firstTriggerAtMs = Date.now();
    // Amendment 1 §3: the 5 s shutdown deadline starts at the FIRST trigger, even during startup.
    armShutdownDeadline(code, reason, kind);
    if (!startupComplete) {
      if (startupState.trigger === null) {
        startupState.trigger = { code, reason, kind };
      }
      return;
    }
    beginShutdown(code, reason, kind);
  }

  const flushPendingStartupTrigger = (): boolean => {
    const t = startupState.trigger;
    if (t === null) return false;
    startupComplete = true;
    beginShutdown(t.code, t.reason, t.kind);
    return true;
  };

  // Install lifetime handlers before any check or async work (§3 d, §6).
  if (installProcessHandlers) {
    process.once("exit", releaseAllLocks);
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
    process.on("uncaughtException", onFatalFault);
    process.on("unhandledRejection", onFatalFault);
  }

  // §1.3: read and discard stdin; watch only for EOF.
  stdin.on("data", onStdinData);
  stdin.once("end", onStdinEnd);
  stdin.once("error", onStdinError);
  stdin.resume();

  // --- §6 Startup precedence: args -> home -> engine.lock -> §4 steps 1-4 -> listen -> step 5 ---

  // 1. Args
  if (argv.length > 0) {
    startupCheckFailed = true;
    return exitServe(SERVE_EXIT.USAGE_OR_HOME, "serve takes no arguments: $MADC_HOME");
  }

  // 2. Home
  try {
    homePath = resolveMadcHome(env);
  } catch (err) {
    startupCheckFailed = true;
    const msg = err instanceof Error ? err.message : "MADC_HOME must be an absolute path";
    return exitServe(SERVE_EXIT.USAGE_OR_HOME, `${msg}: $MADC_HOME`);
  }

  try {
    mkdirSync(homePath, { recursive: true, mode: 0o700 });
    enforcePrivateDir(homePath);
  } catch (err) {
    startupCheckFailed = true;
    return exitServe(
      SERVE_EXIT.USAGE_OR_HOME,
      `home directory unusable (${errCode(err) ?? "error"}): ${homePath}`,
    );
  }

  if (flushPendingStartupTrigger()) return donePromise;

  // 3. engine.lock (§2a)
  lockPath = engineLockPath(homePath);
  try {
    const acq = acquireLockAt(homePath, lockPath, deps.pid ?? process.pid);
    if (!acq.ok) {
      startupCheckFailed = true;
      if (acq.holderPid !== null) {
        // Exact pinned format (§2a line 66): names holder pid and lock path; never prints token.
        return exitServe(SERVE_EXIT.OWNED, `home owned by pid ${acq.holderPid}: ${lockPath}`);
      }
      return exitServe(SERVE_EXIT.OWNED, `engine.lock acquisition exhausted: ${lockPath}`);
    }
    engineLock = acq.handle;
  } catch (err) {
    startupCheckFailed = true;
    if (err instanceof LockPathNotAFileError) {
      return exitServe(
        SERVE_EXIT.UNSAFE_PATH,
        `engine.lock path is not a regular file: ${lockPath}`,
      );
    }
    return exitServe(
      SERVE_EXIT.UNSAFE_PATH,
      `engine.lock I/O error (${errCode(err) ?? "error"}): ${lockPath}`,
    );
  }

  if (flushPendingStartupTrigger()) return donePromise;

  // 4. Load policy + build agent
  const loadedPolicy = loadRepoPolicy(homePath);
  for (const { issue } of loadedPolicy.fileIssues) {
    log(`policy.json: ${issue}; repo-gated providers deny every repository`);
  }
  for (const entry of loadedPolicy.rejected) {
    const where = entry.index === null ? entry.providerId : `${entry.providerId}[${entry.index}]`;
    log(`policy.json: ${where} rejected (${entry.issue}); it grants nothing`);
  }
  if (loadedPolicy.permissiveMode !== null) {
    log(`policy.json: mode ${loadedPolicy.permissiveMode} is more permissive than the pinned 0600`);
  }
  const repoPolicy = loadedPolicy.policy;

  let resolvedAgent: Agent;
  try {
    const factoryOrAgent = deps.agent ?? defaultAgentFactory;
    resolvedAgent =
      typeof factoryOrAgent === "function"
        ? await factoryOrAgent({ home: homePath, repoPolicy })
        : factoryOrAgent;
  } catch {
    if (flushPendingStartupTrigger()) return donePromise;
    startupCheckFailed = true;
    return exitServe(SERVE_EXIT.INTERNAL_FAULT, `unexpected internal fault: ${homePath}`);
  }

  if (flushPendingStartupTrigger()) return donePromise;

  // 5. Socket bind (§4 steps 1-5 + both engine.lock re-verifications)
  const expectedSocketPath = engineSocketPath(homePath);
  const currentLockPath = lockPath;
  const assertStillHoldingLock = (hook?: () => void): void => {
    hook?.();
    if (engineLock === null || !holdsThreadLock(engineLock)) {
      throw new LockLostError(currentLockPath);
    }
  };

  try {
    handle = await startSocketServer({
      home: homePath,
      repoPolicy,
      agent: resolvedAgent,
      log,
      onServerError: (err) => {
        onTrigger(
          SERVE_EXIT.LISTEN_ERROR,
          `fatal listener error (${errCode(err) ?? "error"}): ${activeSocketPath ?? expectedSocketPath}`,
          "fatal",
        );
      },
      socketDeps: {
        ...deps.socketDeps,
        beforeStaleUnlink: () => {
          deps.socketDeps?.beforeStaleUnlink?.();
          assertStillHoldingLock(deps.beforeStaleUnlinkCheck);
        },
        afterListen: () => {
          deps.socketDeps?.afterListen?.();
          assertStillHoldingLock(deps.afterListenCheck);
        },
      },
    });
    activeSocketPath = handle.socketPath;
  } catch (err) {
    if (flushPendingStartupTrigger()) return donePromise;
    startupCheckFailed = true;
    if (err instanceof LockLostError) {
      return exitServe(SERVE_EXIT.OWNED, `engine.lock token lost: ${err.lockPath}`);
    }
    if (err instanceof SocketStartError) {
      const mapped = mapSocketStartError(err);
      return exitServe(mapped.code, mapped.reason);
    }
    return exitServe(SERVE_EXIT.INTERNAL_FAULT, `unexpected internal fault: ${expectedSocketPath}`);
  }

  startupComplete = true;
  if (flushPendingStartupTrigger()) return donePromise;

  // If stdin ended before our listener attached (e.g., already ended stream), shut down now.
  if ("readableEnded" in stdin && (stdin as { readableEnded?: boolean }).readableEnded) {
    beginShutdown(SERVE_EXIT.OK, null, "clean");
    return donePromise;
  }

  deps.onListening?.({ socketPath: activeSocketPath, lockPath: currentLockPath });
  return donePromise;
}
