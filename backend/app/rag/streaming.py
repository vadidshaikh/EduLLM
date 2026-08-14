from collections.abc import Iterator
from typing import Any

from app.rag.llm import stream_llm
from app.rag.nodes import (
    answer_messages,
    check_ambiguity_node,
    clarification_messages,
    condense_query_node,
    generate_chart_node,
    load_history_node,
    respond_node,
    retrieve_filtered_node,
    save_messages_node,
    should_chart_node,
    validate_chart_data_node,
)
from app.rag.state import RAGState


def run_query_stream(*, role: str, query: str, conversation_id: str) -> Iterator[dict[str, Any]]:
    """Runs the same pipeline as the compiled graph (see app/rag/graph.py),
    except the final answer/clarification text is streamed token by token
    instead of produced in one blocking call.

    This intentionally re-runs the pipeline step by step outside of
    graph.invoke() rather than trying to get token-level output out of the
    compiled StateGraph: only one node's output (the answer or the
    clarification question) is meant to reach the user live, and every
    other node (ambiguity check, chart classification, chart generation)
    must still run to completion first/after. Duplicating that ordering
    here is simpler and more explicit than filtering LangGraph's internal
    per-node token stream down to just the one node we care about.

    Yields dicts describing what happened, in order:
      - {"type": "token", "text": str}                             zero or more
      - {"type": "done", "answer", "chart", "sources"}              exactly one, last
    """
    state: RAGState = {"role": role, "query": query, "conversation_id": conversation_id}

    state.update(load_history_node(state))
    if state.get("history"):
        state.update(condense_query_node(state))
    state.update(retrieve_filtered_node(state))
    state.update(check_ambiguity_node(state))

    messages = clarification_messages(state) if state["needs_clarification"] else answer_messages(state)

    chunks: list[str] = []
    for chunk in stream_llm(messages):
        chunks.append(chunk)
        yield {"type": "token", "text": chunk}
    state["answer"] = "".join(chunks).strip()

    if not state["needs_clarification"]:
        state.update(should_chart_node(state))
        if state["should_chart"]:
            state.update(generate_chart_node(state))
            state.update(validate_chart_data_node(state))

    state.update(respond_node(state))
    save_messages_node(state)

    yield {
        "type": "done",
        "answer": state["answer"],
        "chart": state.get("chart"),
        "sources": state.get("sources", []),
    }
