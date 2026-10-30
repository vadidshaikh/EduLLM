import { useCallback, useEffect, useState } from "react";
import { ApiError, listNotes } from "../api/client";
import Icon from "../ui/Icons";
import { timeAgo } from "../ui/spines";
import { smoothly } from "../ui/transition";
import NewNoteDialog from "./NewNoteDialog";
import NoteEditor from "./NoteEditor";
import { publishState } from "./noteState";
import Loading from "../ui/Loading";

function isPublishing(note) {
  return note.document_id && ["queued", "processing"].includes(note.document_status);
}

/**
 * A workspace's slide decks: the list, the "new" dialog, and the
 * editor for the one that's open. `onDocsChanged` refreshes the Docs tab
 * after a publish (a published deck is a document there). `focus` ({deck},
 * from a link) opens that deck.
 */
export default function NotesPanel({ token, workspace, classrooms, onDocsChanged, focus }) {
  const [notes, setNotes] = useState(null);
  const [error, setError] = useState("");
  const [openId, setOpenIdNow] = useState(null);
  const setOpenId = (id) => smoothly(() => setOpenIdNow(id)); // list <-> editor
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- opening what a link points at
    if (focus) setOpenIdNow(focus.deck);
  }, [focus]);

  const refresh = useCallback(async () => {
    try {
      setNotes(await listNotes(token, workspace.id));
      setError("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load the decks.");
    }
  }, [token, workspace.id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- standard fetch-on-mount
    if (!openId) refresh();
  }, [refresh, openId]);

  // Published decks being indexed: poll so their status settles on its own.
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
          Build a lecture slide deck from this workspace&apos;s docs and the institute library. The model drafts
          it with citations, you edit it, then publish it as a doc your classrooms can ask about.
        </p>
        <div className="list-upload">
          <button className="btn" onClick={() => setCreating(true)}>
            <Icon name="plus" /> New slide deck
          </button>
        </div>
      </div>
      {error && <p className="form-error lib-note">{error}</p>}

      {notes === null && !error ? (
        <Loading label="Loading decks" />
      ) : notes?.length === 0 ? (
        <div className="table-wrap">
          <div className="empty-state is-compact">
            <h3>No slide decks yet</h3>
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
                          <span className="note-kind is-slides" title="Slide deck">
                            <Icon name="slides" />
                          </span>
                          <span>
                            {n.title}
                            <small className="note-sub">
                              {n.slide_count} slide{n.slide_count === 1 ? "" : "s"}
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
          onClose={() => setCreating(false)}
          onCreated={(note) => {
            setCreating(false);
            setOpenId(note.id);
          }}
        />
      )}
    </>
  );
}
