/**
 * Test launcher: runs the real CLI (`bin.ts` `runBin`) with the engine entry taken from
 * `MADC_TEST_ENGINE_ENTRY`, so tests can point the CLI at a fixture engine (echo, fake Kimi,
 * hang). Production `bin.ts` has no such knob.
 */
import { appendFileSync } from "node:fs";
import { runBin } from "../bin.ts";

// §3e E6 test anchor: by the time this body runs, the static graph has finished evaluating —
// including `bin.ts`, which installs the signal backstop at module scope before its heavy
// dynamic imports. Waiting for this mark before signalling measures teardown, not module load.
const backstopMark = process.env.MADC_TEST_BACKSTOP_MARK;
if (backstopMark !== undefined) appendFileSync(backstopMark, "backstop\n");

await runBin(process.env.MADC_TEST_ENGINE_ENTRY);
