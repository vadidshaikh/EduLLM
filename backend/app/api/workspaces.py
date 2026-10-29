"""Workspaces, their faculty members, and their classrooms (Phase 2).

Who may do what:
- Any member (owner or editor) of a workspace can see it, manage its
  documents and manage its classrooms and their students.
- Only the owner of a shared workspace can rename it, delete it, and add or
  remove faculty. Editors can remove themselves (leave).
- Personal workspaces have exactly one member and no classrooms.
- Students only join (by code) and leave classrooms.

Every check here 404s rather than 403s when the caller isn't a member, so
workspace and classroom ids don't leak to people outside them.
"""
import logging
import re
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status

from app.api.schemas import (
    AddMemberRequest,
    AddMemberResponse,
    AddStudentsRequest,
    AddStudentsResponse,
    ClassroomOut,
    ClassroomStudentOut,
    CreateClassroomRequest,
    CreateWorkspaceRequest,
    JoinClassroomRequest,
    ReadableDocumentOut,
    ScopeOut,
    StudentClassroomOut,
    UpdateClassroomRequest,
    UpdateWorkspaceRequest,
    WorkspaceMemberOut,
    WorkspaceOut,
)
from app.auth.dependencies import get_claims, require_faculty
from app.auth.email_rules import EmailFormatError, display_name_from_email, parse_institute_email
from app.auth.mailer import send_workspace_invite
from app.db import queries

logger = logging.getLogger(__name__)

router = APIRouter()

_EMAIL_SEPARATORS = re.compile(r"[\s,;]+")


def _required_text(value: str, field: str) -> str:
    value = value.strip()
    if not value:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"{field} cannot be empty")
    return value


def member_workspace(workspace_id: UUID, claims: dict) -> dict:
    """The workspace if the caller is one of its faculty, otherwise 404."""
    workspace = queries.get_member_workspace(workspace_id, claims["sub"])
    if workspace is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "workspace not found")
    return workspace


def _owned_shared_workspace(workspace_id: UUID, claims: dict) -> dict:
    workspace = member_workspace(workspace_id, claims)
    if workspace["kind"] != "shared":
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "personal workspaces can't be changed")
    if workspace["my_role"] != "owner":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "only the workspace owner can do this")
    return workspace


def _managed_classroom(classroom_id: UUID, claims: dict) -> dict:
    """The classroom if the caller is faculty in its workspace, otherwise 404."""
    classroom = queries.get_classroom(classroom_id)
    if classroom is None or queries.get_member_workspace(classroom["workspace_id"], claims["sub"]) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "classroom not found")
    return classroom


def _email_role(email: str) -> str | None:
    try:
        return parse_institute_email(email)["role"]
    except EmailFormatError:
        return None


# --- Workspaces ---


@router.get("/workspaces", response_model=list[WorkspaceOut])
def list_workspaces(claims: dict = Depends(require_faculty)) -> list[WorkspaceOut]:
    """The caller's workspaces, personal first. Creates the personal one if
    it's missing (e.g. a session from before workspaces existed).
    """
    queries.ensure_personal_workspace(claims["sub"])
    return queries.list_workspaces(claims["sub"])


@router.post("/workspaces", response_model=WorkspaceOut, status_code=status.HTTP_201_CREATED)
def create_workspace(body: CreateWorkspaceRequest, claims: dict = Depends(require_faculty)) -> WorkspaceOut:
    """Creates a shared workspace owned by the caller."""
    workspace_id = queries.create_shared_workspace(_required_text(body.name, "name"), claims["sub"])
    return queries.get_member_workspace(workspace_id, claims["sub"])


@router.patch("/workspaces/{workspace_id}", response_model=WorkspaceOut)
def rename_workspace(
    workspace_id: UUID, body: UpdateWorkspaceRequest, claims: dict = Depends(require_faculty)
) -> WorkspaceOut:
    _owned_shared_workspace(workspace_id, claims)
    queries.rename_workspace(workspace_id, _required_text(body.name, "name"))
    return queries.get_member_workspace(workspace_id, claims["sub"])


