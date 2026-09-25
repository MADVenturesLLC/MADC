/**
 * `madc doctor` (CLI pin §3): read-only health report against `$MADC_HOME`. Plain doctor never
 * creates, seeds, locks or appends; `--init` seeds only by spawning the engine against the real
 * home (the engine's own seed writer). Every PASS carries evidence; WARN and SKIP never fail.
 * Never prints a credential value or a lock token; never execs a vendor binary.
 */
import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { MADC_VERSION } from "@madc/core";
import {
  inspectMadcHome,
  isPidAlive,
  listCatalog,
  PROTOCOL_VERSION,
  readLock,
  resolveMadcHome,
  spawnEngine,
  verifySessionFile,
} from "@madc/engine/client";
import { EXIT } from "./exit-codes.ts";
import { type CliIO, colorEnabled, paint, TimeoutError, withTimeout } from "./io.ts";

export type CheckStatus = "pass" | "warn" | "fail" | "skip" | "init";

export type Check = {
  readonly id: string;
  readonly status: CheckStatus;
  readonly summary: string;
  readonly evidence: Readonly<Record<string, unknown>>;
};

const ENGINE_PROBE_MS = 5_000;
const INIT_TIMEOUT_MS = 30_000;
const FLOOR = { node: "22.19.0", bun: "1.2.0" } as const;
const DEFAULT_SEAT = "madc-default";
/** Linux reports /proc/<pid>/stat start times in USER_HZ, which is 100 on every Linux ABI. */
const USER_HZ = 100;
const LOCK_START_SLACK_MS = 2_000;

export type DoctorOptions = { readonly json: boolean; readonly init: boolean };

