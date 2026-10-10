from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, text
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from app.db import create_db_engine
from app.main import create_app
from app.models import Draft, Intention
from conftest import add_intention, create_draft


def test_draft_crud_settings_utc_and_nested_persistence(client):
    assert client.get("/api/drafts").json() == []
    draft = create_draft(client, title="  My paragraph  ", topic="  Software updates  ",
                         task_description=None, target_sentence_count=6,
                         target_word_min=120, target_word_max=180)
    assert draft["title"] == "My paragraph"
    assert draft["topic"] == "Software updates"
    assert draft["task_description"] == ""
    assert draft["revision"] == 1
    assert draft["intention_count"] == 0
    assert draft["created_at"].endswith("Z") and draft["updated_at"].endswith("Z")
    assert "intentions" not in draft
    assert client.get(f"/api/drafts/{draft['id']}").json()["intentions"] == []

    intention = add_intention(client, draft["id"])
    assert intention["revision"] == 1
    assert intention["position"] == 0
    assert intention["status"] == "pending"
    saved = client.get(f"/api/drafts/{draft['id']}").json()
    assert saved["revision"] == 2
    assert saved["intentions"] == [intention]
    assert saved["target_sentence_count"] == 6
    assert saved["target_word_min"] == 120 and saved["target_word_max"] == 180
    assert saved["updated_at"] != draft["updated_at"]
    assert client.get("/api/drafts").json()[0]["intention_count"] == 1

    updated = client.patch(f"/api/drafts/{draft['id']}", json={
        "expected_revision": 2, "target_word_max": 200, "task_description": "For classmates",
    })
    assert updated.status_code == 200
    assert updated.json()["revision"] == 3
    assert updated.json()["target_word_min"] == 120
    assert updated.json()["target_word_max"] == 200
    stale_delete = client.delete(f"/api/drafts/{draft['id']}?expected_revision=2")
    assert stale_delete.status_code == 409
    deleted = client.delete(f"/api/drafts/{draft['id']}?expected_revision=3")
    assert deleted.status_code == 204 and deleted.content == b""
    assert client.get(f"/api/drafts/{draft['id']}").status_code == 404
    assert client.get("/api/drafts").json() == []
    with Session(client.app.state.engine) as session:
        assert session.exec(select(Intention)).all() == []


def test_draft_list_orders_by_updated_time_then_id(client):
    first, second = create_draft(client), create_draft(client)
    assert [item["id"] for item in client.get("/api/drafts").json()] == [second["id"], first["id"]]
    assert client.patch(f"/api/drafts/{first['id']}", json={"title": "Edited", "expected_revision": 1}).status_code == 200
    assert client.get("/api/drafts").json()[0]["id"] == first["id"]
    with Session(client.app.state.engine) as session:
        stamp = datetime(2026, 1, 1, tzinfo=UTC)
        for draft in session.exec(select(Draft)).all():
            draft.updated_at = stamp
            session.add(draft)
        session.commit()
    assert [item["id"] for item in client.get("/api/drafts").json()] == [second["id"], first["id"]]


@pytest.mark.parametrize("fields", [
    {"title": " "}, {"topic": ""}, {"title": None}, {"title": "a" * 201},
    {"topic": "a" * 2001}, {"task_description": "a" * 4001},
    {"target_sentence_count": 2}, {"target_sentence_count": 9},
    {"target_sentence_count": True}, {"target_sentence_count": "5"},
    {"target_word_min": 120}, {"target_word_min": 180, "target_word_max": 120},
    {"target_word_min": 0, "target_word_max": 100},
    {"target_word_min": 1, "target_word_max": 501}, {"surprise": "ignored?"},
])
def test_invalid_draft_input_returns_clean_422_without_saving(client, fields):
    response = client.post("/api/drafts", json={"title": "Title", "topic": "Topic", **fields})
    assert response.status_code == 422
    assert isinstance(response.json()["detail"], str)
    assert client.get("/api/drafts").json() == []


def test_word_range_patch_validates_merged_settings_and_is_atomic(client):
    draft = create_draft(client, target_word_min=100, target_word_max=200)
    before = client.get(f"/api/drafts/{draft['id']}").json()
    for changes in ({"target_word_max": 50}, {"target_word_min": None}, {"target_word_min": 250, "title": "Must not save"}):
        response = client.patch(f"/api/drafts/{draft['id']}", json={"expected_revision": 1, **changes})
        assert response.status_code == 422
        assert client.get(f"/api/drafts/{draft['id']}").json() == before
    response = client.patch(f"/api/drafts/{draft['id']}", json={
        "expected_revision": 1, "target_word_min": None, "target_word_max": None,
    })
    assert response.status_code == 200
    assert response.json()["target_word_min"] is None
    assert response.json()["target_word_max"] is None


