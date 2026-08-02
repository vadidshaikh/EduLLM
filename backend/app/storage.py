import hashlib
import uuid
from pathlib import Path

from app.config import settings


def storage_dir() -> Path:
    path = Path(settings.STORAGE_DIR)
    path.mkdir(parents=True, exist_ok=True)
    return path


def save_upload_file(file_bytes: bytes, original_filename: str) -> Path:
    """Save uploaded bytes under a random name, preserving the extension."""
    suffix = Path(original_filename).suffix
    dest = storage_dir() / f"{uuid.uuid4()}{suffix}"
    dest.write_bytes(file_bytes)
    return dest


def compute_file_hash(file_bytes: bytes) -> str:
    return hashlib.sha256(file_bytes).hexdigest()
