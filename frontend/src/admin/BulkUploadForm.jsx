import { useRef, useState } from "react";

/**
 * Lets a faculty member pick several files at once and upload them all in
 * one go. Each document is titled after its own filename by default —
 * titles aren't collected per-file here to avoid clutter, but can be
 * changed afterwards from the documents table.
 */
export default function BulkUploadForm({ onUpload, uploading }) {
  const [files, setFiles] = useState([]);
  const [classified, setClassified] = useState(false);
  const fileInputRef = useRef(null);

  function handleFilesChange(e) {
    setFiles(Array.from(e.target.files ?? []));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (files.length === 0) return;
    const allowedRoles = classified ? ["faculty"] : ["student", "faculty"];
    await onUpload(files, allowedRoles);
    setFiles([]);
    setClassified(false);
    e.target.reset();
  }

  return (
    <form className="upload-form bulk-upload-form" onSubmit={handleSubmit}>
      <div className="bulk-upload-row">
        <button
          type="button"
          className="btn-secondary btn"
          onClick={() => fileInputRef.current?.click()}
        >
          {files.length > 0 ? `${files.length} file(s) selected` : "Bulk Upload..."}
        </button>
        <input
          ref={fileInputRef}
          className="file-input-hidden"
          type="file"
          multiple
          onChange={handleFilesChange}
        />
        <label className="bulk-classified-label">
          <input
            type="checkbox"
            checked={classified}
            onChange={(e) => setClassified(e.target.checked)}
          />
          Classified (faculty only)
        </label>
        <button
          className="btn bulk-upload-submit"
          type="submit"
          disabled={uploading || files.length === 0}
        >
          {uploading ? "Uploading..." : "Upload All"}
        </button>
      </div>
      {files.length > 0 && (
        <p className="status-line">Titles will default to filenames — rename any of them later.</p>
      )}
    </form>
  );
}
