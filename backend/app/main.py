from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.admin_documents import router as admin_documents_router
from app.api.query import router as query_router
from app.db.pool import pool


@asynccontextmanager
async def lifespan(app: FastAPI):
    pool.open()
    yield
    pool.close()


app = FastAPI(title="Edu LLM", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(query_router)
app.include_router(admin_documents_router)


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}
