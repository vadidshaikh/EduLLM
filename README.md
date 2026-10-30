# Edu LLM — Institute Document Q&A

RAG over institute documents, with access scoped by workspaces and classrooms: restricted content is filtered out at retrieval, so it never reaches the LLM.

## Features

**Everyone**
- Sign in with a magic link sent to your institute email; faculty or student is worked out from the address.
- Ask questions about your documents in a chat; answers stream in with their sources, and a chart when you ask for numbers.
- Search everything you can read, or just one workspace / classroom (pick it from the switcher or type `@name`).
- Chat history: rename, pin, delete, and edit an earlier question to ask again.
- Get a notice when a document you can read is updated or removed.
- Light and dark themes.

**Faculty**
- Institute library (for everyone or faculty only), a personal workspace, and shared workspaces with other faculty.
- Upload PDFs and other docs; they are indexed automatically with a progress bar. Rename, change access, remove, see history.
- Classrooms inside a shared workspace: join codes, add students by email/CSV, archive and restore.
- Publish documents to chosen classrooms; students only ever see what is published to them.
- Slide decks: the AI drafts a `.pptx` lecture deck from chosen docs; edit it, ask for changes in words, redraft when sources change, download or publish.
- Question bank: AI-written or hand-written questions (MCQ, short, long), reviewed and approved before use; near-duplicates are dropped.
- Quizzes where every student gets a different set, and assignments that never repeat questions across classrooms in a term.
- `/ppt` and `/quiz` in the chat composer make a deck or a full classroom quiz in one go.
- Results: quiz scores, who handed in assignments (PDF or ticked off for paper copies), and class analytics — averages, completion, weakest chapters, hardest questions.

**Students**
- Join a classroom with its code; read its docs as a shelf or a list, PDFs open in the built-in viewer.
- Take quizzes in the app (graded on submit; answers shown after the due date).
- Hand in assignments as a PDF, late hand-ins allowed and marked late.

## Screenshots

| | |
|---|---|
| ![Library](mds/screenshots/library.png) Library | ![Notes editor](mds/screenshots/notes-editor.png) Notes editor |
| ![Question bank](mds/screenshots/question-bank.png) Question bank | ![Quiz sets](mds/screenshots/quiz-sets.png) A quiz, one set per student |
| ![Student view](mds/screenshots/student-quiz.png) Student's own quiz (no answers) | |

## Quick Start

```bash
# Terminal 1: backend
docker compose up -d postgres   # DB on port 5433; needed after every reboot
source .venv/bin/activate
cd backend
uvicorn app.main:app --reload

# Terminal 2: frontend
cd frontend
npm run dev
```

Then visit `http://localhost:5173` and sign in with your institute email (`firstname.lastname@scet.ac.in` for faculty, `name.co23d1@scet.ac.in` for students).

## Next Steps

- **Setup, config, troubleshooting** → [mds/SETUP.md](mds/SETUP.md)
- **How it works** → [mds/ARCHITECTURE.md](mds/ARCHITECTURE.md)
- **Test data (accounts, edge cases)** → [mds/SEED_DATA.md](mds/SEED_DATA.md)

## Key Files

| File | Purpose |
|------|---------|
| `backend/app/main.py` | FastAPI server |
| `backend/app/rag/` | LangGraph Q&A pipeline |
| `backend/app/db/queries.py` | All SQL + access control |
| `backend/app/authoring/`, `backend/app/assessments/` | Notes/decks, question bank and quiz assignment |
| `frontend/src/chat/`, `library/`, `quizzes/` | Ask, Library, Quizzes UI |
| `backend/scripts/seed_dev_data.py` | Wipe and refill the DB with test data |
| `.env.example` | Config template |
| `docker-compose.yml` | Services (Postgres, backend, frontend) |

## Technologies

FastAPI · LangGraph · React 19 · PostgreSQL + pgvector · NVIDIA API Catalog · Docker Compose
