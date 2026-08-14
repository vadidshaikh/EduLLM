import logging

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_nvidia_ai_endpoints import ChatNVIDIA

from app.config import settings

logger = logging.getLogger(__name__)


def _to_chat_messages(messages: list[dict[str, str]]):
    """Convert OpenAI-style message dicts into LangChain message objects."""
    converted = []
    for message in messages:
        role = message.get("role", "user")
        content = message.get("content", "")
        if role == "system":
            converted.append(SystemMessage(content=content))
        elif role == "assistant":
            converted.append(AIMessage(content=content))
        elif role == "tool":
            converted.append(ToolMessage(content=content, tool_call_id=message.get("tool_call_id", "tool")))
        else:
            converted.append(HumanMessage(content=content))
    return converted


def call_llm(
    messages: list[dict[str, str]],
    *,
    model: str | None = None,
    temperature: float | None = None,
) -> str:
    """Sends a conversation to the configured AI language model and returns its text reply."""
    kwargs = {}
    if temperature is not None:
        kwargs["temperature"] = temperature
    try:
        llm = ChatNVIDIA(model=model or settings.LLM_MODEL, **kwargs)
        response = llm.invoke(_to_chat_messages(messages))
        return response.content or ""
    except Exception as exc:
        logger.warning("NVIDIA chat completion failed for %s: %s", model or settings.LLM_MODEL, exc)
        return _fallback_reply(messages)


def stream_llm(
    messages: list[dict[str, str]],
    *,
    model: str | None = None,
    temperature: float | None = None,
):
    """Sends a conversation to the configured AI language model and yields
    its text reply incrementally as chunks arrive, instead of waiting for
    the full response like call_llm does.
    """
    kwargs = {}
    if temperature is not None:
        kwargs["temperature"] = temperature

    yielded_any = False
    try:
        llm = ChatNVIDIA(model=model or settings.LLM_MODEL, **kwargs)
        for chunk in llm.stream(_to_chat_messages(messages)):
            if chunk.content:
                yielded_any = True
                yield chunk.content
    except Exception as exc:
        logger.warning("NVIDIA streaming chat completion failed for %s: %s", model or settings.LLM_MODEL, exc)
        # Only fall back if the failure happened before any real content
        # went out — once tokens have already reached the client, silently
        # appending the fallback sentence would just garble the answer.
        if not yielded_any:
            yield _fallback_reply(messages)


def _fallback_reply(messages: list[dict[str, str]]) -> str:
    """Return a safe deterministic reply when the hosted model is unavailable.

    The graph uses the model for query condensation, chart classification,
    chart generation, and final answer writing. When the provider is
    unavailable, it is safer to keep the pipeline running with conservative
    defaults than to fail the request outright.
    """
    prompt_text = "\n".join(message.get("content", "") for message in messages)
    lower_prompt = prompt_text.lower()

    if "standalone search query" in lower_prompt:
        for message in reversed(messages):
            content = message.get("content", "")
            if "New question:" in content:
                return content.split("New question:", 1)[1].split("\n\nStandalone search query:", 1)[0].strip()
        return messages[-1].get("content", "").strip()

    if "output only \"yes\" or \"no\"" in lower_prompt:
        return "no"

    if "output only a single json object" in lower_prompt:
        return "{}"

    return "I’m unable to generate a model response right now because the hosted inference provider is unavailable."
