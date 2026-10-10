"""Deterministic demo sequences and scripted failures; no network access."""

from collections import deque
import json
import re
from collections.abc import Iterable

from app.llm.client import LLMRequest


class FakeLLMClient:
    mode = "fake"

    def __init__(self, responses: Iterable[str | Exception] | None = None):
        self.calls: list[LLMRequest] = []
        self._script = deque(responses) if responses is not None else None

    async def generate(self, request: LLMRequest) -> str:
        self.calls.append(request)
        if self._script is not None:
            if not self._script:
                raise AssertionError("FakeLLMClient response script exhausted")
            response = self._script.popleft()
            if isinstance(response, Exception):
                raise response
            return response
        payload = json.loads(request.user_prompt)
        if request.task == "check_sentence":
            # A transparent demo heuristic, not a semantic assessment.
            broad = bool(re.search(r"\b(always|everyone|guarantee[sd]?)\b", payload["input"]["current_sentence"], re.IGNORECASE))
            return json.dumps({
                "fulfils_intention": "partly" if broad else "yes",
                "summary": "Demo feedback only: review the primary intention and whether your supplied information supports the wording.",
                "issues": [{"type": "overclaim", "message": "Demo heuristic: the wording includes a broad claim.", "suggestion": "Consider a qualification or provide support from your own information."}] if broad else [],
            })
        if request.task == "make_plan":
            level = payload["input"]["help_level"]
            # Generic demo roles/questions, not translation or semantic evaluation.
            return json.dumps({
                "slots": [{"role": "subject", "content": "the subject supplied in your notes"}, {"role": "action", "content": "your supplied action or main point"}],
                "gaps": [{"missing": "A supporting detail", "question": "Which detail from your own information supports this point?"}],
                "ordering_suggestion": "Start with the subject, connect the supplied action, then add a relevant detail if available.",
                "matched_structures": [] if level == "hint" else [{"pattern": "[subject] [supplied action] because [supplied reason].", "note": "Choose your content for the slots."}],
                "matched_keywords": [{"phrase": "supplied detail", "note": "Use a relevant detail from your notes."}],
                "examples": [] if level != "example" else [{"sentence": "A clear point helps the reader follow an explanation.", "why_it_works": "Generic demo of connecting a point and its consequence."}],
            })
        if request.task == "get_hints":
            level = payload["input"]["help_level"]
            return json.dumps({
                "intention_summary": "Focus on the current intention's primary purpose.",
                "relationship": "Connect the current point to earlier writing; introduce the topic when there is no earlier text.",
                "entities": [{"label": "Main subject", "why_needed": "Identify who or what the point concerns."}, {"label": "Supplied reason", "why_needed": "Ask for a reason rather than inventing evidence."}],
                "keywords": [{"phrase": "main point", "note": "Name the idea you want the reader to follow."}, {"phrase": "relevant detail", "note": "Use a detail you can supply."}],
                "connectives": [{"word": "because", "use": "Links a point to its supplied reason."}],
                "structures": [] if level == "hint" else [{"pattern": "[subject] [action] because [supplied reason].", "note": "Keep the slots until you choose your own content."}],
                "examples": [] if level != "example" else [{"sentence": "A clear explanation gives the reader a reason to consider the point.", "why_it_works": "A generic practice example of connecting a point to a reason."}],
            })
        if request.task != "generate_intentions":
            raise NotImplementedError("Micro task demo services arrive in later stages.")
        count = payload["input"]["target_sentence_count"]
        purposes = [
            ("Introduce the focus", "Frame the topic for the intended reader.", "What is the paragraph about?"),
            ("State the central point", "Present the writer's main claim without inventing facts.", "What do you want the reader to understand?"),
            ("Explain the reasoning", "Give the writer's reason for the central point.", "Why does this point matter?"),
            ("Add a supplied detail", "Use a relevant detail the writer can provide; ask if it is missing.", "What detail can you supply?"),
            ("Address a qualification", "Explain a relevant condition or limit on the claim.", "When might this point need qualification?"),
            ("Connect to consequences", "Describe a consequence grounded in the writer's information.", "What follows from this point?"),
            ("Clarify significance", "Explain the practical significance for the reader.", "How does this affect the reader?"),
            ("Close with a takeaway", "Bring the paragraph back to its central purpose.", "What should the reader remember?"),
        ]
        selected = purposes[:count - 1] + purposes[-1:]
        return json.dumps({"intentions": [
            {"function_label": label, "description": description, "guiding_question": question}
            for label, description, question in selected
        ]})
