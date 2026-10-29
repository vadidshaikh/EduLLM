import { useEffect, useState } from "react";
import { ApiError, listAssessments } from "../api/client";
import Icon from "../ui/Icons";
import { timeAgo } from "../ui/spines";
import { smoothly } from "../ui/transition";
import AssessmentView from "./AssessmentView";
import NewAssessmentDialog from "./NewAssessmentDialog";

/**
 * One classroom's quizzes and assignments at a time: the list, the "new"
 * dialog, and the one that's open.
 */
export default function AssessmentsPanel({ token, workspace, classrooms }) {
  const active = classrooms.filter((c) => !c.archived_at);
  const [classroomId, setClassroomId] = useState(active[0]?.id ?? "");
  const classroom = active.find((c) => c.id === classroomId) ?? active[0];
  const [items, setItems] = useState(null);
  const [error, setError] = useState("");
  const [openId, setOpenIdNow] = useState(null);
  const setOpenId = (id) => smoothly(() => setOpenIdNow(id));
  const [creating, setCreating] = useState(null); // "quiz" | "assignment"

  const currentId = classroom?.id;

  // Refetched when the classroom changes and on coming back from one.
  useEffect(() => {
    if (!currentId || openId) return undefined;
    let cancelled = false;
    listAssessments(token, currentId)
      .then((rows) => {
        if (cancelled) return;
        setItems(rows);
        setError("");
      })
      .catch((err) => !cancelled && setError(err instanceof ApiError ? err.message : "Couldn't load them."));
    return () => {
      cancelled = true;
    };
  }, [token, currentId, openId]);

  if (!classroom) {
    return (
      <div className="table-wrap">
        <div className="empty-state is-compact">
          <h3>No classrooms yet</h3>
          <p>Quizzes and assignments are given to a classroom. Create one in the Classrooms tab first.</p>
        </div>
      </div>
    );
  }

  if (openId) {
    return <AssessmentView key={openId} token={token} assessmentId={openId} classroom={classroom} onBack={() => setOpenId(null)} />;
  }

  return (
    <>
      <div className="lib-tools">
        <select
          className="input bank-subject"
          aria-label="Classroom"
          value={classroom.id}
          onChange={(e) => {
            setItems(null);
            setClassroomId(e.target.value);
          }}
        >
          {active.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {c.subject ? ` (${c.subject}${c.term ? `, ${c.term}` : ""})` : ""}
            </option>
          ))}
        </select>
        <div className="list-upload">
          <button className="btn btn-ghost" onClick={() => setCreating("assignment")}>
            <Icon name="note" /> New assignment
          </button>
          <button className="btn" onClick={() => setCreating("quiz")}>
            <Icon name="plus" /> New quiz
          </button>
        </div>
      </div>
      <p className="panel-hint notes-hint">
        An assignment is one set for the class, with no question another classroom&apos;s assignment uses in the same
        subject and term. A quiz gives every student their own set with the same mix of topics and difficulty.
      </p>
      {error && <p className="form-error lib-note">{error}</p>}

      {items === null && !error ? (
        <p className="desk-empty">Loading...</p>
      ) : items?.length === 0 ? (
        <div className="table-wrap">
          <div className="empty-state is-compact">
            <h3>Nothing for {classroom.name} yet</h3>
            <p>Approve some questions in the bank, then make a quiz or assignment from them.</p>
          </div>
        </div>
      ) : (
        items && (
          <div className="table-wrap">
            <table className="docs">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Questions</th>
                  <th>Due</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {items.map((a) => (
                  <tr key={a.id} tabIndex={0} onClick={() => setOpenId(a.id)} onKeyDown={(e) => e.key === "Enter" && setOpenId(a.id)}>
                    <td>
                      <span className="t-title">
                        <span className={`note-kind is-${a.kind === "quiz" ? "slides" : "notes"}`}>
                          <Icon name={a.kind === "quiz" ? "plus" : "note"} />
                        </span>
                        <span>
                          {a.title}
                          <small className="note-sub">
                            {a.kind === "quiz" ? "Quiz" : "Assignment"}, {a.subject}
                          </small>
                        </span>
                      </span>
                    </td>
                    <td className="who">
                      {a.config.count}
                      {a.kind === "quiz" ? ` each, ${a.student_count} students` : ", whole class"}
                    </td>
                    <td className="who">{a.due_at ? new Date(a.due_at).toLocaleString() : "–"}</td>
                    <td className="who" title={a.created_by}>
                      {timeAgo(a.created_at)} by {a.created_by_name}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      {creating && (
        <NewAssessmentDialog
          token={token}
          workspaceId={workspace.id}
          classroom={classroom}
          initialKind={creating}
          onClose={() => setCreating(null)}
          onCreated={(a) => {
            setCreating(null);
            setOpenId(a.id);
          }}
        />
      )}
    </>
  );
}
