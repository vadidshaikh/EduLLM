import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, listAllDocumentEvents, listClassrooms, listDocuments, uploadDocument } from "../api/client";
import Icon from "../ui/Icons";
import { ShelfGroup, Spine, WsMark } from "../ui/Shelf";
import { spineStatus, timeAgo } from "../ui/spines";
import { LIBRARY } from "../shell/useShelves";
import { smoothly } from "../ui/transition";
import ClassroomsPanel from "./ClassroomsPanel";
import DocumentDrawer from "./DocumentDrawer";
import MembersPanel from "./MembersPanel";
import NotesPanel from "./NotesPanel";
import QuizzesPanel from "../quizzes/QuizzesPanel";

const VIEW_KEY = "edullm_library_view";
const RECENT_LIMIT = 8;

/**
 * The shelves a place's books are grouped into. Each group says which
 * documents it holds and, where it makes sense, what an upload dropped on
 * its empty slot becomes (so access is always chosen explicitly).
 */
function shelfGroups(kind) {
  if (kind === "library") {
    return [
      { key: "everyone", label: "Everyone", tone: "var(--accent)", holds: (d) => d.visibility === "institute", upload: "institute" },
      { key: "faculty", label: "Faculty only", tone: "var(--muted)", holds: (d) => d.visibility === "faculty", upload: "faculty", locked: true },
    ];
  }
  if (kind === "personal") {
    return [{ key: "mine", label: "Only you", tone: "var(--tone-6)", holds: () => true, upload: "workspace" }];
  }
  return [
    { key: "published", label: "Published to classrooms", tone: "var(--accent)", holds: (d) => d.visibility === "classrooms" },
    { key: "unpublished", label: "Not published", tone: "var(--muted)", holds: (d) => d.visibility === "workspace", upload: "workspace", locked: true },
  ];
}

/**
 * Who can read a document, in a word or two.
 */
function accessText(doc, kind, classrooms) {
  if (kind === "library") return doc.visibility === "faculty" ? "Faculty only" : "Everyone";
  if (kind === "personal") return "Only you";
  if (!doc.classroom_ids.length) return "Faculty only";
  const names = new Map(classrooms.map((c) => [c.id, c.name]));
  return doc.classroom_ids.map((id) => names.get(id) ?? "Unknown classroom").join(", ");
}

/**
 * Faculty library for what's picked in the topbar switcher: with "All my
 * shelves", an overview of every library to pick from; otherwise that
 * library (the institute library or a workspace): its docs on shelves or in
 * a list, what needs attention, recent changes, and for shared workspaces
 * its classrooms and faculty.
 */
export default function LibraryPage({ auth, shelves, active = true, onNewWorkspace }) {
  const option = shelves.option;
  if (!shelves.loaded) {
    return (
      <main className="main">
        <section className="library">
          <p className="desk-empty">Fetching your library...</p>
        </section>
      </main>
    );
  }
  if (option.kind === "all") {
    return <Overview auth={auth} shelves={shelves} active={active} onNewWorkspace={onNewWorkspace} />;
  }
  // Remount per place so per-place state (tab, drawer, filter) starts fresh.
  return <Library key={option.id} auth={auth} shelves={shelves} option={option} active={active} />;
}

/**
 * "All my shelves" in the Library: one card per library (institute,
 * personal, each shared workspace) with its doc count, plus a card to
 * create a shared workspace. Picking a card selects it in the switcher.
 */