def test_intention_edit_preserves_writing_and_rejects_stale_save(client):
    draft = create_draft(client)
    intention = add_intention(client, draft["id"])
    text = "  Updates reduce risks. They also improve stability.  "
    response = client.patch(f"/api/intentions/{intention['id']}", json={
        "expected_revision": 1, "sentence_text": text, "user_notes": "更新可以减少风险",
    })
    assert response.status_code == 200
    assert response.json()["status"] == "written"
    assert response.json()["sentence_text"] == text
    assert response.json()["user_notes"] == "更新可以减少风险"
    assert response.json()["revision"] == 2
    assert client.get(f"/api/drafts/{draft['id']}").json()["revision"] == 3
    response = client.patch(f"/api/intentions/{intention['id']}", json={
        "expected_revision": 1, "sentence_text": "Stale text",
    })
    assert response.status_code == 409
    saved = client.get(f"/api/drafts/{draft['id']}").json()["intentions"][0]
    assert saved["sentence_text"] == text and saved["revision"] == 2
    response = client.patch(f"/api/intentions/{intention['id']}", json={
        "expected_revision": 2, "function_label": "  Explain benefits  ",
        "description": "  Elaborate the benefits  ", "guiding_question": "  Why update?  ",
    })
    assert response.status_code == 200
    assert response.json()["function_label"] == "Explain benefits"
    assert response.json()["description"] == "Elaborate the benefits"
    assert response.json()["guiding_question"] == "Why update?"
    assert response.json()["sentence_text"] == text


@pytest.mark.parametrize("fields", [
    {}, {"status": "checked"}, {"last_check_json": {"fulfils_intention": "yes"}},
    {"last_check_fingerprint": "f" * 64}, {"function_label": None}, {"description": " "},
    {"sentence_text": "a" * 4001}, {"user_notes": 42}, {"draft_id": 99},
])
def test_invalid_or_server_owned_intention_edits_do_not_mutate(client, fields):
    draft = create_draft(client)
    intention = add_intention(client, draft["id"])
    before = client.get(f"/api/drafts/{draft['id']}").json()
    response = client.patch(f"/api/intentions/{intention['id']}", json={"expected_revision": 1, **fields})
    assert response.status_code == 422
    assert isinstance(response.json()["detail"], str)
    assert client.get(f"/api/drafts/{draft['id']}").json() == before


def test_add_cap_delete_compaction_and_revision_guards(client):
    draft = create_draft(client)
    intentions = [add_intention(client, draft["id"], f"Purpose {index}") for index in range(8)]
    before = client.get(f"/api/drafts/{draft['id']}").json()
    body = {"function_label": "Ninth", "description": "Explain", "guiding_question": "Why?", "expected_draft_revision": before["revision"]}
    assert client.post(f"/api/drafts/{draft['id']}/intentions", json=body).status_code == 409
    assert client.get(f"/api/drafts/{draft['id']}").json() == before
    middle = intentions[3]
    path = f"/api/intentions/{middle['id']}?expected_revision=1&expected_draft_revision={before['revision']}"
    assert client.delete(path.replace("expected_revision=1", "expected_revision=2")).status_code == 409
    assert client.delete(path.replace(f"expected_draft_revision={before['revision']}", "expected_draft_revision=1")).status_code == 409
    response = client.delete(path)
    assert response.status_code == 204 and response.content == b""
    after = client.get(f"/api/drafts/{draft['id']}").json()
    assert after["revision"] == before["revision"] + 1
    assert [item["position"] for item in after["intentions"]] == list(range(7))
    assert [item["id"] for item in after["intentions"]] == [item["id"] for item in intentions if item["id"] != middle["id"]]


def test_database_cascade_and_ids_are_not_reused(client):
    draft = create_draft(client)
    intention = add_intention(client, draft["id"])
    assert client.delete(f"/api/intentions/{intention['id']}?expected_revision=1&expected_draft_revision=2").status_code == 204
    replacement = add_intention(client, draft["id"])
    assert replacement["id"] > intention["id"]
    # Raw DB deletion proves cascade is a database guarantee, not router cleanup.
    with Session(client.app.state.engine) as session:
        session.exec(delete(Draft).where(Draft.id == draft["id"]))
        session.commit()
        assert session.get(Intention, replacement["id"]) is None
    next_draft = create_draft(client)
    assert next_draft["id"] > draft["id"]


