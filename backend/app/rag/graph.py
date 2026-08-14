from langgraph.graph import END, START, StateGraph

from app.rag.nodes import (
    check_ambiguity_node,
    condense_query_node,
    generate_answer_node,
    generate_chart_node,
    generate_clarification_node,
    load_history_node,
    respond_node,
    retrieve_filtered_node,
    save_messages_node,
    should_chart_node,
    validate_chart_data_node,
)
from app.rag.state import RAGState


def _route_after_history(state: RAGState) -> str:
    """Decides whether to rewrite the question using conversation history, or skip straight to searching documents."""
    return "condense_query" if state.get("history") else "retrieve_filtered"


def _route_after_should_chart(state: RAGState) -> str:
    """Decides whether to generate a chart for the answer or go straight to sending the response."""
    return "generate_chart" if state.get("should_chart") else "respond"


def _route_after_ambiguity_check(state: RAGState) -> str:
    """Decides whether the retrieved context matches multiple distinct entities and needs a clarifying question first, or can go straight to answering."""
    return "generate_clarification" if state.get("needs_clarification") else "generate_answer"


def build_graph():
    """Wires together the question-answering flow: load history, search documents, answer, maybe chart, respond, save."""
    g = StateGraph(RAGState)
    g.add_node("load_history", load_history_node)
    g.add_node("condense_query", condense_query_node)
    g.add_node("retrieve_filtered", retrieve_filtered_node)
    g.add_node("check_ambiguity", check_ambiguity_node)
    g.add_node("generate_clarification", generate_clarification_node)
    g.add_node("generate_answer", generate_answer_node)
    g.add_node("should_chart", should_chart_node)
    g.add_node("generate_chart", generate_chart_node)
    g.add_node("validate_chart_data", validate_chart_data_node)
    g.add_node("respond", respond_node)
    g.add_node("save_messages", save_messages_node)

    g.add_edge(START, "load_history")

    # A raw follow-up ("what about for final year students?") retrieves
    # badly on its own — condense it into a standalone query first, but only
    # when there's history to condense against.
    g.add_conditional_edges(
        "load_history",
        _route_after_history,
        {"condense_query": "condense_query", "retrieve_filtered": "retrieve_filtered"},
    )
    g.add_edge("condense_query", "retrieve_filtered")
    g.add_edge("retrieve_filtered", "check_ambiguity")

    # If the retrieved context matches multiple distinct entities under the
    # same name/reference (e.g. two "Jaydeep sir"s), ask which one the user
    # means instead of guessing. The clarifying question is just another
    # assistant message, so the user's reply resolves it via the normal
    # condense_query history handling on the next turn.
    g.add_conditional_edges(
        "check_ambiguity",
        _route_after_ambiguity_check,
        {"generate_clarification": "generate_clarification", "generate_answer": "generate_answer"},
    )
    g.add_edge("generate_clarification", "respond")

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
