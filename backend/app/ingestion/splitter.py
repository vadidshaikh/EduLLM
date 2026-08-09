from langchain_text_splitters import RecursiveCharacterTextSplitter

from app.config import settings

_splitter = RecursiveCharacterTextSplitter(
    chunk_size=settings.CHUNK_SIZE,
    chunk_overlap=settings.CHUNK_OVERLAP,
)


def split_text(text: str) -> list[str]:
    """Splits a long document into smaller overlapping chunks so it can be searched and retrieved more accurately.

    Example: split_text("...4000+ characters of text...") -> ["chunk 1 text", "chunk 2 text", ...]
    """
    return _splitter.split_text(text)
