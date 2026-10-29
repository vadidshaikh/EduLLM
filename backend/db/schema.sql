-- Edu LLM v1 schema. Access control lives entirely in `allowed_roles` on both
-- tables: `documents` for admin listing, `chunks` (denormalized) so retrieval
-- filters in a single pass with no join. See plan.md section 1 and 4.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid()

CREATE TABLE IF NOT EXISTS documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    filename TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    allowed_roles TEXT[] NOT NULL,
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
    embedding vector(768),
    allowed_roles TEXT[] NOT NULL
);

CREATE INDEX IF NOT EXISTS chunks_embedding_ivfflat_idx
    ON chunks USING ivfflat (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS chunks_allowed_roles_gin_idx
    ON chunks USING GIN (allowed_roles);

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

-- One row per event, not per recipient. `audience` is the document's access
-- scope at event time (Phase 1: role names; Phase 2: scope ids). Who sees a
-- notification is decided by the query in queries.list_notifications.
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
