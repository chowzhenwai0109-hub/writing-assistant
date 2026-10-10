from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import json

import pytest
from sqlmodel import Session

from app.llm.client import get_llm_client
from app.llm.errors import LLMFailure
from app.llm.fake import FakeLLMClient
from app.models import Intention
from conftest import add_intention, create_draft
from test_generation import BlockingFake, fake_client


HINTS = {
    "intention_summary": "Explain the main point.", "relationship": "elaboration",
    "entities": [{"label": "Subject", "why_needed": "Who or what the point concerns."}] * 7,
    "keywords": [{"phrase": "supplied reason", "note": "Ground the point in your information."}] * 8,
    "connectives": [{"word": "because", "use": "Connect the supplied reason."}] * 6,
    "structures": [{"pattern": "[subject] [action] because [supplied reason].", "note": "Choose your content."}] * 5,
    "examples": [{"sentence": "A clear explanation gives readers a reason to consider the point.", "why_it_works": "A practice example."}] * 4,
}


def work(client, **settings):
    draft = create_draft(client, **settings)
    first = add_intention(client, draft["id"])
    second = add_intention(client, draft["id"], "Explain the reason")
    client.patch(f"/api/intentions/{first['id']}", json={"expected_revision": 1, "sentence_text": "Updates address known problems."})
    client.patch(f"/api/intentions/{second['id']}", json={"expected_revision": 1, "user_notes": "解释原因，不要编造数据", "sentence_text": "My unfinished point"})
    return client.get(f"/api/drafts/{draft['id']}").json()


def hints(client, draft, level="hint", **changes):
    item = draft["intentions"][-1]
    return client.post(f"/api/intentions/{item['id']}/hints", json={"help_level": level, "expected_revision": item["revision"], "expected_draft_revision": draft["revision"], **changes})


@pytest.mark.parametrize("level,structures,examples", [("hint", 0, 0), ("structure", 3, 0), ("example", 3, 2)])
def test_policy_strips_disallowed_fields_and_truncates_known_lists_without_repair(client, level, structures, examples):
    before = work(client)
    fake = fake_client(client, [json.dumps(HINTS)])
    response = hints(client, before, level)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["mode"] == "fake"
    assert result["draft_revision"] == before["revision"]
    assert result["intention_revision"] == before["intentions"][-1]["revision"]
    assert len(result["context_fingerprint"]) == 64
    assert [len(result["result"][key]) for key in ("entities", "keywords", "connectives", "structures", "examples")] == [5, 6, 4, structures, examples]
    assert len(fake.calls) == 1
    assert client.get(f"/api/drafts/{before['id']}").json() == before


def test_compact_context_contains_saved_writing_notes_targets_without_metadata_or_secret(client):
    draft = work(client, title="Private title", task_description="For classmates", target_word_min=100, target_word_max=180)
    fake = fake_client(client)
    assert hints(client, draft, "structure").status_code == 200
    request = fake.calls[0]
    context = json.loads(request.user_prompt)["input"]
    assert context["previous_sentences"] == ["Updates address known problems."]
    assert context["current_sentence"] == "My unfinished point"
    assert context["user_notes"] == "解释原因，不要编造数据"
    assert context["current_intention"]["position"] == 1
    assert context["task_description"] == "For classmates" and context["target_word_max"] == 180
    assert set(context["intentions"][0]) == {"function_label", "description"}
    assert all(key not in request.user_prompt for key in ("Private title", "created_at", "revision", "draft_id", "GEMINI_API_KEY"))
    assert "guidance is English" in request.system_prompt
    assert request.output_schema["properties"]["examples"]["maxItems"] == 0


@pytest.mark.parametrize("pattern", ["A finished sentence.", "[ ]", "[...]", "[x]", "[placeholder]", "[text]", "[.]"], ids=["filled", "blank", "ellipsis", "single-letter", "generic", "text", "punctuation"])
def test_structure_rejects_placeholder_failures_once_then_preserves_work(client, pattern):
    draft = work(client)
    data = deepcopy(HINTS)
    data["structures"][0]["pattern"] = pattern
    fake = fake_client(client, [json.dumps(data), json.dumps(data)])
    assert hints(client, draft, "structure").status_code == 502
    assert len(fake.calls) == 2
    assert "substantive slot" in json.loads(fake.calls[1].user_prompt)["validation_feedback"]
    assert client.get(f"/api/drafts/{draft['id']}").json() == draft


