-- Edu LLM schema. Safe to re-run (scripts/init_db.py). Access control lives
-- in `scope_ids` on both `documents` and `chunks` (denormalized, so retrieval
-- filters in a single pass with no join). See mds/ARCHITECTURE.md and the
-- Phase 2 section at the end of this file.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid()

CREATE TABLE IF NOT EXISTS documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    filename TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    file_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    progress INT NOT NULL DEFAULT 0,
    version INT NOT NULL DEFAULT 1,
    uploaded_by TEXT NOT NULL,
    uploaded_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE documents
    ADD COLUMN IF NOT EXISTS progress INT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS chunks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
    chunk_text TEXT NOT NULL,
    chunk_index INT NOT NULL,
    embedding vector(768)
);

CREATE INDEX IF NOT EXISTS chunks_embedding_ivfflat_idx
    ON chunks USING ivfflat (embedding vector_cosine_ops);

-- Phase 2: conversation memory, sidebar history, auto-titles. See
-- edu-llm-phase2-changes.md section 1.
CREATE TABLE IF NOT EXISTS conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_email TEXT NOT NULL,
    title TEXT,                          -- null until auto-generated
    is_pinned BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE conversations
    ADD COLUMN IF NOT EXISTS is_pinned BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS conversations_user_email_updated_at_idx
    ON conversations (user_email, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL,                  -- 'user' | 'assistant'
    content TEXT NOT NULL,
    chart_config JSONB,                  -- null if no chart
    sources JSONB,                       -- array of {title, doc_id}
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS messages_conversation_id_created_at_idx
    ON messages (conversation_id, created_at);

-- Phase 2: email magic-link login. See edu-llm-phase2-changes.md section 5.
CREATE TABLE IF NOT EXISTS login_tokens (
    token TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used BOOLEAN DEFAULT FALSE
);

-- Phase 1 (mds/PLAN.md): users table, document audit log, update/delete
-- notifications.

-- Upserted on every POST /auth/verify. `name` is derived from the email local
-- part on first login and is not overwritten afterwards (editable later).
CREATE TABLE IF NOT EXISTS users (
    email TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    dept TEXT,
    year TEXT,
    division TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE documents
    ADD COLUMN IF NOT EXISTS updated_by TEXT;

-- Append-only. No FK on document_id: the event must outlive the document,
-- which is also why document_title is copied in.
CREATE TABLE IF NOT EXISTS document_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL,
    document_title TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('uploaded', 'updated', 'deleted')),
    actor_email TEXT NOT NULL,
    actor_name TEXT NOT NULL,
    version INT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS document_events_document_id_created_at_idx
    ON document_events (document_id, created_at DESC);

-- One row per event, not per recipient. `audience` is the document's scope
-- ids at event time (before and after, for an update), as a JSON array of
-- UUID strings. Who sees a notification is decided by the query in
-- queries.list_notifications.
CREATE TABLE IF NOT EXISTS notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind TEXT NOT NULL CHECK (kind IN ('updated', 'deleted')),
    document_id UUID NOT NULL,
    document_title TEXT NOT NULL,
    version INT NOT NULL,
    actor_email TEXT NOT NULL,
    actor_name TEXT NOT NULL,
    audience JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notifications_created_at_idx
    ON notifications (created_at DESC);

CREATE INDEX IF NOT EXISTS notifications_audience_gin_idx
    ON notifications USING GIN (audience);

-- Users can mark notifications read but never delete them.
CREATE TABLE IF NOT EXISTS notification_reads (
    notification_id UUID NOT NULL REFERENCES notifications(id),
    user_email TEXT NOT NULL,
    read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (notification_id, user_email)
);

-- The API has no UPDATE/DELETE path for the audit log or notifications;
-- this makes the database refuse them too.
CREATE OR REPLACE FUNCTION reject_modification() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS document_events_append_only ON document_events;
CREATE TRIGGER document_events_append_only
    BEFORE UPDATE OR DELETE ON document_events
    FOR EACH ROW EXECUTE FUNCTION reject_modification();

DROP TRIGGER IF EXISTS notifications_append_only ON notifications;
CREATE TRIGGER notifications_append_only
    BEFORE UPDATE OR DELETE ON notifications
    FOR EACH ROW EXECUTE FUNCTION reject_modification();

-- Phase 2 (mds/PLAN.md): workspaces and classrooms.
--
-- Access is expressed as scope ids, stored on every document and copied onto
-- its chunks. A user can read a chunk when the chunk's scope_ids overlap the
-- user's own scope ids, which queries._user_scope_ids works out per request
-- from the membership tables below:
--   00000000-0000-0000-0000-000000000001  INSTITUTE    everyone
--   00000000-0000-0000-0000-000000000002  ALL_FACULTY  every faculty member
--   a workspace id                                     its faculty members
--   a classroom id                                     its students
-- The two fixed ids are mirrored as constants in app/db/queries.py.

CREATE TABLE IF NOT EXISTS workspaces (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('personal', 'shared')),
    owner_email TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS workspaces_one_personal_per_owner_idx
    ON workspaces (owner_email) WHERE kind = 'personal';

-- An invite is just a row here; the invitee may not have a users row yet.
CREATE TABLE IF NOT EXISTS workspace_members (
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_email TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner', 'editor')),
    added_by TEXT NOT NULL,
    added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, user_email)
);

