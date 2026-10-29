import { useState } from "react";

/**
 * Formats a timestamp as a short date + time.
 */
function formatDateTime(iso) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}

/**
 * Shows a table of uploaded documents with a rename control, classified
 * toggle, status, who uploaded / last updated it, plus a delete button for
 * each. Clicking a title opens that document's activity.
 */
export default function DocumentsTable({
  documents,
  loading,
  loaded,
  error,
  onRetry,
  onDelete,
  onRename,
  onUpdateRoles,
  onShowActivity,
}) {
  if (error) {
    return (
      <div className="status-line error">
        {error}{" "}
        <button className="btn-secondary btn btn-inline" onClick={onRetry}>
          Retry
        </button>
      </div>
    );
  }

  if (!loaded && loading) {
    return <p className="status-line">Loading documents...</p>;
  }

  if (documents.length === 0) {
    return <p className="status-line">No documents uploaded yet.</p>;
  }

  return (
    <table className="documents-table">
      <colgroup>
        <col className="col-title" />
        <col className="col-classified" />
        <col className="col-status" />
        <col className="col-activity" />
        <col className="col-actions" />
      </colgroup>
      <thead>
        <tr>
          <th>Title</th>
          <th>Classified</th>
          <th>Status</th>
          <th>Uploaded / updated</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {documents.map((doc) => {
          const classified = doc.allowed_roles.length === 1 && doc.allowed_roles[0] === "faculty";
          return (
            <tr key={doc.id}>
              <td>
                <DocumentTitleCell
                  title={doc.title}
                  onRename={(title) => onRename(doc.id, title)}
                  onShowActivity={() => onShowActivity(doc)}
                />
              </td>
              <td>
                <label className="classified-label">
                  <input
                    type="checkbox"
                    checked={classified}
                    onChange={(e) =>
                      onUpdateRoles(doc.id, e.target.checked ? ["faculty"] : ["student", "faculty"])
                    }
                  />
                  Faculty only
                </label>
              </td>
              <td>
                <StatusCell status={doc.status} progress={doc.progress} />
              </td>
              <td className="activity-cell">
                <div title={doc.uploaded_by}>
                  {doc.uploaded_by_name || doc.uploaded_by} · {formatDateTime(doc.uploaded_at)}
                </div>
                {doc.updated_by && (
                  <div className="activity-updated" title={doc.updated_by}>
                    Updated by {doc.updated_by_name || doc.updated_by} · {formatDateTime(doc.updated_at)}
                  </div>
                )}
              </td>
              <td>
                <button
                  className="btn btn-danger"
                  onClick={() => {
                    if (window.confirm(`Delete "${doc.title}"? This can't be undone.`)) {
                      onDelete(doc.id);
                    }
                  }}
                >
                  Delete
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * Shows a document's indexing status. While it's queued or actively being
 * processed, shows a progress bar with a percentage instead of just the bare
 * status word, so a long-running upload doesn't look stuck.
 */
function StatusCell({ status, progress }) {
  if (status === "queued" || status === "processing") {
    const pct = Math.max(0, Math.min(100, progress ?? 0));
    return (
      <div className="status-progress-bar" title={`${status} - ${pct}%`}>
        <div className="status-progress-fill" style={{ width: `${pct}%` }} />
        <span className="status-progress-label">
          {status} {pct}%
        </span>
      </div>
    );
  }

  return <span className={`pill status-${status}`}>{status}</span>;
}

/**
 * Shows a document's title (click to see its activity) with a rename button, swapping to
 * an editable input (with save/cancel) when the button is clicked.
 */
function DocumentTitleCell({ title, onRename, onShowActivity }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);

  function startEditing() {
    setValue(title);
    setEditing(true);
  }

  function cancel() {
    setEditing(false);
  }

  function save() {
    const trimmed = value.trim();
    setEditing(false);
    if (trimmed && trimmed !== title) {
      onRename(trimmed);
    }
  }

  if (!editing) {
    return (
      <div className="title-cell">
        <button className="title-text title-activity-link" title={`${title} — show activity`} onClick={onShowActivity}>
          {title}
        </button>
        <button className="btn-link title-rename-btn" onClick={startEditing} aria-label="Rename document">
          Rename
        </button>
      </div>
    );
  }

  return (
    <div className="title-cell">
      <input
        className="input title-edit-input"
        type="text"
        value={value}
        autoFocus
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") cancel();
        }}
      />
      <button className="btn-link" onClick={save}>
        Save
      </button>
      <button className="btn-link" onClick={cancel}>
        Cancel
      </button>
    </div>
  );
}
