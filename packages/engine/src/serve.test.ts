/**
 * M3-A2 (`docs/plan/PIN-madc-M3-desktop-protocol-amendment-1.md`):
 * - §2a `acquireLockAt` and `$MADC_HOME/engine.lock` (all existing lock tests + mutation IDs)
 * - §1, §3, §4, §6 `madc-engine serve` exit codes (0/2/20/21/22/23/24/130/143), precedence,
 *   stderr reason line contract, slow stderr >64 KiB flush, closed stderr EPIPE, and token-lost
 *   re-verify (`afterListen`).
 *
 * Note: tests requiring `node:net` (stale-socket `beforeStaleUnlink` token-lost and live socket
 * client connection to `madc-engine serve`) live in `socket-search.test.ts` so `honesty.test.ts`'s
 * `LOCAL_SOCKET_FILES` guard remains narrow and untouched.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { echoAgent } from "./agent.ts";
import {
  acquireLockAt,
  acquireThreadLock,
  engineLockPath,
  holdsThreadLock,
  isPidAlive,
  LOCK_TOKEN_PATTERN,
  LockPathNotAFileError,
  readLock,
  reclaimIfUnchanged,
  releaseThreadLock,
} from "./lock.ts";
import { runServe, SERVE_EXIT } from "./serve.ts";
import { engineSocketPath } from "./socket.ts";
import { makeHome } from "./testing/harness.ts";

const POSIX = process.platform !== "win32";
const ENGINE_BIN = fileURLToPath(new URL("./bin.ts", import.meta.url));
const SERVE_MODULE = fileURLToPath(new URL("./serve.ts", import.meta.url));

const TOKEN_A = "a".repeat(32);
const TOKEN_B = "b".repeat(32);

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) fn();
  }
});

function trackedHome(): string {
  const { home, cleanup } = makeHome();
  cleanups.push(cleanup);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return home;
}

async function deadPid(): Promise<number> {
  const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = dead.pid ?? 0;
  await new Promise((r) => dead.once("exit", r));
  assert.equal(isPidAlive(pid), false);
  return pid;
}

function liveHolder() {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  cleanups.push(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already exited.
    }
  });
  return child;
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out after ${ms}ms waiting for ${what}`)),
      ms,
    );
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function waitFor(cond: () => boolean, ms: number, what: string): Promise<void> {
  return withTimeout(
    new Promise<void>((resolve) => {
      const tick = (): void => {
        if (cond()) resolve();
        else setTimeout(tick, 10);
      };
      tick();
    }),
    ms,
    what,
  );
}

function captureStream(): { stream: PassThrough; text: () => string } {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer | string) => {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
  });
  return {
    stream,
    text: () => Buffer.concat(chunks).toString("utf8"),
  };
}

// ===================================================================== §2a engine.lock test suite

test("engine.lock M3A2-L1: acquireLockAt refuses paths outside/equal to MADC_HOME or escaping via symlinked parent", () => {
  const home = trackedHome();
  const outside = join(home, "..", "escape.lock");
  assert.throws(() => acquireLockAt(home, outside), /escapes MADC_HOME/);
  assert.throws(() => acquireLockAt(home, home), /escapes MADC_HOME/);
  assert.equal(existsSync(outside), false, "rejected before touching disk");

  if (POSIX) {
    const outsideDir = `${home}-outside-dir`;
    cleanups.push(() => rmSync(outsideDir, { recursive: true, force: true }));
    mkdirSync(outsideDir, { recursive: true, mode: 0o700 });
    const symSub = join(home, "sub-sym");
    symlinkSync(outsideDir, symSub);
    assert.throws(() => acquireLockAt(home, join(symSub, "engine.lock")), /escapes MADC_HOME/);
    assert.equal(existsSync(join(outsideDir, "engine.lock")), false);
  }
});

test("engine.lock M3A2-L2: body is {pid,startedAt,token}; token 32 hex fresh per acquire; acquireThreadLock delegates unchanged", () => {
  const home = trackedHome();
  const lockPath = engineLockPath(home);
  const tokens = new Set<string>();
  for (let i = 0; i < 3; i++) {
    const res = acquireLockAt(home, lockPath);
    assert.equal(res.ok, true);
    if (!res.ok) return;
    const body = JSON.parse(readFileSync(res.path, "utf8")) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ["pid", "startedAt", "token"]);
    assert.equal(body.pid, process.pid);
    assert.equal(typeof body.startedAt, "number");
    assert.match(String(body.token), LOCK_TOKEN_PATTERN);
    assert.equal(body.token, res.handle.token);
    tokens.add(String(body.token));
    assert.equal(releaseThreadLock(res.handle), true);
  }
  assert.equal(tokens.size, 3, "token never reused");

  // acquireThreadLock still works unchanged via delegation.
  const tLock = acquireThreadLock(home, "thr_delegate");
  assert.equal(tLock.ok, true);
  if (tLock.ok) {
    assert.equal(holdsThreadLock(tLock.handle), true);
    assert.equal(releaseThreadLock(tLock.handle), true);
  }
});

test("engine.lock M3A2-L3: live foreign holder refused with holderPid; release requires exact token", async () => {
  const home = trackedHome();
  const holder = liveHolder();
  const holderPid = holder.pid ?? 0;
  const lockPath = engineLockPath(home);

  const mine = acquireLockAt(home, lockPath, holderPid);
  assert.equal(mine.ok, true);
  if (!mine.ok) return;

  const other = acquireLockAt(home, lockPath);
  assert.deepEqual(other, { ok: false, path: mine.path, holderPid });
  assert.equal(holdsThreadLock(mine.handle), true);
  assert.equal(releaseThreadLock({ ...mine.handle, token: TOKEN_A }), false);
  assert.equal(holdsThreadLock(mine.handle), true);
  assert.equal(releaseThreadLock(mine.handle), true);
  assert.equal(readLock(mine.path).state, "missing");
});

test("engine.lock M3A2-L4: same pid + same startedAt, different token — stale handle never releases or steals", () => {
  const home = trackedHome();
  const lockPath = engineLockPath(home);
  const first = acquireLockAt(home, lockPath);
  assert.equal(first.ok, true);
  if (!first.ok) return;

  const replacement = { pid: process.pid, startedAt: first.handle.startedAt, token: TOKEN_B };
  unlinkSync(first.path);
  writeFileSync(first.path, JSON.stringify(replacement));
  assert.equal(holdsThreadLock(first.handle), false);
  assert.equal(releaseThreadLock(first.handle), false);
  assert.deepEqual(JSON.parse(readFileSync(first.path, "utf8")), replacement);

  const again = acquireLockAt(home, lockPath);
  assert.deepEqual(again, { ok: false, path: first.path, holderPid: process.pid });
});

test("engine.lock M3A2-L5: reclaim dead/corrupt/legacy bodies; never delete a lock whose token changed", async () => {
  const home = trackedHome();
  const lockPath = engineLockPath(home);
  const holder = liveHolder();

  // Live pid with missing/invalid token → locked, left untouched.
  for (const body of [
    { pid: holder.pid, startedAt: 1 },
    { pid: holder.pid, startedAt: 1, token: "NOT-HEX" },
  ]) {
    writeFileSync(lockPath, JSON.stringify(body));
    const res = acquireLockAt(home, lockPath);
    assert.deepEqual(res, { ok: false, path: lockPath, holderPid: holder.pid });
  }

  // Dead pid: changed token restored, unchanged reclaimed.
  const pid = await deadPid();
  writeFileSync(lockPath, JSON.stringify({ pid, startedAt: 7, token: TOKEN_A }));
  const observed = readLock(lockPath);
  assert.equal(observed.state, "held");
  if (observed.state !== "held") return;
  const changed = { pid, startedAt: 7, token: TOKEN_B };
  writeFileSync(lockPath, JSON.stringify(changed));
  assert.deepEqual(reclaimIfUnchanged(lockPath, observed.fingerprint, "c".repeat(32)), {
    outcome: "restored",
    holderPid: pid,
  });
  assert.deepEqual(JSON.parse(readFileSync(lockPath, "utf8")), changed);

  const acq = acquireLockAt(home, lockPath);
  assert.equal(acq.ok, true);
  if (acq.ok) releaseThreadLock(acq.handle);

  // Corrupt body reclaimed.
  writeFileSync(lockPath, "not-json");
  const acq2 = acquireLockAt(home, lockPath);
  assert.equal(acq2.ok, true);
  if (acq2.ok) releaseThreadLock(acq2.handle);
});

test("engine.lock M3A2-L6: three-engine reclaim race leaves displaced lock aside and displaced holder loses holdsThreadLock", async () => {
  const home = trackedHome();
  const lockPath = engineLockPath(home);
  const pid = await deadPid();

  // R2 observes a dead lock.
  writeFileSync(lockPath, JSON.stringify({ pid, startedAt: 1, token: TOKEN_A }));
  const r2Observed = readLock(lockPath);
  assert.equal(r2Observed.state, "held");
  if (r2Observed.state !== "held") return;

  // R1 reclaims dead lock and acquires a live lock.
  const r1 = acquireLockAt(home, lockPath);
  assert.equal(r1.ok, true);
  if (!r1.ok) return;

  // R2 renames R1's live lock aside; before link-back, R3 acquires at the path.
  let r3Handle: { path: string; pid: number; startedAt: number; token: string } | null = null;
  const r2Token = "d".repeat(32);
  const outcome = reclaimIfUnchanged(lockPath, r2Observed.fingerprint, r2Token, {
    afterRename: () => {
      const r3 = acquireLockAt(home, lockPath);
      assert.equal(r3.ok, true);
      if (r3.ok) r3Handle = r3.handle;
    },
  });
  assert.equal(outcome.outcome, "restored");
  // R1's lock is preserved at engine.lock.reclaim-<r2Token> (not deleted), R3 holds engine.lock.
  assert.ok(
    readdirSync(home).includes(`engine.lock.reclaim-${r2Token}`),
    "displaced lock preserved at aside path",
  );
  assert.equal(holdsThreadLock(r1.handle), false, "displaced holder sees token lost");
  assert.equal(releaseThreadLock(r1.handle), false, "displaced holder never removes R3's lock");
  assert.ok(r3Handle !== null && holdsThreadLock(r3Handle), "R3 still holds engine.lock");
  if (r3Handle !== null) assert.equal(releaseThreadLock(r3Handle), true);
});

if (!POSIX) {
  test.skip(
    "engine.lock M3A2-L7: symlink at engine.lock is never followed, treated as corrupt and reclaimed leaving target intact",
  );
} else {
  test("engine.lock M3A2-L7: symlink at engine.lock is never followed, treated as corrupt and reclaimed leaving target intact", () => {
    const home = trackedHome();
    const lockPath = engineLockPath(home);
    const target = `${home}-sym-target.json`;
    cleanups.push(() => rmSync(target, { force: true }));
    writeFileSync(target, JSON.stringify({ pid: process.pid, startedAt: 1, token: TOKEN_A }));
    symlinkSync(target, lockPath);

    assert.equal(readLock(lockPath).state, "corrupt");
    assert.equal(
      releaseThreadLock({ path: lockPath, pid: process.pid, startedAt: 1, token: TOKEN_A }),
      false,
    );
    assert.equal(
      holdsThreadLock({ path: lockPath, pid: process.pid, startedAt: 1, token: TOKEN_A }),
      false,
    );
    const acq = acquireLockAt(home, lockPath);
    assert.equal(acq.ok, true);
    assert.equal(existsSync(target), true, "symlink target untouched");
    if (acq.ok) releaseThreadLock(acq.handle);
  });
}

test("engine.lock M3A2-L8: directory or FIFO at engine.lock throws LockPathNotAFileError without blocking", () => {
  const home = trackedHome();
  const lockPath = engineLockPath(home);
  mkdirSync(lockPath);
  assert.throws(() => acquireLockAt(home, lockPath), LockPathNotAFileError);
  rmSync(lockPath, { recursive: true });

  if (POSIX) {
    try {
      execFileSync("mkfifo", [lockPath]);
    } catch {
      return; // mkfifo unavailable
    }
    assert.throws(() => acquireLockAt(home, lockPath), LockPathNotAFileError);
  }
});

test("engine.lock M3A2-L9: release re-checks dev+ino before unlink (beforeUnlink swap survives)", () => {
  const home = trackedHome();
  const lockPath = engineLockPath(home);
  const mine = acquireLockAt(home, lockPath);
  assert.equal(mine.ok, true);
  if (!mine.ok) return;
  const original = readFileSync(mine.path, "utf8");
  const released = releaseThreadLock(mine.handle, {
    beforeUnlink: () => {
      unlinkSync(mine.path);
      writeFileSync(mine.path, original);
    },
  });
  assert.equal(released, false);
  assert.equal(readFileSync(mine.path, "utf8"), original);
});

// ===================================================================== §1 / §3 / §6 madc-engine serve

test("serve exit 2: extra arguments, relative MADC_HOME (no echo), and unusable home file", async () => {
  const home = trackedHome();

  // Extra argument (never echoed).
  {
    const err = captureStream();
    const stdin = new PassThrough();
    let exitCode: number | null = null;
    const code = await runServe(["secret-arg-do-not-echo"], {
      env: { MADC_HOME: home },
      stdin,
      stderr: err.stream,
      exit: (c) => {
        exitCode = c;
      },
      agent: echoAgent,
    });
    assert.equal(code, SERVE_EXIT.USAGE_OR_HOME);
    assert.equal(exitCode, 2);
    assert.match(err.text(), /^madc-engine serve: serve takes no arguments:/m);
    assert.equal(err.text().includes("secret-arg-do-not-echo"), false);
  }

  // Relative MADC_HOME (does not echo rejected value).
  {
    const err = captureStream();
    const stdin = new PassThrough();
    let exitCode: number | null = null;
    const code = await runServe([], {
      env: { MADC_HOME: "relative/secret-home" },
      stdin,
      stderr: err.stream,
      exit: (c) => {
        exitCode = c;
      },
      agent: echoAgent,
    });
    assert.equal(code, SERVE_EXIT.USAGE_OR_HOME);
    assert.equal(exitCode, 2);
    assert.match(err.text(), /^madc-engine serve: MADC_HOME must be an absolute path:/m);
    assert.equal(err.text().includes("relative/secret-home"), false);
  }

  // Unusable home (regular file at MADC_HOME).
  {
    const fileHome = join(home, "not-a-dir");
    writeFileSync(fileHome, "x");
    const err = captureStream();
    const stdin = new PassThrough();
    let exitCode: number | null = null;
    const code = await runServe([], {
      env: { MADC_HOME: fileHome },
      stdin,
      stderr: err.stream,
      exit: (c) => {
        exitCode = c;
      },
      agent: echoAgent,
    });
    assert.equal(code, SERVE_EXIT.USAGE_OR_HOME);
    assert.equal(exitCode, 2);
    assert.match(err.text(), /^madc-engine serve: home directory unusable/m);
  }
});

test("serve exit 20: live engine.lock holder names pid and lock path, never prints lock token", async () => {
  const home = trackedHome();
  const holder = liveHolder();
  const holderPid = holder.pid ?? 0;
  const lockPath = engineLockPath(home);
  const acq = acquireLockAt(home, lockPath, holderPid);
  assert.equal(acq.ok, true);
  if (!acq.ok) return;

  const err = captureStream();
  const stdin = new PassThrough();
  let exitCode: number | null = null;
  const code = await runServe([], {
    env: { MADC_HOME: home },
    stdin,
    stderr: err.stream,
    exit: (c) => {
      exitCode = c;
    },
    agent: echoAgent,
  });
  assert.equal(code, SERVE_EXIT.OWNED);
  assert.equal(exitCode, 20);
  const stderrText = err.text();
  assert.equal(stderrText.trim(), `madc-engine serve: home owned by pid ${holderPid}: ${lockPath}`);
  assert.equal(stderrText.includes(acq.handle.token), false, "lock token never logged");
  releaseThreadLock(acq.handle);
});

test("serve exit 20 (M3A2-S2): engine.lock token lost straight after listen -> exit 20, no engine.sock left", async () => {
  const home = trackedHome();
  const lockPath = engineLockPath(home);
  const sockPath = engineSocketPath(home);
  const err = captureStream();
  const stdin = new PassThrough();
  let exitCode: number | null = null;

  const runPromise = runServe([], {
    env: { MADC_HOME: home },
    stdin,
    stderr: err.stream,
    exit: (c) => {
      exitCode = c;
    },
    agent: echoAgent,
    afterListenCheck: () => {
      // Simulate another engine displacing engine.lock right after listen().
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: 1, token: TOKEN_B }));
    },
  });

  try {
    const code = await withTimeout(runPromise, 5000, "M3A2-S2 token lost after listen");
    assert.equal(code, SERVE_EXIT.OWNED);
    assert.equal(exitCode, 20);
    assert.match(err.text(), /^madc-engine serve: engine\.lock token lost:/m);
    assert.equal(existsSync(sockPath), false, "bound socket unlinked when token lost after listen");
  } finally {
    // Always close stdin and wait briefly for any unexpectedly bound listener to shut down so
    // a failing run (e.g. mutant skipping afterListen re-verify) never hangs the test runner.
    stdin.end();
    await withTimeout(runPromise, 2000, "M3A2-S2 cleanup").catch(() => {});
  }
});

test("serve exit 21: non-regular engine.lock (dir), symlink/file at engine.sock, and chmod failure", async () => {
  // 1. Directory at engine.lock
  {
    const home = trackedHome();
    mkdirSync(engineLockPath(home));
    const err = captureStream();
    const stdin = new PassThrough();
    const code = await runServe([], {
      env: { MADC_HOME: home },
      stdin,
      stderr: err.stream,
      exit: () => {},
      agent: echoAgent,
    });
    assert.equal(code, SERVE_EXIT.UNSAFE_PATH);
    assert.match(err.text(), /^madc-engine serve: engine\.lock path is not a regular file:/m);
  }

  // 2. Regular file at engine.sock (must not unlink, engine.lock released)
  if (POSIX) {
    const home = trackedHome();
    const sockPath = engineSocketPath(home);
    writeFileSync(sockPath, "keep-me");
    const err = captureStream();
    const stdin = new PassThrough();
    const code = await runServe([], {
      env: { MADC_HOME: home },
      stdin,
      stderr: err.stream,
      exit: () => {},
      agent: echoAgent,
    });
    assert.equal(code, SERVE_EXIT.UNSAFE_PATH);
    assert.match(err.text(), /^madc-engine serve: not-socket:/m);
    assert.equal(readFileSync(sockPath, "utf8"), "keep-me");
    assert.equal(existsSync(engineLockPath(home)), false, "engine.lock released on refusal");
  }

  // 3. Symlink at engine.sock
  if (POSIX) {
    const home = trackedHome();
    const sockPath = engineSocketPath(home);
    symlinkSync("/tmp/nonexistent-serve-sym", sockPath);
    const err = captureStream();
    const stdin = new PassThrough();
    const code = await runServe([], {
      env: { MADC_HOME: home },
      stdin,
      stderr: err.stream,
      exit: () => {},
      agent: echoAgent,
    });
    assert.equal(code, SERVE_EXIT.UNSAFE_PATH);
    assert.match(err.text(), /^madc-engine serve: symlink:/m);
    assert.equal(existsSync(engineLockPath(home)), false);
  }

  // 4. chmod failure fails closed
  if (POSIX) {
    const home = trackedHome();
    const err = captureStream();
    const stdin = new PassThrough();
    const code = await runServe([], {
      env: { MADC_HOME: home },
      stdin,
      stderr: err.stream,
      exit: () => {},
      agent: echoAgent,
      socketDeps: {
        chmod: () => {
          throw new Error("EPERM injected");
        },
      },
    });
    assert.equal(code, SERVE_EXIT.UNSAFE_PATH);
    assert.match(err.text(), /^madc-engine serve: chmod-failed:/m);
    assert.equal(existsSync(engineSocketPath(home)), false);
    assert.equal(existsSync(engineLockPath(home)), false);
  }
});

if (!POSIX) {
  test.skip("serve exit 22: socket path too long (pre-listen sun_path check)");
} else {
  test("serve exit 22: socket path too long (pre-listen sun_path check)", async () => {
    const base = trackedHome();
    const longHome = join(base, "a".repeat(120));
    const err = captureStream();
    const stdin = new PassThrough();
    const runPromise = runServe([], {
      env: { MADC_HOME: longHome },
      stdin,
      stderr: err.stream,
      exit: () => {},
      agent: echoAgent,
    });
    try {
      const code = await withTimeout(runPromise, 5000, "serve exit 22 path too long");
      assert.equal(code, SERVE_EXIT.LISTEN_ERROR);
      assert.match(err.text(), /^madc-engine serve: socket path too long:/m);
      assert.equal(existsSync(engineLockPath(longHome)), false, "engine.lock released");
    } finally {
      stdin.end();
      await withTimeout(runPromise, 2000, "serve exit 22 cleanup").catch(() => {});
    }
  });
}

test("serve exit 23: clean trigger whose shutdown exceeds deadline exits 23 and releases engine.lock", async () => {
  const home = trackedHome();
  const err = captureStream();
  const stdin = new PassThrough();
  let exitCode: number | null = null;
  let releaseBlocker!: () => void;
  const blocker = new Promise<void>((r) => {
    releaseBlocker = r;
  });

  const runPromise = runServe([], {
    env: { MADC_HOME: home },
    stdin,
    stderr: err.stream,
    exit: (c) => {
      exitCode = c;
    },
    agent: echoAgent,
    shutdownDeadlineMs: 80,
    exitWriteGraceMs: 200,
    totalExitBoundMs: 500,
    beforeClose: () => blocker,
    onListening: () => {
      stdin.end();
    },
  });

  try {
    const code = await withTimeout(runPromise, 2000, "serve exit 23");
    assert.equal(code, SERVE_EXIT.SHUTDOWN_DEADLINE);
    assert.equal(exitCode, 23);
    assert.match(err.text(), /^madc-engine serve: shutdown deadline exceeded:/m);
    assert.equal(existsSync(engineLockPath(home)), false, "engine.lock released on deadline exit");
  } finally {
    releaseBlocker();
    stdin.end();
    await withTimeout(runPromise, 2000, "serve exit 23 cleanup").catch(() => {});
  }
});

test("serve exit 23 (Argus #76 M1): trigger during slow startup does not restart shutdown deadline", async () => {
  const home = trackedHome();
  const err = captureStream();
  const stdin = new PassThrough();
  let triggerAt = 0;
  let exitAt = 0;
  let releaseBlocker!: () => void;
  const blocker = new Promise<void>((r) => {
    releaseBlocker = r;
  });

  // Agent triggers EOF immediately, then takes 300 ms before returning, and beforeClose hangs.
  // With shutdownDeadlineMs = 500, resetting the timer after the 300 ms startup step would exit at
  // >= 800 ms; counting from the first trigger exits at ~500 ms (< 700 ms).
  const runPromise = runServe([], {
    env: { MADC_HOME: home },
    stdin,
    stderr: err.stream,
    exit: () => {
      exitAt = Date.now();
    },
    agent: async () => {
      triggerAt = Date.now();
      stdin.end();
      await new Promise((r) => setTimeout(r, 300));
      return echoAgent;
    },
    shutdownDeadlineMs: 500,
    exitWriteGraceMs: 150,
    totalExitBoundMs: 700,
    beforeClose: () => blocker,
  });

  try {
    const code = await withTimeout(runPromise, 2000, "startup-trigger deadline exit 23");
    const elapsed = exitAt - triggerAt;
    assert.equal(code, SERVE_EXIT.SHUTDOWN_DEADLINE);
    assert.ok(
      elapsed < 700,
      `expected exit within 700ms of first startup trigger (500ms deadline, not reset after 300ms), got ${elapsed}ms`,
    );
    assert.equal(existsSync(engineLockPath(home)), false, "engine.lock released on deadline exit");
  } finally {
    releaseBlocker();
    stdin.end();
    await withTimeout(runPromise, 2000, "Argus #76 M1 cleanup").catch(() => {});
  }
});

test("serve exit 24: unexpected startup fault exits 24 with no stack trace and releases engine.lock", async () => {
  const home = trackedHome();
  const err = captureStream();
  const stdin = new PassThrough();
  let exitCode: number | null = null;
  const code = await runServe([], {
    env: { MADC_HOME: home },
    stdin,
    stderr: err.stream,
    exit: (c) => {
      exitCode = c;
    },
    agent: () => {
      throw new Error("boom secret-internal-detail");
    },
  });
  assert.equal(code, SERVE_EXIT.INTERNAL_FAULT);
  assert.equal(exitCode, 24);
  const out = err.text();
  assert.match(out, /^madc-engine serve: unexpected internal fault:/m);
  assert.equal(out.includes("secret-internal-detail"), false, "no raw error or stack trace");
  assert.equal(out.includes("\n    at "), false, "no stack trace");
  assert.equal(existsSync(engineLockPath(home)), false);
});

test("serve subprocess: stdin EOF (0), SIGINT (130), SIGTERM (143), stdout stays empty, stdin bytes discarded", async () => {
  // 1. Immediate EOF (</dev/null) -> exit 0, empty stdout, locks & socket cleaned up.
  {
    const home = trackedHome();
    const child = spawn(process.execPath, [ENGINE_BIN, "serve"], {
      env: { ...process.env, MADC_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    const code = await withTimeout(
      new Promise<number | null>((r) => child.once("exit", (c) => r(c))),
      5000,
      "immediate EOF serve exit",
    );
    assert.equal(code, 0, stderr);
    assert.equal(stdout, "", "serve never writes stdout");
    assert.equal(existsSync(engineLockPath(home)), false);
    assert.equal(existsSync(engineSocketPath(home)), false);
  }

  // 2. Running serve: discards stdin bytes, closes cleanly on EOF -> exit 0.
  {
    const home = trackedHome();
    const sockPath = engineSocketPath(home);
    const child = spawn(process.execPath, [ENGINE_BIN, "serve"], {
      env: { ...process.env, MADC_HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
    });
    cleanups.push(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already exited.
      }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    await waitFor(() => existsSync(sockPath), 4000, "serve socket bind");
    // Send arbitrary bytes to stdin — serve discards them without parsing JSONL.
    child.stdin.write("not json at all\n{}\n");
    child.stdin.end();
    const code = await withTimeout(
      new Promise<number | null>((r) => child.once("exit", (c) => r(c))),
      5000,
      "EOF serve exit",
    );
    assert.equal(code, 0, stderr);
    assert.equal(stdout, "");
    assert.equal(existsSync(engineLockPath(home)), false);
    assert.equal(existsSync(sockPath), false);
  }

  // 3. SIGINT -> 130 and SIGTERM -> 143 (POSIX).
  if (POSIX) {
    for (const [sig, expected] of [
      ["SIGINT", 130],
      ["SIGTERM", 143],
    ] as const) {
      const home = trackedHome();
      const sockPath = engineSocketPath(home);
      const child = spawn(process.execPath, [ENGINE_BIN, "serve"], {
        env: { ...process.env, MADC_HOME: home },
        stdio: ["pipe", "pipe", "pipe"],
      });
      cleanups.push(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already exited.
        }
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => {
        stdout += String(d);
      });
      child.stderr.on("data", (d) => {
        stderr += String(d);
      });
      await waitFor(() => existsSync(sockPath), 4000, `serve socket bind (${sig})`);
      child.kill(sig);
      const code = await withTimeout(
        new Promise<number | null>((r) => child.once("exit", (c) => r(c))),
        5000,
        `${sig} serve exit`,
      );
      assert.equal(code, expected, stderr);
      assert.equal(stdout, "");
      assert.match(stderr, new RegExp(`madc-engine serve: .*${sig}`));
      assert.equal(existsSync(engineLockPath(home)), false);
      assert.equal(existsSync(sockPath), false);
    }
  }
});

if (!POSIX) {
  test.skip(
    "serve §3 required test: slow stderr reader (>64 KiB unread) still receives final reason line",
  );
} else {
  test("serve §3 required test: slow stderr reader (>64 KiB unread) still receives final reason line", async () => {
    const home = trackedHome();
    const holder = liveHolder();
    const holderPid = holder.pid ?? 0;
    const lockPath = engineLockPath(home);
    const acq = acquireLockAt(home, lockPath, holderPid);
    assert.equal(acq.ok, true);
    if (!acq.ok) return;

    // Subprocess writes 200 KiB of stderr logs before running runServe([], ...) which hits exit 20.
    // A separate reader process (`sleep 0.3; cat`) reads from a real OS pipe so >64 KiB sits unread
    // in the kernel pipe buffer before draining (avoids Bun 1.3.11 in-process pause/resume bug,
    // amendment 1 §3 step 3 test note & `exitflush.log` shellpipe method).
    const driverPath = `${home}-slow-stderr.ts`;
    const codeFile = `${home}-slow-stderr.code`;
    cleanups.push(() => rmSync(driverPath, { force: true }));
    cleanups.push(() => rmSync(codeFile, { force: true }));
    writeFileSync(
      driverPath,
      `import { runServe } from ${JSON.stringify(SERVE_MODULE)};\nprocess.stderr.write("x".repeat(200000) + "\\n");\nawait runServe([]);\n`,
    );
    const child = spawn(
      "sh",
      [
        "-c",
        '( "$1" "$2" 2>&1 1>/dev/null; echo $? > "$3" ) | ( sleep 0.3; cat )',
        "--",
        process.execPath,
        driverPath,
        codeFile,
      ],
      {
        env: { ...process.env, MADC_HOME: home },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    cleanups.push(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already exited.
      }
    });

    const chunks: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    const exitPromise = new Promise<number | null>((r) => child.once("exit", (c) => r(c)));
    const endPromise = new Promise<void>((r) => child.stdout.once("end", () => r()));

    await withTimeout(Promise.all([exitPromise, endPromise]), 5000, "slow stderr serve exit");

    const code = Number(readFileSync(codeFile, "utf8").trim());
    const stderrText = Buffer.concat(chunks).toString("utf8");
    assert.equal(code, 20);
    assert.ok(stderrText.length > 200_000, `expected >200000 bytes, got ${stderrText.length}`);
    assert.ok(
      stderrText.includes(`madc-engine serve: home owned by pid ${holderPid}: ${lockPath}`),
      "final reason line survived >64 KiB slow stderr pipe",
    );
    releaseThreadLock(acq.handle);
  });
}

test("serve §3 EPIPE: closed stderr reader still exits with intended code 20 (never 24 or hang)", async () => {
  const home = trackedHome();
  const holder = liveHolder();
  const holderPid = holder.pid ?? 0;
  const lockPath = engineLockPath(home);
  const acq = acquireLockAt(home, lockPath, holderPid);
  assert.equal(acq.ok, true);
  if (!acq.ok) return;

  const child = spawn(process.execPath, [ENGINE_BIN, "serve"], {
    env: { ...process.env, MADC_HOME: home },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.destroy();
  const code = await withTimeout(
    new Promise<number | null>((r) => child.once("exit", (c) => r(c))),
    5000,
    "EPIPE stderr serve exit",
  );
  assert.equal(code, 20);
  releaseThreadLock(acq.handle);
});

// ===================================================================== M3-A2 hardening & §6 matrix

test("serve constants (M3A2-L4): SERVE_EXIT is frozen against mutation", () => {
  assert.equal(Object.isFrozen(SERVE_EXIT), true);
  assert.throws(() => {
    (SERVE_EXIT as Record<string, number>).OK = 99;
  }, TypeError);
});

test("engine.lock parity (M3A2-L5): acquireThreadLock matches pre-delegation outcomes across all edge cases", async () => {
  const home = trackedHome();
  // Invalid threadId throws -32602 before touching sessions/.
  assert.throws(
    () => acquireThreadLock(home, "../escape"),
    (err: unknown) => (err as { code?: number }).code === -32602,
  );
  assert.equal(existsSync(join(home, "sessions")), false);

  // Valid acquire, live holder refusal, holds/release.
  const first = acquireThreadLock(home, "thr_parity_1");
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(holdsThreadLock(first.handle), true);
  const dup = acquireThreadLock(home, "thr_parity_1");
  assert.deepEqual(dup, { ok: false, path: first.path, holderPid: process.pid });
  assert.equal(releaseThreadLock(first.handle), true);
  assert.equal(holdsThreadLock(first.handle), false);

  // Dead holder reclaimed.
  const dead = await deadPid();
  writeFileSync(first.path, JSON.stringify({ pid: dead, startedAt: 1, token: TOKEN_A }));
  const reclaimed = acquireThreadLock(home, "thr_parity_1");
  assert.equal(reclaimed.ok, true);
  if (reclaimed.ok) assert.equal(releaseThreadLock(reclaimed.handle), true);

  // Non-regular lock path throws LockPathNotAFileError.
  mkdirSync(first.path);
  assert.throws(() => acquireThreadLock(home, "thr_parity_1"), LockPathNotAFileError);
  rmSync(first.path, { recursive: true });

  if (POSIX) {
    // Symlinked $MADC_HOME still succeeds; symlinked sessions/ is refused -32603.
    const symHome = `${home}-sym-home`;
    cleanups.push(() => rmSync(symHome, { force: true }));
    symlinkSync(home, symHome);
    const viaSym = acquireThreadLock(symHome, "thr_via_sym");
    assert.equal(viaSym.ok, true);
    if (viaSym.ok) assert.equal(releaseThreadLock(viaSym.handle), true);

    const badHome = trackedHome();
    const outsideDir = `${badHome}-outside-sessions`;
    cleanups.push(() => rmSync(outsideDir, { recursive: true, force: true }));
    mkdirSync(outsideDir, { recursive: true, mode: 0o700 });
    symlinkSync(outsideDir, join(badHome, "sessions"));
    assert.throws(
      () => acquireThreadLock(badHome, "thr_sym_sessions"),
      (err: unknown) => (err as { code?: number }).code === -32603,
    );
    assert.equal(existsSync(join(outsideDir, "thr_sym_sessions.lock")), false);
  }
});

test("serve exit 23 (M3A2-N2 / M3A2-N3): never-settling agentFactory + stdin EOF exits 23 within deadline+200ms and settles runServe", async () => {
  const home = trackedHome();
  const err = captureStream();
  const stdin = new PassThrough();
  let exitCode: number | null = null;
  let triggerAt = 0;
  let exitAt = 0;
  const shutdownDeadlineMs = 250;

  const runPromise = runServe([], {
    env: { MADC_HOME: home },
    stdin,
    stderr: err.stream,
    exit: (c) => {
      exitCode = c;
      exitAt = Date.now();
    },
    agent: () => new Promise(() => {}),
    shutdownDeadlineMs,
    exitWriteGraceMs: 100,
    totalExitBoundMs: shutdownDeadlineMs + 180,
  });

  setTimeout(() => {
    triggerAt = Date.now();
    stdin.end();
  }, 50);

  const code = await withTimeout(
    runPromise,
    shutdownDeadlineMs + 800,
    "M3A2-N2 never-settling agentFactory exit 23",
  );
  const elapsed = exitAt - triggerAt;
  assert.equal(code, SERVE_EXIT.SHUTDOWN_DEADLINE);
  assert.equal(exitCode, 23);
  assert.ok(
    elapsed >= shutdownDeadlineMs - 30 && elapsed <= shutdownDeadlineMs + 200,
    `expected exit within [${shutdownDeadlineMs - 30}, ${shutdownDeadlineMs + 200}] ms of EOF trigger, got ${elapsed}ms`,
  );
  assert.match(err.text(), /^madc-engine serve: shutdown deadline exceeded:/m);
  assert.equal(existsSync(engineLockPath(home)), false, "engine.lock released on exit 23");
});

test("serve §6 precedence (M3A2-P1): fatal listener error after listen exits 22 even if shutdown hangs past deadline", async () => {
  const home = trackedHome();
  const err = captureStream();
  const stdin = new PassThrough();
  let exitCode: number | null = null;
  let releaseBlocker!: () => void;
  const blocker = new Promise<void>((r) => {
    releaseBlocker = r;
  });
  let emitError: ((e: Error) => void) | null = null;

  const runPromise = runServe([], {
    env: { MADC_HOME: home },
    stdin,
    stderr: err.stream,
    exit: (c) => {
      exitCode = c;
    },
    agent: echoAgent,
    shutdownDeadlineMs: 80,
    exitWriteGraceMs: 100,
    totalExitBoundMs: 300,
    beforeClose: () => blocker,
    socketDeps: {
      onListenReady: (controls) => {
        emitError = controls.emitError;
      },
    },
    onListening: () => {
      emitError?.(Object.assign(new Error("listener EIO"), { code: "EIO" }));
    },
  });

  try {
    const code = await withTimeout(runPromise, 3000, "M3A2-P1 fatal listener error exit 22");
    assert.equal(code, SERVE_EXIT.LISTEN_ERROR);
    assert.equal(exitCode, 22);
    assert.match(err.text(), /^madc-engine serve: fatal listener error \(EIO\):/m);
    assert.equal(existsSync(engineLockPath(home)), false);
  } finally {
    releaseBlocker();
    stdin.end();
    await withTimeout(runPromise, 2000, "M3A2-P1 cleanup").catch(() => {});
  }
});

if (!POSIX) {
  test.skip("serve §6 precedence (M3A2-P2): listen EADDRINUSE exits 20 and releases engine.lock");
} else {
  test("serve §6 precedence (M3A2-P2): listen EADDRINUSE exits 20 and releases engine.lock", async () => {
    const home = trackedHome();
    const sockPath = engineSocketPath(home);
    const err = captureStream();
    const stdin = new PassThrough();
    let exitCode: number | null = null;

    const runPromise = runServe([], {
      env: { MADC_HOME: home },
      stdin,
      stderr: err.stream,
      exit: (c) => {
        exitCode = c;
      },
      agent: echoAgent,
      socketDeps: {
        beforeListen: () => {
          // Planting a directory immediately before listen() yields EADDRINUSE on Node & Bun.
          mkdirSync(sockPath, { mode: 0o700 });
        },
      },
    });
    try {
      const code = await withTimeout(runPromise, 5000, "M3A2-P2 listen EADDRINUSE exit 20");
      assert.equal(code, SERVE_EXIT.OWNED);
      assert.equal(exitCode, 20);
      assert.match(err.text(), /^madc-engine serve: socket address already in use:/m);
      assert.equal(existsSync(engineLockPath(home)), false);
    } finally {
      stdin.end();
      await withTimeout(runPromise, 2000, "M3A2-P2 cleanup").catch(() => {});
    }
  });
}

if (!POSIX) {
  test.skip("serve §6 precedence (M3A2-P3): non-EADDRINUSE listen failure exits 22");
} else {
  test("serve §6 precedence (M3A2-P3): non-EADDRINUSE listen failure exits 22", async () => {
    const home = trackedHome();
    const err = captureStream();
    const stdin = new PassThrough();
    let exitCode: number | null = null;

    const runPromise = runServe([], {
      env: { MADC_HOME: home },
      stdin,
      stderr: err.stream,
      exit: (c) => {
        exitCode = c;
      },
      agent: echoAgent,
      socketDeps: {
        beforeListen: () => {
          // Removing home immediately before listen() yields ENOENT (non-EADDRINUSE) on all runtimes.
          rmSync(home, { recursive: true, force: true });
        },
      },
    });
    try {
      const code = await withTimeout(
        runPromise,
        5000,
        "M3A2-P3 non-EADDRINUSE listen failure exit 22",
      );
      assert.equal(code, SERVE_EXIT.LISTEN_ERROR);
      assert.equal(exitCode, 22);
      assert.match(err.text(), /^madc-engine serve: listen failed \((?!EADDRINUSE)[A-Z0-9_]+\):/m);
    } finally {
      stdin.end();
      await withTimeout(runPromise, 2000, "M3A2-P3 cleanup").catch(() => {});
    }
  });
}

test("serve §6 precedence (M3A2-P4): runtime uncaughtException and unhandledRejection exit 24 in subprocess with cleanup", async () => {
  for (const mode of ["uncaughtException", "unhandledRejection"] as const) {
    const home = trackedHome();
    const driverPath = `${home}-fault-${mode}.ts`;
    cleanups.push(() => rmSync(driverPath, { force: true }));
    const triggerCode =
      mode === "uncaughtException"
        ? `setTimeout(() => { throw new Error("secret-${mode}-detail"); }, 20);`
        : `setTimeout(() => { void Promise.reject(new Error("secret-${mode}-detail")); }, 20);`;
    writeFileSync(
      driverPath,
      [
        `import { runServe } from ${JSON.stringify(SERVE_MODULE)};`,
        `await runServe([], { onListening: () => { ${triggerCode} } });`,
      ].join("\n"),
    );

    const child = spawn(process.execPath, [driverPath], {
      env: { ...process.env, MADC_HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
    });
    cleanups.push(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already exited.
      }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });

    const code = await withTimeout(
      new Promise<number | null>((r) => child.once("exit", (c) => r(c))),
      6000,
      `M3A2-P4 ${mode} subprocess exit 24`,
    );
    assert.equal(code, SERVE_EXIT.INTERNAL_FAULT, `${mode} stderr: ${stderr}`);
    assert.equal(stdout, "", `${mode} must never write stdout`);
    assert.match(stderr, /^madc-engine serve: unexpected internal fault:/m);
    assert.equal(stderr.includes(`secret-${mode}-detail`), false, "no raw error leaked");
    assert.equal(stderr.includes("\n    at "), false, "no stack trace leaked");
    assert.equal(existsSync(engineLockPath(home)), false, `${mode} released engine.lock`);
    assert.equal(existsSync(engineSocketPath(home)), false, `${mode} removed engine.sock`);
  }
});

test("serve §6 precedence (M3A2-P5): fault or failing step during shutdown keeps trigger code (or 23 on deadline)", async () => {
  // 1. Fatal listener error + failing shutdown step during clean EOF shutdown -> keeps 0.
  {
    const home = trackedHome();
    const err = captureStream();
    const stdin = new PassThrough();
    let exitCode: number | null = null;
    let emitError: ((e: Error) => void) | null = null;

    const code = await withTimeout(
      runServe([], {
        env: { MADC_HOME: home },
        stdin,
        stderr: err.stream,
        exit: (c) => {
          exitCode = c;
        },
        agent: echoAgent,
        socketDeps: {
          onListenReady: (controls) => {
            emitError = controls.emitError;
          },
        },
        beforeClose: async () => {
          emitError?.(Object.assign(new Error("late listener fault"), { code: "EIO" }));
          throw new Error("failing shutdown step");
        },
        onListening: () => {
          stdin.end();
        },
      }),
      5000,
      "M3A2-P5 fault during clean shutdown keeps 0",
    );
    assert.equal(code, SERVE_EXIT.OK);
    assert.equal(exitCode, 0);
    assert.match(err.text(), /fault during shutdown:/);
    assert.match(err.text(), /shutdown hook failed:/);
    assert.equal(existsSync(engineLockPath(home)), false);
  }

  // 2. Fatal listener error during clean shutdown that exceeds deadline -> 23 (not 22).
  {
    const home = trackedHome();
    const err = captureStream();
    const stdin = new PassThrough();
    let exitCode: number | null = null;
    let emitError: ((e: Error) => void) | null = null;
    let releaseBlocker!: () => void;
    const blocker = new Promise<void>((r) => {
      releaseBlocker = r;
    });

    const runPromise = runServe([], {
      env: { MADC_HOME: home },
      stdin,
      stderr: err.stream,
      exit: (c) => {
        exitCode = c;
      },
      agent: echoAgent,
      shutdownDeadlineMs: 80,
      exitWriteGraceMs: 100,
      totalExitBoundMs: 300,
      socketDeps: {
        onListenReady: (controls) => {
          emitError = controls.emitError;
        },
      },
      beforeClose: async () => {
        emitError?.(Object.assign(new Error("late listener fault"), { code: "EIO" }));
        await blocker;
      },
      onListening: () => {
        stdin.end();
      },
    });
    try {
      const code = await withTimeout(
        runPromise,
        3000,
        "M3A2-P5 fault during timed-out clean shutdown exits 23",
      );
      assert.equal(code, SERVE_EXIT.SHUTDOWN_DEADLINE);
      assert.equal(exitCode, 23);
      assert.equal(existsSync(engineLockPath(home)), false);
    } finally {
      releaseBlocker();
      stdin.end();
      await withTimeout(runPromise, 2000, "M3A2-P5 cleanup").catch(() => {});
    }
  }
});

test("serve §6 precedence (M3A2-P6): second trigger during shutdown changes nothing", async () => {
  const home = trackedHome();
  const err = captureStream();
  const stdin = new PassThrough();
  let exitCode: number | null = null;
  let emitError: ((e: Error) => void) | null = null;

  const code = await withTimeout(
    runServe([], {
      env: { MADC_HOME: home },
      stdin,
      stderr: err.stream,
      exit: (c) => {
        exitCode = c;
      },
      agent: echoAgent,
      socketDeps: {
        onListenReady: (controls) => {
          emitError = controls.emitError;
        },
      },
      beforeClose: async () => {
        // Fire second clean trigger (stdin error) and a late listener error while shutdown is active.
        stdin.emit("error", new Error("second trigger"));
        emitError?.(Object.assign(new Error("late error"), { code: "EIO" }));
        await new Promise((r) => setTimeout(r, 40));
      },
      onListening: () => {
        stdin.end();
      },
    }),
    5000,
    "M3A2-P6 second trigger during shutdown",
  );
  assert.equal(code, SERVE_EXIT.OK);
  assert.equal(exitCode, 0);
  assert.equal(existsSync(engineLockPath(home)), false);
});

// Conditional `test.skip` registration off POSIX: bun 1.3.11's node:test shim (CI) ignores the
// options-object `skip`, whereas `test.skip` is honored on both Bun 1.3.11 and Node (codex.test.ts).
if (!POSIX) {
  test.skip(
    "serve §3 line 101 (M3A2-N8a): non-ENOENT socket unlink failure logs one stderr line and keeps trigger exit code",
  );
} else {
  test("serve §3 line 101 (M3A2-N8a): non-ENOENT socket unlink failure logs one stderr line and keeps trigger exit code", async () => {
    const home = trackedHome();
    const sockPath = engineSocketPath(home);
    const err = captureStream();
    const stdin = new PassThrough();
    let exitCode: number | null = null;
    let unlinkCalled = false;

    // Restore home mode on cleanup even if assertions fail mid-test.
    cleanups.push(() => {
      try {
        chmodSync(home, 0o700);
      } catch {
        // ignore
      }
    });

    const code = await withTimeout(
      runServe([], {
        env: { MADC_HOME: home },
        stdin,
        stderr: err.stream,
        exit: (c) => {
          exitCode = c;
        },
        agent: echoAgent,
        socketDeps: {
          // Prevent runtime `server.close()` from unlinking `engine.sock` before `unlinkOwnSocket()`
          // runs on Node 22 / Bun 1.4.x; restore `0o700` inside `unlink` so `engine.lock` still
          // releases cleanly afterwards.
          beforeShutdown: async () => {
            chmodSync(home, 0o500);
          },
          unlink: () => {
            unlinkCalled = true;
            chmodSync(home, 0o700);
            throw Object.assign(new Error("EACCES: unlink refused"), { code: "EACCES" });
          },
        },
        onListening: () => {
          stdin.end();
        },
      }),
      5000,
      "M3A2-N8a shutdown unlink EACCES",
    );

    chmodSync(home, 0o700);
    assert.equal(unlinkCalled, true, "unlinkOwnSocket invoked injected unlink dep");
    assert.equal(code, SERVE_EXIT.OK, "trigger exit code unchanged");
    assert.equal(exitCode, 0);
    assert.equal(existsSync(engineLockPath(home)), false, "engine.lock still released cleanly");
    const unlinkLogLines = err
      .text()
      .split("\n")
      .filter((line) => line.includes("socket unlink failed (EACCES)"));
    assert.equal(
      unlinkLogLines.length,
      1,
      `expected exactly one stderr log line naming EACCES, got:\n${err.text()}`,
    );
    assert.ok(
      unlinkLogLines[0]?.includes(sockPath),
      `expected socket path in log: ${unlinkLogLines[0]}`,
    );
  });
}

if (!POSIX) {
  test.skip(
    "serve §3 line 101 (M3A2-N9): ENOENT during socket unlink logs nothing and keeps trigger exit code",
  );
} else {
  test("serve §3 line 101 (M3A2-N9): ENOENT during socket unlink logs nothing and keeps trigger exit code", async () => {
    const home = trackedHome();
    const err = captureStream();
    const stdin = new PassThrough();
    let exitCode: number | null = null;
    let unlinkCalled = false;

    // Restore home mode on cleanup even if assertions fail mid-test.
    cleanups.push(() => {
      try {
        chmodSync(home, 0o700);
      } catch {
        // ignore
      }
    });

    const code = await withTimeout(
      runServe([], {
        env: { MADC_HOME: home },
        stdin,
        stderr: err.stream,
        exit: (c) => {
          exitCode = c;
        },
        agent: echoAgent,
        socketDeps: {
          // Keep `engine.sock` present past `server.close()` on every runtime (Node 22, Bun 1.3.11,
          // Bun 1.4.x) so `unlinkOwnSocket()` always invokes `socketDeps.unlink` directly.
          beforeShutdown: async () => {
            chmodSync(home, 0o500);
          },
          unlink: (p) => {
            unlinkCalled = true;
            chmodSync(home, 0o700);
            try {
              unlinkSync(p);
            } catch {
              // ignore
            }
            throw Object.assign(new Error("ENOENT: already unlinked"), { code: "ENOENT" });
          },
        },
        onListening: () => {
          stdin.end();
        },
      }),
      5000,
      "M3A2-N9 shutdown unlink ENOENT",
    );

    chmodSync(home, 0o700);
    assert.equal(unlinkCalled, true, "unlinkOwnSocket invoked injected unlink dep");
    assert.equal(code, SERVE_EXIT.OK, "trigger exit code unchanged");
    assert.equal(exitCode, 0);
    assert.equal(existsSync(engineLockPath(home)), false, "engine.lock still released cleanly");
    assert.equal(
      err.text().includes("socket unlink failed"),
      false,
      `expected zero 'socket unlink failed' lines on ENOENT, got:\n${err.text()}`,
    );
  });
}

test("serve §3 total-exit cap (M3A2-A2): blocked stderr write callback is cut off by totalExitBoundMs (not full exitWriteGraceMs)", async () => {
  const home = trackedHome();
  const stdin = new PassThrough();
  let exitCode: number | null = null;
  let triggerAt = 0;
  let exitAt = 0;
  let releaseBlocker!: () => void;
  const blocker = new Promise<void>((r) => {
    releaseBlocker = r;
  });

  // Stalled stderr stream: never invokes the write callback (simulating a blocked stderr pipe).
  const pendingCallbacks: Array<() => void> = [];
  const stalledStderr = new Writable({
    write(_chunk, _encoding, callback) {
      pendingCallbacks.push(callback);
    },
  });

  // Same ordering as production (5 s deadline, 2 s grace, 6 s total: grace < total < deadline + grace)
  // so both Mutant I (cap removed) and Mutant I2 (elapsed subtraction dropped) exit at ~deadline + grace
  // (~600 ms) instead of ~total (~400 ms).
  const shutdownDeadlineMs = 250;
  const exitWriteGraceMs = 350;
  const totalExitBoundMs = 400;

  const runPromise = runServe([], {
    env: { MADC_HOME: home },
    stdin,
    stderr: stalledStderr,
    exit: (c) => {
      exitCode = c;
      exitAt = Date.now();
    },
    agent: echoAgent,
    shutdownDeadlineMs,
    exitWriteGraceMs,
    totalExitBoundMs,
    beforeClose: () => blocker,
    onListening: () => {
      triggerAt = Date.now();
      stdin.end();
    },
  });

  try {
    const code = await withTimeout(
      runPromise,
      2000,
      "M3A2-A2 totalExitBoundMs cap on blocked stderr",
    );
    const elapsed = exitAt - triggerAt;
    assert.equal(code, SERVE_EXIT.SHUTDOWN_DEADLINE);
    assert.equal(exitCode, 23);
    // With the cap (serve.ts:283), exit fires around totalExitBoundMs (~400 ms).
    // With grace forced to 0 (Mutant I4), exit fires at ~shutdownDeadlineMs (~250 ms), failing the
    // lower bound. Without the cap (Mutant I) or without elapsed-time subtraction (Mutant I2),
    // exit waits the full exitWriteGraceMs after shutdownDeadlineMs (~250 + 350 = 600 ms), failing
    // the upper bound.
    assert.ok(
      elapsed >= totalExitBoundMs - 50,
      `expected exit at or after ${totalExitBoundMs - 50}ms (totalExitBoundMs cap), got ${elapsed}ms`,
    );
    assert.ok(
      elapsed <= totalExitBoundMs + 100,
      `expected exit within ${totalExitBoundMs + 100}ms (totalExitBoundMs cap), got ${elapsed}ms`,
    );
    assert.equal(existsSync(engineLockPath(home)), false, "engine.lock released on exit 23");
  } finally {
    releaseBlocker();
    stdin.end();
    for (const cb of pendingCallbacks) cb();
    await withTimeout(runPromise, 2000, "M3A2-A2 cleanup").catch(() => {});
  }
});
