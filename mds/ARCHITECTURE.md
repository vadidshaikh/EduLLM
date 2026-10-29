# Architecture

RAG over institute documents, with access scoped by workspaces and classrooms. Stack: FastAPI, LangGraph, PostgreSQL + pgvector, React 19 + Vite, NVIDIA API Catalog (LLM), LangSmith (tracing), Docker Compose.

## Core rule: access control

**Restricted content is never retrieved, so it never reaches the LLM.** It is not enforced through prompts.

- Each document has `scope_ids` (UUID[]), copied onto every chunk. A scope id is one of:
  - `INSTITUTE` (`…0001`): everyone. `ALL_FACULTY` (`…0002`): every faculty member.
  - a **workspace** id: that workspace's faculty members;
  - a **classroom** id: that classroom's students (only while it isn't archived).
- The only enforcement point is `backend/app/db/queries.py::search_chunks()`:
  `WHERE chunks.scope_ids && <user's scope ids>`. A GIN index keeps it fast.
- The user's scope ids come from `queries._user_scope_ids()`, read from the membership tables **on every request**
  (not the JWT), so adding/removing someone or archiving a classroom applies immediately.
  Workspace ids are only granted to the `faculty` role and classroom ids only to `student`.
- `role` and email always come from the verified JWT (`app/auth/dependencies.py`), never from the request body.
- `queries.list_readable_documents()` (`GET /documents`, the Ask page's shelf) uses the same scope check as
  `search_chunks` (`_readable_scopes`), so the shelf lists exactly the books the chat can answer from.
- The chat can pass `scope_id` to search one workspace/classroom. It is intersected with the user's scope ids,
  so it can only narrow access, never widen it. `scope_id = INSTITUTE` means the institute library: both
  institute-wide scopes the user holds (`ALL_FACULTY` too, for faculty).

### Where documents live

| Place | `workspace_id` | `visibility` | `scope_ids` | Managed by |
|---|---|---|---|---|
| Institute library | null | `institute` / `faculty` | `[INSTITUTE]` / `[ALL_FACULTY]` | any faculty |
| Personal workspace | its id | `workspace` | `[workspace]` | its owner |
| Shared workspace | its id | `workspace` | `[workspace]` | its owner and editors |
| Shared workspace, published | its id | `classrooms` | `[workspace, classroom…]` | its owner and editors |

- A faculty member's personal workspace is created on first login. Shared workspaces have an owner (adds/removes
  faculty, renames, deletes when empty) and editors. Only shared workspaces have classrooms.
- Students join a classroom with its 6-character join code, or faculty bulk-add them by email.
- Changing a document's access rewrites `scope_ids` on its chunks (no re-embedding). `replace_chunks` copies the
  document's *current* `scope_ids` under a row lock, so an access change during ingestion isn't lost.
- `search_chunks` turns on pgvector's `ivfflat.iterative_scan` so narrow scopes still get `TOP_K` results.

## Login (magic link)

Role is worked out from the email address:

- Must end in `@scet.ac.in`. Otherwise it is rejected, unless the address is listed in `DEV_FACULTY_EMAILS`.
- Second part of the local name has digits → **student** (`name.co23d1` = dept `co`, year `23`, division `d`, section `1`). No digits → **faculty**. Department codes are not hardcoded.

Flow:
1. `POST /auth/login {email}` creates a single-use token that lasts 15 minutes (`login_tokens`) and emails it through Resend, or logs it when Resend isn't set up.
2. `POST /auth/verify {token}` marks the token used and returns a session JWT (`sub, role, dept, year, division, exp`; lasts 7 days).

## Query pipeline (LangGraph)

```
load_history ─┬─ first turn → generate_title ─┐
              └─ later turn → condense_query ─┴→ retrieve_filtered
→ generate_answer (streams tokens) → should_chart ─┬─ yes → generate_chart → validate_chart_data
                                                    └─ no ─────────────────────────────┐
→ respond (format sources) → save_messages
```

