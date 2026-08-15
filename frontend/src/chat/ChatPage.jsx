import { useEffect, useState, useRef } from "react";
import {
  queryLLMStream,
  listConversations,
  getConversationMessages,
  deleteConversation,
  deleteMessagesFrom,
  updateConversation,
  ApiError,
} from "../api/client";
import AnswerBlock from "./AnswerBlock";
import Sidebar from "./Sidebar";

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
 * Shows the chat page with the sidebar of past conversations, the running list of messages, and the box for typing a new question.
 */
export default function ChatPage({ auth }) {
  const [conversations, setConversations] = useState([]);
  const [conversationId, setConversationId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [editingMessageId, setEditingMessageId] = useState(null);
  const [editingValue, setEditingValue] = useState("");
  const [editSaving, setEditSaving] = useState(false);
  const textareaRef = useRef(null);
  const messagesListRef = useRef(null);
  // A ref (not state) because the scroll handler needs the latest value
  // synchronously on every scroll event, without waiting on a re-render.
  const autoScrollRef = useRef(true);

  /**
   * Grows or shrinks the question textarea's height to fit what's been typed, within a minimum and maximum size.
   */
  const autoResizeTextarea = () => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "39px";
    textarea.style.height = Math.max(39, Math.min(textarea.scrollHeight, 110)) + "px";
  };

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
  // earlier. Runs on every message update rather than just while streaming
  // because that's the only reliable signal that new content was added.
  useEffect(() => {
    const el = messagesListRef.current;
    if (el && autoScrollRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  /**
   * Tracks whether the user is still scrolled to the bottom of the message
   * list, so the streaming auto-scroll knows whether to keep following.
   */
  function handleMessagesScroll() {
    const el = messagesListRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    autoScrollRef.current = distanceFromBottom < AUTO_SCROLL_THRESHOLD_PX;
  }

  /**
   * Clears the current conversation so the user can start a fresh chat.
   */
  function handleNewChat() {
    setConversationId(null);
    setMessages([]);
    setError("");
    autoScrollRef.current = true;
  }

  /**
   * Loads and displays the messages for the conversation the user clicked on in the sidebar.
   */
  async function handleSelect(id) {
    if (id === conversationId) return;
    setConversationId(id);
    setError("");
    autoScrollRef.current = true;
    try {
      const stored = await getConversationMessages(auth.token, id);
      setMessages(stored.map(mapStoredMessage));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load that conversation.");
    }
  }

  /**
   * Deletes a conversation and starts a new chat if the deleted one was currently open.
   */
  async function handleDelete(id) {
    try {
      await deleteConversation(auth.token, id);
      if (id === conversationId) handleNewChat();
      refreshConversations();
    } catch {
      // best-effort — sidebar just won't update if this fails
    }
  }

  /**
   * Renames a conversation and reloads the sidebar list.
   */
  async function handleRename(id, title) {
    const trimmed = title.trim();
    if (!trimmed) return;
    try {
      await updateConversation(auth.token, id, { title: trimmed });
      refreshConversations();
    } catch {
      // best-effort — sidebar just won't update if this fails
    }
  }

  /**
   * Pins or unpins a conversation and reloads the sidebar list.
   */
  async function handleTogglePin(id, isPinned) {
    try {
      await updateConversation(auth.token, id, { isPinned });
      refreshConversations();
    } catch {
      // best-effort — sidebar just won't update if this fails
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
   * Sends a question to the AI and streams the answer into the chat as it's
   * generated, starting a new conversation entry if needed. Shared by the
   * query box and by saving a message edit.
   */
  async function sendQuery(trimmed) {
    setLoading(true);
    setError("");
    // The user just sent a message — always follow the reply as it streams
    // in, even if they'd scrolled up earlier in the conversation.
    autoScrollRef.current = true;
    setMessages((prev) => [
      ...prev,
      { role: "user", content: trimmed },
      { role: "assistant", content: "", chart: null, sources: [] },
    ]);

    const isNewConversation = conversationId === null;
    try {
      await queryLLMStream(auth.token, conversationId, trimmed, {
        onStart: (event) => {
          if (isNewConversation) {
            setConversationId(event.conversation_id);
            // The backend starts generating this conversation's title in
            // parallel with the answer, right when it's created — refresh
            // now so the sidebar entry appears immediately, then once more
            // shortly after to pick up the title once it lands.
            refreshConversations();
            setTimeout(refreshConversations, 1500);
          }
        },
        onToken: appendToLastMessage,
        onDone: (event) => {
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

  /**
   * Sends the typed question to the AI, clearing the input box first.
   */
  async function handleSubmit(e) {
    e.preventDefault();
    const trimmed = query.trim();
    if (!trimmed || loading) return;
    setQuery("");
    await sendQuery(trimmed);
  }

  /**
   * Starts editing a previously-sent message in place.
   */
  function startEditMessage(message) {
    if (!message.id || loading || editSaving) return;
    setEditingMessageId(message.id);
    setEditingValue(message.content);
  }

  /**
   * Cancels an in-progress message edit without saving it.
   */
  function cancelEditMessage() {
    setEditingMessageId(null);
    setEditingValue("");
  }

  /**
   * Saves an edited message: drops it and everything that followed it (both
   * on the backend and locally, since the old answer no longer applies),
   * then re-asks the corrected question.
   */
  async function submitEditMessage(index) {
    const message = messages[index];
    const trimmed = editingValue.trim();
    if (!message?.id || !trimmed || editSaving || loading) return;

    setEditSaving(true);
    try {
      await deleteMessagesFrom(auth.token, conversationId, message.id);
      setMessages((prev) => prev.slice(0, index));
      setEditingMessageId(null);
      setEditingValue("");
      await sendQuery(trimmed);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save that edit.");
    } finally {
      setEditSaving(false);
    }
  }

  /**
   * Updates the typed question text and resizes the textarea as the user types.
   */
  const handleQueryChange = (e) => {
    setQuery(e.target.value);
    autoResizeTextarea();
  };

  return (
    <div className="chat-layout">
      <Sidebar
        conversations={conversations}
        activeConversationId={conversationId}
        onSelect={handleSelect}
        onNewChat={handleNewChat}
        onDelete={handleDelete}
        onRename={handleRename}
        onTogglePin={handleTogglePin}
      />
      <div className="page">
        <div className="chat-container">
          {messages.length === 0 && (
            <div className="chat-header">
              <h1 className="welcome-heading">
                <span className="welcome-wave">W</span>elcome, <span className="welcome-name">Back!!</span>
              </h1>
            </div>
          )}

          <div className="messages-list" ref={messagesListRef} onScroll={handleMessagesScroll}>
            <div className="messages-inner">
              {messages.map((message, i) =>
                message.role === "user" ? (
                  editingMessageId === message.id ? (
                    <div className="user-message-editing" key={i}>
                      <textarea
                        className="input user-message-edit-input"
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
                      <div className="user-message-edit-actions">
                        <button type="button" className="btn-secondary btn" disabled={editSaving} onClick={cancelEditMessage}>
                          Cancel
                        </button>
                        <button type="button" className="btn" disabled={editSaving} onClick={() => submitEditMessage(i)}>
                          {editSaving ? "Saving..." : "Save"}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="user-message-row" key={i}>
                      {message.id && (
                        <button
                          type="button"
                          className="user-message-edit-trigger"
                          title="Edit message"
                          disabled={loading}
                          onClick={() => startEditMessage(message)}
                        >
                          <img className="user-message-edit-icon" src="/rename.png" alt="Edit" />
                        </button>
                      )}
                      <div className="user-message">{message.content}</div>
                    </div>
                  )
                ) : (
                  <AnswerBlock message={message} key={i} />
                )
              )}
            </div>
          </div>

          <form className="query-form" onSubmit={handleSubmit}>
            <textarea
              ref={textareaRef}
              className="textarea input"
              placeholder="Ask a question..."
              value={query}
              onChange={handleQueryChange}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmit(e);
                }
              }}
            />
            <button className="btn" type="submit" disabled={loading}>
              {loading ? "Asking..." : "Ask"}
            </button>
          </form>

          {error && <div className="status-line error">{error}</div>}
        </div>
      </div>
    </div>
  );
}
