# Edu LLM — Institute Document Q&A

A role-based RAG system where students only see documents tagged for them, and faculty can see everything. Access control lives at the database level.

**Phase 2:** Conversation memory, multi-turn chat with sidebar history, auto-generated titles, and email-based magic-link login with role derivation from `@scet.ac.in` addresses.

## Quick Start

```bash
# Terminal 1: backend
cd backend
conda activate edullm
uvicorn app.main:app --reload

# Terminal 2: frontend
cd frontend
npm run dev
```

Then visit `http://localhost:5173` and sign in with your institute email (`firstname.lastname@scet.ac.in` for faculty, `name.co23d1@scet.ac.in` for students).

## Next Steps

- **First time setup?** → [STARTUP.md](STARTUP.md) — environment, dependencies, database
- **How does it work?** → [ARCHITECTURE.md](ARCHITECTURE.md) — design, access control, tech stack
- **Without Docker/services?** → [STARTUP.md#offline](STARTUP.md#offline) — local dev without Postgres

## Key Files

| File | Purpose |
|------|---------|
| `backend/app/main.py` | FastAPI server |
| `backend/app/rag/` | LangGraph Q&A pipeline |
| `backend/db/queries.py` | All SQL + access control |
| `frontend/src/chat/` | Chat UI with sidebar |
| `.env.example` | Config template |
| `docker-compose.yml` | Services (Postgres, backend, frontend) |

## Technologies

FastAPI · LangGraph · React 19 · PostgreSQL + pgvector · NVIDIA API Catalog · Docker Compose
w