- **load_history**: last 10 messages of the conversation.
- **condense_query**: rewrites a follow-up like "what about X?" into a standalone search query.
- **generate_title**: runs inside the graph on the first turn only. The sidebar picks the title up through `GET /conversations`.
- **Charts** use three separate steps, because a single prompt didn't reliably decide when to chart:
  - `should_chart`: a yes/no classifier. Charts only when the user explicitly asks for stats, a trend or a comparison **and** the context has numbers.
  - `generate_chart`: returns Chart.js JSON only.
  - `validate_chart_data`: plain Python. If any chart number is missing from the retrieved context, the whole chart is dropped.
- The graph is compiled once (`app/rag/graph.py`) and serves both `/query` (invoke) and `/query/stream` (stream).

### LLM (`app/rag/llm.py`)
- `call_llm` (blocking) handles condense, classify, chart and title. `stream_llm` handles the answer.
- Up to three NVIDIA keys (`NVIDIA_API_KEY`, `_2`, `_3`) are tried in order; blank keys are skipped. If every key fails, a fallback runs instead of an error: condense echoes the question, the classifier says "no", chart generation returns `{}`, and the answer becomes "model unavailable". When streaming, neither the next key nor the fallback is tried once tokens have already been sent.

### Streaming (`POST /query/stream`)
Returns newline-delimited JSON:
```
{"type":"start","conversation_id"}
{"type":"token","text"}            (many)
{"type":"done","answer","chart","sources","user_message_id","assistant_message_id"}
{"type":"error","message"}         (sent instead of done on failure)
```
`generate_answer` pushes tokens through LangGraph's `get_stream_writer()`, which does nothing during a plain invoke. The frontend (`api/client.js::queryLLMStream`) reads the response with fetch, not `EventSource`, because it has to send the `Authorization` header.

## Conversations

- Tables: `conversations (id, user_email, title, is_pinned, ...)` and `messages (conversation_id, role, content, chart_config, sources, ...)`.
- The first message (`conversation_id: null`) creates a conversation. The client then sends the returned id with each later message.
- Sidebar order: pinned first, then most recently updated. Conversations can be renamed, pinned and deleted.
- Editing a question calls `DELETE /conversations/{id}/messages/{message_id}`, which removes that message and everything after it, then sends the edited text again.

## Ingestion

Upload → save file → `documents` row (status `queued`) → background job: **parse** (Docling) → **split** (4000/800 chars) → **embed** (`multi-qa-mpnet-base-dot-v1`, 768-dim) → replace chunks → status `indexed` or `failed`.

- `documents.progress` (0–100) drives the admin progress bar: 5 at start, 15 after parse, 20 after split, 20→90 during embedding, 100 when indexed.
- Uploading a title that already exists in the same workspace (or the institute library) updates that row in place,
  bumps `version` and replaces its chunks. Version isn't shown in the UI.

## Tracing (LangSmith, optional)

`app/tracing.py`:
- Chat: each conversation is one thread, and traces are named `chat-{conversation_id}`.
- Ingestion: each document is one thread, and traces are named `ingest-{title}`. Embed and index steps log counts, not raw vectors.

## API

| Endpoint | Purpose |
|---|---|
| `POST /auth/login`, `/auth/verify` | Magic-link login |
| `POST /query`, `/query/stream` | Ask a question (`{conversation_id, query}`) |
| `GET /conversations`, `GET /conversations/{id}/messages` | Sidebar and history |
| `PATCH /conversations/{id}`, `DELETE /conversations/{id}` | Rename/pin, delete |
| `DELETE /conversations/{id}/messages/{message_id}` | Truncate for edit |
| `POST/GET/PATCH/DELETE /admin/documents` | Document management (faculty); `?workspace_id=` selects a workspace, omitted = institute library. Every write is audited |
| `GET /admin/document-events`, `GET /admin/documents/{id}/events` | Audit log for one workspace (or the library) / for one document, kept after delete |
| `GET /notifications`, `POST /notifications/{id}/read`, `/notifications/read-all` | Update/delete notices for documents the user could see (by scope ids), excluding their own actions; mark read, never delete |
| `GET/POST /workspaces`, `PATCH/DELETE /workspaces/{id}` | List (creates the personal one if missing), create shared, rename, delete when empty |
| `GET/POST /workspaces/{id}/members`, `DELETE …/members/{email}` | Faculty of a shared workspace; owner adds (invite email if never signed in) and removes; editors can leave |
| `GET/POST /workspaces/{id}/classrooms`, `PATCH /classrooms/{id}`, `POST /classrooms/{id}/join-code` | Classrooms: create, edit, archive/restore, new join code |
| `GET/POST /classrooms/{id}/students`, `DELETE …/students/{email}` | Roster; POST takes pasted emails/CSV |
| `GET /classrooms`, `POST /classrooms/join`, `DELETE /classrooms/{id}/membership` | Student: my classrooms, join by code, leave |
| `GET /scopes` | What the chat can be narrowed to (workspaces or classrooms) |
| `GET /documents?scope_id=` | Ready documents the caller can ask about (`id`, `title`), all or one workspace/classroom; any role |

