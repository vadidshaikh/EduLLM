# Architecture

## System Overview

Edu LLM is a role-based RAG system built on FastAPI + LangGraph + PostgreSQL + pgvector + React, using NVIDIA-hosted models (via `langchain-nvidia-ai-endpoints`) for generation and LangSmith for tracing.

```
User (Institute Email)
  ↓ Magic-link login
Backend Auth
  ↓ Derives role/dept/year from email format
JWT Session Token
  ↓
Chat Message with Conversation ID
  ↓
LangGraph RAG Pipeline (streamed token-by-token to the client)
  ├─ load_history
  ├─ (first turn?) generate_title   ─┐
  ├─ (else) condense_query          ─┘→ both lead into retrieval
  ├─ retrieve_filtered (vector search, role-filtered)
  ├─ generate_answer (LLM call w/ history + context, streams tokens)
  ├─ should_chart (classifier: does answer need a chart?)
  ├─ generate_chart (if yes) + validate_chart_data
  ├─ respond (format sources)
  └─ save_messages (persist to DB)
  ↓
Response + Conversation Sidebar
```

Every conversation's turns are grouped into one LangSmith thread (`app/tracing.py`), and document ingestion runs are traced the same way, so both chat and ingestion pipelines are inspectable end-to-end in LangSmith when tracing is enabled.

## Phase 2: Multi-Turn & Memory

### Conversation Tables

```sql
conversations (id, user_email, title, is_pinned, created_at, updated_at)
messages (id, conversation_id FK, role, content, chart_config, sources, created_at)
login_tokens (token PK, email, expires_at, used)
```

**Why separate from chunks?** Conversations are user data, chunks are documents. Different retention policies, different schemas.

Conversations can be pinned (`is_pinned`), which sorts them above the rest of the sidebar (`ORDER BY is_pinned DESC, updated_at DESC`) regardless of recency.

### Multi-Turn Flow

1. User sends first message → creates new `conversation`
2. LangGraph runs: retrieval + generation, streaming tokens back as they're generated
3. Both turns (user + assistant) are saved to `messages`
4. Response includes `conversation_id` (client stores it)
5. Next message sends `conversation_id` + new query
6. `load_history` fetches last 10 messages (oldest → newest)
7. `condense_query` rewrites "what about X?" into a standalone search query using that context
8. Everything else uses the condensed query

### Editing a Message

The user can edit an earlier question from the chat UI. Editing re-sends the edited text as a new query, but first the client calls `DELETE /conversations/{id}/messages/{message_id}`, which deletes that message and everything sent after it (`delete_messages_from`, keyed on `created_at`) — the old answer (and any turns built on top of it) no longer apply once the question itself has changed.

### Auto-Generated Titles

