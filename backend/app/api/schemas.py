from datetime import datetime
from typing import Any
from uuid import UUID

from pydantic import BaseModel


class QueryRequest(BaseModel):
    query: str


class SourceOut(BaseModel):
    title: str
    doc_id: str


class QueryResponse(BaseModel):
    answer: str
    chart: dict[str, Any] | None
    sources: list[SourceOut]


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
