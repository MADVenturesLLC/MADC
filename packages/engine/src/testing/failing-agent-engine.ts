/** Test fixture: engine whose agent throws — turn must end `failed` with an `error` item. */
import type { Agent } from "../agent.ts";
import { startStdioEngine } from "../main.ts";

const failingAgent: Agent = {
  name: "failing",
  async run() {
    throw new Error("fixture agent failure");
  },
};

await startStdioEngine(failingAgent);
