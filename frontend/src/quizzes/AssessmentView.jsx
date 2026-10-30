import { useEffect, useState } from "react";
import { addQuizStudents, ApiError, deleteAssessment, getAssessment, getHandIn, setHandedIn } from "../api/client";
import Icon from "../ui/Icons";
import PdfViewer from "../ui/PdfViewer";
import ItemList from "./ItemList";
import { confirmDialog } from "../ui/confirm";
import Loading from "../ui/Loading";

/**
 * One quiz or assignment with its answers and every student's progress.
 * Quiz: marks per student; pick one to see their set with what they
 * answered. Students who joined after it was made can be given sets here.
 * Assignment: who has handed in their PDF (opened here in a viewer) or a
 * paper copy (ticked off here), and undoing either.
 */
export default function AssessmentView({ token, assessmentId, classroom, onBack }) {
  const [assessment, setAssessment] = useState(null);
  const [student, setStudent] = useState(null); // whose set is shown
  const [busy, setBusy] = useState(false);
  const [viewing, setViewing] = useState(null); // the result whose PDF is open
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
    const quiz = assessment.kind === "quiz";
    const ok = await confirmDialog({
      title: `Delete "${assessment.title}"?`,
      message: quiz
        ? "Every student's set and their marks go with it."
        : "Its hand-ins go with it, and its questions become free for other assignments.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    const deleted = await run(async () => {
      await deleteAssessment(token, assessmentId);
      return true;
    }, "Couldn't delete it.");
    if (deleted) onBack();
  }

  async function toggleHandedIn(r) {
    if (r.file_name) {
      const ok = await confirmDialog({
        title: "Undo this hand-in?",
        message: `${r.student_name ?? r.student_email}'s PDF "${r.file_name}" is deleted, and they can hand in again.`,
        confirmLabel: "Undo hand-in",
        danger: true,
      });
      if (!ok) return;
    }
    const updated = await run(
      () => setHandedIn(token, assessmentId, r.student_email, !r.submitted_at),
      "Couldn't update it."
    );
    if (updated) setAssessment(updated);
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
        {error ? <p className="form-error">{error}</p> : <Loading label="Loading" />}
      </div>
    );
  }

  const isQuiz = assessment.kind === "quiz";
  const results = assessment.results;
  const result = results.find((r) => r.student_email === student) ?? (isQuiz ? results[0] : null);
  const shown = isQuiz
    ? (assessment.sets.find((s) => s.student_email === result?.student_email) ?? assessment.sets[0])
    : assessment.sets[0];
  const config = assessment.config;
  const handedIn = results.filter((r) => r.submitted_at);
  const marked = results.filter((r) => r.score !== null);
  const average = marked.length ? marked.reduce((sum, r) => sum + r.score / r.total, 0) / marked.length : null;

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

      <p className="note-sub lib-note">
        {handedIn.length} of {results.length} {isQuiz ? "submitted" : "handed in"}
        {isQuiz && average !== null && `, average ${Math.round(average * 100)}%`}
        {!isQuiz && ". Pick a student to open their PDF, or to tick off a paper copy."}
      </p>

      <div className={results.length ? "as-layout" : undefined}>
        {results.length > 0 && (
          <ul className="as-students" aria-label="Students">
            {results.map((r) => (
              <li key={r.student_email}>
                <button
                  aria-current={r === result ? "true" : undefined}
                  onClick={() => setStudent(!isQuiz && r === result ? null : r.student_email)}
                >
                  <span className="as-student-row">
                    <b>{r.student_name ?? r.student_email.split("@")[0]}</b>
                    <ResultTag result={r} />
                  </span>
                  <small>{r.student_email}</small>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="panel">
          {result && (
            <div className="as-panel-head">
              <p>
                <b>{result.student_name ?? result.student_email}</b>{" "}
                <span className="note-sub">{resultLine(result, isQuiz)}</span>
              </p>
              {!isQuiz && (
                <div className="as-panel-actions">
                  {result.file_name && (
                    <button className="btn btn-sm" onClick={() => setViewing(result)}>
                      <Icon name="note" /> View PDF
                    </button>
                  )}
                  <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => toggleHandedIn(result)}>
                    {result.submitted_at ? "Undo hand-in" : "Mark paper copy handed in"}
                  </button>
                </div>
              )}
            </div>
          )}
          {shown ? (
            <ItemList items={shown.items} showMeta picks={isQuiz && result?.score != null ? result.choices : undefined} />
          ) : (
            <p className="desk-empty">No sets.</p>
          )}
        </div>
      </div>
      {viewing && (
        <PdfViewer
          title={viewing.file_name}
          subtitle={`${viewing.student_name ?? viewing.student_email}, ${resultLine(viewing, false)}`}
          load={() => getHandIn(token, assessmentId, viewing.student_email)}
          onClose={() => setViewing(null)}
        />
      )}
    </>
  );
}

/** A student's status in the list: marks (quiz) or handed in (assignment). */
function ResultTag({ result }) {
  if (!result.submitted_at) return <span className="as-pending">Not submitted</span>;
  if (result.score !== null) {
    return (
      <span className="as-marks">
        {result.score}/{result.total}
      </span>
    );
  }
  const what = result.file_name ? "PDF" : "Paper";
  return <span className={result.late ? "as-late" : "as-done"}>{result.late ? `${what}, late` : what}</span>;
}

function resultLine(result, isQuiz) {
  if (!result.submitted_at) return isQuiz ? "hasn't submitted yet" : "hasn't handed it in yet";
  const when = new Date(result.submitted_at).toLocaleString();
  if (isQuiz) return `scored ${result.score}/${result.total}, submitted ${when}`;
  const late = result.late ? " (late)" : "";
  if (!result.file_name) return `paper copy ticked off by ${result.marked_by?.split("@")[0] ?? "faculty"}, ${when}${late}`;
  return `handed in a PDF ${when}${late}`;
}
