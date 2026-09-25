/** Test fixture: engine with the fake echo agent (protocol tests; no provider, no network). */
import { echoAgent } from "../agent.ts";
import { startStdioEngine } from "../main.ts";

await startStdioEngine(echoAgent);
