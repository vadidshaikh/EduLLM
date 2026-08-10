/**
 * Shows a table of uploaded documents with a classified toggle, status, version and upload date, plus a delete button for each.
 */
export default function DocumentsTable({ documents, onDelete, onUpdateRoles }) {
  if (documents.length === 0) {
    return <p className="status-line">No documents uploaded yet.</p>;
  }

  return (
    <table className="documents-table">
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
              <td>{doc.title}</td>
              <td>
                <label>
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
              <td>{new Date(doc.uploaded_at).toLocaleString()}</td>
              <td>
                <button className="btn-secondary btn" onClick={() => onDelete(doc.id)}>
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
