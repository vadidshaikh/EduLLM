import { useCallback, useEffect, useState } from "react";
import { ApiError, deleteNote, downloadNote, getNote, publishNote, redraftNote, reviseNote, updateNote } from "../api/client";
import { diffLines, slidesText } from "../ui/diff";
import Icon from "../ui/Icons";
import { timeAgo } from "../ui/spines";
import { publishState } from "./noteState";
import { confirmDialog } from "../ui/confirm";
import Loading from "../ui/Loading";

function errorText(err, fallback) {
  return err instanceof ApiError ? err.message : fallback;
}

/**
 * The edits not saved yet, as the fields updateNote takes.
 */
function unsavedChanges(note, draft) {
  const changes = {};
  for (const field of ["title", "subject", "topic"]) {
    if ((draft[field] ?? "") !== (note[field] ?? "")) changes[field] = draft[field];
  }
  if (JSON.stringify(draft.slides) !== JSON.stringify(note.slides)) changes.slides = draft.slides;
  return changes;
}

function draftFrom(note) {
  return { title: note.title, subject: note.subject ?? "", topic: note.topic, slides: note.slides };
}

/**
 * Editing one slide deck. Edits stay local until Save. If its sources
 * changed since it was written, a banner offers a redraft of the deck from
 * their current versions, shown as a diff to accept or discard, or "Mark up to date" once checked by hand.
 * Publish saves first, then makes it a workspace doc (faculty only, or
 * classrooms too).
 */
