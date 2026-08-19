from pathlib import Path

from docling.datamodel.base_models import InputFormat
from docling.datamodel.pipeline_options import PdfPipelineOptions, TableFormerMode
from docling.document_converter import DocumentConverter, PdfFormatOption
from langsmith import traceable

_pdf_pipeline_options = PdfPipelineOptions(do_table_structure=True)
_pdf_pipeline_options.table_structure_options.mode = TableFormerMode.ACCURATE
_pdf_pipeline_options.table_structure_options.do_cell_matching = True

_converter = DocumentConverter(
    format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=_pdf_pipeline_options)}
)


@traceable(
    name="parse_document",
    run_type="tool",
    tags=["ingestion", "parsing"],
    process_inputs=lambda inputs: {"path": str(inputs.get("path"))},
    process_outputs=lambda output: {"markdown_chars": len(output)},
)
def parse_to_markdown(path: Path) -> str:
    """Parse a document (PDF, DOCX, PPTX, HTML, ...) to markdown text via
    Docling. PDFs use accurate TableFormer table parsing; other formats use
    Docling's format-specific defaults.
    """
    result = _converter.convert(str(path))
    return result.document.export_to_markdown()
