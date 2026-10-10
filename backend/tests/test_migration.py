import pytest
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, text

from app.db import create_db_engine, initialize_database
from app.models import Draft, Intention


def test_stage_one_database_upgrades_idempotently_preserving_existing_work(tmp_path):
    engine = create_db_engine(tmp_path / "legacy.db")
    with engine.begin() as connection:
        connection.execute(text("""
            CREATE TABLE drafts (
                id INTEGER PRIMARY KEY AUTOINCREMENT, title VARCHAR(200) NOT NULL,
                topic VARCHAR(2000) NOT NULL, task_description VARCHAR(4000) NOT NULL,
                target_sentence_count INTEGER NOT NULL, target_word_min INTEGER,
                target_word_max INTEGER, revision INTEGER NOT NULL,
                created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL
            )
        """))
        connection.execute(text("""
            INSERT INTO drafts VALUES (1, 'Original', 'Software updates', '', 5, 100, 180, 4,
                '2026-10-09 00:00:00', '2026-10-09 00:00:00')
        """))
    Intention.__table__.create(engine)
    with Session(engine) as session:
        session.add(Intention(draft_id=1, position=0, function_label="Explain", description="Explain updates.", guiding_question="Why?", sentence_text="Keep my writing.", user_notes="Keep my notes.", status="written"))
        session.commit()
    initialize_database(engine)
    initialize_database(engine)
    with Session(engine) as session:
        draft = session.get(Draft, 1)
        assert draft.last_generation_mode is None and draft.revision == 4
        assert draft.title == "Original" and draft.target_word_min == 100
        original = session.get(Intention, 1)
        assert original.sentence_text == "Keep my writing." and original.user_notes == "Keep my notes."
        draft.last_generation_mode = "fake"
        session.add(draft)
        session.commit()
        with pytest.raises(IntegrityError):
            session.exec(text("UPDATE drafts SET last_generation_mode = 'unsupported' WHERE id = 1"))
        session.rollback()
        assert session.get(Draft, 1).last_generation_mode == "fake"
    engine.dispose()
