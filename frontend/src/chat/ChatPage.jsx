import { useEffect, useRef, useState } from "react";
import {
  queryLLMStream,
  listConversations,
  listDocuments,
  listReadableDocuments,
  getConversationMessages,
  deleteConversation,
  deleteMessagesFrom,
  updateConversation,
  ApiError,
} from "../api/client";
import Icon from "../ui/Icons";
import { ShelfGroup, Spine, WsMark } from "../ui/Shelf";
import { hashString, nameFromEmail, toneFor } from "../ui/spines";
import AnswerBlock from "./AnswerBlock";
import History from "./History";

// How close to the bottom (in pixels) counts as "still at the bottom" for
// auto-scroll purposes — small enough that a user who's actually scrolled
// up to read something isn't yanked back down.
const AUTO_SCROLL_THRESHOLD_PX = 80;

/**
 * Converts a message loaded from a saved conversation into the message format used for display.
 */
function mapStoredMessage(message) {
  return { id: message.id, role: message.role, content: message.content, chart: message.chart_config, sources: message.sources };
}

/**
 * Loads the docs for the Ask page's shelf when a single workspace or
 * classroom is picked. Returns "blank" for "All" and the institute library
 * (the shelf is just decoration then, without titles), null while loading, or groups of ready
 * documents: [{key, label, tone, docs, locked}].
 * Faculty get their workspace's books split by whether students can read
 * them; students get the books published to their classroom.
 */
// The Ask shelf lists real titles only for one workspace or classroom; for
// "All" and the institute library it's untitled decoration.
const SHOWS_REAL_DOCS = new Set(["personal", "shared", "class"]);

function useAskShelf(auth, shelves) {
  const [result, setResult] = useState({ key: null, groups: null });
  const scope = shelves.option;
  const isFaculty = auth.role === "faculty";

  useEffect(() => {
    if (!SHOWS_REAL_DOCS.has(scope.kind)) return undefined;
    let cancelled = false;

    async function load() {
      if (!isFaculty) {
        const docs = await listReadableDocuments(auth.token, scope.id);
        return [{ key: "class", label: scope.name, tone: scope.color, docs }];
      }
      const docs = (await listDocuments(auth.token, scope.id)).filter((d) => d.status === "indexed");
      if (scope.kind === "personal") {
        return [{ key: "mine", label: "Only you", tone: "var(--tone-6)", docs }];
      }
      return [
        { key: "pub", label: "Published to classrooms", tone: "var(--accent)", docs: docs.filter((d) => d.visibility === "classrooms") },
        { key: "fac", label: "Faculty only", tone: "var(--muted)", docs: docs.filter((d) => d.visibility !== "classrooms"), locked: true },
      ];
    }

    load()
      .then((groups) => !cancelled && setResult({ key: scope.id, groups: groups.filter((g) => g.docs.length > 0) }))
      .catch(() => !cancelled && setResult({ key: scope.id, groups: [] }));
    return () => {
      cancelled = true;
    };
  }, [auth.token, isFaculty, scope.id, scope.kind, scope.name, scope.color]);

  if (!SHOWS_REAL_DOCS.has(scope.kind)) return "blank";
  return result.key === scope.id ? result.groups : null;
}

/**
 * The Ask view: past questions on the left; an empty state with the current
 * shelf, or the conversation with the docs it used on a desk to the right;
 * and the composer. What gets searched is the topbar switcher's choice
 * (`shelves.option`), sent as the query's scope.
 */
