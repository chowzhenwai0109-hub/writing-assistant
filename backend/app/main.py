"""Local application startup, health, CRUD, generation, hints and plans."""

from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import Engine
from sqlmodel import Session, text

from app.config import load_settings
from app.db import create_db_engine, initialize_database
from app.llm.errors import LLMError
from app.routers import checks, drafts, generation, hints, intentions, plans
from app.schemas import HealthResponse


def create_app(database_engine: Engine | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(application: FastAPI):
        engine = database_engine if database_engine is not None else create_db_engine()
        application.state.engine = engine
        application.state.settings = load_settings()
        initialize_database(engine)
        try:
            yield
        finally:
            engine.dispose()

    application = FastAPI(title="Writing Assistant", lifespan=lifespan)
    application.include_router(drafts.router)
    application.include_router(intentions.router)
    application.include_router(generation.router)
    application.include_router(hints.router)
    application.include_router(plans.router)
    application.include_router(checks.router)
    application.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
        allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE"],
        allow_headers=["Content-Type"],
    )

    @application.exception_handler(RequestValidationError)
    async def validation_error(_request: Request, error: RequestValidationError):
        # Error input can contain writing or secrets: return paths/messages only.
        messages = [
            f"{'.'.join(str(part) for part in item['loc'])}: {item['msg']}"
            for item in error.errors()
        ]
        return JSONResponse(status_code=422, content={"detail": "; ".join(messages)})

    @application.exception_handler(Exception)
    async def unexpected_error(_request: Request, _error: Exception):
        return JSONResponse(status_code=500, content={"detail": "An unexpected error occurred. Retry the request."})

    @application.exception_handler(LLMError)
    async def llm_error(_request: Request, error: LLMError):
        return JSONResponse(status_code=error.status_code, content={"detail": error.detail})

    @application.get("/api/health", response_model=HealthResponse)
    def health(request: Request) -> HealthResponse:
        with Session(request.app.state.engine) as session:
            session.exec(text("SELECT 1")).one()
        return HealthResponse()

    return application


app = create_app()
