import { useCallback, useEffect, useState } from "react";
import {
  addWorkspaceMember,
  ApiError,
  deleteWorkspace,
  listWorkspaceMembers,
  removeWorkspaceMember,
  renameWorkspace,
} from "../api/client";
import { confirmDialog } from "../ui/confirm";
import Icon from "../ui/Icons";
import { nameFromEmail, toneColor } from "../ui/spines";
import Loading from "../ui/Loading";

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
    const ok = await confirmDialog(
      leaving
        ? {
            title: `Leave "${workspace.name}"?`,
            message: "You'll lose access to its documents and classrooms.",
            confirmLabel: "Leave",
            danger: true,
          }
        : {
            title: `Remove ${memberEmail}?`,
            message: `They lose access to "${workspace.name}" straight away.`,
            confirmLabel: "Remove",
            danger: true,
          }
    );
    if (!ok) return;
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
    const ok = await confirmDialog({
      title: `Delete "${workspace.name}"?`,
      message: "Its classrooms and faculty list go with it. This can't be undone.",
      confirmLabel: "Delete workspace",
      danger: true,
    });
    if (!ok) return;
    const done = await run(async () => {
      await deleteWorkspace(token, workspace.id);
      return true;
    }, "Couldn't delete the workspace.");
    if (done) onGone();
  }

  return (
    <div className="panel">
      <div className="panel-title-row">
        <div>
          <h2>Faculty</h2>
          <p className="panel-hint">
            Everyone here can read, upload, publish and delete this workspace&apos;s documents, and manage its
            classrooms. Every change is in the activity log.
          </p>
        </div>
        {members?.length > 0 && (
          <span className="stat-chip">
            <Icon name="people" /> {members.length} faculty
          </span>
        )}
      </div>
      {isOwner && (
        <form className="invite-form" onSubmit={handleAdd}>
          <label className="invite-input">
            <Icon name="userPlus" />
            <input
              type="email"
              placeholder="Invite faculty by email, e.g. firstname.lastname@scet.ac.in"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <button className="btn" type="submit" disabled={!email.trim()}>
            Invite
          </button>
        </form>
      )}
      {message && <div className="form-note">{message}</div>}
      {error && <div className="form-error">{error}</div>}
      {members === null && !error && <Loading label="Loading members" compact />}
      {members?.length > 0 && (
        <ul className="person-cards">
          {members.map((m) => (
            <li
              key={m.email}
              className="person-card"
              style={{ "--c": m.role === "owner" ? "var(--accent)" : toneColor(m.email) }}
            >
              <span className="person-avatar" aria-hidden="true">
                {(m.name ?? nameFromEmail(m.email))[0]?.toUpperCase()}
              </span>
              <span className="person-who">
                <b className={m.name ? undefined : "is-pending"}>
                  {m.name ?? "Not signed in yet"}
                  {m.email === me && <span className="you-tag">you</span>}
                </b>
                <small title={m.email}>{m.email}</small>
              </span>
              <span className={`role-badge${m.role === "owner" ? " is-owner" : ""}`}>
                {m.role === "owner" ? "Owner" : "Editor"}
              </span>
              {m.role !== "owner" && (isOwner || m.email === me) && (
                <button
                  className="icon-btn person-remove"
                  title={m.email === me ? "Leave this workspace" : "Remove from workspace"}
                  aria-label={m.email === me ? "Leave this workspace" : `Remove ${m.email}`}
                  onClick={() => handleRemove(m.email)}
                >
                  <Icon name={m.email === me ? "signout" : "x"} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {isOwner && (
        <div className="workspace-settings">
          <section className="settings-card">
            <h3>Workspace name</h3>
            <p className="panel-hint">Shown in everyone&apos;s switcher, and to students next to its classrooms.</p>
            <form className="inline-form" onSubmit={handleRename}>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
              <button className="btn btn-ghost" type="submit" disabled={!name.trim() || name.trim() === workspace.name}>
                <Icon name="pen" /> Rename
              </button>
            </form>
          </section>
          <section className="settings-card is-danger">
            <h3>Delete workspace</h3>
            <p className="panel-hint">
              Removes it with its classrooms and faculty list. Only possible once all its documents and notes are
              deleted.
            </p>
            <button className="btn btn-danger" onClick={handleDelete}>
              <Icon name="trash" /> Delete workspace
            </button>
          </section>
        </div>
      )}
    </div>
  );
}
