"""All SQL for Edu LLM lives in this module — nowhere else issues a query.

`search_chunks` is the access-control enforcement point: the
`scope_ids && <user's scope ids>` predicate (backed by the GIN index on
chunks.scope_ids) is the only thing standing between a session and a chunk
it may not read. The user's scope ids come from `_user_scope_ids`, which
reads the membership tables on every call (not the JWT, since membership
changes during a session). Review changes to those two functions hardest.

Every connection from the pool defaults to dict_row (configured in
app/db/pool.py), so results here are dicts, not tuples.
"""
from __future__ import annotations

import secrets
from datetime import datetime
from typing import Any
from uuid import UUID

from pgvector import Vector
from psycopg.errors import ForeignKeyViolation, UniqueViolation
from psycopg.types.json import Json

from app.db.pool import pool

# Fixed scope ids for the institute library, mirrored in db/schema.sql.
# INSTITUTE is granted to everyone, ALL_FACULTY to every faculty member.
INSTITUTE_SCOPE = UUID("00000000-0000-0000-0000-000000000001")
ALL_FACULTY_SCOPE = UUID("00000000-0000-0000-0000-000000000002")

# No 0/O, 1/I/L: join codes are read off a projector and typed by hand.
_JOIN_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
_JOIN_CODE_LENGTH = 6


def _user_scope_ids(conn: Any, email: str, role: str) -> list[UUID]:
    """Every scope id the user can read, from the membership tables:
    faculty get the institute scopes plus each workspace they belong to;
    students get INSTITUTE plus each classroom they're in that isn't
    archived. `role` must come from the verified JWT.
    """
    if role == "faculty":
        rows = conn.execute(
            "SELECT workspace_id AS id FROM workspace_members WHERE user_email = %s", (email,)
        ).fetchall()
        return [INSTITUTE_SCOPE, ALL_FACULTY_SCOPE, *(r["id"] for r in rows)]

    rows = conn.execute(
        """
        SELECT cm.classroom_id AS id
        FROM classroom_members cm
        JOIN classrooms c ON c.id = cm.classroom_id
        WHERE cm.user_email = %s AND c.archived_at IS NULL
        """,
        (email,),
    ).fetchall()
    return [INSTITUTE_SCOPE, *(r["id"] for r in rows)]


def document_scope_ids(workspace_id: UUID | None, visibility: str, classroom_ids: list[UUID]) -> list[UUID]:
    """The scope ids a document (and each of its chunks) carries:
    institute library docs get INSTITUTE or ALL_FACULTY; workspace docs
    always get the workspace id (its faculty can read them) plus the ids of
    any classrooms they're published to.
    """
    if workspace_id is None:
        return [INSTITUTE_SCOPE] if visibility == "institute" else [ALL_FACULTY_SCOPE]
    if visibility == "classrooms":
        return [workspace_id, *classroom_ids]
    return [workspace_id]


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
            (document_id, document_title, action, actor_email, actor_name, version, workspace_id)
        VALUES (%s, %s, %s, %s, %s, %s, %s)
        """,
        (
            document["id"],
            document["title"],
            action,
            actor_email,
            actor_name,
            document["version"],
            document["workspace_id"],
        ),
    )


def _record_notification(
    conn: Any,
    document: dict[str, Any],
    kind: str,
    actor_email: str,
    actor_name: str,
    audience: list[UUID],
) -> None:
    """Creates one update/delete notice for everyone holding any of the
    `audience` scope ids. Same transaction rule as `_record_event`.
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
            Json(sorted({str(scope) for scope in audience})),
        ),
    )


def insert_document(
    *,
    title: str,
    filename: str,
    storage_path: str,
    workspace_id: UUID | None,
    visibility: str,
    classroom_ids: list[UUID],
    file_hash: str,
    actor_email: str,
    actor_name: str,
    document_id: UUID | None = None,
) -> dict[str, Any]:
    """Insert a new document, or if `title` already exists in the same
    workspace (or the institute library), bump its version and replace its
    file metadata and access (re-upload case). Chunks are handled separately
    by `replace_chunks` once ingestion finishes.

    With `document_id` (a published note being republished), that document
    is the one replaced, whatever its title was; its title becomes `title`.
    If it no longer exists, a new document is inserted.

    A new document is logged as `uploaded`. A re-upload is logged as
    `updated` and notifies everyone who could see the old or the new version.
    """
    scope_ids = document_scope_ids(workspace_id, visibility, classroom_ids)
    with pool.connection() as conn:
        if document_id is not None:
            existing = conn.execute(
                "SELECT id, version, scope_ids FROM documents WHERE id = %s FOR UPDATE", (document_id,)
            ).fetchone()
        else:
            existing = conn.execute(
                """
                SELECT id, version, scope_ids FROM documents
                WHERE title = %s AND workspace_id IS NOT DISTINCT FROM %s
                FOR UPDATE
                """,
                (title, workspace_id),
            ).fetchone()

        if existing:
            row = conn.execute(
                """
                UPDATE documents
                SET title = %s, filename = %s, storage_path = %s, visibility = %s, classroom_ids = %s,
                    scope_ids = %s, file_hash = %s, status = 'queued', progress = 0, version = %s,
                    updated_by = %s, updated_at = now()
                WHERE id = %s
                RETURNING *
                """,
                (
                    title,
                    filename,
                    storage_path,
                    visibility,
                    classroom_ids,
                    scope_ids,
                    file_hash,
                    existing["version"] + 1,
                    actor_email,
                    existing["id"],
                ),
            ).fetchone()
            _record_event(conn, row, "updated", actor_email, actor_name)
            _record_notification(
                conn, row, "updated", actor_email, actor_name, existing["scope_ids"] + scope_ids
            )
        else:
            row = conn.execute(
                """
                INSERT INTO documents
                    (title, filename, storage_path, workspace_id, visibility, classroom_ids,
                     scope_ids, file_hash, uploaded_by)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                RETURNING *
                """,
                (
                    title,
                    filename,
                    storage_path,
                    workspace_id,
                    visibility,
                    classroom_ids,
                    scope_ids,
                    file_hash,
                    actor_email,
                ),
            ).fetchone()
            _record_event(conn, row, "uploaded", actor_email, actor_name)

        conn.commit()
        return row


def list_documents(workspace_id: UUID | None) -> list[dict[str, Any]]:
    """Fetches every document in one workspace (or, with None, the institute
    library), newest first, with the display names of who uploaded and last
    updated it (falling back to the raw email for actors with no users row,
    e.g. bulk imports).
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
            WHERE d.workspace_id IS NOT DISTINCT FROM %s
            ORDER BY d.uploaded_at DESC
            """,
            (workspace_id,),
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
            _record_notification(conn, row, "deleted", actor_email, actor_name, row["scope_ids"])
        conn.commit()
        return row


