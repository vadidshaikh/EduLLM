# Plan

Roadmap for the next features, split into phases. Each phase ships on its own and leaves the app working.
The core rule from [ARCHITECTURE.md](ARCHITECTURE.md) still holds in every phase: **access is enforced in `search_chunks()` by filtering, never by prompts.**

| Phase | Theme | Depends on |
|---|---|---|
| 1 | Users table, document audit log, delete notifications | — |
| 2 | Workspaces and classrooms (membership-based access) | 1 |
| 3 | Faculty notes / PPT authoring | 2 |
| 4 | Quiz and assignment generation with per-class / per-student uniqueness | 2 (3 optional) |

---

## Phase 1 — Accountability: audit log + delete notifications

**Status:** implemented (2026-10-29).

**Goal:** every upload, update and delete records who did it. Updating or deleting a document notifies everyone who can see it (except the person who did it), and that notice can't be removed.

### Why a `users` table first
Today users exist only inside the JWT; there is no list of who can access what. Notifications need one.
- `users (email PK, name, role, dept, year, division, created_at, last_login_at)`, upserted in `POST /auth/verify`.
- `name`: derived from the email local part for now (`pawan.co23d1` → "Pawan"); editable later.

### Audit log
- `documents`: add `updated_by TEXT`. `uploaded_by` already exists.
- New append-only `document_events (id, document_id, document_title, action, actor_email, actor_name, version, created_at)`.
  - `action`: `uploaded | updated | deleted`.
  - No FK cascade on `document_id`; the event must survive the delete. Store `document_title` for that reason.
  - No UPDATE/DELETE path in the API. Optionally enforce in Postgres with a trigger that raises on UPDATE/DELETE.
- Written in the same transaction as the document change (`admin_documents.py` → `queries.py`).
- Admin table: show "Uploaded by / Last updated by"; add a per-document history drawer (`GET /admin/documents/{id}/events`).

### Update and delete notifications
- `notifications (id, kind: updated|deleted, document_id, document_title, version, actor_email, actor_name, audience JSONB, created_at)`
  - `audience` is the document's access scope at the time of the event (Phase 1: `allowed_roles`; Phase 2: scope ids).
- `notification_reads (notification_id, user_email, read_at)` — users can mark read, **never delete**.
- Visibility query: notification audience matches the user's scope **and** `actor_email <> me`.
  No join-date filter: users who join later still see older notices.
  One row per event instead of one row per recipient, so there's no fan-out.
- UI: bell icon with unread count in the sidebar; list panel; "mark all read". No delete button.

### Decisions
- [x] Users who join after an event still see the notice.
- [x] Notify on both updates and deletes (uploads only go to the audit log).

---

## Phase 2 — Workspaces and classrooms

**Status:** implemented (2026-10-29).

**Goal:** faculty create workspaces (personal or shared with other faculty by email). A workspace has classrooms; students join a classroom and see the notes published to it.

