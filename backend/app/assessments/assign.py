"""Choosing questions for assignments and quizzes (Phase 4). Plain Python,
no database or LLM: given the approved pool, a seed and the rules, it returns
which questions go where, the same way every time for the same inputs.

- An assignment is one set of questions for a whole classroom. The caller
  passes only questions no other assignment with the same subject and term
  has used, so classrooms get disjoint sets.
- A quiz gives each student their own set. Every set has the same mix of
  topics and difficulties (stratified sampling), no two students get an
  identical set, and with `max_overlap` no two share more than that many
  questions.
- Question order and mcq option order are shuffled per set.
"""
from __future__ import annotations

import math
import random
from collections import Counter
from collections.abc import Iterable
from dataclasses import dataclass

# Tries per student before giving up on the overlap rule.
_ATTEMPTS = 400


@dataclass(frozen=True)
class PoolQuestion:
    id: str
    topic: str
    difficulty: int
    option_count: int  # 0 unless mcq


class NotEnoughQuestions(Exception):
    """The pool can't satisfy the rules. `needed` is how many questions (in
    the same mix) would be enough, when that can be worked out.
    """

    def __init__(self, message: str, needed: int | None = None):
        super().__init__(message)
        self.needed = needed


def _stratum(q: PoolQuestion) -> tuple[str, int]:
    return (q.topic.strip().lower(), q.difficulty)


def _strata(pool: list[PoolQuestion]) -> dict[tuple[str, int], list[PoolQuestion]]:
    strata: dict[tuple[str, int], list[PoolQuestion]] = {}
    for q in sorted(pool, key=lambda q: q.id):
        strata.setdefault(_stratum(q), []).append(q)
    return dict(sorted(strata.items()))


def quotas(pool: list[PoolQuestion], count: int) -> dict[tuple[str, int], int]:
    """How many questions each (topic, difficulty) group contributes to a
    set of `count`: proportional to the group's size in the pool, rounded by
    largest remainder, so every set has the same mix.
    """
    if count > len(pool):
        raise NotEnoughQuestions(
            f"only {len(pool)} matching approved question{'s' if len(pool) != 1 else ''}; "
            f"a set needs {count}",
            needed=count,
        )
    strata = _strata(pool)
    exact = {key: count * len(qs) / len(pool) for key, qs in strata.items()}
    result = {key: math.floor(v) for key, v in exact.items()}
    by_remainder = sorted(strata, key=lambda key: (-(exact[key] - result[key]), key))
    missing = count - sum(result.values())
    for key in by_remainder:
        if missing == 0:
            break
        if result[key] < len(strata[key]):
            result[key] += 1
            missing -= 1
    return {key: n for key, n in result.items() if n}


def _shuffled(rng: random.Random, questions: list[PoolQuestion]) -> list[dict]:
    """The set in a shuffled order, each with a shuffled mcq option order."""
    order = list(questions)
    rng.shuffle(order)
    items = []
    for q in order:
        options = list(range(q.option_count)) if q.option_count else None
        if options:
            rng.shuffle(options)
        items.append({"question_id": q.id, "option_order": options})
    return items


def assignment_set(pool: list[PoolQuestion], count: int, seed: int) -> list[dict]:
    """One classroom's assignment: `count` questions from the (already
    filtered to unused) pool, stratified by topic and difficulty.
    Returns [{question_id, option_order}] in order.
    """
    rng = random.Random(seed)
    strata = _strata(pool)
    chosen = []
    for key, n in quotas(pool, count).items():
        chosen.extend(rng.sample(strata[key], n))
    return _shuffled(rng, chosen)


def _distinct_sets(strata: dict, wanted: dict) -> int:
    return math.prod(math.comb(len(strata[key]), n) for key, n in wanted.items())


def _enough_for(students: int, count: int) -> int:
    """The smallest pool from which `students` different sets of `count`
    can be drawn (ignoring the topic mix, so a lower bound).
    """
    n = count
    while math.comb(n, count) < students:
        n += 1
    return n


def quiz_sets(
    pool: list[PoolQuestion],
    count: int,
    students: Iterable[str],
    seed: int,
    *,
    max_overlap: int | None = None,
    existing: Iterable[Iterable[str]] = (),
) -> dict[str, list[dict]]:
    """A set of `count` questions per student. `existing` are sets already
    handed out (when students are added to a quiz later); new sets follow
    the same rules against them. Returns {email: [{question_id, option_order}]}.
    """
    students = sorted(set(students))
    taken = [frozenset(s) for s in existing]
    if not students:
        return {}
    if max_overlap is not None and max_overlap >= count:
        max_overlap = None

    wanted = quotas(pool, count)
    strata = _strata(pool)
    total = len(taken) + len(students)
    if _distinct_sets(strata, wanted) < total:
        raise NotEnoughQuestions(
            f"{len(pool)} questions can't give {total} students different sets of {count} "
            "in the same topic and difficulty mix; add more questions",
            needed=max(_enough_for(total, count), len(pool) + 1),
        )

    # Different seed per batch, so adding students later doesn't replay the
    # first batch's choices.
    rng = random.Random(f"{seed}:{len(taken)}")
    uses = Counter(q for s in taken for q in s)
    result: dict[str, list[dict]] = {}
    for email in students:
        for attempt in range(_ATTEMPTS):
            # Prefer questions used least so far, with more randomness on
            # each retry; spreads use evenly, which keeps overlaps small.
            spread = 1 + attempt / 10
            chosen: list[PoolQuestion] = []
            for key, n in wanted.items():
                ranked = sorted(strata[key], key=lambda q: uses[q.id] + rng.random() * spread)
                chosen.extend(ranked[:n])
            ids = frozenset(q.id for q in chosen)
            if ids in taken:
                continue
            if max_overlap is not None and any(len(ids & other) > max_overlap for other in taken):
                continue
            break
        else:
            needed = None
            if max_overlap is not None:
                # A shared core of max_overlap questions plus count - max_overlap
                # of their own per student always works.
                needed = max_overlap + total * (count - max_overlap)
            raise NotEnoughQuestions(
                f"couldn't give every student a different set"
                + (f" sharing at most {max_overlap} questions with any other" if max_overlap is not None else "")
                + "; add more questions"
                + (" or allow more overlap" if max_overlap is not None else ""),
                needed=needed,
            )
        taken.append(ids)
        uses.update(ids)
        result[email] = _shuffled(rng, chosen)
    return result
