"""Faculty slide decks (Phase 3). The table and routes are still called
"notes"; every note is a deck (kind "slides").

A note belongs to a workspace and, like its documents, can be read and
changed by any of its faculty (owner or editor). It is written from some of
the workspace's documents and the institute library's ("sources"), usually
starting from an LLM draft, and remembers which version of each source it
used. When a source is re-uploaded or removed the note shows as stale; the
faculty member can redraft it and compare before saving,
or mark it up to date. Nothing is ever rewritten automatically.

Publishing a note uploads it as an ordinary workspace document (.pptx) through the normal ingestion pipeline, so it's
searchable from Ask, can be published to classrooms, and gets audit events
and update notices like any upload. Republishing replaces that document.

Like workspaces.py, every check 404s for non-members.
"""
import re
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Response, status

from app.api.admin_documents import actor_fields, check_access
from app.api.schemas import (
    CreateNoteRequest,
    NoteOut,
    NoteSourceDocumentOut,
    NoteSummaryOut,
    PublishNoteRequest,
    RedraftResponse,
    ReviseNoteRequest,
    UpdateNoteRequest,
)
from app.api.workspaces import member_workspace
from app.auth.dependencies import require_faculty
from app.authoring.generate import GenerationError, clean_slides, draft_slides, revise_slides
from app.authoring.render import deck_pptx
from app.db import queries
from app.ingestion.pipeline import run_ingestion
from app.storage import compute_file_hash, delete_stored_file, save_upload_file
from app.tracing import document_trace_extra

router = APIRouter()

_MAX_SOURCES = 8
_PPTX_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.presentation"


def _unprocessable(detail: str) -> HTTPException:
    return HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail)


def _required_text(value: str, field: str) -> str:
    value = value.strip()
    if not value:
        raise _unprocessable(f"{field} cannot be empty")
    return value


def _optional_text(value: str | None) -> str | None:
    return (value or "").strip() or None


def _generation_failed(exc: GenerationError) -> HTTPException:
    return HTTPException(status.HTTP_502_BAD_GATEWAY, f"Couldn't write a draft: {exc}")


def _note(note_id: UUID, claims: dict) -> dict:
    """The note if the caller is faculty in its workspace, otherwise 404."""
    note = queries.get_note(note_id)
    if note is None or queries.get_member_workspace(note["workspace_id"], claims["sub"]) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "note not found")
    note["slide_count"] = len(note["slides"])
    return note


def _file_name(note: dict) -> str:
    stem = re.sub(r"[^\w\- ]+", "", note["title"]).strip() or "deck"
    return f"{stem}.pptx"


@router.get("/workspaces/{workspace_id}/note-sources", response_model=list[NoteSourceDocumentOut])
def list_note_sources(workspace_id: UUID, claims: dict = Depends(require_faculty)) -> list[NoteSourceDocumentOut]:
    """The ready documents a note here can be written from: this workspace's
    and the institute library's.
    """
    member_workspace(workspace_id, claims)
    return queries.list_note_source_documents(workspace_id)


@router.get("/workspaces/{workspace_id}/notes", response_model=list[NoteSummaryOut])
def list_notes(workspace_id: UUID, claims: dict = Depends(require_faculty)) -> list[NoteSummaryOut]:
    member_workspace(workspace_id, claims)
    return queries.list_notes(workspace_id)


@router.post("/workspaces/{workspace_id}/notes", response_model=NoteOut)
def create_note(workspace_id: UUID, body: CreateNoteRequest, claims: dict = Depends(require_faculty)) -> NoteOut:
    """Creates a deck from the chosen sources. With `generate`
    (the default) the LLM writes the first draft, which is saved straight
    away so a slow generation isn't lost; it isn't published until the
    faculty member publishes it.
    """
    member_workspace(workspace_id, claims)
    title = _required_text(body.title, "title")
    topic = _required_text(body.topic, "topic")
    subject = _optional_text(body.subject)

    source_ids = list(dict.fromkeys(body.source_doc_ids))
    if not source_ids:
        raise _unprocessable("pick at least one source document")
    if len(source_ids) > _MAX_SOURCES:
        raise _unprocessable(f"pick at most {_MAX_SOURCES} source documents")
    allowed = {d["id"]: d for d in queries.list_note_source_documents(workspace_id)}
    if not set(source_ids) <= allowed.keys():
        raise _unprocessable("sources must be ready documents in this workspace or the institute library")
    sources = [
        {"doc_id": str(i), "title": allowed[i]["title"], "version": allowed[i]["version"]} for i in source_ids
    ]

    slides = []
    if body.generate:
        brief = {
            "title": title,
            "topic": topic,
            "subject": subject,
            "instructions": _optional_text(body.instructions),
            "sources": sources,
        }
        try:
            slides = draft_slides(claims, **brief)
        except GenerationError as exc:
            raise _generation_failed(exc) from exc

    note_id = queries.insert_note(
        workspace_id=workspace_id,
        kind="slides",
        title=title,
        subject=subject,
        topic=topic,
        body_md="",
        slides=slides,
        sources=sources,
        actor_email=claims["sub"],
    )
    return _note(note_id, claims)


@router.get("/notes/{note_id}", response_model=NoteOut)
def get_note(note_id: UUID, claims: dict = Depends(require_faculty)) -> NoteOut:
    return _note(note_id, claims)


