/**
 * Test launcher: runs the real CLI (`bin.ts` `runBin`) with the engine entry taken from
 * `MADC_TEST_ENGINE_ENTRY`, so tests can point the CLI at a fixture engine (echo, fake Kimi,
 * hang). Production `bin.ts` has no such knob.
 */
import { runBin } from "../bin.ts";

await runBin(process.env.MADC_TEST_ENGINE_ENTRY);
