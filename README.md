# Edu LLM — Institute Document Q&A

RAG over institute documents, with access scoped by workspaces and classrooms: restricted content is filtered out at retrieval, so it never reaches the LLM.

## Features

### Everyone
- Sign in with a magic link sent to your institute email; faculty or student is worked out from the address.
- Ask questions about your documents in a chat; answers stream in with their sources, and a chart when you ask for numbers.
- The desk on the right lists the docs the conversation used; hover an answer to see which ones it read.
- Search everything you can read, or just one workspace / classroom (pick it from the switcher or type `@name`).
- Chat history: rename, pin, delete, and edit an earlier question to ask again.
- Get a notice when a document you can read is updated or removed.
- Light and dark themes.

<table><tr>
<td width="50%"><img src="mds/screenshots/ask-chart.png" alt="An answer with a chart and its source"><br><sub>An answer with a chart and its source</sub></td>
<td width="50%"><img src="mds/screenshots/ask-student.png" alt="A student asking within one classroom"><br><sub>A student asking within one classroom</sub></td>
</tr></table>

<table><tr>
<td width="50%"><img src="mds/screenshots/ask-mention.png" alt="Type @ to pick which shelf to search"><br><sub>Type @ to pick which shelf to search</sub></td>
<td width="50%"><img src="mds/screenshots/notices.png" alt="Notices when docs change"><br><sub>Notices when docs change</sub></td>
</tr></table>

### Faculty: library and classrooms
- Institute library (for everyone or faculty only), a personal workspace, and shared workspaces with other faculty.
- Upload PDFs and other docs; they are indexed automatically with a progress bar. Rename, change access, remove, see history.
- Every document is a book on a shelf, grouped by who can read it; or switch to a list.
- Classrooms inside a shared workspace: join codes, add students by email/CSV, archive and restore.
- Publish documents to chosen classrooms; students only ever see what is published to them.

<table><tr>
<td width="50%"><img src="mds/screenshots/library-shelves.png" alt="A workspace library: shelves, recent changes"><br><sub>A workspace library: shelves, recent changes</sub></td>
<td width="50%"><img src="mds/screenshots/classrooms.png" alt="Classrooms with join codes"><br><sub>Classrooms with join codes</sub></td>
</tr></table>

### Faculty: slide decks
- The AI drafts a `.pptx` lecture deck from chosen docs, citing them, with speaker notes.
- Edit slides by hand, or tell the AI what to change ("add a slide on paging", "more detailed") and review it before it replaces anything.
- Redraft when the sources change; download the `.pptx` or publish it to the workspace.
- Type `/ppt` in the chat box to start one.

<table><tr>
<td width="50%"><img src="mds/screenshots/slides-editor.png" alt="The slide editor"><br><sub>The slide editor</sub></td>
<td width="50%"><img src="mds/screenshots/slides-ai.png" alt="Edit with AI"><br><sub>Edit with AI</sub></td>
</tr></table>

### Faculty: question bank and quizzes
- AI-written or hand-written questions (MCQ, short, long), reviewed and approved before use; near-duplicates are dropped.
- Quizzes where every student gets a different set, and assignments that never repeat questions across classrooms in a term.
- Type `/quiz` in the chat box to write questions and give a classroom a quiz in one go.

<table><tr>
<td width="50%"><img src="mds/screenshots/question-bank.png" alt="Question bank"><br><sub>Question bank</sub></td>
<td width="50%"><img src="mds/screenshots/ask-slash.png" alt="/ppt and /quiz from the chat box"><br><sub>/ppt and /quiz from the chat box</sub></td>
</tr></table>

- Results: each student's set and answers, quiz scores, who handed in assignments (PDF, or ticked off for paper copies).
- Class analytics: averages, completion, late hand-ins, weakest chapters, most missed questions.

<table><tr>
<td width="50%"><img src="mds/screenshots/quiz-sets.png" alt="A quiz: one set per student, with their answers"><br><sub>A quiz: one set per student, with their answers</sub></td>
<td width="50%"><img src="mds/screenshots/analytics.png" alt="Class analytics"><br><sub>Class analytics</sub></td>
</tr></table>

### Students
- Join a classroom with its code; read its docs as a shelf or a list, PDFs open in the built-in viewer.
- Take quizzes in the app; the mark shows on submit, and the correct answers after the due date.
- Hand in assignments as a PDF; late hand-ins are allowed and marked late.

<table><tr>
<td width="50%"><img src="mds/screenshots/student-docs.png" alt="A classroom's docs"><br><sub>A classroom's docs</sub></td>
<td width="50%"><img src="mds/screenshots/student-quiz.png" alt="Taking a quiz"><br><sub>Taking a quiz</sub></td>
</tr></table>

<table><tr>
<td width="50%"><img src="mds/screenshots/student-results.png" alt="Marks after submitting"><br><sub>Marks after submitting</sub></td>
<td width="50%"><img src="mds/screenshots/student-assignments.png" alt="Assignments and hand-ins"><br><sub>Assignments and hand-ins</sub></td>
</tr></table>

### Dark theme

<img src="mds/screenshots/dark.png" alt="Library in the dark theme" width="720">

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
