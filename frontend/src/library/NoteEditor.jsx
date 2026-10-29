import { useCallback, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ApiError, deleteNote, downloadNote, getNote, publishNote, redraftNote, updateNote } from "../api/client";
import { diffLines, slidesText, splitSections } from "../ui/diff";
import Icon from "../ui/Icons";
import { timeAgo } from "../ui/spines";
import { publishState } from "./noteState";

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
  if (note.kind === "notes" && draft.body_md !== note.body_md) changes.body_md = draft.body_md;
  if (note.kind === "slides" && JSON.stringify(draft.slides) !== JSON.stringify(note.slides)) changes.slides = draft.slides;
  return changes;
}

function draftFrom(note) {
  return { title: note.title, subject: note.subject ?? "", topic: note.topic, body_md: note.body_md, slides: note.slides };
}

/**
 * Editing one note or deck. Edits stay local until Save. If its sources
 * changed since it was written, a banner offers a redraft from their
 * current versions (the whole thing, or one section of notes), shown as a
 * diff to accept or discard, or "Mark up to date" once checked by hand.
 * Publish saves first, then makes it a workspace doc (faculty only, or
 * classrooms too).
 */
export default function NoteEditor({ token, noteId, workspace, classrooms, onBack, onPublished }) {
  const [note, setNote] = useState(null);
  const [draft, setDraft] = useState(null);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [redrafting, setRedrafting] = useState(null); // "all" | section index
  const [proposal, setProposal] = useState(null); // {label, before, after, apply(draft) -> draft | null}
  const [publishing, setPublishing] = useState(false);

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
        {error ? <p className="form-error">{error}</p> : <p className="desk-empty">Opening...</p>}
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

  function back() {
    if (dirty && !window.confirm("Leave without saving your changes?")) return;
    onBack();
  }

  function reload() {
    if (dirty && !window.confirm("Reloading discards your unsaved changes. Continue?")) return;
    load();
  }

  async function redraftAll() {
    setRedrafting("all");
    setError("");
    try {
      const result = await redraftNote(token, note.id);
      if (note.kind === "slides") {
        setProposal({
          label: "the whole deck",
          before: slidesText(draft.slides),
          after: slidesText(result.slides),
          apply: (now) => ({ ...now, slides: result.slides }),
        });
      } else {
        setProposal({
          label: "the whole note",
          before: draft.body_md,
          after: result.body_md,
          apply: (now) => ({ ...now, body_md: result.body_md }),
        });
      }
    } catch (err) {
      setError(errorText(err, "Couldn't redraft it."));
    } finally {
      setRedrafting(null);
    }
  }

  async function redraftSection(index) {
    const { sections } = splitSections(draft.body_md);
    const original = sections[index];
    setRedrafting(index);
    setError("");
    try {
      const result = await redraftNote(token, note.id, original);
      // Keep the blank lines that separated it from the next section.
      const trailing = /\s*$/.exec(original)[0];
      const replacement = result.body_md.trimEnd() + (trailing || "\n");
      setProposal({
        label: `“${headingOf(original)}”`,
        before: original.trimEnd(),
        after: result.body_md.trimEnd(),
        // null if the section was edited while the redraft was being written
        apply: (now) => {
          const current = splitSections(now.body_md);
          const at = current.sections.indexOf(original);
          if (at === -1) return null;
          current.sections[at] = replacement;
          return { ...now, body_md: current.intro + current.sections.join("") };
        },
      });
    } catch (err) {
      setError(errorText(err, "Couldn't redraft that section."));
    } finally {
      setRedrafting(null);
    }
  }

  async function remove() {
    const published = note.document_id ? " Its published doc stays in the library; remove it there if needed." : "";
    if (!window.confirm(`Delete "${note.title}"? This can't be undone.${published}`)) return;
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
    if (dirty && !window.confirm("The download is the last saved version. Download it anyway?")) return;
    try {
      await downloadNote(token, note.id);
    } catch (err) {
      setError(errorText(err, "Couldn't download it."));
    }
  }

  const state = publishState(note, classrooms);
  const changedSources = note.source_status.filter((s) => s.changed);
  const busy = saving || redrafting !== null;
  const empty = note.kind === "notes" ? !draft.body_md.trim() : draft.slides.length === 0;

  return (
    <div className="note-editor">
      <div className="note-bar">
        <BackButton onBack={back} />
        <span className={`state ${state.tone}`}>{state.text}</span>
        <span className="note-bar-meta">
          {dirty ? "Unsaved changes" : `Saved ${timeAgo(note.updated_at)} by ${note.updated_by_name}`}
        </span>
        <div className="note-bar-actions">
          <button className="btn btn-ghost" onClick={download} title={note.kind === "slides" ? "Download as PowerPoint" : "Download as Markdown"}>
            <Icon name="download" /> {note.kind === "slides" ? ".pptx" : ".md"}
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
              Nothing changes on its own. Redraft {note.kind === "notes" ? "a section or the whole note" : "the deck"} and
              compare, or mark it up to date once you&apos;ve checked it.
            </small>
          </div>
          <div className="stale-actions">
            <button className="btn btn-ghost" disabled={busy} onClick={redraftAll}>
              <Icon name="refresh" /> {redrafting === "all" ? "Redrafting..." : "Redraft all"}
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

      {note.kind === "notes" ? (
        <NotesBody draft={draft} setDraft={setDraft} busy={busy} redrafting={redrafting} onRedraftSection={redraftSection} onRedraftAll={redraftAll} />
      ) : (
        <SlidesBody slides={draft.slides} onChange={(slides) => setDraft({ ...draft, slides })} />
      )}

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
          <h2 id="note-danger-h">{note.kind === "slides" ? "This deck" : "This note"}</h2>
          <p className="form-note" style={{ marginTop: 0 }}>
            Created by {note.created_by_name}. Anyone in {workspace.kind === "personal" ? "your workspace" : workspace.name} can
            edit it; saves never overwrite someone else&apos;s newer changes.
          </p>
          <div className="danger-zone">
            <button className="btn btn-danger" onClick={remove}>
              Delete {note.kind === "slides" ? "deck" : "note"}
            </button>
          </div>
        </section>
      </div>

      {proposal && (
        <CompareDialog
          proposal={proposal}
          onClose={() => setProposal(null)}
          onAccept={() => {
            const next = proposal.apply(draft);
            if (next) setDraft(next);
            else setError("That section was edited while the redraft was being written; redraft it again.");
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

function headingOf(section) {
  return section.split("\n")[0].replace(/^##\s*/, "").trim() || "Untitled section";
}

function BackButton({ onBack }) {
  return (
    <button className="btn btn-ghost note-back" onClick={onBack}>
      <Icon name="arrowLeft" /> All notes
    </button>
  );
}

/**
 * Markdown on the left, the rendered page on the right; under them, each
 * "## " section with a button to redraft just that one.
 */
function NotesBody({ draft, setDraft, busy, redrafting, onRedraftSection, onRedraftAll }) {
  const { sections } = splitSections(draft.body_md);
  return (
    <>
      <div className="note-split">
        <textarea
          className="input note-md"
          aria-label="Notes (Markdown)"
          spellCheck
          placeholder={"## First section\n\nWrite in Markdown. Cite sources by number, e.g. [1]."}
          value={draft.body_md}
          onChange={(e) => setDraft({ ...draft, body_md: e.target.value })}
        />
        <div className="note-preview a-text" aria-label="Preview">
          {draft.body_md.trim() ? (
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{draft.body_md}</ReactMarkdown>
          ) : (
            <p className="form-note">The preview appears here.</p>
          )}
        </div>
      </div>
      <div className="note-sections">
        <span className="field-label">Redraft from the current sources:</span>
        {sections.map((section, i) => (
          <button key={i} className="chip" disabled={busy} onClick={() => onRedraftSection(i)}>
            <Icon name="refresh" /> {redrafting === i ? "Redrafting..." : headingOf(section)}
          </button>
        ))}
        <button className="chip" disabled={busy} onClick={onRedraftAll}>
          <Icon name="refresh" /> {redrafting === "all" ? "Redrafting..." : "Whole note"}
        </button>
      </div>
    </>
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
        <section className="slide-card" key={i} aria-label={`Slide ${i + 1}`}>
          <div className="slide-num">{i + 2}</div>
          <div className="slide-fields">
            <input
              className="input slide-title"
              aria-label="Slide title"
              placeholder="Slide title"
              value={s.title}
              onChange={(e) => update(i, { title: e.target.value })}
            />
            <textarea
              className="input"
              aria-label="Bullets, one per line"
              placeholder="One bullet per line"
              rows={Math.max(3, s.bullets.length + 1)}
              value={s.bullets.join("\n")}
              onChange={(e) => update(i, { bullets: e.target.value.split("\n") })}
            />
            <textarea
              className="input slide-notes"
              aria-label="Speaker notes"
              placeholder="Speaker notes"
              rows={2}
              value={s.notes}
              onChange={(e) => update(i, { notes: e.target.value })}
            />
          </div>
          <div className="slide-tools">
            <button className="icon-btn" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
              <Icon name="arrowUp" />
            </button>
            <button className="icon-btn" aria-label="Move down" disabled={i === slides.length - 1} onClick={() => move(i, 1)}>
              <Icon name="chev" />
            </button>
            <button className="icon-btn" aria-label="Remove slide" onClick={() => onChange(slides.filter((_, k) => k !== i))}>
              <Icon name="trash" />
            </button>
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
          <h2 id="compare-title">New draft of {proposal.label}</h2>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        <div className="modal-body">
          <p className="form-note" style={{ marginTop: 0 }}>
            <span className="diff-key is-del">Removed</span> <span className="diff-key is-add">Added</span> Written from
            the sources&apos; current versions. Using it replaces {proposal.label} in the editor; nothing is saved until you
            press Save.
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
              Use the new draft
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
            It becomes a doc in {personal ? "your workspace" : workspace.name}
            {note.kind === "slides" ? " (a .pptx)" : ""} that Ask can answer from.
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