def test_disallowed_and_truncated_patterns_are_removed_before_placeholder_checks(client):
    draft = work(client)
    data = deepcopy(HINTS)
    data["structures"] = [deepcopy(item) for item in data["structures"]]
    data["structures"][3]["pattern"] = "A fully filled sentence."
    fake = fake_client(client, [json.dumps(data)])
    assert hints(client, draft, "structure").status_code == 200
    assert len(fake.calls) == 1
    data["structures"][0]["pattern"] = "A fully filled sentence."
    fake = fake_client(client, [json.dumps(data)])
    assert hints(client, draft, "hint").json()["result"]["structures"] == []
    assert len(fake.calls) == 1


@pytest.mark.parametrize("mutation", ["unknown", "missing", "wrong-type", "blank", "invalid-json", "duplicate-key"], ids=str)
def test_invalid_shapes_repair_once_and_fail_cleanly(client, mutation):
    draft = work(client)
    data = deepcopy(HINTS)
    if mutation == "unknown": data["sensitive-unknown-field"] = "Never echo this"
    if mutation == "missing": del data["entities"]
    if mutation == "wrong-type": data["examples"][0]["sentence"] = 123
    if mutation == "blank": data["relationship"] = " "
    raw = json.dumps(data)
    if mutation == "invalid-json": raw = "```json\n{}\n```"
    if mutation == "duplicate-key": raw = '{"entities":[],"entities":[]}'
    fake = fake_client(client, [raw, raw])
    response = hints(client, draft)
    assert response.status_code == 502
    assert len(fake.calls) == 2
    assert "sensitive-unknown-field" not in fake.calls[1].user_prompt
    assert client.get(f"/api/drafts/{draft['id']}").json() == draft


def test_repair_can_recover_valid_guidance_and_failure_does_not_retry_transport(client):
    draft = work(client)
    fake = fake_client(client, ["invalid JSON", json.dumps(HINTS)])
    assert hints(client, draft, "example").status_code == 200
    assert len(fake.calls) == 2
    fake = fake_client(client, [LLMFailure("Provider declined.")])
    assert hints(client, draft).status_code == 502
    assert len(fake.calls) == 1


@pytest.mark.parametrize("changes", [{"help_level": "advanced"}, {"expected_revision": True}, {"expected_draft_revision": True}, {"sentence": "Must use saved sentence"}, {"mode": "live"}, {"expected_revision": 999}, {"expected_draft_revision": 999}])
def test_invalid_and_stale_requests_never_call_model(client, changes):
    draft = work(client)
    fake = fake_client(client)
    assert hints(client, draft, **changes).status_code in (409, 422)
    assert fake.calls == []


def test_context_size_is_checked_without_truncating_or_calling_model(client):
    draft = work(client, topic="😀" * 2000)
    item = draft["intentions"][-1]
    client.patch(f"/api/intentions/{item['id']}", json={"expected_revision": item["revision"], "user_notes": "😀" * 4000})
    draft = client.get(f"/api/drafts/{draft['id']}").json()
    fake = fake_client(client)
    assert hints(client, draft).status_code == 422
    assert fake.calls == []


def test_saves_can_proceed_during_hints_and_late_guidance_is_rejected(client):
    before = work(client)
    blocking = BlockingFake()
    client.app.dependency_overrides[get_llm_client] = lambda: blocking
    with ThreadPoolExecutor(max_workers=1) as executor:
        pending = executor.submit(hints, client, before)
        assert blocking.started.wait(timeout=5)
        try:
            item = before["intentions"][0]
            assert client.patch(f"/api/intentions/{item['id']}", json={"expected_revision": item["revision"], "sentence_text": "Keep my newer point."}).status_code == 200
        finally:
            blocking.release.set()
        assert pending.result(timeout=5).status_code == 409
    assert client.get(f"/api/drafts/{before['id']}").json()["intentions"][0]["sentence_text"] == "Keep my newer point."


def test_fingerprint_detects_external_change_without_revision_bump(client):
    before = work(client)
    class ChangedContext(FakeLLMClient):
        async def generate(self, request):
            with Session(client.app.state.engine) as session:
                item = session.get(Intention, before["intentions"][-1]["id"])
                item.user_notes = "Changed outside the normal API"
                session.add(item)
                session.commit()
            return await super().generate(request)
    client.app.dependency_overrides[get_llm_client] = lambda: ChangedContext()
    assert hints(client, before).status_code == 409


def test_deleted_intention_does_not_receive_late_hints(client):
    before = work(client)
    blocking = BlockingFake()
    client.app.dependency_overrides[get_llm_client] = lambda: blocking
    with ThreadPoolExecutor(max_workers=1) as executor:
        pending = executor.submit(hints, client, before)
        assert blocking.started.wait(timeout=5)
        try:
            item = before["intentions"][-1]
            assert client.delete(f"/api/intentions/{item['id']}", params={"expected_revision": item["revision"], "expected_draft_revision": before["revision"]}).status_code == 204
        finally:
            blocking.release.set()
        assert pending.result(timeout=5).status_code == 404
