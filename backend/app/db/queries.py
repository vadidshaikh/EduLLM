"""All SQL for Edu LLM lives in this module — nowhere else issues a query.

`search_chunks` is the access-control enforcement point: the
`allowed_roles @> ARRAY[%s]::text[]` predicate (backed by the GIN index on
chunks.allowed_roles) is the only thing standing between a student session
and a faculty-only chunk. Review changes to that function hardest.

Every connection from the pool defaults to dict_row (configured in
app/db/pool.py), so results here are dicts, not tuples.
"""
from __future__ import annotations

from typing import Any
from uuid import UUID

from pgvector import Vector

from app.db.pool import pool


def insert_document(
    *,
    title: str,
    filename: str,
    storage_path: str,
    allowed_roles: list[str],
    file_hash: str,
    uploaded_by: str,
) -> dict[str, Any]:
    """Insert a new document, or if `title` already exists, bump its version
    and replace its file metadata (re-upload case). Chunks are handled
    separately by `replace_chunks` once ingestion finishes.
    """
    with pool.connection() as conn:
        existing = conn.execute(
            "SELECT id, version FROM documents WHERE title = %s", (title,)
        ).fetchone()

        if existing:
            row = conn.execute(
                """
                UPDATE documents
                SET filename = %s, storage_path = %s, allowed_roles = %s,
                    file_hash = %s, status = 'queued', version = %s,
                    uploaded_by = %s, updated_at = now()
                WHERE id = %s
                RETURNING *
                """,
                (
                    filename,
                    storage_path,
                    allowed_roles,
                    file_hash,
                    existing["version"] + 1,
                    uploaded_by,
                    existing["id"],
                ),
            ).fetchone()
        else:
            row = conn.execute(
                """
                INSERT INTO documents
                    (title, filename, storage_path, allowed_roles, file_hash, uploaded_by)
                VALUES (%s, %s, %s, %s, %s, %s)
                RETURNING *
                """,
                (title, filename, storage_path, allowed_roles, file_hash, uploaded_by),
            ).fetchone()

        conn.commit()
        return row


def list_documents() -> list[dict[str, Any]]:
    with pool.connection() as conn:
        return conn.execute("SELECT * FROM documents ORDER BY uploaded_at DESC").fetchall()


def get_document(document_id: UUID) -> dict[str, Any] | None:
    with pool.connection() as conn:
        return conn.execute("SELECT * FROM documents WHERE id = %s", (document_id,)).fetchone()


def delete_document(document_id: UUID) -> None:
    with pool.connection() as conn:
        conn.execute("DELETE FROM documents WHERE id = %s", (document_id,))
        conn.commit()


def update_document_status(document_id: UUID, status: str) -> None:
    with pool.connection() as conn:
        conn.execute(
            "UPDATE documents SET status = %s, updated_at = now() WHERE id = %s",
            (status, document_id),
        )
        conn.commit()


def replace_chunks(
    document_id: UUID,
    chunks: list[dict[str, Any]],
    allowed_roles: list[str],
) -> None:
    """Delete existing chunks for this document and insert the new set.
    `chunks` items: {"chunk_text": str, "chunk_index": int, "embedding": list[float]}
    """
    with pool.connection() as conn:
        conn.execute("DELETE FROM chunks WHERE document_id = %s", (document_id,))
        conn.cursor().executemany(
            """
            INSERT INTO chunks (document_id, chunk_text, chunk_index, embedding, allowed_roles)
            VALUES (%s, %s, %s, %s, %s)
            """,
            [
                (
                    document_id,
                    c["chunk_text"],
                    c["chunk_index"],
                    Vector(c["embedding"]),
                    allowed_roles,
                )
                for c in chunks
            ],
        )
        conn.commit()


def search_chunks(role: str, embedding: list[float], top_k: int) -> list[dict[str, Any]]:
    """Role-filtered vector search. The WHERE clause is the entire access
    control boundary: a chunk not tagged for `role` is never returned, and
    therefore never reaches the LLM's context.
    """
    with pool.connection() as conn:
        return conn.execute(
            """
            SELECT c.id, c.chunk_text, c.chunk_index, c.document_id, d.title
            FROM chunks c
            JOIN documents d ON d.id = c.document_id
            WHERE c.allowed_roles @> ARRAY[%s]::text[]
            ORDER BY c.embedding <=> %s
            LIMIT %s
            """,
            (role, Vector(embedding), top_k),
        ).fetchall()
