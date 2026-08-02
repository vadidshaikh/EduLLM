from langchain_text_splitters import RecursiveCharacterTextSplitter

from app.config import settings

_splitter = RecursiveCharacterTextSplitter(
    chunk_size=settings.CHUNK_SIZE,
    chunk_overlap=settings.CHUNK_OVERLAP,
)


def split_text(text: str) -> list[str]:
    return _splitter.split_text(text)
