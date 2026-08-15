"""All SQL for Edu LLM lives in this module — nowhere else issues a query.

`search_chunks` is the access-control enforcement point: the
`allowed_roles @> ARRAY[%s]::text[]` predicate (backed by the GIN index on
chunks.allowed_roles) is the only thing standing between a student session
and a faculty-only chunk. Review changes to that function hardest.

Every connection from the pool defaults to dict_row (configured in
app/db/pool.py), so results here are dicts, not tuples.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID

from pgvector import Vector
from psycopg.types.json import Json

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
                    file_hash = %s, status = 'queued', progress = 0, version = %s,
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
    """Fetches every uploaded document, newest first."""
    with pool.connection() as conn:
        return conn.execute("SELECT * FROM documents ORDER BY uploaded_at DESC").fetchall()


def get_document(document_id: UUID) -> dict[str, Any] | None:
    """Looks up a single document's details by its ID."""
    with pool.connection() as conn:
        return conn.execute("SELECT * FROM documents WHERE id = %s", (document_id,)).fetchone()


def delete_document(document_id: UUID) -> None:
    """Permanently removes a document record from the database."""
    with pool.connection() as conn:
        conn.execute("DELETE FROM documents WHERE id = %s", (document_id,))
        conn.commit()


def update_document_roles(document_id: UUID, allowed_roles: list[str]) -> dict[str, Any] | None:
    """Changes which roles can access a document, propagating the new roles
    onto its existing chunks too (they carry a denormalized copy for
    `search_chunks`'s access-control check) so the change takes effect
    immediately, without re-ingestion.
    """
    with pool.connection() as conn:
        row = conn.execute(
            """
            UPDATE documents
            SET allowed_roles = %s, updated_at = now()
            WHERE id = %s
            RETURNING *
            """,
            (allowed_roles, document_id),
        ).fetchone()
        if row is not None:
            conn.execute(
                "UPDATE chunks SET allowed_roles = %s WHERE document_id = %s",
                (allowed_roles, document_id),
            )
        conn.commit()
        return row


def update_document_title(document_id: UUID, title: str) -> dict[str, Any] | None:
    """Renames a document."""
    with pool.connection() as conn:
        row = conn.execute(
            """
            UPDATE documents
            SET title = %s, updated_at = now()
            WHERE id = %s
            RETURNING *
            """,
            (title, document_id),
        ).fetchone()
        conn.commit()
        return row


def update_document_status(document_id: UUID, status: str, progress: int | None = None) -> None:
    """Updates a document's processing status (e.g. queued, processing, indexed,
    failed), and optionally its progress percentage in the same write.
    """
    with pool.connection() as conn:
        if progress is None:
            conn.execute(
                "UPDATE documents SET status = %s, updated_at = now() WHERE id = %s",
                (status, document_id),
            )
        else:
            conn.execute(
                "UPDATE documents SET status = %s, progress = %s, updated_at = now() WHERE id = %s",
                (status, progress, document_id),
            )
        conn.commit()


