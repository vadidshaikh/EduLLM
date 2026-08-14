"""Auto-generated chat titles, produced as their own tiny LangGraph — kept
separate from the main query graph (app/rag/graph.py) so it can run on its
own thread (see app/api/query.py) concurrently with the main answer
pipeline, from just the user's first message, instead of adding latency to
every first message in a conversation or waiting on the answer to exist.
"""
from langgraph.graph import END, START, StateGraph

from app.db.queries import update_conversation_title
from app.rag.nodes import generate_title_node

_title_graph = StateGraph(dict)
_title_graph.add_node("generate_title", generate_title_node)
_title_graph.add_edge(START, "generate_title")
_title_graph.add_edge("generate_title", END)
title_graph = _title_graph.compile()


def run_title_generation(conversation_id: str, first_question: str) -> None:
    """Generates a short title for a conversation from its first message and saves it to the database."""
    result = title_graph.invoke({"first_question": first_question})
    update_conversation_title(conversation_id, result["title"])
