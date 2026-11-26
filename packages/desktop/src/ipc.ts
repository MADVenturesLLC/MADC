/**
 * M3-A2 (`docs/plan/PLAN-madc-M3-build-plan.md` §2 row M3-A2, `PIN-madc-M3-desktop-protocol.md`,
 * `PIN-madc-M3-desktop-protocol-amendment-1.md` §2, §2a, §5, §6):
 *
 * `@madc/engine/client`-equivalent typed IPC client for `packages/desktop`.
 * Imports protocol types and constants from `@madc/engine/client` only — never engine loop,
 * tools, adapters, credentials, or `node:net` (import rule: `PLAN-madc-M0-build-plan.md:105`,
 * `ROADMAP-madc-post-M0.md:140`).
 */
import {
  type InitializeParams,
  type InitializeResult,
  PROTOCOL_VERSION,
  type RoomReport,
} from "@madc/engine/client";

export type RoomUpdateReason = "thread" | "turn" | "handoff" | "decision";

export type RoomUpdatedEvent = {
  readonly reason: RoomUpdateReason;
  readonly threadId: string;
};

export type SessionSearchParams = {
  readonly query: string;
  readonly limit?: number;
  readonly seatId?: string;
};

export type SessionSearchMatch = {
  readonly threadId: string;
  readonly seatId: string;
  readonly seq: number;
  readonly hash: string;
  readonly ts: number;
  readonly type: string;
  readonly snippet: string;
};

export type SessionSearchResult = {
  readonly matches: readonly SessionSearchMatch[];
};

export type SessionReadParams = {
  readonly threadId: string;
};

export type SessionReadResult = {
  readonly threadId: string;
  readonly events: readonly Record<string, unknown>[];
  readonly chainOk: boolean;
};

export type DesktopConnectionInfo = {
  readonly socketPath: string;
  readonly reusedExisting: boolean;
  readonly protocolVersion: string;
  readonly serverName: string;
  readonly serverVersion: string;
  readonly coldStartMs: number;
};

/**
 * Abstract IPC transport implemented by the Tauri v2 Rust shell (`invoke` / events) in production
 * and by in-memory doubles in tests.
 */
export interface DesktopIpcTransport {
  connect(): Promise<DesktopConnectionInfo>;
  request<TResult>(method: string, params: Record<string, unknown>): Promise<TResult>;
  disconnect(): Promise<void>;
  onRoomUpdated(listener: (event: RoomUpdatedEvent) => void): () => void;
}

export type ServeExitClassification =
  | { readonly kind: "clean"; readonly code: 0 | 130 | 143 }
  | { readonly kind: "stopped"; readonly code: number | null; readonly signal: string | null }
  | { readonly kind: "usage-or-home"; readonly code: 2 }
  | { readonly kind: "owned"; readonly code: 20 }
  | { readonly kind: "unsafe-path"; readonly code: 21 }
  | { readonly kind: "listen-error"; readonly code: 22 }
  | { readonly kind: "shutdown-deadline"; readonly code: 23 }
  | { readonly kind: "internal-fault"; readonly code: 24; readonly rawCode: number | null };

/**
 * Classify a `madc-engine serve` exit per amendment 1 §6.
 * Any code not in the pinned table is mapped to `24` (`internal-fault`), except:
 * - signal termination (`code === null && signal !== null`) → `stopped`
 * - Windows launcher-initiated hard kill (`code === 1 && launcherKilled && platform === "win32"`) → `stopped`
 */
export function classifyServeExit(input: {
  readonly code: number | null;
  readonly signal?: string | null;
  readonly launcherKilled?: boolean;
  readonly platform?: string;
}): ServeExitClassification {
  const signal = input.signal ?? null;
  if (input.code === null && signal !== null) {
    return { kind: "stopped", code: null, signal };
  }
  if (input.code === 1 && input.launcherKilled === true && input.platform === "win32") {
    return { kind: "stopped", code: 1, signal: null };
  }
  switch (input.code) {
    case 0:
    case 130:
    case 143:
      return { kind: "clean", code: input.code };
    case 2:
      return { kind: "usage-or-home", code: 2 };
    case 20:
      return { kind: "owned", code: 20 };
    case 21:
      return { kind: "unsafe-path", code: 21 };
    case 22:
      return { kind: "listen-error", code: 22 };
    case 23:
      return { kind: "shutdown-deadline", code: 23 };
    case 24:
      return { kind: "internal-fault", code: 24, rawCode: 24 };
    default:
      return { kind: "internal-fault", code: 24, rawCode: input.code };
  }
}

const LOCK_OWNER_LINE = /^madc-engine serve: home owned by pid (\d+): (.+)$/;

export type LockOwnerGuidance = {
  readonly pid: number;
  readonly lockPath: string;
  readonly manualFix: string;
};

/**
 * Parse amendment 1 §2a's pinned exit-20 lock-holder reason line from `serve`'s drained stderr
 * and return the pinned manual recovery instructions. The launcher never deletes `engine.lock`.
 */
export function parseLockOwnerGuidance(
  stderrText: string,
  platform: string = "darwin",
): LockOwnerGuidance | null {
  const lines = stderrText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line === undefined) continue;
    const match = LOCK_OWNER_LINE.exec(line);
    if (match === null) continue;
    const pid = Number(match[1]);
    const lockPath = match[2] ?? "";
    if (!Number.isInteger(pid) || pid <= 0 || lockPath.length === 0) continue;
    const checkCmd =
      platform === "win32"
        ? `Check Task Manager for PID ${pid}`
        : `Run \`ps -p ${pid} -o command=\` to confirm no \`madc-engine serve\` process with PID ${pid} is running`;
    return {
      pid,
      lockPath,
      manualFix: `(i) ${checkCmd}; (ii) if none is running, manually remove ${lockPath}.`,
    };
  }
  return null;
}

/**
 * Typed desktop protocol client over the Tauri v2 local-socket bridge.
 * Never auto-retries or respawns on failure (amendment 1 §5).
 */
export class DesktopEngineClient {
  readonly #transport: DesktopIpcTransport;
  #connection: DesktopConnectionInfo | null = null;

  constructor(transport: DesktopIpcTransport) {
    this.#transport = transport;
  }

  get connection(): DesktopConnectionInfo | null {
    return this.#connection;
  }

  async connect(): Promise<DesktopConnectionInfo> {
    const info = await this.#transport.connect();
    if (info.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(
        `protocol version mismatch: expected ${PROTOCOL_VERSION}, got ${info.protocolVersion}`,
      );
    }
    this.#connection = info;
    return info;
  }

  async initialize(params: InitializeParams): Promise<InitializeResult> {
    return this.#transport.request<InitializeResult>(
      "initialize",
      params as unknown as Record<string, unknown>,
    );
  }

  async roomInspect(): Promise<{ readonly room: RoomReport }> {
    return this.#transport.request<{ readonly room: RoomReport }>("room/inspect", {});
  }

  async sessionSearch(params: SessionSearchParams): Promise<SessionSearchResult> {
    return this.#transport.request<SessionSearchResult>(
      "session/search",
      params as unknown as Record<string, unknown>,
    );
  }

  async sessionRead(params: SessionReadParams): Promise<SessionReadResult> {
    return this.#transport.request<SessionReadResult>(
      "session/read",
      params as unknown as Record<string, unknown>,
    );
  }

  onRoomUpdated(listener: (event: RoomUpdatedEvent) => void): () => void {
    return this.#transport.onRoomUpdated(listener);
  }

  async disconnect(): Promise<void> {
    this.#connection = null;
    await this.#transport.disconnect();
  }
}
