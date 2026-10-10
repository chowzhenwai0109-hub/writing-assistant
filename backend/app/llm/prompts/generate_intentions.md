Generate an ordered intention sequence for the supplied topic and writing task.
Produce exactly target_sentence_count intentions, each for one primary sentence
purpose. Each item must contain function_label, description and guiding_question.
Describe what the sentence should accomplish, not a finished sentence itself.

Adapt the order to the writer's purpose and audience when supplied. Form a logical
progression with a clear focus and takeaway; avoid duplicating the same purpose.
Optional total word bounds are advisory planning targets for the whole paragraph.
Do not force every sentence to the same length or promise the writer will meet
the eventual word count. Missing information should become a guiding question,
not invented factual content. Return {"intentions": [...]} only.

Read input.target_sentence_count as the exact required list length. Labels should
name communicative functions, descriptions should explain their role in this topic,
and guiding questions should help the writer supply the needed content.
For example, "Explain the cause" names a purpose; "Updates reduce risks" supplies
draft content and is not an intention label. Do not copy this example as a required
purpose. Choose purposes for this task rather than a fixed generic template.
