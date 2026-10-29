import { useCallback, useEffect, useState } from "react";
import { ApiError, listNotes } from "../api/client";
import Icon from "../ui/Icons";
import { timeAgo } from "../ui/spines";
import { smoothly } from "../ui/transition";
import NewNoteDialog from "./NewNoteDialog";
import NoteEditor from "./NoteEditor";
import { publishState } from "./noteState";

function isPublishing(note) {
  return note.document_id && ["queued", "processing"].includes(note.document_status);
}

/**
 * A workspace's notes and slide decks: the list, the "new" dialog, and the
 * editor for the one that's open. `onDocsChanged` refreshes the Docs tab
 * after a publish (a published note is a document there).
 */
export default function NotesPanel({ token, workspace, classrooms, onDocsChanged }) {
  const [notes, setNotes] = useState(null);
  const [error, setError] = useState("");
  const [openId, setOpenIdNow] = useState(null);
  const setOpenId = (id) => smoothly(() => setOpenIdNow(id)); // list <-> editor
  const [creating, setCreating] = useState(null); // "notes" | "slides"

  const refresh = useCallback(async () => {
    try {
      setNotes(await listNotes(token, workspace.id));
      setError("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load the notes.");
    }
  }, [token, workspace.id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- standard fetch-on-mount
    if (!openId) refresh();
  }, [refresh, openId]);

  // Published notes being indexed: poll so their status settles on its own.
  useEffect(() => {
    if (openId || !notes?.some(isPublishing)) return undefined;
    const id = setInterval(refresh, 2500);
    return () => clearInterval(id);
  }, [notes, openId, refresh]);

  if (openId) {
    return (
      <NoteEditor
        key={openId}
        token={token}
        noteId={openId}
        workspace={workspace}
        classrooms={classrooms}
        onBack={() => setOpenId(null)}
        onPublished={onDocsChanged}
      />
    );
  }

  return (
    <>
      <div className="lib-tools">
        <p className="panel-hint notes-hint">
          Write lecture notes or a slide deck from this workspace&apos;s docs and the institute library. The model drafts
          it with citations, you edit it, then publish it as a doc your classrooms can ask about.
        </p>
        <div className="list-upload">
          <button className="btn btn-ghost" onClick={() => setCreating("slides")}>
            <Icon name="slides" /> New slide deck
          </button>
          <button className="btn" onClick={() => setCreating("notes")}>
            <Icon name="note" /> New notes
          </button>
        </div>
      </div>
      {error && <p className="form-error lib-note">{error}</p>}

      {notes === null && !error ? (
        <p className="desk-empty">Loading notes...</p>
      ) : notes?.length === 0 ? (
        <div className="table-wrap">
          <div className="empty-state is-compact">
            <h3>No notes or decks yet</h3>
            <p>Pick a topic and the docs to write from; you&apos;ll get a draft to edit in about a minute.</p>
          </div>
        </div>
      ) : (
        notes && (
          <div className="table-wrap">
            <table className="docs">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Sources</th>
                  <th>Status</th>
                  <th>Edited</th>
                </tr>
              </thead>
              <tbody>
                {notes.map((n) => {
                  const state = publishState(n, classrooms);
                  const changed = n.source_status.filter((s) => s.changed).length;
                  return (
                    <tr key={n.id} tabIndex={0} onClick={() => setOpenId(n.id)} onKeyDown={(e) => e.key === "Enter" && setOpenId(n.id)}>
                      <td>
                        <span className="t-title">
                          <span className={`note-kind is-${n.kind}`} title={n.kind === "slides" ? "Slide deck" : "Notes"}>
                            <Icon name={n.kind === "slides" ? "slides" : "note"} />
                          </span>
                          <span>
                            {n.title}
                            <small className="note-sub">
                              {n.kind === "slides" ? `${n.slide_count} slides` : "Notes"}
                              {n.subject ? `, ${n.subject}` : ""}
                            </small>
                          </span>
                        </span>
                      </td>
                      <td>
                        {n.stale ? (
                          <span className="state warn" title="Re-uploaded or removed since this was written">
                            {changed} of {n.source_status.length} changed
                          </span>
                        ) : (
                          <span className="who">
                            {n.source_status.length} doc{n.source_status.length === 1 ? "" : "s"}, up to date
                          </span>
                        )}
                      </td>
                      <td>
                        <span className={`state ${state.tone}`}>{state.text}</span>
                      </td>
                      <td className="who" title={n.updated_by}>
                        {timeAgo(n.updated_at)} by {n.updated_by_name}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      )}

      {creating && (
        <NewNoteDialog
          token={token}
          workspaceId={workspace.id}
          initialKind={creating}
          onClose={() => setCreating(null)}
          onCreated={(note) => {
            setCreating(null);
            setOpenId(note.id);
          }}
        />
      )}
    </>
  );
}
