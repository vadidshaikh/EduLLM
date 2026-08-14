import logging
import re

from app.config import settings
from app.db.queries import get_recent_messages, insert_message, search_chunks, touch_conversation
from app.ingestion.embedder import embed_texts
from app.rag.chart_parser import parse_chart_json
from app.rag.llm import call_llm
from app.rag.prompts import (
    ANSWER_SYSTEM_PROMPT,
    CHECK_AMBIGUITY_PROMPT,
    CONDENSE_QUERY_PROMPT,
    GENERATE_CHART_PROMPT,
    GENERATE_CLARIFICATION_PROMPT,
    GENERATE_TITLE_PROMPT,
    SHOULD_CHART_PROMPT,
)
from app.rag.state import RAGState

logger = logging.getLogger(__name__)

_HISTORY_WINDOW = 10
_NUMBER_PATTERN = re.compile(r"-?\d[\d,]*\.?\d*")


def _format_history(history: list[dict]) -> str:
    """Turns a list of past chat messages into one readable block of text, like a transcript."""
    return "\n".join(f"{m['role'].capitalize()}: {m['content']}" for m in history)


def _context_text(state: RAGState) -> str:
    """Joins all the retrieved document chunks into one big block of text to feed to the AI model."""
    return "\n\n---\n\n".join(c["chunk_text"] for c in state["retrieved_chunks"])


def load_history_node(state: RAGState) -> dict:
    """Fetches the recent messages from this conversation so far, to give the assistant context about earlier turns."""
    conversation_id = state.get("conversation_id")
    if not conversation_id:
        return {"history": []}
    messages = get_recent_messages(conversation_id, limit=_HISTORY_WINDOW)
    return {"history": [{"role": m["role"], "content": m["content"]} for m in messages]}


def condense_query_node(state: RAGState) -> dict:
    """Only reached (via graph routing) when history is non-empty. Folds
    conversation context into the search query so follow-ups retrieve
    correctly instead of just answering blind.
    """
    history_text = _format_history(state["history"])
    messages = [
        {"role": "system", "content": CONDENSE_QUERY_PROMPT},
        {
            "role": "user",
            "content": f"Conversation so far:\n{history_text}\n\nNew question: {state['query']}\n\nStandalone search query:",
        },
    ]
    condensed = call_llm(messages, temperature=0).strip()
    return {"condensed_query": condensed}


def retrieve_filtered_node(state: RAGState) -> dict:
    """Looks up the document chunks most relevant to the user's question, only returning ones the user's role is allowed to see."""
    search_query = state.get("condensed_query") or state["query"]
    query_embedding = embed_texts([search_query])[0]
    chunks = search_chunks(role=state["role"], embedding=query_embedding, top_k=settings.TOP_K)
    return {"retrieved_chunks": chunks}


def check_ambiguity_node(state: RAGState) -> dict:
    """Asks the AI model whether the retrieved context contains multiple
    distinct entities (e.g. two different people with the same name) that
    the question's wording doesn't already distinguish between.
    """
    question = state.get("condensed_query") or state["query"]
    messages = [
        {"role": "system", "content": CHECK_AMBIGUITY_PROMPT},
        {"role": "user", "content": f"Question: {question}\n\nRetrieved context:\n{_context_text(state)}"},
    ]
    verdict = call_llm(messages, temperature=0).strip().lower()
    return {"needs_clarification": verdict.startswith("yes")}


def generate_clarification_node(state: RAGState) -> dict:
    """Only reached (via graph routing) when check_ambiguity_node said yes.
    Asks the user which of the matching entities they meant instead of
    guessing. The next user message is resolved back into a disambiguated
    search query by condense_query_node's normal history handling, so no
    extra state needs to be tracked across turns.
    """
    question = state.get("condensed_query") or state["query"]
    messages = [
        {"role": "system", "content": GENERATE_CLARIFICATION_PROMPT},
        {"role": "user", "content": f"Question: {question}\n\nRetrieved context:\n{_context_text(state)}"},
    ]
    return {"answer": call_llm(messages).strip()}


