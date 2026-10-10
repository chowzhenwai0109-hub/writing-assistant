"""Run two local development servers; always clean up our own child processes."""

import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import time
from urllib.error import URLError
from urllib.request import urlopen
import webbrowser

PROJECT_DIR = Path(__file__).resolve().parents[1]
MODEL_LITE = "gemini-3.5-flash-lite"
MODEL_FLASH = "gemini-3.6-flash"
WEB_URL = "http://127.0.0.1:5173"


def options(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--open-browser", action="store_true", help="Open the local website after both servers are ready.")
    parser.add_argument("--menu", action="store_true", help="Choose offline demo or a Gemini model for this launch.")
    parser.add_argument("--mode", choices=("fake", "live"), help="Override LLM_MODE for this launch only.")
    parser.add_argument("--model", choices=(MODEL_LITE, MODEL_FLASH), help="Override LLM_MODEL for this launch only.")
    args = parser.parse_args(argv)
    if args.menu and args.mode is None:
        print("D: Demo (offline, default)")
        print("L: Gemini 3.5 Flash-Lite")
        print("F: Gemini 3.6 Flash")
        print("Live choices send writing context to Google when you request assistance.")
        while True:
            choice = input("Choose D, L or F [D]: ").strip().upper() or "D"
            if choice in ("D", "L", "F"):
                args.mode = "fake" if choice == "D" else "live"
                args.model = args.model or (MODEL_FLASH if choice == "F" else MODEL_LITE)
                break
            print("Enter D, L or F.")
    return args


def wait_ready(children, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        for child in children:
            if child.poll() is not None:
                raise RuntimeError(f"A development server exited (code {child.returncode}).")
        try:
            for address in ("http://127.0.0.1:8000/api/health", WEB_URL + "/api/health"):
                with urlopen(address, timeout=1) as response:
                    if response.status != 200 or json.loads(response.read(4096)) != {"status": "ok"}:
                        raise ValueError("Health response is not ready")
            with urlopen(WEB_URL, timeout=1) as response:
                if response.status != 200 or b"<html" not in response.read(65536).lower():
                    raise ValueError("Website is not ready")
            return
        except (URLError, OSError, ValueError):
            time.sleep(0.2)
    raise RuntimeError("Servers did not become ready within 30 seconds. Check the errors above.")


def find_node() -> Path:
    installed = shutil.which("node")
    if installed:
        return Path(installed).resolve()
    candidates = sorted((PROJECT_DIR / ".tools").glob("node-*-win-x64/node.exe"))
    if candidates:
        return candidates[-1].resolve()
    raise RuntimeError("Node.js 24 LTS is required. See README.md for setup.")


def check_port(port: int) -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        if os.name == "nt":
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        try:
            probe.bind(("127.0.0.1", port))
        except OSError as error:
            raise RuntimeError(f"Port {port} is already in use. Stop its server first.") from error


def stop_children(children: list[subprocess.Popen]) -> None:
    # Ignore further Ctrl+C during cleanup so both process trees are stopped.
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    for child in reversed(children):
        if os.name == "nt":
            if child.poll() is None:
                subprocess.run(
                    ["taskkill", "/PID", str(child.pid), "/T", "/F"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    check=False,
                )
        else:
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
    for child in children:
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            if os.name != "nt":
                os.killpg(child.pid, signal.SIGKILL)
            else:
                child.kill()
            child.wait()


def main(argv=None) -> int:
    children: list[subprocess.Popen] = []
    try:
        args = options(argv)
        node = find_node()
        version = subprocess.check_output([str(node), "--version"], text=True).strip()
        if not version.startswith("v24."):
            raise RuntimeError("Use Node.js 24 LTS for this project's locked dependencies.")
        for port in (8000, 5173):
            check_port(port)
        vite = PROJECT_DIR / "frontend" / "node_modules" / "vite" / "bin" / "vite.js"
        if not vite.is_file():
            raise RuntimeError("Frontend dependencies missing. Run npm ci in frontend first.")
        child_env = os.environ.copy()
        child_env["PATH"] = str(node.parent) + os.pathsep + child_env.get("PATH", "")
        backend_env = child_env.copy()
        if args.mode:
            backend_env["LLM_MODE"] = args.mode
        if args.model:
            backend_env["LLM_MODEL"] = args.model
        # Vite never needs the provider key or runtime configuration.
        for key in ("GEMINI_API_KEY", "LLM_MODE", "LLM_MODEL", "LLM_PROVIDER"):
            child_env.pop(key, None)
        commands = [
            ([sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "8000", "--reload"], PROJECT_DIR / "backend"),
            ([str(node), str(vite)], PROJECT_DIR / "frontend"),
        ]
        def request_stop(_signal, _frame):
            raise KeyboardInterrupt
        signal.signal(signal.SIGINT, request_stop)
        signal.signal(signal.SIGTERM, request_stop)
        if hasattr(signal, "SIGBREAK"):
            signal.signal(signal.SIGBREAK, request_stop)
        for index, (command, cwd) in enumerate(commands):
            process_options = {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == "nt" else {"start_new_session": True}
            children.append(subprocess.Popen(command, cwd=cwd, env=backend_env if index == 0 else child_env, **process_options))
        wait_ready(children)
        print("Writing Assistant: http://127.0.0.1:5173", flush=True)
        print("API: http://127.0.0.1:8000/api/health | Ctrl+C stops both servers", flush=True)
        print(f"Mode: {backend_env.get('LLM_MODE', 'from .env (default: fake)')} | Model: {backend_env.get('LLM_MODEL', 'from .env (default: ' + MODEL_LITE + ')')}", flush=True)
        if args.open_browser:
            try:
                if not webbrowser.open(WEB_URL):
                    print("Browser could not open automatically. Open the website address above.", flush=True)
            except webbrowser.Error:
                print("Browser could not open automatically. Open the website address above.", flush=True)
        while True:
            for child in children:
                if child.poll() is not None:
                    raise RuntimeError(f"A development server exited (code {child.returncode}).")
            time.sleep(0.2)
    except KeyboardInterrupt:
        print("\nStopping development servers…", flush=True)
        return 0
    except EOFError:
        print("No launcher selection received. Run with --mode fake or choose from the menu.", file=sys.stderr)
        return 1
    except (OSError, RuntimeError) as error:
        print(f"Cannot run development servers: {error}", file=sys.stderr)
        return 1
    finally:
        if children:
            stop_children(children)


if __name__ == "__main__":
    raise SystemExit(main())
