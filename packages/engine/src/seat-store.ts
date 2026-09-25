/**
 * Seat files under `$MADC_HOME/seats/` (seat pin §1–§3): the seed writer (shared with
 * `madc doctor --init`, A7) and the confined, validated loader used by `thread/start`.
 */
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { KIMI_CODE_PROVIDER_ID, resolveKimiPinnedModel } from "@madc/adapters";
import { enforcePrivateDir, enforcePrivateDirAt, isStrictlyUnder } from "./home.ts";
import { type OpenNoFollowOptions, openNoFollow } from "./lock.ts";
import {
  ErrorCode,
  invalidParams,
  RpcError,
  type SeatInvalidData,
  type SeatNotFoundData,
} from "./protocol/errors.ts";
import { isValidId } from "./protocol/ids.ts";
import { type EngineSeat, MADC_DEFAULT_SEAT, validateSeat } from "./seat.ts";

/** Seat files larger than this are refused (-32006) instead of being parsed. */
const MAX_SEAT_BYTES = 1024 * 1024;

const HOME_SUBDIRS = ["seats", "sessions", "memory"] as const;

/** A seat as loaded from disk, with the file it came from (reported in -32006 data). */
export type LoadedSeat = { readonly seat: EngineSeat; readonly path: string };

/** Operator-facing seat file path (lexical; `id` must already be a valid id). */
export function seatFilePath(home: string, id: string): string {
  return join(home, "seats", `${id}.json`);
}

/**
 * The one seat serializer (the seed writer uses it). Deterministic bytes: keys are emitted in
 * seat pin §3 order regardless of the input object's key order, 2-space indentation, LF line
 * endings, and exactly one trailing newline. `seedDefaultSeat` writes
 * `serializeSeat(MADC_DEFAULT_SEAT)`; a test pins those bytes literally.
 */
