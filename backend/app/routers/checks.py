from typing import Annotated

from anyio import to_thread
from fastapi import APIRouter, Depends, Path, Request

from app.assistance_schemas import CheckRequest, CheckResponse
from app.llm.client import LLMClient, get_llm_client
from app.llm.context import persist_check, prepare_check
from app.llm.service import check_sentence
from app.schemas import MAX_DB_INTEGER

router = APIRouter(prefix="/api/intentions", tags=["checks"])


@router.post("/{intention_id}/check", response_model=CheckResponse)
async def check(intention_id: Annotated[int, Path(ge=1, le=MAX_DB_INTEGER)], body: CheckRequest,
                request: Request, client: Annotated[LLMClient, Depends(get_llm_client)]) -> CheckResponse:
    engine = request.app.state.engine
    snapshot = await to_thread.run_sync(prepare_check, engine, intention_id, body)
    result = await check_sentence(client, snapshot.context)
    return await to_thread.run_sync(persist_check, engine, intention_id, snapshot, result, client.mode)
