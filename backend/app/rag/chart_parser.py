import json
import logging
import re

logger = logging.getLogger(__name__)

_JSON_OBJECT_PATTERN = re.compile(r"\{.*\}", re.DOTALL)
_VALID_TYPES = {"bar", "line", "pie", "doughnut", "radar"}


def parse_chart_json(raw: str) -> dict | None:
    """Parse the dedicated generate_chart LLM call's output into a chart
    config dict, or None if it's missing/malformed/invalid.

    The model is instructed to output only a JSON object, but this tolerates
    stray surrounding text by falling back to extracting the first {...}
    block before giving up.
    """
    raw = raw.strip()
    try:
        chart = json.loads(raw)
    except json.JSONDecodeError:
        match = _JSON_OBJECT_PATTERN.search(raw)
        if not match:
            logger.warning("No JSON object found in generate_chart output, dropping chart")
            return None
        try:
            chart = json.loads(match.group(0))
        except json.JSONDecodeError:
            logger.warning("Malformed JSON in generate_chart output, dropping chart")
            return None

    if not isinstance(chart, dict) or chart.get("type") not in _VALID_TYPES:
        logger.warning(
            "Invalid chart type %r from generate_chart, dropping chart",
            chart.get("type") if isinstance(chart, dict) else chart,
        )
        return None

    return chart
