import { useState } from "react";

function relativeTime(dateStr) {
  const diffSec = Math.round((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? "" : "s"} ago`;
  const diffHour = Math.round(diffMin / 60);
  if (diffHour < 24) return `${diffHour} hour${diffHour === 1 ? "" : "s"} ago`;
  const diffDay = Math.round(diffHour / 24);
  if (diffDay < 30) return `${diffDay} day${diffDay === 1 ? "" : "s"} ago`;
  return new Date(dateStr).toLocaleDateString();
}

export default function Sidebar({ conversations, activeConversationId, onSelect, onNewChat, onDelete }) {
  const [collapsed, setCollapsed] = useState(false);

  if (collapsed) {
    return (
      <div className="sidebar sidebar-collapsed">
        <button className="btn-secondary btn sidebar-toggle" onClick={() => setCollapsed(false)} title="Expand sidebar">
          »
        </button>
      </div>
    );
  }

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <button className="btn new-chat-btn" onClick={onNewChat}>
          + New chat
        </button>
        <button className="btn-secondary btn sidebar-toggle" onClick={() => setCollapsed(true)} title="Collapse sidebar">
          «
        </button>
      </div>
      <div className="conversation-list">
        {conversations.length === 0 && <div className="sidebar-empty">No conversations yet</div>}
        {conversations.map((conversation) => (
          <div
            key={conversation.id}
            className={`conversation-item${conversation.id === activeConversationId ? " active" : ""}`}
            onClick={() => onSelect(conversation.id)}
          >
            <span className="conversation-title">{conversation.title || "New conversation"}</span>
            <span className="conversation-time">{relativeTime(conversation.updated_at)}</span>
            <button
              className="conversation-delete"
              title="Delete conversation"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(conversation.id);
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
