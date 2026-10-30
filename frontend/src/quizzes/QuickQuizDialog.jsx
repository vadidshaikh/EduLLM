import { useEffect, useState } from "react";
import {
  ApiError,
  createAssessment,
  generateQuestions,
  listClassrooms,
  listNoteSources,
  setQuestionsStatus,
} from "../api/client";
import SourcePicker from "../library/SourcePicker";
import Icon from "../ui/Icons";
import { DIFFICULTY_LABEL, toggled } from "./labels";
import { DuePicker } from "./NewAssessmentDialog";

const MAX_SOURCES = 8;
// generateQuestions' limits (GenerateQuestionsRequest.count)
const MIN_POOL = 10;
const MAX_POOL = 50;

const STEP_TEXT = {
  writing: "Writing questions from your docs...",
  approving: "Adding them to the question bank...",
  building: "Making a set for each student...",
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Math.round(Number(value)) || min));
}

/** The subject most of the new questions were filed under. */
function mostCommonSubject(questions) {
  const counts = new Map();
  for (const q of questions) counts.set(q.subject, (counts.get(q.subject) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/**
 * Ask's /quiz: makes a classroom quiz in one go. The model writes multiple
 * choice questions from the picked docs (as GenerateQuestionsDialog does),
 * they're approved into the workspace's bank, and a quiz is made from the
 * approved questions of those docs, a random set per student (as
 * NewAssessmentDialog does). Only shared workspaces with a classroom can
 * hold quizzes. `onCreated({assessment, workspaceId, classroom})`.
 */
export default function QuickQuizDialog({ token, workspaces, workspaceId: initialWorkspaceId, onClose, onCreated }) {
  const [workspaceId, setWorkspaceId] = useState(initialWorkspaceId ?? workspaces[0]?.id ?? "");
  const [classrooms, setClassrooms] = useState(null);
  const [classroomId, setClassroomId] = useState("");
  const [docs, setDocs] = useState(null);
  const [picked, setPicked] = useState([]);
  const [title, setTitle] = useState("");
  const [count, setCount] = useState(10);
  const [pool, setPool] = useState(20);
  const [difficulties, setDifficulties] = useState([1, 2, 3]);
  const [instructions, setInstructions] = useState("");
  const [due, setDue] = useState("");
  const [step, setStep] = useState(null); // a STEP_TEXT key while working
  const [error, setError] = useState("");
  const busy = step !== null;

  useEffect(() => {
    if (!workspaceId) return undefined;
    let cancelled = false;
    listClassrooms(token, workspaceId)
      .then((rows) => {
        if (cancelled) return;
        const active = rows.filter((c) => !c.archived_at);
        setClassrooms(active);
        setClassroomId(active[0]?.id ?? "");
      })
      .catch(() => !cancelled && setClassrooms([]));
    listNoteSources(token, workspaceId)
      .then((rows) => !cancelled && setDocs(rows.filter((d) => d.workspace_id === workspaceId)))
      .catch(() => !cancelled && setDocs([]));
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

  function pickWorkspace(id) {
    setWorkspaceId(id);
    setClassrooms(null);
    setClassroomId("");
    setDocs(null);
    setPicked([]);
  }

  const classroom = classrooms?.find((c) => c.id === classroomId) ?? null;
  const ready = classroom && picked.length > 0 && difficulties.length > 0 && title.trim();

  async function submit(e) {
    e.preventDefault();
    if (!ready || busy) return;
    const perStudent = clamp(count, 1, 100);
    const howMany = clamp(pool, MIN_POOL, MAX_POOL);
    setCount(perStudent);
    setPool(howMany);
    setError("");
    let written = null;
    try {
      setStep("writing");
      written = await generateQuestions(token, workspaceId, {
        sourceDocIds: picked,
        count: howMany,
        types: ["mcq"],
        difficulties,
        instructions: instructions.trim() || null,
      });
      const ids = written.questions.map((q) => q.id);
      if (ids.length) {
        setStep("approving");
        await setQuestionsStatus(token, workspaceId, ids, "approved");
      }
      setStep("building");
      const assessment = await createAssessment(token, classroom.id, {
        kind: "quiz",
        title: title.trim(),
        subject: mostCommonSubject(written.questions) ?? classroom.subject ?? null,
        count: perStudent,
        source_doc_ids: picked,
        topics: [],
        difficulties,
        max_overlap: null,
        due_at: due ? new Date(due).toISOString() : null,
      });
      onCreated({ assessment, workspaceId, classroom, written: written.questions.length });
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Couldn't make the quiz.";
      setError(
        written?.questions.length
          ? `${message} The ${written.questions.length} new questions are approved in the Question bank, so you can make the quiz from the Library.`
          : message
      );
      setStep(null);
    }
  }

  return (
    <>
      <div className="scrim is-open" onClick={busy ? undefined : onClose} />
      <div className="modal modal-wide" role="dialog" aria-modal="true" aria-labelledby="quick-quiz-title">
        <div className="modal-head">
          <h2 id="quick-quiz-title">New quiz</h2>
          <button className="icon-btn" aria-label="Close" disabled={busy} onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        {workspaces.length === 0 ? (
          <div className="modal-body">
            <p className="note-box">
              <b>Quizzes are given to a classroom.</b> Create a shared workspace and a classroom in the Library first.
            </p>
          </div>
        ) : (
          <form className="modal-body" onSubmit={submit}>
            <div className="row">
              <div style={{ flex: 1 }}>
                <label className="field-label" htmlFor="qq-workspace">
                  Workspace
                </label>
                <select
                  id="qq-workspace"
                  className="input"
                  value={workspaceId}
                  disabled={busy}
                  onChange={(e) => pickWorkspace(e.target.value)}
                >
                  {workspaces.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </div>
              <div style={{ flex: 1 }}>
                <label className="field-label" htmlFor="qq-classroom">
                  Classroom
                </label>
                <select
                  id="qq-classroom"
                  className="input"
                  value={classroomId}
                  disabled={busy || !classrooms?.length}
                  onChange={(e) => setClassroomId(e.target.value)}
                >
                  {classrooms === null && <option value="">Loading...</option>}
                  {classrooms?.length === 0 && <option value="">No classrooms</option>}
                  {classrooms?.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                      {c.subject ? ` (${c.subject})` : ""}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {classrooms?.length === 0 && (
              <p className="form-note" style={{ margin: 0 }}>
                This workspace has no classrooms yet. Create one in its Classrooms tab first.
              </p>
            )}

            <div>
              <label className="field-label" htmlFor="qq-title">
                Title
              </label>
              <input
                id="qq-title"
                className="input"
                autoFocus
                placeholder="e.g. Quiz 2: Parsing"
                value={title}
                disabled={busy}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>

            <fieldset className="modal-group">
              <legend className="field-label">
                Write questions from <span className="optional">up to {MAX_SOURCES} docs</span>
              </legend>
              <SourcePicker
                docs={docs}
                picked={picked}
                onChange={setPicked}
                max={MAX_SOURCES}
                disabled={busy}
                empty="This workspace has no ready docs yet. Upload some in the Library first."
              />
            </fieldset>

            <div className="row q-kind">
              <div>
                <span className="field-label">Difficulty</span>
                <div className="seg" role="group" aria-label="Difficulty">
                  {[1, 2, 3].map((d) => (
                    <button
                      key={d}
                      type="button"
                      aria-pressed={difficulties.includes(d)}
                      disabled={busy}
                      onClick={() => setDifficulties(toggled(difficulties, d))}
                    >
                      {DIFFICULTY_LABEL[d]}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="field-label" htmlFor="qq-count">
                  Questions per student
                </label>
                <input
                  id="qq-count"
                  className="input q-count"
                  type="number"
                  min={1}
                  max={100}
                  value={count}
                  disabled={busy}
                  onChange={(e) => setCount(e.target.value)}
                  onBlur={() => setCount(clamp(count, 1, 100))}
                />
              </div>
              <div>
                <label className="field-label" htmlFor="qq-pool">
                  New questions to write
                </label>
                <input
                  id="qq-pool"
                  className="input q-count"
                  type="number"
                  min={MIN_POOL}
                  max={MAX_POOL}
                  value={pool}
                  disabled={busy}
                  onChange={(e) => setPool(e.target.value)}
                  onBlur={() => setPool(clamp(pool, MIN_POOL, MAX_POOL))}
                />
              </div>
            </div>
            <p className="form-note" style={{ margin: 0 }}>
              Each student gets a random set from the approved questions of these docs, including ones already in the
              bank. More questions than each student answers means more varied sets.
            </p>

            <div>
              <label className="field-label" htmlFor="qq-instructions">
                Guidance <span className="optional">optional</span>
              </label>
              <textarea
                id="qq-instructions"
                className="input"
                rows={2}
                placeholder="e.g. Numerical problems where possible; second-year level"
                value={instructions}
                disabled={busy}
                onChange={(e) => setInstructions(e.target.value)}
              />
            </div>

            <DuePicker value={due} onChange={setDue} />

            {busy && (
              <p className="note-box">
                <b>{STEP_TEXT[step]}</b> This usually takes a minute or two
                {pool > 15 ? " (questions are written 15 at a time, so a few more here)" : ""}. Keep this open.
              </p>
            )}
            {error && <p className="form-error">{error}</p>}
            <div className="modal-foot">
              <button className="btn" type="submit" disabled={!ready || busy}>
                {busy ? "Working..." : "Generate quiz"}
              </button>
            </div>
          </form>
        )}
      </div>
    </>
  );
}