export function serializeSeat(seat: EngineSeat): string {
  const memory =
    seat.memory.mode === "file"
      ? { mode: seat.memory.mode, path: seat.memory.path }
      : { mode: seat.memory.mode };
  const tools =
    seat.tools.allow === undefined
      ? { deny: [...seat.tools.deny] }
      : { deny: [...seat.tools.deny], allow: [...seat.tools.allow] };
  const ordered = {
    id: seat.id,
    version: seat.version,
    role: seat.role,
    standingInstructions: seat.standingInstructions,
    pinnedModel: seat.pinnedModel,
    preferredBacking: seat.preferredBacking,
    memory,
    tools,
    policy: { headlessOk: seat.policy.headlessOk },
    handoffs: { enabled: seat.handoffs.enabled, targets: [...seat.handoffs.targets] },
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/** `link` errors meaning "this filesystem has no hard links" (fall back to an in-place create). */
const NO_HARD_LINKS = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV"]);

/** dev + inode of a file the seed writer created (checked again after the link). */
type FileId = { readonly dev: bigint; readonly ino: bigint };

/**
 * Create `path` exclusively (0600, no-follow), write all of `bytes`, fsync. `pinned()` (the
 * lstat-checked `seats/` is still that directory, dev + inode, at its real path) is re-checked
 * immediately before the open, so a swap before that point creates nothing anywhere. `isAt(path,
 * id)` must hold for the opened fd right after the open before a byte is written; otherwise the
 * seed fails, and the empty file it just created is removed only if `path` still names that very
 * inode (a swap in the check-to-open window can land it outside `seats/`; it never holds seed
 * bytes). If anything after that fails, the partial file is removed and the error rethrown — but
 * only while `isAt(path, id)` still holds: a `seats/` swapped after the open means the path may now
 * name an unrelated file, which is never unlinked (the orphaned dot-temp file is harmless: it is
 * never read as a seat). Node has no `openat` / `unlinkat`, so each check and the syscall after it
 * are two path operations; the window between them is the r4104462637 / r4105871146 residual.
 */
function writeNewFile(
  path: string,
  bytes: Buffer,
  isAt: (p: string, id: FileId) => boolean,
  pinned: () => boolean,
): FileId {
  if (!pinned()) {
    throw new Error("seats/ under MADC_HOME changed while the seed was being written");
  }
  seedHooks.afterPinCheck?.("open", path);
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  let id: FileId | null = null;
  let opened: FileId | null = null;
  try {
    const st = fstatSync(fd, { bigint: true });
    opened = { dev: st.dev, ino: st.ino };
    if (isAt(path, opened)) id = opened;
  } catch {
    id = null;
  }
  if (id === null) {
    closeSync(fd);
    unlinkIfSame(path, opened);
    throw new Error("seats/ under MADC_HOME changed while the seed was being written");
  }
  try {
    try {
      seedHooks.beforeWrite?.(path);
      let off = 0;
      while (off < bytes.length) off += writeSync(fd, bytes, off, bytes.length - off);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    unlinkIfAt(path, id, isAt);
    throw err;
  }
  return id;
}

/** Unlink `path` only if it still names the file `id` in the real `seats/` (best effort). */
function unlinkIfAt(path: string, id: FileId, isAt: (p: string, id: FileId) => boolean): void {
  try {
    if (isAt(path, id)) unlinkSync(path);
  } catch {
    // Already gone, or seats/ no longer resolves: leave it.
  }
}

/**
 * Unlink `path` only if it names the file `id` (wherever it resolves now): used for a file the seed
 * itself just created in a swapped directory. Best effort; the lstat-to-unlink gap is the
 * r4104462637 residual.
 */
function unlinkIfSame(path: string, id: FileId | null): void {
  if (id === null) return;
  try {
    const st = lstatSync(path, { bigint: true });
    if (st.isFile() && st.dev === id.dev && st.ino === id.ino) unlinkSync(path);
  } catch {
    // Already gone or unreadable: leave it.
  }
}

/**
 * The seed's `link(tmp, path)` succeeded but `path` is not the seed's temp inode in the pinned
 * `seats/`: the link resolved through a swapped directory. The name `path` did not exist a moment
 * ago (link never replaces), so if it and `tmp` still name one inode, that name is the one the link
 * just created: remove it (only the name; the file it points to keeps its other link). Best effort;
 * the lstat-to-unlink gap is the r4104462637 residual.
 */
function removeStrayLink(tmp: string, path: string): void {
  try {
    const a = lstatSync(path, { bigint: true });
    const b = lstatSync(tmp, { bigint: true });
    if (a.isFile() && a.dev === b.dev && a.ino === b.ino) unlinkSync(path);
  } catch {
    // Already gone or unreadable: leave it.
  }
}

/**
 * Test seam (internal): hooks just before the seed's temp file is opened / written / linked, and
 * right after each home subdirectory passes its lstat check (before its mode is tightened), and
 * `afterPinCheck`: after the last `seats/` identity re-check, immediately before the path-based
 * `open` / `link` syscall (the residual window Node cannot close).
 */
export type SeedTestHooks = {
  beforeOpen?: () => void;
  beforeWrite?: (path: string) => void;
  beforeLink?: (tmp: string) => void;
  afterDirCheck?: (dir: string) => void;
  afterPinCheck?: (step: "open" | "link", path: string) => void;
};
let seedHooks: SeedTestHooks = {};
export function setSeedHooksForTests(hooks: SeedTestHooks | null): void {
  seedHooks = hooks ?? {};
}

function errCode(err: unknown): string | undefined {
  return err !== null && typeof err === "object" && "code" in err
    ? String((err as { code: unknown }).code)
    : undefined;
}

export type SeedResult = {
  readonly path: string;
  /** false when the file already existed (it is never overwritten). */
  readonly created: boolean;
};

/**
 * Create `$MADC_HOME` with `seats/`, `sessions/`, `memory/` (0700) and write
 * `seats/madc-default.json` (0600) with exactly `MADC_DEFAULT_SEAT` if it does not exist yet.
 * The bytes go to a private temp file first (O_EXCL, fsync), which is then hard-linked into
 * place: `link` never replaces an existing file (an operator's file or a concurrent seeder wins),
 * and a failed or interrupted write can never leave a partial seat file behind. The temp name
 * starts with "." so it can never be loaded as a seat. One source of seed content: the engine
 * start and `madc doctor --init` both call this.
 */
export function seedDefaultSeat(home: string): SeedResult {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  enforcePrivateDir(home);
  let seatsId: FileId | null = null;
  for (const sub of HOME_SUBDIRS) {
    const dir = join(home, sub);
    try {
      mkdirSync(dir, { mode: 0o700 });
    } catch (err) {
      if (errCode(err) !== "EEXIST") throw err;
    }
    const st = lstatSync(dir, { bigint: true });
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new Error(`${sub} under MADC_HOME must be a real directory`);
    }
    seedHooks.afterDirCheck?.(dir);
    // chmod on a no-follow fd that is still the lstat-checked directory, never by path.
    if (!enforcePrivateDirAt(dir, { dev: st.dev, ino: st.ino })) {
      throw new Error(`${sub} under MADC_HOME must be a real directory`);
    }
    if (sub === "seats") seatsId = { dev: st.dev, ino: st.ino };
  }
  const path = seatFilePath(home, MADC_DEFAULT_SEAT.id);
  try {
    lstatSync(path);
    return { path, created: false };
  } catch (err) {
    if (errCode(err) !== "ENOENT") throw err;
  }
  // Every file the seed creates must sit in this real seats/ directory (the one lstat-checked
  // above, pinned by dev + inode), strictly under the real home. Node has no openat / linkat, so
  // the pin is re-checked immediately before each path-based open and link, then again on the
  // result; a swap landing in the gap is detected and the seed's own stray name removed.
  const seatsDir = join(home, "seats");
  const realSeats = realpathSync(seatsDir);
  const pin = seatsId;
  const seatsPinned = (): boolean => {
    if (pin === null) return false;
    try {
      const st = lstatSync(seatsDir, { bigint: true });
      if (st.isSymbolicLink() || !st.isDirectory() || st.dev !== pin.dev || st.ino !== pin.ino) {
        return false;
      }
      return realpathSync(seatsDir) === realSeats;
    } catch {
      return false;
    }
  };
  if (!isStrictlyUnder(realSeats, realpathSync(home)) || !seatsPinned()) {
    throw new Error("seats under MADC_HOME must be a real directory");
  }
  const isAt = (p: string, id: FileId): boolean => {
    if (!seatsPinned()) return false;
    const st = lstatSync(p, { bigint: true });
    return st.isFile() && st.dev === id.dev && st.ino === id.ino;
  };
  const bytes = Buffer.from(serializeSeat(MADC_DEFAULT_SEAT), "utf8");
  const tmp = join(
    seatsDir,
    `.${MADC_DEFAULT_SEAT.id}.json.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  seedHooks.beforeOpen?.();
  const tmpId = writeNewFile(tmp, bytes, isAt, seatsPinned);
  const linkChanged = () =>
    new Error("seats/ under MADC_HOME changed while the seed was being linked");
  try {
    try {
      seedHooks.beforeLink?.(tmp);
      // Re-pin immediately before the path-based link: a swap before this point links nothing.
      if (!isAt(tmp, tmpId)) throw linkChanged();
      seedHooks.afterPinCheck?.("link", path);
      linkSync(tmp, path);
      if (!isAt(path, tmpId)) {
        // A swap in the check-to-link gap: undo the name the link just created, then fail.
        removeStrayLink(tmp, path);
        throw linkChanged();
      }
    } catch (err) {
      const code = errCode(err);
      // An existing file only counts as "already seeded" in the pinned seats/: an EEXIST from a
      // link that resolved through a swapped directory fails closed (r4106539531).
      if (code === "EEXIST") {
        if (!seatsPinned()) throw linkChanged();
        return { path, created: false };
      }
      if (!NO_HARD_LINKS.has(code ?? "")) throw err;
      // Filesystem without hard links: exclusive create in place; a failed write removes
      // the partial file before rethrowing.
      try {
        writeNewFile(path, bytes, isAt, seatsPinned);
      } catch (werr) {
        if (errCode(werr) === "EEXIST") {
          if (!seatsPinned()) {
            throw new Error("seats/ under MADC_HOME changed while the seed was being written");
          }
          return { path, created: false };
        }
        throw werr;
      }
    }
    return { path, created: true };
  } finally {
    // Only our own temp file, still in the real seats/ (a leftover dot-temp is never read as a seat).
    unlinkIfAt(tmp, tmpId, isAt);
  }
}

function seatNotFound(seatId: string, path: string): RpcError {
  return new RpcError(ErrorCode.SeatNotFound, "Seat not found", {
    seatId,
    path,
  } satisfies SeatNotFoundData);
}

export function seatInvalid(seatId: string, path: string, issues: string[]): RpcError {
  return new RpcError(ErrorCode.SeatInvalid, "Seat invalid", {
    seatId,
    path,
    issues,
  } satisfies SeatInvalidData);
}

/**
 * True when `path` (which may not exist yet) could resolve outside `realHome`. A missing path is
 * judged by its deepest existing ancestor, and a missing component that is itself a (dangling)
 * symlink counts as an escape, so `memory/link/new.md` with `link` → outside is refused even
 * before `new.md` exists.
 */
function escapesHome(realHome: string, path: string): boolean {
  let current = path;
  for (;;) {
    let real: string;
    try {
      real = realpathSync(current);
    } catch (err) {
      if (errCode(err) !== "ENOENT") return true;
      try {
        lstatSync(current);
        return true; // exists as a dangling symlink
      } catch (lerr) {
        if (errCode(lerr) !== "ENOENT") return true;
      }
      const parent = dirname(current);
      if (parent === current) return true;
      current = parent;
      continue;
    }
    // The path itself must be strictly under the home; an existing ancestor may be the home.
    return current === path
      ? !isStrictlyUnder(real, realHome)
      : real !== realHome && !isStrictlyUnder(real, realHome);
  }
}

/** Test seams for `loadSeat` (internal): a hook after the realpath check, and `openNoFollow`'s. */
export type LoadSeatTestOptions = OpenNoFollowOptions & { afterRealpath?: () => void };

/**
 * Resolve and validate `seats/<seatId>.json` (seat pin §2 resolution):
 * - invalid id → -32602 (before any path join);
 * - missing file → -32005 `{ seatId, path }`;
 * - unreadable / not JSON / schema failure / path escaping `$MADC_HOME` (seat file or
 *   `memory.path`) / a kimi-code `pinnedModel` that the pinned pi-ai catalog does not resolve
 *   → -32006 `{ seatId, path, issues }`.
 */
export function loadSeat(home: string, seatId: string, opts: LoadSeatTestOptions = {}): LoadedSeat {
  if (!isValidId(seatId)) {
    throw invalidParams(["seatId must match ^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$"]);
  }
  const path = seatFilePath(home, seatId);
  const invalid = (issues: string[]) => seatInvalid(seatId, path, issues);
  try {
    lstatSync(path);
  } catch (err) {
    if (errCode(err) === "ENOENT") throw seatNotFound(seatId, path);
    throw invalid([`seat file is unreadable (${errCode(err) ?? "error"})`]);
  }
  let realHome: string;
  let realFile: string;
  try {
    realHome = realpathSync(home);
    realFile = realpathSync(path);
  } catch (err) {
    throw invalid([`seat file does not resolve (${errCode(err) ?? "error"})`]);
  }
  if (!isStrictlyUnder(realFile, realHome)) {
    throw invalid(["seat file resolves outside MADC_HOME"]);
  }
  opts.afterRealpath?.();
  // Read through one fd opened without following a symlink (lock.ts `openNoFollow`), then require
  // that the resolved path still has no symlinks and still names that same inode (dev + ino), so a
  // swap after the realpath check is refused and the checked file is the one parsed.
  const changed = () => invalid(["seat file changed while it was being read"]);
  let text: string;
  let fd: number | null | "symlink" = null;
  try {
    fd = openNoFollow(realFile, opts);
    if (fd === null || fd === "symlink") throw changed();
    const st = fstatSync(fd, { bigint: true });
    if (!st.isFile()) throw invalid(["seat file is not a regular file"]);
    const now = lstatSync(realFile, { bigint: true });
    if (realpathSync(realFile) !== realFile || now.dev !== st.dev || now.ino !== st.ino) {
      throw changed();
    }
    if (st.size > BigInt(MAX_SEAT_BYTES)) {
      throw invalid([`seat file exceeds ${MAX_SEAT_BYTES} bytes`]);
    }
    text = readFileSync(fd, "utf8");
  } catch (err) {
    if (err instanceof RpcError) throw err;
    throw invalid([`seat file is unreadable (${errCode(err) ?? "error"})`]);
  } finally {
    if (typeof fd === "number") closeSync(fd);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw invalid(["seat file is not valid JSON"]);
  }
  const result = validateSeat(raw, seatId);
  if (!result.ok) throw invalid(result.issues);
  const { seat } = result;
  if (seat.preferredBacking === KIMI_CODE_PROVIDER_ID) {
    // Validated at load against the pinned catalog (never remapped); vendor-agent backings name
    // vendor models, which their adapters (A5 / A6) validate.
    const model = resolveKimiPinnedModel(seat.pinnedModel);
    if (!model.ok) throw invalid([model.issue]);
  }
  if (seat.memory.mode === "file") {
    // Lexically confined already; also refuse a memory dir / file that resolves outside the home.
    const memoryPath = join(home, seat.memory.path);
    if (escapesHome(realHome, join(home, "memory")) || escapesHome(realHome, memoryPath)) {
      throw invalid(["memory.path resolves outside MADC_HOME"]);
    }
  }
  return { seat, path };
}
