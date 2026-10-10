"""Strict request contracts and explicit public responses."""

from datetime import UTC, datetime
from typing import Annotated, Any, Literal, Self

from pydantic import (
    AfterValidator, BaseModel, BeforeValidator, ConfigDict, Field, StrictBool, StrictInt,
    StringConstraints, model_validator,
)

MAX_DB_INTEGER = 2**63 - 1
PositiveInt = Annotated[StrictInt, Field(ge=1, le=MAX_DB_INTEGER)]


def valid_unicode_text(value: str) -> str:
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        raise ValueError("Text must contain valid Unicode.") from None
    return value


Title = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200), AfterValidator(valid_unicode_text)]
Topic = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2000), AfterValidator(valid_unicode_text)]
IntentionText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=1000), AfterValidator(valid_unicode_text)]
SentenceCount = Annotated[StrictInt, Field(ge=3, le=8)]
WordBound = Annotated[StrictInt, Field(ge=1, le=500)]
TaskDescription = Annotated[
    str, BeforeValidator(lambda value: "" if value is None else value), Field(max_length=4000), AfterValidator(valid_unicode_text),
]
WritingText = Annotated[
    str, Field(max_length=4000), AfterValidator(valid_unicode_text), AfterValidator(lambda value: value if value.strip() else None),
]


def as_utc(value: datetime) -> datetime:
    # SQLite returns naive datetimes; all stored server timestamps are UTC.
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


UtcDatetime = Annotated[datetime, AfterValidator(as_utc)]


class APIModel(BaseModel):
    model_config = ConfigDict(extra="forbid", from_attributes=True)


class HealthResponse(APIModel):
    status: Literal["ok"] = "ok"


class DraftCreate(APIModel):
    title: Title
    topic: Topic
    task_description: TaskDescription = ""
    target_sentence_count: SentenceCount = 5
    target_word_min: WordBound | None = None
    target_word_max: WordBound | None = None

    @model_validator(mode="after")
    def valid_word_range(self) -> Self:
        low, high = self.target_word_min, self.target_word_max
        if (low is None) != (high is None):
            raise ValueError("Provide both word bounds or clear both.")
        if low is not None and high is not None and low > high:
            raise ValueError("Minimum words must not exceed maximum words.")
        return self


class RevisionPatch(APIModel):
    expected_revision: PositiveInt

    @model_validator(mode="after")
    def has_changes(self) -> Self:
        changed = self.model_fields_set - {"expected_revision"}
        if not changed:
            raise ValueError("Provide at least one editable field.")
        for name in changed - {"sentence_text", "user_notes", "target_word_min", "target_word_max", "task_description"}:
            if getattr(self, name) is None:
                raise ValueError(f"{name} cannot be null.")
        return self


class DraftPatch(RevisionPatch):
    title: Title | None = None
    topic: Topic | None = None
    task_description: TaskDescription | None = None
    target_sentence_count: SentenceCount | None = None
    target_word_min: WordBound | None = None
    target_word_max: WordBound | None = None

    @model_validator(mode="before")
    @classmethod
    def normalize_task_null(cls, data: Any) -> Any:
        if isinstance(data, dict) and "task_description" in data and data["task_description"] is None:
            return {**data, "task_description": ""}
        return data


class IntentionCreate(APIModel):
    expected_draft_revision: PositiveInt
    function_label: Title
    description: IntentionText
    guiding_question: IntentionText


class IntentionPatch(RevisionPatch):
    function_label: Title | None = None
    description: IntentionText | None = None
    guiding_question: IntentionText | None = None
    sentence_text: WritingText | None = None
    user_notes: WritingText | None = None


class IntentionOrder(APIModel):
    expected_revision: PositiveInt
    ordered_ids: Annotated[list[PositiveInt], Field(max_length=8)]


class GenerateIntentionsRequest(APIModel):
    mode: Literal["replace"] = "replace"
    expected_revision: PositiveInt
    confirm_replace: StrictBool = False


class DraftDeleteQuery(APIModel):
    # Query-string numbers are text, so parse them rather than using StrictInt.
    expected_revision: Annotated[int, Field(ge=1, le=MAX_DB_INTEGER)]


class IntentionDeleteQuery(DraftDeleteQuery):
    expected_draft_revision: Annotated[int, Field(ge=1, le=MAX_DB_INTEGER)]


class DraftSummary(APIModel):
    id: PositiveInt
    title: str
    topic: str
    task_description: str
    target_sentence_count: int
    target_word_min: int | None
    target_word_max: int | None
    last_generation_mode: Literal["fake", "live"] | None
    revision: PositiveInt
    created_at: UtcDatetime
    updated_at: UtcDatetime
    intention_count: int


class IntentionResponse(APIModel):
    id: PositiveInt
    draft_id: PositiveInt
    position: int
    function_label: str
    description: str
    guiding_question: str
    status: Literal["pending", "written", "checked"]
    sentence_text: str | None
    user_notes: str | None
    revision: PositiveInt
    last_check_json: dict[str, Any] | None
    last_check_fingerprint: str | None


class DraftResponse(DraftSummary):
    intentions: list[IntentionResponse]


class GenerationResponse(DraftResponse):
    mode: Literal["fake", "live"]
