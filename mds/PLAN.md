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

**Status:** implemented (2026-10-29).

**Goal:** faculty create and update notes and slide decks from their workspace documents, and keep them current when sources change.

- `notes (id, workspace_id, kind: notes|slides, title, subject, topic, body_md, slides JSONB, sources JSONB, document_id, published_at, created_by, updated_by, created_at, updated_at)`
  - `sources` = `[{doc_id, title, version}]` in citation order (`[1]` is the first). It replaces the planned
    `source_doc_ids` + `source_versions` pair.
- **Generate**: faculty picks topic + up to 8 source docs (the workspace's own and the institute library's) → for each source, the
  chunks closest to the topic, through the user's scope ids → LLM drafts Markdown notes citing `[n]`. The draft is saved
  straight away (generation takes ~20–60 s), then edited in a Markdown editor with preview.
- **PPT**: LLM returns a slide outline (JSON: slides → title, bullets, speaker notes), edited as slide cards → rendered with
  `python-pptx` (title slide + slides + sources slide) → download, or published as the `.pptx`.
- **Publish**: the saved note is uploaded as a workspace document (`.md` / `.pptx`) through the normal ingestion pipeline, so it
  becomes searchable, can go to classrooms, and gets audit events and notices. Republishing replaces that same document (new version).
- **"Stay up to date"**: a note is **stale** when a source's `version` changed or the source was removed. The editor then offers
  "redraft a section / the whole note (or deck)", shown as a line diff to accept or discard, and "mark up to date" (records the
  current versions). No silent auto-rewrite.

### Decisions
- [x] Editor: plain Markdown textarea + live preview for notes; slide cards (title, bullets, speaker notes) for decks.
- [x] PPT theme: built-in 16:9 design in the logo's colours; `PPT_TEMPLATE_PATH` swaps in an institute `.pptx` template
  (its first layout for the title slide, its second for content slides).
- [x] Any faculty member of the workspace can edit a note (same rule as documents). Saves are refused (409) if someone else saved
  since the editor loaded the note, instead of overwriting.
- [x] Deleting a note keeps its published document; remove that from the library.
- [ ] Sources can't be changed after a note is created (start a new note instead).
- [ ] Decks can only be redrafted as a whole, not slide by slide.
- [ ] No streaming of drafts into the editor yet (the request waits for the whole draft).

---

## Phase 4 — Quiz and assignment generation

**Status:** implemented (2026-10-30).

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
- [x] The no-repeat rule also covers a classroom's own later assignments: a question is in at most one assignment per
  subject and term. Deleting an assignment frees its questions. Classrooms with no term count as one term.
- [x] Stratify by the faculty's topic (set when generating or writing a question), not a model-chosen sub-topic: model
  labels were too fragmented to give enough distinct sets.
- [x] A question is a near-duplicate when the cosine similarity of its text (prompt + options) to another in the
  workspace's bank is > 0.9; generated ones are dropped, hand-written/edited ones are refused (409).
- [x] Questions in use can be edited (typo fixes show in every set) but can't change type or number of options, and
  can't be deleted.
- [x] A quiz's sets are made for the roster at creation; students who join later get theirs from "Give them sets",
  under the same rules.
- [x] Only shared workspaces have the Quizzes tab (classrooms only exist there).
- [ ] Export format: in-app only for now; PDF/DOCX for printing still open.
- [ ] No notice to students when a quiz/assignment is added (Phase 1 notices are document-only).

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
