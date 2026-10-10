import asyncio
from concurrent.futures import ThreadPoolExecutor
import json
from threading import Event

from anyio import to_thread
import pytest
from pydantic import SecretStr
from sqlmodel import Session

from app.config import Settings
from app.llm.client import get_llm_client
from app.llm.errors import LLMFailure, LLMTimeout
from app.llm.fake import FakeLLMClient
from app.llm import service
from app.models import Draft, Intention
from app.routers import generation
from conftest import add_intention, create_draft


def sequence_json(count=5, **item_changes):
    return json.dumps({"intentions": [
        {"function_label": f"Purpose {index}", "description": "Explain a supplied point.", "guiding_question": "What should the reader understand?", **item_changes}
        for index in range(count)
    ]})


def fake_client(client, responses=None):
    fake = FakeLLMClient(responses)
    client.app.dependency_overrides[get_llm_client] = lambda: fake
    return fake


def generate(client, draft, **changes):
    return client.post(f"/api/drafts/{draft['id']}/intentions/generate", json={"expected_revision": draft["revision"], **changes})


def draft_with_work(client):
    draft = create_draft(client)
    intention = add_intention(client, draft["id"])
    assert client.patch(f"/api/intentions/{intention['id']}", json={
        "expected_revision": 1, "sentence_text": "Updates reduce risks.", "user_notes": "Do not lose these ideas.",
    }).status_code == 200
    return client.get(f"/api/drafts/{draft['id']}").json()


@pytest.mark.parametrize("count", [3, 4, 5, 6, 7, 8])
def test_fake_generation_uses_saved_count_settings_and_persists_in_order(client, count):
    draft = create_draft(client, target_sentence_count=count, target_word_min=100, target_word_max=180)
    fake = fake_client(client)
    response = generate(client, draft)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["mode"] == "fake"
    assert result["last_generation_mode"] == "fake"
    assert result["revision"] == 2
    assert result["intention_count"] == count
    assert [item["position"] for item in result["intentions"]] == list(range(count))
    assert all(item["status"] == "pending" and item["revision"] == 1 for item in result["intentions"])
    assert all(item["sentence_text"] is None and item["user_notes"] is None for item in result["intentions"])
    assert client.get(f"/api/drafts/{draft['id']}").json() == {key: value for key, value in result.items() if key != "mode"}
    assert len(fake.calls) == 1
    payload = json.loads(fake.calls[0].user_prompt)
    assert payload == {"input": {
        "topic": draft["topic"], "task_description": "", "target_sentence_count": count,
        "target_word_min": 100, "target_word_max": 180,
    }}
    assert fake.calls[0].output_schema["properties"]["intentions"]["minItems"] == count
    assert fake.calls[0].output_schema["properties"]["intentions"]["maxItems"] == count


def test_generation_provenance_is_read_only_and_survives_new_application(client):
    from fastapi.testclient import TestClient
    from app.main import create_app

    draft = create_draft(client)
    assert draft["last_generation_mode"] is None
    fake = fake_client(client)
    fake.mode = "live"  # Synthetic live-labelled client; no remote provider.
    generated = generate(client, draft).json()
    assert generated["mode"] == generated["last_generation_mode"] == "live"
    with TestClient(create_app(client.app.state.engine)) as restarted:
        restored = restarted.get(f"/api/drafts/{draft['id']}").json()
        assert restored == {key: value for key, value in generated.items() if key != "mode"}
        rejected = restarted.patch(f"/api/drafts/{draft['id']}", json={"expected_revision": restored["revision"], "last_generation_mode": "fake"})
        assert rejected.status_code == 422


def test_default_fake_mode_never_constructs_a_gemini_sdk_client(client, monkeypatch):
    import google.genai
    def forbidden_sdk(*_args, **_kwargs):
        raise AssertionError("A real SDK client must not exist in fake mode")
    monkeypatch.setattr(google.genai, "Client", forbidden_sdk)
    client.app.state.settings = Settings(gemini_api_key=SecretStr("synthetic-unused-key"))
    draft = create_draft(client)
    assert generate(client, draft).status_code == 200


def test_generation_requires_confirmation_and_replaces_atomically(client):
    before = draft_with_work(client)
    fake = fake_client(client)
    assert generate(client, before).status_code == 409
    assert fake.calls == []
    assert client.get(f"/api/drafts/{before['id']}").json() == before
    response = generate(client, before, confirm_replace=True, mode="replace")
    assert response.status_code == 200
    result = response.json()
    assert result["revision"] == before["revision"] + 1
    assert all(item["id"] > before["intentions"][0]["id"] for item in result["intentions"])
    assert all(item["sentence_text"] is None and item["user_notes"] is None and item["last_check_json"] is None for item in result["intentions"])
    with Session(client.app.state.engine) as session:
        assert session.get(Intention, before["intentions"][0]["id"]) is None


