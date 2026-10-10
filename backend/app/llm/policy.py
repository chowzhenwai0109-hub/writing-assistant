"""Deterministic field/collection/placeholder policy; prose semantics are best effort."""

import re

from app.llm.schemas import CheckOutput, CheckRaw, HelpLevel, HintsOutput, HintsRaw, PlanOutput, PlanRaw


class PolicyViolation(ValueError):
    """Only raise with controlled instructions safe for a repair prompt."""


def has_substantive_placeholder(pattern: str) -> bool:
    for slot in re.findall(r"\[([^\[\]\r\n]{1,100})\]", pattern):
        label = slot.strip().casefold()
        if sum(character.isalpha() for character in label) >= 2 and label not in {"text", "placeholder", "something", "anything", "slot"}:
            return True
    return False


def sanitize_hints(raw: HintsRaw, level: HelpLevel) -> HintsOutput:
    data = raw.model_dump()
    if level == "hint":
        data["structures"] = []
    if level != "example":
        data["examples"] = []
    for field, cap in {"entities": 5, "keywords": 6, "connectives": 4, "structures": 3, "examples": 2}.items():
        data[field] = data[field][:cap]
    if level == "structure" and any(not has_substantive_placeholder(item["pattern"]) for item in data["structures"]):
        raise PolicyViolation("Every Structure pattern must retain a bracketed, letter-bearing substantive slot such as [subject] or [supplied reason].")
    return HintsOutput.model_validate(data)


def sanitize_plan(raw: PlanRaw, level: HelpLevel) -> PlanOutput:
    data = raw.model_dump()
    if level == "hint":
        data["matched_structures"] = []
    if level != "example":
        data["examples"] = []
    for field, cap in {"slots": 6, "gaps": 5, "matched_structures": 3, "matched_keywords": 6, "examples": 2}.items():
        data[field] = data[field][:cap]
    if level == "structure" and any(not has_substantive_placeholder(item["pattern"]) for item in data["matched_structures"]):
        raise PolicyViolation("Every Structure pattern must retain a bracketed, letter-bearing substantive slot such as [subject] or [supplied reason].")
    return PlanOutput.model_validate(data)


def sanitize_check(raw: CheckRaw) -> CheckOutput:
    data = raw.model_dump()
    data["issues"] = data["issues"][:5]
    return CheckOutput.model_validate(data)