## Code map

```
backend/app/
  main.py, config.py, storage.py, tracing.py
  db/        pool.py, queries.py (all SQL + access control)
  auth/      email_rules.py, jwt.py, magic_link.py, mailer.py, dependencies.py
  ingestion/ parser.py, splitter.py, embedder.py, pipeline.py
  rag/       state.py, prompts.py, llm.py, chart_parser.py, nodes.py, graph.py, streaming.py
  api/       schemas.py, query.py, conversations.py, auth.py, admin_documents.py, notifications.py,
             workspaces.py (workspaces, members, classrooms, /scopes)
backend/db/schema.sql          documents, chunks, conversations, messages, login_tokens,
                               users, document_events, notifications, notification_reads,
                               workspaces, workspace_members, classrooms, classroom_members
backend/scripts/               init_db.py, mint_dev_token.py, bulk_upload_docs.py
frontend/src/
  App.jsx    signed-out routes, and the app shell (topbar + Ask / Library views)
  api/client.js
  auth/      useAuth.js, EmailLoginPage (+ LoginLayout), VerifyPage
  shell/     useShelves.js (workspaces/classrooms, what Ask searches, which library is open),
             ScopeSwitcher (topbar switcher; join a classroom / new workspace), Notices (bell)
  chat/      ChatPage (Ask: shelf, thread, desk, composer), History, AnswerBlock, ChartBlock
  library/   LibraryPage (shelves/list, needs attention, recent changes, tabs), DocumentDrawer,
             ClassroomsPanel, MembersPanel
  ui/        Shelf.jsx (Spine, ShelfGroup, WsMark, SpineTooltip), spines.js, Icons.jsx, Logo.jsx
  styles/    theme.css   (ThemeContext.jsx = light/dark toggle)
```

## UI design

"The Shelf", from `edullm-ui-reference.html` (styles only; the data comes from the API).

- Every document is a book spine. Its colour (one of six logo tones) and size are derived from its id and title
  (`ui/spines.js`), since documents have no category or page count. Indexing spines fill up; failed ones are red;
  a lock marks books students can't read (not published to a classroom / faculty only).
- Topbar switcher: one choice that both views follow — the institute library, a workspace (faculty) or a
  classroom (student); nothing picked means "All". Ask searches only the pick (`scope_id`); Library shows that
  library. The Library tab always opens on an overview of every library (and clears the pick); faculty have no
  separate "All" menu entry, students do ("All my classes"). Faculty create shared workspaces from it (name required; other faculty and a first classroom
  optional); students join classrooms from it.
- Ask: with "All" or the institute library selected, the empty state is a decorative shelf of untitled books (students also get their
  classrooms as shortcuts). With one workspace or classroom selected it shows that shelf's real books (or the untitled shelf with a hint
  when it's empty)
  (`GET /documents` for students, the library listing for faculty). The desk on the right lists every doc the conversation used; hovering or clicking an answer highlights
  the docs that answer used (default: the latest answer). On narrow screens the desk is a strip above the thread.
- Library (faculty): shelves grouped by who can read them, each with an upload slot that sets that access;
  list view; a drawer per book (rename, access/publish, history, remove); classrooms and faculty tabs for shared
  workspaces.
- Fonts: Outfit (UI), Literata (answers), JetBrains Mono (join codes). Light and dark themes.
