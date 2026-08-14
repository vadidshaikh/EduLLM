import json
import logging

from fastapi import APIRouter, BackgroundTasks, Depends
from fastapi.responses import StreamingResponse

from app.api.schemas import QueryRequest, QueryResponse
from app.auth.dependencies import get_claims
from app.db.queries import create_conversation
from app.rag.graph import graph
from app.rag.streaming import run_query_stream
from app.rag.title import run_title_generation

logger = logging.getLogger(__name__)

router = APIRouter()


@router.post("/query", response_model=QueryResponse)
def query(
    body: QueryRequest, background_tasks: BackgroundTasks, claims: dict = Depends(get_claims)
) -> QueryResponse:
    """Answers a user's question: runs it through the RAG pipeline to get an
    answer (with sources and an optional chart), creating a new conversation
    if needed and generating a title for it in the background.
    """
    is_new_conversation = body.conversation_id is None
    conversation_id = body.conversation_id or create_conversation(user_email=claims["sub"])["id"]

    result = graph.invoke(
        {
            "role": claims["role"],
            "query": body.query,
            "conversation_id": conversation_id,
        }
    )

    if is_new_conversation:
        # Runs after this response is sent — never makes the user wait on
        # title generation before they see their answer.
        background_tasks.add_task(run_title_generation, conversation_id, body.query, result["answer"])

    return QueryResponse(
        conversation_id=conversation_id,
        answer=result["answer"],
        chart=result["chart"],
        sources=result["sources"],
    )


@router.post("/query/stream")
def query_stream(
    body: QueryRequest, background_tasks: BackgroundTasks, claims: dict = Depends(get_claims)
) -> StreamingResponse:
    """Same as /query, but streams the answer as newline-delimited JSON
    events instead of waiting for the full pipeline to finish:
      {"type": "start", "conversation_id": "..."}          first
      {"type": "token", "text": "..."}                     zero or more
      {"type": "done", "answer", "chart", "sources"}        last, on success
      {"type": "error", "message": "..."}                   last, on failure
    """
    is_new_conversation = body.conversation_id is None
    conversation_id = body.conversation_id or create_conversation(user_email=claims["sub"])["id"]

    def event_stream():
        yield json.dumps({"type": "start", "conversation_id": str(conversation_id)}) + "\n"
        try:
            final = None
            for event in run_query_stream(role=claims["role"], query=body.query, conversation_id=conversation_id):
                if event["type"] == "done":
                    final = event
                yield json.dumps(event) + "\n"
        except Exception:
            logger.exception("Streaming query failed")
            yield json.dumps({"type": "error", "message": "Something went wrong."}) + "\n"
            return

        if is_new_conversation and final is not None:
            # Runs after this response is sent — never makes the user wait
            # on title generation before they see their answer.
            background_tasks.add_task(run_title_generation, conversation_id, body.query, final["answer"])

    response = StreamingResponse(event_stream(), media_type="application/x-ndjson")
    # A path operation that returns a Response object directly bypasses
    # FastAPI's normal background-task wiring, so it has to be attached here
    # explicitly for the title-generation task above to actually run.
    response.background = background_tasks
    return response
