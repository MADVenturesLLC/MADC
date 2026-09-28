/** Tier detection matrix (DESIGN-SPEC rev 6.2 §3.3, §3.4) — pure, captured dimensions. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { asciiForced, colorDepth, decideAppTier, decideTier } from "./tiers.ts";

const tty = {
  stdoutIsTTY: true,
  stderrIsTTY: true,
  stdinIsTTY: true,
  columns: 110,
  rows: 32,
};
const env = (
  over: Record<string, string | undefined> = {},
): Record<string, string | undefined> => ({
  TERM: "xterm-256color",
  ...over,
});

describe("§3.3 colour rules (first match wins)", () => {
  it("rule 1: --json → tier P, no SGR, no chrome", () => {
    const d = decideTier({ ...tty, env: env(), json: true, human: true });
    assert.equal(d.tier, "P");
    assert.equal(d.depth, "none");
  });
  it("rule 2: a failed both-TTY gate → tier P", () => {
    const d = decideTier({ ...tty, stderrIsTTY: false, env: env(), json: false, human: true });
    assert.equal(d.tier, "P");
  });
  it("rule 3: NO_COLOR (any value, including empty) → zero SGR in every tier", () => {
    for (const value of ["1", "", "0"]) {
      const d = decideTier({ ...tty, env: env({ NO_COLOR: value }), json: false, human: true });
      assert.equal(d.depth, "none", `NO_COLOR=${JSON.stringify(value)}`);
      assert.equal(d.tier, "W"); // layout stays; only the SGR is gone
    }
  });
  it("rule 4: TERM exactly dumb → tier P for -p/doctor, zero SGR", () => {
    const d = decideTier({ ...tty, env: env({ TERM: "dumb" }), json: false, human: true });
    assert.equal(d.tier, "P");
    assert.equal(d.depth, "none");
  });
  it("rule 5: FORCE_COLOR is never honoured", () => {
    const d = decideTier({
      ...tty,
      env: env({ NO_COLOR: "1", FORCE_COLOR: "3" }),
      json: false,
      human: true,
    });
    assert.equal(d.depth, "none");
  });
  it("rule 6: COLORTERM truecolor/24bit → true", () => {
    for (const v of ["truecolor", "24bit"]) {
      assert.equal(colorDepth(env({ COLORTERM: v })), "true");
    }
  });
  it("rule 7: TERM containing 256color → 256 index", () => {
    assert.equal(colorDepth(env()), "256");
  });
  it("rule 8: otherwise the 16-colour table", () => {
    assert.equal(colorDepth(env({ TERM: "vt100" })), "16");
  });
});

describe("§3.4 tier A conditions", () => {
  it("(a) below 80 columns or 24 rows → A with the reason", () => {
    const d = decideTier({
      ...tty,
      columns: 72,
      rows: 20,
      env: env({ TERM: "vt100" }),
      json: false,
      human: true,
    });
    assert.equal(d.tier, "A");
    assert.equal(d.lineModeWhy, "72×20 < 80×24");
  });
  it("undefined dimensions count as below", () => {
    const d = decideTier({
      ...tty,
      columns: undefined,
      rows: undefined,
      env: env({ TERM: "vt100" }),
      json: false,
      human: true,
    });
    assert.equal(d.tier, "A");
    assert.equal(d.lineModeWhy, "0×0 < 80×24");
  });
  it("(b) TERM unset or empty → A", () => {
    const d = decideTier({ ...tty, env: env({ TERM: undefined }), json: false, human: true });
    assert.equal(d.tier, "A");
    assert.equal(d.lineModeWhy, "TERM unset");
  });
  it("(c) MADC_UI=lines → A", () => {
    const d = decideTier({
      ...tty,
      env: env({ TERM: "vt100", MADC_UI: "lines" }),
      json: false,
      human: true,
    });
    assert.equal(d.tier, "A");
    assert.equal(d.lineModeWhy, "MADC_UI=lines");
  });
  it("(d) win32 without VT_SESSION → A; with WT_SESSION → W", () => {
    const a = decideTier({
      ...tty,
      platform: "win32",
      env: env({ TERM: "vt100" }),
      json: false,
      human: true,
    });
    assert.equal(a.tier, "A");
    const w = decideTier({
      ...tty,
      platform: "win32",
      env: env({ TERM: "vt100", WT_SESSION: "x" }),
      json: false,
      human: true,
    });
    assert.equal(w.tier, "W");
  });
  it("everything else is tier W", () => {
    const d = decideTier({ ...tty, env: env({ TERM: "vt100" }), json: false, human: true });
    assert.equal(d.tier, "W");
  });
});

describe("§5.0 app gate", () => {
  it("all three TTYs → W; stderr not a TTY → P (no app, today's bytes)", () => {
    const ok = decideAppTier({ ...tty, env: env({ TERM: "vt100" }) });
    assert.equal(ok.tier, "W");
    const noStderr = decideAppTier({ ...tty, stderrIsTTY: false, env: env({ TERM: "vt100" }) });
    assert.equal(noStderr.tier, "P");
    const noStdin = decideAppTier({ ...tty, stdinIsTTY: false, env: env({ TERM: "vt100" }) });
    assert.equal(noStdin.tier, "P");
  });
  it("TERM=dumb → line mode with zero SGR and ASCII", () => {
    const d = decideAppTier({ ...tty, env: env({ TERM: "dumb" }) });
    assert.equal(d.tier, "A");
    assert.equal(d.depth, "none");
    assert.equal(d.ascii, true);
  });
  it("MADC_UI=lines on a big terminal → A (the opt-out)", () => {
    const d = decideAppTier({ ...tty, env: env({ TERM: "vt100", MADC_UI: "lines" }) });
    assert.equal(d.tier, "A");
    assert.equal(d.lineModeWhy, "MADC_UI=lines");
  });
  it("any MADC_UI value other than lines does not select line mode", () => {
    const d = decideAppTier({ ...tty, env: env({ TERM: "vt100", MADC_UI: "LINE" }) });
    assert.equal(d.tier, "W");
  });
});

describe("§4 ASCII fallback", () => {
  it("TERM=dumb, MADC_ASCII=1, or a non-UTF-8 locale forces ASCII chrome", () => {
    assert.equal(asciiForced(env({ TERM: "dumb" })), true);
    assert.equal(asciiForced(env({ MADC_ASCII: "1" })), true);
    assert.equal(asciiForced(env({ LANG: "C" })), true);
    assert.equal(asciiForced(env({ LC_ALL: "en_US.UTF-8" })), false);
    assert.equal(asciiForced(env({ LC_CTYPE: "utf8" })), false);
    assert.equal(asciiForced({}), true); // no locale evidence
    // MADC_ASCII only when exactly 1 (IQW-12); any other value counts as unset.
    assert.equal(asciiForced(env({ MADC_ASCII: "0", LC_ALL: "en_US.UTF-8" })), false);
  });
});