export default function ChatPage({ auth, shelves, historyOpen, onCloseHistory }) {
  const [conversations, setConversations] = useState([]);
  const [conversationId, setConversationId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [editingMessageId, setEditingMessageId] = useState(null);
  const [editingValue, setEditingValue] = useState("");
  const [editSaving, setEditSaving] = useState(false);
  // Which answer's docs the desk highlights: a hovered answer, else a
  // clicked one, else the latest answer that used any docs.
  const [selectedAnswer, setSelectedAnswer] = useState(null);
  const [hoveredAnswer, setHoveredAnswer] = useState(null);
  const textareaRef = useRef(null);
  const threadRef = useRef(null);
  // A ref (not state) because the scroll handler needs the latest value
  // synchronously on every scroll event, without waiting on a re-render.
  const autoScrollRef = useRef(true);
  const shelf = useAskShelf(auth, shelves);
  const scope = shelves.option;

  /**
   * Reloads the list of past conversations shown in the sidebar.
   */
  function refreshConversations() {
    listConversations(auth.token)
      .then(setConversations)
      .catch(() => {});
  }

  useEffect(() => {
    refreshConversations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keeps the view pinned to the newest message (e.g. while an answer is
  // streaming in) as long as the user hasn't scrolled up to read something
  // earlier.
  useEffect(() => {
    const el = threadRef.current;
    if (el && autoScrollRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  function handleThreadScroll() {
    const el = threadRef.current;
    if (!el) return;
    autoScrollRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < AUTO_SCROLL_THRESHOLD_PX;
  }

  function resizeTextarea() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  }

  function handleNewChat() {
    setConversationId(null);
    setMessages([]);
    setSelectedAnswer(null);
    setError("");
    autoScrollRef.current = true;
    onCloseHistory();
    textareaRef.current?.focus();
  }

  async function handleSelect(id) {
    onCloseHistory();
    if (id === conversationId) return;
    setConversationId(id);
    setSelectedAnswer(null);
    setError("");
    autoScrollRef.current = true;
    try {
      const stored = await getConversationMessages(auth.token, id);
      setMessages(stored.map(mapStoredMessage));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load that conversation.");
    }
  }

  async function handleDelete(id) {
    try {
      await deleteConversation(auth.token, id);
      if (id === conversationId) handleNewChat();
      refreshConversations();
    } catch {
      // best-effort — the list just won't update if this fails
    }
  }

  async function handleRename(id, title) {
    try {
      await updateConversation(auth.token, id, { title });
      refreshConversations();
    } catch {
      // best-effort
    }
  }

  async function handleTogglePin(id, isPinned) {
    try {
      await updateConversation(auth.token, id, { isPinned });
      refreshConversations();
    } catch {
      // best-effort
    }
  }

  /**
   * Appends a chunk of text to the currently-streaming assistant message (always the last one in the list).
   */
  function appendToLastMessage(text) {
    setMessages((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      next[next.length - 1] = { ...last, content: last.content + text };
      return next;
    });
  }

  /**
   * Sends a question and streams the answer into the thread, starting a new
   * conversation if needed. Shared by the composer and by saving an edit.
   */
  async function sendQuery(trimmed) {
    setLoading(true);
    setSelectedAnswer(null); // follow the new answer
    setError("");
    autoScrollRef.current = true;
    setMessages((prev) => [
      ...prev,
      { role: "user", content: trimmed, scopeName: scope.id ? scope.name : null },
      { role: "assistant", content: "", chart: null, sources: [] },
    ]);

    const isNewConversation = conversationId === null;
    try {
      await queryLLMStream(auth.token, conversationId, trimmed, {
        scopeId: scope.searchId,
        onStart: (event) => {
          if (isNewConversation) {
            setConversationId(event.conversation_id);
            // The title is generated during the first turn; refresh now so
            // the entry appears, and again shortly after to pick up the title.
            refreshConversations();
            setTimeout(refreshConversations, 1500);
          }
        },
        onToken: appendToLastMessage,
        onDone: (event) => {
          refreshConversations();
          setMessages((prev) => {
            const next = [...prev];
            const assistantIndex = next.length - 1;
            const userIndex = assistantIndex - 1;
            next[assistantIndex] = {
              id: event.assistant_message_id,
              role: "assistant",
              content: event.answer,
              chart: event.chart,
              sources: event.sources,
            };
            if (userIndex >= 0 && next[userIndex].role === "user") {
              next[userIndex] = { ...next[userIndex], id: event.user_message_id };
            }
            return next;
          });
        },
        onError: (message) => setError(message),
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmit(e) {
    e?.preventDefault();
    const trimmed = query.trim();
    if (!trimmed || loading) return;
    setQuery("");
    requestAnimationFrame(resizeTextarea);
    await sendQuery(trimmed);
  }

  function startEditMessage(message) {
    if (!message.id || loading || editSaving) return;
    setEditingMessageId(message.id);
    setEditingValue(message.content);
  }

  function cancelEditMessage() {
    setEditingMessageId(null);
    setEditingValue("");
  }

  /**
   * Saves an edited question: drops it and everything after it (backend and
   * local), then asks the corrected question.
   */
  async function submitEditMessage(index) {
    const message = messages[index];
    const trimmed = editingValue.trim();
    if (!message?.id || !trimmed || editSaving || loading) return;

    setEditSaving(true);
    try {
      await deleteMessagesFrom(auth.token, conversationId, message.id);
      setMessages((prev) => prev.slice(0, index));
      cancelEditMessage();
      await sendQuery(trimmed);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save that edit.");
    } finally {
      setEditSaving(false);
    }
  }

  const inConvo = messages.length > 0;
  const answered = messages.map((m, i) => (m.role === "assistant" && m.sources?.length ? i : -1)).filter((i) => i >= 0);
  const answerCount = answered.length;
  const focusedAnswer = hoveredAnswer ?? selectedAnswer ?? answered[answered.length - 1] ?? null;
  const placeholder = inConvo
    ? "Ask a follow-up..."
    : scope.id
      ? `Ask about ${scope.name}...`
      : "Ask about calendars, placements, syllabi, reports...";

  const composer = (
    <div className="composer-wrap">
      <form className="composer" onSubmit={handleSubmit}>
        {scope.id && (
          <span className="scope">
            <i style={{ background: scope.color }} />
            <span>In {scope.name}</span>
            <button type="button" aria-label="Ask across everything instead" onClick={() => shelves.setScope(null)}>
              <Icon name="x" />
            </button>
          </span>
        )}
        <label htmlFor="q" className="sr">
          Your question
        </label>
        <textarea
          id="q"
          ref={textareaRef}
          rows={1}
          placeholder={placeholder}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            resizeTextarea();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSubmit();
            }
          }}
        />
        <button className="btn" type="submit" disabled={loading || !query.trim()}>
          {loading ? "Asking..." : "Ask"} <Icon name="arrowUp" />
        </button>
      </form>
      {error && <p className="composer-error">{error}</p>}
    </div>
  );

  return (
    <>
      <History
        conversations={conversations}
        activeConversationId={conversationId}
        open={historyOpen}
        onSelect={handleSelect}
        onNewChat={handleNewChat}
        onDelete={handleDelete}
        onRename={handleRename}
        onTogglePin={handleTogglePin}
      />
      <main className="main">
        {inConvo ? (
          <section className="convo">
            <div className="convo-main">
              <div className="thread" ref={threadRef} onScroll={handleThreadScroll}>
                <div className="thread-inner">
                  {messages.map((message, i) =>
                    message.role === "user" ? (
                      editingMessageId === message.id ? (
                        <div className="q-editing" key={i}>
                          <textarea
                            className="input"
                            value={editingValue}
                            onChange={(e) => setEditingValue(e.target.value)}
                            disabled={editSaving}
                            autoFocus
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && !e.shiftKey) {
                                e.preventDefault();
                                submitEditMessage(i);
                              }
                              if (e.key === "Escape") cancelEditMessage();
                            }}
                          />
                          <div className="row">
                            <button type="button" className="btn btn-ghost" disabled={editSaving} onClick={cancelEditMessage}>
                              Cancel
                            </button>
                            <button type="button" className="btn" disabled={editSaving} onClick={() => submitEditMessage(i)}>
                              {editSaving ? "Saving..." : "Save and ask again"}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="q-row" key={i}>
                          {message.id && (
                            <button
                              type="button"
                              className="icon-btn q-edit"
                              aria-label="Edit question"
                              title="Edit question"
                              disabled={loading}
                              onClick={() => startEditMessage(message)}
                            >
                              <Icon name="pen" />
                            </button>
                          )}
                          <div className="q">
                            {message.scopeName && <span className="scoped">In {message.scopeName}</span>}
                            {message.content}
                          </div>
                        </div>
                      )
                    ) : (
                      <AnswerBlock
                        message={message}
                        streaming={loading && i === messages.length - 1}
                        active={answerCount > 1 && i === focusedAnswer}
                        onSelect={() => setSelectedAnswer(selectedAnswer === i ? null : i)}
                        onHover={(on) => setHoveredAnswer(on ? i : null)}
                        key={i}
                      />
                    )
                  )}
                </div>
              </div>
              {composer}
            </div>
            <Desk messages={messages} focused={focusedAnswer} />
          </section>
        ) : (
          <>
            <section className="ask-empty">
              <div className="ask-inner">
                <AskHead auth={auth} shelves={shelves} />
                <div className="ask-shelf">
                  {shelf === "blank" ? <BlankShelf /> : <BookShelf groups={shelf} isFaculty={auth.role === "faculty"} />}
                  {auth.role === "student" && !scope.id && <ClassroomCards shelves={shelves} />}
                </div>
              </div>
            </section>
            {composer}
          </>
        )}
      </main>
    </>
  );
}

/**
 * Greeting and a line about what the current scope searches.
 */
function AskHead({ auth, shelves }) {
  const first = nameFromEmail(auth.sub).split(" ")[0];
  const scope = shelves.option;
  let sub;
  if (auth.role === "faculty") {
    if (!scope.id) {
      sub = "Answers come from the institute library and every workspace you're in. Pick one shelf from the switcher above to narrow it down.";
    } else if (scope.kind === "library") {
      sub = "Answers use only the institute library: institute-wide docs, including the faculty-only ones.";
    } else if (scope.kind === "personal") {
      sub = "Your own shelf. Only you can see these docs, and answers use only them.";
    } else {
      const others = (scope.workspace?.member_count ?? 1) - 1;
      sub = others
        ? `The ${scope.name} shelf, shared with ${others} other faculty. Answers use only this workspace's docs.`
        : `The ${scope.name} shelf. No other faculty have joined yet. Answers use only this workspace's docs.`;
    }
  } else if (shelves.classrooms.length === 0) {
    sub = "Answers come from institute-wide documents. Join your classroom with the code your teacher shared to ask about its docs too.";
  } else if (!scope.id) {
    sub = "Answers come from the docs your teachers published to your classrooms, plus institute-wide documents.";
  } else if (scope.kind === "library") {
    sub = "Answers use only institute-wide documents, not your classrooms' docs.";
  } else {
    sub = `Docs your teachers published to ${scope.name}. Answers use only this classroom's docs.`;
  }
  return (
    <div className="ask-head">
      <h1>What are you looking for, {first}?</h1>
      <p>{sub}</p>
    </div>
  );
}

// The "All" shelf is decoration: a fixed run of untitled books.
const BLANK_BOOKS = Array.from({ length: 18 }, (_, i) => {
  const h = hashString(`blank-${i}`);
  return { id: `blank-${i}`, title: "", size: [24 + (h % 5) * 4, 150 + ((h >> 3) % 5) * 13] };
});

/**
 * A shelf of untitled books, shown when questions search everything.
 */
function BlankShelf() {
  const scale = window.innerWidth < 700 ? 0.66 : 1;
  return (
    <div className="blank-shelf">
      <div className="shelf-row">
        {BLANK_BOOKS.map((b) => (
          <Spine
            key={b.id}
            doc={b}
            blank
            size={[Math.round(b.size[0] * scale), Math.round(b.size[1] * scale)]}
          />
        ))}
      </div>
      <div className="plank" />
    </div>
  );
}

/**
 * The ready books on the picked workspace or classroom, grouped.
 */
function BookShelf({ groups, isFaculty }) {
  if (groups === null) return <p className="desk-empty">Fetching the shelf...</p>;
  if (groups.length === 0) {
    // Same untitled shelf as "All", so an empty workspace doesn't look broken.
    return (
      <>
        <BlankShelf />
        <p className="shelf-hint">
          {isFaculty
            ? "No docs here yet. Add some from the Library."
            : "Your teachers haven't published anything to this classroom yet."}
        </p>
      </>
    );
  }
  const scale = window.innerWidth < 700 ? 0.66 : 1;
  return (
    <div className="shelf-wrap">
      {groups.map((g) => (
        <ShelfGroup key={g.key} label={g.label} tone={g.tone} count={g.docs.length}>
          {g.docs.map((d) => (
            <Spine key={d.id} doc={d} scale={scale} locked={Boolean(g.locked)} />
          ))}
        </ShelfGroup>
      ))}
    </div>
  );
}

/**
 * Students: their classrooms, each a shortcut to ask only about that classroom.
 */
function ClassroomCards({ shelves }) {
  const classes = shelves.sections.flatMap((s) => s.options).filter((o) => o.kind === "class");
  if (classes.length === 0) {
    return (
      <div className="note-box">
        <b>You haven&apos;t joined a classroom yet.</b> Open the switcher at the top and enter the code your teacher
        shared.
      </div>
    );
  }
  return (
    <div className="class-cards">
      {classes.map((c) => (
        <button key={c.id} className="ws-opt" onClick={() => shelves.setScope(c.id)}>
          <WsMark kind="class" color={c.color} />
          <span>
            <b>{c.name}</b>
            <small>{c.sub}</small>
          </span>
        </button>
      ))}
    </div>
  );
}

/**
 * Every doc this conversation used, on the desk to the right. The docs of
 * the `focused` answer (index into `messages`) are highlighted and the rest
 * dimmed, so you can see which docs each answer read.
 */
function Desk({ messages, focused }) {
  const seen = new Map();
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const s of m.sources ?? []) if (!seen.has(s.doc_id)) seen.set(s.doc_id, s);
  }
  const docs = [...seen.values()];
  const questions = messages.filter((m) => m.role === "user").length;
  const highlighted = new Set((focused != null ? messages[focused]?.sources ?? [] : []).map((s) => s.doc_id));
  const answerNumber = messages.slice(0, (focused ?? -1) + 1).filter((m) => m.role === "assistant").length;

  return (
    <aside className={`desk${docs.length ? "" : " is-empty"}`} aria-label="Docs used in this conversation">
      <div className="desk-head">
        <h2>On your desk</h2>
        <p>Docs this conversation used. Hover or click an answer to see which ones it read.</p>
      </div>
      {docs.length > 0 && (
        <div className="desk-stats">
          <div>
            <b>{docs.length}</b>
            <span>{docs.length === 1 ? "doc" : "docs"}</span>
          </div>
          <div>
            <b>{questions}</b>
            <span>{questions === 1 ? "question" : "questions"}</span>
          </div>
          {highlighted.size > 0 && (
            <div className="busy">
              <b>{highlighted.size}</b>
              <span>in answer {answerNumber}</span>
            </div>
          )}
        </div>
      )}
      <div className="desk-pile">
        {docs.map((d) => {
          const state = highlighted.size === 0 ? "" : highlighted.has(d.doc_id) ? " is-active" : " is-dim";
          return (
            <div className={`flat${state}`} data-tone={toneFor(d.doc_id)} key={d.doc_id} title={d.title}>
              <span>{d.title}</span>
            </div>
          );
        })}
      </div>
      <div className="plank desk-plank" />
      {docs.length === 0 && <p className="desk-empty">Docs land here as answers use them.</p>}
    </aside>
  );
}
