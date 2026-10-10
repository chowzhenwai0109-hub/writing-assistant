"""Strict shapes for all V1 tasks. Later stages add prompts/services for micro tasks."""

from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, StringConstraints

from app.schemas import valid_unicode_text

Text = Annotated[str, StringConstraints(strict=True, strip_whitespace=True, min_length=1, max_length=1000), AfterValidator(valid_unicode_text)]
Phrase = Annotated[str, StringConstraints(strict=True, strip_whitespace=True, min_length=1, max_length=200), AfterValidator(valid_unicode_text)]
HelpLevel = Literal["hint", "structure", "example"]


class LLMModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class GeneratedIntention(LLMModel):
    function_label: Phrase
    description: Text
    guiding_question: Text


class IntentionSequence(LLMModel):
    intentions: Annotated[list[GeneratedIntention], Field(min_length=3, max_length=8)]


class Entity(LLMModel):
    label: Phrase
    why_needed: Text


class Keyword(LLMModel):
    phrase: Phrase
    note: Text


class Connective(LLMModel):
    word: Phrase
    use: Text


class Structure(LLMModel):
    pattern: Text
    note: Text


class Example(LLMModel):
    sentence: Text
    why_it_works: Text


class HintsRaw(LLMModel):
    intention_summary: Text
    relationship: Text
    entities: list[Entity]
    keywords: list[Keyword]
    connectives: list[Connective]
    structures: list[Structure]
    examples: list[Example]


class HintsOutput(HintsRaw):
    entities: Annotated[list[Entity], Field(max_length=5)]
    keywords: Annotated[list[Keyword], Field(max_length=6)]
    connectives: Annotated[list[Connective], Field(max_length=4)]
    structures: Annotated[list[Structure], Field(max_length=3)]
    examples: Annotated[list[Example], Field(max_length=2)]


class Slot(LLMModel):
    role: Literal["subject", "action", "condition", "consequence", "detail", "other"]
    content: Text


class Gap(LLMModel):
    missing: Text
    question: Text


class PlanRaw(LLMModel):
    slots: list[Slot]
    gaps: list[Gap]
    ordering_suggestion: Text
    matched_structures: list[Structure]
    matched_keywords: list[Keyword]
    examples: list[Example]


class PlanOutput(PlanRaw):
    slots: Annotated[list[Slot], Field(max_length=6)]
    gaps: Annotated[list[Gap], Field(max_length=5)]
    matched_structures: Annotated[list[Structure], Field(max_length=3)]
    matched_keywords: Annotated[list[Keyword], Field(max_length=6)]
    examples: Annotated[list[Example], Field(max_length=2)]


class Issue(LLMModel):
    type: Literal["off_intention", "overclaim", "missing_info", "repetition", "unclear_relation", "unestablished_info", "other"]
    message: Text
    suggestion: Text


class CheckRaw(LLMModel):
    fulfils_intention: Literal["yes", "partly", "no"]
    summary: Text
    issues: list[Issue]


class CheckOutput(CheckRaw):
    issues: Annotated[list[Issue], Field(max_length=5)]
