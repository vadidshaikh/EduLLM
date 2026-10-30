"""Drafting slide decks from source documents (Phase 3).

A deck is made in two steps so a detailed one never has to fit in a single
model reply (long replies get cut off and their JSON is lost): a plan of
slide titles and what each covers, then the slides themselves, written in
small batches in parallel, each with source excerpts picked for its own
slides. A revision ("make it more detailed", "remove slide 4") plans the
whole revised deck the same way, keeping untouched slides as they are and
writing only the new or changed ones.

Retrieval goes through `queries.search_source_chunks`, which applies the
user's scope ids, so a draft can only draw on documents its author can read.
Nothing here saves anything: callers decide what becomes the note.
"""
import json
import logging
import re
from concurrent.futures import ThreadPoolExecutor
from uuid import UUID

from langsmith import traceable

from app.authoring.prompts import OUTLINE_PROMPT, REVISION_PLAN_PROMPT, WRITE_SLIDES_PROMPT
from app.db import queries
from app.ingestion.embedder import embed_texts
from app.llm_json import parse_json
from app.rag.llm import MODEL_UNAVAILABLE_REPLY, stream_llm

logger = logging.getLogger(__name__)

# About 12 chunks (~48k characters) of context in total, but at least two
# from every source so none is ignored.
_CONTEXT_CHUNKS = 12
_MIN_CHUNKS_PER_SOURCE = 2
# Generous: reasoning models spend part of it before writing anything, and a
# detailed deck (up to 20 slides of full-sentence bullets plus notes) is long.
_MAX_OUTPUT_TOKENS = 16384

_MAX_SLIDES = 30
_MAX_BULLETS = 8
# Slides written per model call, and calls at once.
_BATCH = 4
_PARALLEL = 4

_FENCE = re.compile(r"^```[a-zA-Z]*\n(.*)\n```$", re.DOTALL)


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


def _plan(raw: object, current: int = 0) -> list[dict]:
    """A deck plan from the model: each entry {"keep": index} (a current
    slide kept as is, for revisions) or {"title", "focus", "from": [index]}
    (a slide to write). Indexes are 0-based; bad entries are dropped.
    """
    if isinstance(raw, dict):
        raw = raw.get("slides")
    if not isinstance(raw, list):
        return []
    plan = []
    for item in raw[:_MAX_SLIDES]:
        if not isinstance(item, dict):
            continue
        keep = item.get("keep")
        if isinstance(keep, int) and 1 <= keep <= current:
            plan.append({"keep": keep - 1})
            continue
        title = str(item.get("title") or "").strip()
        if not title:
            continue
        based_on = item.get("from") if isinstance(item.get("from"), list) else []
        plan.append({
            "title": title,
            "focus": str(item.get("focus") or "").strip(),
            "from": [n - 1 for n in based_on if isinstance(n, int) and 1 <= n <= current],
        })
    return plan


def _write_batch(claims: dict, *, brief: str, topic: str, outline: str, batch: list[dict], current: list[dict],
                 sources: list[dict]) -> list[dict]:
    """The slides for one batch of plan entries, in order (retried once)."""
    context = _context(claims, f"{topic}: " + "; ".join(f"{e['title']} {e['focus']}" for e in batch), sources)
    asked = []
    for n, entry in enumerate(batch, start=1):
        lines = [f"{n}. {entry['title']}", f"   Covers: {entry['focus'] or entry['title']}"]
        if entry["from"]:
            existing = [current[i] for i in entry["from"]]
            lines.append(f"   Current content: {json.dumps(existing, ensure_ascii=False)}")
        asked.append("\n".join(lines))
    user = (f"{brief}\n\nThe whole plan:\n{outline}\n\nWrite these {len(batch)} slides now:\n"
            + "\n".join(asked) + f"\n\nSources:\n\n{context}")
    for attempt in range(2):
        raw = ask(WRITE_SLIDES_PROMPT, user, 0.2)
        slides = clean_slides(parse_json(raw))
        if len(slides) >= len(batch):
            # Keep the plan's titles so the slides line up with the outline.
            return [{**slide, "title": entry["title"]} for slide, entry in zip(slides, batch)]
        logger.warning("write slides: got %d of %d (attempt %d): %.300s", len(slides), len(batch), attempt + 1, raw)
    raise GenerationError("the model didn't write all the slides; try again")


def _build(claims: dict, *, plan: list[dict], current: list[dict], brief: str, topic: str,
           sources: list[dict]) -> list[dict]:
    """The deck a plan describes: kept slides copied, the rest written in
    batches of `_BATCH`, `_PARALLEL` at a time.
    """
    outline = "\n".join(
        f"{n}. {current[e['keep']]['title'] if 'keep' in e else e['title']}" for n, e in enumerate(plan, start=1)
    )
    todo = [e for e in plan if "keep" not in e]
    batches = [todo[i:i + _BATCH] for i in range(0, len(todo), _BATCH)]
    with ThreadPoolExecutor(max_workers=_PARALLEL) as pool:
        written = list(pool.map(
            lambda batch: _write_batch(claims, brief=brief, topic=topic, outline=outline, batch=batch,
                                       current=current, sources=sources),
            batches,
        ))
    new_slides = iter(slide for batch in written for slide in batch)
    return [dict(current[e["keep"]]) if "keep" in e else next(new_slides) for e in plan]


@traceable(name="draft_slides", run_type="chain", tags=["authoring"])
def draft_slides(
    claims: dict, *, title: str, topic: str, subject: str | None, instructions: str | None, sources: list[dict]
) -> list[dict]:
    """A deck on `topic`, [{title, bullets, notes}]: planned, then written in batches."""
    brief = _brief(title, topic, subject, instructions)
    context = _context(claims, topic, sources)
    raw = ask(OUTLINE_PROMPT, f"{brief}\n\nSources:\n\n{context}", 0.2)
    plan = _plan(parse_json(raw))
    if not plan:
        logger.warning("draft_slides: unusable plan from the model: %.300s", raw)
        raise GenerationError("the model didn't return a usable outline; try again")
    return _build(claims, plan=plan, current=[], brief=brief, topic=topic, sources=sources)


@traceable(name="revise_slides", run_type="chain", tags=["authoring"])
def revise_slides(
    claims: dict, *, title: str, topic: str, subject: str | None, slides: list[dict], request: str,
    sources: list[dict],
) -> list[dict]:
    """The deck with the faculty member's requested change applied ("add a
    slide on X", "make it more detailed"). The model plans the revised deck,
    keeping untouched slides as they are; only new or changed slides are
    written, in batches.
    """
    brief = _brief(title, topic, subject, None)
    context = _context(claims, f"{topic}: {request}", sources)
    numbered = "\n\n".join(
        f"Slide {n}: {s['title']}\n" + "\n".join(f"- {b}" for b in s["bullets"]) for n, s in enumerate(slides, start=1)
    )
    raw = ask(
        REVISION_PLAN_PROMPT,
        f"{brief}\n\nCurrent deck:\n\n{numbered}\n\nRequested change: {request}\n\nSources:\n\n{context}",
        0.2,
    )
    plan = _plan(parse_json(raw), current=len(slides))
    if not plan:
        logger.warning("revise_slides: unusable plan from the model: %.300s", raw)
        raise GenerationError("the model couldn't plan that change; try rephrasing it")
    brief = f"{brief}\nThe change being made: {request}"
    return _build(claims, plan=plan, current=slides, brief=brief, topic=topic, sources=sources)
