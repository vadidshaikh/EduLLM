import { useEffect, useState } from "react";
import { ApiError, listReadableDocuments } from "../api/client";
import Icon from "../ui/Icons";
import { ShelfGroup, Spine } from "../ui/Shelf";
import { useDocViewer } from "../ui/useDocViewer";
import Loading from "../ui/Loading";

const VIEW_KEY = "edullm_student_docs_view";

function fileType(filename) {
  const ext = filename?.includes(".") ? filename.split(".").pop() : "";
  return ext ? ext.toLowerCase() : "file";
}

/**
 * A student's docs for what the switcher has picked, as books on shelves
 * (like the faculty Library) or as a list. "All my classes" gets one shelf
 * per classroom plus the institute's; one classroom, or the institute
 * docs, one shelf. Clicking a doc opens it: PDFs in the viewer, anything
 * else downloads.
 */
export default function StudentDocs({ token, shelves, active }) {
  const scope = shelves.option;
  const [view, setView] = useState(() => localStorage.getItem(VIEW_KEY) || "shelf");
  const [filter, setFilter] = useState("");
  const [groups, setGroups] = useState(null); // [{key, label, tone, docs}]
  const [error, setError] = useState("");
  const viewer = useDocViewer(token);

  // The shelves to show: each classroom and the institute's for "All",
  // otherwise just the picked one.
  const options = shelves.sections.flatMap((s) => s.options);
  const wanted = scope.kind === "all" ? options.filter((o) => o.kind === "class" || o.kind === "library") : [scope];
  const wantedKey = wanted.map((o) => o.searchId).join(",");

  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    Promise.all(
      wanted.map(async (o) => ({
        key: o.id,
        label: o.name,
        tone: o.color,
        docs: await listReadableDocuments(token, o.searchId),
      }))
    )
      .then((rows) => {
        if (cancelled) return;
        setGroups(rows);
        setError("");
      })
      .catch((err) => !cancelled && setError(err instanceof ApiError ? err.message : "Couldn't load the docs."));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `wanted` is keyed by wantedKey
  }, [token, wantedKey, active]);

  function chooseView(next) {
    localStorage.setItem(VIEW_KEY, next);
    setView(next);
  }

  const q = filter.trim().toLowerCase();
  const match = (d) => !q || d.title.toLowerCase().includes(q);
  // The list shows each doc once, even if it's on more than one shelf.
  const unique = groups ? [...new Map(groups.flatMap((g) => g.docs).map((d) => [d.id, d])).values()] : [];
  unique.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
  const listed = unique.filter(match);
  const shownError = error || viewer.error;

  return (
    <>
      <div className="lib-tools">
        <div className="seg" role="group" aria-label="View">
          <button aria-pressed={view === "shelf"} onClick={() => chooseView("shelf")}>
            Shelves
          </button>
          <button aria-pressed={view === "list"} onClick={() => chooseView("list")}>
            List
          </button>
        </div>
        <label className="search">
          <Icon name="search" />
          <span className="sr">Filter docs</span>
          <input placeholder="Filter by title" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </label>
        {groups && <span className="sd-count">{unique.length} doc{unique.length === 1 ? "" : "s"}</span>}
      </div>
      {shownError && <p className="form-error lib-note">{shownError}</p>}

      {groups === null && !error ? (
        <Loading label="Loading docs" />
      ) : unique.length === 0 && groups ? (
        <div className="table-wrap lib-gap">
          <div className="empty-state is-compact">
            <h3>No docs yet</h3>
            <p>
              When a teacher publishes a doc to {scope.kind === "class" ? "this classroom" : "your classrooms"}, it shows
              up here.
            </p>
          </div>
        </div>
      ) : view === "shelf" ? (
        <div className="lib-shelves">
          <div className="shelf-wrap">
            {groups
              .filter((g) => g.docs.length > 0)
              .map((g) => (
                <ShelfGroup key={g.key} label={g.label} tone={g.tone} count={g.docs.length}>
                  {g.docs.map((d) => (
                    <Spine key={d.id} as="button" doc={d} scale={1.05} dim={!match(d)} onClick={() => viewer.open(d)} />
                  ))}
                </ShelfGroup>
              ))}
          </div>
        </div>
      ) : (
        <div className="table-wrap lib-gap">
          <ul className="sd-list">
            {listed.length === 0 && <li className="sd-none">Nothing matches &ldquo;{filter.trim()}&rdquo;.</li>}
            {listed.map((d) => {
              const type = fileType(d.filename);
              return (
                <li key={d.id}>
                  <button type="button" className="sd-row" onClick={() => viewer.open(d)}>
                    <span className={`sd-type is-${type}`}>{type}</span>
                    <span className="sd-title">{d.title}</span>
                    <span className="sd-action">
                      <Icon name={type === "pdf" ? "books" : "download"} />
                      {type === "pdf" ? "Open" : "Download"}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {viewer.viewer}
    </>
  );
}
