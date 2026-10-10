from concurrent.futures import ThreadPoolExecutor
from threading import Barrier, Event

import pytest
from sqlmodel import Session, text

from app.models import Intention
from app.routers import drafts as draft_routes
from conftest import add_intention, create_draft, seed_checks


def checked_draft(client):
    draft = create_draft(client)
    intentions = [add_intention(client, draft["id"], f"Purpose {index}") for index in range(3)]
    with Session(client.app.state.engine) as session:
        for record in intentions:
            item = session.get(Intention, record["id"])
            item.sentence_text = f"Sentence {item.position}."
            session.add(item)
        session.flush()
        seed_checks(session, draft["id"])
    result = client.get(f"/api/drafts/{draft['id']}").json()
    assert all(item["status"] == "checked" for item in result["intentions"])
    return result


def assert_unchecked(items):
    for item in items:
        assert item["status"] == ("written" if item["sentence_text"] else "pending")
        assert item["last_check_json"] is None
        assert item["last_check_fingerprint"] is None


@pytest.mark.parametrize("changes", [{"sentence_text": "Changed claim."}, {"user_notes": "New grounding"}])
def test_sentence_or_notes_edit_invalidates_current_and_downstream_only(client, changes):
    before = checked_draft(client)
    current = before["intentions"][1]
    response = client.patch(f"/api/intentions/{current['id']}", json={"expected_revision": 1, **changes})
    assert response.status_code == 200
    after = client.get(f"/api/drafts/{before['id']}").json()
    assert after["intentions"][0] == before["intentions"][0]
    assert_unchecked(after["intentions"][1:])
    assert after["revision"] == before["revision"] + 1
    assert [item["revision"] for item in after["intentions"]] == [1, 2, 1]


@pytest.mark.parametrize("value", [None, "", "  \n\t "])
def test_clearing_checked_sentence_returns_pending(client, value):
    before = checked_draft(client)
    current = before["intentions"][1]
    response = client.patch(f"/api/intentions/{current['id']}", json={"expected_revision": 1, "sentence_text": value})
    assert response.status_code == 200
    assert response.json()["sentence_text"] is None
    assert response.json()["status"] == "pending"
    assert response.json()["last_check_json"] is None
    assert response.json()["last_check_fingerprint"] is None


def test_noop_saves_and_reorder_preserve_checks_revisions_and_timestamps(client):
    before = checked_draft(client)
    current = before["intentions"][1]
    response = client.patch(f"/api/intentions/{current['id']}", json={
        "expected_revision": 1, "sentence_text": current["sentence_text"], "user_notes": " \n ",
    })
    assert response.status_code == 200 and response.json() == current
    response = client.patch(f"/api/drafts/{before['id']}", json={
        "expected_revision": before["revision"], "title": f"  {before['title']}  ",
    })
    assert response.status_code == 200
    response = client.put(f"/api/drafts/{before['id']}/intentions/order", json={
        "expected_revision": before["revision"], "ordered_ids": [item["id"] for item in before["intentions"]],
    })
    assert response.status_code == 200 and response.json() == before
    assert client.get(f"/api/drafts/{before['id']}").json() == before


def test_title_only_edit_preserves_checks_but_moves_draft_revision(client):
    before = checked_draft(client)
    response = client.patch(f"/api/drafts/{before['id']}", json={"expected_revision": before["revision"], "title": "New title"})
    assert response.status_code == 200
    after = client.get(f"/api/drafts/{before['id']}").json()
    assert after["revision"] == before["revision"] + 1
    assert after["intentions"] == before["intentions"]


@pytest.mark.parametrize("changes", [
    {"topic": "New topic"}, {"task_description": "New audience"},
    {"target_sentence_count": 6}, {"target_word_min": 120, "target_word_max": 180},
])
def test_draft_context_edit_invalidates_all_checks(client, changes):
    before = checked_draft(client)
    response = client.patch(f"/api/drafts/{before['id']}", json={"expected_revision": before["revision"], **changes})
    assert response.status_code == 200
    after = client.get(f"/api/drafts/{before['id']}").json()
    assert_unchecked(after["intentions"])
    assert [item["revision"] for item in after["intentions"]] == [1, 1, 1]


def test_later_intention_metadata_edit_invalidates_all_checks(client):
    before = checked_draft(client)
    last = before["intentions"][-1]
    response = client.patch(f"/api/intentions/{last['id']}", json={"expected_revision": 1, "guiding_question": "What else matters?"})
    assert response.status_code == 200
    after = client.get(f"/api/drafts/{before['id']}").json()
    assert_unchecked(after["intentions"])
    assert [item["revision"] for item in after["intentions"]] == [1, 1, 2]


def test_add_or_delete_intention_invalidates_all_remaining_checks(client):
    before = checked_draft(client)
    added = add_intention(client, before["id"], "Conclude")
    after_add = client.get(f"/api/drafts/{before['id']}").json()
    assert_unchecked(after_add["intentions"])
    assert added["status"] == "pending"
    before = checked_draft(client)
    last = before["intentions"][-1]
    response = client.delete(f"/api/intentions/{last['id']}?expected_revision=1&expected_draft_revision={before['revision']}")
    assert response.status_code == 204
    after_delete = client.get(f"/api/drafts/{before['id']}").json()
    assert_unchecked(after_delete["intentions"])


