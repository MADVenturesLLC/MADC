/**
 * M3-A2 (`docs/plan/PLAN-madc-M3-build-plan.md` §2 row M3-A2):
 * Minimal, neutral keyboard focus bar state controller.
 *
 * Keeps focusable shell landmarks keyboard-navigable (`Tab`, `Shift+Tab`, `ArrowRight`,
 * `ArrowLeft`, `Home`, `End`) without introducing M3-A3 design tokens, command palette, or
 * decorative green indicators.
 *
 * Runtime implementation lives in `../ui/shell.js` so `ui/index.html` runs the exact tested code.
 */

export type FocusBarItemId = "connection" | "room" | "decisions" | "search";

export type FocusBarItem = {
  readonly id: FocusBarItemId;
  readonly label: string;
};

export type FocusBarKey = "Tab" | "Shift+Tab" | "ArrowRight" | "ArrowLeft" | "Home" | "End";

export type FocusBarState = {
  readonly items: readonly FocusBarItem[];
  readonly activeIndex: number;
  readonly activeId: FocusBarItemId;
};

export {
  createFocusBarState,
  DEFAULT_FOCUS_BAR_ITEMS,
  focusBarSelect,
  stepFocusBar,
} from "../ui/shell.js";
