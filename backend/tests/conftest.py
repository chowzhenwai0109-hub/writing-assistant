import pytest
from fastapi.testclient import TestClient

from app.db import create_db_engine
from app.main import create_app


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "")
    monkeypatch.setenv("LLM_MODE", "fake")
    engine = create_db_engine(tmp_path / "app.db")
    with TestClient(create_app(engine), raise_server_exceptions=False) as test_client:
        yield test_client


def create_draft(client, **overrides):
    response = client.post("/api/drafts", json={
        "title": "My paragraph", "topic": "Software updates", **overrides,
    })
    assert response.status_code == 201, response.text
    return response.json()


def add_intention(client, draft_id, label="Introduce central claim"):
    draft = client.get(f"/api/drafts/{draft_id}").json()
    response = client.post(f"/api/drafts/{draft_id}/intentions", json={
        "function_label": label,
        "description": "Explain how updates reduce risks.",
        "guiding_question": "What does the reader need to understand?",
        "expected_draft_revision": draft["revision"],
    })
    assert response.status_code == 201, response.text
    return response.json()


def seed_checks(session, draft_id):
    """Current feedback fixture, without changing the revisions under test."""
    from app.crud import ordered_intentions, require_draft
    from app.llm.service import context_fingerprint
    from app.writing_context import compact_context
    draft = require_draft(session, draft_id)
    for item in ordered_intentions(session, draft_id):
        if not item.sentence_text:
            continue
        item.status = "checked"
        item.last_check_json = {"result": {"fulfils_intention": "yes", "summary": "Fixture review", "issues": []}, "mode": "fake"}
        item.last_check_fingerprint = context_fingerprint("check_sentence", compact_context(session, draft, item, None))
        session.add(item)
    session.commit()
