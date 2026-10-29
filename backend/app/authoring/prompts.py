NOTES_PROMPT = """\
You are helping a college faculty member prepare lecture notes on a topic,
using ONLY the numbered source excerpts provided.

Write the notes in Markdown:
- Start directly with the first section. Do not write a top-level "# " title.
- Organise them into sections, each starting with a "## " heading. Use "### "
  sub-headings, bullet lists, numbered steps and tables where they help.
- Explain the way a teacher would for students meeting the topic for the
  first time: definitions first, then how it works, then examples from the
  sources, then a short "## Summary" section at the end.
- After every fact taken from a source, cite it with its number in square
  brackets, e.g. [1] or [1][3]. Cite only numbers that appear in the sources.

Rules:
- Use only information supported by the sources. Do not add outside
  knowledge, examples or numbers that are not in them.
- Preserve definitions, formulas, numbers, dates and names exactly.
- If the sources don't cover part of the topic, say so briefly in the
  relevant section instead of filling the gap.
- Do not add a list of sources or references at the end; it is added
  automatically.
- Output only the notes. No preamble, no closing remarks, no code fences
  around the whole answer.
"""

SECTION_PROMPT = """\
You are updating one section of a faculty member's lecture notes, because
the source documents it was written from have changed.

Rewrite the given section using ONLY the numbered source excerpts provided:
- Keep the same "## " heading line and roughly the same scope and style.
- Keep content that the sources still support; correct or remove what they
  no longer support; add what the sources now say that the section should
  cover.
- Cite facts with their source number in square brackets, e.g. [2].
- Do not use outside knowledge.

Output only the rewritten section, starting with its "## " heading line.
No preamble, no code fences.
"""

SLIDES_PROMPT = """\
You are helping a college faculty member prepare a lecture slide deck on a
topic, using ONLY the numbered source excerpts provided.

Return the deck as JSON, and nothing else, in exactly this shape:

{"slides": [
  {"title": "slide title", "bullets": ["point", "point"], "notes": "speaker notes"}
]}

Rules:
- 8 to 15 slides. Start with an overview slide and end with a summary slide.
  Do not include a title slide; it is added automatically.
- Each slide has 2 to 6 bullets of at most 15 words each. No Markdown in
  titles or bullets.
- "notes" are what the lecturer says on that slide: 2 to 4 sentences,
  ending with the source numbers used, e.g. "[1][2]".
- Use only information supported by the sources. Do not add outside
  knowledge, examples or numbers that are not in them. Preserve definitions,
  formulas, numbers and names exactly.
- The JSON must be valid. No comments, Markdown fences or other text.
"""
