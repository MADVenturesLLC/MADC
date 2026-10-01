/**
 * `madc providers ls [--json]` and `madc seats ls [--json]` (M1-A8, plan §7; protocol pin §3.5).
 * Both are one read-only request on a spawned engine (`rpc-call.ts`); the CLI holds no lane or
 * seat logic of its own.
 *
 * - `providers ls` reads `provider/list` from an engine on a throwaway home (`lanes.ts`) and prints
 *   every registry lane: status, wired, credential / binary presence (yes / no, never a value),
 *   `verifiedAt`, terms freshness and the modes the registry lets it serve.
 * - `seats ls` reads `seat/list` from an engine on the real `$MADC_HOME` (an engine start seeds the
 *   roster there, as for any session) and prints every seat — a seat whose file does not load is
 *   listed with its error, never hidden (M1-A7), and every never-eligible same-lane fallback
 *   (D-M1-7) is printed as a warning.
 *
 * `--json` prints exactly one object whose shape is locked by test; human output is plain text
 * with every engine- or file-sourced string stripped of control bytes. Exit codes follow CLI pin §4:
 * 0 listed (broken seats and stale lanes are reported, not failures), 2 usage / `MADC_HOME`,
 * 3 engine, 130 / 143 interrupted.
 */
import { MADC_VERSION } from "@madc/core";
import {
  isValidId,
  PROTOCOL_VERSION,
  resolveMadcHome,
  type SeatSummary,
} from "@madc/engine/client";
import { stripControls } from "./app/sanitize.ts";
import { classifyHomePath } from "./doctor.ts";
import { takeEarlySignal } from "./early-signal.ts";
import { type ErrorClass, EXIT } from "./exit-codes.ts";
import type { CliIO } from "./io.ts";
import { fetchLanes, renderLaneTable, staleDeniedLine } from "./lanes.ts";
import { callEngineOnce, type EngineCallSignal } from "./rpc-call.ts";

/** Keychain probes are capped at 10 s each engine-side and run in parallel; start + list must fit. */
const LIST_BUDGET_MS = 20_000;

type ListSignal = EngineCallSignal & { exit: number | null };

