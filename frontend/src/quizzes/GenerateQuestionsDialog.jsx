import { useEffect, useState } from "react";
import { ApiError, generateQuestions, listNoteSources } from "../api/client";
import SourcePicker from "../library/SourcePicker";
import Icon from "../ui/Icons";
import { DIFFICULTY_LABEL, TYPE_LABEL, TYPES, toggled } from "./labels";

const MAX_SOURCES = 8;

/**
 * Has the model draft questions on a topic from chosen docs. They land in
 * the bank as drafts to review; ones too close to existing questions are
 * left out. `onGenerated({questions, duplicates})`.
 */
export default function GenerateQuestionsDialog({ token, workspaceId, subjects, defaultSubject, onClose, onGenerated }) {
  const [subject, setSubject] = useState(defaultSubject);
  const [topic, setTopic] = useState("");
  const [count, setCount] = useState(10);
  const [types, setTypes] = useState(["mcq", "short"]);
  const [difficulties, setDifficulties] = useState([1, 2, 3]);
  const [instructions, setInstructions] = useState("");
  const [docs, setDocs] = useState(null);
  const [picked, setPicked] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    listNoteSources(token, workspaceId)
      .then((rows) => !cancelled && setDocs(rows))
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

  const ready = subject.trim() && topic.trim() && picked.length && types.length && difficulties.length;

  async function submit(e) {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError("");
    try {
      onGenerated(
        await generateQuestions(token, workspaceId, {
          subject: subject.trim(),
          topic: topic.trim(),
          sourceDocIds: picked,
          count,
          types,
          difficulties,
          instructions: instructions.trim() || null,
        })
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't generate questions.");
      setBusy(false);
    }
  }

  return (
    <>
      <div className="scrim is-open" onClick={busy ? undefined : onClose} />
      <div className="modal modal-wide" role="dialog" aria-modal="true" aria-labelledby="gen-q-title">
        <div className="modal-head">
          <h2 id="gen-q-title">Generate questions</h2>
          <button className="icon-btn" aria-label="Close" disabled={busy} onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        <form className="modal-body" onSubmit={submit}>
          <div className="row">
            <div style={{ flex: 1 }}>
              <label className="field-label" htmlFor="gen-subject">
                Subject <span className="optional">quizzes are made per subject</span>
              </label>
              <input
                id="gen-subject"
                className="input"
                list="gen-subjects"
                placeholder="e.g. Compiler Design"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
              />
              <datalist id="gen-subjects">
                {subjects.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
            </div>
            <div style={{ flex: 2 }}>
              <label className="field-label" htmlFor="gen-topic">
                Topic
              </label>
              <input
                id="gen-topic"
                className="input"
                autoFocus
                placeholder="e.g. Lexical analysis"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
              />
            </div>
          </div>

          <div className="row q-kind">
            <div>
              <span className="field-label">Types</span>
              <div className="seg" role="group" aria-label="Types">
                {TYPES.map((t) => (
                  <button key={t} type="button" aria-pressed={types.includes(t)} disabled={busy} onClick={() => setTypes(toggled(types, t))}>
                    {TYPE_LABEL[t]}
                  </button>
                ))}
              </div>
            </div>
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
              <label className="field-label" htmlFor="gen-count">
                How many
              </label>
              <input
                id="gen-count"
                className="input q-count"
                type="number"
                min={1}
                max={15}
                value={count}
                onChange={(e) => setCount(Math.max(1, Math.min(15, Number(e.target.value) || 1)))}
              />
            </div>
          </div>

          <fieldset className="modal-group">
            <legend className="field-label">
              Write them from <span className="optional">up to {MAX_SOURCES} docs</span>
            </legend>
            <SourcePicker docs={docs} picked={picked} onChange={setPicked} max={MAX_SOURCES} disabled={busy} />
          </fieldset>

          <div>
            <label className="field-label" htmlFor="gen-instructions">
              Guidance <span className="optional">optional</span>
            </label>
            <textarea
              id="gen-instructions"
              className="input"
              rows={2}
              placeholder="e.g. Numerical problems where possible; second-year level"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
            />
          </div>

          {busy && (
            <p className="note-box">
              <b>Writing {count} questions...</b> This usually takes a minute or two. Keep this open.
            </p>
          )}
          {error && <p className="form-error">{error}</p>}
          <div className="modal-foot">
            <button className="btn" type="submit" disabled={!ready || busy}>
              {busy ? "Writing..." : "Generate"}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
