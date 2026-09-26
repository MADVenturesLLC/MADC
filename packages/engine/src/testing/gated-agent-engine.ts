/**
 * Test fixture (Amendment 2 §8 item 2, cross-namespace variant): engine whose agent opens an
 * agentMessage and completes it only once the file named by `MADC_TEST_GATE` exists (polled). The
 * completion is the turn's next session append, so a test can change the lock or the file first.
 */
import { existsSync } from "node:fs";
import type { Agent } from "../agent.ts";
import { startStdioEngine } from "../main.ts";

const gate = process.env.MADC_TEST_GATE ?? "";

const gatedAgent: Agent = {
  name: "gated",
  run(_ctx, sink) {
    const id = sink.newItemId();
    sink.startItem({ id, kind: "agentMessage", status: "inProgress", text: "" });
    return new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (sink.signal.aborted) {
          clearInterval(timer);
          resolve();
        } else if (gate !== "" && existsSync(gate)) {
          clearInterval(timer);
          sink.completeItem({ id, kind: "agentMessage", status: "completed", text: "gated" });
          resolve();
        }
      }, 10);
    });
  },
};

await startStdioEngine(gatedAgent);
