/**
 * I1 (D-M1-6): the pinned registry freshness clock for tests. One source of truth for the value,
 * the env name that carries it to spawned engines, and the one-line application.
 *
 * The engine's turn-time preflight now enforces D-M1-6 (`assertAllowed` receives `now`), so every
 * engine or CLI test that serves a turn needs a clock INSIDE the catalog's freshness window
 * (`verifiedAt` 2026-09-24 + 30 days) — otherwise the suites fail en masse the day the real clock
 * crosses ~2026-10-24 ET. The pin is a fixed instant inside that window.
 *
 * Application: this module's loader sets the env when it is not already set, so a test that needs
 * a different instant overrides `process.env` (or passes the engine option) AFTER importing —
 * and any test that manufactures a stale entry pins a far-future instant explicitly.
 */
export const REGISTRY_TEST_NOW_MS = Date.parse("2026-10-01T00:00:00.000Z");

/** The env name the pinned clock travels under (the engine reads it in provider-agent.ts). */
export const REGISTRY_TEST_NOW_ENV = "MADC_TEST_REGISTRY_NOW";

/** Set the pin unless the process already carries one (an explicit test override wins). */
export function applyRegistryTestClock(): void {
  const current = process.env[REGISTRY_TEST_NOW_ENV];
  if (current === undefined || current === "") {
    process.env[REGISTRY_TEST_NOW_ENV] = String(REGISTRY_TEST_NOW_MS);
  }
}

applyRegistryTestClock();
