import { useCallback, useEffect, useState } from "react";
import { ApiError, getMyAssessment, listMyAssessments } from "../api/client";
import { timeAgo } from "../ui/spines";
import { smoothly } from "../ui/transition";
import ItemList from "./ItemList";

/**
 * Student: the quizzes and assignments from their classrooms, and their
 * own questions for each (a quiz's set is theirs alone). Answering and
 * submitting happen outside the app for now.
 */
export default function MyAssessmentsPage({ auth, active }) {
  const [items, setItems] = useState(null);
  const [error, setError] = useState("");
  const [open, setOpenNow] = useState(null);
  const setOpen = (a) => smoothly(() => setOpenNow(a));

  const refresh = useCallback(async () => {
    try {
      setItems(await listMyAssessments(auth.token));
      setError("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load your work.");
    }
  }, [auth.token]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- refetch each time the page is shown
    if (active) refresh();
  }, [active, refresh]);

  async function openOne(id) {
    try {
      setOpen(await getMyAssessment(auth.token, id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't open it.");
    }
  }

  return (
    <main className="main">
      <section className="library">
        <div className="lib-inner">
          {open ? (
            <>
              <div className="lib-tools">
                <button className="btn btn-ghost" onClick={() => setOpen(null)}>
                  Back
                </button>
                <div className="as-title">
                  <h2>{open.title}</h2>
                  <small className="note-sub">
                    {open.kind === "quiz" ? "Quiz, your own set" : "Assignment"} for {open.classroom_name}, {open.subject}
                    {open.due_at ? `. Due ${new Date(open.due_at).toLocaleString()}` : ""}
                  </small>
                </div>
              </div>
              <div className="panel">
                <ItemList items={open.items} />
              </div>
            </>
          ) : (
            <>
              <div className="lib-head">
                <div>
                  <h1>Quizzes &amp; assignments</h1>
                  <p>From your classrooms. Your teacher tells you how to hand them in.</p>
                </div>
              </div>
              {error && <p className="form-error lib-note">{error}</p>}
              {items === null && !error ? (
                <p className="desk-empty">Loading...</p>
              ) : items?.length === 0 ? (
                <div className="table-wrap lib-gap">
                  <div className="empty-state is-compact">
                    <h3>Nothing yet</h3>
                    <p>When a teacher gives your classroom a quiz or assignment, it shows up here.</p>
                  </div>
                </div>
              ) : (
                items && (
                  <div className="table-wrap lib-gap">
                    <table className="docs">
                      <thead>
                        <tr>
                          <th>Title</th>
                          <th>Classroom</th>
                          <th>Questions</th>
                          <th>Due</th>
                        </tr>
                      </thead>
                      <tbody>
                        {items.map((a) => (
                          <tr key={a.id} tabIndex={0} onClick={() => openOne(a.id)} onKeyDown={(e) => e.key === "Enter" && openOne(a.id)}>
                            <td>
                              <span className="t-title">
                                <span>
                                  {a.title}
                                  <small className="note-sub">
                                    {a.kind === "quiz" ? "Quiz" : "Assignment"}, {a.subject}, {timeAgo(a.created_at)}
                                  </small>
                                </span>
                              </span>
                            </td>
                            <td className="who">{a.classroom_name}</td>
                            <td className="who">{a.question_count}</td>
                            <td className="who">{a.due_at ? new Date(a.due_at).toLocaleString() : "–"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )
              )}
            </>
          )}
        </div>
      </section>
    </main>
  );
}
