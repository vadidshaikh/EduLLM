from uuid import UUID

from fastapi import APIRouter, Depends, status

from app.api.schemas import NotificationsResponse
from app.auth.dependencies import get_claims
from app.db import queries

router = APIRouter()

# The bell panel shows recent notices only; the unread count covers all of them.
_LIST_LIMIT = 50


@router.get("/notifications", response_model=NotificationsResponse)
def list_notifications(claims: dict = Depends(get_claims)) -> NotificationsResponse:
    """Returns the logged-in user's recent document update/delete notices
    (excluding their own actions) and how many they haven't read.
    """
    email, role = claims["sub"], claims["role"]
    return NotificationsResponse(
        unread_count=queries.count_unread_notifications(email, role),
        notifications=queries.list_notifications(email, role, _LIST_LIMIT),
    )


@router.post("/notifications/read-all", status_code=status.HTTP_204_NO_CONTENT)
def mark_all_read(claims: dict = Depends(get_claims)) -> None:
    """Marks every notice visible to the logged-in user as read."""
    queries.mark_notifications_read(claims["sub"], claims["role"])


@router.post("/notifications/{notification_id}/read", status_code=status.HTTP_204_NO_CONTENT)
def mark_read(notification_id: UUID, claims: dict = Depends(get_claims)) -> None:
    """Marks one notice as read. Notices can't be deleted."""
    queries.mark_notifications_read(claims["sub"], claims["role"], notification_id)
