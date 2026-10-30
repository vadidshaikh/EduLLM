/**
 * A loading line: a small spinner and what's loading. It fades in after a
 * short delay, so quick loads don't flash it.
 */
export default function Loading({ label = "Loading", compact = false }) {
  return (
    <p className={`loading${compact ? " is-compact" : ""}`} role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      {label}
    </p>
  );
}
