from typing import Any, TypedDict


class RAGState(TypedDict, total=False):
    # Who is asking (from the verified JWT) and, optionally, the one
    # workspace/classroom to search. retrieve_filtered passes these to
    # search_chunks, which works out what the user may read.
    user_email: str
    role: str
    scope_id: str | None
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
