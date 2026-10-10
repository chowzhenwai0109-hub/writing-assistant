"""Launcher ordering, model selection and cleanup, without opening a browser."""
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
from urllib.error import URLError

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "dev.py"
spec = importlib.util.spec_from_file_location("writing_dev", SCRIPT)
dev = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dev)


@pytest.mark.parametrize("choice,mode,model", [("", "fake", dev.MODEL_LITE), ("l", "live", dev.MODEL_LITE), ("F", "live", dev.MODEL_FLASH)])
def test_launcher_menu_is_explicit_and_defaults_offline(monkeypatch, choice, mode, model):
    monkeypatch.setattr("builtins.input", lambda _: choice)
    args = dev.options(["--menu", "--open-browser"])
    assert (args.mode, args.model, args.open_browser) == (mode, model, True)


def test_invalid_menu_selection_can_be_corrected(monkeypatch):
    choices = iter(["wrong", "D"])
    monkeypatch.setattr("builtins.input", lambda _: next(choices))
    assert dev.options(["--menu"]).mode == "fake"


class Response:
    status = 200
    def __init__(self, value): self.value = value
    def __enter__(self): return self
    def __exit__(self, *_): pass
    def read(self, _limit): return self.value


def test_readiness_waits_for_api_proxy_and_html(monkeypatch):
    visited = []
    def open_url(url, timeout):
        visited.append(url)
        if len(visited) == 1: raise URLError("Still starting")
        return Response(b"<html>Website</html>" if url == dev.WEB_URL else json.dumps({"status": "ok"}).encode())
    monkeypatch.setattr(dev, "urlopen", open_url)
    monkeypatch.setattr(dev.time, "sleep", lambda _: None)
    dev.wait_ready([SimpleNamespace(poll=lambda: None)])
    assert visited == ["http://127.0.0.1:8000/api/health"] * 2 + [dev.WEB_URL + "/api/health", dev.WEB_URL]


def test_readiness_detects_exit_and_timeout(monkeypatch):
    with pytest.raises(RuntimeError, match="exited"):
        dev.wait_ready([SimpleNamespace(poll=lambda: 1, returncode=1)])
    with pytest.raises(RuntimeError, match="did not become ready"):
        dev.wait_ready([], timeout=0)


@pytest.mark.parametrize("model", [dev.MODEL_LITE, dev.MODEL_FLASH])
def test_launch_opens_after_ready_passes_overrides_only_to_backend_and_cleans_up(tmp_path, monkeypatch, model):
    vite = tmp_path / "frontend/node_modules/vite/bin/vite.js"
    vite.parent.mkdir(parents=True); vite.write_text("")
    monkeypatch.setattr(dev, "PROJECT_DIR", tmp_path)
    monkeypatch.setattr(dev, "find_node", lambda: tmp_path / "node.exe")
    monkeypatch.setattr(dev.subprocess, "check_output", lambda *_a, **_k: "v24.21.0")
    monkeypatch.setattr(dev, "check_port", lambda _: None)
    monkeypatch.setattr(dev.signal, "signal", lambda *_: None)
    monkeypatch.setenv("GEMINI_API_KEY", "synthetic-launch-key")
    events, launches, children = [], [], []
    def start(command, **kwargs):
        events.append("start"); launches.append((command, kwargs))
        child = SimpleNamespace(poll=lambda: None); children.append(child); return child
    monkeypatch.setattr(dev.subprocess, "Popen", start)
    monkeypatch.setattr(dev, "wait_ready", lambda _: events.append("ready"))
    monkeypatch.setattr(dev.webbrowser, "open", lambda _: events.append("browser") or True)
    def stop_sleep(_): raise KeyboardInterrupt
    monkeypatch.setattr(dev.time, "sleep", stop_sleep)
    monkeypatch.setattr(dev, "stop_children", lambda actual: events.append("stop") if actual == children else pytest.fail("Wrong children"))
    assert dev.main(["--mode", "live", "--model", model, "--open-browser"]) == 0
    assert events == ["start", "start", "ready", "browser", "stop"]
    assert launches[0][1]["env"]["LLM_MODEL"] == model and launches[0][1]["env"]["LLM_MODE"] == "live"
    assert "GEMINI_API_KEY" not in launches[1][1]["env"] and "LLM_MODEL" not in launches[1][1]["env"]


def test_failed_start_does_not_open_browser_and_cleans_up(tmp_path, monkeypatch):
    vite = tmp_path / "frontend/node_modules/vite/bin/vite.js"
    vite.parent.mkdir(parents=True); vite.write_text("")
    monkeypatch.setattr(dev, "PROJECT_DIR", tmp_path)
    monkeypatch.setattr(dev, "find_node", lambda: tmp_path / "node.exe")
    monkeypatch.setattr(dev.subprocess, "check_output", lambda *_a, **_k: "v24.21.0")
    monkeypatch.setattr(dev, "check_port", lambda _: None)
    monkeypatch.setattr(dev.signal, "signal", lambda *_: None)
    children = []
    monkeypatch.setattr(dev.subprocess, "Popen", lambda *_a, **_k: SimpleNamespace(poll=lambda: None))
    def fail_ready(_): raise RuntimeError("Startup failed")
    monkeypatch.setattr(dev, "wait_ready", fail_ready)
    opened = []; monkeypatch.setattr(dev.webbrowser, "open", lambda _: opened.append(True))
    monkeypatch.setattr(dev, "stop_children", lambda actual: children.extend(actual))
    assert dev.main(["--mode", "fake", "--open-browser"]) == 1
    assert not opened and len(children) == 2
