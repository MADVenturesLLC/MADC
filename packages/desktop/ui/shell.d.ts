import type { EvidenceReceipt, EvidenceTone, PillLabel } from "../src/evidence.ts";
import type { FocusBarItem, FocusBarItemId, FocusBarKey, FocusBarState } from "../src/focus-bar.ts";
import type {
  DesktopEngineEventEnvelope,
  LockOwnerGuidance,
  QuitCommandAck,
  QuitRequestedPayload,
  SeatSummary,
  ServeExitClassification,
  TransportClosedReason,
} from "../src/ipc.ts";

export const EXPECTED_PROTOCOL_VERSION: "madc-m1/1";

export const FORWARDED_ENGINE_EVENTS: ReadonlySet<string>;

export const DEFAULT_FOCUS_BAR_ITEMS: readonly FocusBarItem[];

export type PaletteCommandId =
  | "cmd-connect"
  | "cmd-inspect-room"
  | "cmd-disconnect"
  | "cmd-focus-engine"
  | "cmd-focus-room"
  | "cmd-focus-decisions"
  | "cmd-focus-search"
  | "cmd-copy-chain-head"
  | "cmd-copy-served-model"
  | "cmd-copy-head-open"
  | "cmd-view-panes"
  | "cmd-view-table"
  | "cmd-pane-focus-1"
  | "cmd-pane-focus-2"
  | "cmd-pane-focus-3"
  | "cmd-pane-focus-4"
  | "cmd-pane-hide"
  | "cmd-pane-dismiss"
  | "cmd-turn-start"
  | `cmd-pane-new:${string}`
  | `cmd-pane-show:${string}`
  | `cmd-turn-interrupt:${string}`
  | `cmd-target-toggle:${string}`;

export type PaletteCommand = {
  readonly id: PaletteCommandId;
  readonly group: "Engine" | "Focus" | "Evidence" | "Panes" | "Turn";
  readonly name: string;
  readonly defaultMeta: string | null;
  readonly keyHint: string | null;
  readonly disabled?: boolean;
  readonly meta?: string | null;
};

export const ALLOWED_PILL_LABELS: Readonly<Record<EvidenceTone, ReadonlySet<PillLabel>>>;

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
  readonly ariaLabel?: string;
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
  | { readonly kind: "params"; readonly message: string }
  | { readonly kind: "shutting-down"; readonly message: string }
  | { readonly kind: "not-connected"; readonly message: string }
  | {
      readonly kind: "rpc";
      readonly code: number;
      readonly rpcMessage: string;
      readonly data: unknown;
      readonly message: string;
    }
  | { readonly kind: "transport"; readonly message: string };

export type EngineEventAcceptanceState = {
  readonly boundEpoch: number | null;
  readonly connectionState: DesktopConnectionState;
  readonly disconnectPending: boolean;
  readonly lastAcceptedSeq: number | null;
};

export type EngineEventAcceptanceResult = {
  readonly outcome: "accept" | "drop";
  readonly streamGap: boolean;
  readonly nextSeq: number | null;
};

export type PendingTerminal = {
  readonly epoch: number;
  readonly reason: TransportClosedReason;
};

export type TerminalAcceptanceState = {
  readonly connectionState: DesktopConnectionState;
  readonly disconnectPending: boolean;
  readonly boundEpoch: number | null;
  readonly terminalHandled: number;
  readonly pendingTerminal: PendingTerminal | null;
};

export type TerminalAcceptanceResult = {
  readonly action:
    | "ignore"
    | "pending-connecting"
    | "exit"
    | "fail"
    | "disconnecting"
    | "mark-handled";
  readonly nextState: TerminalAcceptanceState;
  readonly settleQuit: boolean;
  readonly markEnded: boolean;
  readonly nextConnectionState: DesktopConnectionState;
  readonly startDisconnect: boolean;
};

export type ConnectTerminalResolution = {
  readonly matched: boolean;
  readonly reason: TransportClosedReason | null;
  readonly nextState: TerminalAcceptanceState;
  readonly markEnded: boolean;
  readonly settleQuit: boolean;
  readonly startDisconnect: boolean;
};

export type QuitRecordStatus = "candidate" | "shown" | "settled";

export type QuitRecord = {
  readonly requestId: number;
  readonly status: QuitRecordStatus;
};

export type QuitRequestAcceptanceState = {
  readonly boundEpoch: number | null;
  readonly connectionState: DesktopConnectionState;
  readonly quitRecord: QuitRecord | null;
};

export type QuitRequestDecision = {
  readonly action: "candidate-open" | "refocus" | "ignore";
  readonly nextRecord: QuitRecord | null;
};

export type DesktopViewMode = "panes" | "table";

export type PaneLifecycleState =
  | "draft"
  | "starting-thread"
  | "start-failed"
  | "idle"
  | "starting-turn"
  | "running"
  | "interrupt-pending"
  | "completed"
  | "interrupted"
  | "failed"
  | "refused"
  | "history";

export type DesktopPaneSnapshot = {
  readonly paneId: string;
  readonly seatId: string;
  readonly boundEpoch: number;
  readonly state: PaneLifecycleState;
  readonly threadId: string | null;
  readonly turnId: string | null;
  readonly startedAt: number | null;
  readonly cwdText: string;
  readonly cwdBaseline: string;
  readonly cwdSent: string | null;
  readonly threadCwd: string | null;
  readonly visible: boolean;
  readonly hasReadYet: boolean;
  readonly footerReason: string | null;
};

