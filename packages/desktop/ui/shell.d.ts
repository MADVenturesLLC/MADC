import type { EvidenceReceipt, EvidenceTone, PillLabel } from "../src/evidence.ts";
import type { FocusBarItem, FocusBarItemId, FocusBarKey, FocusBarState } from "../src/focus-bar.ts";
import type { LockOwnerGuidance, ServeExitClassification } from "../src/ipc.ts";

export const EXPECTED_PROTOCOL_VERSION: "madc-m1/1";

export const DEFAULT_FOCUS_BAR_ITEMS: readonly FocusBarItem[];

export type PaletteCommand = {
  readonly id:
    | "cmd-connect"
    | "cmd-inspect-room"
    | "cmd-disconnect"
    | "cmd-focus-engine"
    | "cmd-focus-room"
    | "cmd-focus-decisions"
    | "cmd-focus-search"
    | "cmd-copy-chain-head"
    | "cmd-copy-served-model";
  readonly group: "Engine" | "Focus" | "Evidence";
  readonly name: string;
  readonly defaultMeta: string | null;
  readonly keyHint: string | null;
  readonly disabled?: boolean;
  readonly meta?: string | null;
};

export type PaletteMatch = {
  readonly command: PaletteCommand;
  readonly matchIndices: readonly number[];
};

export type PaletteState = {
  readonly open: boolean;
  readonly query: string;
  readonly commands: readonly PaletteCommand[];
  readonly filtered: readonly PaletteMatch[];
  readonly activeId: PaletteCommand["id"] | null;
};

export const PALETTE_COMMANDS: readonly PaletteCommand[];

export type PillInput = {
  readonly tone: EvidenceTone;
  readonly label: PillLabel;
  readonly context?: string;
  readonly small?: boolean;
  readonly role?: "status" | "alert";
};

export type ConnectErrorClassification =
  | {
      readonly phase: "serve-exit";
      readonly exit: ServeExitClassification;
      readonly guidance: LockOwnerGuidance | null;
      readonly raw: string;
    }
  | {
      readonly phase: "start-timeout";
      readonly startWindowMs: number;
      readonly raw: string;
    }
  | {
      readonly phase: "unverified-transport";
      readonly raw: string;
    }
  | {
      readonly phase: "other";
      readonly raw: string;
    };

export type RpcErrorClassification =
  | { readonly kind: "allowlist"; readonly message: string }
  | { readonly kind: "not-connected"; readonly message: string }
  | {
      readonly kind: "rpc";
      readonly code: number;
      readonly rpcMessage: string;
      readonly data: unknown;
      readonly message: string;
    }
  | { readonly kind: "transport"; readonly message: string };

export type DesktopConnectionState =
  | "IDLE"
  | "CONNECTING"
  | "CONNECTED"
  | "DISCONNECTED"
  | "STOPPED"
  | "FAILED";

export function createFocusBarState(
  items?: readonly FocusBarItem[],
  initialIndex?: number,
): FocusBarState;

export function stepFocusBar(state: FocusBarState, key: FocusBarKey): FocusBarState;

export function focusBarSelect(state: FocusBarState, id: FocusBarItemId): FocusBarState;

export function isVerifiedReceipt(receipt: EvidenceReceipt | null | undefined): boolean;

export function evidenceTone(
  receipt: EvidenceReceipt | null | undefined,
  hint?: "ok" | "neutral" | "warn" | "fail",
): EvidenceTone;

export function sanitizeEngineText(value: unknown): string;

export function serveExitFromCode(
  code: number | null,
  signal?: string | null,
): ServeExitClassification;

export function lockOwnerGuidanceFromStderr(
  stderrText: string,
  platform?: string,
): LockOwnerGuidance | null;

export function classifyConnectError(
  errOrMessage: unknown,
  platform?: string,
): ConnectErrorClassification;

export function classifyRpcError(errOrMessage: unknown): RpcErrorClassification;

export function renderPill(doc: ShellDocument, input: PillInput): ShellElement;

export function filterCommands(
  commands: readonly PaletteCommand[],
  query?: string,
): readonly PaletteMatch[];

export function createPaletteState(
  commands?: readonly PaletteCommand[],
  query?: string,
  open?: boolean,
): PaletteState;

export function stepPalette(
  state: PaletteState,
  key: "ArrowDown" | "ArrowUp" | "Home" | "End" | string,
): PaletteState;

export function invokeTauri(
  cmd: string,
  args?: Record<string, unknown>,
  globalObj?: unknown,
): Promise<unknown>;

export type ShellElement = {
  id?: string;
  className: string;
  textContent: string | null;
  tabIndex: number;
  value?: string;
  hidden?: boolean;
  disabled?: boolean;
  inert?: boolean;
  title?: string;
  readonly children: ArrayLike<ShellElement>;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  removeAttribute(name: string): void;
  hasAttribute(name: string): boolean;
  appendChild(child: ShellElement): ShellElement;
  replaceChildren(...nodes: ShellElement[]): void;
  focus(): void;
  addEventListener(type: string, listener: (ev: unknown) => void): void;
  querySelectorAll(selector: string): readonly ShellElement[];
};

export type ShellDocument = {
  readonly activeElement: ShellElement | null;
  getElementById(id: string): ShellElement;
  createElement(tagName: string): ShellElement;
  addEventListener?(type: string, listener: (ev: unknown) => void): void;
};

export function bindDesktopShell(
  doc: ShellDocument,
  invokeFn?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>,
  env?: { readonly globalObj?: unknown; readonly platform?: string },
): {
  readonly getFocusState: () => FocusBarState;
  readonly getConnectionState: () => DesktopConnectionState;
  readonly connect: () => Promise<void>;
  readonly disconnect: () => Promise<void>;
  readonly inspectRoom: () => Promise<void>;
  readonly selectThread: (threadId: string) => Promise<void>;
  readonly openPalette: () => void;
  readonly closePalette: (restoreFocus?: boolean) => void;
  readonly handleKeydown: (ev: unknown) => void;
};
