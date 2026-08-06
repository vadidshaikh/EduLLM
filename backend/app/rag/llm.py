from litellm import completion

from app.config import settings


def call_llm(
    messages: list[dict[str, str]],
    *,
    model: str | None = None,
    temperature: float | None = None,
) -> str:
    kwargs = {}
    if temperature is not None:
        kwargs["temperature"] = temperature
    response = completion(model=model or settings.LLM_MODEL, messages=messages, **kwargs)
    return response.choices[0].message.content
