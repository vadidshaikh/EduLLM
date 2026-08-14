import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Shows the list of past conversations with buttons to start/select chats
 * and a per-conversation actions menu.
 */
export default function Sidebar({
  conversations,
  activeConversationId,
  onSelect,
  onNewChat,
  onDelete,
  onRename,
  onTogglePin,
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [menuState, setMenuState] = useState(null);
  const [renameConversationId, setRenameConversationId] = useState(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameSaving, setRenameSaving] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!renameConversationId) return;

    function handleOutsideRenameClick(event) {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest(".conversation-inline-rename") !== null) return;
      cancelRename();
    }

    document.addEventListener("pointerdown", handleOutsideRenameClick);
    return () => {
      document.removeEventListener("pointerdown", handleOutsideRenameClick);
    };
  }, [renameConversationId]);

  useEffect(() => {
    if (!menuState) return;

    function handlePointerDown(event) {
      const target = event.target;
      if (target instanceof Element && target.closest(".conversation-menu") !== null) return;
      if (target instanceof Element && target.closest(".conversation-menu-trigger") !== null) return;
      setMenuState(null);
      setRenameValue("");
    }

    function handleEsc(event) {
      if (event.key === "Escape") {
        setMenuState(null);
        setRenameValue("");
      }
    }

    function closeOnViewportChange() {
      setMenuState(null);
      setRenameValue("");
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleEsc);
    window.addEventListener("resize", closeOnViewportChange);
    window.addEventListener("scroll", closeOnViewportChange, true);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleEsc);
      window.removeEventListener("resize", closeOnViewportChange);
      window.removeEventListener("scroll", closeOnViewportChange, true);
    };
  }, [menuState]);

  useEffect(() => {
    if (!menuState || !menuRef.current) return;

    const menuEl = menuRef.current;
    const margin = 8;
    let nextLeft = menuState.left;
    let nextTop = menuState.top;
    const rect = menuEl.getBoundingClientRect();

    if (nextLeft + rect.width > window.innerWidth - margin) {
      const openToLeft = menuState.anchorLeft - rect.width - 6;
      nextLeft = openToLeft >= margin
        ? openToLeft
        : Math.max(margin, window.innerWidth - rect.width - margin);
    }
    if (nextTop + rect.height > window.innerHeight - margin) {
      nextTop = Math.max(margin, menuState.anchorTop - rect.height - 6);
    }

    if (nextLeft !== menuState.left || nextTop !== menuState.top) {
      setMenuState((current) => {
        if (!current) return current;
        return { ...current, left: nextLeft, top: nextTop };
      });
    }
  }, [menuState]);

  function openMenu(e, conversation) {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const minLeft = 8;
    const left = Math.max(minLeft, rect.right + 6);
    const top = rect.bottom + 6;
    const isSame = menuState?.id === conversation.id;

    if (isSame) {
      setMenuState(null);
      return;
    }

    setMenuState({
      id: conversation.id,
      left,
      top,
      anchorTop: rect.top,
      anchorLeft: rect.left,
      anchorRight: rect.right,
      title: conversation.title || "",
      isPinned: Boolean(conversation.is_pinned),
    });
  }

  function closeMenu() {
    setMenuState(null);
  }

  function startRename(conversation) {
    setMenuState(null);
    setRenameConversationId(conversation.id);
    setRenameValue(conversation.title || "");
  }

  function cancelRename() {
    setRenameConversationId(null);
    setRenameSaving(false);
    setRenameValue("");
  }

  async function submitRename() {
    if (!renameConversationId || renameSaving) return;
    const trimmed = renameValue.trim();
    if (!trimmed) return;
    setRenameSaving(true);
    try {
      await onRename(renameConversationId, trimmed);
      cancelRename();
    } finally {
      setRenameSaving(false);
    }
  }

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
            onClick={() => {
              if (renameConversationId === conversation.id) return;
              onSelect(conversation.id);
            }}
          >
            {renameConversationId === conversation.id ? (
              <div className="conversation-inline-rename" onClick={(e) => e.stopPropagation()}>
                <input
                  className="input conversation-rename-input"
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  placeholder="Conversation name"
                  autoFocus
                  disabled={renameSaving}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") submitRename();
                    if (e.key === "Escape") cancelRename();
                  }}
                />
              </div>
            ) : (
              <span className="conversation-title">
                {conversation.is_pinned ? <span className="conversation-pin" title="Pinned">📌</span> : null}
                {conversation.title || "New conversation"}
              </span>
            )}
            <button
              className="conversation-menu-trigger"
              title="Conversation options"
              onClick={(e) => openMenu(e, conversation)}
            >
              ...
            </button>
          </div>
        ))}
      </div>
      {menuState &&
        createPortal(
          <div
            ref={menuRef}
            className="conversation-menu"
            style={{ left: `${menuState.left}px`, top: `${menuState.top}px` }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="conversation-menu-item"
              onClick={() => {
                const conversation = conversations.find((c) => c.id === menuState.id);
                if (!conversation) {
                  closeMenu();
                  return;
                }
                startRename(conversation);
              }}
            >
              Rename
            </button>
            <button
              className="conversation-menu-item"
              onClick={() => {
                closeMenu();
                if (window.confirm("Delete this conversation? This can't be undone.")) {
                  onDelete(menuState.id);
                }
              }}
            >
              Delete
            </button>
            <button
              className="conversation-menu-item"
              onClick={() => {
                onTogglePin(menuState.id, !menuState.isPinned);
                closeMenu();
              }}
            >
              {menuState.isPinned ? "Unpin" : "Pin"}
            </button>
          </div>,
          document.body
        )}
    </div>
  );
}