@router.delete("/workspaces/{workspace_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_workspace(workspace_id: UUID, claims: dict = Depends(require_faculty)) -> None:
    """Deletes an empty shared workspace, with its classrooms. Refuses while
    it still has documents or notes, so nothing is removed without an audit
    event.
    """
    _owned_shared_workspace(workspace_id, claims)
    if not queries.delete_workspace(workspace_id):
        raise HTTPException(status.HTTP_409_CONFLICT, "delete the workspace's documents and notes first")


@router.get("/workspaces/{workspace_id}/members", response_model=list[WorkspaceMemberOut])
def list_members(workspace_id: UUID, claims: dict = Depends(require_faculty)) -> list[WorkspaceMemberOut]:
    member_workspace(workspace_id, claims)
    return queries.list_workspace_members(workspace_id)


@router.post("/workspaces/{workspace_id}/members", response_model=AddMemberResponse)
def add_member(
    workspace_id: UUID, body: AddMemberRequest, claims: dict = Depends(require_faculty)
) -> AddMemberResponse:
    """Adds a faculty member by email. If they've never signed in, they're
    emailed an invite; the membership applies as soon as they do.
    """
    workspace = _owned_shared_workspace(workspace_id, claims)
    email = body.email.strip().lower()
    if _email_role(email) != "faculty":
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "only faculty emails can be added")

    added = queries.add_workspace_member(workspace_id, email, claims["sub"])
    invited = False
    if added and queries.get_user(email) is None:
        inviter = queries.get_user(claims["sub"])
        try:
            send_workspace_invite(
                email,
                inviter["name"] if inviter else display_name_from_email(claims["sub"]),
                workspace["name"],
            )
            invited = True
        except Exception:
            # The membership stands either way; they'll see it on first sign-in.
            logger.exception("Failed to send workspace invite to %s", email)
    return AddMemberResponse(added=added, invited=invited)


@router.delete("/workspaces/{workspace_id}/members/{email}", status_code=status.HTTP_204_NO_CONTENT)
def remove_member(workspace_id: UUID, email: str, claims: dict = Depends(require_faculty)) -> None:
    """The owner removes an editor, or an editor leaves. The owner can't be
    removed. Access to the workspace's documents ends immediately.
    """
    workspace = member_workspace(workspace_id, claims)
    email = email.strip().lower()
    if workspace["kind"] != "shared":
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "personal workspaces can't be changed")
    if email != claims["sub"] and workspace["my_role"] != "owner":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "only the workspace owner can remove others")
    if not queries.remove_workspace_member(workspace_id, email):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not a removable member (the owner can't be removed)")


# --- Classrooms (faculty side) ---


@router.get("/workspaces/{workspace_id}/classrooms", response_model=list[ClassroomOut])
def list_classrooms(workspace_id: UUID, claims: dict = Depends(require_faculty)) -> list[ClassroomOut]:
    member_workspace(workspace_id, claims)
    return queries.list_classrooms(workspace_id)


@router.post(
    "/workspaces/{workspace_id}/classrooms", response_model=ClassroomOut, status_code=status.HTTP_201_CREATED
)
def create_classroom(
    workspace_id: UUID, body: CreateClassroomRequest, claims: dict = Depends(require_faculty)
) -> ClassroomOut:
    workspace = member_workspace(workspace_id, claims)
    if workspace["kind"] != "shared":
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, "classrooms belong to shared workspaces, not personal ones"
        )
    return queries.create_classroom(
        workspace_id=workspace_id,
        name=_required_text(body.name, "name"),
        subject=(body.subject or "").strip() or None,
        term=(body.term or "").strip() or None,
        created_by=claims["sub"],
    )


@router.patch("/classrooms/{classroom_id}", response_model=ClassroomOut)
def update_classroom(
    classroom_id: UUID, body: UpdateClassroomRequest, claims: dict = Depends(require_faculty)
) -> ClassroomOut:
    """Edits a classroom's details, or archives / restores it. Archiving
    hides the classroom's documents from its students straight away.
    """
    _managed_classroom(classroom_id, claims)
    return queries.update_classroom(
        classroom_id,
        name=_required_text(body.name, "name") if body.name is not None else None,
        subject=body.subject.strip() if body.subject is not None else None,
        term=body.term.strip() if body.term is not None else None,
        archived=body.archived,
    )


@router.post("/classrooms/{classroom_id}/join-code", response_model=ClassroomOut)
def regenerate_join_code(classroom_id: UUID, claims: dict = Depends(require_faculty)) -> ClassroomOut:
    """Issues a new join code; the old one stops working. Current students stay."""
    _managed_classroom(classroom_id, claims)
    return queries.regenerate_join_code(classroom_id)


