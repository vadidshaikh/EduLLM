/**
 * Where a note stands with its published copy, as {text, tone} for a
 * status pill: a draft, being indexed, published (to whom), or edited since.
 */
export function publishState(note, classrooms) {
  if (!note.document_id) return { text: "Draft, not published", tone: "muted" };
  if (note.document_status === "failed") return { text: "Publishing failed", tone: "bad" };
  if (note.document_status !== "indexed") return { text: `Publishing, ${note.document_progress ?? 0}%`, tone: "busy" };
  if (new Date(note.updated_at) > new Date(note.published_at)) return { text: "Edited since publishing", tone: "warn" };
  const ids = note.document_classroom_ids ?? [];
  if (!ids.length) return { text: "Published, faculty only", tone: "ok" };
  const names = new Map(classrooms.map((c) => [c.id, c.name]));
  return { text: `Published to ${ids.map((id) => names.get(id) ?? "a classroom").join(", ")}`, tone: "ok" };
}
