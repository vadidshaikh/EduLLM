from pathlib import Path
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, UploadFile, status

from app.api.schemas import DocumentOut, UpdateDocumentRequest, UploadResponse
from app.auth.dependencies import require_faculty
from app.db import queries
from app.ingestion.pipeline import run_ingestion
from app.storage import compute_file_hash, save_upload_file

router = APIRouter()

_VALID_ROLES = {"student", "faculty"}


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
        uploaded_by=claims["sub"],
    )

    background_tasks.add_task(run_ingestion, document["id"])
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

    document = None

    if body.allowed_roles is not None:
        invalid = set(body.allowed_roles) - _VALID_ROLES
        if invalid:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"invalid roles: {sorted(invalid)}")
        if not body.allowed_roles:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "allowed_roles cannot be empty")
        document = queries.update_document_roles(document_id, body.allowed_roles)
        if document is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "document not found")

    if body.title is not None:
        title = body.title.strip()
        if not title:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "title cannot be empty")
        document = queries.update_document_title(document_id, title)
        if document is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "document not found")

    return document


@router.delete("/admin/documents/{document_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_document(document_id: UUID, claims: dict = Depends(require_faculty)) -> None:
    """Lets a faculty member permanently remove a document, deleting its
    database record and its file on disk.
    """
    document = queries.get_document(document_id)
    if document is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "document not found")

    queries.delete_document(document_id)  # cascades to chunks

    storage_path = Path(document["storage_path"])
    storage_path.unlink(missing_ok=True)
