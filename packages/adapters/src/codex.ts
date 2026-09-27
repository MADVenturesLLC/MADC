/**
 * Codex backing (Act M0-A6): drives the UNMODIFIED `codex` binary as a child process via the
 * documented embed path, `codex app-server` (JSON-RPC over stdio). This module never speaks HTTP
 * to OpenAI or ChatGPT, never reads, logs, or transmits Codex credentials or session files, and
 * never forks or vendors codex-rs — the child inherits the environment and finds its own auth
 * (ChatGPT sign-in or API key, exactly as when the operator runs it by hand). No proxy or env
 * rewriting is applied.
 *
 * Protocol surface (codex-cli 0.155.1; verified against `codex app-server generate-ts` /
 * `generate-json-schema` and a live handshake + turn on the reference machine):
 *
 *   → initialize { clientInfo: { name, title, version }, capabilities: null }
 *   ← { userAgent, codexHome, platformFamily, platformOs }
 *   → initialized (notification, no params)
 *   → thread/start { model, approvalPolicy: "never", ephemeral: true, developerInstructions? }
 *   ← { thread: { id, … }, model, modelProvider, … }   (result.model = vendor-resolved model)
 *   → turn/start { threadId, input: [{ type: "text", text, text_elements: [] }] }
 *   ← { turn: { id, status: "inProgress", … } }
 *   ← item/started · item/agentMessage/delta { delta } · item/completed (agentMessage text)
 *   ← turn/completed { turn: { status: "completed" | "interrupted" | "failed", … } }
 *   → turn/interrupt { threadId, turnId }   (documented interrupt, sent on abort)
 *
 * Wire framing is newline-delimited JSON; the `jsonrpc` field is omitted outbound and tolerated
 * inbound (app-server convention, same as MAD's own pin §1). `approvalPolicy: "never"` keeps the
 * turn headless: the server then sends no approval requests to the client. `ephemeral: true`
 * keeps the vendor thread from being materialized under the operator's `$CODEX_HOME` — MAD's own
 * session record is the durable one. One app-server child per turn (the A5 lifecycle): the turn's
 * thread is created fresh, so abort and failure semantics stay identical to claude-code's.
 */
import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import {
  ProviderCallError,
  type ProviderPort,
  type ProviderTurnRequest,
  type ProviderTurnResult,
} from "./provider-port.ts";

/** Registry provider id (seat `preferredBacking`). */
export const CODEX_PROVIDER_ID = "codex";
/** Vendor binary name looked up on PATH. */
export const CODEX_BINARY_NAME = "codex";

/**
 * PATH lookup (PATHEXT on Windows). Never executes anything. Mirrors `findClaudeBinary` in
 * `claude-code.ts` — each vendor adapter owns its copy (plan §6 import rules).
 */
export function findCodexBinary(
  env: Readonly<Record<string, string | undefined>>,
  name: string = CODEX_BINARY_NAME,
): string | null {
  const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter((d) => d !== "");
  const exts =
    process.platform === "win32"
      ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((e) => e !== "")
      : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, `${name}${ext}`);
      try {
        if (!statSync(candidate).isFile()) continue;
        if (process.platform !== "win32") accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // not here
      }
    }
  }
  return null;
}

export type CodexPinnedModelResolution =
  | { readonly ok: true; readonly modelId: string }
  | { readonly ok: false; readonly issue: string };

/**
 * `pinnedModel` for codex is the vendor model name (seat pin §2: whatever the operator's Codex
 * build accepts, e.g. `gpt-5.1-codex`) and is passed to the app-server verbatim as
 * `thread/start.params.model`. M0 validates shape only (non-empty); the vendor binary is the
 * authority on which names it accepts.
 */
export function resolveCodexPinnedModel(pinnedModel: string): CodexPinnedModelResolution {
  const modelId = pinnedModel.trim();
  if (modelId === "")
    return { ok: false, issue: "pinnedModel must be a non-empty vendor model name" };
  return { ok: true, modelId };
}

