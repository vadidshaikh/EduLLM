from fastapi import APIRouter, BackgroundTasks, Depends

from app.api.schemas import QueryRequest, QueryResponse
from app.auth.dependencies import get_claims
from app.db.queries import create_conversation
from app.rag.graph import graph
from app.rag.title import run_title_generation

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
            "sub": claims["sub"],
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