def test_database_constraints_reject_invalid_ranges_positions_and_foreign_keys(client):
    draft = create_draft(client)
    intention = add_intention(client, draft["id"])
    with client.app.state.engine.connect() as connection:
        assert connection.execute(text("PRAGMA foreign_keys")).scalar_one() == 1
    with Session(client.app.state.engine) as session:
        invalid_queries = [
            "UPDATE drafts SET target_word_min=200, target_word_max=100",
            "UPDATE intentions SET position=-1",
            "UPDATE intentions SET draft_id=99999",
            "UPDATE intentions SET status='invented'",
        ]
        for query in invalid_queries:
            with pytest.raises(IntegrityError):
                session.exec(text(query))
                session.commit()
            session.rollback()
    assert client.get(f"/api/drafts/{draft['id']}").json()["intentions"] == [intention]


def test_draft_revisions_and_required_patch_inputs(client):
    draft = create_draft(client)
    before = client.get(f"/api/drafts/{draft['id']}").json()
    for body in ({"expected_revision": 1}, {"expected_revision": 1, "title": None},
                 {"title": "New"}, {"expected_revision": True, "title": "New"},
                 {"expected_revision": 1, "status": "checked"}):
        assert client.patch(f"/api/drafts/{draft['id']}", json=body).status_code == 422
    assert client.patch(f"/api/drafts/{draft['id']}", json={"expected_revision": 2, "title": "New"}).status_code == 409
    assert client.delete(f"/api/drafts/{draft['id']}").status_code == 422
    assert client.get(f"/api/drafts/{draft['id']}").json() == before


def test_out_of_range_ids_and_unknown_delete_parameters_return_422(client):
    draft = create_draft(client)
    intention = add_intention(client, draft["id"])
    before = client.get(f"/api/drafts/{draft['id']}").json()
    for invalid_id in (0, -1, 2**63):
        response = client.get(f"/api/drafts/{invalid_id}")
        assert response.status_code == 422 and isinstance(response.json()["detail"], str)
        assert client.patch(f"/api/intentions/{invalid_id}", json={"expected_revision": 1, "sentence_text": "Text"}).status_code == 422
    assert client.delete(f"/api/drafts/{draft['id']}?expected_revision=2&surprise=true").status_code == 422
    assert client.delete(f"/api/intentions/{intention['id']}?expected_revision=1&expected_draft_revision=2&status=checked").status_code == 422
    assert client.get(f"/api/drafts/{draft['id']}").json() == before


@pytest.mark.parametrize("method,path,kwargs", [
    ("get", "/api/drafts/999", {}),
    ("patch", "/api/drafts/999", {"json": {"expected_revision": 1, "title": "New"}}),
    ("delete", "/api/drafts/999?expected_revision=1", {}),
    ("post", "/api/drafts/999/intentions", {"json": {"expected_draft_revision": 1, "function_label": "Claim", "description": "Explain", "guiding_question": "Why?"}}),
    ("put", "/api/drafts/999/intentions/order", {"json": {"expected_revision": 1, "ordered_ids": []}}),
    ("patch", "/api/intentions/999", {"json": {"expected_revision": 1, "sentence_text": "Text"}}),
    ("delete", "/api/intentions/999?expected_revision=1&expected_draft_revision=1", {}),
])
def test_missing_resources_return_clean_404(client, method, path, kwargs):
    response = getattr(client, method)(path, **kwargs)
    assert response.status_code == 404
    assert isinstance(response.json()["detail"], str)


def test_sqlite_data_survives_application_restart(tmp_path, monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "")
    database_path = tmp_path / "persistent.db"
    with TestClient(create_app(create_db_engine(database_path))) as first_client:
        draft = create_draft(first_client, target_sentence_count=4, target_word_min=80, target_word_max=120)
        intention = add_intention(first_client, draft["id"])
        assert first_client.patch(f"/api/intentions/{intention['id']}", json={
            "expected_revision": 1, "sentence_text": "Updates reduce risks.", "user_notes": "Keep the claim modest.",
        }).status_code == 200
        before = first_client.get(f"/api/drafts/{draft['id']}").json()
    with TestClient(create_app(create_db_engine(database_path))) as restarted_client:
        assert restarted_client.get(f"/api/drafts/{draft['id']}").json() == before
        assert restarted_client.get("/api/drafts").json()[0]["intention_count"] == 1
