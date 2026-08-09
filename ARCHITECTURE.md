# Architecture

## System Overview

Edu LLM is a role-based RAG system built on FastAPI + LangGraph + PostgreSQL + pgvector + React.

```
User (Institute Email)
  ↓ Magic-link login
Backend Auth
  ↓ Derives role/dept/year from email format
JWT Session Token
  ↓
Chat Message with Conversation ID
  ↓
LangGraph RAG Pipeline
  ├─ verify_token
  ├─ resolve_role
  ├─ load_history (if not first message)
  ├─ condense_query (rewrite follow-up with context)
  ├─ retrieve_filtered (vector search, role-filtered)
  ├─ generate_answer (LLM call with history + context)
  ├─ should_chart (classifier: does answer need a chart?)
  ├─ generate_chart (if yes) + validate_chart_data
  ├─ respond (format sources)
  └─ save_messages (persist to DB)
  ↓
Response + Conversation Sidebar
```

## Phase 2: Multi-Turn & Memory

### Conversation Tables

```sql
conversations (id, user_email, title, created_at, updated_at)
messages (id, conversation_id FK, role, content, chart_config, sources, created_at)
login_tokens (token PK, email, expires_at, used)
```

**Why separate from chunks?** Conversations are user data, chunks are documents. Different retention policies, different schemas.

### Multi-Turn Flow

1. User sends first message → creates new `conversation`
2. LangGraph runs: retrieval + generation
3. Both turns (user + assistant) are saved to `messages`
4. Response includes `conversation_id` (client stores it)
5. Next message sends `conversation_id` + new query
6. `load_history` fetches last 10 messages (oldest → newest)
7. `condense_query` rewrites "what about X?" into a standalone search query using that context
8. Everything else uses the condensed query

### Auto-Generated Titles

After the first response is sent:
- `BackgroundTasks.add_task()` triggers title generation *asynchronously*
- Tiny LangGraph runs: `generate_title_node` only
- Calls `update_conversation_title()` when done
- Sidebar polls every few seconds to pick up the title

Why async? Doesn't block the user's initial response.

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

## Chart Pipeline (Phase 2 Fix)

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
verify_token
  ↓
resolve_role
  ↓
load_history
  ├─ history non-empty? → condense_query
  └─ empty? → (skip condense)
  ↓
retrieve_filtered (uses condensed_query or raw query)
  ↓
generate_answer (with history in context if present)
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

**Title generation** is a separate, tiny graph run via `BackgroundTasks` after the response is sent.

---

## Project Structure

```
backend/
  app/
    main.py                FastAPI app + logging config
    config.py              Settings (environment variables)
    storage.py             File upload helpers
    db/
      pool.py              Postgres connection pool
      queries.py           All SQL (read first for access control)
    auth/
      email_rules.py       Institute email format parsing + role derivation
      jwt.py               JWT creation/verification
      magic_link.py        Magic-link token generation/validation
      mailer.py            Resend API sender (or console logger for dev)
      dependencies.py      FastAPI auth guards (@Depends)
    ingestion/
      parser.py            Docling (PDF/docx/md parser)
      splitter.py          RecursiveCharacterTextSplitter
      embedder.py          Sentence-Transformers wrapper
      pipeline.py          Orchestrates: parse → split → embed → store
    rag/
      state.py             LangGraph RAGState type
      prompts.py           System + classifier + chart-generation prompts
      llm.py               LiteLLM completion wrapper
      chart_parser.py      Extract & validate JSON from chart output
      nodes.py             All graph node functions (load_history, condense_query, etc.)
      graph.py             Compiled LangGraph with conditional edges
      title.py             Separate tiny graph for title generation
    api/
      schemas.py           Pydantic request/response models
      query.py             POST /query (conversation + RAG)
      conversations.py     GET/DELETE /conversations endpoints
      auth.py              POST /auth/login, /auth/verify
      admin_documents.py   POST/GET/DELETE /admin/documents
  db/
    schema.sql             Postgres DDL (all tables)
  scripts/
    init_db.py             Apply schema idempotently
    mint_dev_token.py      Generate test JWTs (still useful for curl)
  requirements.txt         Python dependencies
  Dockerfile
  storage/                 (Volume: uploaded PDF/docx/md files)

frontend/
  src/
    App.jsx                Main router
    main.jsx               Entry point
    api/
      client.js            HTTP wrapper + endpoint definitions
    auth/
      useAuth.js           Hook: token state + claims decoding
      EmailLoginPage.jsx   Email input → magic link request
      VerifyPage.jsx       Handles /auth/verify?token=... callback
    chat/
      ChatPage.jsx         Main UI: sidebar + messages + query input
      Sidebar.jsx          Conversation history + navigation
      AnswerBlock.jsx      Renders assistant message + chart + sources
      ChartBlock.jsx       Chart.js integration
      RoleBadge.jsx        Shows current role (VIEWING AS: faculty)
      SourceTag.jsx        Citation tags
    admin/
      AdminPage.jsx        Document upload + listing (faculty only)
      DocumentsTable.jsx   File management UI
      UploadForm.jsx       Upload form + role selector
    styles/
      theme.css            Dark theme (CSS variables)
      fonts.css            Google Fonts
  vite.config.js           Vite configuration
  eslint.config.js         Linting rules
  package.json

docker-compose.yml         Services: postgres, backend, frontend
.env                       Environment variables (committed with dev values)
.env.example               Config template
README.md                  Quick start (this document)
STARTUP.md                 Setup instructions
ARCHITECTURE.md            This document
plan.md                    Original Phase 1 architecture spec
```

---

## Technologies

| Component | Tech | Why |
|-----------|------|-----|
| **Parser** | Docling | Accurate table extraction, multi-format support |
| **Chunks** | LangChain RecursiveCharacterTextSplitter | Respects semantics, overlaps context |
| **Embeddings** | Sentence-Transformers (multi-qa-mpnet) | Fast, good for QA, works offline |
| **Vector DB** | PostgreSQL + pgvector | Single database for everything, no ops overhead |
| **Orchestration** | LangGraph | Explicit flow, handles branching (history, chart decision) |
| **LLM** | LiteLLM | Provider-agnostic (OpenAI, HuggingFace, Anthropic, local) |
| **Backend** | FastAPI | Fast, built-in validation, OpenAPI docs |
| **Frontend** | React 19 + Vite | Fast iteration, component-based, reactive |
| **Deployment** | Docker Compose | Everything-in-one, reproducible |

---

## Deployment Notes

For production:
1. **Set real `JWT_SECRET`, `RESEND_*` env vars** in `.env` or secrets manager
2. **Use a real LLM provider** (OpenAI, Anthropic, etc.) — set `LLM_MODEL` in `.env`
3. **Configure Postgres** (hosted Postgres or managed DB)
4. **Use a real storage backend** instead of local `/backend/storage` (S3, GCS, etc.)
5. **Enable HTTPS** (reverse proxy with cert, or use Railway/Fly.io which does it for you)
6. **Monitor logs** (LangGraph has built-in observability; integrate with your logging service)

See `docker-compose.yml` for the local development setup — adapt each service's environment and ports for your infrastructure.