CREATE INDEX IF NOT EXISTS workspace_members_user_email_idx
    ON workspace_members (user_email);

-- Only shared workspaces have classrooms. Archived classrooms keep their
-- members and documents but grant no access.
CREATE TABLE IF NOT EXISTS classrooms (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    subject TEXT,
    term TEXT,                           -- e.g. "2026-27 Odd"
    join_code TEXT NOT NULL UNIQUE,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    archived_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS classrooms_workspace_id_idx ON classrooms (workspace_id);

-- Students. added_by is null when the student joined with the code.
CREATE TABLE IF NOT EXISTS classroom_members (
    classroom_id UUID NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
    user_email TEXT NOT NULL,
    added_by TEXT,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (classroom_id, user_email)
);

CREATE INDEX IF NOT EXISTS classroom_members_user_email_idx
    ON classroom_members (user_email);

-- A document belongs to the institute library (workspace_id null, visibility
-- institute|faculty) or to one workspace (visibility workspace|classrooms).
-- Workspaces with documents can't be deleted (no cascade on purpose).
ALTER TABLE documents
    ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces(id),
    ADD COLUMN IF NOT EXISTS visibility TEXT,
    ADD COLUMN IF NOT EXISTS classroom_ids UUID[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS scope_ids UUID[];

ALTER TABLE chunks
    ADD COLUMN IF NOT EXISTS scope_ids UUID[];

-- Workspace the document was in when the event happened (null = institute
-- library), so the activity log can be shown per workspace.
ALTER TABLE document_events
    ADD COLUMN IF NOT EXISTS workspace_id UUID;

-- One-time migration from Phase 1's role-based access:
--   ["student","faculty"] -> institute (INSTITUTE scope)
--   ["faculty"]           -> faculty   (ALL_FACULTY scope)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'documents' AND column_name = 'allowed_roles'
    ) THEN
        UPDATE documents
        SET visibility = CASE WHEN 'student' = ANY (allowed_roles) THEN 'institute' ELSE 'faculty' END
        WHERE visibility IS NULL;
        ALTER TABLE documents DROP COLUMN allowed_roles;
    END IF;

    UPDATE documents
    SET scope_ids = CASE visibility
        WHEN 'institute' THEN ARRAY['00000000-0000-0000-0000-000000000001']::uuid[]
        ELSE ARRAY['00000000-0000-0000-0000-000000000002']::uuid[]
    END
    WHERE scope_ids IS NULL;

    UPDATE chunks c SET scope_ids = d.scope_ids
    FROM documents d
    WHERE d.id = c.document_id AND c.scope_ids IS NULL;

    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'chunks' AND column_name = 'allowed_roles'
    ) THEN
        ALTER TABLE chunks DROP COLUMN allowed_roles; -- drops its GIN index too
    END IF;

    -- Phase 1 notifications stored role names as their audience.
    IF EXISTS (SELECT 1 FROM notifications WHERE audience ?| ARRAY['student', 'faculty']) THEN
        ALTER TABLE notifications DISABLE TRIGGER notifications_append_only;
        UPDATE notifications
        SET audience = (
            SELECT jsonb_agg(DISTINCT CASE e
                WHEN 'student' THEN '00000000-0000-0000-0000-000000000001'
                WHEN 'faculty' THEN '00000000-0000-0000-0000-000000000002'
                ELSE e
            END)
            FROM jsonb_array_elements_text(audience) AS e
        )
        WHERE audience ?| ARRAY['student', 'faculty'];
        ALTER TABLE notifications ENABLE TRIGGER notifications_append_only;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'documents_visibility_check') THEN
        ALTER TABLE documents ADD CONSTRAINT documents_visibility_check CHECK (
            (workspace_id IS NULL AND visibility IN ('institute', 'faculty') AND classroom_ids = '{}')
            OR (workspace_id IS NOT NULL AND visibility = 'workspace' AND classroom_ids = '{}')
            OR (workspace_id IS NOT NULL AND visibility = 'classrooms' AND classroom_ids <> '{}')
        );
    END IF;