@router.get("/classrooms/{classroom_id}/students", response_model=list[ClassroomStudentOut])
def list_students(classroom_id: UUID, claims: dict = Depends(require_faculty)) -> list[ClassroomStudentOut]:
    _managed_classroom(classroom_id, claims)
    return queries.list_classroom_students(classroom_id)


@router.post("/classrooms/{classroom_id}/students", response_model=AddStudentsResponse)
def add_students(
    classroom_id: UUID, body: AddStudentsRequest, claims: dict = Depends(require_faculty)
) -> AddStudentsResponse:
    """Bulk-adds students from pasted text (a column copied from a sheet, or
    CSV). Anything containing "@" is treated as an email; other words (e.g.
    names in a CSV) are ignored. Emails that aren't student addresses are
    returned in `rejected` rather than failing the whole request.
    """
    _managed_classroom(classroom_id, claims)
    tokens = [t.strip().strip("\"'<>").lower() for t in _EMAIL_SEPARATORS.split(body.emails)]
    candidates = list(dict.fromkeys(t for t in tokens if "@" in t))
    accepted = [e for e in candidates if _email_role(e) == "student"]
    rejected = [e for e in candidates if e not in accepted]
    added = queries.add_classroom_students(classroom_id, accepted, claims["sub"])
    return AddStudentsResponse(added=added, already_in=len(accepted) - added, rejected=rejected)


@router.delete("/classrooms/{classroom_id}/students/{email}", status_code=status.HTTP_204_NO_CONTENT)
def remove_student(classroom_id: UUID, email: str, claims: dict = Depends(require_faculty)) -> None:
    _managed_classroom(classroom_id, claims)
    if not queries.remove_classroom_student(classroom_id, email.strip().lower()):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "student not in this classroom")


# --- Classrooms (student side) ---


def _require_student(claims: dict = Depends(get_claims)) -> dict:
    if claims["role"] != "student":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "student access required")
    return claims


@router.get("/classrooms", response_model=list[StudentClassroomOut])
def list_my_classrooms(claims: dict = Depends(_require_student)) -> list[StudentClassroomOut]:
    return queries.list_student_classrooms(claims["sub"])


@router.post("/classrooms/join", response_model=StudentClassroomOut)
def join_classroom(body: JoinClassroomRequest, claims: dict = Depends(_require_student)) -> StudentClassroomOut:
    """Joins the classroom with this code (case and spaces ignored)."""
    code = re.sub(r"\s+", "", body.code).upper()
    classroom = queries.find_active_classroom_by_code(code) if code else None
    if classroom is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No classroom has that code. Check it with your teacher.")
    if not queries.add_classroom_students(classroom["id"], [claims["sub"]], added_by=None):
        raise HTTPException(status.HTTP_409_CONFLICT, f"You're already in {classroom['name']}.")
    return next(c for c in queries.list_student_classrooms(claims["sub"]) if c["id"] == classroom["id"])


@router.delete("/classrooms/{classroom_id}/membership", status_code=status.HTTP_204_NO_CONTENT)
def leave_classroom(classroom_id: UUID, claims: dict = Depends(_require_student)) -> None:
    if not queries.remove_classroom_student(classroom_id, claims["sub"]):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "you're not in that classroom")


# --- Chat scope picker and shelf ---


@router.get("/documents", response_model=list[ReadableDocumentOut])
def list_readable_documents(scope_id: UUID | None = None, claims: dict = Depends(get_claims)) -> list[ReadableDocumentOut]:
    """The ready documents the caller can ask about, for the Ask page's
    shelf: everything they can read, or only one workspace / classroom with
    `scope_id` (empty if they don't hold it). Works for students and faculty.
    """
    return queries.list_readable_documents(email=claims["sub"], role=claims["role"], scope_id=scope_id)


@router.get("/scopes", response_model=list[ScopeOut])
def list_scopes(claims: dict = Depends(get_claims)) -> list[ScopeOut]:
    """What the chat can be narrowed to: the caller's workspaces (faculty)
    or joined classrooms (students). Pass an id as /query's `scope_id`.
    """
    if claims["role"] == "faculty":
        queries.ensure_personal_workspace(claims["sub"])
        return [
            ScopeOut(id=w["id"], kind=w["kind"], name=w["name"])
            for w in queries.list_workspaces(claims["sub"])
        ]
    return [
        ScopeOut(id=c["id"], kind="classroom", name=c["name"], detail=c["workspace_name"])
        for c in queries.list_student_classrooms(claims["sub"])
    ]