function versionAtLeast(version: string, floor: string): boolean {
  const a = version.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const b = floor.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

const sha256File = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

function sha256OrNull(path: string): string | null {
  try {
    if (!lstatSync(path).isFile()) return null;
    return sha256File(path);
  } catch {
    return null;
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ------------------------------------------------------------------ checks

function checkRuntime(): Check {
  const bun = process.versions.bun;
  const runtime = bun !== undefined ? "bun" : "node";
  const version = bun ?? process.versions.node;
  const floor = FLOOR[runtime];
  const shortFloor = floor.replace(/\.0$/, "");
  const ok = versionAtLeast(version, floor);
  return {
    id: "runtime",
    status: ok ? "pass" : "fail",
    summary: ok
      ? `${runtime} ${version} (floor ${shortFloor})`
      : `${runtime} ${version} below floor ${shortFloor}`,
    evidence: { runtime, version, floor },
  };
}

type ProbeResult = { ok: true; ms: number; exitCode: number } | { ok: false; reason: string };

function finishProbe(
  violations: number,
  exitCode: number | null,
  ms: number,
  version: string,
): ProbeResult & { protocolVersion?: string } {
  if (violations > 0) return { ok: false, reason: "protocol violation" };
  if (exitCode !== 0) return { ok: false, reason: `exit ${String(exitCode)}` };
  return { ok: true, ms, exitCode, protocolVersion: version };
}

/** Spawn the engine against `home`, `initialize`, EOF, and require exit 0 within `budgetMs`. */
async function runProbe(io: CliIO, home: string, budgetMs: number): Promise<ProbeResult> {
  const t0 = Date.now();
  const client = spawnEngine({
    env: { MADC_HOME: home, KIMI_API_KEY: undefined },
    ...(io.engineEntry !== undefined ? { entry: io.engineEntry } : {}),
  });
  let version: string;
  try {
    const init = await withTimeout(
      client.request("initialize", { clientInfo: { name: "madc-doctor", version: MADC_VERSION } }),
      budgetMs,
    );
    version = String(init.protocolVersion);
  } catch (err) {
    const timedOut = err instanceof TimeoutError;
    await client.close(200);
    if (timedOut) return { ok: false, reason: `timeout ${budgetMs}ms` };
    return { ok: false, reason: `exit ${String(client.child.exitCode)}` };
  }
  if (version !== PROTOCOL_VERSION) {
    await client.close(200);
    return { ok: false, reason: `version ${version}` };
  }
  client.notify("initialized", {});
  const remaining = Math.max(1, budgetMs - (Date.now() - t0));
  let exitCode: number | null = null;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    client.child.kill("SIGKILL");
  }, remaining);
  try {
    exitCode = await client.close(remaining + 1_000);
  } finally {
    clearTimeout(timer);
  }
  if (timedOut) return { ok: false, reason: `timeout ${budgetMs}ms` };
  return finishProbe(client.protocolViolations.length, exitCode, Date.now() - t0, version);
}

async function checkEngine(io: CliIO): Promise<Check> {
  // A throwaway temp MADC_HOME, never the real one; removed afterwards.
  const root = mkdtempSync(join(tmpdir(), "madc-doctor-"));
  try {
    const r = await runProbe(io, join(root, "home"), ENGINE_PROBE_MS);
    return r.ok
      ? {
          id: "engine",
          status: "pass",
          summary: `${PROTOCOL_VERSION} · ${r.ms} ms · exit ${r.exitCode}`,
          evidence: { protocolVersion: PROTOCOL_VERSION, ms: r.ms, exitCode: r.exitCode },
        }
      : { id: "engine", status: "fail", summary: r.reason, evidence: { reason: r.reason } };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

type HomeState =
  | { kind: "invalid"; message: string }
  | { kind: "missing"; path: string; source: string }
  | { kind: "present"; path: string; source: string };

function resolveHome(io: CliIO): HomeState {
  const source =
    io.env.MADC_HOME !== undefined && io.env.MADC_HOME !== "" ? "MADC_HOME" : "default";
  let path: string;
  try {
    path = resolveMadcHome(io.env as NodeJS.ProcessEnv);
  } catch (err) {
    return { kind: "invalid", message: errText(err) };
  }
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(path);
  } catch {
    // missing (or unreadable): not initialized
    return { kind: "missing", path, source };
  }
  if (st.isDirectory()) return { kind: "present", path, source };
  // Copilot (review 5321699645, "previously missed"): an existing non-directory is a config error.
  return { kind: "invalid", message: `MADC_HOME ${path} exists but is not a directory` };
}

function checkHome(home: HomeState): Check {
  switch (home.kind) {
    case "invalid":
      return {
        id: "home",
        status: "fail",
        summary: home.message,
        evidence: { source: "MADC_HOME" },
      };
    case "missing":
      return {
        id: "home",
        status: "warn",
        summary: `${home.path} (${home.source}) not initialized: run madc doctor --init`,
        evidence: { path: home.path, source: home.source },
      };
    case "present":
      return {
        id: "home",
        status: "pass",
        summary: `${home.path} (${home.source})`,
        evidence: { path: home.path, source: home.source },
      };
  }
}

function checkSeat(home: HomeState): Check {
  if (home.kind === "invalid") return skip("seat", "MADC_HOME is invalid");
  const path = join(home.path, "seats", `${DEFAULT_SEAT}.json`);
  if (home.kind === "missing") {
    return {
      id: "seat",
      status: "warn",
      summary: `${DEFAULT_SEAT} not initialized (${path})`,
      evidence: { path },
    };
  }
  const seat = inspectMadcHome(home.path, DEFAULT_SEAT).seat;
  if (seat.ok) {
    const sha = sha256OrNull(seat.path);
    if (sha !== null) {
      return {
        id: "seat",
        status: "pass",
        summary: `${DEFAULT_SEAT} · sha256:${sha.slice(0, 12)}`,
        evidence: { path: seat.path, sha256: sha },
      };
    }
    return {
      id: "seat",
      status: "fail",
      summary: "seat file vanished while reading",
      evidence: { path: seat.path },
    };
  }
  if (seat.code === -32005) {
    return {
      id: "seat",
      status: "warn",
      summary: `${DEFAULT_SEAT} not initialized (${seat.path})`,
      evidence: { path: seat.path },
    };
  }
  return {
    id: "seat",
    status: "fail",
    summary: `${seat.code} ${seat.issues.join("; ")}`,
    evidence: { path: seat.path, code: seat.code, issues: seat.issues },
  };
}

function checkSession(home: HomeState): Check {
  if (home.kind !== "present") return skip("session", "no sessions yet");
  const last = inspectMadcHome(home.path, DEFAULT_SEAT).lastSession;
  if (last === null) return skip("session", "no sessions yet");
  const v = verifySessionFile(last.path, last.threadId, {}, home.path);
  if (v.ok) {
    return {
      id: "session",
      status: "pass",
      summary: `${last.threadId} · ${v.events.length} events · head ${v.lastHash.slice(0, 12)}`,
      evidence: {
        threadId: last.threadId,
        path: last.path,
        events: v.events.length,
        headHash: v.lastHash,
      },
    };
  }
  const evidence = {
    threadId: last.threadId,
    path: last.path,
    line: v.line,
    reason: v.reason,
    kind: v.kind,
  };
  if (v.kind === "torn-tail") {
    return {
      id: "session",
      status: "fail",
      summary: `torn tail at line ${v.line}: crash residue, not tamper (file untouched; repair lands in M1)`,
      evidence,
    };
  }
  return {
    id: "session",
    status: "fail",
    summary: `integrity: line ${v.line}: ${v.reason}`,
    evidence,
  };
}

/** Linux: process start time (unix ms) from /proc/<pid>/stat + /proc/stat btime; else null. */
function processStartMs(pid: number): number | null {
  if (process.platform !== "linux") return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const startTicks = Number(fields[19]); // field 22 (starttime); fields[0] is field 3
    const btimeLine = readFileSync("/proc/stat", "utf8")
      .split("\n")
      .find((l) => l.startsWith("btime "));
    const btime = Number(btimeLine?.split(/\s+/)[1]);
    if (!Number.isFinite(startTicks) || !Number.isFinite(btime)) return null;
    return (btime + startTicks / USER_HZ) * 1000;
  } catch {
    return null;
  }
}

const ORPHAN = /\.lock\.(?:reclaim|tmp)-/;

/**
 * The suffix of `*.lock.reclaim-<token>` / `*.lock.tmp-<token>` is the lock token, which doctor
 * never prints (CLI pin §3; Copilot r4107601226): keep the thread id and kind, redact the rest.
 */
function redactOrphan(name: string): string {
  return name.replace(/(\.lock\.(?:reclaim|tmp)-).*$/s, "$1<redacted>");
}

function checkLocks(home: HomeState): Check {
  if (home.kind !== "present")
    return { id: "locks", status: "pass", summary: "no locks", evidence: { locks: [] } };
  const dir = join(home.path, "sessions");
  let names: string[];
  try {
    if (!existsSync(dir)) {
      return { id: "locks", status: "pass", summary: "no locks", evidence: { locks: [] } };
    }
    // Copilot r4107805223: same confinement as the engine's inspection. A `sessions` that is a
    // symlink or resolves outside the real MADC_HOME is not followed or listed.
    const realHome = realpathSync(home.path);
    if (lstatSync(dir).isSymbolicLink() || realpathSync(dir) !== join(realHome, "sessions")) {
      return {
        id: "locks",
        status: "warn",
        summary: `${dir} is a symlink or resolves outside MADC_HOME: not inspected`,
        evidence: { path: dir, confined: false },
      };
    }
    names = readdirSync(dir).sort();
  } catch {
    return { id: "locks", status: "pass", summary: "no locks", evidence: { locks: [] } };
  }
  const warnings: string[] = [];
  const held: string[] = [];
  const locks: Array<Record<string, unknown>> = [];
  const now = Date.now();
  for (const name of names) {
    if (ORPHAN.test(name)) {
      warnings.push(`orphaned ${redactOrphan(name)}`);
      locks.push({ file: redactOrphan(name), state: "orphaned" });
      continue;
    }
    if (!name.endsWith(".lock")) continue;
    const threadId = name.slice(0, -".lock".length);
    const path = join(dir, name);
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(path);
    } catch (err) {
      warnings.push(`${threadId}: unreadable (${errText(err)})`);
      continue;
    }
    if (st.isSymbolicLink()) {
      warnings.push(`${threadId}: lock is a symlink (not followed)`);
      locks.push({ threadId, state: "symlink" });
      continue;
    }
    if (!st.isFile()) {
      warnings.push(`${threadId}: lock is not a regular file`);
      locks.push({ threadId, state: "not-a-file" });
      continue;
    }
    let lock: ReturnType<typeof readLock>;
    try {
      lock = readLock(path); // read-only, no-follow; the body (and its token) is never printed
    } catch (err) {
      warnings.push(`${threadId}: unreadable (${errText(err)})`);
      continue;
    }
    if (lock.state !== "held") {
      warnings.push(`${threadId}: unreadable or corrupt lock body`);
      locks.push({ threadId, state: lock.state });
      continue;
    }
    const startedAt = typeof lock.startedAt === "number" ? lock.startedAt : null;
    const age = startedAt === null ? "?" : `${Math.max(0, Math.round((now - startedAt) / 1000))}s`;
    const entry = `${threadId} · pid ${lock.pid} · age ${age}`;
    locks.push({
      threadId,
      pid: lock.pid,
      ageSeconds: startedAt === null ? null : Math.round((now - startedAt) / 1000),
    });
    if (!isPidAlive(lock.pid)) {
      warnings.push(
        `${entry}: pid ${lock.pid} not visible in this PID namespace: dead here, or live in another container. M0 supports one PID namespace per MADC_HOME (Amendment 2 §1); do not resume this thread from two places`,
      );
      continue;
    }
    const started = processStartMs(lock.pid);
    if (started !== null && startedAt !== null && started > startedAt + LOCK_START_SLACK_MS) {
      warnings.push(`${entry}: pid ${lock.pid} started after the lock: pid reused or foreign`);
      continue;
    }
    held.push(entry);
  }
  if (warnings.length > 0) {
    return {
      id: "locks",
      status: "warn",
      summary: [...warnings, ...held].join("; "),
      evidence: { locks },
    };
  }
  return {
    id: "locks",
    status: "pass",
    summary: held.length === 0 ? "no locks" : held.join("; "),
    evidence: { locks },
  };
}

