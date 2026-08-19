from collections.abc import Callable
from functools import lru_cache

from langsmith import traceable
from sentence_transformers import SentenceTransformer

from app.config import settings

_BATCH_SIZE = 16


@lru_cache(maxsize=1)
def _model() -> SentenceTransformer:
    """Loads (and caches) the AI model that turns text into numeric vectors."""
    return SentenceTransformer(settings.EMBEDDING_MODEL)


@traceable(
    name="embed_chunks",
    run_type="tool",
    tags=["ingestion", "embedding"],
    # on_progress is a callback, not data - and the embedding vectors
    # themselves are large and not human-readable, so log shape instead of
    # the raw floats.
    process_inputs=lambda inputs: {"chunk_count": len(inputs.get("texts", []))},
    process_outputs=lambda output: {
        "embedded_count": len(output),
        "dims": len(output[0]) if output else 0,
    },
)
def embed_texts(texts: list[str], on_progress: Callable[[int, int], None] | None = None) -> list[list[float]]:
    """Converts a list of text passages into numeric vectors that capture their
    meaning, so they can be compared or searched by similarity.

    Encodes in small batches (rather than one `encode()` call) so `on_progress`
    (if given) can be called with (chunks_done, chunks_total) after each batch
    - this is the slowest step of ingestion for large documents, so it's the
    one place fine-grained progress reporting actually matters.
    """
    if not texts:
        return []

    model = _model()
    embeddings: list[list[float]] = []
    for start in range(0, len(texts), _BATCH_SIZE):
        batch = texts[start : start + _BATCH_SIZE]
        embeddings.extend(model.encode(batch, convert_to_numpy=True).tolist())
        if on_progress is not None:
            on_progress(len(embeddings), len(texts))
    return embeddings
