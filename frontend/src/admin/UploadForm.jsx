import { useState } from "react";
import "./UploadFormFile.css";

const ROLES = ["student", "faculty"];

export default function UploadForm({ onUpload, uploading, error }) {
  const [file, setFile] = useState(null);
  const [title, setTitle] = useState("");
  const [roles, setRoles] = useState(["student", "faculty"]);

  function toggleRole(role) {
    setRoles((prev) => (prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role]));
  }

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
