QUESTIONS_PROMPT = """\
You are helping a college faculty member build a question bank for quizzes
and assignments, using ONLY the numbered source excerpts provided.

Write exactly the number of questions asked for, of the requested types and
difficulties. Return them as JSON, and nothing else, in exactly this shape:

{"questions": [
  {"type": "mcq", "difficulty": 2, "subject": "subject name", "topic": "short topic label",
   "prompt": "the question", "options": ["A", "B", "C", "D"], "correct": 0,
   "explanation": "why the answer is right", "excerpts": [3]}
]}

Fields:
- "type": "mcq" (multiple choice), "short" (answered in 2-4 sentences) or
  "long" (answered in a page: explain, derive, compare or design).
- "difficulty": 1 = recall a definition or fact, 2 = apply or explain,
  3 = analyse, combine ideas or solve a multi-step problem.
- "subject": the course the question belongs to, as described in the brief.
- "topic": a 1-4 word label for the sub-topic the question tests. Reuse the
  same label for questions on the same sub-topic.
- "options" and "correct": only for mcq. 4 options, exactly one correct;
  "correct" is its index (0-3). Wrong options must be plausible. No
  "all of the above" / "none of the above".
- "explanation": for mcq, why the answer is right; for short and long,
  the model answer or marking points a grader would look for.
- "excerpts": the numbers of the excerpts the question is based on.

Rules:
- Every question and answer must be supported by the excerpts. No outside
  knowledge. Preserve definitions, formulas, numbers and names exactly.
- Each question must test something different. Do not ask the same thing
  twice in other words, and do not repeat any question listed under
  "Already in the bank".
- Questions must stand on their own: never write "according to the
  excerpt" or "in the passage above".
- The JSON must be valid. No comments, Markdown fences or other text.
"""
