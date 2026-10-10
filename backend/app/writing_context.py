"""Pure compact input shared by inference snapshots and saved-feedback reads."""
from sqlmodel import Session, select

from app.models import Draft, Intention


def compact_context(session: Session, draft: Draft, current: Intention, help_level: str | None) -> dict:
    intentions = session.exec(select(Intention).where(Intention.draft_id == draft.id).order_by(Intention.position)).all()
    context = {
        "topic": draft.topic, "task_description": draft.task_description,
        "target_sentence_count": draft.target_sentence_count,
        "target_word_min": draft.target_word_min, "target_word_max": draft.target_word_max,
        "intentions": [{"function_label": item.function_label, "description": item.description} for item in intentions],
        "current_intention": {field: getattr(current, field) for field in ("position", "function_label", "description", "guiding_question")},
        "previous_sentences": [item.sentence_text for item in intentions if item.position < current.position and item.sentence_text],
        "current_sentence": current.sentence_text or "", "user_notes": current.user_notes or "",
    }
    if help_level is not None:
        context["help_level"] = help_level
    return context
