/**
 * `@madc/desktop` — M3-A2 desktop shell scaffold (Tauri v2 frontend contract).
 * Protocol client types only; no agent loop, tools, adapters, credentials, or direct socket I/O.
 */
export {
  type EvidenceReceipt,
  type EvidenceTone,
  evidenceTone,
  isVerifiedReceipt,
} from "./evidence.ts";
export {
  createFocusBarState,
  DEFAULT_FOCUS_BAR_ITEMS,
  type FocusBarItem,
  type FocusBarItemId,
  type FocusBarKey,
  type FocusBarState,
  focusBarSelect,
  stepFocusBar,
} from "./focus-bar.ts";
export {
  classifyServeExit,
  type DesktopConnectionInfo,
  DesktopEngineClient,
  type DesktopIpcTransport,
  type LockOwnerGuidance,
  parseLockOwnerGuidance,
  type RoomUpdatedEvent,
  type RoomUpdateReason,
  type ServeExitClassification,
  type SessionReadParams,
  type SessionReadResult,
  type SessionSearchMatch,
  type SessionSearchParams,
  type SessionSearchResult,
} from "./ipc.ts";
