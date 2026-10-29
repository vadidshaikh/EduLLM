/**
 * Helpers for drawing documents as book spines. Documents have no category
 * or page count in the backend, so a spine's colour ("tone", 1-6, from the
 * logo palette in theme.css) and size are derived from the document's id
 * and title: stable for a given document, varied across a shelf.
 */

const TONE_COUNT = 6;

/**
 * A stable 32-bit hash of a string (FNV-1a).
 */
export function hashString(value) {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * The spine colour slot (1-6) for a document, workspace or anything with an id.
 */
export function toneFor(id) {
  return (hashString(String(id)) % TONE_COUNT) + 1;
}

/**
 * CSS colour for a tone, e.g. for small marks that aren't full spines.
 */
export function toneColor(id) {
  return `var(--tone-${toneFor(id)})`;
}

/**
 * Width and height in px of a document's spine on a full-size shelf.
 */
export function spineSize(doc, scale = 1) {
  const h = hashString(String(doc.id));
  const height = (150 + (h % 5) * 13) * scale;
  const width = (22 + Math.min(doc.title.length, 48) * 0.3) * scale;
  return [Math.round(width), Math.round(height)];
}

/**
 * Where a document is in indexing, as a spine state: "indexing", "failed" or null when ready.
 */
export function spineStatus(doc) {
  if (doc.status === "queued" || doc.status === "processing") return "indexing";
  if (doc.status === "failed") return "failed";
  return null;
}

/**
 * Display name from an email's local part, matching the backend's
 * display_name_from_email: "jane.doe@x" -> "Jane Doe", "pawan.co23d1@x" -> "Pawan".
 */
export function nameFromEmail(email) {
  const local = (email ?? "").toLowerCase().split("@")[0];
  const words = local.split(".").filter((part) => part && !/\d/.test(part));
  return words.map((w) => w[0].toUpperCase() + w.slice(1)).join(" ") || local;
}

/**
 * A short relative time ("5m ago"), falling back to a date after a week.
 */
export function timeAgo(iso) {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 7 * 86400) return `${Math.floor(seconds / 86400)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
