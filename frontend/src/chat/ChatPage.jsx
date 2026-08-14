import { useEffect, useState, useRef } from "react";
import {
  queryLLM,
  listConversations,
  getConversationMessages,
  deleteConversation,
  updateConversation,
  ApiError,
} from "../api/client";
import RoleBadge from "./RoleBadge";
import AnswerBlock from "./AnswerBlock";
import Sidebar from "./Sidebar";

/**
 * Converts a fresh answer just received from the server into the message format used for display.
 * Example: mapLiveResponse({ answer: "Hi", chart: null, sources: [] }) -> { role: "assistant", content: "Hi", chart: null, sources: [] }
 */
function mapLiveResponse(response) {
  return { role: "assistant", content: response.answer, chart: response.chart, sources: response.sources };
}

/**
 * Converts a message loaded from a saved conversation into the message format used for display.
 */
function mapStoredMessage(message) {
  return { role: message.role, content: message.content, chart: message.chart_config, sources: message.sources };
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
  const textareaRef = useRef(null);

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

  /**
   * Clears the current conversation so the user can start a fresh chat.
   */
  function handleNewChat() {
    setConversationId(null);
    setMessages([]);
    setError("");
  }

  /**
   * Loads and displays the messages for the conversation the user clicked on in the sidebar.
   */
  async function handleSelect(id) {
    if (id === conversationId) return;
    setConversationId(id);
    setError("");
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
   * Sends the typed question to the AI, adds the question and its answer to the chat, and starts a new conversation entry if needed.
   */
  async function handleSubmit(e) {
    e.preventDefault();
    const trimmed = query.trim();
    if (!trimmed || loading) return;

    setLoading(true);
    setError("");
    setMessages((prev) => [...prev, { role: "user", content: trimmed }]);
    setQuery("");

    const isNewConversation = conversationId === null;
    try {
      const response = await queryLLM(auth.token, conversationId, trimmed);
      setMessages((prev) => [...prev, mapLiveResponse(response)]);
      if (isNewConversation) {
        setConversationId(response.conversation_id);
        refreshConversations();
        // Title generation runs async server-side after the response —
        // one more refetch a few seconds later picks it up.
        setTimeout(refreshConversations, 4000);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
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
          <div className="chat-header">
            <h1 className="welcome-heading">
              <span className="welcome-wave">W</span>elcome, <span className="welcome-name">Back!!</span>
            </h1>
          </div>

          <div className="messages-list">
            {messages.map((message, i) =>
              message.role === "user" ? (
                <div className="user-message" key={i}>
                  {message.content}
                </div>
              ) : (
                <AnswerBlock message={message} key={i} />
              )
            )}
          </div>

          <form className="query-form" onSubmit={handleSubmit}>
            <textarea
              ref={textareaRef}
              className="textarea input"
              placeholder="Ask a question..."
              value={query}
              onChange={handleQueryChange}
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
