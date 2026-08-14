import { useCallback, useEffect, useState } from "react";
import {
  deleteDocument,
  listDocuments,
  renameDocument,
  updateDocumentRoles,
  uploadDocument,
  ApiError,
} from "../api/client";
import DocumentsTable from "./DocumentsTable";
import UploadForm from "./UploadForm";
import BulkUploadForm from "./BulkUploadForm";

/**
 * Shows the admin page with a form to upload documents and a table listing all uploaded documents.
 */
export default function AdminPage({ auth }) {
  const [documents, setDocuments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [listError, setListError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");

  /**
   * Fetches the latest list of documents from the server and updates the page, showing an error message if it fails.
   * On failure, the previously loaded list (if any) is kept on screen instead of being blanked out.
   */
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const docs = await listDocuments(auth.token);
      setDocuments(docs);
      setLoaded(true);
      setListError("");
    } catch (err) {
      setListError(err instanceof ApiError ? err.message : "Failed to load documents.");
    } finally {
      setLoading(false);
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
   * Uploads several files at once, each titled after its own filename by
   * default (renameable later from the table), refreshing once at the end.
   */
  async function handleBulkUpload(files, allowedRoles) {
    setUploading(true);
    setError("");
    try {
      for (const file of files) {
        const title = file.name.replace(/\.[^/.]+$/, "") || file.name;
        await uploadDocument(auth.token, { file, title, allowedRoles });
      }
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Bulk upload failed.");
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
   * Renames a document and refreshes the document list, showing an error if it fails.
   */
  async function handleRename(documentId, title) {
    try {
      await renameDocument(auth.token, documentId, title);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Rename failed.");
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
          <h2>Upload documents</h2>
          <UploadForm onUpload={handleUpload} uploading={uploading} error={error} />
          <BulkUploadForm onUpload={handleBulkUpload} uploading={uploading} />
        </div>
        <div className="admin-panel">
          <div className="admin-panel-header">
            <h2>Documents</h2>
            <button className="btn" onClick={refresh} disabled={loading}>
              {loading ? "Refreshing..." : "Refresh"}
            </button>
          </div>
          <DocumentsTable
            documents={documents}
            loading={loading}
            loaded={loaded}
            error={listError}
            onRetry={refresh}
            onDelete={handleDelete}
            onRename={handleRename}
            onUpdateRoles={handleUpdateRoles}
          />
        </div>
      </div>
    </div>
  );
}
