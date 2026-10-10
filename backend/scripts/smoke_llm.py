"""Standalone generation/hints/plan/check smoke, independent of SQLite and draft data."""

import argparse
import asyncio
from pathlib import Path
import sys

from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import load_settings
from app.llm.client import create_llm_client
from app.llm.errors import LLMError
from app.llm.service import check_sentence, generate_intentions, get_hints, make_plan


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true", help="Explicitly opt into remote Gemini evaluation after user authorization.")
    parser.add_argument("--topic", default="How software updates reduce risks")
    parser.add_argument("--sentences", type=int, choices=range(3, 9), default=5)
    parser.add_argument("--task", choices=("generate_intentions", "get_hints", "make_plan", "check_sentence"), default="generate_intentions")
    parser.add_argument("--help-level", choices=("hint", "structure", "example"), default="hint")
    parser.add_argument("--notes", default="Explain the benefit; ask if supporting details are missing.")
    parser.add_argument("--sentence", default="Updates can address known problems.")
    arguments = parser.parse_args()
    if not arguments.topic.strip() or len(arguments.topic) > 2000:
        parser.error("Topic must contain 1–2,000 characters.")
    if arguments.task == "make_plan" and (not arguments.notes.strip() or len(arguments.notes) > 4000):
        parser.error("Notes must contain nonblank text up to 4,000 characters.")
    if arguments.task == "check_sentence" and (not arguments.sentence.strip() or len(arguments.sentence) > 4000):
        parser.error("Sentence must contain nonblank text up to 4,000 characters.")
    # Ignore LLM_MODE=live unless this invocation explicitly opts in.
    settings = load_settings().model_copy(update={"llm_mode": "live" if arguments.live else "fake"})
    context = {
        "topic": arguments.topic, "task_description": "Explain this topic to college classmates without inventing evidence.",
        "target_sentence_count": arguments.sentences, "target_word_min": None, "target_word_max": None,
    }
    try:
        client = create_llm_client(settings)
        if arguments.task in ("get_hints", "make_plan", "check_sentence"):
            context.update({
                "intentions": [{"function_label": "Explain a benefit", "description": "Explain why updates help."}],
                "current_intention": {"position": 0, "function_label": "Explain a benefit", "description": "Explain why updates help.", "guiding_question": "Why do updates help?"},
                "previous_sentences": [], "current_sentence": "", "user_notes": "", "help_level": arguments.help_level,
            })
            if arguments.task == "check_sentence":
                del context["help_level"]
                context["current_sentence"] = arguments.sentence
                result = asyncio.run(check_sentence(client, context))
            elif arguments.task == "make_plan":
                context["user_notes"] = arguments.notes
                result = asyncio.run(make_plan(client, context))
            else:
                result = asyncio.run(get_hints(client, context))
        else:
            result = asyncio.run(generate_intentions(client, context))
    except (LLMError, HTTPException) as error:
        print(f"Smoke check failed ({error.status_code}): {error.detail}", file=sys.stderr)
        return 1
    print(f"Mode: {client.mode}; live model quality {'unverified' if client.mode == 'fake' else 'requires manual review'}")
    print(result.model_dump_json(indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
