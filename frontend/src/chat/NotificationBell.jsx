import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { listNotifications, markAllNotificationsRead, markNotificationRead } from "../api/client";
import { BellIcon } from "./Icons";

// Notices are rare (a document update or delete), so a slow poll is enough.
const POLL_INTERVAL_MS = 60_000;

/**
 * Formats a notice's time as a short relative string ("5m ago"), falling
 * back to a date once it's more than a week old.
 */
function timeAgo(iso) {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 7 * 86400) return `${Math.floor(seconds / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

/**
 * Bell button with an unread badge that opens a panel of document
 * update/delete notices. Notices can be marked read but not removed.
 */
export default function NotificationBell({ token }) {
  const [data, setData] = useState({ unread_count: 0, notifications: [] });
  const [panel, setPanel] = useState(null); // {left, top} while open

  const refresh = useCallback(() => {
    listNotifications(token)
      .then(setData)
      .catch(() => {});
  }, [token]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    if (!panel) return undefined;

    function handlePointerDown(event) {
      const target = event.target;
      if (target instanceof Element && target.closest(".notification-panel, .notification-bell")) return;
      setPanel(null);
    }

    function handleEsc(event) {
      if (event.key === "Escape") setPanel(null);
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleEsc);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleEsc);
    };
  }, [panel]);

  function togglePanel(e) {
    if (panel) {
      setPanel(null);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    setPanel({ left: Math.max(8, rect.left), top: rect.bottom + 6 });
    refresh();
  }

  async function handleRead(notification) {
    if (notification.is_read) return;
    await markNotificationRead(token, notification.id).catch(() => {});
    refresh();
  }

  async function handleReadAll() {
    await markAllNotificationsRead(token).catch(() => {});
    refresh();
  }

  const unread = data.unread_count;

  return (
    <>
      <button
        type="button"
        className="btn-secondary btn notification-bell"
        onClick={togglePanel}
        title={unread ? `${unread} unread notification${unread === 1 ? "" : "s"}` : "Notifications"}
        aria-label="Notifications"
      >
        <BellIcon className="notification-bell-icon" />
        {unread > 0 && <span className="notification-badge">{unread > 99 ? "99+" : unread}</span>}
      </button>
      {panel &&
        createPortal(
          <div
            className="notification-panel"
            style={{ left: `${panel.left}px`, top: `${panel.top}px` }}
          >
            <div className="notification-panel-header">
              <span>Notifications</span>
              {unread > 0 && (
                <button type="button" className="btn-link" onClick={handleReadAll}>
                  Mark all read
                </button>
              )}
            </div>
            {data.notifications.length === 0 ? (
              <div className="notification-empty">No notifications</div>
            ) : (
              <ul className="notification-list">
                {data.notifications.map((n) => (
                  <li
                    key={n.id}
                    className={`notification-item${n.is_read ? "" : " unread"}`}
                    onClick={() => handleRead(n)}
                  >
                    <div className="notification-text">
                      <strong>{n.actor_name}</strong> {n.kind === "deleted" ? "deleted" : "updated"}{" "}
                      <strong>{n.document_title}</strong>
                      {n.kind === "updated" && n.version > 1 ? ` (v${n.version})` : ""}
                    </div>
                    <div className="notification-time">{timeAgo(n.created_at)}</div>
                  </li>
                ))}
              </ul>
            )}
          </div>,
          document.body
        )}
    </>
  );
}
