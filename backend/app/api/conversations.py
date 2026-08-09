from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status

from app.api.schemas import ConversationOut, MessageOut
from app.auth.dependencies import get_claims
from app.db import queries

router = APIRouter()


def _owned_conversation(conversation_id: UUID, user_email: str) -> dict:
    """Fetches a conversation only if it belongs to the given user, otherwise
    raises a 404 error (even if the conversation exists but belongs to
    someone else, so nothing about other users' data is revealed).
    """
    conversation = queries.get_conversation(conversation_id)
    if conversation is None or conversation["user_email"] != user_email:
        # Same 404 whether the conversation doesn't exist or belongs to
        # someone else — don't leak existence of other users' conversations.
        raise HTTPException(status.HTTP_404_NOT_FOUND, "conversation not found")
    return conversation


@router.get("/conversations", response_model=list[ConversationOut])
def list_conversations(claims: dict = Depends(get_claims)) -> list[ConversationOut]:
    """Returns the logged-in user's own list of past conversations."""
    return queries.list_conversations(claims["sub"])


@router.get("/conversations/{conversation_id}/messages", response_model=list[MessageOut])
def get_conversation_messages(conversation_id: UUID, claims: dict = Depends(get_claims)) -> list[MessageOut]:
    """Returns all the messages in one of the logged-in user's conversations."""
    _owned_conversation(conversation_id, claims["sub"])
    return queries.get_messages(conversation_id)


@router.delete("/conversations/{conversation_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_conversation(conversation_id: UUID, claims: dict = Depends(get_claims)) -> None:
    """Lets the logged-in user permanently delete one of their own conversations."""
    _owned_conversation(conversation_id, claims["sub"])
    queries.delete_conversation(conversation_id)
