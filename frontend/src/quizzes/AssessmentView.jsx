import { useEffect, useState } from "react";
import { addQuizStudents, ApiError, deleteAssessment, getAssessment } from "../api/client";
import Icon from "../ui/Icons";
import ItemList from "./ItemList";

/**
 * One quiz or assignment with its answers: the class's set, or (quiz) each
 * student's own set. Students who joined after a quiz was made can be given
 * sets from here.
 */
export default function AssessmentView({ token, assessmentId, classroom, onBack }) {
  const [assessment, setAssessment] = useState(null);
  const [student, setStudent] = useState(null); // whose set is shown
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    getAssessment(token, assessmentId)
      .then((a) => !cancelled && setAssessment(a))
      .catch((err) => !cancelled && setError(err instanceof ApiError ? err.message : "Couldn't load it."));
    return () => {
      cancelled = true;
    };
  }, [token, assessmentId]);

  async function run(action, fallback) {
    setBusy(true);
    setError("");
    try {
      return await action();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : fallback);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    const what = assessment.kind === "quiz" ? "this quiz for every student" : "this assignment";
    if (!window.confirm(`Delete ${what}?`)) return;
    const deleted = await run(async () => {
      await deleteAssessment(token, assessmentId);
      return true;
    }, "Couldn't delete it.");
    if (deleted) onBack();
  }

  async function addMissing() {
    const updated = await run(() => addQuizStudents(token, assessmentId), "Couldn't give them sets.");
    if (updated) setAssessment(updated);
  }

  if (!assessment) {
    return (
      <div className="lib-tools">
        <button className="btn btn-ghost" onClick={onBack}>
          Back
        </button>
        {error ? <p className="form-error">{error}</p> : <p className="desk-empty">Loading...</p>}
      </div>
    );
  }

  const isQuiz = assessment.kind === "quiz";
  const shown = isQuiz ? (assessment.sets.find((s) => s.student_email === student) ?? assessment.sets[0]) : assessment.sets[0];
  const config = assessment.config;

  return (
    <>
      <div className="lib-tools">
        <button className="btn btn-ghost" onClick={onBack}>
          Back
        </button>
        <div className="as-title">
          <h2>{assessment.title}</h2>
          <small className="note-sub">
            {isQuiz ? "Quiz" : "Assignment"} for {classroom.name}, {assessment.subject}: {config.count} question
            {config.count === 1 ? "" : "s"}
            {isQuiz ? ` each, ${assessment.sets.length} students` : ""}
            {isQuiz && config.max_overlap != null ? `, at most ${config.max_overlap} shared between any two` : ""}
            {assessment.due_at ? `. Due ${new Date(assessment.due_at).toLocaleString()}` : ""}
          </small>
        </div>
        <div className="list-upload">
          <button className="btn btn-danger" disabled={busy} onClick={remove}>
            <Icon name="trash" /> Delete
          </button>
        </div>
      </div>
      {error && <p className="form-error lib-note">{error}</p>}
      {assessment.missing_students.length > 0 && (
        <p className="note-box lib-note">
          <b>
            {assessment.missing_students.length} student{assessment.missing_students.length === 1 ? "" : "s"} joined
            after this quiz was made
          </b>{" "}
          and {assessment.missing_students.length === 1 ? "has" : "have"} no set.{" "}
          <button className="link" disabled={busy} onClick={addMissing}>
            Give them sets
          </button>
        </p>
      )}

      <div className={isQuiz ? "as-layout" : undefined}>
        {isQuiz && (
          <ul className="as-students" aria-label="Students">
            {assessment.sets.map((s) => (
              <li key={s.student_email}>
                <button aria-current={s === shown ? "true" : undefined} onClick={() => setStudent(s.student_email)}>
                  <b>{s.student_name ?? s.student_email.split("@")[0]}</b>
                  <small>{s.student_email}</small>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="panel">
          {shown ? <ItemList items={shown.items} showMeta /> : <p className="desk-empty">No sets.</p>}
        </div>
      </div>
    </>
  );
}
