import { useCallback, useEffect, useState } from "react";
import {
  addClassroomStudents,
  ApiError,
  createClassroom,
  listClassroomStudents,
  regenerateJoinCode,
  removeClassroomStudent,
  updateClassroom,
} from "../api/client";

/**
 * Turns a caught error into a message to show.
 */
function errorText(err, fallback) {
  return err instanceof ApiError ? err.message : fallback;
}

/**
 * Lists a shared workspace's classrooms with their join codes, and lets any
 * of its faculty create, edit, archive / restore them and manage their
 * students. `onChanged` reloads the classrooms (they're owned by the parent,
 * which also needs them for publishing documents).
 */
export default function ClassroomsPanel({ token, workspaceId, classrooms, onChanged }) {
  const [form, setForm] = useState({ name: "", subject: "", term: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [openId, setOpenId] = useState(null); // classroom whose students are shown

  async function handleCreate(e) {
    e.preventDefault();
    if (!form.name.trim()) return;
    setSaving(true);
    setError("");
    try {
      await createClassroom(token, workspaceId, form);
    } catch (err) {
      setError(errorText(err, "Couldn't create the classroom."));
      return;
    } finally {
      setSaving(false);
    }
    setForm({ name: "", subject: "", term: "" });
    onChanged();
  }

  /**
   * Runs one change to a classroom, then reloads the list.
   */
  async function run(action, fallback) {
    setError("");
    try {
      await action();
      onChanged();
    } catch (err) {
      setError(errorText(err, fallback));
    }
  }

  return (
    <div className="panel">
      <h2>Classrooms</h2>
      <p className="panel-hint">
        Students join a classroom with its code, or you add them by email. They can ask about the documents
        published to their classrooms.
      </p>
      <form className="inline-form" onSubmit={handleCreate}>
        <input
          className="input"
          placeholder="Classroom name, e.g. CO Sem 5, Div A"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
        <input
          className="input"
          placeholder="Subject (optional)"
          value={form.subject}
          onChange={(e) => setForm({ ...form, subject: e.target.value })}
        />
        <input
          className="input"
          placeholder="Term, e.g. 2026-27 Odd"
          value={form.term}
          onChange={(e) => setForm({ ...form, term: e.target.value })}
        />
        <button className="btn" type="submit" disabled={saving || !form.name.trim()}>
          {saving ? "Creating..." : "Create"}
        </button>
      </form>
      {error && <div className="form-error">{error}</div>}

      {classrooms.length === 0 ? (
        <p className="form-note">No classrooms yet.</p>
      ) : (
        <ul className="classroom-list">
          {classrooms.map((c) => (
            <ClassroomRow
              key={c.id}
              token={token}
              classroom={c}
              open={openId === c.id}
              onToggleOpen={() => setOpenId(openId === c.id ? null : c.id)}
              onRun={run}
              onChanged={onChanged}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * One classroom: details (editable), join code, and actions; expands to its students.
 */
function ClassroomRow({ token, classroom: c, open, onToggleOpen, onRun, onChanged }) {
  const [editing, setEditing] = useState(null); // {name, subject, term} while editing
  const [copied, setCopied] = useState(false);
  const archived = Boolean(c.archived_at);

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(c.join_code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard blocked (e.g. non-https) — the code is on screen anyway
    }
  }

  function saveEdit() {
    if (!editing.name.trim()) return;
    onRun(() => updateClassroom(token, c.id, editing), "Couldn't save the classroom.");
    setEditing(null);
  }

  return (
    <li className={`classroom-item${archived ? " archived" : ""}`}>
      <div className="classroom-row">
        {editing ? (
          <div className="inline-form classroom-edit">
            <input
              className="input"
              value={editing.name}
              autoFocus
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
            />
            <input
              className="input"
              placeholder="Subject"
              value={editing.subject}
              onChange={(e) => setEditing({ ...editing, subject: e.target.value })}
            />
            <input
              className="input"
              placeholder="Term"
              value={editing.term}
              onChange={(e) => setEditing({ ...editing, term: e.target.value })}
            />
            <button className="link" onClick={saveEdit}>
              Save
            </button>
            <button className="link" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        ) : (
          <div className="classroom-main">
            <div className="classroom-name">
              {c.name}
              {archived && <span className="tag-pill">archived</span>}
            </div>
            <div className="classroom-meta">
              {[c.subject, c.term].filter(Boolean).join(" · ") || "No subject or term"} ·{" "}
              {c.student_count} student{c.student_count === 1 ? "" : "s"}
            </div>
          </div>
        )}
        {!editing && (
          <div className="classroom-actions">
            {!archived && (
              <span className="join-code" title="Join code">
                {c.join_code}
              </span>
            )}
            {!archived && (
              <button className="link" onClick={copyCode}>
                {copied ? "Copied" : "Copy"}
              </button>
            )}
            {!archived && (
              <button
                className="link"
                onClick={() => {
                  if (window.confirm(`Replace the join code for "${c.name}"? The current code will stop working.`)) {
                    onRun(() => regenerateJoinCode(token, c.id), "Couldn't change the code.");
                  }
                }}
              >
                New code
              </button>
            )}
            <button className="link" onClick={onToggleOpen}>
              {open ? "Hide students" : "Students"}
            </button>
            <button
              className="link"
              onClick={() => setEditing({ name: c.name, subject: c.subject ?? "", term: c.term ?? "" })}
            >
              Edit
            </button>
            <button
              className="link"
              onClick={() => {
                const prompt = archived
                  ? `Restore "${c.name}"? Its students get access to its documents again.`
                  : `Archive "${c.name}"? Its students lose access to its documents until it's restored.`;
                if (window.confirm(prompt)) {
                  onRun(() => updateClassroom(token, c.id, { archived: !archived }), "Couldn't update the classroom.");
                }
              }}
            >
              {archived ? "Restore" : "Archive"}
            </button>
          </div>
        )}
      </div>
      {open && <StudentsList token={token} classroomId={c.id} onChanged={onChanged} />}
    </li>
  );
}

/**
 * A classroom's students, with remove buttons and a box to bulk-add by
 * pasting emails (one per line, comma-separated, or a CSV).
 */
function StudentsList({ token, classroomId, onChanged }) {
  const [students, setStudents] = useState(null);
  const [error, setError] = useState("");
  const [pasted, setPasted] = useState("");
  const [result, setResult] = useState("");
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => {
    listClassroomStudents(token, classroomId)
      .then((rows) => {
        setStudents(rows);
        setError("");
      })
      .catch((err) => setError(errorText(err, "Couldn't load students.")));
  }, [token, classroomId]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleAdd(e) {
    e.preventDefault();
    if (!pasted.trim()) return;
    setAdding(true);
    setResult("");
    try {
      const r = await addClassroomStudents(token, classroomId, pasted);
      const parts = [`Added ${r.added}`];
      if (r.already_in) parts.push(`${r.already_in} already in`);
      if (r.rejected.length) parts.push(`not student emails: ${r.rejected.join(", ")}`);
      setResult(parts.join(" · "));
      setPasted("");
      load();
      onChanged();
    } catch (err) {
      setResult(errorText(err, "Couldn't add students."));
    } finally {
      setAdding(false);
    }
  }

  async function handleRemove(email) {
    if (!window.confirm(`Remove ${email} from this classroom?`)) return;
    try {
      await removeClassroomStudent(token, classroomId, email);
      load();
      onChanged();
    } catch (err) {
      setError(errorText(err, "Couldn't remove the student."));
    }
  }

  return (
    <div className="students-box">
      <form className="students-add" onSubmit={handleAdd}>
        <textarea
          className="input"
          rows={3}
          placeholder="Paste student emails: one per line, comma-separated, or a CSV"
          value={pasted}
          onChange={(e) => setPasted(e.target.value)}
        />
        <button className="btn btn-ghost" type="submit" disabled={adding || !pasted.trim()}>
          {adding ? "Adding..." : "Add students"}
        </button>
      </form>
      {result && <div className="form-note">{result}</div>}
      {error && <div className="form-error">{error}</div>}
      {students === null && !error && <p className="form-note">Loading students...</p>}
      {students?.length === 0 && <p className="form-note">No students yet. Share the join code, or add them above.</p>}
      {students?.length > 0 && (
        <ul className="people-list">
          {students.map((s) => (
            <li key={s.email}>
              <span>
                {s.name ?? <span className="who">Not signed in yet</span>} <span className="who">{s.email}</span>
              </span>
              <span className="who">{s.added_by ? "added by faculty" : "joined with code"}</span>
              <button className="link" onClick={() => handleRemove(s.email)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
