from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import json
from threading import Barrier
from anyio import to_thread
from fastapi.testclient import TestClient

import pytest
from sqlmodel import Session

from app.llm.client import get_llm_client
from app.llm.errors import LLMFailure, LLMTimeout
from app.llm.fake import FakeLLMClient
from app.models import Intention
from app.main import create_app
from app.llm import context
from conftest import seed_checks
from test_generation import BlockingFake, fake_client
from test_hints import work

OUTPUT = {"fulfils_intention": "yes", "summary": "The primary purpose is present.", "issues": []}


def check(client, draft, **changes):
    item = draft["intentions"][-1]
    return client.post(f"/api/intentions/{item['id']}/check", json={
        "sentence": item["sentence_text"], "expected_revision": item["revision"],
        "expected_draft_revision": draft["revision"], **changes,
    })


@pytest.mark.parametrize("verdict", ["yes", "partly", "no"])
def test_success_persists_all_verdicts_advances_revisions_and_reloads(client, verdict):
    before = work(client)
    output = {**OUTPUT, "fulfils_intention": verdict, "issues": [{"type": "other", "message": "Meaning may be clearer.", "suggestion": "Clarify the reference."}] * 7}
    fake = fake_client(client, [json.dumps(output)])
    response = check(client, before)
    assert response.status_code == 200, response.text
    result = response.json()
    item = result["intention"]
    assert item["status"] == "checked" and len(result["result"]["issues"]) == 5
    assert item["revision"] == result["intention_revision"] == before["intentions"][-1]["revision"] + 1
    assert result["draft_revision"] == before["revision"] + 1
    assert item["last_check_json"] == {"result": result["result"], "mode": "fake"}
    assert item["last_check_fingerprint"] == result["context_fingerprint"]
    assert client.get(f"/api/drafts/{before['id']}").json() == result["draft"]
    request = json.loads(fake.calls[0].user_prompt)["input"]
    assert request["current_sentence"] == item["sentence_text"]
    assert "help_level" not in request and "sentence" not in request
    assert request["previous_sentences"] == ["Updates address known problems."]
    assert fake.calls[0].output_schema["properties"]["issues"]["maxItems"] == 5


def test_changed_sentence_commits_before_inference_and_preserves_exact_text(client):
    before = work(client)
    fake_client(client)
    sentence = "  A fragment\nTwo sentences. Another sentence.  "
    result = check(client, before, sentence=sentence).json()
    assert result["intention"]["sentence_text"] == sentence
    assert result["intention_revision"] == before["intentions"][-1]["revision"] + 2
    assert result["draft_revision"] == before["revision"] + 2


@pytest.mark.parametrize("changes", [
    {"sentence": ""}, {"sentence": " \n\u0085"}, {"sentence": None}, {"sentence": 42},
    {"sentence": "x" * 4001}, {"sentence": "\ud800"}, {"help_level": "hint"},
    {"expected_revision": True}, {"expected_draft_revision": True},
    {"expected_revision": 999}, {"expected_draft_revision": 999},
])
def test_invalid_or_stale_input_has_no_write_or_model_call(client, changes):
    before = work(client); fake = fake_client(client)
    if changes.get("sentence") == "\ud800":
        item = before["intentions"][-1]
        response = client.post(f"/api/intentions/{item['id']}/check", content=json.dumps({"sentence": "\ud800", "expected_revision": item["revision"], "expected_draft_revision": before["revision"]}), headers={"Content-Type": "application/json"})
    else:
        response = check(client, before, **changes)
    assert response.status_code in (409, 422)
    assert not fake.calls
    assert client.get(f"/api/drafts/{before['id']}").json() == before


def test_excessive_candidate_context_rejected_before_mutation(client):
    before = work(client, topic="\U0001f600" * 2000); fake = fake_client(client)
    assert check(client, before, sentence="\U0001f600" * 4000).status_code == 422
    assert not fake.calls
    assert client.get(f"/api/drafts/{before['id']}").json() == before


@pytest.mark.parametrize("bad", ["bad JSON", json.dumps({**OUTPUT, "rewrite": "Unwanted sentence"}), json.dumps({**OUTPUT, "fulfils_intention": "maybe"}), json.dumps({**OUTPUT, "summary": " "})])
def test_one_clean_repair_and_no_feedback_on_failure(client, bad):
    before = work(client); fake = fake_client(client, [bad, bad])
    assert check(client, before).status_code == 502
    assert len(fake.calls) == 2 and "Unwanted sentence" not in fake.calls[-1].user_prompt
    assert client.get(f"/api/drafts/{before['id']}").json() == before
    fake = fake_client(client, [bad, json.dumps(OUTPUT)])
    assert check(client, before).status_code == 200 and len(fake.calls) == 2


