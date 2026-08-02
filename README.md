# Edu LLM — Institute Document Q&A

A role-based RAG system where students only see documents tagged for them, and faculty can see everything. Access control happens at the database level, not in prompts.

See `plan.md` for the full architecture and design decisions.

---

## Quick Start

Everything is already set up. To run it:

```bash
# Terminal 1: backend
cd backend
conda activate edullm
uvicorn app.main:app --reload

# Terminal 2: frontend
cd frontend
npm run dev
```

Then visit `http://localhost:5173`, mint a token from backend/scripts/mint_dev_token.py, and log in using that.

---

## Prerequisites

- **conda** — Miniconda or Anaconda
- **Docker + Docker Compose** — for Postgres
- **Node.js 20+** — for the frontend

---

## Setup (One Time)

### 1. Environment variables

The repo already has a working `.env` file. The only things you might need to change:

- `HF_TOKEN` — your HuggingFace token (needed for embeddings and LLM)
- `JWT_SECRET` — dev key is already there; replace before going to production

Generate a new secret:
```bash
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

See `.env.example` for all available settings.

**Note:** Docker Postgres is mapped to host port **5433** (not 5432, since this machine has a system Postgres already). Change it back in `docker-compose.yml` if you don't have that conflict.

### 2. Python environment

```bash
conda create -n edullm python=3.11 -y
conda activate edullm
pip install -r backend/requirements.txt
```

(First install is slow — torch and docling are large.)

### 3. Database

Start Postgres and create the schema:

```bash
docker compose up -d postgres
python backend/scripts/init_db.py
```

Running `init_db.py` again is safe — it uses `IF NOT EXISTS` everywhere.

---

## Running the App

### Backend (FastAPI + LangGraph)

```bash
cd backend
conda activate edullm
uvicorn app.main:app --reload
```

The API runs on `http://localhost:8000`. Check health: `curl http://localhost:8000/health`

Or use Docker Compose for everything:
```bash
docker compose up -d
```

### Frontend (React + Vite)

```bash
cd frontend
npm run dev
```

Visit `http://localhost:5173`

---

## Login & Test

### Mint a dev token

```bash
python backend/scripts/mint_dev_token.py --sub student1@college.edu --role student
python backend/scripts/mint_dev_token.py --sub prof1@college.edu --role faculty
```

### Log in on the app

Go to `/login` and paste the token.

The role badge at the top shows who you're viewing as.

### Upload documents

Go to `/admin` (faculty only):
- Upload a file (.md, .pdf, .docx, etc.)
- Give it a title
- Choose which roles can see it
- Ingestion runs in the background: `queued` → `processing` → `indexed` (or `failed`)

### Ask a question

On the `/` page (chat):
- Type a question
- The LLM searches only documents you have access to
- Student tokens never see faculty-only documents

---

## Project Structure

```
backend/
  app/
    main.py              FastAPI server + lifespan
    config.py            Environment variables
    storage.py           File upload helpers
    db/
      pool.py            Postgres connection pool
      queries.py         All SQL queries (read this first for ACL)
    auth/
      jwt.py             JWT verification
      dependencies.py    FastAPI auth guards
    ingestion/
      parser.py          Docling (parse PDFs, docx, etc.)
      splitter.py        Split text into chunks
      embedder.py        Sentence-transformers
      pipeline.py        Orchestrate: parse → split → embed → store
    rag/
      state.py           LangGraph state shape
      prompts.py         System prompt (chart-config included)
      chart_parser.py    Extract [GRAPH_CONFIG] from answers
      llm.py             LiteLLM wrapper (swappable provider)
      nodes.py           Graph node functions
      graph.py           Compiled LangGraph
    api/
      schemas.py         Pydantic request/response models
      query.py           POST /query endpoint
      admin_documents.py POST/GET/DELETE /admin/documents
  db/
    schema.sql           Postgres DDL
  scripts/
    init_db.py           Apply schema
    mint_dev_token.py    Generate test JWTs
  requirements.txt       Python dependencies
  Dockerfile
  storage/               (Volume for uploaded files)

frontend/
  src/
    App.jsx              Main routing
    api/
      client.js          API request wrapper
    auth/
      useAuth.js         Token state hook
      DevLoginPage.jsx   Paste-a-JWT login (dev only)
    chat/
      ChatPage.jsx       Main chat interface
      RoleBadge.jsx      Shows current role
      AnswerBlock.jsx    Renders answer + sources + chart
      ChartBlock.jsx     Chart.js integration
      SourceTag.jsx      Citation tags
    admin/
      AdminPage.jsx      Upload + document list
      DocumentsTable.jsx File management
      UploadForm.jsx     Upload UI
    styles/
      theme.css          Dark palette + typography
      fonts.css          Google Fonts setup
  vite.config.js         Vite config
  package.json

docker-compose.yml       Postgres, backend, frontend services
.env                     Environment variables (secrets)
.env.example             Template for .env
plan.md                  Full architecture spec
NEXT_STEPS.md            Manual setup for real auth service
```

---

## How Access Control Works

1. **JWT verification** happens once per request in `app/auth/dependencies.py`
2. **Role extraction** from verified token (never from request body)
3. **Vector search** in `app/db/queries.py::search_chunks()` filters with:
   ```sql
   WHERE chunks.allowed_roles @> ARRAY[%s]::text[]
   ```
   This is the **only place** access control is enforced — before the LLM ever sees the chunk.
4. **Student tokens never retrieve faculty-only chunks**, period.

---

## Troubleshooting

**Port 5432 already in use?** → Change Postgres port in `docker-compose.yml` (or `.env` `DATABASE_URL`)

**Ingestion fails?** → Check `backend` container logs or the server output. Docling is picky about file formats.

**Frontend can't reach backend?** → Verify `VITE_API_BASE_URL` in `.env` is correct (default: `http://localhost:8000`)

**LLM gives errors?** → The default model provider rotates availability. See `.env` for how to swap models.

---

## Technologies Used

- **Parser:** Docling (accurate table extraction)
- **Splitter:** LangChain's RecursiveCharacterTextSplitter
- **Embeddings:** Sentence-Transformers (multi-qa-mpnet-base-dot-v1)
- **Vector DB:** PostgreSQL + pgvector
- **Orchestration:** LangGraph
- **LLM:** LiteLLM (provider-agnostic, defaults to HuggingFace)
- **Backend:** FastAPI
- **Frontend:** React 19 + Vite
- **Deployment:** Docker Compose
