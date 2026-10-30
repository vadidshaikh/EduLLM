import { useEffect, useState } from "react";
import { ApiError, generateQuestions, listNoteSources } from "../api/client";
import SourcePicker from "../library/SourcePicker";
import Icon from "../ui/Icons";
import { DIFFICULTY_LABEL, WRITTEN, toggled } from "./labels";

const MAX_SOURCES = 8;
const MIN_COUNT = 10;
const MAX_COUNT = 50;

function clampCount(value) {
  return Math.max(MIN_COUNT, Math.min(MAX_COUNT, Math.round(Number(value)) || MIN_COUNT));
}

/**
 * Has the model draft questions from chosen docs of this workspace: multiple
 * choice (for quizzes) or written short and long answers (for assignments). It
 * labels each one's topic and picks its subject from the workspace's. They
 * land in the bank as drafts to review; ones too close to existing questions
 * are left out. `onGenerated({questions, duplicates})`.
 */
export default function GenerateQuestionsDialog({ token, workspaceId, onClose, onGenerated }) {
  const [written, setWritten] = useState(false); // false: multiple choice
  const [count, setCount] = useState(10);
  const [difficulties, setDifficulties] = useState([1, 2, 3]);
  const [instructions, setInstructions] = useState("");
  const [docs, setDocs] = useState(null);
  const [picked, setPicked] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
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

  const ready = picked.length && difficulties.length;

  async function submit(e) {
    e.preventDefault();
    if (!ready || busy) return;
    const howMany = clampCount(count);
    setCount(howMany);
    setBusy(true);
    setError("");
    try {
      onGenerated(
        await generateQuestions(token, workspaceId, {
          sourceDocIds: picked,
          count: howMany,
          types: written ? WRITTEN : ["mcq"],
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
          <div className="seg" role="group" aria-label="Question style">
            <button type="button" aria-pressed={!written} disabled={busy} onClick={() => setWritten(false)}>
              Multiple choice, for quizzes
            </button>
            <button type="button" aria-pressed={written} disabled={busy} onClick={() => setWritten(true)}>
              Written (short and long), for assignments
            </button>
          </div>

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
              <label className="field-label" htmlFor="gen-count">
                How many
              </label>
              <input
                id="gen-count"
                className="input q-count"
                type="number"
                min={MIN_COUNT}
                max={MAX_COUNT}
                value={count}
                onChange={(e) => setCount(e.target.value)}
                onBlur={() => setCount(clampCount(count))}
              />
            </div>
          </div>

          <fieldset className="modal-group">
            <legend className="field-label">
              Write them from <span className="optional">up to {MAX_SOURCES} docs</span>
            </legend>
            <SourcePicker
              docs={docs}
              picked={picked}
              onChange={setPicked}
              max={MAX_SOURCES}
              disabled={busy}
              empty="This workspace has no ready docs yet. Upload some in the Docs tab first."
            />
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
              <b>Writing {count} questions...</b>{" "}
              {count > 15 ? "They're written 15 at a time, so this can take several minutes." : "This usually takes a minute or two."}{" "}
              Keep this open.
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
