from functools import lru_cache

from sentence_transformers import SentenceTransformer

from app.config import settings


@lru_cache(maxsize=1)
def _model() -> SentenceTransformer:
    return SentenceTransformer(settings.EMBEDDING_MODEL)


def embed_texts(texts: list[str]) -> list[list[float]]:
    return _model().encode(texts, convert_to_numpy=True).tolist()