function Overview({ auth, shelves, active, onNewWorkspace }) {
  const places = shelves.sections.flatMap((s) => s.options).filter((o) => o.kind !== "all");
  const placesKey = places.map((o) => o.id).join(",");
  const [counts, setCounts] = useState({});

  // Refetched (without blanking) each time the Library is shown again.
  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    Promise.all(
      places.map((o) =>
        listDocuments(auth.token, o.id === LIBRARY ? null : o.id)
          .then((docs) => [o.id, docs.length])
          .catch(() => [o.id, null])
      )
    ).then((pairs) => !cancelled && setCounts(Object.fromEntries(pairs)));
    return () => {
      cancelled = true;
    };
    // placesKey stands in for `places` (a new array each render)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.token, placesKey, active]);

  return (
    <main className="main">
      <section className="library">
        <div className="lib-inner">
          <div className="lib-head">
            <div>
              <h1>Your libraries</h1>
              <p>Pick one to manage its docs. Questions on Ask follow the same choice; with none picked, Ask searches all of them.</p>
            </div>
          </div>
          <div className="place-cards">
            {places.map((o) => (
              <button key={o.id} className="place-card" onClick={() => shelves.setScope(o.id)}>
                <WsMark kind={o.kind} color={o.color} />
                <span>
                  <b>{o.name}</b>
                  <small>{o.sub}</small>
                </span>
                <span className="place-count">
                  <b>{counts[o.id] ?? "–"}</b>
                  <small>{counts[o.id] === 1 ? "doc" : "docs"}</small>
                </span>
              </button>
            ))}
            <button className="place-card place-new" onClick={onNewWorkspace}>
              <span className="place-new-icon">
                <Icon name="plus" />
              </span>
              <span>
                <b>New shared workspace</b>
                <small>Optionally with other faculty and a classroom for your students</small>
              </span>
            </button>
          </div>
        </div>
      </section>
    </main>
  );
}