function checkRegistry(): Check {
  try {
    const entries = listCatalog();
    const wired = entries.filter((e) => e.wired).map((e) => e.id);
    const byStatus: Record<string, number> = {};
    for (const e of entries) byStatus[e.status] = (byStatus[e.status] ?? 0) + 1;
    const counts = Object.entries(byStatus)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ");
    return {
      id: "registry",
      status: "pass",
      summary: `${entries.length} entries · wired: ${wired.join(", ")} · ${counts}`,
      evidence: { entries: entries.length, wired, byStatus },
    };
  } catch (err) {
    return {
      id: "registry",
      status: "fail",
      summary: `catalog failed to load: ${errText(err)}`,
      evidence: {},
    };
  }
}

function checkKimiCredential(io: CliIO): Check {
  // Presence only: never the value, its length, a prefix or a hash.
  const set = (io.env.KIMI_API_KEY ?? "").trim() !== "";
  return set
    ? {
        id: "cred.kimi-code",
        status: "pass",
        summary: "KIMI_API_KEY set",
        evidence: { env: "KIMI_API_KEY", set: true },
      }
    : {
        id: "cred.kimi-code",
        status: "warn",
        summary: "KIMI_API_KEY not set: turns answer -32008 no-credentials",
        evidence: { env: "KIMI_API_KEY", set: false },
      };
}

