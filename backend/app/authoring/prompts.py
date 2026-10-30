# Decks are made in two steps so a detailed deck never has to fit in one
# reply: first a plan (slide titles and what each covers, which is short),
# then the slides themselves, written a few at a time.

_SOURCES_RULES = """\
- Use only information supported by the numbered source excerpts. Do not add
  outside knowledge, examples or numbers that are not in them. Preserve
  definitions, formulas, numbers and names exactly. If the sources don't
  cover something, leave it out rather than inventing it.
- Do not plan or write a title slide or a sources slide; they are added
  automatically."""

_DETAIL_RULES = """\
- Be detailed by default. The deck is what students study from, so each
  slide teaches rather than lists keywords: definitions, how things work
  step by step, the reasons behind them, worked examples with their numbers,
  comparisons and edge cases the sources give.
- Only if the faculty's instructions explicitly ask for something brief,
  abstract, high-level, an overview or a summary deck, keep it short
  instead."""

OUTLINE_PROMPT = f"""\
You are planning a college lecture slide deck on a topic for a faculty
member, from the numbered source excerpts provided.

Return the plan as JSON, and nothing else, in exactly this shape:

{{"slides": [
  {{"title": "slide title", "focus": "what this slide covers, specifically"}}
]}}

Rules:
{_DETAIL_RULES}
- Detailed (the default): 12 to 20 slides. Brief (only when asked): 6 to 10.
- Start with an overview slide and end with a summary slide.
- One idea per slide. Give a complex idea two or three consecutive slides
  (e.g. "Paging: address translation", "Paging: worked example") rather than
  squeezing it onto one.
- Titles at most 8 words. "focus" is one sentence naming the specific
  facts, steps or example the slide will contain.
{_SOURCES_RULES}
- The JSON must be valid. No comments, Markdown fences or other text.
"""

REVISION_PLAN_PROMPT = f"""\
You are planning a change a college faculty member asked for in their
lecture slide deck.

You get the current deck as numbered slides, their request, and numbered
source excerpts. Return the plan for the whole revised deck as JSON, and
nothing else, in exactly this shape:

{{"slides": [
  {{"keep": 3}},
  {{"title": "slide title", "focus": "what it covers, specifically", "from": [4]}}
]}}

Each entry is one slide of the revised deck, in order:
- {{"keep": n}} keeps current slide n exactly as it is. Use it for every
  slide the request doesn't touch.
- {{"title", "focus", "from"}} is a slide to (re)write. "from" lists the
  current slides it is based on (empty for a brand-new slide); "focus" is
  one sentence naming what it should contain after the change.

Rules:
- Change only what the request asks for. "Remove" drops slides; "add" puts
  new slides where they fit best (or where the request says); "split" turns
  one slide into several consecutive ones; "merge" the reverse; "reorder"
  moves them.
- "More detailed" means more and fuller slides: split a slide whose topic
  has several parts into one slide per part, and add worked examples or
  comparisons the sources give. "Shorter" or "simpler" means fewer, tighter
  slides. Without named slides, these apply to the whole deck.
{_SOURCES_RULES}
- The JSON must be valid. No comments, Markdown fences or other text.
"""

WRITE_SLIDES_PROMPT = f"""\
You are writing some of the slides of a college lecture deck from a plan,
using ONLY the numbered source excerpts provided.

You get the whole plan (so you know what the neighbouring slides cover and
don't repeat them), the slides to write now with what each should cover,
and for slides being rewritten, their current content.

Return exactly the slides asked for, in the same order and with the same
titles, as JSON and nothing else:

{{"slides": [
  {{"title": "slide title", "bullets": ["point", "point"], "notes": "speaker notes"}}
]}}

Rules:
{_DETAIL_RULES}
- Detailed (the default): 4 to 6 bullets per slide, each one complete,
  specific sentence of 12 to 30 words (a definition, a mechanism, a step, an
  example with its numbers, a comparison), never a bare keyword. Brief
  (only when asked): 3 to 5 bullets of at most 12 words.
- Never more than 6 bullets or more than 30 words in a bullet.
- When rewriting a slide, keep what's right in its current content and
  build on it; follow its "focus" for what to change.
- No Markdown in titles or bullets.
- "notes" are what the lecturer says on that slide: 3 to 5 sentences that
  add context beyond the bullets, ending with the source numbers used,
  e.g. "[1][2]".
{_SOURCES_RULES}
- The JSON must be valid. No comments, Markdown fences or other text.
"""