def test_reorder_swaps_unique_positions_preserves_text_and_invalidates_checks(client):
    before = checked_draft(client)
    ids = [item["id"] for item in before["intentions"]]
    response = client.put(f"/api/drafts/{before['id']}/intentions/order", json={
        "expected_revision": before["revision"], "ordered_ids": [ids[2], ids[0], ids[1]],
    })
    assert response.status_code == 200
    after = response.json()
    assert [item["id"] for item in after["intentions"]] == [ids[2], ids[0], ids[1]]
    assert [item["position"] for item in after["intentions"]] == [0, 1, 2]
    assert [item["sentence_text"] for item in after["intentions"]] == ["Sentence 2.", "Sentence 0.", "Sentence 1."]
    assert [item["revision"] for item in after["intentions"]] == [1, 1, 1]
    assert after["revision"] == before["revision"] + 1
    assert_unchecked(after["intentions"])
    assert client.get(f"/api/drafts/{before['id']}").json() == after


def test_invalid_reorder_is_atomic_and_empty_draft_order_is_noop(client):
    before = checked_draft(client)
    ids = [item["id"] for item in before["intentions"]]
    other = create_draft(client)
    foreign = add_intention(client, other["id"])["id"]
    for invalid in ([ids[0], ids[0], ids[2]], ids[:2], [ids[0], ids[1], foreign], ids + [999], [True, ids[1], ids[2]]):
        response = client.put(f"/api/drafts/{before['id']}/intentions/order", json={
            "expected_revision": before["revision"], "ordered_ids": invalid,
        })
        assert response.status_code == 422
        assert client.get(f"/api/drafts/{before['id']}").json() == before
    stale = client.put(f"/api/drafts/{before['id']}/intentions/order", json={"expected_revision": 1, "ordered_ids": ids[::-1]})
    assert stale.status_code == 409
    empty = create_draft(client)
    response = client.put(f"/api/drafts/{empty['id']}/intentions/order", json={"expected_revision": 1, "ordered_ids": []})
    assert response.status_code == 200
    assert response.json()["revision"] == 1 and response.json()["intentions"] == []


def test_failure_after_position_updates_rolls_back_every_change(client, monkeypatch):
    before = checked_draft(client)
    def fail_touch(*_args):
        raise RuntimeError("Injected failure after reorder")
    monkeypatch.setattr(draft_routes, "touch_draft", fail_touch)
    response = client.put(f"/api/drafts/{before['id']}/intentions/order", json={
        "expected_revision": before["revision"], "ordered_ids": [item["id"] for item in before["intentions"]][::-1],
    })
    assert response.status_code == 500
    assert response.json() == {"detail": "An unexpected error occurred. Retry the request."}
    assert client.get(f"/api/drafts/{before['id']}").json() == before


def test_overlapping_saves_only_accept_one_writer_for_same_revision(client):
    draft = create_draft(client)
    intention = add_intention(client, draft["id"])
    barrier = Barrier(2)
    def save(text):
        barrier.wait(timeout=5)
        return client.patch(f"/api/intentions/{intention['id']}", json={"expected_revision": 1, "sentence_text": text})
    with ThreadPoolExecutor(max_workers=2) as executor:
        responses = list(executor.map(save, ["Writer A", "Writer B"]))
    assert sorted(response.status_code for response in responses) == [200, 409]
    accepted = next(response.json() for response in responses if response.status_code == 200)
    after = client.get(f"/api/drafts/{draft['id']}").json()
    assert after["intentions"][0] == accepted
    assert accepted["revision"] == 2
    assert after["revision"] == 3


def test_overlapping_additions_cannot_exceed_eight_intentions(client):
    draft = create_draft(client)
    for index in range(7):
        add_intention(client, draft["id"], f"Purpose {index}")
    revision = client.get(f"/api/drafts/{draft['id']}").json()["revision"]
    barrier = Barrier(2)
    def add(label):
        barrier.wait(timeout=5)
        return client.post(f"/api/drafts/{draft['id']}/intentions", json={
            "expected_draft_revision": revision, "function_label": label,
            "description": "Conclude", "guiding_question": "What follows?",
        })
    with ThreadPoolExecutor(max_workers=2) as executor:
        responses = list(executor.map(add, ["Addition A", "Addition B"]))
    assert sorted(response.status_code for response in responses) == [201, 409]
    after = client.get(f"/api/drafts/{draft['id']}").json()
    assert after["intention_count"] == 8
    assert [item["position"] for item in after["intentions"]] == list(range(8))


def test_draft_read_has_consistent_revision_and_items_during_concurrent_edit(client, monkeypatch):
    draft = create_draft(client)
    intention = add_intention(client, draft["id"])
    before = client.get(f"/api/drafts/{draft['id']}").json()
    # WAL permits the other writer to commit while the read snapshot stays open.
    with client.app.state.engine.connect() as connection:
        connection.execute(text("PRAGMA journal_mode=WAL"))
    reader_loaded = Event()
    writer_finished = Event()
    original = draft_routes.require_draft
    def pause_read(session, draft_id):
        result = original(session, draft_id)
        reader_loaded.set()
        assert writer_finished.wait(timeout=5)
        return result
    monkeypatch.setattr(draft_routes, "require_draft", pause_read)
    with ThreadPoolExecutor(max_workers=2) as executor:
        reader = executor.submit(client.get, f"/api/drafts/{draft['id']}")
        assert reader_loaded.wait(timeout=5)
        try:
            written = client.patch(f"/api/intentions/{intention['id']}", json={"expected_revision": 1, "sentence_text": "New sentence"})
            assert written.status_code == 200
        finally:
            writer_finished.set()
        response = reader.result(timeout=5)
    assert response.status_code == 200
    assert response.json() == before
    monkeypatch.setattr(draft_routes, "require_draft", original)
    after = client.get(f"/api/drafts/{draft['id']}").json()
    assert after["revision"] == before["revision"] + 1
    assert after["intentions"][0]["sentence_text"] == "New sentence"
