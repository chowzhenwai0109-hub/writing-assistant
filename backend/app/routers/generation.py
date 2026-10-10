"""Plan first, then replace atomically if the draft snapshot is still current."""

from typing import Annotated

from anyio import to_thread
from fastapi import APIRouter, Depends, HTTPException, Path, Request
from sqlalchemy import Engine, delete

from app.crud import draft_response, ordered_intentions, require_draft, require_revision, touch_draft
from app.db import read_session, write_session
from app.llm.client import LLMClient, get_llm_client
from app.llm.schemas import IntentionSequence
from app.llm.service import MAX_CONTEXT_BYTES, canonical_json, context_fingerprint, generate_intentions
from app.models import Draft, Intention
from app.schemas import GenerateIntentionsRequest, GenerationResponse, MAX_DB_INTEGER

router = APIRouter(prefix="/api/drafts", tags=["generation"])
DraftID = Annotated[int, Path(ge=1, le=MAX_DB_INTEGER)]


def generation_context(draft: Draft) -> dict:
    return {field: getattr(draft, field) for field in (
        "topic", "task_description", "target_sentence_count", "target_word_min", "target_word_max",
    )}


def snapshot_draft(engine: Engine, draft_id: int, body: GenerateIntentionsRequest) -> tuple[dict, str]:
    with read_session(engine) as session:
        draft = require_draft(session, draft_id)
        require_revision(draft.revision, body.expected_revision)
        if ordered_intentions(session, draft_id) and not body.confirm_replace:
            raise HTTPException(409, "Replacing this sequence deletes its intentions, notes and sentences. Confirm replacement first.")
        context = generation_context(draft)
        if len(canonical_json(context).encode("utf-8")) > MAX_CONTEXT_BYTES:
            raise HTTPException(422, "Writing context is too large. Shorten the topic or task description.")
        return context, context_fingerprint("generate_intentions", context)


def replace_sequence(
    engine: Engine, draft_id: int, expected_revision: int, fingerprint: str,
    result: IntentionSequence, mode: str,
) -> GenerationResponse:
    with write_session(engine) as session:
        draft = require_draft(session, draft_id)
        require_revision(draft.revision, expected_revision)
        if context_fingerprint("generate_intentions", generation_context(draft)) != fingerprint:
            raise HTTPException(409, "Draft context changed while generating. Please retry.")
        session.exec(delete(Intention).where(Intention.draft_id == draft_id))
        for position, item in enumerate(result.intentions):
            session.add(Intention(draft_id=draft_id, position=position, **item.model_dump()))
        draft.last_generation_mode = mode
        touch_draft(session, draft)
        session.flush()
        return GenerationResponse.model_validate({**draft_response(session, draft).model_dump(), "mode": mode})


@router.post("/{draft_id}/intentions/generate", response_model=GenerationResponse)
async def generate_sequence(
    draft_id: DraftID, body: GenerateIntentionsRequest, request: Request,
    client: Annotated[LLMClient, Depends(get_llm_client)],
) -> GenerationResponse:
    engine = request.app.state.engine
    context, fingerprint = await to_thread.run_sync(snapshot_draft, engine, draft_id, body)
    # Both sessions are closed while awaiting model output. No mutation yet.
    result = await generate_intentions(client, context)
    return await to_thread.run_sync(replace_sequence, engine, draft_id, body.expected_revision, fingerprint, result, client.mode)
