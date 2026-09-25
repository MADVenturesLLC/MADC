/**
 * Child process for `madc doctor`'s `seat` and `session` rows (CLI pin §3: every check has a hard
 * timeout). `inspectMadcHome` and `verifySessionFile` are synchronous and read whole files, so the
 * parent runs them here under a deadline it can enforce by killing this process. Read-only:
 * prints one JSON line (no event bodies, no credentials) and exits.
 */
import { inspectMadcHome, verifySessionFile } from "@madc/engine/client";

const [home, seatId] = process.argv.slice(2);
if (home === undefined || seatId === undefined) {
  process.stderr.write("usage: inspect-child <home> <seatId>\n");
  process.exit(2);
}
const report = inspectMadcHome(home, seatId);
const last = report.lastSession;
let verify: unknown = null;
if (last !== null) {
  const v = verifySessionFile(last.path, last.threadId, {}, home);
  verify = v.ok
    ? { ok: true, events: v.events.length, lastHash: v.lastHash }
    : { ok: false, line: v.line, reason: v.reason, kind: v.kind };
}
process.stdout.write(
  `${JSON.stringify({ seat: report.seat, lastSession: last === null ? null : { threadId: last.threadId, path: last.path }, verify })}\n`,
);
