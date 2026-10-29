"""Drafting notes and slide decks from source documents (Phase 3).

Retrieval goes through `queries.search_source_chunks`, which applies the
user's scope ids, so a draft can only draw on documents its author can read.
Nothing here saves anything: callers decide what becomes the note.
"""
import json
import logging
import re
from uuid import UUID

from langsmith import traceable

from app.authoring.prompts import NOTES_PROMPT, SECTION_PROMPT, SLIDES_PROMPT
from app.db import queries
from app.ingestion.embedder import embed_texts
from app.rag.llm import MODEL_UNAVAILABLE_REPLY, stream_llm

logger = logging.getLogger(__name__)

# About 12 chunks (~48k characters) of context in total, but at least two
# from every source so none is ignored.
_CONTEXT_CHUNKS = 12
_MIN_CHUNKS_PER_SOURCE = 2
# Generous: reasoning models spend part of it before writing anything.
_MAX_OUTPUT_TOKENS = 8192

_MAX_SLIDES = 25
_MAX_BULLETS = 8

_FENCE = re.compile(r"^```[a-zA-Z]*\n(.*)\n```$", re.DOTALL)
_JSON_OBJECT = re.compile(r"\{.*\}", re.DOTALL)


class GenerationError(Exception):
    """The model couldn't produce a usable draft (unavailable, or bad output)."""


def _context(claims: dict, query: str, sources: list[dict]) -> str:
    """The source excerpts most relevant to `query`, grouped under each
    source's citation number ([1] is sources[0]). Sources that were deleted
    or that the user can no longer read contribute nothing, but keep their
    number so existing citations stay right.
    """
    doc_ids = [UUID(s["doc_id"]) for s in sources]
    per_document = max(_MIN_CHUNKS_PER_SOURCE, _CONTEXT_CHUNKS // max(len(doc_ids), 1))
    chunks = queries.search_source_chunks(
        email=claims["sub"],
        role=claims["role"],
        embedding=embed_texts([query])[0],
        document_ids=doc_ids,
        per_document=per_document,
    )
    if not chunks:
        raise GenerationError("none of the sources could be read; they may have been removed")

    by_doc: dict[str, list[str]] = {}
    for chunk in chunks:
        by_doc.setdefault(str(chunk["document_id"]), []).append(chunk["chunk_text"])
    blocks = []
    for number, source in enumerate(sources, start=1):
        texts = by_doc.get(source["doc_id"])
        if texts:
            blocks.append(f"[{number}] {source['title']}\n\n" + "\n\n---\n\n".join(texts))
    return "\n\n=====\n\n".join(blocks)


def parse_json(raw: str) -> object:
    """The model's JSON reply, or the first {...} in it if it added text
    around it; None if neither parses.
    """
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        match = _JSON_OBJECT.search(raw)
        try:
            return json.loads(match.group(0)) if match else None
        except json.JSONDecodeError:
            return None


def _brief(title: str, topic: str, subject: str | None, instructions: str | None) -> str:
    lines = [f"Title: {title}", f"Topic: {topic}"]
    if subject:
        lines.append(f"Subject: {subject}")
    if instructions:
        lines.append(f"Faculty's instructions: {instructions}")
    return "\n".join(lines)


def ask(system: str, user: str, temperature: float = 0.3) -> str:
    # Streamed and collected: a draft can take longer than the read timeout
    # of a blocking call.
    reply = "".join(
        stream_llm(
            [{"role": "system", "content": system}, {"role": "user", "content": user}],
            temperature=temperature,
            max_tokens=_MAX_OUTPUT_TOKENS,
        )
    ).strip()
    if not reply or reply == MODEL_UNAVAILABLE_REPLY:
        raise GenerationError("the model is unavailable right now; try again in a minute")
    match = _FENCE.match(reply)
    return match.group(1).strip() if match else reply


@traceable(name="draft_notes", run_type="chain", tags=["authoring"])
def draft_notes(
    claims: dict, *, title: str, topic: str, subject: str | None, instructions: str | None, sources: list[dict]
) -> str:
    """Markdown lecture notes on `topic`, citing sources as [n]."""
    context = _context(claims, topic, sources)
    body = ask(NOTES_PROMPT, f"{_brief(title, topic, subject, instructions)}\n\nSources:\n\n{context}")
    # The title is shown (and published) separately.
    return re.sub(r"^# .*\n+", "", body, count=1)


@traceable(name="redraft_section", run_type="chain", tags=["authoring"])
def redraft_section(claims: dict, *, title: str, topic: str, section: str, sources: list[dict]) -> str:
    """One `## ` section of a note, rewritten from the sources' current versions."""
    heading = section.strip().splitlines()[0].lstrip("# ").strip()
    context = _context(claims, f"{topic}: {heading}", sources)
    return ask(
        SECTION_PROMPT,
        f"{_brief(title, topic, None, None)}\n\nSection to update:\n\n{section.strip()}\n\nSources:\n\n{context}",
    )


def clean_slides(raw: object) -> list[dict]:
    """Slides as [{title, bullets, notes}], keeping only well-formed ones and
    trimming them to sensible sizes. Used for both model output and edits.
    """
    if isinstance(raw, dict):
        raw = raw.get("slides")
    if not isinstance(raw, list):
        return []
    slides = []
    for item in raw[:_MAX_SLIDES]:
        if not isinstance(item, dict):
            continue
        bullets = item.get("bullets") if isinstance(item.get("bullets"), list) else []
        slide = {
            "title": str(item.get("title") or "").strip(),
            "bullets": [str(b).strip() for b in bullets if str(b).strip()][:_MAX_BULLETS],
            "notes": str(item.get("notes") or "").strip(),
        }
        if slide["title"] or slide["bullets"]:
            slides.append(slide)
    return slides


@traceable(name="draft_slides", run_type="chain", tags=["authoring"])
def draft_slides(
    claims: dict, *, title: str, topic: str, subject: str | None, instructions: str | None, sources: list[dict]
) -> list[dict]:
    """A slide outline on `topic`: [{title, bullets, notes}]."""
    context = _context(claims, topic, sources)
    raw = ask(SLIDES_PROMPT, f"{_brief(title, topic, subject, instructions)}\n\nSources:\n\n{context}", 0.2)
    slides = clean_slides(parse_json(raw))
    if not slides:
        logger.warning("draft_slides: unusable outline from the model: %.300s", raw)
        raise GenerationError("the model didn't return a usable outline; try again")
    return slides
