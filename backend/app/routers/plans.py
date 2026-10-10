from typing import Annotated

from anyio import to_thread
from fastapi import APIRouter, Depends, Path, Request

from app.assistance_schemas import PlanRequest, PlanResponse
from app.llm.client import LLMClient, get_llm_client
from app.llm.context import prepare_plan, verify_hints
from app.llm.service import make_plan
from app.schemas import MAX_DB_INTEGER

router = APIRouter(prefix="/api/intentions", tags=["plans"])


@router.post("/{intention_id}/plan", response_model=PlanResponse)
async def plan(intention_id: Annotated[int, Path(ge=1, le=MAX_DB_INTEGER)], body: PlanRequest,
               request: Request, client: Annotated[LLMClient, Depends(get_llm_client)]) -> PlanResponse:
    engine = request.app.state.engine
    snapshot, intention = await to_thread.run_sync(prepare_plan, engine, intention_id, body)
    result = await make_plan(client, snapshot.context)
    await to_thread.run_sync(verify_hints, engine, intention_id, snapshot, "make_plan")
    return PlanResponse(result=result, context_fingerprint=snapshot.fingerprint,
                        intention_revision=snapshot.intention_revision, draft_revision=snapshot.draft_revision,
                        mode=client.mode, intention=intention)
