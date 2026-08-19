import json
import logging

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse

from app.api.schemas import QueryRequest, QueryResponse
from app.auth.dependencies import get_claims
from app.db.queries import create_conversation
from app.rag.graph import graph
from app.rag.streaming import run_query_stream
from app.tracing import conversation_trace_config

logger = logging.getLogger(__name__)

router = APIRouter()


@router.post("/query", response_model=QueryResponse)
def query(body: QueryRequest, claims: dict = Depends(get_claims)) -> QueryResponse:
    """Answers a user's question: runs it through the RAG pipeline to get an
    answer (with sources and an optional chart), creating a new conversation
    if needed and generating its title inside the same trace.
    """
    conversation_id = body.conversation_id or create_conversation(user_email=claims["sub"])["id"]

    result = graph.invoke(
        {
            "role": claims["role"],
            "query": body.query,
            "conversation_id": conversation_id,
            "messages": [{"role": "user", "content": body.query}],
        },
        config=conversation_trace_config(str(conversation_id)),
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
    conversation_id = body.conversation_id or create_conversation(user_email=claims["sub"])["id"]

    def event_stream():
        yield json.dumps({"type": "start", "conversation_id": str(conversation_id)}) + "\n"
        try:
            for event in run_query_stream(
                role=claims["role"],
                query=body.query,
                conversation_id=str(conversation_id),
            ):
                yield json.dumps(event) + "\n"
        except Exception:
            logger.exception("Streaming query failed")
            yield json.dumps({"type": "error", "message": "Something went wrong."}) + "\n"

    return StreamingResponse(event_stream(), media_type="application/x-ndjson")
