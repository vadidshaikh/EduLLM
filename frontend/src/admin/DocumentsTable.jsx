/**
 * Shows a table of uploaded documents with their roles, status, version and upload date, plus a delete button for each.
 */
export default function DocumentsTable({ documents, onDelete }) {
  if (documents.length === 0) {
    return <p className="status-line">No documents uploaded yet.</p>;
  }

  return (
    <table className="documents-table">
      <thead>
        <tr>
          <th>Title</th>
          <th>Roles</th>
          <th>Status</th>
          <th>Version</th>
          <th>Uploaded</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {documents.map((doc) => (
          <tr key={doc.id}>
            <td>{doc.title}</td>
            <td>
              {doc.allowed_roles.map((role) => (
                <span key={role} className="pill">
                  {role}
                </span>
              ))}
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
        ))}
      </tbody>
    </table>
  );
}