Title generation is a node (`generate_title_node`) inside the main graph, not a separate background task. `load_history` routes to it only when history is empty (i.e. this is the conversation's first turn); every later turn routes to `condense_query` instead. Running it inline means the title generation call shows up inside the same LangSmith trace as the rest of that turn, and the client can just poll `GET /conversations` — no separate async job to coordinate.

## Streaming

`POST /query/stream` streams the answer back as newline-delimited JSON instead of waiting for the whole pipeline to finish:

```
{"type": "start", "conversation_id": "..."}
{"type": "token", "text": "..."}      × many
{"type": "done", "answer", "chart", "sources", "user_message_id", "assistant_message_id"}
{"type": "error", "message": "..."}   (instead of "done", on failure)
```

- `app/rag/streaming.py::run_query_stream` runs the *same compiled graph* as the non-streaming `/query` endpoint (`app/rag/graph.py`), so LangSmith still traces it as one real graph run rather than a hand-rolled chain.
- Token streaming happens inside `generate_answer_node`: it calls `stream_llm(...)` and pushes each chunk out via LangGraph's `get_stream_writer()` as a `"custom"` stream event. `graph.stream(..., stream_mode=["custom", "values"])` interleaves those custom token events with the final state.
- `get_stream_writer()` is a no-op when nothing is consuming `"custom"` events, so the exact same node function backs both `graph.invoke()` (plain `/query`) and `graph.stream()` (`/query/stream`) — no duplicated generation logic.
- The frontend (`api/client.js::queryLLMStream`) reads the fetch response body manually (not `EventSource`, which can't send the `Authorization` header this API needs) and dispatches each line to `onStart` / `onToken` / `onDone` / `onError` handlers that `ChatPage.jsx` uses to render tokens as they arrive and auto-scroll the message list.

## Access Control (The Core)

**Single enforcement point:** `app/db/queries.py::search_chunks()`

```python
def search_chunks(role: str, embedding: list[float], top_k: int):
    return conn.execute(
        """
        SELECT ... FROM chunks
        WHERE chunks.allowed_roles @> ARRAY[%s]::text[]
        ORDER BY c.embedding <=> %s
        LIMIT %s
        """,
        (role, Vector(embedding), top_k),
    ).fetchall()
```

**This is the entire ACL boundary.** A chunk not tagged for your role is never returned, never reaches the LLM, never appears in the answer.

### How It Works

1. **Admin uploads a document** and specifies `allowed_roles: ["student", "faculty"]` (or just one)
2. **Ingestion pipeline** creates chunks and copies `allowed_roles` to each
3. **Every query** calls `search_chunks(role=claims["role"], ...)` — role comes from the JWT, never user input
4. **Student role** only sees chunks tagged `["student"]` or `["student", "faculty"]`
5. **Faculty role** sees everything

### Why It's Safe

- **Role from JWT, not request body** — verified once per request in `app/auth/dependencies.py`
- **Filtering in SQL, before Python** — can't accidentally skip it with a prompt injection
- **Database constraint** — if someone resets the role somehow, the SQL WHERE clause still prevents access
- **Indexed** — `GIN index on chunks.allowed_roles` keeps it fast even with millions of chunks

---

## Email-Based Login (Phase 2)

### Email Format Rules (SCET)

- **Faculty:** `firstname.lastname@scet.ac.in` — local part has no digits
- **Student:** `name.co23d1@scet.ac.in` — local part's 2nd segment has digits
  - `co` = department
  - `23` = admission year
  - `d` = division
  - `1` = section/class

### Derivation Logic

```python
def parse_institute_email(email: str) -> dict:
    # 1. Validate domain
    if not email.endswith("@scet.ac.in"):
        raise EmailFormatError(...)
    
    # 2. Split local part
    parts = email.split(".")  # ["firstname", "lastname"] or ["name", "co23d1"]
    
    # 3. Check if 2nd segment has digits
    if any(ch.isdigit() for ch in parts[1]):
        # Student: parse dept/year/division/section
        return {"role": "student", "dept": "co", "year": "23", ...}
    else:
        # Faculty
        return {"role": "faculty"}
```

This avoids hardcoding department codes and works across SCET's many departments.

`DEV_FACULTY_EMAILS` (a comma-separated list in `.env`) lets specific non-institute addresses log in as faculty for local development/demos, bypassing the `@scet.ac.in` domain check entirely.

### Login Flow

1. **POST /auth/login** with email
2. Backend validates domain, derives role/dept
3. Generates a 15-minute `login_token` (single-use, in DB)
4. Sends magic link via Resend (or logs it if Resend not configured)
5. User clicks link → **POST /auth/verify** with token
6. Backend marks token used, re-derives role, issues session JWT
7. JWT includes: `sub`, `role`, `dept`, `year`, `division`, `exp`
8. All downstream logic unchanged — still expects a JWT with role claim

---

## LLM Provider (NVIDIA API Catalog)

`app/rag/llm.py` calls NVIDIA-hosted models via `ChatNVIDIA` (`langchain-nvidia-ai-endpoints`), converting the app's OpenAI-style `{role, content}` message dicts into LangChain message objects. Two entry points:

- `call_llm(messages, ...)` — blocking, returns the full text reply. Used for condensation, chart classification, chart generation, and title generation.
- `stream_llm(messages, ...)` — generator, yields text chunks as they arrive. Used only by `generate_answer_node` for the streamed answer.

**Deterministic fallback:** if the NVIDIA call raises (provider down, rate-limited, etc.), both functions fall back to `_fallback_reply()` instead of failing the request:
- Query condensation falls back to just echoing the raw new question.
- The chart classifier falls back to `"no"`.
- Chart generation falls back to `"{}"` (parses to no chart).
- The final answer falls back to a plain "model unavailable" message.

For `stream_llm`, the fallback only fires if no real tokens were yielded yet — once partial content has already reached the client, appending a fallback sentence would just garble the answer, so it's skipped.

---

## Chart Pipeline

Old approach: "Generate answer + decide whether to include a chart" in one prompt → LLM didn't self-police reliably.

New approach: Three separate steps.

### should_chart_node

Classifier-only prompt (low temperature):
- Input: question, answer text, retrieved context
- Output: "yes" or "no"
- Rule: Chart only if **explicit** request for stats/trend/comparison AND **numeric data present**

### generate_chart_node

Chart-generation-only prompt (low temperature):
- Input: question, answer, context
- Output: JSON object only (no prose, no fence)
- Formats chart as Chart.js structure

### validate_chart_data_node

Pure Python (no LLM):
- Extract all numbers from context chunks (regex + float parsing)
- Extract all numbers from chart's `datasets[].data`
- If any chart value missing from context: **drop entire chart** + log warning
- Never send fabricated numbers to the user

This is the "deterministic backstop" — even if the LLM hallucinates, the data validation catches it.

---

## LangGraph Flow

**Conditional edges** = routes depend on state:

```
START
  ↓
load_history
  ├─ history non-empty? → condense_query
  └─ empty (first turn)? → generate_title
  ↓                             ↓
  └─────────────┬───────────────┘
                ↓
        retrieve_filtered (uses condensed_query, or raw query on first turn)
                ↓
        generate_answer (streams tokens; history in context if present)
                ↓
        should_chart (classifier)
          ├─ yes? → generate_chart → validate_chart_data
          └─ no? → (skip)
                ↓
        respond (format sources + ensure chart key exists)
                ↓
        save_messages (persist user + assistant turns)
                ↓
        END
```

`generate_title` and `condense_query` are mutually exclusive per turn — the first turn has no history to condense (and needs a title), every later turn has history to condense (and already has a title). Both paths converge on `retrieve_filtered`.

The whole graph is compiled once at import time (`app/rag/graph.py::graph`) and reused by both `graph.invoke()` (`/query`) and `graph.stream()` (`/query/stream`) — see [Streaming](#streaming).

---

## Observability (LangSmith)

`app/tracing.py` provides two small helpers that make LangGraph/LangSmith tracing legible instead of a wall of identically-named runs:

- `conversation_trace_config(conversation_id)` → passed as `config=` to `graph.invoke`/`graph.stream`. Groups every turn of a conversation into one LangSmith thread (`thread_id`) and names each trace `chat-{conversation_id}` instead of the default `chat_turn` for every run.
- `document_trace_extra(document_id, title)` → passed as `langsmith_extra=` to `run_ingestion`. Names the ingestion run `ingest-{title}` and groups its stages (parse → split → embed → index) into one thread keyed on the document id.

Ingestion's embedding and indexing stages (`embed_texts`, `_index_chunks` in `app/ingestion/pipeline.py`) are wrapped in `@traceable` with custom `process_inputs`/`process_outputs` so LangSmith gets chunk counts and vector dimensions instead of the raw embedding floats or full chunk text.

Tracing is opt-in via `.env` (`LANGSMITH_TRACING`, `LANGSMITH_API_KEY`, `LANGSMITH_PROJECT`, `LANGSMITH_ENDPOINT`) — LangGraph/LangSmith pick these up automatically; nothing errors if they're unset, tracing is just a no-op.

---

## Document Ingestion & Versioning

### Progress Tracking

`documents.progress` (0–100) is updated at each ingestion stage so the admin UI can render a live progress bar instead of a static "processing" label:

| Stage | Progress |
|---|---|
| queued → processing starts | 5 |
| parse done | 15 |
| split done | 20 |
| embedding | 20 → 90, incrementally per batch (`on_progress` callback in `embed_texts`) |
| indexed | 100 |

`DocumentsTable.jsx::StatusCell` renders the bar while `status` is `queued` or `processing`, and falls back to a plain status pill once the document reaches `indexed` or `failed`.

### Re-upload / Versioning

Uploading a document whose `title` already exists doesn't create a duplicate row — `insert_document()` updates the existing row in place (new file, `status` reset to `queued`, `progress` reset to `0`) and increments `documents.version`. The column exists and is tracked server-side, but is not currently surfaced as a column in the admin UI table (only Title / Classified / Status / Uploaded / Actions are shown).

---

## Project Structure

```
backend/
  app/
    main.py                FastAPI app + logging config
    config.py               Settings (environment variables)
    storage.py               File upload helpers
    tracing.py                LangSmith trace-config helpers (conversations + ingestion)
    db/
      pool.py               Postgres connection pool
      queries.py            All SQL (read first for access control)
    auth/
      email_rules.py        Institute email format parsing + role derivation
      jwt.py                 JWT creation/verification
      magic_link.py          Magic-link token generation/validation
      mailer.py               Resend API sender (or console logger for dev)
      dependencies.py         FastAPI auth guards (@Depends)
    ingestion/
      parser.py              Docling (PDF/docx/md parser)
      splitter.py              RecursiveCharacterTextSplitter
      embedder.py               Sentence-Transformers wrapper (batched, reports progress)
      pipeline.py                Orchestrates: parse → split → embed → store (traced, progress-tracked)
    rag/
      state.py                LangGraph RAGState type
      prompts.py                System + classifier + chart-generation + title prompts
      llm.py                     ChatNVIDIA wrapper (call_llm + stream_llm, deterministic fallback)
      chart_parser.py             Extract & validate JSON from chart output
      nodes.py                     All graph node functions (load_history, condense_query, generate_title, etc.)
      graph.py                      Compiled LangGraph with conditional edges
      streaming.py                  Token-streaming wrapper around the same compiled graph
    api/
      schemas.py               Pydantic request/response models
      query.py                  POST /query, POST /query/stream (conversation + RAG)
      conversations.py           GET/DELETE /conversations, PATCH (rename/pin), DELETE .../messages/{id}
      auth.py                     POST /auth/login, /auth/verify
      admin_documents.py           POST/GET/PATCH/DELETE /admin/documents (traced ingestion kickoff)
  db/
    schema.sql                DDL: documents (+progress, +version), chunks, conversations (+is_pinned), messages, login_tokens
  scripts/
    init_db.py               Apply schema idempotently
    mint_dev_token.py         Generate test JWTs (still useful for curl)
  Dockerfile
  storage/                   (Volume: uploaded PDF/docx/md files)

frontend/
  src/
    App.jsx                  Main router
    main.jsx                 Entry point
    ThemeContext.jsx           Light/dark theme provider, persisted to localStorage
    api/
      client.js                HTTP wrapper + endpoint definitions (incl. streaming reader)
    auth/
      useAuth.js                Hook: token state + claims decoding
      EmailLoginPage.jsx          Email input → magic link request
      VerifyPage.jsx               Handles /auth/verify?token=... callback
    chat/
      ChatPage.jsx                Main UI: sidebar + streamed messages + edit/query input
      Sidebar.jsx                  Conversation history + pin/rename + navigation
      AnswerBlock.jsx               Renders assistant message + chart + sources
      ChartBlock.jsx                 Chart.js integration
      RoleBadge.jsx                  Shows current role (VIEWING AS: faculty)
      SourceTag.jsx                   Citation tags
    admin/
      AdminPage.jsx                Document upload + listing (faculty only)
      DocumentsTable.jsx             File management UI (progress bar, inline rename)
      UploadForm.jsx                  Upload form + role selector
    styles/
      theme.css                Dark/light theme (CSS variables)
      fonts.css                 Google Fonts
  vite.config.js             Vite configuration
  eslint.config.js            Linting rules
  package.json

docker-compose.yml         Services: postgres, backend, admin-ui (frontend container)
requirements.txt           Python dependencies (repo root, shared by backend + scripts)
.env                        Environment variables (committed with dev values)
.env.example                 Config template
README.md                   Quick start (this document)
STARTUP.md                   Setup instructions
ARCHITECTURE.md              This document
plan.md                      Original Phase 1 architecture spec
```

---

## Technologies

| Component | Tech | Why |
|-----------|------|-----|
| **Parser** | Docling | Accurate table extraction, multi-format support |
| **Chunks** | LangChain RecursiveCharacterTextSplitter | Respects semantics, overlaps context |
| **Embeddings** | Sentence-Transformers (multi-qa-mpnet) | Fast, good for QA, works offline |
| **Vector DB** | PostgreSQL + pgvector | Single database for everything, no ops overhead |
| **Orchestration** | LangGraph | Explicit flow, handles branching (history, chart decision), native token streaming |
| **LLM** | NVIDIA API Catalog via `ChatNVIDIA` (`langchain-nvidia-ai-endpoints`) | Hosted inference, streaming support, swappable model id via `LLM_MODEL` |
| **Observability** | LangSmith | Thread-grouped traces per conversation/document, opt-in via env vars |
| **Backend** | FastAPI | Fast, built-in validation, OpenAPI docs, native `StreamingResponse` |
| **Frontend** | React 19 + Vite | Fast iteration, component-based, reactive |
| **Deployment** | Docker Compose | Everything-in-one, reproducible |

---

## Deployment Notes

For production:
1. **Set real `JWT_SECRET`, `RESEND_*`, `NVIDIA_API_KEY` env vars** in `.env` or secrets manager
2. **Set `LLM_MODEL`** to the NVIDIA API Catalog model id you want to serve
3. **Configure Postgres** (hosted Postgres or managed DB)
4. **Use a real storage backend** instead of local `/backend/storage` (S3, GCS, etc.)
5. **Enable HTTPS** (reverse proxy with cert, or use Railway/Fly.io which does it for you)
6. **Turn on LangSmith tracing** (`LANGSMITH_TRACING=true` + `LANGSMITH_API_KEY`) for production observability, or point `LANGSMITH_ENDPOINT` at a self-hosted instance
7. **Don't set `DEV_FACULTY_EMAILS`** in production — it's a domain-check bypass meant for local dev/demos only

See `docker-compose.yml` for the local development setup — adapt each service's environment and ports for your infrastructure.
