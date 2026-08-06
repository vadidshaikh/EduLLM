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
    updated_at: datetime


class MessageOut(BaseModel):
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
    version: int
    uploaded_at: datetime


class UploadResponse(BaseModel):
    document_id: UUID
    status: str