END
$$;

ALTER TABLE documents
    ALTER COLUMN visibility SET NOT NULL,
    ALTER COLUMN scope_ids SET NOT NULL;

ALTER TABLE chunks
    ALTER COLUMN scope_ids SET NOT NULL;

CREATE INDEX IF NOT EXISTS chunks_scope_ids_gin_idx ON chunks USING GIN (scope_ids);

CREATE INDEX IF NOT EXISTS documents_workspace_id_idx ON documents (workspace_id);

CREATE INDEX IF NOT EXISTS document_events_workspace_id_created_at_idx
    ON document_events (workspace_id, created_at DESC);

-- Phase 3 (mds/PLAN.md): faculty notes and slide decks.
--
-- A note is written (or drafted by the LLM) from some of its workspace's
-- documents and the institute library's. `sources` remembers which version
-- of each source was used, as [{"doc_id", "title", "version"}] in citation
-- order ([1] is the first). A note is stale when any of them has since been
-- re-uploaded or deleted; it is never rewritten automatically.
-- Publishing turns it into an ordinary document (`document_id`) that goes
-- through ingestion, so it becomes searchable and gets audit events.
CREATE TABLE IF NOT EXISTS notes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id),
    kind TEXT NOT NULL CHECK (kind IN ('notes', 'slides')),
    title TEXT NOT NULL,
    subject TEXT,
    topic TEXT NOT NULL,
    body_md TEXT NOT NULL DEFAULT '',          -- kind = notes
    slides JSONB NOT NULL DEFAULT '[]',        -- kind = slides: [{title, bullets[], notes}]
    sources JSONB NOT NULL DEFAULT '[]',
    document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
    published_at TIMESTAMPTZ,
    created_by TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notes_workspace_id_updated_at_idx ON notes (workspace_id, updated_at DESC);

-- Notes generation reads the chunks of a few chosen documents.
CREATE INDEX IF NOT EXISTS chunks_document_id_idx ON chunks (document_id);

