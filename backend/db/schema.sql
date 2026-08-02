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
    version INT NOT NULL DEFAULT 1,
    uploaded_by TEXT NOT NULL,
    uploaded_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

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
