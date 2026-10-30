import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  getMyAssessment,
  getMyHandIn,
  handInAssignment,
  listMyAssessments,
  submitMyAssessment,
} from "../api/client";
import LibrarySide from "../library/LibrarySide";
import StudentDocs from "../library/StudentDocs";
import { timeAgo } from "../ui/spines";
import { smoothly } from "../ui/transition";
import ItemList from "./ItemList";
import { confirmDialog } from "../ui/confirm";
import Icon from "../ui/Icons";
import PdfViewer from "../ui/PdfViewer";
import Loading from "../ui/Loading";

const SECTION_TEXT = {
  books: ["Docs", "What your teachers published. Click a doc to open it: PDFs open here, other files download."],
  quizzes: ["Quizzes", "Multiple choice, your own set. Answer each one once; marks show right away."],
  assignments: ["Assignments", "Write the answers on paper and hand them in as a PDF. Late hand-ins are allowed."],
};

/**
 * Student: their Library, like faculty's, with the shelf switcher on the
 * left and three sections for whatever it has picked (all classrooms, the
 * institute docs, or one classroom): Docs, Quizzes and Assignments.
 * - Quiz (multiple choice, their own set): pick an option per question and
 *   submit once; marks show right away, the answers once the due date (if
 *   any) has passed.
 * - Assignment (written): the questions, answered on paper and handed in
 *   as a PDF (replaceable; late is allowed).
 */
