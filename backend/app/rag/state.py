from typing import Any, TypedDict


class RAGState(TypedDict, total=False):
    role: str
    sub: str
    query: str
    conversation_id: str
    history: list[dict[str, Any]]
    condensed_query: str
    retrieved_chunks: list[dict[str, Any]]
    answer: str
    should_chart: bool
    chart: dict[str, Any] | None
    sources: list[dict[str, Any]]
