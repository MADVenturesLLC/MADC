#!/usr/bin/env bash
set -euo pipefail

# Reproducible capture of real engine RPC results and notifications at commit 870c1f7e
# for AM2 §13 test (7s). Requires zero vendor credentials or network access.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
COMMIT="870c1f7ec3aeca13190f306b23c5d91810675e09"

WORK_BASE="${TMPDIR:-/tmp}/madc-capture-870c1f7e-$$"
EXTRACT_DIR="$WORK_BASE/src"
HOME_DIR="$WORK_BASE/home"
OUT_FILE="$SCRIPT_DIR/fixtures.json"

cleanup() {
  rm -rf "$WORK_BASE"
}
trap cleanup EXIT

mkdir -p "$EXTRACT_DIR" "$HOME_DIR"
chmod 700 "$HOME_DIR"

git -C "$REPO_ROOT" archive "$COMMIT" package.json tsconfig.json packages | tar -x -C "$EXTRACT_DIR"
if [ -d "$REPO_ROOT/node_modules" ]; then
  ln -s "$REPO_ROOT/node_modules" "$EXTRACT_DIR/node_modules"
fi

cat > "$WORK_BASE/run-capture.mjs" <<'EOF'
import { mkdirSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [extractDir, homeDir, outFile] = process.argv.slice(2);
const { startSocketServer } = await import(pathToFileURL(join(extractDir, "packages/engine/src/socket.ts")).href);

// Create one invalid seat file so seat/list covers ok: false alongside ok: true madc-default
mkdirSync(join(homeDir, "seats"), { recursive: true, mode: 0o700 });
writeFileSync(
  join(homeDir, "seats", "bad-seat.json"),
  JSON.stringify({ version: 2, id: "bad-seat" }) + "\n",
  { mode: 0o600 },
);

let openTurnGateResolve = null;
const turn2OpenReady = new Promise((r) => { openTurnGateResolve = r; });

const stubAgent = {
  name: "capture-stub",
  async run(ctx, sink) {
    const prompt = ctx.input.map((p) => p.text).join("\n");
    if (prompt.includes("interrupt-me")) {
      const receiptId = sink.newItemId();
      sink.startItem({
        id: receiptId,
        kind: "servedModel",
        status: "inProgress",
        requestedModel: "claude-sonnet-4-5-20250929",
        servedModel: "",
        backing: "anthropic-direct",
        providerId: "anthropic",
        lane: "allowed-direct",
        mode: "headless",
        fallbackFrom: null,
        vendorReported: false,
      });
      const msgId = sink.newItemId();
      sink.startItem({ id: msgId, kind: "agentMessage", status: "inProgress", text: "" });
      sink.delta(msgId, "partial ");
      openTurnGateResolve?.();
      await new Promise((resolve) => {
        if (sink.signal.aborted) return resolve();
        sink.signal.addEventListener("abort", resolve, { once: true });
      });
      return;
    }

    const tcId = sink.newItemId();
    sink.startItem({ id: tcId, kind: "toolCall", status: "inProgress", name: "noop_tool", arguments: null });
    sink.completeItem({ id: tcId, kind: "toolCall", status: "completed", name: "noop_tool", arguments: null });

    const trId = sink.newItemId();
    sink.startItem({ id: trId, kind: "toolResult", status: "inProgress", callId: tcId, name: "noop_tool", output: "ok", isError: false });
    sink.completeItem({ id: trId, kind: "toolResult", status: "completed", callId: tcId, name: "noop_tool", output: "ok", isError: false });

    const smId = sink.newItemId();
    const smItem = {
      id: smId,
      kind: "servedModel",
      status: "inProgress",
      requestedModel: "claude-sonnet-4-5-20250929",
      servedModel: "claude-sonnet-4-5-20250929",
      backing: "anthropic-direct",
      providerId: "anthropic",
      lane: "allowed-direct",
      mode: "headless",
      fallbackFrom: null,
      vendorReported: true,
    };
    sink.startItem(smItem);
    sink.completeItem({ ...smItem, status: "completed" });

    const msgId = sink.newItemId();
    sink.startItem({ id: msgId, kind: "agentMessage", status: "inProgress", text: "" });
    sink.delta(msgId, "hello ");
    sink.delta(msgId, "world");
    sink.completeItem({ id: msgId, kind: "agentMessage", status: "completed", text: "hello world" });
  },
};

const server = await startSocketServer({
  home: homeDir,
  agent: stubAgent,
});

const sock = createConnection(server.socketPath);
await new Promise((res, rej) => {
  sock.once("connect", res);
  sock.once("error", rej);
});

let nextId = 1;
const pending = new Map();
const notifications = [];
const waiters = [];

createInterface({ input: sock }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (Object.hasOwn(msg, "id")) {
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    }
  } else {
    notifications.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(msg)) {
        const w = waiters.splice(i, 1)[0];
        w.resolve(msg);
      }
    }
  }
});

function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    sock.write(JSON.stringify({ id, method, params }) + "\n");
  });
}

function waitNotification(pred) {
  const existing = notifications.find(pred);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve) => waiters.push({ pred, resolve }));
}

const initResult = await rpc("initialize", {
  clientInfo: { name: "madc-capture", version: "0.0.0" },
  capabilities: { subscribeRoom: true },
});
const threadStartParams = {};
const threadStartResult = await rpc("thread/start", threadStartParams);
const threadId = threadStartResult.thread.id;
const seatListResult = await rpc("seat/list", {});

const turn1StartResult = await rpc("turn/start", {
  threadId,
  input: [{ type: "text", text: "capture turn 1" }],
  mode: "headless",
});
await waitNotification((n) => n.method === "turn/completed" && n.params?.turn?.id === turn1StartResult.turn.id);

const sessionReadParams = { threadId };
const sessionReadResult = await rpc("session/read", sessionReadParams);
const sessionSearchResult = await rpc("session/search", { query: "capture" });
const roomInspectResult = await rpc("room/inspect", {});

const turn2StartResult = await rpc("turn/start", {
  threadId,
  input: [{ type: "text", text: "interrupt-me" }],
  mode: "headless",
});
await turn2OpenReady;
const turnInterruptResult = await rpc("turn/interrupt", {
  threadId,
  turnId: turn2StartResult.turn.id,
});
await waitNotification((n) => n.method === "turn/completed" && n.params?.turn?.id === turn2StartResult.turn.id);

// Wait briefly for room/updated trailing notifications
await new Promise((r) => setTimeout(r, 100));

const fixture = {
  sourceCommit: "870c1f7ec3aeca13190f306b23c5d91810675e09",
  rpcs: {
    initialize: initResult,
    seatList: seatListResult,
    threadStart: { params: threadStartParams, result: threadStartResult },
    turnStart: { threadId, result: turn1StartResult },
    turnInterrupt: turnInterruptResult,
    sessionRead: { threadId, result: sessionReadResult },
    sessionSearch: sessionSearchResult,
    roomInspect: roomInspectResult,
  },
  notifications,
};

writeFileSync(outFile, JSON.stringify(fixture, null, 2) + "\n");
sock.destroy();
await server.close();
EOF

node "$WORK_BASE/run-capture.mjs" "$EXTRACT_DIR" "$HOME_DIR" "$OUT_FILE"
ls -lh "$OUT_FILE"
