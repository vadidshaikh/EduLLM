import logging
from pathlib import Path
from uuid import UUID

from app.db import queries
from app.ingestion.embedder import embed_texts
from app.ingestion.parser import parse_to_markdown
from app.ingestion.splitter import split_text

logger = logging.getLogger(__name__)


def run_ingestion(document_id: UUID) -> None:
    """parse -> split -> embed -> replace chunks -> update status.

    Runs as a FastAPI BackgroundTask after the documents row is created with
    status=queued. Failures are caught and recorded on the row rather than
    raised, since there's no caller left listening by the time this runs.
    """
    document = queries.get_document(document_id)
    if document is None:
        logger.error("run_ingestion: document %s not found", document_id)
        return

    try:
        queries.update_document_status(document_id, "processing")

        text = parse_to_markdown(Path(document["storage_path"]))
        chunks = split_text(text)
        embeddings = embed_texts(chunks)

        chunk_rows = [
            {"chunk_text": chunk, "chunk_index": i, "embedding": embedding}
            for i, (chunk, embedding) in enumerate(zip(chunks, embeddings))
        ]
        queries.replace_chunks(document_id, chunk_rows, document["allowed_roles"])
        queries.update_document_status(document_id, "indexed")
    except Exception:
        logger.exception("run_ingestion failed for document %s", document_id)
        queries.update_document_status(document_id, "failed")
