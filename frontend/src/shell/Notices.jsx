import { useCallback, useEffect, useRef, useState } from "react";
import { listNotifications, markAllNotificationsRead, markNotificationRead } from "../api/client";
import Icon from "../ui/Icons";
import { Spine } from "../ui/Shelf";
import { timeAgo } from "../ui/spines";

// Notices are rare (a document update or delete), so a slow poll is enough.
const POLL_INTERVAL_MS = 60_000;

/**
 * Bell with an unread badge, opening the list of update/delete notices for
 * documents the user can read. Notices can be marked read but never removed.
 */
export default function Notices({ token }) {
  const [data, setData] = useState({ unread_count: 0, notifications: [] });
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

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
    if (!open) return undefined;
    function onDown(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    }
    function onKey(e) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function readOne(n) {
    if (n.is_read) return;
    await markNotificationRead(token, n.id).catch(() => {});
    refresh();
  }

  async function readAll() {
    await markAllNotificationsRead(token).catch(() => {});
    refresh();
  }

  const unread = data.unread_count;

  return (
    <div className="notices" ref={wrapRef}>
      <button
        className="icon-btn"
        aria-label={`Notices, ${unread} unread`}
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          if (!open) refresh();
        }}
      >
        <Icon name="bell" />
        {unread > 0 && <span className="badge-dot">{unread > 99 ? "99+" : unread}</span>}
      </button>
      {open && (
        <div className="pop">
          <div className="pop-head">
            <b>Notices</b>
            {unread > 0 && (
              <button className="link" type="button" onClick={readAll}>
                Mark all read
              </button>
            )}
          </div>
          <ul>
            {data.notifications.length === 0 ? (
              <li>
                <div>
                  Nothing new.
                  <small>You&apos;ll hear here when a doc you can read changes.</small>
                </div>
              </li>
            ) : (
              data.notifications.map((n) => (
                <li
                  key={n.id}
                  className={`notice${n.is_read ? "" : " unread"}`}
                  onClick={() => readOne(n)}
                >
                  <Spine doc={{ id: n.document_id, title: n.document_title }} small size={[8, 30]} />
                  <div>
                    {n.document_title}{" "}
                    {n.kind === "deleted"
                      ? "was removed"
                      : n.version > 1
                        ? `was updated (v${n.version})`
                        : "was updated"}
                    <small>
                      {n.actor_name}, {timeAgo(n.created_at)}
                    </small>
                  </div>
                </li>
              ))
            )}
          </ul>
          <p className="pop-foot">Notices about changed or removed documents stay here for everyone who could see them.</p>
        </div>
      )}
    </div>
  );
}
