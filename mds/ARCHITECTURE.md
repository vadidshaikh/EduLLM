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

## Slide decks (Phase 3)

`app/api/notes.py`, `app/authoring/` (`prompts.py`, `generate.py`, `render.py`).

- A deck belongs to a workspace (`notes` table, a historical name); any of its faculty can edit it. Only `kind = 'slides'`
  is created, listed or opened (`slides`: `[{title, bullets, notes}]`); older Markdown notes rows (`kind = 'notes'`,
  `body_md`) are ignored.
- **Sources** are some of the workspace's documents and the institute library's (indexed, up to 8), stored as
  `sources = [{doc_id, title, version}]`; `[n]` in the text cites the n-th.
- **Drafting** (`generate.py`) embeds the topic and takes the closest chunks *of each source*
  (`queries.search_source_chunks`, ~12 chunks in total, at least 2 per source). That query applies the same
  `scope_ids && <user's scope ids>` filter as `search_chunks`, so a draft can only use what its author can read.
  Drafts are streamed from the LLM and collected (a blocking call over a minute hits the client's read timeout), with up to
  8192 output tokens. If every key fails, the API returns 502 instead of saving the fallback sentence.
- **Stale**: `queries._with_source_status` compares each source's stored version with the document's current one (or notes it
  was removed). `POST /notes/{id}/redraft` returns a proposal only (the whole deck);
  the editor shows a line diff and nothing is saved until Save. `mark_up_to_date` records the current versions.
- **Revising**: `POST /notes/{id}/revise {slides, request}` applies a change asked for in words ("add a slide on paging",
  "remove slide 4") to the deck as it is in the editor. Also a proposal only, like a redraft.
- **Saving** is optimistic: `PATCH` carries the `updated_at` the editor loaded and gets 409 if someone saved since.
- **Publishing** uploads the deck through the normal path (`insert_document` + `run_ingestion`) as a `.pptx` (`render.deck_pptx`: title slide, slides with speaker notes, sources slide; built-in
  design, or the template at `PPT_TEMPLATE_PATH`). `notes.document_id` links them; republishing replaces that document by id
  (`insert_document(document_id=...)`), bumping its version and notifying its readers. A note can't be published under the
  title of another document in the workspace (409), since uploads with an existing title replace it.

## Question bank, quizzes and assignments (Phase 4)

`app/api/assessments.py`, `app/assessments/` (`prompts.py`, `generate.py`, `assign.py`).

- **Bank** (`questions`): per workspace; `subject`, `topic`, `type` (mcq/short/long), `difficulty` 1–3,
  `body {prompt, options}`, `answer {correct, explanation}`, `source_chunk_ids`, `embedding`, `status` draft/approved.
  Only approved questions are used. Any faculty member of the workspace can manage it.
- **Generating** (`generate.py`) reads source chunks through `queries.search_source_chunks` (same scope filter as
  notes), numbers each excerpt, and asks the model for JSON questions citing excerpt numbers (mapped back to chunk
  ids). The bank's recent prompts are listed in the prompt to steer away from repeats; then any draft whose text is
  within cosine 0.9 of a bank question or an earlier draft is dropped (`DUPLICATE_SIMILARITY`).
- **Choosing** (`assign.py`, plain Python, `random.Random(seed)`; the seed is stored on the assessment):
  - quotas per (topic, difficulty) are proportional to the pool, by largest remainder, so every set has the same mix;
  - **assignment**: one set for the class, from questions no assignment with the same `rule_key`
    (`lower(subject)|lower(term)`) uses. The partial unique index on `assessment_items (rule_key, question_id)
    WHERE kind = 'assignment'` enforces it in the database too;
  - **quiz**: one set per student; no two identical, and with `max_overlap` no two share more than that. Greedy,
    preferring least-used questions, with retries; when it fails it reports a pool size that would be enough;
  - question order and mcq option order are shuffled per set (`assessment_items.option_order`).
- `POST /classrooms/{id}/assessments/check` runs the same planning without saving; the dialog uses it to show whether
  the bank is big enough before Create.
- **Students** get only their own items (`student_email = me` or class-wide), only while in the (unarchived) classroom,
  with options in their order and **never** `answer`.

## Answering and results (Phase 5)

`submissions (assessment_id, student_email, answers, score, total, marked_by, file_path, file_name, file_size, submitted_at)`,
one row per student per assessment.

- **Quizzes** are answered in the app: `POST /my/assessments/{id}/submit` grades MCQs on the spot and saves once
  (409 if already submitted, 422 after the due date). `answers[].choice` is an index into the question's *original*
  options (not the shuffled order shown), so an edited question can be regraded. The student sees their picks and
  mark right away, and the correct answers and explanations only once the due date has passed (or straight away
  when there is none).
- **Assignments** are written and checked on paper; a submission only records that it was handed in (score/total null).
  Students upload a PDF (`POST /my/assessments/{id}/hand-in`, up to 20 MB, must start with `%PDF`, saved under
  `storage/handins`, replaces an earlier one; late is allowed and flagged). Faculty can tick off a paper copy
  (`PUT …/submissions/{email}`, `marked_by` = them) or undo it. Model answers are never shown to students.
- **Analytics** (`GET /classrooms/{id}/analytics`) is computed in Python from the classroom's assessments: turnout and
  average per assessment, each student's record (average, handed in, missed, late), accuracy per chapter (the source
  doc of each question) and the five hardest questions (answered at least twice). Quiz marks only.

