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
import Icon from "../ui/Icons";
import { nameFromEmail, toneColor } from "../ui/spines";
import { confirmDialog } from "../ui/confirm";
import Loading from "../ui/Loading";

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

  async function toggleArchived() {
    const ok = await confirmDialog(
      archived
        ? { title: `Restore "${c.name}"?`, message: "Its students get access to its documents again.", confirmLabel: "Restore" }
        : {
            title: `Archive "${c.name}"?`,
            message: "Its students lose access to its documents and quizzes until it's restored.",
            confirmLabel: "Archive",
            danger: true,
          }
    );
    if (ok) onRun(() => updateClassroom(token, c.id, { archived: !archived }), "Couldn't update the classroom.");
  }

  async function newCode() {
    const ok = await confirmDialog({
      title: "Replace the join code?",
      message: `The current code for "${c.name}" stops working. Students already in stay in.`,
      confirmLabel: "New code",
    });
    if (ok) onRun(() => regenerateJoinCode(token, c.id), "Couldn't change the code.");
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
            <button className="btn btn-sm" onClick={saveEdit} disabled={!editing.name.trim()}>
              Save
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => setEditing(null)}>
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
              {[c.subject, c.term].filter(Boolean).join(" · ") || "No subject or term"}
            </div>
          </div>
        )}
        {!editing && (
          <div className="classroom-actions">
            {!archived && (
              <span className="code-chip">
                <span className="join-code" title="Join code">
                  {c.join_code}
                </span>
                <button className="icon-btn" title={copied ? "Copied" : "Copy join code"} aria-label="Copy join code" onClick={copyCode}>
                  <Icon name={copied ? "check" : "copy"} />
                </button>
                <button
                  className="icon-btn"
                  title="New join code"
                  aria-label="New join code"
                  onClick={newCode}
                >
                  <Icon name="refresh" />
                </button>
              </span>
            )}
            <button className="btn btn-ghost btn-sm" aria-expanded={open} onClick={onToggleOpen}>
              <Icon name="people" /> {c.student_count} student{c.student_count === 1 ? "" : "s"}
              <Icon name="chev" className={open ? "chev-up" : undefined} />
            </button>
            <button
              className="icon-btn"
              title="Edit name, subject, term"
              aria-label={`Edit ${c.name}`}
              onClick={() => setEditing({ name: c.name, subject: c.subject ?? "", term: c.term ?? "" })}
            >
              <Icon name="pen" />
            </button>
            {archived ? (
              <button className="btn btn-ghost btn-sm" onClick={toggleArchived}>
                Restore
              </button>
            ) : (
              <button className="icon-btn" title="Archive" aria-label={`Archive ${c.name}`} onClick={toggleArchived}>
                <Icon name="archive" />
              </button>
            )}
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
  const [adderShown, setAdderShown] = useState(false); // the paste box, once there are students
  const [query, setQuery] = useState("");

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
      setAdderShown(false);
      load();
      onChanged();
    } catch (err) {
      setResult(errorText(err, "Couldn't add students."));
    } finally {
      setAdding(false);
    }
  }

  async function handleRemove(email) {
    const ok = await confirmDialog({
      title: "Remove this student?",
      message: `${email} loses access to this classroom's documents and quizzes.`,
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    try {
      await removeClassroomStudent(token, classroomId, email);
      load();
      onChanged();
    } catch (err) {
      setError(errorText(err, "Couldn't remove the student."));
    }
  }

  const joined = students?.filter((x) => !x.added_by).length ?? 0;
  const pending = students?.filter((x) => !x.name).length ?? 0;
  const q = query.trim().toLowerCase();
  const shown = students?.filter((x) => !q || x.email.includes(q) || x.name?.toLowerCase().includes(q)) ?? [];
  const adderOpen = adderShown || students?.length === 0;

  return (
    <div className="students-box">
      <div className="students-head">
        <div className="students-stats">
          {students !== null && (
            <>
              <b>
                {students.length} student{students.length === 1 ? "" : "s"}
              </b>
              {students.length > 0 && (
                <>
                  <span className="stat-chip">
                    <Icon name="userPlus" /> {students.length - joined} added
                  </span>
                  <span className="stat-chip">
                    <Icon name="key" /> {joined} joined with code
                  </span>
                  {pending > 0 && <span className="stat-chip is-pending">{pending} not signed in yet</span>}
                </>
              )}
            </>
          )}
        </div>
        <div className="students-tools">
          {students?.length > 8 && (
            <label className="students-search">
              <Icon name="search" />
              <input placeholder="Find a student" value={query} onChange={(e) => setQuery(e.target.value)} />
            </label>
          )}
          {students?.length > 0 && (
            <button className="btn btn-ghost btn-sm" aria-expanded={adderOpen} onClick={() => setAdderShown(!adderShown)}>
              <Icon name="userPlus" /> Add by email
            </button>
          )}
        </div>
      </div>

      {adderOpen && (
        <form className="students-add" onSubmit={handleAdd}>
          <textarea
            className="input"
            rows={3}
            autoFocus={students?.length > 0}
            placeholder={"Paste student emails: one per line, comma-separated, or a CSV\ne.g. aarav.co23d1@scet.ac.in"}
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
          />
          <button className="btn" type="submit" disabled={adding || !pasted.trim()}>
            <Icon name="plus" /> {adding ? "Adding..." : "Add students"}
          </button>
        </form>
      )}
      {result && <div className="form-note">{result}</div>}
      {error && <div className="form-error">{error}</div>}
      {students === null && !error && <Loading label="Loading students" compact />}
      {students?.length === 0 && (
        <p className="form-note">No students yet. Share the join code, or paste their emails above.</p>
      )}
      {students?.length > 0 && shown.length === 0 && <p className="form-note">No one matches &ldquo;{query}&rdquo;.</p>}
      {shown.length > 0 && (
        <ul className="person-cards">
          {shown.map((x) => (
            <li key={x.email} className="person-card" style={{ "--c": toneColor(x.email) }}>
              <span className="person-avatar" aria-hidden="true">
                {(x.name ?? nameFromEmail(x.email))[0]?.toUpperCase()}
              </span>
              <span className="person-who">
                <b className={x.name ? undefined : "is-pending"}>{x.name ?? "Not signed in yet"}</b>
                <small title={x.email}>{x.email}</small>
              </span>
              <span
                className="person-how"
                title={x.added_by ? `Added by ${x.added_by}` : "Joined with the class code"}
                aria-label={x.added_by ? "Added by faculty" : "Joined with code"}
              >
                <Icon name={x.added_by ? "userPlus" : "key"} />
              </span>
              <button
                className="icon-btn person-remove"
                title="Remove from classroom"
                aria-label={`Remove ${x.email}`}
                onClick={() => handleRemove(x.email)}
              >
                <Icon name="x" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
