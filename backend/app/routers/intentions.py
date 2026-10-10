from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query, Response
from sqlmodel import Session

from app.crud import (
    assign_positions, invalidate_checks, ordered_intentions,
    require_draft, require_intention, require_revision, touch_draft, intention_response,
)
from app.db import get_write_session
from app.schemas import IntentionDeleteQuery, IntentionPatch, IntentionResponse, MAX_DB_INTEGER

router = APIRouter(prefix="/api/intentions", tags=["intentions"])
WriteSession = Annotated[Session, Depends(get_write_session, scope="function")]
IntentionID = Annotated[int, Path(ge=1, le=MAX_DB_INTEGER)]


@router.patch("/{intention_id}", response_model=IntentionResponse)
def update_intention(intention_id: IntentionID, body: IntentionPatch, session: WriteSession) -> IntentionResponse:
    intention = require_intention(session, intention_id)
    require_revision(intention.revision, body.expected_revision)
    draft = require_draft(session, intention.draft_id)
    submitted = body.model_dump(exclude_unset=True, exclude={"expected_revision"})
    changes = {field: value for field, value in submitted.items() if getattr(intention, field) != value}
    if changes:
        for field, value in changes.items():
            setattr(intention, field, value)
        intention.revision += 1
        session.add(intention)
        metadata_changed = bool(set(changes) - {"sentence_text", "user_notes"})
        invalidate_checks(session, draft.id, 0 if metadata_changed else intention.position)
        touch_draft(session, draft)
        session.flush()
    return intention_response(session, draft, intention)


@router.delete("/{intention_id}", status_code=204)
def delete_intention(
    intention_id: IntentionID, query: Annotated[IntentionDeleteQuery, Query()], session: WriteSession,
) -> Response:
    intention = require_intention(session, intention_id)
    draft = require_draft(session, intention.draft_id)
    require_revision(intention.revision, query.expected_revision)
    require_revision(draft.revision, query.expected_draft_revision)
    session.delete(intention)
    session.flush()
    assign_positions(session, ordered_intentions(session, draft.id))
    invalidate_checks(session, draft.id)
    touch_draft(session, draft)
    session.flush()
    return Response(status_code=204)
