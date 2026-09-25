/**
 * Test fixture: engine whose agent opens an agentMessage, streams one delta, then waits until the
 * turn is interrupted (or the connection ends). Used for turn/interrupt, -32004, and EOF tests.
 */
import type { Agent } from "../agent.ts";
import { startStdioEngine } from "../main.ts";

const hangAgent: Agent = {
  name: "hang",
  run(_ctx, sink) {
    const id = sink.newItemId();
    sink.startItem({ id, kind: "agentMessage", status: "inProgress", text: "" });
    sink.delta(id, "partial");
    return new Promise<void>((resolve) => {
      if (sink.signal.aborted) resolve();
      else sink.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  },
};

await startStdioEngine(hangAgent);
