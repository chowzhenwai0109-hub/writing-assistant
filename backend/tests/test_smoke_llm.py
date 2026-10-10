import json
import os
from pathlib import Path
import subprocess
import sys
import pytest


def test_smoke_defaults_to_fake_even_with_live_environment_and_other_cwd(tmp_path):
    script = Path(__file__).resolve().parents[1] / "scripts" / "smoke_llm.py"
    environment = {
        **os.environ, "LLM_MODE": "live", "LLM_PROVIDER": "gemini",
        "GEMINI_API_KEY": "synthetic-unused-smoke-key",
    }
    completed = subprocess.run(
        [sys.executable, str(script), "--sentences", "3"],
        cwd=tmp_path, env=environment, capture_output=True, text=True, timeout=15,
    )
    assert completed.returncode == 0, completed.stderr
    mode, payload = completed.stdout.split("\n", 1)
    assert mode == "Mode: fake; live model quality unverified"
    assert len(json.loads(payload)["intentions"]) == 3
    assert "synthetic-unused-smoke-key" not in completed.stdout + completed.stderr
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize("level", ["hint", "structure", "example"])
def test_hints_smoke_is_offline_and_enforces_level(level, tmp_path):
    script = Path(__file__).resolve().parents[1] / "scripts" / "smoke_llm.py"
    completed = subprocess.run([sys.executable, str(script), "--task", "get_hints", "--help-level", level],
        cwd=tmp_path, env={**os.environ, "LLM_MODE": "live", "GEMINI_API_KEY": "synthetic-unused-key"}, capture_output=True, text=True, timeout=15)
    assert completed.returncode == 0, completed.stderr
    mode, payload = completed.stdout.split("\n", 1)
    assert mode == "Mode: fake; live model quality unverified"
    result = json.loads(payload)
    assert bool(result["structures"]) == (level != "hint")
    assert bool(result["examples"]) == (level == "example")
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize("level", ["hint", "structure", "example"])
def test_plan_smoke_forces_fake_with_multilingual_notes(level, tmp_path):
    script = Path(__file__).resolve().parents[1] / "scripts" / "smoke_llm.py"
    completed = subprocess.run([sys.executable, str(script), "--task", "make_plan", "--help-level", level, "--notes", "解释原因，缺少证据就提问"],
        cwd=tmp_path, env={**os.environ, "LLM_MODE": "live", "GEMINI_API_KEY": "synthetic-unused-key"}, capture_output=True, text=True, timeout=15)
    assert completed.returncode == 0, completed.stderr
    mode, payload = completed.stdout.split("\n", 1)
    assert mode == "Mode: fake; live model quality unverified"
    result = json.loads(payload)
    assert result["slots"] and result["gaps"]
    assert bool(result["matched_structures"]) == (level != "hint")
    assert bool(result["examples"]) == (level == "example")
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize("sentence,verdict", [("Updates can help.", "yes"), ("Updates always guarantee safety.", "partly")])
def test_check_smoke_forces_fake_and_does_not_touch_sqlite(sentence, verdict, tmp_path):
    script = Path(__file__).resolve().parents[1] / "scripts" / "smoke_llm.py"
    completed = subprocess.run([sys.executable, str(script), "--task", "check_sentence", "--sentence", sentence],
        cwd=tmp_path, env={**os.environ, "LLM_MODE": "live", "GEMINI_API_KEY": "synthetic-unused-key"}, capture_output=True, text=True, timeout=15)
    assert completed.returncode == 0, completed.stderr
    mode, payload = completed.stdout.split("\n", 1)
    assert mode == "Mode: fake; live model quality unverified"
    assert json.loads(payload)["fulfils_intention"] == verdict
    assert list(tmp_path.iterdir()) == []