-- Phase 4 (mds/PLAN.md): question bank, quizzes and assignments.
--
-- Questions are drafted by the LLM from a workspace's sources (or written by
-- hand) and only used once a faculty member approves them. `embedding` is
-- the question's prompt, used to refuse near-duplicates (paraphrases would
-- otherwise defeat the uniqueness rules below).
--   body   = {"prompt", "options": [..]}      options only for mcq
--   answer = {"correct": <option index>|null, "explanation"}
-- Students never see `answer`.
CREATE TABLE IF NOT EXISTS questions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id),
    subject TEXT NOT NULL,
    topic TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('mcq', 'short', 'long')),
    difficulty INT NOT NULL CHECK (difficulty BETWEEN 1 AND 3),
    body JSONB NOT NULL,
    answer JSONB NOT NULL,
    source_chunk_ids UUID[] NOT NULL DEFAULT '{}',
    source_doc_ids UUID[] NOT NULL DEFAULT '{}',
    embedding vector(768) NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved')),
    created_by TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS questions_workspace_subject_idx ON questions (workspace_id, lower(subject));

-- An assessment belongs to one classroom. `config` holds what it was built
-- with ({count, topics, types, difficulties, max_overlap}); `seed` makes the
-- choice of questions reproducible. `rule_key` = lower(subject) | term: an
-- assignment's questions can't be used by another assignment with the same
-- key (enforced by the unique index on assessment_items).
CREATE TABLE IF NOT EXISTS assessments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    classroom_id UUID NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('quiz', 'assignment')),
    title TEXT NOT NULL,
    subject TEXT NOT NULL,
    rule_key TEXT NOT NULL,
    config JSONB NOT NULL,
    seed BIGINT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    due_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS assessments_classroom_id_idx ON assessments (classroom_id, created_at DESC);

-- student_email is null for an assignment's class-wide items, set for a
-- quiz's per-student ones. option_order is the shuffled order of an mcq's
-- options as shown (indexes into body.options). kind and rule_key are
-- copied from the assessment so the index below can enforce the
-- no-repeat rule. Questions in use can't be deleted (no cascade).
CREATE TABLE IF NOT EXISTS assessment_items (
    assessment_id UUID NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
    student_email TEXT,
    question_id UUID NOT NULL REFERENCES questions(id),
    position INT NOT NULL,
    option_order INT[],
    kind TEXT NOT NULL,
    rule_key TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS assessment_items_assignment_once_per_term_idx
    ON assessment_items (rule_key, question_id) WHERE kind = 'assignment';

CREATE UNIQUE INDEX IF NOT EXISTS assessment_items_position_idx
    ON assessment_items (assessment_id, COALESCE(student_email, ''), position);

CREATE INDEX IF NOT EXISTS assessment_items_student_idx ON assessment_items (student_email, assessment_id);

CREATE INDEX IF NOT EXISTS assessment_items_question_id_idx ON assessment_items (question_id);

-- Phase 5: answering. A student's answers to one quiz or assignment, graded
-- when they submit (multiple choice only for now). One submission each, no
-- resubmitting. `answers` = [{"question_id", "choice"}], `choice` being an
-- index into the question's body.options (not the shuffled order shown), or
-- null when left blank, so a later edit to a question can be regraded.
CREATE TABLE IF NOT EXISTS submissions (
    assessment_id UUID NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
    student_email TEXT NOT NULL,
    answers JSONB NOT NULL,
    score INT NOT NULL,
    total INT NOT NULL,
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (assessment_id, student_email)
);

CREATE INDEX IF NOT EXISTS submissions_student_email_idx ON submissions (student_email);

-- Assignments are written answers checked on paper: a submission only
-- records that it was handed in (score and total stay null). `marked_by`
-- is the faculty member who ticked it off, null when the student did.
ALTER TABLE submissions
    ALTER COLUMN score DROP NOT NULL,
    ALTER COLUMN total DROP NOT NULL,
    ADD COLUMN IF NOT EXISTS marked_by TEXT;

-- Assignments are handed in as a PDF of the written answers (scanned or
-- typed). Null for quizzes and for paper copies ticked off by faculty.
ALTER TABLE submissions
    ADD COLUMN IF NOT EXISTS file_path TEXT,
    ADD COLUMN IF NOT EXISTS file_name TEXT,
    ADD COLUMN IF NOT EXISTS file_size INT;
