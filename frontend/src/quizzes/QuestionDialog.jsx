import { useEffect, useState } from "react";
import { ApiError, createQuestion, deleteQuestion, updateQuestion } from "../api/client";
import Icon from "../ui/Icons";
import { DIFFICULTY_LABEL, TYPE_LABEL, TYPES, letter } from "./labels";
import { confirmDialog } from "../ui/confirm";

function initialForm(question, defaults) {
  if (!question) {
    return {
      subject: defaults.subject,
      topic: "",
      type: "mcq",
      difficulty: 2,
      prompt: "",
      options: ["", "", "", ""],
      correct: 0,
      explanation: "",
    };
  }
  return {
    subject: question.subject,
    topic: question.topic,
    type: question.type,
    difficulty: question.difficulty,
    prompt: question.body.prompt,
    options: question.body.options ?? ["", "", "", ""],
    correct: question.answer.correct ?? 0,
    explanation: question.answer.explanation ?? "",
  };
}

/**
 * Writes a new question or reviews / edits one from the bank: its wording,
 * options and answer, and approving it. `question` is null for a new one.
 */
export default function QuestionDialog({ token, workspaceId, question, defaults, onClose, onSaved }) {
  const [form, setForm] = useState(() => initialForm(question, defaults));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (changes) => setForm((f) => ({ ...f, ...changes }));
  const inUse = Boolean(question?.use_count);

  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape" && !busy) onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  function content() {
    const mcq = form.type === "mcq";
    return {
      type: form.type,
      difficulty: form.difficulty,
      prompt: form.prompt.trim(),
      options: mcq ? form.options.map((o) => o.trim()) : [],
      correct: mcq ? form.correct : null,
      explanation: form.explanation.trim(),
    };
  }

  async function save(status) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (question) {
        await updateQuestion(token, question.id, { subject: form.subject, topic: form.topic, content: content(), status });
      } else {
        const created = await createQuestion(token, workspaceId, { subject: form.subject, topic: form.topic, ...content() });
        if (status === "approved") await updateQuestion(token, created.id, { status });
      }
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save the question.");
      setBusy(false);
    }
  }

  async function remove() {
    const ok = await confirmDialog({
      title: "Delete this question?",
      message: "It's removed from the bank.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await deleteQuestion(token, question.id);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't delete it.");
      setBusy(false);
    }
  }

  const ready = form.subject.trim() && form.topic.trim() && form.prompt.trim();
  const approved = question?.status === "approved";

  return (
    <>
      <div className="scrim is-open" onClick={busy ? undefined : onClose} />
      <div className="modal modal-wide" role="dialog" aria-modal="true" aria-labelledby="question-title">
        <div className="modal-head">
          <h2 id="question-title">{question ? (approved ? "Question" : "Review question") : "Write a question"}</h2>
          <button className="icon-btn" aria-label="Close" disabled={busy} onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        <form
          className="modal-body"
          onSubmit={(e) => {
            e.preventDefault();
            save("approved");
          }}
        >
          <div className="row">
            <div style={{ flex: 1 }}>
              <label className="field-label" htmlFor="q-subject">
                Subject
              </label>
              <input id="q-subject" className="input" value={form.subject} onChange={(e) => set({ subject: e.target.value })} />
            </div>
            <div style={{ flex: 1 }}>
              <label className="field-label" htmlFor="q-topic">
                Topic
              </label>
              <input id="q-topic" className="input" value={form.topic} onChange={(e) => set({ topic: e.target.value })} />
            </div>
          </div>

          <div className="row q-kind">
            <div className="seg" role="group" aria-label="Type">
              {TYPES.map((t) => (
                <button
                  key={t}
                  type="button"
                  aria-pressed={form.type === t}
                  disabled={inUse && t !== question.type}
                  onClick={() => set({ type: t })}
                >
                  {TYPE_LABEL[t]}
                </button>
              ))}
            </div>
            <div className="seg" role="group" aria-label="Difficulty">
              {[1, 2, 3].map((d) => (
                <button key={d} type="button" aria-pressed={form.difficulty === d} onClick={() => set({ difficulty: d })}>
                  {DIFFICULTY_LABEL[d]}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="field-label" htmlFor="q-prompt">
              Question
            </label>
            <textarea
              id="q-prompt"
              className="input"
              rows={3}
              autoFocus={!question}
              value={form.prompt}
              onChange={(e) => set({ prompt: e.target.value })}
            />
          </div>

          {form.type === "mcq" && (
            <fieldset className="modal-group">
              <legend className="field-label">
                Options <span className="optional">mark the correct one; students see them shuffled</span>
              </legend>
              {form.options.map((option, i) => (
                <div key={i} className="q-option-edit">
                  <input
                    type="radio"
                    name="q-correct"
                    aria-label={`Option ${letter(i)} is correct`}
                    checked={form.correct === i}
                    onChange={() => set({ correct: i })}
                  />
                  <span className="q-letter">{letter(i)}</span>
                  <input
                    className="input"
                    value={option}
                    onChange={(e) => set({ options: form.options.map((o, j) => (j === i ? e.target.value : o)) })}
                  />
                  {!inUse && form.options.length > 2 && (
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={`Remove option ${letter(i)}`}
                      onClick={() =>
                        set({
                          options: form.options.filter((_, j) => j !== i),
                          correct: form.correct === i ? 0 : form.correct > i ? form.correct - 1 : form.correct,
                        })
                      }
                    >
                      <Icon name="x" />
                    </button>
                  )}
                </div>
              ))}
              {!inUse && form.options.length < 6 && (
                <button type="button" className="link q-add-option" onClick={() => set({ options: [...form.options, ""] })}>
                  Add an option
                </button>
              )}
            </fieldset>
          )}

          <div>
            <label className="field-label" htmlFor="q-explanation">
              {form.type === "mcq" ? "Why it's right" : "Model answer / marking points"}{" "}
              <span className="optional">faculty only</span>
            </label>
            <textarea
              id="q-explanation"
              className="input"
              rows={form.type === "long" ? 5 : 3}
              value={form.explanation}
              onChange={(e) => set({ explanation: e.target.value })}
            />
          </div>

          {inUse && (
            <p className="note-box">
              In {question.use_count} quiz or assignment set{question.use_count === 1 ? "" : "s"}: edits show there too,
              but its type and number of options can&apos;t change.
            </p>
          )}
          {error && <p className="form-error">{error}</p>}
          <div className="modal-foot">
            {question && !inUse && (
              <button type="button" className="btn btn-danger q-delete" disabled={busy} onClick={remove}>
                <Icon name="trash" /> Delete
              </button>
            )}
            {approved ? (
              <>
                {!inUse && (
                  <button type="button" className="btn btn-ghost" disabled={!ready || busy} onClick={() => save("draft")}>
                    Back to review
                  </button>
                )}
                <button className="btn" type="submit" disabled={!ready || busy}>
                  {busy ? "Saving..." : "Save"}
                </button>
              </>
            ) : (
              <>
                <button type="button" className="btn btn-ghost" disabled={!ready || busy} onClick={() => save("draft")}>
                  Save as draft
                </button>
                <button className="btn" type="submit" disabled={!ready || busy}>
                  {busy ? "Saving..." : "Save and approve"}
                </button>
              </>
            )}
          </div>
        </form>
      </div>
    </>
  );
}
