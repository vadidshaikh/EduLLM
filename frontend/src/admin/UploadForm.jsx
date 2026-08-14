import { useRef, useState } from "react";
import "./UploadFormFile.css";

/**
 * Shows a form for typing a title (defaulting to the picked file's name),
 * picking a file, and marking it classified (faculty-only) or open to
 * everyone, then uploading it.
 */
export default function UploadForm({ onUpload, uploading, error }) {
  const [file, setFile] = useState(null);
  const [title, setTitle] = useState("");
  const [titleEdited, setTitleEdited] = useState(false);
  const [classified, setClassified] = useState(false);
  const fileInputRef = useRef(null);

  /**
   * Records the picked file and, unless the title was already hand-edited,
   * fills the title in with the file's name (without its extension).
   */
  function handleFileChange(e) {
    const selected = e.target.files?.[0] ?? null;
    setFile(selected);
    if (selected && !titleEdited) {
      setTitle(selected.name.replace(/\.[^/.]+$/, "") || selected.name);
    }
  }

  function handleTitleChange(e) {
    setTitle(e.target.value);
    setTitleEdited(true);
  }

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
          placeholder="Document title"
          value={title}
          onChange={handleTitleChange}
        />
        <button
          type="button"
          className="btn-secondary btn choose-file-btn"
          onClick={() => fileInputRef.current?.click()}
        >
          {file ? file.name : "Choose File"}
        </button>
        <input
          ref={fileInputRef}
          className="file-input-hidden"
          type="file"
          onChange={handleFileChange}
        />
      </div>
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
