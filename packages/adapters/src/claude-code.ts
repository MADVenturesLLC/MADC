/**
 * Claude Code backing (Act M0-A5): drives the UNMODIFIED `claude` binary as a child process.
 * This module never imports `@earendil-works/pi-ai` (plan §6: only `kimi-code.ts` may), never
 * speaks HTTP to the Claude API, and never reads, logs, or transmits Claude credentials or session
 * files — the child inherits the environment and finds its own auth, exactly as when the operator
 * runs it by hand. No proxy or env rewriting is applied.
 *
 * Headless interface (documented in `claude --help`, Claude Code "print mode"):
 *
 *   claude -p <prompt> --output-format json [--model <model>] [--append-system-prompt <text>]
 *
 * `-p` is the documented non-interactive mode and `--output-format json` the documented
 * machine-readable result: one JSON object on stdout at exit (`{ result, modelUsage, is_error, … }`).
 * M0 uses capture-and-emit (plan §10 A5: "stream or capture"): the captured result text is emitted
 * as a single delta when the child exits successfully.
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
export const CLAUDE_CODE_PROVIDER_ID = "claude-code";
/** Vendor binary name looked up on PATH. */
export const CLAUDE_BINARY_NAME = "claude";

/**
 * PATH lookup (PATHEXT on Windows). Never executes anything. Mirrors `findOnPath` in
 * `packages/cli/src/doctor.ts` — adapters must not import from cli (plan §6 import rules).
 */
export function findClaudeBinary(
  env: Readonly<Record<string, string | undefined>>,
  name: string = CLAUDE_BINARY_NAME,
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

export type ClaudePinnedModelResolution =
  | { readonly ok: true; readonly modelId: string }
  | { readonly ok: false; readonly issue: string };

/**
 * `pinnedModel` for claude-code is the vendor model name (seat pin §2: alias like `opus` or a full
 * name like `claude-sonnet-4-5`); it is trimmed of surrounding whitespace and the trimmed value is
 * passed to the child via `--model`. M0 validates shape only (non-empty); the vendor binary is the
 * authority on which names it accepts.
 */
export function resolveClaudePinnedModel(pinnedModel: string): ClaudePinnedModelResolution {
  const modelId = pinnedModel.trim();
  if (modelId === "")
    return { ok: false, issue: "pinnedModel must be a non-empty vendor model name" };
  return { ok: true, modelId };
}

/** Spawn seam (production: `node:child_process.spawn`; tests: a fake child). */
export type ClaudeSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export type ClaudeCodePortOptions = {
  /** Absolute path of the detected `claude` binary (from `findClaudeBinary`). */
  readonly binaryPath: string;
  /** Test seam: spawn override. Production never sets it. */
  readonly spawn?: ClaudeSpawn;
};

export function createClaudeCodePort(options: ClaudeCodePortOptions): ProviderPort {
  if (options.binaryPath.trim() === "") {
    throw new ProviderCallError("failed", null, "claude-code requires a binary path");
  }
  const spawnFn = options.spawn ?? spawn;
  return Object.freeze({
    providerId: CLAUDE_CODE_PROVIDER_ID,
    streamTurn: (request: ProviderTurnRequest) =>
      streamClaudeTurn(spawnFn, options.binaryPath, request),
  });
}

/** The `result` object's shape as read by MAD (everything else is ignored). */
type ClaudeResultJson = {
  readonly is_error?: unknown;
  readonly result?: unknown;
  readonly modelUsage?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** First model id the vendor reports in `modelUsage` (keyed by model name), if any. */
function reportedModel(modelUsage: unknown): string | null {
  if (!isRecord(modelUsage)) return null;
  for (const key of Object.keys(modelUsage)) {
    if (key !== "") return key;
  }
  return null;
}

function streamClaudeTurn(
  spawnFn: ClaudeSpawn,
  binaryPath: string,
  request: ProviderTurnRequest,
): Promise<ProviderTurnResult> {
  const args = [
    "-p",
    request.messages.map((m) => m.text).join("\n"),
    "--output-format",
    "json",
    "--model",
    request.modelId,
    ...(request.systemPrompt === undefined ? [] : ["--append-system-prompt", request.systemPrompt]),
  ];
  return new Promise<ProviderTurnResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      // The child inherits the environment (spawn default): that is how the unmodified tool finds
      // its own auth. MAD never adds, removes, or rewrites a variable.
      child = spawnFn(binaryPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      reject(new ProviderCallError("failed", null, "claude-code child failed to start"));
      return;
    }
    let stdout = "";
    let settled = false;
    let spawnError: NodeJS.ErrnoException | null = null;
    // Escalation only: SIGTERM first, SIGKILL if the child outlives the grace window.
    let killTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (killTimer !== null) clearTimeout(killTimer);
      request.signal.removeEventListener("abort", onAbort);
      fn();
    };
    const fail = (err: ProviderCallError): void => finish(() => reject(err));
    const onAbort = (): void => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      killTimer.unref?.();
    };

    child.on("error", (err: NodeJS.ErrnoException) => {
      // The binary vanished between preflight detection and spawn (protocol pin §4.2).
      spawnError = err;
      fail(
        new ProviderCallError(
          "failed",
          null,
          "claude-code binary could not be started",
          "binary-missing",
        ),
      );
    });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    // stderr is drained but never read, logged, or surfaced (it can carry vendor text or account
    // details).
    child.stderr?.on("data", () => undefined);
    if (request.signal.aborted) onAbort();
    else request.signal.addEventListener("abort", onAbort, { once: true });

    child.on("close", (code) => {
      if (settled) {
        // 'error' already settled; still nothing further to do ('close' always follows).
        return;
      }
      if (request.signal.aborted) {
        fail(new ProviderCallError("aborted", null, "claude-code turn aborted"));
        return;
      }
      if (spawnError !== null) return; // already reported via 'error'
      if (code !== 0) {
        fail(new ProviderCallError("failed", null, `claude-code child exited ${code ?? "null"}`));
        return;
      }
      let parsed: ClaudeResultJson;
      try {
        parsed = JSON.parse(stdout) as ClaudeResultJson;
      } catch {
        fail(new ProviderCallError("failed", null, "claude-code output was not a result object"));
        return;
      }
      if (!isRecord(parsed)) {
        fail(new ProviderCallError("failed", null, "claude-code output was not a result object"));
        return;
      }
      if (parsed.is_error === true || typeof parsed.result !== "string") {
        fail(new ProviderCallError("failed", null, "claude-code reported an error result"));
        return;
      }
      const text = parsed.result;
      request.onTextDelta(text);
      finish(() =>
        resolve({
          text,
          requestedModelId: request.modelId,
          servedModel: reportedModel(parsed.modelUsage) ?? request.modelId,
        }),
      );
    });
  });
}
