import { useEffect, useState } from "react";
import { addWorkspaceMember, ApiError, createClassroom, createWorkspace } from "../api/client";
import Icon from "../ui/Icons";

/**
 * Creates a shared workspace in one go. Only the name is required:
 * - other faculty are optional (a workspace can be just you);
 * - a first classroom is optional too, though it's the usual reason for a
 *   shared workspace: students join it to read the docs published to it.
 * If some faculty couldn't be added, the workspace still exists and the
 * dialog says who was skipped before moving on.
 * `onCreated(id)` runs once the user is done.
 */
export default function NewWorkspaceDialog({ token, onClose, onCreated }) {
  const [name, setName] = useState("");
  const [faculty, setFaculty] = useState("");
  const [classroom, setClassroom] = useState({ name: "", subject: "", term: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(null); // {id, skipped: [{email, reason}]}

  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape" && !busy) onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  async function submit(e) {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError("");
    let workspaceId;
    try {
      workspaceId = (await createWorkspace(token, name.trim())).id;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't create the workspace.");
      setBusy(false);
      return;
    }

    const skipped = [];
    const emails = [...new Set(faculty.split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean))];
    for (const email of emails) {
      try {
        await addWorkspaceMember(token, workspaceId, email);
      } catch (err) {
        skipped.push({ email, reason: err instanceof ApiError ? err.message : "couldn't be added" });
      }
    }
    if (classroom.name.trim()) {
      try {
        await createClassroom(token, workspaceId, classroom);
      } catch (err) {
        skipped.push({ email: `Classroom "${classroom.name.trim()}"`, reason: err instanceof ApiError ? err.message : "couldn't be created" });
      }
    }
    setBusy(false);

    if (skipped.length) setDone({ id: workspaceId, skipped });
    else onCreated(workspaceId);
  }

  return (
    <>
      <div className="scrim is-open" onClick={busy ? undefined : onClose} />
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="new-ws-title">
        <div className="modal-head">
          <h2 id="new-ws-title">New shared workspace</h2>
          <button className="icon-btn" aria-label="Close" disabled={busy} onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>

        {done ? (
          <div className="modal-body">
            <p className="note-box">
              <b>The workspace was created,</b> but some things were skipped:
            </p>
            <ul className="skipped">
              {done.skipped.map((s) => (
                <li key={s.email}>
                  <b>{s.email}</b>: {s.reason}
                </li>
              ))}
            </ul>
            <p className="form-note">You can fix these later from its Classrooms and Faculty tabs.</p>
            <div className="modal-foot">
              <button className="btn" onClick={() => onCreated(done.id)}>
                Open the workspace
              </button>
            </div>
          </div>
        ) : (
          <form className="modal-body" onSubmit={submit}>
            <div>
              <label className="field-label" htmlFor="ws-name">
                Name
              </label>
              <input
                id="ws-name"
                className="input"
                autoFocus
                placeholder="e.g. Computer Engg. department, or Compiler Design 2026"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>

            <div>
              <label className="field-label" htmlFor="ws-faculty">
                Other faculty <span className="optional">optional</span>
              </label>
              <textarea
                id="ws-faculty"
                className="input"
                rows={2}
                placeholder="firstname.lastname@scet.ac.in, one per line or comma-separated"
                value={faculty}
                onChange={(e) => setFaculty(e.target.value)}
              />
              <p className="form-note">
                They can upload, publish and manage classrooms here. Leave empty to keep it to yourself for now.
              </p>
            </div>

            <fieldset className="modal-group">
              <legend className="field-label">
                First classroom <span className="optional">optional, the usual setup</span>
              </legend>
              <input
                className="input"
                placeholder="Classroom name, e.g. CO Sem 5, Div A"
                value={classroom.name}
                onChange={(e) => setClassroom({ ...classroom, name: e.target.value })}
              />
              <div className="row">
                <input
                  className="input"
                  placeholder="Subject"
                  value={classroom.subject}
                  disabled={!classroom.name.trim()}
                  onChange={(e) => setClassroom({ ...classroom, subject: e.target.value })}
                />
                <input
                  className="input"
                  placeholder="Term, e.g. 2026-27 Odd"
                  value={classroom.term}
                  disabled={!classroom.name.trim()}
                  onChange={(e) => setClassroom({ ...classroom, term: e.target.value })}
                />
              </div>
              <p className="form-note">Students join it with a code, then ask about the docs you publish to it.</p>
            </fieldset>

            {error && <p className="form-error">{error}</p>}
            <div className="modal-foot">
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={onClose}>
                Cancel
              </button>
              <button className="btn" type="submit" disabled={busy || !name.trim()}>
                {busy ? "Creating..." : "Create workspace"}
              </button>
            </div>
          </form>
        )}
      </div>
    </>
  );
}
