from typing import Annotated, Literal

from pydantic import AfterValidator, Field, StringConstraints

from app.llm.schemas import CheckOutput, HelpLevel, HintsOutput, PlanOutput
from app.schemas import APIModel, DraftResponse, IntentionResponse, PositiveInt, valid_unicode_text


class HintsRequest(APIModel):
    help_level: HelpLevel = "hint"
    expected_revision: PositiveInt
    expected_draft_revision: PositiveInt


class HintsResponse(APIModel):
    result: HintsOutput
    context_fingerprint: Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
    intention_revision: PositiveInt
    draft_revision: PositiveInt
    mode: Literal["fake", "live"]


def nonblank_notes(value: str) -> str:
    if not value.strip():
        raise ValueError("Add rough notes before making a sentence plan.")
    return value


class PlanRequest(HintsRequest):
    user_notes: Annotated[str, StringConstraints(strict=True, min_length=1, max_length=4000), AfterValidator(valid_unicode_text), AfterValidator(nonblank_notes)]


class PlanResponse(APIModel):
    result: PlanOutput
    context_fingerprint: Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
    intention_revision: PositiveInt
    draft_revision: PositiveInt
    mode: Literal["fake", "live"]
    intention: IntentionResponse


def nonblank_sentence(value: str) -> str:
    if not value.strip():
        raise ValueError("Write a sentence before checking it.")
    return value


class CheckRequest(APIModel):
    sentence: Annotated[str, StringConstraints(strict=True, min_length=1, max_length=4000), AfterValidator(valid_unicode_text), AfterValidator(nonblank_sentence)]
    expected_revision: PositiveInt
    expected_draft_revision: PositiveInt


class CheckResponse(APIModel):
    result: CheckOutput
    context_fingerprint: Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
    intention_revision: PositiveInt
    draft_revision: PositiveInt
    mode: Literal["fake", "live"]
    intention: IntentionResponse
    draft: DraftResponse
