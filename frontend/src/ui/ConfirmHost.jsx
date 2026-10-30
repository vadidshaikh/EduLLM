import { useEffect, useRef, useState } from "react";
import { setConfirmHandler } from "./confirm";
import Icon from "./Icons";

/**
 * Renders confirmDialog's requests, one at a time. Mount once.
 */
export default function ConfirmHost() {
  const [request, setRequest] = useState(null);
  const confirmRef = useRef(null);

  useEffect(() => {
    setConfirmHandler((next) =>
      setRequest((current) => {
        current?.resolve(false); // a newer question replaces an unanswered one
        return next;
      })
    );
    return () => setConfirmHandler(null);
  }, []);

  useEffect(() => {
    if (!request) return undefined;
    confirmRef.current?.focus();
    function onKey(e) {
      if (e.key === "Escape") {
        e.stopPropagation(); // don't also close a dialog underneath
        answer(false);
      }
    }
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  });

  function answer(value) {
    request.resolve(value);
    setRequest(null);
  }

  if (!request) return null;
  return (
    <>
      <div className="scrim is-open confirm-scrim" onClick={() => answer(false)} />
      <div
        className={`modal confirm${request.danger ? " is-danger" : ""}`}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby={request.message ? "confirm-message" : undefined}
      >
        <div className="confirm-body">
          <span className="confirm-icon" aria-hidden="true">
            <Icon name={request.danger ? "trash" : "check"} />
          </span>
          <div>
            <h2 id="confirm-title">{request.title}</h2>
            {request.message && <p id="confirm-message">{request.message}</p>}
          </div>
        </div>
        <div className="modal-foot confirm-foot">
          <button className="btn btn-ghost" onClick={() => answer(false)}>
            {request.cancelLabel}
          </button>
          <button
            ref={confirmRef}
            className={`btn${request.danger ? " btn-danger-solid" : ""}`}
            onClick={() => answer(true)}
          >
            {request.confirmLabel}
          </button>
        </div>
      </div>
    </>
  );
}
