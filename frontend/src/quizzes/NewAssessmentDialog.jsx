import { useEffect, useMemo, useState } from "react";
import { ApiError, checkAssessment, createAssessment, listNoteSources, listQuestions } from "../api/client";
import Icon from "../ui/Icons";
import { MAX_ASSIGNMENT_QUESTIONS } from "./labels";

/**
 * Makes a quiz (multiple choice, a different random set per student) or an
 * assignment (written, up to 25 questions, one set for the class) for a
 * classroom from the subject's approved questions. Pick the docs (chapters)
 * it covers to use only questions generated from them; none = every doc.
 * While it's being set up, the server checks whether the bank has enough
 * questions for the rules (and how many would be); Create waits for that.
 */
export default function NewAssessmentDialog({ token, workspaceId, classroom, initialKind, onClose, onCreated }) {
  const [kind, setKind] = useState(initialKind);
  const [title, setTitle] = useState("");
  const [subject, setSubject] = useState(classroom.subject ?? "");
  const [count, setCount] = useState(10);
  const [due, setDue] = useState("");
  const [bank, setBank] = useState([]);
  const [docTitles, setDocTitles] = useState({});
  const [docs, setDocs] = useState([]); // picked source doc ids
  const [check, setCheck] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    listQuestions(token, workspaceId)
      .then((rows) => !cancelled && setBank(rows.filter((q) => q.status === "approved")))
      .catch(() => {});
    listNoteSources(token, workspaceId)
      .then((rows) => !cancelled && setDocTitles(Object.fromEntries(rows.map((d) => [d.id, d.title]))))
      .catch(() => {});
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

  const maxCount = kind === "assignment" ? MAX_ASSIGNMENT_QUESTIONS : 100;
  const subjects = useMemo(() => [...new Set(bank.map((q) => q.subject.trim()))].sort(), [bank]);
  // The docs this kind's approved questions in the subject were written from,
  // each with how many there are (quiz: mcq, assignment: written).
  const subjectKey = subject.trim().toLowerCase();
  const chapters = useMemo(() => {
    const counts = new Map();
    for (const q of bank) {
      if (q.subject.trim().toLowerCase() !== subjectKey || (q.type === "mcq") !== (kind === "quiz")) continue;
      for (const id of q.source_doc_ids) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return [...counts]
      .map(([id, n]) => ({ id, n, title: docTitles[id] ?? "A removed doc" }))
      .sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
  }, [bank, subjectKey, kind, docTitles]);
  // Picks that no longer apply (other subject or kind) don't count.
  const pickedDocs = useMemo(() => docs.filter((id) => chapters.some((c) => c.id === id)), [docs, chapters]);
  const config = useMemo(
    () => ({
      kind,
      subject: subject.trim() || null,
      count: Math.min(count, maxCount),
      source_doc_ids: pickedDocs,
      // Every topic and difficulty, and no overlap cap: each student's set is random.
      topics: [],
      difficulties: [],
      max_overlap: null,
    }),
    [kind, subject, count, maxCount, pickedDocs]
  );

  // Ask the server, shortly after the last change.
  useEffect(() => {
    let cancelled = false;
    const id = setTimeout(() => {
      checkAssessment(token, classroom.id, config)
        .then((result) => !cancelled && setCheck(result))
        .catch((err) => !cancelled && setCheck({ ok: false, message: err instanceof ApiError ? err.message : "Couldn't check." }));
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [token, classroom.id, config]);

  async function submit(e) {
    e.preventDefault();
    if (busy || !check?.ok || !title.trim()) return;
    setBusy(true);
    setError("");
    try {
      onCreated(
        await createAssessment(token, classroom.id, {
          ...config,
          title: title.trim(),
          due_at: due ? new Date(due).toISOString() : null,
        })
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't create it.");
      setBusy(false);
    }
  }

  return (
    <>
      <div className="scrim is-open" onClick={busy ? undefined : onClose} />
      <div className="modal modal-wide" role="dialog" aria-modal="true" aria-labelledby="new-assessment-title">
        <div className="modal-head">
          <h2 id="new-assessment-title">
            New {kind} for {classroom.name}
          </h2>
          <button className="icon-btn" aria-label="Close" disabled={busy} onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        <form className="modal-body" onSubmit={submit}>
          <div className="kind-pick" role="radiogroup" aria-label="Kind">
            {KINDS.map(([id, icon, name, sub]) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={kind === id}
                className="kind-opt"
                onClick={() => setKind(id)}
              >
                <span className="kind-icon">
                  <Icon name={icon} />
                </span>
                <span>
                  <b>{name}</b>
                  <small>{sub}</small>
                </span>
              </button>
            ))}
          </div>

          <div className="row">
            <div style={{ flex: 2 }}>
              <label className="field-label" htmlFor="as-title">
                Title
              </label>
              <input
                id="as-title"
                className="input"
                autoFocus
                placeholder={kind === "quiz" ? "e.g. Quiz 2: Parsing" : "e.g. Assignment 1"}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>
            <div style={{ flex: 1 }}>
              <label className="field-label" htmlFor="as-subject">
                Subject
              </label>
              <input
                id="as-subject"
                className="input"
                list="as-subjects"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
              />
              <datalist id="as-subjects">
                {subjects.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
            </div>
          </div>

          <div className="row q-kind">
            <div>
              <label className="field-label" htmlFor="as-count">
                Questions {kind === "quiz" ? "per student" : <span className="optional">up to {MAX_ASSIGNMENT_QUESTIONS}</span>}
              </label>
              <input
                id="as-count"
                className="input q-count"
                type="number"
                min={1}
                max={maxCount}
                value={Math.min(count, maxCount)}
                onChange={(e) => setCount(Math.max(1, Math.min(maxCount, Number(e.target.value) || 1)))}
              />
            </div>
          </div>

          <fieldset className="modal-group chapters">
            <legend className="field-label">
              Chapters <span className="optional">{pickedDocs.length ? `${pickedDocs.length} picked` : "none picked = all docs"}</span>
            </legend>
            {chapters.length === 0 ? (
              <p className="form-note" style={{ margin: 0 }}>
                No approved {kind === "quiz" ? "multiple-choice" : "written"} questions for{" "}
                {subject.trim() || "this subject"} yet. Generate some from your docs in the Question bank.
              </p>
            ) : (
              <div className="chapter-list">
                {chapters.map((c) => (
                  <label key={c.id} className="chapter">
                    <input
                      type="checkbox"
                      checked={pickedDocs.includes(c.id)}
                      onChange={() => setDocs(pickedDocs.includes(c.id) ? pickedDocs.filter((d) => d !== c.id) : [...pickedDocs, c.id])}
                    />
                    <span className="chapter-title">{c.title}</span>
                    <small>
                      {c.n} question{c.n === 1 ? "" : "s"}
                    </small>
                  </label>
                ))}
              </div>
            )}
          </fieldset>

          <DuePicker value={due} onChange={setDue} />

          {check && (
            <p className={`note-box check-box${check.ok ? " is-ok" : " is-bad"}`}>
              <b>{check.ok ? "Enough questions." : "Not enough questions."}</b>{" "}
              {/[.!?]$/.test(check.message.trim()) ? check.message : `${check.message.trim()}.`}
              {!check.ok && check.needed ? ` About ${check.needed} matching approved questions would be enough.` : ""}
              {kind === "assignment" && check.sharing?.length > 1 && (
                <small>
                  Same subject and term:{" "}
                  {check.sharing.map((c) => `${c.name}${c.has_assignment ? " (has an assignment)" : ""}`).join(", ")}
                </small>
              )}
            </p>
          )}
          {error && <p className="form-error">{error}</p>}
          <div className="modal-foot">
            <button className="btn" type="submit" disabled={busy || !check?.ok || !title.trim()}>
              {busy ? "Creating..." : kind === "quiz" ? `Create ${check?.students ?? ""} sets` : "Create assignment"}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}

const KINDS = [
  ["quiz", "quiz", "Quiz", "Multiple choice, a random set per student"],
  ["assignment", "note", "Assignment", "Written answers, one set for the class"],
];

const PRESETS = [
  ["none", "No due date"],
  ["1", "Tomorrow"],
  ["3", "In 3 days"],
  ["7", "In a week"],
  ["pick", "Pick a date"],
];

/** "YYYY-MM-DDTHH:mm" in local time, as datetime-local values are. */
function localValue(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function daysFromNow(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(23, 59, 0, 0);
  return localValue(d);
}

/**
 * The due date: quick choices (end of day tomorrow, in 3 days, in a week),
 * or a date and time of your own, with the result spelled out.
 * `value` is "" (none) or a local "YYYY-MM-DDTHH:mm".
 */
export function DuePicker({ value, onChange }) {
  const [mode, setMode] = useState(value ? "pick" : "none");
  const [date, time] = value ? value.split("T") : ["", "23:59"];
  const when = value ? new Date(value) : null;
  const past = when && when <= new Date();

  function choose(next) {
    setMode(next);
    if (next === "none") onChange("");
    else if (next === "pick") onChange(value || daysFromNow(1));
    else onChange(daysFromNow(Number(next)));
  }

  return (
    <div className="due">
      <span className="field-label">Due</span>
      <div className="due-chips" role="group" aria-label="Due">
        {PRESETS.map(([id, label]) => (
          <button key={id} type="button" className="topic-chip" aria-pressed={mode === id} onClick={() => choose(id)}>
            {id === "pick" && <Icon name="pen" />}
            {label}
          </button>
        ))}
      </div>
      {mode === "pick" && (
        <div className="due-fields">
          <input
            className="input"
            type="date"
            aria-label="Due date"
            min={localValue(new Date()).slice(0, 10)}
            value={date}
            onChange={(e) => e.target.value && onChange(`${e.target.value}T${time || "23:59"}`)}
          />
          <input
            className="input"
            type="time"
            aria-label="Due time"
            value={time}
            onChange={(e) => e.target.value && onChange(`${date}T${e.target.value}`)}
          />
        </div>
      )}
      <p className={`due-summary${past ? " is-past" : ""}`}>
        {when
          ? `${past ? "That's in the past: " : "Due "}${when.toLocaleString(undefined, {
              weekday: "short",
              day: "numeric",
              month: "short",
              hour: "numeric",
              minute: "2-digit",
            })}. Quizzes close then; assignments can still be handed in late.`
          : "No deadline. Students can do it any time."}
      </p>
    </div>
  );
}
