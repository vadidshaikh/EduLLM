import json
import logging
import re

logger = logging.getLogger(__name__)

_PATTERN = re.compile(r"\[GRAPH_CONFIG\](.*?)\[/GRAPH_CONFIG\]", re.DOTALL)
_VALID_TYPES = {"bar", "line", "pie", "doughnut", "radar"}


def parse_chart_config(raw_answer: str) -> tuple[str, dict | None]:
    """Extract and strip a [GRAPH_CONFIG] block from the raw LLM answer.

    Returns (visible_text, chart_or_none). Any malformed or invalid block is
    stripped and logged, degrading gracefully to a chart-less answer rather
    than leaking raw block syntax into the UI.
    """
    match = _PATTERN.search(raw_answer)
    if not match:
        return raw_answer.strip(), None

    clean_text = _PATTERN.sub("", raw_answer).strip()

    try:
        chart = json.loads(match.group(1).strip())
    except json.JSONDecodeError:
        logger.warning("Malformed GRAPH_CONFIG block, dropping it")
        return clean_text, None

    if not isinstance(chart, dict) or chart.get("type") not in _VALID_TYPES:
        logger.warning("Invalid GRAPH_CONFIG chart type %r, dropping it", chart.get("type") if isinstance(chart, dict) else chart)
        return clean_text, None

    return clean_text, chart
