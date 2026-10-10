"""Atomic writing saves, assistance snapshots and guarded feedback persistence."""

from dataclasses import dataclass

from fastapi import HTTPException
from sqlalchemy import Engine
from app.crud import draft_response, invalidate_checks, require_draft, require_intention, require_revision, touch_draft
from app.db import read_session, write_session
from app.llm.service import MAX_CONTEXT_BYTES, canonical_json, context_fingerprint
from app.models import Draft, Intention
from app.assistance_schemas import CheckRequest, CheckResponse, PlanRequest
from app.schemas import IntentionResponse
from app.writing_context import compact_context
from app.feedback import StoredCheck, intention_response
from app.llm.schemas import CheckOutput


@dataclass(frozen=True)
class AssistanceSnapshot:
    context: dict
    fingerprint: str
    intention_revision: int
    draft_revision: int


def bounded_snapshot(task: str, context: dict, current: Intention, draft: Draft) -> AssistanceSnapshot:
    if len(canonical_json(context).encode("utf-8")) > MAX_CONTEXT_BYTES:
        raise HTTPException(422, "Writing context is too large. Shorten the topic, task description, notes or earlier writing.")
    return AssistanceSnapshot(context, context_fingerprint(task, context), current.revision, draft.revision)


def snapshot_hints(engine: Engine, intention_id: int, expected_revision: int, expected_draft_revision: int, help_level: str, task: str = "get_hints") -> AssistanceSnapshot:
    with read_session(engine) as session:
        current = require_intention(session, intention_id)
        draft = require_draft(session, current.draft_id)
        require_revision(current.revision, expected_revision)
        require_revision(draft.revision, expected_draft_revision)
        context = compact_context(session, draft, current, help_level)
        return bounded_snapshot(task, context, current, draft)


def verify_hints(engine: Engine, intention_id: int, original: AssistanceSnapshot, task: str = "get_hints") -> None:
    current = snapshot_hints(engine, intention_id, original.intention_revision, original.draft_revision, original.context["help_level"], task)
    if current.fingerprint != original.fingerprint:
        raise HTTPException(409, "Writing context changed while getting guidance. Please retry.")


def prepare_plan(engine: Engine, intention_id: int, body: PlanRequest) -> tuple[AssistanceSnapshot, IntentionResponse]:
    # Save notes and capture the post-save context in the same short transaction.
    # Reject an excessive candidate BEFORE touching revisions/notes/checks.
    with write_session(engine) as session:
        current = require_intention(session, intention_id)
        draft = require_draft(session, current.draft_id)
        require_revision(current.revision, body.expected_revision)
        require_revision(draft.revision, body.expected_draft_revision)
        context = compact_context(session, draft, current, body.help_level)
        context["user_notes"] = body.user_notes
        bounded_snapshot("make_plan", context, current, draft)
        if current.user_notes != body.user_notes:
            current.user_notes = body.user_notes
            current.revision += 1
            session.add(current)
            invalidate_checks(session, draft.id, current.position)
            touch_draft(session, draft)
            session.flush()
        snapshot = bounded_snapshot("make_plan", context, current, draft)
        intention = intention_response(session, draft, current)
    return snapshot, intention


def prepare_check(engine: Engine, intention_id: int, body: CheckRequest) -> AssistanceSnapshot:
    with write_session(engine) as session:
        current = require_intention(session, intention_id)
        draft = require_draft(session, current.draft_id)
        require_revision(current.revision, body.expected_revision)
        require_revision(draft.revision, body.expected_draft_revision)
        context = compact_context(session, draft, current, None)
        context["current_sentence"] = body.sentence
        bounded_snapshot("check_sentence", context, current, draft)
        if current.sentence_text != body.sentence:
            current.sentence_text = body.sentence
            current.revision += 1
            session.add(current)
            invalidate_checks(session, draft.id, current.position)
            touch_draft(session, draft)
            session.flush()
        snapshot = bounded_snapshot("check_sentence", context, current, draft)
    return snapshot


def persist_check(engine: Engine, intention_id: int, original: AssistanceSnapshot, result: CheckOutput, mode: str) -> CheckResponse:
    # Final compare + persistence is one transaction. Feedback revisions order
    # overlapping checks while leaving other current check contexts unchanged.
    with write_session(engine) as session:
        current = require_intention(session, intention_id)
        draft = require_draft(session, current.draft_id)
        require_revision(current.revision, original.intention_revision)
        require_revision(draft.revision, original.draft_revision)
        fingerprint = context_fingerprint("check_sentence", compact_context(session, draft, current, None))
        if fingerprint != original.fingerprint:
            raise HTTPException(409, "Writing context changed while checking. Please retry.")
        current.last_check_json = StoredCheck(result=result, mode=mode).model_dump()
        current.last_check_fingerprint = fingerprint
        current.status = "checked"
        current.revision += 1
        session.add(current)
        touch_draft(session, draft)
        session.flush()
        saved = intention_response(session, draft, current)
        response = CheckResponse(result=result, context_fingerprint=fingerprint,
                                 intention_revision=current.revision, draft_revision=draft.revision,
                                 mode=mode, intention=saved, draft=draft_response(session, draft))
    return response
