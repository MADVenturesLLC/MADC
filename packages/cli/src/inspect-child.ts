/**
 * Child process for `madc doctor`'s MADC_HOME-reading work (CLI pin §3: every check has a hard
 * timeout). The `seat`, `session` and `locks` rows and `--init`'s seat hash are synchronous file
 * reads, so the parent runs them here under a deadline it enforces by killing this process.
 * Read-only: prints one JSON value (rows carry no event bodies, lock tokens or credentials).
 *   inspect-child rows <HomeState JSON>   → Check[] for seat, session, locks
 *   inspect-child init-sha <home>         → seat sha256 or null
 */
import { initSeatSha, localRows } from "./doctor.ts";

const [mode, arg] = process.argv.slice(2);
if (mode === "rows" && arg !== undefined) {
  process.stdout.write(`${JSON.stringify(localRows(JSON.parse(arg)))}\n`);
} else if (mode === "init-sha" && arg !== undefined) {
  process.stdout.write(`${JSON.stringify(initSeatSha(arg))}\n`);
} else {
  process.stderr.write("usage: inspect-child rows <home-json> | init-sha <home>\n");
  process.exit(2);
}
