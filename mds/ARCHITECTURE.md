# Architecture

Role-based RAG over institute documents. Stack: FastAPI, LangGraph, PostgreSQL + pgvector, React 19 + Vite, NVIDIA API Catalog (LLM), LangSmith (tracing), Docker Compose.

## Core rule: access control

**Restricted content is never retrieved, so it never reaches the LLM.** It is not enforced through prompts.

- Each document has `allowed_roles`: `["student","faculty"]` or `["faculty"]`. It is copied onto every chunk.
- The only enforcement point is `backend/app/db/queries.py::search_chunks()`:
  `WHERE chunks.allowed_roles @> ARRAY[role]`. A GIN index keeps it fast.
- `role` always comes from the verified JWT (`app/auth/dependencies.py`), never from the request body.
- Students see student-tagged docs. Faculty see everything. Admin routes are faculty only.

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
- If the NVIDIA call fails, a fallback runs instead of an error: condense echoes the question, the classifier says "no", chart generation returns `{}`, and the answer becomes "model unavailable". When streaming, the fallback is skipped once tokens have already been sent.

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
- Uploading a title that already exists updates the row in place, bumps `version` and replaces its chunks. Version isn't shown in the UI.

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
| `POST/GET/PATCH/DELETE /admin/documents` | Document management (faculty) |

## Code map

```
backend/app/
  main.py, config.py, storage.py, tracing.py
  db/        pool.py, queries.py (all SQL + access control)
  auth/      email_rules.py, jwt.py, magic_link.py, mailer.py, dependencies.py
  ingestion/ parser.py, splitter.py, embedder.py, pipeline.py
  rag/       state.py, prompts.py, llm.py, chart_parser.py, nodes.py, graph.py, streaming.py
  api/       schemas.py, query.py, conversations.py, auth.py, admin_documents.py
backend/db/schema.sql          documents, chunks, conversations, messages, login_tokens
backend/scripts/               init_db.py, mint_dev_token.py, bulk_upload_docs.py
frontend/src/
  api/client.js
  auth/      useAuth.js, EmailLoginPage.jsx, VerifyPage.jsx
  chat/      ChatPage, Sidebar, AnswerBlock, ChartBlock, RoleBadge, SourceTag
  admin/     AdminPage, DocumentsTable, UploadForm
  styles/    theme.css, fonts.css    (ThemeContext.jsx = light/dark toggle)
```

## UI design

- Dark warm palette: background `#1A1918`, surface `#242322`, text `#EDEAE4`, muted `#9C9890`, accent `#C4703F` (used sparingly).
- Fonts: Inter for UI, Source Serif 4 for answers, JetBrains Mono for citations and filenames.
- A "Viewing as: Student/Faculty" badge always shows the current role.
- The admin panel is a plain utility table.
