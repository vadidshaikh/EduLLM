from pathlib import Path

from dotenv import load_dotenv
from pydantic_settings import BaseSettings, SettingsConfigDict

# The repo-root .env is the single source of secrets/config for both local
# runs and docker-compose (which also passes it via env_file:). Loading it
# here means `python scripts/foo.py` and `uvicorn app.main:app` behave the
# same without needing a shell to `source` anything first.
_REPO_ROOT_ENV = Path(__file__).resolve().parent.parent.parent / ".env"
if _REPO_ROOT_ENV.exists():
    load_dotenv(_REPO_ROOT_ENV)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore")

    DATABASE_URL: str = "postgresql://edullm:edullm@localhost:5432/edullm"

    JWT_SECRET: str = "dev-secret-change-me"
    JWT_ALGORITHM: str = "HS256"

    HF_TOKEN: str = ""
    LLM_MODEL: str = "huggingface/featherless-ai/Qwen/Qwen2.5-7B-Instruct"
    EMBEDDING_MODEL: str = "sentence-transformers/multi-qa-mpnet-base-dot-v1"

    STORAGE_DIR: str = str(Path(__file__).resolve().parent.parent / "storage")

    CHUNK_SIZE: int = 4000
    CHUNK_OVERLAP: int = 800
    TOP_K: int = 5

    # Phase 2: email magic-link login, sent via Mailjet's HTTP API. If
    # MAILJET_API_KEY is unset, the magic link is logged instead of emailed —
    # zero-setup for local dev.
    MAILJET_API_KEY: str = ""
    MAILJET_API_SECRET: str = ""
    MAILJET_FROM_EMAIL: str = ""
    MAILJET_FROM_NAME: str = "Edu LLM"

    MAGIC_LINK_BASE_URL: str = "http://localhost:5173/auth/verify"
    LOGIN_TOKEN_EXPIRY_MINUTES: int = 15
    SESSION_JWT_EXPIRY_DAYS: int = 7


settings = Settings()
