import { useEffect, useState } from "react";
import Icon from "./Icons";
import Loading from "./Loading";

/**
 * Shows a PDF in a dialog inside the app (no new tab or browser pop-up).
 * `load()` returns a Promise of the file's Blob; it's called once, when the
 * viewer opens.
 */
export default function PdfViewer({ title, subtitle, load, onClose }) {
  const [url, setUrl] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let objectUrl = null;
    let cancelled = false;
    load()
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch((err) => !cancelled && setError(err?.message || "Couldn't open the PDF."));
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once per opening
  }, []);

  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <div className="scrim is-open pdf-scrim" onClick={onClose} />
      <div className="modal modal-pdf" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <div className="pdf-title">
            <h2>{title}</h2>
            {subtitle && <small className="note-sub">{subtitle}</small>}
          </div>
          <div className="pdf-actions">
            {url && (
              <a className="btn btn-ghost btn-sm" href={url} download={title}>
                <Icon name="download" /> Download
              </a>
            )}
            <button className="icon-btn" aria-label="Close" onClick={onClose}>
              <Icon name="x" />
            </button>
          </div>
        </div>
        <div className="pdf-frame">
          {error ? (
            <p className="form-error">{error}</p>
          ) : url ? (
            <iframe title={title} src={url} />
          ) : (
            <Loading label="Opening the PDF" />
          )}
        </div>
      </div>
    </>
  );
}
