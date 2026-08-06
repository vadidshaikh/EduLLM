import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.admin_documents import router as admin_documents_router
from app.api.auth import router as auth_router
from app.api.conversations import router as conversations_router
from app.api.query import router as query_router
from app.db.pool import pool

# Without this, INFO-level logs (e.g. the magic-link dev-mode fallback in
# app/auth/mailer.py) are silently dropped — Python's root logger defaults
# to WARNING with no handler configured.
logging.basicConfig(level=logging.INFO)


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
app.include_router(auth_router)
app.include_router(conversations_router)


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}
