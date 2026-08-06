from langgraph.graph import END, START, StateGraph

from app.rag.nodes import (
    condense_query_node,
    generate_answer_node,
    generate_chart_node,
    load_history_node,
    resolve_role_node,
    respond_node,
    retrieve_filtered_node,
    save_messages_node,
    should_chart_node,
    validate_chart_data_node,
    verify_token_node,
)
from app.rag.state import RAGState


def _route_after_history(state: RAGState) -> str:
    return "condense_query" if state.get("history") else "retrieve_filtered"


def _route_after_should_chart(state: RAGState) -> str:
    return "generate_chart" if state.get("should_chart") else "respond"


def build_graph():
    g = StateGraph(RAGState)
    g.add_node("verify_token", verify_token_node)
    g.add_node("resolve_role", resolve_role_node)
    g.add_node("load_history", load_history_node)
    g.add_node("condense_query", condense_query_node)
    g.add_node("retrieve_filtered", retrieve_filtered_node)
    g.add_node("generate_answer", generate_answer_node)
    g.add_node("should_chart", should_chart_node)
    g.add_node("generate_chart", generate_chart_node)
    g.add_node("validate_chart_data", validate_chart_data_node)
    g.add_node("respond", respond_node)
    g.add_node("save_messages", save_messages_node)

    g.add_edge(START, "verify_token")
    g.add_edge("verify_token", "resolve_role")
    g.add_edge("resolve_role", "load_history")

    # A raw follow-up ("what about for final year students?") retrieves
    # badly on its own — condense it into a standalone query first, but only
    # when there's history to condense against.
    g.add_conditional_edges(
        "load_history",
        _route_after_history,
        {"condense_query": "condense_query", "retrieve_filtered": "retrieve_filtered"},
    )
    g.add_edge("condense_query", "retrieve_filtered")
    g.add_edge("retrieve_filtered", "generate_answer")

    # Chart inclusion is decided by a dedicated classifier, not a
    # side-instruction inside generate_answer's prompt (that was the root
    # cause of charts appearing on every message).
    g.add_edge("generate_answer", "should_chart")
    g.add_conditional_edges(
        "should_chart",
        _route_after_should_chart,
        {"generate_chart": "generate_chart", "respond": "respond"},
    )
    g.add_edge("generate_chart", "validate_chart_data")
    g.add_edge("validate_chart_data", "respond")

    g.add_edge("respond", "save_messages")
    g.add_edge("save_messages", END)
    return g.compile()


graph = build_graph()
