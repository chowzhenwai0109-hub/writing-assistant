from fastapi.testclient import TestClient
from sqlalchemy import text

from app.db import create_db_engine
from app.main import create_app


def test_health_uses_local_sqlite_without_a_provider_key(tmp_path, monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "")
    database_path = tmp_path / "data" / "test.db"
    engine = create_db_engine(database_path)

    with TestClient(create_app(engine)) as client:
        response = client.get("/api/health")
        assert response.status_code == 200
        assert response.json() == {"status": "ok"}
        assert client.app.state.settings.gemini_api_key.get_secret_value() == ""
        assert database_path.is_file()
        with engine.connect() as connection:
            assert connection.execute(text("PRAGMA foreign_keys")).scalar_one() == 1