@router.patch("/notes/{note_id}", response_model=NoteOut)
def update_note(note_id: UUID, body: UpdateNoteRequest, claims: dict = Depends(require_faculty)) -> NoteOut:
    """Saves edits, and/or marks the note as checked against its sources'
    current versions. Refused with 409 if someone else saved it since the
    editor loaded it.
    """
    note = _note(note_id, claims)
    changes: dict = {}
    if body.title is not None:
        changes["title"] = _required_text(body.title, "title")
    if body.topic is not None:
        changes["topic"] = _required_text(body.topic, "topic")
    if body.subject is not None:
        changes["subject"] = _optional_text(body.subject)
    if body.slides is not None:
        changes["slides"] = clean_slides([s.model_dump() for s in body.slides])
    if body.mark_up_to_date:
        current = {str(d["id"]): d for d in queries.get_documents([UUID(s["doc_id"]) for s in note["sources"]])}
        changes["sources"] = [
            {"doc_id": s["doc_id"], "title": current[s["doc_id"]]["title"], "version": current[s["doc_id"]]["version"]}
            for s in note["sources"]
            if s["doc_id"] in current
        ]
    if not changes:
        raise _unprocessable("no fields to update")

    if not queries.update_note(note_id, changes, base_updated_at=body.base_updated_at, actor_email=claims["sub"]):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "someone else saved this note since you opened it; reload it to see their changes",
        )
    return _note(note_id, claims)


@router.delete("/notes/{note_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_note(note_id: UUID, claims: dict = Depends(require_faculty)) -> None:
    """Deletes the note. If it was published, that document stays in the
    library (remove it there).
    """
    _note(note_id, claims)
    queries.delete_note(note_id)


@router.post("/notes/{note_id}/redraft", response_model=RedraftResponse)
def redraft_note(note_id: UUID, claims: dict = Depends(require_faculty)) -> RedraftResponse:
    """Writes a new deck from the sources' current versions, for the editor
    to compare and accept or discard. Saves nothing.
    """
    note = _note(note_id, claims)
    try:
        return RedraftResponse(
            slides=draft_slides(
                claims,
                title=note["title"],
                topic=note["topic"],
                subject=note["subject"],
                instructions=None,
                sources=note["sources"],
            )
        )
    except GenerationError as exc:
        raise _generation_failed(exc) from exc


@router.post("/notes/{note_id}/revise", response_model=RedraftResponse)
def revise_note(note_id: UUID, body: ReviseNoteRequest, claims: dict = Depends(require_faculty)) -> RedraftResponse:
    """Applies a change the faculty member asks for in words ("add a slide
    on paging", "remove slide 4", "make the examples simpler") to the deck
    as it is in the editor. A proposal only, like a redraft: nothing is
    saved until the editor saves it.
    """
    note = _note(note_id, claims)
    request = _required_text(body.request, "the change")
    if len(request) > 1000:
        raise _unprocessable("describe the change in at most 1000 characters")
    try:
        return RedraftResponse(
            slides=revise_slides(
                claims,
                title=note["title"],
                topic=note["topic"],
                subject=note["subject"],
                slides=clean_slides([s.model_dump() for s in body.slides]),
                request=request,
                sources=note["sources"],
            )
        )
    except GenerationError as exc:
        raise _generation_failed(exc) from exc


@router.get("/notes/{note_id}/download")
def download_note(note_id: UUID, claims: dict = Depends(require_faculty)) -> Response:
    """The saved deck as a .pptx file."""
    note = _note(note_id, claims)
    return Response(
        deck_pptx(note),
        media_type=_PPTX_TYPE,
        headers={"Content-Disposition": f'attachment; filename="{_file_name(note)}"'},
    )


@router.post("/notes/{note_id}/publish", response_model=NoteOut)
def publish_note(
    note_id: UUID, body: PublishNoteRequest, background_tasks: BackgroundTasks, claims: dict = Depends(require_faculty)
) -> NoteOut:
    """Publishes the saved note as a document of its workspace, readable by
    the workspace's faculty or also by the chosen classrooms. The first
    publish adds a document; later ones replace it (a new version, with an
    update notice to its readers). It's indexed in the background like any
    upload.
    """
    note = _note(note_id, claims)
    workspace = member_workspace(note["workspace_id"], claims)
    classroom_ids = check_access(workspace, body.visibility, body.classroom_ids)
    if not note["slides"]:
        raise _unprocessable("there's nothing to publish yet")

    same_title = queries.find_document_by_title(note["workspace_id"], note["title"])
    if same_title is not None and same_title["id"] != note["document_id"]:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f'a doc called "{note["title"]}" is already in this workspace; rename the note first',
        )

    previous = queries.get_document(note["document_id"]) if note["document_id"] else None
    file_bytes = deck_pptx(note)
    filename = _file_name(note)
    storage_path = save_upload_file(file_bytes, filename)
    document = queries.insert_document(
        title=note["title"],
        filename=filename,
        storage_path=str(storage_path),
        workspace_id=note["workspace_id"],
        visibility=body.visibility,
        classroom_ids=classroom_ids,
        file_hash=compute_file_hash(file_bytes),
        document_id=previous["id"] if previous else None,
        **actor_fields(claims),
    )
    if previous is not None:
        delete_stored_file(previous["storage_path"])
    queries.set_note_published(note_id, document["id"])

    background_tasks.add_task(
        run_ingestion,
        document["id"],
        langsmith_extra=document_trace_extra(document["id"], note["title"]),
    )
    return _note(note_id, claims)
