import { useCallback, useEffect, useState } from "react";
import {
  addWorkspaceMember,
  ApiError,
  deleteWorkspace,
  listWorkspaceMembers,
  removeWorkspaceMember,
  renameWorkspace,
} from "../api/client";

/**
 * A shared workspace's faculty and settings. The owner can add faculty by
 * email, remove editors, rename the workspace and delete it once it's
 * empty; an editor can leave. `onChanged` reloads the workspace list;
 * `onGone` is called after the user deletes or leaves the workspace.
 */
export default function MembersPanel({ token, workspace, me, onChanged, onGone }) {
  const [members, setMembers] = useState(null);
  const [email, setEmail] = useState("");
  const [name, setName] = useState(workspace.name);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const isOwner = workspace.my_role === "owner";

  const load = useCallback(() => {
    listWorkspaceMembers(token, workspace.id)
      .then(setMembers)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Couldn't load members."));
  }, [token, workspace.id]);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * Runs one change, showing its error (if any) instead of throwing.
   */
  async function run(action, fallback) {
    setError("");
    setMessage("");
    try {
      return await action();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : fallback);
      return undefined;
    }
  }

  async function handleAdd(e) {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) return;
    const result = await run(() => addWorkspaceMember(token, workspace.id, trimmed), "Couldn't add them.");
    if (!result) return;
    setEmail("");
    if (!result.added) setMessage(`${trimmed} is already a member.`);
    else if (result.invited) setMessage(`Added ${trimmed}. They haven't signed in yet, so they were emailed an invite.`);
    else setMessage(`Added ${trimmed}.`);
    load();
    onChanged();
  }

  async function handleRemove(memberEmail) {
    const leaving = memberEmail === me;
    const prompt = leaving
      ? `Leave "${workspace.name}"? You'll lose access to its documents and classrooms.`
      : `Remove ${memberEmail} from "${workspace.name}"? They lose access straight away.`;
    if (!window.confirm(prompt)) return;
    const done = await run(async () => {
      await removeWorkspaceMember(token, workspace.id, memberEmail);
      return true;
    }, "Couldn't remove them.");
    if (!done) return;
    if (leaving) onGone();
    else {
      load();
      onChanged();
    }
  }

  async function handleRename(e) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || trimmed === workspace.name) return;
    if (await run(() => renameWorkspace(token, workspace.id, trimmed), "Couldn't rename the workspace.")) {
      onChanged();
    }
  }

  async function handleDelete() {
    if (!window.confirm(`Delete "${workspace.name}" and its classrooms? This can't be undone.`)) return;
    const done = await run(async () => {
      await deleteWorkspace(token, workspace.id);
      return true;
    }, "Couldn't delete the workspace.");
    if (done) onGone();
  }

  return (
    <div className="panel">
      <h2>Faculty</h2>
      <p className="panel-hint">
        Everyone here can read, upload, publish and delete this workspace&apos;s documents, and manage its
        classrooms. Every change is in the activity log.
      </p>
      {isOwner && (
        <form className="inline-form" onSubmit={handleAdd}>
          <input
            className="input"
            type="email"
            placeholder="Faculty email, e.g. firstname.lastname@scet.ac.in"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <button className="btn" type="submit" disabled={!email.trim()}>
            Add
          </button>
        </form>
      )}
      {message && <div className="form-note">{message}</div>}
      {error && <div className="form-error">{error}</div>}
      {members === null && !error && <p className="form-note">Loading members...</p>}
      {members?.length > 0 && (
        <ul className="people-list">
          {members.map((m) => (
            <li key={m.email}>
              <span>
                {m.name ?? <span className="who">Not signed in yet</span>} <span className="who">{m.email}</span>
              </span>
              <span className="tag-pill">{m.role}</span>
              {m.role !== "owner" && (isOwner || m.email === me) ? (
                <button className="link" onClick={() => handleRemove(m.email)}>
                  {m.email === me ? "Leave" : "Remove"}
                </button>
              ) : (
                <span />
              )}
            </li>
          ))}
        </ul>
      )}

      {isOwner && (
        <div className="workspace-settings">
          <h2>Workspace</h2>
          <form className="inline-form" onSubmit={handleRename}>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
            <button className="btn btn-ghost" type="submit" disabled={!name.trim() || name.trim() === workspace.name}>
              Rename
            </button>
          </form>
          <button className="btn btn-danger" onClick={handleDelete}>
            Delete workspace
          </button>
          <p className="panel-hint">A workspace can only be deleted once all its documents are deleted.</p>
        </div>
      )}
    </div>
  );
}