function Library({ auth, shelves, option, active }) {
  const workspace = option.workspace ?? null;
  const placeId = option.id === LIBRARY ? null : option.id;
  const kind = option.id === LIBRARY ? "library" : workspace.kind;
  const [section, setSection] = useState("books");
  const [view, setView] = useState(() => localStorage.getItem(VIEW_KEY) || "shelf");
  // Who a list-view upload is readable by (the shelf view uses each shelf's slot instead).
  const [listUpload, setListUpload] = useState(kind === "library" ? "faculty" : "workspace");
  const [filter, setFilter] = useState("");
  const [documents, setDocuments] = useState(null);
  const [classrooms, setClassrooms] = useState([]);
  const [events, setEvents] = useState([]);
  const [error, setError] = useState("");
  const [uploadNote, setUploadNote] = useState("");
  const [openDocId, setOpenDocId] = useState(null);
  const fileRef = useRef(null);
  const pendingUpload = useRef(null); // visibility for the next file pick

  const refresh = useCallback(async () => {
    try {
      const [docs, evts] = await Promise.all([
        listDocuments(auth.token, placeId),
        listAllDocumentEvents(auth.token, placeId),
      ]);
      setDocuments(docs);
      setEvents(evts);
      setError("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load the library.");
    }
  }, [auth.token, placeId]);

  const refreshClassrooms = useCallback(async () => {
    if (kind !== "shared") return;
    try {
      setClassrooms(await listClassrooms(auth.token, placeId));
    } catch {
      // publishing just shows no classrooms
    }
  }, [auth.token, placeId, kind]);

  // On mount, and again (quietly, keeping what's shown) whenever the
  // Library is switched back to, since it stays mounted while hidden.
  useEffect(() => {
    if (!active) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- standard fetch-on-mount
    refresh();
    refreshClassrooms();
  }, [refresh, refreshClassrooms, active]);

  // Poll while anything is still being indexed, so spines fill up on their own.
  useEffect(() => {
    const busy = documents?.some((d) => spineStatus(d) === "indexing");
    if (!busy || !active) return undefined;
    const id = setInterval(refresh, 2000);
    return () => clearInterval(id);
  }, [documents, refresh, active]);

  function chooseView(next) {
    localStorage.setItem(VIEW_KEY, next);
    setView(next);
  }

  function pickFiles(visibility) {
    pendingUpload.current = visibility;
    fileRef.current?.click();
  }

  /**
   * Uploads files one by one, each titled from its filename, with the access
   * of the shelf they were added to.
   */
  async function upload(files, visibility) {
    if (!files.length) return;
    setError("");
    for (let i = 0; i < files.length; i += 1) {
      const file = files[i];
      setUploadNote(files.length > 1 ? `Uploading ${i + 1} of ${files.length}: ${file.name}` : `Uploading ${file.name}`);
      try {
        await uploadDocument(auth.token, {
          file,
          title: file.name.replace(/\.[^/.]+$/, "") || file.name,
          workspaceId: placeId,
          visibility,
        });
      } catch (err) {
        setError(`${file.name}: ${err instanceof ApiError ? err.message : "upload failed."}`);
      }
      await refresh();
    }
    setUploadNote("");
  }

  const docs = documents ?? [];
  // The institute library is managed as a plain list; shelves are for workspaces.
  const canShelf = kind !== "library";
  const shownView = canShelf ? view : "list";
  const groups = shelfGroups(kind);
  const match = (d) => !filter.trim() || d.title.toLowerCase().includes(filter.trim().toLowerCase());
  const counts = {
    books: docs.length,
    published: docs.filter((d) => d.visibility === "classrooms").length,
    busy: docs.filter((d) => spineStatus(d) === "indexing").length,
    bad: docs.filter((d) => spineStatus(d) === "failed").length,
  };
  const activeClassrooms = classrooms.filter((c) => !c.archived_at);
  const openDoc = docs.find((d) => d.id === openDocId) ?? null;
  const place = {
    kind,
    name: option.name,
    classrooms,
    memberCount: workspace?.member_count ?? 0,
  };

  const title = kind === "library" ? "Institute library" : kind === "personal" ? "My library" : `${workspace.name} library`;
  const sub =
    kind === "library"
      ? "Institute-wide documents. Every faculty member can manage them; docs marked “Everyone” are readable by students too."
      : kind === "personal"
        ? "Only you can see these. Upload to a shared workspace to publish a doc to a classroom."
        : activeClassrooms.length
          ? `Shared with ${workspace.member_count} faculty. Publish docs to ${activeClassrooms.map((c) => c.name).join(" or ")} so students can ask about them.`
          : `Shared with ${workspace.member_count} faculty. Create a classroom to publish docs to students.`;

  return (
    <main className="main">
      <section className="library">
        <div className="lib-inner">
          <div className="lib-head">
            <div>
              <h1>{title}</h1>
              <p>{sub}</p>
            </div>
            {section === "books" && (
              <div className="counts">
                <div>
                  <b>{counts.books}</b>
                  <span>{counts.books === 1 ? "doc" : "docs"}</span>
                </div>
                {kind === "shared" && (
                  <div>
                    <b>{counts.published}</b>
                    <span>published</span>
                  </div>
                )}
                <div className="busy">
                  <b>{counts.busy}</b>
                  <span>indexing</span>
                </div>
                {counts.bad > 0 && (
                  <div className="bad">
                    <b>{counts.bad}</b>
                    <span>failed</span>
                  </div>
                )}
              </div>
            )}
          </div>

          {kind !== "library" && (
            <nav className="nav lib-tabs" aria-label="Workspace">
              {[
                ["books", "Docs"],
                ["notes", "Notes & slides"],
                ...(kind === "shared"
                  ? [
                      ["quizzes", "Quizzes"],
                      ["classrooms", "Classrooms"],
                      ["faculty", "Faculty"],
                    ]
                  : []),
              ].map(([id, label]) => (
                <button key={id} aria-current={section === id ? "page" : undefined} onClick={() => id !== section && smoothly(() => setSection(id))}>
                  {label}
                </button>
              ))}
            </nav>
          )}

          {section === "books" && (
            <>
              <div className="lib-tools">
                {canShelf && (
                  <div className="seg" role="group" aria-label="View">
                    <button aria-pressed={view === "shelf"} onClick={() => chooseView("shelf")}>
                      Shelves
                    </button>
                    <button aria-pressed={view === "list"} onClick={() => chooseView("list")}>
                      List
                    </button>
                  </div>
                )}
                <label className="search">
                  <Icon name="search" />
                  <span className="sr">Filter documents</span>
                  <input placeholder="Filter by title" value={filter} onChange={(e) => setFilter(e.target.value)} />
                </label>
                {shownView === "list" ? (
                  <div className="list-upload">
                    {kind === "library" && (
                      <select
                        className="input"
                        aria-label="Who can read uploaded docs"
                        value={listUpload}
                        onChange={(e) => setListUpload(e.target.value)}
                      >
                        <option value="faculty">Faculty only</option>
                        <option value="institute">Everyone (students too)</option>
                      </select>
                    )}
                    <button
                      className="btn"
                      title={
                        kind === "shared"
                          ? "Uploads as not published; publish to classrooms from the doc's drawer"
                          : "Upload docs, or drop files on the list"
                      }
                      onClick={() => pickFiles(listUpload)}
                    >
                      <Icon name="upload" /> Upload docs
                    </button>
                  </div>
                ) : (
                <div className="legend">
                  <span>
                    <i style={{ background: "transparent", boxShadow: "inset 0 0 0 2px var(--accent)" }} />
                    Indexing
                  </span>
                  <span>
                    <i style={{ background: "var(--danger)" }} />
                    Failed
                  </span>
                  {kind !== "personal" && (
                    <span>
                      <Icon name="lock" className="legend-lock" />
                      Not published to a classroom
                    </span>
                  )}
                </div>
                )}
              </div>
              {uploadNote && <p className="form-note lib-note">{uploadNote}</p>}
              {error && <p className="form-error lib-note">{error}</p>}

              {documents === null && !error ? (
                <p className="desk-empty">Loading docs...</p>
              ) : shownView === "shelf" ? (
                <div className="lib-shelves">
                  <div className="shelf-wrap">
                    {groups.map((g) => {
                      const held = docs.filter(g.holds);
                      if (!held.length && !g.upload) return null;
                      return (
                        <ShelfGroup key={g.key} label={g.label} tone={g.tone} count={held.length}>
                          {held.map((d) => (
                            <Spine
                              key={d.id}
                              as="button"
                              doc={d}
                              scale={1.05}
                              locked={Boolean(g.locked)}
                              dim={!match(d)}
                              onClick={() => setOpenDocId(d.id)}
                            />
                          ))}
                          {g.upload && <UploadSlot label={g.label} onPick={() => pickFiles(g.upload)} onDrop={(files) => upload(files, g.upload)} />}
                        </ShelfGroup>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <DocumentList
                  docs={docs.filter(match)}
                  total={docs.length}
                  filter={filter.trim()}
                  onClearFilter={() => setFilter("")}
                  kind={kind}
                  placeName={option.name}
                  classrooms={classrooms}
                  onOpen={setOpenDocId}
                  onDrop={(files) => upload(files, listUpload)}
                />
              )}

              <div className="lib-lower">
                <NeedsAttention docs={docs} onOpen={setOpenDocId} />
                <RecentChanges events={events} docs={docs} onOpen={setOpenDocId} />
              </div>
              <input
                ref={fileRef}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  upload(Array.from(e.target.files ?? []), pendingUpload.current);
                  e.target.value = "";
                }}
              />
            </>
          )}

          {section === "notes" && (
            <NotesPanel token={auth.token} workspace={workspace} classrooms={classrooms} onDocsChanged={refresh} />
          )}

          {section === "quizzes" && <QuizzesPanel token={auth.token} workspace={workspace} classrooms={classrooms} />}

          {section === "classrooms" && (
            <ClassroomsPanel
              token={auth.token}
              workspaceId={placeId}
              classrooms={classrooms}
              onChanged={() => {
                refreshClassrooms();
                shelves.reload();
              }}
            />
          )}

          {section === "faculty" && (
            <MembersPanel
              token={auth.token}
              workspace={workspace}
              me={auth.sub}
              onChanged={shelves.reload}
              onGone={async () => {
                await shelves.reload();
                shelves.setScope(null);
              }}
            />
          )}
        </div>
      </section>

      {openDoc && (
        <DocumentDrawer
          token={auth.token}
          doc={openDoc}
          place={place}
          onClose={() => setOpenDocId(null)}
          onChanged={refresh}
          onRemoved={() => {
            setOpenDocId(null);
            refresh();
          }}
        />
      )}
    </main>
  );
}

/**
 * The empty slot at the end of a shelf: click to pick files, or drop them on it.
 */
function UploadSlot({ label, onPick, onDrop }) {
  const [over, setOver] = useState(false);
  return (
    <button
      className={`slot${over ? " is-over" : ""}`}
      type="button"
      data-tip={`Drop files here, or click to add to “${label}”`}
      aria-label={`Add files to ${label}`}
      onClick={onPick}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        onDrop(Array.from(e.dataTransfer.files));
      }}
    >
      <Icon name="upload" />
    </button>
  );
}

