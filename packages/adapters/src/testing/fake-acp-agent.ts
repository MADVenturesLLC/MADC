/**
 * Test-only fixture child standing in for an ACP vendor agent such as `grok agent stdio` (Act
 * M1-A6). Spawned as a real process via `createFakeAcpSpawn` (same runtime as the test runner), it
 * speaks the ACP v1 flow the client codes against (initialize → authenticate → session/new →
 * session/prompt with session/update notifications → stopReason) and answers per
 * `MADC_TEST_ACP_MODE`:
 *
 * - unset / `ok`       — happy flow; the model from `--model=` is reported through a `model`
 *                        config option on `session/new`; text in two chunks; `end_turn`
 * - `no-model`         — no model report anywhere (receipt: requested id, vendorReported false)
 * - `legacy-model`     — model reported as the pre-configOptions `models.currentModelId`
 * - `model-update`     — no report on session/new; a `config_option_update` mid-turn reports
 *                        `grok-served-later`
 * - `tools`            — text, a read tool that completes, an execute tool that fails, a third
 *                        call that never reaches a terminal status, more text
 * - `permission`       — asks `session/request_permission` (allow/reject options) and waits for
 *                        the answer before ending the turn
 * - `fs-request`       — calls `fs/read_text_file` (a capability MAD never advertises) and waits
 *                        for the answer before ending the turn
 * - `trailing`         — answers `session/prompt` FIRST, then flushes text chunks 40 ms later
 *                        (the pattern xAI's ACP example tolerates)
 * - `same-chunk`       — the session/new response AND a model `config_option_update` in ONE write
 * - `hang`             — the prompt is never answered until `session/cancel`, then `cancelled`
 * - `hang-deaf`        — ignores `session/cancel`; runs until killed (escalation path)
 * - `no-auth`          — advertises no auth methods
 * - `auth-error`       — `authenticate` answers a JSON-RPC error (hostile body)
 * - `auth-required`    — `session/new` answers ACP `auth_required` (-32000, hostile body)
 * - `prompt-error`     — `session/prompt` answers a JSON-RPC error (hostile body)
 * - `refusal`          — stopReason `refusal` after some text
 * - `agent-cancelled`  — stopReason `cancelled` although nobody cancelled
 * - `bad-stop`         — an unknown stopReason
 * - `bad-version`      — initialize answers protocolVersion 2
 * - `nonzero`          — hostile text on stderr, exit 1
 * - `malformed`        — a non-JSON line on stdout on the first message
 * - `vanish`           — exits 127 immediately
 * - `exit-after-init`  — answers initialize, then exits 0 (the next write hits a closed pipe)
 * - `exit-after-answer`— text + prompt answer, then exits 0 at once (close during the drain)
 *
 * Records every client message it receives to `MADC_TEST_ACP_WIRE_LOG` (one JSON line each) and
 * its argv, cwd and whether `XAI_API_KEY` is PRESENT in its env (never a value) to
 * `MADC_TEST_ACP_ARGV_LOG`, so tests can assert exactly what the client sent and spawned.
 */
import { appendFileSync } from "node:fs";

const mode = process.env.MADC_TEST_ACP_MODE ?? "ok";
const wireLog = process.env.MADC_TEST_ACP_WIRE_LOG;
const argvLog = process.env.MADC_TEST_ACP_ARGV_LOG;

const SESSION_ID = "sess_fakeacp";
const HOSTILE = "upstream 400 detail with account details that must never surface";
const argv = process.argv.slice(2);
const modelArg = argv.find((arg) => arg.startsWith("--model="))?.slice("--model=".length) ?? null;

if (argvLog !== undefined) {
  appendFileSync(
    argvLog,
    `${JSON.stringify({ argv, cwd: process.cwd(), xaiApiKeyPresent: Object.hasOwn(process.env, "XAI_API_KEY") })}\n`,
  );
}

function send(msg: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
}

