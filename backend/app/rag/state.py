from typing import Any, TypedDict


class RAGState(TypedDict, total=False):
    role: str
    sub: str
    query: str
    retrieved_chunks: list[dict[str, Any]]
    raw_answer: str
    answer: str
    chart: dict[str, Any] | None
    sources: list[dict[str, Any]]