@pytest.mark.parametrize("changes", [{"mode": "append"}, {"confirm_replace": "true"}, {"target_sentence_count": 7}, {"expected_revision": True}])
def test_invalid_generation_request_does_not_call_or_mutate(client, changes):
    draft = create_draft(client)
    before = client.get(f"/api/drafts/{draft['id']}").json()
    fake = fake_client(client)
    response = generate(client, draft, **changes)
    assert response.status_code == 422
    assert isinstance(response.json()["detail"], str)
    assert fake.calls == []
    assert client.get(f"/api/drafts/{draft['id']}").json() == before


def test_missing_and_stale_drafts_do_not_call_model(client):
    before = draft_with_work(client)
    fake = fake_client(client)
    assert generate(client, {"id": before["id"], "revision": 1}, confirm_replace=True).status_code == 409
    assert generate(client, {"id": 99999, "revision": 1}).status_code == 404
    assert fake.calls == []


def test_invalid_json_repairs_once_then_saves_valid_sequence(client):
    draft = create_draft(client)
    fake = fake_client(client, ["not JSON", sequence_json()])
    response = generate(client, draft)
    assert response.status_code == 200
    assert len(fake.calls) == 2
    assert "validation_feedback" not in json.loads(fake.calls[0].user_prompt)
    assert "validation_feedback" in json.loads(fake.calls[1].user_prompt)
    assert fake.calls[0].system_prompt == fake.calls[1].system_prompt


@pytest.mark.parametrize("bad_output", [
    "not JSON", "```json\n{}\n```", "{}", "[]",
    sequence_json(3), sequence_json(8), sequence_json(9),
    sequence_json(function_label=" "), sequence_json(description="a" * 1001),
    sequence_json(guiding_question=123), sequence_json(extra="Must reject unknown fields"),
    sequence_json(description="\ud800"),
    '{"intentions":[],"intentions":[]}', '{"intentions":NaN}',
], ids=["invalid-json", "markdown", "missing-list", "wrong-root", "too-few", "too-many", "over-cap", "blank-label", "long-description", "wrong-type", "extra-field", "surrogate", "duplicate-key", "nonfinite"])
def test_invalid_output_after_one_repair_preserves_all_work(client, bad_output):
    before = draft_with_work(client)
    fake = fake_client(client, [bad_output, bad_output])
    response = generate(client, before, confirm_replace=True)
    assert response.status_code == 502, response.text
    assert len(fake.calls) == 2
    assert client.get(f"/api/drafts/{before['id']}").json() == before


def test_repair_errors_do_not_echo_raw_values_or_unknown_field_names(client):
    draft = create_draft(client)
    secret_marker = "sensitive-output-do-not-echo"
    payload = json.loads(sequence_json())
    payload["intentions"][0][secret_marker] = secret_marker
    fake = fake_client(client, [json.dumps(payload), sequence_json()])
    assert generate(client, draft).status_code == 200
    feedback = json.loads(fake.calls[1].user_prompt)["validation_feedback"]
    assert "extra_forbidden" in feedback
    assert secret_marker not in feedback


@pytest.mark.parametrize("result,status", [("", 502), (" \n ", 502), ("a" * (128 * 1024 + 1), 502), (LLMFailure("Provider declined."), 502), (LLMTimeout(), 504)], ids=["empty", "whitespace", "oversize", "refusal", "timeout"])
def test_nonrepairable_failure_does_not_retry_or_delete_work(client, result, status):
    before = draft_with_work(client)
    fake = fake_client(client, [result])
    response = generate(client, before, confirm_replace=True)
    assert response.status_code == status
    assert len(fake.calls) == 1
    assert client.get(f"/api/drafts/{before['id']}").json() == before


@pytest.mark.parametrize("settings", [
    Settings(llm_mode="live"), Settings(llm_mode="unsupported"), Settings(llm_provider="unsupported"),
    Settings(llm_mode="live", llm_model="", gemini_api_key=SecretStr("synthetic-test-key")),
    Settings(llm_mode="live", llm_model="gemini-invalid/model", gemini_api_key=SecretStr("synthetic-test-key")),
])
def test_bad_configuration_returns_503_while_crud_and_health_work(client, settings):
    client.app.state.settings = settings
    draft = create_draft(client)
    response = generate(client, draft)
    assert response.status_code == 503
    assert isinstance(response.json()["detail"], str)
    assert "synthetic-test-key" not in response.text
    assert client.get("/api/health").status_code == 200
    assert client.get(f"/api/drafts/{draft['id']}").json()["intentions"] == []


def test_unicode_context_budget_is_checked_before_model_call(client):
    draft = create_draft(client, topic="😀" * 2000, task_description="😀" * 4000)
    fake = fake_client(client)
    response = generate(client, draft)
    assert response.status_code == 422
    assert fake.calls == []
    assert client.get(f"/api/drafts/{draft['id']}").json()["revision"] == 1


def test_context_sent_to_model_excludes_metadata_and_api_secret(client):
    client.app.state.settings = Settings(gemini_api_key=SecretStr("synthetic-secret-not-in-context"))
    draft = create_draft(client, title="Private title not needed by model", task_description="For beginners")
    fake = fake_client(client)
    assert generate(client, draft).status_code == 200
    prompt = fake.calls[0].user_prompt
    assert "synthetic-secret-not-in-context" not in prompt
    assert "Private title" not in prompt
    assert "revision" not in prompt and "created_at" not in prompt
    assert "untrusted content" in fake.calls[0].system_prompt


