from langgraph.graph import END, START, StateGraph

from app.rag.nodes import (
    generate_answer_node,
    parse_chart_config_node,
    respond_node,
    resolve_role_node,
    retrieve_filtered_node,
    verify_token_node,
)
from app.rag.state import RAGState


def build_graph():
    g = StateGraph(RAGState)
    g.add_node("verify_token", verify_token_node)
    g.add_node("resolve_role", resolve_role_node)
    g.add_node("retrieve_filtered", retrieve_filtered_node)
    g.add_node("generate_answer", generate_answer_node)
    g.add_node("parse_chart_config", parse_chart_config_node)
    g.add_node("respond", respond_node)

    g.add_edge(START, "verify_token")
    g.add_edge("verify_token", "resolve_role")
    g.add_edge("resolve_role", "retrieve_filtered")
    g.add_edge("retrieve_filtered", "generate_answer")
    g.add_edge("generate_answer", "parse_chart_config")
    g.add_edge("parse_chart_config", "respond")
    g.add_edge("respond", END)
    return g.compile()


graph = build_graph()
