import { useState } from "react";

/**
 * Shows a table of uploaded documents with a rename control, classified
 * toggle, status, version and upload date, plus a delete button for each.
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
        <col className="col-version" />
        <col className="col-uploaded" />
        <col className="col-actions" />
      </colgroup>
      <thead>
        <tr>
          <th>Title</th>
          <th>Classified</th>
          <th>Status</th>
          <th>Version</th>
          <th>Uploaded</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {documents.map((doc) => {
          const classified = doc.allowed_roles.length === 1 && doc.allowed_roles[0] === "faculty";
          return (
            <tr key={doc.id}>
              <td>
                <DocumentTitleCell title={doc.title} onRename={(title) => onRename(doc.id, title)} />
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
                <span className={`pill status-${doc.status}`}>{doc.status}</span>
              </td>
              <td>{doc.version}</td>
              <td className="uploaded-cell">
                {new Date(doc.uploaded_at).toLocaleString(undefined, {
                  dateStyle: "short",
                  timeStyle: "short",
                })}
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
 * Shows a document's title as plain text with a rename button, swapping to
 * an editable input (with save/cancel) when the button is clicked.
 */
function DocumentTitleCell({ title, onRename }) {
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
        <span className="title-text" title={title}>
          {title}
        </span>
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
