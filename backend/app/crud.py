"""Shared Stage 1 mutations and status rules, independent of the LLM."""

from fastapi import HTTPException
from sqlmodel import Session, select

from app.models import Draft, Intention, utc_now
from app.schemas import DraftResponse, DraftSummary
from app.feedback import intention_response


def require_draft(session: Session, draft_id: int) -> Draft:
    draft = session.get(Draft, draft_id)
    if draft is None:
        raise HTTPException(404, "Draft not found.")
    return draft


def require_intention(session: Session, intention_id: int) -> Intention:
    intention = session.get(Intention, intention_id)
    if intention is None:
        raise HTTPException(404, "Intention not found.")
    return intention


def require_revision(actual: int, expected: int) -> None:
    if actual != expected:
        raise HTTPException(409, "This item has changed. Reload its saved version before retrying.")


def ordered_intentions(session: Session, draft_id: int) -> list[Intention]:
    return list(session.exec(
        select(Intention).where(Intention.draft_id == draft_id).order_by(Intention.position)
    ).all())


def touch_draft(session: Session, draft: Draft) -> None:
    draft.revision += 1
    draft.updated_at = utc_now()
    session.add(draft)


def invalidate_checks(session: Session, draft_id: int, from_position: int = 0) -> None:
    for intention in ordered_intentions(session, draft_id):
        if intention.position >= from_position:
            intention.last_check_json = None
            intention.last_check_fingerprint = None
            intention.status = "written" if intention.sentence_text and intention.sentence_text.strip() else "pending"
            session.add(intention)


def assign_positions(session: Session, intentions: list[Intention]) -> None:
    if not intentions:
        return
    offset = max(item.position for item in intentions) + len(intentions) + 1
    for item in intentions:
        item.position += offset
        session.add(item)
    session.flush()
    for position, item in enumerate(intentions):
        item.position = position
        session.add(item)
    session.flush()


def draft_summary(session: Session, draft: Draft) -> DraftSummary:
    return DraftSummary.model_validate({
        **draft.model_dump(), "intention_count": len(ordered_intentions(session, draft.id)),
    })


def draft_response(session: Session, draft: Draft) -> DraftResponse:
    intentions = ordered_intentions(session, draft.id)
    return DraftResponse.model_validate({
        **draft.model_dump(),
        "intention_count": len(intentions),
        "intentions": [intention_response(session, draft, item) for item in intentions],
    })
