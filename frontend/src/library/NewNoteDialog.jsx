import { useEffect, useState } from "react";
import { ApiError, createNote, listNoteSources } from "../api/client";
import Icon from "../ui/Icons";

const MAX_SOURCES = 8;

/**
 * Starts notes or a slide deck: what it's about, which docs to write it
 * from (this workspace's and the institute library's), and optional
 * guidance. "Write draft" has the model write it first (up to a minute or
 * so); "Start blank" opens an empty one tied to the same sources.
 * `onCreated(note)` gets the saved note.
 */
export default function NewNoteDialog({ token, workspaceId, initialKind, onClose, onCreated }) {
  const [kind, setKind] = useState(initialKind);
  const [title, setTitle] = useState("");
  const [topic, setTopic] = useState("");
  const [subject, setSubject] = useState("");
  const [instructions, setInstructions] = useState("");
  const [docs, setDocs] = useState(null);
  const [picked, setPicked] = useState([]);
  const [busy, setBusy] = useState(null); // "draft" | "blank"
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    listNoteSources(token, workspaceId)
      .then((rows) => !cancelled && setDocs(rows))
      .catch(() => !cancelled && setDocs([]));
    return () => {
      cancelled = true;
    };
  }, [token, workspaceId]);

  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape" && !busy) onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  function toggle(id, checked) {
    setPicked((now) => (checked ? [...now, id] : now.filter((x) => x !== id)));
  }

  async function submit(generate) {
    if (!topic.trim() || !picked.length || busy) return;
    setBusy(generate ? "draft" : "blank");
    setError("");
    try {
      const note = await createNote(token, workspaceId, {
        kind,
        title: title.trim() || topic.trim().slice(0, 80),
        topic: topic.trim(),
        subject: subject.trim() || null,
        sourceDocIds: picked,
        instructions: instructions.trim() || null,
        generate,
      });
      onCreated(note);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't create it.");
      setBusy(null);
    }
  }

  const own = docs?.filter((d) => d.workspace_id) ?? [];
  const library = docs?.filter((d) => !d.workspace_id) ?? [];
  const ready = topic.trim() && picked.length > 0;

  return (
    <>
      <div className="scrim is-open" onClick={busy ? undefined : onClose} />
      <div className="modal modal-wide" role="dialog" aria-modal="true" aria-labelledby="new-note-title">
        <div className="modal-head">
          <h2 id="new-note-title">{kind === "slides" ? "New slide deck" : "New notes"}</h2>
          <button className="icon-btn" aria-label="Close" disabled={Boolean(busy)} onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        <form
          className="modal-body"
          onSubmit={(e) => {
            e.preventDefault();
            submit(true);
          }}
        >
          <div className="seg" role="group" aria-label="What to write">
            <button type="button" aria-pressed={kind === "notes"} disabled={Boolean(busy)} onClick={() => setKind("notes")}>
              Notes
            </button>
            <button type="button" aria-pressed={kind === "slides"} disabled={Boolean(busy)} onClick={() => setKind("slides")}>
              Slide deck
            </button>
          </div>

          <div>
            <label className="field-label" htmlFor="note-topic">
              Topic
            </label>
            <textarea
              id="note-topic"
              className="input"
              rows={2}
              autoFocus
              placeholder="e.g. Lexical analysis: tokens, regular expressions and finite automata"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
            />
          </div>

          <div className="row">
            <div style={{ flex: 2 }}>
              <label className="field-label" htmlFor="note-title">
                Title <span className="optional">defaults to the topic</span>
              </label>
              <input id="note-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div style={{ flex: 1 }}>
              <label className="field-label" htmlFor="note-subject">
                Subject <span className="optional">optional</span>
              </label>
              <input
                id="note-subject"
                className="input"
                placeholder="e.g. Compiler Design"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
              />
            </div>
          </div>

          <fieldset className="modal-group">
            <legend className="field-label">
              Write it from <span className="optional">up to {MAX_SOURCES} docs</span>
            </legend>
            {docs === null ? (
              <p className="form-note">Loading docs...</p>
            ) : docs.length === 0 ? (
              <p className="note-box">
                There are no ready docs here or in the institute library yet. Upload some in the Docs tab first.
              </p>
            ) : (
              <div className="source-pick">
                {[
                  ["This workspace", own],
                  ["Institute library", library],
                ].map(
                  ([heading, rows]) =>
                    rows.length > 0 && (
                      <div key={heading}>
                        <h4>{heading}</h4>
                        <div className="publish">
                          {rows.map((d) => {
                            const checked = picked.includes(d.id);
                            return (
                              <label key={d.id}>
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  disabled={Boolean(busy) || (!checked && picked.length >= MAX_SOURCES)}
                                  onChange={(e) => toggle(d.id, e.target.checked)}
                                />
                                <span>
                                  <b>{d.title}</b>
                                  {checked && <small>Cited as [{picked.indexOf(d.id) + 1}]</small>}
                                </span>
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    )
                )}
              </div>
            )}
          </fieldset>

          <div>
            <label className="field-label" htmlFor="note-instructions">
              Guidance for the draft <span className="optional">optional</span>
            </label>
            <textarea
              id="note-instructions"
              className="input"
              rows={2}
              placeholder={
                kind === "slides"
                  ? "e.g. For a 50-minute lecture, second-year students; include one worked example"
                  : "e.g. Keep it to two pages; add a worked example for each algorithm"
              }
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
            />
          </div>

          {busy === "draft" && (
            <p className="note-box">
              <b>Writing the draft from {picked.length} doc{picked.length === 1 ? "" : "s"}...</b> This usually takes
              under a minute{kind === "slides" ? " or two for a deck" : ""}. Keep this open.
            </p>
          )}
          {error && <p className="form-error">{error}</p>}
          <div className="modal-foot">
            <button type="button" className="btn btn-ghost" disabled={!ready || Boolean(busy)} onClick={() => submit(false)}>
              {busy === "blank" ? "Creating..." : "Start blank"}
            </button>
            <button className="btn" type="submit" disabled={!ready || Boolean(busy)}>
              {busy === "draft" ? "Writing..." : "Write draft"}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
