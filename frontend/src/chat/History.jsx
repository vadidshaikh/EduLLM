import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import Icon from "../ui/Icons";
import { toneFor } from "../ui/spines";
import { confirmDialog } from "../ui/confirm";

const DAY_MS = 86_400_000;

/**
 * Which heading a conversation goes under: Pinned, then by last update.
 */
function groupOf(conversation) {
  if (conversation.is_pinned) return "Pinned";
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  const updated = new Date(conversation.updated_at).getTime();
  if (updated >= startOfToday) return "Today";
  if (updated >= startOfToday - DAY_MS) return "Yesterday";
  return "Earlier";
}

const GROUPS = ["Pinned", "Today", "Yesterday", "Earlier"];

const STACK_HEIGHTS = [14, 18, 12]; // px, the same for every conversation

/**
 * The conversation's docs as a little stack: one bar per doc its answers
 * used (up to three, most recent first), in the same colour as that doc on
 * the desk. Unused slots are drawn empty, so every stack has the same shape.
 */
function Stack({ docIds = [] }) {
  return (
    <span className="stack" aria-hidden="true">
      {STACK_HEIGHTS.map((height, k) => (
        <i
          key={k}
          className={docIds[k] ? "" : "empty"}
          style={{ height: `${height}px`, background: docIds[k] ? `var(--tone-${toneFor(docIds[k])})` : undefined }}
        />
      ))}
    </span>
  );
}

/**
 * The left column: the shelf switcher (`switcher`, what Ask searches),
 * "New question" and the user's past conversations,
 * grouped, each with a menu to rename, pin or delete it. On narrow screens
 * it slides in (`open`).
 */
export default function History({
  switcher,
  conversations,
  activeConversationId,
  open,
  onSelect,
  onNewChat,
  onDelete,
  onRename,
  onTogglePin,
}) {
  const [menu, setMenu] = useState(null); // {conversation, left, top}
  const [renaming, setRenaming] = useState(null); // {id, value}

  useEffect(() => {
    if (!menu) return undefined;
    function onDown(e) {
      if (e.target instanceof Element && e.target.closest(".h-menu, .h-menu-trigger")) return;
      setMenu(null);
    }
    function onKey(e) {
      if (e.key === "Escape") setMenu(null);
    }
    function close() {
      setMenu(null);
    }
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [menu]);

  function openMenu(e, conversation) {
    e.stopPropagation();
    if (menu?.conversation.id === conversation.id) {
      setMenu(null);
      return;
    }
    const r = e.currentTarget.getBoundingClientRect();
    setMenu({
      conversation,
      left: Math.min(r.right + 6, window.innerWidth - 180),
      top: Math.min(r.top, window.innerHeight - 140),
    });
  }

  async function submitRename() {
    const value = renaming?.value.trim();
    if (value) await onRename(renaming.id, value);
    setRenaming(null);
  }

  const grouped = GROUPS.map((g) => [g, conversations.filter((c) => groupOf(c) === g)]).filter(
    ([, items]) => items.length > 0
  );

  return (
    <aside className={`history${open ? " is-open" : ""}`} aria-label="Your questions">
      <div className="history-top">
        {switcher}
        <button className="btn" onClick={onNewChat}>
          <Icon name="plus" /> New question
        </button>
      </div>
      <div className="history-list">
        {grouped.length === 0 && (
          <p className="desk-empty" style={{ padding: ".8rem .45rem" }}>
            Questions you ask will be kept here.
          </p>
        )}
        {grouped.map(([group, items]) => (
          <div key={group}>
            <h3>{group}</h3>
            {items.map((c) =>
              renaming?.id === c.id ? (
                <div className="h-item h-renaming" key={c.id}>
                  <Stack docIds={c.doc_ids} />
                  <input
                    className="input"
                    value={renaming.value}
                    autoFocus
                    onChange={(e) => setRenaming({ ...renaming, value: e.target.value })}
                    onBlur={submitRename}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") submitRename();
                      if (e.key === "Escape") setRenaming(null);
                    }}
                  />
                </div>
              ) : (
                <div className="h-row" key={c.id}>
                  <button
                    className="h-item"
                    aria-current={c.id === activeConversationId ? "true" : undefined}
                    onClick={() => onSelect(c.id)}
                  >
                    <Stack docIds={c.doc_ids} />
                    <span>{c.title || "New question"}</span>
                  </button>
                  <button
                    className="icon-btn h-menu-trigger"
                    aria-label="Question options"
                    onClick={(e) => openMenu(e, c)}
                  >
                    <Icon name="dots" />
                  </button>
                </div>
              )
            )}
          </div>
        ))}
      </div>
      {menu &&
        createPortal(
          <div className="h-menu" style={{ left: menu.left, top: menu.top }}>
            <button
              onClick={() => {
                setRenaming({ id: menu.conversation.id, value: menu.conversation.title || "" });
                setMenu(null);
              }}
            >
              <Icon name="pen" /> Rename
            </button>
            <button
              onClick={() => {
                onTogglePin(menu.conversation.id, !menu.conversation.is_pinned);
                setMenu(null);
              }}
            >
              <Icon name="pin" /> {menu.conversation.is_pinned ? "Unpin" : "Pin"}
            </button>
            <button
              className="danger"
              onClick={async () => {
                const id = menu.conversation.id;
                setMenu(null);
                const ok = await confirmDialog({
                  title: "Delete this conversation?",
                  message: "Its questions and answers are removed for good.",
                  confirmLabel: "Delete",
                  danger: true,
                });
                if (ok) onDelete(id);
              }}
            >
              <Icon name="trash" /> Delete
            </button>
          </div>,
          document.body
        )}
    </aside>
  );
}
