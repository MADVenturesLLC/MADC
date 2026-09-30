/**
 * Render tiers (DESIGN-SPEC rev 6.2 §3.3, §3.4): every output is placed in one tier at startup.
 * Pure detection: no I/O, so tests drive it with captured terminal dimensions and env maps.
 *
 * - P (plain): --json, a failed TTY gate, or TERM exactly dumb → today's bytes, zero SGR.
 * - A (Level A fallback): the gate passes but the terminal is below 80×24, TERM is unset or
 *   empty, MADC_UI=lines opts out, or a Windows console without VT → pinned lines + §6.2 SGR.
 * - W (Witness): everything else → the full layout; colour depth per §3.3 rows 6–8.
 *
 * The first rule of §3.3 wins: --json; TTY gate; NO_COLOR (any value); TERM exactly dumb;
 * FORCE_COLOR is never honoured; COLORTERM truecolor/24bit → truecolor; TERM containing
 * 256color → 256 index; otherwise the 16-colour table.
 */

export type ColorDepth = "none" | "16" | "256" | "true";
export type Tier = "P" | "A" | "W";

export type TierInput = {
  /** The gate inputs (§3.3 rule 2). A check that fails or is unclear counts as not a TTY. */
  readonly stdoutIsTTY: boolean;
  readonly stderrIsTTY: boolean;
  readonly stdinIsTTY: boolean;
  /** columns/rows of the output stream; undefined counts as below 80×24 (§3.4 a). */
  readonly columns: number | undefined;
  readonly rows: number | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
};

export type TierDecision = {
  readonly tier: Tier;
  readonly depth: ColorDepth;
  /** Chrome glyph set: ASCII per §4 (TERM=dumb, non-UTF-8 locale, or MADC_ASCII=1). */
  readonly ascii: boolean;
  /** Set for tier A: the reason recorded on the line-mode identity line (§6.3). */
  readonly lineModeWhy: string | null;
};

/** §4: the ASCII fallback triggers on TERM=dumb, a locale that does not name UTF-8, or MADC_ASCII=1. */
export function asciiForced(env: Readonly<Record<string, string | undefined>>): boolean {
  if (env.TERM === "dumb") return true;
  if (env.MADC_ASCII === "1") return true;
  const locale = env.LC_ALL ?? env.LC_CTYPE ?? env.LANG;
  if (locale === undefined || locale === "") return true;
  return !/UTF-?8/i.test(locale);
}

/** §3.3 colour rules 6–8 (only reached when NO_COLOR and TERM=dumb did not apply). */
export function colorDepth(
  env: Readonly<Record<string, string | undefined>>,
): Exclude<ColorDepth, "none"> {
  const colorterm = env.COLORTERM;
  if (colorterm === "truecolor" || colorterm === "24bit") return "true";
  if ((env.TERM ?? "").includes("256color")) return "256";
  return "16";
}

/**
 * Tier for the one-shot and doctor stdout rows (gates (a)/(b): stderr lines need BOTH TTYs,
 * doctor's stdout rows need stdout). `human` selects the both-TTY gate (RQ-1) vs stdout only.
 */
export function decideTier(
  input: TierInput & { readonly json: boolean; readonly human: boolean },
): TierDecision {
  const gatePasses = input.human ? input.stdoutIsTTY && input.stderrIsTTY : input.stdoutIsTTY;
  const ascii = asciiForced(input.env);
  const noColor = input.env.NO_COLOR !== undefined;
  if (input.json || !gatePasses || input.env.TERM === "dumb") {
    return { tier: "P", depth: "none", ascii, lineModeWhy: null };
  }
  const why = lineModeWhy(input);
  if (why !== null) {
    // §3.3 rule 3: NO_COLOR (any value) → zero SGR, layout and words stay (IQ-16).
    return { tier: "A", depth: noColor ? "none" : colorDepth(input.env), ascii, lineModeWhy: why };
  }
  return { tier: "W", depth: noColor ? "none" : colorDepth(input.env), ascii, lineModeWhy: null };
}

/** §3.4 tier-A conditions (a)–(d) for the app and -p; the reason, or null for tier W. */
export function lineModeWhy(
  input: Pick<TierInput, "columns" | "rows" | "env" | "platform">,
): string | null {
  const cols = input.columns ?? 0;
  const rows = input.rows ?? 0;
  if (cols < 80 || rows < 24) return `${cols}×${rows} < 80×24`;
  const term = input.env.TERM;
  if (term === undefined || term === "") return "TERM unset";
  if (input.env.MADC_UI === "lines") return "MADC_UI=lines";
  if (input.platform === "win32" && input.env.WT_SESSION === undefined) {
    return "no VT";
  }
  return null;
}

/**
 * The app's own gate (§5.0, IQW-1): stdin, stdout and stderr must all be TTYs or the app does
 * not start at all. The line-mode app runs when the gate passes but a tier-A condition holds.
 */
export function decideAppTier(input: TierInput): TierDecision {
  const gatePasses = input.stdinIsTTY && input.stdoutIsTTY && input.stderrIsTTY;
  const ascii = asciiForced(input.env);
  if (input.env.TERM === "dumb") {
    // §5.0: line mode with zero SGR and the ASCII prompt.
    return { tier: "A", depth: "none", ascii: true, lineModeWhy: "TERM=dumb" };
  }
  if (!gatePasses) {
    return { tier: "P", depth: "none", ascii, lineModeWhy: null };
  }
  const why = lineModeWhy(input);
  if (why !== null) {
    return {
      tier: "A",
      depth: input.env.NO_COLOR !== undefined ? "none" : colorDepth(input.env),
      ascii,
      lineModeWhy: why,
    };
  }
  return {
    tier: "W",
    depth: input.env.NO_COLOR !== undefined ? "none" : colorDepth(input.env),
    ascii,
    lineModeWhy: null,
  };
}
