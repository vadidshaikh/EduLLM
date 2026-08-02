import { useCallback, useEffect, useState } from "react";
import { deleteDocument, listDocuments, uploadDocument, ApiError } from "../api/client";
import DocumentsTable from "./DocumentsTable";
import UploadForm from "./UploadForm";

export default function AdminPage({ auth }) {
  const [documents, setDocuments] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      setDocuments(await listDocuments(auth.token));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load documents.");
    }
  }, [auth.token]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- standard fetch-on-mount
    refresh();
  }, [refresh]);

  async function handleUpload(payload) {
    setUploading(true);
    setError("");
    try {
      await uploadDocument(auth.token, payload);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete(documentId) {
    try {
      await deleteDocument(auth.token, documentId);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Delete failed.");
    }
  }

  return (
    <div className="page">
      <div className="admin-container">
        <div className="admin-panel">
          <h2>Upload a document</h2>
          <UploadForm onUpload={handleUpload} uploading={uploading} error={error} />
        </div>
        <div className="admin-panel">
          <h2>Documents</h2>
          <DocumentsTable documents={documents} onDelete={handleDelete} />
        </div>
      </div>
    </div>
  );
}
