# Prompt review and evaluation

The prompts are clear enough to begin model evaluation: each request has one task,
explicit inputs, a structured output schema, shared policy and task-specific rules.
They are not yet proven reliable with a live model. Offline tests verify request
assembly, field restrictions, validation, bounded repair and persistence, rather
than natural-language reasoning or judgment.

Stage 7 resolved these ambiguities:

| Finding | Implemented solution |
|---|---|
| Writing goals looked like instructions to ignore | Apply legitimate audience/tone/purpose preferences; reject attempts to override policy or output format. |
| Help levels used prose names | Identify exact input values `hint`, `structure`, `example` and their permitted fields. |
| Nested output fields were implicit | Spell out each item's keys and the exact slot-role enum; retain provider schema and local validation. |
| Slots could become completed sentences | Give short fragment and role-order illustrations; allow explanatory sentences while prohibiting completing the writer's draft. |
| Caps could become quotas | Return only relevant items; empty lists are valid. |
| Generic guidance could ignore supplied ideas | Ask for specific supplied subjects/vocabulary, fewer slots for sparse notes and targeted questions for ambiguity. |
| Check verdict thresholds were unspecified | Define yes/partly/no by primary-purpose achievement; minor issues can coexist with yes. |
| New information could be falsely flagged | Distinguish ordinary new points from overclaims, unexplained assumptions and missing required details. |
| Issue labels could overlap | Define all seven types and ask for specific, nonduplicate issues with targeted suggestions. |
| Repair instructions were unclear | Identify application validation feedback and keep the same original input/task; one bounded repair only. |

These are design judgments, informed by Google's guidance on clear instructions
and examples. The prompts stay short enough to avoid redundant or contradictory
rules. The exact count and JSON contracts remain enforced in code. Whole-sentence
leakage in prose, grounding, English quality, relevance and calibrated verdicts
remain semantic properties requiring observed model responses.
[Google prompt design strategies](https://ai.google.dev/gemini-api/docs/prompting-strategies).

The chosen default is `gemini-3.5-flash-lite`; the launcher can choose
`gemini-3.6-flash` instead. Google documents both model codes and structured-output
support. This confirms the configuration choice, not API-key access or writing
quality in this project. There is no automatic fallback to another model.
[Flash-Lite documentation](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite),
[Flash documentation](https://ai.google.dev/gemini-api/docs/models/gemini-3.6-flash).

When live evaluation is authorized, test both models against the same cases:

1. Generate exactly 3, 5 and 8 purposes for different audiences; no draft sentences.
2. Request hints at every level; check useful topic-specific vocabulary and no
   completed draft text below Example, including in explanatory prose.
3. Plan from sparse and non-English notes; preserve meaning, ask about gaps and
   retain substantive Structure slots without invented support.
4. Include instructions embedded in writing that ask for rewrites or extra fields;
   verify policy and schema adherence.
5. Check an acceptable primary-plus-secondary purpose, a minor meaning concern,
   an absolute overclaim, repetition, missing information and an ambiguous reference.
6. Check a fragment/multiple sentences and a word-target mismatch; preserve text
   and avoid automatic negative verdicts based on length alone.

Record model ID, input, help level, output and an independent human assessment.
Use the detailed Stage 5/6 rubrics in SOLUTION_DESIGN.md. Do not equate successful
JSON parsing or one smoke response with semantic acceptance. Live results remain
deferred; staged builds make no provider requests.
