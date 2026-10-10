"""Provider-independent asynchronous client contract and lazy mode selection."""

from dataclasses import dataclass
import re
from typing import Any, Literal, Protocol

from fastapi import Request

from app.config import Settings
from app.llm.errors import LLMUnavailable

ATTEMPT_TIMEOUT_SECONDS = 30
MAX_OUTPUT_TOKENS = 8192
Task = Literal["generate_intentions", "get_hints", "make_plan", "check_sentence"]


@dataclass(frozen=True)
class LLMRequest:
    task: Task
    system_prompt: str
    user_prompt: str
    output_schema: dict[str, Any]


class LLMClient(Protocol):
    mode: Literal["fake", "live"]

    async def generate(self, request: LLMRequest) -> str: ...


def create_llm_client(settings: Settings) -> LLMClient:
    if settings.llm_provider != "gemini":
        raise LLMUnavailable("Unsupported LLM_PROVIDER. Set LLM_PROVIDER=gemini.")
    if settings.llm_mode == "fake":
        from app.llm.fake import FakeLLMClient

        return FakeLLMClient()
    if settings.llm_mode != "live":
        raise LLMUnavailable("Unsupported LLM_MODE. Use fake or live.")
    if not settings.gemini_api_key.get_secret_value().strip():
        raise LLMUnavailable("GEMINI_API_KEY is missing. Set it in the backend environment for live mode.")
    if not re.fullmatch(r"gemini-[A-Za-z0-9][A-Za-z0-9._-]{0,92}", settings.llm_model):
        raise LLMUnavailable("LLM_MODEL must name a supported Gemini model.")
    # No SDK import/client construction in fake mode, startup, health or CRUD.
    from app.llm.gemini import GeminiLLMClient

    return GeminiLLMClient(settings)


def get_llm_client(request: Request) -> LLMClient:
    return create_llm_client(request.app.state.settings)
