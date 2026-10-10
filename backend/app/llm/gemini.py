"""Gemini structured-output adapter. Constructed only for explicit live mode."""

from collections.abc import Callable

from google import genai
from google.genai import errors, types
import httpx

from app.config import Settings
from app.llm.client import ATTEMPT_TIMEOUT_SECONDS, LLMRequest, MAX_OUTPUT_TOKENS
from app.llm.errors import LLMFailure, LLMTimeout, LLMUnavailable


class GeminiLLMClient:
    mode = "live"

    def __init__(self, settings: Settings, client_factory: Callable | None = None):
        self._settings = settings
        self._client_factory = client_factory

    async def generate(self, request: LLMRequest) -> str:
        factory = self._client_factory or genai.Client
        sdk = None
        try:
            sdk = factory(
                api_key=self._settings.gemini_api_key.get_secret_value(),
                vertexai=False,
                http_options=types.HttpOptions(
                    base_url="https://generativelanguage.googleapis.com",
                    api_version="v1beta",
                    timeout=ATTEMPT_TIMEOUT_SECONDS * 1000,
                    retry_options=types.HttpRetryOptions(attempts=1),
                ),
            )
            async with sdk.aio as asynchronous_client:
                response = await asynchronous_client.models.generate_content(
                    model=self._settings.llm_model,
                    contents=request.user_prompt,
                    config=types.GenerateContentConfig(
                        system_instruction=request.system_prompt,
                        response_mime_type="application/json",
                        response_json_schema=request.output_schema,
                        max_output_tokens=MAX_OUTPUT_TOKENS,
                        candidate_count=1,
                        automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
                    ),
                )
            blocked = response.prompt_feedback and response.prompt_feedback.block_reason
            if blocked and blocked != types.BlockedReason.BLOCKED_REASON_UNSPECIFIED:
                raise LLMFailure("The provider declined this writing request. Please revise it and retry.")
            if not response.candidates or len(response.candidates) != 1:
                raise LLMFailure("The provider returned no usable candidate. Please retry.")
            candidate = response.candidates[0]
            if candidate.finish_reason == types.FinishReason.MAX_TOKENS:
                raise LLMFailure("The provider response was truncated. Please retry.")
            if candidate.finish_reason != types.FinishReason.STOP:
                raise LLMFailure("The provider did not complete the writing request. Please revise it and retry.")
            parts = candidate.content.parts if candidate.content else []
            output = "".join(part.text for part in parts or [] if part.text and not part.thought)
            if not output.strip():
                raise LLMFailure("The provider returned no usable text. Please retry.")
            return output
        except (httpx.TimeoutException, TimeoutError):
            raise LLMTimeout() from None
        except errors.APIError as error:
            if error.code in (401, 403):
                raise LLMUnavailable("Gemini authentication failed. Check GEMINI_API_KEY and account access.") from None
            if error.code == 404:
                raise LLMUnavailable("The configured Gemini model is unavailable. Check LLM_MODEL.") from None
            if error.code == 429:
                raise LLMFailure("The provider is rate limited. Please retry later.") from None
            raise LLMFailure("The provider could not complete the request. Please retry.") from None
        except httpx.RequestError:
            raise LLMFailure("Could not connect to the writing provider. Please retry.") from None
        except ValueError:
            # SDK JSON decoding and response validation may include raw content.
            # A broken provider envelope is not a repairable model output.
            raise LLMFailure("The provider returned an invalid response. Please retry.") from None
        finally:
            if sdk is not None:
                sdk.close()
