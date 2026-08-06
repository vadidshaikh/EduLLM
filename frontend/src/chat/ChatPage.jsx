import { useEffect, useState, useRef } from "react";
import {
  queryLLM,
  listConversations,
  getConversationMessages,
  deleteConversation,
  ApiError,
} from "../api/client";
import RoleBadge from "./RoleBadge";
import AnswerBlock from "./AnswerBlock";
import Sidebar from "./Sidebar";

function mapLiveResponse(response) {
  return { role: "assistant", content: response.answer, chart: response.chart, sources: response.sources };
}

function mapStoredMessage(message) {
  return { role: message.role, content: message.content, chart: message.chart_config, sources: message.sources };
}

export default function ChatPage({ auth }) {
  const [conversations, setConversations] = useState([]);
  const [conversationId, setConversationId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const textareaRef = useRef(null);

  const autoResizeTextarea = () => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "39px";
    textarea.style.height = Math.max(39, Math.min(textarea.scrollHeight, 110)) + "px";
  };

  function refreshConversations() {
    listConversations(auth.token)
      .then(setConversations)
      .catch(() => {});
  }

  useEffect(() => {
    refreshConversations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleNewChat() {
    setConversationId(null);
    setMessages([]);
    setError("");
  }

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

  async function handleDelete(id) {
    try {
      await deleteConversation(auth.token, id);
      if (id === conversationId) handleNewChat();
      refreshConversations();
    } catch {
      // best-effort — sidebar just won't update if this fails
    }
  }

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
      />
      <div className="page">
        <div className="chat-container">
          <div className="chat-header">
            <RoleBadge role={auth.role} />
            <h1 style={{ margin: 0, fontSize: "1.3rem" }}>Ask about your institute's documents</h1>
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
