from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status

from app.api.schemas import ConversationOut, MessageOut
from app.auth.dependencies import get_claims
from app.db import queries

router = APIRouter()


def _owned_conversation(conversation_id: UUID, user_email: str) -> dict:
    conversation = queries.get_conversation(conversation_id)
    if conversation is None or conversation["user_email"] != user_email:
        # Same 404 whether the conversation doesn't exist or belongs to
        # someone else — don't leak existence of other users' conversations.
        raise HTTPException(status.HTTP_404_NOT_FOUND, "conversation not found")
    return conversation


@router.get("/conversations", response_model=list[ConversationOut])
def list_conversations(claims: dict = Depends(get_claims)) -> list[ConversationOut]:
    return queries.list_conversations(claims["sub"])


@router.get("/conversations/{conversation_id}/messages", response_model=list[MessageOut])
def get_conversation_messages(conversation_id: UUID, claims: dict = Depends(get_claims)) -> list[MessageOut]:
    _owned_conversation(conversation_id, claims["sub"])
    return queries.get_messages(conversation_id)


@router.delete("/conversations/{conversation_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_conversation(conversation_id: UUID, claims: dict = Depends(get_claims)) -> None:
    _owned_conversation(conversation_id, claims["sub"])
    queries.delete_conversation(conversation_id)
