"""Shared bounded validation, one repair attempt, generation, hints and plans."""

import asyncio
from hashlib import sha256
import json
from pathlib import Path
from collections.abc import Callable
from typing import Any, TypeVar

from pydantic import ValidationError

from app.llm.client import ATTEMPT_TIMEOUT_SECONDS, LLMClient, LLMRequest, Task
from app.llm.errors import LLMFailure, LLMTimeout
from app.llm.schemas import CheckOutput, CheckRaw, HelpLevel, HintsOutput, HintsRaw, IntentionSequence, LLMModel, PlanOutput, PlanRaw
from app.llm.policy import PolicyViolation, sanitize_check, sanitize_hints, sanitize_plan

MAX_CONTEXT_BYTES = 24_000
MAX_RESPONSE_BYTES = 128 * 1024
PROMPT_DIR = Path(__file__).resolve().parent / "prompts"


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def context_fingerprint(task: str, context: dict[str, Any]) -> str:
    return sha256(canonical_json({"task": task, "input": context}).encode("utf-8")).hexdigest()


def read_prompt(name: str) -> str:
    return (PROMPT_DIR / name).read_text(encoding="utf-8")


def reject_duplicate_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON key")
        result[key] = value
    return result


def reject_constant(_value):
    raise ValueError("Nonfinite JSON value")


def schema_error_summary(error: ValidationError) -> str:
    # Only library-controlled codes: no loc keys, user values, ctx or raw output.
    codes = sorted({item["type"] for item in error.errors(include_input=False, include_context=False, include_url=False)})
    return "JSON schema validation failed: " + ", ".join(codes[:8])


Output = TypeVar("Output", bound=LLMModel)


async def validated_call(
    client: LLMClient, task: Task, context: dict[str, Any], schema: dict,
    validate: Callable[[Any], Output],
) -> Output:
    encoded = canonical_json(context)
    if len(encoded.encode("utf-8")) > MAX_CONTEXT_BYTES:
        # Context checks normally run in the route before choosing a provider.
        from fastapi import HTTPException

        raise HTTPException(422, "Writing context is too large. Shorten the topic, task description or earlier writing.")
    system = read_prompt("system.md") + "\n\n" + read_prompt(f"{task}.md")
    repair = None
    for attempt in range(2):
        payload = {"input": context}
        if repair is not None:
            payload["validation_feedback"] = repair
        request = LLMRequest(task, system, canonical_json(payload), schema)
        try:
            raw = await asyncio.wait_for(client.generate(request), timeout=ATTEMPT_TIMEOUT_SECONDS)
        except TimeoutError:
            raise LLMTimeout() from None
        if not isinstance(raw, str) or not raw.strip():
            raise LLMFailure("The model returned no usable output. Please retry.")
        if len(raw.encode("utf-8", errors="surrogatepass")) > MAX_RESPONSE_BYTES:
            raise LLMFailure("The model response exceeded the supported size. Please retry.")
        try:
            raw.encode("utf-8")
            data = json.loads(raw, object_pairs_hook=reject_duplicate_keys, parse_constant=reject_constant)
            return validate(data)
        except PolicyViolation as error:
            repair = str(error)  # Fixed policy instructions, never model content.
        except ValidationError as error:
            repair = schema_error_summary(error)
        except (ValueError, RecursionError):
            repair = "Return one valid UTF-8 JSON object without duplicate keys or nonfinite values."
        if attempt == 1:
            raise LLMFailure("The model returned invalid writing guidance after one repair attempt. Please retry.")
    raise AssertionError("Unreachable validation state")


async def generate_intentions(client: LLMClient, context: dict[str, Any]) -> IntentionSequence:
    expected_count = context["target_sentence_count"]
    schema = IntentionSequence.model_json_schema()
    schema["properties"]["intentions"].update(minItems=expected_count, maxItems=expected_count)
    def validate(data):
        result = IntentionSequence.model_validate(data)
        if len(result.intentions) != expected_count:
            raise PolicyViolation(f"Return exactly {expected_count} intentions.")
        return result
    return await validated_call(client, "generate_intentions", context, schema, validate)


async def get_hints(client: LLMClient, context: dict[str, Any]) -> HintsOutput:
    level: HelpLevel = context["help_level"]
    schema = HintsOutput.model_json_schema()
    if level == "hint":
        schema["properties"]["structures"]["maxItems"] = 0
    if level != "example":
        schema["properties"]["examples"]["maxItems"] = 0
    return await validated_call(client, "get_hints", context, schema, lambda data: sanitize_hints(HintsRaw.model_validate(data), level))


async def make_plan(client: LLMClient, context: dict[str, Any]) -> PlanOutput:
    level: HelpLevel = context["help_level"]
    schema = PlanOutput.model_json_schema()
    if level == "hint":
        schema["properties"]["matched_structures"]["maxItems"] = 0
    if level != "example":
        schema["properties"]["examples"]["maxItems"] = 0
    return await validated_call(client, "make_plan", context, schema, lambda data: sanitize_plan(PlanRaw.model_validate(data), level))


async def check_sentence(client: LLMClient, context: dict[str, Any]) -> CheckOutput:
    return await validated_call(client, "check_sentence", context, CheckOutput.model_json_schema(), lambda data: sanitize_check(CheckRaw.model_validate(data)))
