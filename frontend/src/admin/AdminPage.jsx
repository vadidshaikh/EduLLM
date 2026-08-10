import { useCallback, useEffect, useState } from "react";
import { deleteDocument, listDocuments, updateDocumentRoles, uploadDocument, ApiError } from "../api/client";
import DocumentsTable from "./DocumentsTable";
import UploadForm from "./UploadForm";

/**
 * Shows the admin page with a form to upload documents and a table listing all uploaded documents.
 */
export default function AdminPage({ auth }) {
  const [documents, setDocuments] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");

  /**
   * Fetches the latest list of documents from the server and updates the page, showing an error message if it fails.
   */
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

  /**
   * Uploads a new document and then refreshes the document list, showing an error if the upload fails.
   */
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

  /**
   * Deletes a document and refreshes the document list, showing an error if deletion fails.
   */
  async function handleDelete(documentId) {
    try {
      await deleteDocument(auth.token, documentId);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Delete failed.");
    }
  }

  /**
   * Changes a document's access roles and refreshes the document list, showing an error if it fails.
   */
  async function handleUpdateRoles(documentId, allowedRoles) {
    try {
      await updateDocumentRoles(auth.token, documentId, allowedRoles);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to update access.");
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
          <DocumentsTable documents={documents} onDelete={handleDelete} onUpdateRoles={handleUpdateRoles} />
        </div>
      </div>
    </div>
  );
}
