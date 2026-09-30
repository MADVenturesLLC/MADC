/**
 * `madc doctor` (CLI pin §3): read-only health report against `$MADC_HOME`. Plain doctor never
 * creates, seeds, locks or appends; `--init` seeds only by spawning the engine against the real
 * home (the engine's own seed writer). Every PASS carries evidence; WARN and SKIP never fail.
 * Never prints a credential value or a lock token; never execs a vendor binary.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MADC_VERSION } from "@madc/core";
import {
  EngineProtocolError,
  EngineRpcError,
  inspectMadcHome,
  isPidAlive,
  listCatalog,
  loadRepoPolicy,
  PROTOCOL_VERSION,
  REPO_GATED_PROVIDER_IDS,
  type RepoPolicyLoad,
  readLock,
  resolveMadcHome,
  sessionsOwnerReadUnsupported,
  spawnEngine,
  verifySessionFile,
} from "@madc/engine/client";
import { takeEarlySignal } from "./early-signal.ts";
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
/**
 * Clock ticks per second for /proc/<pid>/stat `starttime`: Linux USER_HZ, ASSUMED to be 100 (the
 * value on every mainstream Linux ABI; not read from sysconf at runtime).
 */
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

/**
 * sha256 of a regular file read through ONE no-follow descriptor (Copilot review 5322024643,
 * "previously missed"): the type check and the bytes hashed are bound to the same inode, and a
 * symlink swapped in at `path` is never followed. `null` = absent, not a regular file, or unreadable.
 */
