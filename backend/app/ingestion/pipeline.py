import logging
from pathlib import Path
from uuid import UUID

from app.db import queries
from app.ingestion.embedder import embed_texts
from app.ingestion.parser import parse_to_markdown
from app.ingestion.splitter import split_text

logger = logging.getLogger(__name__)



# Rough share of total processing time each stage takes for a typical
# document, used to turn stage completion (and, within embedding, batch
# completion) into one 0-100 progress number the frontend can show as a bar.
_PARSE_DONE_PROGRESS = 15
_SPLIT_DONE_PROGRESS = 20
_EMBED_DONE_PROGRESS = 90


def run_ingestion(document_id: UUID) -> None:
    """parse -> split -> embed -> replace chunks -> update status.

    Runs as a FastAPI BackgroundTask after the documents row is created with
    status=queued. Failures are caught and recorded on the row rather than
    raised, since there's no caller left listening by the time this runs.
    Progress is written to the documents row at each stage (and per batch
    during embedding, the slowest stage) so the frontend can poll it to show
    a progress bar instead of an indefinite "processing" label.
    """
    document = queries.get_document(document_id)
    if document is None:
        logger.error("run_ingestion: document %s not found", document_id)
        return

    try:
        queries.update_document_status(document_id, "processing", progress=5)

        text = parse_to_markdown(Path(document["storage_path"]))
        queries.update_document_progress(document_id, _PARSE_DONE_PROGRESS)

        chunks = split_text(text)
        queries.update_document_progress(document_id, _SPLIT_DONE_PROGRESS)

        embed_span = _EMBED_DONE_PROGRESS - _SPLIT_DONE_PROGRESS

        def _on_embed_progress(done: int, total: int) -> None:
            progress = _SPLIT_DONE_PROGRESS + round(embed_span * done / total)
            queries.update_document_progress(document_id, progress)

        embeddings = embed_texts(chunks, on_progress=_on_embed_progress)

        chunk_rows = [
            {"chunk_text": chunk, "chunk_index": i, "embedding": embedding}
            for i, (chunk, embedding) in enumerate(zip(chunks, embeddings))
        ]
        queries.replace_chunks(document_id, chunk_rows, document["allowed_roles"])
        queries.update_document_status(document_id, "indexed", progress=100)
    except Exception:
        logger.exception("run_ingestion failed for document %s", document_id)
        queries.update_document_status(document_id, "failed")
