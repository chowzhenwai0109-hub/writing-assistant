import asyncio
import json

from google import genai
import httpx
from pydantic import SecretStr
import pytest

from app.config import Settings
from app.llm.client import LLMRequest
from app.llm.errors import LLMError
from app.llm.gemini import GeminiLLMClient
from app.llm.schemas import IntentionSequence
from test_generation import sequence_json


def llm_request():
    return LLMRequest("generate_intentions", "System policy", '{"input":{"topic":"Updates"}}', IntentionSequence.model_json_schema())


class RecordingTransport(httpx.MockTransport):
    def __init__(self, handler):
        super().__init__(handler)
        self.sync_closed = False
        self.async_closed = False

    def close(self):
        self.sync_closed = True
        return super().close()

    async def aclose(self):
        self.async_closed = True
        return await super().aclose()


def offline_adapter(handler):
    # The real SDK uses this in-memory HTTP transport; no socket is opened.
    requests = []
    options_seen = []
    def capture(request):
        requests.append(request)
        return handler(request)
    transport = RecordingTransport(capture)
    def factory(**kwargs):
        options = kwargs["http_options"]
        options_seen.append(options)
        kwargs["http_options"] = options.model_copy(update={
            "client_args": {"transport": transport, "trust_env": False},
            "async_client_args": {"transport": transport, "trust_env": False},
        })
        return genai.Client(**kwargs)
    settings = Settings(llm_mode="live", gemini_api_key=SecretStr("synthetic-offline-test-key"))
    return GeminiLLMClient(settings, factory), requests, options_seen, transport


def test_real_sdk_request_configuration_is_structured_bounded_and_closed_offline():
    def handler(_request):
        return httpx.Response(200, json={"candidates": [{
            "content": {"role": "model", "parts": [{"text": "Internal reasoning", "thought": True}, {"text": sequence_json()}]},
            "finishReason": "STOP",
        }]})
    adapter, requests, options, transport = offline_adapter(handler)
    result = asyncio.run(adapter.generate(llm_request()))
    assert result == sequence_json()
    assert len(requests) == 1
    assert requests[0].url.host == "generativelanguage.googleapis.com"
    assert requests[0].headers["x-goog-api-key"] == "synthetic-offline-test-key"
    payload = json.loads(requests[0].content)
    assert payload["generationConfig"]["responseMimeType"] == "application/json"
    assert payload["generationConfig"]["maxOutputTokens"] == 8192
    assert payload["generationConfig"]["responseJsonSchema"]["properties"]["intentions"]["maxItems"] == 8
    assert payload["systemInstruction"]["parts"][0]["text"] == "System policy"
    assert options[0].timeout == 30_000 and options[0].retry_options.attempts == 1
    assert transport.sync_closed and transport.async_closed


@pytest.mark.parametrize("status,expected", [(400, 502), (401, 503), (403, 503), (404, 503), (429, 502), (500, 502), (503, 502)])
def test_provider_errors_are_sanitized_and_sdk_never_retries(status, expected, caplog):
    marker = "sensitive-provider-error-and-key-must-not-escape"
    adapter, requests, _options, transport = offline_adapter(lambda _request: httpx.Response(status, json={"error": {"code": status, "message": marker}}))
    with pytest.raises(LLMError) as caught:
        asyncio.run(adapter.generate(llm_request()))
    assert caught.value.status_code == expected
    assert marker not in str(caught.value)
    assert marker not in caplog.text
    assert len(requests) == 1
    assert transport.sync_closed and transport.async_closed


@pytest.mark.parametrize("response", [
    {}, {"promptFeedback": {"blockReason": "SAFETY"}},
    {"candidates": [{"finishReason": "MAX_TOKENS", "content": {"parts": [{"text": "partial"}]}}]},
    {"candidates": [{"finishReason": "SAFETY"}]},
    {"candidates": [{"finishReason": "STOP", "content": {"parts": []}}]},
    {"candidates": [{"finishReason": "STOP", "content": {"parts": [{"text": "Thought only", "thought": True}]}}]},
    {"candidates": [{"finishReason": "STOP", "content": {"parts": [{"functionCall": {"name": "unrequested_action", "args": {}}}]}}]},
])
def test_refused_truncated_empty_and_nontext_responses_fail_without_repair(response):
    adapter, requests, _options, transport = offline_adapter(lambda _request: httpx.Response(200, json=response))
    with pytest.raises(LLMError) as caught:
        asyncio.run(adapter.generate(llm_request()))
    assert caught.value.status_code == 502
    assert len(requests) == 1
    assert transport.sync_closed and transport.async_closed


@pytest.mark.parametrize("error,expected", [(httpx.ReadTimeout("Sensitive timeout details"), 504), (httpx.ConnectError("Sensitive network details"), 502)])
def test_transport_failures_do_not_retry_or_expose_details(error, expected):
    def handler(_request):
        raise error
    adapter, requests, _options, transport = offline_adapter(handler)
    with pytest.raises(LLMError) as caught:
        asyncio.run(adapter.generate(llm_request()))
    assert caught.value.status_code == expected
    assert "Sensitive" not in str(caught.value)
    assert len(requests) == 1
    assert transport.sync_closed and transport.async_closed


@pytest.mark.parametrize("body", [
    "not JSON", '[]', '{"candidates":"sensitive-malformed-data"}',
    '{"candidates":[{"content":{"parts":[{"text":123}]},"finishReason":"STOP"}]}',
], ids=["invalid-json", "wrong-root", "wrong-candidates", "wrong-text"])
def test_malformed_provider_envelopes_fail_cleanly_without_retry(body):
    adapter, requests, _options, transport = offline_adapter(lambda _request: httpx.Response(200, text=body))
    with pytest.raises(LLMError) as caught:
        asyncio.run(adapter.generate(llm_request()))
    assert caught.value.status_code == 502
    assert "sensitive-malformed-data" not in str(caught.value)
    assert len(requests) == 1
    assert transport.sync_closed and transport.async_closed