/** Spawn seam (production: `node:child_process.spawn`; tests: a fake child). */
export type CodexSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export type CodexPortOptions = {
  /** Absolute path of the detected `codex` binary (from `findCodexBinary`). */
  readonly binaryPath: string;
  /** Test seam: spawn override. Production never sets it. */
  readonly spawn?: CodexSpawn;
  /**
   * Version reported in the app-server `initialize` handshake `clientInfo` (production: the
   * engine version). The client name is always the honest `madc`.
   */
  readonly clientVersion?: string;
};

export function createCodexCodePort(options: CodexPortOptions): ProviderPort {
  if (options.binaryPath.trim() === "") {
    throw new ProviderCallError("failed", null, "codex requires a binary path");
  }
  const spawnFn = options.spawn ?? spawn;
  const clientVersion = options.clientVersion ?? "0.0.0";
  return Object.freeze({
    providerId: CODEX_PROVIDER_ID,
    streamTurn: (request: ProviderTurnRequest) =>
      streamCodexTurn(spawnFn, options.binaryPath, clientVersion, request),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: unknown, field: string): string | null {
  if (!isRecord(value)) return null;
  const v = value[field];
  return typeof v === "string" && v !== "" ? v : null;
}

/** Request ids used on the app-server link (one per message, in send order). */
const ID_INITIALIZE = 1;
const ID_THREAD_START = 2;
const ID_TURN_START = 3;
const ID_TURN_INTERRUPT = 4;

function streamCodexTurn(
  spawnFn: CodexSpawn,
  binaryPath: string,
  clientVersion: string,
  request: ProviderTurnRequest,
): Promise<ProviderTurnResult> {
  const prompt = request.messages.map((m) => m.text).join("\n");
  return new Promise<ProviderTurnResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      // The child inherits the environment (spawn default): that is how the unmodified tool finds
      // its own auth. MAD never adds, removes, or rewrites a variable.
      child = spawnFn(binaryPath, ["app-server"], { stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      // A synchronous spawn throw is never a missing binary (node reports not-found
      // asynchronously via the 'error' event), so no pinned `binary-missing` reason here.
      reject(new ProviderCallError("failed", null, "codex app-server child failed to start"));
      return;
    }
    let stdoutBuf = "";
    let settled = false;
    let spawnError: NodeJS.ErrnoException | null = null;
    // Escalation only: SIGTERM first, SIGKILL if the child outlives the grace window.
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let threadId: string | null = null;
    let turnId: string | null = null;
    let servedModel = request.modelId;
    let deltaText = "";
    let streamedDeltas = false;
    let completedText: string | null = null;
    const pending = new Map<number, (result: unknown) => void>();

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (killTimer !== null) clearTimeout(killTimer);
      request.signal.removeEventListener("abort", onAbort);
      // Wake every outstanding request: continuations see `settled` and return; no promise (and
      // the closures it retains) is left pending after the turn is over.
      for (const resolveRequest of pending.values()) resolveRequest(undefined);
      pending.clear();
      fn();
    };
    const fail = (err: ProviderCallError): void =>
      finish(() => {
        // The child is per-turn: a settled turn never leaves a server running.
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
        killTimer.unref?.();
        reject(err);
      });
    const killChild = (): void => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      killTimer.unref?.();
    };
    const onAbort = (): void => {
      if (threadId !== null && turnId !== null) {
        // The documented interrupt for the active turn first (best effort), with a short grace
        // for the server to wind the turn down, then SIGTERM→SIGKILL escalation (as A5).
        write({
          id: ID_TURN_INTERRUPT,
          method: "turn/interrupt",
          params: { threadId, turnId },
        });
        killTimer = setTimeout(() => {
          child.kill("SIGTERM");
          killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
          killTimer.unref?.();
        }, 250);
        killTimer.unref?.();
        return;
      }
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      killTimer.unref?.();
    };

    const write = (message: Record<string, unknown>): void => {
      try {
        child.stdin?.write(`${JSON.stringify(message)}\n`);
      } catch {
        // The child is gone; the 'close'/'error' handlers settle the turn.
      }
    };
    const sendRequest = (
      id: number,
      method: string,
      params: Record<string, unknown>,
    ): Promise<unknown> =>
      new Promise((resolveRequest) => {
        if (settled) {
          // The turn is already over: resolve so the awaiting continuation returns at once.
          resolveRequest(undefined);
          return;
        }
        pending.set(id, resolveRequest);
        write({ id, method, params });
      });

    const onResponse = (msg: Record<string, unknown>): void => {
      const id = typeof msg.id === "number" ? msg.id : null;
      if (id === null) return;
      const resolveRequest = pending.get(id);
      if (resolveRequest === undefined) return;
      pending.delete(id);
      if (isRecord(msg.error)) {
        // MAD-authored message: the vendor error body can carry account or upstream detail.
        const method =
          id === ID_INITIALIZE
            ? "initialize"
            : id === ID_THREAD_START
              ? "thread/start"
              : id === ID_TURN_START
                ? "turn/start"
                : "turn/interrupt";
        fail(new ProviderCallError("failed", null, `codex app-server ${method} failed`));
        return;
      }
      resolveRequest(msg.result);
    };

    const onTurnCompleted = (params: unknown): void => {
      const turn = isRecord(params) ? params.turn : null;
      const id = stringField(turn, "id");
      if (turnId === null || id !== turnId || !isRecord(turn)) return;
      if (turn.status === "completed") {
        // item/completed is authoritative (protocol pin §3.4); deltas were already streamed.
        let text = completedText ?? deltaText;
        if (completedText === null) {
          // Capture-and-emit fallback: the app-server may deliver text only at completion.
          for (const item of Array.isArray(turn.items) ? turn.items : []) {
            const itemText = stringField(item, "text");
            if (isRecord(item) && item.type === "agentMessage" && itemText !== null) {
              text = itemText;
            }
          }
        }
        if (!streamedDeltas && text !== "") request.onTextDelta(text);
        finish(() => {
          killChild();
          resolve({ text, requestedModelId: request.modelId, servedModel });
        });
        return;
      }
      if (turn.status === "interrupted") {
        fail(new ProviderCallError("aborted", null, "codex turn aborted"));
        return;
      }
      // "failed" (and any other terminal status): the vendor error text never surfaces.
      fail(new ProviderCallError("failed", null, "codex turn failed"));
    };

    // Turn-scoped notifications that arrive before the local `turnId` binding: a vendor flush can
    // put the turn/start response AND its turn notifications in ONE stdout chunk, and the
    // response continuation (which assigns `turnId`) runs as a microtask only after this
    // synchronous drain. Buffer such notifications in order and re-dispatch them once `turnId` is
    // known — the turnId binding check still applies on re-dispatch.
    const preBind: Record<string, unknown>[] = [];

    const dispatchTurnNotification = (msg: Record<string, unknown>): void => {
      const params = msg.params;
      switch (msg.method) {
        case "item/agentMessage/delta": {
          if (turnId === null || stringField(params, "turnId") !== turnId) return;
          const delta = isRecord(params) ? params.delta : null;
          if (typeof delta === "string" && delta !== "") {
            streamedDeltas = true;
            deltaText += delta;
            request.onTextDelta(delta);
          }
          return;
        }
        case "item/completed": {
          if (turnId === null || stringField(params, "turnId") !== turnId) return;
          const item = isRecord(params) ? params.item : null;
          if (isRecord(item) && item.type === "agentMessage") {
            const text = stringField(item, "text");
            if (text !== null) completedText = text;
          }
          return;
        }
        case "turn/completed":
          onTurnCompleted(params);
          return;
        default:
          return;
      }
    };

    const onNotification = (msg: Record<string, unknown>): void => {
      switch (msg.method) {
        case "item/agentMessage/delta":
        case "item/completed":
        case "turn/completed":
          if (turnId === null) {
            // Only a notification that names a turn can ever bind; anything else is dropped.
            // item/* name it as `turnId`; turn/completed as `turn.id`.
            const params = msg.params;
            const namesTurn =
              stringField(params, "turnId") !== null ||
              (isRecord(params) && stringField(params.turn, "id") !== null);
            if (namesTurn) preBind.push(msg);
            return;
          }
          dispatchTurnNotification(msg);
          return;
        default:
          // Every other app-server notification (thread/started, thread/status/changed,
          // tokenUsage, hooks, warnings, …) is vendor-internal and ignored.
          return;
      }
    };

    const onLine = (line: string): void => {
      if (settled || line.trim() === "") return;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        fail(new ProviderCallError("failed", null, "codex app-server output was not JSON-RPC"));
        return;
      }
      if (!isRecord(msg)) {
        fail(new ProviderCallError("failed", null, "codex app-server output was not JSON-RPC"));
        return;
      }
      if (typeof msg.method === "string" && msg.id === undefined) {
        onNotification(msg);
        return;
      }
      if (typeof msg.method === "string") {
        // A server→client request (approvals, elicitations). `approvalPolicy: "never"` means none
        // are expected; they are never answered from MAD (headless, no interactive surface).
        return;
      }
      onResponse(msg);
    };

    child.on("error", (err: NodeJS.ErrnoException) => {
      spawnError = err;
      // ENOENT (node's cross-platform not-found): the binary vanished between preflight
      // detection and spawn (protocol pin §4.2) → the pinned -32008 reason. Anything else
      // (EACCES, EINVAL, …) is an ordinary call failure (-32603), not "binary-missing".
      if (err.code === "ENOENT") {
        fail(
          new ProviderCallError(
            "failed",
            null,
            "codex binary could not be started",
            "binary-missing",
          ),
        );
        return;
      }
      fail(new ProviderCallError("failed", null, "codex binary could not be started"));
    });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdoutBuf += chunk;
      let at = stdoutBuf.indexOf("\n");
      while (at >= 0) {
        const line = stdoutBuf.slice(0, at);
        stdoutBuf = stdoutBuf.slice(at + 1);
        onLine(line);
        at = stdoutBuf.indexOf("\n");
      }
    });
    // A closed vendor pipe reports EPIPE as an async stream 'error', never a thrown write — the
    // try/catch in `write` alone cannot see it, and an unhandled stream error would crash the
    // engine. Route it into the normal failure path (the child's 'close' settles the same way).
    child.stdin?.on("error", () => {
      if (settled) return;
      fail(new ProviderCallError("failed", null, "codex app-server stdin closed"));
    });
    // stderr is drained but never read, logged, or surfaced (it can carry vendor text or account
    // details). resume() keeps the stream flowing without a per-chunk callback.
    child.stderr?.resume?.();
    if (request.signal.aborted) onAbort();
    else request.signal.addEventListener("abort", onAbort, { once: true });

    child.on("close", (code) => {
      if (killTimer !== null) clearTimeout(killTimer);
      if (settled) {
        // The turn already settled; 'close' always follows the kill.
        return;
      }
      if (request.signal.aborted) {
        fail(new ProviderCallError("aborted", null, "codex turn aborted"));
        return;
      }
      if (spawnError !== null) return; // already reported via 'error'
      fail(
        new ProviderCallError("failed", null, `codex app-server child exited ${code ?? "null"}`),
      );
    });

    // Drive the documented handshake and turn. Failures settle via the response/notification
    // handlers above; this chain only advances while the turn is still live.
    void (async () => {
      const initResult = await sendRequest(ID_INITIALIZE, "initialize", {
        clientInfo: { name: "madc", title: null, version: clientVersion },
        capabilities: null,
      });
      if (settled || !isRecord(initResult)) return;
      write({ method: "initialized" });
      const threadResult = await sendRequest(ID_THREAD_START, "thread/start", {
        model: request.modelId,
        approvalPolicy: "never",
        ephemeral: true,
        ...(request.systemPrompt === undefined
          ? {}
          : { developerInstructions: request.systemPrompt }),
      });
      if (settled || !isRecord(threadResult)) return;
      threadId = stringField(threadResult.thread, "id");
      const reported = stringField(threadResult, "model");
      if (reported !== null) servedModel = reported;
      if (threadId === null) {
        fail(new ProviderCallError("failed", null, "codex app-server thread/start failed"));
        return;
      }
      const turnResult = await sendRequest(ID_TURN_START, "turn/start", {
        threadId,
        input: [{ type: "text", text: prompt, text_elements: [] }],
      });
      if (settled || !isRecord(turnResult)) return;
      turnId = stringField(turnResult.turn, "id");
      if (turnId === null) {
        fail(new ProviderCallError("failed", null, "codex app-server turn/start failed"));
        return;
      }
      // Re-dispatch any same-chunk notifications buffered before the binding (in arrival order).
      for (const msg of preBind.splice(0)) dispatchTurnNotification(msg);
    })();
  });
}
