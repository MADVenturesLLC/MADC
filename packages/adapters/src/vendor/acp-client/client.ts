/**
 * Generic ACP client (Act M1-A6): drives an UNMODIFIED ACP-speaking vendor agent as a child process
 * over stdio JSON-RPC and exposes it as a MAD `ProviderPort`. Adding another ACP agent is a spec
 * (`AcpAgentSpec`: registry id, argv, auth choice) plus a registry entry, not new client code (M1
 * plan §3). This module never speaks HTTP, never reads a vendor credential store or credential
 * env value, and never rewrites the environment: the child inherits it and finds its own auth.
 *
 * One child per turn (the A5/A6 lifecycle), protocol per ACP schema v1:
 *
 *   → initialize { protocolVersion: 1, clientCapabilities (nothing served), clientInfo: madc }
 *   ← { protocolVersion: 1, agentCapabilities, authMethods }
 *   → authenticate { methodId, _meta? }      (only when the spec asks for it)
 *   → session/new { cwd, mcpServers: [] }
 *   ← { sessionId, configOptions? }          (a `model` config option = the agent's model report)
 *   → session/prompt { sessionId, prompt: [text…] }
 *   ← session/update notifications: agent_message_chunk → deltas; tool_call / tool_call_update →
 *     tool events; config_option_update → model report; everything else dropped
 *   ← { stopReason }
 *   → session/cancel { sessionId }           (notification; sent on abort = MAD turn/interrupt)
 *
 * Agent→client requests: `session/request_permission` is answered by the M1 posture in `wire.ts`
 * (refuse; `cancelled` after an interrupt); anything else gets `-32601`. Outbound messages carry
 * `jsonrpc: "2.0"` (ACP is strict JSON-RPC 2.0); inbound ones are accepted with or without it.
 * Vendor error bodies and stderr never surface: every error message here is MAD-authored.
 */
import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import {
  ProviderCallError,
  type ProviderPort,
  type ProviderTurnRequest,
  type ProviderTurnResult,
} from "../../provider-port.ts";
import {
  ACP_ANSWERED_STOP_REASONS,
  ACP_AUTH_REQUIRED,
  ACP_CLIENT_CAPABILITIES,
  ACP_PROTOCOL_VERSION,
  type AcpAuthChoice,
  type AcpAuthMethod,
  authMethodsOf,
  createToolTracker,
  isRecord,
  JSONRPC_METHOD_NOT_FOUND,
  parseSessionUpdate,
  permissionOutcome,
  reportedModelOf,
} from "./wire.ts";

/**
 * PATH lookup (PATHEXT on Windows) for an ACP agent binary. Never executes anything. Same rule as
 * `findClaudeBinary` / `findCodexBinary`; one shared copy serves every ACP agent spec.
 */
