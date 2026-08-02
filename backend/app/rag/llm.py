from litellm import completion

from app.config import settings


def call_llm(messages: list[dict[str, str]]) -> str:
    response = completion(model=settings.LLM_MODEL, messages=messages)
    return response.choices[0].message.content
