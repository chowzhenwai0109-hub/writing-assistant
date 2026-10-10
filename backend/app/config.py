"""Backend-only settings. Importing this module never contacts a provider."""

import os
from pathlib import Path

from dotenv import dotenv_values
from pydantic import BaseModel, ConfigDict, Field, SecretStr

BACKEND_DIR = Path(__file__).resolve().parents[1]
PROJECT_DIR = BACKEND_DIR.parent


class Settings(BaseModel):
    model_config = ConfigDict(frozen=True)

    llm_provider: str = "gemini"
    llm_mode: str = "fake"
    llm_model: str = "gemini-3.5-flash-lite"
    gemini_api_key: SecretStr = Field(default=SecretStr(""), repr=False)


def load_settings(project_dir: Path = PROJECT_DIR) -> Settings:
    # Read files without changing process env or printing secret values.
    values = {
        **dotenv_values(project_dir / ".env"),
        **dotenv_values(project_dir / "backend" / ".env"),
        **os.environ,
    }
    fields = {
        "llm_provider": "LLM_PROVIDER",
        "llm_mode": "LLM_MODE",
        "llm_model": "LLM_MODEL",
        "gemini_api_key": "GEMINI_API_KEY",
    }
    return Settings(
        **{field: values[key] for field, key in fields.items() if values.get(key) is not None}
    )