export function findAgentBinary(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
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

/** What one ACP vendor agent needs beyond the generic client. */
export type AcpAgentSpec = {
  /** Registry provider id (== seat `preferredBacking`), e.g. `grok-build`. */
  readonly providerId: string;
  /** argv after the binary for one turn; `modelId` is the seat's validated vendor model name. */
  readonly args: (modelId: string) => readonly string[];
  /**
   * Picks the `authenticate` method from the agent's advertised list, or null when none is usable
   * (the turn then fails -32008 `no-credentials` without calling `authenticate`). Omitted: MAD
   * never calls `authenticate`, and an `auth_required` answer to `session/new` fails the turn the
   * same way.
   */
  readonly selectAuth?: (methods: readonly AcpAuthMethod[]) => AcpAuthChoice | null;
  /**
   * Quiet window (ms) to keep reading `session/update` after the `session/prompt` response, for
   * agents documented to flush trailing chunks after it; 0 for strictly ordered agents. The turn
   * resolves once no update arrived for this long, or at `trailingMaxMs` after the response.
   */
  readonly trailingQuietMs: number;
  readonly trailingMaxMs: number;
};

/** Spawn seam (production: `node:child_process.spawn`; tests: the fake ACP agent child). */
export type AcpSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export type AcpPortOptions = {
  readonly spec: AcpAgentSpec;
  /** Absolute path of the detected agent binary. */
  readonly binaryPath: string;
  /** Test seam: spawn override. Production never sets it. */
  readonly spawn?: AcpSpawn;
  /** Version in the `initialize` `clientInfo` (production: the engine version); name is `madc`. */
  readonly clientVersion?: string;
};

export function createAcpPort(options: AcpPortOptions): ProviderPort {
  const { spec } = options;
  if (options.binaryPath.trim() === "") {
    throw new ProviderCallError("failed", null, `${spec.providerId} requires a binary path`);
  }
  const spawnFn = options.spawn ?? spawn;
  const clientVersion = options.clientVersion ?? "0.0.0";
  return Object.freeze({
    providerId: spec.providerId,
    streamTurn: (request: ProviderTurnRequest) =>
      streamAcpTurn(spec, spawnFn, options.binaryPath, clientVersion, request),
  });
}

/** Grace between `session/cancel` and SIGTERM, and between SIGTERM and SIGKILL (as codex). */
const CANCEL_GRACE_MS = 250;
const KILL_GRACE_MS = 2_000;

function streamAcpTurn(
  spec: AcpAgentSpec,
  spawnFn: AcpSpawn,
  binaryPath: string,
  clientVersion: string,
  request: ProviderTurnRequest,
): Promise<ProviderTurnResult> {
  const label = spec.providerId;
  const prompt = request.messages.map((m) => m.text).join("\n");
  return new Promise<ProviderTurnResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      // The child inherits the environment (spawn default) and the engine's cwd: that is how the
      // unmodified agent finds its own auth and workspace. MAD adds, removes or rewrites nothing.
      child = spawnFn(binaryPath, [...spec.args(request.modelId)], {
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      // A synchronous spawn throw is never a missing binary (node reports not-found
      // asynchronously via 'error'), so no pinned `binary-missing` reason here.
      reject(new ProviderCallError("failed", null, `${label} agent child failed to start`));
      return;
    }
    const cwd = process.cwd();
    let stdoutBuf = "";
    let settled = false;
    let spawnError: NodeJS.ErrnoException | null = null;
    let childClosed = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let drainTimer: ReturnType<typeof setTimeout> | null = null;
    let nextId = 1;
    let sessionId: string | null = null;
    let promptSent = false;
    let promptAnswered = false;
    let cancelling = false;
    let lastUpdateAt = 0;
    let reportedModel: string | null = null;
    let text = "";
    const pending = new Map<number, { method: string; settle: (msg: unknown) => void }>();
    // Session updates that arrive before `sessionId` is bound: a flush can carry the session/new
    // response and the agent's first updates in ONE stdout chunk, and the continuation that binds
    // `sessionId` runs as a microtask after this synchronous drain (the codex same-chunk lesson).
    const preBind: unknown[] = [];
    const tools = createToolTracker((event) => request.onToolEvent?.(event));

    const killChild = (): void => {
      if (childClosed) return;
      if (killTimer !== null) clearTimeout(killTimer);
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
      killTimer.unref?.();
    };
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (killTimer !== null) clearTimeout(killTimer);
      if (drainTimer !== null) clearTimeout(drainTimer);
      request.signal.removeEventListener("abort", onAbort);
      // Wake every outstanding request so no continuation (or its closure) is left pending.
      for (const entry of pending.values()) entry.settle(undefined);
      pending.clear();
      // The child is per-turn: a settled turn never leaves an agent running.
      killChild();
      fn();
    };
    const fail = (err: ProviderCallError): void => finish(() => reject(err));
    const succeed = (): void =>
      finish(() =>
        resolve({
          text,
          requestedModelId: request.modelId,
          // P2 honesty rule: the agent's own report, else the requested id — never a guess.
          servedModel: reportedModel ?? request.modelId,
          vendorReported: reportedModel !== null,
        }),
      );

    const write = (message: Record<string, unknown>): void => {
      try {
        child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
      } catch {
        // The child is gone; the 'close'/'error' handlers settle the turn.
      }
    };
    /** Resolves with the result, or with `{ error }` for an error response (never rejects). */
    const sendRequest = (method: string, params: Record<string, unknown>): Promise<unknown> =>
      new Promise((settle) => {
        if (settled) {
          settle(undefined);
          return;
        }
        const id = nextId++;
        pending.set(id, { method, settle });
        write({ id, method, params });
      });
    const errorOf = (reply: unknown): Record<string, unknown> | null =>
      isRecord(reply) && isRecord(reply.error) ? reply.error : null;

    const onAbort = (): void => {
      if (settled) return;
      if (promptAnswered) {
        // The vendor turn is already over; nothing to cancel — stop reading and end the child.
        fail(new ProviderCallError("aborted", null, `${label} turn aborted`));
        return;
      }
      if (sessionId !== null && promptSent) {
        // ACP cancellation for the active prompt (the MAD `turn/interrupt` mapping): the agent
        // should answer the prompt with `stopReason: "cancelled"`. A short grace, then escalation.
        cancelling = true;
        write({ method: "session/cancel", params: { sessionId } });
        killTimer = setTimeout(killChild, CANCEL_GRACE_MS);
        killTimer.unref?.();
        return;
      }
      killChild();
    };

    const applyUpdate = (params: unknown): void => {
      if (sessionId === null) return;
      const update = parseSessionUpdate(params, sessionId);
      if (update.kind === "ignored") return;
      lastUpdateAt = Date.now();
      if (update.kind === "text") {
        text += update.text;
        request.onTextDelta(update.text);
      } else if (update.kind === "tool") {
        tools.apply(update.update);
      } else {
        reportedModel = update.modelId;
      }
    };

    const answerAgentRequest = (msg: Record<string, unknown>): void => {
      const id = msg.id;
      if (typeof id !== "number" && typeof id !== "string") return;
      if (msg.method === "session/request_permission") {
        write({ id, result: { outcome: permissionOutcome(msg.params, cancelling) } });
        return;
      }
      write({ id, error: { code: JSONRPC_METHOD_NOT_FOUND, message: "Method not found" } });
    };

    const onResponse = (msg: Record<string, unknown>): void => {
      if (typeof msg.id !== "number") return;
      const entry = pending.get(msg.id);
      if (entry === undefined) return;
      pending.delete(msg.id);
      entry.settle(isRecord(msg.error) ? { error: msg.error } : { result: msg.result });
    };

    const onLine = (line: string): void => {
      if (settled || line.trim() === "") return;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        fail(new ProviderCallError("failed", null, `${label} ACP output was not JSON-RPC`));
        return;
      }
      if (!isRecord(msg)) {
        fail(new ProviderCallError("failed", null, `${label} ACP output was not JSON-RPC`));
        return;
      }
      if (typeof msg.method === "string") {
        if (msg.id === undefined) {
          if (msg.method !== "session/update") return;
          if (sessionId === null) preBind.push(msg.params);
          else applyUpdate(msg.params);
          return;
        }
        answerAgentRequest(msg);
        return;
      }
      onResponse(msg);
    };

    child.on("error", (err: NodeJS.ErrnoException) => {
      spawnError = err;
      // ENOENT: the binary vanished between preflight detection and spawn (protocol pin §4.2) →
      // the pinned -32008 reason. Anything else is an ordinary call failure (-32603).
      fail(
        err.code === "ENOENT"
          ? new ProviderCallError(
              "failed",
              null,
              `${label} binary could not be started`,
              "binary-missing",
            )
          : new ProviderCallError("failed", null, `${label} binary could not be started`),
      );
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
    // A closed agent pipe reports EPIPE as an async stream 'error' (never a thrown write); an
    // unhandled stream error would crash the engine, so route it into the failure path.
    child.stdin?.on("error", () => {
      if (settled) return;
      fail(new ProviderCallError("failed", null, `${label} agent stdin closed`));
    });
    // stderr is drained but never read, logged, or surfaced (it can carry vendor or account text).
    child.stderr?.resume?.();
    if (request.signal.aborted) onAbort();
    else request.signal.addEventListener("abort", onAbort, { once: true });

    child.on("close", (code) => {
      childClosed = true;
      if (killTimer !== null) clearTimeout(killTimer);
      if (settled) return;
      if (request.signal.aborted) {
        fail(new ProviderCallError("aborted", null, `${label} turn aborted`));
        return;
      }
      if (spawnError !== null) return; // already reported via 'error'
      // The agent answered the prompt and then exited while trailing updates were drained: the
      // vendor turn is complete, so it stands.
      if (promptAnswered) {
        succeed();
        return;
      }
      fail(new ProviderCallError("failed", null, `${label} agent child exited ${code ?? "null"}`));
    });

    /** After the prompt response: read trailing updates until quiet, then resolve. */
    const drainThenSucceed = (): void => {
      const quietMs = Math.max(0, spec.trailingQuietMs);
      if (quietMs === 0) {
        succeed();
        return;
      }
      const answeredAt = Date.now();
      lastUpdateAt = answeredAt;
      const deadline = answeredAt + Math.max(quietMs, spec.trailingMaxMs);
      const tick = (): void => {
        if (settled) return;
        const now = Date.now();
        const quietFor = now - lastUpdateAt;
        if (quietFor >= quietMs || now >= deadline) {
          succeed();
          return;
        }
        drainTimer = setTimeout(tick, Math.min(quietMs - quietFor, deadline - now));
      };
      // Kept ref'd on purpose: the turn is awaiting it, and it is bounded by `trailingMaxMs`.
      drainTimer = setTimeout(tick, quietMs);
    };

    // Drive the handshake and the prompt. Failures settle via the handlers above; this chain only
    // advances while the turn is still live.
    void (async () => {
      const init = await sendRequest("initialize", {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: ACP_CLIENT_CAPABILITIES,
        clientInfo: { name: "madc", version: clientVersion },
      });
      if (settled) return;
      const initResult = isRecord(init) ? init.result : undefined;
      if (errorOf(init) !== null || !isRecord(initResult)) {
        fail(new ProviderCallError("failed", null, `${label} ACP initialize failed`));
        return;
      }
      if (initResult.protocolVersion !== ACP_PROTOCOL_VERSION) {
        fail(new ProviderCallError("failed", null, `${label} ACP protocol version unsupported`));
        return;
      }

      if (spec.selectAuth !== undefined) {
        const choice = spec.selectAuth(authMethodsOf(initResult));
        if (choice === null) {
          fail(
            new ProviderCallError(
              "failed",
              null,
              `${label} offers no usable sign-in`,
              "no-credentials",
            ),
          );
          return;
        }
        const auth = await sendRequest("authenticate", {
          methodId: choice.methodId,
          ...(choice.meta === undefined ? {} : { _meta: choice.meta }),
        });
        if (settled) return;
        if (errorOf(auth) !== null) {
          fail(
            new ProviderCallError("failed", null, `${label} authenticate failed`, "no-credentials"),
          );
          return;
        }
      }

      const created = await sendRequest("session/new", { cwd, mcpServers: [] });
      if (settled) return;
      const createError = errorOf(created);
      const session = isRecord(created) ? created.result : undefined;
      if (createError !== null || !isRecord(session)) {
        fail(
          createError?.code === ACP_AUTH_REQUIRED
            ? new ProviderCallError("failed", null, `${label} is not signed in`, "no-credentials")
            : new ProviderCallError("failed", null, `${label} ACP session/new failed`),
        );
        return;
      }
      sessionId = typeof session.sessionId === "string" ? session.sessionId : null;
      if (sessionId === null || sessionId === "") {
        sessionId = null;
        fail(new ProviderCallError("failed", null, `${label} ACP session/new failed`));
        return;
      }
      reportedModel = reportedModelOf(session);
      // Replay same-chunk updates buffered before the binding, in arrival order.
      for (const params of preBind.splice(0)) applyUpdate(params);
      if (request.signal.aborted) return;

      // ACP has no system-prompt channel: the seat's standing instructions travel as the prompt's
      // leading text block, ahead of the user's text.
      const blocks = [
        ...(request.systemPrompt === undefined || request.systemPrompt === ""
          ? []
          : [{ type: "text", text: request.systemPrompt }]),
        { type: "text", text: prompt },
      ];
      promptSent = true;
      const answer = await sendRequest("session/prompt", { sessionId, prompt: blocks });
      if (settled) return;
      const promptResult = isRecord(answer) ? answer.result : undefined;
      if (errorOf(answer) !== null || !isRecord(promptResult)) {
        fail(
          cancelling
            ? new ProviderCallError("aborted", null, `${label} turn aborted`)
            : new ProviderCallError("failed", null, `${label} ACP session/prompt failed`),
        );
        return;
      }
      const stopReason = promptResult.stopReason;
      if (cancelling || stopReason === "cancelled") {
        fail(
          cancelling
            ? new ProviderCallError("aborted", null, `${label} turn aborted`)
            : new ProviderCallError("failed", null, `${label} turn was cancelled by the agent`),
        );
        return;
      }
      if (typeof stopReason !== "string" || !ACP_ANSWERED_STOP_REASONS.has(stopReason)) {
        fail(new ProviderCallError("failed", null, `${label} turn failed`));
        return;
      }
      promptAnswered = true;
      drainThenSucceed();
    })();
  });
}
