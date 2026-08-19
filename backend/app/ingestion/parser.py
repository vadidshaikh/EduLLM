import shutil
import subprocess
import tempfile
from pathlib import Path

import pymupdf as fitz
from langsmith import traceable

from app.config import settings
from app.ingestion.ocr import run_document_ocr
from app.storage import storage_dir

_IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".bmp", ".tiff", ".tif", ".webp", ".gif"}

# Different LibreOffice packagings expose different binary names on PATH
# (apt's package ships `soffice`; the snap package only symlinks `libreoffice`).
_SOFFICE_BIN = shutil.which("soffice") or shutil.which("libreoffice") or "soffice"


def _convert_to_pdf(path: Path, out_dir: Path) -> Path:
    """Convert an office/HTML document to PDF via headless LibreOffice, so
    every non-image format can be rendered to page images for OCR."""
    subprocess.run(
        [_SOFFICE_BIN, "--headless", "--convert-to", "pdf", "--outdir", str(out_dir), str(path)],
        check=True,
        capture_output=True,
        timeout=180,
    )
    pdf_path = out_dir / f"{path.stem}.pdf"
    if not pdf_path.exists():
        raise RuntimeError(f"LibreOffice failed to convert {path} to PDF")
    return pdf_path


def _pdf_to_images(pdf_path: Path, out_dir: Path) -> list[Path]:
    """Render each page of a PDF to a PNG at OCR_DPI resolution."""
    zoom = settings.OCR_DPI / 72  # PDF points are natively 72 DPI
    matrix = fitz.Matrix(zoom, zoom)
    image_paths = []
    with fitz.open(str(pdf_path)) as doc:
        for i, page in enumerate(doc):
            pix = page.get_pixmap(matrix=matrix)
            image_path = out_dir / f"page_{i:04d}.png"
            pix.save(str(image_path))
            image_paths.append(image_path)
    return image_paths


@traceable(
    name="parse_document",
    run_type="tool",
    tags=["ingestion", "parsing"],
    process_inputs=lambda inputs: {"path": str(inputs.get("path"))},
    process_outputs=lambda output: {"markdown_chars": len(output)},
)
def parse_to_markdown(path: Path) -> str:
    """Parse any document (PDF, image, DOCX, PPTX, HTML, ...) to text via
    Baidu's Unlimited-OCR document-parsing model. Non-PDF/image formats are
    first converted to PDF with headless LibreOffice; every PDF page is then
    rendered to an image and passed through OCR.
    """
    # Rooted under STORAGE_DIR rather than the system temp dir: a
    # snap-packaged LibreOffice can't read/write outside $HOME-adjacent
    # paths, and system /tmp is outside its confinement.
    work_root = storage_dir() / "_ocr_tmp"
    work_root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="ocr_ingest_", dir=work_root) as tmp:
        tmp_dir = Path(tmp)

        if path.suffix.lower() in _IMAGE_SUFFIXES:
            image_paths = [path]
        else:
            pdf_path = path if path.suffix.lower() == ".pdf" else _convert_to_pdf(path, tmp_dir)
            image_paths = _pdf_to_images(pdf_path, tmp_dir)

        return run_document_ocr(image_paths, tmp_dir / "ocr_output")
