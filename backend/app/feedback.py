"""Stored provenance and safe public views; reads never mutate SQLite."""
from typing import Literal

from pydantic import BaseModel, ConfigDict, ValidationError
from sqlmodel import Session

from app.llm.schemas import CheckOutput
from app.llm.service import context_fingerprint
from app.models import Draft, Intention
from app.schemas import IntentionResponse
from app.writing_context import compact_context


class StoredCheck(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    result: CheckOutput
    mode: Literal["fake", "live"]


def intention_response(session: Session, draft: Draft, intention: Intention) -> IntentionResponse:
    data = intention.model_dump()
    record = None
    if intention.sentence_text and intention.sentence_text.strip() and intention.last_check_json:
        try:
            candidate = StoredCheck.model_validate(intention.last_check_json)
            fingerprint = context_fingerprint("check_sentence", compact_context(session, draft, intention, None))
            if fingerprint == intention.last_check_fingerprint:
                record = candidate
        except (ValidationError, ValueError, UnicodeError):
            pass  # Legacy/malformed/stale feedback is not current advice.
    data.update(status="checked" if record else "written" if intention.sentence_text and intention.sentence_text.strip() else "pending",
                last_check_json=record.model_dump() if record else None,
                last_check_fingerprint=intention.last_check_fingerprint if record else None)
    return IntentionResponse.model_validate(data)
