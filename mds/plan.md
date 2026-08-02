# Edu LLM — Architecture & Build Spec (v1)

Role-based RAG system for institute document Q&A, with hard access control between student-visible and faculty-only documents.

---

## 1. Design Principle (read this first)

**Access control happens at retrieval time, via a metadata filter on the vector search — never as a prompt instruction.**

A restricted chunk must never enter the LLM's context window for a student session. We do not ask the model to "please don't share this." We simply never retrieve it. This is the constraint every other design decision below serves.

---

## 2. Scope (v1)

- Roles: `student`, `faculty` (binary now; schema designed to extend to per-department/per-course later without a rewrite)
- Access control: whole-document level (not chunk-level) — a document is either `["student","faculty"]` or `["faculty"]`
- Auth: external service (college email/ID login) issues a JWT; Edu LLM trusts and verifies that token, does not manage its own credentials
- Scale target: ~hundreds–low thousands of documents, 30–75 concurrent users
- Deployment: single VM, Docker Compose

---

## 3. Tech Stack

| Layer | Choice | Notes |
|---|---|---|
| Parser | Docling (`table_parsing_strategy: accurate`) | carried over from Pathway tests |
| Splitter | RecursiveCharacterTextSplitter, `chunk_size=4000, chunk_overlap=800` | carried over from Pathway tests |
| Embeddings | `sentence-transformers/multi-qa-mpnet-base-dot-v1` | carried over from Pathway tests |
| Vector store | PostgreSQL + `pgvector` | one DB for both relational + vector data |
| Orchestration | LangGraph | explicit graph nodes for auth/filter/retrieve/generate |
| LLM | via LiteLLM or provider SDK directly | keep provider-agnostic like the old config |
| Backend API | FastAPI | |
| Admin UI | Simple React/Next.js SPA or server-rendered admin panel | upload + role tagging + status |
| Job execution | FastAPI `BackgroundTasks` (v1) → Celery/RQ + Redis if load grows | avoid over-engineering at this scale |
| Deployment | Docker Compose on single VM | services: `postgres`, `backend`, `admin-ui`, optional `redis` |

---

## 4. Data Model (Postgres)

```sql
-- Document registry
CREATE TABLE documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    filename TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    allowed_roles TEXT[] NOT NULL,      -- e.g. {'student','faculty'} or {'faculty'}
    file_hash TEXT NOT NULL,             -- for change detection / re-embed trigger
    status TEXT NOT NULL DEFAULT 'queued', -- queued | processing | indexed | failed
    version INT NOT NULL DEFAULT 1,
    uploaded_by TEXT NOT NULL,           -- from JWT claim
    uploaded_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Chunk-level embeddings
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE chunks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
    chunk_text TEXT NOT NULL,
    chunk_index INT NOT NULL,
    embedding vector(768),               -- matches multi-qa-mpnet-base-dot-v1 dim
    allowed_roles TEXT[] NOT NULL        -- denormalized from documents for fast filtering
);

CREATE INDEX ON chunks USING ivfflat (embedding vector_cosine_ops);
CREATE INDEX ON chunks USING GIN (allowed_roles);
```

`allowed_roles` is denormalized onto `chunks` so the retrieval query filters in a single pass without a join — matters at 30–75 concurrent users on one VM.

---

## 5. Auth Flow

1. User logs into the separate auth service with college email/ID.
2. Auth service issues JWT containing at minimum: `sub` (user id/email), `role` (`student`|`faculty`).
3. Every Edu LLM API request carries `Authorization: Bearer <token>`.
4. Backend verifies signature (shared secret or JWKS, depending on how the auth service issues tokens — confirm this with whoever builds it) and extracts `role`. Backend never accepts a role from the request body — only from the verified token.
5. Admin endpoints (upload, tagging) additionally require `role == faculty` (or a dedicated `admin` claim if the auth service supports it — worth requesting this now rather than overloading `faculty`).

---

## 6. Ingestion Pipeline

```
Upload (Admin UI) 
  → save file to storage, compute file_hash
  → insert/update row in `documents` (status=queued)
  → background job:
      parse (Docling) 
      → split (RecursiveCharacterTextSplitter, 4000/800)
      → embed (multi-qa-mpnet-base-dot-v1)
      → delete old chunks for this document_id (if re-upload)
      → insert new chunks with allowed_roles copied from document
      → update documents.status = indexed (or failed, with error logged)
```

Re-upload of an existing document (same title, new file) bumps `version`, replaces chunks — don't accumulate stale duplicates.

---

## 7. LangGraph Flow

State object carries: `token`, `role`, `query`, `retrieved_chunks`, `answer`.

```
verify_token         → decode JWT, reject if invalid/expired
resolve_role          → attach role to state
retrieve_filtered      → vector search WHERE allowed_roles @> ARRAY[role], top_k=5
generate_answer        → LLM call with your existing chart-aware system prompt
parse_chart_config     → extract [GRAPH_CONFIG] block if present
respond                → return {answer, chart?, sources}
```