function installSignals(): { sig: ListSignal; remove: () => void } {
  const sig: ListSignal = { exit: null, kill: null };
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

type ListKind = "providers" | "seats";

/** The one `--json` object for a failed listing: the same keys as success, the list `null`. */
function failureJson(
  kind: ListKind,
  exitCode: number,
  error: { code: number | null; message: string; class: ErrorClass },
  home: string | null,
): string {
  const base = {
    ok: false,
    exitCode,
    madcVersion: MADC_VERSION,
    protocolVersion: PROTOCOL_VERSION,
  };
  const body =
    kind === "providers"
      ? { ...base, providers: null, error }
      : { ...base, home, seats: null, error };
  return `${JSON.stringify(body)}\n`;
}

function fail(
  io: CliIO,
  json: boolean,
  kind: ListKind,
  exitCode: number,
  error: { code: number | null; message: string; class: ErrorClass },
  home: string | null = null,
): number {
  if (json) io.stdout.write(failureJson(kind, exitCode, error, home));
  else io.stderr.write(`madc: ${kind} ls: ${stripControls(error.message)}\n`);
  return exitCode;
}

function interrupted(
  io: CliIO,
  json: boolean,
  kind: ListKind,
  code: number,
  home: string | null = null,
): number {
  if (!json) {
    io.stderr.write("madc: interrupted by signal\n");
    return code;
  }
  const error = { code: null, message: "interrupted by signal", class: "interrupted" as const };
  return fail(io, true, kind, code, error, home);
}

// ------------------------------------------------------------------------ providers ls

export async function runProvidersLs(io: CliIO, json: boolean): Promise<number> {
  const early = takeEarlySignal();
  if (early !== null) return interrupted(io, json, "providers", early);
  const { sig, remove } = installSignals();
  try {
    const r = await fetchLanes(io, { clientName: "madc-providers", budgetMs: LIST_BUDGET_MS, sig });
    if (sig.exit !== null) return interrupted(io, json, "providers", sig.exit);
    if (!r.ok) {
      return fail(io, json, "providers", r.exit, {
        code: r.code,
        message: r.reason,
        class: r.class,
      });
    }
    if (json) {
      io.stdout.write(
        `${JSON.stringify({
          ok: true,
          exitCode: EXIT.ok,
          madcVersion: MADC_VERSION,
          protocolVersion: PROTOCOL_VERSION,
          providers: r.rows,
          error: null,
        })}\n`,
      );
      return EXIT.ok;
    }
    for (const line of renderLaneTable(r.rows)) io.stdout.write(`${line}\n`);
    const stale = staleDeniedLine(r.rows);
    if (stale !== null) io.stdout.write(`warning: ${stale}\n`);
    return EXIT.ok;
  } finally {
    remove();
  }
}

// ------------------------------------------------------------------------ seats ls

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

/**
 * Strict read of a `seat/list` result against the M1-A7 `SeatSummary` projection. Only the
 * projection's fields are copied (in a fixed key order, which the `--json` schema test locks), so
 * nothing else the engine might send — and nothing from a seat file outside the projection, such
 * as `standingInstructions` — can be printed. `null` = malformed (a protocol violation).
 */
export function parseSeatList(result: unknown): SeatSummary[] | null {
  if (!isRecord(result) || !Array.isArray(result.data)) return null;
  const out: SeatSummary[] = [];
  for (const raw of result.data as unknown[]) {
    if (!isRecord(raw) || !isValidId(raw.id) || typeof raw.path !== "string") return null;
    if (raw.ok === false) {
      if (!Number.isInteger(raw.code) || !isStringArray(raw.issues)) return null;
      out.push({
        id: raw.id,
        ok: false,
        path: raw.path,
        code: raw.code as number,
        issues: [...raw.issues],
      });
      continue;
    }
    if (raw.ok !== true) return null;
    const { version, displayName, role, pinnedModel, preferredBacking, fallbacks } = raw;
    const { memory, tools, policy, warnings } = raw;
    if (version !== 1 && version !== 2) return null;
    if (displayName !== null && typeof displayName !== "string") return null;
    if (typeof role !== "string" || typeof pinnedModel !== "string") return null;
    if (typeof preferredBacking !== "string" || !isStringArray(fallbacks)) return null;
    if (!isRecord(memory) || !isRecord(tools) || !isRecord(policy)) return null;
    if (!isStringArray(tools.deny) || typeof policy.headlessOk !== "boolean") return null;
    if (!isStringArray(warnings)) return null;
    let mem: { mode: "file"; path: string } | { mode: "in-session" };
    if (memory.mode === "file" && typeof memory.path === "string") {
      mem = { mode: "file", path: memory.path };
    } else if (memory.mode === "in-session") {
      mem = { mode: "in-session" };
    } else {
      return null;
    }
    out.push({
      id: raw.id,
      ok: true,
      path: raw.path,
      version,
      displayName,
      role,
      pinnedModel,
      preferredBacking,
      fallbacks: [...fallbacks],
      memory: mem,
      tools: { deny: [...tools.deny] },
      policy: { headlessOk: policy.headlessOk },
      warnings: [...warnings],
    });
  }
  return out;
}

/**
 * The human seats table plus one line per warning and per broken seat. Every seat-file-sourced
 * string is stripped of control bytes (a tampered seat must not inject terminal sequences).
 */
export function renderSeatsTable(seats: readonly SeatSummary[]): string[] {
  const clean = (s: string): string => stripControls(s);
  const header = ["SEAT", "VERSION", "BACKING", "MODEL", "FALLBACKS", "HEADLESS", "STATE"];
  const cells = seats.map((s) =>
    s.ok
      ? [
          s.id,
          String(s.version),
          clean(s.preferredBacking),
          clean(s.pinnedModel),
          s.fallbacks.length === 0 ? "-" : s.fallbacks.map(clean).join(", "),
          s.policy.headlessOk ? "yes" : "no",
          s.warnings.length === 0
            ? "ok"
            : `ok · ${s.warnings.length} warning${s.warnings.length === 1 ? "" : "s"}`,
        ]
      : [s.id, "-", "-", "-", "-", "-", `error ${s.code}`],
  );
  const widths = header.map((h, i) => Math.max(h.length, ...cells.map((c) => (c[i] ?? "").length)));
  const line = (c: readonly string[]): string =>
    c.map((cell, i) => (i === c.length - 1 ? cell : cell.padEnd(widths[i] ?? 0))).join("  ");
  const out = [line(header), ...cells.map(line)];
  for (const s of seats) {
    if (s.ok) {
      // The engine's warning already names the seat ("seat <id>: fallback …", seat load).
      for (const w of s.warnings) out.push(`warning: ${clean(w)}`);
    } else {
      const issues = s.issues.length === 0 ? "" : ` ${s.issues.map(clean).join("; ")}`;
      out.push(`error: ${s.id} (${clean(s.path)}): ${s.code}${issues}`);
    }
  }
  return out;
}

export async function runSeatsLs(io: CliIO, json: boolean): Promise<number> {
  const early = takeEarlySignal();
  if (early !== null) return interrupted(io, json, "seats", early);
  // MADC_HOME: the same resolver and classifier as the one-shot (exit 2 before anything spawns).
  let home: string;
  try {
    home = resolveMadcHome(io.env as NodeJS.ProcessEnv);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(io, json, "seats", EXIT.usage, { code: null, message, class: "usage" });
  }
  const state = classifyHomePath(home);
  if (state.kind === "not-directory" || state.kind === "invalid") {
    const message =
      state.kind === "invalid" ? state.message : `MADC_HOME ${home} exists but is not a directory`;
    return fail(io, json, "seats", EXIT.usage, { code: null, message, class: "usage" }, home);
  }
  const { sig, remove } = installSignals();
  try {
    const r = await callEngineOnce(io, {
      env: { MADC_HOME: home },
      clientName: "madc-seats",
      method: "seat/list",
      budgetMs: LIST_BUDGET_MS,
      sig,
    });
    if (sig.exit !== null) return interrupted(io, json, "seats", sig.exit, home);
    if (!r.ok) {
      return fail(
        io,
        json,
        "seats",
        r.exit,
        { code: r.code, message: r.reason, class: r.class },
        home,
      );
    }
    const seats = parseSeatList(r.result);
    if (seats === null) {
      return fail(
        io,
        json,
        "seats",
        EXIT.engine,
        {
          code: null,
          message: "protocol violation: seat/list returned a malformed payload",
          class: "engine",
        },
        home,
      );
    }
    if (json) {
      io.stdout.write(
        `${JSON.stringify({
          ok: true,
          exitCode: EXIT.ok,
          madcVersion: MADC_VERSION,
          protocolVersion: PROTOCOL_VERSION,
          home,
          seats,
          error: null,
        })}\n`,
      );
      return EXIT.ok;
    }
    for (const line of renderSeatsTable(seats)) io.stdout.write(`${line}\n`);
    return EXIT.ok;
  } finally {
    remove();
  }
}
