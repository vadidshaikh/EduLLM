import { useEffect, useMemo, useState } from "react";
import { ApiError, checkAssessment, createAssessment, listQuestions } from "../api/client";
import Icon from "../ui/Icons";
import { DIFFICULTY_LABEL, TYPE_LABEL, TYPES, toggled } from "./labels";

/**
 * Makes a quiz or assignment for a classroom from the approved questions.
 * While it's being set up, the server checks whether the bank has enough
 * questions for the rules (and how many would be); Create waits for that.
 */
export default function NewAssessmentDialog({ token, workspaceId, classroom, initialKind, onClose, onCreated }) {
  const [kind, setKind] = useState(initialKind);
  const [title, setTitle] = useState("");
  const [subject, setSubject] = useState(classroom.subject ?? "");
  const [count, setCount] = useState(10);
  const [topics, setTopics] = useState([]);
  const [types, setTypes] = useState([]);
  const [difficulties, setDifficulties] = useState([]);
  const [capOverlap, setCapOverlap] = useState(false);
  const [maxOverlap, setMaxOverlap] = useState(3);
  const [due, setDue] = useState("");
  const [bank, setBank] = useState([]);
  const [check, setCheck] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    listQuestions(token, workspaceId)
      .then((rows) => !cancelled && setBank(rows.filter((q) => q.status === "approved")))
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

  const subjectKey = subject.trim().toLowerCase();
  const subjects = useMemo(() => [...new Set(bank.map((q) => q.subject.trim()))].sort(), [bank]);
  const topicNames = useMemo(
    () =>
      [...new Set(bank.filter((q) => q.subject.trim().toLowerCase() === subjectKey).map((q) => q.topic.trim()))].sort(),
    [bank, subjectKey]
  );

  const config = useMemo(
    () => ({
      kind,
      subject: subject.trim() || null,
      count,
      topics,
      types,
      difficulties,
      max_overlap: kind === "quiz" && capOverlap ? maxOverlap : null,
    }),
    [kind, subject, count, topics, types, difficulties, capOverlap, maxOverlap]
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
          <div className="seg" role="group" aria-label="Kind">
            <button type="button" aria-pressed={kind === "quiz"} onClick={() => setKind("quiz")}>
              Quiz, a set per student
            </button>
            <button type="button" aria-pressed={kind === "assignment"} onClick={() => setKind("assignment")}>
              Assignment, one set for the class
            </button>
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
                onChange={(e) => {
                  setSubject(e.target.value);
                  setTopics([]);
                }}
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
                Questions {kind === "quiz" ? "per student" : ""}
              </label>
              <input
                id="as-count"
                className="input q-count"
                type="number"
                min={1}
                max={100}
                value={count}
                onChange={(e) => setCount(Math.max(1, Math.min(100, Number(e.target.value) || 1)))}
              />
            </div>
            <div>
              <span className="field-label">
                Types <span className="optional">none = any</span>
              </span>
              <div className="seg" role="group" aria-label="Types">
                {TYPES.map((t) => (
                  <button key={t} type="button" aria-pressed={types.includes(t)} onClick={() => setTypes(toggled(types, t))}>
                    {TYPE_LABEL[t]}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <span className="field-label">
                Difficulty <span className="optional">none = any</span>
              </span>
              <div className="seg" role="group" aria-label="Difficulty">
                {[1, 2, 3].map((d) => (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={difficulties.includes(d)}
                    onClick={() => setDifficulties(toggled(difficulties, d))}
                  >
                    {DIFFICULTY_LABEL[d]}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {topicNames.length > 0 && (
            <div>
              <span className="field-label">
                Topics <span className="optional">none = all of them</span>
              </span>
              <div className="topic-chips">
                {topicNames.map((t) => (
                  <button
                    key={t}
                    type="button"
                    className="topic-chip"
                    aria-pressed={topics.includes(t)}
                    onClick={() => setTopics(toggled(topics, t))}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="row q-kind">
            {kind === "quiz" && (
              <label className="overlap-cap">
                <input type="checkbox" checked={capOverlap} onChange={(e) => setCapOverlap(e.target.checked)} />
                <span>Any two students share at most</span>
                <input
                  className="input q-count"
                  type="number"
                  min={0}
                  max={Math.max(0, count - 1)}
                  disabled={!capOverlap}
                  value={maxOverlap}
                  onChange={(e) => setMaxOverlap(Math.max(0, Number(e.target.value) || 0))}
                />
                <span>questions</span>
              </label>
            )}
            <div>
              <label className="field-label" htmlFor="as-due">
                Due <span className="optional">optional</span>
              </label>
              <input id="as-due" className="input" type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
            </div>
          </div>

          {check && (
            <p className={`note-box check-box${check.ok ? " is-ok" : " is-bad"}`}>
              <b>{check.ok ? "Enough questions." : "Not enough questions."}</b> {check.message}
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
