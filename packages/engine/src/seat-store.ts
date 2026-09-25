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
import { enforcePrivateDir, isStrictlyUnder } from "./home.ts";
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
 * Create `path` exclusively (0600, no-follow), write all of `bytes`, fsync. `inPlace(fd)` must hold
 * right after the open (the parent still resolves to the real `seats/` under the home, and the path
 * names the opened fd) before a byte is written; otherwise the empty file is left alone and the
 * seed fails. If anything after that fails, the partial file is removed and the error rethrown.
 */
function writeNewFile(path: string, bytes: Buffer, inPlace: (fd: number) => boolean): FileId {
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  let id: FileId | null = null;
  try {
    const st = fstatSync(fd, { bigint: true });
    if (inPlace(fd)) id = { dev: st.dev, ino: st.ino };
  } catch {
    id = null;
  }
  if (id === null) {
    closeSync(fd);
    throw new Error("seats/ under MADC_HOME changed while the seed was being written");
  }
  try {
    try {
      let off = 0;
      while (off < bytes.length) off += writeSync(fd, bytes, off, bytes.length - off);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    try {
      unlinkSync(path);
    } catch {
      // Already gone.
    }
    throw err;
  }
  return id;
}

/** Test seam (internal): hooks just before the seed's temp file is opened / linked. */
export type SeedTestHooks = { beforeOpen?: () => void; beforeLink?: () => void };
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
  for (const sub of HOME_SUBDIRS) {
    const dir = join(home, sub);
    try {
      mkdirSync(dir, { mode: 0o700 });
    } catch (err) {
      if (errCode(err) !== "EEXIST") throw err;
    }
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new Error(`${sub} under MADC_HOME must be a real directory`);
    }
    enforcePrivateDir(dir);
  }
  const path = seatFilePath(home, MADC_DEFAULT_SEAT.id);
  try {
    lstatSync(path);
    return { path, created: false };
  } catch (err) {
    if (errCode(err) !== "ENOENT") throw err;
  }
  // Every file the seed creates must sit in this real seats/ directory, strictly under the real
  // home: a seats/ swapped for a symlink after the checks above is refused before any byte is
  // written (Node has no openat, so this is checked on the opened fd, and again after the link).
  const realSeats = realpathSync(join(home, "seats"));
  if (!isStrictlyUnder(realSeats, realpathSync(home))) {
    throw new Error("seats under MADC_HOME must be a real directory");
  }
  const isAt = (p: string, id: FileId): boolean => {
    if (realpathSync(dirname(p)) !== realSeats) return false;
    const st = lstatSync(p, { bigint: true });
    return st.isFile() && st.dev === id.dev && st.ino === id.ino;
  };
  const opened = (p: string) => (fd: number) => {
    const st = fstatSync(fd, { bigint: true });
    return isAt(p, { dev: st.dev, ino: st.ino });
  };
  const bytes = Buffer.from(serializeSeat(MADC_DEFAULT_SEAT), "utf8");
  const tmp = join(
    home,
    "seats",
    `.${MADC_DEFAULT_SEAT.id}.json.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  seedHooks.beforeOpen?.();
  const tmpId = writeNewFile(tmp, bytes, opened(tmp));
  try {
    try {
      seedHooks.beforeLink?.();
      linkSync(tmp, path);
      if (!isAt(path, tmpId)) {
        throw new Error("seats/ under MADC_HOME changed while the seed was being linked");
      }
    } catch (err) {
      const code = errCode(err);
      if (code === "EEXIST") return { path, created: false };
      if (!NO_HARD_LINKS.has(code ?? "")) throw err;
      // Filesystem without hard links: exclusive create in place; a failed write removes
      // the partial file before rethrowing.
      try {
        writeNewFile(path, bytes, opened(path));
      } catch (werr) {
        if (errCode(werr) === "EEXIST") return { path, created: false };
        throw werr;
      }
    }
    return { path, created: true };
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // Best effort: a leftover dot-temp file is never read as a seat.
    }
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
