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
   * Uploads either one file (with the provided title) or multiple files
   * (each titled from its own filename), then refreshes once at the end.
   */
  async function handleUpload(payload) {
    setUploading(true);
    setError("");
    try {
      if (payload.mode === "bulk") {
        for (const file of payload.files) {
          const title = file.name.replace(/\.[^/.]+$/, "") || file.name;
          await uploadDocument(auth.token, { file, title, allowedRoles: payload.allowedRoles });
        }
      } else {
        await uploadDocument(auth.token, {
          file: payload.file,
          title: payload.title,
          allowedRoles: payload.allowedRoles,
        });
      }
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
          <h2>Upload document(s)</h2>
          <UploadForm onUpload={handleUpload} uploading={uploading} error={error} />
        </div>
        <div className="admin-panel">
          <div className="admin-panel-header">
            <h2>Documents</h2>
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
