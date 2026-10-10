from typing import Annotated

from anyio import to_thread
from fastapi import APIRouter, Depends, Path, Request

from app.assistance_schemas import HintsRequest, HintsResponse
from app.llm.client import LLMClient, get_llm_client
from app.llm.context import snapshot_hints, verify_hints
from app.llm.service import get_hints
from app.schemas import MAX_DB_INTEGER

router = APIRouter(prefix="/api/intentions", tags=["hints"])


@router.post("/{intention_id}/hints", response_model=HintsResponse)
async def hints(
    intention_id: Annotated[int, Path(ge=1, le=MAX_DB_INTEGER)], body: HintsRequest,
    request: Request, client: Annotated[LLMClient, Depends(get_llm_client)],
) -> HintsResponse:
    engine = request.app.state.engine
    snapshot = await to_thread.run_sync(snapshot_hints, engine, intention_id, body.expected_revision, body.expected_draft_revision, body.help_level)
    result = await get_hints(client, snapshot.context)
    await to_thread.run_sync(verify_hints, engine, intention_id, snapshot)
    return HintsResponse(result=result, context_fingerprint=snapshot.fingerprint, intention_revision=snapshot.intention_revision, draft_revision=snapshot.draft_revision, mode=client.mode)
