import { useEffect, useState } from "react";
import { ApiError, listAllDocumentEvents, listDocumentEvents } from "../api/client";

const ACTION_LABELS = { uploaded: "Uploaded", updated: "Updated", deleted: "Deleted" };

/**
 * Side drawer showing the document audit log: recent uploads, updates and
 * deletes across all documents (deleted ones included). Clicking a document
 * narrows the list to that document's full history. Read-only.
 * `initialDocument` ({id, title}) opens the drawer already narrowed.
 */
export default function ActivityDrawer({ token, initialDocument = null, onClose }) {
  const [filter, setFilter] = useState(initialDocument); // {id, title} when narrowed to one document
  const [result, setResult] = useState({ key: null, events: [], error: "" });

  const key = filter ? filter.id : "all";

  useEffect(() => {
    let cancelled = false;
    const load = filter ? listDocumentEvents(token, filter.id) : listAllDocumentEvents(token);
    load
      .then((events) => {
        if (!cancelled) setResult({ key, events, error: "" });
      })
      .catch((err) => {
        if (!cancelled) {
          setResult({ key, events: [], error: err instanceof ApiError ? err.message : "Failed to load activity." });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [token, filter, key]);

  useEffect(() => {
    function handleEsc(event) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleEsc);
    return () => window.removeEventListener("keydown", handleEsc);
  }, [onClose]);

  const loading = result.key !== key;

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()} aria-label="Document activity">
        <div className="drawer-header">
          <h2 title={filter?.title}>{filter ? `History: ${filter.title}` : "Activity"}</h2>
          <button className="btn-secondary btn btn-inline" onClick={onClose}>
            Close
          </button>
        </div>
        {filter && (
          <button className="btn-link drawer-back" onClick={() => setFilter(null)}>
            ← All activity
          </button>
        )}
        {loading && <p className="status-line">Loading activity...</p>}
        {!loading && result.error && <p className="status-line error">{result.error}</p>}
        {!loading && !result.error && result.events.length === 0 && (
          <p className="status-line">
            {filter
              ? "No recorded activity for this document yet. Changes are logged from the moment the audit log was added."
              : "No recorded activity yet."}
          </p>
        )}
        {!loading && result.events.length > 0 && (
          <ol className="history-list">
            {result.events.map((event) => (
              <li key={event.id} className="history-item">
                <div>
                  <span className={`pill action-${event.action}`}>{ACTION_LABELS[event.action] ?? event.action}</span>
                  {filter ? (
                    <span>v{event.version}</span>
                  ) : (
                    <button
                      className="btn-link history-doc-link"
                      title="Show this document's history"
                      onClick={() => setFilter({ id: event.document_id, title: event.document_title })}
                    >
                      {event.document_title}
                    </button>
                  )}
                </div>
                <div className="history-meta">
                  <span title={event.actor_email}>{event.actor_name}</span>
                  {filter ? ` · ${event.document_title}` : ` · v${event.version}`} ·{" "}
                  {new Date(event.created_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
                </div>
              </li>
            ))}
          </ol>
        )}
      </aside>
    </div>
  );
}