## Ask composer shortcuts

- `@` + part of a name (`chat/ScopeMention.jsx`) picks a workspace, classroom or library to search, same as the switcher.
- `/` at the start of an empty message (faculty, `chat/SlashCommand.jsx`) lists commands instead of asking the chat:
  `/ppt` opens the new-deck dialog; `/quiz` (`quizzes/QuickQuizDialog.jsx`) writes MCQs from chosen docs, approves
  them into the workspace's bank and creates a classroom quiz from them, in one go.

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
| `GET /documents/{id}/file` | The original file, inline (PDFs open in the viewer), for anyone who can read it |
| `GET /workspaces/{id}/note-sources` | Docs a note there can be written from (the workspace's + institute library, indexed) |
| `GET/POST /workspaces/{id}/notes` | List decks (with stale status); create one, LLM-drafted unless `generate: false` |
| `GET/PATCH/DELETE /notes/{id}` | Open, save (409 if saved by someone else since; `mark_up_to_date`), delete |
| `POST /notes/{id}/redraft` | New draft of the whole deck from the sources' current versions; saves nothing |
| `POST /notes/{id}/revise` | Apply a change asked for in words to the deck in the editor; saves nothing |
| `POST /notes/{id}/publish`, `GET /notes/{id}/download` | Publish/republish as a workspace doc (`.pptx`); download the file |
| `GET/POST /workspaces/{id}/questions`, `PATCH/DELETE /questions/{id}` | Question bank: list, write one (409 if a near-duplicate), edit/approve, delete (409 if used) |
| `POST /workspaces/{id}/questions/generate`, `…/questions/status` | LLM drafts from sources (near-duplicates dropped); approve several at once |
| `GET/POST /classrooms/{id}/assessments`, `POST …/assessments/check` | A classroom's quizzes/assignments; create; dry run (enough questions?) |
| `GET/DELETE /assessments/{id}`, `POST /assessments/{id}/add-students` | Every set with answers; delete; sets for students who joined later |
| `GET /classrooms/{id}/analytics` | Class results: per assessment, per student, per chapter, hardest questions |
| `PUT/DELETE /assessments/{id}/submissions/{email}`, `GET …/file` | Tick off / undo a paper hand-in; view a handed-in PDF |
| `GET /my/assessments`, `GET /my/assessments/{id}` | Student: their quizzes/assignments and own questions (answers only after submitting and the due date) |
| `POST /my/assessments/{id}/submit` | Student: submit quiz answers (graded, once) |
| `POST/GET /my/assessments/{id}/hand-in` | Student: upload / view their assignment PDF |

## Code map

```
backend/app/
  main.py, config.py, storage.py, tracing.py
  db/        pool.py, queries.py (all SQL + access control)
  auth/      email_rules.py, jwt.py, magic_link.py, mailer.py, dependencies.py
  ingestion/ parser.py, splitter.py, embedder.py, pipeline.py
  rag/       state.py, prompts.py, llm.py, chart_parser.py, nodes.py, graph.py, streaming.py
  api/       schemas.py, query.py, conversations.py, auth.py, admin_documents.py, notifications.py,
             workspaces.py (workspaces, members, classrooms, /scopes), notes.py (notes and decks),
             assessments.py (question bank, quizzes, assignments)
  authoring/ prompts.py, generate.py (drafts from sources), render.py (Markdown / .pptx)
  assessments/ prompts.py, generate.py (questions from sources, de-duplication), assign.py (who gets which questions)
backend/db/schema.sql          documents, chunks, conversations, messages, login_tokens,
                               users, document_events, notifications, notification_reads,
                               workspaces, workspace_members, classrooms, classroom_members, notes,
                               questions, assessments, assessment_items, submissions
backend/scripts/               init_db.py, mint_dev_token.py, bulk_upload_docs.py,
                               seed_dev_data.py + seed_content.py (test data, see SEED_DATA.md)
frontend/src/
  App.jsx    signed-out routes, and the app shell (topbar + Ask / Library views; both stay mounted,
             the inactive one is hidden, so switching keeps state; ui/transition.js animates switches)
  api/client.js
  auth/      useAuth.js, EmailLoginPage (+ LoginLayout), VerifyPage
  shell/     useShelves.js (workspaces/classrooms, what Ask searches, which library is open),
             ScopeSwitcher (shelf switcher; join a classroom / new workspace), Notices (bell)
  chat/      ChatPage (Ask: shelf, thread, desk, composer), History, AnswerBlock, ChartBlock,
             ScopeMention (@ shelf picker), SlashCommand (/ppt, /quiz)
  library/   LibraryPage (shelves/list, needs attention, recent changes, tabs), DocumentDrawer,
             ClassroomsPanel, MembersPanel, NotesPanel (Slides tab), NewNoteDialog,
             NoteEditor (editor, redraft / revise + compare, publish), noteState.js, SourcePicker,
             LibrarySide, StudentDocs (student shelf / list of docs)
  quizzes/   QuizzesPanel (workspace "Quizzes" tab), QuestionBank, QuestionDialog, GenerateQuestionsDialog,
             AssessmentsPanel, NewAssessmentDialog, AssessmentView, ItemList, AnalyticsPanel, QuickQuizDialog (/quiz),
             MyAssessmentsPage (student view: docs, quizzes, assignments; take / hand in)
  ui/        Shelf.jsx (Spine, ShelfGroup, WsMark, SpineTooltip), spines.js, Icons.jsx, Logo.jsx,
             diff.js (line diff), PdfViewer + useDocViewer (open docs / hand-ins), ConfirmHost + confirm.js, Loading
  styles/    theme.css   (ThemeContext.jsx = light/dark toggle)
```

## UI design

"The Shelf", from `edullm-ui-reference.html` (styles only; the data comes from the API).

- Every document is a book spine. Its colour (one of six logo tones) and size are derived from its id and title
  (`ui/spines.js`), since documents have no category or page count. Indexing spines fill up; failed ones are red;
  a lock marks books students can't read (not published to a classroom / faculty only).
- Shelf switcher (top of the history sidebar on Ask, in the topbar on Library; Ask and Library are centred in the topbar): one choice that both views follow — the institute library, a workspace (faculty) or a
  classroom (student); nothing picked means "All". Ask searches only the pick (`scope_id`); Library shows that
  library. Switching between Ask and Library keeps the pick; "All" is chosen explicitly from the menu
  ("All my shelves" for faculty, which the Library shows as an overview of every library; "All my classes" for students). Faculty create shared workspaces from it (name required; other faculty and a first classroom
  optional); students join classrooms from it.
- Ask: with "All" or the institute library selected, the empty state is a decorative shelf of untitled books (students also get their
  classrooms as shortcuts). With one workspace or classroom selected it shows that shelf's real books (or the untitled shelf with a hint
  when it's empty)
  (`GET /documents` for students, the library listing for faculty). The desk on the right lists every doc the conversation used; hovering or clicking an answer highlights
  the docs that answer used (default: the latest answer). On narrow screens the desk is a strip above the thread.
- Library (faculty): shelves grouped by who can read them, each with an upload slot that sets that access;
  list view; a drawer per book (rename, access/publish, history, remove); a "Slides" tab for every
  workspace; Quizzes, classrooms and faculty tabs for shared workspaces.
- Library (students): their docs as shelves or a list (PDFs open in the viewer), and their quizzes and assignments.
- Fonts: Outfit (UI), Literata (answers), JetBrains Mono (join codes). Light and dark themes.
