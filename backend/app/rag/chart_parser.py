import logging

from app.llm_json import parse_json

logger = logging.getLogger(__name__)

_VALID_TYPES = {"bar", "line", "pie", "doughnut", "radar"}


def parse_chart_json(raw: str) -> dict | None:
    """Parse the dedicated generate_chart LLM call's output into a chart
    config dict, or None if it's missing/malformed/invalid.

    The model is instructed to output only a JSON object; `parse_json`
    tolerates stray surrounding text and mismatched closing brackets.
    """
    chart = parse_json(raw.strip())
    if chart is None:
        logger.warning("No usable JSON object in generate_chart output, dropping chart")
        return None

    if not isinstance(chart, dict) or chart.get("type") not in _VALID_TYPES:
        logger.warning(
            "Invalid chart type %r from generate_chart, dropping chart",
            chart.get("type") if isinstance(chart, dict) else chart,
        )
        return None

    return chart
