/** Test fixture: engine with the fake echo agent (protocol tests; no provider, no network). */
import { echoAgent } from "../agent.ts";
import { startStdioEngine } from "../main.ts";
import type { PresenceTerminal } from "../presence/terminal.ts";

const terminal: PresenceTerminal | undefined =
  process.env.MADC_TEST_CONFIRM_TERMINAL === "1"
    ? {
        probe: () => ({ device: "99:1", session: "1001" }),
        confirm: async () => true,
      }
    : undefined;

await startStdioEngine(echoAgent, terminal === undefined ? {} : { terminal });
