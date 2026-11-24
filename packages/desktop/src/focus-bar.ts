/**
 * M3-A2 (`docs/plan/PLAN-madc-M3-build-plan.md` §2 row M3-A2):
 * Minimal, neutral keyboard focus bar state controller.
 *
 * Keeps focusable shell landmarks keyboard-navigable (`Tab`, `Shift+Tab`, `ArrowRight`,
 * `ArrowLeft`, `Home`, `End`) without introducing M3-A3 design tokens, command palette, or
 * decorative green indicators.
 */

export type FocusBarItemId = "connection" | "room" | "decisions" | "search";

export type FocusBarItem = {
  readonly id: FocusBarItemId;
  readonly label: string;
};

export const DEFAULT_FOCUS_BAR_ITEMS: readonly FocusBarItem[] = [
  { id: "connection", label: "Engine" },
  { id: "room", label: "Room" },
  { id: "decisions", label: "Decisions" },
  { id: "search", label: "Search" },
];

export type FocusBarKey = "Tab" | "Shift+Tab" | "ArrowRight" | "ArrowLeft" | "Home" | "End";

export type FocusBarState = {
  readonly items: readonly FocusBarItem[];
  readonly activeIndex: number;
  readonly activeId: FocusBarItemId;
};

export function createFocusBarState(
  items: readonly FocusBarItem[] = DEFAULT_FOCUS_BAR_ITEMS,
  initialIndex = 0,
): FocusBarState {
  if (items.length === 0) {
    throw new Error("focus bar requires at least one item");
  }
  const bounded = ((initialIndex % items.length) + items.length) % items.length;
  const active = items[bounded];
  if (active === undefined) {
    throw new Error("focus bar index out of range");
  }
  return { items, activeIndex: bounded, activeId: active.id };
}

export function stepFocusBar(state: FocusBarState, key: FocusBarKey): FocusBarState {
  const len = state.items.length;
  let nextIndex = state.activeIndex;
  switch (key) {
    case "Tab":
    case "ArrowRight":
      nextIndex = (state.activeIndex + 1) % len;
      break;
    case "Shift+Tab":
    case "ArrowLeft":
      nextIndex = (state.activeIndex - 1 + len) % len;
      break;
    case "Home":
      nextIndex = 0;
      break;
    case "End":
      nextIndex = len - 1;
      break;
  }
  const active = state.items[nextIndex];
  if (active === undefined) return state;
  return { ...state, activeIndex: nextIndex, activeId: active.id };
}

export function focusBarSelect(state: FocusBarState, id: FocusBarItemId): FocusBarState {
  const idx = state.items.findIndex((item) => item.id === id);
  if (idx === -1) return state;
  return { ...state, activeIndex: idx, activeId: id };
}
