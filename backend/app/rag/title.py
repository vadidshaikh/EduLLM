"""Auto-generated chat titles, produced as their own tiny LangGraph — kept
separate from the main query graph (app/rag/graph.py) so it can be invoked
as a FastAPI background task *after* the user's answer is already on the
wire, instead of adding latency to every first message in a conversation.
"""
from langgraph.graph import END, START, StateGraph

from app.db.queries import update_conversation_title
from app.rag.nodes import generate_title_node

_title_graph = StateGraph(dict)
_title_graph.add_node("generate_title", generate_title_node)
_title_graph.add_edge(START, "generate_title")
_title_graph.add_edge("generate_title", END)
title_graph = _title_graph.compile()


def run_title_generation(conversation_id: str, first_question: str, first_answer: str) -> None:
    """Generates a short title for a conversation from its first question and answer, then saves it to the database."""
    result = title_graph.invoke({"first_question": first_question, "first_answer": first_answer})
    update_conversation_title(conversation_id, result["title"])
