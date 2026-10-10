from app.config import load_settings


def test_backend_only_settings_precedence_and_safe_default(tmp_path, monkeypatch):
    for key in ("LLM_PROVIDER", "LLM_MODE", "LLM_MODEL", "GEMINI_API_KEY"):
        monkeypatch.delenv(key, raising=False)
    (tmp_path / ".env").write_text("GEMINI_API_KEY=root-test-key\nLLM_MODEL=root-model\n")
    (tmp_path / "backend").mkdir()
    settings = load_settings(tmp_path)
    assert settings.llm_mode == "fake"
    assert settings.gemini_api_key.get_secret_value() == "root-test-key"

    (tmp_path / "backend" / ".env").write_text("GEMINI_API_KEY=backend-test-key\n")
    settings = load_settings(tmp_path)
    assert settings.gemini_api_key.get_secret_value() == "backend-test-key"
    assert settings.llm_model == "root-model"

    monkeypatch.setenv("GEMINI_API_KEY", "process-test-key")
    settings = load_settings(tmp_path)
    assert settings.gemini_api_key.get_secret_value() == "process-test-key"
    assert "process-test-key" not in repr(settings)
    assert "process-test-key" not in settings.model_dump_json()


def test_default_model_is_flash_lite(tmp_path, monkeypatch):
    for key in ("LLM_PROVIDER", "LLM_MODE", "LLM_MODEL", "GEMINI_API_KEY"):
        monkeypatch.delenv(key, raising=False)
    settings = load_settings(tmp_path)
    assert settings.llm_model == "gemini-3.5-flash-lite" and settings.llm_mode == "fake"
