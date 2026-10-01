/**
 * The lanes report (M1-A8, plan §7 and criterion H) shared by `madc providers ls` and doctor's
 * `lanes` row. One source of truth per fact:
 *
 * - presence, `verifiedAt` and `stale` come from the engine's `provider/list` (protocol pin §3.5):
 *   the CLI never probes a keychain or a PATH for a lane itself;
 * - the modes a lane can serve and whether it carries a Founder override come from the pure
 *   registry catalog (`canServe`, `founderOverride`), never from a second copy of that policy here.
 *
 * Presence is printed as yes / no only: never a credential value, its length, a prefix or a hash
 * (the engine sends nothing else, and only the fields below are ever copied out of its answer).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canServe,
  DEFAULT_STALE_DAYS,
  isValidId,
  listCatalog,
  type ProviderEntry,
  type ProviderStatus,
  type ProviderSummary,
} from "@madc/engine/client";
import { EXIT } from "./exit-codes.ts";
import type { CliIO } from "./io.ts";
import { callEngineOnce, type EngineCallFailure, type EngineCallSignal } from "./rpc-call.ts";

export type LaneMode = "interactive" | "headless";

/**
 * One lane as `providers ls --json` and doctor's `lanes` evidence carry it. Keys and order are
 * fixed (the `--json` schema is locked by test); both presence keys are always present, `null`
 * where that kind of presence does not apply to the lane.
 */
export type LaneRow = {
  readonly id: string;
  readonly status: ProviderStatus;
  readonly wired: boolean;
  /** ISO date the terms were last read; `""` = never verified. */
  readonly verifiedAt: string;
  /** Older than the registry freshness window (30 days, M1-A1), as the engine judged it. */
  readonly stale: boolean;
  /** The registry entry carries a per-entry Founder override (D-M1-6). */
  readonly founderOverride: boolean;
  /**
   * The registry's freshness rule denies this lane (D-M1-6): an allow entry that is stale and has
   * no Founder override. `forbidden` entries are denied regardless and are never counted here.
   */
  readonly staleDenied: boolean;
  /** Direct-key lanes: a credential is stored. `null` on every other kind of lane. */
  readonly credentialsPresent: boolean | null;
  /** Vendor-agent lanes this build has an adapter for: the binary is on PATH. Else `null`. */
  readonly binaryPresent: boolean | null;
  /** The modes the registry lets this lane serve (`canServe`), in the order interactive, headless. */
  readonly modes: readonly LaneMode[];
};

const STATUSES: ReadonlySet<string> = new Set([
  "allowed-direct",
  "allowed-via-vendor-agent",
  "interactive-only",
  "forbidden",
]);
const VERIFIED_AT = /^(?:\d{4}-\d{2}-\d{2})?$/;
const MODES: readonly LaneMode[] = ["interactive", "headless"];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Strict read of a `provider/list` result against the catalog it must cover (protocol pin §3.5,
 * §5): `{ data: ProviderSummary[] }` with exactly one entry per catalog entry, same ids in catalog
 * order, each entry's `status` / `wired` / `verifiedAt` equal to the catalog's, and presence only
 * where the lane's `connect` kind allows it — `credentialsPresent` on (every) `direct` lane,
 * `binaryPresent` only on `vendor-agent` lanes, never both. Anything else is `null` (a protocol
 * violation for the caller), so a partial, reordered or stale answer is never shown as a complete
 * report and no lane ever shows a presence fact it cannot have. Only the pinned fields are copied,
 * so nothing the engine might add could ever be printed. `catalog` defaults to the registry's own.
 */
export function parseProviderList(
  result: unknown,
  catalog: readonly ProviderEntry[] = listCatalog(),
): ProviderSummary[] | null {
  if (!isRecord(result) || !Array.isArray(result.data)) return null;
  const data = result.data as unknown[];
  if (data.length !== catalog.length) return null;
  const out: ProviderSummary[] = [];
  for (const [i, raw] of data.entries()) {
    const entry = catalog[i];
    if (entry === undefined || !isRecord(raw)) return null;
    const { id, status, wired, verifiedAt, stale, credentialsPresent, binaryPresent } = raw;
    if (!isValidId(id) || id !== entry.id) return null;
    if (typeof status !== "string" || !STATUSES.has(status) || status !== entry.status) return null;
    if (typeof wired !== "boolean" || wired !== entry.wired) return null;
    if (typeof stale !== "boolean") return null;
    if (typeof verifiedAt !== "string" || !VERIFIED_AT.test(verifiedAt)) return null;
    if (verifiedAt !== entry.verifiedAt) return null;
    // Every direct lane reports credential presence (the engine always probes it).
    if ((credentialsPresent === undefined) !== (entry.connect !== "direct")) return null;
    if (credentialsPresent !== undefined && typeof credentialsPresent !== "boolean") return null;
    if (binaryPresent !== undefined) {
      if (typeof binaryPresent !== "boolean" || entry.connect !== "vendor-agent") return null;
    }
    out.push({
      id,
      status: status as ProviderStatus,
      wired,
      verifiedAt,
      stale,
      ...(credentialsPresent !== undefined ? { credentialsPresent } : {}),
      ...(binaryPresent !== undefined ? { binaryPresent } : {}),
    });
  }
  return out;
}

