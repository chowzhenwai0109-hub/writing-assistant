"""Persistent draft and intention records; API validation lives in schemas.py."""

from datetime import UTC, datetime
from typing import Any

from sqlalchemy import CheckConstraint, Column, JSON, UniqueConstraint
from sqlmodel import Field, SQLModel


def utc_now() -> datetime:
    return datetime.now(UTC)


class Draft(SQLModel, table=True):
    __tablename__ = "drafts"
    __table_args__ = (
        CheckConstraint("revision >= 1", name="draft_revision_positive"),
        CheckConstraint("target_sentence_count BETWEEN 3 AND 8", name="sentence_count_range"),
        CheckConstraint("last_generation_mode IS NULL OR last_generation_mode IN ('fake', 'live')", name="generation_mode_valid"),
        CheckConstraint(
            "(target_word_min IS NULL AND target_word_max IS NULL) OR "
            "(target_word_min IS NOT NULL AND target_word_max IS NOT NULL AND "
            "target_word_min BETWEEN 1 AND 500 AND target_word_max BETWEEN 1 AND 500 "
            "AND target_word_min <= target_word_max)",
            name="word_range_valid",
        ),
        {"sqlite_autoincrement": True},
    )

    id: int | None = Field(default=None, primary_key=True)
    title: str = Field(max_length=200)
    topic: str = Field(max_length=2000)
    task_description: str = Field(default="", max_length=4000)
    target_sentence_count: int = Field(default=5)
    target_word_min: int | None = Field(default=None)
    target_word_max: int | None = Field(default=None)
    last_generation_mode: str | None = Field(default=None, max_length=4)
    revision: int = Field(default=1)
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class Intention(SQLModel, table=True):
    __tablename__ = "intentions"
    __table_args__ = (
        UniqueConstraint("draft_id", "position", name="unique_draft_position"),
        CheckConstraint("position >= 0", name="position_nonnegative"),
        CheckConstraint("revision >= 1", name="intention_revision_positive"),
        CheckConstraint("status IN ('pending', 'written', 'checked')", name="status_valid"),
        {"sqlite_autoincrement": True},
    )

    id: int | None = Field(default=None, primary_key=True)
    draft_id: int = Field(foreign_key="drafts.id", ondelete="CASCADE", index=True)
    position: int
    function_label: str = Field(max_length=200)
    description: str = Field(max_length=1000)
    guiding_question: str = Field(max_length=1000)
    status: str = Field(default="pending")
    sentence_text: str | None = Field(default=None, max_length=4000)
    user_notes: str | None = Field(default=None, max_length=4000)
    revision: int = Field(default=1)
    last_check_json: dict[str, Any] | None = Field(default=None, sa_column=Column(JSON(none_as_null=True)))
    last_check_fingerprint: str | None = Field(default=None, max_length=64)
