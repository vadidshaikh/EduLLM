from typing import Any, TypedDict


class RAGState(TypedDict, total=False):
    role: str
    query: str
    conversation_id: str
    # Carries the current question in LangChain's role/content shape purely
    # so LangSmith's trace/thread UI can detect it and preview the actual
    # question instead of falling back to showing the raw thread_id (a
    # conversation UUID) as the trace's "input".
    messages: list[dict[str, Any]]
    title: str
    history: list[dict[str, Any]]
    condensed_query: str
    retrieved_chunks: list[dict[str, Any]]
    answer: str
    should_chart: bool
    chart: dict[str, Any] | None
    sources: list[dict[str, Any]]
    user_message_id: Any
    assistant_message_id: Any