/**
 * The list view: one row per doc; click to open it. Files dropped on it are uploaded.
 */
function DocumentList({ docs, total, filter, onClearFilter, kind, placeName, classrooms, onOpen, onDrop }) {
  const [over, setOver] = useState(false);
  const empty = docs.length === 0;
  return (
    <div
      className={`table-wrap${over ? " is-over" : ""}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        onDrop(Array.from(e.dataTransfer.files));
      }}
    >
      {empty && total === 0 && <EmptyLibrary kind={kind} placeName={placeName} />}
      {empty && total > 0 && (
        <div className="empty-state is-compact">
          <h3>No docs match “{filter}”</h3>
          <p>Try another part of the title.</p>
          <button className="btn btn-ghost" onClick={onClearFilter}>
            Clear filter
          </button>
        </div>
      )}
      {!empty && (
      <table className="docs">
        <thead>
          <tr>
            <th>Title</th>
            <th>{kind === "shared" ? "Published to" : "Who can read it"}</th>
            <th>Status</th>
            <th>Added</th>
            <th>By</th>
          </tr>
        </thead>
        <tbody>
          {docs.map((d) => {
            const status = spineStatus(d);
            return (
              <tr key={d.id} tabIndex={0} onClick={() => onOpen(d.id)} onKeyDown={(e) => e.key === "Enter" && onOpen(d.id)}>
                <td>
                  <span className="t-title">
                    <Spine doc={{ ...d, status: "indexed" }} small size={[8, 26]} />
                    {d.title}
                  </span>
                </td>
                <td className={d.visibility === "classrooms" || d.visibility === "institute" ? "" : "who"}>
                  {accessText(d, kind, classrooms)}
                </td>
                <td>
                  {status === "indexing" ? (
                    <span className="state busy">Indexing {d.progress ?? 0}%</span>
                  ) : status === "failed" ? (
                    <span className="state bad">Failed</span>
                  ) : (
                    <span className="state ok">Ready</span>
                  )}
                </td>
                <td>{new Date(d.uploaded_at).toLocaleDateString(undefined, { day: "numeric", month: "short" })}</td>
                <td className="who" title={d.uploaded_by}>
                  {d.uploaded_by_name || d.uploaded_by}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      )}
    </div>
  );
}

const EMPTY_TEXT = {
  library: {
    title: "The institute library is empty",
    body: "Add circulars, calendars and reports for the whole institute. Pick who can read them first: faculty only, or everyone including students.",
  },
  personal: {
    title: "Your workspace is empty",
    body: "Keep your own notes and papers here. Only you can see them, and you can ask about them from Ask.",
  },
  shared: {
    title: (name) => `Nothing in ${name} yet`,
    body: "Add docs for the faculty here, then publish them to a classroom so students can ask about them too.",
  },
};

/**
 * What an empty library shows instead of an empty table: a few untitled
 * books on a plank (one leaning, like the logo), a line about what goes
 * here, and a pointer to the Upload docs button above (or dropping files).
 */
function EmptyLibrary({ kind, placeName }) {
  const text = EMPTY_TEXT[kind];
  const title = typeof text.title === "function" ? text.title(placeName) : text.title;
  return (
    <div className="empty-state">
      <div className="empty-shelf" aria-hidden="true">
        <div className="empty-books">
          {[[22, 92], [18, 78], [26, 104], [20, 86], [16, 70]].map(([w, h], i) => (
            <Spine key={i} doc={{ id: `empty-${kind}-${i}`, title: "" }} blank size={[w, h]} />
          ))}
        </div>
        <div className="plank" />
      </div>
      <h3>{title}</h3>
      <p>{text.body}</p>
      <p className="empty-hint">Use Upload docs above, or drop files here.</p>
    </div>
  );
}

/**
 * Books that are still indexing or failed to index.
 */
function NeedsAttention({ docs, onOpen }) {
  const items = docs.filter((d) => spineStatus(d));
  return (
    <section className="panel" aria-labelledby="attn-h">
      <h2 id="attn-h">Needs attention</h2>
      <ul className="attn">
        {items.length === 0 ? (
          <li>
            <div>
              <b>All docs are ready</b>
              <small>Everything here can be used in answers.</small>
            </div>
          </li>
        ) : (
          items.map((d) =>
            spineStatus(d) === "failed" ? (
              <li key={d.id}>
                <Spine doc={d} small size={[10, 34]} />
                <div>
                  <b>{d.title}</b>
                  <small>Couldn&apos;t read any text. It may be a scanned PDF; upload a text-based copy.</small>
                </div>
                <button className="btn btn-ghost" onClick={() => onOpen(d.id)}>
                  Details
                </button>
              </li>
            ) : (
              <li key={d.id}>
                <Spine doc={d} small size={[10, 34]} />
                <div>
                  <b>{d.title}</b>
                  <small>
                    {d.status === "queued" ? "Waiting to be indexed" : `Indexing, ${d.progress ?? 0}% done`}
                  </small>
                  <div className="bar">
                    <i style={{ width: `${d.progress ?? 0}%` }} />
                  </div>
                </div>
              </li>
            )
          )
        )}
      </ul>
    </section>
  );
}

const EVENT_ICON = { uploaded: ["up", "upload"], updated: ["ed", "pen"], deleted: ["rm", "x"] };
const EVENT_TEXT = { uploaded: "added", updated: "updated", deleted: "removed" };

/**
 * The latest audit events for this place, including removed books.
 */
function RecentChanges({ events, docs, onOpen }) {
  const live = new Set(docs.map((d) => d.id));
  const recent = events.slice(0, RECENT_LIMIT);
  return (
    <section className="panel" aria-labelledby="log-h">
      <h2 id="log-h">Recent changes</h2>
      <ul className="log">
        {recent.length === 0 ? (
          <li>
            <span />
            <span className="who">Nothing has changed here yet.</span>
            <span />
          </li>
        ) : (
          recent.map((e) => {
            const [cls, icon] = EVENT_ICON[e.action] ?? ["ed", "pen"];
            return (
              <li key={e.id}>
                <span className={`act ${cls}`}>
                  <Icon name={icon} />
                </span>
                <span>
                  {live.has(e.document_id) ? (
                    <button className="log-title" onClick={() => onOpen(e.document_id)}>
                      {e.document_title}
                    </button>
                  ) : (
                    <b>{e.document_title}</b>
                  )}{" "}
                  {EVENT_TEXT[e.action] ?? e.action}
                  {e.action === "updated" && e.version > 1 ? ` (v${e.version})` : ""}{" "}
                  <span className="who" title={e.actor_email}>
                    by {e.actor_name}
                  </span>
                </span>
                <time dateTime={e.created_at}>{timeAgo(e.created_at)}</time>
              </li>
            );
          })
        )}
      </ul>
    </section>
  );
}