export default function NoteEditor({ token, noteId, workspace, classrooms, onBack, onPublished }) {
  const [note, setNote] = useState(null);
  const [draft, setDraft] = useState(null);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [redrafting, setRedrafting] = useState(false);
  const [proposal, setProposal] = useState(null); // {label, before, after, apply(draft) -> draft | null}
  const [publishing, setPublishing] = useState(false);
  const [revising, setRevising] = useState(false); // the "Edit with AI" dialog is open

  const load = useCallback(async () => {
    try {
      const loaded = await getNote(token, noteId);
      setNote(loaded);
      setDraft(draftFrom(loaded));
      setConflict(false);
      setError("");
    } catch (err) {
      setError(errorText(err, "Couldn't open it."));
    }
  }, [token, noteId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- standard fetch-on-mount
    load();
  }, [load]);

  const changes = note && draft ? unsavedChanges(note, draft) : {};
  const dirty = Object.keys(changes).length > 0;

  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (e) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // While its published copy is indexing, refresh the status (not the draft).
  const indexing = note?.document_id && ["queued", "processing"].includes(note.document_status);
  useEffect(() => {
    if (!indexing) return undefined;
    const id = setInterval(async () => {
      try {
        const fresh = await getNote(token, noteId);
        setNote((now) => ({ ...now, ...pick(fresh, ["document_status", "document_progress"]) }));
      } catch {
        // try again next tick
      }
    }, 2500);
    return () => clearInterval(id);
  }, [indexing, token, noteId]);

  if (!note || !draft) {
    return (
      <div className="note-editor">
        <BackButton onBack={onBack} />
        {error ? <p className="form-error">{error}</p> : <Loading label="Opening" />}
      </div>
    );
  }

  /**
   * Saves local edits (and/or marks the sources checked). Returns the saved
   * note, or null if it failed.
   */
  async function save(extra = {}) {
    if (!dirty && !extra.mark_up_to_date) return note;
    setSaving(true);
    setError("");
    try {
      const saved = await updateNote(token, note.id, note.updated_at, { ...changes, ...extra });
      setNote(saved);
      setDraft((now) => ({ ...now, ...pick(draftFrom(saved), Object.keys(changes)) }));
      return saved;
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setConflict(true);
      setError(errorText(err, "Couldn't save."));
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function back() {
    const ok =
      !dirty ||
      (await confirmDialog({
        title: "Leave without saving?",
        message: "Your unsaved changes will be lost.",
        confirmLabel: "Leave",
        danger: true,
      }));
    if (ok) onBack();
  }

  async function reload() {
    const ok =
      !dirty ||
      (await confirmDialog({
        title: "Discard your changes?",
        message: "Reloading replaces them with the last saved version.",
        confirmLabel: "Reload",
        danger: true,
      }));
    if (ok) load();
  }

  async function redraftAll() {
    setRedrafting(true);
    setError("");
    try {
      const result = await redraftNote(token, note.id);
      setProposal({
        label: "the whole deck",
        before: slidesText(draft.slides),
        after: slidesText(result.slides),
        apply: (now) => ({ ...now, slides: result.slides }),
      });
    } catch (err) {
      setError(errorText(err, "Couldn't redraft it."));
    } finally {
      setRedrafting(false);
    }
  }

  /**
   * Asks the model to apply a change described in words to the deck as it
   * is in the editor, then shows it as a diff to accept or discard. Returns
   * an error message, or null when the diff is up.
   */
  async function revise(changeRequest) {
    const before = draft.slides;
    try {
      const result = await reviseNote(token, note.id, changeRequest, before);
      setProposal({
        heading: "Suggested edit",
        label: `“${changeRequest}”`,
        note: "Your change, applied to the deck as it is in the editor (unsaved edits included).",
        before: slidesText(before),
        after: slidesText(result.slides),
        // null if the deck was edited while the change was being written
        apply: (now) => (now.slides === before ? { ...now, slides: result.slides } : null),
      });
      return null;
    } catch (err) {
      return errorText(err, "Couldn't make that change.");
    }
  }

  async function remove() {
    const published = note.document_id ? " Its published doc stays in the library; remove it there if needed." : "";
    const ok = await confirmDialog({
      title: `Delete "${note.title}"?`,
      message: `This can't be undone.${published}`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteNote(token, note.id);
      onBack();
    } catch (err) {
      setError(errorText(err, "Couldn't delete it."));
    }
  }

  async function openPublish() {
    if (dirty && !(await save())) return;
    setPublishing(true);
  }

  async function download() {
    const ok =
      !dirty ||
      (await confirmDialog({
        title: "Download the saved version?",
        message: "Your unsaved changes aren't in the download.",
        confirmLabel: "Download",
      }));
    if (!ok) return;
    try {
      await downloadNote(token, note.id);
    } catch (err) {
      setError(errorText(err, "Couldn't download it."));
    }
  }

  const state = publishState(note, classrooms);
  const changedSources = note.source_status.filter((s) => s.changed);
  const busy = saving || redrafting;
  const empty = draft.slides.length === 0;

  return (
    <div className="note-editor">
      <div className="note-bar">
        <BackButton onBack={back} />
        <span className={`state ${state.tone}`}>{state.text}</span>
        <span className="note-bar-meta">
          {dirty ? "Unsaved changes" : `Saved ${timeAgo(note.updated_at)} by ${note.updated_by_name}`}
        </span>
        <div className="note-bar-actions">
          <button className="btn btn-ghost btn-ai" disabled={busy} onClick={() => setRevising(true)}>
            <Icon name="sparkle" /> Edit with AI
          </button>
          <button className="btn btn-ghost" onClick={download} title="Download as PowerPoint">
            <Icon name="download" /> .pptx
          </button>
          <button className="btn btn-ghost" disabled={busy || empty} onClick={openPublish}>
            {note.document_id ? "Republish" : "Publish"}
          </button>
          <button className="btn" disabled={!dirty || busy} onClick={() => save()}>
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>

      {error && (
        <p className="form-error lib-note">
          {error}{" "}
          {conflict && (
            <button className="link-btn" onClick={reload}>
              Reload
            </button>
          )}
        </p>
      )}

      {note.stale && (
        <div className="stale-banner" role="status">
          <div>
            <b>
              {changedSources.length === 1 ? "A source has" : `${changedSources.length} sources have`} changed since
              this was written.
            </b>
            <ul>
              {changedSources.map((s) => (
                <li key={s.doc_id}>
                  {s.title}:{" "}
                  {s.current_version === null ? "removed" : `version ${s.used_version} → ${s.current_version}`}
                </li>
              ))}
            </ul>
            <small>
              Nothing changes on its own. Redraft the deck and
              compare, or mark it up to date once you&apos;ve checked it.
            </small>
          </div>
          <div className="stale-actions">
            <button className="btn btn-ghost" disabled={busy} onClick={redraftAll}>
              <Icon name="refresh" /> {redrafting ? "Redrafting..." : "Redraft deck"}
            </button>
            <button className="btn btn-ghost" disabled={busy} onClick={() => save({ mark_up_to_date: true })}>
              Mark up to date
            </button>
          </div>
        </div>
      )}

      <input
        className="note-title-input"
        aria-label="Title"
        value={draft.title}
        onChange={(e) => setDraft({ ...draft, title: e.target.value })}
      />
      <div className="row note-meta-row">
        <label>
          <span className="field-label">Subject</span>
          <input className="input" value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} />
        </label>
        <label style={{ flex: 2 }}>
          <span className="field-label">Topic (what redrafts are about)</span>
          <input className="input" value={draft.topic} onChange={(e) => setDraft({ ...draft, topic: e.target.value })} />
        </label>
      </div>

      <SlidesBody slides={draft.slides} onChange={(slides) => setDraft({ ...draft, slides })} />

      <div className="lib-lower note-lower">
        <section className="panel" aria-labelledby="sources-h">
          <h2 id="sources-h">Sources</h2>
          <ol className="note-sources">
            {note.source_status.map((s) => (
              <li key={s.doc_id}>
                <b>{s.title}</b>{" "}
                <small className={s.changed ? "is-changed" : ""}>
                  {s.current_version === null
                    ? `removed (used version ${s.used_version})`
                    : s.changed
                      ? `version ${s.used_version} used, now ${s.current_version}`
                      : `version ${s.used_version}, current`}
                </small>
              </li>
            ))}
          </ol>
          <p className="form-note">Cited in the text by number, e.g. [1]. Published copies list them at the end.</p>
        </section>
        <section className="panel" aria-labelledby="note-danger-h">
          <h2 id="note-danger-h">This deck</h2>
          <p className="form-note" style={{ marginTop: 0 }}>
            Created by {note.created_by_name}. Anyone in {workspace.kind === "personal" ? "your workspace" : workspace.name} can
            edit it; saves never overwrite someone else&apos;s newer changes.
          </p>
          <div className="danger-zone">
            <button className="btn btn-danger" onClick={remove}>
              Delete deck
            </button>
          </div>
        </section>
      </div>

      {revising && (
        <ReviseDialog
          slideCount={draft.slides.length}
          onClose={() => setRevising(false)}
          onSubmit={async (text) => {
            const failed = await revise(text);
            if (!failed) setRevising(false);
            return failed;
          }}
        />
      )}
      {proposal && (
        <CompareDialog
          proposal={proposal}
          onClose={() => setProposal(null)}
          onAccept={() => {
            const next = proposal.apply(draft);
            if (next) setDraft(next);
            else setError("The deck was edited while that was being written; try it again.");
            setProposal(null);
          }}
        />
      )}
      {publishing && (
        <PublishDialog
          token={token}
          note={note}
          workspace={workspace}
          classrooms={classrooms}
          onClose={() => setPublishing(false)}
          onPublished={(saved) => {
            setNote((now) => ({ ...now, ...pick(saved, PUBLISH_FIELDS) }));
            setPublishing(false);
            onPublished?.();
          }}
        />
      )}
    </div>
  );
}

const PUBLISH_FIELDS = [
  "document_id",
  "document_status",
  "document_progress",
  "document_visibility",
  "document_classroom_ids",
  "published_at",
];

function pick(obj, keys) {
  return Object.fromEntries(keys.filter((k) => k in obj).map((k) => [k, obj[k]]));
}

function BackButton({ onBack }) {
  return (
    <button className="btn btn-ghost note-back" onClick={onBack}>
      <Icon name="arrowLeft" /> All decks
    </button>
  );
}

/**
 * One card per slide: title, bullets (one per line) and speaker notes, with
 * move up/down and remove. The title slide and a sources slide are added
 * when the deck is rendered.
 */
function SlidesBody({ slides, onChange }) {
  function update(i, patch) {
    onChange(slides.map((s, k) => (k === i ? { ...s, ...patch } : s)));
  }
  function move(i, by) {
    const next = [...slides];
    [next[i], next[i + by]] = [next[i + by], next[i]];
    onChange(next);
  }
  return (
    <div className="slide-list">
      <p className="form-note" style={{ marginTop: 0 }}>
        A title slide and a sources slide are added when the deck is downloaded or published.
      </p>
      {slides.map((s, i) => (
        <section className="slide-card" key={i} aria-label={`Slide ${i + 2}`}>
          <header className="slide-head">
            <span className="slide-num" title="Slide 1 is the title slide">{i + 2}</span>
            <input
              className="slide-title"
              aria-label="Slide title"
              placeholder="Slide title"
              value={s.title}
              onChange={(e) => update(i, { title: e.target.value })}
            />
            <div className="slide-tools">
              <button className="icon-btn" aria-label="Move up" title="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                <Icon name="arrowUp" />
              </button>
              <button
                className="icon-btn"
                aria-label="Move down"
                title="Move down"
                disabled={i === slides.length - 1}
                onClick={() => move(i, 1)}
              >
                <Icon name="arrowDown" />
              </button>
              <button className="icon-btn is-danger" aria-label="Remove slide" title="Remove slide" onClick={() => onChange(slides.filter((_, k) => k !== i))}>
                <Icon name="trash" />
              </button>
            </div>
          </header>
          <div className="slide-fields">
            <textarea
              className="input slide-bullets"
              aria-label="Bullets, one per line"
              placeholder="One bullet per line"
              rows={Math.max(3, s.bullets.length + 1)}
              value={s.bullets.join("\n")}
              onChange={(e) => update(i, { bullets: e.target.value.split("\n") })}
            />
            <label className="slide-notes-label">
              <span className="field-label">Speaker notes</span>
              <textarea
                className="input slide-notes"
                placeholder="Optional: what to say on this slide"
                rows={2}
                value={s.notes}
                onChange={(e) => update(i, { notes: e.target.value })}
              />
            </label>
          </div>
        </section>
      ))}
      <button className="btn btn-ghost" onClick={() => onChange([...slides, { title: "", bullets: [], notes: "" }])}>
        <Icon name="plus" /> Add slide
      </button>
    </div>
  );
}

/**
 * The redraft next to what's there now, as a line diff. Accepting puts it
 * in the editor (still unsaved); discarding leaves everything as it was.
 */
function CompareDialog({ proposal, onClose, onAccept }) {
  const lines = diffLines(proposal.before, proposal.after);
  const changed = lines.some((l) => l.type !== "same");

  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <div className="scrim is-open" onClick={onClose} />
      <div className="modal modal-xwide" role="dialog" aria-modal="true" aria-labelledby="compare-title">
        <div className="modal-head">
          <h2 id="compare-title">{proposal.heading ? `${proposal.heading}: ${proposal.label}` : `New draft of ${proposal.label}`}</h2>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        <div className="modal-body">
          <p className="form-note" style={{ marginTop: 0 }}>
            <span className="diff-key is-del">Removed</span> <span className="diff-key is-add">Added</span>{" "}
            {proposal.note ??
              `Written from the sources' current versions. Using it replaces ${proposal.label} in the editor.`}{" "}
            Nothing is saved until you press Save.
          </p>
          {changed ? (
            <pre className="diff">
              {lines.map((l, i) => (
                <div key={i} className={`diff-line is-${l.type}`}>
                  <span aria-hidden="true">{l.type === "add" ? "+" : l.type === "del" ? "−" : " "}</span>
                  {l.text || " "}
                </div>
              ))}
            </pre>
          ) : (
            <p className="note-box">The new draft is the same as what you have.</p>
          )}
          <div className="modal-foot">
            <button className="btn btn-ghost" onClick={onClose}>
              Keep mine
            </button>
            <button className="btn" disabled={!changed} onClick={onAccept}>
              {proposal.heading ? "Apply the change" : "Use the new draft"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * Who the published doc is for. Personal workspaces only have "just you";
 * shared ones can add classrooms, otherwise it's for their faculty only.
 */
function PublishDialog({ token, note, workspace, classrooms, onClose, onPublished }) {
  const options = classrooms.filter((c) => !c.archived_at);
  const [picked, setPicked] = useState(() =>
    (note.document_classroom_ids ?? []).filter((id) => options.some((c) => c.id === id))
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const personal = workspace.kind === "personal";

  async function submit() {
    setBusy(true);
    setError("");
    try {
      const saved = await publishNote(token, note.id, {
        visibility: picked.length ? "classrooms" : "workspace",
        classroomIds: picked,
      });
      onPublished(saved);
    } catch (err) {
      setError(errorText(err, "Couldn't publish it."));
      setBusy(false);
    }
  }

  return (
    <>
      <div className="scrim is-open" onClick={busy ? undefined : onClose} />
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="publish-title">
        <div className="modal-head">
          <h2 id="publish-title">{note.document_id ? "Republish" : "Publish"} “{note.title}”</h2>
          <button className="icon-btn" aria-label="Close" disabled={busy} onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        <div className="modal-body">
          <p className="form-note" style={{ marginTop: 0 }}>
            It becomes a doc in {personal ? "your workspace" : workspace.name} (a .pptx) that Ask can answer from.
            {note.document_id && " The published copy is replaced and its readers get an update notice."}
          </p>
          {personal ? (
            <p className="note-box">
              <b>Only you can read it.</b> Personal workspaces have no classrooms; write it in a shared workspace to publish
              to students.
            </p>
          ) : (
            <>
              <span className="field-label">Also publish to classrooms</span>
              {options.length ? (
                <div className="publish">
                  {options.map((c) => (
                    <label key={c.id}>
                      <input
                        type="checkbox"
                        checked={picked.includes(c.id)}
                        disabled={busy}
                        onChange={(e) =>
                          setPicked((now) => (e.target.checked ? [...now, c.id] : now.filter((x) => x !== c.id)))
                        }
                      />
                      <span>
                        <b>{c.name}</b>
                        <small>
                          {c.student_count} student{c.student_count === 1 ? "" : "s"}
                          {c.subject ? `, ${c.subject}` : ""}
                        </small>
                      </span>
                    </label>
                  ))}
                </div>
              ) : (
                <p className="note-box">No classrooms yet; create one in the Classrooms tab to publish to students.</p>
              )}
              <p className="note-box">
                All {workspace.member_count} faculty in {workspace.name} can always read it.
                {!picked.length && <b> Students won&apos;t see it.</b>}
              </p>
            </>
          )}
          {error && <p className="form-error">{error}</p>}
          <div className="modal-foot">
            <button className="btn btn-ghost" disabled={busy} onClick={onClose}>
              Cancel
            </button>
            <button className="btn" disabled={busy} onClick={submit}>
              {busy ? "Publishing..." : note.document_id ? "Republish" : "Publish"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// Quick starts; anything else, the faculty member types.
const SUGGESTIONS = [
  ["More detailed", "Make the deck more detailed: split slides that cover several ideas and add worked examples"],
  ["Shorter", "Make the deck shorter: merge related slides and keep only the key points"],
];

/**
 * "Edit with AI": the faculty member says what to change ("add a slide on
 * TLBs", "remove slide 4") and the model applies it to the deck from its
 * sources. `onSubmit(text)` resolves to an error message, or null once the
 * comparison is up.
 */
function ReviseDialog({ slideCount, onClose, onSubmit }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape" && !busy) onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  async function submit(e) {
    e?.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true);
    setError("");
    const failed = await onSubmit(text.trim());
    if (failed) {
      setError(failed);
      setBusy(false);
    }
  }

  return (
    <>
      <div className="scrim is-open" onClick={busy ? undefined : onClose} />
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="revise-title">
        <div className="modal-head">
          <h2 id="revise-title">Edit with AI</h2>
          <button className="icon-btn" aria-label="Close" disabled={busy} onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        <form className="modal-body" onSubmit={submit}>
          <p className="form-note" style={{ marginTop: 0 }}>
            Say what to change in this {slideCount}-slide deck. New content comes from its sources. You&apos;ll see the
            change before anything is replaced.
          </p>
          <textarea
            className="input revise-input"
            rows={3}
            autoFocus
            disabled={busy}
            aria-label="What to change"
            placeholder="e.g. Add a slide on the TLB after paging, remove slide 7, or split the segmentation slide in two"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
            }}
          />
          <div className="revise-chips" role="group" aria-label="Quick starts">
            {SUGGESTIONS.map(([label, request]) => (
              <button
                key={label}
                type="button"
                className="topic-chip"
                aria-pressed={text === request}
                disabled={busy}
                onClick={() => setText(request)}
              >
                {label}
              </button>
            ))}
            <span className="revise-or">or type your own change above</span>
          </div>
          {busy && <Loading label="Planning the change, then writing the slides. Big changes can take a minute or two" compact />}
          {error && <p className="form-error">{error}</p>}
          <div className="modal-foot">
            <span className="revise-hint">Ctrl + Enter to apply</span>
            <button className="btn" type="submit" disabled={busy || !text.trim()}>
              <Icon name="sparkle" /> {busy ? "Working..." : "Make the change"}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
