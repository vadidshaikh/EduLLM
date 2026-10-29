from datetime import datetime
from typing import Any
from uuid import UUID

from pydantic import BaseModel


class QueryRequest(BaseModel):
    conversation_id: UUID | None = None
    query: str


class SourceOut(BaseModel):
    title: str
    doc_id: str


class QueryResponse(BaseModel):
    conversation_id: UUID
    answer: str
    chart: dict[str, Any] | None
    sources: list[SourceOut]


class ConversationOut(BaseModel):
    id: UUID
    title: str | None
    is_pinned: bool
    updated_at: datetime


class UpdateConversationRequest(BaseModel):
    title: str | None = None
    is_pinned: bool | None = None


class MessageOut(BaseModel):
    id: UUID
    role: str
    content: str
    chart_config: dict[str, Any] | None
    sources: list[SourceOut] | None
    created_at: datetime


class LoginRequest(BaseModel):
    email: str


class LoginResponse(BaseModel):
    detail: str


class VerifyRequest(BaseModel):
    token: str


class TokenResponse(BaseModel):
    access_token: str


class DocumentOut(BaseModel):
    id: UUID
    title: str
    allowed_roles: list[str]
    status: str
    progress: int
    version: int
    uploaded_by: str
    uploaded_by_name: str | None = None
    uploaded_at: datetime
    updated_by: str | None
    updated_by_name: str | None = None
    updated_at: datetime


class UploadResponse(BaseModel):
    document_id: UUID
    status: str


class UpdateDocumentRequest(BaseModel):
    title: str | None = None
    allowed_roles: list[str] | None = None


class DocumentEventOut(BaseModel):
    id: UUID
    document_id: UUID
    document_title: str
    action: str
    actor_email: str
    actor_name: str
    version: int
    created_at: datetime


class NotificationOut(BaseModel):
    id: UUID
    kind: str
    document_id: UUID
    document_title: str
    version: int
    actor_name: str
    created_at: datetime
    is_read: bool


class NotificationsResponse(BaseModel):
    unread_count: int
    notifications: list[NotificationOut]
