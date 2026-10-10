"""Path-stable SQLite setup and transaction-scoped FastAPI dependencies."""

import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from fastapi import HTTPException, Request
from sqlalchemy import Engine, event
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlmodel import Session, SQLModel, create_engine, text

from app.config import BACKEND_DIR

DATABASE_PATH = BACKEND_DIR / "data" / "app.db"


def create_db_engine(database_path: Path = DATABASE_PATH) -> Engine:
    database_path = database_path.resolve()
    database_path.parent.mkdir(parents=True, exist_ok=True)
    engine = create_engine(
        f"sqlite:///{database_path.as_posix()}",
        connect_args={"check_same_thread": False, "timeout": 5},
    )

    @event.listens_for(engine, "connect")
    def enable_foreign_keys(connection, _record) -> None:
        cursor = connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    return engine


def initialize_database(engine: Engine) -> None:
    from app import models  # Register both tables before create_all.

    SQLModel.metadata.create_all(engine)
    # create_all does not alter existing Stage 1 tables. Serialize this additive
    # migration with the same write guard as mutations; repeat startup is safe.
    with write_session(engine) as session:
        columns = {row[1] for row in session.exec(text("PRAGMA table_info(drafts)")).all()}
        if "last_generation_mode" not in columns:
            session.exec(text(
                "ALTER TABLE drafts ADD COLUMN last_generation_mode VARCHAR(4) "
                "CHECK(last_generation_mode IS NULL OR last_generation_mode IN ('fake', 'live'))"
            ))
    with Session(engine) as session:
        session.exec(text("SELECT 1")).one()


@contextmanager
def read_session(engine: Engine) -> Iterator[Session]:
    with Session(engine) as session:
        # SQLite's legacy mode doesn't begin a physical transaction for SELECT.
        # Explicit BEGIN makes revision + nested items one consistent snapshot.
        session.exec(text("BEGIN"))
        yield session


@contextmanager
def write_session(engine: Engine) -> Iterator[Session]:
    with Session(engine) as session:
        try:
            # Acquire the write reservation BEFORE reading revisions or positions.
            # This makes read/compare/mutate atomic across threads and processes.
            session.exec(text("BEGIN IMMEDIATE"))
            yield session
            session.commit()
        except IntegrityError as error:
            session.rollback()
            raise HTTPException(409, "The change conflicts with stored data.") from error
        except OperationalError as error:
            session.rollback()
            code = getattr(error.orig, "sqlite_errorcode", None)
            if code is not None and (code & 0xFF) in (sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED):
                raise HTTPException(409, "The local database is busy. Retry the change.") from error
            raise HTTPException(500, "The local database operation failed.") from error
        except Exception:
            session.rollback()
            raise


def get_session(request: Request) -> Iterator[Session]:
    with read_session(request.app.state.engine) as session:
        yield session


def get_write_session(request: Request) -> Iterator[Session]:
    with write_session(request.app.state.engine) as session:
        yield session
