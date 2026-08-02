from fastapi import APIRouter, Depends

from app.api.schemas import QueryRequest, QueryResponse
from app.auth.dependencies import get_claims
from app.rag.graph import graph

router = APIRouter()


@router.post("/query", response_model=QueryResponse)
def query(body: QueryRequest, claims: dict = Depends(get_claims)) -> QueryResponse:
    result = graph.invoke(
        {"role": claims["role"], "sub": claims["sub"], "query": body.query}
    )
    return QueryResponse(
        answer=result["answer"],
        chart=result["chart"],
        sources=result["sources"],
    )