def test_exception_after_deletion_rolls_back_replacement(client, monkeypatch):
    before = draft_with_work(client)
    fake_client(client)
    def fail_touch(*_args):
        raise RuntimeError("Injected replacement failure")
    monkeypatch.setattr(generation, "touch_draft", fail_touch)
    response = generate(client, before, confirm_replace=True)
    assert response.status_code == 500
    assert client.get(f"/api/drafts/{before['id']}").json() == before


class BlockingFake(FakeLLMClient):
    def __init__(self):
        super().__init__()
        self.started = Event()
        self.release = Event()

    async def generate(self, request):
        self.started.set()
        released = await to_thread.run_sync(lambda: self.release.wait(timeout=5))
        assert released, "Test did not release the fake response"
        return await super().generate(request)


def test_user_can_save_during_generation_and_stale_result_cannot_replace_it(client):
    before = draft_with_work(client)
    blocking = BlockingFake()
    client.app.dependency_overrides[get_llm_client] = lambda: blocking
    with ThreadPoolExecutor(max_workers=1) as executor:
        pending = executor.submit(generate, client, before, confirm_replace=True)
        assert blocking.started.wait(timeout=5)
        try:
            intention = before["intentions"][0]
            response = client.patch(f"/api/intentions/{intention['id']}", json={
                "expected_revision": intention["revision"], "sentence_text": "Keep the newer sentence.",
            })
            assert response.status_code == 200
            after_save = client.get(f"/api/drafts/{before['id']}").json()
        finally:
            blocking.release.set()
        assert pending.result(timeout=5).status_code == 409
    assert client.get(f"/api/drafts/{before['id']}").json() == after_save


def test_context_fingerprint_detects_change_even_without_revision_bump(client):
    before = draft_with_work(client)
    class ContextChangingFake(FakeLLMClient):
        async def generate(self, request):
            with Session(client.app.state.engine) as session:
                draft = session.get(Draft, before["id"])
                draft.topic = "Changed directly in storage"
                session.add(draft)
                session.commit()
            return await super().generate(request)
    client.app.dependency_overrides[get_llm_client] = lambda: ContextChangingFake()
    assert generate(client, before, confirm_replace=True).status_code == 409
    after = client.get(f"/api/drafts/{before['id']}").json()
    assert after["intentions"] == before["intentions"]
    assert after["topic"] == "Changed directly in storage"


def test_two_inflight_generations_can_apply_only_one_sequence(client):
    before = create_draft(client)
    blocking = BlockingFake()
    client.app.dependency_overrides[get_llm_client] = lambda: blocking
    with ThreadPoolExecutor(max_workers=1) as executor:
        pending = executor.submit(generate, client, before)
        assert blocking.started.wait(timeout=5)
        try:
            fake_client(client)
            first = generate(client, before)
            assert first.status_code == 200
        finally:
            blocking.release.set()
        assert pending.result(timeout=5).status_code == 409
    assert client.get(f"/api/drafts/{before['id']}").json() == {key: value for key, value in first.json().items() if key != "mode"}


def test_deleted_draft_cannot_be_recreated_by_late_generation(client):
    before = create_draft(client)
    blocking = BlockingFake()
    client.app.dependency_overrides[get_llm_client] = lambda: blocking
    with ThreadPoolExecutor(max_workers=1) as executor:
        pending = executor.submit(generate, client, before)
        assert blocking.started.wait(timeout=5)
        try:
            deleted = client.delete(f"/api/drafts/{before['id']}", params={"expected_revision": before["revision"]})
            assert deleted.status_code == 204
        finally:
            blocking.release.set()
        assert pending.result(timeout=5).status_code == 404
    assert client.get("/api/drafts").json() == []


def test_attempt_deadline_cancels_slow_fake_without_repair(client, monkeypatch):
    before = draft_with_work(client)
    cancelled = Event()
    class SlowFake(FakeLLMClient):
        async def generate(self, request):
            self.calls.append(request)
            try:
                await asyncio.sleep(10)
            finally:
                cancelled.set()
    fake = SlowFake()
    client.app.dependency_overrides[get_llm_client] = lambda: fake
    monkeypatch.setattr(service, "ATTEMPT_TIMEOUT_SECONDS", 0.01)
    assert generate(client, before, confirm_replace=True).status_code == 504
    assert len(fake.calls) == 1 and cancelled.is_set()
    assert client.get(f"/api/drafts/{before['id']}").json() == before


def test_invalid_unicode_input_is_rejected_before_storage(client):
    response = client.post("/api/drafts", content=json.dumps({"title": "Valid", "topic": "\ud800"}), headers={"Content-Type": "application/json"})
    assert response.status_code == 422
    assert "unicode" in response.json()["detail"].lower()
    assert client.get("/api/drafts").json() == []
