"""Document management for faculty: the institute library (workspace_id
omitted / null) and each workspace's documents.

Any faculty member can manage institute library documents, as before
Phase 2. A workspace's documents can be managed by any of its members
(owner or editor); the audit log and notifications make that traceable.
"""
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, UploadFile, status

from app.api.schemas import DocumentEventOut, DocumentOut, UpdateDocumentRequest, UploadResponse
from app.api.workspaces import member_workspace
from app.auth.dependencies import require_faculty
from app.auth.email_rules import display_name_from_email
from app.db import queries
from app.ingestion.pipeline import run_ingestion
from app.storage import compute_file_hash, delete_stored_file, save_upload_file
from app.tracing import document_trace_extra

router = APIRouter()

# The activity drawer shows recent events only; per-document history is unlimited.
_ACTIVITY_LIMIT = 200


def actor_fields(claims: dict) -> dict[str, str]:
    """Who is making this change, as recorded in the audit log: the session's
    email plus their stored display name (or a derived one if they have no
    users row yet, e.g. a session issued before the users table existed).
    """
    email = claims["sub"]
    user = queries.get_user(email)
    return {"actor_email": email, "actor_name": user["name"] if user else display_name_from_email(email)}


def _unprocessable(detail: str) -> HTTPException:
    return HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail)


def _workspace_or_library(workspace_id: UUID | None, claims: dict) -> dict | None:
    """The workspace (checking the caller is in it), or None for the
    institute library.
    """
    return member_workspace(workspace_id, claims) if workspace_id is not None else None


def check_access(workspace: dict | None, visibility: str, classroom_ids: list[UUID]) -> list[UUID]:
    """Validates who a document is being made readable by, for where it
    lives, and returns the de-duplicated classroom ids:
    - institute library: "institute" (everyone) or "faculty" (all faculty);
    - personal workspace: "workspace" only (just the owner);
    - shared workspace: "workspace" (its faculty) or "classrooms" (its
      faculty plus the students of the listed classrooms, which must be
      this workspace's).
    """
    classroom_ids = list(dict.fromkeys(classroom_ids))
    if workspace is None:
        allowed = {"institute", "faculty"}
    elif workspace["kind"] == "personal":
        allowed = {"workspace"}
    else:
        allowed = {"workspace", "classrooms"}
    if visibility not in allowed:
        raise _unprocessable(f"visibility must be one of {sorted(allowed)} here")

    if visibility != "classrooms":
        if classroom_ids:
            raise _unprocessable("classroom_ids only apply when visibility is 'classrooms'")
        return []
    if not classroom_ids:
        raise _unprocessable("pick at least one classroom")
    own = {c["id"] for c in queries.list_classrooms(workspace["id"])}
    if not set(classroom_ids) <= own:
        raise _unprocessable("classrooms must belong to this workspace")
    return classroom_ids


def _writable_document(document_id: UUID, claims: dict) -> dict:
    """The document if the caller may change it, otherwise 404."""
    document = queries.get_document(document_id)
    if document is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "document not found")
    if document["workspace_id"] is not None:
        try:
            member_workspace(document["workspace_id"], claims)
        except HTTPException:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "document not found") from None
    return document


@router.post("/admin/documents", response_model=UploadResponse)
async def upload_document(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    title: str = Form(...),
    visibility: str = Form(...),
    workspace_id: UUID | None = Form(None),
    classroom_ids: list[UUID] = Form([]),
    claims: dict = Depends(require_faculty),
) -> UploadResponse:
    """Lets a faculty member upload a new document to the institute library
    or one of their workspaces, saves the file to storage, records it in the
    database, and kicks off background processing so it can be searched
    later. Re-uploading a title that already exists in the same place
    replaces that document.
    """
    workspace = _workspace_or_library(workspace_id, claims)
    classroom_ids = check_access(workspace, visibility, classroom_ids)
    title = title.strip()
    if not title:
        raise _unprocessable("title cannot be empty")

    file_bytes = await file.read()
    storage_path = save_upload_file(file_bytes, file.filename)

    document = queries.insert_document(
        title=title,
        filename=file.filename,
        storage_path=str(storage_path),
        workspace_id=workspace_id,
        visibility=visibility,
        classroom_ids=classroom_ids,
        file_hash=compute_file_hash(file_bytes),
        **actor_fields(claims),
    )

    background_tasks.add_task(
        run_ingestion,
        document["id"],
        langsmith_extra=document_trace_extra(document["id"], title),
    )
    return UploadResponse(document_id=document["id"], status=document["status"])


@router.get("/admin/documents", response_model=list[DocumentOut])
def list_documents(workspace_id: UUID | None = None, claims: dict = Depends(require_faculty)) -> list[DocumentOut]:
    """Returns one workspace's documents, or the institute library's when
    `workspace_id` is omitted.
    """
    _workspace_or_library(workspace_id, claims)
    return queries.list_documents(workspace_id)


@router.patch("/admin/documents/{document_id}", response_model=DocumentOut)
def update_document(
    document_id: UUID, body: UpdateDocumentRequest, claims: dict = Depends(require_faculty)
) -> DocumentOut:
    """Lets a faculty member rename a document and/or change who can read it
    (e.g. publish it to a classroom, or make it faculty-only), taking effect
    immediately.
    """
    if body.title is None and body.visibility is None:
        raise _unprocessable("no fields to update")

    document = _writable_document(document_id, claims)
    classroom_ids = None
    if body.visibility is not None:
        workspace = _workspace_or_library(document["workspace_id"], claims)
        classroom_ids = check_access(workspace, body.visibility, body.classroom_ids)

    title = None
    if body.title is not None:
        title = body.title.strip()
        if not title:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "title cannot be empty")

    document = queries.update_document(
        document_id,
        title=title,
        visibility=body.visibility,
        classroom_ids=classroom_ids,
        **actor_fields(claims),
    )
    if document is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "document not found")
    return document


@router.get("/admin/document-events", response_model=list[DocumentEventOut])
def list_all_document_events(
    workspace_id: UUID | None = None, claims: dict = Depends(require_faculty)
) -> list[DocumentEventOut]:
    """Returns recent audit events (uploads, updates, deletes) for one
    workspace, or the institute library when `workspace_id` is omitted,
    newest first. Deleted documents' events are included.
    """
    _workspace_or_library(workspace_id, claims)
    return queries.list_all_document_events(workspace_id, _ACTIVITY_LIMIT)


@router.get("/admin/documents/{document_id}/events", response_model=list[DocumentEventOut])
def list_document_events(document_id: UUID, claims: dict = Depends(require_faculty)) -> list[DocumentEventOut]:
    """Returns a document's audit history (who uploaded, updated or deleted
    it, and when), newest first. Still available after the document is
    deleted, to the people who could manage it.
    """
    document = queries.get_document(document_id)
    events = queries.list_document_events(document_id)
    if document is not None:
        workspace_id = document["workspace_id"]
    else:
        workspace_id = events[0]["workspace_id"] if events else None
    if workspace_id is not None:
        try:
            member_workspace(workspace_id, claims)
        except HTTPException:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "document not found") from None
    return events


@router.delete("/admin/documents/{document_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_document(document_id: UUID, claims: dict = Depends(require_faculty)) -> None:
    """Lets a faculty member permanently remove a document, deleting its
    database record and its file on disk. The delete is logged and everyone
    who could see the document is notified.
    """
    _writable_document(document_id, claims)
    document = queries.delete_document(document_id, **actor_fields(claims))  # cascades to chunks
    if document is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "document not found")

    delete_stored_file(document["storage_path"])