export default function MyAssessmentsPage({ auth, shelves, switcher, active }) {
  const scope = shelves.option;
  // The institute docs have no quizzes or assignments.
  const sections = scope.kind === "library" ? ["books"] : ["books", "quizzes", "assignments"];
  const [chosen, setSection] = useState("books");
  const section = sections.includes(chosen) ? chosen : "books";
  const [items, setItems] = useState(null);
  const [error, setError] = useState("");
  const [open, setOpenNow] = useState(null);
  const setOpen = (a) => smoothly(() => setOpenNow(a));
  const [answers, setAnswers] = useState({}); // position -> option index, while answering
  const [submitting, setSubmitting] = useState(false);

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
      setAnswers({});
      setError("");
      setOpen(await getMyAssessment(auth.token, id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't open it.");
    }
  }

  function close() {
    setOpen(null);
    refresh();
  }

  const kind = section === "quizzes" ? "quiz" : "assignment";
  const shown = items?.filter((a) => a.kind === kind && (scope.kind !== "class" || a.classroom_id === scope.id));
  const [heading, blurb] = SECTION_TEXT[section];

  async function submit() {
    const blank = open.items.length - Object.keys(answers).length;
    const ok = await confirmDialog({
      title: blank ? `${blank} question${blank === 1 ? " is" : "s are"} unanswered` : "Submit your answers?",
      message: blank ? "Submit anyway? You can't change your answers after." : "You can't change them after.",
      confirmLabel: "Submit",
    });
    if (!ok) return;
    setSubmitting(true);
    setError("");
    try {
      const done = await submitMyAssessment(
        auth.token,
        open.id,
        Object.entries(answers).map(([position, choice]) => ({
          position: Number(position),
          choice,
        }))
      );
      setOpenNow(done);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't submit.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <LibrarySide
        switcher={switcher}
        sections={sections}
        section={open ? (open.kind === "quiz" ? "quizzes" : "assignments") : section}
        onSection={(id) =>
          smoothly(() => {
            setOpenNow(null);
            setSection(id);
          })
        }
      />
      <main className="main">
        <section className="library">
          <div className="lib-inner">
            {open ? (
              <>
                <div className="lib-tools">
                  <button className="btn btn-ghost" onClick={close}>
                    Back
                  </button>
                  <div className="as-title">
                    <h2>{open.title}</h2>
                    <small className="note-sub">
                      {open.kind === "quiz" ? "Quiz, your own set" : "Assignment"} for {open.classroom_name},{" "}
                      {open.subject}
                      {open.due_at ? `. Due ${new Date(open.due_at).toLocaleString()}` : ""}
                    </small>
                  </div>
                </div>
                {error && <p className="form-error lib-note">{error}</p>}
                {open.kind === "assignment" ? (
                  <HandIn token={auth.token} assessment={open} onUpdated={setOpenNow} onError={setError} />
                ) : (
                  <Status assessment={open} answered={Object.keys(answers).length} />
                )}
                <div className="panel">
                  {open.kind === "assignment" ? (
                    <ItemList items={open.items} />
                  ) : open.submitted_at ? (
                    <ItemList
                      items={open.items}
                      picks={Object.fromEntries(open.items.map((i) => [i.position, i.choice]))}
                      pickLabel="your answer"
                    />
                  ) : open.closed ? (
                    <ItemList items={open.items} />
                  ) : (
                    <ItemList
                      items={open.items}
                      picks={answers}
                      onPick={(position, i) => setAnswers({ ...answers, [position]: i })}
                    />
                  )}
                </div>
                {open.kind === "quiz" && !open.submitted_at && !open.closed && (
                  <div className="as-submit">
                    <span className="note-sub">
                      {Object.keys(answers).length} of {open.items.length} answered
                    </span>
                    <button className="btn" disabled={submitting} onClick={submit}>
                      {submitting ? "Submitting..." : "Submit answers"}
                    </button>
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="lib-head">
                  <div>
                    <h1>{heading}</h1>
                    <p>
                      {scope.kind === "class"
                        ? `${scope.name}. `
                        : scope.kind === "library"
                          ? "Institute-wide. "
                          : "All your classrooms. "}
                      {blurb}
                    </p>
                  </div>
                </div>
                {section === "books" ? (
                  <StudentDocs token={auth.token} shelves={shelves} active={active} />
                ) : (
                  <>
                    {error && <p className="form-error lib-note">{error}</p>}
                    {items === null && !error ? (
                      <Loading label="Loading" />
                    ) : shown?.length === 0 ? (
                      <div className="table-wrap lib-gap">
                        <div className="empty-state is-compact">
                          <h3>No {section} yet</h3>
                          <p>
                            When a teacher gives {scope.kind === "class" ? "this classroom" : "your classroom"}{" "}
                            {kind === "quiz" ? "a quiz" : "an assignment"}, it shows up here.
                          </p>
                        </div>
                      </div>
                    ) : (
                      shown && (
                        <div className="table-wrap lib-gap">
                          <table className="docs">
                            <thead>
                              <tr>
                                <th>Title</th>
                                <th>Classroom</th>
                                <th>Questions</th>
                                <th>Due</th>
                                <th>Status</th>
                              </tr>
                            </thead>
                            <tbody>
                              {shown.map((a) => (
                                <tr
                                  key={a.id}
                                  tabIndex={0}
                                  onClick={() => openOne(a.id)}
                                  onKeyDown={(e) => e.key === "Enter" && openOne(a.id)}
                                >
                                  <td>
                                    <span className="t-title">
                                      <span>
                                        {a.title}
                                        <small className="note-sub">
                                          {a.subject}, {timeAgo(a.created_at)}
                                        </small>
                                      </span>
                                    </span>
                                  </td>
                                  <td className="who">{a.classroom_name}</td>
                                  <td className="who">{a.question_count}</td>
                                  <td className="who">{a.due_at ? new Date(a.due_at).toLocaleString() : "–"}</td>
                                  <td>
                                    <Marks assessment={a} />
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )
                    )}
                  </>
                )}
              </>
            )}
          </div>
        </section>
      </main>
    </>
  );
}

/**
 * A score, or what's going on instead: still to do, or missed.
 */
function Marks({ assessment: a }) {
  if (a.score !== null && a.score !== undefined) {
    return (
      <b className="as-marks">
        {a.score}/{a.total}
      </b>
    );
  }
  if (a.submitted_at) return <span className="as-done">Handed in</span>;
  const overdue = a.due_at && new Date(a.due_at) <= new Date();
  if (!overdue) return <span className="who">To do</span>;
  // a quiz closes at the due date; an assignment can still be handed in late
  return <span className="as-missed">{a.kind === "quiz" ? "Missed" : "Overdue"}</span>;
}

/**
 * The line above the questions: marks once submitted (and whether the
 * answers are out yet), or that the due date passed.
 */
function Status({ assessment, answered }) {
  if (assessment.submitted_at) {
    return (
      <p className="note-box lib-note as-result">
        <span>
          <b>
            You scored {assessment.score}/{assessment.total}
          </b>{" "}
          <span className="note-sub">submitted {timeAgo(assessment.submitted_at)}</span>
        </span>
        <span className="note-sub">
          {assessment.results_visible
            ? "Correct answers are marked in green."
            : `Correct answers show after the due date${assessment.due_at ? `, ${new Date(assessment.due_at).toLocaleString()}` : ""}.`}
        </span>
      </p>
    );
  }
  if (assessment.closed) {
    return (
      <p className="note-box lib-note">
        <b>The due date has passed</b> and nothing was submitted, so this can&apos;t be answered any more.
      </p>
    );
  }
  return answered === 0 ? (
    <p className="note-sub lib-note">Pick one option per question, then submit at the bottom.</p>
  ) : null;
}

function fileSize(bytes) {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * An assignment's hand-in: drop or pick a PDF of the written answers;
 * once handed in, the file with View and Replace.
 */
function HandIn({ token, assessment: a, onUpdated, onError }) {
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [viewing, setViewing] = useState(false);
  const inputRef = useRef(null);
  const overdue = a.due_at && new Date(a.due_at) <= new Date();
  const late = a.submitted_at && a.due_at && new Date(a.submitted_at) > new Date(a.due_at);

  async function upload(file) {
    if (!file) return;
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      onError("Only a PDF can be handed in. Scan or export your answers to PDF.");
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      onError("That PDF is over 20 MB. Scan at a lower resolution.");
      return;
    }
    if (a.file_name) {
      const ok = await confirmDialog({
        title: "Replace your hand-in?",
        message: `"${a.file_name}" is replaced by "${file.name}"${overdue ? ", and it will show as late" : ""}.`,
        confirmLabel: "Replace",
      });
      if (!ok) return;
    }
    setBusy(true);
    onError("");
    try {
      onUpdated(await handInAssignment(token, a.id, file));
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Couldn't hand it in.");
    } finally {
      setBusy(false);
    }
  }

  const picker = (
    <input
      ref={inputRef}
      type="file"
      accept="application/pdf,.pdf"
      hidden
      onChange={(e) => {
        upload(e.target.files?.[0]);
        e.target.value = "";
      }}
    />
  );

  return (
    <div className="lib-note">
      {picker}
      {a.file_name ? (
        <div className="handin-file">
          <span className="handin-icon" aria-hidden="true">
            <Icon name="note" />
            <i>PDF</i>
          </span>
          <span className="handin-meta">
            <b>{a.file_name}</b>
            <small>
              {fileSize(a.file_size)} · handed in {timeAgo(a.submitted_at)}
              {late && <span className="as-late"> · late</span>}
            </small>
          </span>
          <button className="btn btn-sm" onClick={() => setViewing(true)}>
            View
          </button>
          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => inputRef.current?.click()}>
            <Icon name="upload" /> {busy ? "Uploading..." : "Replace"}
          </button>
        </div>
      ) : (
        <button
          type="button"
          className={`handin-drop${over ? " is-over" : ""}`}
          disabled={busy}
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            upload(e.dataTransfer.files?.[0]);
          }}
        >
          <span className="handin-drop-icon" aria-hidden="true">
            <Icon name="upload" />
          </span>
          <b>{busy ? "Uploading..." : "Hand in your answers"}</b>
          <span>Write them on paper, scan them into one PDF, and drop it here or click to choose. Up to 20 MB.</span>
          {a.submitted_at && <span className="as-done">Your teacher has ticked off a paper copy.</span>}
          {overdue && !a.submitted_at && (
            <span className="as-late">The due date has passed, so it will show as late.</span>
          )}
        </button>
      )}
      {viewing && (
        <PdfViewer
          title={a.file_name}
          subtitle={a.title}
          load={() => getMyHandIn(token, a.id)}
          onClose={() => setViewing(false)}
        />
      )}
    </div>
  );
}
