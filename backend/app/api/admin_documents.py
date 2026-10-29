from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, UploadFile, status

from app.api.schemas import DocumentEventOut, DocumentOut, UpdateDocumentRequest, UploadResponse
from app.auth.dependencies import require_faculty
from app.auth.email_rules import display_name_from_email
from app.db import queries
from app.ingestion.pipeline import run_ingestion
from app.storage import compute_file_hash, delete_stored_file, save_upload_file
from app.tracing import document_trace_extra

router = APIRouter()

_VALID_ROLES = {"student", "faculty"}

# The activity drawer shows recent events only; per-document history is unlimited.
_ACTIVITY_LIMIT = 200


def _actor(claims: dict) -> dict[str, str]:
    """Who is making this change, as recorded in the audit log: the session's
    email plus their stored display name (or a derived one if they have no
    users row yet, e.g. a session issued before the users table existed).
    """
    email = claims["sub"]
    user = queries.get_user(email)
    return {"actor_email": email, "actor_name": user["name"] if user else display_name_from_email(email)}


@router.post("/admin/documents", response_model=UploadResponse)
async def upload_document(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    title: str = Form(...),
    allowed_roles: list[str] = Form(...),
    claims: dict = Depends(require_faculty),
) -> UploadResponse:
    """Lets a faculty member upload a new document, saves the file to storage,
    records it in the database, and kicks off background processing so it can
    be searched later.
    """
    invalid = set(allowed_roles) - _VALID_ROLES
    if invalid:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"invalid roles: {sorted(invalid)}")

    file_bytes = await file.read()
    storage_path = save_upload_file(file_bytes, file.filename)

    document = queries.insert_document(
        title=title,
        filename=file.filename,
        storage_path=str(storage_path),
        allowed_roles=allowed_roles,
        file_hash=compute_file_hash(file_bytes),
        **_actor(claims),
    )

    background_tasks.add_task(
        run_ingestion,
        document["id"],
        langsmith_extra=document_trace_extra(document["id"], title),
    )
    return UploadResponse(document_id=document["id"], status=document["status"])


@router.get("/admin/documents", response_model=list[DocumentOut])
def list_documents(claims: dict = Depends(require_faculty)) -> list[DocumentOut]:
    """Returns the list of all uploaded documents, for faculty only."""
    return queries.list_documents()


@router.patch("/admin/documents/{document_id}", response_model=DocumentOut)
def update_document(
    document_id: UUID, body: UpdateDocumentRequest, claims: dict = Depends(require_faculty)
) -> DocumentOut:
    """Lets a faculty member rename a document and/or change which roles can
    access it (e.g. faculty-only <-> both), taking effect immediately.
    """
    if body.title is None and body.allowed_roles is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "no fields to update")

    if body.allowed_roles is not None:
        invalid = set(body.allowed_roles) - _VALID_ROLES
        if invalid:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"invalid roles: {sorted(invalid)}")
        if not body.allowed_roles:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "allowed_roles cannot be empty")

    title = None
    if body.title is not None:
        title = body.title.strip()
        if not title:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "title cannot be empty")

    document = queries.update_document(
        document_id, title=title, allowed_roles=body.allowed_roles, **_actor(claims)
    )
    if document is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "document not found")
    return document


@router.get("/admin/document-events", response_model=list[DocumentEventOut])
def list_all_document_events(claims: dict = Depends(require_faculty)) -> list[DocumentEventOut]:
    """Returns recent audit events across all documents (uploads, updates,
    deletes), newest first. Deleted documents' events are included.
    """
    return queries.list_all_document_events(_ACTIVITY_LIMIT)


@router.get("/admin/documents/{document_id}/events", response_model=list[DocumentEventOut])
def list_document_events(document_id: UUID, claims: dict = Depends(require_faculty)) -> list[DocumentEventOut]:
    """Returns a document's audit history (who uploaded, updated or deleted
    it, and when), newest first. Still available after the document is deleted.
    """
    return queries.list_document_events(document_id)


@router.delete("/admin/documents/{document_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_document(document_id: UUID, claims: dict = Depends(require_faculty)) -> None:
    """Lets a faculty member permanently remove a document, deleting its
    database record and its file on disk. The delete is logged and everyone
    who could see the document is notified.
    """
    document = queries.delete_document(document_id, **_actor(claims))  # cascades to chunks
    if document is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "document not found")

    delete_stored_file(document["storage_path"])
