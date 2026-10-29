"""Turning a note into the file it's downloaded and published as: Markdown
for notes, PowerPoint for slide decks.

Decks use the institute template when `PPT_TEMPLATE_PATH` points at a
.pptx (its first layout for the title slide, its second, "Title and
Content", for the rest); otherwise a built-in 16:9 design in the logo's
colours.
"""
from io import BytesIO

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.util import Inches, Pt

from app.config import settings

_BLUE = RGBColor(0x16, 0x84, 0xAC)
_DEEP = RGBColor(0x0D, 0x5F, 0x7E)
_INK = RGBColor(0x21, 0x1F, 0x1C)
_MUTED = RGBColor(0x5D, 0x6B, 0x70)

_WIDTH, _HEIGHT = Inches(13.333), Inches(7.5)
_BLANK_LAYOUT = 6  # in python-pptx's default template


def sources_list(sources: list[dict]) -> list[str]:
    """"[n] Title" for each source, in citation order."""
    return [f"[{n}] {s['title']}" for n, s in enumerate(sources, start=1)]


def notes_markdown(note: dict) -> str:
    """The note as one Markdown file: title, body, then its sources, so the
    [n] citations in the body still mean something once published.
    """
    parts = [f"# {note['title']}", note["body_md"].strip()]
    if note["sources"]:
        parts.append("## Sources\n\n" + "\n".join(f"- {line}" for line in sources_list(note["sources"])))
    return "\n\n".join(p for p in parts if p) + "\n"


def _text(frame, lines: list[str], size: int, color: RGBColor, bold: bool = False) -> None:
    frame.word_wrap = True
    for i, line in enumerate(lines):
        paragraph = frame.paragraphs[0] if i == 0 else frame.add_paragraph()
        paragraph.text = line
        paragraph.space_after = Pt(size * 0.6)
        for run in paragraph.runs:
            run.font.size = Pt(size)
            run.font.bold = bold
            run.font.color.rgb = color


def _bullet_size(bullets: list[str]) -> int:
    longest = max((len(b) for b in bullets), default=0)
    return 24 if len(bullets) <= 4 and longest <= 80 else 20


def _builtin_slide(prs, title: str, lines: list[str], *, footer: str, number: int, cover: bool = False):
    slide = prs.slides.add_slide(prs.slide_layouts[_BLANK_LAYOUT])
    bar = slide.shapes.add_shape(1, 0, 0, Inches(0.28), _HEIGHT)  # 1 = rectangle
    bar.fill.solid()
    bar.fill.fore_color.rgb = _BLUE if not cover else _DEEP
    bar.line.fill.background()

    if cover:
        _text(slide.shapes.add_textbox(Inches(1), Inches(2.3), Inches(11.3), Inches(1.6)).text_frame,
              [title], 44, _INK, bold=True)
        _text(slide.shapes.add_textbox(Inches(1), Inches(4.0), Inches(11.3), Inches(2)).text_frame,
              lines, 20, _MUTED)
        return slide

    _text(slide.shapes.add_textbox(Inches(0.8), Inches(0.5), Inches(11.8), Inches(1.1)).text_frame,
          [title], 32, _DEEP, bold=True)
    body = slide.shapes.add_textbox(Inches(0.8), Inches(1.75), Inches(11.8), Inches(5.0)).text_frame
    _text(body, [f"•  {line}" for line in lines], _bullet_size(lines), _INK)
    _text(slide.shapes.add_textbox(Inches(0.8), Inches(6.85), Inches(10), Inches(0.4)).text_frame,
          [footer], 11, _MUTED)
    _text(slide.shapes.add_textbox(Inches(11.8), Inches(6.85), Inches(1), Inches(0.4)).text_frame,
          [str(number)], 11, _MUTED)
    return slide


def _template_slide(prs, title: str, lines: list[str], *, cover: bool = False):
    layout = prs.slide_layouts[0 if cover else min(1, len(prs.slide_layouts) - 1)]
    slide = prs.slides.add_slide(layout)
    placeholders = list(slide.placeholders)
    if slide.shapes.title is not None:
        slide.shapes.title.text = title
    body = next((p for p in placeholders if p.placeholder_format.idx != 0), None)
    if body is not None:
        frame = body.text_frame
        for i, line in enumerate(lines):
            (frame.paragraphs[0] if i == 0 else frame.add_paragraph()).text = line
    return slide


def deck_pptx(note: dict) -> bytes:
    """The deck as a .pptx: a title slide, one slide per outline entry (with
    its speaker notes), and a closing slide listing the sources.
    """
    template = settings.PPT_TEMPLATE_PATH.strip()
    if template:
        prs = Presentation(template)
    else:
        prs = Presentation()
        prs.slide_width, prs.slide_height = _WIDTH, _HEIGHT

    def add(title: str, lines: list[str], number: int, cover: bool = False):
        if template:
            return _template_slide(prs, title, lines, cover=cover)
        return _builtin_slide(prs, title, lines, footer=note["title"], number=number, cover=cover)

    cover_lines = [line for line in (note.get("subject"), note["topic"]) if line]
    add(note["title"], cover_lines, 1, cover=True)
    for number, s in enumerate(note["slides"], start=2):
        slide = add(s["title"], s["bullets"], number)
        if s.get("notes"):
            slide.notes_slide.notes_text_frame.text = s["notes"]
    if note["sources"]:
        add("Sources", sources_list(note["sources"]), len(note["slides"]) + 2)

    out = BytesIO()
    prs.save(out)
    return out.getvalue()