def generate_answer_node(state: RAGState) -> dict:
    """Asks the AI model to write an answer to the user's question using only the retrieved document chunks (and recent chat history) as its source material."""
    context = _context_text(state)
    question = state.get("condensed_query") or state["query"]

    messages = [{"role": "system", "content": ANSWER_SYSTEM_PROMPT}]
    if state.get("history"):
        messages.append(
            {"role": "system", "content": f"Recent conversation history:\n{_format_history(state['history'])}"}
        )
    messages.append({"role": "user", "content": f"Context:\n\n{context}\n\nQuestion: {question}"})

    return {"answer": call_llm(messages).strip()}


def should_chart_node(state: RAGState) -> dict:
    """Asks the AI model to judge whether this question and answer would benefit from being shown as a chart."""
    messages = [
        {"role": "system", "content": SHOULD_CHART_PROMPT},
        {
            "role": "user",
            "content": f"Question: {state['query']}\n\nAnswer: {state['answer']}\n\nContext:\n{_context_text(state)}",
        },
    ]
    verdict = call_llm(messages, temperature=0).strip().lower()
    return {"should_chart": verdict.startswith("yes")}


def generate_chart_node(state: RAGState) -> dict:
    """Only reached (via graph routing) when should_chart_node said yes."""
    messages = [
        {"role": "system", "content": GENERATE_CHART_PROMPT},
        {
            "role": "user",
            "content": f"Question: {state['query']}\n\nAnswer: {state['answer']}\n\nContext:\n{_context_text(state)}",
        },
    ]
    raw = call_llm(messages, temperature=0)
    return {"chart": parse_chart_json(raw)}


def _numbers_in(text: str) -> set[float]:
    """Pulls out every number that appears in a piece of text, so it can be compared elsewhere.

    Example: _numbers_in("Sales grew 12.5% to 1,200 units") -> {12.5, 1200.0}
    """
    numbers = set()
    for match in _NUMBER_PATTERN.findall(text):
        try:
            numbers.add(float(match.replace(",", "")))
        except ValueError:
            continue
    return numbers


def validate_chart_data_node(state: RAGState) -> dict:
    """Deterministic backstop (plain code, not an LLM call): every numeric
    value in the chart's data must appear in the retrieved context. If any
    value can't be matched, drop the chart entirely rather than send
    fabricated numbers to the user.
    """
    chart = state.get("chart")
    if not chart:
        return {}

    context_numbers = _numbers_in(_context_text(state))
    chart_numbers = set()
    for dataset in chart.get("datasets", []):
        for value in dataset.get("data", []):
            try:
                chart_numbers.add(float(value))
            except (TypeError, ValueError):
                continue

    missing = chart_numbers - context_numbers
    if missing:
        logger.warning("Dropping chart: values %s not found in retrieved context", missing)
        return {"chart": None}

    return {}


def respond_node(state: RAGState) -> dict:
    """Builds the final list of unique source documents to show the user, alongside whatever chart (if any) was generated."""
    seen: set[str] = set()
    sources = []
    for chunk in state["retrieved_chunks"]:
        doc_id = str(chunk["document_id"])
        if doc_id not in seen:
            seen.add(doc_id)
            sources.append({"title": chunk["title"], "doc_id": doc_id})
    # Always set "chart" so it's present in the final state even when the
    # should-chart branch was skipped entirely.
    return {"sources": sources, "chart": state.get("chart")}


def save_messages_node(state: RAGState) -> dict:
    """Saves the user's question and the assistant's answer to the conversation history in the database."""
    conversation_id = state["conversation_id"]
    insert_message(conversation_id=conversation_id, role="user", content=state["query"])
    insert_message(
        conversation_id=conversation_id,
        role="assistant",
        content=state["answer"],
        chart_config=state.get("chart"),
        sources=state.get("sources"),
    )
    touch_conversation(conversation_id)
    return {}


def generate_title_node(state: dict) -> dict:
    """Standalone node (not wired into the main graph — see app/rag/title.py)
    invoked as a background task after the response is already sent, so
    title generation never blocks the user's answer.
    """
    messages = [
        {"role": "system", "content": GENERATE_TITLE_PROMPT},
        {"role": "user", "content": f"Question: {state['first_question']}\n\nAnswer: {state['first_answer']}"},
    ]
    title = call_llm(messages, temperature=0.3).strip().strip('"').rstrip(".")
    return {"title": title[:80]}
