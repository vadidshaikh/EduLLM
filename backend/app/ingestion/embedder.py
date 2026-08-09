from functools import lru_cache

from sentence_transformers import SentenceTransformer

from app.config import settings


@lru_cache(maxsize=1)
def _model() -> SentenceTransformer:
    """Loads (and caches) the AI model that turns text into numeric vectors."""
    return SentenceTransformer(settings.EMBEDDING_MODEL)


def embed_texts(texts: list[str]) -> list[list[float]]:
    """Converts a list of text passages into numeric vectors that capture their meaning, so they can be compared or searched by similarity."""
    return _model().encode(texts, convert_to_numpy=True).tolist()
