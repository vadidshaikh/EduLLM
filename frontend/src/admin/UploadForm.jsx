import { useState } from "react";
import "./UploadFormFile.css";

const ROLES = ["student", "faculty"];

/**
 * Shows a form for picking a file, typing a title, and choosing which roles can see it, then uploading it.
 */
export default function UploadForm({ onUpload, uploading, error }) {
  const [file, setFile] = useState(null);
  const [title, setTitle] = useState("");
  const [roles, setRoles] = useState(["student", "faculty"]);

  /**
   * Adds or removes a role from the selected roles list when its checkbox is clicked.
   */
  function toggleRole(role) {
    setRoles((prev) => (prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role]));
  }

  /**
   * Sends the selected file, title and roles to be uploaded when the form is submitted, then clears the form.
   */
  async function handleSubmit(e) {
    e.preventDefault();
    if (!file || !title.trim() || roles.length === 0) return;
    await onUpload({ file, title: title.trim(), allowedRoles: roles });
    setFile(null);
    setTitle("");
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
        {ROLES.map((role) => (
          <label key={role}>
            <input type="checkbox" checked={roles.includes(role)} onChange={() => toggleRole(role)} />
            {role}
          </label>
        ))}
      </div>
      {error && <div className="status-line error">{error}</div>}
      <button className="btn" type="submit" disabled={uploading} style={{ alignSelf: "flex-start" }}>
        {uploading ? "Uploading..." : "Upload"}
      </button>
    </form>
  );
}