def update_document_progress(document_id: UUID, progress: int) -> None:
    """Updates only a document's progress percentage (0-100), without touching
    its status. Used to report incremental progress during embedding, the
    slowest step of ingestion for large documents.
    """
    with pool.connection() as conn:
        conn.execute(
            "UPDATE documents SET progress = %s, updated_at = now() WHERE id = %s",
            (progress, document_id),
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


# --- Conversations & messages (Phase 2 conversation memory / sidebar) ---


def create_conversation(user_email: str) -> dict[str, Any]:
    """Starts a new chat conversation record for a given user."""
    with pool.connection() as conn:
        row = conn.execute(
            "INSERT INTO conversations (user_email) VALUES (%s) RETURNING *",
            (user_email,),
        ).fetchone()
        conn.commit()
        return row


def get_conversation(conversation_id: UUID) -> dict[str, Any] | None:
    """Looks up a single conversation's details by its ID."""
    with pool.connection() as conn:
        return conn.execute(
            "SELECT * FROM conversations WHERE id = %s", (conversation_id,)
        ).fetchone()


def list_conversations(user_email: str) -> list[dict[str, Any]]:
    """Fetches all of a user's conversations for display in the sidebar.
    Pinned conversations are shown first, then most recently updated.
    """
    with pool.connection() as conn:
        return conn.execute(
            """
            SELECT id, title, is_pinned, updated_at FROM conversations
            WHERE user_email = %s
            ORDER BY is_pinned DESC, updated_at DESC
            """,
            (user_email,),
        ).fetchall()


def update_conversation_title(conversation_id: UUID, title: str) -> None:
    """Saves an auto-generated title for a conversation."""
    with pool.connection() as conn:
        conn.execute(
            "UPDATE conversations SET title = %s WHERE id = %s",
            (title, conversation_id),
        )
        conn.commit()


def update_conversation(
    conversation_id: UUID,
    *,
    title: str | None = None,
    is_pinned: bool | None = None,
) -> dict[str, Any] | None:
    """Updates one or both editable conversation fields and returns the row."""
    if title is None and is_pinned is None:
        return None

    sets: list[str] = []
    params: list[Any] = []

    if title is not None:
        sets.append("title = %s")
        params.append(title)
    if is_pinned is not None:
        sets.append("is_pinned = %s")
        params.append(is_pinned)

    sets.append("updated_at = now()")
    params.append(conversation_id)

    with pool.connection() as conn:
        row = conn.execute(
            f"""
            UPDATE conversations
            SET {", ".join(sets)}
            WHERE id = %s
            RETURNING id, title, is_pinned, updated_at
            """,
            tuple(params),
        ).fetchone()
        conn.commit()
        return row


def touch_conversation(conversation_id: UUID) -> None:
    """Marks a conversation as just updated, so it moves to the top of the recent list."""
    with pool.connection() as conn:
        conn.execute(
            "UPDATE conversations SET updated_at = now() WHERE id = %s",
            (conversation_id,),
        )
        conn.commit()


def delete_conversation(conversation_id: UUID) -> None:
    """Permanently removes a conversation and, via cascade, all of its messages."""
    with pool.connection() as conn:
        conn.execute("DELETE FROM conversations WHERE id = %s", (conversation_id,))  # cascades to messages
        conn.commit()


def insert_message(
    *,
    conversation_id: UUID,
    role: str,
    content: str,
    chart_config: dict[str, Any] | None = None,
    sources: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Saves one chat message (from the user or the assistant) into a conversation."""
    with pool.connection() as conn:
        row = conn.execute(
            """
            INSERT INTO messages (conversation_id, role, content, chart_config, sources)
            VALUES (%s, %s, %s, %s, %s)
            RETURNING *
            """,
            (
                conversation_id,
                role,
                content,
                Json(chart_config) if chart_config is not None else None,
                Json(sources) if sources is not None else None,
            ),
        ).fetchone()
        conn.commit()
        return row


def get_messages(conversation_id: UUID) -> list[dict[str, Any]]:
    """Fetches all messages in a conversation, in the order they were sent."""
    with pool.connection() as conn:
        return conn.execute(
            """
            SELECT id, role, content, chart_config, sources, created_at
            FROM messages
            WHERE conversation_id = %s
            ORDER BY created_at ASC
            """,
            (conversation_id,),
        ).fetchall()


def get_message(message_id: UUID) -> dict[str, Any] | None:
    """Looks up a single message's details by its ID."""
    with pool.connection() as conn:
        return conn.execute("SELECT * FROM messages WHERE id = %s", (message_id,)).fetchone()


def delete_messages_from(conversation_id: UUID, from_created_at: datetime) -> None:
    """Deletes a message and everything sent after it in the conversation, by
    timestamp. Used when an earlier question is edited: the old answer (and
    any later turns building on it) are no longer valid once the question
    changes.
    """
    with pool.connection() as conn:
        conn.execute(
            "DELETE FROM messages WHERE conversation_id = %s AND created_at >= %s",
            (conversation_id, from_created_at),
        )
        conn.commit()


def get_recent_messages(conversation_id: UUID, limit: int) -> list[dict[str, Any]]:
    """Last `limit` messages, oldest first — the window fed into condense_query
    and generate_answer as conversation history.
    """
    with pool.connection() as conn:
        return conn.execute(
            """
            SELECT role, content FROM (
                SELECT role, content, created_at FROM messages
                WHERE conversation_id = %s
                ORDER BY created_at DESC
                LIMIT %s
            ) recent
            ORDER BY created_at ASC
            """,
            (conversation_id, limit),
        ).fetchall()


# --- Login tokens (Phase 2 email magic-link login) ---


def insert_login_token(token: str, email: str, expires_at: datetime) -> None:
    """Stores a one-time magic-link login token for an email address."""
    with pool.connection() as conn:
        conn.execute(
            "INSERT INTO login_tokens (token, email, expires_at) VALUES (%s, %s, %s)",
            (token, email, expires_at),
        )
        conn.commit()


def get_login_token(token: str) -> dict[str, Any] | None:
    """Looks up a magic-link login token's details so it can be checked for validity."""
    with pool.connection() as conn:
        return conn.execute(
            "SELECT * FROM login_tokens WHERE token = %s", (token,)
        ).fetchone()


def mark_login_token_used(token: str) -> None:
    """Flags a magic-link login token as already used, so it can't be replayed."""
    with pool.connection() as conn:
        conn.execute("UPDATE login_tokens SET used = TRUE WHERE token = %s", (token,))
        conn.commit()