@pytest.mark.parametrize("failure,status", [(LLMFailure("Unavailable"), 502), (LLMTimeout(), 504)])
def test_failure_retains_changed_sentence_and_invalidates_feedback(client, failure, status):
    before = work(client)
    with Session(client.app.state.engine) as session: seed_checks(session, before["id"])
    before = client.get(f"/api/drafts/{before['id']}").json()
    fake = fake_client(client, [failure])
    assert check(client, before, sentence="Keep this new sentence.").status_code == status
    assert len(fake.calls) == 1
    saved = client.get(f"/api/drafts/{before['id']}").json()
    assert saved["intentions"][0] == before["intentions"][0]
    assert saved["intentions"][-1]["sentence_text"] == "Keep this new sentence."
    assert saved["intentions"][-1]["status"] == "written"
    assert saved["intentions"][-1]["last_check_json"] is None
    assert saved["revision"] == before["revision"] + 1


def test_failed_noop_recheck_keeps_current_feedback(client):
    before = work(client); fake_client(client)
    before = check(client, before).json()["draft"]
    fake_client(client, [LLMFailure("Unavailable")])
    assert check(client, before).status_code == 502
    assert client.get(f"/api/drafts/{before['id']}").json() == before


@pytest.mark.parametrize("mutation", ["writing", "delete", "external"])
def test_no_transaction_during_inference_and_late_feedback_rejected(client, mutation):
    before = work(client); blocking = BlockingFake()
    client.app.dependency_overrides[get_llm_client] = lambda: blocking
    with ThreadPoolExecutor(max_workers=1) as executor:
        pending = executor.submit(check, client, before)
        assert blocking.started.wait(timeout=5)
        try:
            current = before["intentions"][-1]
            if mutation == "writing":
                assert client.patch(f"/api/intentions/{current['id']}", json={"expected_revision": current["revision"], "user_notes": "New notes"}).status_code == 200
            elif mutation == "delete":
                assert client.delete(f"/api/intentions/{current['id']}", params={"expected_revision": current["revision"], "expected_draft_revision": before["revision"]}).status_code == 204
            else:
                with Session(client.app.state.engine) as session:
                    record = session.get(Intention, current["id"]); record.user_notes = "External mutation"
                    session.add(record); session.commit()
        finally: blocking.release.set()
        assert pending.result(timeout=5).status_code == (404 if mutation == "delete" else 409)


def test_overlapping_checks_only_persist_one_result(client):
    before = work(client); barrier = Barrier(2)
    class Concurrent(FakeLLMClient):
        async def generate(self, request):
            await to_thread.run_sync(lambda: barrier.wait(timeout=5))
            return await super().generate(request)
    client.app.dependency_overrides[get_llm_client] = lambda: Concurrent()
    with ThreadPoolExecutor(max_workers=2) as executor:
        responses = list(executor.map(lambda _: check(client, before), range(2)))
    assert sorted(r.status_code for r in responses) == [200, 409]
    accepted = next(r.json() for r in responses if r.status_code == 200)
    assert client.get(f"/api/drafts/{before['id']}").json() == accepted["draft"]


@pytest.mark.parametrize("corruption", ["context", "fingerprint", "schema", "legacy"])
def test_reads_hide_unverifiable_feedback_without_mutating_storage(client, corruption):
    before = work(client); fake_client(client)
    saved = check(client, before).json()["draft"]
    with Session(client.app.state.engine) as session:
        item = session.get(Intention, saved["intentions"][-1]["id"])
        if corruption == "context": item.user_notes = "Untracked external change"
        elif corruption == "fingerprint": item.last_check_fingerprint = "0" * 64
        elif corruption == "schema": item.last_check_json = {"result": {"summary": "Invalid"}, "mode": "fake"}
        else: item.last_check_json = deepcopy(OUTPUT)
        raw = deepcopy(item.last_check_json)
        session.add(item); session.commit()
    view = client.get(f"/api/drafts/{before['id']}").json()["intentions"][-1]
    assert view["status"] == "written" and view["last_check_json"] is view["last_check_fingerprint"] is None
    with Session(client.app.state.engine) as session:
        record = session.get(Intention, view["id"])
        assert record.last_check_json == raw and record.status == "checked"


def test_feedback_transaction_rolls_back_on_failure(client, monkeypatch):
    before = work(client); fake_client(client)
    def fail(*_): raise RuntimeError("Injected failure")
    monkeypatch.setattr(context, "touch_draft", fail)
    assert check(client, before).status_code == 500
    assert client.get(f"/api/drafts/{before['id']}").json() == before


def test_check_feedback_persists_across_application_restart(client):
    before = work(client); fake_client(client)
    saved = check(client, before).json()["draft"]
    with TestClient(create_app(client.app.state.engine)) as restarted:
        assert restarted.get(f"/api/drafts/{before['id']}").json() == saved


@pytest.mark.parametrize("sentence,verdict", [("Updates can address known problems.", "yes"), ("Updates always guarantee safety.", "partly")])
def test_fake_demo_contract_not_semantic_quality(client, sentence, verdict):
    before = work(client); fake_client(client)
    response = check(client, before, sentence=sentence)
    assert response.status_code == 200
    assert response.json()["result"]["fulfils_intention"] == verdict
    assert "Demo" in response.json()["result"]["summary"]
    assert response.json()["intention"]["status"] == "checked"
