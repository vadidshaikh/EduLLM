"""Reading JSON out of model replies.

Models asked for "JSON and nothing else" still add text around it now and
then, or close brackets in the wrong order. Shared by every caller that
parses a model's JSON (slide decks, questions, charts).
"""
import json
import re

_JSON_OBJECT = re.compile(r"\{.*\}", re.DOTALL)
_CLOSER = {"{": "}", "[": "]"}


def _fix_closers(text: str) -> str | None:
    """`text` with mismatched closing brackets put right, as the model
    sometimes writes them in the wrong order (`{"keep": 12]} }` for
    `{"keep": 12}]}`): a closer that doesn't match the innermost open
    bracket closes that one first, and closers with nothing open are
    dropped. None if brackets are still open at the end (a cut-off reply),
    since closing those would keep half-written slides.
    """
    out, stack, in_string, escaped = [], [], False, False
    for ch in text:
        if in_string:
            out.append(ch)
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch in _CLOSER:
            stack.append(ch)
        elif ch in "]}":
            while stack and _CLOSER[stack[-1]] != ch:
                out.append(_CLOSER[stack.pop()])
            if not stack:
                continue  # nothing open for it
            stack.pop()
        out.append(ch)
    return None if stack or in_string else "".join(out)


def parse_json(raw: str) -> object:
    """The model's JSON reply, or the first {...} in it if it added text
    around it, with mismatched closing brackets repaired if needed; None if
    none of those parse.
    """
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        pass
    match = _JSON_OBJECT.search(raw)
    if not match:
        return None
    for text in (match.group(0), _fix_closers(match.group(0))):
        if text is None:
            continue
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            continue
    return None
