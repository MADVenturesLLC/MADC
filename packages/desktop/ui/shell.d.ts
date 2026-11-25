import type { EvidenceReceipt, EvidenceTone } from "../src/evidence.ts";
import type { FocusBarItem, FocusBarItemId, FocusBarKey, FocusBarState } from "../src/focus-bar.ts";

export const DEFAULT_FOCUS_BAR_ITEMS: readonly FocusBarItem[];

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

export function invokeTauri(
  cmd: string,
  args?: Record<string, unknown>,
  globalObj?: unknown,
): Promise<unknown>;

export type ShellElement = {
  className: string;
  textContent: string | null;
  tabIndex: number;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  focus(): void;
  addEventListener(type: string, listener: (ev: unknown) => void): void;
  querySelectorAll(selector: string): readonly ShellElement[];
};

export type ShellDocument = {
  getElementById(id: string): ShellElement;
};

export function bindDesktopShell(
  doc: ShellDocument,
  invokeFn?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>,
): {
  readonly getFocusState: () => FocusBarState;
  readonly connect: () => Promise<void>;
};
