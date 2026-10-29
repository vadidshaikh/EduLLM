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


def _record_event(
    conn: Any,
    document: dict[str, Any],
    action: str,
    actor_email: str,
    actor_name: str,
) -> None:
    """Appends one row to the document audit log. Always called on the
    caller's connection, before its commit, so the event and the change it
    describes land in the same transaction.
    """
    conn.execute(
        """
        INSERT INTO document_events
            (document_id, document_title, action, actor_email, actor_name, version)
        VALUES (%s, %s, %s, %s, %s, %s)
        """,
        (document["id"], document["title"], action, actor_email, actor_name, document["version"]),
    )


def _record_notification(
    conn: Any,
    document: dict[str, Any],
    kind: str,
    actor_email: str,
    actor_name: str,
    audience: list[str],
) -> None:
    """Creates one update/delete notice for everyone in `audience` (role
    names in Phase 1). Same transaction rule as `_record_event`.
    """
    conn.execute(
        """
        INSERT INTO notifications
            (kind, document_id, document_title, version, actor_email, actor_name, audience)
        VALUES (%s, %s, %s, %s, %s, %s, %s)
        """,
        (
            kind,
            document["id"],
            document["title"],
            document["version"],
            actor_email,
            actor_name,
            Json(sorted(set(audience))),
        ),
    )


def insert_document(
    *,
    title: str,
    filename: str,
    storage_path: str,
    allowed_roles: list[str],
    file_hash: str,
    actor_email: str,
    actor_name: str,
) -> dict[str, Any]:
    """Insert a new document, or if `title` already exists, bump its version
    and replace its file metadata (re-upload case). Chunks are handled
    separately by `replace_chunks` once ingestion finishes.

    A new document is logged as `uploaded`. A re-upload is logged as
    `updated` and notifies everyone who could see the old or the new version.
    """
    with pool.connection() as conn:
        existing = conn.execute(
            "SELECT id, version, allowed_roles FROM documents WHERE title = %s FOR UPDATE", (title,)
        ).fetchone()

        if existing:
            row = conn.execute(
                """
                UPDATE documents
                SET filename = %s, storage_path = %s, allowed_roles = %s,
                    file_hash = %s, status = 'queued', progress = 0, version = %s,
                    updated_by = %s, updated_at = now()
                WHERE id = %s
                RETURNING *
                """,
                (
                    filename,
                    storage_path,
                    allowed_roles,
                    file_hash,
                    existing["version"] + 1,
                    actor_email,
                    existing["id"],
                ),
            ).fetchone()
            _record_event(conn, row, "updated", actor_email, actor_name)
            _record_notification(
                conn, row, "updated", actor_email, actor_name, existing["allowed_roles"] + allowed_roles
            )
        else:
            row = conn.execute(
                """
                INSERT INTO documents
                    (title, filename, storage_path, allowed_roles, file_hash, uploaded_by)
                VALUES (%s, %s, %s, %s, %s, %s)
                RETURNING *
                """,
                (title, filename, storage_path, allowed_roles, file_hash, actor_email),
            ).fetchone()
            _record_event(conn, row, "uploaded", actor_email, actor_name)

        conn.commit()
        return row


def list_documents() -> list[dict[str, Any]]:
    """Fetches every uploaded document, newest first, with the display names
    of who uploaded and last updated it (falling back to the raw email for
    actors with no users row, e.g. bulk imports).
    """
    with pool.connection() as conn:
        return conn.execute(
            """
            SELECT d.*,
                   COALESCE(up.name, d.uploaded_by) AS uploaded_by_name,
                   COALESCE(ud.name, d.updated_by) AS updated_by_name
            FROM documents d
            LEFT JOIN users up ON up.email = d.uploaded_by
            LEFT JOIN users ud ON ud.email = d.updated_by
            ORDER BY d.uploaded_at DESC
            """
        ).fetchall()


def get_document(document_id: UUID) -> dict[str, Any] | None:
    """Looks up a single document's details by its ID."""
    with pool.connection() as conn:
        return conn.execute("SELECT * FROM documents WHERE id = %s", (document_id,)).fetchone()


def delete_document(document_id: UUID, *, actor_email: str, actor_name: str) -> dict[str, Any] | None:
    """Permanently removes a document record (chunks cascade), logs the
    delete and notifies everyone who could see it. Returns the deleted row,
    or None if it didn't exist.
    """
    with pool.connection() as conn:
        row = conn.execute("DELETE FROM documents WHERE id = %s RETURNING *", (document_id,)).fetchone()
        if row is not None:
            _record_event(conn, row, "deleted", actor_email, actor_name)
            _record_notification(conn, row, "deleted", actor_email, actor_name, row["allowed_roles"])
        conn.commit()
        return row


