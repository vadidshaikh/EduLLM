import { useState } from "react";
import "./UploadFormFile.css";

/**
 * Shows a form for picking a file, typing a title, and marking it classified (faculty-only) or open to everyone, then uploading it.
 */
export default function UploadForm({ onUpload, uploading, error }) {
  const [file, setFile] = useState(null);
  const [title, setTitle] = useState("");
  const [classified, setClassified] = useState(false);

  /**
   * Sends the selected file, title and derived roles to be uploaded when the form is submitted, then clears the form.
   */
  async function handleSubmit(e) {
    e.preventDefault();
    if (!file || !title.trim()) return;
    const allowedRoles = classified ? ["faculty"] : ["student", "faculty"];
    await onUpload({ file, title: title.trim(), allowedRoles });
    setFile(null);
    setTitle("");
    setClassified(false);
    e.target.reset();
  }

  return (
    <form className="upload-form" onSubmit={handleSubmit}>
      <input
        className="input"
        type="text"
        placeholder="Document title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <input
        className="input file-input"
        type="file"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
      />
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
        {uploading ? "Uploading..." : "Upload"}
      </button>
    </form>
  );
}
