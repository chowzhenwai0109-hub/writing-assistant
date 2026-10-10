from copy import deepcopy

from pydantic import ValidationError
import pytest

from app.llm.schemas import CheckOutput, HintsOutput, HintsRaw, PlanOutput, PlanRaw

HINTS = {"intention_summary": "Explain the claim", "relationship": "elaboration", "entities": [], "keywords": [], "connectives": [], "structures": [], "examples": []}
PLAN = {"slots": [], "gaps": [], "ordering_suggestion": "subject then action", "matched_structures": [], "matched_keywords": [], "examples": []}
CHECK = {"fulfils_intention": "partly", "summary": "The purpose needs a clearer relationship.", "issues": [{"type": "unclear_relation", "message": "The cause is unclear.", "suggestion": "Identify the cause."}]}


@pytest.mark.parametrize("model,payload", [(HintsOutput, HINTS), (PlanOutput, PLAN), (CheckOutput, CHECK)])
def test_micro_contracts_accept_required_shape_and_forbid_unknown_or_missing_keys(model, payload):
    assert model.model_validate(payload).model_dump() == payload
    with pytest.raises(ValidationError):
        model.model_validate({**payload, "unexpected": "Must not be ignored"})
    for field in payload:
        missing = {key: value for key, value in payload.items() if key != field}
        with pytest.raises(ValidationError):
            model.model_validate(missing)


def test_raw_micro_shapes_allow_known_extra_items_but_final_contracts_enforce_caps():
    hints = {**HINTS, "entities": [{"label": "Writer", "why_needed": "The subject of the action"}] * 6}
    assert len(HintsRaw.model_validate(hints).entities) == 6
    with pytest.raises(ValidationError):
        HintsOutput.model_validate(hints)
    plan = {**PLAN, "examples": [{"sentence": "An example.", "why_it_works": "Shows the relationship"}] * 3}
    assert len(PlanRaw.model_validate(plan).examples) == 3
    with pytest.raises(ValidationError):
        PlanOutput.model_validate(plan)


def test_micro_enums_and_text_types_are_strict():
    bad_check = deepcopy(CHECK)
    bad_check["issues"][0]["type"] = "grammar_lesson"
    with pytest.raises(ValidationError):
        CheckOutput.model_validate(bad_check)
    with pytest.raises(ValidationError):
        CheckOutput.model_validate({**CHECK, "fulfils_intention": "maybe"})
    with pytest.raises(ValidationError):
        PlanOutput.model_validate({**PLAN, "slots": [{"role": "invented", "content": "fragment"}]})
    with pytest.raises(ValidationError):
        HintsOutput.model_validate({**HINTS, "relationship": 123})
