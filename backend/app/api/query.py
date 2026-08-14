import json
import logging
import threading

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse

from app.api.schemas import QueryRequest, QueryResponse
from app.auth.dependencies import get_claims
from app.db.queries import create_conversation
from app.rag.graph import graph
from app.rag.streaming import run_query_stream
from app.rag.title import run_title_generation

logger = logging.getLogger(__name__)

router = APIRouter()


def _start_title_generation(conversation_id: str, query: str) -> None:
    """Kicks off title generation on its own thread immediately, so it runs
    concurrently with the main answer pipeline below rather than only after
    the response finishes (which is when FastAPI's BackgroundTasks would
    run it) — the title is then usually ready by the time the first answer
    arrives, instead of leaving the sidebar on "New conversation" for
    several extra seconds.
    """
    threading.Thread(target=run_title_generation, args=(conversation_id, query), daemon=True).start()


@router.post("/query", response_model=QueryResponse)
def query(body: QueryRequest, claims: dict = Depends(get_claims)) -> QueryResponse:
    """Answers a user's question: runs it through the RAG pipeline to get an
    answer (with sources and an optional chart), creating a new conversation
    if needed and generating its title in parallel.
    """
    is_new_conversation = body.conversation_id is None
    conversation_id = body.conversation_id or create_conversation(user_email=claims["sub"])["id"]

    if is_new_conversation:
        _start_title_generation(conversation_id, body.query)

    result = graph.invoke(
        {
            "role": claims["role"],
            "query": body.query,
            "conversation_id": conversation_id,
        }
    )

    return QueryResponse(
        conversation_id=conversation_id,
        answer=result["answer"],
        chart=result["chart"],
        sources=result["sources"],
    )


@router.post("/query/stream")
def query_stream(body: QueryRequest, claims: dict = Depends(get_claims)) -> StreamingResponse:
    """Same as /query, but streams the answer as newline-delimited JSON
    events instead of waiting for the full pipeline to finish:
      {"type": "start", "conversation_id": "..."}          first
      {"type": "token", "text": "..."}                     zero or more
      {"type": "done", "answer", "chart", "sources"}        last, on success
      {"type": "error", "message": "..."}                   last, on failure
    """
    is_new_conversation = body.conversation_id is None
    conversation_id = body.conversation_id or create_conversation(user_email=claims["sub"])["id"]

    if is_new_conversation:
        _start_title_generation(conversation_id, body.query)

    def event_stream():
        yield json.dumps({"type": "start", "conversation_id": str(conversation_id)}) + "\n"
        try:
            for event in run_query_stream(role=claims["role"], query=body.query, conversation_id=conversation_id):
                yield json.dumps(event) + "\n"
        except Exception:
            logger.exception("Streaming query failed")
            yield json.dumps({"type": "error", "message": "Something went wrong."}) + "\n"

    return StreamingResponse(event_stream(), media_type="application/x-ndjson")