/** PATH lookup only (PATHEXT on Windows). Never executes anything. */
export function findOnPath(
  name: string,
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter((d) => d !== "");
  const exts =
    process.platform === "win32"
      ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((e) => e !== "")
      : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, `${name}${ext}`);
      try {
        if (!statSync(candidate).isFile()) continue;
        if (process.platform !== "win32") accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // not here
      }
    }
  }
  return null;
}

function checkBin(io: CliIO, name: string, act: string): Check {
  const found = findOnPath(name, io.env);
  return {
    id: `bin.${name}`,
    status: "skip",
    summary: `${found === null ? "not on PATH" : `found ${found}`} · adapter not built (${act})`,
    evidence: { path: found },
  };
}

function skip(id: string, why: string): Check {
  return { id, status: "skip", summary: why, evidence: {} };
}

/** `--init`: seed via the engine against the real home (seat pin §1 same writer). Never writes seat bytes itself. */
async function runInit(io: CliIO, home: string): Promise<Check> {
  const seatPath = join(home, "seats", `${DEFAULT_SEAT}.json`);
  const before = sha256OrNull(seatPath);
  const r = await runProbe(io, home, INIT_TIMEOUT_MS);
  if (!r.ok)
    return {
      id: "init",
      status: "fail",
      summary: `engine ${r.reason}`,
      evidence: { path: seatPath },
    };
  const after = sha256OrNull(seatPath);
  if (after === null) {
    return {
      id: "init",
      status: "fail",
      summary: `engine did not seed ${seatPath}`,
      evidence: { path: seatPath },
    };
  }
  if (before === null) {
    return {
      id: "init",
      status: "init",
      summary: `seeded ${seatPath}`,
      evidence: { path: seatPath, sha256: after, seeded: true },
    };
  }
  if (before !== after) {
    return {
      id: "init",
      status: "fail",
      summary: `seat changed during init (${seatPath})`,
      evidence: { path: seatPath },
    };
  }
  return {
    id: "init",
    status: "init",
    summary: `already present (unchanged, sha256:${after.slice(0, 12)})`,
    evidence: { path: seatPath, sha256: after, seeded: false },
  };
}