### Model
```
workspace (id, name, kind: personal|shared, owner_email, created_at)
workspace_members (workspace_id, user_email, role: owner|editor, added_by, added_at)
classroom (id, workspace_id, name, subject, term, join_code, created_by, archived_at)   -- term e.g. "2026-27 Odd"
classroom_members (classroom_id, user_email, joined_at)          -- students
documents: + workspace_id, + visibility: workspace|classrooms, + classroom_ids UUID[]
```
- **Personal** workspace: only the owner. Auto-created on a faculty member's first login.
- **Shared** workspace: owner adds faculty by email (invite is just a `workspace_members` row; email via Resend if the user doesn't exist yet).
- Students join by **join code** (also allow faculty to bulk-add by email/CSV).
- A document is either faculty-only within the workspace, or published to one or more of its classrooms.

### Access control (keeps the single enforcement point)
- Replace `chunks.allowed_roles` with `chunks.scope_ids UUID[]` (GIN-indexed):
  - workspace id → faculty members of that workspace,
  - classroom ids → students in those classrooms,
  - a fixed `INSTITUTE` id → current global docs (migration maps `["student","faculty"]` → INSTITUTE + faculty, `["faculty"]` → faculty-global).
- Per request, load the user's scope ids from membership tables (not the JWT — membership changes during a session). Filter: `chunks.scope_ids && :user_scopes`.
- Changing a document's visibility rewrites `scope_ids` on its chunks (no re-embedding).
- Phase 1 notification `audience` switches to scope ids; same query shape.

### UI
- Faculty: workspace switcher, classroom list, members tab, documents tab per workspace.
- Student: "Join classroom" (code), list of joined classrooms. Chat can be scoped to a classroom or "all my classes".

### Decisions
- [x] Any faculty member of a shared workspace (owner or editor) can update/delete any document in it. The audit log and notifications make this traceable.
- [ ] Does the existing separate `admin` role question (below) go away? Workspace owner may cover it.
  For now any faculty member can still manage the institute library.
- [x] Students can be in classrooms from different workspaces at once.
- [x] Only shared workspaces have classrooms (personal = only the owner), as in the UI reference.
- [x] Institute library kept: documents with no workspace, visibility `institute` (everyone) or `faculty`.
  Phase 1 docs migrated there (`["student","faculty"]` → `institute`, `["faculty"]` → `faculty`).
- [x] Picking a classroom/workspace in the chat searches only that scope (institute docs only appear under "All").
- [x] Archiving a classroom removes its students' access; it can be restored. Workspaces can only be deleted when empty.
- [ ] Moving a document between workspaces isn't supported yet (re-upload it instead).

---

## Phase 3 — Faculty notes / PPT authoring

**Goal:** faculty create and update notes and slide decks from their workspace documents, and keep them current when sources change.

- `notes (id, workspace_id, title, subject, topic, body_md, source_doc_ids UUID[], source_versions JSONB, created_by, updated_by, updated_at)`
- **Generate**: faculty picks topic + source docs → RAG over *their* scope → LLM drafts Markdown notes with citations. Faculty edits in a Markdown editor, then saves.
- **PPT**: generate a slide outline (JSON: slides → title, bullets, speaker notes) → render with `python-pptx` → download. Same source tracking.
- **Publish**: saving/publishing a note runs it through the normal ingestion pipeline as a document, so it becomes searchable and gets audit events from Phase 1.
- **"Stay up to date"**: `source_versions` stores the version of each source doc used. When a source's `version` bumps, mark the note **stale** and offer "regenerate section / show diff". No silent auto-rewrite.

### Decisions
- [ ] Editor: plain Markdown textarea + preview, or a rich editor? (Proposed: Markdown first.)
- [ ] PPT theme/template: one institute template?

---

## Phase 4 — Quiz and assignment generation

**Goal:** generate quizzes/assignments by subject, so that no two classes get the same assignment and no two students get the same quiz.

### Approach: question bank first, then assignment of questions
Generating per student directly is slow, expensive and hard to review. Instead:

1. **Build a bank** — `questions (id, workspace_id, subject, topic, type: mcq|short|long, difficulty 1-3, body JSONB, answer JSONB, source_chunk_ids, embedding vector(768), status: draft|approved, created_by)`.
   LLM generates questions from scoped chunks; faculty reviews and approves. Only approved questions are used.
2. **De-duplicate the bank** — embed each question; reject a new one if cosine similarity > ~0.9 to an existing one. Otherwise "different" questions can be paraphrases of each other, which defeats the uniqueness rule.
3. **Assign** — plain Python, deterministic with a stored seed:
   - **Assignments (per classroom):** questions used by one classroom's assignment are excluded for other classrooms with the same subject **and term** → disjoint sets. Questions can be reused in a later term. Needs `pool ≥ classes × questions_per_assignment`; the UI shows this count and blocks or asks for more questions when short.
   - **Quizzes (per student):** each student gets `k` questions sampled **stratified by topic and difficulty** (same mix for everyone, so it's fair). Constraint: no two students get an identical set. Overlap between students is allowed ("s1: a s d, s2: b d w"); there is **no overlap cap by default**, but faculty can optionally set `max_overlap` per quiz. Greedy sampling with retries; if it can't satisfy the constraint, report the minimum pool size needed.
   - Also shuffle question order and MCQ option order per student.
4. **Store** — `assessments (id, classroom_id, kind: quiz|assignment, subject, config JSONB, seed, created_by, due_at)` and `assessment_items (assessment_id, student_email NULL for class-wide, question_id, position)`. A unique check across `assessment_items` enforces the class-level rule in the DB.

### Out of scope for Phase 4 (possible Phase 5)
- Student submission, auto-grading of MCQs, LLM-assisted grading of short answers, plagiarism check across students.

### Decisions
- [x] No-repeat rule applies within one subject in one term (`classroom.term`).
- [x] No default `max_overlap`; only identical sets are forbidden unless faculty set a cap.
- [ ] Export format: in-app only, or also PDF/DOCX for printing?

---

## Open items (carried over)

### Decisions pending
- [ ] Test the student email rule ("digits in 2nd segment") against real SCET emails, including hyphenated names and middle initials.
- [ ] Decide whether a separate `admin` role is needed. Right now every faculty member can upload and delete documents (see `app/auth/dependencies.py`). Revisit after Phase 2.
- [ ] Confirm the token lifetimes (now 15 min for magic links, 7 days for sessions).
- [ ] Domain + SSL, if the app must be reachable from outside the campus network.

### Future work
- Chunk-level (partial-document) access control. Phase 2's `scope_ids` on `chunks` keeps this possible.
- Output-scanning guardrail as a second layer. Retrieval filtering stays the main control.
- Per-user rate limiting (more important once Phase 3/4 generation is live).
- Summarize long conversations (only the last 10 messages are used now).
- Move to a job queue (Celery/RQ + Redis) if FastAPI background tasks can't keep up — likely needed for bulk quiz/notes generation.
- Load test at ~50 concurrent queries.
