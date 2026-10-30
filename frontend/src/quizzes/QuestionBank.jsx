import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, listNoteSources, listQuestions, setQuestionsStatus } from "../api/client";
import Icon from "../ui/Icons";
import GenerateQuestionsDialog from "./GenerateQuestionsDialog";
import QuestionDialog from "./QuestionDialog";
import { DIFFICULTY_LABEL, TYPE_LABEL } from "./labels";
import Loading from "../ui/Loading";

/**
 * A workspace's question bank: drafts from the model (or written by hand)
 * that faculty review and approve. Only approved questions go into quizzes
 * and assignments.
 */
export default function QuestionBank({ token, workspace }) {
  const [questions, setQuestions] = useState(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [subject, setSubject] = useState(""); // "" = all
  const [show, setShow] = useState("all"); // all | draft | approved
  const [selected, setSelected] = useState([]);
  const [editing, setEditing] = useState(null); // a question, or {} for a new one
  const [generating, setGenerating] = useState(false);
  const [docTitles, setDocTitles] = useState({});

  const refresh = useCallback(async () => {
    try {
      setQuestions(await listQuestions(token, workspace.id));
      setError("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load the question bank.");
    }
  }, [token, workspace.id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- standard fetch-on-mount
    refresh();
  }, [refresh]);

  // Titles for the "Chapter" column (the doc each question was written from).
  useEffect(() => {
    let cancelled = false;
    listNoteSources(token, workspace.id)
      .then((rows) => !cancelled && setDocTitles(Object.fromEntries(rows.map((d) => [d.id, d.title]))))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [token, workspace.id]);

  const subjects = useMemo(() => {
    const byKey = new Map();
    for (const q of questions ?? []) {
      const key = q.subject.trim().toLowerCase();
      const entry = byKey.get(key) ?? { name: q.subject, approved: 0, draft: 0 };
      entry[q.status] += 1;
      byKey.set(key, entry);
    }
    return [...byKey.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [questions]);

  const shown = (questions ?? []).filter(
    (q) => (!subject || q.subject.trim().toLowerCase() === subject) && (show === "all" || q.status === show)
  );
  const drafts = shown.filter((q) => q.status === "draft");
  const picked = selected.filter((id) => shown.some((q) => q.id === id));

  async function approve(ids) {
    setError("");
    try {
      const { changed } = await setQuestionsStatus(token, workspace.id, ids, "approved");
      setNote(`Approved ${changed} question${changed === 1 ? "" : "s"}.`);
      setSelected([]);
      refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't approve them.");
    }
  }

  const subjectName = subjects.find(([key]) => key === subject)?.[1].name ?? "";

  return (
    <>
      <div className="lib-tools">
        <div className="seg" role="group" aria-label="Status">
          {[
            ["all", "All"],
            ["draft", "To review"],
            ["approved", "Approved"],
          ].map(([id, label]) => (
            <button key={id} aria-pressed={show === id} onClick={() => setShow(id)}>
              {label}
            </button>
          ))}
        </div>
        {subjects.length > 0 && (
          <select className="input bank-subject" aria-label="Subject" value={subject} onChange={(e) => setSubject(e.target.value)}>
            <option value="">All subjects</option>
            {subjects.map(([key, s]) => (
              <option key={key} value={key}>
                {s.name} ({s.approved} approved{s.draft ? `, ${s.draft} to review` : ""})
              </option>
            ))}
          </select>
        )}
        <div className="list-upload">
          {picked.length > 0 ? (
            <button className="btn" onClick={() => approve(picked)}>
              Approve {picked.length} selected
            </button>
          ) : (
            drafts.length > 0 && (
              <button className="btn btn-ghost" onClick={() => approve(drafts.map((q) => q.id))}>
                Approve all {drafts.length} shown
              </button>
            )
          )}
          <button className="btn btn-ghost" onClick={() => setEditing({})}>
            <Icon name="pen" /> Write a question
          </button>
          <button className="btn" onClick={() => setGenerating(true)}>
            <Icon name="plus" /> Generate questions
          </button>
        </div>
      </div>
      {note && <p className="form-note lib-note">{note}</p>}
      {error && <p className="form-error lib-note">{error}</p>}

      {questions === null && !error ? (
        <Loading label="Loading questions" />
      ) : questions?.length === 0 ? (
        <div className="table-wrap">
          <div className="empty-state is-compact">
            <h3>No questions yet</h3>
            <p>
              Generate questions from this workspace&apos;s docs, review them, and approve the good ones. Quizzes and
              assignments only use approved questions.
            </p>
          </div>
        </div>
      ) : (
        questions && (
          <div className="table-wrap">
            <table className="docs">
              <thead>
                <tr>
                  <th className="check-col">
                    <input
                      type="checkbox"
                      aria-label="Select all drafts shown"
                      checked={drafts.length > 0 && drafts.every((q) => picked.includes(q.id))}
                      disabled={!drafts.length}
                      onChange={(e) => setSelected(e.target.checked ? drafts.map((q) => q.id) : [])}
                    />
                  </th>
                  <th>Question</th>
                  <th>Chapter</th>
                  <th>Level</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {shown.length === 0 && (
                  <tr className="empty-row">
                    <td colSpan={5}>Nothing matches.</td>
                  </tr>
                )}
                {shown.map((q) => (
                  <tr key={q.id} tabIndex={0} onClick={() => setEditing(q)} onKeyDown={(e) => e.key === "Enter" && setEditing(q)}>
                    <td className="check-col" onClick={(e) => e.stopPropagation()}>
                      {q.status === "draft" && (
                        <input
                          type="checkbox"
                          aria-label="Select"
                          checked={picked.includes(q.id)}
                          onChange={(e) =>
                            setSelected((now) => (e.target.checked ? [...now, q.id] : now.filter((x) => x !== q.id)))
                          }
                        />
                      )}
                    </td>
                    <td>
                      <span className="q-prompt">{q.body.prompt}</span>
                      <small className="note-sub">
                        {TYPE_LABEL[q.type]}
                        {!subject && `, ${q.subject}`}
                      </small>
                    </td>
                    <td className="who q-chapter">
                      {q.source_doc_ids.length
                        ? q.source_doc_ids.map((id) => docTitles[id] ?? "A removed doc").join(", ")
                        : "Written by hand"}
                    </td>
                    <td className="who">{DIFFICULTY_LABEL[q.difficulty]}</td>
                    <td>
                      {q.status === "approved" ? (
                        <span className="state ok">
                          Approved{q.use_count ? `, in ${q.use_count} set${q.use_count === 1 ? "" : "s"}` : ""}
                        </span>
                      ) : (
                        <span className="state warn">To review</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      {editing && (
        <QuestionDialog
          token={token}
          workspaceId={workspace.id}
          question={editing.id ? editing : null}
          defaults={{ subject: subjectName || subjects[0]?.[1].name || "" }}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
        />
      )}
      {generating && (
        <GenerateQuestionsDialog
          token={token}
          workspaceId={workspace.id}
          onClose={() => setGenerating(false)}
          onGenerated={({ questions: added, duplicates }) => {
            setGenerating(false);
            setShow("draft");
            setSubject(added[0]?.subject.trim().toLowerCase() ?? subject);
            setNote(
              `Added ${added.length} draft${added.length === 1 ? "" : "s"} to review` +
                (duplicates ? `; ${duplicates} left out as too close to questions already in the bank.` : ".")
            );
            refresh();
          }}
        />
      )}
    </>
  );
}