def update_document(
    document_id: UUID,
    *,
    title: str | None,
    visibility: str | None,
    classroom_ids: list[UUID] | None,
    actor_email: str,
    actor_name: str,
) -> dict[str, Any] | None:
    """Renames a document and/or changes who can read it, as one audited
    `updated` event. `visibility` and `classroom_ids` change together (None
    = leave access as is). An access change rewrites the scope ids on the
    existing chunks too (they carry a denormalized copy for
    `search_chunks`), so it takes effect immediately without re-embedding.
    Everyone who could see the document before or after is notified.
    """
    with pool.connection() as conn:
        before = conn.execute(
            "SELECT workspace_id, scope_ids FROM documents WHERE id = %s FOR UPDATE", (document_id,)
        ).fetchone()
        if before is None:
            return None

        scope_ids = None
        if visibility is not None:
            scope_ids = document_scope_ids(before["workspace_id"], visibility, classroom_ids or [])

        row = conn.execute(
            """
            UPDATE documents
            SET title = COALESCE(%s, title),
                visibility = COALESCE(%s, visibility),
                classroom_ids = COALESCE(%s, classroom_ids),
                scope_ids = COALESCE(%s, scope_ids),
                updated_by = %s, updated_at = now()
            WHERE id = %s
            RETURNING *
            """,
            (
                title,
                visibility,
                (classroom_ids or []) if visibility is not None else None,
                scope_ids,
                actor_email,
                document_id,
            ),
        ).fetchone()
        if scope_ids is not None:
            conn.execute(
                "UPDATE chunks SET scope_ids = %s WHERE document_id = %s",
                (scope_ids, document_id),
            )
        _record_event(conn, row, "updated", actor_email, actor_name)
        _record_notification(
            conn, row, "updated", actor_email, actor_name, before["scope_ids"] + row["scope_ids"]
        )
        conn.commit()
        return row


def list_all_document_events(workspace_id: UUID | None, limit: int) -> list[dict[str, Any]]:
    """The most recent audit events for one workspace (or, with None, the
    institute library), newest first, including documents that have since
    been deleted.
    """
    with pool.connection() as conn:
        return conn.execute(
            """
            SELECT id, document_id, document_title, action, actor_email, actor_name, version,
                   workspace_id, created_at
            FROM document_events
            WHERE workspace_id IS NOT DISTINCT FROM %s
            ORDER BY created_at DESC
            LIMIT %s
            """,
            (workspace_id, limit),
        ).fetchall()


