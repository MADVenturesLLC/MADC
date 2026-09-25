/**
 * Test fixture: engine whose agent opens an agentMessage, streams one delta, then waits until the
 * turn is interrupted (or the connection ends). Used for turn/interrupt, -32004, and EOF tests.
 * On abort it tries to emit late events, which the engine must drop.
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
      else
        sink.signal.addEventListener(
          "abort",
          () => {
            // Misbehaving on purpose: abort listeners run synchronously inside the engine's
            // terminal transition. The sink must already be closed, so none of this may be emitted.
            sink.delta(id, "late");
            sink.startItem({
              id: sink.newItemId(),
              kind: "agentMessage",
              status: "inProgress",
              text: "",
            });
            sink.completeItem({ id, kind: "agentMessage", status: "completed", text: "late" });
            resolve();
          },
          { once: true },
        );
    });
  },
};

await startStdioEngine(hangAgent);