def update_document(
    document_id: UUID,
    *,
    title: str | None,
    allowed_roles: list[str] | None,
    actor_email: str,
    actor_name: str,
) -> dict[str, Any] | None:
    """Renames a document and/or changes which roles can access it, as one
    audited `updated` event. A roles change is propagated onto the existing
    chunks too (they carry a denormalized copy for `search_chunks`'s
    access-control check), so it takes effect immediately without
    re-ingestion. Everyone who could see the document before or after the
    change is notified.
    """
    with pool.connection() as conn:
        before = conn.execute(
            "SELECT allowed_roles FROM documents WHERE id = %s FOR UPDATE", (document_id,)
        ).fetchone()
        if before is None:
            return None

        row = conn.execute(
            """
            UPDATE documents
            SET title = COALESCE(%s, title),
                allowed_roles = COALESCE(%s, allowed_roles),
                updated_by = %s, updated_at = now()
            WHERE id = %s
            RETURNING *
            """,
            (title, allowed_roles, actor_email, document_id),
        ).fetchone()
        if allowed_roles is not None:
            conn.execute(
                "UPDATE chunks SET allowed_roles = %s WHERE document_id = %s",
                (allowed_roles, document_id),
            )
        _record_event(conn, row, "updated", actor_email, actor_name)
        _record_notification(
            conn, row, "updated", actor_email, actor_name, before["allowed_roles"] + row["allowed_roles"]
        )
        conn.commit()
        return row


def list_all_document_events(limit: int) -> list[dict[str, Any]]:
    """The most recent audit events across all documents, newest first,
    including documents that have since been deleted.
    """
    with pool.connection() as conn:
        return conn.execute(
            """
            SELECT id, document_id, document_title, action, actor_email, actor_name, version, created_at
            FROM document_events
            ORDER BY created_at DESC
            LIMIT %s
            """,
            (limit,),
        ).fetchall()


def list_document_events(document_id: UUID) -> list[dict[str, Any]]:
    """A document's audit history, newest first. Works for deleted
    documents too, since events aren't tied to the documents row.
    """
    with pool.connection() as conn:
        return conn.execute(
            """
            SELECT id, document_id, document_title, action, actor_email, actor_name, version, created_at
            FROM document_events
            WHERE document_id = %s
            ORDER BY created_at DESC
            """,
            (document_id,),
        ).fetchall()


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


# --- Users (Phase 1, mds/PLAN.md) ---


def upsert_user(
    *,
    email: str,
    name: str,
    role: str,
    dept: str | None,
    year: str | None,
    division: str | None,
) -> None:
    """Records a login. Role and email-derived fields are refreshed every
    time; `name` is only set on first login so a later edit isn't clobbered.
    """
    with pool.connection() as conn:
        conn.execute(
            """
            INSERT INTO users (email, name, role, dept, year, division)
            VALUES (%s, %s, %s, %s, %s, %s)
            ON CONFLICT (email) DO UPDATE
            SET role = EXCLUDED.role, dept = EXCLUDED.dept, year = EXCLUDED.year,
                division = EXCLUDED.division, last_login_at = now()
            """,
            (email, name, role, dept, year, division),
        )
        conn.commit()


def get_user(email: str) -> dict[str, Any] | None:
    """Looks up a user by email."""
    with pool.connection() as conn:
        return conn.execute("SELECT * FROM users WHERE email = %s", (email,)).fetchone()


# --- Notifications (Phase 1, mds/PLAN.md) ---
#
# Visibility is decided here and only here: a notification is shown to a
# user when its audience includes their role and they weren't the actor.
# There is deliberately no join-date filter, and no way to delete one.

_VISIBLE_TO_USER = "n.audience ? %(role)s AND n.actor_email <> %(email)s"


def list_notifications(email: str, role: str, limit: int) -> list[dict[str, Any]]:
    """The user's most recent notifications, newest first, each with whether
    they've read it.
    """
    with pool.connection() as conn:
        return conn.execute(
            f"""
            SELECT n.id, n.kind, n.document_id, n.document_title, n.version,
                   n.actor_name, n.created_at, r.read_at IS NOT NULL AS is_read
            FROM notifications n
            LEFT JOIN notification_reads r
                   ON r.notification_id = n.id AND r.user_email = %(email)s
            WHERE {_VISIBLE_TO_USER}
            ORDER BY n.created_at DESC
            LIMIT %(limit)s
            """,
            {"email": email, "role": role, "limit": limit},
        ).fetchall()


def count_unread_notifications(email: str, role: str) -> int:
    """How many of the user's visible notifications they haven't read."""
    with pool.connection() as conn:
        row = conn.execute(
            f"""
            SELECT count(*) AS unread
            FROM notifications n
            WHERE {_VISIBLE_TO_USER}
              AND NOT EXISTS (
                  SELECT 1 FROM notification_reads r
                  WHERE r.notification_id = n.id AND r.user_email = %(email)s
              )
            """,
            {"email": email, "role": role},
        ).fetchone()
        return row["unread"]


def mark_notifications_read(email: str, role: str, notification_id: UUID | None = None) -> None:
    """Marks one notification (or, with no id, all of them) read for the
    user. Only notifications visible to the user can be marked.
    """
    with pool.connection() as conn:
        conn.execute(
            f"""
            INSERT INTO notification_reads (notification_id, user_email)
            SELECT n.id, %(email)s FROM notifications n
            WHERE {_VISIBLE_TO_USER}
              AND (%(id)s::uuid IS NULL OR n.id = %(id)s::uuid)
            ON CONFLICT DO NOTHING
            """,
            {"email": email, "role": role, "id": notification_id},
        )
        conn.commit()
