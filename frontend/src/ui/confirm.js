// The mounted <ConfirmHost />'s way of showing a request (ui/ConfirmHost.jsx); null when none is mounted.
let show = null;

export function setConfirmHandler(handler) {
  show = handler;
}

/**
 * The app's own replacement for window.confirm: shows a dialog and resolves
 * to true (confirmed) or false (cancelled, Escape, or clicking outside).
 *   if (!(await confirmDialog({ title: "Delete this note?", message, confirmLabel: "Delete", danger: true }))) return;
 * Falls back to window.confirm if no ConfirmHost is mounted.
 */
export function confirmDialog({ title, message = "", confirmLabel = "OK", cancelLabel = "Cancel", danger = false }) {
  if (!show) return Promise.resolve(window.confirm([title, message].filter(Boolean).join("\n\n")));
  return new Promise((resolve) => show({ title, message, confirmLabel, cancelLabel, danger, resolve }));
}