export function sha256OrNull(path: string): string | null {
  let fd: number | undefined;
  try {
    // O_NONBLOCK: a FIFO planted at the path must not block the open (Bugbot 4108211281).
    const nofollow = constants.O_NOFOLLOW;
    // Without O_NOFOLLOW (Windows): lstat → open → fstat, and the opened inode must be the one
    // lstat saw (Copilot r4108213343), so a symlink is never followed.
    const pre = nofollow === undefined ? lstatSync(path) : null;
    if (pre !== null && !pre.isFile()) return null;
    fd = openSync(path, constants.O_RDONLY | (nofollow ?? 0) | (constants.O_NONBLOCK ?? 0));
    const st = fstatSync(fd);
    if (!st.isFile()) return null;
    if (pre !== null && (pre.ino !== st.ino || pre.dev !== st.dev)) return null;
    return createHash("sha256").update(readFileSync(fd)).digest("hex");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * sha256 of `<home>/seats/<file>` only when `seats/` is a real directory (not a symlink) that
 * resolves to `<real home>/seats` (Copilot r4108455655: a symlinked parent is never followed).
 */
export function confinedSeatSha(home: string, file: string): string | null {
  // Copilot r4108570448: the parent's identity is pinned before the open and re-checked after
  // the hash; a `seats/` swapped in between discards the result.
  const before = confinedDirId(home, "seats");
  if (before === null) return null;
  const sha = sha256OrNull(join(home, "seats", file));
  swapHookForTests?.("seats");
  return sameDirId(before, confinedDirId(home, "seats")) ? sha : null;
}

type DirId = { readonly dev: number; readonly ino: number };

/** Test seam: runs between the confinement check and the re-check (simulates a concurrent swap). */
let swapHookForTests: ((dir: "seats" | "sessions") => void) | null = null;
export function setDoctorSwapHookForTests(
  hook: ((dir: "seats" | "sessions") => void) | null,
): void {
  swapHookForTests = hook;
}

/**
 * Identity of `<home>/<name>` when it is a real directory (never a symlink) that resolves to
 * `<real home>/<name>`; `null` otherwise (absent, symlink, non-directory, outside, unreadable).
 */
export function confinedDirId(home: string, name: string): DirId | null {
  const dir = join(home, name);
  try {
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) return null;
    if (realpathSync(dir) !== join(realpathSync(home), name)) return null;
    return { dev: st.dev, ino: st.ino };
  } catch {
    return null;
  }
}

function sameDirId(a: DirId | null, b: DirId | null): boolean {
  return a !== null && b !== null && a.dev === b.dev && a.ino === b.ino;
}

/** True when something (even a dangling symlink) exists at `path`, without following it. */
export function existsNoFollow(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

export type HomePathState =
  | { readonly kind: "present" }
  | { readonly kind: "not-directory" }
  | { readonly kind: "absent" }
  | { readonly kind: "invalid"; readonly message: string };

/**
 * §3e E18: one classifier over the `MADC_HOME` stat/lstat error codes, shared by the one-shot and
 * doctor. Only a both-fail `ENOENT` is absent; everything else names the real reason (a dangling
 * symlink, a symlink loop, or an unreadable path) instead of "dangling symlink" or "missing".
 */
export function classifyHomePath(path: string): HomePathState {
  try {
    return statSync(path).isDirectory() ? { kind: "present" } : { kind: "not-directory" };
  } catch (statErr) {
    const statCode = (statErr as NodeJS.ErrnoException).code;
    try {
      lstatSync(path);
    } catch (lstatErr) {
      const lstatCode = (lstatErr as NodeJS.ErrnoException).code;
      if (statCode === "ENOENT" && lstatCode === "ENOENT") return { kind: "absent" };
      return { kind: "invalid", message: `MADC_HOME ${path} cannot be read (${statCode})` };
    }
    // stat failed but lstat succeeded: something is there that stat cannot resolve.
    if (statCode === "ENOENT") {
      return { kind: "invalid", message: `MADC_HOME ${path} is a dangling symlink` };
    }
    if (statCode === "ELOOP") {
      return { kind: "invalid", message: `MADC_HOME ${path} is a symlink loop` };
    }
    return { kind: "invalid", message: `MADC_HOME ${path} cannot be read (${statCode})` };
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

type ProbeResult =
  | { ok: true; ms: number; exitCode: number }
  | { ok: false; reason: string; code?: number };

/**
 * §3e E7: doctor-wide signal state. `exit` is set by the SIGINT/SIGTERM listeners; `kill` kills
 * the probe engine currently running (no EOF wait), if any.
 */
type DoctorSignal = { exit: number | null; kill: (() => void) | null };

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
async function runProbe(
  io: CliIO,
  home: string,
  budgetMs: number,
  sig?: DoctorSignal,
): Promise<ProbeResult> {
  const t0 = Date.now();
  const client = spawnEngine({
    env: { MADC_HOME: home, KIMI_API_KEY: undefined },
    ...(io.engineEntry !== undefined ? { entry: io.engineEntry } : {}),
  });
  if (sig !== undefined) {
    // §3e E7: the hook stays armed for the WHOLE probe — a signal during the stdin-EOF wait
    // kills the child too (no EOF wait, never the remaining budget).
    sig.kill = () => {
      try {
        client.child.kill("SIGKILL");
      } catch {
        // already gone
      }
    };
  }
  try {
    let version: string;
    try {
      const init = await withTimeout(
        client.request("initialize", {
          clientInfo: { name: "madc-doctor", version: MADC_VERSION },
        }),
        budgetMs,
      );
      version = String(init.protocolVersion);
    } catch (err) {
      await client.close(200);
      if (err instanceof TimeoutError) return { ok: false, reason: `timeout ${budgetMs}ms` };
      // §3e E1: a malformed error body on the initialize reply is a protocol violation.
      if (err instanceof EngineProtocolError) return { ok: false, reason: "protocol violation" };
      // §3e E10: an RPC error answer to initialize is a protocol violation too; the code is
      // carried (and printed) only when it is an integer.
      if (err instanceof EngineRpcError) {
        return Number.isInteger(err.code)
          ? {
              ok: false,
              reason: `protocol violation: initialize answered error ${err.code}`,
              code: err.code,
            }
          : { ok: false, reason: "protocol violation" };
      }
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
  } finally {
    if (sig !== undefined) sig.kill = null;
  }
}

async function checkEngine(io: CliIO, sig?: DoctorSignal): Promise<Check> {
  // A throwaway temp MADC_HOME, never the real one; removed afterwards.
  let root: string;
  try {
    root = mkdtempSync(join(tmpdir(), "madc-doctor-"));
  } catch (err) {
    // §3e E16 F-140: a failing temp home is an engine-row FAIL; the other rows still run.
    const code = (err as NodeJS.ErrnoException).code ?? "error";
    return {
      id: "engine",
      status: "fail",
      summary: `temp home: ${code}`,
      evidence: { reason: `temp home: ${code}` },
    };
  }
  try {
    const r = await runProbe(io, join(root, "home"), ENGINE_PROBE_MS, sig);
    return r.ok
      ? {
          id: "engine",
          status: "pass",
          summary: `${PROTOCOL_VERSION} · ${r.ms} ms · exit ${r.exitCode}`,
          evidence: { protocolVersion: PROTOCOL_VERSION, ms: r.ms, exitCode: r.exitCode },
        }
      : {
          id: "engine",
          status: "fail",
          summary: r.reason,
          evidence: { reason: r.reason, ...(r.code !== undefined ? { code: r.code } : {}) },
        };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export type HomeState =
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
  // §3e E18: the same classifier the one-shot uses (a symlink that resolves to a directory is
  // fine; only a both-fail ENOENT is "missing").
  const state = classifyHomePath(path);
  switch (state.kind) {
    case "present":
      return { kind: "present", path, source };
    case "not-directory":
      // Copilot (review 5321699645, "previously missed"): an existing non-directory is a config error.
      return { kind: "invalid", message: `MADC_HOME ${path} exists but is not a directory` };
    case "absent":
      return { kind: "missing", path, source };
    case "invalid":
      return { kind: "invalid", message: state.message };
  }
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

/** CLI pin §3: every check has a hard timeout; the seat/session inspection gets this budget. */
const INSPECT_TIMEOUT_MS = 5_000;
let inspectTimeoutMs = INSPECT_TIMEOUT_MS;
/** Test seam: shrink the inspection deadline to force the timeout path. `null` restores it. */
export function setDoctorInspectTimeoutForTests(ms: number | null): void {
  inspectTimeoutMs = ms ?? INSPECT_TIMEOUT_MS;
}

type SeatInfo = ReturnType<typeof inspectMadcHome>["seat"];
type Inspection =
  | {
      readonly ok: true;
      readonly seat: SeatInfo;
      readonly lastSession: { readonly threadId: string; readonly path: string } | null;
      readonly verify:
        | { readonly ok: true; readonly events: number; readonly lastHash: string }
        | {
            readonly ok: false;
            readonly line: number;
            readonly reason: string;
            readonly kind: string;
          }
        | null;
    }
  | { readonly ok: false; readonly reason: string };

const LOCAL_CHILD = fileURLToPath(new URL("./inspect-child.ts", import.meta.url));

/** In-process read-only inspection (runs inside the bounded child). */
function inspectDirect(home: string): Inspection {
  const report = inspectMadcHome(home, DEFAULT_SEAT);
  const last = report.lastSession;
  let verify: Extract<Inspection, { ok: true }>["verify"] = null;
  if (last !== null) {
    const v = verifySessionFile(last.path, last.threadId, {}, home);
    verify = v.ok
      ? { ok: true, events: v.events.length, lastHash: v.lastHash }
      : { ok: false, line: v.line, reason: v.reason, kind: v.kind };
  }
  return {
    ok: true,
    seat: report.seat,
    lastSession: last === null ? null : { threadId: last.threadId, path: last.path },
    verify,
  };
}

/**
 * The rows that read MADC_HOME: `seat` (inspection + no-follow hash), `session` (chain verify)
 * and `locks` (survey). Synchronous; the parent only ever runs this inside the bounded child.
 */
export function localRows(home: HomeState): Check[] {
  const insp = home.kind === "present" ? inspectDirect(home.path) : null;
  return [
    checkSeat(home, insp),
    checkSession(home, insp),
    home.kind === "invalid" ? skip("locks", "MADC_HOME is invalid") : checkLocks(home),
  ];
}

/** Seat sha256 for `--init`'s before/after comparison (runs inside the bounded child). */
export function initSeatSha(home: string): string | null {
  return confinedSeatSha(home, `${DEFAULT_SEAT}.json`);
}

type ChildResult = { ok: true; value: unknown } | { ok: false; reason: string };

/**
 * Run one read-only local job in a child killed at the deadline (CLI pin §3 "every check has a
 * hard timeout"; Copilot r4109051001, r4109123404, r4109123434): a huge or stalled seat, session
 * or `sessions/` tree can no longer hang doctor.
 */
function runLocalChild(mode: "rows" | "init-sha", arg: string): ChildResult {
  const flags = process.versions.bun !== undefined ? [] : ["--disable-warning=ExperimentalWarning"];
  const r = spawnSync(process.execPath, [...flags, LOCAL_CHILD, mode, arg], {
    timeout: inspectTimeoutMs,
    killSignal: "SIGKILL",
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.error !== undefined && (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
    return { ok: false, reason: `timeout ${inspectTimeoutMs}ms` };
  }
  if (r.signal !== null) return { ok: false, reason: `timeout ${inspectTimeoutMs}ms` };
  if (r.status !== 0) return { ok: false, reason: `inspection failed (exit ${String(r.status)})` };
  try {
    return { ok: true, value: JSON.parse(r.stdout) as unknown };
  } catch {
    return { ok: false, reason: "inspection returned malformed output" };
  }
}

function localRowsBounded(home: HomeState): Check[] {
  if (home.kind !== "present") return localRows(home); // no MADC_HOME reads
  const r = runLocalChild("rows", JSON.stringify(home));
  if (r.ok && Array.isArray(r.value) && r.value.length === 3) return r.value as Check[];
  const reason = r.ok ? "inspection returned malformed output" : r.reason;
  return ["seat", "session", "locks"].map((id) => ({
    id,
    status: "fail" as const,
    summary: reason,
    evidence: {},
  }));
}

/** `--init` seat hash under the same deadline; a timeout is reported as its own reason. */
function initSeatShaBounded(home: string): { sha: string | null } | { reason: string } {
  const r = runLocalChild("init-sha", home);
  if (!r.ok) return { reason: r.reason };
  return { sha: typeof r.value === "string" ? r.value : null };
}

function checkSeat(home: HomeState, insp: Inspection | null): Check {
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
  if (insp === null || !insp.ok) {
    const reason = insp === null ? "not inspected" : insp.reason;
    return { id: "seat", status: "fail", summary: reason, evidence: { path } };
  }
  const seat = insp.seat;
  if (seat.ok) {
    const sha = confinedSeatSha(home.path, `${DEFAULT_SEAT}.json`);
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

function checkSession(home: HomeState, insp: Inspection | null): Check {
  if (home.kind !== "present") return skip("session", "no sessions yet");
  if (insp === null || !insp.ok) {
    const reason = insp === null ? "not inspected" : insp.reason;
    return { id: "session", status: "fail", summary: reason, evidence: {} };
  }
  const last = insp.lastSession;
  const v = insp.verify;
  if (last === null || v === null) return skip("session", "no sessions yet");
  if (v.ok) {
    return {
      id: "session",
      status: "pass",
      summary: `${last.threadId} · ${v.events} events · head ${v.lastHash.slice(0, 12)}`,
      evidence: {
        threadId: last.threadId,
        path: last.path,
        events: v.events,
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

/**
 * Process start time in Unix ms, from the text of `/proc/<pid>/stat` and `/proc/stat` (Founder
 * correction to the CLI pin `locks` row, PR #16 r4107161992). Field 22 (`starttime`) is in clock
 * ticks since boot, NOT Unix ms: startMs = btime * 1000 + starttimeTicks * 1000 / USER_HZ, where
 * `btime` (the `btime` line of /proc/stat) is boot time in seconds since the epoch. Anything that
 * does not parse → null (the reuse check is then skipped; it never FAILs).
 */
export function procStartMs(pidStat: string, procStat: string): number | null {
  const close = pidStat.lastIndexOf(")"); // comm may contain spaces and parentheses
  if (close < 0) return null;
  const fields = pidStat.slice(close + 2).split(" ");
  const ticks = fields[19]; // field 22 (starttime); fields[0] is field 3 (state)
  const btime = /^btime (\d+)$/m.exec(procStat)?.[1];
  if (ticks === undefined || !/^\d+$/.test(ticks) || btime === undefined) return null;
  return Number(btime) * 1000 + (Number(ticks) * 1000) / USER_HZ;
}

/**
 * The pid-reuse rule: WARN "started after the lock" only when the start time is known and later
 * than `startedAt` + 2 s slack. An unknown start time (no /proc, parse failure) skips the check.
 */
export function startedAfterLock(startMs: number | null, lockStartedAt: number | null): boolean {
  return (
    startMs !== null && lockStartedAt !== null && startMs > lockStartedAt + LOCK_START_SLACK_MS
  );
}

/** Linux: process start time (Unix ms) via {@link procStartMs}; unreadable /proc or non-Linux → null. */
function processStartMs(pid: number): number | null {
  if (process.platform !== "linux") return null;
  try {
    return procStartMs(
      readFileSync(`/proc/${pid}/stat`, "utf8"),
      readFileSync("/proc/stat", "utf8"),
    );
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
  let pinned: DirId | null = null;
  // Amendment 3 item 5 rule 4: an owner-unreadable sessions/ is unsupported in M0 — WARN with the
  // pinned summary whenever the detection rule matches (lstat mode bits, so the same as root).
  // Computed before confinement: Bun's realpathSync refuses EACCES on such a directory where
  // Node's succeeds, and the rule 5 detection never depends on either. A symlink reports 0777, so
  // it never matches here; the symlink branch below still decides it. If the directory can still
  // be listed (running as root), the per-lock evidence follows as usual.
  const unsupportedMode = sessionsOwnerReadUnsupported(dir);
  const unsupportedSummary =
    unsupportedMode === null
      ? null
      : `sessions/ mode ${unsupportedMode}: unsupported in M0 (needs owner read for directory fsync)`;
  try {
    // Copilot r4107805223 / r4107905013, Bugbot 4107900653: same confinement as the engine's
    // inspection. `lstat` first (no follow): any `sessions` symlink, dangling or not, and any
    // `sessions` that resolves outside the real MADC_HOME, is never followed or listed.
    let st: ReturnType<typeof lstatSync> | undefined;
    try {
      st = lstatSync(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      return { id: "locks", status: "pass", summary: "no locks", evidence: { locks: [] } };
    }
    let realpathOk = false;
    if (!st.isSymbolicLink() && st.isDirectory()) {
      try {
        realpathOk = realpathSync(dir) === join(realpathSync(home.path), "sessions");
      } catch (err) {
        // Bun only: EACCES on the owner-unreadable dir. The mode-bits detection decides the row.
        if (unsupportedMode === null || (err as NodeJS.ErrnoException).code !== "EACCES") throw err;
        realpathOk = true;
      }
    }
    if (!realpathOk) {
      return {
        id: "locks",
        status: "warn",
        summary: `${dir} is a symlink or resolves outside MADC_HOME: not inspected`,
        evidence: { path: dir, confined: false },
      };
    }
    pinned = { dev: st.dev, ino: st.ino };
  } catch (err) {
    // `sessions/` exists (lstat above) but its confinement could not be resolved: never a
    // healthy PASS (Copilot review 5322024643, "previously missed").
    const code = (err as NodeJS.ErrnoException).code ?? "error";
    return {
      id: "locks",
      status: "warn",
      summary: `${dir} unreadable (${code}): not inspected`,
      evidence: { path: dir, error: code },
    };
  }
  try {
    names = readdirSync(dir).sort();
    swapHookForTests?.("sessions");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "error";
    if (unsupportedSummary !== null) {
      return {
        id: "locks",
        status: "warn",
        summary: unsupportedSummary,
        evidence: { path: dir, mode: unsupportedMode },
      };
    }
    return {
      id: "locks",
      status: "warn",
      summary: `${dir} unreadable (${code}): not inspected`,
      evidence: { path: dir, error: code },
    };
  }
  const warnings: string[] = unsupportedSummary === null ? [] : [unsupportedSummary];
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
    if (lock.token === null) {
      // A held lock without a well-formed { pid, startedAt, token } body is legacy/corrupt
      // (Copilot review 5322869130): WARN, never a healthy PASS. The body is still not printed.
      warnings.push(`${threadId} · pid ${lock.pid}: corrupt or legacy lock body`);
      locks.push({ threadId, pid: lock.pid, state: "corrupt" });
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
    if (startedAfterLock(processStartMs(lock.pid), startedAt)) {
      warnings.push(`${entry}: pid ${lock.pid} started after the lock: pid reused or foreign`);
      continue;
    }
    held.push(entry);
  }
  // Copilot r4108570535: the survey counts only if `sessions/` is still the same confined
  // directory that was checked before enumeration; a swap during the survey discards everything.
  if (!sameDirId(pinned, confinedDirId(home.path, "sessions"))) {
    return {
      id: "locks",
      status: "warn",
      summary: `${dir} changed during the survey: not inspected`,
      evidence: { path: dir, confined: false },
    };
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

/**
 * M1-A4: the `$MADC_HOME/policy.json` repo allowlists (M1 seat pin §5). Read-only, like every other
 * doctor row. Reports what the engine reports at start: entries rejected AT LOAD (a path-only entry,
 * an entry whose remote does not normalize, a key that is not a registry id), a file refused
 * outright, and a mode more permissive than the pinned `0600`.
 *
 * A rejected entry GRANTS NOTHING, so each one is a WARN the operator must see: the allowlist they
 * meant to write is not the allowlist in force, and the lane silently denies. Never prints a
 * credential value, and never prints an entry's own text — a remote can carry
 * `https://user:token@host/…`, so rejections are identified by provider id and position only.
 */
function checkPolicy(home: HomeState): Check {
  if (home.kind !== "present") return skip("policy", "MADC_HOME is not present: nothing to read");
  const gated = [...REPO_GATED_PROVIDER_IDS];
  let loaded: RepoPolicyLoad;
  try {
    loaded = loadRepoPolicy(home.path);
  } catch (err) {
    // loadRepoPolicy is total; this is the belt-and-braces path so doctor itself never throws.
    return { id: "policy", status: "fail", summary: `policy.json: ${errText(err)}`, evidence: {} };
  }
  if (!loaded.present) {
    return {
      id: "policy",
      status: "pass",
      summary: `no policy.json: repo-gated providers (${gated.join(", ")}) deny every repository (D-M1-8 clean-install default)`,
      evidence: { present: false, repoGated: gated, allowEntries: 0 },
    };
  }

  let allowEntries = 0;
  for (const list of loaded.policy.allow.values()) allowEntries += list.length;
  const evidence: Record<string, unknown> = {
    present: true,
    repoGated: gated,
    providers: [...loaded.policy.allow.keys()],
    allowEntries,
    rejected: loaded.rejected.length,
  };

  const warnings: string[] = [];
  // A refused file is fail-closed (deny everywhere) but is never what the operator intended.
  for (const { issue } of loaded.fileIssues) {
    warnings.push(`${issue}; repo-gated providers deny every repository`);
  }
  for (const entry of loaded.rejected) {
    const where = entry.index === null ? entry.providerId : `${entry.providerId}[${entry.index}]`;
    warnings.push(`${where} rejected: ${entry.issue} (grants nothing)`);
  }
  if (loaded.permissiveMode !== null) {
    evidence.mode = loaded.permissiveMode;
    warnings.push(`mode ${loaded.permissiveMode} is more permissive than the pinned 0600`);
  }

  if (warnings.length > 0) {
    return {
      id: "policy",
      status: "warn",
      summary: `${warnings.length} policy.json problem(s): ${warnings.join("; ")}`,
      evidence,
    };
  }
  return {
    id: "policy",
    status: "pass",
    summary: `${allowEntries} allowlist entries across ${loaded.policy.allow.size} repo-gated providers`,
    evidence,
  };
}

function checkKimiCredential(io: CliIO): Check {
  // M1-A2 (D-M1-5): credentials live in the OS keychain, resolved by the engine; the environment
  // satisfies presence ONLY under the pinned MADC_DEV_ENV_KEYS=1 development exception, which this
  // row must disclose loudly. Presence only: never a value, its length, a prefix or a hash.
  // Keychain presence per provider is queried by `madc auth status <providerId>`; the full lanes
  // report (every lane's credentials/binary presence) lands in M1-A8.
  const devEnvKeys = io.env.MADC_DEV_ENV_KEYS === "1";
  const envSet = (io.env.KIMI_API_KEY ?? "").trim() !== "";
  if (devEnvKeys) {
    return {
      id: "cred.kimi-code",
      status: "warn",
      summary: envSet
        ? "MADC_DEV_ENV_KEYS=1 dev exception (D-M1-5): KIMI_API_KEY set — env fallback ACTIVE; the keychain wins when present; unset the flag for keychain-only"
        : "MADC_DEV_ENV_KEYS=1 dev exception (D-M1-5): env fallback ACTIVE but KIMI_API_KEY empty; credentials resolve from the OS keychain (madc auth status kimi-code)",
      evidence: { devEnvKeys: true, env: "KIMI_API_KEY", set: envSet, store: "os-keychain" },
    };
  }
  return {
    id: "cred.kimi-code",
    status: "skip",
    summary:
      "credentials resolve from the OS keychain (MADC_DEV_ENV_KEYS unset; env KIMI_API_KEY ignored): madc auth status kimi-code",
    evidence: { devEnvKeys: false, env: "KIMI_API_KEY", set: envSet, store: "os-keychain" },
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
async function runInit(io: CliIO, home: string, sig?: DoctorSignal): Promise<Check> {
  const seatPath = join(home, "seats", `${DEFAULT_SEAT}.json`);
  const pre = initSeatShaBounded(home);
  if ("reason" in pre) {
    return { id: "init", status: "fail", summary: pre.reason, evidence: { path: seatPath } };
  }
  const before = pre.sha;
  const r = await runProbe(io, home, INIT_TIMEOUT_MS, sig);
  if (!r.ok)
    return {
      id: "init",
      status: "fail",
      summary: `engine ${r.reason}`,
      evidence: { path: seatPath },
    };
  const post = initSeatShaBounded(home);
  if ("reason" in post) {
    return { id: "init", status: "fail", summary: post.reason, evidence: { path: seatPath } };
  }
  const after = post.sha;
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
  // §3e E7: doctor installs SIGINT/SIGTERM listeners for its whole run. On a signal it kills the
  // probe engine if one is running (no EOF wait), still removes the temp dir, runs no further
  // rows, and exits 130/143 with the rows so far.
  const sig: DoctorSignal = { exit: null, kill: null };
  const onSigint = () => {
    sig.exit = sig.exit ?? EXIT.sigint;
    sig.kill?.();
  };
  const onSigterm = () => {
    sig.exit = EXIT.sigterm;
    sig.kill?.();
  };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  // §3e E7: a signal recorded by the bin.ts backstop during module load applies to the whole run:
  // no rows run, and the run exits 130/143 with the (empty) rows so far.
  const earlySignal = takeEarlySignal();
  if (earlySignal !== null) sig.exit = earlySignal;
  // MADC_HOME set but not absolute: exit-2 class, and nothing spawns (CLI pin §1).
  let home = resolveHome(io);
  const homeInvalid = home.kind === "invalid";
  try {
    if (!opts.json)
      io.stdout.write(`madc doctor · madc ${MADC_VERSION} · protocol ${PROTOCOL_VERSION}\n`);

    if (opts.init && home.kind !== "invalid" && sig.exit === null) {
      emit(await runInit(io, home.path, sig));
      home = resolveHome(io);
    }
    if (sig.exit === null) emit(checkRuntime());
    if (sig.exit === null) {
      emit(
        homeInvalid
          ? skip("engine", "MADC_HOME is invalid: nothing spawned")
          : await checkEngine(io, sig),
      );
    }
    if (sig.exit === null) emit(checkHome(home));
    if (sig.exit === null) {
      for (const row of localRowsBounded(home)) emit(row);
      // The local rows ran under a blocking spawnSync child: let a signal delivered meanwhile
      // take effect now that the child has returned (§3e E7).
      await new Promise((resolve) => setImmediate(resolve));
    }
    if (sig.exit === null) emit(checkRegistry());
    if (sig.exit === null) emit(checkPolicy(home));
    if (sig.exit === null) emit(checkKimiCredential(io));
    if (sig.exit === null) emit(checkBin(io, "claude", "A5"));
    if (sig.exit === null) emit(checkBin(io, "codex", "A6"));
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }

  const counts = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const c of checks) if (c.status !== "init") counts[c.status]++;
  const exitCode =
    sig.exit ?? (homeInvalid ? EXIT.usage : counts.fail > 0 ? EXIT.failure : EXIT.ok);
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
