from collections.abc import Iterator
from typing import Any

from app.rag.graph import graph
from app.tracing import conversation_trace_config


def run_query_stream(*, role: str, query: str, conversation_id: str) -> Iterator[dict[str, Any]]:
    """Runs the question through the same compiled graph as app/rag/graph.py
    (so LangSmith traces this as one real LangGraph run, with the proper
    node-graph structure, instead of a hand-rolled chain), streaming the
    answer token by token as generate_answer_node emits them via
    LangGraph's custom stream writer.

    Yields dicts describing what happened, in order:
      - {"type": "token", "text": str}                             zero or more
      - {"type": "done", "answer", "chart", "sources",
         "user_message_id", "assistant_message_id"}                exactly one, last
    """
    initial_state = {
        "role": role,
        "query": query,
        "conversation_id": conversation_id,
        "messages": [{"role": "user", "content": query}],
    }

    final_state: dict[str, Any] = {}
    for stream_mode, payload in graph.stream(
        initial_state,
        config=conversation_trace_config(conversation_id),
        stream_mode=["custom", "values"],
    ):
        if stream_mode == "custom":
            yield payload
        else:
            final_state = payload

    yield {
        "type": "done",
        "answer": final_state["answer"],
        "chart": final_state.get("chart"),
        "sources": final_state.get("sources", []),
        "user_message_id": str(final_state["user_message_id"]),
        "assistant_message_id": str(final_state["assistant_message_id"]),
    }