// ------------------------------------------------------------------ runner

const COLORS: Record<CheckStatus, string> = {
  pass: "32",
  warn: "33",
  fail: "31",
  skip: "2",
  init: "36",
};

function renderRow(c: Check, color: boolean): string {
  const word = paint(color, COLORS[c.status], c.status.toUpperCase().padEnd(4));
  // The --init row is `INIT  seeded <path>` / `INIT  already present (…)` (CLI pin §3).
  if (c.id === "init" && c.status === "init") return `${word}  ${c.summary}\n`;
  return `${word}  ${c.id.padEnd(14)} ${c.summary}\n`;
}

export async function runDoctor(io: CliIO, opts: DoctorOptions): Promise<number> {
  const t0 = Date.now();
  const color = !opts.json && colorEnabled(io);
  const checks: Check[] = [];
  const emit = (c: Check) => {
    checks.push(c);
    if (!opts.json) io.stdout.write(renderRow(c, color));
  };
  if (!opts.json)
    io.stdout.write(`madc doctor · madc ${MADC_VERSION} · protocol ${PROTOCOL_VERSION}\n`);

  let home = resolveHome(io);
  // MADC_HOME set but not absolute: exit-2 class, and nothing spawns (CLI pin §1).
  const homeInvalid = home.kind === "invalid";
  if (opts.init && home.kind !== "invalid") {
    emit(await runInit(io, home.path));
    home = resolveHome(io);
  }
  emit(checkRuntime());
  emit(
    homeInvalid ? skip("engine", "MADC_HOME is invalid: nothing spawned") : await checkEngine(io),
  );
  emit(checkHome(home));
  emit(checkSeat(home));
  emit(checkSession(home));
  emit(home.kind === "invalid" ? skip("locks", "MADC_HOME is invalid") : checkLocks(home));
  emit(checkRegistry());
  emit(checkKimiCredential(io));
  emit(checkBin(io, "claude", "A5"));
  emit(checkBin(io, "codex", "A6"));

  const counts = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const c of checks) if (c.status !== "init") counts[c.status]++;
  const exitCode = homeInvalid ? EXIT.usage : counts.fail > 0 ? EXIT.failure : EXIT.ok;
  const ms = Date.now() - t0;
  if (opts.json) {
    io.stdout.write(
      `${JSON.stringify({
        ok: exitCode === EXIT.ok,
        exitCode,
        madcVersion: MADC_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        durationMs: ms,
        checks,
        counts,
      })}\n`,
    );
  } else {
    io.stdout.write(
      `RESULT  ${counts.fail} FAIL · ${counts.warn} WARN · ${counts.skip} SKIP · ${ms} ms   exit ${exitCode}\n`,
    );
  }
  return exitCode;
}
