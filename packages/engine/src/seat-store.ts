/**
 * Seat files under `$MADC_HOME/seats/` (seat pin §1–§3): the seed writer (shared with
 * `madc doctor --init`, A7) and the confined, validated loader used by `thread/start`.
 */
import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { KIMI_CODE_PROVIDER_ID, resolveKimiPinnedModel } from "@madc/adapters";
import { enforcePrivateDir, isStrictlyUnder } from "./home.ts";
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

/** Exact seed bytes for a seat: 2-space JSON plus a trailing newline. */
export function serializeSeat(seat: EngineSeat): string {
  return `${JSON.stringify(seat, null, 2)}\n`;
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
 * The file is created with `O_EXCL`, so an existing file (or a concurrent seeder) is never
 * overwritten. One source of seed content: the engine start and `madc doctor --init` both call this.
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
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
  } catch (err) {
    if (errCode(err) === "EEXIST") return { path, created: false };
    throw err;
  }
  try {
    const bytes = Buffer.from(serializeSeat(MADC_DEFAULT_SEAT), "utf8");
    let off = 0;
    while (off < bytes.length) off += writeSync(fd, bytes, off, bytes.length - off);
  } finally {
    closeSync(fd);
  }
  return { path, created: true };
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

/**
 * Resolve and validate `seats/<seatId>.json` (seat pin §2 resolution):
 * - invalid id → -32602 (before any path join);
 * - missing file → -32005 `{ seatId, path }`;
 * - unreadable / not JSON / schema failure / path escaping `$MADC_HOME` (seat file or
 *   `memory.path`) / a kimi-code `pinnedModel` that the pinned pi-ai catalog does not resolve
 *   → -32006 `{ seatId, path, issues }`.
 */
export function loadSeat(home: string, seatId: string): LoadedSeat {
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
  let text: string;
  try {
    const st = statSync(realFile);
    if (!st.isFile()) throw invalid(["seat file is not a regular file"]);
    if (st.size > MAX_SEAT_BYTES) throw invalid([`seat file exceeds ${MAX_SEAT_BYTES} bytes`]);
    text = readFileSync(realFile, "utf8");
  } catch (err) {
    if (err instanceof RpcError) throw err;
    throw invalid([`seat file is unreadable (${errCode(err) ?? "error"})`]);
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
