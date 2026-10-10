from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Response
from pydantic import ValidationError
from sqlmodel import Session, select

from app.crud import (
    assign_positions, draft_response, draft_summary, invalidate_checks,
    ordered_intentions, require_draft, require_revision, touch_draft, intention_response,
)
from app.db import get_session, get_write_session
from app.models import Draft, Intention
from app.schemas import (
    DraftCreate, DraftDeleteQuery, DraftPatch, DraftResponse, DraftSummary,
    IntentionCreate, IntentionOrder, IntentionResponse, MAX_DB_INTEGER,
)

router = APIRouter(prefix="/api/drafts", tags=["drafts"])
ReadSession = Annotated[Session, Depends(get_session, scope="function")]
WriteSession = Annotated[Session, Depends(get_write_session, scope="function")]
DraftID = Annotated[int, Path(ge=1, le=MAX_DB_INTEGER)]


@router.post("", response_model=DraftSummary, status_code=201)
def create_draft(body: DraftCreate, session: WriteSession) -> DraftSummary:
    draft = Draft(**body.model_dump())
    session.add(draft)
    session.flush()
    return draft_summary(session, draft)


@router.get("", response_model=list[DraftSummary])
def list_drafts(session: ReadSession) -> list[DraftSummary]:
    drafts = session.exec(select(Draft).order_by(Draft.updated_at.desc(), Draft.id.desc())).all()
    return [draft_summary(session, draft) for draft in drafts]


@router.get("/{draft_id}", response_model=DraftResponse)
def get_draft(draft_id: DraftID, session: ReadSession) -> DraftResponse:
    return draft_response(session, require_draft(session, draft_id))


@router.patch("/{draft_id}", response_model=DraftSummary)
def update_draft(draft_id: DraftID, body: DraftPatch, session: WriteSession) -> DraftSummary:
    draft = require_draft(session, draft_id)
    require_revision(draft.revision, body.expected_revision)
    submitted = body.model_dump(exclude_unset=True, exclude={"expected_revision"})
    existing = {field: getattr(draft, field) for field in DraftCreate.model_fields}
    try:
        normalized = DraftCreate.model_validate({**existing, **submitted}).model_dump()
    except ValidationError as error:
        # Validate the merged range, without returning writing or Pydantic input.
        raise HTTPException(422, "Provide both word bounds (1–500) with minimum <= maximum, or clear both.") from error
    changes = {field: value for field, value in normalized.items() if value != existing[field]}
    if changes:
        for field, value in changes.items():
            setattr(draft, field, value)
        if set(changes) - {"title"}:
            invalidate_checks(session, draft_id)
        touch_draft(session, draft)
        session.flush()
    return draft_summary(session, draft)


@router.delete("/{draft_id}", status_code=204)
def delete_draft(draft_id: DraftID, query: Annotated[DraftDeleteQuery, Query()], session: WriteSession) -> Response:
    draft = require_draft(session, draft_id)
    require_revision(draft.revision, query.expected_revision)
    session.delete(draft)
    session.flush()
    return Response(status_code=204)


@router.post("/{draft_id}/intentions", response_model=IntentionResponse, status_code=201)
def add_intention(draft_id: DraftID, body: IntentionCreate, session: WriteSession) -> IntentionResponse:
    draft = require_draft(session, draft_id)
    require_revision(draft.revision, body.expected_draft_revision)
    intentions = ordered_intentions(session, draft_id)
    if len(intentions) >= 8:
        raise HTTPException(409, "A draft supports at most eight intentions.")
    intention = Intention(
        draft_id=draft_id, position=len(intentions),
        **body.model_dump(exclude={"expected_draft_revision"}),
    )
    session.add(intention)
    invalidate_checks(session, draft_id)
    touch_draft(session, draft)
    session.flush()
    return intention_response(session, draft, intention)


@router.put("/{draft_id}/intentions/order", response_model=DraftResponse)
def reorder_intentions(draft_id: DraftID, body: IntentionOrder, session: WriteSession) -> DraftResponse:
    draft = require_draft(session, draft_id)
    require_revision(draft.revision, body.expected_revision)
    intentions = ordered_intentions(session, draft_id)
    by_id = {item.id: item for item in intentions}
    if len(body.ordered_ids) != len(by_id) or set(body.ordered_ids) != set(by_id):
        raise HTTPException(422, "Provide every intention ID in this draft exactly once.")
    if body.ordered_ids != [item.id for item in intentions]:
        assign_positions(session, [by_id[item_id] for item_id in body.ordered_ids])
        invalidate_checks(session, draft_id)
        touch_draft(session, draft)
        session.flush()
    return draft_response(session, draft)
