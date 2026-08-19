from typing import Any


def conversation_trace_config(conversation_id: str) -> dict[str, Any]:
    """Groups every turn for a conversation into one LangSmith thread, and
    names each trace after the chat it belongs to (LangSmith otherwise
    labels every run "chat_turn", making them indistinguishable in the
    traces list).
    """
    return {
        "configurable": {"thread_id": str(conversation_id)},
        "metadata": {
            "conversation_id": str(conversation_id),
            "session_id": str(conversation_id),
        },
        "run_name": f"chat-{conversation_id}",
    }


def document_trace_extra(document_id: str, title: str | None = None) -> dict[str, Any]:
    """Builds the `langsmith_extra` kwarg for a document's ingestion pipeline
    (upload -> parse -> chunk -> embed -> index), naming the run after the
    document and grouping its stages into one LangSmith thread - the
    ingestion-side counterpart to conversation_trace_config.
    """
    return {
        "name": f"ingest-{title or document_id}",
        "tags": ["ingestion"],
        "metadata": {
            "document_id": str(document_id),
            "session_id": str(document_id),
        },
    }