Keep your existing system prompt (the chart-inclusion logic) verbatim — it's already well-specified and doesn't need to change for the access-control work.

---

## 8. API Contract (draft)

```
POST /query
  Headers: Authorization: Bearer <jwt>
  Body: { "query": string }
  Response: { "answer": string, "chart": object|null, "sources": [{"title","doc_id"}] }

POST /admin/documents          (faculty only)
  multipart upload: file, title, allowed_roles
  Response: { "document_id", "status": "queued" }

GET /admin/documents            (faculty only)
  Response: [{ "id","title","allowed_roles","status","version","uploaded_at" }]

DELETE /admin/documents/{id}    (faculty only)
```

---

## 9. Deployment (Docker Compose sketch)

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg16
    volumes: [pgdata:/var/lib/postgresql/data]
  backend:
    build: ./backend
    depends_on: [postgres]
    env_file: .env
  admin-ui:
    build: ./admin-ui
    depends_on: [backend]
volumes:
  pgdata:
```

Single VM sizing for 30–75 concurrent users: 4 vCPU / 16GB RAM is a reasonable starting point, mainly to keep embedding/parsing jobs from starving query latency — revisit after load-testing.

---

## 9a. UI Design Direction (student/faculty chat UI + admin panel)

Simple, dark, Anthropic-adjacent typography. Note: Styrene/Tiempos themselves are commercially licensed to Anthropic — using free equivalents that carry the same character.

**Palette** (dark, not pure black — keeps it readable for long document-reading sessions):
- Background: `#1A1918` (warm near-black, not cold blue-black)
- Surface/panel: `#242322`
- Text primary: `#EDEAE4`
- Text muted: `#9C9890`
- Accent: `#C4703F` (muted terracotta — used sparingly: role badges, active states, links only)

**Typography** — same dual-system logic Anthropic uses: sans for UI chrome, serif for the actual content people are reading.
- UI chrome (nav, buttons, labels, admin panel): **Inter** or **General Sans** — free, close in spirit to Styrene's clean geometric character
- Answer/document content: **Source Serif 4** or **Newsreader** — free, transitional serif close to Tiempos' feel; used for the LLM's answers and any quoted document text, giving the "reading" parts a distinct, editorial feel from the "control" parts
- Mono (source citations, doc filenames): **JetBrains Mono**

**Signature element**: since this product's entire premise is role-gated visibility, make that visible rather than invisible. A small persistent badge showing "Viewing as: Student" or "Viewing as: Faculty" near the query box — not just a security feature, a trust feature. Users should always know why they're seeing what they're seeing.

**Layout concept**: single-column chat interface (question in, answer in serif below with source citations as small mono tags), keep it that simple for v1 — no sidebar clutter. Admin panel is a separate, plainer view: table of documents with role tags and status, upload button. Don't try to make the admin panel visually interesting — it's a utility screen, treat it as one.

---

## 10. Manual Action Items (things only you can do — Claude CLI can't automate these)

- [ ] Get JWT verification details from the auth team: signing secret (HMAC) or JWKS/public key URL (RSA)
- [ ] Confirm the exact JWT claim name for role (e.g. `role` vs `user_role`) in writing from the auth team
- [ ] Decide whether "admin" (can upload/tag docs) is a separate claim from "faculty" — if not, every faculty member gets upload access
- [ ] Pick an LLM provider and obtain the API key
- [ ] Get a HuggingFace token if the embedding/parsing models need gated downloads
- [ ] Decide where documents physically live (storage path/volume)
- [ ] Arrange domain + SSL if this needs to be reachable outside the campus network
- [ ] Have an initial batch of documents ready, tagged by role, for the first admin upload

Claude CLI should generate the actual README (setup commands, `.env` template, run instructions) once the repo exists — this checklist is the input it needs, not a substitute for that README.

---

## 11. Open Items (for later iterations, not blocking v1)

- Chunk-level (partial-document) ACL — you flagged this as unresolved; current schema supports it later since `allowed_roles` already lives on `chunks`, not just `documents`
- Multi-role granularity (per-department/course) — extend `allowed_roles` to more values, no structural change needed
- Output-scanning guardrail as defense-in-depth (secondary layer, not primary — retrieval filtering remains primary)
- Rate limiting per user
- Whether "admin" should be a separate claim from "faculty"

---

## 12. Suggested Build Order (for Claude Code)

1. Postgres schema + pgvector setup, Docker Compose skeleton
2. Ingestion pipeline (parser → splitter → embedder → DB write), test with a handful of docs
3. JWT verification middleware (mock the auth service response until it's live)
4. LangGraph query flow with role-filtered retrieval
5. `/query` API endpoint, test role filtering with student vs faculty tokens
6. Admin UI: upload + role tagging + status view
7. Load test at ~50 concurrent queries