function update(body: Record<string, unknown>): Record<string, unknown> {
  return { method: "session/update", params: { sessionId: SESSION_ID, update: body } };
}

function chunk(text: string): Record<string, unknown> {
  return update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
}

function modelOption(currentValue: string): Record<string, unknown> {
  return {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue,
    options: [{ value: currentValue, name: currentValue }],
  };
}

let prompt = "";
let promptId: number | string | null = null;
let nextAgentRequestId = 900;
const awaiting = new Map<number, () => void>();

function answerPrompt(stopReason: string): void {
  if (promptId === null) return;
  send({ id: promptId, result: { stopReason } });
  promptId = null;
}

function runPrompt(): void {
  switch (mode) {
    case "tools":
      send(chunk("Looking. "));
      send(
        update({
          sessionUpdate: "tool_call",
          toolCallId: "call_read",
          title: "Read README.md",
          kind: "read",
          status: "pending",
          rawInput: { path: "README.md" },
        }),
      );
      send(
        update({
          sessionUpdate: "tool_call_update",
          toolCallId: "call_read",
          status: "in_progress",
        }),
      );
      send(
        update({
          sessionUpdate: "tool_call_update",
          toolCallId: "call_read",
          status: "completed",
          content: [{ type: "content", content: { type: "text", text: "# MADC" } }],
        }),
      );
      send(
        update({
          sessionUpdate: "tool_call",
          toolCallId: "call_exec",
          title: "Run npm test",
          kind: "execute",
          status: "pending",
          rawInput: { command: "npm test" },
        }),
      );
      send(
        update({
          sessionUpdate: "tool_call_update",
          toolCallId: "call_exec",
          status: "failed",
          rawOutput: { exitCode: 1 },
        }),
      );
      send(
        update({
          sessionUpdate: "tool_call",
          toolCallId: "call_open",
          title: "Search the web",
          kind: "fetch",
          status: "in_progress",
        }),
      );
      // Dropped kinds: thoughts and plans never become MAD items.
      send(
        update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } }),
      );
      send(update({ sessionUpdate: "plan", entries: [] }));
      send(chunk("Done."));
      answerPrompt("end_turn");
      return;
    case "permission": {
      const id = nextAgentRequestId++;
      awaiting.set(id, () => {
        send(chunk("permission answered"));
        answerPrompt("end_turn");
      });
      send({
        id,
        method: "session/request_permission",
        params: {
          sessionId: SESSION_ID,
          toolCall: { toolCallId: "call_perm", title: "Run rm -rf build", kind: "execute" },
          options: [
            { optionId: "opt-allow-once", name: "Allow once", kind: "allow_once" },
            { optionId: "opt-allow-always", name: "Always allow", kind: "allow_always" },
            { optionId: "opt-reject-once", name: "Reject", kind: "reject_once" },
            { optionId: "opt-reject-always", name: "Never", kind: "reject_always" },
          ],
        },
      });
      return;
    }
    case "fs-request": {
      const id = nextAgentRequestId++;
      awaiting.set(id, () => {
        send(chunk("fs answered"));
        answerPrompt("end_turn");
      });
      send({
        id,
        method: "fs/read_text_file",
        params: { sessionId: SESSION_ID, path: "/etc/hosts" },
      });
      return;
    }
    case "trailing":
      answerPrompt("end_turn");
      setTimeout(() => {
        send(chunk("late "));
        send(chunk("answer"));
      }, 40);
      return;
    case "model-update":
      send(chunk("fake acp answer"));
      send(
        update({
          sessionUpdate: "config_option_update",
          configOptions: [modelOption("grok-served-later")],
        }),
      );
      send(chunk(` to: ${prompt}`));
      answerPrompt("end_turn");
      return;
    case "hang":
    case "hang-deaf":
      send(chunk("partial "));
      return;
    case "prompt-error":
      send({ id: promptId, error: { code: -32603, message: HOSTILE } });
      promptId = null;
      return;
    case "refusal":
      send(chunk("I can't help with that."));
      answerPrompt("refusal");
      return;
    case "agent-cancelled":
      send(chunk("partial"));
      answerPrompt("cancelled");
      return;
    case "bad-stop":
      send(chunk("partial"));
      answerPrompt("exploded");
      return;
    case "exit-after-answer":
      send(chunk("fake acp answer"));
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } })}\n`,
        () => process.exit(0),
      );
      return;
    default:
      send(chunk("fake acp answer"));
      send(chunk(` to: ${prompt}`));
      answerPrompt("end_turn");
  }
}

function handle(msg: Record<string, unknown>): void {
  if (wireLog !== undefined) appendFileSync(wireLog, `${JSON.stringify(msg)}\n`);
  if (msg.method === undefined && typeof msg.id === "number") {
    // The client's answer to one of our requests.
    const next = awaiting.get(msg.id);
    awaiting.delete(msg.id);
    next?.();
    return;
  }
  switch (msg.method) {
    case "initialize": {
      const result = {
        protocolVersion: mode === "bad-version" ? 2 : 1,
        agentCapabilities: { loadSession: false },
        agentInfo: { name: "fake-acp", version: "0.0.0" },
        authMethods:
          mode === "no-auth"
            ? []
            : [
                { id: "cached_token", name: "Cached login" },
                { id: "xai.api_key", name: "API key" },
              ],
      };
      if (mode === "exit-after-init") {
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n`, () =>
          process.exit(0),
        );
        return;
      }
      send({ id: msg.id, result });
      return;
    }
    case "authenticate":
      if (mode === "auth-error") {
        send({ id: msg.id, error: { code: -32000, message: HOSTILE } });
        return;
      }
      send({ id: msg.id, result: {} });
      return;
    case "session/new": {
      if (mode === "auth-required") {
        send({ id: msg.id, error: { code: -32000, message: HOSTILE } });
        return;
      }
      const result: Record<string, unknown> = { sessionId: SESSION_ID };
      if (mode === "legacy-model" && modelArg !== null) {
        result.models = { currentModelId: modelArg, availableModels: [] };
      } else if (
        !["no-model", "legacy-model", "model-update", "same-chunk"].includes(mode) &&
        modelArg !== null
      ) {
        result.configOptions = [modelOption(modelArg)];
      }
      if (mode === "same-chunk") {
        const lines = [
          { jsonrpc: "2.0", id: msg.id, result },
          {
            jsonrpc: "2.0",
            ...update({
              sessionUpdate: "config_option_update",
              configOptions: [modelOption("grok-same-chunk")],
            }),
          },
        ];
        process.stdout.write(`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
        return;
      }
      send({ id: msg.id, result });
      return;
    }
    case "session/prompt": {
      const params = (msg.params ?? {}) as Record<string, unknown>;
      const blocks = Array.isArray(params.prompt)
        ? (params.prompt as Record<string, unknown>[])
        : [];
      const last = blocks.at(-1);
      prompt = typeof last?.text === "string" ? last.text : "";
      promptId = msg.id as number;
      setTimeout(runPrompt, 5);
      return;
    }
    case "session/cancel":
      if (mode === "hang") answerPrompt("cancelled");
      return;
    default:
      return;
  }
}

switch (mode) {
  case "nonzero":
    process.stderr.write("fake acp: exploded with account details that must never surface\n");
    process.exit(1);
    break;
  case "vanish":
    process.exit(127);
    break;
  default: {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (data: string) => {
      buf += data;
      let at = buf.indexOf("\n");
      while (at >= 0) {
        const line = buf.slice(0, at);
        buf = buf.slice(at + 1);
        if (line.trim() !== "") {
          if (mode === "malformed") {
            process.stdout.write("this is not json\n");
            process.exit(0);
          }
          handle(JSON.parse(line) as Record<string, unknown>);
        }
        at = buf.indexOf("\n");
      }
    });
  }
}