export type DesktopQuitStateSnapshot = {
  readonly quitRecord: QuitRecord | null;
  readonly dialogOpen: boolean;
  readonly boundEpoch: number | null;
  readonly terminalHandled: number;
  readonly exitStarted: boolean;
};

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

export function acceptEngineEvent(
  state: EngineEventAcceptanceState,
  ev: DesktopEngineEventEnvelope | unknown,
): EngineEventAcceptanceResult;

export function acceptTerminal(
  state: TerminalAcceptanceState,
  ev:
    | {
        readonly epoch?: unknown;
        readonly params?: { readonly reason?: unknown };
        readonly reason?: unknown;
      }
    | unknown,
): TerminalAcceptanceResult;

export function resolveConnectTerminal(
  state: TerminalAcceptanceState,
  resolvedEpoch: number | null | undefined,
): ConnectTerminalResolution;

export function acceptQuitRequest(
  state: QuitRequestAcceptanceState,
  payload: QuitRequestedPayload | unknown,
): QuitRequestDecision;

export type CwdFieldPhase = "draft" | "starting" | "refused" | "started";

export type CwdFieldStateResult = {
  readonly word: "NO CWD" | "UNCHECKED" | "REJECTED" | "REFUSED" | "STARTING" | "STARTED";
  readonly glyph: "○" | "✗";
  readonly tone: "neutral" | "fail";
  readonly reason: string | null;
};

export type PaneReceiptChip = {
  readonly key: string;
  readonly value: string;
  readonly title?: string | null;
  readonly muted?: boolean;
  readonly bdi?: boolean;
};

export type PaneReceiptRowSpec = {
  readonly kind:
    | "method-error"
    | "servedModel"
    | "lane"
    | "worktree.topLevel"
    | "head@open"
    | "hash";
  readonly label: string;
  readonly isField: boolean;
  readonly tone: EvidenceTone;
  readonly pillLabel: PillLabel | null;
  readonly chips: readonly PaneReceiptChip[];
  readonly note: string | null;
  readonly title?: string | null;
  readonly accessibleName?: string | null;
};

export function cwdCheck(text: string): { readonly ok: boolean; readonly reason: string };

export function cwdFieldState(
  text: string,
  phase: CwdFieldPhase,
  refuseInfo?: { readonly message?: string } | null,
): CwdFieldStateResult;

export function paneColumns(width: number): 2 | 4;

export function isWidePaneWidth(paneWidth: number): boolean;

export function turnPillForPane(pane: { readonly state: PaneLifecycleState }): {
  readonly tone: "neutral" | "fail";
  readonly label: PillLabel;
};

export function receiptRowsForPane(
  pane: Record<string, unknown>,
  readEntry?: {
    readonly ok: boolean;
    readonly result?: Record<string, unknown>;
    readonly note?: string;
  } | null,
  roomRow?: Record<string, unknown> | null,
  connectionState?: DesktopConnectionState,
): readonly PaneReceiptRowSpec[];

export function composerTargets(
  panes: readonly DesktopPaneSnapshot[],
  selectedSet: ReadonlySet<string>,
  boundEpoch: number | null,
  connectionState: DesktopConnectionState,
): readonly {
  readonly paneId: string;
  readonly seatId: string;
  readonly selected: boolean;
  readonly enabled: boolean;
  readonly disabledReason: string | null;
  readonly title: string | null;
}[];

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
  readOnly?: boolean;
  hidden?: boolean;
  disabled?: boolean;
  inert?: boolean;
  title?: string;
  setSelectionRange?(start: number, end: number): void;
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
  env?: {
    readonly globalObj?: unknown;
    readonly platform?: string;
    readonly viewportWidth?: number;
  },
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
  readonly handleEngineEvent: (payload: unknown) => void;
  readonly handleQuitRequested: (payload: unknown) => Promise<void>;
  readonly reportEventBridgeFailure: (message: string) => void;
  readonly ackQuit: () => Promise<QuitCommandAck>;
  readonly confirmQuit: () => Promise<QuitCommandAck>;
  readonly loadSeats: () => Promise<readonly SeatSummary[]>;
  readonly createDraftPane: (seatId: string) => DesktopPaneSnapshot;
  readonly setPaneCwdText: (paneId: string, text: string) => void;
  readonly startThread: (paneId: string) => Promise<void>;
  readonly startTurn: (text: string, targetPaneIds?: readonly string[]) => Promise<void>;
  readonly interruptTurn: (paneId: string) => Promise<void>;
  readonly dismissPane: (paneId: string) => boolean;
  readonly hidePane: (paneId: string) => boolean;
  readonly showPane: (paneId: string) => boolean;
  readonly focusPane: (paneId: string) => boolean;
  readonly toggleComposerTarget: (paneId: string) => boolean;
  readonly setViewMode: (mode: DesktopViewMode) => void;
  readonly getViewMode: () => DesktopViewMode;
  readonly getPanes: () => readonly DesktopPaneSnapshot[];
  readonly getSeats: () => readonly SeatSummary[];
  readonly getQuitState: () => DesktopQuitStateSnapshot;
  readonly getQuitTurns: () => readonly DesktopPaneSnapshot[];
  readonly isTableStale: () => boolean;
  readonly isStreamGap: () => boolean;
};