def list_document_events(document_id: UUID) -> list[dict[str, Any]]:
    """A document's audit history, newest first. Works for deleted
    documents too, since events aren't tied to the documents row.
    """
    with pool.connection() as conn:
        return conn.execute(
            """
            SELECT id, document_id, document_title, action, actor_email, actor_name, version,
                   workspace_id, created_at
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


def replace_chunks(document_id: UUID, chunks: list[dict[str, Any]]) -> None:
    """Delete existing chunks for this document and insert the new set,
    tagged with the document's current scope ids. The document row is
    locked while doing so, so an access change made while ingestion was
    running can't be overwritten with the scope ids it started with.
    `chunks` items: {"chunk_text": str, "chunk_index": int, "embedding": list[float]}
    """
    with pool.connection() as conn:
        document = conn.execute(
            "SELECT scope_ids FROM documents WHERE id = %s FOR UPDATE", (document_id,)
        ).fetchone()
        if document is None:  # deleted while ingesting
            return
        conn.execute("DELETE FROM chunks WHERE document_id = %s", (document_id,))
        conn.cursor().executemany(
            """
            INSERT INTO chunks (document_id, chunk_text, chunk_index, embedding, scope_ids)
            VALUES (%s, %s, %s, %s, %s)
            """,
            [
                (
                    document_id,
                    c["chunk_text"],
                    c["chunk_index"],
                    Vector(c["embedding"]),
                    document["scope_ids"],
                )
                for c in chunks
            ],
        )
        conn.commit()


def _readable_scopes(conn: Any, email: str, role: str, scope_id: UUID | None) -> list[UUID]:
    """The scope ids a read may match: all of the user's, or just
    `scope_id` when one is picked and the user actually holds it (otherwise
    none). INSTITUTE_SCOPE stands for the whole institute library, so it
    selects both institute-wide scopes the user holds (ALL_FACULTY too, for
    faculty). Shared by `search_chunks` and `list_readable_documents` so the
    chat and the shelf can never disagree about what a user can read.
    """
    scopes = _user_scope_ids(conn, email, role)
    if scope_id == INSTITUTE_SCOPE:
        return [s for s in scopes if s in (INSTITUTE_SCOPE, ALL_FACULTY_SCOPE)]
    if scope_id is not None:
        return [scope_id] if scope_id in scopes else []
    return scopes


def list_readable_documents(*, email: str, role: str, scope_id: UUID | None = None) -> list[dict[str, Any]]:
    """The indexed documents the user can read (the books the chat can
    answer from), optionally narrowed to one workspace or classroom, by
    title. Same access rule as `search_chunks`, applied to documents.scope_ids.
    """
    with pool.connection() as conn:
        scopes = _readable_scopes(conn, email, role, scope_id)
        if not scopes:
            return []
        return conn.execute(
            """
            SELECT id, title, filename FROM documents
            WHERE scope_ids && %s::uuid[] AND status = 'indexed'
            ORDER BY lower(title)
            """,
            (scopes,),
        ).fetchall()


def get_readable_document(document_id: UUID, *, email: str, role: str) -> dict[str, Any] | None:
    """The document if the user can read it (the same scope rule as the
    shelf and the chat), otherwise None.
    """
    with pool.connection() as conn:
        scopes = _user_scope_ids(conn, email, role)
        return conn.execute(
            "SELECT * FROM documents WHERE id = %s AND scope_ids && %s::uuid[]", (document_id, scopes)
        ).fetchone()


def search_chunks(
    *,
    email: str,
    role: str,
    embedding: list[float],
    top_k: int,
    scope_id: UUID | None = None,
) -> list[dict[str, Any]]:
    """Scope-filtered vector search. The WHERE clause is the entire access
    control boundary: a chunk whose scope ids don't overlap the user's is
    never returned, and therefore never reaches the LLM's context.

    `scope_id` (a workspace or classroom picked in the chat) narrows the
    search to that one scope; it only counts if the user actually holds it,
    otherwise nothing is returned.

    Iterative index scans stop the ivfflat index from returning fewer than
    `top_k` rows when most of the nearest chunks are filtered out.
    """
    with pool.connection() as conn:
        scopes = _readable_scopes(conn, email, role, scope_id)
        if not scopes:
            return []

        conn.execute("SET LOCAL ivfflat.iterative_scan = relaxed_order")
        return conn.execute(
            """
            WITH hits AS MATERIALIZED (
                SELECT c.id, c.chunk_text, c.chunk_index, c.document_id,
                       c.embedding <=> %s AS distance
                FROM chunks c
                WHERE c.scope_ids && %s::uuid[]
                ORDER BY distance
                LIMIT %s
            )
            SELECT h.id, h.chunk_text, h.chunk_index, h.document_id, d.title
            FROM hits h
            JOIN documents d ON d.id = h.document_id
            ORDER BY h.distance
            """,
            (Vector(embedding), scopes, top_k),
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
    `doc_ids` holds up to three documents its answers used, most recently
    used first (the sidebar draws them as the conversation's stack of docs).
    """
    with pool.connection() as conn:
        return conn.execute(
            """
            SELECT c.id, c.title, c.is_pinned, c.updated_at,
                   COALESCE((
                       SELECT array_agg(used.doc_id ORDER BY used.last_used DESC)
                       FROM (
                           SELECT s->>'doc_id' AS doc_id, max(m.created_at) AS last_used
                           FROM messages m
                           CROSS JOIN LATERAL jsonb_array_elements(
                               CASE WHEN jsonb_typeof(m.sources) = 'array' THEN m.sources ELSE '[]' END
                           ) AS s
                           WHERE m.conversation_id = c.id AND m.role = 'assistant'
                           GROUP BY 1
                           ORDER BY last_used DESC
                           LIMIT 3
                       ) used
                   ), '{}') AS doc_ids
            FROM conversations c
            WHERE c.user_email = %s
            ORDER BY c.is_pinned DESC, c.updated_at DESC
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


# --- Notifications (Phase 1, mds/PLAN.md; scope-based audience since Phase 2) ---
#
# Visibility is decided here and only here: a notification is shown to a
# user when its audience shares a scope id with them and they weren't the
# actor. There is deliberately no join-date filter, and no way to delete one.

_VISIBLE_TO_USER = "n.audience ?| %(scopes)s::text[] AND n.actor_email <> %(email)s"


def _notification_params(conn: Any, email: str, role: str, **extra: Any) -> dict[str, Any]:
    scopes = [str(scope) for scope in _user_scope_ids(conn, email, role)]
    return {"email": email, "scopes": scopes, **extra}


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
            _notification_params(conn, email, role, limit=limit),
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
            _notification_params(conn, email, role),
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
            _notification_params(conn, email, role, id=notification_id),
        )
        conn.commit()


# --- Workspaces (Phase 2, mds/PLAN.md) ---
#
# Membership in a workspace is what grants a faculty member its scope id
# (see _user_scope_ids). These functions don't check who is asking; the API
# layer (app/api/workspaces.py) does that before calling them.

_PERSONAL_WORKSPACE_NAME = "My workspace"

_WORKSPACE_COLUMNS = """
    w.id, w.name, w.kind, w.owner_email, w.created_at, m.role AS my_role,
    (SELECT count(*) FROM workspace_members wm WHERE wm.workspace_id = w.id) AS member_count,
    (SELECT count(*) FROM classrooms c
     WHERE c.workspace_id = w.id AND c.archived_at IS NULL) AS classroom_count
"""


def ensure_personal_workspace(email: str) -> None:
    """Creates the faculty member's personal workspace if they don't have
    one yet. Safe to call on every login.
    """
    with pool.connection() as conn:
        row = conn.execute(
            """
            INSERT INTO workspaces (name, kind, owner_email)
            VALUES (%s, 'personal', %s)
            ON CONFLICT (owner_email) WHERE kind = 'personal' DO NOTHING
            RETURNING id
            """,
            (_PERSONAL_WORKSPACE_NAME, email),
        ).fetchone()
        if row is not None:
            conn.execute(
                """
                INSERT INTO workspace_members (workspace_id, user_email, role, added_by)
                VALUES (%s, %s, 'owner', %s)
                """,
                (row["id"], email, email),
            )
        conn.commit()


def list_workspaces(email: str) -> list[dict[str, Any]]:
    """Every workspace the user is a member of: personal first, then shared
    ones by name, each with the user's role and member/classroom counts.
    """
    with pool.connection() as conn:
        return conn.execute(
            f"""
            SELECT {_WORKSPACE_COLUMNS}
            FROM workspace_members m
            JOIN workspaces w ON w.id = m.workspace_id
            WHERE m.user_email = %s
            ORDER BY w.kind = 'personal' DESC, lower(w.name)
            """,
            (email,),
        ).fetchall()


def get_member_workspace(workspace_id: UUID, email: str) -> dict[str, Any] | None:
    """The workspace, with the user's role in it, or None if it doesn't
    exist or the user isn't a member.
    """
    with pool.connection() as conn:
        return conn.execute(
            f"""
            SELECT {_WORKSPACE_COLUMNS}
            FROM workspace_members m
            JOIN workspaces w ON w.id = m.workspace_id
            WHERE m.workspace_id = %s AND m.user_email = %s
            """,
            (workspace_id, email),
        ).fetchone()


def create_shared_workspace(name: str, owner_email: str) -> UUID:
    """Creates a shared workspace with `owner_email` as its owner."""
    with pool.connection() as conn:
        row = conn.execute(
            "INSERT INTO workspaces (name, kind, owner_email) VALUES (%s, 'shared', %s) RETURNING id",
            (name, owner_email),
        ).fetchone()
        conn.execute(
            """
            INSERT INTO workspace_members (workspace_id, user_email, role, added_by)
            VALUES (%s, %s, 'owner', %s)
            """,
            (row["id"], owner_email, owner_email),
        )
        conn.commit()
        return row["id"]


def rename_workspace(workspace_id: UUID, name: str) -> None:
    with pool.connection() as conn:
        conn.execute("UPDATE workspaces SET name = %s WHERE id = %s", (name, workspace_id))
        conn.commit()


def delete_workspace(workspace_id: UUID) -> bool:
    """Deletes a workspace with its members and classrooms, but only if it
    has no documents or notes left. Returns whether it was deleted.
    """
    with pool.connection() as conn:
        row = conn.execute(
            """
            DELETE FROM workspaces w
            WHERE w.id = %s
              AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.workspace_id = w.id)
              AND NOT EXISTS (SELECT 1 FROM notes n WHERE n.workspace_id = w.id)
            RETURNING id
            """,
            (workspace_id,),
        ).fetchone()
        conn.commit()
        return row is not None


def list_workspace_members(workspace_id: UUID) -> list[dict[str, Any]]:
    """The workspace's faculty, owner first. `name` is null for people who
    were added but haven't signed in yet.
    """
    with pool.connection() as conn:
        return conn.execute(
            """
            SELECT m.user_email AS email, u.name, m.role, m.added_by, m.added_at
            FROM workspace_members m
            LEFT JOIN users u ON u.email = m.user_email
            WHERE m.workspace_id = %s
            ORDER BY m.role = 'owner' DESC, m.added_at
            """,
            (workspace_id,),
        ).fetchall()


def add_workspace_member(workspace_id: UUID, email: str, added_by: str) -> bool:
    """Adds a faculty member as an editor. Returns False if they were
    already a member.
    """
    with pool.connection() as conn:
        row = conn.execute(
            """
            INSERT INTO workspace_members (workspace_id, user_email, role, added_by)
            VALUES (%s, %s, 'editor', %s)
            ON CONFLICT DO NOTHING
            RETURNING user_email
            """,
            (workspace_id, email, added_by),
        ).fetchone()
        conn.commit()
        return row is not None


def remove_workspace_member(workspace_id: UUID, email: str) -> bool:
    """Removes an editor (never the owner). Returns whether a row went."""
    with pool.connection() as conn:
        row = conn.execute(
            """
            DELETE FROM workspace_members
            WHERE workspace_id = %s AND user_email = %s AND role <> 'owner'
            RETURNING user_email
            """,
            (workspace_id, email),
        ).fetchone()
        conn.commit()
        return row is not None


# --- Classrooms (Phase 2, mds/PLAN.md) ---
#
# Membership in a classroom is what grants a student its scope id. Same
# rule as workspaces: callers check permissions first.

_CLASSROOM_COLUMNS = """
    c.id, c.workspace_id, c.name, c.subject, c.term, c.join_code, c.created_by,
    c.created_at, c.archived_at,
    (SELECT count(*) FROM classroom_members cm WHERE cm.classroom_id = c.id) AS student_count
"""


def _new_join_code() -> str:
    return "".join(secrets.choice(_JOIN_CODE_ALPHABET) for _ in range(_JOIN_CODE_LENGTH))


def list_classrooms(workspace_id: UUID) -> list[dict[str, Any]]:
    """A workspace's classrooms, active ones first, then by name."""
    with pool.connection() as conn:
        return conn.execute(
            f"""
            SELECT {_CLASSROOM_COLUMNS}
            FROM classrooms c
            WHERE c.workspace_id = %s
            ORDER BY c.archived_at IS NOT NULL, lower(c.name)
            """,
            (workspace_id,),
        ).fetchall()


def get_classroom(classroom_id: UUID) -> dict[str, Any] | None:
    with pool.connection() as conn:
        return conn.execute(
            f"SELECT {_CLASSROOM_COLUMNS} FROM classrooms c WHERE c.id = %s", (classroom_id,)
        ).fetchone()


def create_classroom(
    *, workspace_id: UUID, name: str, subject: str | None, term: str | None, created_by: str
) -> dict[str, Any]:
    """Creates a classroom with a fresh join code, retrying on the (rare)
    collision with an existing code.
    """
    for _ in range(5):
        try:
            with pool.connection() as conn:
                row = conn.execute(
                    """
                    INSERT INTO classrooms (workspace_id, name, subject, term, join_code, created_by)
                    VALUES (%s, %s, %s, %s, %s, %s)
                    RETURNING id
                    """,
                    (workspace_id, name, subject, term, _new_join_code(), created_by),
                ).fetchone()
                conn.commit()
            return get_classroom(row["id"])
        except UniqueViolation:
            continue
    raise RuntimeError("could not generate a unique join code")


def update_classroom(
    classroom_id: UUID,
    *,
    name: str | None = None,
    subject: str | None = None,
    term: str | None = None,
    archived: bool | None = None,
) -> dict[str, Any] | None:
    """Edits a classroom's details and/or archives / restores it. Fields
    left as None are unchanged; pass "" to clear subject or term.
    Archiving takes students' access away at once (see _user_scope_ids).
    """
    with pool.connection() as conn:
        conn.execute(
            """
            UPDATE classrooms
            SET name = COALESCE(%(name)s, name),
                subject = CASE WHEN %(subject)s::text IS NULL THEN subject ELSE NULLIF(%(subject)s, '') END,
                term = CASE WHEN %(term)s::text IS NULL THEN term ELSE NULLIF(%(term)s, '') END,
                archived_at = CASE
                    WHEN %(archived)s::boolean IS NULL THEN archived_at
                    WHEN %(archived)s THEN COALESCE(archived_at, now())
                    ELSE NULL
                END
            WHERE id = %(id)s
            """,
            {"id": classroom_id, "name": name, "subject": subject, "term": term, "archived": archived},
        )
        conn.commit()
    return get_classroom(classroom_id)


def regenerate_join_code(classroom_id: UUID) -> dict[str, Any] | None:
    """Replaces a classroom's join code, e.g. after it leaked. Students
    who already joined stay in.
    """
    for _ in range(5):
        try:
            with pool.connection() as conn:
                conn.execute(
                    "UPDATE classrooms SET join_code = %s WHERE id = %s",
                    (_new_join_code(), classroom_id),
                )
                conn.commit()
            return get_classroom(classroom_id)
        except UniqueViolation:
            continue
    raise RuntimeError("could not generate a unique join code")


def list_classroom_students(classroom_id: UUID) -> list[dict[str, Any]]:
    """A classroom's students by email. `name` is null for students who
    were added by a teacher but haven't signed in yet.
    """
    with pool.connection() as conn:
        return conn.execute(
            """
            SELECT cm.user_email AS email, u.name, cm.added_by, cm.joined_at
            FROM classroom_members cm
            LEFT JOIN users u ON u.email = cm.user_email
            WHERE cm.classroom_id = %s
            ORDER BY cm.user_email
            """,
            (classroom_id,),
        ).fetchall()


def add_classroom_students(classroom_id: UUID, emails: list[str], added_by: str) -> int:
    """Bulk-adds students. Returns how many were new to the classroom."""
    with pool.connection() as conn:
        added = 0
        for email in emails:
            row = conn.execute(
                """
                INSERT INTO classroom_members (classroom_id, user_email, added_by)
                VALUES (%s, %s, %s)
                ON CONFLICT DO NOTHING
                RETURNING user_email
                """,
                (classroom_id, email, added_by),
            ).fetchone()
            added += row is not None
        conn.commit()
        return added


def remove_classroom_student(classroom_id: UUID, email: str) -> bool:
    with pool.connection() as conn:
        row = conn.execute(
            "DELETE FROM classroom_members WHERE classroom_id = %s AND user_email = %s RETURNING user_email",
            (classroom_id, email),
        ).fetchone()
        conn.commit()
        return row is not None


def find_active_classroom_by_code(join_code: str) -> dict[str, Any] | None:
    """The non-archived classroom with this join code, if any."""
    with pool.connection() as conn:
        return conn.execute(
            f"SELECT {_CLASSROOM_COLUMNS} FROM classrooms c WHERE c.join_code = %s AND c.archived_at IS NULL",
            (join_code,),
        ).fetchone()


def list_student_classrooms(email: str) -> list[dict[str, Any]]:
    """The non-archived classrooms a student is in, with each one's
    workspace name, by name.
    """
    with pool.connection() as conn:
        return conn.execute(
            f"""
            SELECT {_CLASSROOM_COLUMNS}, w.name AS workspace_name
            FROM classroom_members m
            JOIN classrooms c ON c.id = m.classroom_id
            JOIN workspaces w ON w.id = c.workspace_id
            WHERE m.user_email = %s AND c.archived_at IS NULL
            ORDER BY lower(c.name)
            """,
            (email,),
        ).fetchall()


# --- Notes and slide decks (Phase 3, mds/PLAN.md) ---
#
# Same rule as workspaces: callers check the user is a member of the note's
# workspace first. A note's sources can only be its workspace's documents or
# the institute library's (checked in app/api/notes.py), and generation reads
# them through `search_source_chunks`, which applies the user's scope ids
# like `search_chunks` does.

_NOTE_COLUMNS = """
    n.*,
    COALESCE(uc.name, n.created_by) AS created_by_name,
    COALESCE(uu.name, n.updated_by) AS updated_by_name,
    d.status AS document_status, d.progress AS document_progress,
    d.visibility AS document_visibility, d.classroom_ids AS document_classroom_ids
"""

_NOTE_JOINS = """
    LEFT JOIN users uc ON uc.email = n.created_by
    LEFT JOIN users uu ON uu.email = n.updated_by
    LEFT JOIN documents d ON d.id = n.document_id
"""


def list_note_source_documents(workspace_id: UUID) -> list[dict[str, Any]]:
    """The indexed documents a note in this workspace can be written from:
    the workspace's own, then the institute library's, each by title.
    """
    with pool.connection() as conn:
        return conn.execute(
            """
            SELECT id, title, version, workspace_id, visibility FROM documents
            WHERE (workspace_id = %s OR workspace_id IS NULL) AND status = 'indexed'
            ORDER BY workspace_id IS NULL, lower(title)
            """,
            (workspace_id,),
        ).fetchall()


def get_documents(document_ids: list[UUID]) -> list[dict[str, Any]]:
    """The given documents that still exist (any order)."""
    if not document_ids:
        return []
    with pool.connection() as conn:
        return conn.execute(
            "SELECT id, title, version, workspace_id, status FROM documents WHERE id = ANY(%s)",
            (document_ids,),
        ).fetchall()


def search_source_chunks(
    *,
    email: str,
    role: str,
    embedding: list[float],
    document_ids: list[UUID],
    per_document: int,
) -> list[dict[str, Any]]:
    """The `per_document` chunks of each given document closest to
    `embedding`, in document order then reading order, for writing notes
    from those documents. The scope filter is the same as `search_chunks`':
    a document the user can't read contributes nothing.
    """
    if not document_ids:
        return []
    with pool.connection() as conn:
        scopes = _user_scope_ids(conn, email, role)
        return conn.execute(
            """
            SELECT r.id, r.document_id, r.chunk_index, r.chunk_text
            FROM (
                SELECT c.id, c.document_id, c.chunk_index, c.chunk_text,
                       row_number() OVER (PARTITION BY c.document_id ORDER BY c.embedding <=> %s) AS rank
                FROM chunks c
                WHERE c.document_id = ANY(%s) AND c.scope_ids && %s::uuid[]
            ) r
            WHERE r.rank <= %s
            ORDER BY array_position(%s, r.document_id), r.chunk_index
            """,
            (Vector(embedding), document_ids, scopes, per_document, document_ids),
        ).fetchall()


def _with_source_status(conn: Any, notes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Adds `source_status` to each note: one entry per source with the
    version used, the document's current version (None once deleted) and
    whether it changed since. `stale` is true when any source changed.
    """
    ids = {s["doc_id"] for n in notes for s in n["sources"]}
    current = {}
    if ids:
        rows = conn.execute(
            "SELECT id, title, version FROM documents WHERE id = ANY(%s::uuid[])", (list(ids),)
        ).fetchall()
        current = {str(r["id"]): r for r in rows}
    for note in notes:
        status = []
        for source in note["sources"]:
            doc = current.get(source["doc_id"])
            status.append(
                {
                    "doc_id": source["doc_id"],
                    "title": doc["title"] if doc else source["title"],
                    "used_version": source["version"],
                    "current_version": doc["version"] if doc else None,
                    "changed": doc is None or doc["version"] != source["version"],
                }
            )
        note["source_status"] = status
        note["stale"] = any(s["changed"] for s in status)
    return notes


def list_notes(workspace_id: UUID) -> list[dict[str, Any]]:
    """A workspace's slide decks, most recently edited first. The body
    and slides are left out; `get_note` has them.
    """
    with pool.connection() as conn:
        rows = conn.execute(
            f"""
            SELECT {_NOTE_COLUMNS}, jsonb_array_length(n.slides) AS slide_count
            FROM notes n {_NOTE_JOINS}
            WHERE n.workspace_id = %s AND n.kind = 'slides'
            ORDER BY n.updated_at DESC
            """,
            (workspace_id,),
        ).fetchall()
        for row in rows:
            row.pop("body_md")
            row.pop("slides")
        return _with_source_status(conn, rows)


def get_note(note_id: UUID) -> dict[str, Any] | None:
    with pool.connection() as conn:
        row = conn.execute(
            f"SELECT {_NOTE_COLUMNS} FROM notes n {_NOTE_JOINS} WHERE n.id = %s AND n.kind = 'slides'",
            (note_id,),
        ).fetchone()
        return _with_source_status(conn, [row])[0] if row else None


def insert_note(
    *,
    workspace_id: UUID,
    kind: str,
    title: str,
    subject: str | None,
    topic: str,
    body_md: str,
    slides: list[dict[str, Any]],
    sources: list[dict[str, Any]],
    actor_email: str,
) -> UUID:
    with pool.connection() as conn:
        row = conn.execute(
            """
            INSERT INTO notes
                (workspace_id, kind, title, subject, topic, body_md, slides, sources, created_by, updated_by)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING id
            """,
            (
                workspace_id,
                kind,
                title,
                subject,
                topic,
                body_md,
                Json(slides),
                Json(sources),
                actor_email,
                actor_email,
            ),
        ).fetchone()
        conn.commit()
        return row["id"]


_NOTE_EDITABLE = ("title", "subject", "topic", "body_md", "slides", "sources")


def update_note(
    note_id: UUID, changes: dict[str, Any], *, base_updated_at: datetime, actor_email: str
) -> bool:
    """Saves an edit, but only if nobody else saved the note since the
    editor loaded it (`base_updated_at`), so one faculty member can't
    silently overwrite another's changes. Returns whether it was saved.
    """
    fields = [f for f in _NOTE_EDITABLE if f in changes]
    values = [Json(changes[f]) if f in ("slides", "sources") else changes[f] for f in fields]
    assignments = "".join(f"{f} = %s, " for f in fields)
    with pool.connection() as conn:
        row = conn.execute(
            f"""
            UPDATE notes SET {assignments}updated_by = %s, updated_at = now()
            WHERE id = %s AND updated_at = %s
            RETURNING id
            """,
            (*values, actor_email, note_id, base_updated_at),
        ).fetchone()
        conn.commit()
        return row is not None


def set_note_published(note_id: UUID, document_id: UUID) -> None:
    """Links a note to the document it was published as. Doesn't touch
    updated_at: publishing isn't an edit.
    """
    with pool.connection() as conn:
        conn.execute(
            "UPDATE notes SET document_id = %s, published_at = now() WHERE id = %s",
            (document_id, note_id),
        )
        conn.commit()


def delete_note(note_id: UUID) -> None:
    """Deletes the note. A document it was published as stays in the library."""
    with pool.connection() as conn:
        conn.execute("DELETE FROM notes WHERE id = %s", (note_id,))
        conn.commit()


def find_document_by_title(workspace_id: UUID, title: str) -> dict[str, Any] | None:
    """The workspace's document with this exact title, if any (uploads with
    an existing title replace that document)."""
    with pool.connection() as conn:
        return conn.execute(
            "SELECT id, title FROM documents WHERE workspace_id = %s AND title = %s", (workspace_id, title)
        ).fetchone()


# --- Question bank, quizzes and assignments (Phase 4, mds/PLAN.md) ---
#
# Same rule as notes: callers check the user is faculty in the question's
# workspace / the assessment's classroom's workspace first. The student
# functions check classroom membership themselves and never return answers.

_QUESTION_COLUMNS = """
    q.id, q.workspace_id, q.subject, q.topic, q.type, q.difficulty, q.body, q.answer,
    q.source_chunk_ids, q.source_doc_ids, q.status, q.created_by, q.updated_by,
    q.created_at, q.updated_at,
    COALESCE(uc.name, q.created_by) AS created_by_name,
    (SELECT count(DISTINCT ai.assessment_id) FROM assessment_items ai WHERE ai.question_id = q.id) AS use_count
"""


def list_question_prompts(workspace_id: UUID, *, limit: int) -> list[str]:
    """The prompts of the workspace's most recent questions."""
    with pool.connection() as conn:
        rows = conn.execute(
            """
            SELECT body->>'prompt' AS prompt FROM questions
            WHERE workspace_id = %s
            ORDER BY created_at DESC LIMIT %s
            """,
            (workspace_id, limit),
        ).fetchall()
        return [r["prompt"] for r in rows]


def workspace_subjects(workspace_id: UUID) -> list[str]:
    """The subjects in use in a workspace (its active classrooms' and its
    question bank's), most used first, one spelling each: the classrooms'
    when both have it, since quizzes match questions to a classroom's subject.
    """
    with pool.connection() as conn:
        rows = conn.execute(
            """
            SELECT (array_agg(subject ORDER BY from_classroom DESC))[1] AS subject
            FROM (
                SELECT subject, true AS from_classroom FROM classrooms
                WHERE workspace_id = %(ws)s AND archived_at IS NULL AND subject IS NOT NULL
                UNION ALL
                SELECT subject, false FROM questions WHERE workspace_id = %(ws)s
            ) s
            GROUP BY lower(subject)
            ORDER BY count(*) DESC, lower(subject)
            """,
            {"ws": workspace_id},
        ).fetchall()
        return [r["subject"] for r in rows]


def most_similar_question(
    workspace_id: UUID, embedding: list[float], *, exclude_id: UUID | None = None
) -> dict[str, Any] | None:
    """The workspace's question closest to `embedding` (any subject), with
    its cosine similarity.
    """
    with pool.connection() as conn:
        return conn.execute(
            """
            SELECT id, body->>'prompt' AS prompt, 1 - (embedding <=> %s) AS similarity
            FROM questions
            WHERE workspace_id = %s AND id IS DISTINCT FROM %s
            ORDER BY embedding <=> %s
            LIMIT 1
            """,
            (Vector(embedding), workspace_id, exclude_id, Vector(embedding)),
        ).fetchone()


def insert_questions(*, workspace_id: UUID, questions: list[dict[str, Any]], actor_email: str) -> list[UUID]:
    """Adds questions to the bank as drafts. Each carries its own subject and topic."""
    with pool.connection() as conn:
        ids = []
        for q in questions:
            row = conn.execute(
                """
                INSERT INTO questions (workspace_id, subject, topic, type, difficulty, body, answer,
                                       source_chunk_ids, source_doc_ids, embedding, created_by, updated_by)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                RETURNING id
                """,
                (
                    workspace_id,
                    q["subject"],
                    q["topic"],
                    q["type"],
                    q["difficulty"],
                    Json(q["body"]),
                    Json(q["answer"]),
                    q.get("source_chunk_ids", []),
                    q.get("source_doc_ids", []),
                    Vector(q["embedding"]),
                    actor_email,
                    actor_email,
                ),
            ).fetchone()
            ids.append(row["id"])
        conn.commit()
        return ids


def list_questions(workspace_id: UUID) -> list[dict[str, Any]]:
    """The workspace's bank, newest first."""
    with pool.connection() as conn:
        return conn.execute(
            f"""
            SELECT {_QUESTION_COLUMNS}
            FROM questions q LEFT JOIN users uc ON uc.email = q.created_by
            WHERE q.workspace_id = %s
            ORDER BY q.created_at DESC, q.id
            """,
            (workspace_id,),
        ).fetchall()


def get_question(question_id: UUID) -> dict[str, Any] | None:
    with pool.connection() as conn:
        return conn.execute(
            f"SELECT {_QUESTION_COLUMNS} FROM questions q LEFT JOIN users uc ON uc.email = q.created_by WHERE q.id = %s",
            (question_id,),
        ).fetchone()


_QUESTION_EDITABLE = ("subject", "topic", "type", "difficulty", "body", "answer", "status", "embedding")


def update_question(question_id: UUID, changes: dict[str, Any], *, actor_email: str) -> None:
    fields = [f for f in _QUESTION_EDITABLE if f in changes]
    if not fields:
        return
    wrap = {"body": Json, "answer": Json, "embedding": Vector}
    values = [wrap.get(f, lambda v: v)(changes[f]) for f in fields]
    assignments = "".join(f"{f} = %s, " for f in fields)
    with pool.connection() as conn:
        conn.execute(
            f"UPDATE questions SET {assignments}updated_by = %s, updated_at = now() WHERE id = %s",
            (*values, actor_email, question_id),
        )
        conn.commit()


def set_questions_status(workspace_id: UUID, question_ids: list[UUID], status: str, *, actor_email: str) -> int:
    """Approves (or un-approves) several of a workspace's questions at once."""
    with pool.connection() as conn:
        rows = conn.execute(
            """
            UPDATE questions SET status = %s, updated_by = %s, updated_at = now()
            WHERE workspace_id = %s AND id = ANY(%s) AND status <> %s
            RETURNING id
            """,
            (status, actor_email, workspace_id, question_ids, status),
        ).fetchall()
        conn.commit()
        return len(rows)


def delete_question(question_id: UUID) -> bool:
    """Deletes a question unless an assessment uses it. Returns whether it
    was deleted.
    """
    try:
        with pool.connection() as conn:
            conn.execute("DELETE FROM questions WHERE id = %s", (question_id,))
            conn.commit()
        return True
    except ForeignKeyViolation:
        return False


def rule_key(subject: str, term: str | None) -> str:
    """Assignments with the same key can't share questions: one subject in
    one term (classrooms with no term count as one term).
    """
    return f"{subject.strip().lower()}|{(term or '').strip().lower()}"


def approved_pool(
    workspace_id: UUID,
    *,
    subject: str,
    topics: list[str],
    types: list[str],
    difficulties: list[int],
    doc_ids: list[UUID] | None = None,
    unused_by_assignments: str | None = None,
) -> list[dict[str, Any]]:
    """The workspace's approved questions in a subject, narrowed by source
    doc (written from any of `doc_ids`), topic, type and difficulty (empty
    list = any). With `unused_by_assignments`
    (a rule key), questions already in an assignment with that key are left
    out.
    """
    with pool.connection() as conn:
        return conn.execute(
            """
            SELECT q.id, q.topic, q.difficulty, q.type,
                   COALESCE(jsonb_array_length(q.body->'options'), 0) AS option_count
            FROM questions q
            WHERE q.workspace_id = %(ws)s AND q.status = 'approved'
              AND lower(q.subject) = lower(%(subject)s)
              AND (cardinality(%(docs)s::uuid[]) = 0 OR q.source_doc_ids && %(docs)s::uuid[])
              AND (cardinality(%(topics)s::text[]) = 0 OR lower(q.topic) = ANY(%(topics)s::text[]))
              AND (cardinality(%(types)s::text[]) = 0 OR q.type = ANY(%(types)s::text[]))
              AND (cardinality(%(difficulties)s::int[]) = 0 OR q.difficulty = ANY(%(difficulties)s::int[]))
              AND (%(key)s::text IS NULL OR NOT EXISTS (
                  SELECT 1 FROM assessment_items ai
                  WHERE ai.question_id = q.id AND ai.kind = 'assignment' AND ai.rule_key = %(key)s
              ))
            ORDER BY q.id
            """,
            {
                "ws": workspace_id,
                "subject": subject,
                "docs": list(doc_ids or []),
                "topics": [t.strip().lower() for t in topics],
                "types": types,
                "difficulties": difficulties,
                "key": unused_by_assignments,
            },
        ).fetchall()


def classrooms_sharing_rule(workspace_id: UUID, key: str) -> list[dict[str, Any]]:
    """The workspace's active classrooms whose subject and term give this
    rule key, each with whether it already has an assignment under it.
    """
    with pool.connection() as conn:
        rows = conn.execute(
            """
            SELECT c.id, c.name, c.subject, c.term,
                   EXISTS (SELECT 1 FROM assessments a
                           WHERE a.classroom_id = c.id AND a.kind = 'assignment' AND a.rule_key = %s) AS has_assignment
            FROM classrooms c
            WHERE c.workspace_id = %s AND c.archived_at IS NULL AND c.subject IS NOT NULL
            ORDER BY lower(c.name)
            """,
            (key, workspace_id),
        ).fetchall()
        return [r for r in rows if rule_key(r["subject"], r["term"]) == key]


_ASSESSMENT_COLUMNS = """
    a.*, COALESCE(u.name, a.created_by) AS created_by_name,
    (SELECT count(DISTINCT ai.student_email) FROM assessment_items ai
     WHERE ai.assessment_id = a.id AND ai.student_email IS NOT NULL) AS student_count
"""


def _insert_items(conn: Any, assessment: dict[str, Any], sets: dict[str | None, list[dict[str, Any]]]) -> None:
    for email, items in sets.items():
        for position, item in enumerate(items, start=1):
            conn.execute(
                """
                INSERT INTO assessment_items
                    (assessment_id, student_email, question_id, position, option_order, kind, rule_key)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    assessment["id"],
                    email,
                    item["question_id"],
                    position,
                    item["option_order"],
                    assessment["kind"],
                    assessment["rule_key"],
                ),
            )


def insert_assessment(
    *,
    classroom_id: UUID,
    kind: str,
    title: str,
    subject: str,
    key: str,
    config: dict[str, Any],
    seed: int,
    due_at: datetime | None,
    actor_email: str,
    sets: dict[str | None, list[dict[str, Any]]],
) -> UUID | None:
    """Saves an assessment and its items in one transaction. `sets` maps a
    student's email (None = the whole class, for an assignment) to their
    questions in order. Returns None if one of an assignment's questions was
    taken by another assignment under the same rule in the meantime.
    """
    try:
        with pool.connection() as conn:
            row = conn.execute(
                """
                INSERT INTO assessments (classroom_id, kind, title, subject, rule_key, config, seed, created_by, due_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                RETURNING id, kind, rule_key
                """,
                (classroom_id, kind, title, subject, key, Json(config), seed, actor_email, due_at),
            ).fetchone()
            _insert_items(conn, row, sets)
            conn.commit()
            return row["id"]
    except UniqueViolation:
        return None


def add_assessment_sets(assessment_id: UUID, sets: dict[str, list[dict[str, Any]]]) -> bool:
    """Adds sets for students who didn't have one. False if one of them got
    a set in the meantime.
    """
    try:
        with pool.connection() as conn:
            row = conn.execute(
                "SELECT id, kind, rule_key FROM assessments WHERE id = %s FOR UPDATE", (assessment_id,)
            ).fetchone()
            _insert_items(conn, row, sets)
            conn.commit()
            return True
    except UniqueViolation:
        return False


def list_assessments(classroom_id: UUID) -> list[dict[str, Any]]:
    with pool.connection() as conn:
        return conn.execute(
            f"""
            SELECT {_ASSESSMENT_COLUMNS}
            FROM assessments a LEFT JOIN users u ON u.email = a.created_by
            WHERE a.classroom_id = %s
            ORDER BY a.created_at DESC
            """,
            (classroom_id,),
        ).fetchall()


def get_assessment(assessment_id: UUID) -> dict[str, Any] | None:
    with pool.connection() as conn:
        return conn.execute(
            f"SELECT {_ASSESSMENT_COLUMNS} FROM assessments a LEFT JOIN users u ON u.email = a.created_by WHERE a.id = %s",
            (assessment_id,),
        ).fetchone()


def get_assessment_items(assessment_id: UUID) -> list[dict[str, Any]]:
    """Every item of an assessment with its question (answers included,
    for faculty), by student then position.
    """
    with pool.connection() as conn:
        return conn.execute(
            """
            SELECT ai.student_email, ai.position, ai.option_order, u.name AS student_name,
                   q.id AS question_id, q.topic, q.type, q.difficulty, q.body, q.answer, q.source_doc_ids
            FROM assessment_items ai
            JOIN questions q ON q.id = ai.question_id
            LEFT JOIN users u ON u.email = ai.student_email
            WHERE ai.assessment_id = %s
            ORDER BY ai.student_email NULLS FIRST, ai.position
            """,
            (assessment_id,),
        ).fetchall()


def delete_assessment(assessment_id: UUID) -> list[str]:
    """Deletes an assessment with its submissions; its questions become free
    for other assignments again. Returns the handed-in files' paths, for the
    caller to remove.
    """
    with pool.connection() as conn:
        files = conn.execute(
            "SELECT file_path FROM submissions WHERE assessment_id = %s AND file_path IS NOT NULL", (assessment_id,)
        ).fetchall()
        conn.execute("DELETE FROM assessments WHERE id = %s", (assessment_id,))
        conn.commit()
        return [f["file_path"] for f in files]


_STUDENT_CAN_SEE = """
    JOIN classroom_members cm ON cm.classroom_id = a.classroom_id AND cm.user_email = %(email)s
    JOIN classrooms c ON c.id = a.classroom_id AND c.archived_at IS NULL
"""


def list_student_assessments(email: str) -> list[dict[str, Any]]:
    """The quizzes and assignments a student has: assignments of their
    (active) classrooms, and quizzes with a set for them. No questions.
    """
    with pool.connection() as conn:
        return conn.execute(
            f"""
            SELECT a.id, a.kind, a.title, a.subject, a.due_at, a.created_at,
                   c.id AS classroom_id, c.name AS classroom_name,
                   (SELECT count(*) FROM assessment_items ai
                    WHERE ai.assessment_id = a.id
                      AND (ai.student_email = %(email)s OR ai.student_email IS NULL)) AS question_count,
                   s.score, s.total, s.submitted_at
            FROM assessments a {_STUDENT_CAN_SEE}
            LEFT JOIN submissions s ON s.assessment_id = a.id AND s.student_email = %(email)s
            WHERE a.kind = 'assignment' OR EXISTS (
                SELECT 1 FROM assessment_items ai WHERE ai.assessment_id = a.id AND ai.student_email = %(email)s
            )
            ORDER BY a.due_at NULLS LAST, a.created_at DESC
            """,
            {"email": email},
        ).fetchall()


def get_student_assessment(assessment_id: UUID, email: str, *, with_answers: bool = False) -> dict[str, Any] | None:
    """One assessment as a student sees it, with their questions in their
    order (prompt and options only), or None if they can't see it. The
    answers come along only `with_answers`, for grading and for showing
    results once they're allowed: callers decide what reaches the student.
    """
    with pool.connection() as conn:
        assessment = conn.execute(
            f"""
            SELECT a.id, a.kind, a.title, a.subject, a.due_at, a.created_at,
                   c.id AS classroom_id, c.name AS classroom_name
            FROM assessments a {_STUDENT_CAN_SEE}
            WHERE a.id = %(id)s
            """,
            {"email": email, "id": assessment_id},
        ).fetchone()
        if assessment is None:
            return None
        answer = ", q.answer" if with_answers else ""
        items = conn.execute(
            f"""
            SELECT ai.position, ai.option_order, q.id AS question_id, q.type, q.body{answer}
            FROM assessment_items ai JOIN questions q ON q.id = ai.question_id
            WHERE ai.assessment_id = %s AND (ai.student_email = %s OR ai.student_email IS NULL)
            ORDER BY ai.position
            """,
            (assessment_id, email),
        ).fetchall()
        if not items:
            return None
        assessment["items"] = items
        return assessment


# --- Submissions (Phase 5) ---
#
# Graded by the API on submit; stored once per student and assessment.


def get_submission(assessment_id: UUID, email: str) -> dict[str, Any] | None:
    with pool.connection() as conn:
        return conn.execute(
            "SELECT * FROM submissions WHERE assessment_id = %s AND student_email = %s", (assessment_id, email)
        ).fetchone()


def insert_submission(
    *, assessment_id: UUID, email: str, answers: list[dict], score: int | None, total: int | None,
    marked_by: str | None = None,
) -> bool:
    """Saves a submission: a graded quiz, or an assignment handed in (no
    answers or score; `marked_by` = the faculty member who ticked it off).
    False if the student already submitted.
    """
    try:
        with pool.connection() as conn:
            conn.execute(
                """
                INSERT INTO submissions (assessment_id, student_email, answers, score, total, marked_by)
                VALUES (%s, %s, %s, %s, %s, %s)
                """,
                (assessment_id, email, Json(answers), score, total, marked_by),
            )
            conn.commit()
        return True
    except UniqueViolation:
        return False


def list_submissions(assessment_id: UUID) -> list[dict[str, Any]]:
    """Every submission to an assessment, with the student's name."""
    with pool.connection() as conn:
        return conn.execute(
            """
            SELECT s.*, u.name AS student_name
            FROM submissions s LEFT JOIN users u ON u.email = s.student_email
            WHERE s.assessment_id = %s
            """,
            (assessment_id,),
        ).fetchall()


def delete_submission(assessment_id: UUID, email: str) -> dict[str, Any] | None:
    """Undoes a hand-in. Returns the deleted row (its file is the caller's
    to remove), or None if there was none.
    """
    with pool.connection() as conn:
        row = conn.execute(
            "DELETE FROM submissions WHERE assessment_id = %s AND student_email = %s RETURNING *",
            (assessment_id, email),
        ).fetchone()
        conn.commit()
        return row


def save_file_submission(
    *, assessment_id: UUID, email: str, file_path: str, file_name: str, file_size: int
) -> str | None:
    """Records an assignment's PDF as handed in now, replacing an earlier
    hand-in (file or faculty tick-off). Returns the replaced file's path,
    for the caller to remove.
    """
    with pool.connection() as conn:
        old = conn.execute(
            "SELECT file_path FROM submissions WHERE assessment_id = %s AND student_email = %s FOR UPDATE",
            (assessment_id, email),
        ).fetchone()
        conn.execute(
            """
            INSERT INTO submissions (assessment_id, student_email, answers, file_path, file_name, file_size)
            VALUES (%s, %s, '[]', %s, %s, %s)
            ON CONFLICT (assessment_id, student_email) DO UPDATE
            SET file_path = EXCLUDED.file_path, file_name = EXCLUDED.file_name, file_size = EXCLUDED.file_size,
                submitted_at = now(), marked_by = NULL
            """,
            (assessment_id, email, file_path, file_name, file_size),
        )
        conn.commit()
        return old["file_path"] if old else None