/**
 * Join the engine's summaries with the pure catalog: modes and Founder overrides (see top).
 * `catalog` is the registry's own; tests pass a synthetic one (no shipped entry has an override).
 */
export function laneRows(
  summaries: readonly ProviderSummary[],
  catalog: readonly ProviderEntry[] = listCatalog(),
): LaneRow[] {
  return summaries.map((s) => {
    const entry = catalog.find((e) => e.id === s.id);
    const founderOverride = entry?.founderOverride !== undefined;
    return {
      id: s.id,
      status: s.status,
      wired: s.wired,
      verifiedAt: s.verifiedAt,
      stale: s.stale,
      founderOverride,
      staleDenied: s.stale && s.status !== "forbidden" && !founderOverride,
      credentialsPresent: s.credentialsPresent ?? null,
      binaryPresent: s.binaryPresent ?? null,
      modes: entry === undefined ? [] : MODES.filter((m) => canServe(entry, m)),
    };
  });
}

export const staleDeniedIds = (rows: readonly LaneRow[]): string[] =>
  rows.filter((r) => r.staleDenied).map((r) => r.id);

function presentCell(r: LaneRow): string {
  if (r.credentialsPresent !== null) return `creds ${r.credentialsPresent ? "yes" : "no"}`;
  if (r.binaryPresent !== null) return `binary ${r.binaryPresent ? "yes" : "no"}`;
  return "-";
}

function termsCell(r: LaneRow): string {
  if (!r.stale) return "fresh";
  if (r.staleDenied) return "stale: denied";
  if (r.status === "forbidden") return "stale";
  return "stale: override";
}

/**
 * The lanes table: one header line and one line per lane, plain text (no colour, no control
 * bytes — every cell is a validated id, enum, date or fixed word). Columns size to their content.
 */
export function renderLaneTable(rows: readonly LaneRow[]): string[] {
  const header = ["LANE", "STATUS", "WIRED", "PRESENT", "VERIFIED", "TERMS", "SERVES"];
  const cells = rows.map((r) => [
    r.id,
    r.status,
    r.wired ? "yes" : "no",
    presentCell(r),
    r.verifiedAt === "" ? "never" : r.verifiedAt,
    termsCell(r),
    r.modes.length === 0 ? "none" : r.modes.join(", "),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...cells.map((c) => (c[i] ?? "").length)));
  const line = (c: readonly string[]): string =>
    c.map((cell, i) => (i === c.length - 1 ? cell : cell.padEnd(widths[i] ?? 0))).join("  ");
  return [line(header), ...cells.map(line)];
}

/** The one-line freshness verdict both surfaces print (D-M1-6 wording, ids only). */
export function staleDeniedLine(rows: readonly LaneRow[]): string | null {
  const ids = staleDeniedIds(rows);
  if (ids.length === 0) return null;
  return `terms stale (> ${DEFAULT_STALE_DAYS} days, D-M1-6): the registry denies ${ids.join(", ")} until re-verified or a Founder override is recorded`;
}

export type LanesFetch = { readonly ok: true; readonly rows: LaneRow[] } | EngineCallFailure;

/**
 * `provider/list` from an engine started on a THROWAWAY `$MADC_HOME`: the method reads nothing
 * from the home, and any engine start seeds the roster there, so a lanes report never creates or
 * touches the operator's real home. The rest of the environment is passed through unchanged, so
 * presence is what a real turn would see (keychain, `MADC_DEV_ENV_KEYS=1`, PATH). The temp dir is
 * removed afterwards.
 */
export async function fetchLanes(
  io: CliIO,
  opts: { readonly clientName: string; readonly budgetMs: number; readonly sig?: EngineCallSignal },
): Promise<LanesFetch> {
  let root: string;
  try {
    root = mkdtempSync(join(tmpdir(), "madc-lanes-"));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code ?? "error";
    return {
      ok: false,
      reason: `temp home: ${code}`,
      code: null,
      exit: EXIT.engine,
      class: "engine",
    };
  }
  try {
    const r = await callEngineOnce(io, {
      env: { MADC_HOME: join(root, "home") },
      clientName: opts.clientName,
      method: "provider/list",
      budgetMs: opts.budgetMs,
      ...(opts.sig !== undefined ? { sig: opts.sig } : {}),
    });
    if (!r.ok) return r;
    const summaries = parseProviderList(r.result);
    if (summaries === null) {
      return {
        ok: false,
        reason: "protocol violation: provider/list returned a malformed payload",
        code: null,
        exit: EXIT.engine,
        class: "engine",
      };
    }
    return { ok: true, rows: laneRows(summaries) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
