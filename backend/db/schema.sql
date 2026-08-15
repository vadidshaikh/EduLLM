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
