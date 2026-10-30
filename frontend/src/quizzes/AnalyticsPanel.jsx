import { useEffect, useState } from "react";
import { ApiError, getClassroomAnalytics } from "../api/client";
import Icon from "../ui/Icons";
import Loading from "../ui/Loading";

const pct = (x) => (x == null ? "–" : `${Math.round(x * 100)}%`);

// A student needs attention with a quiz average under half, or two or more missed.
const needsAttention = (s) => (s.average != null && s.average < 0.5) || s.missed >= 2;

/**
 * One classroom's results across its quizzes and assignments: headline
 * numbers, each assessment's turnout and average, how well each chapter
 * (source doc) is understood, the questions most got wrong, and every
 * student's record. Quizzes are marked in the app; assignments only count
 * as handed in or not.
 */
export default function AnalyticsPanel({ token, classrooms }) {
  const active = classrooms.filter((c) => !c.archived_at);
  const [classroomId, setClassroomId] = useState(active[0]?.id ?? "");
  const classroom = active.find((c) => c.id === classroomId) ?? active[0];
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [onlyFlagged, setOnlyFlagged] = useState(false);
  const currentId = classroom?.id;

  useEffect(() => {
    if (!currentId) return undefined;
    let cancelled = false;
    getClassroomAnalytics(token, currentId)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setError("");
      })
      .catch((err) => !cancelled && setError(err instanceof ApiError ? err.message : "Couldn't load the analytics."));
    return () => {
      cancelled = true;
    };
  }, [token, currentId]);

  if (!classroom) {
    return (
      <div className="table-wrap">
        <div className="empty-state is-compact">
          <h3>No classrooms yet</h3>
          <p>Analytics come from a classroom&apos;s quizzes and assignments. Create a classroom first.</p>
        </div>
      </div>
    );
  }

  const flagged = data ? data.student_rows.filter(needsAttention) : [];
  const studentRows = data ? (onlyFlagged ? flagged : data.student_rows) : [];

  return (
    <>
      <div className="lib-tools">
        <select
          className="input bank-subject"
          aria-label="Classroom"
          value={classroom.id}
          onChange={(e) => {
            setData(null);
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
      </div>
      {error && <p className="form-error lib-note">{error}</p>}
      {data === null && !error && <Loading label="Crunching the numbers" />}

      {data && data.assessments.length === 0 && (
        <div className="table-wrap">
          <div className="empty-state is-compact">
            <h3>Nothing to analyse yet</h3>
            <p>Give {classroom.name} a quiz or an assignment and its results show up here.</p>
          </div>
        </div>
      )}

      {data && data.assessments.length > 0 && (
        <div className="an">
          <div className="an-tiles">
            <Tile label="Quiz average" value={pct(data.average)} sub="across every quiz submitted" />
            <Tile label="Handed in" value={pct(data.completion)} sub="of everything assigned" />
            <Tile label="Students" value={data.students} sub={`${flagged.length} need attention`} />
            <Tile
              label="Given"
              value={data.quizzes + data.assignments}
              sub={`${data.quizzes} quiz${data.quizzes === 1 ? "" : "zes"}, ${data.assignments} assignment${data.assignments === 1 ? "" : "s"}`}
            />
          </div>

          <section className="panel an-card" aria-labelledby="an-assess">
            <h2 id="an-assess">Quizzes &amp; assignments</h2>
            <table className="an-table">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Handed in</th>
                  <th>Average</th>
                  <th>Late</th>
                </tr>
              </thead>
              <tbody>
                {data.assessments.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <span className="an-title">
                        <span className={`note-kind is-${a.kind === "quiz" ? "slides" : "notes"}`}>
                          <Icon name={a.kind === "quiz" ? "quiz" : "note"} />
                        </span>
                        <span>
                          {a.title}
                          <small className="note-sub">
                            {a.kind === "quiz" ? "Quiz" : "Assignment"}
                            {a.due_at ? `, due ${new Date(a.due_at).toLocaleDateString(undefined, { day: "numeric", month: "short" })}` : ", no due date"}
                          </small>
                        </span>
                      </span>
                    </td>
                    <td>
                      <Meter value={a.assigned ? a.submitted / a.assigned : 0} text={`${a.submitted}/${a.assigned}`} />
                    </td>
                    <td>
                      {a.average == null ? (
                        <span className="who">{a.kind === "quiz" ? "No submissions" : "Marked on paper"}</span>
                      ) : (
                        <Meter value={a.average} text={pct(a.average)} />
                      )}
                    </td>
                    <td className="who">{a.late || "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <div className="an-split">
            <section className="panel an-card" aria-labelledby="an-chapters">
              <h2 id="an-chapters">Chapters</h2>
              <p className="form-note">Share of quiz answers that were right, weakest first.</p>
              {data.chapters.length === 0 ? (
                <p className="desk-empty">No quiz answers yet.</p>
              ) : (
                <ul className="an-bars">
                  {data.chapters.map((c) => (
                    <li key={c.doc_id ?? "hand"}>
                      <span className="an-bar-label" title={c.title}>
                        {c.title}
                      </span>
                      <Meter value={c.accuracy} text={pct(c.accuracy)} tip={`${c.right} of ${c.answered} answers right`} />
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="panel an-card" aria-labelledby="an-hard">
              <h2 id="an-hard">Most missed questions</h2>
              <p className="form-note">Answered by at least two students.</p>
              {data.hardest.length === 0 ? (
                <p className="desk-empty">Not enough answers yet.</p>
              ) : (
                <ol className="an-hard">
                  {data.hardest.map((q, i) => (
                    <li key={q.question_id}>
                      <span className="an-hard-num">{i + 1}</span>
                      <span className="an-hard-text">
                        {q.prompt}
                        <small className="note-sub">{q.assessment}</small>
                      </span>
                      <span className="an-hard-score" title={`${q.right} of ${q.answered} answers right`}>
                        <b>{pct(q.accuracy)}</b>
                        <small>
                          {q.right}/{q.answered} right
                        </small>
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </div>

          <section className="panel an-card" aria-labelledby="an-students">
            <div className="an-card-head">
              <h2 id="an-students">Students</h2>
              <label className="an-filter">
                <input type="checkbox" checked={onlyFlagged} onChange={(e) => setOnlyFlagged(e.target.checked)} />
                Only those who need attention ({flagged.length})
              </label>
            </div>
            <table className="an-table">
              <thead>
                <tr>
                  <th>Student</th>
                  <th>Quiz average</th>
                  <th>Handed in</th>
                  <th>Missed</th>
                  <th>Late</th>
                </tr>
              </thead>
              <tbody>
                {studentRows.length === 0 && (
                  <tr className="empty-row">
                    <td colSpan={5}>{onlyFlagged ? "Everyone is on track." : "No students yet."}</td>
                  </tr>
                )}
                {studentRows.map((s) => (
                  <tr key={s.email}>
                    <td>
                      <b>{s.name ?? s.email.split("@")[0]}</b>
                      {needsAttention(s) && <span className="state warn an-flag">Needs attention</span>}
                      <small className="note-sub">{s.email}</small>
                    </td>
                    <td>{s.average == null ? <span className="who">–</span> : <Meter value={s.average} text={pct(s.average)} />}</td>
                    <td className="who">
                      {s.handed_in}/{s.quizzes + s.assignments}
                    </td>
                    <td className={s.missed ? "an-missed" : "who"}>{s.missed || "–"}</td>
                    <td className="who">{s.late || "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
      )}
    </>
  );
}

function Tile({ label, value, sub }) {
  return (
    <div className="an-tile">
      <span className="an-tile-label">{label}</span>
      <b>{value}</b>
      <small>{sub}</small>
    </div>
  );
}

/** A 0..1 value as a thin bar on a track, with its value in text beside it. */
function Meter({ value, text, tip }) {
  const width = Math.max(0, Math.min(1, value)) * 100;
  return (
    <span className="an-meter" title={tip ?? text}>
      <span className="an-track">
        <span className="an-fill" style={{ width: `${width}%` }} />
      </span>
      <span className="an-value">{text}</span>
    </span>
  );
}
