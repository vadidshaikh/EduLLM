from app.config import settings
from app.db.queries import search_chunks
from app.ingestion.embedder import embed_texts
from app.rag.chart_parser import parse_chart_config
from app.rag.llm import call_llm
from app.rag.prompts import CHART_SYSTEM_PROMPT
from app.rag.state import RAGState

VALID_ROLES = {"student", "faculty"}


def verify_token_node(state: RAGState) -> dict:
    """Defensive check only — the real JWT verification already happened in
    the FastAPI dependency before the graph was invoked (see api/query.py).
    This node exists so the auth step is an explicit, traceable node in the
    graph per the spec, not a hidden precondition.
    """
    if not state.get("sub"):
        raise ValueError("missing verified subject in graph state")
    return {}


def resolve_role_node(state: RAGState) -> dict:
    role = state.get("role")
    if role not in VALID_ROLES:
        raise ValueError(f"missing or invalid role in graph state: {role!r}")
    return {"role": role}


def retrieve_filtered_node(state: RAGState) -> dict:
    query_embedding = embed_texts([state["query"]])[0]
    chunks = search_chunks(role=state["role"], embedding=query_embedding, top_k=settings.TOP_K)
    return {"retrieved_chunks": chunks}


def generate_answer_node(state: RAGState) -> dict:
    context = "\n\n---\n\n".join(c["chunk_text"] for c in state["retrieved_chunks"])
    messages = [
        {"role": "system", "content": CHART_SYSTEM_PROMPT},
        {"role": "user", "content": f"Context:\n\n{context}\n\nQuestion: {state['query']}"},
    ]
    return {"raw_answer": call_llm(messages)}


def parse_chart_config_node(state: RAGState) -> dict:
    answer, chart = parse_chart_config(state["raw_answer"])
    return {"answer": answer, "chart": chart}


def respond_node(state: RAGState) -> dict:
    seen: set[str] = set()
    sources = []
    for chunk in state["retrieved_chunks"]:
        doc_id = str(chunk["document_id"])
        if doc_id not in seen:
            seen.add(doc_id)
            sources.append({"title": chunk["title"], "doc_id": doc_id})
    return {"sources": sources}
