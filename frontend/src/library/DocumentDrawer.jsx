import { useEffect, useState } from "react";
import {
  ApiError,
  deleteDocument,
  listDocumentEvents,
  renameDocument,
  updateDocumentAccess,
} from "../api/client";
import Icon from "../ui/Icons";
import { Spine } from "../ui/Shelf";
import { spineStatus } from "../ui/spines";
import { confirmDialog } from "../ui/confirm";
import { useDocViewer } from "../ui/useDocViewer";
import Loading from "../ui/Loading";

const ACTION_TEXT = { uploaded: "Added", updated: "Updated", deleted: "Removed" };

function formatDate(iso) {
  return new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

/**
 * Side drawer for one document: rename it, choose who can read it (what's
 * offered depends on `place`), see its audit history, and remove it. Every
 * change is saved straight away. `place` is {kind: "library"|"personal"|"shared",
 * name, classrooms, memberCount}.
 */
export default function DocumentDrawer({ token, doc, place, onClose, onChanged, onRemoved }) {
  const [title, setTitle] = useState(doc.title);
  const [events, setEvents] = useState(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const status = spineStatus(doc);
  const docViewer = useDocViewer(token);
  const viewerOpen = docViewer.isOpen;

  useEffect(() => {
    let cancelled = false;
    listDocumentEvents(token, doc.id)
      .then((rows) => !cancelled && setEvents(rows))
      .catch(() => !cancelled && setEvents([]));
    return () => {
      cancelled = true;
    };
  }, [token, doc.id, doc.version, doc.updated_at]);

  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape" && !viewerOpen) onClose(); // Escape closes the viewer first
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, viewerOpen]);

  /**
   * Runs one change and refreshes the library, showing the error if it fails.
   */
  async function run(action, fallback) {
    setSaving(true);
    setError("");
    try {
      await action();
      await onChanged();
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : fallback);
      return false;
    } finally {
      setSaving(false);
    }
  }

  function saveTitle() {
    const trimmed = title.trim();
    if (!trimmed || trimmed === doc.title) return;
    run(() => renameDocument(token, doc.id, trimmed), "Couldn't rename it.");
  }

  function setAccess(visibility, classroomIds = []) {
    run(() => updateDocumentAccess(token, doc.id, { visibility, classroomIds }), "Couldn't change who can read it.");
  }

  function toggleClassroom(classroomId, checked) {
    const next = checked
      ? [...doc.classroom_ids, classroomId]
      : doc.classroom_ids.filter((id) => id !== classroomId);
    setAccess(next.length ? "classrooms" : "workspace", next);
  }

  async function remove() {
    const ok = await confirmDialog({
      title: `Remove "${doc.title}"?`,
      message: "It disappears from answers straight away, and readers get a notice. This can't be undone.",
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    setSaving(true);
    try {
      await deleteDocument(token, doc.id);
      onRemoved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't remove it.");
      setSaving(false);
    }
  }

  return (
    <>
      <div className="scrim is-open" onClick={onClose} />
      <aside className="drawer is-open" aria-label="Document details">
        <div className="drawer-head">
          <Spine doc={doc} small size={[24, 92]} />
          <div>
            <h2>{doc.title}</h2>
            <p className="meta">
              In {place.name}, version {doc.version}
            </p>
            <button className="btn btn-ghost btn-sm drawer-open" onClick={() => docViewer.open(doc)}>
              <Icon name="download" /> Open {doc.filename?.split(".").pop()?.toUpperCase() || "file"}
            </button>
            {status === "failed" && (
              <p className="meta" style={{ color: "var(--danger)" }}>
                Indexing failed: no readable text was found. Upload a text-based copy.
              </p>
            )}
            {status === "indexing" && (
              <p className="meta" style={{ color: "var(--accent)" }}>
                Indexing, {doc.progress ?? 0}% done
              </p>
            )}
          </div>
          <button className="icon-btn" aria-label="Close" autoFocus onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        <div className="drawer-body">
          {(error || docViewer.error) && <p className="form-error">{error || docViewer.error}</p>}
          <div>
            <h3>
              <label htmlFor="rename">Title shown in answers</label>
            </h3>
            <div className="row">
              <input
                className="input"
                id="rename"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && saveTitle()}
              />
              <button
                className="btn btn-ghost"
                disabled={saving || !title.trim() || title.trim() === doc.title}
                onClick={saveTitle}
              >
                Save
              </button>
            </div>
          </div>

          <div>
            <h3>{place.kind === "shared" ? "Publish to classrooms" : "Who can read it"}</h3>
            <AccessControls place={place} doc={doc} disabled={saving} onLibrary={setAccess} onToggle={toggleClassroom} />
          </div>

          <div>
            <h3>History</h3>
            {events === null ? (
              <Loading label="Loading history" compact />
            ) : events.length === 0 ? (
              <p className="form-note">No recorded changes yet.</p>
            ) : (
              <ul className="timeline">
                {events.map((e) => (
                  <li key={e.id}>
                    {ACTION_TEXT[e.action] ?? e.action}
                    {e.action === "updated" ? `, version ${e.version}` : ""}
                    <small>
                      <span title={e.actor_email}>{e.actor_name}</span>, {formatDate(e.created_at)}
                    </small>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="danger-zone">
            <button className="btn btn-danger" disabled={saving} onClick={remove}>
              Remove from library
            </button>
            <p className="form-note" style={{ marginTop: ".5rem" }}>
              Everyone who could read it gets a notice. Answers stop using it straight away.
            </p>
          </div>
        </div>
      </aside>
      {docViewer.viewer}
    </>
  );
}

/**
 * The access choices for where the document lives.
 */
function AccessControls({ place, doc, disabled, onLibrary, onToggle }) {
  if (place.kind === "library") {
    return (
      <div className="access">
        <label>
          <input
            type="radio"
            name="access"
            checked={doc.visibility === "institute"}
            disabled={disabled}
            onChange={() => onLibrary("institute")}
          />
          <b>Everyone</b>
          <small>Students and faculty</small>
        </label>
        <label>
          <input
            type="radio"
            name="access"
            checked={doc.visibility === "faculty"}
            disabled={disabled}
            onChange={() => onLibrary("faculty")}
          />
          <b>Faculty only</b>
          <small>Every faculty member, no students</small>
        </label>
      </div>
    );
  }

  if (place.kind === "personal") {
    return (
      <p className="note-box">
        <b>Only you can read this.</b> Personal workspaces have no classrooms. Upload it to a shared workspace to
        publish it to students.
      </p>
    );
  }

  const options = place.classrooms.filter((c) => !c.archived_at || doc.classroom_ids.includes(c.id));
  return (
    <>
      {options.length > 0 ? (
        <div className="publish">
          {options.map((c) => (
            <label key={c.id}>
              <input
                type="checkbox"
                checked={doc.classroom_ids.includes(c.id)}
                disabled={disabled}
                onChange={(e) => onToggle(c.id, e.target.checked)}
              />
              <span>
                <b>{c.name}</b>
                <small>
                  {c.archived_at ? "Archived" : `${c.student_count} student${c.student_count === 1 ? "" : "s"}`}
                  {c.subject ? `, ${c.subject}` : ""}
                </small>
              </span>
            </label>
          ))}
        </div>
      ) : (
        <p className="note-box">This workspace has no classrooms yet. Create one in the Classrooms tab to publish to students.</p>
      )}
      <p className="note-box" style={{ marginTop: ".5rem" }}>
        All {place.memberCount} faculty in {place.name} can always read it.
        {doc.classroom_ids.length === 0 && <b> Students can&apos;t see it yet.</b>}
      </p>
    </>
  );
}
