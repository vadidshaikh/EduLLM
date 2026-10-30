import { useEffect, useState } from "react";
import { ApiError, getDocumentFile } from "../api/client";
import PdfViewer from "./PdfViewer";

const EXTENSIONS = {
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "text/markdown": ".md",
  "text/plain": ".txt",
};

/**
 * Opening a document's original file: PDFs in the in-app viewer, anything
 * else (.pptx, .docx, ...) as a download. `open(doc)` takes {id, title} or
 * {doc_id, title}, plus `filename` when known; render `viewer` somewhere on
 * the page; `error` is the last failure, if any.
 */
export function useDocViewer(token) {
  const [shown, setShown] = useState(null); // {title, load}
  const [error, setError] = useState("");

  // A failed open shows briefly, then clears.
  useEffect(() => {
    if (!error) return undefined;
    const id = setTimeout(() => setError(""), 5000);
    return () => clearTimeout(id);
  }, [error]);

  async function open(doc) {
    const id = doc.id ?? doc.doc_id;
    setError("");
    // Known to be a PDF: open the viewer straight away and let it load.
    if (doc.filename?.toLowerCase().endsWith(".pdf")) {
      setShown({ title: doc.title, load: () => getDocumentFile(token, id) });
      return;
    }
    try {
      const blob = await getDocumentFile(token, id);
      if (blob.type === "application/pdf") {
        setShown({ title: doc.title, load: () => Promise.resolve(blob) });
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = doc.filename || `${doc.title}${EXTENSIONS[blob.type.split(";")[0]] ?? ""}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't open that doc.");
    }
  }

  const viewer = shown && <PdfViewer title={shown.title} load={shown.load} onClose={() => setShown(null)} />;
  return { open, viewer, error, isOpen: Boolean(shown) };
}
