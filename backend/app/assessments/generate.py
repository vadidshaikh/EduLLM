"""Drafting bank questions from source documents (Phase 4).

Like notes, retrieval goes through `queries.search_source_chunks`, so
questions can only be drawn from documents their author can read. Each
draft remembers the chunks it came from. Near-duplicates of questions
already in the workspace's bank (or of each other) are dropped: the
uniqueness rules for quizzes and assignments mean nothing if two "different"
questions are paraphrases.
"""
import logging
from uuid import UUID

import numpy as np
from langsmith import traceable

from app.assessments.prompts import QUESTIONS_PROMPT
from app.authoring.generate import GenerationError, ask, parse_json
from app.db import queries
from app.ingestion.embedder import embed_texts

logger = logging.getLogger(__name__)

# Cosine similarity above which two questions count as the same question.
DUPLICATE_SIMILARITY = 0.9

_CONTEXT_CHUNKS = 12
_MIN_CHUNKS_PER_SOURCE = 2
_MAX_OPTIONS = 6
_EXISTING_SHOWN = 40  # bank questions listed in the prompt so the model avoids them

TYPE_LABELS = {"mcq": "multiple choice", "short": "short answer", "long": "long answer"}


def question_text(body: dict) -> str:
    """What a question's embedding is computed from: the prompt and, for
    mcq, its options (so two mcqs with the same stem but different options
    still compare as close).
    """
    return "\n".join([body["prompt"], *body.get("options", [])])


def clean_question(raw: object, *, types: list[str]) -> dict | None:
    """A well-formed {type, difficulty, body, answer} from model output or
    an edit, or None. mcq needs 2-6 distinct options and a valid answer.
    """
    if not isinstance(raw, dict):
        return None
    qtype = raw.get("type")
    prompt = str(raw.get("prompt") or "").strip()
    if qtype not in types or not prompt:
        return None
    try:
        difficulty = min(3, max(1, int(raw.get("difficulty") or 2)))
    except (TypeError, ValueError):
        difficulty = 2
    body: dict = {"prompt": prompt}
    answer: dict = {"correct": None, "explanation": str(raw.get("explanation") or "").strip()}
    if qtype == "mcq":
        options = raw.get("options") if isinstance(raw.get("options"), list) else []
        options = [str(o).strip() for o in options if str(o).strip()][:_MAX_OPTIONS]
        correct = raw.get("correct")
        if len(options) < 2 or len(set(options)) != len(options):
            return None
        if not isinstance(correct, int) or isinstance(correct, bool) or not 0 <= correct < len(options):
            return None
        body["options"] = options
        answer["correct"] = correct
    return {"type": qtype, "difficulty": difficulty, "body": body, "answer": answer}


def _excerpts(claims: dict, query: str, sources: list[dict]) -> list[dict]:
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
    return chunks


def _mix(count: int, types: list[str], difficulties: list[int]) -> str:
    kinds = ", ".join(TYPE_LABELS[t] for t in types)
    levels = ", ".join(str(d) for d in difficulties)
    return (
        f"Write {count} questions. Types: {kinds}; spread them roughly evenly over these types. "
        f"Difficulties: {levels}; spread them roughly evenly over these levels."
    )


@traceable(name="draft_questions", run_type="chain", tags=["assessments"])
def draft_questions(
    claims: dict,
    *,
    workspace_id: UUID,
    subject: str,
    topic: str,
    sources: list[dict],
    count: int,
    types: list[str],
    difficulties: list[int],
    instructions: str | None,
) -> tuple[list[dict], int]:
    """New questions on `topic`, each {type, difficulty, body, answer,
    source_chunk_ids, source_doc_ids, embedding}, minus near-duplicates.
    Returns them and how many duplicates were dropped.
    """
    chunks = _excerpts(claims, f"{subject}: {topic}", sources)
    titles = {s["doc_id"]: s["title"] for s in sources}
    context = "\n\n=====\n\n".join(
        f"[{n}] from {titles.get(str(c['document_id']), 'a source')}\n\n{c['chunk_text']}"
        for n, c in enumerate(chunks, start=1)
    )
    existing = queries.list_question_prompts(workspace_id, subject, limit=_EXISTING_SHOWN)
    brief = [f"Subject: {subject}", f"Topic: {topic}", _mix(count, types, difficulties)]
    if instructions:
        brief.append(f"Faculty's instructions: {instructions}")
    if existing:
        brief.append("Already in the bank (do not repeat):\n" + "\n".join(f"- {p}" for p in existing))

    raw = ask(QUESTIONS_PROMPT, "\n".join(brief) + f"\n\nExcerpts:\n\n{context}", 0.4)
    parsed = parse_json(raw)
    items = parsed.get("questions") if isinstance(parsed, dict) else parsed
    drafts = []
    for item in items if isinstance(items, list) else []:
        question = clean_question(item, types=types)
        if question is None:
            continue
        cited = [n for n in item.get("excerpts") or [] if isinstance(n, int) and 1 <= n <= len(chunks)]
        used = [chunks[n - 1] for n in dict.fromkeys(cited)]
        question["source_chunk_ids"] = [c["id"] for c in used]
        question["source_doc_ids"] = list(dict.fromkeys(c["document_id"] for c in used))
        drafts.append(question)
    if not drafts:
        logger.warning("draft_questions: unusable reply from the model: %.300s", raw)
        raise GenerationError("the model didn't return usable questions; try again")

    drafts = drafts[:count]
    for question, embedding in zip(drafts, embed_texts([question_text(q["body"]) for q in drafts])):
        question["embedding"] = embedding
    kept = drop_duplicates(workspace_id, drafts)
    return kept, len(drafts) - len(kept)


def _unit(vector: list[float]) -> np.ndarray:
    v = np.asarray(vector, dtype=np.float32)
    return v / (np.linalg.norm(v) or 1.0)


def drop_duplicates(workspace_id: UUID, questions: list[dict]) -> list[dict]:
    """The questions that aren't near-duplicates of one already in the
    workspace's bank or of an earlier one in the list.
    """
    kept: list[dict] = []
    kept_vectors: list[np.ndarray] = []
    for question in questions:
        vector = _unit(question["embedding"])
        if any(float(vector @ other) > DUPLICATE_SIMILARITY for other in kept_vectors):
            continue
        similar = queries.most_similar_question(workspace_id, question["embedding"])
        if similar is not None and similar["similarity"] > DUPLICATE_SIMILARITY:
            continue
        kept.append(question)
        kept_vectors.append(vector)
    return kept
