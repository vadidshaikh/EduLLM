import logging
from functools import lru_cache
from pathlib import Path

import torch
from transformers import AutoModel, AutoTokenizer

from app.config import settings

logger = logging.getLogger(__name__)

_DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
# bf16 is only well-supported on CUDA for this model; CPU falls back to fp32.
_DTYPE = torch.bfloat16 if _DEVICE == "cuda" else torch.float32

_SINGLE_PAGE_PROMPT = "<image>document parsing."
_MULTI_PAGE_PROMPT = "<image>Multi page parsing."


@lru_cache(maxsize=1)
def _tokenizer():
    return AutoTokenizer.from_pretrained(settings.OCR_MODEL, trust_remote_code=True)


@lru_cache(maxsize=1)
def _model():
    logger.info("Loading OCR model %s on %s", settings.OCR_MODEL, _DEVICE)
    model = AutoModel.from_pretrained(
        settings.OCR_MODEL,
        trust_remote_code=True,
        use_safetensors=True,
        torch_dtype=_DTYPE,
    )
    return model.eval().to(_DEVICE)


def _read_saved_output(output_dir: Path, before: set[str]) -> str:
    """Fallback for when infer()/infer_multi() don't hand back text directly:
    read whatever new .md/.txt files they wrote into output_dir, in name order.
    """
    new_files = sorted(p for p in output_dir.iterdir() if p.name not in before)
    texts = [p.read_text(encoding="utf-8", errors="ignore") for p in new_files if p.suffix in {".md", ".txt"}]
    return "\n\n".join(texts)


def run_document_ocr(image_paths: list[Path], output_dir: Path) -> str:
    """Runs Baidu's Unlimited-OCR document-parsing model over one or more
    page images already rendered to disk, returning the parsed text.
    """
    if not image_paths:
        return ""

    tokenizer = _tokenizer()
    model = _model()
    output_dir.mkdir(parents=True, exist_ok=True)
    before = {p.name for p in output_dir.iterdir()}

    if len(image_paths) == 1:
        result = model.infer(
            tokenizer,
            prompt=_SINGLE_PAGE_PROMPT,
            image_file=str(image_paths[0]),
            output_path=str(output_dir),
            base_size=1024,
            image_size=640,
            crop_mode=True,
            max_length=32768,
            no_repeat_ngram_size=35,
            ngram_window=128,
            save_results=True,
        )
    else:
        result = model.infer_multi(
            tokenizer,
            prompt=_MULTI_PAGE_PROMPT,
            image_files=[str(p) for p in image_paths],
            output_path=str(output_dir),
            image_size=1024,
            max_length=32768,
            no_repeat_ngram_size=35,
            ngram_window=1024,
            save_results=True,
        )

    if isinstance(result, str) and result.strip():
        return result

    return _read_saved_output(output_dir, before)
