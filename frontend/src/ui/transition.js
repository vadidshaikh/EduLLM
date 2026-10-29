import { flushSync } from "react-dom";

const supported = typeof document !== "undefined" && "startViewTransition" in document;

/**
 * Runs a state change (switching view, shelf, tab, theme...) as a view
 * transition: the browser snapshots the page, applies `update`, and
 * cross-fades to the result, while named parts (topbar, shelf switcher,
 * history; see theme.css) move or slide instead of jumping. Falls back to
 * a plain update where unsupported or when reduced motion is preferred.
 *
 * `update` is flushed synchronously so the new state is what gets captured;
 * this is why BrowserRouter runs with useTransitions={false} (main.jsx).
 */
export function smoothly(update) {
  if (!supported || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    update();
    return;
  }
  document.startViewTransition(() => flushSync(update));
}
