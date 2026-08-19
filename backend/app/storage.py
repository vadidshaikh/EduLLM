import hashlib
import uuid
from pathlib import Path

from langsmith import traceable

from app.config import settings


def storage_dir() -> Path:
    """Finds (and creates if needed) the folder on disk where uploaded files are kept."""
    path = Path(settings.STORAGE_DIR)
    path.mkdir(parents=True, exist_ok=True)
    return path


@traceable(
    name="save_uploaded_file",
    run_type="tool",
    tags=["ingestion", "upload"],
    # Never send the raw file bytes to LangSmith - just note the size.
    process_inputs=lambda inputs: {
        "original_filename": inputs.get("original_filename"),
        "size_bytes": len(inputs.get("file_bytes", b"")),
    },
    process_outputs=lambda output: {"storage_path": str(output)},
)
def save_upload_file(file_bytes: bytes, original_filename: str) -> Path:
    """Save uploaded bytes under a random name, preserving the extension."""
    suffix = Path(original_filename).suffix
    dest = storage_dir() / f"{uuid.uuid4()}{suffix}"
    dest.write_bytes(file_bytes)
    return dest


def compute_file_hash(file_bytes: bytes) -> str:
    """Creates a unique fingerprint for a file's contents so duplicate uploads can be detected."""
    return hashlib.sha256(file_bytes).hexdigest()
