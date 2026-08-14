import { useRef, useState } from "react";
import "./UploadFormFile.css";

/**
 * Shows one upload form for both single and multi-file uploads.
 * If one file is selected, its title can be edited before upload.
 * If multiple files are selected, each file uses its own filename as title.
 */
export default function UploadForm({ onUpload, uploading, error }) {
  const [files, setFiles] = useState([]);
  const [title, setTitle] = useState("");
  const [titleEdited, setTitleEdited] = useState(false);
  const [classified, setClassified] = useState(false);
  const fileInputRef = useRef(null);

  /**
   * Records picked files and auto-fills the title when exactly one file is selected.
   */
  function handleFileChange(e) {
    const selectedFiles = Array.from(e.target.files ?? []);
    setFiles(selectedFiles);

    if (selectedFiles.length === 1 && !titleEdited) {
      const selected = selectedFiles[0];
      setTitle(selected.name.replace(/\.[^/.]+$/, "") || selected.name);
    }

    if (selectedFiles.length !== 1) {
      setTitleEdited(false);
      setTitle("");
    }
  }

  function handleTitleChange(e) {
    setTitle(e.target.value);
    setTitleEdited(true);
  }

  /**
   * Submits as single-upload logic for one file, or bulk-upload logic for many files.
   */
  async function handleSubmit(e) {
    e.preventDefault();
    if (files.length === 0) return;

    const allowedRoles = classified ? ["faculty"] : ["student", "faculty"];

    if (files.length === 1) {
      if (!title.trim()) return;
      await onUpload({ mode: "single", file: files[0], title: title.trim(), allowedRoles });
    } else {
      await onUpload({ mode: "bulk", files, allowedRoles });
    }

    setFiles([]);
    setTitle("");
    setTitleEdited(false);
    setClassified(false);
    e.target.reset();
  }

  return (
    <form className="upload-form" onSubmit={handleSubmit}>
      <div className="title-file-row">
        <input
          className="input"
          type="text"
          placeholder={files.length > 1 ? "Title is auto-set per file" : "Document title"}
          value={title}
          onChange={handleTitleChange}
          disabled={files.length > 1}
        />
        <button
          type="button"
          className="btn-secondary btn choose-file-btn"
          onClick={() => fileInputRef.current?.click()}
        >
          {files.length === 0
            ? "Choose File(s)"
            : files.length === 1
              ? files[0].name
              : `${files.length} file(s) selected`}
        </button>
        <input
          ref={fileInputRef}
          className="file-input-hidden"
          type="file"
          multiple
          onChange={handleFileChange}
        />
      </div>
      {files.length > 1 && (
        <div className="status-line">Multiple files selected: titles will default to filenames.</div>
      )}
      <div className="role-checkboxes">
        <label>
          <input
            type="checkbox"
            checked={classified}
            onChange={(e) => setClassified(e.target.checked)}
          />
          Classified (faculty only)
        </label>
      </div>
      {error && <div className="status-line error">{error}</div>}
      <button className="btn" type="submit" disabled={uploading} style={{ alignSelf: "flex-start" }}>
        {uploading ? "Uploading..." : files.length > 1 ? "Upload All" : "Upload"}
      </button>
    </form>
  );
}
