from langchain_text_splitters import RecursiveCharacterTextSplitter
from langsmith import traceable

from app.config import settings

_splitter = RecursiveCharacterTextSplitter(
    chunk_size=settings.CHUNK_SIZE,
    chunk_overlap=settings.CHUNK_OVERLAP,
)


@traceable(
    name="chunk_document",
    run_type="tool",
    tags=["ingestion", "chunking"],
    process_inputs=lambda inputs: {"text_chars": len(inputs.get("text", ""))},
    process_outputs=lambda output: {"chunk_count": len(output)},
)
def split_text(text: str) -> list[str]:
    """Splits a long document into smaller overlapping chunks so it can be searched and retrieved more accurately.

    Example: split_text("...4000+ characters of text...") -> ["chunk 1 text", "chunk 2 text", ...]
    """
    return _splitter.split_text(text)
